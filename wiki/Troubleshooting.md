# Troubleshooting

## The nodes do not appear

Restart ComfyUI after installing, then check the startup log. WarpPipe logs
`WarpPipe LoRA library routes registered` when it has loaded; an import failure
appears above that as a traceback naming the file.

If you installed by hand, the folder has to be directly inside `custom_nodes`,
with `__init__.py` at its top level.

## Some nodes are missing, but not all

If `WARPPIPE_ENABLE_V3` is set in your environment, WarpPipe registers through
ComfyUI's V3 API. Should a node ever lack a V3 schema, startup logs an error
naming it. Unset the variable to fall back to the legacy path, which registers
everything.

## The prompt box is a plain text field

No colouring, no strip, no `/` completion means the frontend did not load. Check
the browser console for a failed import of `/extensions/warppipe/prompt_ui.js`.

If you installed from the registry with a version before 4.0.0, the wheel did
not ship the JavaScript at all — `package-data` listed only the documentation.
Upgrading fixes it.

## Every tag is red

Red means no file matched. If *every* tag is red, the library did not load
rather than every name being wrong. Open `/warppipe/loras` directly:

```
http://127.0.0.1:8188/warppipe/loras
```

An error or an empty list points at ComfyUI's LoRA folder configuration, not at
your prompt.

## A tag is red but the file is there

The name has to identify exactly one file. Try, in order: the filename without
folder or extension, then several words from it in any order. A bare fragment
that matches several files cannot be resolved — in one real collection, 24 files
share a single common phrase.

A near miss suggests the closest names in the message, which usually settles it.

## The run stops with "matches no file" or "matches N files"

That is deliberate. Generating without a LoRA the prompt asked for gives a wrong
picture *and* wrong metadata, so an unresolvable tag fails the run rather than
being skipped with a warning nobody reads. Fix the tag, or comment it out with
`//`.

## No previews in the browser

Previews are read off the disk: an image beside the model file named
`<model>.preview.png`, `.preview.jpg`, `.preview.webp`, or just `<model>.png`.
[Civitai Updater](https://github.com/gregory-richard/comfyui-civitai-updater)
downloads them; so do most model managers.

If the files are there but the cards are blank, the thumbnail cache has nowhere
to write. It goes next to ComfyUI's user directory; check that is writable, and
that Pillow is importable in ComfyUI's Python.

## No trigger words anywhere

Trigger words come only from `.civitai.info` sidecars — there is no fallback,
because nothing else on disk knows them. Run Civitai Updater's **Scan Metadata
Only** to fetch them without checking for updates.

`Tab` on a tag always answers: it says the LoRA declares none rather than doing
nothing, so you can tell a missing sidecar from a key that did not register.

## Everything is grouped under folder names, not base models

Same cause. `baseModel` comes from the sidecar; without one, WarpPipe falls back
to the folder, which is right for collections filed that way and meaningless for
the rest.

## A tag is orange

The file is real but its sidecar declares a different base model to the
checkpoint you have wired in. It will load; it usually does nothing useful. You
may know better than the sidecar — the warning does not stop anything.

With nothing connected to `model`, nothing can be judged and nothing goes
orange.

## Civitai does not link the resources

Check the saved PNG actually has a `parameters` chunk — **Generation info** has
to be on, and something has to reach the `images` input.

Then check the resources were found. The node logs any name it could not resolve
and left out. The usual causes:

- The LoRA is not in ComfyUI's LoRA folder any more, so it was not applied
  either.
- The branch that loaded it was behind a switch that did not run — which is
  correct: it did not contribute to the image.
- The upload is a JPEG re-encode. Re-encoding strips EXIF, and with it the
  generation info.

## Saved nothing and said nothing

Fixed in 4.0.0. When nothing reaches `images` the node now reports it on screen
and in the log instead of showing a green tick over an empty save. If you see the
old silent behaviour you are on an older version.

## The workflow did not embed

JPEG has nowhere to keep it. The node saves the file and tells you the workflow
was dropped; the generation info still goes into EXIF, which Civitai reads. Use
PNG if you want the graph in the file.

## Schedulers named beta57 or bong_tangent behave oddly

WarpPipe registers those names globally so other packs — FaceDetailer especially
— accept a workflow built around them. Until RES4LYF itself is installed they
are karras under another label, which is logged at startup. Install RES4LYF for
the real implementations.

## A workflow from 2.x will not connect

3.0.0 renamed the internal type from `CONTROL` to `WARPPIPE`. Reconnect the
Warp-to-Unwarp link once and it will save correctly from then on.

## Outputs are None

An Unwarp returns `None` for anything the warp never carried, rather than
inventing a default. If a sampler is complaining about a missing value, connect
it into the Warp — or check that the Warp you are unpacking is the one you
think, since a chained Warp only carries what it was given plus what it was told.

## Reporting something else

Turn on debug logging and include the startup lines plus whatever the run
produced:

```python
import logging

logging.getLogger("WarpPipe").setLevel(logging.DEBUG)
```

Issues: <https://github.com/gregory-richard/ComfyUI-WarpPipe/issues>
