# Warp Send / Select / Result Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the image workflow's Get/Set routing with three WarpPipe nodes, so you pick a model inside its own group and see its live preview and result there.

**Architecture:**
- **Warp Send** is a real passthrough node (`warp`, `index`) placed in each model group.
- **Warp Select** is a frontend-only virtual node. Its `resolveVirtualOutput` points Generate at the active Send.
- **Warp Result** is an output node. It returns preview images plus a `target` name, and the frontend draws them into the matching Send.
- **Routing logic:** the pure functions (collect, validate, pick) live in their own JS module, which is tested with `node --test`.

**Tech Stack:** Python 3.10+ (legacy + V3 node registration as in `warp_pipe.py`), vanilla ES modules for the ComfyUI frontend 1.57, pytest, node:test, eslint/prettier, ruff.

**Spec:** `docs/superpowers/specs/2026-11-05-warp-send-select-design.md`

## Global Constraints

- Release version: `4.2.0` (`pyproject.toml`, `version.txt`, `CHANGELOG.md`).
- Node ids and display names:
  - `Warp Send` / `🌀 Warp Send`
  - `Warp Select` / `🌀 Warp Select`
  - `Warp Result` / `🌀 Warp Result`
- Category: `Custom/WarpPipe Nodes`, the same as the other nodes.
- Every Python node is registered in both `NODE_DEFINITIONS` (legacy) and `V3_NODE_CLASSES`.
- These errors block the queue with an alert, using exactly these messages:
  - `Warp Select: no Warp Send is active.`
  - `Warp Select: the active Warp Send "<name>" is muted or bypassed.`
  - `Warp Select: two Warp Sends are named "<name>".`
  - `Warp Select: two Warp Sends use index <n>.`
  - `Warp Select: the active Warp Send "<name>" has no warp input.`
  - `Warp Select: this workflow has no Warp Send.`
- `npm run check`, `ruff check`, `ruff format --check` and `pytest -q` stay green, as in CI.
- Work happens on branch `feat/warp-send-select`. Commit at the end of each task. The user has approved the plan, and that approval includes these branch commits. Pushing, the PR, the tag and publishing need a separate OK.

## Review Focus

1. **A Send inside a subgraph** (a group converted to a subgraph): `collectSends` must recurse into subgraph definitions, and the active Send there must still resolve. Test it in Task 2.
2. **A copied or pasted Send** keeps `properties.active` and its name. The copy must lose `active` on paste, and a duplicate name or index blocks the queue. Test it in Task 2 (`validateRoute`) and Task 4 (`onConfigure`/clone).
3. **The active Send is deleted** while Warp Select still shows its name. The queue must block with "no Warp Send is active", not silently pick another. Test it in Task 2.
4. **`first` and `final` with different batch sizes** (for example, the Image Filter passes 1 image while `final` has 2). The slider pairs by position up to the shorter list, and the arrows only step through real pairs. Test it in Task 3 (payload) and Task 4 (UI).
5. **Warp Result runs with an empty `target`** (an old workflow, or no Select). It still saves its previews, and no Send changes. Test it in Task 3.

---

### Task 1: Probe the frontend virtual-output path (throwaway)

**Files:**
- Create (throwaway, not committed): `C:\Users\grego\AppData\Local\Temp\claude\…\scratchpad\probe_select.js`, pasted into the browser pane.

- [ ] **Step 1: Find the native hook in the frontend.** In `python_embeded/Lib/site-packages/comfyui_frontend_package/static/assets/`, search for `resolveVirtualOutput`. Expected: `ExecutableNodeDTO.resolveOutput` calls `node.resolveVirtualOutput(slot)` and expects `{node, slot}`. If it is absent, KJ's runtime patch (`comfyui-kjnodes/web/js/setgetnodes.js`, extension `KJNodes.CrossGraphSetGet`) is the model to copy.
- [ ] **Step 2: Probe in the running ComfyUI.**
  - Register a temporary virtual node class `ProbeSelect` (`isVirtualNode = true`, outputs WARPPIPE and INT). Its `resolveVirtualOutput(slot)` returns `{node: <a Primitive INT node>, slot: 0}` for slot 1.
  - Wire `ProbeSelect.INT` to a `PreviewAny`, call `app.graphToPrompt()`, and confirm the PreviewAny input references the primitive's execution id.
  - Repeat with the primitive inside a subgraph.
- [ ] **Step 3: Record the result.** Add three lines under "Probe result" at the end of this plan: the hook name, the return shape, and whether cross-subgraph works. If cross-subgraph fails, Task 4 adds the KJ-style DTO patch, scoped to `Warp Select`. Delete the probe node.

### Task 2: Pure routing module

**Files:**
- Create: `web/warp_route.js`
- Create: `tests/web/warp_route.test.mjs`
- Modify: `package.json` (add the new test file to the `test` script)

**Interfaces:**
- Produces, used by Task 4:
  - `collectSends(rootGraph) -> SendInfo[]`, where `SendInfo = {node, graph, name: string, index: number, active: boolean, muted: boolean, hasWarp: boolean}`. It walks `rootGraph._nodes` and every `subgraph` reached through nodes that have one.
  - `validateRoute(sends: SendInfo[]) -> {ok: true, send: SendInfo} | {ok: false, error: string}`. It applies the Global Constraints messages, checked in this order: no sends, duplicate name, duplicate index, none active, active muted, active without warp.
  - `activate(sends: SendInfo[], node) -> void`. It sets `properties.active` on `node` only and clears it on all others.
  - `sortedNames(sends) -> string[]`, ordered by `index` and used for the combo.

- [ ] **Step 1: Write the failing tests** in `tests/web/warp_route.test.mjs`, building plain fake graphs (`{_nodes:[{type:"Warp Send", widgets:[{name:"name",value:"Krea 2"},{name:"index",value:7}], properties:{active:true}, mode:0, inputs:[{name:"warp",link:5}]}]}`):
  - `collectSends finds sends in nested subgraphs`: one Send at root and one inside `node.subgraph._nodes`. Expect length 2.
  - `validateRoute: no sends`: equals the exact no-send message.
  - `validateRoute: duplicate name / duplicate index / none active / muted (mode 2 and 4) / no warp link`: each equals its exact message.
  - `validateRoute: deleted active send`: a list without any active Send gives the "no Warp Send is active" error.
  - `validateRoute ok`: returns the active Send.
  - `activate clears others`: exactly one has `properties.active === true` afterwards.
  - `sortedNames orders by index`: `["Flux 2","Krea 2"]` for indexes 1 and 7.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `web/warp_route.js`. Plain ESM with no `app` import, so node can load it.
- [ ] **Step 4: Run** `npm run check`. Expected: lint, format and all tests PASS.
- [ ] **Step 5: Commit:** `feat: routing helpers for Warp Send and Warp Select`

### Task 3: Python nodes Warp Send and Warp Result

**Files:**
- Modify: `warp_pipe.py` (new classes after `DeadEnd`, entries in `NODE_DEFINITIONS` and `V3_NODE_CLASSES`)
- Test: `tests/test_warp_pipe.py`
- Create: `web/docs/Warp Send.md`, `web/docs/Warp Select.md`, `web/docs/Warp Result.md` (match the style of `web/docs/Warp.md`)

**Interfaces:**
- Produces, used by Task 4:
  - `WarpSend.passthrough(warp, index: int, name: str) -> (warp, index)`. The inputs are `warp` (WARPPIPE, required), `index` (INT, default 1, min 1, max 99) and `name` (STRING, default `"Model"`). The outputs are `warp` (WARPPIPE) and `index` (INT).
  - `WarpResult.show(first=None, final=None, target: str = "") -> {"ui": {"first": [img…], "final": [img…], "target": [target]}}`. Both images are optional IMAGE inputs and `target` is a STRING widget. It is an OUTPUT_NODE that returns no data outputs. Previews are saved as temp files the way `SaveImageCivitai` saves its previews; reuse its preview helper rather than duplicating it.

- [ ] **Step 1: Write the failing tests:**
  - `test_warp_send_passes_warp_and_index_through`: returns the same warp object and `7`.
  - `test_warp_result_payload_has_target_and_both_lists`: with `FakeTensor` batches of 2 and 2, `len(ui["first"]) == 2`, `len(ui["final"]) == 2` and `ui["target"] == ["Krea 2"]`.
  - `test_warp_result_mismatched_batches`: with batches of 1 and 2, both lists are returned unchanged (pairing happens in the UI).
  - `test_warp_result_empty_target_still_saves`: with `target=""`, it still returns both lists and `ui["target"] == [""]`.
  - Extend `test_legacy_registration_and_node_contracts` so that both new ids are registered in legacy and V3 mode.
- [ ] **Step 2: Run** `python -m pytest -q`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** both classes and their V3 wrappers. Monkeypatch the temp-save helper in the tests, as the existing SaveImageCivitai tests do.
- [ ] **Step 4: Run** `python -m pytest -q && python -m ruff check . && python -m ruff format --check .`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: Warp Send passthrough and Warp Result output node`

### Task 4: Frontend: Warp Send UI, Warp Select virtual node, result routing

**Files:**
- Create: `web/warp_send.js` (one `app.registerExtension({name: "WarpPipe.WarpSend"})`)
- Modify: `package.json` only if lint globs need it

**Interfaces:**
- Consumes: Task 2 helpers and Task 3 node ids, input names and the ui keys `first`, `final` and `target`.
- Produces, used by Task 5: `drawPreviewInto(sendNode, imageBitmapOrImg)`, exported on `window.WarpPipe.warpSend` for the preview mirror.

- [ ] **Step 1: Warp Send node UI** (`beforeRegisterNodeDef` for `Warp Send`):
  - An "aktivieren" button calls `activate`, refreshes every Select combo and every Result `target` widget, and marks the active node with `color: "#2a5"` on the title (the others keep their defaults).
  - A canvas widget draws the slider (A = first, B = final), with prev/next arrows when there is more than one pair. Pairs are `min(first.length, final.length)`.
  - `onConfigure` restores the active state. Pasting or cloning sets `properties.active = false`.
  - The default size is `[520, 860]`.
- [ ] **Step 2: Warp Select virtual node** (`registerCustomNodes`, a LiteGraph class `"Warp Select"` with `isVirtualNode = true`):
  - Outputs are `warp` (WARPPIPE) and `index` (INT).
  - Widgets: an `active` combo (values from `sortedNames`; setting it activates that Send) and a "zur aktiven Gruppe" button (centre the canvas on the active Send; if it lives in a subgraph, open that subgraph first).
  - `resolveVirtualOutput(slot)` returns `{node: send.node, slot}` from `validateRoute`. Use the Task 1 probe result for the exact contract, and add the scoped DTO patch only if the probe says it is needed.
- [ ] **Step 3: Queue guard:** wrap `app.queuePrompt` (or the `graphToPrompt` hook the probe found) so that when the graph contains a Warp Select and `validateRoute` is not ok, `alert(error)` runs and nothing is queued. A graph without a Warp Select is untouched.
- [ ] **Step 4: Result routing:**
  - On the `executed` API event for a `Warp Result` node, find the Send whose name equals `output.target[0]`.
  - Store the image refs in `send.properties.warpResult = {first, final}`, a session cache that is not re-fetched after a restart, and redraw.
  - An unknown or empty target leaves every Send unchanged.
- [ ] **Step 5: Verify in the browser pane** on a scratch copy of the workflow:
  - Two groups, each with a Send, plus a Select, a Generate stand-in and a Result.
  - Activating one Send updates the combo.
  - `graphToPrompt` output references only that group's Warp.
  - Each of the six error messages appears in its case.
  - `npm run check` passes.
- [ ] **Step 6: Commit:** `feat: Warp Select routing, Warp Send activation and result slider`

### Task 5: Live preview mirror

**Files:**
- Modify: `web/warp_send.js`

- [ ] **Step 1: Mirror the previews:**
  - Track the prompt id of a queue that passed the guard and the active Send at that moment.
  - On `b_preview_with_metadata` (fall back to `b_preview`) for that prompt id, call `drawPreviewInto(activeSend, blob→ImageBitmap)`.
  - On `execution_success`, `execution_error` or `execution_interrupted`, clear the live frame. The last result, if any, shows again.
- [ ] **Step 2: Enable previews:** after asking the user, add `--preview-method auto` to `C:\Users\grego\Documents\StableDiffusion\ComfyUI-2603\run_nvidia_gpu.bat`, then restart (kill `python main.py`, then `Start-Process` the bat).
- [ ] **Step 3: Verify:** queue a run. The active Send shows changing frames during sampling, then the slider.
- [ ] **Step 4: Commit:** `feat: Warp Send shows the live sampling preview`

### Task 6: Migrate the image workflow and lay it out

**Files (outside the repo):**
- Modify: `ComfyUI/user/default/workflows/Img (26-11-02).json`. Back it up first to the scratchpad as `Img-before-warpsend.json`.
- Create: scratchpad `wf_warpsend_migrate.py`.

- [ ] **Step 1: Capture a regression baseline:** queue the current workflow via `graphToPrompt` (Krea 2, batch 1, fixed seed, Image Filter timeout 3) with prefix `workflow-test/baseline`, and keep the PNG.
- [ ] **Step 2: Write the migration script.** For each model group, replace the `warp - <model>` SetNode with a Warp Send:
  - Use these names and indexes: Flux 2 = 1, Qwen Image = 2, Qwen Image Edit = 3, Z-Image Turbo = 4, Z-Image Base + Turbo = 5, Anima = 6, Krea 2 = 7, Krea 2 Edit = 8, Moss Image = 9.
  - Copy `active` from the current INTConstant 2979 value.

  Then rework the hub:
  - Add Warp Select, linking `warp` to Generate's `warp` and `index` to Generate's `select`.
  - Add Warp Result, with `first` from the Image Selector output (the image that today goes to `Set_img - filtered`) and `final` from Unwarp 4035 `image`.
  - Delete every SetNode and GetNode, InversedSwitches 4024 and 4026, ImpactSwitch 4045, INTConstant 2979, its Label nodes, and the per-group comparers fed by `img - filtered/final` Gets.
- [ ] **Step 3: Apply the layout from the spec:**
  - Model groups go left to right: Models, Prompt + LoRAs, Warp Provider, Warp, Warp Send (520 × group height). Each group stays about 2070 × 900, in two columns, 1–9.
  - Hub: images in the top row, with the detailer previews above their detailer, the final image and Save. Modules go in the bottom row, with Warp Select directly left of Generate. The hub bottom is tight above the groups.
  - Bookmarks: 0 = hub, 1–9 = models (retitled `🔖 (n) <name>`).
- [ ] **Step 4: Check for overlaps:** run the browser overlap check (frontend sizes) from the workflow memory notes. Expected: no overlaps except deliberate ones.
- [ ] **Step 5: Run the regression test:** queue the migrated workflow with the same seed and prefix `workflow-test/after`. Expected: pixel-identical to the baseline (compare with PIL `ImageChops.difference(...).getbbox() is None`). The result and live preview appear in the Krea 2 Send.
- [ ] **Step 6: Switch test:** activate Z-Image Turbo and run. The result lands in ZIT, and Krea 2 still shows its previous result. Then batch 2: the slider arrows step through 2 pairs.
- [ ] **Step 7:** Nothing to commit, since the file is outside the repo. Tell the user to reload the workflow.

### Task 7: Docs, version and release prep

**Files:**
- Modify: `README.md` (a short section on the three nodes and the activation flow), `CHANGELOG.md` (`## [4.2.0] - 2026-11-05`), `pyproject.toml`, `version.txt`, `node_list.json` (add the three ids)

- [ ] **Step 1: Write the docs and bump the version.**
- [ ] **Step 2: Run** `npm run check && python -m pytest -q && python -m ruff check . && python -m ruff format --check . && python -m build`. Expected: everything PASS.
- [ ] **Step 3: Commit:** `chore: release 4.2.0`
- [ ] **Step 4: Ask the user** before the push, PR, merge, tag `v4.2.0`, GitHub release and the registry publish through `publish_action.yml`.

## Probe result

(Filled in by Task 1.)
