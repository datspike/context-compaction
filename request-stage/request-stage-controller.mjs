import { GenerationMeter } from "./generation-meter.mjs";
import { GenerationTelemetry } from "./generation-telemetry.mjs";

const DEFAULT_INTERVAL_MS = 1000;
const COMPACTION_STATUS_KEY = "request-stage-compaction";
// The working message renders as "spinner + text" inside the editor top border and
// is truncated to terminal width minus the border reserve.
const WORKING_SPINNER_WIDTH = 2;
const WORKING_BORDER_RESERVE = 5;
const DEFAULT_WIDTH = 80;

function defaultWidth() {
  const columns = typeof process !== "undefined" ? process.stdout?.columns : undefined;
  return Number.isFinite(columns) && columns > 0 ? columns : DEFAULT_WIDTH;
}

export const REQUEST_STAGE_COMPACTION_STATUS_KEY = COMPACTION_STATUS_KEY;

function getSessionIdentity(ctx) {
  const manager = ctx?.sessionManager;
  if (!manager || typeof manager !== "object") return undefined;
  const id = typeof manager.getSessionId === "function" ? manager.getSessionId() : undefined;
  const file = typeof manager.getSessionFile === "function" ? manager.getSessionFile() : undefined;
  return {
    manager,
    id: typeof id === "string" && id ? id : undefined,
    key: typeof id === "string" && id ? `id:${id}` : typeof file === "string" && file ? `file:${file}` : undefined,
  };
}


function safeName(name) {
  if (typeof name !== "string") return "инструмент";
  const sanitized = name.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 48);
  return sanitized || "инструмент";
}

function formatCompactionReason(reason) {
  switch (reason) {
    case "manual": return "вручную";
    case "threshold": return "по порогу контекста";
    case "overflow": return "после переполнения контекста";
    default: return "операция";
  }
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatRateNumber(value) {
  if (!Number.isFinite(value) || value < 0) return "0";
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

/** Visible width of a plain message: ignore ANSI styling and count code points. */
function visibleLength(text) {
  return [...String(text).replace(/\u001b\[[0-9;]*m/g, "")].length;
}

function truncateToVisibleWidth(text, width) {
  if (width <= 0) return "";
  return [...String(text)].slice(0, width).join("");
}

function assistantContentKinds(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  const kinds = new Set();
  for (const part of content) {
    if (part && typeof part === "object" && typeof part.type === "string") kinds.add(part.type);
  }
  return kinds;
}

function eventTypeName(data) {
  if (!data || typeof data !== "object") return "";
  const value = data.type ?? data.event ?? data.kind;
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isReasoningStreamEvent(data) {
  const type = eventTypeName(data);
  return type.includes("reason") || type.includes("think") || type.includes("analysis");
}

function isTextStreamEvent(data) {
  const type = eventTypeName(data);
  return (type.includes("text") || type.includes("content")) && !isReasoningStreamEvent(data);
}

function isToolStreamEvent(data) {
  const type = eventTypeName(data);
  return type.includes("tool") || type.includes("function_call") || type.includes("tool_call");
}

function isGenerationDelta(event) {
  return Boolean(event && (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
    && typeof event.delta === "string" && event.delta.length > 0);
}

function terminalMessageKind(message) {
  if (!message || message.role !== "assistant") return undefined;
  if (message.stopReason === "aborted") return "cancelled";
  if (message.stopReason === "error") return "error";
  return undefined;
}

function finalMessageKind(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const kind = terminalMessageKind(messages[i]);
    if (kind) return kind;
  }
  return undefined;
}

export class RequestStageController {
  constructor({ now = () => Date.now(), intervalMs = DEFAULT_INTERVAL_MS, onState = () => {}, width = defaultWidth, telemetry = undefined } = {}) {
    this.now = now;
    this.intervalMs = intervalMs;
    this.onState = onState;
    this.meter = new GenerationMeter({ now: this.now });
    this.telemetry = telemetry;
    this.width = width;
    this.owner = undefined;
    this.ui = undefined;
    this.active = false;
    this.startedAt = undefined;
    this.stageStartedAt = undefined;
    this.stage = "idle";
    this.stageDetail = undefined;
    this.activeTools = new Map();
    this.toolStarts = new Map();
    this.responseTelemetry = undefined;
    this.lastRecordedResponse = undefined;
    this.providerWindow = false;
    this.assistantStreamStarted = false;
    this.expectedProvider = undefined;
    this.expectedModel = undefined;
    this.expectedApi = undefined;
    this.lastModelProvider = undefined;
    this.lastModelId = undefined;
    this.generation = 0;
    this.timer = undefined;
    this.lastEmission = "";
    this.compaction = undefined;
  }

  /**
   * Compaction owns the working line until it ends: payload hooks and timer ticks of the
   * surrounding agent run keep their timing, but cannot replace the compact label.
   */
  beginCompaction(ctx, label) {
    this.bindUi(ctx);
    if (!this.isOwned(ctx)) this.adoptSession(ctx);
    const now = this.now();
    this.compaction = { label, startedAt: this.compaction?.startedAt ?? now };
    this.startTimer();
    this.emit(true);
  }

  endCompaction() {
    if (!this.compaction) return;
    this.compaction = undefined;
    if (!this.active) {
      this.stopTimer();
      this.clearUi();
    }
    this.emit(true);
  }

  bindUi(ctx) {
    this.ui = ctx?.ui;
  }

  adoptSession(ctx) {
    this.owner = getSessionIdentity(ctx);
  }

  isOwned(ctx) {
    const current = getSessionIdentity(ctx);
    return Boolean(this.owner && current && current.manager === this.owner.manager);
  }
  captureModel(ctx) {
    const model = ctx?.model;
    if (!model || typeof model !== "object") return;
    const provider = typeof model.provider === "string" ? model.provider : undefined;
    const modelId = typeof model.id === "string" ? model.id : undefined;
    const api = typeof model.api === "string" ? model.api : undefined;
    const changed = (this.lastModelProvider !== undefined && provider !== undefined && this.lastModelProvider !== provider)
      || (this.lastModelId !== undefined && modelId !== undefined && this.lastModelId !== modelId);
    if (changed) this.meter.reset();
    this.lastModelProvider = provider;
    this.lastModelId = modelId;
    this.expectedProvider = provider;
    this.expectedModel = modelId;
    this.expectedApi = api;
  }
  isOwnedProvider(event) {
    if (this.expectedProvider && event?.provider && event.provider !== this.expectedProvider) return false;
    if (this.expectedModel && event?.model && event.model !== this.expectedModel) return false;
    return true;
  }

  start(ctx, stage = "request_sent") {
    this.bindUi(ctx);
    this.captureModel(ctx);
    if (!this.isOwned(ctx)) this.adoptSession(ctx);
    if (!this.active) {
      const startedAt = this.now();
      this.active = true;
      this.startedAt = startedAt;
      this.stageStartedAt = startedAt;
      this.generation += 1;
      this.providerRequestStartedAt = undefined;
      this.responseTelemetry = undefined;
      this.toolStarts.clear();
      this.activeTools.clear();
      this.providerWindow = false;
      this.assistantStreamStarted = false;
      this.startTimer();
    }
    this.setStage(stage);
    this.stageDetail = undefined;
    this.emit();
  }

  startTimer() {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.emit(), this.intervalMs);
    if (typeof this.timer?.unref === "function") this.timer.unref();
  }

  stopTimer() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  setStage(stage, at = this.now()) {
    if (this.stage !== stage || this.stageStartedAt === undefined) this.stageStartedAt = at;
    this.stage = stage;
  }

  /**
   * Right-edge readout of the working line: the current arrival rate (a light
   * sliding-window average) and the session average over measured generation windows.
   */
  rateText(now = this.now()) {
    const state = this.meter.snapshot(now);
    const current = state.streaming ? state.rate : null;
    const average = state.averageRate;
    if (current == null && average == null) return undefined;
    const estimated = Boolean(current?.estimated || state.tokens.estimated || state.averageEstimated);
    let body;
    if (current != null && average != null) body = `${formatRateNumber(current.value)} ток/с (ср. ${formatRateNumber(average)})`;
    else if (current != null) body = `${formatRateNumber(current.value)} ток/с`;
    else body = `ср. ${formatRateNumber(average)} ток/с`;
    return `${estimated ? "≈" : ""}${body}`;
  }

  composeMessage(now = this.now()) {
    if (this.compaction) return `${this.compaction.label} · compact длится ${formatDuration(now - this.compaction.startedAt)}`;
    const stage = this.stageText(now);
    if (stage === undefined) return undefined;
    const rate = this.rateText(now);
    if (rate === undefined) return stage;
    const width = this.width();
    const available = Math.max(0, width - WORKING_BORDER_RESERVE - WORKING_SPINNER_WIDTH);
    const pad = available - visibleLength(stage) - visibleLength(rate);
    if (pad >= 2) return `${stage}${" ".repeat(pad)}${rate}`;
    const separator = " · ";
    const stageWidth = available - visibleLength(rate) - visibleLength(separator);
    if (stageWidth <= 0) return rate;
    return `${truncateToVisibleWidth(stage, stageWidth)}${separator}${rate}`;
  }

  stageText(now = this.now()) {
    if (!this.active || this.startedAt === undefined) return undefined;
    const elapsed = formatDuration(now - this.startedAt);
    const stageElapsed = formatDuration(now - (this.stageStartedAt ?? this.startedAt));
    const activeTiming = `запрос длится ${elapsed} · этап длится ${stageElapsed}`;
    const finalTiming = `запрос длился ${elapsed} · этап длился ${stageElapsed}`;
    switch (this.stage) {
      case "request_sent":
        return `Запрос отправлен · жду содержимое · ${activeTiming}`;
      case "reasoning":
        return `Получаю API-сводку рассуждений · ${activeTiming}`;
      case "prepare_tool":
        return `Подготовка вызова инструмента · ${activeTiming} · инструмент ещё не запущен`;
      case "text_stream":
        return `Поток текста · ${activeTiming}`;
      case "tool_running": {
        const names = [...this.activeTools.values()].map(safeName);
        const label = names.length > 1 ? `${names.slice(0, 3).join(", ")} (${names.length})` : names[0] ?? "инструмент";
        return `Исполняется инструмент: ${label} · ${activeTiming}`;
      }
      case "completed":
        return `Ответ завершён · ожидание следующего шага · ${finalTiming}`;
      case "cancelled":
        return `Отмена · запрос прерван · ${finalTiming}`;
      case "error":
        return `Ответ завершён с ошибкой · ${finalTiming}`;
      default:
        return `Запрос выполняется · ${activeTiming}`;
    }
  }

  emit(force = false) {
    const now = this.now();
    const message = this.composeMessage(now);
    const visible = this.active || Boolean(this.compaction);
    const signature = `${visible ? "1" : "0"}\0${message ?? ""}`;
    if (!force && signature === this.lastEmission) return;
    this.lastEmission = signature;
    this.onState({
      visible,
      message,
      stage: this.stage,
      elapsedMs: this.startedAt === undefined ? 0 : Math.max(0, now - this.startedAt),
      stageElapsedMs: this.stageStartedAt === undefined ? 0 : Math.max(0, now - this.stageStartedAt),
      activeToolCount: this.activeTools.size,
      generation: this.generation,
    }, this.ui);
  }

  startResponseTelemetry(message, now) {
    const sessionId = this.owner?.id;
    const messageId = typeof message?.id === "string" ? message.id : undefined;
    this.responseTelemetry = {
      responseKey: `${sessionId ?? "unknown"}:${messageId ?? `generation-${this.generation}-${now}`}`,
      sessionId, messageId, generation: this.generation,
      providerRequestStartedAt: this.providerRequestStartedAt, startedAt: now,
      firstDeltaAt: undefined, lastDeltaAt: undefined, providerResponseEndAt: undefined,
      lastMessage: message,
      provider: typeof message?.provider === "string" ? message.provider : this.expectedProvider,
      model: typeof message?.model === "string" ? message.model : this.expectedModel,
      api: typeof message?.api === "string" ? message.api : this.expectedApi,
    };
  }

  noteGenerationDelta(event, message, now) {
    if (!this.responseTelemetry) this.startResponseTelemetry(message, now);
    this.responseTelemetry.lastMessage = message;
    if (!isGenerationDelta(event)) return;
    if (this.responseTelemetry.firstDeltaAt === undefined) this.responseTelemetry.firstDeltaAt = now;
    this.responseTelemetry.lastDeltaAt = now;
  }

  finishResponseTelemetry(message, now, complete, reason, meterAlreadySettled = false) {
    const timing = this.responseTelemetry;
    if (!timing || !this.telemetry) return;
    if (!meterAlreadySettled) this.meter.endResponse(message ?? timing.lastMessage, now);
    const settled = this.meter.settledSnapshot();
    const state = this.meter.snapshot(now);
    const finalMessage = message ?? timing.lastMessage;
    const providerEnd = timing.providerResponseEndAt;
    const firstWait = timing.providerRequestStartedAt != null && timing.firstDeltaAt != null
      ? Math.max(0, timing.firstDeltaAt - timing.providerRequestStartedAt) : null;
    const betweenWait = timing.firstDeltaAt != null && timing.lastDeltaAt != null && settled
      ? Math.max(0, timing.lastDeltaAt - timing.firstDeltaAt - settled.measuredMs) : null;
    const tailWait = timing.lastDeltaAt != null && providerEnd != null
      ? Math.max(0, providerEnd - timing.lastDeltaAt) : null;
    const waits = [firstWait, betweenWait, tailWait];
    const apiWaitTotal = waits.every((value) => value != null) ? waits.reduce((sum, value) => sum + value, 0) : null;
    const countedTokens = settled?.countedTokens ?? 0;
    const generationMs = settled?.measuredMs ?? 0;
    this.telemetry.writeResponse({
      responseKey: timing.responseKey, sessionId: timing.sessionId, messageId: timing.messageId, generation: timing.generation,
      provider: timing.provider, model: timing.model, api: timing.api, startedAt: timing.startedAt,
      firstDeltaAt: timing.firstDeltaAt, lastDeltaAt: timing.lastDeltaAt, providerResponseEndAt: providerEnd, endedAt: now,
      providerRequestMs: timing.providerRequestStartedAt == null || providerEnd == null ? null : Math.max(0, providerEnd - timing.providerRequestStartedAt),
      responseElapsedMs: Math.max(0, now - timing.startedAt), providerElapsedMs: timing.providerRequestStartedAt == null || providerEnd == null ? null : Math.max(0, providerEnd - timing.providerRequestStartedAt),
      outputTokens: finalMessage?.usage?.output, reasoningTokens: finalMessage?.usage?.reasoning, countedTokens, generationMsTotal: generationMs,
      generationMsThinking: settled?.windows?.thinking ?? state.windows.thinkingMs, generationMsText: settled?.windows?.text ?? state.windows.textMs,
      generationMsToolcall: settled?.windows?.toolcall ?? state.windows.toolcallMs,
      generationRate: generationMs > 0 ? countedTokens * 1000 / generationMs : null, averageRate: state.averageRate,
      apiWaitBeforeFirstTokenMs: firstWait, apiWaitBetweenGenerationWindowsMs: betweenWait, apiWaitAfterLastTokenMs: tailWait, apiWaitTotalMs: apiWaitTotal,
      stopReason: reason ?? finalMessage?.stopReason, complete, estimated: settled?.estimated, thinkingHidden: settled?.thinkingHidden,
      flags: { missingProviderRequest: timing.providerRequestStartedAt == null, missingFirstGenerationDelta: timing.firstDeltaAt == null, missingLastGenerationDelta: timing.lastDeltaAt == null, missingProviderResponseEnd: timing.providerResponseEndAt == null, incompleteReason: complete ? undefined : "controller_reset" },
    });
    this.lastRecordedResponse = { responseKey: timing.responseKey, lastDeltaAt: timing.lastDeltaAt };
    this.responseTelemetry = undefined;
  }

  recordToolStart(event, now) {
    const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : `tool-${now}`;
    this.toolStarts.set(toolCallId, { startedAt: now, toolCallId, toolName: safeName(event?.toolName) });
  }

  recordToolEnd(event, now) {
    const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : undefined;
    const started = toolCallId ? this.toolStarts.get(toolCallId) : undefined;
    if (!started || !this.telemetry) return;
    this.telemetry.writeTool({ toolKey: `${this.owner?.id ?? "unknown"}:${toolCallId}:${started.startedAt}`, sessionId: this.owner?.id, toolCallId, toolName: started.toolName, startedAt: started.startedAt, endedAt: now, durationMs: Math.max(0, now - started.startedAt), complete: true, isError: event?.isError });
    this.toolStarts.delete(toolCallId);
  }

  flushOpenTools(now) {
    if (!this.telemetry) return;
    for (const started of this.toolStarts.values()) {
      this.telemetry.writeTool({ toolKey: `${this.owner?.id ?? "unknown"}:${started.toolCallId}:${started.startedAt}`, sessionId: this.owner?.id, toolCallId: started.toolCallId, toolName: started.toolName, startedAt: started.startedAt, endedAt: now, durationMs: Math.max(0, now - started.startedAt), complete: false });
    }
    this.toolStarts.clear();
  }

  clearUi() {
    const ui = this.ui;
    if (!ui) return;
    try {
      ui.setStatus?.(COMPACTION_STATUS_KEY, undefined);
      ui.setWorkingMessage?.();
      ui.setWorkingVisible?.(false);
    } catch {
      // Session replacement/reload can invalidate the old UI context.
    }
  }

  reset({ clearUi = true } = {}) {
    const now = this.now();
    if (this.responseTelemetry) this.finishResponseTelemetry(undefined, now, false, "controller_reset");
    this.flushOpenTools(now);
    this.stopTimer();
    this.active = false;
    this.startedAt = undefined;
    this.stageStartedAt = undefined;
    this.stage = "idle";
    this.stageDetail = undefined;
    this.activeTools.clear();
    this.providerWindow = false;
    this.assistantStreamStarted = false;
    this.expectedProvider = undefined;
    this.expectedModel = undefined;
    this.expectedApi = undefined;
    this.providerRequestStartedAt = undefined;
    this.responseTelemetry = undefined;
    this.lastRecordedResponse = undefined;
    this.lastEmission = "";
    this.compaction = undefined;
    if (clearUi) this.clearUi();
    this.emit(true);
  }

  finish(stage) {
    if (!this.active) return;
    this.setStage(stage);
    this.emit(true);
    if (!this.compaction) this.stopTimer();
  }

  updateCompactionStatus(ctx, text) {
    this.bindUi(ctx);
    if (!this.ui?.setStatus) return;
    try {
      this.ui.setStatus(COMPACTION_STATUS_KEY, text);
    } catch {
      // UI may be invalid during session replacement.
    }
  }

  handle(event, ctx) {
    this.bindUi(ctx);
    if (!event || typeof event.type !== "string") return;
    const type = event.type;

    if (type === "session_start") {
      this.reset();
      this.meter.reset();
      this.adoptSession(ctx);
      return;
    }
    if (type === "session_shutdown") {
      this.reset();
      this.meter.reset();
      this.owner = undefined;
      this.ui = undefined;
      return;
    }
    if (type === "before_agent_start") {
      if (!this.isOwned(ctx)) {
        // A real session switch without session_start: session totals must not leak.
        if (this.owner) this.meter.reset();
        this.reset();
      }
      this.adoptSession(ctx);
      this.start(ctx);
      return;
    }
    if (type === "agent_start") {
      if (!this.isOwned(ctx)) {
        if (this.owner) this.meter.reset();
        this.reset();
      }
      this.start(ctx);
      return;
    }
    if (!this.isOwned(ctx)) return;

    if (type === "session_before_compact") {
      if (this.active) {
        this.setStage("request_sent");
        this.emit(true);
      }
      const reason = typeof event.reason === "string" ? event.reason : "операция";
      this.updateCompactionStatus(ctx, `Сжатие контекста · причина: ${formatCompactionReason(reason)}`);
      return;
    }
    if (type === "session_compact") {
      this.compaction = undefined;
      try { ctx?.ui?.setStatus?.(COMPACTION_STATUS_KEY, undefined); } catch {}
      if (event.willRetry) this.start(ctx, "request_sent");
      else if (!this.active) this.reset();
      else this.setStage("request_sent");
      this.emit(true);
      return;
    }
    if (type === "session_compact_failed") {
      this.compaction = undefined;
      try { ctx?.ui?.setStatus?.(COMPACTION_STATUS_KEY, undefined); } catch {}
      if (event.willRetry) this.start(ctx, "request_sent");
      else if (this.active) this.finish(event.aborted ? "cancelled" : "error");
      else this.reset();
      return;
    }
    if (!this.active) return;

    if (type === "turn_start") {
      this.providerWindow = false;
      this.setStage("request_sent");
      this.emit(true);
      return;
    }
    if (type === "before_provider_request") {
      this.captureModel(ctx);
      this.providerRequestStartedAt = this.now();
      this.providerWindow = true;
      this.setStage("request_sent");
      this.emit(true);
      return;
    }
    if (type === "after_provider_response") {
      const providerResponseEnd = this.now();
      if (this.responseTelemetry) this.responseTelemetry.providerResponseEndAt = providerResponseEnd;
      else if (this.lastRecordedResponse && this.telemetry) this.telemetry.updateResponseProviderEnd(this.lastRecordedResponse.responseKey, providerResponseEnd, this.lastRecordedResponse.lastDeltaAt);
      this.providerWindow = true;
      return;
    }
    if (type === "message_start" && event.message?.role === "assistant") {
      this.expectedProvider = typeof event.message.provider === "string" ? event.message.provider : this.expectedProvider;
      this.expectedModel = typeof event.message.model === "string" ? event.message.model : this.expectedModel;
      this.expectedApi = typeof event.message.api === "string" ? event.message.api : this.expectedApi;
      this.providerWindow = true;
      this.assistantStreamStarted = true;
      const now = this.now();
      this.meter.startResponse(event.message, now);
      if (this.telemetry) this.startResponseTelemetry(event.message, now);
      this.setStage("reasoning");
      this.emit(true);
      return;
    }
    if (type === "message_update" && event.message?.role === "assistant") {
      const now = this.now();
      this.meter.record(event.assistantMessageEvent, event.message, now);
      if (this.telemetry) this.noteGenerationDelta(event.assistantMessageEvent, event.message, now);
      const kinds = assistantContentKinds(event.message);
      if (kinds.has("toolCall")) this.setStage("prepare_tool");
      else if (kinds.has("text")) this.setStage("text_stream");
      else if (kinds.has("thinking")) this.setStage("reasoning");
      this.emit(true);
      return;
    }
    if (type === "provider_stream_event") {
      if (!this.assistantStreamStarted || this.activeTools.size > 0 || !this.isOwnedProvider(event)) return;
      if (isToolStreamEvent(event.data)) this.setStage("prepare_tool");
      else if (isReasoningStreamEvent(event.data)) this.setStage("reasoning");
      else if (isTextStreamEvent(event.data)) this.setStage("text_stream");
      this.emit(true);
      return;
    }
    if (type === "tool_call") {
      this.providerWindow = false;
      this.setStage("prepare_tool");
      this.emit(true);
      return;
    }
    if (type === "tool_execution_start") {
      this.providerWindow = false;
      this.activeTools.set(event.toolCallId, safeName(event.toolName));
      this.recordToolStart(event, this.now());
      this.setStage("tool_running");
      this.emit(true);
      return;
    }
    if (type === "tool_execution_end") {
      this.activeTools.delete(event.toolCallId);
      this.recordToolEnd(event, this.now());
      if (this.activeTools.size > 0) this.setStage("tool_running");
      else this.setStage("request_sent");
      this.emit(true);
      return;
    }
    if (type === "message_end" && event.message?.role === "assistant") {
      const now = this.now();
      this.meter.endResponse(event.message, now);
      if (this.telemetry) this.finishResponseTelemetry(event.message, now, true, undefined, true);
      this.providerWindow = false;
      this.assistantStreamStarted = false;
      const terminal = terminalMessageKind(event.message);
      if (terminal) this.setStage(terminal);
      else if (assistantContentKinds(event.message).has("toolCall")) this.setStage("prepare_tool");
      else this.setStage("completed");
      this.emit(true);
      return;
    }
    if (type === "turn_end") {
      if (this.activeTools.size === 0) this.setStage("completed");
      this.emit(true);
      return;
    }
    if (type === "agent_end") {
      if (this.responseTelemetry) {
        const messages = Array.isArray(event.messages) ? event.messages : [];
        const message = [...messages].reverse().find((item) => item?.role === "assistant") ?? this.responseTelemetry.lastMessage;
        const now = this.now();
        this.meter.endResponse(message, now);
        if (this.telemetry) this.finishResponseTelemetry(message, now, false, terminalMessageKind(message), true);
      }
      const terminal = finalMessageKind(event.messages);
      if (terminal) this.setStage(terminal);
      else if (event.willContinue !== true) this.setStage("completed");
      this.emit(true);
      return;
    }
    if (type === "agent_settled") {
      this.reset();
    }
  }
}

export function formatRequestStageDuration(milliseconds) {
  return formatDuration(milliseconds);
}

export function classifyProviderStreamEvent(data) {
  if (isToolStreamEvent(data)) return "prepare_tool";
  if (isReasoningStreamEvent(data)) return "reasoning";
  if (isTextStreamEvent(data)) return "text_stream";
  return undefined;
}
