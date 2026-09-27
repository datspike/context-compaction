import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.js";

const params = { mainObjective: "Продолжить цель", completedCheckpoint: "Завершён этап", continuationTarget: "Сделать следующий шаг" };
let sequence = 0;

function setup(options: { branch?: any[]; sessionId?: string; setModelResult?: boolean; thinkingLevel?: string; modelSwitchThinkingLevel?: string; language?: "ru" | "en" } = {}) {
	const handlers = new Map<string, (...args: any[]) => any>();
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
	const notices: Array<{ text: string; level: string }> = [];
	const sessionManager = { getEntries: () => branch, getBranch: () => branch, getSessionId: () => sessionId, getSessionFile: () => undefined };
	const ctx: any = {
		cwd: "/tmp/context-compaction-test",
		hasUI: true,
		ui: { notify(text: string, level: string) { notices.push({ text, level }); }, setStatus() {} },
		model: { provider: "openai", id: "gpt-5.6-sol", contextWindow: 272_000 },
		modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt-5.6-sol", contextWindow: 600_000 }] },
		sessionManager,
		getContextUsage: () => ({ tokens: 1_000, contextWindow: ctx.model.contextWindow, percent: 1 }),
		isIdle: () => idle,
		compact(value: any) { compactOptions.push(value); },
	};
	const pi: any = {
		registerTool(value: any) { tool = value; },
		registerCommand(_name: string, value: any) { command = value.handler; },
		on(name: string, value: any) { handlers.set(name, value); },
		appendEntry(type: string, data: any) {
			audits.push({ type, data });
			branch = [...branch, { id: `append-${audits.length}`, type: "custom", customType: type, data }];
		},
		setModel(next: any) {
			if (options.setModelResult === false) return Promise.resolve(false);
			ctx.model = next;
			if (options.modelSwitchThinkingLevel) thinkingLevel = options.modelSwitchThinkingLevel;
			return Promise.resolve(true);
		},
		getThinkingLevel() { return thinkingLevel; },
		setThinkingLevel(value: string) { thinkingLevel = value; },
		sendUserMessage(text: string) { if (!compactionInProgress) sent.push(text); },
	};
	const agentDir = mkdtempSync(join(tmpdir(), "context-compaction-test-profile-"));
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ contextCompaction: { summaryLanguage: options.language ?? "ru" } }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		extension(pi);
	} finally {
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
	return {
		ctx, tool, command, audits, compactOptions, sent, notices,
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

	test("English compact delegates manual, threshold and overflow summaries to Pi", async () => {
		const runtime = setup({ language: "en" });
		let customCalls = 0;
		runtime.ctx.modelRegistry.complete = () => { customCalls++; throw new Error("Custom summarizer must not run in English mode"); };
		expect(runtime.hasEvent("session_before_tree")).toBe(false);
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
});
