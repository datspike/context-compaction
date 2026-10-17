import assert from "node:assert/strict";
import test from "node:test";
import { RequestStageController, classifyProviderStreamEvent, formatRequestStageDuration } from "./request-stage-controller.mjs";

function makeContext(manager, calls, model = { provider: "openai", id: "gpt-5.6-luna" }) {
  return {
    mode: "tui",
    model,
    sessionManager: manager,
    ui: {
      setWorkingMessage: (message) => calls.push(["working-message", message]),
      setWorkingVisible: (visible) => calls.push(["working-visible", visible]),
      setStatus: (key, value) => calls.push(["status", key, value]),
    },
  };
}

function makeHarness(width) {
  let now = 0;
  const states = [];
  const calls = [];
  const controller = new RequestStageController({
    now: () => now,
    onState: (state) => states.push(state),
    ...(width === undefined ? {} : { width: () => width }),
  });
  const manager = { getSessionId: () => "session-a" };
  const ctx = makeContext(manager, calls);
  controller.handle({ type: "session_start", reason: "startup" }, ctx);
  return { controller, manager, ctx, calls, states, setNow: (value) => { now = value; } };
}

test("timer belongs to the request and renders observable transitions", () => {
  const h = makeHarness();
  h.controller.handle({ type: "before_agent_start", prompt: "безопасный prompt" }, h.ctx);
  h.setNow(134_000);
  h.controller.emit(true);
  assert.match(h.states.at(-1).message, /Запрос отправлен · жду содержимое · запрос длится 2:14 · этап длится 2:14/);

  h.controller.handle({ type: "before_provider_request", payload: {} }, h.ctx);
  h.controller.handle({ type: "message_start", message: { role: "assistant", provider: "openai", model: "gpt-5.6-luna" } }, h.ctx);
  assert.match(h.states.at(-1).message, /Получаю API-сводку рассуждений · запрос длится 2:14 · этап длится 0:00/);

  h.setNow(136_000);
  h.controller.handle({ type: "provider_stream_event", provider: "openai", model: "gpt-5.6-luna", data: { type: "response.reasoning_summary_text.delta", delta: "секрет" } }, h.ctx);
  assert.match(h.states.at(-1).message, /Получаю API-сводку рассуждений · запрос длится 2:16 · этап длится 0:02/);
  h.setNow(140_000);
  h.controller.handle({ type: "provider_stream_event", provider: "openai", model: "gpt-5.6-luna", data: { type: "response.output_text.delta", delta: "секрет" } }, h.ctx);
  assert.match(h.states.at(-1).message, /Поток текста · запрос длится 2:20 · этап длится 0:00/);
  assert.equal(h.states.at(-1).stageElapsedMs, 0);
  assert.equal(h.calls.some((call) => call.join(" ").includes("секрет")), false);
});

test("ownership fence ignores foreign session and provider streams", () => {
  const h = makeHarness();
  h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
  h.controller.handle({ type: "message_start", message: { role: "assistant", provider: "openai", model: "gpt-5.6-luna" } }, h.ctx);
  const foreignCalls = [];
  const foreignManager = { getSessionId: () => "session-a" };
  const foreign = makeContext(foreignManager, foreignCalls, { provider: "openai", id: "gpt-5.6-luna" });
  const before = h.states.length;
  h.controller.handle({ type: "provider_stream_event", provider: "openai", model: "gpt-5.6-luna", data: { type: "response.output_text.delta" } }, foreign);
  assert.equal(h.states.length, before);
  h.controller.handle({ type: "provider_stream_event", provider: "anthropic", model: "other-model", data: { type: "response.reasoning.delta" } }, h.ctx);
  assert.equal(h.states.length, before);
});

test("tool preparation and parallel execution expose only safe names and counts", () => {
  const h = makeHarness();
  h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
  h.controller.handle({ type: "tool_call", toolName: "read_file", input: { path: "/private/secret" } }, h.ctx);
  assert.match(h.states.at(-1).message, /Подготовка вызова инструмента/);
  h.controller.handle({ type: "tool_execution_start", toolCallId: "a", toolName: "read_file", args: { path: "/private/secret" } }, h.ctx);
  h.controller.handle({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "cat secret" } }, h.ctx);
  assert.match(h.states.at(-1).message, /Исполняется инструмент: read_file, bash \(2\)/);
  assert.equal(h.calls.some((call) => call.join(" ").includes("secret")), false);
  h.controller.handle({ type: "tool_execution_end", toolCallId: "a", toolName: "read_file", result: {}, isError: false }, h.ctx);
  assert.match(h.states.at(-1).message, /Исполняется инструмент: bash/);
  h.controller.handle({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", result: {}, isError: false }, h.ctx);
  assert.match(h.states.at(-1).message, /Запрос отправлен/);
});

test("completion, cancellation, reload, and compaction clear state", () => {
  const h = makeHarness();
  h.controller.handle({ type: "session_before_compact", reason: "manual" }, h.ctx);
  assert.equal(h.calls.some((call) => call[0] === "status" && call[2] === "Сжатие контекста · причина: вручную"), true);
  assert.equal(h.calls.some((call) => call[0] === "working-visible" && call[1] === true), false);
  h.controller.handle({ type: "session_compact", reason: "manual", willRetry: false }, h.ctx);
  assert.equal(h.calls.some((call) => call[0] === "status" && call[2] === undefined), true);

  h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
  h.controller.handle({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "answer" }] } }, h.ctx);
  assert.match(h.states.at(-1).message, /Ответ завершён · ожидание следующего шага/);
  h.controller.handle({ type: "agent_settled" }, h.ctx);
  assert.equal(h.states.at(-1).visible, false);

  h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
  h.controller.handle({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } }, h.ctx);
  assert.match(h.states.at(-1).message, /Отмена · запрос прерван/);
  h.controller.handle({ type: "agent_settled" }, h.ctx);

  h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
  h.controller.handle({ type: "session_shutdown", reason: "reload" }, h.ctx);
  assert.equal(h.states.at(-1).visible, false);
  const oldManager = { getSessionId: () => "session-a" };
  h.controller.handle({ type: "provider_stream_event", provider: "openai", model: "gpt-5.6-luna", data: { type: "response.output_text.delta" } }, makeContext(oldManager, []));
  assert.equal(h.states.at(-1).visible, false);
});

test("pure helpers classify without exposing provider payload", () => {
  assert.equal(formatRequestStageDuration(134_000), "2:14");
  assert.equal(classifyProviderStreamEvent({ type: "reasoning.delta", delta: "secret" }), "reasoning");
  assert.equal(classifyProviderStreamEvent({ type: "output_text.delta", delta: "secret" }), "text_stream");
  assert.equal(classifyProviderStreamEvent({ type: "tool_call.delta", arguments: "secret" }), "prepare_tool");
  assert.equal(classifyProviderStreamEvent({ type: "unknown" }), undefined);
});

function assistantUsage(output, reasoning) {
  return {
    input: 0,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test("working line reports the exact arrival rate from usage samples", () => {
  const h = makeHarness();
  h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
  const message = (output) => ({
    role: "assistant",
    provider: "openai",
    model: "gpt-5.6-luna",
    content: [{ type: "text", text: "" }],
    usage: assistantUsage(output),
  });
  h.controller.handle({ type: "message_start", message: message(0) }, h.ctx);
  h.controller.handle({ type: "message_update", message: message(10), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, h.ctx);
  h.setNow(1_000);
  h.controller.handle({ type: "message_update", message: message(50), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, h.ctx);
  const line = h.states.at(-1).message;
  assert.match(line, /^Поток текста · запрос длится 0:01 · этап длится 0:01/);
  assert.match(line, /50 ток\/с \(ср\. 50\)$/);
  // The rate segment is pinned to the right edge of the working line.
  assert.equal(line.length, 73);
  h.controller.handle({ type: "message_end", message: message(50) }, h.ctx);
  assert.match(h.states.at(-1).message, /^Ответ завершён · ожидание следующего шага · запрос длился/);
  assert.match(h.states.at(-1).message, /ср\. 50 ток\/с$/);
  assert.equal(h.states.at(-1).message.length, 73);
});

test("estimated rate is marked approximate until usage settles", () => {
  const h = makeHarness();
  h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
  const message = (output) => ({
    role: "assistant",
    provider: "openai",
    model: "gpt-5.6-luna",
    content: [{ type: "text", text: "" }],
    usage: assistantUsage(output),
  });
  h.controller.handle({ type: "message_start", message: message(0) }, h.ctx);
  h.controller.handle({ type: "message_update", message: message(0), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, h.ctx);
  h.setNow(1_000);
  h.controller.handle({ type: "message_update", message: message(0), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, h.ctx);
  assert.match(h.states.at(-1).message, /≈20 ток\/с \(ср\. 20\)$/);
  h.controller.handle({ type: "message_end", message: message(95) }, h.ctx);
  assert.match(h.states.at(-1).message, /ср\. 95 ток\/с$/);
});

test("working line shows only the rate readout without token breakdown", () => {
  const h = makeHarness();
  h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
  const message = (output, reasoning) => ({
    role: "assistant",
    provider: "openai",
    model: "gpt-5.6-luna",
    content: [{ type: "thinking", thinking: "" }, { type: "text", text: "" }],
    usage: assistantUsage(output, reasoning),
  });
  h.controller.handle({ type: "message_start", message: message(0, 0) }, h.ctx);
  h.controller.handle({ type: "message_update", message: message(15, 15), assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "a".repeat(20) } }, h.ctx);
  h.setNow(500);
  h.controller.handle({ type: "message_update", message: message(30, 30), assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "a".repeat(20) } }, h.ctx);
  h.setNow(1_000);
  h.controller.handle({ type: "message_update", message: message(40, 30), assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "x".repeat(20) } }, h.ctx);
  h.setNow(2_000);
  h.controller.handle({ type: "message_update", message: message(50, 30), assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "x".repeat(20) } }, h.ctx);
  const line = h.states.at(-1).message;
  assert.match(line, /33 ток\/с \(ср\. 33\)$/);
  assert.equal(line.includes("финг"), false);
  assert.equal(line.includes("токенов"), false);
  assert.equal(line.includes("текст+тулы"), false);
});

test("working line keeps the stock format when nothing is measured", () => {
  const h = makeHarness();
  h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
  assert.match(h.states.at(-1).message, /^Запрос отправлен · жду содержимое · запрос длится 0:00 · этап длится 0:00$/);
});

test("session average accumulates across requests and resets on session_start", () => {
  const h = makeHarness();
  const message = (output) => ({
    role: "assistant",
    provider: "openai",
    model: "gpt-5.6-luna",
    content: [{ type: "text", text: "" }],
    usage: assistantUsage(output),
  });
  const runRequest = (start, output) => {
    h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
    h.controller.handle({ type: "message_start", message: message(0) }, h.ctx);
    h.setNow(start);
    h.controller.handle({ type: "message_update", message: message(0), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, h.ctx);
    h.setNow(start + 1_000);
    h.controller.handle({ type: "message_update", message: message(output), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, h.ctx);
    h.controller.handle({ type: "message_end", message: message(output) }, h.ctx);
  };
  runRequest(0, 50);
  assert.match(h.states.at(-1).message, /ср\. 50 ток\/с$/);
  h.controller.handle({ type: "agent_settled" }, h.ctx);
  runRequest(2_000, 20);
  assert.match(h.states.at(-1).message, /ср\. 35 ток\/с$/);
  h.controller.handle({ type: "session_start", reason: "startup" }, h.ctx);
  runRequest(5_000, 30);
  assert.match(h.states.at(-1).message, /ср\. 30 ток\/с$/);
});

test("rate segment falls back to an inline join when the line is too narrow", () => {
  const h = makeHarness(60);
  const message = (output) => ({
    role: "assistant",
    provider: "openai",
    model: "gpt-5.6-luna",
    content: [{ type: "text", text: "" }],
    usage: assistantUsage(output),
  });
  h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
  h.controller.handle({ type: "message_start", message: message(0) }, h.ctx);
  h.controller.handle({ type: "message_update", message: message(0), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, h.ctx);
  h.setNow(500);
  h.controller.handle({ type: "message_update", message: message(25), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, h.ctx);
  h.setNow(1_000);
  h.controller.handle({ type: "message_update", message: message(50), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, h.ctx);
  const line = h.states.at(-1).message;
  assert.match(line, / · 50 ток\/с \(ср\. 50\)$/);
  assert.equal(line.includes("  50 ток/с"), false);
  assert.equal(line.length, 53);
});

test("model change resets the session average", () => {
  const h = makeHarness();
  const message = (output) => ({
    role: "assistant",
    provider: h.ctx.model.provider,
    model: h.ctx.model.id,
    content: [{ type: "text", text: "" }],
    usage: assistantUsage(output),
  });
  const runRequest = (start, output) => {
    h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
    h.controller.handle({ type: "message_start", message: message(0) }, h.ctx);
    h.setNow(start);
    h.controller.handle({ type: "message_update", message: message(0), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, h.ctx);
    h.setNow(start + 1_000);
    h.controller.handle({ type: "message_update", message: message(output), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, h.ctx);
    h.controller.handle({ type: "message_end", message: message(output) }, h.ctx);
  };
  runRequest(0, 50);
  assert.match(h.states.at(-1).message, /ср\. 50 ток\/с$/);
  h.controller.handle({ type: "agent_settled" }, h.ctx);
  h.ctx.model = { provider: "openai", id: "gpt-5.7-luna" };
  runRequest(2_000, 20);
  assert.match(h.states.at(-1).message, /ср\. 20 ток\/с$/);
  assert.equal(h.states.at(-1).message.includes("ср. 35 ток/с"), false);
});

test("compaction owns the working line through payload hooks and timer ticks of the agent run", () => {
  const h = makeHarness();
  h.controller.handle({ type: "before_agent_start", prompt: "prompt" }, h.ctx);
  h.controller.handle({ type: "session_before_compact", reason: "threshold" }, h.ctx);
  h.controller.beginCompaction(h.ctx, "Compact: append по кэшу последнего запроса");
  h.setNow(5_000);
  // The append request runs the working payload hooks; that must not show a generation stage.
  h.controller.handle({ type: "before_provider_request", payload: {} }, h.ctx);
  h.controller.handle({ type: "turn_start" }, h.ctx);
  h.controller.emit(true);
  assert.equal(h.states.at(-1).message, "Compact: append по кэшу последнего запроса · compact длится 0:05");
  h.controller.beginCompaction(h.ctx, "Compact: стандартная сводка");
  h.setNow(7_000);
  h.controller.emit(true);
  assert.equal(h.states.at(-1).message, "Compact: стандартная сводка · compact длится 0:07");
  h.controller.handle({ type: "session_compact", willRetry: false }, h.ctx);
  assert.match(h.states.at(-1).message, /^Запрос отправлен/);
  assert.equal(h.states.at(-1).visible, true);
});

test("a manual compact outside an agent run shows and then releases the working line", () => {
  const h = makeHarness();
  h.controller.beginCompaction(h.ctx, "Compact: стандартная сводка");
  assert.deepEqual([h.states.at(-1).visible, h.states.at(-1).message], [true, "Compact: стандартная сводка · compact длится 0:00"]);
  h.controller.endCompaction();
  assert.equal(h.states.at(-1).visible, false);
  assert.equal(h.controller.timer, undefined);
});
