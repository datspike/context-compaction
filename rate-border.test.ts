import { describe, expect, test } from "bun:test";
import { createRateBorder } from "./request-stage/rate-border.js";

describe("rate border", () => {
	test("preserves editor contents and scroll indicator, and restores the previous factory", () => {
		let renders = 0;
		const editor = { render: (_width: number) => ["─── ↑ 4 more ───────────────────────────", "first", "second", "────────────────────────────────────────"], borderColor: (s: string) => s };
		const previous = () => editor;
		let factory: any = previous;
		const ui: any = { getEditorComponent: () => factory, setEditorComponent: (f: any) => { factory = f; } };
		const border = createRateBorder();
		border.install(ui);
		const renderedEditor = factory({ requestRender: () => { renders++; } }, {}, {});
		border.setRate("ср. 65 / 48 ток/с");
		const lines = renderedEditor.render(40);
		expect(lines[0]).toContain("↑ 4 more");
		expect(lines[0]).toContain("ср. 65 / 48 ток/с");
		expect(lines.slice(1)).toEqual(["first", "second", "────────────────────────────────────────"]);
		expect(renderedEditor.render(15)[0]).toBe("─── ↑ 4 more ───────────────────────────");
		expect(renders).toBe(1);
		border.uninstall();
		expect(factory).toBe(previous);
	});

	test("does not overwrite a centered scroll marker or a foreign component", () => {
		let line = "──────────────── ↑ 4 more ──────────────";
		const editor = { render: () => [line, "text"], borderColor: (s: string) => s };
		let factory: any = () => editor;
		const ui: any = { getEditorComponent: () => factory, setEditorComponent: (f: any) => { factory = f; } };
		const border = createRateBorder();
		border.install(ui);
		const instance = factory({ requestRender() {} }, {}, {});
		border.setRate("ср. 65 / 48 ток/с");
		expect(instance.render(35)[0]).toBe(line);
		line = "Foreign custom editor";
		expect(instance.render(80)[0]).toBe(line);
	});
});
