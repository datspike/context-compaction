import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Provider } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionBoundaryDraft, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { appendTask, buildAppendCompaction, cacheStatus, classifyRequestFailure, COMPACTION_OUTPUT_FORMAT, parseResult, preservesPayloadPrefix, supported, type AppendFallback, type AppendOutcome } from "./append-compaction.js";

import { isNativeCompactionMessage } from "./checkpoint.js";
import { russianCompaction } from "./summary.js";

const SERVICE_PREFIX = "[context-compaction-native:";
const MAX_PAYLOAD_CHARS = 16 * 1024 * 1024;
const WINDOW_MARGIN = 4096;
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
	model: { provider: string; id: string };
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
}

function text(message: unknown): string {
	const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((p) => typeof p?.text === "string" ? p.text : "").join("\n") : "";
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
	return ctx.sessionManager.getBranch().filter((e) => e.type !== "custom" && e.type !== "session_info" && e.type !== "usage");
}
function isService(message: { role?: string; content?: unknown }, ctx: ExtensionContext): boolean {
	return message.role === "user" && text(message).startsWith(SERVICE_PREFIX) && isNativeCompactionMessage({ type: "message", message }, ctx.sessionManager.getBranch());
}

/** Coordinates native service turns while leaving Pi's compact and provider implementations intact. */
export class NativeAppend {
	private run?: Run;
	private decline: AppendFallback = "unsupported";
	private registration?: { registry: ExtensionContext["modelRegistry"]; id: string; proxy: Provider; restore: () => void };
	private fallbackScope?: { sessionId: string; reason: SessionBeforeCompactEvent["reason"] };

	constructor(private readonly pi: ExtensionAPI, private readonly callbacks: Callbacks) {}

	get active(): boolean { return this.run !== undefined; }
	/** Why no guarded native operation was started; permits only a standalone fallback. */
	preflightReason(): AppendFallback { return this.decline; }
	/** The original compact callback reports the handoff, not the eventual native result. */
	ownsCallback(): boolean { return this.run !== undefined && this.run.phase !== "fallback"; }

	private sameSession(run: Run, ctx: ExtensionContext): boolean {
		return ctx.sessionManager.getSessionId() === run.sessionId;
	}
	private sameModel(run: Run, ctx: ExtensionContext): boolean {
		return ctx.model?.provider === run.model.provider && ctx.model.id === run.model.id;
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
			return base.streamSimple(model, context, {
				...options, maxRetries: 0, timeoutMs: 120_000,
				onPayload: async (payload) => {
					const final = (await options?.onPayload?.(payload, model)) ?? payload;
					if (this.run !== run || run.phase !== "response" || !this.sameModel(run, run.ctx) || !this.registrationOwned(run.ctx) || payloadDigest(final) !== run.payloadHash) {
						this.reject(run, "payload-mismatch", run.ctx, true);
						throw new Error("APPEND_COMPACTION_FINAL_PAYLOAD_MISMATCH");
					}
					if (options?.signal?.aborted) throw new Error("APPEND_COMPACTION_ABORTED");
					run.verified = true;
					run.sent = true;
					return final;
				},
			});
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

	/** Intercept prepared compaction only when the current provider can be guarded end to end. */
	before(event: SessionBeforeCompactEvent, ctx: ExtensionContext): { cancel: true } | undefined {
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
		const window = ctx.modelRegistry.find(ctx.model!.provider, ctx.model!.id)?.contextWindow ?? ctx.model!.contextWindow;
		if (!(maxTokens > 0) || event.preparation.tokensBefore + maxTokens + WINDOW_MARGIN >= window) { this.decline = "insufficient-window"; return; }
		const id = randomUUID();
		const run: Run = { id, service: `${SERVICE_PREFIX}${id}] Служебный запрос сводки; не выполняй рабочие действия.`, event, ctx, sessionId: ctx.sessionManager.getSessionId(), model: { provider: ctx.model!.provider, id: ctx.model!.id }, fingerprint: digest(semanticBranch(ctx)), phase: "handoff", started: Date.now(), maxTokens, toolBlocks: 0, fallbackAllowed: false };
		this.run = run;
		run.abort = () => this.reject(run, "aborted", ctx);
		event.signal.addEventListener("abort", run.abort, { once: true });
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "append compact: подготовка");
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
		if (run.event.reason === "manual" && !ctx.isIdle()) return;
		run.phase = "queued";
		this.pi.appendEntry("context-compaction-native", { version: 1, id: run.id, phase: "queued", sessionId: run.sessionId });
		this.pi.sendUserMessage(run.service, { deliverAs: run.event.reason === "manual" ? "followUp" : "steer" });
	}

	/** Transform only our own service input; stale service records are never model instructions. */
	context(messages: AgentMessage[], ctx: ExtensionContext): { messages: AgentMessage[] } | undefined {
		const run = this.run;
		if (run?.standard && run.phase === "drafted") run.continuationStarted = true;
		const last = messages.at(-1);
		let orphan = false;
		const filtered = messages.filter((message) => {
			if (message.role === "user") orphan = isService(message, ctx) && (!run || text(message) !== run.service);
			return !orphan || message.role === "system";
		});
		if (run && last?.role === "user" && !isService(last, ctx) && run.phase !== "drafted" && run.phase !== "fallback") {
			this.reject(run, "context-changed", ctx, false, false);
			void this.settled(ctx);
			return filtered.length !== messages.length ? { messages: filtered } : undefined;
		}
		if (!run || run.phase === "drafted" || run.phase === "fallback" || run.phase === "failed") {
			if (last && isService(last, ctx)) ctx.abort();
			return filtered.length !== messages.length ? { messages: filtered } : undefined;
		}
		if (!last || last.role !== "user" || text(last) !== run.service || !isService(last, ctx) || !this.sameSession(run, ctx) || !this.sameModel(run, ctx)) {
			this.reject(run, "context-changed", ctx); return;
		}
		run.serviceId = [...ctx.sessionManager.getBranch()].reverse().find((e) => e.type === "message" && isService(e.message, ctx) && text(e.message) === run.service)?.id;
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
		if (!value || !Array.isArray(value.input) || text(value.input.at(-1) ?? {}) !== run.task || value.model !== run.model.id || value.prompt_cache_key !== run.sessionId) {
			this.reject(run, "payload-mismatch", ctx, true); throw new Error("APPEND_COMPACTION_NATIVE_PAYLOAD_MISMATCH");
		}
		const serialized = JSON.stringify(value);
		const window = ctx.modelRegistry.find(run.model.provider, run.model.id)?.contextWindow ?? ctx.model!.contextWindow;
		if (serialized.length > MAX_PAYLOAD_CHARS || Math.ceil(serialized.length / 3) + run.maxTokens + WINDOW_MARGIN > window) {
			this.reject(run, "insufficient-window", ctx, true); throw new Error("APPEND_COMPACTION_INSUFFICIENT_WINDOW");
		}
		const baseline = { ...value, input: value.input.slice(0, -1) };
		const next = { ...value, tool_choice: "none", text: { format: COMPACTION_OUTPUT_FORMAT }, max_output_tokens: run.maxTokens };
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
		if (this.run !== run || run.phase === "drafted" || run.phase === "fallback") return;
		if (!run.failure) {
			const fallbackReason = ["unsupported", "snapshot-unavailable", "boundary-unavailable", "insufficient-window", "payload-mismatch"].includes(reason);
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
			if (entry.type !== "message") continue;
			if (entry.message.role === "user") service = isService(entry.message, ctx) && !omitted.has(entry.id);
			if (service && entry.message.role !== "system") ids.add(entry.id);
		}
		return [...ids].filter((id) => id && !omitted.has(id)).map((targetId) => ({ type: "context_edit", targetId, replacement: null }));
	}

	/** Return drafts only; success callbacks wait until Pi has committed the actual compaction. */
	async turn(event: TurnEndEvent, ctx: ExtensionContext): Promise<{ entries: SessionBoundaryDraft[]; continue?: boolean } | undefined> {
		const run = this.run;
		if (!run || run.phase === "drafted" || run.phase === "fallback") {
			const entries = this.cleanup(ctx); return entries.length ? { entries } : undefined;
		}
		if (!this.sameSession(run, ctx)) return;
		const response = event.message as AssistantMessage;
		const current = semanticBranch(ctx).filter((e) => e.id !== event.messageEntryId && !event.toolResultEntryIds.includes(e.id));
		if (run.event.willRetry && (!this.sameModel(run, ctx) || digest(current) !== run.fingerprint)) { run.fallbackAllowed = false; this.reject(run, "context-changed", ctx); }
		if (!run.failure && (!this.sameModel(run, ctx) || digest(current) !== run.fingerprint || !run.verified || !run.messages || !run.serviceId)) this.reject(run, "context-changed", ctx);
		if (!run.failure && response.stopReason === "aborted") this.reject(run, "aborted", ctx);
		if (!run.failure && response.stopReason === "error") {
			this.reject(run, "request-failed", ctx, true);
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
				return { entries: [
					{ type: "compaction", summary: run.outcome.compaction.summary, firstKeptEntryId: run.outcome.compaction.firstKeptEntryId, usage: response.usage, details: { ...run.outcome.compaction.details, nativeAppend: { version: 1, id: run.id, reason: run.event.reason } } },
					...this.cleanup(ctx, [run.serviceId!, event.messageEntryId, ...event.toolResultEntryIds]),
				], continue: run.event.willRetry };
			}
		}
		if (run.failure?.kind === "cancel") {
			const usage = response.stopReason !== "aborted" && response.usage?.totalTokens > 0 ? response.usage : undefined;
			run.failure = { ...run.failure, usage, cacheStatus: cacheStatus(usage, Boolean(run.sent)) };
		}
		const standard = await this.prepareStandard(ctx);
		if (standard) return { ...standard, entries: [...standard.entries, ...this.cleanup(ctx, [event.messageEntryId, ...event.toolResultEntryIds])] };
		return { entries: this.cleanup(ctx, [event.messageEntryId, ...event.toolResultEntryIds]) };
	}

	/** Preserve overflow recovery at a public boundary instead of creating a manual compact. */
	private async prepareStandard(ctx: ExtensionContext): Promise<{ entries: SessionBoundaryDraft[]; continue: true } | undefined> {
		const run = this.run;
		if (!run?.failure || !run.fallbackAllowed || !run.event.willRetry || run.phase !== "failed" || ctx.hasPendingMessages()) return;
		if (!this.sameSession(run, ctx) || !this.sameModel(run, ctx) || !this.registrationOwned(ctx) || run.signal?.aborted || run.event.signal.aborted) return;
		const fingerprint = digest(semanticBranch(ctx));
		if (!run.failureReported) { run.failureReported = true; this.callbacks.failed(run.failure, Date.now() - run.started, run.model, ctx); }
		run.phase = "standard";
		run.fallbackAllowed = false;
		const result = await russianCompaction({ ...run.event, signal: run.signal ?? run.event.signal }, ctx);
		if (this.run !== run || run.phase !== "standard") return;
		if (!result || !this.sameSession(run, ctx) || !this.sameModel(run, ctx) || !this.registrationOwned(ctx) || digest(semanticBranch(ctx)) !== fingerprint || run.signal?.aborted || run.event.signal.aborted || ctx.hasPendingMessages()) {
			run.phase = "failed";
			return;
		}
		run.standard = run.failure;
		run.outcome = { kind: "success", compaction: result.compaction, cacheStatus: cacheStatus(result.compaction.usage, true), appendAttempt: [{ attempt: 1, phase: "apply", toolBlocks: 0, toolBlockTypes: [], repairAttempts: 0 }] };
		run.completion = this.completion(run);
		run.phase = "drafted";
		return { entries: [{ type: "compaction", summary: result.compaction.summary, firstKeptEntryId: result.compaction.firstKeptEntryId, usage: result.compaction.usage, details: { ...result.compaction.details, nativeAppend: { version: 1, id: run.id, reason: run.event.reason, standard: true } } }], continue: true };
	}

	/** Error responses end the low-level loop even after a turn-boundary continuation decision. */
	async beforeSettle(ctx: ExtensionContext): Promise<{ continue: true } | undefined> {
		const run = this.run;
		if (!run?.standard || run.phase !== "drafted" || run.continuationStarted) return;
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
			const entry = ctx.sessionManager.getBranch().find((e) => e.type === "compaction" && (e.details as any)?.nativeAppend?.id === run.id);
			if (entry && run.completion) {
				run.applied = true;
				for (const draft of this.callbacks.entries(run.completion)) {
					if (draft.type !== "custom") throw new Error("Native append receipts must be custom metadata");
					this.pi.appendEntry(draft.customType, draft.data);
				}
				this.release(run, ctx);
				await this.callbacks.applied(run.completion, ctx);
				await this.callbacks.finished(ctx, true);
				return;
			}
			run.failureReported = false;
			run.phase = "failed"; run.failure = { kind: "cancel", reason: "context-changed", cacheStatus: run.outcome?.cacheStatus ?? "unknown", usage: run.outcome?.compaction.usage, appendAttempt: run.outcome?.appendAttempt ?? [] };
		}
		if (!run.failure) this.reject(run, "request-failed", ctx);
		if (!run.failureReported) { run.failureReported = true; this.callbacks.failed(run.failure!, Date.now() - run.started, run.model, ctx); }
		if (run.fallbackAllowed && this.sameModel(run, ctx) && ctx.isIdle() && !ctx.hasPendingMessages()) {
			run.phase = "fallback";
			this.fallbackScope = { sessionId: run.sessionId, reason: run.event.reason };
			ctx.compact({ customInstructions: run.event.customInstructions, onComplete: () => { this.release(run, ctx); void this.callbacks.finished(ctx, true); }, onError: () => { this.release(run, ctx); void this.callbacks.finished(ctx, false); } });
			return;
		}
		this.release(run, ctx);
		await this.callbacks.finished(ctx, false);
	}

	/** Keep the original automatic trigger when a standalone fallback is requested via ctx.compact. */
	fallbackReason(): SessionBeforeCompactEvent["reason"] | undefined { return this.fallbackScope?.reason; }

	private release(run: Run, ctx: ExtensionContext): void {
		if (run.timer) clearTimeout(run.timer);
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
