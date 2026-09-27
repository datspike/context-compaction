import {
	convertToLlm,
	prepareBranchEntries,
	serializeConversation,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import type { SummaryLanguage } from "./language.js";

const SUMMARIZATION_SYSTEM_PROMPT = "You are a context summarization assistant. Do not continue the conversation. Output only the requested structured summary.";
const DEFAULT_RESERVE_TOKENS = 16_384;
const NATIVE_BRANCH_SUMMARY_PREAMBLE = "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n";

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

Не продолжай разговор и не отвечай на вопросы из истории: выведи только структурированное summary. Будь кратким, но не выбрасывай незавершённую работу, ограничения, принятые решения, причины решений, ошибки и данные, необходимые для продолжения.
Пиши по-русски также контекст разрезанного хода. Для него используй разделы «## Исходный запрос», «## Прогресс на текущий момент» и «## Контекст для продолжения».
Не переводи и не изменяй точные технические фрагменты: пути, имена файлов, команды, идентификаторы, имена функций, API, сообщения ошибок и код. Не создавай и не дублируй machine-readable блоки вроде <read-files> и <modified-files>: Pi добавит их сам.`.trim();

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

Сохраняй точные пути, имена файлов, функции, команды и сообщения ошибок. Не продолжай разговор и не добавляй ответов на вопросы из истории; выведи только summary. Не создавай machine-readable блоки: Pi добавит их сам.`.trim();

export const ENGLISH_COMPACTION_FOCUS = `Write all natural-language text in English. Preserve the standard checkpoint structure using ## Goal, ## Constraints & Preferences, ## Progress, ### Done, ### In Progress, ### Blocked, ## Key Decisions, ## Next Steps and ## Critical Context.
For a split turn use ## Original Request, ## Progress So Far and ## Context Needed to Continue. Do not continue the conversation or answer questions from its history. Keep unfinished work, constraints, decisions and reasons, errors and information needed to continue. Preserve exact paths, filenames, commands, identifiers, function names, APIs, error messages and code. Do not generate <read-files> or <modified-files> blocks: Pi will add them.`;

export const ENGLISH_TREE_SUMMARY_INSTRUCTIONS = `Summarize the branch in English so work can be resumed later. Use this structure:

## Goal
[What the user wanted to accomplish]

## Constraints & Preferences
- [Constraints and preferences, or (none)]

## Progress
### Done
- [x] [Completed work]
### In Progress
- [ ] [Unfinished work]
### Blocked
- [Blockers, or (none)]

## Key Decisions
- **[Decision]**: [Reason]

## Next Steps
1. [Next action]

Preserve exact paths, filenames, commands, functions, and error messages. Do not continue the conversation or add answers from its history. Do not create machine-readable blocks: Pi will add them.`;

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

function hasStructuralHeading(summary: string, headings: string[]): boolean {
	return classifySummaryLines(summary).some(({ line, protected: isProtected }) => !isProtected && headings.includes(line));
}

function hasSummaryStructure(summary: string, language: SummaryLanguage, allowSplitTurn: boolean): boolean {
	const goal = language === "ru" ? "## Цель" : "## Goal";
	const original = language === "ru" ? "## Исходный запрос" : "## Original Request";
	return hasStructuralHeading(summary, allowSplitTurn ? [goal, original] : [goal]);
}

function hasPrefixStructure(summary: string, language: SummaryLanguage): boolean {
	return hasStructuralHeading(summary, [language === "ru" ? "## Исходный запрос" : "## Original Request"]);
}

type FileOps = { read?: Set<string>; written?: Set<string>; edited?: Set<string> };
type FileLists = { readFiles: string[]; modifiedFiles: string[] };

type SummaryResponse = {
	text: string;
	usage?: unknown;
};

function collectCumulativeFileLists(fileOps: FileOps | undefined, entries: readonly any[]): FileLists {
	const read = new Set<string>(fileOps?.read ?? []);
	const modified = new Set<string>([...(fileOps?.written ?? []), ...(fileOps?.edited ?? [])]);
	for (const entry of entries) {
		if (entry?.type !== "compaction" && entry?.type !== "branch_summary") continue;
		const details = entry.details;
		if (!details || typeof details !== "object") continue;
		for (const path of Array.isArray(details.readFiles) ? details.readFiles : []) if (typeof path === "string") read.add(path);
		for (const path of Array.isArray(details.modifiedFiles) ? details.modifiedFiles : []) if (typeof path === "string") modified.add(path);
	}
	return {
		readFiles: [...read].filter((path) => !modified.has(path)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

function formatFileOperations(files: FileLists): string {
	const sections: string[] = [];
	if (files.readFiles.length > 0) sections.push(`<read-files>\n${files.readFiles.join("\n")}\n</read-files>`);
	if (files.modifiedFiles.length > 0) sections.push(`<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

function combineUsage(first: any, second: any): any {
	if (!first) return second;
	if (!second) return first;
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
	if (first.reasoning !== undefined || second.reasoning !== undefined) combined.reasoning = sum(first.reasoning, second.reasoning);
	if (first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined) combined.cacheWrite1h = sum(first.cacheWrite1h, second.cacheWrite1h);
	return combined;
}

async function completeSummary(ctx: ExtensionContext, prompt: string, maxTokens: number, signal: AbortSignal): Promise<SummaryResponse> {
	if (!ctx.model) throw new Error("No model selected");
	const response: any = await ctx.modelRegistry.complete(
		ctx.model,
		{
			messages: [{
				role: "user",
				content: [{ type: "text", text: `<instructions>\n${SUMMARIZATION_SYSTEM_PROMPT}\n</instructions>\n\n${prompt}` }],
				timestamp: Date.now(),
			}],
		},
		{ maxTokens, signal, cacheRetention: "none" },
	);
	if (response.stopReason === "aborted" || response.stopReason === "error" || response.stopReason === "length") throw new Error(response.errorMessage ?? "Summary generation failed");
	if (Array.isArray(response.content) && response.content.some((block: any) => block?.type === "toolCall")) throw new Error("Summary attempted to call a tool");
	const text = Array.isArray(response.content) ? response.content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("\n") : "";
	if (!text.trim()) throw new Error("Summary was empty");
	return { text, usage: response.usage };
}

function conversationPrompt(messages: any[], instructions: string, previousSummary?: string): string {
	const conversationText = serializeConversation(convertToLlm(messages));
	return `<conversation>\n${conversationText}\n</conversation>\n\n${previousSummary ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n` : ""}${instructions}`;
}

async function summarizeMessages(ctx: ExtensionContext, messages: any[], instructions: string, previousSummary: string | undefined, maxTokens: number, signal: AbortSignal): Promise<SummaryResponse> {
	return completeSummary(ctx, conversationPrompt(messages, instructions, previousSummary), maxTokens, signal);
}

async function summarizeTurnPrefix(ctx: ExtensionContext, messages: any[], signal: AbortSignal, maxTokens: number, language: SummaryLanguage): Promise<SummaryResponse> {
	const instructions = language === "ru" ? `Это ранняя часть пользовательского хода, а его недавняя часть сохранена отдельно. Составь краткий контекст для продолжения на русском языке и используй ровно этот формат:

## Исходный запрос
[Что пользователь просил в этом ходу]

## Прогресс на текущий момент
- [Ключевые решения и действия в ранней части]

## Контекст для продолжения
- [Что нужно знать, чтобы понять сохранённую недавнюю часть]

Сохраняй точные пути, команды, имена функций и сообщения ошибок. Выведи только summary.`
		: `This is the early part of a user turn; its recent part is preserved separately. Summarize the context needed to continue in English, using exactly this format:

## Original Request
[What the user requested]

## Progress So Far
- [Decisions and actions in the early part]

## Context Needed to Continue
- [What is needed to understand the preserved recent part]

Preserve exact paths, commands, function names and error messages. Output only the summary.`;
	return summarizeMessages(ctx, messages, instructions, undefined, maxTokens, signal);
}

/** Generates a localized summary for compact, falling back to Pi on failure. */
export async function summarizeCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext, language: SummaryLanguage = "ru"): Promise<{ compaction: any } | undefined> {
	if (!ctx.model) return undefined;
	try {
		const preparation = event.preparation;
		const focus = language === "ru" ? RUSSIAN_COMPACTION_FOCUS : ENGLISH_COMPACTION_FOCUS;
		const instructions = event.customInstructions
			? `${focus}\n\n${language === "ru" ? "Дополнительный checkpoint-контекст и инструкции текущей операции:" : "Additional checkpoint context and instructions for this operation:"}\n${event.customInstructions}`
			: focus;
		const maxTokens = Math.min(Math.floor(preparation.settings.reserveTokens * 0.8), ctx.model.maxTokens > 0 ? ctx.model.maxTokens : Number.POSITIVE_INFINITY);
		let summary: string;
		let usage: unknown;
		if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
			let historyText = preparation.previousSummary ? (language === "ru" ? localizeSummaryStructure(preparation.previousSummary) : preparation.previousSummary) : (language === "ru" ? "Предыдущей истории нет." : "No previous history.");
			let historyUsage: unknown;
			if (preparation.messagesToSummarize.length > 0) {
				const history = await summarizeMessages(ctx, preparation.messagesToSummarize, instructions, preparation.previousSummary, maxTokens, event.signal);
				historyText = language === "ru" ? localizeSummaryStructure(history.text) : history.text;
				historyUsage = history.usage;
				if (!hasSummaryStructure(historyText, language, false)) return undefined;
			} else if (preparation.previousSummary && !hasSummaryStructure(historyText, language, false) && !hasPrefixStructure(historyText, language)) {
				if (language !== "en" || !hasSummaryStructure(historyText, "ru", true)) return undefined;
				// The stored Russian summary remains untouched; only the new English summary is regenerated.
				const history = await summarizeMessages(ctx, [], instructions, preparation.previousSummary, maxTokens, event.signal);
				historyText = history.text;
				historyUsage = history.usage;
				if (!hasSummaryStructure(historyText, "en", false)) return undefined;
			}
			const prefix = await summarizeTurnPrefix(ctx, preparation.turnPrefixMessages, event.signal, Math.min(Math.floor(preparation.settings.reserveTokens * 0.5), ctx.model.maxTokens > 0 ? ctx.model.maxTokens : Number.POSITIVE_INFINITY), language);
			const prefixText = language === "ru" ? localizeSummaryStructure(prefix.text) : prefix.text;
			if (!hasPrefixStructure(prefixText, language)) return undefined;
			summary = `${historyText}\n\n${language === "ru" ? "**Контекст разрезанного хода:**" : "**Turn Context (split turn):**"}\n${prefixText}`;
			usage = combineUsage(historyUsage, prefix.usage);
		} else {
			const result = await summarizeMessages(ctx, preparation.messagesToSummarize, instructions, preparation.previousSummary, maxTokens, event.signal);
			summary = language === "ru" ? localizeSummaryStructure(result.text) : result.text;
			usage = result.usage;
			if (!hasSummaryStructure(summary, language, false)) return undefined;
		}
		const files = collectCumulativeFileLists(preparation.fileOps, event.branchEntries);
		return {
			compaction: {
				summary: `${summary}${formatFileOperations(files)}`,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage,
				details: files,
			},
		};
	} catch {
		return undefined;
	}
}

/** Summarizes /tree in the chosen language while preserving usage and file tracking. */
export async function summarizeTree(event: SessionBeforeTreeEvent, ctx: ExtensionContext, language: SummaryLanguage = "ru"): Promise<{ summary: any } | undefined> {
	if (!event.preparation.userWantsSummary || !ctx.model) return undefined;
	try {
		const reserveTokens = DEFAULT_RESERVE_TOKENS;
		const tokenBudget = Math.max(0, (ctx.model.contextWindow || 128_000) - reserveTokens);
		const prepared = prepareBranchEntries(event.preparation.entriesToSummarize, tokenBudget);
		if (prepared.messages.length === 0) return undefined;
		const replaceInstructions = Boolean(event.preparation.replaceInstructions && event.preparation.customInstructions);
		const focus = language === "ru" ? RUSSIAN_TREE_SUMMARY_INSTRUCTIONS : ENGLISH_TREE_SUMMARY_INSTRUCTIONS;
		const instructions = replaceInstructions
			? event.preparation.customInstructions!
			: event.preparation.customInstructions
				? `${focus}\n\n${language === "ru" ? "Дополнительные инструкции текущего перехода по дереву:" : "Additional instructions for this tree transition:"}\n${event.preparation.customInstructions}`
				: focus;
		const result = await completeSummary(ctx, conversationPrompt(prepared.messages, instructions), Math.min(4096, ctx.model.maxTokens > 0 ? ctx.model.maxTokens : Number.POSITIVE_INFINITY), event.signal);
		const stripped = stripBranchSummaryPreamble(result.text);
		const summary = language === "ru" ? localizeSummaryStructure(stripped) : stripped;
		if (!replaceInstructions && !hasSummaryStructure(summary, language, false)) return undefined;
		const files = collectCumulativeFileLists(prepared.fileOps, event.preparation.entriesToSummarize);
		return {
			summary: {
				summary: `${summary}${formatFileOperations(files)}`,
				usage: result.usage,
				details: files,
			},
		};
	} catch {
		return undefined;
	}
}
