import { MAX_COMPACT_PAYLOAD_CHARS } from "./compact-budget.js";
import { NativeAppend } from "./native-append.js";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageEventStream, createInitialSystemMessage } from "@earendil-works/pi-ai";
import { streamSimple as convertResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "./index.js";

const usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const history = "## Цель\nСохранить локальный JSON ради автономной работы без сети.\n## Следующие шаги\nРешение пользователя: проверить импорт и экспорт Linux.";
type Scenario = "success" | "split-turn" | "invalid-json" | "tail-leak" | "tool-calls" | "aborted" | "late-mutator" | "checkpoint" | "threshold" | "overflow" | "apply-rejected" | "late-context" | "late-envelope" | "model-switch" | "orphan" | "late-include" | "late-tools" | "queue-rejected" | "mid-convo-effort" | "late-effort" | "unexpected-tail" | "duplicate-effort" | "provider-hook-throw";

async function until(predicate: () => boolean, description: string) {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Real SDK and Responses conversion; all provider responses are synthetic and network is forbidden. */
async function setup(mode: Scenario | `${"manual" | "checkpoint" | "threshold" | "overflow"}-provider-error` = "success", nativeFailure?: "invalid-json" | "tail-leak" | "tool-calls" | "cancel-standard" | "apply-rejected" | "transport-error" | "drop-native" | "mutate-native" | "mutate-tail", budgetCase?: "large" | "wrong-route" | "small" | "opaque" | "serialized" | "late-serialized") {
	const providerError = mode.endsWith("-provider-error");
	const scenario = (providerError ? mode.replace("-provider-error", "").replace("manual", "success") : mode) as Scenario;
	const parent = join(import.meta.dirname!, ".runtime"); mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, "native-test-"));
	const profile = join(root, "profile"); mkdirSync(profile);
	const large = budgetCase === "large" || budgetCase === "wrong-route" || budgetCase === "small" || budgetCase === "serialized" || budgetCase === "late-serialized";
	writeFileSync(join(profile, "settings.json"), JSON.stringify({ contextCompaction: { appendCompaction: true, summaryLanguage: "ru", ...((budgetCase === "large" || budgetCase === "wrong-route" || budgetCase === "serialized" || budgetCase === "late-serialized") ? { compactCapabilities: [{ provider: "native-fixture", model: "native-model", baseUrl: budgetCase === "wrong-route" ? "https://wrong.invalid/v1" : "https://fixture.invalid/v1", contextWindow: 1_048_576, source: "offline route fixture" }] } : {}) } }));
	const payloads: any[] = [];
	let toolExecutions = 0, beforeStarts = 0, contextTransforms = 0, payloadTransforms = 0, networkCalls = 0, ordinaryResponses = 0;
	const dispatchModels: { window: number; transport: unknown }[] = [];
	let droppedService = false;
	let standardFailures = 0;
	let standardExpectedRequests = 1;
	let latePayloadChars = 0;
	let lastUserPrompt = "Проверить импорт.";
	const runtime = await ModelRuntime.create({ authPath: join(profile, "auth.json"), modelsPath: join(profile, "models.json") });
	runtime.registerProvider("native-fixture", {
		api: "openai-responses", apiKey: "offline-fixture", baseUrl: "https://fixture.invalid/v1",
		models: [{ id: "native-model", name: "Synthetic native fixture", api: "openai-responses", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: large ? 272_000 : 100_000, maxTokens: large ? 128_000 : 8192, compat: { supportsMidConvoSystemMessages: true, supportsMidConvoEffort: ["mid-convo-effort", "late-effort", "unexpected-tail", "duplicate-effort"].includes(scenario) } }],
		streamSimple(model, context, options) {
			dispatchModels.push({ window: model.contextWindow, transport: options?.transport });
			const events = new AssistantMessageEventStream();
			void (async () => {
				let final: any;
				await convertResponses(model, context, { ...options, apiKey: "offline-fixture", transport: "sse", maxRetries: 0,
					onPayload: async (payload) => { final = (await options?.onPayload?.(payload, model)) ?? payload; if (nativeFailure === "cancel-standard" && ordinaryResponses === 1 && final?.text?.format?.name !== "compact_result") void session.abort(); throw new Error("SYNTHETIC_PROVIDER_CAPTURE"); },
					fetch: async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN"); },
				}).result();
				if (final && !options?.signal?.aborted) payloads.push(final);
				const native = final?.text?.format?.name === "compact_result";
				const task = (final?.input?.findLast((item: any) => item.role === "user")?.content ?? []).map((part: any) => part.text ?? "").join("\n");
				const split = native && !task.includes("РАННЯЯ ЧАСТЬ ХОДА: (нет сообщений)");
				const prefixSummary = "## Исходный запрос\n" + lastUserPrompt + "\n## Прогресс на текущий момент\nПроверка запланирована.\n## Контекст для продолжения\nНе считать импорт завершённым.";
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage, timestamp: Date.now(), content: [{ type: "text", text: native ? JSON.stringify({ history, turnPrefix: split ? prefixSummary : "" }) : task.includes("Это ранняя часть пользовательского хода, а его недавняя часть сохранена отдельно.") ? prefixSummary : history }] };
				if (!native && final) {
					ordinaryResponses++;
					if (ordinaryResponses === 1 && scenario === "threshold") message.usage = { ...usage, input: 70_050, totalTokens: 70_060 };
					if (ordinaryResponses === 1 && scenario === "overflow") { message.stopReason = "error"; message.errorMessage = "maximum context length exceeded"; }
					if (ordinaryResponses === 1 && scenario === "checkpoint") { message.content = [{ type: "toolCall", id: "checkpoint", name: "checkpoint_compact_continue", arguments: { mainObjective: "Сохранить автономное хранение", completedCheckpoint: "Выбран локальный JSON", continuationTarget: "Проверить импорт и экспорт Linux" } }]; message.stopReason = "toolUse"; }
				}
				if (native && providerError) { message.content = []; message.stopReason = "error"; message.errorMessage = nativeFailure === "transport-error" ? "OpenAI Responses stream ended before a terminal response event" : "SYNTHETIC_PROVIDER_ERROR"; if (nativeFailure === "transport-error") message.usage = { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }; }
				if (native && (scenario === "invalid-json" || nativeFailure === "invalid-json" || nativeFailure === "cancel-standard" || nativeFailure === "apply-rejected")) message.content[0].text = "{broken";
				if (native && (scenario === "tail-leak" || nativeFailure === "tail-leak")) message.content[0].text = JSON.stringify({ history: "## Цель\nСвежий код TAIL_73918.", turnPrefix: "" });
				if (native && (scenario === "tool-calls" || nativeFailure === "tool-calls")) { message.content = [{ type: "toolCall", id: "first", name: "read", arguments: { path: "/dev/null" } }, { type: "toolCall", id: "second", name: "read", arguments: { path: "/dev/null" } }]; message.stopReason = "toolUse"; }
				if ((native && scenario === "aborted") || options?.signal?.aborted || !final) { message.content = []; message.stopReason = "aborted"; }
				if (message.stopReason === "aborted") events.push({ type: "error", reason: "aborted", error: message });
				else if (message.stopReason === "error") events.push({ type: "error", reason: "error", error: message });
				else events.push({ type: "done", reason: message.stopReason, message });
				events.end();
			})().catch((error) => {
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "error", errorMessage: String(error), usage, timestamp: Date.now() };
				events.push({ type: "error", reason: "error", error: message }); events.end();
			});
			return events;
		},
	});
	const model = runtime.getModel("native-fixture", "native-model")!;
	expect(model).toBeDefined();
	const settings = SettingsManager.inMemory({ compaction: { enabled: scenario === "threshold" || scenario === "overflow", reserveTokens: scenario === "threshold" ? 30_000 : 4096, keepRecentTokens: 100 }, retry: { enabled: false, maxRetries: 0 }, cacheWarming: "off", transport: "sse" } as any);
	const manager = SessionManager.create(root, join(root, "sessions"));
	manager.appendMessage(createInitialSystemMessage("Follow the current service task.", [{ name: "read", description: "Read a synthetic fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }])!);
	manager.appendMessage({ role: "user", content: "Решение пользователя: локальный JSON для автономной работы; нужен импорт и экспорт Linux. " + (budgetCase === "serialized" ? "\0".repeat(Math.ceil(MAX_COMPACT_PAYLOAD_CHARS / 6) + 4096) : "Обсуждаем варианты хранения. ".repeat(300)), timestamp: Date.now() });
	if (scenario === "split-turn") manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Проверка только запланирована. ".repeat(200) }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage, timestamp: Date.now() });
	if (scenario !== "split-turn") manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Локальный JSON выбран ради автономной работы." }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: large ? { ...usage, input: 255_617, totalTokens: 255_627 } : usage, timestamp: Date.now() });
	const tailText = "Импорт не проверен. Хвостовой маркер TAIL_73918. ".repeat(100);
	const tailId = scenario === "split-turn" ? manager.appendMessage({ role: "assistant", content: [{ type: "text", text: tailText }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage, timestamp: Date.now() }) : manager.appendCustomMessageEntry("fixture-tail", tailText, false);
	const oldTail = JSON.stringify(manager.getEntry(tailId));
	let orphan: { serviceId: string; responseId: string; original: string } | undefined;
	if (scenario === "orphan") {
		const id = "ef70cc98-d84c-4875-a3f1-ef6ef4df25b2";
		manager.appendCustomEntry("context-compaction-native", { version: 1, id, phase: "queued", sessionId: manager.getSessionId() });
		const serviceId = manager.appendMessage({ role: "user", content: `[context-compaction-native:${id}] orphan`, timestamp: Date.now() });
		const responseId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ORPHAN_PRIVATE_RESPONSE" }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage, timestamp: Date.now() });
		orphan = { serviceId, responseId, original: JSON.stringify(manager.getEntry(serviceId)) };
	}
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: profile, settingsManager: settings, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, systemPrompt: "Follow the current service task.", extensionFactories: [
		(pi) => {
			pi.on("session_compact_failed", () => { standardFailures++; });
			// SDK cut selection may split a turn; answer its distinct history and prefix requests.
			pi.on("session_before_compact", (event) => { if (event.willRetry) standardExpectedRequests = event.preparation.isSplitTurn && event.preparation.turnPrefixMessages.length > 0 ? Number(event.preparation.messagesToSummarize.length > 0) + 1 : 1; });
			pi.on("before_agent_start", (event: any) => { if (event.messageType === "user" && !event.prompt.startsWith("[context-compaction-native:")) lastUserPrompt = event.prompt; beforeStarts++; event.systemPromptOptions.appendSystemPrompt = ["CURRENT_PROMPT_TRANSFORM"]; });
			pi.on("context_with_system", () => { contextTransforms++; });
			pi.on("before_provider_request", (event) => {
				payloadTransforms++;
				const payload = event.payload as any;
				const extra = scenario === "unexpected-tail" ? { role: "user", content: [{ type: "input_text", text: "UNEXPECTED_TASK" }] } : scenario === "duplicate-effort" ? { type: "configuration_update", reasoning: { effort: "medium" } } : undefined;
				return { ...payload, ...(extra ? { input: [...payload.input, extra] } : budgetCase === "opaque" ? { input: [{ type: "reasoning", id: "opaque-fixture", encrypted_content: "x".repeat(703_320) }, ...payload.input] } : {}), metadata: { fixtureTransform: "CURRENT_PAYLOAD_TRANSFORM" } };
			});
		},
		(pi) => { const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = profile; try { extension(scenario === "queue-rejected" ? new Proxy(pi, { get(target, key) { if (key === "sendMessage") return (...args: any[]) => { if (!droppedService) { droppedService = true; return; } return Reflect.apply(target.sendMessage, target, args); }; return Reflect.get(target, key); } }) : pi); } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; } },
		...(scenario === "model-switch" ? [(pi: any) => pi.on("context_with_system", async (event: any, ctx: any) => { if (JSON.stringify(event.messages.at(-1)).includes("СЛУЖЕБНАЯ ЗАДАЧА COMPACT")) await pi.setModel({ ...ctx.model, contextWindow: 90_000 }); })] : []),
		...(scenario === "late-context" ? [(pi: any) => pi.on("context_with_system", (event: any) => ({ messages: event.messages.map((message: any) => message.role === "user" && JSON.stringify(message.content).includes("Решение пользователя:") ? { ...message, content: "Подменённая история" } : message) }))] : []),
		...(scenario === "late-envelope" ? [(pi: any) => pi.on("context_with_system", (event: any) => ({ messages: event.messages.map((message: any) => message.role === "system" ? { ...message, content: message.content + "\\nCURRENT_LATE_ENVELOPE" } : message) }))] : []),
		...((scenario === "apply-rejected" || nativeFailure === "apply-rejected" || nativeFailure === "drop-native" || nativeFailure === "mutate-native" || nativeFailure === "mutate-tail") ? [(pi: any) => pi.on("turn_end", (event: any) => ({ entries: (nativeFailure === "mutate-native" || nativeFailure === "mutate-tail") ? event.entries.map((draft: any) => draft.type === "compaction" ? { ...draft, ...(nativeFailure === "mutate-tail" ? { firstKeptEntryId: manager.getBranch().find((e: any) => e.type === "message" && e.message.role === "user")!.id } : { summary: draft.summary + "\nUNEXPECTED_BOUNDARY_CHANGE" }) } : draft) : event.entries.filter((draft: any) => draft.type !== "compaction") }))] : []),
		...(scenario === "late-effort" ? [(pi: any) => pi.on("before_provider_request", (event: any) => event.payload.text?.format?.name === "compact_result" ? { ...event.payload, input: [...event.payload.input.slice(0, -1), { type: "configuration_update", reasoning: { effort: "high" } }] } : undefined)] : []),
		...(scenario === "late-tools" ? [(pi: any) => pi.on("before_provider_request", (event: any) => ({ ...event.payload, tools: [...(event.payload.tools ?? []), { type: "web_search", external_web_access: true }] }))] : []),
		...(scenario === "late-include" ? [(pi: any) => pi.on("before_provider_request", (event: any) => ({ ...event.payload, include: [...(event.payload.include ?? []), "web_search_call.action.sources"] }))] : []),
		...(scenario === "late-mutator" ? [(pi: any) => { pi.on("before_provider_request", (event: any) => ({ ...event.payload, tool_choice: "auto" })); }] : []),
		...(budgetCase === "late-serialized" ? [(pi: any) => pi.on("before_provider_request", (event: any) => { const payload = { ...event.payload, tools: [...(event.payload.tools ?? []), { type: "function", name: "large_declaration", description: "x".repeat(MAX_COMPACT_PAYLOAD_CHARS), parameters: { type: "object", properties: {} } }] }; latePayloadChars = JSON.stringify(payload).length; return payload; })] : []),
		...(scenario === "provider-hook-throw" ? [(pi: any) => pi.on("before_provider_request", (event: any) => { if (event.payload.text?.format?.name === "compact_result") throw new Error("SYNTHETIC_BEFORE_PROVIDER_FAILURE"); })] : []),
	] });
	await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({ cwd: root, agentDir: profile, modelRuntime: runtime, model, thinkingLevel: "medium", settingsManager: settings, sessionManager: manager, resourceLoader: loader, tools: scenario === "checkpoint" ? ["read", "checkpoint_compact_continue"] : ["read"], customTools: [{ name: "read", label: "read", description: "Read synthetic fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as any, execute: async () => { toolExecutions++; return { content: [{ type: "text", text: "fixture" }], details: {} }; } }] });
	await session.bindExtensions({} as any);
	if (scenario === "checkpoint") session.setActiveToolsByName(["read", "checkpoint_compact_continue"]);
	const originalFile = readFileSync(manager.getSessionFile()!);
	const audits = () => manager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "context-compaction-append").map((e: any) => e.data);
	return { session, manager, model, runtime, tailId, oldTail, orphan, originalFile, payloads, dispatchModels, audits, get stats() { return { toolExecutions, beforeStarts, contextTransforms, payloadTransforms, networkCalls, standardFailures, standardExpectedRequests, latePayloadChars }; },
		async compact() {
			try { await session.compact(); } catch (error) { expect(String(error)).toContain("cancelled"); }
			await until(() => audits().length > 0 && session.isIdle, `native result (${scenario})`);
			if (["invalid-json", "tail-leak", "tool-calls", "late-mutator", "late-context"].includes(scenario)) await until(() => manager.getBranch().some((e) => e.type === "compaction") && session.isIdle, `standalone fallback (${scenario})`);
		},
		async close() { await session.abort(); session.dispose(); rmSync(root, { recursive: true, force: true }); },
	};
}

for (const scenario of ["success", "split-turn", "late-envelope", "late-include", "late-tools"] as const) test(`native SDK compact: ${scenario}`, async () => {
	const fixture = await setup(scenario);
	try {
		await fixture.compact();
		expect(fixture.audits().some((audit: any) => audit.outcome === "success" && audit.native === true)).toBe(true);
		expect(readFileSync(fixture.manager.getSessionFile()!).subarray(0, fixture.originalFile.length).equals(fixture.originalFile)).toBe(true);
		expect(fixture.payloads).toHaveLength(1);
		expect(fixture.payloads[0].tool_choice).toBe("none");
		expect(fixture.payloads[0].tools.some((tool: any) => tool.name === "read")).toBe(true);
		expect(fixture.payloads[0].metadata.fixtureTransform).toBe("CURRENT_PAYLOAD_TRANSFORM");
		expect(fixture.payloads[0].input[0].content).toBeDefined();
		expect(fixture.stats.beforeStarts).toBe(1);
		expect(fixture.stats.contextTransforms).toBe(1);
		expect(fixture.stats.toolExecutions).toBe(0);
		expect(fixture.stats.networkCalls).toBe(0);
		expect(JSON.stringify(fixture.manager.getEntry(fixture.tailId))).toBe(fixture.oldTail);
		const compaction: any = fixture.manager.getBranch().find((entry) => entry.type === "compaction");
		expect(compaction.firstKeptEntryId).toBe(fixture.tailId);
		expect(JSON.stringify(fixture.manager.buildSessionProjection().messages)).not.toContain("[context-compaction-native:");
	} finally { await fixture.close(); }
});

for (const scenario of ["invalid-json", "tail-leak", "tool-calls", "aborted", "late-mutator", "late-context", "model-switch"] as const) test(`native SDK failure: ${scenario}`, async () => {
	const fixture = await setup(scenario);
	try {
		await fixture.compact();
		expect(fixture.audits().every((audit: any) => audit.outcome !== "success")).toBe(true);
		expect(fixture.stats.toolExecutions).toBe(0);
		expect(fixture.stats.networkCalls).toBe(0);
		expect(JSON.stringify(fixture.manager.getEntry(fixture.tailId))).toBe(fixture.oldTail);
		expect(JSON.stringify(fixture.manager.buildSessionProjection().messages)).not.toContain("[context-compaction-native:");
		if (scenario === "aborted" || scenario === "model-switch") expect(fixture.manager.getBranch().some((e) => e.type === "compaction")).toBe(false);
		if (scenario === "late-mutator" || scenario === "late-context") expect(fixture.payloads.some((payload) => payload.text?.format?.name === "compact_result")).toBe(false);
	} finally { await fixture.close(); }
});

for (const scenario of ["checkpoint", "threshold", "overflow"] as const) test(`native SDK entry: ${scenario}`, async () => {
	const fixture = await setup(scenario);
	try {
		await fixture.session.prompt(scenario === "checkpoint" ? "Сохрани checkpoint и продолжи проверку импорта." : "Продолжи исходную работу; контрольный запрос.");
		await until(() => fixture.audits().some((audit: any) => audit.outcome === "success" && audit.native) && fixture.session.isIdle, `native ${scenario} success`);
		if (scenario === "checkpoint") await until(() => fixture.payloads.length >= 3 && fixture.session.isIdle, "checkpoint continuation");
		expect(fixture.payloads.filter((p) => p.text?.format?.name === "compact_result")).toHaveLength(1);
		expect(fixture.payloads).toHaveLength(scenario === "threshold" ? 2 : 3);
		expect(fixture.stats.toolExecutions).toBe(0);
		expect(fixture.stats.networkCalls).toBe(0);
		expect(JSON.stringify(fixture.manager.getEntry(fixture.tailId))).toBe(fixture.oldTail);
		expect(JSON.stringify(fixture.manager.buildSessionProjection().messages)).not.toContain("[context-compaction-native:");
		const cards: any[] = fixture.manager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "context-compaction-card");
		expect(cards.at(-1)?.data.trigger).toBe(scenario === "checkpoint" ? "manual" : scenario);
		if (scenario === "checkpoint") {
			const phases = fixture.manager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "context-compaction-audit").map((e: any) => e.data.phase);
			expect(phases.filter((p) => p === "send-attempted")).toHaveLength(1);
			expect(phases).not.toContain("error");
		}
	} catch (error) {
		console.error("ENTRY_DIAGNOSTIC", JSON.stringify({ scenario, tools: fixture.session.getActiveToolNames(), audits: fixture.audits(), stats: fixture.stats, payloads: fixture.payloads.map((p) => ({ native: p.text?.format?.name, tools: p.tools?.map((t: any) => t.name), last: JSON.stringify(p.input.at(-1)).slice(0, 160) })), entries: fixture.manager.getBranch().map((e: any) => ({ type: e.type, role: e.message?.role, data: e.type === "custom" ? e.data : undefined, text: e.message ? JSON.stringify(e.message.content).slice(0, 100) : undefined })) }));
		throw error;
	} finally { await fixture.close(); }
}, 10_000);

for (const entry of ["manual", "checkpoint", "threshold", "overflow"] as const) test(`native receipt and continuation require the actual saved boundary: ${entry}`, async () => {
	const fixture = await setup(entry === "manual" ? "success" : entry, "drop-native");
	try {
		if (entry === "manual") await fixture.compact();
		else await fixture.session.prompt("Продолжи проверку импорта.");
		await until(() => fixture.session.isIdle && fixture.audits().some((a: any) => a.reason === "apply-failed"), `rejected native boundary ${entry}`);
		expect(fixture.payloads).toHaveLength(entry === "manual" ? 1 : 2);
		expect(fixture.audits()).toHaveLength(1);
		expect(fixture.audits()[0]).toMatchObject({ outcome: "unknown", reason: "apply-failed", native: true });
		expect(fixture.manager.getBranch().some((e) => e.type === "compaction")).toBe(false);
		expect(JSON.stringify(fixture.manager.buildSessionProjection().messages)).not.toContain("[context-compaction-native:");
	} finally { await fixture.close(); }
});

test("an interrupted service turn is excluded before the next normal request and cleaned append-only", async () => {
	const fixture = await setup("orphan");
	try {
		const { serviceId, responseId, original } = fixture.orphan!;
		await fixture.session.prompt("Новый настоящий запрос пользователя.");
		expect(fixture.payloads).toHaveLength(1);
		expect(JSON.stringify(fixture.payloads[0])).not.toContain("ORPHAN_PRIVATE_RESPONSE");
		expect(JSON.stringify(fixture.payloads[0])).not.toContain("[context-compaction-native:");
		expect(JSON.stringify(fixture.manager.getEntry(serviceId))).toBe(original);
		const omitted = fixture.manager.getBranch().filter((e) => e.type === "context_edit" && e.replacement === null).map((e: any) => e.targetId);
		const branch = fixture.manager.getBranch();
		const normalUserIndex = branch.findIndex((entry: any) => entry.type === "message" && entry.message?.role === "user" && JSON.stringify(entry.message.content).includes("Новый настоящий запрос пользователя."));
		const normalUser = normalUserIndex >= 0 ? branch[normalUserIndex] : undefined;
		const normalResponse = normalUserIndex >= 0 ? branch.slice(normalUserIndex + 1).find((entry: any) => entry.type === "message" && entry.message?.role === "assistant") : undefined;
		expect(normalUser).toBeDefined();
		expect(normalResponse).toBeDefined();
		expect(omitted).not.toContain(normalUser!.id);
		expect(omitted).not.toContain(normalResponse!.id);
		expect(JSON.stringify(fixture.manager.buildSessionProjection().messages)).toContain(JSON.stringify(normalResponse!.message.content));
		expect(omitted.every((id) => (fixture.manager.getEntry(id) as any)?.message?.role !== "system")).toBe(true);
		expect(omitted).toContain(serviceId);
		expect(omitted).toContain(responseId);
	} finally { await fixture.close(); }
});

test("an early provider hook failure hides the native service message immediately", async () => {
	const fixture = await setup("provider-hook-throw");
	try {
		await fixture.compact();
		const branch = fixture.manager.getBranch();
		expect(branch.some((entry: any) => entry.type === "message" && entry.message?.role === "user" && JSON.stringify(entry.message.content).includes("[context-compaction-native:"))).toBe(false);
		expect(branch.some((entry: any) => entry.type === "custom_message" && entry.customType === "context-compaction-native" && entry.display === false)).toBe(true);
		expect(branch.some((entry: any) => entry.type === "context_edit" && entry.replacement === null)).toBe(true);
		expect(JSON.stringify(fixture.manager.buildSessionProjection().messages)).not.toContain("[context-compaction-native:");
		expect(readFileSync(fixture.manager.getSessionFile()!).subarray(0, fixture.originalFile.length).equals(fixture.originalFile)).toBe(true);
		const reloaded = SessionManager.open(fixture.manager.getSessionFile()!);
		expect(JSON.stringify(reloaded.buildSessionProjection().messages)).not.toContain("[context-compaction-native:");
		await fixture.session.prompt("Новый настоящий запрос после reload.");
		await until(() => fixture.session.isIdle && fixture.manager.getBranch().some((entry: any) => entry.type === "message" && entry.message?.role === "user" && JSON.stringify(entry.message.content).includes("Новый настоящий запрос после reload.")), "ordinary request after hidden orphan");
		const afterBranch = fixture.manager.getBranch();
		const afterUserIndex = afterBranch.findIndex((entry: any) => entry.type === "message" && entry.message?.role === "user" && JSON.stringify(entry.message.content).includes("Новый настоящий запрос после reload."));
		const afterUser = afterUserIndex >= 0 ? afterBranch[afterUserIndex] : undefined;
		const afterAssistant = afterUserIndex >= 0 ? afterBranch.slice(afterUserIndex + 1).find((entry: any) => entry.type === "message" && entry.message?.role === "assistant") : undefined;
		const afterOmitted = afterBranch.filter((entry: any) => entry.type === "context_edit" && entry.replacement === null).map((entry: any) => entry.targetId);
		expect(afterUser).toBeDefined();
		expect(afterAssistant).toBeDefined();
		expect(afterOmitted).not.toContain(afterUser!.id);
		expect(afterOmitted).not.toContain(afterAssistant!.id);
		expect(JSON.stringify(fixture.manager.buildSessionProjection().messages)).toContain(JSON.stringify(afterAssistant!.message.content));
	} finally { await fixture.close(); }
});

test("a repeated manual handoff keeps one native operation and sends only one request", async () => {
	const fixture = await setup();
	try {
		for (let i = 0; i < 2; i++) { try { await fixture.session.compact(); } catch (e) { expect(String(e)).toContain("cancelled"); } }
		await until(() => fixture.audits().some((a: any) => a.outcome === "success"), "repeated handoff result");
		expect(fixture.payloads).toHaveLength(1);
		expect(fixture.manager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(1);
	} finally { await fixture.close(); }
});

test("a changed session identity before queued start sends no stale request", async () => {
	const fixture = await setup();
	try {
		try { await fixture.session.compact(); } catch (e) { expect(String(e)).toContain("cancelled"); }
		fixture.manager.newSession();
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(fixture.payloads).toHaveLength(0);
		expect(fixture.manager.getBranch().some((e) => e.type === "compaction")).toBe(false);
		expect(fixture.audits()).toHaveLength(0);
	} finally { await fixture.close(); }
});

test("new ordinary input supersedes pending compact without losing its normal response", async () => {
	const fixture = await setup();
	try {
		try { await fixture.session.compact(); } catch (e) { expect(String(e)).toContain("cancelled"); }
		await fixture.session.prompt("Новый обычный запрос вместо ожидающего compact.");
		expect(fixture.payloads).toHaveLength(1);
		expect(fixture.payloads[0].text?.format?.name).not.toBe("compact_result");
		expect(fixture.manager.getBranch().some((e) => e.type === "compaction")).toBe(false);
		expect(fixture.session.getLastAssistantText()).toContain("локальный JSON");
		expect(JSON.stringify(fixture.manager.buildSessionProjection().messages)).toContain("локальный JSON");
	} finally { await fixture.close(); }
});

for (const kind of ["provider", "transport"] as const) for (const entry of ["manual", "checkpoint", "threshold", "overflow"] as const) test(`native ${kind} error never retries or resumes: ${entry}`, async () => {
	const fixture = await setup(`${entry}-provider-error`, kind === "transport" ? "transport-error" : undefined);
	try {
		if (entry === "manual") await fixture.compact();
		else await fixture.session.prompt("Продолжи проверку импорта.");
		await until(() => fixture.audits().some((a: any) => a.native && a.reason === "request-failed") && fixture.session.isIdle, `failed native settles ${kind} ${entry}`);
		expect(fixture.manager.getBranch().some((e) => e.type === "compaction")).toBe(false);
		expect(fixture.payloads).toHaveLength(entry === "manual" ? 1 : 2);
		expect(fixture.payloads.filter((p) => p.text?.format?.name === "compact_result")).toHaveLength(1);
		const failure = fixture.audits().find((a: any) => a.native && a.reason === "request-failed");
		expect(failure.outcome).toBe("cancel");
		expect(failure.requestFailure).toEqual({ class: kind === "transport" ? "transport" : "provider-error", phase: "provider", hasUsage: kind === "provider" });
		expect(fixture.audits().some((a: any) => a.outcome === "success")).toBe(false);
		expect(fixture.stats.networkCalls).toBe(0);
		expect(fixture.stats.toolExecutions).toBe(0);
		expect(JSON.stringify(fixture.manager.getEntry(fixture.tailId))).toBe(fixture.oldTail);
		expect(JSON.stringify(fixture.manager.buildSessionProjection().messages)).not.toContain("[context-compaction-native:");
	} finally { await fixture.close(); }
});

test("idle tree cancellation releases the scheduled native operation", async () => {
	const fixture = await setup();
	try {
		try { await fixture.session.compact(); } catch (error) { expect(String(error)).toContain("cancelled"); }
		const target = fixture.manager.getBranch().find((e: any) => e.type === "message" && e.message.role === "assistant")!;
		await fixture.session.navigateTree(target.id, { summarize: false });
		expect(fixture.manager.getEntries().some((e: any) => e.type === "custom" && e.customType === "context-compaction-append" && e.data.native && e.data.reason === "context-changed")).toBe(true);
		await fixture.session.prompt("Продолжи проверку импорта после перехода ветки.");
		await fixture.compact();
		await until(() => fixture.audits().some((a: any) => a.native && a.outcome === "success") && fixture.session.isIdle, "append after tree cancellation");
		expect(fixture.payloads.filter((p) => p.text?.format?.name === "compact_result")).toHaveLength(1);
		expect(fixture.stats.networkCalls).toBe(0);
	} finally { await fixture.close(); }
});

test("an unstarted service submission can be cancelled and retried without reload", async () => {
	const fixture = await setup("queue-rejected");
	try {
		try { await fixture.session.compact(); } catch (error) { expect(String(error)).toContain("cancelled"); }
		await until(() => fixture.manager.getBranch().some((e: any) => e.type === "custom" && e.customType === "context-compaction-native") && fixture.session.isIdle, "dropped service submission");
		expect(fixture.payloads).toHaveLength(0);
		try { await fixture.session.compact(); } catch (error) { expect(String(error)).toContain("cancelled"); }
		expect(fixture.audits().some((a: any) => a.native && a.reason === "context-changed")).toBe(true);
		await fixture.compact();
		await until(() => fixture.audits().some((a: any) => a.native && a.outcome === "success") && fixture.session.isIdle, "append after rejected submission");
		expect(fixture.payloads.filter((p) => p.text?.format?.name === "compact_result")).toHaveLength(1);
		expect(fixture.stats.networkCalls).toBe(0);
	} finally { await fixture.close(); }
});

for (const failure of ["invalid-json", "tail-leak", "tool-calls"] as const) test(`overflow standard fallback resumes the original work once: ${failure}`, async () => {
	const fixture = await setup("overflow", failure);
	try {
		const request = "Продолжи исходный импорт ORIGINAL_OVERFLOW_491.";
		await fixture.session.prompt(request);
		await until(() => fixture.session.isIdle && fixture.payloads.length === 3 + fixture.stats.standardExpectedRequests, `overflow fallback continuation ${failure}`);
		expect(fixture.payloads.filter((p) => p.text?.format?.name === "compact_result")).toHaveLength(1);
		expect(JSON.stringify(fixture.payloads.at(-1).input)).toContain(request);
		// A split request lives in the typed prefix summary, not a retained raw user message.
		expect(fixture.manager.buildSessionProjection().messages.filter((m: any) => (m.role === "user" || m.role === "compactionSummary") && JSON.stringify(m).includes(request))).toHaveLength(1);
		expect(fixture.manager.getBranch().filter((e: any) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(request))).toHaveLength(1);
		expect(JSON.stringify(fixture.manager.buildSessionProjection().messages)).not.toContain("[context-compaction-native:");
		expect(fixture.stats.toolExecutions).toBe(0);
		expect(fixture.stats.networkCalls).toBe(0);
		const cards: any[] = fixture.manager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "context-compaction-card");
		expect(cards.at(-1).data.kind).toBe("standard");
		expect(cards.at(-1).data.trigger).toBe("overflow");
	} finally { await fixture.close(); }
});

test("cancelling overflow standard fallback does not compact or resume", async () => {
	const fixture = await setup("overflow", "cancel-standard");
	try {
		await fixture.session.prompt("Продолжи исходную работу.");
		await until(() => fixture.session.isIdle, "cancelled fallback settles");
		expect(fixture.manager.getBranch().some((e) => e.type === "compaction")).toBe(false);
		expect(fixture.payloads).toHaveLength(2);
		expect(fixture.audits().some((a: any) => a.outcome === "success")).toBe(false);
		expect(fixture.stats.networkCalls).toBe(0);
	} finally { await fixture.close(); }
});

test("rejected overflow standard boundary never resumes or claims success", async () => {
	const fixture = await setup("overflow", "apply-rejected");
	try {
		await fixture.session.prompt("Продолжи исходную работу.");
		await until(() => fixture.session.isIdle, "rejected fallback settles");
		expect(fixture.manager.getBranch().some((e) => e.type === "compaction")).toBe(false);
		expect(fixture.payloads).toHaveLength(2 + fixture.stats.standardExpectedRequests);
		expect(fixture.audits().some((a: any) => a.outcome === "success")).toBe(false);
		expect(fixture.audits().some((a: any) => a.outcome === "unknown" && a.reason === "apply-failed")).toBe(true);
		expect(fixture.stats.networkCalls).toBe(0);
	} finally { await fixture.close(); }
});

test("native compact preserves the SDK trailing effort update", async () => {
	const fixture = await setup("mid-convo-effort");
	try {
		await fixture.compact();
		expect(fixture.audits().some((a: any) => a.native && a.outcome === "success")).toBe(true);
		const payload = fixture.payloads.find((p) => p.text?.format?.name === "compact_result");
		expect(payload.input.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "medium" } });
		expect(payload.input.at(-2).role).toBe("user");
		expect(payload.tool_choice).toBe("none");
		expect(payload.prompt_cache_key).toBe(fixture.manager.getSessionId());
		expect(fixture.stats.toolExecutions).toBe(0);
		expect(fixture.stats.networkCalls).toBe(0);
		expect(JSON.stringify(fixture.manager.getEntry(fixture.tailId))).toBe(fixture.oldTail);
	} finally { await fixture.close(); }
});

for (const scenario of ["unexpected-tail", "duplicate-effort"] as const) test(`native payload rejects non-SDK suffix: ${scenario}`, async () => {
	const fixture = await setup(scenario);
	try {
		await fixture.compact();
		expect(fixture.audits().some((a: any) => a.reason === "payload-mismatch")).toBe(true);
		expect(fixture.payloads.filter((p) => p.text?.format?.name === "compact_result")).toHaveLength(0);
		expect(fixture.stats.networkCalls).toBe(0);
	} finally { await fixture.close(); }
});

test("late changes to the SDK effort control are rejected before sending", async () => {
	const fixture = await setup("late-effort");
	try {
		await fixture.compact();
		expect(fixture.audits().some((a: any) => a.reason === "payload-mismatch")).toBe(true);
		expect(fixture.payloads.filter((p) => p.text?.format?.name === "compact_result")).toHaveLength(0);
		expect(fixture.stats.networkCalls).toBe(0);
	} finally { await fixture.close(); }
});

for (const budgetCase of ["large", "wrong-route", "small", "opaque"] as const) test(`service budget through real SDK: ${budgetCase}`, async () => {
	const fixture = await setup("success", undefined, budgetCase);
	try {
		await fixture.compact();
		const native = fixture.payloads.filter(p => p.text?.format?.name === "compact_result");
		if (budgetCase === "large" || budgetCase === "opaque") {
			expect(native).toHaveLength(1);
			expect(fixture.audits().some((a: any) => a.native && a.outcome === "success")).toBe(true);
			expect(fixture.dispatchModels[0].transport).toBe("sse");
			if (budgetCase === "large") {
				expect(fixture.dispatchModels[0].window).toBe(1_048_576);
				expect(fixture.session.model?.contextWindow).toBe(272_000);
				const audit: any = fixture.manager.getBranch().find((e: any) => e.type === "custom" && e.customType === "context-compaction-budget");
				expect(audit.data.outputReserve).toBe(128_000);
				expect(audit.data.inputTokens + audit.data.taskTokens + audit.data.outputReserve + audit.data.margin).toBeGreaterThan(272_000);
			} else expect(native[0].input.find((i: any) => i.id === "opaque-fixture").encrypted_content).toHaveLength(703_320);
		} else {
			expect(native).toHaveLength(0);
			expect(fixture.audits()[0].reason).toBe("insufficient-window");
		}
		expect(fixture.manager.getBranch().some(e => e.type === "compaction")).toBe(true);
		expect(JSON.stringify(fixture.manager.getEntry(fixture.tailId))).toBe(fixture.oldTail);
		expect(fixture.stats.networkCalls).toBe(0);
	} finally { await fixture.close(); }
}, 10_000);

test("cleanup leaves context usage unknown until a fresh successful assistant or boundary", () => {
	const id = "ef70cc98-d84c-4875-a3f1-ef6ef4df25b2";
	const branch: any[] = [
		{ id: "owner", type: "custom", customType: "context-compaction-native", data: { id, phase: "queued" } },
		{ id: "old", type: "message", message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 227503 } } },
		{ id: "service", type: "message", message: { role: "user", content: `[context-compaction-native:${id}] task` } },
	];
	let tokens = 227503;
	const ctx: any = { sessionManager: { getBranch: () => branch, getSessionId: () => "fixture" }, getContextUsage: () => ({ tokens }) };
	const controller = new NativeAppend({} as any, {} as any);
	expect(controller.contextTokens(ctx)).toBe(227503);
	const edits = (controller as any).cleanup(ctx);
	expect(edits).toHaveLength(1);
	branch.push(...edits.map((e: any) => ({ ...e, id: "edit" })));
	tokens = 179914;
	expect(controller.contextTokens(ctx)).toBeUndefined();
	branch.push({ id: "failed", type: "message", message: { role: "assistant", stopReason: "error", usage: { totalTokens: 1 } } });
	expect(controller.contextTokens(ctx)).toBeUndefined();
	branch.push({ id: "fresh", type: "message", message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 1000 } } });
	tokens = 1000;
	expect(controller.contextTokens(ctx)).toBe(1000);
});

test("native serialized rejection cannot escape through the real SDK standard fallback", async () => {
	const fixture = await setup("success", undefined, "serialized");
	try {
		await fixture.compact();
		try { await until(() => fixture.stats.standardFailures >= 2 && fixture.session.isIdle, "standard serialized refusal"); }
		catch (error) { console.error("SERIALIZED_DIAGNOSTIC", JSON.stringify({ stats: fixture.stats, dispatches: fixture.dispatchModels, payloadCount: fixture.payloads.length, audits: fixture.audits() })); throw error; }
		// Native handoff cancels the original compact; the rejected standard fallback cancels once more.
		expect(fixture.stats.standardFailures).toBe(2);
		expect(fixture.audits()[0].reason).toBe("request-too-large");
		expect(fixture.dispatchModels).toHaveLength(2);
		expect(fixture.payloads).toHaveLength(0);
		expect(fixture.manager.getBranch().some((e) => e.type === "compaction")).toBe(false);
		expect(fixture.audits().some((e: any) => e.outcome === "success")).toBe(false);
		expect(fixture.stats.networkCalls).toBe(0);
		expect(fixture.stats.toolExecutions).toBe(0);
		expect(JSON.stringify(fixture.manager.getEntry(fixture.tailId))).toBe(fixture.oldTail);
	} finally { await fixture.close(); }
});

for (const mutation of ["summary", "tail"] as const) for (const entry of ["manual", "checkpoint", "threshold", "overflow"] as const) test(`mutated durable native ${mutation} cannot claim success or continue: ${entry}`, async () => {
	const fixture = await setup(entry === "manual" ? "success" : entry, mutation === "summary" ? "mutate-native" : "mutate-tail");
	try {
		if (entry === "manual") await fixture.compact(); else await fixture.session.prompt("Продолжи проверку импорта.");
		await until(() => fixture.session.isIdle && fixture.audits().length > 0, `mutated boundary ${entry}`);
		expect(fixture.audits().some((a: any) => a.outcome === "success")).toBe(false);
		expect(fixture.manager.getBranch().some((e: any) => e.type === "compaction" && (mutation === "summary" ? e.summary.includes("UNEXPECTED_BOUNDARY_CHANGE") : e.firstKeptEntryId === fixture.manager.getBranch().find((x: any) => x.type === "message" && x.message.role === "user")!.id))).toBe(true);
		expect(fixture.payloads).toHaveLength(entry === "manual" ? 1 : 2);
	} finally { await fixture.close(); }
});

test("native final budget records exact late serialization refusal", async () => {
	const fixture = await setup("success", undefined, "late-serialized");
	try {
		await fixture.compact();
		const budgets: any[] = fixture.manager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "context-compaction-budget").map((e: any) => e.data);
		expect(budgets.find((b) => b.phase === "prepared").allowed).toBe(true);
		const final = budgets.find((b) => b.phase === "final");
		expect(final.reason).toBe("request-too-large");
		expect(final.serializedChars).toBe(fixture.stats.latePayloadChars);
		expect(final.serializedChars).toBeGreaterThan(MAX_COMPACT_PAYLOAD_CHARS);
		expect(fixture.audits()[0].reason).toBe("request-too-large");
		expect(fixture.payloads.filter((p) => p.text?.format?.name === "compact_result")).toHaveLength(0);
		expect(fixture.stats.networkCalls).toBe(0);
	} finally { await fixture.close(); }
});
