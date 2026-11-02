# Warp Provider

Generate latents and sampling parameters with convenient resolution presets.

## Overview

The **Warp Provider** node creates an empty latent image and outputs common sampling parameters. Its 32 resolution presets cover all major aspect ratios, and the latent it makes fits any model — SDXL, FLUX.2, MOSS-Image, Qwen-Image, Z-Image, Krea 2, Anima.

## Inputs

All inputs are **optional** with sensible defaults:

- **batch_size** — Number of images to generate (default: 1, range: 1–64)
- **seed** — Random seed (default: 0)
- **steps_1** — Primary step count (default: 20)
- **steps_2**, **steps_3** — Additional step counts for multi-pass workflows (default: 0)
- **cfg** — CFG scale (default: 7.0, range: 0.0–50.0)
- **sampler_name** — Sampler selection (default: euler)
- **scheduler** — Scheduler selection (default: normal)
- **size_preset** — Resolution preset, e.g. `3:4 · 1152×1536 · 1.8 MP` (default: `1:1 · 1024×1024 · 1.0 MP`)
- **custom_width**, **custom_height** — Custom dimensions when "Custom" preset is selected (step: 8; use multiples of 16 for anything but SDXL)

## Outputs

- **latent** — Empty latent image at the selected resolution
- **batch_size**, **seed**, **steps_1/2/3**, **width**, **height** — INT
- **cfg** — FLOAT
- **sampler_name** — Sampler enum
- **scheduler** — Scheduler enum

## Resolution Presets

Each preset says its aspect ratio, its size and its megapixels, and nothing else. They run from 9:16 to 16:9, each ratio from small to large, and every side is a multiple of 16 — what FLUX.2, MOSS-Image, Qwen-Image, Z-Image, Krea 2 and Anima all need.

Pick by megapixels for the model you are running:

| Family | Comfortable at |
|---|---|
| SDXL, Anima, Krea 2 Raw | ~1 MP |
| FLUX.2, MOSS-Image, Z-Image, Krea 2 Turbo | 1–2 MP (up to 4) |
| Qwen-Image 2.1 | ~4 MP native, 1 MP works |

Workflows saved by 4.1 and earlier, with labels like `Portrait (high-res) | 3:4 | 1152 × 1536 | 1.77 MP`, still load and run at the same size, and show the new label. Four old sizes that were not multiples of 16 moved by 8 pixels: 1224→1232, 1640→1632, 1368→1360 and 1080→1088.

## One latent for every model

The latent is the four-channel, eighth-size one ComfyUI's own Empty Latent Image makes, labelled with that scale. KSampler and SamplerCustomAdvanced reshape an empty latent for the model they are given and, reading the label, resize it for models on a sixteenth-size grid. So FLUX.2 and MOSS-Image render at the preset's size, without an Empty Flux 2 Latent of their own. Samplers from other packs that skip this step (RES4LYF, Impact Pack) render those models at twice the size, as they would from Empty Latent Image.
