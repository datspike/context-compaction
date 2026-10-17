import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
// @ts-ignore -- plain ESM modules moved from the request-stage extension unchanged; they are tested with node:test.
import { RequestStageController } from "./request-stage/request-stage-controller.mjs";
// @ts-ignore
import { GenerationTelemetry } from "./request-stage/generation-telemetry.mjs";
// @ts-ignore
import { showRateOverlay } from "./request-stage/rate-overlay.mjs";

/** Events the request stage follows; the extension forwards each one exactly once. */
export const REQUEST_STAGE_EVENTS = [
	"session_start", "session_shutdown", "before_agent_start", "agent_start", "agent_end", "agent_settled",
	"turn_start", "turn_end", "before_provider_request", "model_select", "after_provider_response", "provider_stream_event",
	"message_start", "message_update", "message_end", "tool_call", "tool_execution_start", "tool_execution_end",
	"session_before_compact", "session_compact", "session_compact_failed",
] as const;
export type RequestStageEvent = typeof REQUEST_STAGE_EVENTS[number];

export interface RequestStage {
	observe(type: RequestStageEvent, event: unknown, ctx: ExtensionContext): void;
	beginCompaction(ctx: ExtensionContext, label: string): void;
	endCompaction(): void;
}

const tui = (ctx: ExtensionContext): boolean => (ctx as { mode?: string }).mode === "tui";

/**
 * The single owner of Pi's working line: request stage and generation rate during agent runs,
 * and the compact label while this extension compacts. The settled rate uses a passive overlay.
 */
export function createRequestStage(): RequestStage {
	const controller = new RequestStageController({
		telemetry: new GenerationTelemetry(),
		onState: (state: { visible: boolean; message?: string }, ui: ExtensionContext["ui"] | undefined) => {
			if (!ui) return;
			try {
				ui.setWorkingMessage(state.visible ? state.message : undefined);
				ui.setWorkingVisible(state.visible);
			} catch {
				// Reload or session replacement can invalidate the old UI context.
			}
		},
	});
	let hideRateOverlay = (): void => {};
	const hideOverlay = (): void => { hideRateOverlay(); hideRateOverlay = () => {}; };
	return {
		observe(type, event, ctx) {
			if (!tui(ctx)) return;
			if (type === "session_start" || type === "session_shutdown" || type === "before_agent_start" || type === "agent_start" || type === "before_provider_request" || type === "model_select") hideOverlay();
			controller.handle({ ...(event as object), type }, ctx);
			if (type === "agent_settled") {
				const rate = controller.rateText();
				hideOverlay();
				if (rate) hideRateOverlay = showRateOverlay(ctx.ui, rate);
			}
		},
		beginCompaction(ctx, label) { if (tui(ctx)) controller.beginCompaction(ctx, label); },
		endCompaction() { controller.endCompaction(); },
	};
}
