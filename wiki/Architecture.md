# Architecture

```
warp_pipe.py          every node, the storage, the resource scan, the routes
__init__.py           picks a registration path and re-exports it
web/
  prompt_ui.js        the coloured prompt box, the strip, inline completion
  lora_browser.js     the library modal
  model_base.js       which base model a node is wired to
  library.js          one fetch of the index, shared by both views
  text.js             escaping and filename helpers
  widget_values.js    saving widget values by name rather than by position
  save_image_ui.js    friendly labels, and the toast when nothing was saved
  docs/*.md           the per-node help ComfyUI shows behind the ? button
wiki/                 this documentation
tests/                pytest, no ComfyUI required
```

## How a warp travels

A `WARPPIPE` link does not carry the data. It carries `{"id": "<uuid>"}`, and
the data sits in a module-level dict keyed by that id.

That is a deliberate trade. Passing tensors and model patchers down a link would
have ComfyUI copy and cache them at every hop; passing a token means a Warp
costs the same whether it carries a seed or six models.

The cost is that the dict holds references, so a stored bundle keeps its models
alive. Two limits bound it: entries older than an hour are pruned, and no more
than 256 are kept, oldest evicted first. An Unwarp refreshes an entry's
timestamp when it reads it, so a warp in active use never expires. All of it is
under one lock, and the cleanup runs on insertion rather than on a timer.

Each `Warp` instance gets its id at construction. ComfyUI caches node instances
per graph node, so the id is stable across runs of the same workflow.

## Validation

Sampler and scheduler sockets are the awkward part of this pack.

ComfyUI types a combo socket by its list of options, so a `sampler_name` coming
out of another node pack with a wider list is a *different type* to ComfyUI's
own, and the link is refused. WarpPipe wants those links to work.

Earlier versions patched ComfyUI's global prompt validator, which affected every
node in the process. That is gone. Instead each node declares
`VALIDATE_INPUTS(input_types)`, which:

- keeps normal socket checks for everything else — an `IMAGE` into a `MODEL`
  still fails, and says so;
- relaxes only `sampler_name` and `scheduler`;
- accepts a comma-joined enum string that shares any member with what was
  expected, which is how some builds spell a combo type.

Whatever arrives is then coerced at run time: an unknown sampler becomes
`euler`, an unknown scheduler `karras`. The allowlists are snapshots of
ComfyUI's lists taken at import, not references to them — a reference would grow
as other packs registered their own schedulers, and coercion would stop
coercing.

## Finding the resources for a saved image

`Save Image (Civitai)` needs to know which checkpoint and which LoRAs made the
picture. It reads the prompt graph ComfyUI passes it as a hidden input.

1. **Walk back from this node.** Breadth-first over the links, recording how far
   each node is. Nodes not upstream are ignored, so a second branch of a large
   workflow contributes nothing.
2. **Follow only the taken branch of a switch.** A switch names its inputs
   `input1..inputN` and carries a `select`; the others are wired but never ran.
   The selector is usually a small constant node one link away, so that is
   followed too — but only when it is unambiguous. When the choice cannot be
   read, every branch is followed, as before, because dropping a real resource
   is worse than including a spare one.
3. **Recognise loaders by the input they carry**, not by class name — `ckpt_name`,
   `unet_name`, `model_name`. A name that resolves inside the checkpoint,
   diffusion-model or UNet folders is a model whatever the input is called, so a
   loader from an unknown pack still records what it loaded.
4. **Collect LoRAs** from `lora_name`, from numbered `lora_name_1` slots with
   their matching strengths, from rgthree-style `{"lora":…, "on":…}` dicts
   honouring the on/off switch, and from `<lora:...>` tags in any string input
   with comments stripped first.
5. **Nearest model wins.** With several upstream, the one fewest links away is
   the one that made this picture — a refiner in front of a base. Equal
   distances fall to the order the graph listed them.

Then each name is resolved to a file and hashed. A name that resolves to nothing
is logged and left out: crediting a LoRA that was never applied describes an
image that was not made.

## Hashes and metadata

Civitai matches a resource by AutoV2 — the first ten hex characters of the
file's SHA256. WarpPipe takes it from the sidecar when one is there and hashes
the file when it is not, caching by path, size and mtime so a replaced file
re-hashes and an unchanged one never does.

Two conventions go into the `parameters` block, because they are read by
different things:

- `Lora hashes: "name: hash"` — A1111's additional-networks spelling.
- `Hashes: {"model": …, "lora:name": …}` — what Civitai's own extension writes,
  and the field it actually links resources from.

Writing only the first is why an upload would name its checkpoint and credit
none of its LoRAs: the checkpoint comes from `Model hash`, which both agree on,
and the LoRAs were never anywhere Civitai looked.

JPEG has no text chunks, so for that format the same block goes into EXIF
`UserComment` as UTF-16BE behind a `UNICODE\0` marker — what A1111 writes and
what every reader of these files expects.

## The prompt box

The text is the only state. There is no list of LoRAs kept beside it, because two
sources of truth disagree eventually.

A transparent `textarea` sits over a highlight layer that renders the same
string as coloured spans. Every property that decides where a glyph lands is
copied from one to the other, including the width ComfyUI's scrollbar gutter
takes, or the colouring slides off the words. Typing, selection, undo and IME
are all the real textarea's.

Suggestions are *drawn* on that layer rather than written into the value.
Writing them meant undoing them on every keystroke, which raced with fast typing,
filled the undo stack with edits nobody made, and marked the workflow dirty
while merely browsing.

Edits go through `document.execCommand("insertText")` — the only way to change a
textarea that the browser's own undo still understands. Assigning to `value`
clears the undo stack, which would make every weight nudge a point of no return.

Layout is watched on a 100ms timer rather than with a `ResizeObserver`, which
only delivers while the page renders: a node resized in a background tab came
back with the layer at its old size. The timer, the observer and the strip are
all torn down on `onRemoved`.

## Widget values

ComfyUI serialises widget values positionally. Anything that changes widget
order between a save and a load — an extension reordering them, or a widget
added in a later version — shifts every later value onto the wrong widget,
silently. Booleans are the worst of it, because the wrong value is still valid.

This pack reorders its own widgets, so it also writes them by name into the saved
workflow and reads them back by name. A workflow saved before that existed falls
back to a per-node migration that knows what the old shape meant.

## Registration

`NODE_DEFINITIONS` maps node id to display name and class, and both registration
paths are built from it. Keeping two lists in step by hand is exactly how V3 mode
once shipped five of the seven nodes, with nothing said about the other two.

The V3 implementation is opt-in behind `WARPPIPE_ENABLE_V3=1` while the upstream
API settles. A test asserts both paths cover the same set.

## Compatibility shims

`comfy.samplers` is imported behind a `try`, with a small mock behind it, so the
module imports outside ComfyUI for tests and lint. The mock exists only to make
import work; it is not a simulation of ComfyUI.

`beta57` and `bong_tangent` are registered globally against the karras handler so
other packs accept a workflow built around RES4LYF's schedulers even when
RES4LYF has not loaded. Startup logs which names it stood in for.
