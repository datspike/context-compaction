import { expect, test } from "bun:test";
import { estimateSummaryTokens, formatCompactCard, renderCompactCard } from "./card.js";

const theme = { fg: (_color: string, text: string) => text };

test("append hit card shows type, cache share, size, time and cost", () => {
    const card = formatCompactCard({ version: 2, kind: "append", trigger: "manual", provider: "openai", model: "gpt-5.6-luna", tokensBefore: 258_796, summaryTokens: 4_100, durationMs: 12_345, usage: { input: 21_000, cacheRead: 237_000, cost: { total: 0.0208 } } }, "ru");
	expect(card.line).toBe("◆ append compact · cache hit 92% · 258.8k → summary ~4.1k · 12.3 s · $0.0208");
	expect(card.tone).toBe("normal");
	expect(card.details).toContain("модель: openai/gpt-5.6-luna");
	expect(card.details).toContain("cache: read 237.0k / input 258.0k (92%)");
});

test("cache miss and fallback are warnings; fallback names the reason", () => {
    expect(formatCompactCard({ version: 2, kind: "append", durationMs: 1_000, usage: { input: 100, cacheRead: 0, cost: { total: 0.08 } } }, "en").tone).toBe("warning");
    const fallback = formatCompactCard({ version: 2, kind: "standard", fallbackReason: "insufficient-window", tokensBefore: 258_796, summaryTokens: 3_000, usage: { input: 250_000, cacheRead: 0, cost: { total: 0.0451 } } }, "ru");
	expect(fallback.line).toBe("◆ standard compact · append fallback (insufficient-window) · 258.8k → summary ~3.0k · $0.0451");
	expect(fallback.tone).toBe("warning");
	expect(fallback.details).toContain("причина fallback: insufficient-window");
});

test("fallback card keeps append and standard economics separate", () => {
    const card = formatCompactCard({ version: 2, kind: "standard", fallbackReason: "invalid-result", tokensBefore: 1_000, summaryTokens: 100, durationMs: 3_000, appendDurationMs: 1_200, appendCacheStatus: "unknown", appendUsage: { input: 40, cacheRead: 0, cost: { total: 0.007 } }, usage: { input: 100, cacheRead: 0, cost: { total: 0.02 } } }, "en");
    expect(card.line).toContain("$0.0200");
    expect(card.line).toContain("append $0.0070");
    expect(card.details).toContain("append time: 1.2 s · cache unknown");
    expect(card.details).toContain("append cost: append $0.0070");
    expect(card.details).toContain("cost: $0.0200");
});

test("cache unavailable is explicit and not a miss warning", () => {
    const card = formatCompactCard({ version: 2, kind: "append", appendCacheStatus: "unavailable", appendDurationMs: 1_000, usage: { input: 100, cost: { total: 0.01 } } }, "en");
    expect(card.line).toContain("cache unavailable");
    expect(card.tone).toBe("normal");
});
test("no-usage fallback still shows separate append economics", () => {
    const preflight = formatCompactCard({ version: 2, kind: "standard", fallbackReason: "insufficient-window", appendCacheStatus: "not-attempted", durationMs: 2_000, usage: { input: 100, cost: { total: 0.02 } } }, "en");
    expect(preflight.line).toContain("append $0.0000");
    const failed = formatCompactCard({ version: 2, kind: "standard", fallbackReason: "request-failed", appendCacheStatus: "unknown", durationMs: 2_000, usage: { input: 100, cost: { total: 0.02 } } }, "en");
    expect(failed.details).toContain("append cost: append unknown");
});

test("plain standard compact without usage stays neutral and tolerates missing fields", () => {
    const card = formatCompactCard({ version: 2, kind: "standard" }, "en");
	expect(card.line).toBe("◆ standard compact · ? → summary ?");
	expect(card.tone).toBe("normal");
});

test("renderer shows details only when expanded", () => {
    const data = { version: 2 as const, kind: "append" as const, tokensBefore: 1_000, summaryTokens: 100, durationMs: 1_000, usage: { input: 10, cacheRead: 90, cost: { total: 0.01 } } };
	expect(renderCompactCard(data, false, theme, "ru").render(200)).toHaveLength(1);
	expect(renderCompactCard(data, true, theme, "ru").render(200).length).toBeGreaterThan(3);
});

test("estimates summary tokens only from text", () => {
	expect(estimateSummaryTokens("x".repeat(40))).toBe(10);
	expect(estimateSummaryTokens(undefined)).toBeUndefined();
});
