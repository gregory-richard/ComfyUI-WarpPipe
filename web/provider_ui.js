import { app } from "../../scripts/app.js";
import { upgradeSizePreset } from "./size_presets.js";

// The Warp Provider, showing a size preset from an old workflow the way the
// dropdown writes it today.

const NODE_ID = "Warp Provider";
const SIZE_WIDGET = "size_preset";

app.registerExtension({
  name: "warppipe.providerUI",
  async nodeCreated(node) {
    if (node.comfyClass !== NODE_ID) return;

    // After the saved values are restored, which is when an old label arrives.
    // Left as it was, it ran perfectly well but was the long padded string the
    // short labels replaced, in every Provider of every workflow saved before.
    const priorConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = priorConfigure?.apply(this, args);
      const widget = (node.widgets || []).find((w) => w.name === SIZE_WIDGET);
      const values = widget?.options?.values;
      const options = typeof values === "function" ? values() : values;
      const label = widget && Array.isArray(options) && upgradeSizePreset(widget.value, options);
      if (label) widget.value = label;
      return result;
    };
  },
});
