import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSummaryLanguage } from "./language.js";
import {
	ENGLISH_COMPACTION_FOCUS,
	ENGLISH_TREE_SUMMARY_INSTRUCTIONS,
	RUSSIAN_COMPACTION_FOCUS,
	RUSSIAN_TREE_SUMMARY_INSTRUCTIONS,
	localizeSummaryStructure,
	summarizeCompaction,
	summarizeTree,
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
		expect(await summarizeCompaction(event, ctx)).toBeUndefined();
	});
});

test("English compaction keeps English headings and cumulative files in normal and split turns", async () => {
 const prompts: string[] = [];
 const responses = ["## Goal\nContinue work", "## Goal\nExisting work", "## Original Request\nComplete the feature"];
 const ctx = {
  model: { maxTokens: 8192 },
  modelRegistry: { complete: async (_model: unknown, request: any) => { prompts.push(request.messages[0].content[0].text); return { content: [{ type: "text", text: responses.shift() }], usage: { input: 1 } }; } },
 } as any;
 const preparation = { settings: { reserveTokens: 8192 }, isSplitTurn: false, messagesToSummarize: [], previousSummary: undefined, turnPrefixMessages: [], fileOps: { read: new Set(["src/a.ts"]), edited: new Set(["src/b.ts"]) }, firstKeptEntryId: "kept", tokensBefore: 100 };
 const event = { preparation, branchEntries: [], signal: new AbortController().signal } as any;
 const normal = await summarizeCompaction(event, ctx, "en");
 expect(normal?.compaction.summary).toContain("## Goal\nContinue work");
 expect(normal?.compaction.summary).toContain("<modified-files>\nsrc/b.ts\n</modified-files>");
 expect(prompts[0]).toContain(ENGLISH_COMPACTION_FOCUS);
 const message = { role: "user", content: [{ type: "text", text: "Continue the feature" }], timestamp: 1 };
 const split = await summarizeCompaction({ ...event, preparation: { ...preparation, isSplitTurn: true, messagesToSummarize: [message], turnPrefixMessages: [message] } }, ctx, "en");
 expect(split?.compaction.summary).toContain("**Turn Context (split turn):**\n## Original Request");
 expect(prompts[2]).toContain("## Context Needed to Continue");
 expect(prompts[2]).not.toContain("## Контекст для продолжения");
});

test("English split-turn regenerates a prior Russian summary before writing the new prefix", async () => {
 const prompts: string[] = [];
 const responses = ["## Goal\nFinish src/a.ts", "## Original Request\nContinue src/a.ts"];
 const ctx = { model: { maxTokens: 8192 }, modelRegistry: { complete: async (_model: unknown, request: any) => { prompts.push(request.messages[0].content[0].text); return { content: [{ type: "text", text: responses.shift() }], usage: { input: 2 } }; } } } as any;
 const message = { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 1 };
 const event = { branchEntries: [], preparation: { settings: { reserveTokens: 8192 }, isSplitTurn: true, messagesToSummarize: [], previousSummary: "## Цель\nЗавершить src/a.ts", turnPrefixMessages: [message], fileOps: { read: new Set(["src/a.ts"]) }, firstKeptEntryId: "kept", tokensBefore: 100 }, signal: new AbortController().signal } as any;
 const result = await summarizeCompaction(event, ctx, "en");
 expect(result?.compaction.summary).toContain("## Goal\nFinish src/a.ts\n\n**Turn Context (split turn):**\n## Original Request");
 expect(result?.compaction.summary).toContain("<read-files>\nsrc/a.ts\n</read-files>");
 expect(result?.compaction.usage.input).toBe(4);
 expect(prompts[0]).toContain("## Цель\nЗавершить src/a.ts");
 expect(prompts[0]).toContain(ENGLISH_COMPACTION_FOCUS);
 expect(prompts).toHaveLength(2);
});

test("English /tree uses English instructions and preserves paths and usage", async () => {
 let prompt = "";
 const ctx = { model: { contextWindow: 128000, maxTokens: 8192 }, modelRegistry: { complete: async (_model: unknown, request: any) => { prompt = request.messages[0].content[0].text; return { content: [{ type: "text", text: "## Goal\nRead src/a.ts" }], usage: { input: 3 } }; } } } as any;
 const event = { preparation: { userWantsSummary: true, entriesToSummarize: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } }] }, signal: new AbortController().signal } as any;
 const result = await summarizeTree(event, ctx, "en");
 expect(result?.summary.summary).toContain("## Goal\nRead src/a.ts");
 expect(result?.summary.usage).toEqual({ input: 3 });
 expect(prompt).toContain(ENGLISH_TREE_SUMMARY_INSTRUCTIONS);
 expect(prompt).not.toContain("Пиши весь естественный текст");
});
