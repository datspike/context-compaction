import { describe, expect, test } from "bun:test";
import {
	RUSSIAN_COMPACTION_FOCUS,
	RUSSIAN_TREE_SUMMARY_INSTRUCTIONS,
	localizeSummaryStructure,
	russianCompaction,
	stripBranchSummaryPreamble,
} from "./summary.js";

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
