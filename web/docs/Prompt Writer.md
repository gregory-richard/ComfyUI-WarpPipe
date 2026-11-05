# Prompt Writer

Have an LLM write an image prompt and put it into the active group's 🌀 Prompt + LoRAs.

## Overview

Use one **Prompt Writer** in the hub. Type an idea, pick a model and a system prompt, and press **write**. The LLM writes the prompt in the format your system prompt defines, and the status line shows what it cost and how long it took, e.g. `0.3 ¢ · 8 s · 1,812 → 640 tokens`. Press **use** to put the result into the Prompt + LoRAs of the active Warp Send's group. Writing a prompt never queues an image. The node exists only in the browser, so it never takes part in a run.

## Widgets

- **base_url** — The OpenAI-compatible server. Default `https://nano-gpt.com/api/v1`. LM Studio, Ollama and llama.cpp work too; plain `http://` is allowed only for `localhost`, `127.0.0.1` and `::1`.
- **model** — The server's models, with the price per million input/output tokens and 👁 for models that see images. A model that is no longer listed stays selected and reads "(not listed)".
- **system_prompt** — The `.txt` files in your system prompt folder.
- **temperature** — 0–2, default 0.6.
- **reference** — An optional image, set with **reference…** (uploaded to `input/`) and cleared with **clear reference**. It is sent only when the model has vision; otherwise **write** says so and sends text only.
- **idea** — The idea, an existing prompt, or a change request.
- **result** — The LLM's prompt. You can edit it.

## Buttons

- **write** — Sends the request. While it runs it reads `writing…`; click it again to cancel. If **result** is not empty it is sent along, so a change request in **idea** returns the complete updated prompt.
- **new** — Clears **result**, so the next **write** starts fresh.
- **from prompt** — Copies the active group's prompt into **idea**.
- **use** — Writes **result** into the active group's prompt, without lines that start with `//` and with runs of blank lines collapsed. One undo step; the target node flashes.
- **refresh lists** — Reloads the model list (otherwise cached for an hour) and the system prompt list.

## The active group's prompt

From the active Warp Send, the node follows the links upstream, into and out of subgraphs, to a Prompt + LoRAs. If there is none on that path, it takes the Prompt + LoRAs inside the same group as the Send. No active Send, no prompt, or two prompts is an error in the status line that names the group.

## Setup

- **System prompt folder** — Settings → WarpPipe → Prompt Writer. Only `.txt` files directly in that folder are listed.
- **API key** — Type it once into the node's key field and click **save key**. The backend stores it in `ComfyUI/user/warppipe_llm_keys.json` for the host of `base_url`, it survives restarts, and the browser can never read it back. Alternatively set the environment variable `NANOGPT_API_KEY`. For other servers you can also put `{"host": "key"}` entries in `ComfyUI/user/warppipe_llm_keys.json`. A key is sent only to its own host, so a workflow pointing at another server never gets it. Local servers get no key unless the file names them.

The key is never stored in a workflow, in image metadata or in the browser. WarpPipe never writes, logs or returns it.
