import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { SummaryLanguage } from "./language.js";

export type ContinuationMode = "explicit_prompt" | "plan_phase" | "resume_existing_plan" | "goal_loop" | "auto_context_pressure";

const FOLLOW_UP_MARKER_PREFIX = "<!-- pi-context-compaction:follow-up:";
const FOLLOW_UP_MARKER_SUFFIX = " -->";

type BranchEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown };
};

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type?: unknown; text?: unknown } => !!part && typeof part === "object")
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function continuationCorrelation(entry: BranchEntry): string | null {
	if (entry.type !== "message" || entry.message?.role !== "user") return null;
	const match = messageText(entry.message.content).match(/<!-- pi-context-compaction:follow-up:([^\s>]+) -->/);
	return match?.[1] ?? null;
}

/** Отличает followUp этого расширения от настоящего user input по durable send audit. */
export function isHumanUserMessage(entry: BranchEntry, entries: readonly BranchEntry[]): boolean {
	if (entry.type !== "message" || entry.message?.role !== "user") return false;
	const correlation = continuationCorrelation(entry);
	if (!correlation) return true;
	return !entries.some((candidate) => {
		const audit = candidate.type === "custom" && candidate.customType === "context-compaction-audit" && candidate.data && typeof candidate.data === "object"
			? candidate.data as { correlation?: unknown; phase?: unknown; origin?: unknown }
			: undefined;
		return audit?.correlation === correlation && audit.phase === "send-attempted" && (audit.origin === "manual-tool" || audit.origin === "planned");
	});
}

/** Помечает continuation так, чтобы его materialized role:user entry не стал human watermark. */
export function contextCompactionFollowUp(prompt: string, correlation: string): string {
	return `${FOLLOW_UP_MARKER_PREFIX}${correlation}${FOLLOW_UP_MARKER_SUFFIX}\n${prompt}`;
}

export interface CheckpointParams {
	mainObjective: string;
	completedCheckpoint: string;
	continuationMode?: ContinuationMode;
	continuationTarget: string;
	planPath?: string;
	currentPhase?: string;
	nextPhase?: string;
	importantFiles?: string[];
	verificationState?: string;
	blockers?: string;
	doNotDo?: string[];
	extraContext?: string;
}

/** Defines the same tool arguments in both languages without changing parameter names. */
export function checkpointParamsSchema(language: SummaryLanguage) {
	const en = language === "en";
	return Type.Object({
		mainObjective: Type.String({ description: en ? "The main user objective to continue after compaction." : "Главная цель пользователя, которую нужно продолжить после compact." }),
		completedCheckpoint: Type.String({ description: en ? "Work already completed before compaction." : "Что уже завершено перед compact." }),
		continuationMode: Type.Optional(StringEnum(["explicit_prompt", "plan_phase", "resume_existing_plan", "goal_loop", "auto_context_pressure"] as const)),
		continuationTarget: Type.String({ description: en ? "The next concrete step after compaction." : "Следующий конкретный шаг после compact." }),
		planPath: Type.Optional(Type.String()),
		currentPhase: Type.Optional(Type.String()),
		nextPhase: Type.Optional(Type.String()),
		importantFiles: Type.Optional(Type.Array(Type.String())),
		verificationState: Type.Optional(Type.String()),
		blockers: Type.Optional(Type.String()),
		doNotDo: Type.Optional(Type.Array(Type.String())),
		extraContext: Type.Optional(Type.String()),
	});
}
export const CheckpointParamsSchema = checkpointParamsSchema("ru");

export function prepareArguments(args: unknown): CheckpointParams {
	const input = (args && typeof args === "object" ? args : {}) as Partial<CheckpointParams> & {
		nextPrompt?: string;
		nextStep?: string;
	};
	return { ...input, continuationTarget: input.continuationTarget ?? input.nextPrompt ?? input.nextStep } as CheckpointParams;
}

/** Проверяет, был ли compact после последнего настоящего user message. */
export function compactedSinceLastUserMessage(ctx: { sessionManager: { getBranch(): readonly BranchEntry[] } }): boolean {
	const entries = ctx.sessionManager.getBranch();
	let user = -1;
	let compact = -1;
	for (const [index, entry] of entries.entries()) {
		if (isHumanUserMessage(entry, entries)) user = index;
		if (entry.type === "compaction") compact = index;
	}
	return compact > user;
}

/** Builds the manual checkpoint ledger in the configured language. */
export function buildLedger(params: CheckpointParams, language: SummaryLanguage = "ru"): string {
	const optional = (name: string, value?: string) => value?.trim() ? `\n\n## ${name}\n${value.trim()}` : "";
	const list = (name: string, value?: string[]) => value?.length ? `\n\n## ${name}\n${value.map((item) => `- ${item}`).join("\n")}` : "";
	const names = language === "ru"
		? ["Главная цель", "Завершённый checkpoint", "Следующий шаг", "Режим продолжения", "План", "Важные файлы", "Проверка", "Блокеры", "Не повторять", "Дополнительный контекст"]
		: ["Main objective", "Completed checkpoint", "Next step", "Continuation mode", "Plan", "Important files", "Verification", "Blockers", "Do not repeat", "Additional context"];
	return `## ${names[0]}\n${params.mainObjective}\n\n## ${names[1]}\n${params.completedCheckpoint}\n\n## ${names[2]}\n${params.continuationTarget}`
		+ optional(names[3], params.continuationMode)
		+ optional(names[4], [params.planPath, params.currentPhase, params.nextPhase].filter(Boolean).join("; "))
		+ list(names[5], params.importantFiles)
		+ optional(names[6], params.verificationState)
		+ optional(names[7], params.blockers)
		+ list(names[8], params.doNotDo)
		+ optional(names[9], params.extraContext);
}

export function buildInstructions(ledger: string, language: SummaryLanguage = "ru"): string {
	const instruction = language === "ru"
		? "Сформируй компактную карточку продолжения текущей задачи. Сохрани цель, ограничения, изменения, проверки, блокеры и ближайший шаг. Не копируй пустые разделы."
		: "Write a concise continuation note in English. Preserve the objective, constraints, changes, checks, blockers and next action. Omit empty sections.";
	return `${instruction}\n\n${ledger}`;
}

export function continuationPrompt(params: CheckpointParams, language: SummaryLanguage = "ru"): string {
	if (language === "en") return `Continue the main objective from the next unfinished step in the summary: ${params.continuationTarget}.${params.continuationMode ? ` Continuation mode: ${params.continuationMode}.` : ""} Do not replan from scratch.`;
	const mode = params.continuationMode ? ` Режим продолжения: ${params.continuationMode}.` : "";
	return `Продолжи основную цель по краткой сводке с ближайшего незавершённого действия: ${params.continuationTarget}.${mode} Не перепланируй работу с нуля.`;
}
