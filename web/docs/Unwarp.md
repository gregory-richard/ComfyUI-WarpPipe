# Unwarp Bundle

Unpack a warp bundle back into individual data types.

## Overview

The **Unwarp** node is the counterpart to **Warp**. It takes a single warp bundle and extracts all the individual data types, making them available as separate outputs.

## Input

- **warp** (optional) — A warp bundle from a **Warp** node. If not connected, all outputs return None.

## Outputs

All original data types are extracted as individual outputs:

- **model_1**, **model_2** — MODEL
- **image** — IMAGE
- **mask** — MASK
- **clip** — CLIP
- **clip_vision** — CLIP_VISION
- **vae** — VAE
- **conditioning_positive**, **conditioning_negative** — CONDITIONING
- **latent** — LATENT
- **prompt_positive**, **prompt_negative** — STRING
- **batch_size**, **seed**, **steps_1/2/3**, **width**, **height** — INT
- **cfg** — FLOAT
- **sampler_name** — Sampler enum
- **scheduler** — Scheduler enum

## Usage Tips

- Connect only the outputs you need — unused outputs can be left unconnected.
- If the warp bundle doesn't contain a particular value, that output will be None.
- Sampler and scheduler outputs are coerced to safe values for maximum compatibility.
