import type { ContextMode, PolicySource } from "./policy.js";

export const AUDIT_ENTRY = "context-compaction-audit";

export type AuditOrigin = "manual-tool" | "external-unattributed";
export type AuditReason = "manual" | "threshold" | "overflow";
export type AuditPhase = "pending" | "running" | "success" | "error" | "cancel" | "contained" | "continuation-claimed" | "send-attempted";

/** Наблюдаемая append-only запись public lifecycle; это не межрасширенческий протокол. */
export interface AuditEntry {
	version: 2;
	correlation: string;
	origin: AuditOrigin;
	reason: AuditReason;
	phase: AuditPhase;
	tokens: number | null;
	window: number;
	threshold: number | null;
	mode: ContextMode;
	source: PolicySource;
	willRetry: boolean;
	sessionId?: string;
	tree?: string;
}

export type ParsedAudit = { type: "lifecycle"; entry: AuditEntry } | { type: "unknown" };

/** Проверяет только локальный durable discriminant; неизвестные записи безопасно игнорируются. */
export function parseAuditRecord(value: unknown): ParsedAudit {
	if (!value || typeof value !== "object") return { type: "unknown" };
	const record = value as Record<string, unknown>;
	if (record.version === 2 && typeof record.correlation === "string" && typeof record.phase === "string") {
		return { type: "lifecycle", entry: value as AuditEntry };
	}
	return { type: "unknown" };
}

/** Добавляет lifecycle-запись без summary, transcript, raw errors или ledger. */
export function appendAudit(pi: { appendEntry(type: string, data: AuditEntry): void }, entry: AuditEntry): void {
	pi.appendEntry(AUDIT_ENTRY, entry);
}
