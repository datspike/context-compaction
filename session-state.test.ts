import { describe, expect, test } from "bun:test";
import { appendMode, hasLegacyThreshold, MODE_ENTRY, restoreMode } from "./session-state.js";

describe("session-state", () => {
	test("восстанавливает последний именованный режим из append-only записей", () => {
		const entries = [
			{ type: "custom", customType: MODE_ENTRY, data: { mode: "economy" } },
			{ type: "custom", customType: MODE_ENTRY, data: { mode: "long-chat" } },
		];
		expect(restoreMode(entries)).toBe("long-chat");
		const appended: any[] = [];
		appendMode({ appendEntry(type, data) { appended.push({ type, data }); } }, "long-once");
		expect(appended).toEqual([{ type: MODE_ENTRY, data: { mode: "long-once" } }]);
	});

	test("только обнаруживает legacy порог, не создавая reset или миграцию", () => {
		const entries = [{ type: "custom", customType: "checkpoint-compact-session-threshold", data: { kind: "tokens", value: 700_000 } }];
		expect(hasLegacyThreshold(entries)).toBe(true);
		expect(restoreMode(entries)).toBe("economy");
	});
});
