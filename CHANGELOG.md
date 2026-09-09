# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- **Refreshing node definitions now refreshes the LoRA library too**: pressing `r`, or using the menu, reloaded every other node's model lists but not ours. The library is cached in the browser, so a LoRA added since the tab was opened stayed unknown - its tag read red and completion never offered it. The prompt box and the browser share one cache and both pick it up now, along with any `.civitai.info` written since

## [4.0.1] - 2026-09-01

### Fixed

- **Even card heights in the LoRA browser**: a card's height came from its content, so a missing creator, a name that wrapped to two lines, or trigger words each added or removed a row and the grid went ragged. Every row now states its height in pixels and the trigger count moved onto the preview as a badge, which costs no height at all
- **The no-preview placeholder ran 24px tall**: it carried padding without `border-box`, so a card with no preview image pushed its own caption down and clipped the base-model line off the bottom

### Added

- **Open a model's page from the browser**: each card carries a ↗ to its Civitai page, as a control of its own rather than a modifier on the click that inserts the tag. Cards whose sidecar records no source do not show one

## [4.0.0] - 2026-09-01

### Added

- **Save Image (Civitai)** node: writes an A1111-style `parameters` block that Civitai parses, so uploaded images show their prompt, sampler settings and linked resources. Embedding the ComfyUI workflow stays optional via a toggle.
- **Resource identification**: checkpoints and LoRAs are identified by AutoV2 hash (the first 10 characters of the file's SHA256). Hashes are read from `.civitai.info` sidecars when present and otherwise computed once and cached on disk.
- **Prompt + LoRAs** node: write the prompt and its LoRAs in one text box using A1111 `<lora:name:weight>` syntax. A tag may name any unambiguous fragment of a filename, so long foldered names do not have to be typed in full. Nothing is added to the prompt: trigger words go in by hand, where they can be read and edited like the rest of it.
- **Prompt notes**: anything after `//` is removed before the prompt is encoded, so a line can be commented out - including a LoRA tag, which then does not load. The prompt is tidied afterwards so a removed tag leaves no stranded spaces or doubled commas.
- **A coloured prompt box**: tags, notes and trigger words are coloured as you type, with a red tag for a name that matches no file and an orange one for a file made for another base model. One line under the prompt describes whichever tag the caret is in - its preview, creator, weight and trigger words - and opens the full details.
- **Editing verbs on the text**: `Ctrl+↑`/`Ctrl+↓` change a tag's weight, `Ctrl+/` comments a line out (which switches that LoRA off), and `Alt+↑`/`Alt+↓` reorder. Each is an ordinary edit that the browser's own undo understands.
- **`/` in the prompt** completes inline over both LoRAs and embeddings, drawn as grey text rather than a popover, inserting `<lora:...>` or `embedding:...` as appropriate. `Tab` on an existing tag offers that LoRA's trigger words.
- **Embeddings index**: a `/warppipe/embeddings` route, in the same shape as the LoRA index.
- **Friendlier node labels**: widgets read Prompt, Trigger words and Apply to, with tooltips.
- **LoRA browser**: a Browse button on the Prompt + LoRAs node opens a library modal - a rail of model families with counts, a searchable grid of preview cards, and click-to-insert. The family of the model wired into the node is pinned and the rest dimmed, so 761 LoRAs narrow to the ones that can actually apply. Cards insert the bare filename, which resolves uniquely for all 761.
- **LoRA library index**: a `/warppipe/loras` route listing every LoRA with its creator, name, version, folder, base model and trigger words, parsed from the `creator - name - version (base)` filename convention and the `.civitai.info` sidecar. Built for 761 files in 0.65s, 227 KB of JSON.
- **Thumbnail cache**: a `/warppipe/lora/thumbnail` route serving 320px WebP previews, cached by path and mtime. Preview images average 1.27 MB each and total about a gigabyte; the cached thumbnails are 6-9 KB, built in 28ms and served in under a millisecond after that.
- **Dated filenames**: `filename_prefix` accepts `%date:FORMAT%`, e.g. `%date:yy-MM-dd hh-mm-ss%`. ComfyUI expands this in its frontend only, so prompts sent over the API never saw it; expanding it server-side makes both paths behave alike.
- **LoRA tag matching**: tags are matched against the full name, the bare filename, every word in any order, or a unique fragment, ignoring case and slash direction. A tag matching nothing or several files stops the run naming what it matched, rather than quietly producing an image without the LoRA.
- **Model detection**: recognises loaders by the input they carry (`ckpt_name`, `unet_name`), so checkpoint, UNet/diffusion and GGUF loaders are all found without naming each pack. The model field on the node is an override, not a requirement.
- **Upstream tracing**: resources are collected only from nodes that actually fed the saved image, so unrelated branches of a large workflow do not contribute the wrong model or LoRA.
- **LoRA detection**: reads ComfyUI's own loaders, the stacked slot format used by rgthree's Power Lora Loader (skipping disabled slots), and `<lora:name:weight>` tags written into the prompt.

### Fixed

- **Every node registered on both paths**: `WARPPIPE_ENABLE_V3=1` registered five of the seven nodes, so a workflow using Save Image (Civitai) or Prompt + LoRAs failed to open with nothing said about why. Both paths are now built from one table, and a node missing a V3 schema is reported at startup
- **Nearest model on a tie**: with several checkpoints at the same distance from the saved image, the metadata credited whichever filename sorted first rather than the one the graph listed first
- **Scheduler coercion**: `SAFE_SAMPLERS` and `SAFE_SCHEDULERS` referenced ComfyUI's own lists rather than copying them, so anything another pack appended later walked through `coerce_scheduler` untouched - the one thing it exists to prevent
- **Interrupted cache writes**: the hash cache and the thumbnail cache wrote straight to their final paths, leaving a truncated file behind if anything interrupted them. Both now write through a temporary file and rename
- **Frontend teardown**: the Prompt + LoRAs node left a 100ms timer, a MutationObserver and its strip behind when the node was removed, so they ran for the rest of the session against a page that was gone
- **Escaped library markup**: model names, versions and base models came from filenames and downloaded sidecars but were written into the browser's rows as markup
- **The frontend was missing from built wheels**: `package-data` listed `web/docs/*.md` but no JavaScript, so an install from the registry had a `web/` directory containing only documentation - no prompt UI, no library browser, no save-node labels
- **Dead code in the save node**: a branch preferring "LoRAs recorded in the warp" could never run, because nothing ever wrote them there. The graph scan already reads the Prompt + LoRAs node's tags

### Documentation

- **Rewritten README**, compact and built to be scanned: what the pack does, three screenshots, install, the node table, and links out. Everything longer moved to the wiki
- **Screenshots taken from a real ComfyUI** rather than described in prose, captured against a generated demo LoRA folder so no personal library appears
- **[WIKI.md](WIKI.md)**: getting started, usage, a node reference, the HTTP API, architecture, development and troubleshooting, in one file. The README is the shop window; the detail lives there
- **The Civitai Updater relationship, written down**: which sidecar field feeds which feature, and exactly what stops working without one. Only the AutoV2 hash has a fallback
- **A new example workflow**: two model configurations, Krea 2 and Z-Image Turbo, each with its own Warp, switched into one shared pipeline. The generated image carries both the workflow and the Civitai `parameters` block it was saved with
- **Assets restructured** into `assets/registry/` (sized and quantised for the listing - the banner went from 4.8 MB to 487 KB), `assets/docs/` (screenshots, 352 KB for six) and `assets/source/` (the originals)
- **Corrected the node help**: the Prompt + LoRAs page described a "Trigger words" setting that does not exist and then contradicted itself 25 lines later; the save page described a recorded-LoRA path that was never built

### Improved

- **Frontend lint and formatting**: eslint and prettier over `web/`, checked in CI in a job of their own. A third of this pack by volume had no automated checks at all
- **One library cache**: the prompt and the browser each held their own and fetched the index separately; they now share one, so the server indexes the model folder once
- **Single sidecar read per model**: indexing a library opened and parsed every `.civitai.info` twice, once for the payload and once more for its trigger words
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
