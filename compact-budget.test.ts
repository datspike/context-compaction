import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
	COMPACT_WINDOW_MARGIN,
	MAX_COMPACT_PAYLOAD_CHARS,
	calculateCompactBudget,
	resolveCompactCapability,
} from "./compact-budget.js";
import { loadSummarySettings } from "./language.js";

const model = { provider: "openai", id: "gpt-6.1-sol", baseUrl: "https://api.example.test/v1", contextWindow: 1_000_000, maxTokens: 128_000 };
const override = { provider: model.provider, model: model.id, baseUrl: model.baseUrl, contextWindow: 1_050_000, source: "provider-catalog" };

describe("compact capability", () => {
	test("uses the exact registry declaration and ignores session contextWindow", () => {
		expect(resolveCompactCapability(model, 272_000)).toEqual({ window: 272_000, source: "exact-registry", outputLimitEnforced: false });
	});

	test("uses only an exact provider/model/baseUrl override", () => {
		expect(resolveCompactCapability(model, 272_000, [override])).toEqual({ window: 1_050_000, source: "provider-catalog", outputLimitEnforced: false });
		expect(resolveCompactCapability({ ...model, baseUrl: "https://other.example.test/v1" }, 272_000, [override])).toMatchObject({ window: 272_000, source: "exact-registry" });
		expect(resolveCompactCapability(model, undefined, [override])).toMatchObject({ window: 1_050_000, source: "provider-catalog" });
	});

	test("returns an unsupported capability when the registry window is unknown", () => {
		expect(resolveCompactCapability(model)).toEqual({ window: 0, source: "unsupported", outputLimitEnforced: false });
		expect(resolveCompactCapability({ ...model, contextWindow: 2_000_000 })).toEqual({ window: 0, source: "unsupported", outputLimitEnforced: false });
	});

	test("rejects invalid and ambiguous overrides", () => {
		expect(() => resolveCompactCapability(model, 272_000, [{ ...override, source: "" }])).toThrow("source");
		expect(() => resolveCompactCapability(model, 272_000, [{ ...override, contextWindow: Number.NaN }])).toThrow("contextWindow");
		expect(() => resolveCompactCapability(model, 272_000, [override, override])).toThrow("duplicates");
		expect(() => resolveCompactCapability(model, 272_000, [{ ...override, outputLimitEnforced: "yes" as never }])).toThrow("outputLimitEnforced");
	});

	test("defaults output enforcement to false and honors an explicit override", () => {
		expect(resolveCompactCapability(model, 272_000, [{ ...override, outputLimitEnforced: true }])).toMatchObject({ outputLimitEnforced: true });
	});
});

describe("compact budget", () => {
	test("reserves the model maximum when output enforcement is not confirmed", () => {
		const capability = resolveCompactCapability(model, 272_000);
		expect(calculateCompactBudget({ capability, inputTokens: 249_900, taskTokens: 2_000, requestedOutputTokens: 4_096, modelMaxTokens: 16_000 })).toEqual({
			allowed: true,
			reason: undefined,
			inputTokens: 249_900,
			taskTokens: 2_000,
			requestedOutputTokens: 4_096,
			outputReserve: 16_000,
			margin: COMPACT_WINDOW_MARGIN,
			window: 272_000,
			serializedChars: 0,
		});
	});

	test("uses the requested output only for an explicitly enforced limit", () => {
		const capability = resolveCompactCapability(model, 272_000, [{ ...override, outputLimitEnforced: true }]);
		const budget = calculateCompactBudget({ capability, inputTokens: 250_000, taskTokens: 2_000, requestedOutputTokens: 4_096, modelMaxTokens: 16_000 });
		expect(budget).toMatchObject({ allowed: true, outputReserve: 4_096, window: 1_050_000 });
	});

	test("requires the complete token sum to fit and reports an insufficient window", () => {
		const capability = resolveCompactCapability(model, 272_000);
		const budget = calculateCompactBudget({ capability, inputTokens: 250_000, taskTokens: 2_000, requestedOutputTokens: 4_096, modelMaxTokens: 20_000 });
		expect(budget).toMatchObject({ allowed: false, reason: "insufficient-window", outputReserve: 20_000, margin: 4_096 });
		expect(calculateCompactBudget({ capability, inputTokens: 251_904, taskTokens: 0, requestedOutputTokens: 16_000, modelMaxTokens: 16_000 })).toMatchObject({ allowed: true });
	});

	test("checks serialized size independently without converting characters to tokens", () => {
		const capability = resolveCompactCapability(model, 1_000_000);
		const budget = calculateCompactBudget({ capability, inputTokens: 1, taskTokens: 1, requestedOutputTokens: 1, modelMaxTokens: 16_000, serializedChars: MAX_COMPACT_PAYLOAD_CHARS + 1 });
		expect(budget).toMatchObject({ allowed: false, reason: "request-too-large", serializedChars: MAX_COMPACT_PAYLOAD_CHARS + 1 });
		expect(calculateCompactBudget({ capability, inputTokens: 1, taskTokens: 1, requestedOutputTokens: 1, modelMaxTokens: 16_000, serializedChars: MAX_COMPACT_PAYLOAD_CHARS })).toMatchObject({ allowed: true, serializedChars: MAX_COMPACT_PAYLOAD_CHARS });
	});

	test("rejects unknown maxima and invalid numeric inputs", () => {
		const capability = resolveCompactCapability(model, 1_000_000);
		expect(calculateCompactBudget({ capability, inputTokens: 1, taskTokens: 1, requestedOutputTokens: 1, modelMaxTokens: Number.NaN })).toMatchObject({ allowed: false, reason: "unsupported" });
		expect(calculateCompactBudget({ capability, inputTokens: -1, taskTokens: 1, requestedOutputTokens: 1, modelMaxTokens: 16_000 })).toMatchObject({ allowed: false, reason: "unsupported" });
		expect(calculateCompactBudget({ capability: { window: 0, source: "", outputLimitEnforced: false }, inputTokens: 1, taskTokens: 1, requestedOutputTokens: 1, modelMaxTokens: 16_000 })).toMatchObject({ allowed: false, reason: "unsupported" });
	});

	test("rejects an output request above the model maximum", () => {
		const capability = resolveCompactCapability(model, 1_000_000);
		expect(calculateCompactBudget({ capability, inputTokens: 1, taskTokens: 1, requestedOutputTokens: 16_001, modelMaxTokens: 16_000 })).toMatchObject({ allowed: false, reason: "request-too-large", outputReserve: 16_000 });
	});
});

describe("compact capability settings", () => {
	test("keeps the old settings shape when compactCapabilities is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "compaction-budget-settings-"));
		try {
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextCompaction: { summaryLanguage: "en", appendCompaction: false } }));
			expect(loadSummarySettings(dir)).toEqual({ summaryLanguage: "en", appendCompaction: false });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reads and validates compact capability overrides only when configured", () => {
		const dir = mkdtempSync(join(tmpdir(), "compaction-budget-settings-"));
		try {
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextCompaction: { compactCapabilities: [override] } }));
			expect(loadSummarySettings(dir)).toEqual({ summaryLanguage: "ru", appendCompaction: true, compactCapabilities: [override] });
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextCompaction: { compactCapabilities: [override, override] } }));
			expect(() => loadSummarySettings(dir)).toThrow("duplicates");
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextCompaction: { compactCapabilities: {} } }));
			expect(() => loadSummarySettings(dir)).toThrow("must be an array");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});