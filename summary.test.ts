import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSummaryLanguage } from "./language.js";
import {
	RUSSIAN_COMPACTION_FOCUS,
	RUSSIAN_TREE_SUMMARY_INSTRUCTIONS,
	localizeSummaryStructure,
	russianCompaction,
	russianTreeSummary,
	stripBranchSummaryPreamble,
} from "./summary.js";

test("summary language is independently configurable and validates the Pi profile", () => {
	const dir = mkdtempSync(join(tmpdir(), "compaction-language-"));
	try {
		expect(loadSummaryLanguage(dir)).toBe("ru");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextCompaction: { summaryLanguage: "en" } }));
		expect(loadSummaryLanguage(dir)).toBe("en");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextCompaction: { summaryLanguage: "fr" } }));
		expect(() => loadSummaryLanguage(dir)).toThrow("contextCompaction.summaryLanguage must be ru or en");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Russian summary formatting", () => {
	test("translates only native structural headings and preserves technical markers", () => {
		const source = [
			"## Goal",
			"A task in progress.",
			"## Constraints & Preferences",
			"## Progress",
			"### Done",
			"### In Progress",
			"### Blocked",
			"## Key Decisions",
			"## Next Steps",
			"## Critical Context",
			"<read-files>",
			"src/example.ts",
			"</read-files>",
			"Error: exact message",
		].join("\n");

		expect(localizeSummaryStructure(source)).toBe([
			"## Цель",
			"A task in progress.",
			"## Ограничения и предпочтения",
			"## Прогресс",
			"### Готово",
			"### В работе",
			"### Заблокировано",
			"## Ключевые решения",
			"## Следующие шаги",
			"## Критический контекст",
			"<read-files>",
			"src/example.ts",
			"</read-files>",
			"Error: exact message",
		].join("\n"));
	});

	test("translates split-turn headings as well", () => {
		expect(localizeSummaryStructure("## Original Request\n## Early Progress\n## Context for Suffix")).toBe("## Исходный запрос\n## Ранний прогресс\n## Контекст для сохранённой части");
	});

	test("translates actual native split-turn headings and service label", () => {
		expect(localizeSummaryStructure("## Original Request\n## Progress So Far\n## Context Needed to Continue\n**Turn Context (split turn):**")).toBe("## Исходный запрос\n## Прогресс на текущий момент\n## Контекст для продолжения\n**Контекст разрезанного хода:**");
	});

	test("does not rewrite technical headings inside code or file blocks", () => {
		const source = "```markdown\n```js\n## Goal\nstill code\n```\n~~~markdown\n## Progress\n~~~\n<read-files>\n## Goal\n</read-files>";
		expect(localizeSummaryStructure(source)).toBe(source);
	});

	test("removes only the native branch preamble", () => {
		const source = "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n## Goal\nРабота";
		expect(stripBranchSummaryPreamble(source)).toBe("## Goal\nРабота");
		expect(stripBranchSummaryPreamble("Вводный абзац\n\n## Раздел\nТекст")).toBe("Вводный абзац\n\n## Раздел\nТекст");
		expect(stripBranchSummaryPreamble("## Цель\nРабота")).toBe("## Цель\nРабота");
	});

	test("prompts require Russian prose without changing technical literals", () => {
		expect(RUSSIAN_COMPACTION_FOCUS).toContain("Пиши весь естественный текст");
		expect(RUSSIAN_COMPACTION_FOCUS).toContain("<read-files>");
		expect(RUSSIAN_TREE_SUMMARY_INSTRUCTIONS).toContain("## Цель");
		expect(RUSSIAN_TREE_SUMMARY_INSTRUCTIONS).toContain("Сохраняй точные пути");
	});

	test("falls back when no model is selected", async () => {
		const event = { preparation: {}, reason: "threshold", willRetry: false, signal: new AbortController().signal } as any;
		const ctx = { model: undefined } as any;
		expect(await russianCompaction(event, ctx)).toBeUndefined();
	});
});

test("Russian compact keeps localized headings, split-turn context and cumulative files", async () => {
	const responses = ["## Goal\nContinue work", "## Goal\nExisting work", "## Original Request\nComplete the feature"];
	const ctx = {
		model: { maxTokens: 8192 },
		modelRegistry: { complete: async () => ({ content: [{ type: "text", text: responses.shift() }], usage: { input: 1 } }) },
	} as any;
	const preparation = { settings: { reserveTokens: 8192 }, isSplitTurn: false, messagesToSummarize: [], previousSummary: undefined, turnPrefixMessages: [], fileOps: { read: new Set(["src/a.ts"]), edited: new Set(["src/b.ts"]) }, firstKeptEntryId: "kept", tokensBefore: 100 };
	const event = { preparation, branchEntries: [], signal: new AbortController().signal } as any;
	const normal = await russianCompaction(event, ctx);
	expect(normal?.compaction.summary).toContain("## Цель\nContinue work");
	expect(normal?.compaction.summary).toContain("<modified-files>\nsrc/b.ts\n</modified-files>");
	const message = { role: "user", content: [{ type: "text", text: "Continue the feature" }], timestamp: 1 };
	const split = await russianCompaction({ ...event, preparation: { ...preparation, isSplitTurn: true, messagesToSummarize: [message], turnPrefixMessages: [message] } }, ctx);
	expect(split?.compaction.summary).toContain("**Контекст разрезанного хода:**\n## Исходный запрос");
});

test("Russian /tree keeps localized headings and usage", async () => {
	const ctx = { model: { contextWindow: 128000, maxTokens: 8192 }, modelRegistry: { complete: async () => ({ content: [{ type: "text", text: "## Goal\nRead src/a.ts" }], usage: { input: 3 } }) } } as any;
	const event = { preparation: { userWantsSummary: true, entriesToSummarize: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } }] }, signal: new AbortController().signal } as any;
	const result = await russianTreeSummary(event, ctx);
	expect(result?.summary.summary).toContain("## Цель\nRead src/a.ts");
	expect(result?.summary.usage).toEqual({ input: 3 });
});
