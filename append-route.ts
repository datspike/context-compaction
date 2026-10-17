import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Provider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { omittedFromContext, outsideContext, supported, systemShape, type AppendFallback, type AppendSnapshot } from "./append-compaction.js";
import { isNativeCompactionMessage } from "./checkpoint.js";
import type { CompactCapability } from "./compact-budget.js";

type StreamArgs = Parameters<Provider["streamSimple"]>;
type Manager = ExtensionContext["sessionManager"];

/** Pi's short tier is about five minutes; used when the model declares no `promptCache` lifetime. */
export const DEFAULT_CACHE_TTL_MS = 300_000;
/** A request sent this close to expiry may outlive the cache entry it reads. */
export const CACHE_EXPIRY_MARGIN_MS = 15_000;
const MAX_CAPTURE_CHARS = 16 * 1024 * 1024;
const SERVICE_PREFIX = "[context-compaction-native:";

/** The last working request of this process, held in memory only. */
interface Capture {
	sessionId: string;
	anchor: string;
	model: StreamArgs[0];
	context: StreamArgs[1];
	options: StreamArgs[2];
	payload?: unknown;
	sentAt: number;
	settledAt?: number;
	refreshedAt?: number;
	stopReason?: string;
	usage?: AssistantMessage["usage"];
}

/** Content-free comparison of the coming append with the last request actually sent. */
export interface CacheCheck {
	captured: boolean;
	warmed?: boolean;
	stopReason?: string;
	pauseMs?: number;
	ttlMs?: number;
	ttlSource?: "model" | "default";
	cacheRetention?: string;
	route?: { session: boolean; provider: boolean; model: boolean; baseUrl: boolean };
	cacheKey?: "present" | "absent";
	inputItems?: number;
	lastRequest?: { input: number; cacheRead: number; output: number; cost: number };
}

export type RoutePlan = { snapshot: AppendSnapshot; check: CacheCheck } | { fallback: AppendFallback; check: CacheCheck };

function text(message: unknown): string {
	const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n") : "";
}

function sameMessages(left: readonly unknown[], right: readonly unknown[]): boolean {
	return left.length === right.length && left.every((message, index) => message === right[index]);
}

/**
 * Owns the provider wrapper that remembers the last working request of the session.
 * Append is sent only as a continuation of that request, while its cache entry is still alive.
 */
export class AppendRoute {
	private capture?: Capture;
	private registration?: { registry: ExtensionContext["modelRegistry"]; id: string; base: Provider; proxy: Provider; restore: () => void };
	private manager?: Manager;

	/** Wrap the current provider so its working requests can be continued; idempotent for the same provider. */
	install(ctx: ExtensionContext): boolean {
		this.manager = ctx.sessionManager;
		if (!ctx.model || !supported(ctx) || typeof ctx.modelRegistry.getProvider !== "function") return false;
		if (this.registration) {
			if (this.registration.id === ctx.model.provider && this.owned(ctx)) return true;
			this.uninstall();
		}
		const registry = ctx.modelRegistry;
		const id = ctx.model.provider;
		const base = registry.getProvider(id);
		if (!base) return false;
		const previousNative = registry.getRegisteredNativeProvider(id);
		const previousConfig = registry.getRegisteredProviderConfig(id);
		const stream: Provider["streamSimple"] = (model, context, options) => this.observe(base, model, context, options);
		const proxy = new Proxy(base, { get(target, key) {
			if (key === "streamSimple") return stream;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		} });
		registry.registerProvider(proxy);
		this.registration = { registry, id, base, proxy, restore: () => {
			if (registry.getRegisteredNativeProvider(id) !== proxy) return;
			registry.unregisterProvider(id);
			if (previousNative) registry.registerProvider(previousNative);
			else if (previousConfig) registry.registerProvider(id, previousConfig);
		} };
		return true;
	}

	/** Restore exactly our registration, never a replacement installed by another extension. */
	uninstall(): void {
		this.registration?.restore();
		this.registration = undefined;
		this.capture = undefined;
	}

	/** Forget the captured request: a new session or model never continues the old prefix. */
	reset(ctx?: ExtensionContext): void {
		this.capture = undefined;
		if (ctx) this.manager = ctx.sessionManager;
	}

	private owned(ctx: ExtensionContext): boolean {
		return !!this.registration && this.registration.registry === ctx.modelRegistry && ctx.modelRegistry.getRegisteredNativeProvider(this.registration.id) === this.registration.proxy;
	}

	/** Branch entry that produced the last message of a working request; its timestamp survives context transforms. */
	private anchorOf(context: StreamArgs[1]): string | undefined {
		const last = context.messages.at(-1) as { role?: string; timestamp?: number } | undefined;
		if (!this.manager || !last || typeof last.timestamp !== "number") return;
		const branch = this.manager.getBranch(), omitted = omittedFromContext(branch);
		const contextual = [...branch].reverse().filter((item) => !outsideContext(item) && item.type !== "thinking_level_change" && !omitted.has(item.id));
		const matches = (entry: (typeof branch)[number] | undefined): boolean => entry?.type === "message" ? entry.message.role === last.role && entry.message.timestamp === last.timestamp
			// Pi turns a custom message into a user message with the entry timestamp.
			: entry?.type === "custom_message" && last.role === "user" && new Date(entry.timestamp).getTime() === last.timestamp;
		if (matches(contextual[0])) return contextual[0].id;
		// A threshold compact inside a turn is followed by a request whose context already holds the summary and ends with the kept tail;
		// the compaction itself is then the point the append continues from.
		if (contextual[0]?.type === "compaction" && matches(contextual[1])) return contextual[0].id;
		return;
	}

	private observe(base: Provider, model: StreamArgs[0], context: StreamArgs[1], options: StreamArgs[2]) {
		const sessionId = this.manager?.getSessionId();
		// Only agent requests of this session carry the SDK payload hooks and the transcript system head.
		const working = !!sessionId && options?.sessionId === sessionId && typeof options.onPayload === "function" && context.messages[0]?.role === "system";
		if (!working) return base.streamSimple(model, context, options);
		const previous = this.capture;
		// Pi's cache warmer replays the same context; it refreshes the entry instead of replacing the capture.
		// Only a settled, successful capture is warm; an automatic retry of a failed request replaces it instead.
		const warm = previous?.settledAt !== undefined && previous.stopReason !== "error" && previous.stopReason !== "aborted";
		if (previous && warm && previous.model.id === model.id && sameMessages(previous.context.messages, context.messages)) {
			const replay = base.streamSimple(model, context, options);
			void replay.result().then((message) => { if (this.capture === previous && message.stopReason !== "error" && message.stopReason !== "aborted") previous.refreshedAt = Date.now(); }, () => undefined);
			return replay;
		}
		const anchor = this.anchorOf(context);
		if (!anchor) { this.capture = undefined; return base.streamSimple(model, context, options); }
		const capture: Capture = { sessionId, anchor, model, context: { ...context, messages: [...context.messages] }, options, sentAt: Date.now() };
		const result = base.streamSimple(model, context, { ...options, onPayload: async (payload, payloadModel) => {
			const final = (await options!.onPayload!(payload, payloadModel)) ?? payload;
			// The provider sends exactly this value; the append request must reproduce it as its prefix.
			if (JSON.stringify(final).length <= MAX_CAPTURE_CHARS) { capture.payload = final; capture.sentAt = Date.now(); this.capture = capture; }
			else if (this.capture === previous) this.capture = undefined;
			return final;
		} });
		void result.result().then((message) => {
			if (this.capture !== capture) return;
			capture.settledAt = Date.now(); capture.stopReason = message.stopReason; capture.usage = message.usage;
		}, () => { if (this.capture === capture) capture.stopReason = "error"; });
		return result;
	}

	/** Decide before any paid request whether append can continue a warm cached prefix. */
	plan(ctx: ExtensionContext, capability: CompactCapability, now = Date.now()): RoutePlan {
		const capture = this.capture;
		if (!supported(ctx) || !this.owned(ctx)) return { fallback: "unsupported", check: { captured: !!capture } };
		if (!capture?.payload) return { fallback: "no-sent-request", check: { captured: false } };
		const retention = capture.options?.cacheRetention ?? "short";
		const declared = retention === "none" ? undefined : (capture.model as { promptCache?: Record<string, number | undefined> }).promptCache?.[retention];
		const ttlMs = typeof declared === "number" && declared > 0 ? declared * 1000 : DEFAULT_CACHE_TTL_MS;
		const last = capture.refreshedAt ?? capture.settledAt;
		const payload = capture.payload as { prompt_cache_key?: unknown; input?: unknown[] };
		const check: CacheCheck = {
			captured: true, warmed: capture.settledAt !== undefined && capture.stopReason !== "error" && capture.stopReason !== "aborted", ...(capture.stopReason ? { stopReason: capture.stopReason } : {}),
			...(last === undefined ? {} : { pauseMs: now - last }), ttlMs, ttlSource: typeof declared === "number" && declared > 0 ? "model" : "default", cacheRetention: retention,
			route: { session: capture.sessionId === ctx.sessionManager.getSessionId(), provider: capture.model.provider === ctx.model?.provider, model: capture.model.id === ctx.model?.id, baseUrl: capture.model.baseUrl === ctx.model?.baseUrl },
			cacheKey: payload.prompt_cache_key === undefined ? "absent" : "present",
			...(Array.isArray(payload.input) ? { inputItems: payload.input.length } : {}),
			...(capture.usage ? { lastRequest: { input: capture.usage.input, cacheRead: capture.usage.cacheRead, output: capture.usage.output, cost: capture.usage.cost.total } } : {}),
		};
		if (!Object.values(check.route!).every(Boolean)) return { fallback: "route-changed", check };
		if (!check.warmed) return { fallback: "not-warmed", check };
		if (check.pauseMs === undefined || check.pauseMs > ttlMs - CACHE_EXPIRY_MARGIN_MS) return { fallback: "cache-expired", check };
		const messages = capture.context.messages as AppendSnapshot["messages"];
		return { check, snapshot: {
			sessionId: capture.sessionId, anchor: capture.anchor, provider: capture.model.provider, modelId: capture.model.id,
			messages, systemShape: systemShape(messages[0]), payload: capture.payload as AppendSnapshot["payload"],
			request: { model: capture.model, context: capture.context, options: capture.options },
			stream: (...args) => this.registration!.base.streamSimple(...args), window: capability.window, capability,
		} };
	}
}

/**
 * Sessions written by the former service-turn append may still hold an unfinished service request.
 * It is an instruction to this extension, never to the model: drop it and the replies that answered it.
 */
export function withoutLegacyServiceTurns(messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[] | undefined {
	let service = false, changed = false;
	const branch = ctx.sessionManager.getBranch();
	const kept = messages.filter((message) => {
		if (message.role === "user" || message.role === "custom") {
			const entry = message.role === "custom" ? { type: "custom_message", customType: (message as { customType?: string }).customType, content: (message as { content?: unknown }).content } : { type: "message", message };
			service = text(message).startsWith(SERVICE_PREFIX) && isNativeCompactionMessage(entry, branch);
		}
		const drop = service && message.role !== "system";
		if (drop) changed = true;
		return !drop;
	});
	return changed ? kept : undefined;
}
