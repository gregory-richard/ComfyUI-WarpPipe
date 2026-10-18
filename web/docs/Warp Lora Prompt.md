# Prompt + LoRAs

Write the prompt and the LoRAs it uses on one node.

## Overview

The **Prompt + LoRAs** node keeps a prompt and its LoRAs together instead of
splitting them between a text node and a loader. The prose goes in the prompt
box; the LoRAs go in the short box under it, one to a line, in the same
`<lora:name:weight>` syntax A1111 uses:

```
Prompt   a portrait, dramatic lighting, sharp focus
LoRAs    <lora:detail tweaker:0.8>
```

Switching a LoRA becomes an edit to the text rather than a rewire.

A tag written into the prompt itself still loads — that is how an A1111 prompt
arrives, and how every workflow saved before the list existed reads. The strip
offers to move those down into the list when the list is empty.

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

## Colours in the text

Every box colours what it finds, so the text says what it will do:

| | |
| --- | --- |
| cyan | a LoRA tag that matches a file, for the model you are using |
| red, wavy underline | a tag matching nothing — check the spelling |
| orange, dotted underline | a real file, but made for another base model |
| amber | an embedding |
| green | a trigger word belonging to one of the LoRAs in use |
| dim green | a trigger word whose LoRA is not loaded - switched off, at weight 0, or in the second list while it is off |
| grey italic | a note, which is not sent |

Red and orange are different complaints. Red will not load at all. Orange loads
perfectly well and usually does nothing useful, so it is a warning rather than
an error — you may know something the sidecar does not. Hover either for the
reason; orange names both base models. With nothing wired into **model**, or for
a file whose sidecar names no base, nothing can be judged and nothing is orange.

A tag inside a note is coloured as a note, because that is what happens to it:
it does not load.

A trigger word is still coloured when its LoRA is not loaded, because it is
still that LoRA's word and the prompt still sends it - but in a dimmer green, so
a word nothing will answer does not look like one that something will. A word
two LoRAs declare stays bright while either of them is loaded. Hover any of them
to see whose it is.

Selecting text keeps all of it. The colouring is drawn behind the box you type
in, so a selection that painted its own opaque text would hide it — the
selection is a tint instead, and the notes stay italic while highlighted.

## Where the LoRAs live

In the box under the prompt, as text, one tag to a line:

    Prompt   a photo in a sunlit kitchen, boxer panties, warm light
    LoRAs    <lora:bolero537 - boxer panties - v1.0 (anima):0.80>

The box is two lines tall and grows with what it holds, up to six, so a node
that uses one LoRA is barely taller than a prompt. The prose stays prose: what
goes to the model is what you can read in the prompt box, with nothing to skip
over.

**Drag the bottom edge of a list to set its height** — the short bar in the
middle of it marks the handle, though the whole edge works, and the node grows
by what you take rather than squeezing the prompt. The height is kept with the
node, so it is there next time the workflow opens, and Ctrl+Z takes it back
like any other change. Resizing the node itself gives the room to the prompt
instead. **Double-click** the same band to hand the height back to the box and
have it fit the list again.

When the prompt has tags in it and the list is empty, the strip offers to move
them down: **click anywhere on that line**, and it says how many it moved.

The line to itself is what makes the rest work: every LoRA verb below is an
ordinary edit to one line, so commenting, moving or deleting that line means
exactly one LoRA and nothing else.

Order is the order they are applied in, which is why a line can be moved.

## A second list, for a second pass

A two-model sampler runs the picture twice - base then turbo, high noise then
low - and each pass wants its own LoRAs at its own weights. The same file at
1.00 on the first pass and 0.40 on the second is the ordinary case there, not
an edge one.

Switch **Model 2** to *its own LoRAs* and a second box appears for exactly that.
It feeds the **model_2** output, the first list feeds **model**, and the two
lists are read independently: a tag in one says nothing about the other.

    LoRAs           <lora:some speed lora:1.00>
                    <lora:a style (high noise):0.20>
    LoRAs · model 2 <lora:some speed lora:1.00>
                    <lora:a style (low noise):0.20>

Switched off, the second list is not read at all and **model_2** passes through
untouched — a box that is not on screen cannot be loading anything.

The text encoder is patched by the first list only. There is one CLIP, encoded
once and shared by both passes, so patching it with two different stacks would
describe neither of them. Most LoRAs for these architectures carry no
text-encoder weights at all.

## Adding a LoRA without typing its name

Type **/** in the LoRAs box followed by a few letters. The best match appears in
grey at the end of that line - press **Tab** to take it, or **arrow up/down** to
walk the other matches. **Escape**, or clicking elsewhere, drops the suggestion.
The same **/** works in the prompt, where an embedding belongs: it is written
where you typed it, as `embedding:name`.

If the LoRA declares trigger words, they are offered straight away as a second
suggestion: **Tab** again writes them into the **prompt**, where the caret last
was, and the arrows choose between all of them and one at a time. Adding a LoRA
and saying its word is Tab twice. The grey text is drawn in the prompt box
while you are still in the list, so the offer is shown where it will land, and
typing carries on where it was.

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
| **Alt+↑ / Alt+↓** | move the line - LoRAs apply down the list |
| select the line, delete | remove it |

Ctrl+↑/↓ is the same key ComfyUI uses for `(word:1.1)` emphasis. Outside a LoRA
tag it still does that; only inside one does it move the weight instead.

Ctrl+/ comments the line out, and a commented tag is one that does not load -
the same `//` that hides prose. It stays readable, so you can decide to switch
it back on.

All of these go through the browser's own editing, so **Ctrl+Z** undoes them
like any other typing.

## The strip under the prompt

One line, showing whichever tag the caret is in — in either list, or in the
prompt: its preview, the title and creator from the `.civitai.info` sidecar,
the base model, the weight, its first few trigger words as buttons that insert
them into the prompt, and **↗** to open its Civitai page. A tag naming a file
that is not there says so.

With the caret in a coloured trigger word, it shows the LoRA that word belongs
to, led by the word itself: `neon rain from Neon Rain`. It adds `off` when that
LoRA is not loaded, `model 2` when it is in the second list, and `+1` when
another LoRA declares the same word too - hover that for the name. Whichever it
is showing, that LoRA's tag and every one of its words get a soft background in
all the boxes, so a word in the prompt and its tag two boxes down are found
together.

With the caret anywhere else — or with nothing being edited at all — it stands
by and just counts what is loaded. It describes where the cursor is, not what
the node holds, so it empties when you click away.

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

Links go to **civitai.red**, where adult models live — a `.com` link to one of
those does not arrive anywhere useful. That host serves the rest as well, so it
is used for every model rather than guessing from a sidecar's maturity flag,
which not every sidecar carries.

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
pick, and they land in the prompt, at the end of the line the caret was last
on, separated by commas. They are prose, and prose is what the prompt is for.

None of them are ever added for you. The section on trigger words below says
why that is deliberate rather than unfinished.

## How the prompt is laid out

Blank lines you write are kept, so a long prompt can be broken into sections and
still reach the model that way. More than one blank line in a row becomes one.

A line that held only a note or only a LoRA tag is removed rather than left
behind as a blank — it was never a blank line, and turning it into one would
space the prompt out differently every time a tag was added or moved.

## Notes in the prompt

Anything after `//` to the end of the line is a note for you, not for the model.
It is removed before the prompt is encoded, so a line can be commented out to
disable it — including a LoRA tag, which then does not load either.

```
a photo in a sunlit kitchen   // try 0.6 next time
// <lora:detail tweaker:0.8>  <- parked for now
```

## Trigger words

Nothing is added to your prompt. The **prompt** output is what you wrote, with
the tags and the notes taken out — and nothing else.

Trigger words go in by hand, where you can see them: **Tab** on a tag offers the
LoRA's own words, and the strip under the prompt lists them as buttons. Then
they are ordinary prompt text — readable, movable, editable, and yours.

That is the point of choosing them. Appending them silently at generation time
would send words you never saw, and creators do not always put a keyword in
`trainedWords` — one LoRA in a real collection declares
*"Her large breasts strain the fabric of her shirt to the limit."*, and another
runs to 655 characters. A prompt is worth more than that treatment.

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

- **text** — The prompt. Tags written in here still load.
- **loras** — The LoRAs applied to **model**, one `<lora:name:weight>` a line.
- **loras_2_on** — Give **model_2** a list of its own, and show it.
- **loras_2** — The LoRAs applied to **model_2**, for a second pass.
- **apply_to_clip** — Patch the text encoder as well as the model.
- **model** (optional) — The model the first list is applied to.
- **model_2** (optional) — The model the second list is applied to.
- **clip** (optional) — The CLIP the first list is applied to.

## Outputs

- **model** — The model with every LoRA in the first list applied.
- **clip** — The CLIP with the first list applied, if **apply_to_clip** is on.
- **prompt** — The prompt with the tags and the notes removed, and nothing
  added, ready for a text encoder.
- **model_2** — The second model with the second list applied, or untouched
  when the switch is off. It sits last because outputs are restored by
  position: in front of the other three it would land every link in a workflow
  saved before it on the wrong socket.

## Wiring it

Connect **model** and **clip** from your loader, and send the **model**,
**clip** and **prompt** outputs on to your sampler and text encoder. For a
two-pass sampler, take the second model in through **model_2** and out again
into the pass that uses it — the **Warp** node's `model_1` and `model_2` are
the same two.

This node builds no warp of its own. To record the generation in a saved image,
send its **prompt**, **model** and **clip** into a **Warp** node along with the
seed, steps, CFG and sampler, and give that warp to Save Image (Civitai) - one
node that assembles warps rather than two that disagree about what is in them.

Without a warp the save node still walks the graph for the checkpoint and the
LoRAs, but the prompt, the seed, the steps, the CFG and the sampler are only
ever carried by a warp.

## Notes

- Both model and CLIP strength use the tag's single weight.
- LoRA loading uses ComfyUI's own loader, so behaviour matches a standard
  LoRA Loader node.
