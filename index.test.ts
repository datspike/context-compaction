import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { appendAuditPayload, appendUsageForAudit } from "./index.js";

const params = { mainObjective: "Продолжить цель", completedCheckpoint: "Завершён этап", continuationTarget: "Сделать следующий шаг" };
let sequence = 0;

function setup(options: { branch?: any[]; sessionId?: string; setModelResult?: boolean; setModelResults?: Array<boolean | "reject">; emitModelSelect?: boolean; thinkingLevel?: string; modelSwitchThinkingLevel?: string; language?: "ru" | "en"; appendCompaction?: boolean; modelProvider?: string; modelId?: string; registryContextWindow?: number; registryTiers?: Array<{ inputTokensAbove: number }> } = {}) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const renderers = new Map<string, any>();
	let tool: any;
	let command: any;
	let idle = false;
	let branch = options.branch ?? [{ id: "user-1", type: "message", message: { role: "user", content: "Начать работу" } }];
	let sessionId = options.sessionId ?? `session-${++sequence}`;
	let thinkingLevel = options.thinkingLevel ?? "low";
	let compactionInProgress = false;
	const audits: any[] = [];
	const compactOptions: any[] = [];
	const sent: string[] = [];
	const setModelCalls: any[] = [];
	const notices: Array<{ text: string; level: string }> = [];
	const sessionManager = { getEntries: () => branch, getBranch: () => branch, getSessionId: () => sessionId, getSessionFile: () => undefined };
	const ctx: any = {
		cwd: "/tmp/context-compaction-test",
		hasUI: true,
		ui: { notify(text: string, level: string) { notices.push({ text, level }); }, setStatus() {} },
        model: { provider: options.modelProvider ?? "openai", id: options.modelId ?? "gpt-5.6-sol", api: "openai-responses", contextWindow: 272_000, maxTokens: 128_000, compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } },
        modelRegistry: { getAll: () => [{ provider: options.modelProvider ?? "openai", id: options.modelId ?? "gpt-5.6-sol", contextWindow: options.registryContextWindow ?? 600_000, cost: { tiers: options.registryTiers ?? [{ inputTokensAbove: options.registryContextWindow ?? 600_000 }] } }], find: () => ctx.model },
		sessionManager,
		getContextUsage: () => ({ tokens: 1_000, contextWindow: ctx.model.contextWindow, percent: 1 }),
		isIdle: () => idle,
		compact(value: any) { compactOptions.push(value); },
	};
	const pi: any = {
		registerTool(value: any) { tool = value; },
		registerCommand(_name: string, value: any) { command = value.handler; },
		on(name: string, value: any) { handlers.set(name, value); },
		registerEntryRenderer(type: string, renderer: any) { renderers.set(type, renderer); },
		appendEntry(type: string, data: any) {
			audits.push({ type, data });
			branch = [...branch, { id: `append-${audits.length}`, type: "custom", customType: type, data }];
		},
		async setModel(next: any) {
			setModelCalls.push(next);
			const result = options.setModelResults?.shift() ?? options.setModelResult ?? true;
			if (result === false) return false;
			ctx.model = next;
			if (options.emitModelSelect) await handlers.get("model_select")?.({}, ctx);
			if (result === "reject") throw new Error("session transcript write failed");
			if (options.modelSwitchThinkingLevel) thinkingLevel = options.modelSwitchThinkingLevel;
			return true;
		},
		getThinkingLevel() { return thinkingLevel; },
		setThinkingLevel(value: string) { thinkingLevel = value; },
		sendUserMessage(text: string) { if (!compactionInProgress) sent.push(text); },
	};
	const agentDir = mkdtempSync(join(tmpdir(), "context-compaction-test-profile-"));
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ contextCompaction: { summaryLanguage: options.language ?? "ru", appendCompaction: options.appendCompaction ?? false } }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		extension(pi);
	} finally {
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
	return {
		ctx, tool, command, audits, renderers, compactOptions, sent, notices, setModelCalls,
		hasEvent(name: string) { return handlers.has(name); },
		get thinkingLevel() { return thinkingLevel; },
		setBranch(value: any[]) { branch = value; },
		getBranch() { return branch; },
		setSessionId(value: string) { sessionId = value; },
		setCompactionInProgress(value: boolean) { compactionInProgress = value; },
		async flush() { await Promise.resolve(); await Promise.resolve(); },
		async event(name: string, event: any = {}, context: any = ctx) { return handlers.get(name)!(event, context); },
		async settle(isNowIdle = true) { idle = isNowIdle; return handlers.get("agent_settled")!({}, ctx); },
	};
}

async function startManual(runtime: ReturnType<typeof setup>) {
	const result = await runtime.tool.execute("call", params, undefined, undefined, runtime.ctx);
	expect(result.details.result).toBe("scheduled");
	await runtime.settle();
	expect(runtime.compactOptions).toHaveLength(1);
	return runtime.compactOptions[0];
}

describe("public compaction lifecycle", () => {
	test("does not import or arm a private automatic-compaction path", async () => {
		const runtime = setup();
		await runtime.event("turn_end", { message: { role: "assistant" }, toolResults: [] });
		await runtime.settle();
		expect(runtime.compactOptions).toHaveLength(0);
		expect(runtime.audits).toHaveLength(0);
	});

	test("manual checkpoint waits for agent_settled and keeps its structured ledger", async () => {
		const runtime = setup();
		await runtime.tool.execute("call", params, undefined, undefined, runtime.ctx);
		expect(runtime.compactOptions).toHaveLength(0);
		await runtime.settle(false);
		expect(runtime.compactOptions).toHaveLength(0);
		await runtime.settle(true);
		expect(runtime.compactOptions[0].customInstructions).toContain("Главная цель");
		expect(runtime.compactOptions[0].customInstructions).toContain("Следующий шаг");
	});

	test("manual continuation waits for ctx.compact onComplete, after Pi releases its compaction lock", async () => {
		const runtime = setup();
		const callback = await startManual(runtime);
		runtime.setCompactionInProgress(true);
		await runtime.event("session_before_compact", { reason: "manual", willRetry: false });
		await runtime.event("session_compact", { reason: "manual", willRetry: false, compactionEntry: { tokensBefore: 12_000 } });
		expect(runtime.sent).toHaveLength(0);
		expect(runtime.audits.filter((entry) => entry.data.phase === "success" && entry.data.origin === "manual-tool")).toHaveLength(1);
		runtime.setCompactionInProgress(false);
		callback.onComplete({});
		await runtime.flush();
		expect(runtime.sent).toHaveLength(1);
		expect(runtime.sent[0]).toContain("Сделать следующий шаг");
		expect(runtime.audits.filter((entry) => entry.data.phase === "continuation-claimed")).toHaveLength(1);
		expect(runtime.audits.filter((entry) => entry.data.phase === "send-attempted")).toHaveLength(1);
		callback.onError(new Error("late"));
		expect(runtime.sent).toHaveLength(1);
	});

	for (const appendCompaction of [false, true]) test(`English compact delegates manual, threshold and overflow summaries to Pi (append=${appendCompaction})`, async () => {
		const runtime = setup({ language: "en", appendCompaction });
		let customCalls = 0;
		runtime.ctx.modelRegistry.complete = () => { customCalls++; throw new Error("Custom summarizer must not run in English mode"); };
		runtime.ctx.modelRegistry.streamSimple = () => { customCalls++; throw new Error("Append summarizer must not run in English mode"); };
		expect(runtime.hasEvent("session_before_tree")).toBe(false);
		expect(runtime.hasEvent("context_with_system")).toBe(false);
		expect(runtime.hasEvent("before_provider_request")).toBe(false);
		const callback = await startManual(runtime);
		expect(callback.customInstructions).toContain("## Main objective");
		expect(callback.customInstructions).not.toContain("## Главная цель");
		expect(await runtime.event("session_before_compact", { reason: "manual", willRetry: false, preparation: { tokensBefore: 100 } })).toBeUndefined();
		await runtime.event("session_compact", { reason: "manual", willRetry: false, compactionEntry: { tokensBefore: 100 } });
		callback.onComplete({});
		await runtime.flush();
		expect(runtime.sent).toHaveLength(1);
		expect(runtime.sent[0]).toContain("Continue the main objective");
		for (const reason of ["threshold", "overflow"]) {
			expect(await runtime.event("session_before_compact", { reason, willRetry: reason === "overflow", preparation: { tokensBefore: 100 } })).toBeUndefined();
		}
		expect(customCalls).toBe(0);
	});

	test("failed manual compact records an error and never synthesizes continuation", async () => {
		const runtime = setup();
		await startManual(runtime);
		await runtime.event("session_compact_failed", { reason: "manual", willRetry: false, preparation: { tokensBefore: 256_000 } });
		expect(runtime.sent).toHaveLength(0);
		expect(runtime.audits.filter((entry) => entry.data.phase === "error" && entry.data.origin === "manual-tool")).toHaveLength(1);
	});

	test("failed native threshold is audited without cancelling Pi or scheduling a retry", async () => {
		const runtime = setup();
		expect(await runtime.event("session_before_compact", { reason: "threshold", willRetry: false, preparation: { tokensBefore: 256_000 } })).toBeUndefined();
		await runtime.event("session_compact_failed", { reason: "threshold", willRetry: false, preparation: { tokensBefore: 256_000 } });
		expect(runtime.compactOptions).toHaveLength(0);
		expect(runtime.sent).toHaveLength(0);
		expect(runtime.audits.filter((entry) => entry.data.origin === "external-unattributed" && entry.data.reason === "threshold").map((entry) => entry.data.phase)).toEqual(["contained", "error"]);
	});

	test("a native threshold cancels only a pending manual checkpoint and never creates a second compact", async () => {
		const runtime = setup();
		await runtime.tool.execute("call", params, undefined, undefined, runtime.ctx);
		await runtime.event("session_before_compact", { reason: "threshold", willRetry: false });
		await runtime.event("session_compact", { reason: "threshold", willRetry: false, compactionEntry: { tokensBefore: 256_000 } });
		await runtime.settle();
		expect(runtime.compactOptions).toHaveLength(0);
		expect(runtime.sent).toHaveLength(0);
		expect(runtime.audits.filter((entry) => entry.data.origin === "manual-tool" && entry.data.phase === "cancel")).toHaveLength(1);
	});
});

test("keeps append usage and provider/model in the audit payload", () => {
	const usage = { input: 20, output: 10, cacheRead: 100, cacheWrite: 0, totalTokens: 130, cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0, total: 0.03 } };
	const success = { kind: "success" as const, compaction: { summary: "summary", firstKeptEntryId: "tail", tokensBefore: 1, usage, details: { read: new Set(), edited: new Set(), created: new Set() } } };
	expect(appendUsageForAudit(success)).toEqual(usage);
	expect(appendUsageForAudit({ kind: "cancel", reason: "request-failed", usage })).toEqual(usage);
	expect(appendAuditPayload({ ...success, repairAttempts: 1 }, 123, { provider: "openai", id: "gpt-5.6-sol" })).toMatchObject({ provider: "openai", model: "gpt-5.6-sol", durationMs: 123, repairAttempts: 1, usage });
});

test("persists only the bounded mismatch diagnostic on the existing append audit", () => {
	const payloadMismatch = { fields: ["input" as const], inputLengths: [2, 3] as [number, number], firstInputMismatch: 1, inputItemFields: ["content"] };
	expect(appendAuditPayload({ kind: "fallback", reason: "payload-mismatch", payloadMismatch }, 29, { provider: "openai", id: "q12-fixture" })).toMatchObject({ reason: "payload-mismatch", payloadMismatch });
	expect(appendAuditPayload({ kind: "fallback", reason: "snapshot-unavailable" }, 0, undefined)).not.toHaveProperty("payloadMismatch");
});

test("writes a durable compact card after session_compact and never before it", async () => {
	const runtime = setup({ language: "en" });
	await runtime.event("session_before_compact", { reason: "threshold", willRetry: false });
	expect(runtime.audits.filter((entry) => entry.type === "context-compaction-card")).toHaveLength(0);
	await runtime.event("session_compact", { reason: "threshold", willRetry: false, compactionEntry: { tokensBefore: 258_796, summary: "x".repeat(400), usage: { input: 250_000, cacheRead: 0, cost: { total: 0.04 } } } });
	const cards = runtime.audits.filter((entry) => entry.type === "context-compaction-card");
	expect(cards).toHaveLength(1);
	expect(cards[0].data).toMatchObject({ version: 2, kind: "standard", trigger: "threshold", tokensBefore: 258_796, summaryTokens: 100 });
	expect(JSON.stringify(cards[0].data)).not.toContain("xxxx");
	const rendered = runtime.renderers.get("context-compaction-card")({ data: cards[0].data }, { expanded: false }, { fg: (_c: string, text: string) => text });
	expect(rendered.render(200)[0]).toContain("standard compact");
	expect(runtime.notices.filter((notice) => notice.text.includes("append compact"))).toHaveLength(0);
});

test("does not claim append success before Pi confirms session_compact", async () => {
    const branch = [{ id: "a", type: "message", message: { role: "user", content: "Начать работу" } }, { id: "b", type: "message", message: { role: "assistant", content: "Проверка выполнена." } }, { id: "c", type: "message", message: { role: "user", content: "Новый хвост." } }];
    const runtime = setup({ language: "ru", appendCompaction: true, branch });
    const user = branch[0].message, progress = branch[1].message, tail = branch[2].message;
    const payload = { model: runtime.ctx.model.id, input: [{ role: "developer", content: "Original system" }, { role: "user", content: user.content }, { role: "assistant", content: progress.content }, { role: "user", content: tail.content }], tools: [], prompt_cache_key: "fixture-session" };
    runtime.ctx.modelRegistry.streamSimple = (_model: any, _context: any, options: any) => ({ result: async () => { await options.onPayload({ ...payload, input: [...payload.input, { role: "user", content: "candidate" }] }); return { role: "assistant", content: [{ type: "text", text: JSON.stringify({ history: "## Цель\nСохранить замысел.", turnPrefix: "" }) }], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 115, cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0, total: 0.03 } } }; } });
    await runtime.event("context_with_system", { messages: [{ role: "system", content: "Original system", timestamp: 0 }, user, progress, tail] });
    await runtime.event("before_provider_request", { payload });
    const preparation = { messagesToSummarize: [user, progress], turnPrefixMessages: [], isSplitTurn: false, firstKeptEntryId: "c", tokensBefore: 100, fileOps: { read: new Set(), edited: new Set(), created: new Set() }, settings: { reserveTokens: 4096, keepRecentTokens: 1024 } };
    await runtime.event("session_before_compact", { reason: "threshold", signal: new AbortController().signal, branchEntries: runtime.getBranch(), preparation, willRetry: false });
    expect(runtime.audits.filter((entry) => entry.type === "context-compaction-append" && entry.data.outcome === "success")).toHaveLength(0);
    await runtime.event("session_compact_failed", { reason: "threshold", willRetry: false, preparation });
    expect(runtime.audits.find((entry) => entry.type === "context-compaction-append")?.data).toMatchObject({ outcome: "unknown", reason: "apply-failed", cacheStatus: "hit" });
});

describe("session-local context modes", () => {
	test("economy, long-once, long-chat and off only change public model metadata", async () => {
		const runtime = setup({ thinkingLevel: "max", modelSwitchThinkingLevel: "low" });
		await runtime.command("long-once", runtime.ctx);
		expect(runtime.ctx.model.contextWindow).toBe(372_000);
		expect(runtime.thinkingLevel).toBe("max");
		await runtime.command("long-chat", runtime.ctx);
		expect(runtime.ctx.model.contextWindow).toBe(600_000);
		await runtime.command("off", runtime.ctx);
		expect(runtime.ctx.model.contextWindow).toBe(600_000);
		await runtime.command("economy", runtime.ctx);
		expect(runtime.ctx.model.contextWindow).toBe(272_000);
	});

	test("long modes use a session override for any provider with an exact long pricing tier", async () => {
		const runtime = setup({ modelProvider: "custom", registryContextWindow: 272_000, registryTiers: [{ inputTokensAbove: 272_000 }] });
		await runtime.command("long-chat", runtime.ctx);
		expect(runtime.ctx.model.contextWindow).toBe(600_000);
		expect(runtime.notices.some((entry) => entry.text.includes("source=session-override"))).toBe(true);
	});

	test("long modes stay conservative without an exact long pricing tier", async () => {
		const runtime = setup({ modelProvider: "custom", registryContextWindow: 272_000, registryTiers: [] });
		await runtime.command("long-chat", runtime.ctx);
		expect(runtime.ctx.model.contextWindow).toBe(272_000);
		expect(runtime.notices.some((entry) => entry.text.includes("нет доступного long-tier"))).toBe(true);
	});

	test("declared capability without a long pricing tier stays conservative", async () => {
		const runtime = setup({ modelProvider: "custom", registryContextWindow: 600_000, registryTiers: [] });
		await runtime.command("long-chat", runtime.ctx);
		expect(runtime.ctx.model.contextWindow).toBe(272_000);
		expect(runtime.notices.some((entry) => entry.text.includes("нет доступного long-tier"))).toBe(true);
	});

	test("long-once returns to economy only after a successful native compact", async () => {
		const runtime = setup();
		await runtime.command("long-once", runtime.ctx);
		expect(runtime.ctx.model.contextWindow).toBe(372_000);
		await runtime.event("session_compact_failed", { reason: "threshold", willRetry: false });
		expect(runtime.ctx.model.contextWindow).toBe(372_000);
		await runtime.event("session_compact", { reason: "threshold", willRetry: false, compactionEntry: { tokensBefore: 356_000 } });
		expect(runtime.ctx.model.contextWindow).toBe(272_000);
		expect(runtime.audits.some((entry) => entry.type === "context-compaction-mode" && entry.data.mode === "economy")).toBe(true);
	});

	test("long-chat survives native compaction and off retains native Pi policy", async () => {
		const runtime = setup();
		await runtime.command("long-chat", runtime.ctx);
		await runtime.event("session_compact", { reason: "overflow", willRetry: true, compactionEntry: { tokensBefore: 590_000 } });
		expect(runtime.ctx.model.contextWindow).toBe(600_000);
		await runtime.command("off", runtime.ctx);
		expect(await runtime.event("session_before_compact", { reason: "threshold", willRetry: false })).toBeUndefined();
		expect(runtime.compactOptions).toHaveLength(0);
	});

	test("setModel failure falls back to economy and reports the limitation", async () => {
		const runtime = setup({ setModelResult: false });
		await runtime.command("long-chat", runtime.ctx);
		expect(runtime.ctx.model.contextWindow).toBe(272_000);
		expect(runtime.notices.some((entry) => entry.level === "error")).toBe(true);
		expect(runtime.audits.some((entry) => entry.type === "context-compaction-mode" && entry.data.mode === "economy")).toBe(true);
	});

	test("restores the previous model after a partial setModel rejection", async () => {
		const runtime = setup({ setModelResults: ["reject", true], emitModelSelect: true });
		await runtime.command("long-chat", runtime.ctx);
		expect(runtime.ctx.model.contextWindow).toBe(272_000);
		expect(runtime.setModelCalls.map((model) => model.contextWindow)).toEqual([600_000, 272_000]);
		expect(runtime.notices.some((entry) => entry.level === "error")).toBe(true);
	});

	test("retains the long mode when an economy transition fails after partial mutation", async () => {
		const runtime = setup({ setModelResults: [true, "reject", true], emitModelSelect: true });
		await runtime.command("long-chat", runtime.ctx);
		await runtime.command("economy", runtime.ctx);
		expect(runtime.ctx.model.contextWindow).toBe(600_000);
		expect(runtime.notices.some((entry) => entry.text.includes("сохранён прежний режим"))).toBe(true);
		expect(runtime.notices.some((entry) => entry.text.includes("context: long-chat") && entry.text.includes("600000"))).toBe(true);
	});

	test("keeps fallback visible after a repeated economy failure", async () => {
		const runtime = setup({ setModelResults: ["reject", false, "reject", true], emitModelSelect: true });
		await runtime.command("long-chat", runtime.ctx);
		await runtime.command("economy", runtime.ctx);
		expect(runtime.ctx.model.contextWindow).toBe(600_000);
		expect(runtime.notices.some((entry) => entry.text.includes("context: economy") && entry.text.includes("600000") && entry.text.includes("source=fallback"))).toBe(true);
	});
});
