import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export const GENERATION_TELEMETRY_VERSION = "1";

// The database stays in the Pi profile, where request-stage kept it, so history survives the move into this package.
// Loaded on first use: runtimes without node:sqlite (Bun in the test runner) disable telemetry instead of failing to load the extension.
const require = createRequire(import.meta.url);

const DEFAULT_DATABASE_PATH = defaultGenerationTelemetryPath();

function nullableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jsonFlags(value) {
  if (!value || typeof value !== "object") return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

export class GenerationTelemetry {
  constructor({ databasePath = DEFAULT_DATABASE_PATH, now = () => Date.now() } = {}) {
    this.databasePath = databasePath;
    this.now = now;
    this.db = undefined;
    this.responseStatement = undefined;
    this.toolStatement = undefined;
    this.updateResponseStatement = undefined;
    this.disabled = false;
  }

  open() {
    if (this.db || this.disabled) return this.db;
    try {
      mkdirSync(dirname(this.databasePath), { recursive: true });
      const { DatabaseSync } = require("node:sqlite");
      this.db = new DatabaseSync(this.databasePath);
      this.db.exec(`
        PRAGMA busy_timeout = 1000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS responses (
          response_key TEXT PRIMARY KEY,
          session_id TEXT,
          message_id TEXT,
          generation INTEGER,
          provider TEXT,
          model TEXT,
          api TEXT,
          started_at_utc TEXT NOT NULL,
          first_delta_at_utc TEXT,
          last_delta_at_utc TEXT,
          provider_response_end_at_utc TEXT,
          ended_at_utc TEXT NOT NULL,
          provider_request_ms INTEGER,
          response_elapsed_ms INTEGER,
          provider_elapsed_ms INTEGER,
          output_tokens REAL,
          reasoning_tokens REAL,
          counted_tokens REAL,
          generation_ms_total INTEGER,
          generation_ms_thinking INTEGER,
          generation_ms_text INTEGER,
          generation_ms_toolcall INTEGER,
          generation_rate REAL,
          average_rate REAL,
          api_wait_before_first_token_ms INTEGER,
          api_wait_between_generation_windows_ms INTEGER,
          api_wait_after_last_token_ms INTEGER,
          api_wait_total_ms INTEGER,
          stop_reason TEXT,
          complete INTEGER NOT NULL,
          estimated INTEGER NOT NULL,
          thinking_hidden INTEGER NOT NULL,
          flags_json TEXT NOT NULL,
          measurement_version TEXT NOT NULL,
          recorded_at_utc TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS responses_model_time
          ON responses(model, started_at_utc);
        CREATE INDEX IF NOT EXISTS responses_session_message
          ON responses(session_id, message_id);
        CREATE TABLE IF NOT EXISTS tool_executions (
          tool_key TEXT PRIMARY KEY,
          session_id TEXT,
          tool_call_id TEXT,
          tool_name TEXT,
          started_at_utc TEXT NOT NULL,
          ended_at_utc TEXT,
          duration_ms INTEGER,
          complete INTEGER NOT NULL,
          is_error INTEGER,
          recorded_at_utc TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS tool_executions_session_time
          ON tool_executions(session_id, started_at_utc);
      `);
      this.responseStatement = this.db.prepare(`
        INSERT OR IGNORE INTO responses (
          response_key, session_id, message_id, generation, provider, model, api,
          started_at_utc, first_delta_at_utc, last_delta_at_utc,
          provider_response_end_at_utc, ended_at_utc, provider_request_ms,
          response_elapsed_ms, provider_elapsed_ms, output_tokens, reasoning_tokens,
          counted_tokens, generation_ms_total, generation_ms_thinking,
          generation_ms_text, generation_ms_toolcall, generation_rate, average_rate,
          api_wait_before_first_token_ms, api_wait_between_generation_windows_ms,
          api_wait_after_last_token_ms, api_wait_total_ms, stop_reason, complete,
          estimated, thinking_hidden, flags_json, measurement_version, recorded_at_utc
        ) VALUES (
          :response_key, :session_id, :message_id, :generation, :provider, :model, :api,
          :started_at_utc, :first_delta_at_utc, :last_delta_at_utc,
          :provider_response_end_at_utc, :ended_at_utc, :provider_request_ms,
          :response_elapsed_ms, :provider_elapsed_ms, :output_tokens, :reasoning_tokens,
          :counted_tokens, :generation_ms_total, :generation_ms_thinking,
          :generation_ms_text, :generation_ms_toolcall, :generation_rate, :average_rate,
          :api_wait_before_first_token_ms, :api_wait_between_generation_windows_ms,
          :api_wait_after_last_token_ms, :api_wait_total_ms, :stop_reason, :complete,
          :estimated, :thinking_hidden, :flags_json, :measurement_version, :recorded_at_utc
        )
      `);
      this.toolStatement = this.db.prepare(`
        INSERT OR IGNORE INTO tool_executions (
          tool_key, session_id, tool_call_id, tool_name, started_at_utc,
          ended_at_utc, duration_ms, complete, is_error, recorded_at_utc
        ) VALUES (
          :tool_key, :session_id, :tool_call_id, :tool_name, :started_at_utc,
          :ended_at_utc, :duration_ms, :complete, :is_error, :recorded_at_utc
        )
      `);
      this.updateResponseStatement = this.db.prepare(`
        UPDATE responses
        SET provider_response_end_at_utc = :provider_response_end_at_utc,
            api_wait_after_last_token_ms = :api_wait_after_last_token_ms,
            api_wait_total_ms = CASE
              WHEN api_wait_before_first_token_ms IS NOT NULL
               AND api_wait_between_generation_windows_ms IS NOT NULL
               AND :api_wait_after_last_token_ms IS NOT NULL
              THEN api_wait_before_first_token_ms + api_wait_between_generation_windows_ms + :api_wait_after_last_token_ms
              ELSE NULL
            END,
            provider_request_ms = CASE
              WHEN started_at_utc IS NOT NULL THEN CAST((julianday(:provider_response_end_at_utc) - julianday(started_at_utc)) * 86400000 AS INTEGER)
              ELSE provider_request_ms
            END,
            provider_elapsed_ms = CASE
              WHEN started_at_utc IS NOT NULL THEN CAST((julianday(:provider_response_end_at_utc) - julianday(started_at_utc)) * 86400000 AS INTEGER)
              ELSE provider_elapsed_ms
            END,
            flags_json = json_set(flags_json, '$.missingProviderResponseEnd', false)
        WHERE response_key = :response_key
      `);
      return this.db;
    } catch {
      this.disabled = true;
      this.db = undefined;
      return undefined;
    }
  }

  writeResponse(record) {
    if (!record || !this.open()) return false;
    try {
      this.responseStatement.run({
        response_key: String(record.responseKey),
        session_id: nullableString(record.sessionId),
        message_id: nullableString(record.messageId),
        generation: nullableNumber(record.generation),
        provider: nullableString(record.provider),
        model: nullableString(record.model),
        api: nullableString(record.api),
        started_at_utc: new Date(record.startedAt).toISOString(),
        first_delta_at_utc: record.firstDeltaAt == null ? null : new Date(record.firstDeltaAt).toISOString(),
        last_delta_at_utc: record.lastDeltaAt == null ? null : new Date(record.lastDeltaAt).toISOString(),
        provider_response_end_at_utc: record.providerResponseEndAt == null ? null : new Date(record.providerResponseEndAt).toISOString(),
        ended_at_utc: new Date(record.endedAt).toISOString(),
        provider_request_ms: nullableNumber(record.providerRequestMs),
        response_elapsed_ms: nullableNumber(record.responseElapsedMs),
        provider_elapsed_ms: nullableNumber(record.providerElapsedMs),
        output_tokens: nullableNumber(record.outputTokens),
        reasoning_tokens: nullableNumber(record.reasoningTokens),
        counted_tokens: nullableNumber(record.countedTokens),
        generation_ms_total: nullableNumber(record.generationMsTotal),
        generation_ms_thinking: nullableNumber(record.generationMsThinking),
        generation_ms_text: nullableNumber(record.generationMsText),
        generation_ms_toolcall: nullableNumber(record.generationMsToolcall),
        generation_rate: nullableNumber(record.generationRate),
        average_rate: nullableNumber(record.averageRate),
        api_wait_before_first_token_ms: nullableNumber(record.apiWaitBeforeFirstTokenMs),
        api_wait_between_generation_windows_ms: nullableNumber(record.apiWaitBetweenGenerationWindowsMs),
        api_wait_after_last_token_ms: nullableNumber(record.apiWaitAfterLastTokenMs),
        api_wait_total_ms: nullableNumber(record.apiWaitTotalMs),
        stop_reason: nullableString(record.stopReason),
        complete: record.complete ? 1 : 0,
        estimated: record.estimated ? 1 : 0,
        thinking_hidden: record.thinkingHidden ? 1 : 0,
        flags_json: jsonFlags(record.flags),
        measurement_version: GENERATION_TELEMETRY_VERSION,
        recorded_at_utc: new Date(this.now()).toISOString(),
      });
      return true;
    } catch {
      return false;
    }
  }

  updateResponseProviderEnd(responseKey, providerResponseEndAt, lastDeltaAt) {
    if (!responseKey || lastDeltaAt == null || !this.open()) return false;
    try {
      const tailWait = Math.max(0, providerResponseEndAt - lastDeltaAt);
      this.updateResponseStatement.run({
        response_key: String(responseKey),
        provider_response_end_at_utc: new Date(providerResponseEndAt).toISOString(),
        api_wait_after_last_token_ms: tailWait,
      });
      return true;
    } catch {
      return false;
    }
  }

  writeTool(record) {
    if (!record || !this.open()) return false;
    try {
      this.toolStatement.run({
        tool_key: String(record.toolKey),
        session_id: nullableString(record.sessionId),
        tool_call_id: nullableString(record.toolCallId),
        tool_name: nullableString(record.toolName),
        started_at_utc: new Date(record.startedAt).toISOString(),
        ended_at_utc: record.endedAt == null ? null : new Date(record.endedAt).toISOString(),
        duration_ms: nullableNumber(record.durationMs),
        complete: record.complete ? 1 : 0,
        is_error: record.isError == null ? null : (record.isError ? 1 : 0),
        recorded_at_utc: new Date(this.now()).toISOString(),
      });
      return true;
    } catch {
      return false;
    }
  }

  close() {
    try { this.db?.close(); } catch {}
    this.db = undefined;
    this.responseStatement = undefined;
    this.toolStatement = undefined;
    this.updateResponseStatement = undefined;
  }
}

export function defaultGenerationTelemetryPath(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) {
  return join(agentDir, "telemetry", "generation.sqlite");
}
