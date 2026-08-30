# Save Image (Civitai)

Save images with generation metadata that Civitai can read.

## Overview

ComfyUI writes its workflow into a PNG in its own format, which Civitai does not
parse — which is why an uploaded image shows no prompt and no linked resources.
This node additionally writes an A1111-style `parameters` block, the format
Civitai does read, so one file works for both purposes.

The ComfyUI workflow is still embedded by default, so saved images keep opening
as workflows when dragged back in.

## How resources are identified

Civitai matches a checkpoint or LoRA by a hash of the file, not by its name.
The hash is `AutoV2`: the first 10 characters of the file's SHA256.

Hashes are read from a model's `.civitai.info` sidecar when one exists, as
written by tools like Civitai Updater. Without a sidecar, the file is hashed
once and the result cached by path, size and modification time, so large
checkpoints are not re-read on later saves.

## Finding what was used

The node walks the workflow backwards from the image being saved and collects
only the loaders that actually contributed to it. Branches that did not feed
this image are ignored, so a workflow holding many models behind switches still
reports the right one.

It recognises loaders by the input they carry — `ckpt_name`, `unet_name` — which
covers checkpoint, diffusion/UNet and GGUF loaders alike. It also reads
`<lora:name:weight>` tags from text inputs, including this pack's Prompt +
LoRAs node and power-prompt nodes from other packs, and the stacked slot format
used by rgthree's Power Lora Loader, honouring each slot's on/off switch.

When a warp from the Prompt + LoRAs node is connected, the LoRAs it recorded are
used directly instead, since that node knows exactly what it applied.

## Inputs

- **images** (optional) — The images to save. Optional so that bypassing an
  upstream branch leaves this node idle rather than failing the prompt with
  a missing connection. With nothing connected it saves nothing and says so
  in the console.
- **filename_prefix** — Prefix for saved files. Supports `%date:FORMAT%`, using
  the field letters `yyyy`, `yy`, `MM`, `dd`, `hh`, `mm`, `ss` — note that `MM`
  is the month and `mm` the minute. `%date:yy-MM-dd hh-mm-ss%` gives
  `26-08-28 17-28-56_00001_.png`. A slash makes a subfolder, so
  `shots/%date:yyyy-MM-dd%/img` files output by day. ComfyUI's own `%width%`
  and `%height%` still work. Characters a filename cannot contain become `-`.
- **embed_workflow** — Embed the ComfyUI workflow alongside the metadata.
- **warp** (optional) — Supplies prompt, seed, steps, CFG, sampler, scheduler
  and size. Without it, only what can be read from the graph is written.
- **model_name_override** (optional) — Use only when detection reports the wrong
  model. Leave empty otherwise.

## Which steps value is used

A warp can carry `steps_1`, `steps_2` and `steps_3`, but the metadata format has
a single `Steps` field. `steps_1` is written.

## Notes

- Sampler names are written as ComfyUI spells them (`dpmpp_2m`), not translated
  to A1111's spelling. Resource linking depends on hashes, not on these names.
- If a resource appears in the metadata by name but is not linked on Civitai,
  its file could not be found or hashed — check the console for the path.
