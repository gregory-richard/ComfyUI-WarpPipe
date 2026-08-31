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

## Filenames it does not recognise

A name shaped `creator - title - version (base)` is split into those parts for
display. Any other name is left whole — it is shown as-is rather than guessed
at, and nothing depends on the shape.

What a LoRA is compatible with comes from its `.civitai.info` sidecar, not from
its name or folder, so the library groups correctly whatever the files are
called. Files without a sidecar fall back to grouping by folder.

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

## Colours in the prompt

The prompt box colours what it finds, so the text says what it will do:

| | |
| --- | --- |
| cyan | a LoRA tag that matches a file |
| red, underlined | a tag matching nothing — check the spelling |
| amber | an embedding |
| green | a trigger word belonging to one of the LoRAs in use |
| grey italic | a note, which is not sent |

A tag inside a note is coloured as a note, because that is what happens to it:
it does not load.

## Where the LoRAs live

Picking a LoRA adds it to the list under the prompt, not into the prompt text.
The prompt stays prose; the list is what the rows show and what gets applied.

Tags typed straight into the prompt still work and are applied too, so an older
workflow keeps running. If both name the same LoRA, the list wins, since that is
what the rows are showing you.

## Adding a LoRA without typing its name

Press **/** anywhere in the prompt for a picker of LoRAs and embeddings, with
previews. Type to filter, arrow keys to move, Enter or click to insert. A LoRA
is inserted as `<lora:name:1.0>`, an embedding as `embedding:name`.

The **Browse LoRAs** button opens the full library instead, with a rail of model
families.

## The rows under the prompt

A LoRA is never text in the prompt. Type a tag, paste one, or open a workflow
that kept its tags inline, and it moves out of the prompt into a row — the
prompt stays prose. A tag inside a `//` note is left where it is, since parking
one there is deliberate.

Each row carries:

- **⠿** drag to reorder, or drag out of the node to copy the tag as text
- the preview, the model's title, and its creator and version underneath
- **⊕** choose trigger words to insert — see below
- **↗** open its page on Civitai
- the weight — drag in steps of 0.1, or click and type a value
- **◉ / ○** switch it off and on. A LoRA switched off is kept, greyed and struck
  through, and not applied
- **⧉** copy its tag to the clipboard
- **✕** remove it

The title comes from the `.civitai.info` sidecar rather than the filename, so it
reads correctly whatever the file is called. Without a sidecar the row falls back
to the filename and has no link.

## Where the list sits

The field holds two panels: the prompt on top, the LoRAs beneath, with a divider
between them. Each scrolls on its own, so a long prompt and a long list stay out
of each other's way and neither makes the node taller.

Drag the divider to give one panel more room than the other. The position is
saved with the workflow, and stays between a quarter and four fifths so neither
panel can be squeezed shut.

With nothing in the list the divider and the list both disappear, and the field
is an ordinary prompt box.

## Choosing trigger words

**⊕** opens a list of that LoRA's trigger words. Creators sometimes declare a
single word and sometimes several paragraphs — in one collection of 761 files the
longest ran to 655 characters — so they are offered one at a time rather than
inserted wholesale. Words already in the prompt are dimmed, and **Insert all**
adds whatever is missing.

A row outlined in red names a file that does not exist.

Switching off writes the line out as a comment, which is the same rule as `//`
in the prompt: commented means not applied. Nothing here is a second copy of the
state — the rows are the list, drawn.

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
