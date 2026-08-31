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
| cyan | a LoRA tag that matches a file, for the model you are using |
| red, wavy underline | a tag matching nothing — check the spelling |
| orange, dotted underline | a real file, but made for another base model |
| amber | an embedding |
| green | a trigger word belonging to one of the LoRAs in use |
| grey italic | a note, which is not sent |

Red and orange are different complaints. Red will not load at all. Orange loads
perfectly well and usually does nothing useful, so it is a warning rather than
an error — you may know something the sidecar does not. Hover either for the
reason; orange names both base models. With nothing wired into **model**, or for
a file whose sidecar names no base, nothing can be judged and nothing is orange.

A tag inside a note is coloured as a note, because that is what happens to it:
it does not load.

## Where the LoRAs live

In the prompt, as text, each tag on a line of its own:

    a photo in a sunlit kitchen,
    <lora:bolero537 - boxer panties - v1.0 (anima):0.80>
    boxer panties
    warm light

They are not gathered at the top or the bottom - a tag belongs where you were
writing when you reached for it. The line to itself is what makes the rest work:
every LoRA verb below is an ordinary edit to one line, so commenting, moving or
deleting that line means exactly one LoRA and nothing else.

There is no separate list any more. Older workflows that kept one still run -
the backend reads both - and the strip under the prompt offers to move them in.

## Adding a LoRA without typing its name

Type **/** in the prompt followed by a few letters. The best match appears in
grey at the end of that line - press **Tab** to take it, or **arrow up/down** to
walk the other matches. **Escape**, or clicking elsewhere, drops the suggestion.
An embedding is written where you typed it, as `embedding:name`.

If the LoRA declares trigger words, they are offered straight away as a second
suggestion: **Tab** again puts them on the line under the tag, and the arrows
choose between all of them and one at a time. Adding a LoRA and saying its word
is Tab twice.

That offer is not a moment you can miss. Put the caret in any tag and press
**Tab** and its trigger words are offered again, however long ago it went in.
The strip shows a small **⇥** beside the words when there are some to offer.

Tab always answers. Not every LoRA declares trigger words - 470 of 1884 files in
one real collection declare none - so when there are none it says so, rather
than looking like a key that does not work. A tag naming a file that is not in
the library says that instead.

The grey text is only drawn, never typed. Until you press Tab the prompt holds
exactly what you typed, so a suggestion can never be typed over, never lands in
the undo history, and never marks the workflow changed just because you were
looking. Slashes in ordinary text - `1/2`, `and/or` - suggest nothing, because a
bare slash is a slash until you type something after it.

The **Browse LoRAs** button opens the full library instead, with previews and a
rail of model families.

### It suggests what fits the model you are using

The node follows its **model** input back to whichever loader feeds it, asks the
server what base model that file is, and drops every LoRA known to be for a
different one. The strip names the base it is matching, so it is never a mystery
why the list is short.

Only what is *known* not to fit is dropped. A LoRA with no `.civitai.info`
sidecar declares no base model, and guessing would hide one that works - 163 of
761 files in one real collection say nothing about theirs. Those still appear,
after the ones that match, so the first suggestion is a fit whenever a fit
exists. With nothing wired into **model**, everything is suggested.

## Changing a LoRA once it is there

With the caret in a tag:

| | |
| --- | --- |
| **Ctrl+↑ / Ctrl+↓** | weight, in steps of 0.1 |
| **Ctrl+/** | switch it off and on |
| **Alt+↑ / Alt+↓** | move the line - LoRAs apply down the prompt |
| select the line, delete | remove it |

Ctrl+↑/↓ is the same key ComfyUI uses for `(word:1.1)` emphasis. Outside a LoRA
tag it still does that; only inside one does it move the weight instead.

Ctrl+/ comments the line out, and a commented tag is one that does not load -
the same `//` that hides prose. It stays readable, so you can decide to switch
it back on.

All of these go through the browser's own editing, so **Ctrl+Z** undoes them
like any other typing.

## The strip under the prompt

One line, showing whichever tag the caret is in: its preview, the title and
creator from the `.civitai.info` sidecar, the base model, the weight, its first
few trigger words as buttons that insert them, and **↗** to open its Civitai
page. A tag naming a file that is not there says so.

With the caret anywhere else it just counts what is loaded.

It replaced a card per LoRA. The cards repeated what the text already said and
needed a scrolling panel and a draggable split to hold them, which is where the
flickering came from; only one LoRA can be under the caret, so only one line is
ever needed.

## Looking at one properly

Click the preview or the name in the strip. That opens the LoRA on its own: the
preview at its full size, the title, creator, base model and file name, **every**
trigger word as a button that inserts it - dimmed if it is already in your
prompt - and the link to its Civitai page. Escape or a click outside closes it.

A line can only ever show a thumbnail and the first few words, which is what
this is for. It needs no list of its own to search: it opens on whatever the
caret is in.

Both the link and the title come from the `.civitai.info` sidecar. Without one
there is no link, and the name falls back to the filename.

## How a tag names a file

Either the bare name - `<lora:creator - thing - v1 (base):1.00>` - or the path
it sits at inside the LoRA folder, `<lora:anima\creator - thing - v1:1.00>`,
which is the form ComfyUI's own LoRA Loader uses. Both resolve, both colour as
known, and both find the same previews and trigger words.

## Choosing trigger words

Creators sometimes declare a single word and sometimes several paragraphs - in
one collection of 761 files the longest ran to 655 characters - so they are
never inserted wholesale. The suggestion after Tab offers all of them first,
then one at a time; the strip offers the first six as buttons. Either way you
pick, and they land on a line of their own.

The node's **Trigger words** setting is the other way round: it adds them for
you at generation time, without touching the prompt you wrote.

## Notes in the prompt

Anything after `//` to the end of the line is a note for you, not for the model.
It is removed before the prompt is encoded, so a line can be commented out to
disable it — including a LoRA tag, which then does not load either.

```
a photo in a sunlit kitchen   // try 0.6 next time
// <lora:detail tweaker:0.8>  <- parked for now
```

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

Connect **warp** to the Save Image (Civitai) node if you want full metadata in
the file. The prompt, the seed, the steps, the CFG and the sampler reach that
node only through a warp. Without one it walks the graph, which finds the
checkpoint and the LoRAs but nothing else, and the image is saved with:

    Size: 1024x1024, Model: some model, Version: ComfyUI-WarpPipe

With the warp connected, the same image is saved with the prompt, the negative
prompt, `Steps`, `Sampler`, `Schedule type`, `CFG scale`, `Seed` and
`Lora hashes` - which is what Civitai reads to credit the resources.

Everything else about the node works with **warp** unconnected; only what is
written into the file changes.

## Notes

- Both model and CLIP strength use the tag's single weight.
- LoRA loading uses ComfyUI's own loader, so behaviour matches a standard
  LoRA Loader node.
