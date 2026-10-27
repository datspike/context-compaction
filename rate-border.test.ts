import { describe, expect, test } from "bun:test";
import { createRateBorder } from "./request-stage/rate-border.js";

function setup() {
	let renders = 0;
	let factory: any;
	const ui: any = { getEditorComponent: () => factory, setEditorComponent: (f: any) => { factory = f; } };
	const border = createRateBorder();
	border.install(ui);
	const editor = factory({ terminal: { rows: 20 }, requestRender: () => { renders++; } }, { borderColor: (s: string) => s }, {});
	return { ui, border, editor, getFactory: () => factory, renders: () => renders };
}

describe("rate border", () => {
	test("preserves the stock embedded working status, scrolling and editor contents", () => {
		const { border, editor, renders, getFactory } = setup();
		expect(editor.embedWorkingStatus).toBe(true);
		editor.setWorkingStatusIndicator({ renderInBorder: () => "РАБОТА", renderSpinnerInBorder: () => "⠋" });
		editor.setText(Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n"));
		const before = editor.render(80);
		expect(before[0]).toContain("РАБОТА");
		expect(before[0]).toMatch(/↑\s*\d+\s+more/);
		border.setRate("ср. 65 / 48 ток/с");
		const after = editor.render(80);
		expect(after[0]).toContain("РАБОТА");
		expect(after[0]).toMatch(/↑\s*\d+\s+more/);
		expect(after[0]).toContain("ср. 65 / 48 ток/с");
		expect(after.slice(1)).toEqual(before.slice(1));
		expect(renders()).toBe(1);
		border.uninstall();
		expect(getFactory()).toBeUndefined();
	});

	test("does not truncate a long working status to make room for the rate", () => {
		const { border, editor } = setup();
		editor.setWorkingStatusIndicator({ renderInBorder: () => "длинная рабочая стадия запроса", renderSpinnerInBorder: () => "⠋" });
		const before = editor.render(50)[0];
		border.setRate("ср. 65 / 48 ток/с");
		expect(editor.render(50)[0]).toBe(before);
	});

	test("does not replace or mutate a foreign editor, including a border-like header", () => {
		const editor = { render: () => ["──── foreign status ─────────────", "text"] };
		const previous = () => editor;
		let factory: any = previous;
		const ui: any = { getEditorComponent: () => factory, setEditorComponent: (f: any) => { factory = f; } };
		const border = createRateBorder();
		border.install(ui);
		border.setRate("ср. 65 / 48 ток/с");
		expect(factory).toBe(previous);
		expect(factory().render()[0]).toBe("──── foreign status ─────────────");
		border.uninstall();
		expect(factory).toBe(previous);
	});

	test("does not restore over a factory installed after this one", () => {
		const { ui, border, getFactory } = setup();
		const other = () => ({});
		ui.setEditorComponent(other);
		border.uninstall();
		expect(getFactory()).toBe(other);
	});
});
