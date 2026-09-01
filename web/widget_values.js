// Save and restore a node's widget values by name, not by position.
//
// ComfyUI writes widgets_values in the order of node.widgets and reads them
// back the same way. Anything that changes that order between a save and a load
// - an extension reordering widgets for legibility, or a widget added to the
// schema in a later version - shifts every value after it onto the wrong
// widget, silently and permanently. Booleans are the worst of it: the wrong
// value is still a valid one, so nothing complains.
//
// Writing the values by name as well costs one small object in the workflow and
// makes the order stop mattering.

const BY_NAME = "warppipeWidgets";

/**
 * @param node        the node to protect
 * @param migrate     optional (node, widgets_values) => void, called only for a
 *                    workflow saved before this ran, to place old values on the
 *                    widgets they belong to now.
 */
export function keepWidgetValuesByName(node, migrate) {
  const priorSerialize = node.onSerialize;
  node.onSerialize = function (o) {
    priorSerialize?.call(this, o);
    o[BY_NAME] = Object.fromEntries(
      (node.widgets || []).filter((w) => w.name).map((w) => [w.name, w.value])
    );
  };

  const priorConfigure = node.onConfigure;
  node.onConfigure = function (o) {
    priorConfigure?.call(this, o);
    const saved = o?.[BY_NAME];
    if (saved) {
      for (const widget of node.widgets || []) {
        if (widget.name in saved) widget.value = saved[widget.name];
      }
      return;
    }
    // Older than this: the values were placed by position, which may have put
    // them on the wrong widgets. Only the node itself knows what the old shape
    // meant, so it says.
    migrate?.(node, o?.widgets_values);
  };
}

/** Set widget values by name, ignoring any this node does not have. */
export function setWidgetValues(node, values) {
  for (const widget of node.widgets || []) {
    if (Object.hasOwn(values, widget.name)) widget.value = values[widget.name];
  }
}
