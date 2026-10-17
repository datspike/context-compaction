import { randomUUID } from "node:crypto";
import { NativeAppend } from "./native-append.js";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendAudit, type AuditEntry, type AuditReason } from "./audit.js";
import {
	buildInstructions,
	buildLedger,
	CheckpointParamsSchema,
	checkpointParamsSchema,
	compactedSinceLastUserMessage,
	contextCompactionFollowUp,
	continuationPrompt,
	isHumanUserMessage,
	prepareArguments,
	type CheckpointParams,
} from "./checkpoint.js";
import { COMPACT_CARD_TYPE, estimateSummaryTokens, renderCompactCard, type CompactCardData } from "./card.js";
import { loadSummarySettings } from "./language.js";
import { appendCompaction } from "./append-compaction.js";
import {
	ECONOMY_WINDOW,
	formatFooter,
	LONG_CHAT_MAXIMUM,
	resolvePolicy,
	type ContextMode,
} from "./policy.js";
import { appendMode, hasLegacyThreshold, restoreMode } from "./session-state.js";
import { russianCompaction, russianTreeSummary } from "./summary.js";

export function appendUsageForAudit(outcome: Awaited<ReturnType<typeof appendCompaction>>): unknown {
	return outcome.kind === "success" ? outcome.compaction.usage : outcome.kind === "cancel" ? outcome.usage : undefined;
}

export function appendAuditPayload(outcome: Awaited<ReturnType<typeof appendCompaction>>, durationMs: number, model: { provider?: string; id?: string } | undefined): Record<string, unknown> {
    return {
        version: 2,
        outcome: outcome.kind,
        reason: "reason" in outcome ? outcome.reason : undefined,
        durationMs,
        provider: model?.provider,
        model: model?.id,
        repairAttempts: "repairAttempts" in outcome ? outcome.repairAttempts ?? 0 : 0,
        usage: appendUsageForAudit(outcome),
        appendAttempt: outcome.appendAttempt,
        cacheStatus: outcome.cacheStatus,
        ...(outcome.validationGuard ? { validationGuard: outcome.validationGuard } : {}),
        ...(outcome.requestFailure ? { requestFailure: outcome.requestFailure } : {}),
        ...(outcome.kind === "fallback" && outcome.reason === "payload-mismatch" && outcome.payloadMismatch ? { payloadMismatch: outcome.payloadMismatch } : {}),
    };
}

type ContextCompletion = { value: string; label: string; description: string };
type Scope = { sessionId: string; branch: string };
type UserWatermark = string | null;
type GoalSnapshot = { kind: "none" } | { kind: "active"; goalId: string } | { kind: "inactive"; goalId: string; status: string };
type SessionEntry = { id?: string; timestamp?: string; type?: string; customType?: string; data?: unknown; message?: { role?: string; content?: unknown } };
type ManualOperation = {
	correlation: string;
	origin: "manual-tool";
	reason: "manual";
	params: CheckpointParams;
	scope: Scope;
	modelRoute: string;
	userWatermark: UserWatermark;
	goal: GoalSnapshot;
	lifecycle: "pending" | "running" | "success" | "error" | "cancel";
	continuationClaimed: boolean;
	continuationSuppressed: boolean;
};

const CONTEXT_COMPLETIONS: ContextCompletion[] = [
	{ value: "status", label: "status", description: "Показать текущий режим, окно и порог" },
	{ value: "economy", label: "economy", description: "Консервативное окно, ограниченное capability модели" },
	{ value: "long-once", label: "long-once", description: "Увеличенное окно по declared capability до следующего compact" },
	{ value: "long-chat", label: "long-chat", description: "Постоянное увеличенное окно по declared capability" },
	{ value: "off", label: "off", description: "Вернуть declared registry-окно без extension soft cap" },
];
const STATUS_KEY = "context-compaction";
const GLOBAL_STATE = globalThis as typeof globalThis & { __piContextCompactionLegacyNoticesV2?: Set<string> };
const LEGACY_NOTICE_SESSIONS = GLOBAL_STATE.__piContextCompactionLegacyNoticesV2 ??= new Set<string>();

export function getContextArgumentCompletions(prefix: string, language: "ru" | "en" = "ru"): ContextCompletion[] | null {
	const items = CONTEXT_COMPLETIONS.filter((item) => item.value.startsWith(prefix.trimStart()));
	if (!items.length) return null;
	if (language === "ru") return items;
	const descriptions: Record<string, string> = { status: "Show the current mode, window and threshold", economy: "Conservative window bounded by model capability", "long-once": "Extended window until the next compaction", "long-chat": "Persistent extended window within model capability", off: "Restore the declared registry window" };
	return items.map((item) => ({ ...item, description: descriptions[item.value] }));
}

type RegistryDeclaration = { contextWindow?: number; hasLongPricingTier: boolean };

function modelDeclaration(ctx: ExtensionContext): RegistryDeclaration {
	const model = ctx.model;
	const candidate = model && ctx.modelRegistry.getAll().find((entry) => entry.provider === model.provider && entry.id === model.id);
	const contextWindow = candidate?.contextWindow;
	const hasLongPricingTier =
		Number.isFinite(contextWindow) &&
		contextWindow! >= ECONOMY_WINDOW &&
		(candidate?.cost?.tiers?.some((tier) => Number.isFinite(tier.inputTokensAbove) && tier.inputTokensAbove >= contextWindow!) ?? false);
	return { contextWindow, hasLongPricingTier };
}

function notice(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
}

function scopeOf(ctx: ExtensionContext, anonymousIdentities: WeakMap<object, Map<string, string>>): Scope {
	const manager = ctx.sessionManager;
	const branch = manager.getBranch() as Array<{ id?: string; timestamp?: string; type?: string }>;
	let sessionId = manager.getSessionId() || manager.getSessionFile();
	if (!sessionId) {
		let identities = anonymousIdentities.get(manager as object);
		if (!identities) { identities = new Map<string, string>(); anonymousIdentities.set(manager as object, identities); }
		const root = branch[0];
		const rootKey = root ? `${root.id ?? root.timestamp ?? root.type ?? "empty"}` : "manager-root";
		sessionId = identities.get(rootKey);
		if (!sessionId) { sessionId = randomUUID(); identities.set(rootKey, sessionId); }
	}
	const leaf = branch.at(-1);
	return { sessionId, branch: String(leaf?.id ?? leaf?.timestamp ?? leaf?.type ?? "empty") };
}

function branchContains(ctx: ExtensionContext, anchor: string): boolean {
	return (ctx.sessionManager.getBranch() as SessionEntry[]).some((entry) => String(entry.id ?? entry.timestamp ?? entry.type ?? "empty") === anchor);
}

function entryIdentity(entry: SessionEntry, index: number): string {
	return String(entry.id ?? entry.timestamp ?? `${entry.type ?? "entry"}:${index}`);
}

function userWatermark(entries: readonly SessionEntry[]): UserWatermark {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (isHumanUserMessage(entries[index], entries)) return entryIdentity(entries[index], index);
	}
	return null;
}

type DurableGoal = { goalId: string; status: string; updatedAt?: number; usage?: { tokensUsed: number; activeSeconds: number } };

function goalSnapshot(entries: readonly SessionEntry[]): GoalSnapshot {
	let goal: DurableGoal | null = null;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "pi-codex-goal" || !entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as { kind?: unknown; source?: unknown; goalId?: unknown; status?: unknown; updatedAt?: unknown; usage?: unknown; goal?: { goalId?: unknown; status?: unknown; updatedAt?: unknown; usage?: unknown } };
		if (data.kind === "clear") { goal = null; continue; }
		if (data.kind === "set" && typeof data.goal?.goalId === "string" && typeof data.goal.status === "string") {
			const usage = data.goal.usage as { tokensUsed?: unknown; activeSeconds?: unknown } | undefined;
			goal = { goalId: data.goal.goalId, status: data.goal.status, updatedAt: typeof data.goal.updatedAt === "number" ? data.goal.updatedAt : undefined, usage: typeof usage?.tokensUsed === "number" && typeof usage.activeSeconds === "number" ? { tokensUsed: usage.tokensUsed, activeSeconds: usage.activeSeconds } : undefined };
			continue;
		}
		if (data.kind !== "usage" || data.source !== "runtime" || !goal || data.goalId !== goal.goalId || (goal.status !== "active" && goal.status !== "budgetLimited") || (data.status !== "active" && data.status !== "budgetLimited") || (goal.status === "budgetLimited" && data.status === "active")) continue;
		const usage = data.usage as { tokensUsed?: unknown; activeSeconds?: unknown } | undefined;
		if (typeof data.updatedAt !== "number" || typeof usage?.tokensUsed !== "number" || typeof usage.activeSeconds !== "number" || (goal.updatedAt !== undefined && data.updatedAt < goal.updatedAt) || (goal.usage && (usage.tokensUsed < goal.usage.tokensUsed || usage.activeSeconds < goal.usage.activeSeconds))) continue;
		goal = { goalId: goal.goalId, status: data.status, updatedAt: data.updatedAt, usage: { tokensUsed: usage.tokensUsed, activeSeconds: usage.activeSeconds } };
	}
	if (!goal) return { kind: "none" };
	return goal.status === "active" ? { kind: "active", goalId: goal.goalId } : { kind: "inactive", goalId: goal.goalId, status: goal.status };
}

function continuationGoalIsValid(snapshot: GoalSnapshot, entries: readonly SessionEntry[]): boolean {
	const current = goalSnapshot(entries);
	if (snapshot.kind === "none") return current.kind === "none";
	if (snapshot.kind === "inactive") return snapshot.status === "complete" && current.kind === "inactive" && current.status === "complete" && current.goalId === snapshot.goalId;
	return (current.kind === "active" || current.kind === "inactive" && current.status === "complete") && current.goalId === snapshot.goalId;
}

/** Public-API extension: Pi owns automatic compaction and automatic continuation. */
export default function contextCompaction(pi: ExtensionAPI): void {
	const settings = loadSummarySettings();
	const language = settings.summaryLanguage;
    /** Итог append между session_before_compact и session_compact: receipt подтверждаем только после сохранения compaction. */
    type PendingScope = { sessionId?: string; anchor?: string };
    type PendingCard = Pick<CompactCardData, "kind" | "fallbackReason" | "provider" | "model" | "durationMs" | "appendDurationMs" | "appendUsage" | "appendCacheStatus" | "repairAttempts"> & { scope: PendingScope };
    let pendingCard: PendingCard | undefined;
    type AppendOutcome = Awaited<ReturnType<typeof appendCompaction>>;
    const currentScope = (ctx: ExtensionContext, anchor?: string): PendingScope => { const scope = scopeOf(ctx, anonymousIdentities); return { sessionId: scope.sessionId, anchor: anchor ?? scope.branch }; };
    const scopeMatches = (pending: PendingScope, ctx: ExtensionContext): boolean => pending.sessionId === ctx.sessionManager.getSessionId() && (!pending.anchor || ctx.sessionManager.getBranch().some((entry) => entry.id === pending.anchor));
    let summarySequence = 0;
    const standard = async (event: any, ctx: ExtensionContext) => {
        const generation = ++summarySequence;
        return russianCompaction(event, ctx, {
            model: native.serviceModel(ctx), capability: native.capability(ctx),
            isCurrent: () => generation === summarySequence,
            onFailure: (reason) => {
                pi.appendEntry("context-compaction-standard", { version: 1, reason });
                if (reason !== "aborted") notice(ctx, `Compact: ${reason}`, "warning");
            },
        });
    };
    const summarize = async (event: any, ctx: ExtensionContext) => {
        if (!settings.appendCompaction || native.fallbackReason()) return standard(event, ctx);
        pendingCard = undefined;
        const handoff = native.before(event, ctx);
        if (handoff) return handoff;
        const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
        const outcome: AppendOutcome = { kind: "fallback", reason: native.preflightReason(), cacheStatus: "not-attempted", appendAttempt: [{ attempt: 0, phase: "preflight", toolBlocks: 0, toolBlockTypes: [], repairAttempts: 0 }] };
        pi.appendEntry("context-compaction-append", appendAuditPayload(outcome, 0, model));
        const started = Date.now();
        const compact = await standard(event, ctx);
        if (!("compaction" in compact)) return compact;
        pendingCard = { kind: "standard", fallbackReason: outcome.reason, provider: model?.provider, model: model?.id, appendDurationMs: 0, appendCacheStatus: "not-attempted", durationMs: Date.now() - started, repairAttempts: 0, scope: currentScope(ctx) };
        return compact;
    };
	const text = (ru: string, en: string): string => language === "ru" ? ru : en;
	let mode: ContextMode = "economy";
	let operation: ManualOperation | undefined;
	let sequence = 0;
	let useActualWindowFallback = false;
	let internalModelTransition = false;
	let windowErrorNotified = false;
	const runtimeId = randomUUID();
	const anonymousIdentities = new WeakMap<object, Map<string, string>>();
	const nextCorrelation = (): string => `${runtimeId}-${++sequence}`;
	const resolvedPolicy = (ctx: ExtensionContext) => {
		const declaration = modelDeclaration(ctx);
		const sessionOverrideWindow = declaration.hasLongPricingTier ? LONG_CHAT_MAXIMUM : undefined;
		return resolvePolicy(mode, ctx.model, declaration.contextWindow, { sessionOverrideWindow, longPricingTierAvailable: declaration.hasLongPricingTier });
	};
	const currentPolicy = (ctx: ExtensionContext) => {
		const policy = resolvedPolicy(ctx);
		const actualWindow = ctx.model?.contextWindow;
		return !useActualWindowFallback || !actualWindow || actualWindow <= 0 ? policy : {
			...policy,
			mode,
			window: actualWindow,
			threshold: mode === "off" ? undefined : Math.floor(actualWindow * 0.75),
			source: mode === "off" ? "off" as const : "fallback" as const,
		};
	};
	const setModelInternally = async (model: any): Promise<boolean> => {
		internalModelTransition = true;
		try {
			return await pi.setModel(model);
		} finally {
			internalModelTransition = false;
		}
	};
	const audit = (ctx: ExtensionContext, op: { correlation: string; origin: AuditEntry["origin"]; scope: Scope }, phase: AuditEntry["phase"], reason: AuditReason, willRetry = false, tokensOverride?: number | null): void => {
		const policy = currentPolicy(ctx);
		appendAudit(pi, { version: 2, correlation: op.correlation, origin: op.origin, reason, phase, tokens: tokensOverride ?? ctx.getContextUsage()?.tokens ?? null, window: policy.window, threshold: policy.threshold ?? null, mode, source: policy.source, willRetry, sessionId: op.scope.sessionId, tree: op.scope.branch });
	};
	const external = (ctx: ExtensionContext, phase: AuditEntry["phase"], reason: AuditReason, willRetry: boolean, tokens?: number): void => audit(ctx, { correlation: nextCorrelation(), origin: "external-unattributed", scope: scopeOf(ctx, anonymousIdentities) }, phase, reason, willRetry, tokens);
	const updateFooter = (ctx: ExtensionContext): void => { if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, formatFooter(native.contextTokens(ctx), currentPolicy(ctx))); };
	const setMode = (next: ContextMode, persist: boolean): void => { if (mode !== next) { mode = next; if (persist) appendMode(pi, next); } };
	const manualIdentity = (ctx: ExtensionContext): string => JSON.stringify(ctx.model ? [ctx.model.provider, ctx.model.id, ctx.model.api, ctx.model.baseUrl ?? ""] : null);
	const isCurrent = (ctx: ExtensionContext, op: ManualOperation, lifecycle?: ManualOperation["lifecycle"]): boolean => {
		const actual = scopeOf(ctx, anonymousIdentities);
		return operation === op && (!lifecycle || op.lifecycle === lifecycle) && op.scope.sessionId === actual.sessionId && op.modelRoute === manualIdentity(ctx) && branchContains(ctx, op.scope.branch);
	};
	const currentOperation = (ctx: ExtensionContext): ManualOperation | undefined => {
		if (operation && !isCurrent(ctx, operation)) operation = undefined;
		return operation;
	};
	const ensureWindow = async (ctx: ExtensionContext, fallbackMode: ContextMode = "economy"): Promise<boolean> => {
		useActualWindowFallback = false;
		windowErrorNotified = false;
		const policy = resolvedPolicy(ctx);
		if (policy.mode !== mode) { setMode("economy", true); await ensureWindow(ctx); updateFooter(ctx); return false; }
		if (!ctx.model || policy.window <= 0 || ctx.model.contextWindow === policy.window) return true;
		const previousModel = ctx.model;
		const thinkingLevel = pi.getThinkingLevel();
		const restorePreviousModel = async (): Promise<boolean> => {
			const matchesPrevious = () => ctx.model?.provider === previousModel.provider && ctx.model?.id === previousModel.id && ctx.model?.contextWindow === previousModel.contextWindow;
			if (matchesPrevious()) return true;
			try {
				if (!await setModelInternally(previousModel)) return false;
				pi.setThinkingLevel(thinkingLevel);
				return matchesPrevious();
			} catch {
				return false;
			}
		};
		try {
			if (!await setModelInternally({ ...ctx.model, contextWindow: policy.window })) throw new Error("setModel returned false");
			pi.setThinkingLevel(thinkingLevel);
		} catch {
			const restored = await restorePreviousModel();
			let safeMode = false;
			if (restored) {
				setMode(fallbackMode, true);
				safeMode = ctx.model?.contextWindow === resolvedPolicy(ctx).window;
				useActualWindowFallback = !safeMode;
			} else {
				setMode("economy", true);
				useActualWindowFallback = true;
			}
			const message = safeMode
				? text("Не удалось применить окно контекста; сохранён прежний режим", "Could not apply the context window; retained the previous mode")
				: text("Не удалось применить окно контекста и восстановить согласованное окно; отображается фактическое окно, повторите выбор economy", "Could not apply the context window or restore a consistent window; showing the actual window, select economy again");
			updateFooter(ctx);
			notice(ctx, message, "error");
			windowErrorNotified = true;
			return false;
		}
		updateFooter(ctx);
		return true;
	};
	const cancel = (ctx: ExtensionContext, op: ManualOperation): void => {
		if (!isCurrent(ctx, op) || (op.lifecycle !== "pending" && op.lifecycle !== "running")) return;
		op.lifecycle = "cancel";
		audit(ctx, op, "cancel", "manual");
		operation = undefined;
	};
	const fail = (ctx: ExtensionContext, op: ManualOperation, willRetry = false): void => {
		if (operation !== op || (op.lifecycle !== "pending" && op.lifecycle !== "running")) return;
		op.lifecycle = "error";
		audit(ctx, op, "error", "manual", willRetry);
		operation = undefined;
		updateFooter(ctx);
	};
	const restoreAfterSuccessfulCompact = async (ctx: ExtensionContext): Promise<void> => {
		if (mode === "long-once") { setMode("economy", true); await ensureWindow(ctx, "long-once"); }
		else if (mode === "long-chat") await ensureWindow(ctx);
		updateFooter(ctx);
	};
	/** session_compact подтверждает успех, но Pi ещё не освободил compaction lock. */
	const markManualSuccess = (ctx: ExtensionContext, op: ManualOperation): void => {
		if (!isCurrent(ctx, op, "running")) return;
		op.lifecycle = "success";
		audit(ctx, op, "success", "manual");
		updateFooter(ctx);
	};
	/** onComplete вызывается после AgentSession.compact() finally, когда follow-up уже разрешён. */
	const continueManualAfterCompaction = async (ctx: ExtensionContext, op: ManualOperation): Promise<void> => {
		if (!isCurrent(ctx, op, "success")) return;
		await restoreAfterSuccessfulCompact(ctx);
		const entries = ctx.sessionManager.getBranch() as SessionEntry[];
		if (!isCurrent(ctx, op, "success") || op.continuationClaimed || op.continuationSuppressed || ctx.hasPendingMessages() || userWatermark(entries) !== op.userWatermark || !continuationGoalIsValid(op.goal, entries)) { operation = undefined; return; }
		// In-memory guard covers duplicate callbacks. Pi's public ExtensionAPI does not
		// expose queue acknowledgement, so this records one invocation after the core lock.
		op.continuationClaimed = true;
		try {
			const revalidated = ctx.sessionManager.getBranch() as SessionEntry[];
			if (!isCurrent(ctx, op, "success") || op.continuationSuppressed || ctx.hasPendingMessages() || userWatermark(revalidated) !== op.userWatermark || !continuationGoalIsValid(op.goal, revalidated)) return;
			pi.sendUserMessage(contextCompactionFollowUp(continuationPrompt(op.params, language), op.correlation), { deliverAs: "followUp" });
			audit(ctx, op, "continuation-claimed", "manual");
			audit(ctx, op, "send-attempted", "manual");
		} catch {
			audit(ctx, op, "error", "manual");
			notice(ctx, text("Не удалось поставить continuation после compact", "Could not queue continuation after compaction"), "error");
		} finally {
			operation = undefined;
		}
	};

	const native = new NativeAppend(pi, {
		entries: ({ id, event, outcome, durationMs, model, standard }) => standard ? [
			{ type: "custom", customType: COMPACT_CARD_TYPE, data: { version: 2, kind: "standard", trigger: event.reason, tokensBefore: event.preparation.tokensBefore, summaryTokens: estimateSummaryTokens(outcome.compaction.summary), usage: outcome.compaction.usage, fallbackReason: standard.reason, appendUsage: appendUsageForAudit(standard), appendCacheStatus: standard.cacheStatus, provider: model.provider, model: model.id, durationMs } },
		] : [
			{ type: "custom", customType: "context-compaction-append", data: { ...appendAuditPayload(outcome, durationMs, model), native: true, correlation: id } },
			{ type: "custom", customType: COMPACT_CARD_TYPE, data: { version: 2, kind: "append", trigger: event.reason, tokensBefore: event.preparation.tokensBefore, summaryTokens: estimateSummaryTokens(outcome.compaction.summary), usage: outcome.compaction.usage, appendUsage: outcome.compaction.usage, appendCacheStatus: outcome.cacheStatus, provider: model.provider, model: model.id, durationMs, appendDurationMs: durationMs, repairAttempts: outcome.repairAttempts ?? 0 } },
		],
		applied: async ({ event, outcome, standard }, ctx) => {
			if (standard) pendingCard = undefined;
			const op = currentOperation(ctx);
			if (op?.lifecycle === "running" && event.reason === "manual") { markManualSuccess(ctx, op); return; }
			if (event.willRetry && op) op.continuationSuppressed = true;
			await restoreAfterSuccessfulCompact(ctx);
			external(ctx, "success", event.reason, event.willRetry, outcome.compaction.tokensBefore);
		},
		failed: (outcome, durationMs, model, ctx) => {
			const applyFailed = outcome.kind === "cancel" && outcome.reason === "context-changed" && outcome.appendAttempt.some((attempt) => attempt.phase === "apply");
			pi.appendEntry("context-compaction-append", { ...appendAuditPayload(outcome, durationMs, model), ...(applyFailed ? { outcome: "unknown", reason: "apply-failed" } : {}), native: true });
			pendingCard = { kind: "standard", fallbackReason: outcome.reason, provider: model.provider, model: model.id, appendDurationMs: durationMs, appendUsage: appendUsageForAudit(outcome) as any, appendCacheStatus: outcome.cacheStatus, scope: currentScope(ctx) };
		},
		finished: async (ctx, success) => {
			const op = currentOperation(ctx);
			if (op && !success) fail(ctx, op);
			else if (op?.lifecycle === "success") await continueManualAfterCompaction(ctx, op);
			updateFooter(ctx);
		},
	}, settings.compactCapabilities);

	pi.registerTool({
		name: "checkpoint_compact_continue",
		label: "Checkpoint Compact Continue",
		description: language === "ru" ? "Сохраняет checkpoint, сжимает контекст и продолжает ту же цель после успешного compact." : "Saves a checkpoint, compacts context, and continues the same objective after successful compaction.",
		promptSnippet: "Checkpoint current progress, compact context, and continue the same objective after compaction",
		promptGuidelines: language === "ru" ? ["Используй checkpoint_compact_continue только по явной просьбе пользователя или при инструкции сохранить checkpoint перед сжатием.", "Перед вызовом заверши текущую атомарную работу и вызывай tool последним действием checkpoint.", "Для работы по плану передавай planPath/currentPhase/nextPhase, когда они известны."] : ["Use checkpoint_compact_continue only on explicit user request or when instructed to checkpoint before compaction.", "Finish the current atomic task first and call this tool as the final checkpoint action.", "For plan-based work pass planPath/currentPhase/nextPhase when known."],
		parameters: language === "ru" ? CheckpointParamsSchema : checkpointParamsSchema("en"),
		prepareArguments,
		async execute(_id, raw, _signal, _onUpdate, ctx) {
			if (currentOperation(ctx)) return { content: [{ type: "text" as const, text: text("Compact уже ожидает или выполняется.", "Compaction is already pending or running.") }], details: { reason: "manual", params: raw, result: "in_progress" }, terminate: true };
			if (compactedSinceLastUserMessage(ctx)) return { content: [{ type: "text" as const, text: text("Compact уже был выполнен после последнего сообщения пользователя.", "Compaction already ran after the last user message.") }], details: { reason: "manual", params: raw, result: "already_compacted" }, terminate: false };
			const entries = ctx.sessionManager.getBranch() as SessionEntry[];
			const op: ManualOperation = { correlation: nextCorrelation(), origin: "manual-tool", reason: "manual", params: raw as CheckpointParams, scope: scopeOf(ctx, anonymousIdentities), modelRoute: manualIdentity(ctx), userWatermark: userWatermark(entries), goal: goalSnapshot(entries), lifecycle: "pending", continuationClaimed: false, continuationSuppressed: false };
			operation = op;
			audit(ctx, { ...op, origin: "manual-tool" }, "pending", "manual");
			return { content: [{ type: "text" as const, text: text("Checkpoint compact запланирован после завершения текущего хода.", "Checkpoint compaction is scheduled after the current turn.") }], details: { reason: "manual", params: raw, result: "scheduled" }, terminate: true };
		},
	});

	pi.registerCommand("context", {
		description: text("Показывает или меняет именованный режим context compaction.", "Show or change the named context compaction mode."),
		getArgumentCompletions: (prefix) => getContextArgumentCompletions(prefix, language),
		handler: async (args, ctx) => {
			const command = args.trim() || "status";
			if (!CONTEXT_COMPLETIONS.some((item) => item.value === command)) { notice(ctx, text("Использование: /context [status|economy|long-once|long-chat|off]", "Usage: /context [status|economy|long-once|long-chat|off]"), "error"); return; }
			if (command !== "status") {
				const previousMode = mode;
				setMode(command as ContextMode, true);
				if (!(await ensureWindow(ctx, previousMode)) && command !== "economy" && !windowErrorNotified) notice(ctx, text("Для точной записи модели нет доступного long-tier; оставлен economy", "The exact model entry has no available long tier; economy is retained"), "error");
			}
			const policy = currentPolicy(ctx);
			notice(ctx, `context: ${mode}; model=${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : text("модель не выбрана", "no model selected")}; ${text("окно", "window")}=${policy.window}; compact@${policy.threshold ?? "native"}; source=${policy.source}`);
			updateFooter(ctx);
		},
	});

	if (settings.appendCompaction && language === "ru") {
		pi.on("before_provider_request", (event, ctx) => {
			const payload = native.payload(event.payload, ctx);
			return payload;
		});
	}
	pi.on("context_with_system", (event, ctx) => {
		const result = native.context(event.messages, ctx);
		return result;
	});
	pi.on("tool_call", (_event, ctx) => native.tool(ctx));
	pi.on("session_before_switch", (_event, ctx) => { ++summarySequence; operation = undefined; native.cancel(ctx); });
	pi.on("session_before_fork", (_event, ctx) => { ++summarySequence; operation = undefined; native.cancel(ctx); });
	pi.on("session_start", async (_event, ctx) => {
		++summarySequence;
		native.shutdown(ctx);
        pendingCard = undefined;
		operation = undefined;
		mode = restoreMode(ctx.sessionManager.getEntries());
		const key = scopeOf(ctx, anonymousIdentities).sessionId;
		if (hasLegacyThreshold(ctx.sessionManager.getEntries()) && !LEGACY_NOTICE_SESSIONS.has(key)) {
			LEGACY_NOTICE_SESSIONS.add(key);
			notice(ctx, text("Старый сессионный порог обнаружен и проигнорирован; используйте /context с именованным режимом.", "Legacy session threshold ignored; use a named /context mode."));
		}
		await ensureWindow(ctx);
		updateFooter(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		++summarySequence;
		if (operation && (!internalModelTransition || operation.modelRoute !== manualIdentity(ctx))) operation = undefined;
		if (internalModelTransition) { updateFooter(ctx); return; }
		native.shutdown(ctx); await ensureWindow(ctx); updateFooter(ctx);
	});
	pi.on("message_end", (event) => native.messageEnd(event));
	pi.on("turn_end", (event, ctx) => { updateFooter(ctx); return native.turn(event, ctx); });
	pi.on("agent_before_settle", (_event, ctx) => native.beforeSettle(ctx));
	pi.on("agent_settled", async (_event, ctx) => {
		await native.settled(ctx);
		const op = currentOperation(ctx);
		if (!op || !ctx.isIdle() || !isCurrent(ctx, op, "pending")) return;
		op.lifecycle = "running";
		audit(ctx, { ...op, origin: "manual-tool" }, "running", "manual");
		ctx.compact({ customInstructions: buildInstructions(buildLedger(op.params, language), language), onComplete: () => { if (!native.ownsCallback()) void continueManualAfterCompaction(ctx, op); }, onError: () => { if (!native.ownsCallback()) fail(ctx, op); } });
	});
	pi.on("session_before_compact", async (event: any, ctx) => {
		const reason = event.reason as AuditReason;
		const op = currentOperation(ctx);
		if (op?.lifecycle === "running" && reason === "manual") {
			if (event.willRetry) op.continuationSuppressed = true;
			if (language === "ru") return summarize(event, ctx);
			return;
		}
		if (event.willRetry && op) op.continuationSuppressed = true;
		if (reason === "threshold" && op?.lifecycle === "pending") cancel(ctx, op);
		external(ctx, "contained", reason, Boolean(event.willRetry), event.preparation?.tokensBefore);
		if (language === "ru") return summarize(event, ctx);
	});
	pi.on("session_before_tree", async (event: any, ctx) => { ++summarySequence; operation = undefined; native.cancel(ctx); if (language === "ru") return russianTreeSummary(event, ctx); });
	if (typeof pi.registerEntryRenderer === "function") {
		pi.registerEntryRenderer<CompactCardData>(COMPACT_CARD_TYPE, (entry, options, theme) => entry.data ? renderCompactCard(entry.data, options.expanded, theme, language) : undefined);
	}
	pi.on("session_compact", async (event: any, ctx) => {
		// A manual native compact is saved by Pi from the hook result; Pi may report an older entry with an equal summary, so ownership comes from the held run, not the event entry.
		if (native.awaitsSave()) { pendingCard = undefined; await native.compacted(ctx); updateFooter(ctx); return; }

        const pending = pendingCard && scopeMatches(pendingCard.scope, ctx) ? pendingCard : undefined;
        pendingCard = undefined;
        const { scope: _pendingScope, ...card } = pending ?? {};
        const entry = event.compactionEntry;
		pi.appendEntry<CompactCardData>(COMPACT_CARD_TYPE, {
			version: 2,
			kind: "standard",
			...card,
			trigger: event.reason,
			tokensBefore: entry?.tokensBefore,
			summaryTokens: estimateSummaryTokens(entry?.summary),
			usage: entry?.usage,
		});
		const reason = event.reason as AuditReason;
		const op = currentOperation(ctx);
		if (op?.lifecycle === "running" && reason === "manual") { markManualSuccess(ctx, op); return; }
		if (event.willRetry && op) op.continuationSuppressed = true;
		if (reason === "threshold" || reason === "overflow" || reason === "manual") await restoreAfterSuccessfulCompact(ctx);
		external(ctx, "success", reason, Boolean(event.willRetry), event.compactionEntry?.tokensBefore);
	});
	pi.on("session_compact_failed", (event: any, ctx) => {
		if (native.handoffFailed(event, ctx)) return;
		void native.compactFailed(ctx);
        pendingCard = undefined;
        const reason = event.reason as AuditReason;
		const op = currentOperation(ctx);
		if (op?.lifecycle === "running" && reason === "manual") { fail(ctx, op, Boolean(event.willRetry)); return; }
		if (event.willRetry && op) op.continuationSuppressed = true;
		external(ctx, "error", reason, Boolean(event.willRetry), event.preparation?.tokensBefore);
		updateFooter(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => { ++summarySequence; native.shutdown(ctx); const op = currentOperation(ctx); if (op) cancel(ctx, op); });
}

export { compactedSinceLastUserMessage, prepareArguments } from "./checkpoint.js";
