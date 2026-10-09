import { describe, expect, test } from "bun:test";
import { formatFooter, resolvePolicy } from "./policy.js";

describe("policy", () => {
	const model = { provider: "custom", id: "large", contextWindow: 272_000 };
	const longTier = { longPricingTierAvailable: true };

	test.each([
		[undefined, 272_000, 256_000],
		[271_999, 271_999, 203_999],
		[272_000, 272_000, 256_000],
		[272_001, 272_001, 256_001],
		[372_000, 372_000, 356_000],
		[500_000, 372_000, 356_000],
		[600_000, 372_000, 356_000],
		[1_050_000, 372_000, 356_000],
	])("long-once capability %p", (declared, window, threshold) => {
		const policy = resolvePolicy("long-once", model, declared, longTier);
		expect(policy).toMatchObject({ window, threshold, longOnceAvailable: declared !== undefined && declared > 272_000 });
	});

	test.each([
		[undefined, 272_000, 256_000],
		[271_999, 271_999, 203_999],
		[272_000, 272_000, 256_000],
		[272_001, 272_001, 256_001],
		[372_000, 372_000, 356_000],
		[500_000, 500_000, 484_000],
		[600_000, 600_000, 584_000],
		[1_050_000, 600_000, 584_000],
	])("long-chat capability %p", (declared, window, threshold) => {
		const policy = resolvePolicy("long-chat", model, declared, longTier);
		expect(policy).toMatchObject({ window, threshold, longChatAvailable: declared !== undefined && declared > 272_000 });
	});

	test("long modes require an exact registry declaration and do not use temporary actual window", () => {
		const overridden = { ...model, contextWindow: 600_000 };
		expect(resolvePolicy("long-once", overridden)).toMatchObject({ mode: "economy", window: 600_000, longOnceAvailable: false, source: "fallback" });
		expect(resolvePolicy("long-chat", overridden, 272_000)).toMatchObject({ mode: "economy", window: 272_000, threshold: 256_000, longChatAvailable: false, source: "exact-registry" });
	});

	test("declared capability does not enable long without an exact pricing tier", () => {
		expect(resolvePolicy("long-chat", model, 600_000)).toMatchObject({ mode: "economy", window: 272_000, threshold: 256_000, source: "exact-registry", longChatAvailable: false });
		expect(resolvePolicy("long-chat", model, 600_000, longTier)).toMatchObject({ mode: "long-chat", window: 600_000, threshold: 584_000, source: "exact-registry", longChatAvailable: true });
	});

	test("session override enables explicit long modes without changing economy", () => {
		const options = { sessionOverrideWindow: 600_000, longPricingTierAvailable: true };
		expect(resolvePolicy("economy", model, 272_000, options)).toMatchObject({ mode: "economy", window: 272_000, threshold: 256_000, source: "exact-registry" });
		expect(resolvePolicy("long-once", model, 272_000, options)).toMatchObject({ mode: "long-once", window: 372_000, threshold: 356_000, source: "session-override", longOnceAvailable: true });
		expect(resolvePolicy("long-chat", model, 272_000, options)).toMatchObject({ mode: "long-chat", window: 600_000, threshold: 584_000, source: "session-override", longChatAvailable: true });
		expect(resolvePolicy("off", model, 272_000, options)).toMatchObject({ mode: "off", window: 272_000, threshold: undefined, source: "off" });
	});

	test("economy is bounded by registry capability and off restores declared base window", () => {
		expect(resolvePolicy("economy", model, 100_000)).toMatchObject({ window: 100_000, threshold: 75_000, source: "exact-registry" });
		expect(resolvePolicy("economy", { ...model, contextWindow: 600_000 }, 1_050_000)).toMatchObject({ window: 272_000, threshold: 256_000 });
		expect(resolvePolicy("off", { ...model, contextWindow: 600_000 }, 1_050_000)).toMatchObject({ window: 1_050_000, threshold: undefined });
	});

	test("footer uses resolved effective window", () => {
		const policy = resolvePolicy("economy", { ...model, contextWindow: 372_000 }, 272_000);
		expect(formatFooter(100_000, policy)).toBe("ctx 100K/272K 36.8% · compact@256K · economy");
	});
});
