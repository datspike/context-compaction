import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type AssistantMessage, type Message, type Provider } from "@earendil-works/pi-ai";
import { convertToLlm, estimateTokens, type ExtensionAPI, type ExtensionContext, type MessageEndEvent, type SessionBeforeCompactEvent, type SessionBoundaryDraft, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { appendTask, buildAppendCompaction, cacheStatus, classifyRequestFailure, parseResult, preservesPayloadPrefix, supported, type AppendFallback, type AppendOutcome } from "./append-compaction.js";

import { isNativeCompactionMessage } from "./checkpoint.js";
import { russianCompaction } from "./summary.js";
import { calculateCompactBudget, resolveCompactCapability, type CompactCapability, type CompactCapabilityOverride } from "./compact-budget.js";

const SERVICE_PREFIX = "[context-compaction-native:";
const STATUS_KEY = "context-compaction-native";
type Success = Extract<AppendOutcome, { kind: "success" }>;
type Failure = Exclude<AppendOutcome, Success>;
type Phase = "handoff" | "scheduled" | "queued" | "context" | "payload" | "response" | "drafted" | "failed" | "fallback" | "standard";

export interface NativeCompletion {
	id: string;
	event: SessionBeforeCompactEvent;
	outcome: Success;
	standard?: Failure;
	durationMs: number;
	model: { provider: string; id: string };
}
interface Callbacks {
	entries(completion: NativeCompletion): SessionBoundaryDraft[];
	applied(completion: NativeCompletion, ctx: ExtensionContext): void | Promise<void>;
	failed(outcome: Failure, durationMs: number, model: { provider: string; id: string }, ctx: ExtensionContext): void;
	finished(ctx: ExtensionContext, successful: boolean): void | Promise<void>;
}
interface Run {
	id: string;
	service: string;
	event: SessionBeforeCompactEvent;
	ctx: ExtensionContext;
	sessionId: string;
	model: { provider: string; id: string; baseUrl: string };
	capability: CompactCapability;
	inputTokens: number;
	modelMaxTokens: number;
	fingerprint: string;
	phase: Phase;
	started: number;
	maxTokens: number;
	serviceId?: string;
	messages?: Message[];
	task?: string;
	payloadHash?: string;
	verified?: boolean;
	sent?: boolean;
	toolBlocks: number;
	outcome?: Success;
	failure?: Failure;
	standard?: Failure;
	continuationStarted?: boolean;
	signal?: AbortSignal;
	timer?: ReturnType<typeof setTimeout>;
	abort?: () => void;
	fallbackAllowed: boolean;
	failureReported?: boolean;
	applied?: boolean;
	completion?: NativeCompletion;
	/** True from the dispatch of our own request until its assistant message is finalized. */
	responding?: boolean;
	/** Original service response; the visible and persisted message is emptied so the summary is not shown twice. */
	raw?: AssistantMessage;
	/** Resolves the pending manual hook; Pi keeps its own compaction spinner until it settles. */
	held?: (result: HookResult) => void;
	/** The manual compaction is saved by Pi from the hook result, so verification waits for its saved entry. */
	holding?: boolean;
	saved?: boolean;
	startTimer?: ReturnType<typeof setTimeout>;
}
/** How long a held manual compact waits for its service turn to begin before giving the session back. */
export const nativeStartTimeout = { ms: 15_000 };
type HookResult = { cancel: true } | { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage?: unknown; details?: unknown } };

function text(message: unknown): string {
	const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((p) => typeof p?.text === "string" ? p.text : "").join("\n") : "";
}
/** Pass only lifecycle events: the service JSON is the future summary and must not stream into the chat. */
function withoutTextEvents(source: AssistantMessageEventStream, model: { api: string; provider: string; id: string }): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			let started = false;
			for await (const event of source) {
				if (event.type === "start") started = true;
				else if (!started && (event.type === "done" || event.type === "error")) {
					// Without a start event the agent loop would show the finished response as its first message.
					out.push({ type: "start", partial: { ...(event.type === "done" ? event.message : event.error), content: [] } });
					started = true;
				}
				if (!/^(text|thinking)_/.test(event.type)) out.push(event);
			}
		} catch (error) {
			const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			out.push({ type: "error", reason: "error", error: { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: zero, stopReason: "error", errorMessage: String(error), timestamp: Date.now() } as AssistantMessage });
		}
		out.end();
	})();
	return out;
}
function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Bind source and execution controls; final declarations remain owned by the native payload pipeline. */
function payloadDigest(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return digest(value);
	const { include, tools, ...request } = value as Record<string, unknown>;
	if (tools !== undefined && (!Array.isArray(tools) || !tools.every((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item.type === "string"))) return digest(value);
	if (include !== undefined && (!Array.isArray(include) || !include.every((item) => typeof item === "string"))) return digest(value);
	return digest(request);
}
function semanticBranch(ctx: ExtensionContext) {
	return ctx.sessionManager.getBranch().filter((e) => e.type !== "custom" && e.type !== "session_info" && e.type !== "usage" && !(e.type === "custom_message" && e.customType === STATUS_KEY));
}
function isService(message: { role?: string; customType?: string; content?: unknown }, ctx: ExtensionContext): boolean {
	const supportedRole = message.role === "user" || message.role === "custom" || (message.role === undefined && message.customType === STATUS_KEY);
	const entry = message.role === "custom" || (message.role === undefined && message.customType === STATUS_KEY) ? { type: "custom_message", customType: message.customType, content: message.content } : { type: "message", message };
	return supportedRole && text(message).startsWith(SERVICE_PREFIX) && isNativeCompactionMessage(entry, ctx.sessionManager.getBranch());
}

/** Coordinates native service turns while leaving Pi's compact and provider implementations intact. */
export class NativeAppend {
	private run?: Run;
	private uncertainUsage?: string;

	/** A cleanup edit invalidates SDK usage; do not display a fictitious reduction. */
	contextTokens(ctx: ExtensionContext): number | null | undefined {
		if (this.uncertainUsage) {
			if (this.usageStamp(ctx) === this.uncertainUsage) return undefined;
			this.uncertainUsage = undefined;
		}
		return ctx.getContextUsage()?.tokens;
	}
	private usageStamp(ctx: ExtensionContext, excluded = new Set<string>()): string {
		const branch = ctx.sessionManager.getBranch();
		const omitted = new Set([...excluded, ...branch.flatMap(e => e.type === "context_edit" && e.replacement === null ? [e.targetId] : [])]);
		let assistant: string | undefined, boundary: string | undefined, service = false;
		for (const entry of branch) {
			if (entry.type === "compaction") boundary = entry.id;
			if (entry.type === "message" || entry.type === "custom_message") {
				const message = entry.type === "message" ? entry.message : entry;
				if (isService(message, ctx)) service = !omitted.has(entry.id);
			}
			if (entry.type !== "message" || omitted.has(entry.id)) continue;
			if (!service && entry.message.role === "assistant" && entry.message.stopReason !== "aborted" && entry.message.stopReason !== "error" && entry.message.usage?.totalTokens > 0) assistant = entry.id;
		}
		return JSON.stringify([ctx.sessionManager.getSessionId(), assistant, boundary]);
	}
	private decline: AppendFallback = "unsupported";
	private registration?: { registry: ExtensionContext["modelRegistry"]; id: string; proxy: Provider; restore: () => void };
	private fallbackScope?: { sessionId: string; reason: SessionBeforeCompactEvent["reason"] };

	constructor(private readonly pi: ExtensionAPI, private readonly callbacks: Callbacks, private readonly capabilities: readonly CompactCapabilityOverride[] = []) {}

	/** Service metadata does not change ordinary session policy or registry. */
	capability(ctx: ExtensionContext): CompactCapability {
		return ctx.model ? resolveCompactCapability(ctx.model, ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)?.contextWindow, this.capabilities) : { window: 0, source: "unsupported", outputLimitEnforced: false };
	}
	serviceModel(ctx: ExtensionContext) {
		return ctx.model ? { ...ctx.model, contextWindow: this.capability(ctx).window } : undefined;
	}
	private budget(run: Run, payload?: unknown) {
		const serialized = payload === undefined ? undefined : JSON.stringify(payload);
		// Pi estimates visible text; opaque reasoning and image bytes are not text tokens.
		const visible = payload === undefined ? 0 : estimateTokens({ role: "user", content: JSON.stringify(payload, (key, value) => key === "encrypted_content" || key === "image_url" || key === "data" ? undefined : value), timestamp: 0 });
		const taskTokens = run.task ? estimateTokens({ role: "user", content: run.task, timestamp: 0 }) : 0;
		return calculateCompactBudget({ capability: run.capability, inputTokens: Math.max(run.inputTokens, visible - taskTokens), taskTokens, requestedOutputTokens: run.maxTokens, modelMaxTokens: run.modelMaxTokens, serializedChars: serialized?.length });
	}

	get active(): boolean { return this.run !== undefined; }
	/** Why no guarded native operation was started; permits only a standalone fallback. */
	preflightReason(): AppendFallback { return this.decline; }
	/** The original compact callback reports the handoff, not the eventual native result. */
	ownsCallback(): boolean { return this.run !== undefined && this.run.phase !== "fallback"; }

	private sameSession(run: Run, ctx: ExtensionContext): boolean {
		return ctx.sessionManager.getSessionId() === run.sessionId;
	}
	private sameModel(run: Run, ctx: ExtensionContext): boolean {
		return ctx.model?.provider === run.model.provider && ctx.model.id === run.model.id && ctx.model.baseUrl === run.model.baseUrl;
	}
	private completion(run: Run): NativeCompletion {
		return { id: run.id, event: run.event, outcome: run.outcome!, standard: run.standard, durationMs: Date.now() - run.started, model: run.model };
	}
	private registrationOwned(ctx: ExtensionContext): boolean {
		return !!this.registration && this.registration.registry === ctx.modelRegistry && ctx.modelRegistry.getRegisteredNativeProvider(this.registration.id) === this.registration.proxy;
	}
	private install(ctx: ExtensionContext): boolean {
		if (!ctx.model || typeof ctx.modelRegistry.getProvider !== "function") return false;
		if (this.registration) return this.registration.id === ctx.model.provider && this.registrationOwned(ctx);
		const registry = ctx.modelRegistry;
		const id = ctx.model.provider;
		const base = registry.getProvider(id);
		if (!base) return false;
		const previousNative = registry.getRegisteredNativeProvider(id);
		const previousConfig = registry.getRegisteredProviderConfig(id);
		const stream: Provider["streamSimple"] = (model, context, options) => {
			const run = this.run;
			const ownRequest = run && options?.sessionId === run.sessionId && run.task && text(context.messages.at(-1) ?? {}) === run.task;
			if (!ownRequest) return base.streamSimple(model, context, options);
			run.signal = options?.signal;
			if (digest(context.messages.slice(0, -1).filter((message) => message.role !== "system")) !== digest(run.messages?.filter((message) => message.role !== "system"))) {
				this.reject(run, "payload-mismatch", run.ctx, true);
				throw new Error("APPEND_COMPACTION_FINAL_CONTEXT_MISMATCH");
			}
			run.responding = true;
			return withoutTextEvents(base.streamSimple({ ...model, contextWindow: run.capability.window }, context, {
				...options, transport: "sse", maxRetries: 0, timeoutMs: 120_000,
				onPayload: async (payload) => {
					const final = (await options?.onPayload?.(payload, model)) ?? payload;
					if (this.run !== run || run.phase !== "response" || !this.sameModel(run, run.ctx) || !this.registrationOwned(run.ctx) || payloadDigest(final) !== run.payloadHash) {
						this.reject(run, "payload-mismatch", run.ctx, true);
						throw new Error("APPEND_COMPACTION_FINAL_PAYLOAD_MISMATCH");
					}
					if (options?.signal?.aborted) throw new Error("APPEND_COMPACTION_ABORTED");
					const budget = this.budget(run, final);
					this.pi.appendEntry("context-compaction-budget", { version: 1, id: run.id, phase: "final", source: run.capability.source, inputSource: "sdk-preparation-and-visible-payload-estimate", ...budget });
					if (!this.sameSession(run, run.ctx) || !budget.allowed) {
						this.reject(run, !this.sameSession(run, run.ctx) ? "context-changed" : budget.reason ?? "insufficient-window", run.ctx, true);
						throw new Error(budget.reason === "request-too-large" ? "APPEND_COMPACTION_REQUEST_TOO_LARGE" : "APPEND_COMPACTION_INSUFFICIENT_WINDOW");
					}
					run.verified = true;
					run.sent = true;
					return final;
				},
			}), model);
		};
		const proxy = new Proxy(base, { get(target, key) {
			if (key === "streamSimple") return stream;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		} });
		registry.registerProvider(proxy);
		this.registration = { registry, id, proxy, restore: () => {
			if (registry.getRegisteredNativeProvider(id) !== proxy) return;
			registry.unregisterProvider(id);
			if (previousNative) registry.registerProvider(previousNative);
			else if (previousConfig) registry.registerProvider(id, previousConfig);
		} };
		return true;
	}

	/** Take the service response out of the chat and the stored branch; parsing uses the copy kept here. */
	messageEnd(event: MessageEndEvent): { message: AgentMessage } | undefined {
		const run = this.run;
		if (!run?.responding || event.message.role !== "assistant") return;
		run.responding = false;
		run.raw = { ...event.message, content: [...event.message.content] };
		// Tool calls stay: the agent loop must still see and block them, and a failure must remain visible.
		return { message: { ...event.message, content: event.message.content.filter((block) => block.type === "toolCall") } };
	}

	/** Intercept prepared compaction only when the current provider can be guarded end to end. */
	before(event: SessionBeforeCompactEvent, ctx: ExtensionContext): { cancel: true } | Promise<HookResult> | undefined {
		this.decline = "unsupported";
		if (this.run?.phase === "fallback") return;
		if (this.run) {
			if (event.reason === "manual" && this.run.event.reason === "manual" && this.run.phase === "scheduled") return { cancel: true };
			// A service response must not recursively compact, nor recover overflow twice.
			this.cancel(ctx);
			return { cancel: true };
		}
		if (!supported(ctx) || event.signal.aborted || !this.install(ctx)) return;
		const maxTokens = Math.min(Math.floor(event.preparation.settings.reserveTokens * 0.8), ctx.model!.maxTokens);
		const capability = this.capability(ctx);
		const budget = calculateCompactBudget({ capability, inputTokens: event.preparation.tokensBefore, taskTokens: 0, requestedOutputTokens: maxTokens, modelMaxTokens: ctx.model!.maxTokens });
		if (!budget.allowed) { this.decline = budget.reason ?? "insufficient-window"; return; }
		const id = randomUUID();
		const run: Run = { id, service: `${SERVICE_PREFIX}${id}] Служебный запрос сводки; не выполняй рабочие действия.`, event, ctx, sessionId: ctx.sessionManager.getSessionId(), model: { provider: ctx.model!.provider, id: ctx.model!.id, baseUrl: ctx.model!.baseUrl }, capability, inputTokens: event.preparation.tokensBefore, modelMaxTokens: ctx.model!.maxTokens, fingerprint: digest(semanticBranch(ctx)), phase: "handoff", started: Date.now(), maxTokens, toolBlocks: 0, fallbackAllowed: false };
		this.run = run;
		run.abort = () => {
			const unstarted = run.phase === "scheduled" || run.phase === "queued";
			this.reject(run, "aborted", ctx);
			// A held manual compact has no later turn_end to release it when the service turn never began.
			if (unstarted && run.holding) void this.settled(ctx);
		};
		event.signal.addEventListener("abort", run.abort, { once: true });
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "append compact: подготовка");
		// A manual compact keeps Pi's own spinner and returns the result itself; cancelling would print a red error.
		if (event.reason === "manual") {
			run.phase = "scheduled"; run.holding = true;
			run.timer = setTimeout(() => this.start(run, ctx), 0);
			return new Promise<HookResult>((resolve) => { run.held = resolve; });
		}
		return { cancel: true };
	}

	/** Consume only the cancellation emitted by the preparation we deliberately handed off. */
	handoffFailed(event: { reason: string; aborted: boolean }, ctx: ExtensionContext): boolean {
		const run = this.run;
		if (!run || run.phase !== "handoff" || !this.sameSession(run, ctx) || event.reason !== run.event.reason || !event.aborted) return false;
		if (run.event.signal.aborted) { this.reject(run, "aborted", ctx); return true; }
		run.phase = "scheduled";
		if (run.event.reason === "manual") run.timer = setTimeout(() => this.start(run, ctx), 0);
		else this.start(run, ctx);
		return true;
	}
	private start(run: Run, ctx: ExtensionContext): void {
		if (this.run !== run || run.phase !== "scheduled") return;
		if (!this.sameSession(run, ctx) || !this.sameModel(run, ctx) || digest(semanticBranch(ctx)) !== run.fingerprint || !this.registrationOwned(ctx)) {
			this.reject(run, "context-changed", ctx); void this.settled(ctx); return;
		}
		if (run.event.reason === "manual" && !run.holding && !ctx.isIdle()) return;
		run.phase = "queued";
		this.pi.appendEntry("context-compaction-native", { version: 1, id: run.id, phase: "queued", sessionId: run.sessionId });
		this.pi.sendMessage({ customType: STATUS_KEY, content: run.service, display: false }, { triggerTurn: true, deliverAs: run.event.reason === "manual" ? "followUp" : "steer" });
		if (run.holding) run.startTimer = setTimeout(() => {
			if (this.run !== run || run.phase !== "queued") return;
			this.reject(run, "request-failed", ctx);
			void this.settled(ctx);
		}, nativeStartTimeout.ms);
	}

	/** Transform only our own service input; stale service records are never model instructions. */
	context(messages: AgentMessage[], ctx: ExtensionContext): { messages: AgentMessage[] } | undefined {
		const run = this.run;
		if (run?.phase === "drafted") run.continuationStarted = true;
		const last = messages.at(-1);
		let orphan = false;
		const filtered = messages.filter((message) => {
			if (message.role === "user" || message.role === "custom") orphan = isService(message, ctx) && (!run || text(message) !== run.service);
			return !orphan || message.role === "system";
		});
		if (run && (last?.role === "user" || last?.role === "custom") && !isService(last, ctx) && run.phase !== "drafted" && run.phase !== "fallback") {
			this.reject(run, "context-changed", ctx, false, false);
			void this.settled(ctx);
			return filtered.length !== messages.length ? { messages: filtered } : undefined;
		}
		if (!run || run.phase === "drafted" || run.phase === "fallback" || run.phase === "failed") {
			if (last && isService(last, ctx) && run?.phase !== "failed") ctx.abort();
			return filtered.length !== messages.length ? { messages: filtered } : undefined;
		}
		if (!last || (last.role !== "user" && last.role !== "custom") || text(last) !== run.service || !isService(last, ctx) || !this.sameSession(run, ctx) || !this.sameModel(run, ctx)) {
			this.reject(run, "context-changed", ctx); return;
		}
		run.serviceId = [...ctx.sessionManager.getBranch()].reverse().find((e) => {
			const message = e.type === "message" ? e.message : e.type === "custom_message" ? e : undefined;
			return !!message && isService(message, ctx) && text(message) === run.service;
		})?.id;
		run.messages = convertToLlm(filtered.slice(0, -1));
		run.task = appendTask(run.messages, run.event);
		if (!run.serviceId || !run.task) { this.reject(run, "boundary-unavailable", ctx, true); return; }
		run.fingerprint = digest(semanticBranch(ctx));
		run.phase = "payload";
		if (ctx.hasUI) ctx.ui.setWorkingMessage("Append compact: создаю сводку");
		return { messages: [...filtered.slice(0, -1), { ...last, content: [{ type: "text", text: run.task }] }] };
	}

	/** Add the task controls without replacing the native instructions, tools or source prefix. */
	payload(payload: unknown, ctx: ExtensionContext): unknown {
		const run = this.run;
		if (!run || run.phase !== "payload") return;
		const value = payload as Record<string, any> | undefined;
		const input = Array.isArray(value?.input) ? value.input : undefined;
		const suffix = input?.at(-1);
		// Responses may append a model-supported effort control after the final user message.
		const compat = ctx.model?.compat;
		const effortControl = compat && "supportsMidConvoEffort" in compat && compat.supportsMidConvoEffort === true && suffix?.type === "configuration_update"
			&& Object.keys(suffix).length === 2 && suffix.reasoning && typeof suffix.reasoning === "object" && !Array.isArray(suffix.reasoning)
			&& Object.keys(suffix.reasoning).length === 1 && typeof suffix.reasoning.effort === "string" && suffix.reasoning.effort.length > 0;
		const taskIndex = (input?.length ?? 0) - (effortControl ? 2 : 1);
		const task = input?.[taskIndex];
		if (!value || !input || task?.role !== "user" || text(task) !== run.task || value.model !== run.model.id || value.prompt_cache_key !== run.sessionId) {
			this.reject(run, "payload-mismatch", ctx, true); throw new Error("APPEND_COMPACTION_NATIVE_PAYLOAD_MISMATCH");
		}
		const next = { ...value, tool_choice: "none", max_output_tokens: run.maxTokens };
		const budget = this.budget(run, next);
		this.pi.appendEntry("context-compaction-budget", { version: 1, id: run.id, phase: "prepared", source: run.capability.source, inputSource: "sdk-preparation-and-visible-payload-estimate", ...budget });
		if (!budget.allowed) {
			this.reject(run, budget.reason ?? "insufficient-window", ctx, true); throw new Error(budget.reason === "request-too-large" ? "APPEND_COMPACTION_REQUEST_TOO_LARGE" : "APPEND_COMPACTION_INSUFFICIENT_WINDOW");
		}
		const baseline = { ...value, input: input.slice(0, taskIndex) };
		if (!preservesPayloadPrefix(baseline, next)) {
			this.reject(run, "payload-mismatch", ctx, true); throw new Error("APPEND_COMPACTION_PREFIX_MISMATCH");
		}
		run.payloadHash = payloadDigest(next);
		run.phase = "response";
		return next;
	}

	/** Block every proposed tool, including additional calls after an earlier one was rejected. */
	tool(ctx: ExtensionContext): { block: true; reason: string } | undefined {
		const run = this.run;
		if (!run || run.phase === "drafted" || run.phase === "fallback") return;
		run.toolBlocks += 1;
		this.reject(run, "invalid-result", ctx, true);
		if (run.failure) {
			run.failure.validationGuard = "tool-call";
			const attempt = run.failure.appendAttempt.at(-1);
			if (attempt) { attempt.toolBlocks = run.toolBlocks; attempt.toolBlockTypes = Array(run.toolBlocks).fill("toolCall"); }
		}
		return { block: true, reason: "Compaction never executes tools" };
	}

	private reject(run: Run, reason: Failure["reason"], ctx: ExtensionContext, fallback = false, abortCurrent = true): void {
		if (this.run !== run || run.phase === "drafted") return;
		if (!run.failure) {
			const fallbackReason = ["unsupported", "snapshot-unavailable", "boundary-unavailable", "insufficient-window", "request-too-large", "payload-mismatch"].includes(reason);
			run.failure = fallbackReason ? { kind: "fallback", appendAttempt: [], reason: reason as Extract<Failure, { kind: "fallback" }>["reason"], cacheStatus: run.sent ? "unknown" : "not-attempted" } : { kind: "cancel", appendAttempt: [], reason: reason as Extract<Failure, { kind: "cancel" }>["reason"], cacheStatus: run.sent ? "unknown" : "not-attempted" };
			run.failure.appendAttempt = [{ attempt: run.sent ? 1 : 0, phase: run.sent ? "provider" : "preflight", toolBlocks: run.toolBlocks, toolBlockTypes: run.toolBlocks ? ["toolCall"] : [], repairAttempts: 0 }];
			run.fallbackAllowed = fallback;
		}
		run.phase = "failed";
		if (run.timer) clearTimeout(run.timer);
		if (abortCurrent && !(fallback && run.event.willRetry) && this.sameSession(run, ctx) && !ctx.isIdle()) ctx.abort();
	}

	/** Hide orphaned service turns as well as the current service response, using append-only edits. */
	private cleanup(ctx: ExtensionContext, extra: string[] = []): SessionBoundaryDraft[] {
		const branch = ctx.sessionManager.getBranch();
		const omitted = new Set(branch.flatMap((e) => e.type === "context_edit" && e.replacement === null ? [e.targetId] : []));
		const ids = new Set(extra);
		let service = false;
		for (const entry of branch) {
			if (entry.type !== "message" && entry.type !== "custom_message") continue;
			const message = entry.type === "message" ? entry.message : entry;
			if (isService(message, ctx)) {
				service = !omitted.has(entry.id);
			} else if (entry.type === "custom_message" || entry.message?.role === "user" || entry.message?.role === "custom") {
				service = false;
			}
			if (service && (entry.type === "custom_message" || entry.message?.role === "user" || entry.message?.role === "assistant" || entry.message?.role === "toolResult")) ids.add(entry.id);
		}
		const removed = [...ids].filter((id) => id && !omitted.has(id));
		if (removed.length) this.uncertainUsage = this.usageStamp(ctx, new Set(removed));
		return removed.map((targetId) => ({ type: "context_edit", targetId, replacement: null }));
	}

	/** Return drafts only; success callbacks wait until Pi has committed the actual compaction. */
	async turn(event: TurnEndEvent, ctx: ExtensionContext): Promise<{ entries: SessionBoundaryDraft[]; continue?: boolean } | undefined> {
		const run = this.run;
		if (!run || run.phase === "drafted" || run.phase === "fallback") {
			const entries = this.cleanup(ctx);
			return entries.length ? { entries } : undefined;
		}
		if (!this.sameSession(run, ctx)) return;
		const response = run.raw ?? event.message as AssistantMessage;
		const current = semanticBranch(ctx).filter((e) => e.id !== event.messageEntryId && !event.toolResultEntryIds.includes(e.id));
		if (run.event.willRetry && (!this.sameModel(run, ctx) || digest(current) !== run.fingerprint)) { run.fallbackAllowed = false; this.reject(run, "context-changed", ctx); }
		if (!run.failure && (!this.sameModel(run, ctx) || digest(current) !== run.fingerprint || !run.verified || !run.messages || !run.serviceId)) this.reject(run, "context-changed", ctx);
		if (!run.failure && response.stopReason === "aborted") this.reject(run, "aborted", ctx);
		if (!run.failure && response.stopReason === "error") {
			// An SDK error may be a lost stream, not a confirmed rejection by the provider.
			this.reject(run, "request-failed", ctx);
			run.failure!.requestFailure = { ...classifyRequestFailure(response.errorMessage, "provider"), hasUsage: response.usage?.totalTokens > 0 };
			for (const attempt of run.failure!.appendAttempt) attempt.stopReason = response.stopReason;
		}
		if (!run.failure) {
			const parsed = parseResult(response, run.event.preparation.isSplitTurn && run.event.preparation.turnPrefixMessages.length > 0, run.messages!, run.event);
			const attempt = { attempt: 1, phase: parsed.parsed ? "apply" as const : "parse" as const, stopReason: response.stopReason, toolBlocks: Math.max(run.toolBlocks, parsed.toolBlockTypes.length), toolBlockTypes: parsed.toolBlockTypes, responseChars: parsed.responseChars, repairAttempts: 0 };
			if (!parsed.parsed) {
				this.reject(run, "invalid-result", ctx, response.stopReason === "stop" || response.stopReason === "length");
				run.failure = { ...run.failure!, validationGuard: parsed.guard, appendAttempt: [attempt] };
			} else {
				run.outcome = { kind: "success", compaction: buildAppendCompaction(parsed.parsed, run.event, response.usage), cacheStatus: cacheStatus(response.usage, true), appendAttempt: [attempt] };
				run.completion = this.completion(run);
				run.phase = "drafted";
				const marker = { version: 1, id: run.id, reason: run.event.reason };
				if (run.holding) {
					this.resolveHold(run, { compaction: { ...run.outcome.compaction, usage: response.usage, details: { ...run.outcome.compaction.details, nativeAppend: marker } } });
					return { entries: this.cleanup(ctx, [run.serviceId!, event.messageEntryId, ...event.toolResultEntryIds]) };
				}
				return { entries: [
					{ type: "compaction", summary: run.outcome.compaction.summary, firstKeptEntryId: run.outcome.compaction.firstKeptEntryId, usage: response.usage, details: { ...run.outcome.compaction.details, nativeAppend: marker } },
					...this.cleanup(ctx, [run.serviceId!, event.messageEntryId, ...event.toolResultEntryIds]),
				] };
			}
		}
		if (run.failure?.kind === "cancel") {
			const usage = response.stopReason !== "aborted" && response.usage?.totalTokens > 0 ? response.usage : undefined;
			run.failure = { ...run.failure, usage, cacheStatus: cacheStatus(usage, Boolean(run.sent)) };
		}
		const standard = await this.prepareStandard(ctx);
		if (standard) return { ...standard, entries: [...standard.entries, ...this.cleanup(ctx, [event.messageEntryId, ...event.toolResultEntryIds])] };
		this.resolveHold(run, { cancel: true });
		return { entries: this.cleanup(ctx, [event.messageEntryId, ...event.toolResultEntryIds]) };
	}

	/** Preserve overflow recovery at a public boundary instead of creating a manual compact. */
	private async prepareStandard(ctx: ExtensionContext): Promise<{ entries: SessionBoundaryDraft[] } | undefined> {
		const run = this.run;
		if (!run?.failure || !run.fallbackAllowed || !(run.event.willRetry || run.holding) || run.phase !== "failed" || ctx.hasPendingMessages()) return;
		if (!this.sameSession(run, ctx) || !this.sameModel(run, ctx) || !this.registrationOwned(ctx) || run.signal?.aborted || run.event.signal.aborted) return;
		const fingerprint = digest(semanticBranch(ctx));
		run.phase = "standard";
		run.fallbackAllowed = false;
		const result = await russianCompaction({ ...run.event, signal: run.signal ?? run.event.signal }, ctx, { model: this.serviceModel(ctx), capability: run.capability, isCurrent: () => this.run === run && run.phase === "standard" && this.registrationOwned(ctx) && digest(semanticBranch(ctx)) === fingerprint });
		if (this.run !== run || run.phase !== "standard") return;
		if (!run.failureReported) { run.failureReported = true; this.callbacks.failed(run.failure, Date.now() - run.started, run.model, ctx); }
		if (!("compaction" in result) || !this.sameSession(run, ctx) || !this.sameModel(run, ctx) || !this.registrationOwned(ctx) || digest(semanticBranch(ctx)) !== fingerprint || run.signal?.aborted || run.event.signal.aborted || ctx.hasPendingMessages()) {
			run.phase = "failed";
			return;
		}
		run.standard = run.failure;
		run.outcome = { kind: "success", compaction: result.compaction, cacheStatus: cacheStatus(result.compaction.usage, true), appendAttempt: [{ attempt: 1, phase: "apply", toolBlocks: 0, toolBlockTypes: [], repairAttempts: 0 }] };
		run.completion = this.completion(run);
		run.phase = "drafted";
		const marker = { version: 1, id: run.id, reason: run.event.reason, standard: true };
		if (run.holding) {
			this.resolveHold(run, { compaction: { ...result.compaction, details: { ...result.compaction.details, nativeAppend: marker } } });
			return { entries: [] };
		}
		return { entries: [{ type: "compaction", summary: result.compaction.summary, firstKeptEntryId: result.compaction.firstKeptEntryId, usage: result.compaction.usage, details: { ...result.compaction.details, nativeAppend: marker } }] };
	}

	/** The last real message before the service turn is a user request or tool result that no assistant message has answered. */
	private awaitsAnswer(run: Run, ctx: ExtensionContext): boolean {
		const branch = ctx.sessionManager.getBranch();
		const serviceAt = branch.findIndex((entry) => entry.id === run.serviceId);
		const last = (serviceAt < 0 ? branch : branch.slice(0, serviceAt)).filter((entry) => entry.type === "message").at(-1);
		return last?.type === "message" && (last.message.role === "user" || last.message.role === "toolResult");
	}

	/** Resume only after the committed compaction survived every turn_end handler. */
	async beforeSettle(ctx: ExtensionContext): Promise<{ continue: true } | undefined> {
		const run = this.run;
		if (!run || run.phase !== "drafted" || run.continuationStarted) return;
		// Threshold compaction before a request hands the turn to the service run; the interrupted user request still needs its answer.
		if (!run.event.willRetry && !(run.event.reason === "threshold" && this.awaitsAnswer(run, ctx))) return;
		await this.settled(ctx);
		if (run.applied && !run.signal?.aborted && !run.event.signal.aborted && this.sameSession(run, ctx) && this.sameModel(run, ctx) && !ctx.hasPendingMessages()) return { continue: true };
	}

	/** Confirm application after boundary validation, then release or run one safe standalone fallback. */
	async settled(ctx: ExtensionContext): Promise<void> {
		const run = this.run;
		if (!run) return;
		if (run.phase === "scheduled") { this.start(run, ctx); return; }
		if (run.phase === "handoff" || run.phase === "fallback" || run.phase === "standard") return;
		if (!this.sameSession(run, ctx)) { this.release(run, ctx); return; }
		if (run.phase === "drafted") {
			if (run.holding && !run.saved) return;
			const entry = ctx.sessionManager.getBranch().find((e) => e.type === "compaction" && (e.details as any)?.nativeAppend?.id === run.id);
			const expected = run.outcome?.compaction;
			const marker = (entry as any)?.details?.nativeAppend;
			// A matching operation id cannot authenticate a boundary changed by a later handler.
			if (entry?.type === "compaction" && expected && entry.firstKeptEntryId === expected.firstKeptEntryId && entry.summary === expected.summary && marker.version === 1 && marker.reason === run.event.reason && (marker.standard ?? false) === Boolean(run.standard) && Object.entries(expected.details ?? {}).every(([key, value]) => JSON.stringify(value) === JSON.stringify((entry.details as any)?.[key])) && run.completion) {
				run.applied = true;
				for (const draft of this.callbacks.entries(run.completion)) {
					if (draft.type !== "custom") throw new Error("Native append receipts must be custom metadata");
					this.pi.appendEntry(draft.customType, draft.data);
				}
				this.release(run, ctx);
				await this.callbacks.applied(run.completion, ctx);
				// A held manual compact reports completion through Pi's own callback once the compaction lock is released.
				if (!run.holding) await this.callbacks.finished(ctx, true);
				return;
			}
			run.failureReported = false;
			run.phase = "failed"; run.failure = { kind: "cancel", reason: "context-changed", cacheStatus: run.outcome?.cacheStatus ?? "unknown", usage: run.outcome?.compaction.usage, appendAttempt: run.outcome?.appendAttempt ?? [] };
		}
		if (!run.failure) this.reject(run, "request-failed", ctx);
		if (!run.failureReported) { run.failureReported = true; this.callbacks.failed(run.failure!, Date.now() - run.started, run.model, ctx); }
		if (run.fallbackAllowed && this.sameModel(run, ctx) && ctx.isIdle() && !ctx.hasPendingMessages()) {
			run.phase = "fallback";
			run.fallbackAllowed = false;
			this.fallbackScope = { sessionId: run.sessionId, reason: run.event.reason };
			ctx.compact({ customInstructions: run.event.customInstructions, onComplete: () => { this.release(run, ctx); void this.callbacks.finished(ctx, true); }, onError: () => { this.release(run, ctx); void this.callbacks.finished(ctx, false); } });
			return;
		}
		this.release(run, ctx);
		await this.callbacks.finished(ctx, false);
	}

	/** Keep the original automatic trigger when a standalone fallback is requested via ctx.compact. */
	fallbackReason(): SessionBeforeCompactEvent["reason"] | undefined { return this.fallbackScope?.reason; }

	private resolveHold(run: Run, result: HookResult): void {
		const held = run.held;
		run.held = undefined;
		held?.(result);
	}
	/** True while a held manual compact waits for Pi to save the compaction returned from its hook. */
	awaitsSave(): boolean { return !!this.run?.holding && this.run.phase === "drafted" && !this.run.saved; }
	/** Pi saved the compaction returned from the manual hook; confirm the boundary and publish receipts. */
	async compacted(ctx: ExtensionContext): Promise<void> {
		const run = this.run;
		if (!run?.holding || run.phase !== "drafted" || run.saved) return;
		run.saved = true;
		await this.settled(ctx);
	}
	/** Pi failed to save the compaction returned from the manual hook. */
	async compactFailed(ctx: ExtensionContext): Promise<void> {
		const run = this.run;
		if (!run?.holding || run.phase !== "drafted" || run.saved) return;
		run.saved = true;
		await this.settled(ctx);
	}

	private release(run: Run, ctx: ExtensionContext): void {
		this.resolveHold(run, { cancel: true });
		if (run.timer) clearTimeout(run.timer);
		if (run.startTimer) clearTimeout(run.startTimer);
		if (run.abort) run.event.signal.removeEventListener("abort", run.abort);
		if (this.run === run) this.run = undefined;
		this.fallbackScope = undefined;
		if (this.sameSession(run, ctx) && ctx.hasUI) { ctx.ui.setStatus(STATUS_KEY, undefined); ctx.ui.setWorkingMessage(); }
	}
	/** Invalidate ownership before session/model changes; cleanup is performed only on its original branch. */
	cancel(ctx: ExtensionContext): void {
		const run = this.run;
		if (run) {
			const unstarted = run.phase === "handoff" || run.phase === "scheduled" || run.phase === "queued";
			this.reject(run, "context-changed", ctx);
			// Unstarted operations have no future turn_end, even inside another compact lock.
			if (unstarted || ctx.isIdle()) void this.settled(ctx);
		}
	}
	/** Restore exactly our provider registration, never a replacement installed by another extension. */
	shutdown(ctx: ExtensionContext): void {
		const run = this.run;
		if (run) {
			this.reject(run, "context-changed", ctx);
			if (this.sameSession(run, ctx) && !run.failureReported) {
				run.failureReported = true;
				this.callbacks.failed(run.failure ?? { kind: "cancel", reason: "context-changed", appendAttempt: [], cacheStatus: "unknown" }, Date.now() - run.started, run.model, ctx);
				void this.callbacks.finished(ctx, false);
			}
			this.release(run, ctx);
		}
		this.registration?.restore(); this.registration = undefined;
	}
}
