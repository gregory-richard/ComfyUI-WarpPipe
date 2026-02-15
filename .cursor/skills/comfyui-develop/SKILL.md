---
name: comfyui-develop
description: Develop ComfyUI custom nodes. Covers node class structure, INPUT_TYPES, RETURN_TYPES, datatypes (IMAGE, LATENT, MASK, MODEL, CLIP, VAE, CONDITIONING), lifecycle, lazy evaluation, node expansion, JavaScript extensions, and frontend hooks. Use when creating, modifying, or debugging ComfyUI custom nodes.
---

# Developing ComfyUI Custom Nodes

Docs: https://docs.comfy.org/custom-nodes/overview

## Node Class Structure

Every custom node is a Python class with these required properties:

```python
class MyNode:
    CATEGORY = "my_category/subcategory"    # Menu location
    FUNCTION = "run"                         # Method name to call
    RETURN_TYPES = ("IMAGE",)               # Tuple of output types
    RETURN_NAMES = ("image",)               # Optional: output labels

    @classmethod
    def INPUT_TYPES(cls):                   # Must be @classmethod
        return {
            "required": { "image": ("IMAGE", {}) },
            "optional": { "mask": ("MASK", {}) },
            # "hidden": { "unique_id": "UNIQUE_ID" }
        }

    def run(self, image, mask=None):        # Optional inputs need defaults
        return (result,)                     # Must return tuple. Trailing comma!
```

### Key Rules
- `INPUT_TYPES` **must** be a `@classmethod` (options computed at runtime)
- `FUNCTION` returns a `tuple` matching `RETURN_TYPES` (even if empty: `return ()`)
- Optional inputs: only passed if connected, so provide default values
- Hidden inputs: `"UNIQUE_ID"`, `"PROMPT"`, `"EXTRA_PNGINFO"` are special ComfyUI values

## Datatypes

### Primitives
| Type | Python | Widget | Extra Params |
|------|--------|--------|--------------|
| `INT` | `int` | Spinner | `default` (req), `min`, `max`, `step` |
| `FLOAT` | `float` | Spinner | `default` (req), `min`, `max`, `step` |
| `STRING` | `str` | Text | `default` (req), `multiline`, `placeholder`, `dynamicPrompts` |
| `BOOLEAN` | `bool` | Toggle | `default` (req), `label_on`, `label_off` |
| `COMBO` | `list[str]` -> `str` | Dropdown | Defined as `(["opt1","opt2"], {})` |

### Tensor Types
| Type | Shape | Notes |
|------|-------|-------|
| `IMAGE` | `[B,H,W,C]` C=3 | Batch of images, channel-last. Convert to/from PIL for I/O |
| `LATENT` | `dict` with `samples`: `[B,C,H,W]` C=4 | Channel-first. H,W = image/8 |
| `MASK` | `[B,H,W]` or `[H,W]` | Check `len(mask.shape)`. Unsqueeze as needed |

### Model Types
`MODEL`, `CLIP`, `CLIP_VISION`, `VAE`, `CONDITIONING` - opaque objects passed through.

### Custom Sampling
`NOISE`, `SAMPLER`, `SIGMAS`, `GUIDER` - advanced sampling pipeline types.

### Custom Datatypes
Define your own by using any string as the type name. The frontend prevents connecting mismatched types.

### Additional Input Parameters
| Key | Purpose |
|-----|---------|
| `default` | Default widget value |
| `min`, `max`, `step` | Number constraints |
| `forceInput` | Always show as input socket (no widget) |
| `defaultInput` | Default to input socket but allow widget conversion |
| `lazy` | Enable lazy evaluation |
| `rawLink` | Receive link reference instead of value (for expansion) |

## Lifecycle & Registration

### `__init__.py`
```python
from .my_nodes import MyNode, AnotherNode

NODE_CLASS_MAPPINGS = {
    "My Node": MyNode,           # Unique name across all Comfy
    "Another Node": AnotherNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "My Node": "My Display Name",
}
WEB_DIRECTORY = "./web"          # Optional: for JS extensions
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
```

ComfyUI scans `custom_nodes/` at startup. Errors fail silently (module skipped) - check the console.

## Execution Control

### OUTPUT_NODE
Set `OUTPUT_NODE = True` for nodes that are workflow endpoints (save, preview). Only output nodes trigger execution.

### IS_CHANGED
Controls caching. Return any value; node re-executes when return value differs from previous run.
- Return `float("NaN")` to always execute (avoid if possible)
- Return a hash of inputs for file-based nodes

```python
@classmethod
def IS_CHANGED(cls, **kwargs):
    return hashlib.sha256(data).hexdigest()
```

### VALIDATE_INPUTS
Called before execution. Return `True` or error string.
- Only receives constant inputs (not values from other nodes)
- If takes `input_types` param: receives connected types dict, skips default type validation
- If takes `**kwargs`: receives all inputs, skips all default validation

## Lazy Evaluation

Skip evaluating unused inputs. Two steps:

1. Mark inputs: `"image": ("IMAGE", {"lazy": True})`
2. Implement `check_lazy_status(self, ...)` returning list of needed input names

```python
def check_lazy_status(self, mask, image1=None, image2=None):
    needed = []
    if image1 is None and mask.min() != 1.0:
        needed.append("image1")
    return needed
```

## Node Expansion

Return a subgraph instead of direct results. Enables loops and composite operations:

```python
from comfy_execution.graph_utils import GraphBuilder

def my_function(self, ...):
    graph = GraphBuilder()
    node1 = graph.node("CheckpointLoaderSimple", ckpt_name=name)
    return {
        "result": (node1.out(0), node1.out(1)),
        "expand": graph.finalize(),
    }
```

## Execution Blocking

```python
from comfy_execution.graph import ExecutionBlocker
# Silent block:
return (ExecutionBlocker(None),)
# Error message block:
return (ExecutionBlocker("No VAE found"),)
```

## List Processing

- Default: Comfy processes lists sequentially, calling your function once per item
- `INPUT_IS_LIST = True`: Receive entire list at once (all inputs become lists)
- `OUTPUT_IS_LIST = (True,)`: Your output list should not be wrapped

## JavaScript Extensions

### Setup
Export `WEB_DIRECTORY = "./web"` (or `"./js"`). Place `.js` files there. Only `.js` served.

### Extension Structure
```javascript
import { app } from "../../scripts/app.js";
app.registerExtension({
    name: "unique.extension.name",
    async setup() { /* after startup */ },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeType.comfyClass === "MyNode") {
            // Modify node prototype
        }
    },
    async nodeCreated(node) { /* per-instance setup */ },
});
```

### Hook Order (page load)
`init` -> `addCustomNodeDefs` -> `getCustomWidgets` -> `beforeRegisterNodeDef` (repeated) -> `registerCustomNodes` -> `beforeConfigureGraph` -> `nodeCreated` -> `loadedGraphNode` -> `afterConfigureGraph` -> `setup`

### Server-to-Client Messages
```python
# Python (server)
from server import PromptServer
PromptServer.instance.send_sync("my.event.type", {"key": "value"})
```
```javascript
// JavaScript (client)
app.api.addEventListener("my.event.type", (event) => {
    console.log(event.detail.key);
});
```

## Additional Resources

For detailed docs on specific topics:
- Datatypes: https://docs.comfy.org/custom-nodes/backend/datatypes
- Images & masks: https://docs.comfy.org/custom-nodes/backend/images_and_masks
- Lazy eval: https://docs.comfy.org/custom-nodes/backend/lazy_evaluation
- Node expansion: https://docs.comfy.org/custom-nodes/backend/expansion
- JS hooks: https://docs.comfy.org/custom-nodes/js/javascript_hooks
- JS objects: https://docs.comfy.org/custom-nodes/js/javascript_objects_and_hijacking
