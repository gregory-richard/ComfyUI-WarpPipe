# Development

## Setting up

Clone anywhere and link it into ComfyUI rather than working inside
`custom_nodes`:

```powershell
$src = "C:\path\to\ComfyUI-WarpPipe"
$dst = "C:\path\to\ComfyUI\custom_nodes\warppipe"
New-Item -ItemType Junction -Path $dst -Target $src
```

```bash
ln -s /path/to/ComfyUI-WarpPipe /path/to/ComfyUI/custom_nodes/warppipe
```

## Checks

Everything CI runs, in the order it runs it:

```bash
python -m ruff check . --exclude .agents --exclude .claude
```

```bash
python -m ruff format --check . --exclude .agents --exclude .claude
```

```bash
python -m pytest -q
```

```bash
npm ci && npm run check
```

The Python tools are pinned in the workflow and the frontend lockfile is
committed, both for the same reason: a build going red should mean the code
changed, not that a tool released that morning.

`npm run check` is eslint plus prettier over `web/`. `npm run format` writes the
formatting rather than checking it.

## Tests

`pytest` needs no ComfyUI. `tests/conftest.py` installs a fake `comfy`,
`comfy_api` and `torch` into `sys.modules` and loads `warp_pipe.py` fresh for
each test, so legacy and V3 registration can both be exercised in one run.

The fakes exist to make import work and to let schemas be inspected. They are
not a simulation of ComfyUI: anything depending on real execution semantics has
to be tried in ComfyUI.

Worth knowing when adding tests:

- `warp_pipe` and `package_loader` fixtures give you a freshly imported module;
  `warp_pipe_loader(enable_v3=True)` gives you the V3 path.
- A test that asserts a fix should be checked against the unfixed code once, by
  reverting the change and watching it go red. A regression test that never
  could have failed is decoration.
- `test_the_package_ships_every_file_the_frontend_needs` reads `pyproject.toml`
  and asserts every file under `web/` is matched by a `package-data` glob. Add a
  `.css` there and it will tell you before the wheel does.

## Adding a node

1. Write the class in `warp_pipe.py` with `INPUT_TYPES`, `RETURN_TYPES`,
   `RETURN_NAMES`, `FUNCTION` and `CATEGORY`.
2. Add it to `NODE_DEFINITIONS`. That is what both registration paths are built
   from, so this is the only list.
3. Add a V3 class and an entry in `V3_NODE_CLASSES`. Startup logs an error
   naming anything in `NODE_DEFINITIONS` without one, and a test fails.
4. Write `web/docs/<Node ID>.md`. ComfyUI shows it behind the `?` on the node.
5. Document it in [Nodes.md](Nodes.md) and, if it is worth showing, the README.

V3 schemas share one field-id namespace across inputs and outputs, so an output
mirroring an input needs a distinct id and a matching `display_name` — `model`
in, `model_out` displayed as `model` out.

## Screenshots

`assets/docs/*.webp` are captured from a real ComfyUI, not mocked. The setup:

1. Build a small demo LoRA folder — plausible filenames in the
   `creator - name - version (base)` convention, `.civitai.info` sidecars, and
   generated stand-in preview art. Never the real library; a public README
   should not carry somebody's model collection.
2. Run a second ComfyUI on another port with `--base-directory` pointed at that
   folder, so the running instance is untouched. `--base-directory` does not
   override `extra_model_paths.yaml`, so copy `main.py` and the other loose
   modules into a scratch directory beside junctions to the package directories;
   ComfyUI then looks for the config next to that copy and finds none.
3. Drive it with Playwright against an installed Chrome, at
   `deviceScaleFactor: 2`, hiding `.workflow-tabs-container`,
   `.side-toolbar-container`, `.subgraph-breadcrumb` and `.actionbar-container`
   so the app's own chrome stays out of the clip.

Save flat UI shots as lossless WebP and anything with real gradients as quality
90. Palette-quantised PNG bands badly on preview art.

## The wiki

`wiki/` in this repo is the source of truth - it reviews alongside the code that
changes it. A workflow copies it into the GitHub wiki on every push to `main`
that touches it, so the pages are also browsable at `/wiki` with GitHub's own
navigation.

The wiki is a separate repository, so repo-relative paths do not resolve there.
The workflow rewrites them on the way in: `../assets/...` becomes a
`raw.githubusercontent.com` URL and anything else `../` becomes a blob URL.
Links between wiki pages are left alone, because GitHub resolves `Usage.md` to
the Usage page by itself. Keep writing them relative and the rewrite handles it.

One manual step, once: GitHub does not create the wiki repository until a page
has been made in the web UI. Create any page there and the workflow takes over -
it replaces the contents wholesale, so a page deleted from `wiki/` disappears.

## Releasing

1. Move the `[Unreleased]` block in `CHANGELOG.md` under a new version heading
   with today's date.
2. Set the version in **both** `pyproject.toml` and `version.txt`.
3. Merge to `main`.

The publish workflow fires on a push touching `pyproject.toml`, but only
publishes when the version there actually changed against the previous commit —
editing lint config does not re-publish. A manual `workflow_dispatch` always
publishes.

Semver as this project reads it: a new node or a new capability is a minor; a
change that makes an existing workflow load differently is a major. 3.0.0 was
the `CONTROL` → `WARPPIPE` rename. 4.0.0 is the prompt box and the Civitai save
node — nothing breaks, but it is a different pack to use.

## Registry metadata

`[tool.comfy]` in `pyproject.toml` carries the publisher, display name, and raw
GitHub URLs for `assets/registry/icon.png` and `assets/registry/banner.png`.
Those two are the sized, quantised copies — the originals live in
`assets/source/` and are far too heavy for a listing page.
