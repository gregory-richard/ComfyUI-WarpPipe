# Nodes

Seven nodes, all under **Custom/WarpPipe Nodes**. Node IDs are what saved
workflows and the API use; display names are what you see on the canvas.

| ID | Display name |
| --- | --- |
| `Warp` | 🌀 Warp |
| `Unwarp` | 🌀 Unwarp |
| `Warp Provider` | 🌀 Warp Provider |
| `Warp Lora Prompt` | 🌀 Prompt + LoRAs |
| `Save Image Civitai` | 🌀 Save Image (Civitai) |
| `FD Scheduler Adapter` | 🌀 Scheduler Adapter for FaceDetailer |
| `Dead End` | 🚫 Dead End |

---

## 🌀 Warp

Bundles data into a single `WARPPIPE` object.

**Inputs** — all optional.

| Input | Type | Notes |
| --- | --- | --- |
| `warp` | `WARPPIPE` | Start from another warp's contents, then add to them |
| `model_1`, `model_2` | `MODEL` | |
| `clip` | `CLIP` | |
| `clip_vision` | `CLIP_VISION` | |
| `vae` | `VAE` | |
| `conditioning_positive`, `conditioning_negative` | `CONDITIONING` | |
| `image` | `IMAGE` | |
| `mask` | `MASK` | |
| `latent` | `LATENT` | |
| `prompt_positive`, `prompt_negative` | `STRING` | link only |
| `batch_size`, `seed`, `steps_1`, `steps_2`, `steps_3`, `width`, `height` | `INT` | link only |
| `cfg` | `FLOAT` | link only |
| `sampler_name` | sampler enum | link only |
| `scheduler` | scheduler enum | link only |

**Output:** `warp` — `WARPPIPE`.

Three step counts exist because multi-pass workflows want them: a base pass, a
refiner, a detailer. Nothing forces you to use more than `steps_1`.

Sampler and scheduler are coerced on the way in. A name ComfyUI does not know
becomes `euler` or `karras` rather than travelling as something a sampler will
later reject. Linked enums from other node packs are accepted — see
[Architecture → Validation](Architecture.md#validation).

---

## 🌀 Unwarp

Unpacks a warp. Its one input, `warp`, is optional; with nothing connected every
output is `None`.

**Outputs**, in order:

`model_1`, `model_2`, `image`, `mask`, `clip`, `clip_vision`, `vae`,
`conditioning_positive`, `conditioning_negative`, `latent`, `prompt_positive`,
`prompt_negative`, `batch_size`, `seed`, `steps_1`, `steps_2`, `steps_3`, `cfg`,
`sampler_name`, `scheduler`, `width`, `height`.

A field the warp never carried comes back as `None`, not as a default. Inventing
`euler` for a sampler nobody set would produce an image with the wrong settings
and no indication that anything was missing.

---

## 🌀 Warp Provider

Sampling parameters and a matching empty latent, in one node.

| Input | Type | Default | Range |
| --- | --- | --- | --- |
| `batch_size` | `INT` | 1 | 1–64 |
| `seed` | `INT` | 0 | 0–2⁶⁴−1 |
| `steps_1` | `INT` | 20 | 1–200 |
| `steps_2`, `steps_3` | `INT` | 0 | 0–200 |
| `cfg` | `FLOAT` | 7.0 | 0.0–50.0 |
| `sampler_name` | sampler enum | `euler` | |
| `scheduler` | scheduler enum | `normal` | |
| `size_preset` | 31 presets | Square (SDXL native) 1024×1024 | |
| `custom_width`, `custom_height` | `INT` | 1024 | 64–8192, step 8 |

**Outputs:** `latent`, `batch_size`, `seed`, `steps_1`, `steps_2`, `steps_3`,
`cfg`, `sampler_name`, `scheduler`, `width`, `height`.

Presets are labelled `use case | ratio | width × height | megapixels` and sorted
by aspect ratio (9:16 up to 16:9), then by size. Every one is divisible by 8
with the short side at most 2048. Choose `Custom` to use the two custom boxes.

The latent is four channels at an eighth scale — the SD1.5/SDXL shape, matching
ComfyUI's own Empty Latent Image. Wider-latent architectures need their own
node.

Dimensions are validated before the tensor is made: a linked width that is not
an integer, is out of range, or is not divisible by 8 raises rather than
producing a latent nothing can sample.

---

## 🌀 Prompt + LoRAs

The prompt and its LoRAs in one text box. Full walkthrough in
[Usage → Writing a prompt](Usage.md#writing-a-prompt).

| Input | Type | Notes |
| --- | --- | --- |
| `text` | `STRING` | multiline. The prompt, with `<lora:name:weight>` tags inline and `//` notes |
| `apply_to_clip` | `BOOLEAN` | default on. Patch the text encoder as well as the model |
| `model` | `MODEL` | optional |
| `clip` | `CLIP` | optional |

**Outputs:** `model`, `clip`, `prompt`.

`prompt` is what you wrote with tags and notes removed and nothing added. Blank
lines you wrote are kept — at most one in a row — but a line that held only a
tag or only a note is removed rather than left behind as a blank.

**`apply_to_clip`** decides whether the text encoder is patched too. Whether it
matters depends entirely on the LoRA: in a survey of 761 files, every Krea2,
Flux2, Wan, Qwen, ZIT and LTX LoRA was model-only, so patching CLIP changed
nothing; among SDXL LoRAs, 76% carried text-encoder weights, where turning it off
discards half of what the LoRA does. Leave it on unless you have a reason.

Encode the prompt **after** the LoRAs are applied — take this node's `clip`
output into your text encoder, not the CLIP straight from the loader.

There is also a hidden `loras` input, kept so workflows saved before the tags
moved into the prompt still load. The strip offers to move its contents into the
prompt; nothing writes to it any more.

---

## 🌀 Save Image (Civitai)

Saves images with metadata Civitai reads. Details in
[Usage → Saving for Civitai](Usage.md#saving-for-civitai).

| Input | Type | Default | Shown as |
| --- | --- | --- | --- |
| `filename_prefix` | `STRING` | `WarpPipe` | Save as |
| `embed_metadata` | `BOOLEAN` | on | Generation info |
| `embed_workflow` | `BOOLEAN` | on | Workflow |
| `file_format` | `png` / `jpeg` | `png` | Format |
| `preview` | `BOOLEAN` | on | Preview |
| `images` | `IMAGE` | — | optional |
| `warp` | `WARPPIPE` | — | optional |

Hidden inputs: `prompt`, `extra_pnginfo`, `unique_id`. No outputs — this is an
output node.

`images` is optional on purpose: bypassing an upstream branch leaves this node
idle instead of failing the whole prompt. When nothing arrives it saves nothing
and says so, on the node and in the log, rather than reporting a silent success.

---

## 🌀 Scheduler Adapter for FaceDetailer

**Input:** `scheduler` — a KSampler scheduler (required).
**Output:** `scheduler` — one FaceDetailer accepts.

FaceDetailer builds its list as ComfyUI's schedulers plus Impact Pack's own.
Exotic entries — `AYS SDXL`, `GITS[coeff=1.2]`, `OSS FLUX` and friends — pass
through when the target list has them and are mapped to `karras` when it does
not.

---

## 🚫 Dead End

**Input:** `input` — any type, optional. **No outputs.**

It is not an output node, so ComfyUI never executes it, which is the point: it
terminates a branch without running it. Useful for parking a path while you work
on another, or for tidying an unused output.

---

## Registration

Both registration paths are built from one table in `warp_pipe.py`, so every
node exists whichever path runs.

- **Legacy** (default) — `NODE_CLASS_MAPPINGS` and `NODE_DISPLAY_NAME_MAPPINGS`.
- **V3** — set `WARPPIPE_ENABLE_V3=1` to register through
  `comfy_entrypoint()` and ComfyUI's V3 schema instead.

The two are mutually exclusive; the package exports one or the other, never
both. If a node were ever added without a V3 schema, startup logs an error
naming it rather than quietly dropping it.
