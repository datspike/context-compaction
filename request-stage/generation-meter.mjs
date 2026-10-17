/**
 * Measures how fast generated tokens arrive at the agent during assistant streams.
 *
 * Token counts come from provider-reported `usage` counters. Providers update them
 * mid-stream at different granularity (Gemini on every chunk, Anthropic in
 * `message_delta`, OpenAI-compatible servers only when they include per-chunk
 * usage), so the meter samples the cumulative counters whenever they change and
 * derives rates from those samples. When a provider reports usage only at the end
 * of the response, the meter falls back to a character estimate and marks it as
 * approximate.
 *
 * Only measurable generation time counts as the denominator: the span between the
 * first and the last delta of every uninterrupted run of same-kind deltas. Tool
 * execution, provider stalls between blocks and the wait before the first token
 * are excluded, so the rate reflects token arrival instead of wall-clock request
 * time. Redacted (encrypted) thinking emits no deltas and is never measured, and
 * tokens that cannot be attributed to a measured window never enter the session
 * average either. Windows shorter than MIN_MEASURED_MS are dropped whole, so a burst of
 * deltas cannot turn a token count into an absurd rate. A usage counter that moved once
 * (Anthropic reports it only at message_delta) is not a rate and falls back to the
 * character estimate, which is calibrated on the session's settled responses.
 *
 * Some bridges deliver a whole text or thinking block in one burst: every delta lands
 * within milliseconds, so the run has no measurable span. When most visible text and
 * reasoning arrived that way and the provider reported usage, the whole message (start to
 * end, which is pure generation) becomes the denominator. Live readings stay empty until
 * the message ends.
 */

const CHARS_PER_TOKEN = 4;
const RATE_WINDOW_MS = 3000;
const MIN_TICK_SPAN_MS = 50;
// A shorter measured span cannot carry a meaningful rate: a few deltas landing within
// milliseconds would turn any token count into thousands of tokens per second.
const MIN_MEASURED_MS = 1000;
// A text or thinking run whose deltas land within this span arrived as one burst.
// Ordinary streams spread deltas over many milliseconds per run.
// A message is treated as bursty only when burst runs carry at least this share of its characters.
const BURST_CHAR_SHARE = 0.5;
// Tokens per character are learned per content kind from settled responses that carry a
// single kind, once this many tokens are known. Code and JSON tokenize far denser than prose,
// so one session-wide ratio misreads the other kind.
const CALIBRATION_MIN_TOKENS = 100;
const CALIBRATION_CHARS_PER_TOKEN_RANGE = [1, 8];

const DELTA_KINDS = {
  text_delta: "text",
  thinking_delta: "thinking",
  toolcall_delta: "toolcall",
};

const END_KINDS = {
  text_end: "text",
  thinking_end: "thinking",
  toolcall_end: "toolcall",
};

export const GENERATION_METER_CHARS_PER_TOKEN = CHARS_PER_TOKEN;


function blockIsRedacted(event, message, measuredChars = 0) {
  const block = message?.content?.[event?.contentIndex];
  if (!block || typeof block !== "object") return false;
  if (block.redacted) return true;
  if (block.thinking || measuredChars > 0 || typeof block.thinkingSignature !== "string") return false;
  try {
    const signature = JSON.parse(block.thinkingSignature);
    return Boolean(signature && typeof signature === "object" && signature.encrypted_content);
  } catch {
    return false;
  }
}

function authoritativeChars(kind, event) {
  if (kind === "toolcall") {
    try {
      return JSON.stringify(event.toolCall?.arguments ?? {}).length;
    } catch {
      return 0;
    }
  }
  return typeof event.content === "string" ? event.content.length : 0;
}

function finiteCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class GenerationMeter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.reset();
  }

  /** Clears session totals and the current response window. */
  reset() {
    this.totals = {
      output: 0, reasoning: 0, genMs: 0, thinkingHidden: false, estimated: false,
      calibration: { text: { chars: 0, tokens: 0 }, thinking: { chars: 0, tokens: 0 }, toolcall: { chars: 0, tokens: 0 } },
    };
    this.clearResponse();
    this.response = null;
  }

  clearResponse() {
    this.samples = [];
    this.run = undefined;
    this.genMs = 0;
    this.genMsByKind = { thinking: 0, text: 0, toolcall: 0 };
    this.blockChars = new Map();
    this.charsByKind = { thinking: 0, text: 0, toolcall: 0 };
    this.measuredCharsByKind = { thinking: 0, text: 0, toolcall: 0 };
    this.thinkingHidden = false;
    this.hiddenThinkingBlocks = new Set();
    this.measuredThinkingBlocks = new Set();
    this.lastSample = undefined;
    this.usageSeen = false;
    this.usageMoves = 0;
    this.lastTickGenMs = Number.NEGATIVE_INFINITY;
    this.burstChars = 0;
    this.lastSettled = undefined;
  }

  /** Starts measuring one assistant response stream. */
  startResponse(message, now = this.now()) {
    this.clearResponse();
    this.response = { startedAt: now };
    const reported = finiteCount(message?.usage?.output);
    this.usageSeen = reported !== undefined && reported > 0;
    this.lastSample = { genMs: 0, output: reported ?? 0, reasoning: finiteCount(message?.usage?.reasoning), chars: 0 };
    this.pushSample(this.lastSample);
  }

  /**
   * Records one normalized assistant stream event (`message_update`) together with
   * the live message snapshot that carries the current `usage` counters.
   */
  record(assistantMessageEvent, message, now = this.now()) {
    if (!this.response) this.startResponse(message, now);
    const event = assistantMessageEvent;
    const type = event && typeof event.type === "string" ? event.type : "";
    const deltaKind = DELTA_KINDS[type];
    if (deltaKind) {
      const hidden = deltaKind === "thinking" && blockIsRedacted(event, message, this.blockChars.get(event.contentIndex)?.chars ?? 0);
      if (hidden) {
        this.thinkingHidden = true;
        this.hiddenThinkingBlocks.add(event.contentIndex);
      } else this.addDelta(deltaKind, event, now);
      this.sampleUsage(message?.usage, now, false);
      this.tick(now);
      return;
    }
    const endKind = END_KINDS[type];
    if (endKind) {
      const hidden = endKind === "thinking" && blockIsRedacted(event, message, this.blockChars.get(event.contentIndex)?.chars ?? 0);
      if (hidden) {
        this.thinkingHidden = true;
        this.hiddenThinkingBlocks.add(event.contentIndex);
      }
      this.closeRun();
      if (!hidden) this.reconcileBlock(endKind, event);
      this.sampleUsage(message?.usage, now, false);
      return;
    }
    this.sampleUsage(message?.usage, now, false);
  }

  /** Character-based token estimate in the tokens-per-character ratio of one content kind. */
  estimateTokens(chars, kind = this.dominantKind()) {
    return Math.round(chars / this.charsPerToken(kind));
  }

  /** The content kind with the most measured characters in the current response. */
  dominantKind() {
    let best = "text";
    for (const kind of ["thinking", "toolcall"]) {
      if (this.measuredCharsByKind[kind] > this.measuredCharsByKind[best]) best = kind;
    }
    return best;
  }

  charsPerToken(kind) {
    const cal = this.totals.calibration[kind];
    if (!cal || cal.tokens < CALIBRATION_MIN_TOKENS || cal.chars <= 0) return CHARS_PER_TOKEN;
    const [low, high] = CALIBRATION_CHARS_PER_TOKEN_RANGE;
    return Math.min(high, Math.max(low, cal.chars / cal.tokens));
  }

  /** Settles the finished response into session totals. */
  endResponse(message, now = this.now()) {
    if (!this.response) return;
    this.closeRun();
    this.sampleUsage(message?.usage, now, true);
    const settled = this.lastSample ?? { output: 0, reasoning: undefined };
    const wallMs = Math.max(0, now - this.response.startedAt);
    const burst = this.isBurstMessage();
    const measuredMs = burst ? wallMs : this.genMs;
    let counted = 0;
    let estimated = false;
    // Session aggregate counts only generation attributable to measured windows.
    // Hidden reasoning has no attributable window; mixed visible/hidden reasoning
    // uses only the visible character estimate and never the aggregate reasoning count.
    if (measuredMs >= MIN_MEASURED_MS) {
      const hidden = this.thinkingHidden;
      const mixedThinking = this.hiddenThinkingBlocks.size > 0 && this.measuredThinkingBlocks.size > 0;
      const hiddenUnknown = hidden && settled.reasoning == null;
      if (mixedThinking || this.totalChars() > this.measuredChars()) {
        counted = this.estimateTokens(this.measuredChars());
        estimated = this.measuredChars() > 0;
      } else if (hidden) {
        counted = hiddenUnknown ? this.estimateTokens(this.measuredChars()) : Math.max(0, settled.output - settled.reasoning);
        estimated = hiddenUnknown;
      } else {
        counted = this.usageSeen ? settled.output : this.estimateTokens(this.measuredChars());
        estimated = !this.usageSeen;
        // Only a response with a single content kind attributes its output tokens to that kind.
        const kinds = ["thinking", "text", "toolcall"].filter((kind) => this.measuredCharsByKind[kind] > 0);
        if (this.usageSeen && settled.output > 0 && kinds.length === 1) {
          const cal = this.totals.calibration[kinds[0]];
          cal.chars += this.measuredChars();
          cal.tokens += settled.output;
        }
      }
      this.totals.output += counted;
      this.totals.reasoning += hidden ? 0 : (settled.reasoning ?? 0);
      this.totals.genMs += measuredMs;
      this.totals.estimated = this.totals.estimated || estimated;
    }
    this.lastSettled = {
      countedTokens: measuredMs >= MIN_MEASURED_MS ? (typeof counted === "number" ? counted : 0) : 0,
      measuredMs,
      estimated: measuredMs >= MIN_MEASURED_MS ? estimated : false,
      thinkingHidden: this.thinkingHidden,
      windows: { ...this.genMsByKind },
    };
    this.totals.thinkingHidden = this.totals.thinkingHidden || this.thinkingHidden;
    this.response = null;
  }

  /** Returns the last response-only contribution after endResponse(). */
  settledSnapshot() {
    return this.lastSettled ? { ...this.lastSettled, windows: { ...this.lastSettled.windows } } : undefined;
  }

  /**
   * A message whose deltas arrived in bursts: measured spans cover too little of its
   * wall-clock time, and the provider's usage counter is the only exact token source.
   */
  isBurstMessage() {
    if (!this.usageSeen || this.thinkingHidden || this.hiddenThinkingBlocks.size > 0) return false;
    const visibleChars = this.charsByKind.text + this.charsByKind.thinking;
    return this.burstChars > 0 && this.burstChars >= visibleChars * BURST_CHAR_SHARE;
  }

  addDelta(kind, event, now) {
    const chars = typeof event.delta === "string" ? event.delta.length : 0;
    if (chars <= 0) return;
    if (this.run && this.run.kind !== kind) this.closeRun();
    if (!this.run) this.run = { kind, start: now, last: now, chars: 0 };
    else this.run.last = now;
    this.run.chars += chars;
    const entry = this.blockChars.get(event.contentIndex) ?? { kind, chars: 0 };
    entry.chars += chars;
    this.blockChars.set(event.contentIndex, entry);
    this.charsByKind[kind] += chars;
    this.measuredCharsByKind[kind] += chars;
    if (kind === "thinking") this.measuredThinkingBlocks.add(event.contentIndex);
  }

  closeRun() {
    if (!this.run) return;
    const span = Math.max(0, this.run.last - this.run.start);
    this.genMs += span;
    this.genMsByKind[this.run.kind] += span;
    if (this.run.kind !== "toolcall" && span < MIN_TICK_SPAN_MS) this.burstChars += this.run.chars;
    this.run = undefined;
  }

  /** Reconciles counted delta characters with the authoritative block length. */
  reconcileBlock(kind, event) {
    const authoritative = authoritativeChars(kind, event);
    if (authoritative <= 0) return;
    const entry = this.blockChars.get(event.contentIndex);
    if (entry) {
      if (authoritative > entry.chars) {
        const delta = authoritative - entry.chars;
        this.charsByKind[kind] += delta;
        this.measuredCharsByKind[kind] += delta;
        entry.chars = authoritative;
      }
      return;
    }
    this.charsByKind[kind] += authoritative;
  }

  genMsNow(now = this.now()) {
    const live = this.run ? Math.max(0, this.run.last - this.run.start) : 0;
    return this.genMs + live;
  }

  totalChars() {
    return this.charsByKind.thinking + this.charsByKind.text + this.charsByKind.toolcall;
  }

  measuredChars() {
    return this.measuredCharsByKind.thinking + this.measuredCharsByKind.text + this.measuredCharsByKind.toolcall;
  }

  sampleUsage(usage, now, force) {
    const output = finiteCount(usage?.output);
    if (output === undefined) return;
    this.usageSeen = this.usageSeen || output > 0;
    const reasoning = finiteCount(usage?.reasoning);
    const first = this.samples[0];
    if (reasoning !== undefined && first?.reasoning == null && first.output === 0) first.reasoning = 0;
    const last = this.lastSample;
    if (last && last.output !== output) this.usageMoves += 1;
    if (!force && last && last.output === output && last.reasoning === reasoning) return;
    const sample = { genMs: this.genMsNow(now), output, reasoning, chars: this.measuredChars() };
    this.lastSample = sample;
    this.pushSample(sample);
  }

  tick(now) {
    const genMs = this.genMsNow(now);
    if (genMs - this.lastTickGenMs < MIN_TICK_SPAN_MS) return;
    if (this.lastSample && this.lastSample.genMs === genMs) return;
    this.lastTickGenMs = genMs;
    this.pushSample({
      genMs,
      output: this.lastSample?.output ?? 0,
      reasoning: this.lastSample?.reasoning,
      chars: this.measuredChars(),
    });
  }

  pushSample(sample) {
    this.samples.push(sample);
    // Keep every sample inside the rate window plus one anchor before it, so a
    // provider with sparse usage updates still has an interval to measure.
    const windowStart = sample.genMs - RATE_WINDOW_MS;
    const firstInWindow = this.samples.findIndex((entry) => entry.genMs >= windowStart);
    if (firstInWindow === -1) {
      this.samples.splice(0, Math.max(0, this.samples.length - 2));
      return;
    }
    if (firstInWindow <= 0) return;
    this.samples.splice(0, firstInWindow - 1);
  }

  /** Instantaneous arrival rate: exact when usage moved, character estimate otherwise. */
  instantRate() {
    if (this.samples.length < 2) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const genMs = last.genMs - first.genMs;
    if (genMs < MIN_MEASURED_MS) return null;
    const dOutput = last.output - first.output;
    const dReasoning = last.reasoning != null && first.reasoning != null ? last.reasoning - first.reasoning : undefined;
    const mixedThinking = this.hiddenThinkingBlocks.size > 0 && this.measuredThinkingBlocks.size > 0;
    const hasUnattributed = mixedThinking || this.totalChars() > this.measuredChars();
    const usageDriven = this.usageMoves >= 2 && !hasUnattributed;
    if (usageDriven && this.thinkingHidden && dReasoning != null) {
      const visibleOutput = dOutput - dReasoning;
      if (visibleOutput > 0) return { value: (visibleOutput * 1000) / genMs, estimated: false };
    } else if (usageDriven && !this.thinkingHidden && dOutput > 0) {
      return { value: (dOutput * 1000) / genMs, estimated: false };
    }
    const dChars = last.chars - first.chars;
    if (dChars > 0) return { value: (this.estimateTokens(dChars) * 1000) / genMs, estimated: true };
    return null;
  }

  snapshot(now = this.now()) {
    const streaming = Boolean(this.response);
    const rate = streaming ? this.instantRate() : null;
    const last = this.lastSample;
    const rawLiveTokens = streaming && last && last.output > 0 ? last.output : undefined;
    const mixedThinking = this.hiddenThinkingBlocks.size > 0 && this.measuredThinkingBlocks.size > 0;
    const hasUnattributed = mixedThinking || this.totalChars() > this.measuredChars();
    const usageLive = this.usageMoves >= 2;
    const liveTokens = hasUnattributed || !usageLive ? undefined : rawLiveTokens;
    const chars = this.measuredChars();
    const currentOutput = streaming ? (liveTokens ?? this.estimateTokens(chars)) : 0;
    const liveMeasured = streaming && this.genMsNow(now) >= MIN_MEASURED_MS;
    const estimated = Boolean(streaming && liveTokens === undefined && chars > 0);
    // In-flight contribution follows the same attribution as the settled one.
    let currentCounted = 0;
    if (liveMeasured) {
      if (mixedThinking) {
        currentCounted = this.estimateTokens(chars);
      } else if (this.thinkingHidden) {
        currentCounted = liveTokens !== undefined && last?.reasoning != null
          ? Math.max(0, currentOutput - last.reasoning)
          : this.estimateTokens(chars);
      } else if (this.totalChars() > this.measuredChars()) {
        currentCounted = this.estimateTokens(chars);
      } else {
        currentCounted = currentOutput;
      }
    }
    const total = this.totals.output + currentCounted;
    const totalGenMs = this.totals.genMs + (liveMeasured ? this.genMsNow(now) : 0);

    let thinking = null;
    let thinkingEstimated = false;
    if (streaming && last?.reasoning != null) {
      thinking = this.totals.reasoning + last.reasoning;
    } else if (streaming && this.charsByKind.thinking > 0 && last?.reasoning == null) {
      thinking = this.totals.reasoning + this.estimateTokens(this.charsByKind.thinking, "thinking");
      thinkingEstimated = true;
    } else if (this.totals.reasoning > 0) {
      thinking = this.totals.reasoning;
    }
    if (thinking === 0 && !this.thinkingHidden) thinking = null;

    return {
      streaming,
      rate,
      averageRate: totalGenMs > 0 ? (total * 1000) / totalGenMs : null,
      averageEstimated: Boolean(this.totals.estimated),
      tokens: {
        total,
        estimated,
        textAndTools: total - (thinking ?? 0),
        thinking,
        thinkingEstimated,
        thinkingHidden: this.thinkingHidden || this.totals.thinkingHidden,
      },
      windows: {
        thinkingMs: this.genMsByKind.thinking,
        textMs: this.genMsByKind.text,
        toolcallMs: this.genMsByKind.toolcall,
        totalMs: this.genMsNow(now),
      },
    };
  }
}
