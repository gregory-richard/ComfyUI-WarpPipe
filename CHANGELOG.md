# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **Save Image (Civitai)** node: writes an A1111-style `parameters` block that Civitai parses, so uploaded images show their prompt, sampler settings and linked resources. Embedding the ComfyUI workflow stays optional via a toggle.
- **Resource identification**: checkpoints and LoRAs are identified by AutoV2 hash (the first 10 characters of the file's SHA256). Hashes are read from `.civitai.info` sidecars when present and otherwise computed once and cached on disk.
- **Prompt + LoRAs** node: write the prompt and its LoRAs in one text box using A1111 `<lora:name:weight>` syntax. A tag may name any unambiguous fragment of a filename, so long foldered names do not have to be typed in full. Optionally appends the trigger words each LoRA declares in its `.civitai.info` sidecar.
- **Dated filenames**: `filename_prefix` accepts `%date:FORMAT%`, e.g. `%date:yy-MM-dd hh-mm-ss%`. ComfyUI expands this in its frontend only, so prompts sent over the API never saw it; expanding it server-side makes both paths behave alike.
- **LoRA tag matching**: tags are matched against the full name, the bare filename, every word in any order, or a unique fragment, ignoring case and slash direction. A tag matching nothing or several files stops the run naming what it matched, rather than quietly producing an image without the LoRA.
- **LoRAs recorded in the warp**: the node stores what it actually applied, and the save node prefers that over rediscovering resources from the graph.
- **Model detection**: recognises loaders by the input they carry (`ckpt_name`, `unet_name`), so checkpoint, UNet/diffusion and GGUF loaders are all found without naming each pack. The model field on the node is an override, not a requirement.
- **Upstream tracing**: resources are collected only from nodes that actually fed the saved image, so unrelated branches of a large workflow do not contribute the wrong model or LoRA.
- **LoRA detection**: reads ComfyUI's own loaders, the stacked slot format used by rgthree's Power Lora Loader (skipping disabled slots), and `<lora:name:weight>` tags written into the prompt.

### Improved

- **Reproducible CI toolchain**: Pinned `build`, `pytest`, and `ruff` so lint and test results depend on the repository rather than on when a build happens to run
- **Explicit lint rule set**: Selected ruff rules in `pyproject.toml`, documenting the rule families that ComfyUI's conventions make unactionable (framework-mandated method names, the node-pack directory name, and emoji in display names)
- **Modernized annotations**: Internal type hints now use PEP 585 builtins, and the fallback sampler shims are annotated with `ClassVar`
- **Version-gated publishing**: The registry workflow now publishes only when the version in `pyproject.toml` actually changes, so metadata edits no longer force a version bump

## [3.3.0] - 2026-08-30

### Added

- Unit tests for legacy and V3 registration, bundle round-trips, storage cleanup, scheduler compatibility, and latent validation
- GitHub Actions validation on Python 3.9 and 3.13, including lint, formatting, tests, and package builds

### Fixed

- Removed the process-wide ComfyUI input-validator monkey-patch and switched V3 enum outputs to the native `io.Combo.Output` schema
- Preserved backend type checks for non-enum Warp links while allowing sampler and scheduler enums from compatible node packs
- Corrected V3 registration so `comfy_entrypoint` and legacy node mappings are never exported simultaneously
- Enforced the warp-storage hard cap on insertion and made stale/orphan cleanup atomic
- Preserved `None` for fields absent from a warp instead of inventing sampler, scheduler, and dimension defaults
- Rejected invalid linked dimensions and batch sizes before creating inconsistent latent tensors
- Corrected package configuration so built wheels contain the WarpPipe Python package and node documentation

## [3.2.1] - 2026-06-14

### Fixed

- **Combo enum validation compatibility**: Added a narrow compatibility patch for ComfyUI builds that expose sampler and scheduler combo outputs as comma-joined enum strings, preventing false `Return type mismatch` errors when linking WarpPipe sampler/scheduler values into `COMBO` or list-backed sampler inputs.
- **Linked sampler/scheduler inputs**: Updated Warp and FD Scheduler Adapter validation signatures so linked enum inputs from other node packs can be accepted and normalized by WarpPipe.
- **V3 registration stability**: Made V3 schema node registration opt-in with `WARPPIPE_ENABLE_V3=1` while keeping legacy node mappings as the default path for saved workflow compatibility.

## [3.2.0] - 2026-06-10

### Added

- **ComfyUI V3 schema support**: Added optional `comfy_entrypoint()` registration with schema-backed V3 node classes when `comfy_api` is available, while keeping legacy mappings for older ComfyUI installs

### Improved

- **Local import validation**: Expanded the development fallback sampler mock so `warp_pipe.py` can be imported outside a ComfyUI checkout for smoke testing
- **Developer skills**: Updated local ComfyUI development, testing, and publishing skills with V3 migration guidance

## [3.1.0] - 2026-02-15

### Added

- **RES4LYF compatibility**: Globally registers `beta57` and `bong_tangent` schedulers in `comfy.samplers.SCHEDULER_NAMES` and `SCHEDULER_HANDLERS` so other nodes (like FaceDetailer) pick them up even if RES4LYF hasn't loaded yet

### Improved

- **Dynamic FD_SCHEDULERS**: Replaced hardcoded scheduler list with `list(comfy.samplers.SCHEDULER_HANDLERS) + IMPACT_PACK_SCHEDULERS` to stay in sync with ComfyUI's built-in schedulers
- **Consistent display names**: Unified all node display names to use the spiral emoji

## [3.0.0] - 2026-02-09

### Breaking Changes

- **Renamed custom data type** from `CONTROL` to `WARPPIPE` for uniqueness and to avoid collisions with other node packs. Existing workflows may need Warp-to-Unwarp connections manually reconnected once.
- **Renamed registry package** from `comfyui-warppipe` to `warppipe` per ComfyUI best practice. Install with `comfy node install warppipe`.

### Added

- **Node documentation**: Rich markdown help pages for all 5 nodes, displayed in ComfyUI's node docs panel
- **VALIDATE_INPUTS** on Dead End node for proper wildcard (`*`) input type support per ComfyUI docs
- **OS-independent classifier** in pyproject.toml for registry compatibility
- **`web/` directory** created to match the `WEB_DIRECTORY` export

### Fixed

- **Memory leak**: Warp storage now has automatic time-based cleanup (entries expire after 1 hour) and a 256-entry hard cap to prevent unbounded memory growth
- **Noisy console output**: Replaced all debug `print()` statements with Python `logging` module (`WarpPipe` logger). Use DEBUG level to see internal details.

## [2.2.0] - 2025-12-31

### Added

- Expanded resolution presets in Warp Provider node:
  - Added support for various aspect ratios: 9:16, 3:4, 2:3, 4:5, 1:1, 5:4, 3:2, 4:3, 16:9
  - Included specific resolutions optimized for SDXL
  - Added detailed labels showing aspect ratio, resolution, and megapixel count
  - Sorted presets by aspect ratio and size for better usability

## [2.1.0] - 2025-12-15

### Added

- **Dead End** node for workflow debugging and branch control
- Accepts any input type using universal `*` type specifier
- True dead end: produces no outputs and doesn't trigger execution

### Fixed

- Made Unwarp node input optional to prevent errors when no warp is connected
- Graceful error handling: returns None values instead of throwing errors

## [2.0.0] - 2025-12-01

### Added

- **Warp Provider** node with preset dimensions and latent generation
- **FD Scheduler Adapter** for FaceDetailer compatibility
- Enhanced scheduler compatibility with automatic coercion system
- Support for mask data type
- Multiple sampling steps (steps_1, steps_2, steps_3)
- Thread-safe storage implementation with proper locking

### Improved

- Error handling and validation with ComfyUI import fallbacks
- Code structure with detailed docstrings

## [1.0.0] - 2025-11-01

### Added

- Initial release
- **Warp** and **Unwarp** nodes for data bundling
- Support for all major ComfyUI data types (MODEL, CLIP, VAE, CONDITIONING, IMAGE, LATENT, etc.)
