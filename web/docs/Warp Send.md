# Warp Send

Mark the end of one model group and choose which group runs.

## Overview

Place a **Warp Send** at the end of each model group in your workflow. It passes the warp and a model index on unchanged. A **Warp Select** node in the hub reads all Sends and points Generate at the active one. While sampling, the Send shows the live preview; afterwards it shows a before/after slider (first generation vs. final image), or **no result yet** before the first run. Results are kept until the page is reloaded and are not saved with the workflow.

## Inputs

- **warp** — The warp bundle of this model group.
- **index** — The model number Generate's switch uses (1-99). Must be unique per Send.
- **name** — The label shown in Warp Select's list. Must be unique per Send.

## Outputs

- **warp** — The warp, unchanged.
- **index** — The index, unchanged.

## Usage

1. Add a Send at the end of each model group and set its **name** and **index**.
2. Press **activate** on the Send you want to run, or pick it in Warp Select's dropdown. Only the active Send runs.
3. Queue the workflow. The Send shows the live preview while sampling, then the before/after slider.
