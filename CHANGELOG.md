# Changelog

All notable changes to this project will be documented in this file.

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
