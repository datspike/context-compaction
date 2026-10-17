/**
 * Shows one passive rate readout over the vacated Working line without adding a footer or row.
 */
export function showRateOverlay(ui, text) {
  if (!ui || typeof ui.custom !== "function" || !text) return () => {};

  let closed = false;
  let handle;
  let finish;
  const width = [...text].length;

  const hide = () => {
    if (closed) return;
    closed = true;
    finish?.();
    if (!finish) handle?.hide();
  };

  try {
    void ui.custom(
      (tui, _theme, _keybindings, done) => {
        if (closed) {
          done(undefined);
          return { render: () => [], invalidate() {} };
        }

        const nativeHide = tui?.hideOverlay;
        const descriptor = tui && typeof nativeHide === "function"
          ? Object.getOwnPropertyDescriptor(tui, "hideOverlay")
          : undefined;
        let closing = false;
        const hideOwned = function () {
          if (!closing) return nativeHide.call(this);
          handle?.hide();
        };
        if (tui && typeof nativeHide === "function") tui.hideOverlay = hideOwned;

        finish = () => {
          if (typeof nativeHide !== "function") {
            done(undefined);
            return;
          }
          closing = true;
          try {
            done(undefined);
          } finally {
            closing = false;
            if (tui.hideOverlay === hideOwned) {
              if (descriptor) Object.defineProperty(tui, "hideOverlay", descriptor);
              else delete tui.hideOverlay;
            }
          }
        };

        return {
          render: (availableWidth) => {
            const suffix = [...text].slice(-Math.max(1, availableWidth)).join("");
            return [suffix];
          },
          invalidate() {},
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "bottom-right",
          width,
          // Working's text line is six rows above the bottom edge and ends five columns before it:
          // the three footer rows, two editor borders, the editor's inner line, and the right border reserve.
          margin: { bottom: 6, right: 5 },
          nonCapturing: true,
        },
        onHandle: (overlayHandle) => {
          handle = overlayHandle;
          if (closed) overlayHandle.hide();
        },
      },
    ).catch(() => {});
  } catch {
    // UI may be invalid during session replacement or shutdown.
  }

  return hide;
}
