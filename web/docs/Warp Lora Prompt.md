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

A tag does not need the full filename, but it does need enough to identify one
file. Measured against a real collection of 761 LoRAs, a short fragment like
`detail tweaker` is unique only about half the time — 24 files there contain
`secret sauce` alone.

Matching is tried in this order, ignoring case and slash direction:

1. the full name, `sdxl/creator - detail tweaker (sdxl).safetensors`
2. the filename without folder or extension, `creator - detail tweaker (sdxl)`
3. every word, in any order — `sdxl detail tweaker` finds the above
4. a unique fragment, `detail tweaker`

Option 2 always works. Option 3 is usually the shortest thing worth typing.

A tag that matches nothing suggests the nearest names, so a typo is a
question rather than a dead end.

**A tag that matches nothing, or matches several files, stops the run** with a
message naming what it matched. That is deliberate: generating an image without
a LoRA the prompt asked for gives you a wrong picture and wrong metadata, and a
console warning is too easy to miss.

## Notes

Anything after `//` to the end of the line is a note for you, not for the model.
It is removed before the prompt is encoded, so a line can be commented out to
disable it — including a LoRA tag, which then does not load either.

```
a photo in a sunlit kitchen   // try 0.6 next time
// <lora:detail tweaker:0.8>  <- parked for now
```

Removing a tag or a note leaves gaps behind it, so the prompt is tidied
afterwards: no stranded spaces before commas, no doubled commas, no blank lines
left where a note used to be.

## Trigger words

With **insert_trigger_words** enabled, the node appends the trigger words each
LoRA declares in its `.civitai.info` sidecar, skipping any already present in
your prompt. Those sidecars are written by tools like Civitai Updater; without
one, there are no trigger words to add and the prompt is left as written.

The words are added to the **prompt** output, not shown on the node.

## Model only, or model and CLIP

A LoRA can carry weights for the diffusion model, the text encoder, or both.
**apply_to_clip** controls whether the text encoder is patched as well.

Whether it matters depends entirely on the LoRA. Surveying a real collection of
761 files: every Krea2, Flux2, Wan, Qwen, ZIT and LTX LoRA in it was model-only,
so patching CLIP changed nothing at all. Among SDXL LoRAs, 76% did carry
text-encoder weights, where turning this off would discard half of what the
LoRA does.

Leave it on unless you have a reason. On a model-only LoRA it costs nothing.

## Conditioning order

Encode the prompt **after** the LoRAs are applied — take this node's **clip**
output into your text encoder, not the CLIP straight from the loader. For a
model-only LoRA the two are identical, but for one carrying text-encoder
weights, encoding first would silently drop them.

## Inputs

- **text** — The prompt, with any `<lora:name:weight>` tags inline.
- **insert_trigger_words** — Append trigger words from each LoRA's sidecar.
- **apply_to_clip** — Patch the text encoder as well as the model.
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
