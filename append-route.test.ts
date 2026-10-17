import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageEventStream, createInitialSystemMessage } from "@earendil-works/pi-ai";
import { streamSimple as convertResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { APPEND_CANDIDATE_START, APPEND_TURN_SEPARATOR, preservesPayloadPrefix, withoutTrailingEffort } from "./append-compaction.js";
import extension from "./index.js";

const usage = { input: 2000, output: 10, cacheRead: 1800, cacheWrite: 0, totalTokens: 3810, cost: { input: 0.002, output: 0.001, cacheRead: 0.0002, cacheWrite: 0, total: 0.0032 } };
const history = "## Цель\nСохранить локальный JSON ради автономной работы без сети.\n## Следующие шаги\nРешение пользователя: проверить импорт.";
/** Request kinds in order, with the history and turn-prefix calls of one standard summary counted once. */
const kinds = (f: { payloads: { kind: string }[] }): string[] => f.payloads.map((p) => p.kind).filter((kind, index, all) => kind !== "standard" || all[index - 1] !== "standard");
const prefix = "## Исходный запрос\nПроверить экспорт.";
/** Standard summaries send the serialized transcript in one user message; working requests replay the conversation item by item. */
const kindOf = (payload: any): "append" | "work" | "standard" => {
	if (JSON.stringify(payload?.input ?? []).includes(APPEND_CANDIDATE_START)) return "append";
	return (payload?.input?.length ?? 0) <= 2 && /<conversation>|# Conversation|context summarization/.test(JSON.stringify(payload?.input?.at(-1) ?? "")) ? "standard" : "work";
};

type Options = { tui?: boolean; append?: boolean; promptCache?: Record<string, number>; unstableTools?: boolean; appendReply?: string[] };

/** Real SDK and Responses conversion; every provider response is synthetic and the network is forbidden. */
async function setup(options: Options = {}) {
	const parent = join(import.meta.dirname!, ".runtime"); mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, "route-test-"));
	const profile = join(root, "profile"); mkdirSync(profile);
	writeFileSync(join(profile, "settings.json"), JSON.stringify({ contextCompaction: { appendCompaction: options.append ?? true, summaryLanguage: "ru" } }));
	const payloads: { kind: ReturnType<typeof kindOf>; payload: any }[] = [];
	let network = 0, toolsCounter = 0, appendReplies = 0;
	const runtime = await ModelRuntime.create({ authPath: join(profile, "auth.json"), modelsPath: join(profile, "models.json") });
	runtime.registerProvider("route-fixture", {
		api: "openai-responses", apiKey: "offline-fixture", baseUrl: "https://fixture.invalid/v1",
		models: [{ id: "route-model", name: "Synthetic route fixture", api: "openai-responses", reasoning: true, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 8192, compat: { supportsMidConvoSystemMessages: true }, ...(options.promptCache ? { promptCache: options.promptCache } : {}) } as any],
		streamSimple(model, context, streamOptions) {
			const events = new AssistantMessageEventStream();
			void (async () => {
				let final: any;
				await convertResponses(model, context, { ...streamOptions, apiKey: "offline-fixture", transport: "sse", maxRetries: 0,
					onPayload: async (payload) => { final = (await streamOptions?.onPayload?.(payload, model)) ?? payload; throw new Error("SYNTHETIC_PROVIDER_CAPTURE"); },
					fetch: async () => { network++; throw new Error("NETWORK_FORBIDDEN"); },
				}).result();
				const kind = kindOf(final);
				if (final) payloads.push({ kind, payload: final });
				// Pi cuts this fixture inside the last turn, so a valid summary also carries the turn prefix.
				const split = JSON.stringify(final?.input?.at(-1) ?? "").includes(APPEND_TURN_SEPARATOR);
				const text = kind === "append" ? options.appendReply?.[appendReplies++] ?? (split ? `${history}\n${APPEND_TURN_SEPARATOR}\n${prefix}` : history) : kind === "standard" ? `${history}\n${prefix}` : "Импорт проверен, продолжаю.";
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: final ? "stop" : "error", errorMessage: final ? undefined : "payload refused", usage, timestamp: Date.now(), content: final ? [{ type: "text", text }] : [] };
				if (!final) events.push({ type: "error", reason: "error", error: message });
				else { events.push({ type: "start", partial: { ...message, content: [] } }); events.push({ type: "done", reason: "stop", message }); }
				events.end();
			})();
			return events;
		},
	});
	const model = runtime.getModel("route-fixture", "route-model")!;
	const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 100 }, retry: { enabled: false, maxRetries: 0 }, cacheWarming: "off", transport: "sse" } as any);
	const manager = SessionManager.create(root, join(root, "sessions"));
	manager.appendMessage(createInitialSystemMessage("Follow the current task.", [{ name: "read", description: "Read a synthetic fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }])!);
	manager.appendMessage({ role: "user", content: "Решение пользователя: локальный JSON для автономной работы. " + "Обсуждаем варианты хранения. ".repeat(300), timestamp: Date.now() - 10_000 });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Локальный JSON выбран ради автономной работы." }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage, timestamp: Date.now() - 9000 });
	manager.appendMessage({ role: "user", content: "Опиши формат файла. " + "Поля и версии формата. ".repeat(200), timestamp: Date.now() - 8000 });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Формат описан. ".repeat(100) }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage, timestamp: Date.now() - 7000 });
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: profile, settingsManager: settings, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, systemPrompt: "Follow the current task.", extensionFactories: [
		// Another extension shapes every request after the SDK, as pi-web-search does.
		(pi) => pi.on("before_provider_request", (event) => {
			const payload = event.payload as any;
			const extra = options.unstableTools ? [{ type: "function", name: `unstable_${toolsCounter++}`, parameters: { type: "object", properties: {} } }] : [];
			return { ...payload, tools: [...(payload.tools ?? []), { type: "web_search" }, ...extra], metadata: { shapedBy: "fixture" } };
		}),
		(pi) => { const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = profile; try { extension(pi); } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; } },
	] });
	await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({ cwd: root, agentDir: profile, modelRuntime: runtime, model, thinkingLevel: "medium", settingsManager: settings, sessionManager: manager, resourceLoader: loader, tools: ["read"], customTools: [{ name: "read", label: "read", description: "Read synthetic fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as any, execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }) }] });
	const notices: string[] = [], footer: string[] = [], working: (string | undefined)[] = [];
	const noop = () => undefined;
	const uiContext: any = { notify: (message: string) => notices.push(message), setStatus: (statusKey: string, value?: string) => { if (statusKey === "context-compaction") footer.push(value ?? ""); }, setWorkingMessage: (message?: string) => working.push(message), setWorkingVisible: noop, setWidget: noop, setFooter: noop, setHeader: noop, setTitle: noop, select: noop, confirm: noop, input: noop, custom: noop, setEditorText: noop, getEditorText: () => "", theme: undefined };
	const errors: unknown[] = [];
	await session.bindExtensions({ uiContext, ...(options.tui ? { mode: "tui" } : {}), onError: (error: unknown) => errors.push(error) } as any);
	const custom = (type: string) => manager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === type).map((entry: any) => entry.data);
	return { session, manager, payloads, notices, footer, working, custom, get network() { return network; },
		async compact() { try { await session.compact(); } catch (error) { expect(String(error)).toContain("cancelled"); } },
		async close() { expect(errors).toEqual([]); await session.abort(); session.dispose(); rmSync(root, { recursive: true, force: true }); },
	};
}

test("append continues the last sent working request, including payload changes made by other extensions", async () => {
	const f = await setup();
	try {
		await f.session.prompt("Проверь импорт.");
		await f.session.prompt("Теперь проверь экспорт.");
		await f.compact();
		const work = f.payloads.filter((p) => p.kind === "work"), append = f.payloads.filter((p) => p.kind === "append");
		expect(work).toHaveLength(2); expect(append).toHaveLength(1);
		// The prefix is the second, longer request, as sent after every payload hook, not the first or an unhooked rebuild.
		expect(preservesPayloadPrefix(withoutTrailingEffort(work[1].payload), append[0].payload)).toBe(true);
		expect(append[0].payload.input.length).toBeGreaterThan(work[1].payload.input.length);
		expect(append[0].payload.tools).toEqual(work[1].payload.tools);
		expect(append[0].payload.tool_choice).toBe("none");
		expect(append[0].payload.prompt_cache_key).toBe(work[1].payload.prompt_cache_key);
		const audit = f.custom("context-compaction-append").at(-1);
		expect(audit).toMatchObject({ version: 3, outcome: "success", cacheStatus: "hit", cacheCheck: { captured: true, warmed: true, ttlSource: "default", route: { session: true, provider: true, model: true, baseUrl: true }, lastRequest: { cacheRead: 1800 } } });
		expect(audit.appendAttempt[0]).toMatchObject({ attempt: 1, phase: "apply", usage: { cacheRead: 1800, cost: 0.0032 } });
		expect(audit.appendAttempt[0].durationMs).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(audit)).not.toContain(work[1].payload.prompt_cache_key);
		expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		expect(f.custom("context-compaction-card").at(-1)).toMatchObject({ kind: "append", appendCacheStatus: "hit" });
		expect(f.network).toBe(0);
	} finally { await f.close(); }
});

test("without a request sent by this process the compact is standard and no append is paid for", async () => {
	const f = await setup();
	try {
		await f.compact();
		expect(kinds(f)).toEqual(["standard"]);
		expect(f.custom("context-compaction-append").at(-1)).toMatchObject({ outcome: "fallback", reason: "no-sent-request", cacheStatus: "not-attempted", cacheCheck: { captured: false } });
		expect(f.custom("context-compaction-card").at(-1)).toMatchObject({ kind: "standard", fallbackReason: "no-sent-request" });
	} finally { await f.close(); }
});

test("an expired cache lifetime from the model sends the standard summary without an append attempt", async () => {
	const f = await setup({ promptCache: { short: 5 } });
	try {
		await f.session.prompt("Проверь импорт.");
		await f.compact();
		expect(kinds(f)).toEqual(["work", "standard"]);
		expect(f.custom("context-compaction-append").at(-1)).toMatchObject({ outcome: "fallback", reason: "cache-expired", cacheCheck: { ttlMs: 5000, ttlSource: "model", warmed: true } });
	} finally { await f.close(); }
});

test("a payload that diverges after the shared hooks never reaches the provider as append", async () => {
	const f = await setup({ unstableTools: true });
	try {
		await f.session.prompt("Проверь импорт.");
		await f.compact();
		expect(kinds(f)).toEqual(["work", "standard"]);
		expect(f.custom("context-compaction-append").at(-1)).toMatchObject({ outcome: "fallback", reason: "payload-mismatch", payloadMismatch: { fields: ["tools"] } });
	} finally { await f.close(); }
});

test("a rejected reply is kept privately in the session and never reaches the model context", async () => {
	const f = await setup({ appendReply: ["нет заголовка", "нет заголовка снова"] });
	try {
		await f.session.prompt("Проверь импорт.");
		await f.compact();
		expect(kinds(f)).toEqual(["work", "append", "append", "standard"]);
		const replies = f.custom("context-compaction-append-reply");
		expect(replies).toMatchObject([{ attempt: 1, guard: "history-heading", text: "нет заголовка" }, { attempt: 2, guard: "history-heading", text: "нет заголовка снова" }]);
		expect(f.custom("context-compaction-append").at(-1)).toMatchObject({ outcome: "cancel", reason: "invalid-result", validationGuard: "history-heading" });
		expect(JSON.stringify(f.custom("context-compaction-append"))).not.toContain("нет заголовка");
		expect(JSON.stringify(f.manager.buildSessionProjection().messages)).not.toContain("нет заголовка");
	} finally { await f.close(); }
});

test("/context append on works for this window only, even when the profile disables append", async () => {
	const f = await setup({ append: false });
	try {
		await f.session.prompt("Проверь импорт.");
		await f.compact();
		expect(f.custom("context-compaction-append").at(-1)).toMatchObject({ reason: "disabled" });
		await f.session.prompt("/context append on");
		expect(f.footer.at(-1)).toContain("append on*");
		await f.session.prompt("Проверь экспорт. " + "Подробности экспорта. ".repeat(300));
		await f.compact();
		expect(f.custom("context-compaction-append").at(-1)).toMatchObject({ outcome: "success" });
		expect(f.payloads.filter((p) => p.kind === "append")).toHaveLength(1);
		await f.session.prompt("/context append status");
		expect(f.notices.at(-1)).toContain("только это окно");
	} finally { await f.close(); }
});

test("during append the working line shows the compact, not the generation of the request it reuses", async () => {
	const f = await setup({ tui: true });
	try {
		await f.session.prompt("Проверь импорт.");
		const before = f.working.length;
		await f.compact();
		const during = f.working.slice(before);
		expect(f.custom("context-compaction-append").at(-1)).toMatchObject({ outcome: "success" });
		const shown = during.filter((message) => message !== undefined);
		// The append request reuses the working payload hooks, yet only the compact label is shown, and the line is released after.
		expect(shown).toEqual(["Compact: append по кэшу последнего запроса · compact длится 0:00"]);
		expect(during.at(-1)).toBeUndefined();
	} finally { await f.close(); }
});
