import { app } from "../../scripts/app.js";
import { keepWidgetValuesByName, setWidgetValues } from "./widget_values.js";

// The Save Image (Civitai) node, named in the words a person would use.

const NODE_ID = "Save Image Civitai";

// The input ids are what the API and saved workflows speak; these are only what
// the node calls them on screen.
const FRIENDLY_LABELS = {
  filename_prefix: "Save as",
  embed_metadata: "Generation info",
  embed_workflow: "Workflow",
  model_name_override: "Checkpoint",
};

/** A workflow saved when one toggle did both jobs.
 *
 * It held [filename_prefix, embed_workflow, model_name_override]. Read by
 * position against today's widgets, the workflow toggle lands on the metadata
 * one and the checkpoint name lands on the workflow toggle - where an empty
 * string reads as "off" and would quietly stop writing the workflow.
 */
function migrateSingleToggle(node, values) {
  if (!Array.isArray(values) || values.length !== 3) return;
  const [prefix, embedWorkflow, checkpoint] = values;
  if (typeof embedWorkflow !== "boolean" || typeof checkpoint !== "string") return;
  setWidgetValues(node, {
    filename_prefix: prefix,
    // It always wrote the parameters block; only the workflow was optional.
    embed_metadata: true,
    embed_workflow: embedWorkflow,
    model_name_override: checkpoint,
  });
}

app.registerExtension({
  name: "warppipe.saveImageUI",
  async nodeCreated(node) {
    if (node.comfyClass !== NODE_ID) return;

    for (const widget of node.widgets || []) {
      if (FRIENDLY_LABELS[widget.name]) widget.label = FRIENDLY_LABELS[widget.name];
    }
    keepWidgetValuesByName(node, migrateSingleToggle);
  },
});
