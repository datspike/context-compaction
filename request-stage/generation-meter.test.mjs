import assert from "node:assert/strict";
import test from "node:test";
import { GenerationMeter } from "./generation-meter.mjs";

function usage(output, reasoning) {
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

function textDelta(chars, output, reasoning) {
  return {
    event: { type: "text_delta", contentIndex: 0, delta: "x".repeat(chars) },
    message: { role: "assistant", content: [{ type: "text", text: "" }], usage: usage(output, reasoning) },
  };
}

test("live usage counters give an exact arrival rate", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  for (let i = 0; i <= 10; i += 1) {
    now = i * 100;
    const { event, message } = textDelta(40, i * 10);
    meter.record(event, message, now);
  }
  const state = meter.snapshot(now);
  assert.equal(state.rate.estimated, false);
  // 100 tokens arrived over 1000 ms of measured generation windows.
  assert.equal(state.rate.value, 100);
  // The session average accumulates over measured windows, including the in-flight one.
  assert.equal(state.averageRate, 100);
  assert.equal(state.tokens.total, 100);
  assert.equal(state.tokens.estimated, false);
});

test("usage reported only at the end falls back to a marked character estimate", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  for (let i = 1; i <= 11; i += 1) {
    now = i * 100;
    const { event, message } = textDelta(40, 0);
    meter.record(event, message, now);
  }
  const mid = meter.snapshot(now);
  assert.equal(mid.rate.estimated, true);
  // 440 characters ~= 110 tokens over 1000 ms of measured windows.
  assert.equal(mid.rate.value, (440 / 4) * 1000 / 1000);
  assert.equal(mid.tokens.estimated, true);

  meter.endResponse({ usage: usage(95) }, now);
  const done = meter.snapshot(now);
  assert.equal(done.streaming, false);
  assert.equal(done.tokens.total, 95);
  assert.equal(done.tokens.estimated, false);
  assert.equal(done.averageRate, 95 * 1000 / 1000);
});

test("redacted thinking is never measured and is reported as hidden", () => {
  const meter = new GenerationMeter({ now: () => 0 });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }],
    usage: usage(0),
  };
  meter.record({ type: "thinking_start", contentIndex: 0 }, message, 100);
  meter.record({ type: "thinking_end", contentIndex: 0, content: "[Reasoning redacted]" }, message, 200);
  assert.equal(meter.charsByKind.thinking, 0);
  meter.endResponse({ usage: usage(50, 30) }, 200);
  const state = meter.snapshot(200);
  assert.equal(state.tokens.thinkingHidden, true);
  assert.equal(state.windows.thinkingMs, 0);
});

test("category windows exclude pauses between blocks and split reasoning exactly", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0, 0) }, 0);

  for (const [at, output, reasoning] of [[0, 0, 0], [500, 15, 15], [1000, 30, 30]]) {
    now = at;
    meter.record(
      { type: "thinking_delta", contentIndex: 0, delta: "a".repeat(20) },
      { role: "assistant", content: [{ type: "thinking", thinking: "" }], usage: usage(output, reasoning) },
      now,
    );
  }
  // The provider pause between the reasoning and text blocks is not measured.
  for (const [at, output, reasoning] of [[6000, 70, 45], [6500, 85, 55], [7000, 100, 60]]) {
    now = at;
    const { event, message } = textDelta(20, output, reasoning);
    meter.record(event, message, now);
  }
  meter.endResponse({ usage: usage(100, 60) }, 7000);

  const state = meter.snapshot(7000);
  assert.equal(state.windows.thinkingMs, 1000);
  assert.equal(state.windows.textMs, 1000);
  assert.equal(state.windows.toolcallMs, 0);
  assert.equal(state.windows.totalMs, 2000);
  assert.equal(state.averageRate, 50);
  assert.equal(state.tokens.thinking, 60);
  assert.equal(state.tokens.thinkingEstimated, false);
  assert.equal(state.tokens.textAndTools, 40);
});

test("tool-call arguments snapshotted at start are counted at block end", () => {
  const meter = new GenerationMeter({ now: () => 0 });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  const toolCall = { type: "toolCall", id: "1", name: "read_file", arguments: { path: "/tmp/long-path-name" } };
  const message = { role: "assistant", content: [toolCall], usage: usage(0) };
  meter.record({ type: "toolcall_start", contentIndex: 0, toolCall: { id: "1", name: "read_file", arguments: {} } }, message, 0);
  meter.record({ type: "toolcall_end", contentIndex: 0, toolCall }, message, 1000);
  assert.equal(meter.charsByKind.toolcall, JSON.stringify(toolCall.arguments).length);
});

test("aborted responses still settle over the measured window and sum across a request", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  for (const at of [0, 1000]) {
    now = at;
    const { event, message } = textDelta(40, 0);
    meter.record(event, message, now);
  }
  meter.endResponse({ usage: usage(40), stopReason: "aborted" }, 1000);

  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 2000);
  for (const at of [2000, 3000]) {
    now = at;
    const { event, message } = textDelta(40, 0);
    meter.record(event, message, now);
  }
  meter.endResponse({ usage: usage(50) }, 3000);

  const state = meter.snapshot(3000);
  assert.equal(state.streaming, false);
  assert.equal(state.tokens.total, 90);
  assert.equal(state.averageRate, 90 * 1000 / 2000);
});

test("unmeasured redacted thinking never enters the session average", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  // Response A: ordinary text, 20 tokens over 1000 ms of measured windows.
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  for (const at of [0, 1000]) {
    now = at;
    const { event, message } = textDelta(40, at === 0 ? 0 : 20);
    meter.record(event, message, now);
  }
  meter.endResponse({ usage: usage(20) }, 1000);
  assert.equal(meter.snapshot(1000).averageRate, 20);

  // Response B: redacted thinking only. Its tokens arrive in usage but nothing
  // was measured, so neither the in-flight nor the settled average may move.
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 2000);
  const redacted = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }],
    usage: usage(50, 50),
  };
  meter.record({ type: "thinking_start", contentIndex: 0 }, redacted, 2100);
  assert.equal(meter.snapshot(2100).averageRate, 20);
  meter.record({ type: "thinking_end", contentIndex: 0, content: "[Reasoning redacted]" }, redacted, 2200);
  meter.endResponse({ usage: usage(50, 50) }, 2200);
  const state = meter.snapshot(2200);
  assert.equal(state.averageRate, 20);
  assert.equal(state.tokens.thinkingHidden, true);
});

test("hidden thinking of unknown size counts only the visible estimate", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  for (const at of [0, 1000]) {
    now = at;
    const { event, message } = textDelta(40, at === 0 ? 0 : 10);
    meter.record(event, message, now);
  }
  const redacted = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }],
    usage: usage(50),
  };
  meter.record({ type: "thinking_start", contentIndex: 0 }, redacted, 1500);
  meter.record({ type: "thinking_end", contentIndex: 0, content: "[Reasoning redacted]" }, redacted, 1600);
  meter.endResponse({ usage: usage(50) }, 1600);
  const state = meter.snapshot(1600);
  // 80 visible characters ~= 20 tokens over 1000 ms; the hidden part is not guessed.
  assert.equal(state.averageRate, 20);
  assert.equal(state.averageEstimated, true);
});

test("a response with only zero usage sentinels contributes a marked estimate", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  for (const at of [0, 1000]) {
    now = at;
    meter.record(
      { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) },
      { role: "assistant", content: [{ type: "text", text: "" }], usage: usage(0) },
      now,
    );
  }
  meter.endResponse({ role: "assistant", content: [], usage: usage(0) }, 1000);
  const state = meter.snapshot(1000);
  assert.equal(state.averageRate, 20);
  assert.equal(state.averageEstimated, true);
});

test("empty tool deltas do not open or extend a measured window", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  const message = (output) => ({
    role: "assistant",
    content: [{ type: "toolCall", arguments: {} }],
    usage: usage(output),
  });
  meter.record({ type: "toolcall_delta", contentIndex: 0, delta: "" }, message(0), 0);
  meter.record({ type: "toolcall_delta", contentIndex: 0, delta: "" }, message(0), 900);
  meter.record({ type: "toolcall_delta", contentIndex: 0, delta: "x".repeat(40) }, message(10), 900);
  meter.record({ type: "toolcall_delta", contentIndex: 0, delta: "x".repeat(40) }, message(20), 1900);
  meter.endResponse(message(20), 1900);
  const state = meter.snapshot(1900);
  // Only the 1000 ms between the first and last non-empty delta is measured.
  assert.equal(state.windows.toolcallMs, 1000);
  assert.equal(state.averageRate, 20 * 1000 / 1000);
});

test("encrypted-only reasoning signatures are excluded from the measured average", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  const encryptedThinking = {
    type: "thinking",
    thinking: "",
    thinkingSignature: JSON.stringify({ type: "reasoning", id: "r1", encrypted_content: "opaque" }),
  };
  meter.startResponse({ role: "assistant", content: [encryptedThinking], usage: usage(0) }, 0);
  meter.record({ type: "thinking_start", contentIndex: 0 }, { role: "assistant", content: [encryptedThinking], usage: usage(0) }, 0);
  meter.record({ type: "thinking_end", contentIndex: 0 }, { role: "assistant", content: [encryptedThinking], usage: usage(60, 60) }, 0);
  for (const at of [0, 1000]) {
    now = at;
    const { event, message } = textDelta(40, at === 0 ? 60 : 100, 60);
    meter.record(event, message, now);
  }
  meter.endResponse({ usage: usage(100, 60) }, 1000);
  const state = meter.snapshot(1000);
  assert.equal(state.tokens.thinkingHidden, true);
  assert.equal(state.averageRate, 40);
});

test("visible reasoning remains measurable with an encrypted replay signature", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  const visibleThinking = {
    type: "thinking",
    thinking: "visible summary",
    thinkingSignature: JSON.stringify({ type: "reasoning", id: "r2", encrypted_content: "opaque" }),
  };
  meter.startResponse({ role: "assistant", content: [visibleThinking], usage: usage(0, 0) }, 0);
  for (const at of [0, 1000]) {
    now = at;
    meter.record(
      { type: "thinking_delta", contentIndex: 0, delta: "a".repeat(40) },
      { role: "assistant", content: [visibleThinking], usage: usage(at === 0 ? 0 : 60, at === 0 ? 0 : 60) },
      now,
    );
  }
  meter.record({ type: "thinking_end", contentIndex: 0 }, { role: "assistant", content: [visibleThinking], usage: usage(60, 60) }, 1000);
  for (const at of [1000, 2000]) {
    now = at;
    const { event, message } = textDelta(40, at === 1000 ? 60 : 100, 60);
    meter.record(event, message, now);
  }
  meter.endResponse({ usage: usage(100, 60) }, 2000);
  const state = meter.snapshot(2000);
  assert.equal(state.tokens.thinkingHidden, false);
  assert.equal(state.averageRate, 50);
});

test("mixed visible and hidden reasoning uses only visible character estimates", () => {
  const meter = new GenerationMeter({ now: () => 0 });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  const visible = { type: "thinking", thinking: "visible" };
  const hidden = { type: "thinking", thinking: "", redacted: true };
  const text = { type: "text", text: "" };
  const content = [visible, hidden, text];
  meter.record({ type: "thinking_delta", contentIndex: 0, delta: "x".repeat(40) }, { role: "assistant", content, usage: usage(0, 0) }, 0);
  meter.record({ type: "thinking_delta", contentIndex: 0, delta: "x".repeat(40) }, { role: "assistant", content, usage: usage(20, 20) }, 1000);
  meter.record({ type: "thinking_end", contentIndex: 0 }, { role: "assistant", content, usage: usage(20, 20) }, 1000);
  meter.record({ type: "thinking_start", contentIndex: 1 }, { role: "assistant", content, usage: usage(20, 20) }, 1000);
  meter.record({ type: "thinking_end", contentIndex: 1 }, { role: "assistant", content, usage: usage(30, 30) }, 1000);
  meter.record({ type: "text_delta", contentIndex: 2, delta: "x".repeat(40) }, { role: "assistant", content, usage: usage(30, 30) }, 1000);
  meter.record({ type: "text_delta", contentIndex: 2, delta: "x".repeat(40) }, { role: "assistant", content, usage: usage(40, 30) }, 2000);
  meter.endResponse({ usage: usage(40, 30) }, 2000);
  const state = meter.snapshot(2000);
  assert.equal(state.tokens.thinkingHidden, true);
  assert.equal(state.averageEstimated, true);
  assert.equal(state.tokens.total, 40);
  assert.equal(state.averageRate, 20);
});

test("zero-delta tool snapshots do not enter the measured average", () => {
  const meter = new GenerationMeter({ now: () => 0 });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  const text = { type: "text", text: "" };
  const toolCall = { type: "toolCall", id: "1", name: "read_file", arguments: { path: "/tmp/very-long-path-name" } };
  const content = [text, toolCall];
  meter.record({ type: "text_delta", contentIndex: 0, delta: "x".repeat(40) }, { role: "assistant", content, usage: usage(0) }, 0);
  meter.record({ type: "text_delta", contentIndex: 0, delta: "x".repeat(40) }, { role: "assistant", content, usage: usage(0) }, 1000);
  meter.record({ type: "toolcall_start", contentIndex: 1, toolCall: { id: "1", name: "read_file", arguments: {} } }, { role: "assistant", content, usage: usage(0) }, 1000);
  meter.record({ type: "toolcall_end", contentIndex: 1, toolCall }, { role: "assistant", content, usage: usage(0) }, 1000);
  meter.endResponse({ usage: usage(40) }, 1000);
  const state = meter.snapshot(1000);
  assert.equal(meter.charsByKind.toolcall, JSON.stringify(toolCall.arguments).length);
  assert.equal(state.tokens.total, 20);
  assert.equal(state.averageRate, 20);
  assert.equal(state.averageEstimated, true);
});

test("encrypted-only reasoning keeps live usage exact for visible text", () => {
  const meter = new GenerationMeter({ now: () => 0 });
  const content = [
    { type: "thinking", thinking: "", redacted: true },
    { type: "text", text: "" },
  ];
  meter.startResponse({ role: "assistant", content, usage: usage(0, 0) }, 0);
  meter.record({ type: "thinking_start", contentIndex: 0 }, { role: "assistant", content, usage: usage(0, 0) }, 0);
  meter.record({ type: "thinking_end", contentIndex: 0 }, { role: "assistant", content, usage: usage(60, 60) }, 0);
  meter.record({ type: "text_delta", contentIndex: 1, delta: "x".repeat(40) }, { role: "assistant", content, usage: usage(60, 60) }, 0);
  meter.record({ type: "text_delta", contentIndex: 1, delta: "x".repeat(40) }, { role: "assistant", content, usage: usage(100, 60) }, 1000);
  const state = meter.snapshot(1000);
  assert.equal(state.rate.value, 40);
  assert.equal(state.rate.estimated, false);
  assert.equal(state.averageRate, 40);
  assert.equal(state.averageEstimated, false);
});

test("hidden reasoning does not reintroduce zero-delta tool tokens after settlement", () => {
  const meter = new GenerationMeter({ now: () => 0 });
  const toolCall = { type: "toolCall", id: "1", name: "read_file", arguments: { path: "/tmp/very-long-path-name" } };
  const content = [
    { type: "thinking", thinking: "", redacted: true },
    { type: "text", text: "" },
    toolCall,
  ];
  meter.startResponse({ role: "assistant", content, usage: usage(0, 0) }, 0);
  meter.record({ type: "thinking_start", contentIndex: 0 }, { role: "assistant", content, usage: usage(0, 0) }, 0);
  meter.record({ type: "thinking_end", contentIndex: 0 }, { role: "assistant", content, usage: usage(60, 60) }, 0);
  meter.record({ type: "text_delta", contentIndex: 1, delta: "x".repeat(40) }, { role: "assistant", content, usage: usage(60, 60) }, 0);
  meter.record({ type: "text_delta", contentIndex: 1, delta: "x".repeat(40) }, { role: "assistant", content, usage: usage(100, 60) }, 1000);
  meter.record({ type: "toolcall_start", contentIndex: 2, toolCall: { id: "1", name: "read_file", arguments: {} } }, { role: "assistant", content, usage: usage(100, 60) }, 1000);
  meter.record({ type: "toolcall_end", contentIndex: 2, toolCall }, { role: "assistant", content, usage: usage(100, 60) }, 1000);
  meter.endResponse({ usage: usage(100, 60) }, 1000);
  const state = meter.snapshot(1000);
  assert.equal(state.averageRate, 20);
  assert.equal(state.averageEstimated, true);
  assert.equal(state.tokens.total, 20);
});

test("late reasoning usage backfills the zero-output baseline", () => {
  const meter = new GenerationMeter({ now: () => 0 });
  const content = [
    { type: "thinking", thinking: "", redacted: true },
    { type: "text", text: "" },
  ];
  meter.startResponse({ role: "assistant", content, usage: usage(0) }, 0);
  meter.record({ type: "thinking_start", contentIndex: 0 }, { role: "assistant", content, usage: usage(0) }, 0);
  meter.record({ type: "thinking_end", contentIndex: 0 }, { role: "assistant", content, usage: usage(20, 20) }, 0);
  meter.record({ type: "text_delta", contentIndex: 1, delta: "x".repeat(40) }, { role: "assistant", content, usage: usage(20, 20) }, 0);
  meter.record({ type: "text_delta", contentIndex: 1, delta: "x".repeat(40) }, { role: "assistant", content, usage: usage(60, 20) }, 1000);
  const state = meter.snapshot(1000);
  assert.equal(state.rate.value, 40);
  assert.equal(state.rate.estimated, false);
  assert.equal(state.averageRate, 40);
});

test("a burst shorter than the minimum measured span never reaches the session average", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  for (const at of [0, 10, 20]) {
    now = at;
    const { event, message } = textDelta(40, at === 20 ? 200 : 0);
    meter.record(event, message, now);
  }
  assert.equal(meter.snapshot(now).rate, null);
  meter.endResponse({ usage: usage(200) }, 20);
  const state = meter.snapshot(20);
  // The unmeasurable tokens are not attributed anywhere, not even to the settled response.
  assert.equal(state.tokens.total, 0);
  assert.equal(state.averageRate, null);
  assert.equal(meter.totals.output, 0);
  assert.equal(meter.totals.genMs, 0);
});

test("usage that only reports the starting value is replaced by the estimate while streaming", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  meter.startResponse({ role: "assistant", content: [], usage: usage(1) }, 0);
  for (let i = 1; i <= 20; i += 1) {
    now = i * 100;
    const { event, message } = textDelta(40, 1);
    meter.record(event, message, now);
  }
  const live = meter.snapshot(now);
  // 800 characters over the 1900 ms between the first and the last delta: the counter still
  // shows the start value, so the live average must come from the estimate, not collapse to zero.
  assert.equal(live.tokens.estimated, true);
  assert.equal(live.averageRate, (800 / 4) * 1000 / 1900);
  assert.equal(live.rate.estimated, true);
});

test("settled responses calibrate the tokens-per-character estimate for the session", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  // 150 tokens for 225 characters: dense JSON-like output at 1.5 characters per token.
  meter.startResponse({ role: "assistant", content: [], usage: usage(1) }, 0);
  for (let i = 1; i <= 11; i += 1) {
    now = i * 100;
    meter.record({ type: "toolcall_delta", contentIndex: 0, delta: "x".repeat(22) }, { role: "assistant", content: [], usage: usage(1) }, now);
  }
  meter.endResponse({ usage: usage(150) }, now);
  assert.equal(meter.totals.calibration.toolcall.tokens, 150);
  assert.equal(meter.totals.calibration.toolcall.chars, 242);
  assert.equal(meter.totals.calibration.text.tokens, 0);

  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, now);
  const start = now;
  for (let i = 1; i <= 20; i += 1) {
    now = start + i * 100;
    meter.record({ type: "toolcall_delta", contentIndex: 0, delta: "x".repeat(15) }, { role: "assistant", content: [], usage: usage(0) }, now);
  }
  const state = meter.snapshot(now);
  // 300 characters at the calibrated ~1.61 characters per token (not the default 4) over 1900 ms.
  assert.equal(state.rate.estimated, true);
  assert.equal(state.rate.value, (Math.round(300 / (242 / 150)) * 1000) / 1900);
});

test("a message whose deltas arrive in one burst is measured over its wall-clock time", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  meter.startResponse({ role: "assistant", content: [], usage: usage(1) }, 0);
  // Like the Claude bridge: thinking and text land within milliseconds at the end of the message.
  for (const at of [1800, 1805, 1810]) {
    now = at;
    const { event, message } = textDelta(40, 1);
    meter.record(event, message, now);
  }
  // No live rate can be measured from one burst, and the counter has not moved yet.
  assert.equal(meter.snapshot(1810).rate, null);
  assert.equal(meter.snapshot(1810).averageRate, null);

  meter.endResponse({ usage: usage(189) }, 1860);
  const state = meter.snapshot(1860);
  assert.equal(state.streaming, false);
  assert.equal(state.tokens.total, 189);
  assert.equal(state.averageRate, 189 * 1000 / 1860);
  assert.equal(meter.totals.genMs, 1860);
});

test("ordinary streams keep their measured span even when the message has a long pause", () => {
  let now = 0;
  const meter = new GenerationMeter({ now: () => now });
  meter.startResponse({ role: "assistant", content: [], usage: usage(0) }, 0);
  for (const at of [0, 1000, 2000]) {
    now = at;
    const { event, message } = textDelta(40, at === 2000 ? 100 : 0);
    meter.record(event, message, now);
  }
  // A 6 s pause after the last delta is not generation: the measured span stays 2000 ms.
  meter.endResponse({ usage: usage(100) }, 8000);
  assert.equal(meter.totals.genMs, 2000);
  assert.equal(meter.snapshot(8000).averageRate, 100 * 1000 / 2000);
});
