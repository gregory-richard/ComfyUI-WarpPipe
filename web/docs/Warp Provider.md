# Warp Provider

Generate latents and sampling parameters with convenient resolution presets.

## Overview

The **Warp Provider** node creates an empty latent image and outputs common sampling parameters. It features 30+ resolution presets covering all major aspect ratios, making it easy to set up generation parameters in one place.

## Inputs

All inputs are **optional** with sensible defaults:

- **batch_size** — Number of images to generate (default: 1, range: 1–64)
- **seed** — Random seed (default: 0)
- **steps_1** — Primary step count (default: 20)
- **steps_2**, **steps_3** — Additional step counts for multi-pass workflows (default: 0)
- **cfg** — CFG scale (default: 7.0, range: 0.0–50.0)
- **sampler_name** — Sampler selection (default: euler)
- **scheduler** — Scheduler selection (default: normal)
- **size_preset** — Resolution preset dropdown with 30+ options organized by aspect ratio
- **custom_width**, **custom_height** — Custom dimensions when "Custom" preset is selected (step: 8)

## Outputs

- **latent** — Empty latent image at the selected resolution
- **batch_size**, **seed**, **steps_1/2/3**, **width**, **height** — INT
- **cfg** — FLOAT
- **sampler_name** — Sampler enum
- **scheduler** — Scheduler enum

## Resolution Presets

Presets are organized by aspect ratio:

| Aspect Ratio | Use Cases |
|---|---|
| 9:16 | Mobile, Stories (portrait) |
| 3:4, 2:3, 4:5 | Portrait photography, Instagram portrait |
| 1:1 | Square (SDXL native 1024x1024) |
| 5:4, 3:2, 4:3 | Landscape photography, Instagram landscape |
| 16:9 | Widescreen, video |

Each preset shows resolution and megapixel count for easy selection.
