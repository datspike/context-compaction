import assert from "node:assert/strict";
import test from "node:test";
import { showRateOverlay } from "./rate-overlay.mjs";

test("rate overlay is passive, unstyled, and stays over the vacated Working line", () => {
  let component;
  let options;
  let handle;
  let doneCalls = 0;
  let foreignHideCalls = 0;
  const ui = {
    custom(factory, receivedOptions) {
      options = receivedOptions;
      const tui = { hideOverlay() { foreignHideCalls += 1; } };
      component = factory(tui, {}, {}, () => {
        doneCalls += 1;
        tui.hideOverlay();
      });
      handle = { hideCalled: false, hide() { this.hideCalled = true; } };
      receivedOptions.onHandle(handle);
      return Promise.resolve(undefined);
    },
  };

  const hide = showRateOverlay(ui, "ср. 42 ток/с");

  assert.equal(options.overlay, true);
  assert.deepEqual(options.overlayOptions, {
    anchor: "bottom-right",
    width: "ср. 42 ток/с".length,
    margin: { bottom: 6, right: 5 },
    nonCapturing: true,
  });
  assert.deepEqual(component.render(80), ["ср. 42 ток/с"]);
  assert.deepEqual(component.render(5), ["ток/с"]);
  hide();
  assert.equal(handle.hideCalled, true);
  assert.equal(doneCalls, 1);
  assert.equal(foreignHideCalls, 0);
});

test("rate overlay is a no-op when custom UI is unavailable", () => {
  assert.doesNotThrow(() => showRateOverlay({}, "ср. 42 ток/с")());
});
