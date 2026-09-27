import type { ContextMode } from "./policy.js";

export const MODE_ENTRY = "context-compaction-mode";
export const LEGACY_THRESHOLD_ENTRY = "checkpoint-compact-session-threshold";

export interface ModeEntry {
	mode: ContextMode;
}

/** Восстанавливает последнее допустимое именованное состояние из append-only журнала. */
export function restoreMode(entries: readonly any[]): ContextMode {
	let mode: ContextMode = "economy";
	for (const entry of entries) {
		if (entry?.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
		const candidate = entry.data?.mode;
		if (candidate === "economy" || candidate === "long-once" || candidate === "long-chat" || candidate === "off") {
			mode = candidate;
		}
	}
	return mode;
}

/** Обнаруживает старый порог, не преобразуя и не изменяя журнал. */
export function hasLegacyThreshold(entries: readonly any[]): boolean {
	return entries.some((entry) => entry?.type === "custom" && entry.customType === LEGACY_THRESHOLD_ENTRY);
}

/** Сохраняет только именованный режим в новом append-only типе. */
export function appendMode(pi: { appendEntry(type: string, data: ModeEntry): void }, mode: ContextMode): void {
	pi.appendEntry(MODE_ENTRY, { mode });
}
