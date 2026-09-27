export type ContextMode = "economy" | "long-once" | "long-chat" | "off";
export type PolicySource = "exact-registry" | "fallback" | "off";

export interface ModelIdentity {
	provider?: string;
	id?: string;
	contextWindow?: number;
}

export interface ContextPolicy {
	mode: ContextMode;
	window: number;
	threshold: number | undefined;
	source: PolicySource;
	longOnceAvailable: boolean;
	longChatAvailable: boolean;
}

export const ECONOMY_WINDOW = 272_000;
export const ECONOMY_THRESHOLD = 256_000;
export const LONG_ONCE_WINDOW = 372_000;
export const LONG_ONCE_THRESHOLD = 356_000;
export const LONG_CHAT_MINIMUM = 500_000;
export const LONG_CHAT_MAXIMUM = 600_000;
export const COMPACTION_RESERVE = 16_000;

/** Нормализует объявленное или фактическое окно только для расчётов policy. */
function validWindow(value: number | undefined): number | undefined {
	return Number.isFinite(value) && (value ?? 0) > 0 ? Math.round(value!) : undefined;
}

/** Вычисляет именованную policy по capability точной registry-пары. */
export function resolvePolicy(
	mode: ContextMode,
	model: ModelIdentity | undefined,
	declaredWindow?: number,
): ContextPolicy {
	const registryWindow = validWindow(declaredWindow);
	const actualWindow = validWindow(model?.contextWindow) ?? 0;
	const source: PolicySource = registryWindow === undefined ? "fallback" : "exact-registry";
	const baseWindow = registryWindow ?? actualWindow;
	const economyWindow = registryWindow === undefined ? actualWindow : Math.min(ECONOMY_WINDOW, registryWindow);
	const economyThreshold = economyWindow === ECONOMY_WINDOW
		? ECONOMY_THRESHOLD
		: economyWindow > 0 ? Math.floor(economyWindow * 0.75) : undefined;
	const longOnceWindow = registryWindow === undefined ? undefined : Math.min(LONG_ONCE_WINDOW, registryWindow);
	const longChatWindow = registryWindow === undefined ? undefined : Math.min(LONG_CHAT_MAXIMUM, registryWindow);
	const longOnceAvailable = longOnceWindow !== undefined && longOnceWindow > economyWindow;
	const longChatAvailable = longChatWindow !== undefined && longChatWindow > economyWindow;

	if (mode === "off") {
		return { mode, window: baseWindow, threshold: undefined, source: "off", longOnceAvailable, longChatAvailable };
	}
	if (mode === "long-once" && longOnceAvailable) {
		return { mode, window: longOnceWindow!, threshold: longOnceWindow! - COMPACTION_RESERVE, source, longOnceAvailable, longChatAvailable };
	}
	if (mode === "long-chat" && longChatAvailable) {
		return { mode, window: longChatWindow!, threshold: longChatWindow! - COMPACTION_RESERVE, source, longOnceAvailable, longChatAvailable };
	}
	return { mode: "economy", window: economyWindow, threshold: economyThreshold, source, longOnceAvailable, longChatAvailable };
}

export function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
	return `${Math.round(tokens / 1_000)}K`;
}

/** Формирует единственный индикатор заполнения фактического окна. */
export function formatFooter(tokens: number | null | undefined, policy: ContextPolicy): string {
	const usage = tokens === null || tokens === undefined ? "?" : formatTokenCount(tokens);
	const percent = tokens === null || tokens === undefined || policy.window <= 0
		? "?"
		: (tokens / policy.window * 100).toFixed(1);
	const threshold = policy.threshold === undefined ? "off" : formatTokenCount(policy.threshold);
	return `ctx ${usage}/${formatTokenCount(policy.window)} ${percent}% · compact@${threshold} · ${policy.mode}`;
}
