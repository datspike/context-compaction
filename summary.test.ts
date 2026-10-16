import { MAX_COMPACT_PAYLOAD_CHARS } from "./compact-budget.js";
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
		expect(RUSSIAN_COMPACTION_FOCUS).toContain("«решение пользователя» или «предложение агента»");
		expect(RUSSIAN_COMPACTION_FOCUS).toContain("испробованные пути с причиной отказа");
		expect(RUSSIAN_TREE_SUMMARY_INSTRUCTIONS).toContain("## Цель");
		expect(RUSSIAN_TREE_SUMMARY_INSTRUCTIONS).toContain("Сохраняй точные пути");
	});

	test("returns an explicit cancellation when no model is selected", async () => {
		const event = { preparation: {}, reason: "threshold", willRetry: false, signal: new AbortController().signal } as any;
		const ctx = { model: undefined } as any;
		expect(await russianCompaction(event, ctx)).toEqual({ cancel: true });
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
	expect(normal?.compaction.summary).toContain("<file-hints>");
	expect(normal?.compaction.summary).not.toContain("<modified-files>");
	expect(normal?.compaction.details.modifiedFiles).toEqual(["src/b.ts"]);
	const message = { role: "user", content: [{ type: "text", text: "Continue the feature" }], timestamp: 1 };
	const split = await russianCompaction({ ...event, preparation: { ...preparation, isSplitTurn: true, messagesToSummarize: [message], turnPrefixMessages: [message] } }, ctx);
	expect(split?.compaction.summary).toContain("**Контекст разрезанного хода:**\nЭтот ход начат после истории выше.");
	expect(split?.compaction.summary).toContain("действует он; разделы выше описывают состояние до хода.\n## Исходный запрос");
});

test("Russian /tree keeps localized headings and usage", async () => {
	const ctx = { model: { contextWindow: 128000, maxTokens: 8192 }, modelRegistry: { complete: async () => ({ content: [{ type: "text", text: "## Goal\nRead src/a.ts" }], usage: { input: 3 } }) } } as any;
	const event = { preparation: { userWantsSummary: true, entriesToSummarize: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } }] }, signal: new AbortController().signal } as any;
	const result = await russianTreeSummary(event, ctx);
	expect(result?.summary.summary).toContain("## Цель\nRead src/a.ts");
	expect(result?.summary.usage).toEqual({ input: 3 });
});


function guardedFixture() {
const controller = new AbortController();
const activeModel: any = { provider: "fixture", id: "active", api: "openai-responses", baseUrl: "https://active.invalid", maxTokens: 8192, contextWindow: 128000 };
const branch: any[] = [{ id: "root", parentId: null, type: "message" }];
let sessionId = "session-a";
let route: object = {};
const fixture: any = { controller, branch, activeModel, sessionId, route, calls: [], response: { stopReason: "stop", content: [{ type: "text", text: "## Goal\nСводка" }], usage: { input: 2, output: 3 } } };
fixture.setSession = (value: string) => { sessionId = value; };
fixture.setRoute = (value: object) => { route = value; };
const manager = { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.jsonl`, getLeafId: () => branch.at(-1)?.id ?? null, getBranch: () => branch };
fixture.ctx = { model: activeModel, sessionManager: manager, modelRegistry: { getProvider: () => route, complete: async (...args: any[]) => { fixture.calls.push(args); return fixture.response; } } };
const preparation = { settings: { reserveTokens: 8192 }, isSplitTurn: false, messagesToSummarize: [], previousSummary: undefined, turnPrefixMessages: [], fileOps: { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() }, firstKeptEntryId: "kept", tokensBefore: 100 };
fixture.event = { preparation, branchEntries: [], signal: controller.signal, reason: "threshold", willRetry: false };
return fixture;
}

test("standard compact uses the service model without changing the active identity and requests SSE once", async () => {
const fixture = guardedFixture();
const serviceModel: any = { ...fixture.activeModel, id: "service", baseUrl: "https://service.invalid" };
const result = await russianCompaction(fixture.event, fixture.ctx, { model: serviceModel });
expect(result).toHaveProperty("compaction");
expect(fixture.calls).toHaveLength(1);
expect(fixture.calls[0][0]).toBe(serviceModel);
expect(fixture.calls[0][2]).toMatchObject({ transport: "sse", maxRetries: 0, signal: fixture.event.signal });
expect(fixture.ctx.model).toBe(fixture.activeModel);
});

test("standard compact classifies invalid responses and request failures separately", async () => {
const invalid = guardedFixture();
invalid.response = { stopReason: "stop", content: [{ type: "text", text: "не структурировано" }] };
const invalidReasons: string[] = [];
expect(await russianCompaction(invalid.event, invalid.ctx, { onFailure: (reason) => invalidReasons.push(reason) })).toEqual({ cancel: true });
expect(invalidReasons).toEqual(["invalid-response"]);
const failed = guardedFixture();
failed.ctx.modelRegistry.complete = async (...args: any[]) => { failed.calls.push(args); throw new Error("network unavailable"); };
const failedReasons: string[] = [];
expect(await russianCompaction(failed.event, failed.ctx, { onFailure: (reason) => failedReasons.push(reason) })).toEqual({ cancel: true });
expect(failedReasons).toEqual(["request-failed"]);
});

test("standard compact rejects session, tree, model and route changes after await", async () => {
for (const change of ["session", "tree", "model", "route"] as const) {
const fixture = guardedFixture();
fixture.ctx.modelRegistry.complete = async (...args: any[]) => {
fixture.calls.push(args);
if (change === "session") fixture.setSession("session-b");
if (change === "tree") fixture.branch.push({ id: "child", parentId: "root", type: "message" });
if (change === "model") fixture.ctx.model = { ...fixture.activeModel, id: "changed" };
if (change === "route") fixture.setRoute({});
return fixture.response;
};
const reasons: string[] = [];
expect(await russianCompaction(fixture.event, fixture.ctx, { onFailure: (reason) => reasons.push(reason) })).toEqual({ cancel: true });
expect(reasons).toEqual(["context-changed"]);
expect(fixture.calls).toHaveLength(1);
}
});

test("standard compact treats abort and owner loss as explicit cancellation", async () => {
const aborted = guardedFixture();
aborted.ctx.modelRegistry.complete = async (...args: any[]) => { aborted.calls.push(args); aborted.controller.abort(); return aborted.response; };
const abortedReasons: string[] = [];
expect(await russianCompaction(aborted.event, aborted.ctx, { onFailure: (reason) => abortedReasons.push(reason) })).toEqual({ cancel: true });
expect(abortedReasons).toEqual(["aborted"]);
const stale = guardedFixture();
const staleReasons: string[] = [];
expect(await russianCompaction(stale.event, stale.ctx, { isCurrent: () => false, onFailure: (reason) => staleReasons.push(reason) })).toEqual({ cancel: true });
expect(staleReasons).toEqual(["context-changed"]);
expect(stale.calls).toHaveLength(0);
});

test("split-turn stops before the prefix request when history loses its context", async () => {
const fixture = guardedFixture();
const message = { role: "user", content: [{ type: "text", text: "Новый ход" }], timestamp: 1 };
fixture.event.preparation = { ...fixture.event.preparation, isSplitTurn: true, messagesToSummarize: [message], turnPrefixMessages: [message] };
fixture.ctx.modelRegistry.complete = async (...args: any[]) => {
fixture.calls.push(args);
fixture.ctx.model = { ...fixture.activeModel, id: "changed" };
return fixture.response;
};
const reasons: string[] = [];
expect(await russianCompaction(fixture.event, fixture.ctx, { onFailure: (reason) => reasons.push(reason) })).toEqual({ cancel: true });
expect(reasons).toEqual(["context-changed"]);
expect(fixture.calls).toHaveLength(1);
});

for (const kind of ["small", "oversized", "swallowed-error", "late-route"] as const) test(`standard final provider boundary: ${kind}`, async () => {
const fixture = guardedFixture();
const huge = kind === "oversized" || kind === "swallowed-error";
const text = huge ? "\0".repeat(Math.ceil(MAX_COMPACT_PAYLOAD_CHARS / 6) + 2048) : "Сохранить локальный JSON";
fixture.event.preparation.messagesToSummarize = [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }];
const reasons: string[] = [];
let sent = 0;
fixture.ctx.modelRegistry.complete = async (model: any, context: any, options: any) => {
 const payload = { model: model.id, input: context.messages, encrypted_content: "opaque-kept" };
 if (kind === "late-route") fixture.activeModel.baseUrl = "https://changed.invalid";
 try { expect((await options.onPayload?.(payload, model)) ?? payload).toBe(payload); }
 catch (error) { if (kind === "swallowed-error") return { stopReason: "error", errorMessage: String(error), content: [] }; throw error; }
 sent++;
 return fixture.response;
};
const result = await russianCompaction(fixture.event, fixture.ctx, { model: { ...fixture.activeModel, contextWindow: 1048576 }, capability: { window: 1048576, source: "offline exact-route declaration", outputLimitEnforced: false }, onFailure: (reason) => reasons.push(reason) });
if (kind === "small") { expect(result).toHaveProperty("compaction"); expect(sent).toBe(1); }
else { expect(result).toEqual({ cancel: true }); expect(sent).toBe(0); expect(reasons).toEqual([kind === "late-route" ? "context-changed" : "request-too-large"]); }
});