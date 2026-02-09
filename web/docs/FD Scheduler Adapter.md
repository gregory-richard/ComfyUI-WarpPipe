# FD Scheduler Adapter

Convert KSampler schedulers to FaceDetailer-compatible schedulers.

## Overview

The **FD Scheduler Adapter** bridges the gap between standard KSampler scheduler values and the extended scheduler set supported by FaceDetailer (from Impact Pack). Some schedulers used by KSampler are not recognized by FaceDetailer and vice versa — this node handles the conversion automatically.

## Input

- **scheduler** (required) — A scheduler value from the standard KSampler scheduler list.

## Output

- **scheduler** — A FaceDetailer-compatible scheduler value.

## How It Works

- If the input scheduler is already in FaceDetailer's accepted set, it passes through unchanged.
- Exotic schedulers (AYS SDXL, GITS, OSS variants, etc.) are mapped to their closest compatible equivalent.
- Unknown schedulers fall back to "karras" for maximum compatibility.
