# Warp Send

Mark the end of one model group and choose which group runs.

## Overview

Place a **Warp Send** at the end of each model group in your workflow. It passes the warp and a model index on unchanged. A **Warp Select** node in the hub reads all Sends and points Generate at the active one. While sampling, the Send shows the live preview; afterwards it shows a before/after slider (before vs. final), or **no result yet** before the first run. The final is the images Save Image (Civitai) shows in that run; with several Save Image (Civitai) nodes the last one to run is the final, and a Save Image (Civitai) with its preview off gives no final. The before is the images of the node you mark with right-click **Use as before image for Warp Send**; the mark goes on an output node such as Preview Image (one per workflow; **Remove before-image mark** clears it, and the marked node shows a "before" badge). No links are needed. Results go to the Send that was active when the run was queued, are kept until the page is reloaded and are not saved with the workflow. The active Send is fully green; inactive Sends are fully red and show "active: <name>". It works in the classic canvas and in Nodes 2.0.

## Inputs

- **warp** — The warp bundle of this model group.
- **index** — The model number Generate's switch uses (1-99). Must be unique per Send.
- **name** — The label shown in Warp Select's list. Must be unique per Send.

## Outputs

- **warp** — The warp, unchanged.
- **index** — The index, unchanged.

## Usage

1. Add a Send at the end of each model group and set its **name** and **index**.
2. Press the big **activate** button (it reads **active** on the active Send) on the Send you want to run, or pick it in Warp Select's dropdown. Only the active Send runs.
3. Queue the workflow. The Send shows the live preview while sampling, then the before/after slider.
