import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SummaryLanguage = "ru" | "en";
export type SummarySettings = { summaryLanguage: SummaryLanguage; appendCompaction: boolean };

/** Reads and validates the session's global summary preferences once at extension load. */
export function loadSummarySettings(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): SummarySettings {
	const defaults: SummarySettings = { summaryLanguage: "ru", appendCompaction: false };
	let text: string;
	try {
		text = readFileSync(join(agentDir, "settings.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
		throw error;
	}
	const settings: unknown = JSON.parse(text);
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Pi settings must be an object");
	const config = (settings as Record<string, unknown>).contextCompaction;
	if (config === undefined) return defaults;
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("contextCompaction must be an object");
	const { summaryLanguage: language = "ru", appendCompaction = false } = config as Record<string, unknown>;
	if (language !== "ru" && language !== "en") throw new Error("contextCompaction.summaryLanguage must be ru or en");
	if (typeof appendCompaction !== "boolean") throw new Error("contextCompaction.appendCompaction must be a boolean");
	return { summaryLanguage: language, appendCompaction };
}

/** Retains the original language-only API for callers. */
export function loadSummaryLanguage(agentDir?: string): SummaryLanguage {
	return loadSummarySettings(agentDir).summaryLanguage;
}
