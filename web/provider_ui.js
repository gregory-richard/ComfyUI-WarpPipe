import { app } from "../../scripts/app.js";
import { upgradeSizePreset } from "./size_presets.js";

// The Warp Provider: a size preset named so it fits, and one from an old
// workflow shown the way the dropdown writes it today.

const NODE_ID = "Warp Provider";
const SIZE_WIDGET = "size_preset";

// The input ids are what the API and saved workflows speak; these are only what
// the node calls them on screen. In a 280px node "size_preset" and the preset
// beside it did not both fit, and the frontend cut the name to "size_pr…".
const FRIENDLY_LABELS = {
  size_preset: "size",
};

app.registerExtension({
  name: "warppipe.providerUI",
  async nodeCreated(node) {
    if (node.comfyClass !== NODE_ID) return;

    for (const widget of node.widgets || []) {
      if (FRIENDLY_LABELS[widget.name]) widget.label = FRIENDLY_LABELS[widget.name];
    }

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
