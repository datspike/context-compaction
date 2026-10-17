import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GenerationTelemetry } from "./generation-telemetry.mjs";
import { RequestStageController } from "./request-stage-controller.mjs";

function usage(output, reasoning = 0) {
  return { output, reasoning, input: 0, totalTokens: output, cacheRead: 0, cacheWrite: 0 };
}

function message(output, id = "message-1") {
  return {
    id,
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    api: "openai-responses",
    content: [{ type: "text", text: "" }],
    usage: usage(output),
    stopReason: "stop",
  };
}

test("SQLite telemetry is durable, UTC-based, and idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-generation-telemetry-"));
  const path = join(dir, "generation.sqlite");
  try {
    const telemetry = new GenerationTelemetry({ databasePath: path, now: () => 1_700_000_000_000 });
    const record = {
      responseKey: "session-1:message-1", sessionId: "session-1", messageId: "message-1", generation: 1,
      provider: "openai", model: "gpt-test", api: "openai-responses", startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000, outputTokens: 50, countedTokens: 50, generationMsTotal: 1_000,
      generationMsText: 1_000, generationRate: 50, averageRate: 50, apiWaitBeforeFirstTokenMs: 100, apiWaitBetweenGenerationWindowsMs: 50, apiWaitAfterLastTokenMs: 0, apiWaitTotalMs: 150, complete: true, flags: {},
    };
    assert.equal(telemetry.writeResponse(record), true);
    assert.equal(telemetry.writeResponse(record), true);
    const row = telemetry.db.prepare("SELECT count(*) AS n, started_at_utc, measurement_version FROM responses").get();
    assert.equal(row.n, 1);
    assert.equal(row.started_at_utc, "2023-11-14T22:13:20.000Z");
    assert.equal(row.measurement_version, "1");
    assert.equal(telemetry.updateResponseProviderEnd("session-1:message-1", 1_700_000_001_200, 1_700_000_001_000), true);
    const updated = telemetry.db.prepare("SELECT provider_response_end_at_utc, api_wait_after_last_token_ms, api_wait_total_ms, json_extract(flags_json, '$.missingProviderResponseEnd') AS missing FROM responses").get();
    assert.equal(updated.provider_response_end_at_utc, "2023-11-14T22:13:21.200Z");
    assert.equal(updated.api_wait_after_last_token_ms, 200);
    assert.equal(updated.api_wait_total_ms, 350);
    assert.equal(updated.missing, 0);
    assert.equal(telemetry.writeTool({ toolKey: "session-1:tool-1:1", sessionId: "session-1", toolCallId: "tool-1", toolName: "bash", startedAt: 1_700_000_000_000, endedAt: 1_700_000_000_100, durationMs: 100, complete: true }), true);
    assert.equal(telemetry.db.prepare("SELECT count(*) AS n FROM tool_executions").get().n, 1);
    telemetry.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller records generation rate and decomposed api wait", () => {
  let now = 0;
  const writes = { responses: [], tools: [], updates: [] };
  const telemetry = {
    writeResponse: (record) => writes.responses.push(record),
    writeTool: (record) => writes.tools.push(record),
    updateResponseProviderEnd: (...args) => writes.updates.push(args),
  };
  const controller = new RequestStageController({ now: () => now, telemetry, onState: () => {} });
  const manager = { getSessionId: () => "session-1" };
  const ctx = { mode: "tui", model: { provider: "openai", id: "gpt-test", api: "openai-responses" }, sessionManager: manager, ui: {} };
  controller.handle({ type: "session_start" }, ctx);
  controller.handle({ type: "before_agent_start" }, ctx);
  now = 100;
  controller.handle({ type: "before_provider_request" }, ctx);
  now = 300;
  controller.handle({ type: "message_start", message: message(0) }, ctx);
  now = 1_000;
  controller.handle({ type: "message_update", message: message(10), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, ctx);
  now = 2_000;
  controller.handle({ type: "message_update", message: message(50), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, ctx);
  now = 2_300;
  controller.handle({ type: "message_end", message: message(50) }, ctx);
  now = 2_400;
  controller.handle({ type: "after_provider_response" }, ctx);

  assert.equal(writes.responses.length, 1);
  const response = writes.responses[0];
  assert.equal(response.complete, true);
  assert.equal(response.countedTokens, 50);
  assert.equal(response.generationMsTotal, 1_000);
  assert.equal(response.generationRate, 50);
  assert.equal(response.averageRate, 50);
  assert.equal(response.apiWaitBeforeFirstTokenMs, 900);
  assert.equal(response.apiWaitBetweenGenerationWindowsMs, 0);
  assert.equal(response.apiWaitAfterLastTokenMs, null);
  assert.equal(response.apiWaitTotalMs, null);
  assert.deepEqual(writes.updates, [["session-1:message-1", 2_400, 2_000]]);

  now = 3_000;
  controller.handle({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" }, ctx);
  now = 3_500;
  controller.handle({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", isError: false }, ctx);
  assert.deepEqual(writes.tools[0], {
    toolKey: "session-1:tool-1:3000", sessionId: "session-1", toolCallId: "tool-1", toolName: "bash",
    startedAt: 3000, endedAt: 3500, durationMs: 500, complete: true, isError: false,
  });
});

test("controller persists an incomplete response on reset", () => {
  let now = 0;
  const writes = [];
  const telemetry = { writeResponse: (record) => writes.push(record), writeTool: () => {}, updateResponseProviderEnd: () => {} };
  const controller = new RequestStageController({ now: () => now, telemetry, onState: () => {} });
  const manager = { getSessionId: () => "session-2" };
  const ctx = { mode: "tui", model: { provider: "openai", id: "gpt-test" }, sessionManager: manager, ui: {} };
  controller.handle({ type: "session_start" }, ctx);
  controller.handle({ type: "before_agent_start" }, ctx);
  controller.handle({ type: "before_provider_request" }, ctx);
  controller.handle({ type: "message_start", message: message(0, "message-2") }, ctx);
  now = 100;
  controller.handle({ type: "session_shutdown" }, ctx);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].complete, false);
  assert.equal(writes[0].responseKey, "session-2:message-2");
  assert.equal(writes[0].apiWaitTotalMs, null);
  assert.equal(writes[0].flags.missingProviderResponseEnd, true);
});
