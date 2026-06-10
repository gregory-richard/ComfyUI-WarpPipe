---
name: comfyui-testing
description: Test and debug ComfyUI custom nodes. Covers local testing workflows, import validation, common errors, debugging techniques, and compatibility checks. Use when testing custom nodes, debugging import errors, fixing node loading failures, or validating node behavior.
---

# Testing & Debugging ComfyUI Custom Nodes

## Local Testing Setup

### Quick Validation

Before publishing, always verify nodes load correctly:

1. Run `python -m py_compile your_node_files.py` for syntax errors
2. Run a plain import smoke test from the node-pack root
3. Start ComfyUI and check the console for import errors
4. Search the console output for your node pack name - any errors appear here
5. Verify nodes appear in the Add Node menu under the correct category

For V3 node packs, also verify the extension entrypoint:

```python
import asyncio
import your_node_pack

async def main():
    ext = await your_node_pack.comfy_entrypoint()
    nodes = await ext.get_node_list()
    for node in nodes:
        node.GET_SCHEMA()

asyncio.run(main())
```

### Symlink Development Setup

For rapid iteration, symlink your dev directory into ComfyUI's `custom_nodes/`:

```bash
# Windows (run as admin)
mklink /D "C:\path\to\ComfyUI\custom_nodes\your-node" "C:\path\to\your-dev-repo"

# Linux/macOS
ln -s /path/to/your-dev-repo /path/to/ComfyUI/custom_nodes/your-node
```

Restart ComfyUI after code changes (no re-clone needed).

## Common Import Errors

### Missing dependencies
```
Cannot import name 'X' from 'Y'
```
Fix: Add missing packages to `requirements.txt`. Don't include `torch`, `torchvision`, `comfy`, or core ComfyUI packages.

### Circular imports
```
ImportError: cannot import name 'NODE_CLASS_MAPPINGS' (most likely due to circular import)
```
Fix: Defer heavy imports inside functions, or restructure module imports.

### ComfyUI module access
```python
# Correct pattern for importing comfy internals
import comfy.samplers
import comfy.model_management
from server import PromptServer
import folder_paths
```

If running outside ComfyUI (e.g., tests), guard imports:
```python
try:
    import comfy.samplers
except ImportError:
    # Provide a complete enough mock for import-time constants, or skip.
    pass
```

If a module mutates ComfyUI globals at import time, the fallback mock must include those mutated attributes. For sampler code, that often means both `KSampler.SCHEDULERS` and module-level `SCHEDULER_NAMES` / `SCHEDULER_HANDLERS`.

## Debugging Techniques

### Console Logging
Use Python `logging` (not `print`) for production-quality output:

```python
import logging
logger = logging.getLogger("MyNodePack")

logger.debug("Detailed info: %s", variable)  # Hidden by default
logger.info("Node loaded successfully")
logger.warning("Falling back to default: %s", fallback)
logger.error("Failed to process: %s", error)
```

### Validating Node Structure

Common structural issues:
- **Missing trailing comma**: `return (result)` should be `return (result,)`
- **RETURN_TYPES / return tuple mismatch**: lengths must match exactly
- **INPUT_TYPES not a classmethod**: must be decorated with `@classmethod`
- **Non-unique NODE_CLASS_MAPPINGS keys**: collisions with other node packs cause silent failures
- **V3 schema ID collision**: input and output IDs must be unique across `io.Schema`; use `display_name` when labels should match
- **V3 mutable state**: do not rely on `__init__` values during execution; use inputs, hidden values, or external storage keyed by `io.Hidden.unique_id`

### Tensor Shape Debugging

```python
logger.debug("Image shape: %s dtype: %s", image.shape, image.dtype)
# Expected: IMAGE [B,H,W,3], LATENT samples [B,4,H,W], MASK [B,H,W] or [H,W]
```

### Type Compatibility

When accepting enum types (samplers, schedulers), validate against the known lists:
```python
import comfy.samplers
valid_samplers = comfy.samplers.KSampler.SAMPLERS
valid_schedulers = comfy.samplers.KSampler.SCHEDULERS
```

## Compatibility Testing

### Cross-Node-Pack Compatibility
- Test with commonly used node packs (Impact Pack, rgthree, etc.)
- Watch for scheduler/sampler enum conflicts
- Verify custom datatypes don't collide (`WARPPIPE`, not `CONTROL`)

### Wildcard Input Testing
For nodes accepting any type (`"*"`):
```python
@classmethod
def VALIDATE_INPUTS(cls, input_types=None, **kwargs):
    return True  # Required to skip type validation for wildcard inputs
```

For V3:
```python
@classmethod
def validate_inputs(cls, input_types=None, **kwargs):
    return True
```

### Memory and Performance
- Large tensor operations: use `comfy.model_management.get_torch_device()` for GPU placement
- Thread safety: use locks for shared state (`threading.Lock`)
- Memory leaks: implement cleanup for any global storage (TTL expiry, max cap)

## Pre-Release Testing Checklist

- [ ] ComfyUI starts without import errors
- [ ] Plain Python import works or intentionally skips with clear guards
- [ ] V3 `comfy_entrypoint()` returns an extension and every node `GET_SCHEMA()` validates
- [ ] All nodes appear in Add Node menu
- [ ] Each node executes with minimal inputs
- [ ] Optional inputs work when disconnected (no crashes)
- [ ] Default values produce valid output
- [ ] Node works in a saved/loaded workflow (serialization roundtrip)
- [ ] `IS_CHANGED` returns consistent results for unchanged inputs
- [ ] V3 `fingerprint_inputs` returns consistent results for unchanged inputs
- [ ] No `print()` statements in production code (use `logging`)
- [ ] `requirements.txt` has no ComfyUI/torch dependencies
- [ ] Tested on target Python versions (3.9+)

## Workflow Testing

### Save/Load Roundtrip
1. Create a workflow using your nodes
2. Save as JSON (API format)
3. Load the saved workflow
4. Verify all connections restore correctly
5. Re-execute and compare results

### Edge Cases to Test
- Empty/None inputs on optional ports
- Batch size > 1 for IMAGE/LATENT inputs
- Unusual image dimensions (non-square, very small, very large)
- Multiple instances of the same node in one workflow
