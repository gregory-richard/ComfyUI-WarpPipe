# Usage

## Writing a prompt

The **Prompt + LoRAs** node is a text box that understands what is in it.

![The prompt box, with every colour state showing](../assets/docs/prompt-node.webp)

LoRAs go inline, A1111 style:

```
a portrait in a sunlit kitchen, golden hour, soft bokeh
highly detailed, 35mm film      // pushed up from 0.6

<lora:atelier - Detail Tweaker - v2.0 (SDXL):0.80>
<lora:northlight - Golden Hour Portrait - v3.1 (SDXL):0.65>
// <lora:atelier - Film Photography - v1.4 (SDXL):0.40>   parked for now
```

The node's **model** and **clip** outputs come out patched with every tag it
resolved. Its **prompt** output is what you wrote with the tags and the notes
taken out — and nothing added.

### What the colours mean

| | |
| --- | --- |
| cyan | a tag matching a file, built for the model you have connected |
| red, wavy underline | a tag matching nothing — check the spelling |
| orange, dotted underline | a real file, but built for another base model |
| amber | an embedding |
| green | a trigger word belonging to one of the LoRAs in use |
| grey italic | a note after `//`, which is not sent to the model |

Red and orange are different complaints. Red will not load at all. Orange loads
perfectly well and usually does nothing useful — you may know something the
sidecar does not. Hover either for the reason.

With nothing wired into **model**, or for a file whose sidecar declares no base,
nothing can be judged and nothing goes orange.

### Naming a LoRA

A tag does not need the full filename, only enough to identify one file.
Matching is tried in this order, ignoring case and slash direction:

1. the full name — `sdxl/atelier - Detail Tweaker - v2.0 (SDXL).safetensors`
2. the filename without folder or extension — `atelier - Detail Tweaker - v2.0 (SDXL)`
3. every word, in any order — `sdxl detail tweaker` finds the above
4. a unique fragment — `detail tweaker`

Option 2 always works and is what the browser inserts. Option 3 is usually the
shortest thing worth typing.

**A tag that matches nothing, or matches several files, stops the run** and says
what it matched. That is deliberate: generating without a LoRA the prompt asked
for gives a wrong picture *and* wrong metadata, and a console warning is too easy
to miss. A near miss suggests the closest names, so a typo is a question rather
than a dead end.

### Completing with `/`

![Typing slash completes against the library inline](../assets/docs/inline-completion.webp)

The suggestion is drawn in grey rather than shown in a popover, so it never
covers what you are typing, and it is filtered to the base model you have wired
in. `Tab` takes it. Taking a LoRA that declares trigger words offers them
straight away as a second suggestion, so the common pair — add it, then say its
word — is `Tab` twice and no dialog.

Nothing is written into the box until you accept. The suggestion cannot be typed
over, cannot land in the undo history, and does not mark the workflow changed
while you are only looking.

### Keys

| | |
| --- | --- |
| `/` | complete against the library, inline |
| `Tab` | take the suggestion; on an existing tag, offer that LoRA's trigger words |
| `↑` `↓` | walk the alternatives while a suggestion is showing |
| `Ctrl+↑` `Ctrl+↓` | change the weight of the tag the caret is in, in steps of 0.1 |
| `Ctrl+/` | comment the line out, which switches that LoRA off |
| `Alt+↑` `Alt+↓` | move the line, which reorders when LoRAs are applied |
| `Esc` | drop the suggestion |

Each of these is an ordinary edit to the text, which is why a tag gets a line to
itself. It also means the browser's own undo understands all of them.

### Trigger words

Nothing is added to your prompt. `Tab` on a tag offers that LoRA's words, and
the strip lists the first six as buttons; either way you pick, and they land on a
line of their own as ordinary prompt text.

That is the point of choosing. Appending them silently would send words you never
saw, and creators do not always put a keyword in `trainedWords` — in one real
collection the longest entry ran to 655 characters.

### The browser

**Browse LoRAs** opens the library as cards.

![The LoRA library browser](../assets/docs/lora-browser.webp)

The rail groups by family with counts. The family of the model you have
connected is pinned and marked; the rest stay visible but dimmed, because you
may have a reason. Search matches creator, name, version and family. Clicking a
card writes its tag where the caret was.

## Bundling a generation

![Warp bundling three sources; Unwarp giving them back](../assets/docs/warp-unwarp.webp)

Connect anything you like into a **Warp** — models, CLIP, VAE, conditioning,
images, masks, latents, prompts, and the sampling parameters. One `WARPPIPE`
link carries all of it. An **Unwarp** unpacks it into twenty-two outputs in a
fixed order.

Two things worth knowing:

- **Warps chain.** Give a Warp another warp on its `warp` input and it starts
  from that one's contents, then applies whatever else is connected. Build a
  base warp and extend it per branch.
- **Absent is not default.** A field nothing was connected to comes back as
  `None`, not as an invented `euler` or `512`. If a downstream node needs a
  value, connect one.

The intended shape is one Warp per model or style — each with its own steps,
CFG, sampler, scheduler and resolution — and switching between them by moving
the single link into your Unwarp.

### Parameters and latents

**Warp Provider** is the other half: one node holding the seed, steps, CFG,
sampler, scheduler and size, and producing the empty latent to match.

![Warp Provider](../assets/docs/warp-provider.webp)

Thirty-odd presets cover every common aspect ratio from 9:16 to 16:9, each
labelled with its use, ratio, pixel size and megapixels, sorted by ratio and
then by size. Pick `Custom` to use the `custom_width` and `custom_height` boxes.

The latent it makes is the SD1.5/SDXL shape — four channels at an eighth scale,
the same as ComfyUI's own Empty Latent Image. Architectures on a wider latent
(Flux, SD3) need their own empty-latent node; the presets here are SDXL's
anyway.

## Saving for Civitai

![Save Image (Civitai)](../assets/docs/save-image-civitai.webp)

Civitai identifies a checkpoint or a LoRA by a hash of the file, not by its
name, and reads those hashes out of an A1111-style `parameters` text chunk.
**Save Image (Civitai)** writes that chunk alongside ComfyUI's own, so one PNG
both satisfies the site and still reopens as a workflow.

Connect your images, and a warp carrying the prompt, seed, steps, CFG and
sampler. The resources are worked out from the graph:

- It walks back from itself, so only nodes that actually fed this image count.
  A branch behind a switch that did not run is not credited.
- With several checkpoints upstream, the nearest one wins — a refiner in front
  of a base is the one recorded.
- LoRAs are found in ComfyUI's own loaders, in numbered stacker slots, in
  rgthree-style slot dicts, and as `<lora:...>` tags in any text input. A tag
  behind a `//` is skipped, because it never loaded.
- A LoRA the workflow names but which is not on disk is left out and logged,
  rather than credited to a picture it never touched.

### The toggles

| | |
| --- | --- |
| **Save as** | `filename_prefix`. Understands `%date:yy-MM-dd hh-mm-ss%` as well as ComfyUI's `%width%`/`%height%`. A slash makes a subfolder. |
| **Generation info** | The `parameters` block: prompt, seed, sampler, size, model and LoRA hashes. |
| **Workflow** | The whole ComfyUI graph, so the image can be dragged back in — which also reveals your pipeline to anyone you send it to. PNG only. |
| **Format** | `png` is lossless and holds the workflow; `jpeg` is much smaller and keeps the generation info in EXIF, which Civitai also reads. |
| **Preview** | Whether the saved images appear on the node. They are saved either way. |

`%date:...%` is expanded here rather than in the frontend, so a prompt sent over
the API behaves the same as one run from the browser.

Choosing JPEG with **Workflow** on saves the file and tells you the workflow was
dropped, rather than silently omitting it.

## What the sidecars give you

WarpPipe reads `.civitai.info` files sitting beside your models — the sidecars
[Civitai Updater](https://github.com/gregory-richard/comfyui-civitai-updater)
writes and keeps current.

| Field | Used for | Without it |
| --- | --- | --- |
| `trainedWords` | trigger words: `Tab`, the strip, green colouring | no trigger words at all |
| `baseModel` | family grouping, the orange warning, filtering `/` | grouped by folder instead |
| `model.name` | the real model name on cards and in the strip | the filename |
| `modelId`, `id` | the ↗ link to its page on Civitai | no link |
| `files[].hashes.SHA256` | the AutoV2 hash Civitai matches on | computed by hashing the file, then cached |

Only the hash has a fallback. Everything else is simply absent, and the features
built on it go quiet — the LoRA still lists, still previews and still applies.

Preview images are read straight off the disk: any `.preview.png`, `.preview.jpg`
or bare `.png` next to the model file. They are cached down to 320px WebP
thumbnails on first request, because full previews are generations in their own
right — around 1.27 MB each in a real collection, against 6–9 KB cached.

Links point at `civitai.red` rather than `civitai.com`. Since the April 2026
split, `.com` serves an SFW-filtered catalogue, so a link to it for a mature
model arrives nowhere useful; `.red` serves everything, checked against a model
flagged safe.
