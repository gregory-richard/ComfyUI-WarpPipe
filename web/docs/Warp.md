# Warp Bundle

Bundle multiple data types into a single warp object for easy transfer through your workflow.

## Overview

The **Warp** node collects various ComfyUI data types (models, images, conditioning, parameters, etc.) into a single bundled output. This drastically simplifies complex workflows by reducing the number of connections needed between distant nodes.

## Inputs

All inputs are **optional**. Connect only what you need:

- **warp** — An existing warp bundle to copy from and extend. Allows chaining multiple Warp nodes.
- **model_1**, **model_2** — MODEL inputs (e.g. checkpoints, LoRA-modified models)
- **clip**, **clip_vision** — CLIP and CLIP_VISION encoders
- **vae** — VAE model
- **image** — IMAGE batch
- **mask** — MASK input
- **conditioning_positive**, **conditioning_negative** — CONDITIONING inputs
- **latent** — LATENT data
- **prompt_positive**, **prompt_negative** — Text prompts (STRING)
- **batch_size**, **seed**, **steps_1/2/3**, **width**, **height** — Integer parameters
- **cfg** — CFG scale (FLOAT)
- **sampler_name** — Sampler selection (matches KSampler options)
- **scheduler** — Scheduler selection (matches KSampler options)

## Output

- **warp** — A single bundled object containing all connected inputs.

## Usage Tips

- Connect the **warp** output to an **Unwarp** node to extract individual data types.
- Chain multiple Warp nodes by connecting one warp output to another's warp input — later values override earlier ones.
- Only non-None inputs are stored; unconnected inputs are ignored.
