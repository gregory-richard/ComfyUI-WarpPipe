# Prompt + LoRAs

Write the prompt and the LoRAs it uses in one text box.

## Overview

The **Prompt + LoRAs** node keeps a prompt and its LoRAs together instead of
splitting them between a text node and a loader. LoRAs are written inline using
the same `<lora:name:weight>` syntax A1111 uses:

```
a portrait, dramatic lighting <lora:detail tweaker:0.8>
```

Switching a LoRA becomes an edit to the text rather than a rewire.

## Naming a LoRA

A tag does not need the full filename. Any fragment that matches exactly one
file in your `loras` folder works, so this:

```
loras/sdxl/w4r10ck - detail tweaker (sdxl).safetensors
```

can be written as `<lora:detail tweaker:0.8>`.

If a fragment matches several files, or none, the tag is skipped and the reason
is written to the ComfyUI console. The rest of the prompt still runs — a typo
costs you one LoRA, not the whole generation.

## Trigger words

With **insert_trigger_words** enabled, the node appends the trigger words each
LoRA declares in its `.civitai.info` sidecar, skipping any already present in
your prompt. Those sidecars are written by tools like Civitai Updater; without
one, there are no trigger words to add and the prompt is left as written.

The words are added to the **prompt** output, not shown on the node.

## Inputs

- **text** — The prompt, with any `<lora:name:weight>` tags inline.
- **insert_trigger_words** — Append trigger words from each LoRA's sidecar.
- **model** (optional) — The model the LoRAs are applied to.
- **clip** (optional) — The CLIP the LoRAs are applied to.
- **warp** (optional) — An existing warp to copy from and extend.

## Outputs

- **model** — The model with every resolved LoRA applied.
- **clip** — The CLIP with every resolved LoRA applied.
- **prompt** — The prompt with the tags removed, ready for a text encoder.
  Trigger words appear here when enabled.
- **warp** — A warp carrying the prompt and the LoRAs that were applied.

## Wiring it

Connect **model** and **clip** from your loader, and send the **model**,
**clip** and **prompt** outputs on to your sampler and text encoder.

The **warp** output is optional. Leaving it unconnected is fine: the Save Image
(Civitai) node reads the LoRA tags straight out of this node's text when it
builds its metadata, so resources are still recorded. Connect it only if you
want the warp assembled here rather than later.

## Notes

- Both model and CLIP strength use the tag's single weight.
- LoRA loading uses ComfyUI's own loader, so behaviour matches a standard
  LoRA Loader node.
