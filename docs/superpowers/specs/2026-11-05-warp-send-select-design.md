# Warp Send / Warp Select / Warp Result: design

Date: 2026-11-05. Status: approved in chat, awaiting spec review.

## Goal

The user works on one model at a time. They want to see that model's prompt, loaders, Warp Provider settings and its result (first generation and final image) on one screen, without scrolling to the hub. They also want a live sampling preview there.

Today the image workflow ("Img (26-11-02)") routes everything through 27 KJ SetNodes and 30 GetNodes, two ImpactInversedSwitches, an INTConstant model selector with labels, and an ImpactSwitch. Two thirds of that only send results back to per-group comparers.

Success means:
- No Get/Set nodes, InversedSwitches or Model Selector are left in the image workflow.
- You choose the model inside its own group.
- The run executes only that group.
- Its result and the live preview appear in that group.
- The rendered images are unchanged for the same seed.

## Components (all in ComfyUI-WarpPipe, release 4.2.0)

### Warp Send (passthrough node in `warp_pipe.py`, UI in `web/warp_send.js`)

It sits in each model group, at the end of the data flow (Warp → Warp Send).

- **Input:** `warp` (WARPPIPE).
- **Widgets:** `name` (string, e.g. "Krea 2") and `index` (INT 1–99, e.g. 7). Generate's inner ImpactSwitch picks the model's sampling chain by this number, and the dropdown lists Sends in `index` order.
- **Activate button:** marks this Send as the active one, and only one Send per graph is active. The active state is stored in the node's `properties.active`. The node gets a highlighted title bar, and the change syncs Warp Select's dropdown.
- **Display:** a large before/after slider. The left side is the first generation and the right side is the final image. With batch > 1, small prev/next arrows step through the pairs.
- **Live preview:** while sampling, the slider area shows the live preview.
- **Persistence:** result image references are kept in `properties` for the session only. Temp files do not survive a ComfyUI restart, and nothing more is persisted.
- **Backend role:** a small real passthrough node (Python: `warp` and `index` in, `warp` and `index` out). Its outputs have no visible links. Warp Select resolves to them virtually, so only the active Send is ever referenced and executed. This replaces "virtual like KJ SetNode": a virtual node cannot hand an INT literal to Generate, but a real output can.

### Warp Select (frontend-only virtual node, `web/warp_send.js`)

It sits in the hub and replaces the Model Selector, its labels, the nine GetNodes and the ImpactSwitch.

- **Outputs:** `warp` (WARPPIPE) and `index` (INT), both linked to Generate (`warp`, `select`).
- **Widget:** `active`, a combo listing every Send `name` in the graph, including Sends inside subgraphs. Changing it activates that Send, and activating a Send changes the combo.
- **Button "go to active group":** centres the canvas on the active Send's group.
- **At queue time:** Warp Select is a virtual node whose `resolveVirtualOutput(slot)` returns `{node: activeSend, slot}`, the frontend 1.57 mechanism that KJ Get nodes use. Generate therefore reads `warp` and `index` straight from the active Send. Inactive Sends are unreferenced and are not sent. The plan's first task is a probe that confirms this before anything else is built.

### Warp Result (Python output node, `warp_pipe.py`, legacy + V3)

It sits at the end of the hub.

- **Inputs:** `first` (IMAGE, the first generation after the Image Filter), `final` (IMAGE, after detailers and Realism) and a `target` STRING widget. The frontend hides that widget and keeps it equal to the active Send's name.
- **Output:** `ui` with the saved temp previews of `first` and `final` plus `target`. It returns no data outputs.
- **Frontend:** on `executed`, the extension finds the Send whose `name` equals `target` and gives it the images. Every other Send keeps its last result.

### Live preview mirror

The extension listens to the API's `b_preview_with_metadata` / `b_preview` events. While a prompt queued through Warp Select runs, it draws the latest preview frame into the active Send. Previews only exist when ComfyUI runs with `--preview-method auto`, so that flag is added to `run_nvidia_gpu.bat`; the restart needs the user's approval.

## Errors (the run is blocked with a clear message)

- No Send is active.
- The active Send is muted or bypassed.
- Two Sends share a name.
- The active Send has no `warp` input.
- A workflow contains a Warp Select but no Warp Send.
- Two Sends share an `index`.

Renaming a Send updates the combo immediately. A Warp Result with an empty `target` still runs, and its images are simply not mirrored.

## Workflow changes (Img (26-11-02), outside the repo)

- **Model groups:**
  - Each group's SetNode `warp - <model>` becomes a Warp Send named after the group.
  - The per-group comparer fed by `img - filtered/final` Gets is removed.
  - The new layout, left to right: Models, Prompt + LoRAs, Warp Provider, Warp, then Warp Send (about 520 wide, full group height).
  - The group size stays about 2070 × 900.
- **Hub ("Workflow" group):**
  - Images go in the top row: the detailer previews above their detailer, the large final image and Save.
  - Modules go in the bottom row: Warp Select directly left of Generate, then Image Selector, detailers, Upscale, Pose, Realism, Unwarp.
  - Warp Result takes the Image Selector output as `first` and the Unwarp image as `final`.
  - Removed: all Get/SetNodes, both InversedSwitches, the INTConstant Model Selector, its labels, the ImpactSwitch, and the three `model switch` Gets. The `model switch` value has three readers today: Generate's `select` input, which moves to Warp Select's `index`, and the two InversedSwitches, which are removed.
- **Bookmarks:** 0 is the hub and 1–9 are the models in the old selector order (Flux 2, Qwen, Qwen Edit, ZIT, ZIT+ZIB, Anima, Krea 2, Krea 2 Edit, Moss). This removes the clashing "e" on Krea 2 Edit and avoids "r" (refresh).

## Testing

- **pytest:** Warp Result's ui payload (target passthrough, batch of 2, missing `first`) in the existing `tests/` setup.
- **Real ComfyUI:**
  - Krea 2 with batch 2: the result and live preview land in Krea 2.
  - Switching to ZIT: the result lands in ZIT, and Krea 2 keeps its old one.
  - Each error case blocks the run with its message.
- **Regression:** the restructured workflow produces pixel-identical output to the current one with fixed seeds (queued via graphToPrompt).

## Out of scope

- Persisting results across restarts.
- Sending results to more than one Send.
- Replacing Get/Set nodes in other workflows (for example Vid).
