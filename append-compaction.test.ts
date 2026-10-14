import { describe, expect, test } from "bun:test";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { Type } from "typebox";
import { APPEND_CANDIDATE_END, APPEND_CANDIDATE_START, AppendCapture, appendCompaction, appendTask, preservesPayloadPrefix, shouldUseStandardCompactFallback } from "./append-compaction.js";
import { loadSummarySettings } from "./language.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const model: any = {
	id: "q12-fixture", name: "Q12 offline fixture", provider: "openai", api: "openai-responses", baseUrl: "https://q12.invalid/v1",
	input: ["text"], reasoning: true, contextWindow: 272_000, maxTokens: 128_000,
	cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
	compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsMaxOutputTokens: true },
};
const usage = { input: 20, output: 10, cacheRead: 100, cacheWrite: 0, totalTokens: 130, cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0, total: 0.03 } };
const answer = () => ({ role: "assistant", content: [{ type: "text", text: JSON.stringify({ history: "## Цель\nСохранить замысел.\n## Следующие шаги\nПроверить без публикации.", turnPrefix: "" }) }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 4 });

function fixture() {
	const request: any = { role: "user", content: "Сделай локально, не публикуй. Сохрани содержание.", timestamp: 1 };
	const system: any = { role: "system", content: "Original system. Work normally, using tools when needed.", timestamp: 0, sections: { policy: "<policy>Do not publish</policy>" }, toolsAdded: [{ name: "bash", description: "Execute shell commands", parameters: Type.Object({ command: Type.String() }) }] };
	const progress: any = { ...answer(), content: [{ type: "text", text: "Проверка выполнена. Следующий шаг ещё не сделан." }], timestamp: 2 };
	const tail: any = { role: "user", content: "НОВЫЙ ХВОСТ: сохраняй это как исходное сообщение.", timestamp: 3 };
	const branch: any[] = [{ type: "message", id: "a", message: request }, { type: "message", id: "b", message: progress }, { type: "message", id: "c", message: tail }];
	const controller = new AbortController();
	const event: any = { reason: "manual", signal: controller.signal, branchEntries: branch, preparation: {
		messagesToSummarize: [request, progress], turnPrefixMessages: [], isSplitTurn: false, firstKeptEntryId: "c", tokensBefore: 8000,
		fileOps: { read: new Set(), edited: new Set(), created: new Set() }, settings: { reserveTokens: 4096, keepRecentTokens: 1024 },
	} };
	const messages = [system, request];
	const payload: any = { model: model.id, input: [{ role: "developer", content: "original" }, { role: "user", content: request.content }], tools: [{ name: "bash", type: "function" }], prompt_cache_key: "fixture-session" };
	const snapshot: any = { sessionId: "fixture-session", anchor: "a", provider: model.provider, modelId: model.id, messages, payload };
	let calls = 0, options: any, submitted: any;
	const ctx: any = { model: structuredClone(model), thinkingLevel: "medium", getContextUsage: () => ({ tokens: 8000 }),
		sessionManager: { getSessionId: () => "fixture-session", getBranch: () => branch },
		modelRegistry: { find: () => model, streamSimple: (_model: any, context: any, opts: any) => {
			calls++; options = opts; submitted = context;
			return { result: async () => { await opts.onPayload({ ...payload, input: [...payload.input, { role: "assistant", content: progress.content }, { role: "user", content: tail.content }, { role: "user", content: context.messages.at(-1).content }] }); return answer(); } };
		} },
	};
	return { ctx, event, snapshot, branch, controller, messages, payload, progress, tail, calls: () => calls, options: () => options, submitted: () => submitted };
}

describe("append compaction", () => {
	test("exposes one empty candidate block without changing the surrounding prompt", () => {
		const f = fixture();
		const task = appendTask([...f.messages, f.progress, f.tail], f.event)!;
		const block = `${APPEND_CANDIDATE_START}\n${APPEND_CANDIDATE_END}`;
		expect(task).toContain(block);
		const candidate = task.replace(block, `${APPEND_CANDIDATE_START}\nCANDIDATE\n${APPEND_CANDIDATE_END}`);
		expect(candidate.replace(`${APPEND_CANDIDATE_START}\nCANDIDATE\n${APPEND_CANDIDATE_END}`, block)).toBe(task);
	});
	test("keeps input prefix, tools and system envelope verbatim; checks each separately", () => {
		const f = fixture();
		expect(preservesPayloadPrefix(f.payload, { ...f.payload, input: [...f.payload.input, { role: "user", content: "compact" }] })).toBe(true);
		for (const change of [{ tools: [] }, { instructions: "new" }, { model: "another" }, { input: [{ role: "developer", content: "changed" }] }]) expect(preservesPayloadPrefix(f.payload, { ...f.payload, ...change })).toBe(false);
		expect(preservesPayloadPrefix(undefined, f.payload)).toBe(false);
	});
	test("uses standard compact only for recoverable append failures", () => {
		expect(shouldUseStandardCompactFallback({ kind: "fallback", reason: "unsupported" })).toBe(true);
		expect(shouldUseStandardCompactFallback({ kind: "cancel", reason: "invalid-result" })).toBe(true);
		expect(shouldUseStandardCompactFallback({ kind: "cancel", reason: "request-failed" })).toBe(true);
		expect(shouldUseStandardCompactFallback({ kind: "cancel", reason: "aborted" })).toBe(false);
		expect(shouldUseStandardCompactFallback({ kind: "cancel", reason: "context-changed" })).toBe(false);
		expect(shouldUseStandardCompactFallback({ kind: "success", compaction: { summary: "## Цель\nX", firstKeptEntryId: "c", tokensBefore: 1, usage, details: { read: new Set(), edited: new Set(), created: new Set() } } })).toBe(false);
	});
	test("preserves original tail boundary and usage; no working tool execution loop", async () => {
		const f = fixture(), original = structuredClone(f.snapshot.messages), tail = structuredClone(f.tail);
		const result = await appendCompaction(f.event, f.ctx, f.snapshot);
		expect(result.kind).toBe("success");
		if (result.kind !== "success") throw new Error("Expected success");
		expect(result.compaction.firstKeptEntryId).toBe("c");
		expect(result.compaction.usage).toEqual(usage);
		expect(result.compaction.summary).not.toContain("НОВЫЙ ХВОСТ");
		expect(f.tail).toEqual(tail);
		expect(f.snapshot.messages).toEqual(original);
		expect(f.submitted().messages.slice(0, 2)).toEqual(original);
		expect(f.calls()).toBe(1);
		expect(f.options()).toMatchObject({ transport: "sse", toolChoice: "none", cacheRetention: "short", sessionId: "fixture-session", reasoning: "medium", maxRetries: 0 });
		expect(f.options().maxTokens).toBe(3276);
	});
	test("adds strict OpenAI output schema without changing the cached input prefix", async () => {
		const f = fixture(); let payload: any;
		f.ctx.modelRegistry.streamSimple = (_model: any, context: any, opts: any) => ({ result: async () => {
			payload = await opts.onPayload({ ...f.payload, input: [...f.payload.input, { role: "user", content: context.messages.at(-1).content }] });
			return answer();
		} });
		const result = await appendCompaction(f.event, f.ctx, f.snapshot);
		expect(result.kind).toBe("success");
		expect(payload.text).toEqual({ format: { type: "json_schema", name: "compact_result", strict: true, schema: { type: "object", properties: { history: { type: "string" }, turnPrefix: { type: "string" } }, required: ["history", "turnPrefix"], additionalProperties: false } } });
		expect(preservesPayloadPrefix(f.payload, payload)).toBe(true);
	});
	test("repairs one malformed structured response before returning append success", async () => {
		const f = fixture(); let calls = 0;
		f.ctx.modelRegistry.streamSimple = (_model: any, context: any, opts: any) => ({ result: async () => {
			calls++; await opts.onPayload({ ...f.payload, input: [...f.payload.input, { role: "user", content: context.messages.at(-1).content }] });
			return calls === 1 ? { ...answer(), content: [{ type: "text", text: "{broken" }] } : answer();
		} });
		const result = await appendCompaction(f.event, f.ctx, f.snapshot);
		expect(result.kind).toBe("success");
		expect(calls).toBe(2);
		if (result.kind === "success") expect(result.compaction.usage?.totalTokens).toBe(260);
	});
	test("rejects structural headings hidden inside code fences", async () => {
		const f = fixture(); let calls = 0;
		f.ctx.modelRegistry.streamSimple = (_model: any, context: any, opts: any) => ({ result: async () => {
			calls++; await opts.onPayload({ ...f.payload, input: [...f.payload.input, { role: "user", content: context.messages.at(-1).content }] });
			if (calls === 1) return { ...answer(), content: [{ type: "text", text: JSON.stringify({ history: "```markdown\\n## Цель\\nэто не заголовок\\n```", turnPrefix: "" }) }] };
			return answer();
		} });
		const result = await appendCompaction(f.event, f.ctx, f.snapshot);
		expect(result.kind).toBe("success");
		expect(calls).toBe(2);
	});
	test("capture is an isolated bounded copy and does not mutate the original context", () => {
		const f = fixture(), capture = new AppendCapture();
		capture.context(f.messages, f.ctx); capture.payload(f.payload, f.ctx);
		f.messages[0].content = "changed after capture"; f.payload.tools[0].name = "changed after capture";
		expect(capture.get()!.messages[0].content).toContain("Original system");
		expect((capture.get()!.payload!.tools as any)[0].name).toBe("bash");
		capture.clear(); expect(capture.get()).toBeUndefined();
		f.messages[0].content = "x".repeat(16 * 1024 * 1024); capture.context(f.messages, f.ctx); expect(capture.get()).toBeUndefined();
	});
	test("rejects a working tool call and never executes it or retries", async () => {
		const f = fixture(); let calls = 0;
		f.ctx.modelRegistry.streamSimple = () => ({ result: async () => { calls++; return { ...answer(), stopReason: "toolUse", content: [{ type: "toolCall", id: "danger", name: "bash", arguments: { command: "rm -rf /" } }] }; } });
		expect(await appendCompaction(f.event, f.ctx, f.snapshot)).toMatchObject({ kind: "cancel", reason: "invalid-result", usage });
		expect(calls).toBe(1);
	});
	test("even tool calls mislabelled as normal stop are rejected", async () => {
		const f = fixture(); f.ctx.modelRegistry.streamSimple = () => ({ result: async () => ({ ...answer(), content: [...answer().content, { type: "toolCall", id: "x", name: "bash", arguments: {} }] }) });
		expect(await appendCompaction(f.event, f.ctx, f.snapshot)).toMatchObject({ kind: "cancel", reason: "invalid-result" });
	});
	test("cancel before send, mid-request abort and stale branch never apply a result", async () => {
		const f = fixture(); f.controller.abort(); expect(await appendCompaction(f.event, f.ctx, f.snapshot)).toEqual({ kind: "cancel", reason: "aborted" }); expect(f.calls()).toBe(0);
		for (const change of ["branch", "session", "model", "abort"]) {
			const g = fixture(); g.ctx.modelRegistry.streamSimple = () => ({ result: async () => {
				if (change === "branch") g.branch.push({ type: "custom", id: "new" });
				if (change === "session") g.ctx.sessionManager.getSessionId = () => "new";
				if (change === "model") g.ctx.model.id = "new";
				if (change === "abort") g.controller.abort();
				return answer();
			} });
			expect(await appendCompaction(g.event, g.ctx, g.snapshot)).toMatchObject({ kind: "cancel", reason: change === "abort" ? "aborted" : "context-changed" });
		}
	});
	test("an unknown request failure does not launch a paid retry", async () => {
		const f = fixture(); let calls = 0;
		f.ctx.modelRegistry.streamSimple = () => ({ result: async () => { calls++; throw new Error("stream closed before response.completed"); } });
		expect(await appendCompaction(f.event, f.ctx, f.snapshot)).toEqual({ kind: "cancel", reason: "request-failed" }); expect(calls).toBe(1);
	});
	test("payload mismatch is detected in the pre-send hook", async () => {
		const f = fixture(); let sent = 0;
		f.ctx.modelRegistry.streamSimple = (_m: any, _c: any, opts: any) => ({ result: async () => { await opts.onPayload({ ...f.payload, tools: [] }); sent++; return answer(); } });
		expect(await appendCompaction(f.event, f.ctx, f.snapshot)).toEqual({ kind: "fallback", reason: "payload-mismatch" }); expect(sent).toBe(0);
	});
	test("unsupported path, absent snapshot, edited context and unknown boundary fall back before send", async () => {
		for (const scenario of ["unsupported", "snapshot-unavailable", "context-changed", "boundary-unavailable"]) {
			const f = fixture();
			if (scenario === "unsupported") f.ctx.model.compat.supportsMidConvoSystemMessages = false;
			if (scenario === "snapshot-unavailable") f.snapshot.payload = undefined;
			if (scenario === "context-changed") f.branch.push({ id: "edit", type: "context_edit" });
			if (scenario === "boundary-unavailable") f.event.preparation.messagesToSummarize = [{ role: "user", content: "missing", timestamp: 1 }];
			expect(await appendCompaction(f.event, f.ctx, f.snapshot)).toEqual({ kind: "fallback", reason: scenario }); expect(f.calls()).toBe(0);
		}
	});
	test("source catalog identifies eligible state without importing a tail-only completion", () => {
		const f = fixture();
		f.progress.content = [{ type: "text", text: "Jobs 0133 и 0134 отправлены на проверку; завершение ещё не подтверждено." }];
		f.tail.content = "Jobs 0133 validated: 138/138; 0134 validated: 90/90. Запущена новая ручная Terra-вычитка.";
		const messages = [...f.messages, f.progress, f.tail];
		const original = JSON.stringify(messages);
		const task = appendTask(messages, f.event)!;
		expect(task).toContain('"ordinal":3,"role":"assistant","text":"Jobs 0133 и 0134 отправлены на проверку; завершение ещё не подтверждено."');
		expect(task).not.toContain("138/138");
		expect(task).not.toContain("90/90");
		expect(task).not.toContain("новая ручная Terra");
		expect(task).toContain("запланированное до границы должно остаться запланированным");
		expect(JSON.stringify(messages)).toBe(original);
	});
	test("rejects a summary that imports a numeric fact only present in the saved tail", async () => {
		const f = fixture();
		f.progress.content = [{ type: "text", text: "Jobs 0133 и 0134 отправлены на проверку; завершение ещё не подтверждено." }];
		f.tail.content = "Jobs 0133 validated: 138/138; 0134 validated: 90/90.";
		f.ctx.modelRegistry.streamSimple = () => ({ result: async () => ({ ...answer(), content: [{ type: "text", text: JSON.stringify({ history: "## Цель\nJob 0133 validated: 138 segments; job 0134 validated: 90 segments.", turnPrefix: "" }) }] }) });
		expect(await appendCompaction(f.event, f.ctx, f.snapshot)).toMatchObject({ kind: "cancel", reason: "invalid-result" });
	});

	test("window accounts for full envelope, output/reasoning and margin; session override cannot invent capability", async () => {
		const f = fixture(); f.ctx.getContextUsage = () => ({ tokens: 269_000 }); f.ctx.model.contextWindow = 1_000_000;
		expect(await appendCompaction(f.event, f.ctx, f.snapshot)).toEqual({ kind: "fallback", reason: "insufficient-window" }); expect(f.calls()).toBe(0);
		const g = fixture(); g.snapshot.payload.tools = "x".repeat(900_000);
		expect(await appendCompaction(g.event, g.ctx, g.snapshot)).toEqual({ kind: "fallback", reason: "insufficient-window" }); expect(g.calls()).toBe(0);
	});
	test("split-turn requires a prefix summary but keeps the same raw tail", async () => {
		const f = fixture(); f.event.preparation.messagesToSummarize = [f.messages[1]]; f.event.preparation.turnPrefixMessages = [f.progress]; f.event.preparation.isSplitTurn = true;
		const task = appendTask([...f.messages, f.progress, f.tail], f.event)!;
		expect(task).toContain("Номера сообщений (с 1, включая system и toolResult): 2."); expect(task).toContain("Номера сообщений (с 1, включая system и toolResult): 3."); expect(task).not.toContain("НОВЫЙ ХВОСТ");
		f.ctx.modelRegistry.streamSimple = () => ({ result: async () => ({ ...answer(), content: [{ type: "text", text: JSON.stringify({ history: "## Цель\nИстория", turnPrefix: "## Исходный запрос\nЛокальная проверка\n## Контекст для продолжения\nРабота ещё не завершена." }) }] }) });
		const result = await appendCompaction(f.event, f.ctx, f.snapshot); expect(result.kind).toBe("success");
		if (result.kind === "success") { expect(result.compaction.summary).toContain("**Контекст разрезанного хода:**"); expect(result.compaction.firstKeptEntryId).toBe("c"); }
	});
	test("repeated user text does not move the split-turn boundary backwards", () => {
		const f = fixture();
		const earlier = { role: "user", content: "Продолжай.", timestamp: 10 } as any;
		const later = { role: "user", content: "Продолжай.", timestamp: 20 } as any;
		f.event.preparation.messagesToSummarize = [earlier]; f.event.preparation.turnPrefixMessages = [later];
		const task = appendTask([f.messages[0], earlier, later, f.tail], f.event)!;
		expect(task).toContain("Номера сообщений (с 1, включая system и toolResult): 2.");
		expect(task).toContain("Номера сообщений (с 1, включая system и toolResult): 3.");
	});
	test("invalid JSON, missing goal, length cutoff and missing split-turn prefix are rejected", async () => {
		for (const response of [{ ...answer(), content: [{ type: "text", text: "not JSON" }] }, { ...answer(), stopReason: "length" }, { ...answer(), content: [{ type: "text", text: '{"history":"No goal", "turnPrefix":""}' }] }]) {
			const f = fixture(); f.ctx.modelRegistry.streamSimple = () => ({ result: async () => response }); expect(await appendCompaction(f.event, f.ctx, f.snapshot)).toMatchObject({ kind: "cancel", reason: "invalid-result" });
		}
		const f = fixture(); f.event.preparation.isSplitTurn = true; f.event.preparation.messagesToSummarize = [f.messages[1]]; f.event.preparation.turnPrefixMessages = [f.progress]; expect(await appendCompaction(f.event, f.ctx, f.snapshot)).toMatchObject({ kind: "cancel", reason: "invalid-result" });
	});
});

test("real OpenAI Responses converter preserves original envelope and produces an isolated no-tool request offline", async () => {
	const f = fixture(); let requests = 0, original: any, next: any;
	const capture = async (messages: any[], opts: any, receive: (payload: any) => void) => {
		await streamSimple(model, { messages }, { ...opts, apiKey: "offline-fixture", fetch: async () => { requests++; throw new Error("NETWORK_FORBIDDEN"); }, onPayload: (payload) => { receive(structuredClone(payload)); throw new Error("OFFLINE_CAPTURE_ONLY"); } }).result();
	};
	await capture(f.messages, { sessionId: "fixture-session", cacheRetention: "short", reasoning: "medium", maxRetries: 0, transport: "sse" }, (payload) => { original = payload; });
	await capture([...f.messages, f.progress, f.tail, { role: "user", content: "Only return a compact summary. Never call tools.", timestamp: 4 }], { sessionId: "fixture-session", cacheRetention: "short", reasoning: "medium", maxRetries: 0, transport: "sse", toolChoice: "none" }, (payload) => { next = payload; });
	expect(requests).toBe(0); expect(original.input.length).toBeGreaterThan(0); expect(preservesPayloadPrefix(original, next)).toBe(true);
	expect(next.tools).toEqual(original.tools); expect(next.tool_choice).toBe("none"); expect(next.prompt_cache_key).toBe(original.prompt_cache_key); expect(next.store).toBe(false); expect(next.previous_response_id).toBeUndefined(); expect(next.reasoning.effort).toBe("medium");
});

test("append setting is opt-in and rejects ambiguous values", () => {
	const dir = mkdtempSync(join(tmpdir(), "q12-settings-"));
	try {
		expect(loadSummarySettings(dir)).toEqual({ summaryLanguage: "ru", appendCompaction: false });
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextCompaction: { appendCompaction: true } })); expect(loadSummarySettings(dir).appendCompaction).toBe(true);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextCompaction: { appendCompaction: "true" } })); expect(() => loadSummarySettings(dir)).toThrow("contextCompaction.appendCompaction must be a boolean");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
