# API

Four routes, registered on ComfyUI's own `PromptServer` at import. They exist
for WarpPipe's frontend; nothing stops you calling them yourself.

If `aiohttp` or `server` cannot be imported — running the module outside
ComfyUI, for tests or a lint — registration is skipped and the nodes still work.
The frontend degrades with it: tags go uncoloured and the browser says the
library is unavailable.

```
GET /warppipe/loras
GET /warppipe/embeddings
GET /warppipe/model/base?name=<name>
GET /warppipe/lora/thumbnail?name=<name>&kind=<loras|embeddings>[&full=1]
```

---

## `GET /warppipe/loras`

Every LoRA in the configured folders, with everything the browser needs and no
image data.

```json
{
  "loras": [
    {
      "id": "sdxl/atelier - Detail Tweaker - v2.0 (SDXL).safetensors",
      "folder": "sdxl",
      "creator": "atelier",
      "name": "Detail Tweaker",
      "version": "v2.0",
      "tagged_base": "SDXL",
      "base_model": "SDXL 1.0",
      "structured": true,
      "title": "Detail Tweaker (SDXL)",
      "url": "https://civitai.red/models/58390?modelVersionId=583901",
      "triggers": ["highly detailed", "intricate detail"],
      "has_preview": true,
      "kind": "loras",
      "thumbnail": "/warppipe/lora/thumbnail?name=sdxl%2F...&kind=loras"
    }
  ]
}
```

| Field | Where it comes from |
| --- | --- |
| `id` | the exact string a `<lora:...>` tag has to resolve to. Uses the platform's separator, so a Windows entry reads `sdxl\name.safetensors`; tag matching ignores slash direction either way |
| `folder` | the first path segment inside the LoRA folder |
| `creator`, `name`, `version`, `tagged_base` | parsed from a `creator - name - version (base)` filename |
| `structured` | whether the filename actually had that shape — when false, `name` is the whole stem and callers should not pretend otherwise |
| `base_model` | the sidecar's `baseModel`, tidied |
| `title` | the sidecar's `model.name` |
| `url` | built from the sidecar's `modelId` and `id` |
| `triggers` | the sidecar's `trainedWords`, split on commas |
| `has_preview`, `thumbnail` | whether an image sits beside the file; the server owns URL construction |

Sidecar-derived fields are `null` or empty when there is no `.civitai.info`.

Cost is one directory listing, one sidecar read and a handful of `stat` calls
per model. Against 761 files it answers in well under a second and returns a few
hundred kilobytes of JSON.

---

## `GET /warppipe/embeddings`

Identical, keyed `embeddings`. Every entry carries `"kind": "embeddings"`, which
is how the frontend knows to insert `embedding:name` rather than a `<lora:>`
tag.

---

## `GET /warppipe/model/base`

The base model of one file, for matching LoRAs against the checkpoint that is
wired in.

```
GET /warppipe/model/base?name=demo%20-%20Illustrious%20Base%20-%20v1.0%20(SDXL).safetensors
```

```json
{ "name": "...", "base_model": "SDXL 1.0", "found": true }
```

Looked up across `loras`, `checkpoints`, `diffusion_models`, `unet` and
`embeddings`. `found` is whether the file resolved at all; `base_model` is
`null` when it did but declares nothing.

---

## `GET /warppipe/lora/thumbnail`

The preview image beside a model.

| Parameter | |
| --- | --- |
| `name` | the model's `id` from the index |
| `kind` | `loras` or `embeddings`; anything else is a 400 |
| `full` | `1` to serve the original instead of the thumbnail |

Without `full`, a WebP capped at 320px on the long side, built on first request
and cached by path, size and mtime — so replacing a preview refreshes it.
Measured against a real collection: previews average 1.27 MB, thumbnails 6–9 KB,
about 20 ms to build and under a millisecond to serve after that. Both are sent
with `Cache-Control: max-age=86400`.

404 when the model has no preview beside it, or when a thumbnail cannot be built
(no Pillow, or nowhere writable to cache it).

### On paths

`name` is resolved through ComfyUI's `folder_paths`, which is what keeps this to
configured model folders — an arbitrary path can never be requested, and `..`
is neutralised before the lookup. The route serves preview images beside
configured models and nothing else.

These routes are unauthenticated, exactly as the rest of ComfyUI's are. Anyone
who can reach your ComfyUI can list your model library through them, which is
worth knowing if you have bound the server to something other than localhost.
