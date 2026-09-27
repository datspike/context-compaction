import { randomUUID } from "node:crypto";
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
import { loadSummaryLanguage } from "./language.js";
import { formatFooter, resolvePolicy, type ContextMode } from "./policy.js";
import { appendMode, hasLegacyThreshold, restoreMode } from "./session-state.js";
import { russianCompaction, russianTreeSummary } from "./summary.js";

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

function modelDeclaration(ctx: ExtensionContext): number | undefined {
	const model = ctx.model;
	return model && ctx.modelRegistry.getAll().find((candidate) => candidate.provider === model.provider && candidate.id === model.id)?.contextWindow;
}

function notice(ctx: ExtensionContext, text: string, level: "info" | "error" = "info"): void {
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
	const language = loadSummaryLanguage();
	const text = (ru: string, en: string): string => language === "ru" ? ru : en;
	let mode: ContextMode = "economy";
	let operation: ManualOperation | undefined;
	let sequence = 0;
	let useActualWindowFallback = false;
	let windowErrorNotified = false;
	const runtimeId = randomUUID();
	const anonymousIdentities = new WeakMap<object, Map<string, string>>();
	const nextCorrelation = (): string => `${runtimeId}-${++sequence}`;
	const resolvedPolicy = (ctx: ExtensionContext) => resolvePolicy(mode, ctx.model, modelDeclaration(ctx));
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
	const audit = (ctx: ExtensionContext, op: { correlation: string; origin: AuditEntry["origin"]; scope: Scope }, phase: AuditEntry["phase"], reason: AuditReason, willRetry = false, tokensOverride?: number | null): void => {
		const policy = currentPolicy(ctx);
		appendAudit(pi, { version: 2, correlation: op.correlation, origin: op.origin, reason, phase, tokens: tokensOverride ?? ctx.getContextUsage()?.tokens ?? null, window: policy.window, threshold: policy.threshold ?? null, mode, source: policy.source, willRetry, sessionId: op.scope.sessionId, tree: op.scope.branch });
	};
	const external = (ctx: ExtensionContext, phase: AuditEntry["phase"], reason: AuditReason, willRetry: boolean, tokens?: number): void => audit(ctx, { correlation: nextCorrelation(), origin: "external-unattributed", scope: scopeOf(ctx, anonymousIdentities) }, phase, reason, willRetry, tokens);
	const updateFooter = (ctx: ExtensionContext): void => { if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, formatFooter(ctx.getContextUsage()?.tokens, currentPolicy(ctx))); };
	const setMode = (next: ContextMode, persist: boolean): void => { if (mode !== next) { mode = next; if (persist) appendMode(pi, next); } };
	const isCurrent = (ctx: ExtensionContext, op: ManualOperation, lifecycle?: ManualOperation["lifecycle"]): boolean => {
		const actual = scopeOf(ctx, anonymousIdentities);
		return operation === op && (!lifecycle || op.lifecycle === lifecycle) && op.scope.sessionId === actual.sessionId && branchContains(ctx, op.scope.branch);
	};
	const currentOperation = (ctx: ExtensionContext): ManualOperation | undefined => {
		if (operation && !isCurrent(ctx, operation)) operation = undefined;
		return operation;
	};
	const ensureWindow = async (ctx: ExtensionContext): Promise<boolean> => {
		useActualWindowFallback = false;
		windowErrorNotified = false;
		const policy = resolvedPolicy(ctx);
		if (policy.mode !== mode) { setMode("economy", true); await ensureWindow(ctx); updateFooter(ctx); return false; }
		if (!ctx.model || policy.window <= 0 || ctx.model.contextWindow === policy.window) return true;
		const thinkingLevel = pi.getThinkingLevel();
		try {
			if (!await pi.setModel({ ...ctx.model, contextWindow: policy.window })) throw new Error("setModel returned false");
			pi.setThinkingLevel(thinkingLevel);
		} catch {
			if (mode !== "economy") setMode("economy", true);
			useActualWindowFallback = true;
			updateFooter(ctx);
			notice(ctx, text("Не удалось применить окно контекста; включён безопасный режим economy", "Could not apply the context window; switched to safe economy mode"), "error");
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
		if (mode === "long-once") { setMode("economy", true); await ensureWindow(ctx); }
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
		if (!isCurrent(ctx, op, "success") || op.continuationClaimed || op.continuationSuppressed || userWatermark(entries) !== op.userWatermark || !continuationGoalIsValid(op.goal, entries)) { operation = undefined; return; }
		// In-memory guard covers duplicate callbacks. Pi's public ExtensionAPI does not
		// expose queue acknowledgement, so this records one invocation after the core lock.
		op.continuationClaimed = true;
		try {
			const revalidated = ctx.sessionManager.getBranch() as SessionEntry[];
			if (!isCurrent(ctx, op, "success") || op.continuationSuppressed || userWatermark(revalidated) !== op.userWatermark || !continuationGoalIsValid(op.goal, revalidated)) return;
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
			const op: ManualOperation = { correlation: nextCorrelation(), origin: "manual-tool", reason: "manual", params: raw as CheckpointParams, scope: scopeOf(ctx, anonymousIdentities), userWatermark: userWatermark(entries), goal: goalSnapshot(entries), lifecycle: "pending", continuationClaimed: false, continuationSuppressed: false };
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
				setMode(command as ContextMode, true);
				if (!(await ensureWindow(ctx)) && command !== "economy" && !windowErrorNotified) notice(ctx, text("Выбранный режим недоступен для точной текущей модели; оставлен economy", "This mode is unavailable for the exact current model; economy is retained"), "error");
			}
			const policy = currentPolicy(ctx);
			notice(ctx, `context: ${mode}; model=${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : text("модель не выбрана", "no model selected")}; ${text("окно", "window")}=${policy.window}; compact@${policy.threshold ?? "native"}; source=${policy.source}`);
			updateFooter(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
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
	pi.on("model_select", async (_event, ctx) => { await ensureWindow(ctx); updateFooter(ctx); });
	pi.on("turn_end", (_event, ctx) => { updateFooter(ctx); });
	pi.on("agent_settled", (_event, ctx) => {
		const op = currentOperation(ctx);
		if (!op || !ctx.isIdle() || !isCurrent(ctx, op, "pending")) return;
		op.lifecycle = "running";
		audit(ctx, { ...op, origin: "manual-tool" }, "running", "manual");
		ctx.compact({ customInstructions: buildInstructions(buildLedger(op.params, language), language), onComplete: () => { void continueManualAfterCompaction(ctx, op); }, onError: () => fail(ctx, op) });
	});
	pi.on("session_before_compact", async (event: any, ctx) => {
		const reason = event.reason as AuditReason;
		const op = currentOperation(ctx);
		if (op?.lifecycle === "running" && reason === "manual") {
			if (event.willRetry) op.continuationSuppressed = true;
			if (language === "ru") return russianCompaction(event, ctx);
			return;
		}
		if (event.willRetry && op) op.continuationSuppressed = true;
		if (reason === "threshold" && op?.lifecycle === "pending") cancel(ctx, op);
		external(ctx, "contained", reason, Boolean(event.willRetry), event.preparation?.tokensBefore);
		if (language === "ru") return russianCompaction(event, ctx);
	});
	if (language === "ru") pi.on("session_before_tree", async (event: any, ctx) => russianTreeSummary(event, ctx));
	pi.on("session_compact", async (event: any, ctx) => {
		const reason = event.reason as AuditReason;
		const op = currentOperation(ctx);
		if (op?.lifecycle === "running" && reason === "manual") { markManualSuccess(ctx, op); return; }
		if (event.willRetry && op) op.continuationSuppressed = true;
		if (reason === "threshold" || reason === "overflow" || reason === "manual") await restoreAfterSuccessfulCompact(ctx);
		external(ctx, "success", reason, Boolean(event.willRetry), event.compactionEntry?.tokensBefore);
	});
	pi.on("session_compact_failed", (event: any, ctx) => {
		const reason = event.reason as AuditReason;
		const op = currentOperation(ctx);
		if (op?.lifecycle === "running" && reason === "manual") { fail(ctx, op, Boolean(event.willRetry)); return; }
		if (event.willRetry && op) op.continuationSuppressed = true;
		external(ctx, "error", reason, Boolean(event.willRetry), event.preparation?.tokensBefore);
		updateFooter(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => { const op = currentOperation(ctx); if (op) cancel(ctx, op); });
}

export { compactedSinceLastUserMessage, prepareArguments } from "./checkpoint.js";
