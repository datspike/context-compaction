export const COMPACT_WINDOW_MARGIN = 4_096;
export const MAX_COMPACT_PAYLOAD_CHARS = 16 * 1024 * 1024;

export interface CompactModel {
	provider: string;
	id: string;
	baseUrl: string;
	contextWindow?: number;
	maxTokens?: number;
}

/** Capability selected for the service compact request, after route resolution. */
export interface CompactCapability {
	window: number;
	source: string;
	outputLimitEnforced: boolean;
}

/** Explicit capability for one exact provider/model/baseUrl route. */
export interface CompactCapabilityOverride {
	provider: string;
	model: string;
	baseUrl: string;
	contextWindow: number;
	source: string;
	outputLimitEnforced?: boolean;
}

export type CompactBudgetReason = "unsupported" | "insufficient-window" | "request-too-large";

export interface CompactBudgetInput {
	capability: CompactCapability;
	inputTokens: number;
	taskTokens: number;
	requestedOutputTokens: number;
	modelMaxTokens: number;
	serializedChars?: number;
}

export interface CompactBudget {
	allowed: boolean;
	reason: CompactBudgetReason | undefined;
	inputTokens: number;
	taskTokens: number;
	requestedOutputTokens: number;
	outputReserve: number;
	margin: number;
	window: number;
	serializedChars: number;
}

const REGISTRY_SOURCE = "exact-registry";
const OVERRIDE_FIELDS = new Set(["provider", "model", "baseUrl", "contextWindow", "source", "outputLimitEnforced"]);

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function overrideError(index: number, field: string): Error {
	return new Error(`contextCompaction.compactCapabilities[${index}].${field} is invalid`);
}

/** Validates capability settings without changing their route identity or source text. */
export function validateCompactCapabilityOverrides(value: unknown): CompactCapabilityOverride[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("contextCompaction.compactCapabilities must be an array");

	const seen = new Set<string>();
	return value.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`contextCompaction.compactCapabilities[${index}] must be an object`);
		for (const key of Object.keys(entry)) if (!OVERRIDE_FIELDS.has(key)) throw new Error(`contextCompaction.compactCapabilities[${index}].${key} is not supported`);
		if (!isNonEmptyString(entry.provider)) throw overrideError(index, "provider");
		if (!isNonEmptyString(entry.model)) throw overrideError(index, "model");
		if (!isNonEmptyString(entry.baseUrl)) throw overrideError(index, "baseUrl");
		if (!isPositiveInteger(entry.contextWindow)) throw overrideError(index, "contextWindow");
		if (!isNonEmptyString(entry.source)) throw overrideError(index, "source");
		if (entry.outputLimitEnforced !== undefined && typeof entry.outputLimitEnforced !== "boolean") throw overrideError(index, "outputLimitEnforced");

		const route = JSON.stringify([entry.provider, entry.model, entry.baseUrl]);
		if (seen.has(route)) throw new Error(`contextCompaction.compactCapabilities[${index}] duplicates an exact route`);
		seen.add(route);

		const override: CompactCapabilityOverride = {
			provider: entry.provider,
			model: entry.model,
			baseUrl: entry.baseUrl,
			contextWindow: entry.contextWindow,
			source: entry.source,
		};
		if (entry.outputLimitEnforced !== undefined) override.outputLimitEnforced = entry.outputLimitEnforced;
		return override;
	});
}

function validModel(model: CompactModel): boolean {
	return isRecord(model) && isNonEmptyString(model.provider) && isNonEmptyString(model.id) && isNonEmptyString(model.baseUrl);
}

/** Resolves an exact service capability without using a session-local contextWindow. */
export function resolveCompactCapability(
	model: CompactModel,
	declaredWindow?: number,
	overrides?: readonly CompactCapabilityOverride[],
): CompactCapability {
	const validatedOverrides = validateCompactCapabilityOverrides(overrides);
	if (validModel(model)) {
		const override = validatedOverrides.find((entry) => entry.provider === model.provider && entry.model === model.id && entry.baseUrl === model.baseUrl);
		if (override) return { window: override.contextWindow, source: override.source, outputLimitEnforced: override.outputLimitEnforced === true };
	}

	if (!validModel(model) || !isPositiveInteger(declaredWindow)) return { window: 0, source: "unsupported", outputLimitEnforced: false };
	return { window: declaredWindow, source: REGISTRY_SOURCE, outputLimitEnforced: false };
}

function validCapability(value: unknown): value is CompactCapability {
	if (!isRecord(value) || !isPositiveInteger(value.window) || !isNonEmptyString(value.source)) return false;
	return value.outputLimitEnforced === undefined || typeof value.outputLimitEnforced === "boolean";
}

function numericValue(value: unknown, valid: (candidate: unknown) => candidate is number): number {
	return valid(value) ? value : 0;
}

/** Computes one conservative service-compact budget for both preflight and final guards. */
export function calculateCompactBudget(input: CompactBudgetInput): CompactBudget {
	const inputTokens = numericValue(input?.inputTokens, isNonNegativeInteger);
	const taskTokens = numericValue(input?.taskTokens, isNonNegativeInteger);
	const requestedOutputTokens = numericValue(input?.requestedOutputTokens, isPositiveInteger);
	const modelMaxTokens = numericValue(input?.modelMaxTokens, isPositiveInteger);
	const serializedChars = input?.serializedChars === undefined ? 0 : numericValue(input.serializedChars, isNonNegativeInteger);
	const capability = input?.capability;
	const window = validCapability(capability) ? capability.window : 0;
	const outputLimitEnforced = validCapability(capability) && capability.outputLimitEnforced === true;
	const outputReserve = outputLimitEnforced ? requestedOutputTokens : modelMaxTokens;
	const validNumbers =
		isNonNegativeInteger(input?.inputTokens) &&
		isNonNegativeInteger(input?.taskTokens) &&
		isPositiveInteger(input?.requestedOutputTokens) &&
		isPositiveInteger(input?.modelMaxTokens) &&
		(input?.serializedChars === undefined || isNonNegativeInteger(input.serializedChars));

	let reason: CompactBudgetReason | undefined;
	if (!validCapability(capability) || !validNumbers) reason = "unsupported";
	else if (requestedOutputTokens > modelMaxTokens || serializedChars > MAX_COMPACT_PAYLOAD_CHARS) reason = "request-too-large";
	else if (inputTokens + taskTokens + outputReserve + COMPACT_WINDOW_MARGIN > window) reason = "insufficient-window";

	return {
		allowed: reason === undefined,
		reason,
		inputTokens,
		taskTokens,
		requestedOutputTokens,
		outputReserve,
		margin: COMPACT_WINDOW_MARGIN,
		window,
		serializedChars,
	};
}