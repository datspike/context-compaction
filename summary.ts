import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { MAX_COMPACT_PAYLOAD_CHARS, calculateCompactBudget, type CompactCapability } from "./compact-budget.js";
import type { Model } from "@earendil-works/pi-ai";
import { collectFileLists, formatFileHints, withoutFileTracking, withoutMessageFileTracking } from "./file-hints.js";
import {
	convertToLlm,
	prepareBranchEntries,
	serializeConversation,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";

const SUMMARIZATION_SYSTEM_PROMPT = "You are a context summarization assistant. Do not continue the conversation. Output only the requested structured summary.";
const DEFAULT_RESERVE_TOKENS = 16_384;
const NATIVE_BRANCH_SUMMARY_PREAMBLE = "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n";

/** Разделы истории собраны до начала текущего хода; явное старшинство нужно, иначе прошлая цель и шаги выглядят действующими. */
export const SPLIT_TURN_HEADER = "**Контекст разрезанного хода:**\nЭтот ход начат после истории выше. Если его запрос меняет цель, ограничения или следующие шаги, действует он; разделы выше описывают состояние до хода.";

export const RUSSIAN_COMPACTION_FOCUS = `
Пиши весь естественный текст итогового summary на русском языке.
Сохрани смысл и структуру стандартного checkpoint summary, но используй такие русские разделы:
- ## Цель
- ## Ограничения и предпочтения
- ## Прогресс
- ### Готово
- ### В работе
- ### Заблокировано
- ## Ключевые решения
- ## Следующие шаги
- ## Критический контекст

Не продолжай разговор и не отвечай на вопросы из истории: выведи только структурированное summary. Будь кратким, но не выбрасывай незавершённую работу, ограничения, принятые решения, причины решений, ошибки, критерии завершения и достаточности из истории и данные, необходимые для продолжения.
В «## Следующие шаги» помечай источник каждого шага: «решение пользователя» или «предложение агента». Не записывай как шаг закрытие с отрицательным итогом, fallback или остановку, если пользователь этого не решал.
В «## Ключевые решения» сохраняй испробованные пути с причиной отказа, ещё не проверенные альтернативы и израсходованный и оставшийся бюджет.
Высказывания пользователя о цели и достижимости результата сохраняй дословно.
Пиши по-русски также контекст разрезанного хода. Для него используй разделы «## Исходный запрос», «## Прогресс на текущий момент» и «## Контекст для продолжения».
Не переводи и не изменяй точные технические фрагменты: пути, имена файлов, команды, идентификаторы, имена функций, API, сообщения ошибок и код. Сохраняй в смысловом тексте точные пути, необходимые для незавершённой работы, проверок и ограничений. Не создавай блоки <read-files>, <modified-files> или <file-hints>: расширение добавит ограниченные файловые наводки отдельно.`.trim();

export const RUSSIAN_TREE_SUMMARY_INSTRUCTIONS = `Составь краткое структурированное summary оставляемой ветки, чтобы к ней можно было вернуться позже.

Пиши весь естественный текст на русском языке и используй ровно этот формат:

## Цель
[Чего пользователь пытался добиться в этой ветке]

## Ограничения и предпочтения
- [Ограничения, предпочтения и требования]
- [Или «(нет)», если их не было]

## Прогресс
### Готово
- [x] [Завершённые действия и изменения]

### В работе
- [ ] [Начатая, но не завершённая работа]

### Заблокировано
- [Проблемы, которые мешают продолжению, или «(нет)»]

## Ключевые решения
- **[Решение]**: [Краткая причина]

## Следующие шаги
1. [Что нужно сделать дальше]

Сохраняй точные пути, имена файлов, функции, команды и сообщения ошибок. Не продолжай разговор и не добавляй ответов на вопросы из истории; выведи только summary. Сохраняй в смысловом тексте точные пути для незавершённой работы и проверок. Не создавай блоки <read-files>, <modified-files> или <file-hints>: расширение добавит файловые наводки отдельно.`.trim();

const SUMMARY_HEADINGS: Readonly<Record<string, string>> = {
	"## Goal": "## Цель",
	"## Constraints & Preferences": "## Ограничения и предпочтения",
	"## Progress": "## Прогресс",
	"### Done": "### Готово",
	"### In Progress": "### В работе",
	"### Blocked": "### Заблокировано",
	"## Key Decisions": "## Ключевые решения",
	"## Next Steps": "## Следующие шаги",
	"## Critical Context": "## Критический контекст",
	"## Original Request": "## Исходный запрос",
	"## Progress So Far": "## Прогресс на текущий момент",
	"## Context Needed to Continue": "## Контекст для продолжения",
	"## Early Progress": "## Ранний прогресс",
	"## Context for Suffix": "## Контекст для сохранённой части",
	"**Turn Context (split turn):**": "**Контекст разрезанного хода:**",
};

type SummaryLine = { line: string; protected: boolean };
type FenceState = { character: "`" | "~"; length: number };

function classifySummaryLines(summary: string): SummaryLine[] {
	let fence: FenceState | undefined;
	let machineBlock: "read" | "modified" | undefined;
	return summary.split("\n").map((line) => {
		const trimmed = line.trim();
		if (fence) {
			const close = trimmed.match(/^(`+|~+)\s*$/)?.[1];
			const closesFence = close && close[0] === fence.character && close.length >= fence.length;
			if (closesFence) fence = undefined;
			return { line, protected: true };
		}
		const openingFence = trimmed.match(/^(`{3,}|~{3,})/)?.[1];
		if (openingFence) {
			fence = { character: openingFence[0] as "`" | "~", length: openingFence.length };
			return { line, protected: true };
		}
		if (machineBlock) {
			const closesMachine = (machineBlock === "read" && trimmed === "</read-files>") || (machineBlock === "modified" && trimmed === "</modified-files>");
			if (closesMachine) machineBlock = undefined;
			return { line, protected: true };
		}
		if (trimmed === "<read-files>") { machineBlock = "read"; return { line, protected: true }; }
		if (trimmed === "<modified-files>") { machineBlock = "modified"; return { line, protected: true }; }
		return { line, protected: false };
	});
}

/** Переводит только известные структурные заголовки вне code и machine-readable блоков. */
export function localizeSummaryStructure(summary: string): string {
	return classifySummaryLines(summary)
		.map(({ line, protected: isProtected }) => !isProtected ? SUMMARY_HEADINGS[line] ?? line : line)
		.join("\n");
}

/** Убирает только точную англоязычную приписку native branch summarizer. */
export function stripBranchSummaryPreamble(summary: string): string {
	return summary.startsWith(NATIVE_BRANCH_SUMMARY_PREAMBLE)
		? summary.slice(NATIVE_BRANCH_SUMMARY_PREAMBLE.length).trimStart()
		: summary.trim();
}

export function hasStructuralHeading(summary: string, headings: string[]): boolean {
	return classifySummaryLines(summary).some(({ line, protected: isProtected }) => !isProtected && headings.includes(line));
}

function hasLocalizedSummaryStructure(summary: string, allowSplitTurn: boolean): boolean {
	return hasStructuralHeading(summary, allowSplitTurn ? ["## Цель", "## Исходный запрос"] : ["## Цель"]);
}

function hasLocalizedPrefixStructure(summary: string): boolean {
	return hasStructuralHeading(summary, ["## Исходный запрос"]);
}

type SummaryResponse = {
    text: string;
    usage?: unknown;
};

export type CompactionFailureReason = "aborted" | "context-changed" | "invalid-response" | "request-failed" | "insufficient-window" | "unsupported" | "request-too-large";

export type RussianCompactionOptions = {
    capability?: CompactCapability;
    model?: Model<any>;
    isCurrent?: () => boolean;
    onFailure?: (reason: string) => void;
};

export type RussianCompactionResult = {
    compaction: any;
} | {
    cancel: true;
};

class SummaryFailure extends Error {
    constructor(readonly reason: CompactionFailureReason) {
        super(reason);
        this.name = "SummaryFailure";
    }
}

type ModelIdentity = {
    provider: unknown;
    id: unknown;
    api: unknown;
    baseUrl: unknown;
};

type RouteIdentity = {
    registry: unknown;
    provider: unknown;
    model: ModelIdentity;
};

type SessionIdentity = {
    sessionId: unknown;
    sessionFile: unknown;
    tree: string | undefined;
};

type OperationSnapshot = {
    signal: AbortSignal;
    activeModel: ModelIdentity | undefined;
    activeRoute: RouteIdentity | undefined;
    serviceModel: ModelIdentity;
    serviceModelRef: Model<any>;
    serviceRoute: RouteIdentity;
    session: SessionIdentity;
};

type CompactionRequestGuard = {
    capability?: CompactCapability;
    model: Model<any>;
    signal: AbortSignal;
    validate: () => void;
};

function modelIdentity(model: Model<any> | undefined): ModelIdentity | undefined {
    if (!model)
        return undefined;
    return { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl };
}

function sameModelIdentity(left: ModelIdentity | undefined, right: ModelIdentity | undefined): boolean {
    return left?.provider === right?.provider && left?.id === right?.id && left?.api === right?.api && left?.baseUrl === right?.baseUrl;
}

function routeIdentity(ctx: ExtensionContext, model: Model<any> | undefined): RouteIdentity | undefined {
    const identity = modelIdentity(model);
    if (!identity)
        return undefined;
    const registry = ctx.modelRegistry as any;
    const provider = typeof registry?.getProvider === "function" ? registry.getProvider(model!.provider) : undefined;
    return { registry, provider, model: identity };
}

function sameRoute(left: RouteIdentity | undefined, right: RouteIdentity | undefined): boolean {
    return left?.registry === right?.registry && left?.provider === right?.provider && sameModelIdentity(left?.model, right?.model);
}

function branchIdentity(ctx: ExtensionContext): string | undefined {
    const manager = ctx.sessionManager as any;
    if (!manager || typeof manager.getBranch !== "function")
        return undefined;
    const branch = manager.getBranch();
    if (!Array.isArray(branch))
        return undefined;
    const leaf = typeof manager.getLeafId === "function" ? manager.getLeafId() : undefined;
    const entries = branch.map((entry: any, index: number) => ({
        index,
        id: entry?.id ?? null,
        parentId: entry?.parentId ?? null,
        type: entry?.type ?? null,
    }));
    return JSON.stringify({ leaf, entries });
}

function sessionIdentity(ctx: ExtensionContext): SessionIdentity {
    const manager = ctx.sessionManager as any;
    return {
        sessionId: manager && typeof manager.getSessionId === "function" ? manager.getSessionId() : undefined,
        sessionFile: manager && typeof manager.getSessionFile === "function" ? manager.getSessionFile() : undefined,
        tree: branchIdentity(ctx),
    };
}

function sameSession(left: SessionIdentity, right: SessionIdentity): boolean {
    return left.sessionId === right.sessionId && left.sessionFile === right.sessionFile && left.tree === right.tree;
}

function operationSnapshot(ctx: ExtensionContext, signal: AbortSignal, activeModel: Model<any> | undefined, serviceModel: Model<any>): OperationSnapshot {
    return {
        signal,
        activeModel: modelIdentity(activeModel),
        activeRoute: routeIdentity(ctx, activeModel),
        serviceModel: modelIdentity(serviceModel)!,
        serviceModelRef: serviceModel,
        serviceRoute: routeIdentity(ctx, serviceModel)!,
        session: sessionIdentity(ctx),
    };
}

function signalAborted(ctx: ExtensionContext, signal?: AbortSignal): boolean {
    return Boolean(signal?.aborted) || Boolean(ctx.signal?.aborted);
}

function abortError(error: unknown): boolean {
    return error instanceof Error && (error.name === "AbortError" || /\babort(?:ed|ing)?\b/i.test(error.message));
}

function assertCurrent(ctx: ExtensionContext, snapshot: OperationSnapshot, owner?: () => boolean): void {
    if (signalAborted(ctx, snapshot.signal))
        throw new SummaryFailure("aborted");
    if (!sameSession(snapshot.session, sessionIdentity(ctx))
        || !sameModelIdentity(snapshot.activeModel, modelIdentity(ctx.model))
        || !sameRoute(snapshot.activeRoute, routeIdentity(ctx, ctx.model))
        || !sameRoute(snapshot.serviceRoute, routeIdentity(ctx, snapshot.serviceModelRef))) {
        throw new SummaryFailure("context-changed");
    }
    if (owner) {
        try {
            if (!owner())
                throw new SummaryFailure("context-changed");
        }
        catch (error) {
            if (error instanceof SummaryFailure)
                throw error;
            throw new SummaryFailure("context-changed");
        }
    }
}

function guardFor(ctx: ExtensionContext, snapshot: OperationSnapshot, owner?: () => boolean, capability?: CompactCapability): CompactionRequestGuard {
    return { capability, model: snapshot.serviceModelRef, signal: snapshot.signal, validate: () => assertCurrent(ctx, snapshot, owner) };
}

function reportFailure(options: RussianCompactionOptions | undefined, reason: CompactionFailureReason): RussianCompactionResult {
    try {
        options?.onFailure?.(reason);
    }
    catch { /* diagnostics must not alter the explicit outcome */ }
    return { cancel: true };
}

function reasonForFailure(error: unknown, ctx: ExtensionContext, guard: CompactionRequestGuard | undefined): CompactionFailureReason {
    if (error instanceof SummaryFailure)
        return error.reason;
    if (guard) {
        if (signalAborted(ctx, guard.signal) || abortError(error))
            return "aborted";
        try {
            guard.validate();
        }
        catch {
            return "context-changed";
        }
    }
    return abortError(error) ? "aborted" : "request-failed";
}

function combineUsage(first: any, second: any): any {
    if (!first)
        return second;
    if (!second)
        return first;
    const sum = (left: unknown, right: unknown): number => (typeof left === "number" ? left : 0) + (typeof right === "number" ? right : 0);
    const cost = first.cost && second.cost ? {
        input: sum(first.cost.input, second.cost.input),
        output: sum(first.cost.output, second.cost.output),
        cacheRead: sum(first.cost.cacheRead, second.cost.cacheRead),
        cacheWrite: sum(first.cost.cacheWrite, second.cost.cacheWrite),
        total: sum(first.cost.total, second.cost.total),
    } : first.cost ?? second.cost;
    const combined = {
        ...first,
        ...second,
        input: sum(first.input, second.input),
        output: sum(first.output, second.output),
        cacheRead: sum(first.cacheRead, second.cacheRead),
        cacheWrite: sum(first.cacheWrite, second.cacheWrite),
        totalTokens: sum(first.totalTokens, second.totalTokens),
        cost,
    };
    if (first.reasoning !== undefined || second.reasoning !== undefined)
        combined.reasoning = sum(first.reasoning, second.reasoning);
    if (first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined)
        combined.cacheWrite1h = sum(first.cacheWrite1h, second.cacheWrite1h);
    return combined;
}

async function completeSummary(ctx: ExtensionContext, prompt: string, maxTokens: number, signal: AbortSignal, guard?: CompactionRequestGuard): Promise<SummaryResponse> {
    const model = guard?.model ?? ctx.model;
    if (!model)
        throw new Error("No model selected");
    if (guard)
        guard.validate();
    let inputTokens = 0;
    if (guard?.capability) {
        inputTokens = estimateTokens({ role: "user", content: `<instructions>\n${SUMMARIZATION_SYSTEM_PROMPT}\n</instructions>\n\n${prompt}`, timestamp: 0 });
        const budget = calculateCompactBudget({ capability: guard.capability, inputTokens, taskTokens: 0, requestedOutputTokens: maxTokens, modelMaxTokens: model.maxTokens });
        if (!budget.allowed)
            throw new SummaryFailure(budget.reason!);
    }
    let payloadFailure: unknown;
    const options: Record<string, unknown> = { maxTokens, signal, cacheRetention: "none" };
    if (guard) {
        options.maxRetries = 0;
        options.transport = "sse";
        options.onPayload = (payload: unknown) => {
            try {
                guard.validate();
                const serializedChars = JSON.stringify(payload).length;
                if (guard.capability) {
                    const budget = calculateCompactBudget({ capability: guard.capability, inputTokens, taskTokens: 0, requestedOutputTokens: maxTokens, modelMaxTokens: model.maxTokens, serializedChars });
                    if (!budget.allowed) throw new SummaryFailure(budget.reason!);
                } else if (serializedChars > MAX_COMPACT_PAYLOAD_CHARS) throw new SummaryFailure("request-too-large");
                return payload;
            } catch (error) {
                // Providers may convert hook failures into error messages; retain the original refusal.
                payloadFailure = error;
                throw error;
            }
        };
        const sessionId = (ctx.sessionManager as any)?.getSessionId?.();
        if (typeof sessionId === "string" && sessionId)
            options.sessionId = sessionId;
    }
    let response: any;
    try {
        response = await ctx.modelRegistry.complete(model, {
            messages: [{
                    role: "user",
                    content: [{ type: "text", text: `<instructions>\n${SUMMARIZATION_SYSTEM_PROMPT}\n</instructions>\n\n${prompt}` }],
                    timestamp: Date.now(),
                }],
        }, options as any);
    }
    catch (error) {
        if (payloadFailure) throw payloadFailure;
        if (!guard)
            throw error;
        if (signalAborted(ctx, signal) || abortError(error))
            throw new SummaryFailure("aborted");
        guard.validate();
        throw new SummaryFailure("request-failed");
    }
    if (payloadFailure) throw payloadFailure;
    if (guard)
        guard.validate();
    if (response?.stopReason === "aborted") {
        if (guard)
            throw new SummaryFailure("aborted");
        throw new Error("Summary generation aborted");
    }
    if (response?.stopReason === "error") {
        if (guard)
            throw new SummaryFailure("request-failed");
        throw new Error(response.errorMessage ?? "Summary generation failed");
    }
    if (response?.stopReason === "length" || !Array.isArray(response?.content)) {
        if (guard)
            throw new SummaryFailure("invalid-response");
        throw new Error("Summary generation failed");
    }
    if (response.content.some((block: any) => block?.type === "toolCall")) {
        if (guard)
            throw new SummaryFailure("invalid-response");
        throw new Error("Summary attempted to call a tool");
    }
    const rawText = response.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("\n");
    const text = withoutFileTracking(rawText);
    if (!text.trim()) {
        if (guard)
            throw new SummaryFailure("invalid-response");
        throw new Error("Summary was empty");
    }
    return { text, usage: response.usage };
}

function conversationPrompt(messages: any[], instructions: string, previousSummary?: string, sources: readonly unknown[] = []): string {
    const conversationText = serializeConversation(convertToLlm(withoutMessageFileTracking(messages, sources)));
    const previous = previousSummary ? withoutFileTracking(previousSummary, sources) : undefined;
    return `<conversation>\n${conversationText}\n</conversation>\n\n${previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ""}${instructions}`;
}

async function summarizeMessages(ctx: ExtensionContext, messages: any[], instructions: string, previousSummary: string | undefined, maxTokens: number, signal: AbortSignal, sources: readonly unknown[], guard?: CompactionRequestGuard): Promise<SummaryResponse> {
    return completeSummary(ctx, conversationPrompt(messages, instructions, previousSummary, sources), maxTokens, signal, guard);
}

async function summarizeTurnPrefix(ctx: ExtensionContext, messages: any[], signal: AbortSignal, maxTokens: number, sources: readonly unknown[], guard?: CompactionRequestGuard): Promise<SummaryResponse> {
    const instructions = `Это ранняя часть пользовательского хода, а его недавняя часть сохранена отдельно. Составь краткий контекст для продолжения на русском языке и используй ровно этот формат:

## Исходный запрос
[Что пользователь просил в этом ходу; ключевые фразы о цели и достижимости — дословно. Если запрос отменяет или меняет прежнюю цель, ограничения или план, назови, что именно]

## Прогресс на текущий момент
- [Ключевые решения и действия в ранней части]

## Контекст для продолжения
- [Что нужно знать, чтобы понять сохранённую недавнюю часть]

Сохраняй точные пути, команды, имена функций и сообщения ошибок. Выведи только summary.`;
    return summarizeMessages(ctx, messages, instructions, undefined, maxTokens, signal, sources, guard);
}

/** Генерирует русское summary для automatic/manual compaction; отказ всегда имеет явный исход. */
export async function russianCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext, options?: RussianCompactionOptions): Promise<RussianCompactionResult> {
    const serviceModel = options?.model ?? ctx.model;
    if (!serviceModel)
        return reportFailure(options, signalAborted(ctx, event.signal) ? "aborted" : "request-failed");
    let guard: CompactionRequestGuard | undefined;
    try {
        const snapshot = operationSnapshot(ctx, event.signal, ctx.model, serviceModel);
        guard = guardFor(ctx, snapshot, options?.isCurrent, options?.capability);
        guard.validate();
        const preparation = event.preparation;
        const sources = event.branchEntries.flatMap((entry) => entry.type === "compaction" || entry.type === "branch_summary" ? [entry.details] : []);
        const instructions = event.customInstructions
            ? `${RUSSIAN_COMPACTION_FOCUS}\n\nДополнительный checkpoint-контекст и инструкции текущей операции:\n${event.customInstructions}`
            : RUSSIAN_COMPACTION_FOCUS;
        const serviceMaxTokens = serviceModel.maxTokens;
        const maxTokens = Math.min(Math.floor(preparation.settings.reserveTokens * 0.8), serviceMaxTokens > 0 ? serviceMaxTokens : Number.POSITIVE_INFINITY);
        let summary: string;
        let usage: unknown;
        if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
            let historyText = preparation.previousSummary ? localizeSummaryStructure(withoutFileTracking(preparation.previousSummary, sources)) : "Предыдущей истории нет.";
            let historyUsage: unknown;
            if (preparation.messagesToSummarize.length > 0) {
                const history = await summarizeMessages(ctx, preparation.messagesToSummarize, instructions, preparation.previousSummary, maxTokens, event.signal, sources, guard);
                guard.validate();
                historyText = localizeSummaryStructure(history.text);
                historyUsage = history.usage;
                if (!hasLocalizedSummaryStructure(historyText, false))
                    throw new SummaryFailure("invalid-response");
            }
            else if (preparation.previousSummary && !hasLocalizedSummaryStructure(historyText, false) && !hasLocalizedPrefixStructure(historyText)) {
                throw new SummaryFailure("invalid-response");
            }
            const prefix = await summarizeTurnPrefix(ctx, preparation.turnPrefixMessages, event.signal, Math.min(Math.floor(preparation.settings.reserveTokens * 0.5), serviceMaxTokens > 0 ? serviceMaxTokens : Number.POSITIVE_INFINITY), sources, guard);
            guard.validate();
            const prefixText = localizeSummaryStructure(prefix.text);
            if (!hasLocalizedPrefixStructure(prefixText))
                throw new SummaryFailure("invalid-response");
            summary = `${historyText}\n\n${SPLIT_TURN_HEADER}\n${prefixText}`;
            usage = combineUsage(historyUsage, prefix.usage);
        }
        else {
            const result = await summarizeMessages(ctx, preparation.messagesToSummarize, instructions, preparation.previousSummary, maxTokens, event.signal, sources, guard);
            guard.validate();
            summary = localizeSummaryStructure(result.text);
            usage = result.usage;
            if (!hasLocalizedSummaryStructure(summary, false))
                throw new SummaryFailure("invalid-response");
        }
        guard.validate();
        summary = withoutFileTracking(summary);
        const files = collectFileLists(preparation.fileOps, event.branchEntries);
        const hints = formatFileHints(files, [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages], summary);
        guard.validate();
        return {
            compaction: {
                summary: `${summary}${hints}`,
                firstKeptEntryId: preparation.firstKeptEntryId,
                tokensBefore: preparation.tokensBefore,
                usage,
                details: files,
            },
        };
    }
    catch (error) {
        const reason = reasonForFailure(error, ctx, guard);
        return reportFailure(options, reason);
    }
}

/** Генерирует русское summary для /tree, сохраняя native token budget, usage и cumulative file tracking. */
export async function russianTreeSummary(event: SessionBeforeTreeEvent, ctx: ExtensionContext): Promise<{ summary: any } | undefined> {
	if (!event.preparation.userWantsSummary || !ctx.model) return undefined;
	try {
		const reserveTokens = DEFAULT_RESERVE_TOKENS;
		const tokenBudget = Math.max(0, (ctx.model.contextWindow || 128_000) - reserveTokens);
		const entries = event.preparation.entriesToSummarize.map((entry) => entry.type === "compaction" || entry.type === "branch_summary"
			? { ...entry, summary: withoutFileTracking(entry.summary, [entry.details]) } : entry);
		const prepared = prepareBranchEntries(entries, tokenBudget);
		if (prepared.messages.length === 0) return undefined;
		const replaceInstructions = Boolean(event.preparation.replaceInstructions && event.preparation.customInstructions);
		const instructions = replaceInstructions
			? event.preparation.customInstructions!
			: event.preparation.customInstructions
				? `${RUSSIAN_TREE_SUMMARY_INSTRUCTIONS}\n\nДополнительные инструкции текущего перехода по дереву:\n${event.preparation.customInstructions}`
				: RUSSIAN_TREE_SUMMARY_INSTRUCTIONS;
		const result = await completeSummary(ctx, conversationPrompt(prepared.messages, instructions), Math.min(4096, ctx.model.maxTokens > 0 ? ctx.model.maxTokens : Number.POSITIVE_INFINITY), event.signal);
		const summary = withoutFileTracking(localizeSummaryStructure(stripBranchSummaryPreamble(result.text)));
		if (!replaceInstructions && !hasLocalizedSummaryStructure(summary, false)) return undefined;
		const files = collectFileLists(prepared.fileOps, event.preparation.entriesToSummarize);
		return {
			summary: {
				summary: `${summary}${formatFileHints(files, prepared.messages, summary)}`,
				usage: result.usage,
				details: files,
			},
		};
	} catch {
		return undefined;
	}
}