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
  upstream branch leaves this node idle rather than failing the whole prompt.
  When nothing reaches it the node saves nothing and says so on screen — a run
  that wrote no file otherwise looks exactly like one that did.
- **filename_prefix** — Prefix for saved files. Supports `%date:FORMAT%`, using
  the field letters `yyyy`, `yy`, `MM`, `dd`, `hh`, `mm`, `ss` — note that `MM`
  is the month and `mm` the minute. `%date:yy-MM-dd hh-mm-ss%` gives
  `26-08-28 17-28-56_00001_.png`. A slash makes a subfolder, so
  `shots/%date:yyyy-MM-dd%/img` files output by day. ComfyUI's own `%width%`
  and `%height%` still work. Characters a filename cannot contain become `-`.
- **Generation info** (`embed_metadata`) — Write the `parameters` block: the
  prompt, seed, sampler, size, model and LoRA hashes, in the form Civitai and
  A1111 read. This is what gets your resources credited when you upload.
- **Workflow** (`embed_workflow`) — Write the ComfyUI graph, so the image can be
  dragged back in to rebuild it.
- **warp** (optional) — Supplies prompt, seed, steps, CFG, sampler, scheduler
  and size. Without it, only what can be read from the graph is written.

## The two switches

They were one toggle, and they are separate things.

The **generation info** is a short text block naming what made the image. It is
what a site reads to credit the model and the LoRAs.

The **workflow** is your entire graph — every node, every setting, every file
path on your machine — stored in the file. It is what makes a ComfyUI image
droppable back into ComfyUI, and it is also handed to everyone you send the
picture to. Turning it off while leaving the generation info on gives an upload
that credits its resources without publishing how you work.

Turning the generation info off skips building it, which skips hashing the
checkpoint and every LoRA.

## How the checkpoint is found

By walking back through the graph from this node and looking at what each node
upstream of it holds. Only nodes upstream count, so an unrelated branch of a
large workflow cannot contribute the wrong model, and the **nearest** loader
wins — a refiner in front of a base is the one that made the picture.

A node is not identified by its class name, so a loader from any pack works:

- The usual input names — `ckpt_name`, `unet_name`, `model_name` — are read
  first, which covers ComfyUI's own loaders and most others.
- Failing that, any value that looks like a model filename and **resolves inside
  the checkpoint, diffusion-model or UNet folders** is the model, whatever the
  input happens to be called. A pack that calls its input `the_weights_i_want`
  is found the same as one that does not.

Where the file lives is what distinguishes a model from a LoRA, VAE or CLIP, so
those are never mistaken for it even though they are all `.safetensors`.

Renaming a node, or relabelling its ports, changes nothing: labels are display
only, and none of this reads them. Converting `ckpt_name` into an input and
feeding it from a string node also still works — the name is found on the node
that holds it.

What it cannot find is a model that was never a file: a merge built in the
graph, or a loader that records no filename at all. Then no `Model:` is written,
because there is nothing true to write.

## Which steps value is used

A warp can carry `steps_1`, `steps_2` and `steps_3`, but the metadata format has
a single `Steps` field. `steps_1` is written.

## Notes

- Sampler names are written as ComfyUI spells them (`dpmpp_2m`), not translated
  to A1111's spelling. Resource linking depends on hashes, not on these names.
- If a resource appears in the metadata by name but is not linked on Civitai,
  its file could not be found or hashed — check the console for the path.
