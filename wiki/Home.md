# WarpPipe

Two things, in one node pack.

**A prompt box that owns its LoRAs.** Write `<lora:name:weight>` inline, the way
A1111 does, and the tags *are* the loader. The text is the only state: colouring,
completion, weights, ordering and switching a LoRA off are all edits to it.

**One wire instead of twenty.** A Warp bundles everything a generation needs;
an Unwarp gives it back. Whole model setups become a single connection you move.

## Where to go

| | |
| --- | --- |
| [Usage](Usage.md) | Writing prompts, bundling a generation, saving for Civitai |
| [Nodes](Nodes.md) | Every node, every input and output |
| [API](API.md) | The HTTP routes the frontend calls |
| [Architecture](Architecture.md) | How it is put together, and why it is put together that way |
| [Development](Development.md) | Running the tests, the lint, and cutting a release |
| [Troubleshooting](Troubleshooting.md) | When a node, a preview or a LoRA does not turn up |

Each node also carries its own help inside ComfyUI. The `?` on a node opens the
matching page from [`web/docs/`](../web/docs) without leaving the canvas.

## Installing

From the ComfyUI Registry:

```bash
comfy node install warppipe
```

Or by hand, into `ComfyUI/custom_nodes`:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/gregory-richard/ComfyUI-WarpPipe.git
```

Restart ComfyUI afterwards either way. If you keep the source elsewhere, link it
in rather than copying — see [Development](Development.md#setting-up).

## What it needs

ComfyUI, Python 3.9 or newer, and nothing else. There are no third-party Python
dependencies: everything WarpPipe uses — `Pillow`, `aiohttp`, `torch` — already
ships with ComfyUI.

[Civitai Updater](https://github.com/gregory-richard/comfyui-civitai-updater) is
not required but is worth having; see
[Usage → What the sidecars give you](Usage.md#what-the-sidecars-give-you).

## A quick tour

The shortest useful workflow is three nodes:

```
Load Checkpoint ──► Prompt + LoRAs ──► KSampler
                    (model, clip, prompt)
```

Type a prompt, press `/`, pick a LoRA, press `Tab`. The tag lands on a line of
its own and the LoRA is applied to the model and CLIP that come out.

The bundling is worth adding once a workflow has more than one model setup in
it:

```
Load Checkpoint ─┐
Warp Provider  ──┼──► Warp ────────► Unwarp ──► KSampler ──► VAE Decode
Prompt + LoRAs ──┘      │                                        │
                        └────────────────► Save Image (Civitai) ◄┘
```

The middle link carries the lot. Build a second Warp with a different checkpoint
and different steps, and switching between them is one connection moved.

## Version

This wiki documents **4.0.0**. See the [changelog](../CHANGELOG.md) for what
changed, and [Development](Development.md) for how releases are cut.
