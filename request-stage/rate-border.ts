import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Places the readout on the existing top border without changing editor geometry. */
export function createRateBorder() {
	let rate: string | undefined;
	let redraw: (() => void) | undefined;
	let installedUi: ExtensionContext["ui"] | undefined;
	let installedFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let previousFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

	return {
		install(ui: ExtensionContext["ui"]) {
			if (installedFactory && ui.getEditorComponent?.() === installedFactory) { installedUi = ui; return; }
			if (typeof ui.setEditorComponent !== "function") return;
			previousFactory = ui.getEditorComponent?.();
			installedUi = ui;
			const previous = previousFactory;
			installedFactory = (tui, theme, keybindings) => {
				const editor = previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
				const render = editor.render.bind(editor);
				redraw = () => tui.requestRender();
				editor.render = (width: number) => {
					const lines = render(width);
					if (!rate || !lines.length) return lines;
					const label = ` ${rate} `;
					const labelWidth = visibleWidth(label);
					const plain = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
					if (!plain.startsWith("─")) return lines;
					const scroll = /↑\s*\d+\s+more/.exec(plain);
					const scrollEnd = scroll ? visibleWidth(plain.slice(0, scroll.index + scroll[0].length)) : 1;
					const remaining = width - labelWidth - 1;
					if (remaining < scrollEnd) return lines;
					lines[0] = `${truncateToWidth(lines[0], remaining, "")}${label}${editor.borderColor?.("─") ?? "─"}`;
					return lines;
				};
				return editor;
			};
			ui.setEditorComponent(installedFactory);
		},
		setRate(value: string | undefined) {
			if (rate === value) return;
			rate = value;
			redraw?.();
		},
		uninstall() {
			if (installedUi && installedUi.getEditorComponent?.() === installedFactory) installedUi.setEditorComponent(previousFactory);
			installedUi = undefined;
			installedFactory = undefined;
			previousFactory = undefined;
			redraw = undefined;
			rate = undefined;
		},
	};
}
