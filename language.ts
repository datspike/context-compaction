import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SummaryLanguage = "ru" | "en";

/** Reads the global Pi profile preference. Missing configuration retains the original Russian behavior. */
export function loadSummaryLanguage(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): SummaryLanguage {
	let text: string;
	try {
		text = readFileSync(join(agentDir, "settings.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "ru";
		throw error;
	}
	const settings: unknown = JSON.parse(text);
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Pi settings must be an object");
	const config = (settings as Record<string, unknown>).contextCompaction;
	if (config === undefined) return "ru";
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("contextCompaction must be an object");
	const language = (config as Record<string, unknown>).summaryLanguage;
	if (language === undefined) return "ru";
	if (language !== "ru" && language !== "en") throw new Error("contextCompaction.summaryLanguage must be ru or en");
	return language;
}
