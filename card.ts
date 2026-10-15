import { Text } from "@earendil-works/pi-tui";

/** Карточка итога compact: сохраняется в сессии после compaction и рисуется в ленте Pi. */
export const COMPACT_CARD_TYPE = "context-compaction-card";

export type CompactCardKind = "append" | "standard";

export interface CompactCardUsage {
	input?: number;
	cacheRead?: number;
	cost?: { total?: number };
}

export interface CompactCardData {
    version: 2;
    kind: CompactCardKind;
    /** Причина отказа append, из-за которой выполнен обычный compact. */
    fallbackReason?: string;
    trigger?: string;
    provider?: string;
    model?: string;
    tokensBefore?: number;
    /** Оценка размера summary в токенах; хвост контекста сюда не входит. */
    summaryTokens?: number;
    /** Время standard compact; appendDurationMs остаётся отдельным. */
    durationMs?: number;
    appendDurationMs?: number;
    appendUsage?: CompactCardUsage;
    appendCacheStatus?: string;
    repairAttempts?: number;
    usage?: CompactCardUsage;
}

export interface CompactCardText {
	line: string;
	details: string[];
	/** warning: fallback или cache miss; иначе обычный цвет. */
	tone: "normal" | "warning";
}

function tokens(value: number | undefined, approximate = false): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "?";
	const text = value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
	return approximate ? `~${text}` : text;
}

/** Оценка токенов summary: ~4 символа на токен. */
export function estimateSummaryTokens(summary: unknown): number | undefined {
	return typeof summary === "string" ? Math.ceil(summary.length / 4) : undefined;
}

export function formatCompactCard(data: CompactCardData, language: "ru" | "en"): CompactCardText {
    const ru = language === "ru";
    const usage = data.usage;
    const appendUsage = data.appendUsage;
    const cacheRead = usage?.cacheRead;
    const numericCacheRead = typeof cacheRead === "number";
    const input = (usage?.input ?? 0) + (numericCacheRead ? cacheRead : 0);
    const hasUsage = Boolean(usage) && input > 0;
    const cacheShare = hasUsage && numericCacheRead ? Math.round((cacheRead / input) * 100) : undefined;
    const derivedAppendCacheStatus = data.kind === "append" && numericCacheRead ? (cacheRead > 0 ? "hit" : "miss") : undefined;
    const appendCacheStatus = data.appendCacheStatus ?? derivedAppendCacheStatus;
    const cache = data.kind === "append" && appendCacheStatus && appendCacheStatus !== "not-attempted" ? appendCacheStatus === "hit" && cacheShare !== undefined ? `cache hit ${cacheShare}%` : `cache ${appendCacheStatus}` : undefined;
    const duration = typeof data.durationMs === "number" ? `${(data.durationMs / 1000).toFixed(1)} s` : undefined;
    const costValue = usage?.cost?.total;
    const cost = typeof costValue === "number" ? `$${costValue.toFixed(4)}` : undefined;
    const appendCost = appendUsage?.cost?.total;
    const appendCostText = typeof appendCost === "number" ? `append $${appendCost.toFixed(4)}` : appendCacheStatus === "not-attempted" ? "append $0.0000" : appendCacheStatus ? "append unknown" : undefined;
    const fallback = data.fallbackReason !== undefined;
    const label = data.kind === "append" ? "append compact" : fallback ? `standard compact · append fallback (${data.fallbackReason})` : "standard compact";
    const size = `${tokens(data.tokensBefore)} → summary ${tokens(data.summaryTokens, true)}`;
    const line = ["◆ " + label, cache, size, duration, cost, fallback ? appendCostText : undefined].filter(Boolean).join(" · ");
    const details: string[] = [];
    details.push(`${ru ? "тип" : "type"}: ${data.kind}${data.trigger ? ` · ${data.trigger}` : ""}`);
    if (data.provider || data.model) details.push(`${ru ? "модель" : "model"}: ${[data.provider, data.model].filter(Boolean).join("/")}`);
    if (fallback) details.push(`${ru ? "причина fallback" : "fallback reason"}: ${data.fallbackReason}`);
    details.push(`${ru ? "контекст" : "context"}: ${tokens(data.tokensBefore)} → summary ${tokens(data.summaryTokens, true)} (${ru ? "хвост не учтён" : "kept tail not counted"})`);
    if (hasUsage) details.push(`cache: read ${tokens(cacheRead)} / input ${tokens(input)}${cacheShare !== undefined ? ` (${cacheShare}%)` : ""}`);
    else if (data.kind === "append" && appendCacheStatus && appendCacheStatus !== "not-attempted") details.push(`cache: ${appendCacheStatus}`);
    if (duration) details.push(`${ru ? "время" : "time"}: ${duration}${data.repairAttempts ? ` · repair ${data.repairAttempts}` : ""}`);
    if (typeof data.appendDurationMs === "number") details.push(`${ru ? "append время" : "append time"}: ${(data.appendDurationMs / 1000).toFixed(1)} s${appendCacheStatus ? ` · cache ${appendCacheStatus}` : ""}`);
    if (appendCostText) details.push(`${ru ? "append стоимость" : "append cost"}: ${appendCostText}`);
    if (cost) details.push(`${ru ? "стоимость" : "cost"}: ${cost}`);
    const tone = fallback || (data.kind === "append" && appendCacheStatus === "miss") ? "warning" : "normal";
    return { line, details, tone };
}

/** Компонент ленты Pi: свёрнутая строка или строка с подробностями при раскрытии. */
export function renderCompactCard(data: CompactCardData, expanded: boolean, theme: { fg(color: string, text: string): string }, language: "ru" | "en"): Text {
	const card = formatCompactCard(data, language);
	const lines = [theme.fg(card.tone === "warning" ? "warning" : "accent", card.line), ...(expanded ? card.details.map((detail) => theme.fg("dim", `  ${detail}`)) : [])];
	return new Text(lines.join("\n"), 1, 0);
}
