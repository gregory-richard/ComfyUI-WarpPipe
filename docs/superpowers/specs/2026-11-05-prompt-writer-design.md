# Prompt Writer: design

Date: 2026-11-05. Status: approved in chat, spec under review.

## Goal

The user wants to turn an idea, a reference image or an existing prompt into a good image prompt. The LLM writes it from the user's own system prompt (for example `image_master_prompt_v2.6.txt`), which defines a fixed sectioned format.

- **Placement:** one node in the hub ("Workflow" group).
- **Target:** its result goes into the prompt of the active model group with one click.
- **No generation:** writing a prompt never queues an image.
- **Backend:** NanoGPT by default, with model selection. Any OpenAI-compatible server (LM Studio, Ollama, llama.cpp) works through the same node.

Success means:
- In the hub, the user types an idea and clicks **write**.
- Within seconds a prompt in their format appears, with its cost.
- **use** puts it into the active group's 🌀 Prompt + LoRAs `text`.
- No API key ever appears in a workflow, PNG metadata or the browser.

## Components (ComfyUI-WarpPipe, branch `feat/prompt-writer`, built on `feat/warp-send-select`)

### 🌀 Prompt Writer (frontend-only virtual node, `web/prompt_writer.js`)

It is virtual (`isVirtualNode`, like Warp Select), so it is never part of a queued prompt and has no Python node class.

**Widgets** (stored in the workflow; none of them secret):
- **`base_url`:** text, default `https://nano-gpt.com/api/v1`.
- **`model`:** combo filled from the model list.
  - Each label shows the name, the price per million input/output tokens, and 👁 for vision models, e.g. `Qwen 3.8 27B Uncensored Thinking · $0.30/$1.20 · 👁`.
  - The stored value is the model id.
  - A model that is no longer listed stays selected and shows "(not listed)".
- **`system_prompt`:** combo listing the `.txt` files in the system-prompt folder (see Settings).
- **`temperature`:** FLOAT 0–2, default 0.6.
- **`reference`:** optional image upload (same upload as Load Image, stored in `input/`). It is sent only when the model has vision; otherwise **write** shows a notice and sends text only.
- **`idea`:** multiline. The idea, an existing prompt, or a change request.
- **`result`:** multiline, editable. The LLM's prompt.

**Buttons:**
- **write:**
  - **Request:** sends the request through the backend. If `result` is not empty, the request also includes the previous result, so a change request in `idea` returns "the complete updated prompt", as the system prompt asks.
  - **While running:** the button reads "writing…" and a second click cancels.
  - **Result:** fills `result`, and the status line shows the cost and duration, e.g. `0.3 ¢ · 8 s · 1,812 → 640 tokens`.
- **new:** clears `result`, so the next **write** starts fresh.
- **from prompt:** copies the active group's prompt `text` into `idea`.
- **use:**
  - Writes `result` into the active group's prompt `text`, with lines starting with `//` removed and runs of blank lines collapsed.
  - One undo step.
  - Briefly flashes the target node.
- **refresh lists:** reloads the model list (it is otherwise cached by the backend for one hour).

**The active group's prompt:**
- **Primary rule:** starting from the active Warp Send (from `warp_route.js`), walk upstream through links, including through subgraph boundaries, and collect the nodes of type `Warp Lora Prompt`.
- **Fallback:** if the walk finds none, take the Prompt + LoRAs nodes inside the same LGraphGroup as the Send.
- **Errors:**
  - Exactly one node is required; zero or more than one is an error that names the group.
  - No active Send is an error: "Activate a Warp Send first".

### Backend routes (`prompt_writer.py`, registered next to the existing `/warppipe/*` routes)

- **`GET /warppipe/llm/models?base_url=…[&refresh=1]`:**
  - Calls `{base_url}/models?detailed=true`.
  - Returns `[{id, name, prompt_price, completion_price, vision}]`. Missing fields are null, so plain OpenAI-style servers work too.
- **`GET /warppipe/llm/system_prompts`:** returns the `.txt` file names in the configured folder.
- **`POST /warppipe/llm/write`:**
  - **Body:** `{base_url, model, system_prompt, temperature, idea, previous_result?, reference?}`.
  - **Behaviour:**
    - Reads the system prompt file.
    - Builds the chat messages: system; then `previous_result` as an assistant turn if present; then the user turn with `idea` and the reference image as a data URL.
    - Calls `{base_url}/chat/completions` with no streaming and a 180 s timeout.
  - **Response:** `{text, seconds, usage, cost}`. `cost` comes from the response if the provider sends one, otherwise from usage × listed prices, or null.
  - **Errors:** returned as `{error}` with the provider's message, never with the key.
  - **Thinking models:** a reasoning field (`reasoning`, `reasoning_content`) is discarded, and `<think>…</think>` blocks are stripped from `text`.

### Settings and secrets

- **ComfyUI setting `WarpPipe.PromptWriter.SystemPromptDir`:**
  - The folder of system prompts. It is not secret.
  - The backend lists and reads only `.txt` files directly inside it, with no path separators in the requested name.
- **API keys:**
  - Keys are bound to hosts. A key is used only when the request's `base_url` host equals the key's host. A workflow from someone else that points `base_url` at another server therefore can never receive the key.
  - **Where keys come from:**
    - The environment variable `NANOGPT_API_KEY` covers the hosts `nano-gpt.com` and `api.nano-gpt.com`.
    - Optionally, `ComfyUI/user/warppipe_llm_keys.json` holds `{"host": "key"}` for other hosts.
  - The user creates both themselves. WarpPipe never writes, logs or returns a key.
- **Local servers:**
  - A `base_url` on localhost or 127.0.0.1 is sent with no key unless the file names that host.
  - Plain `http://` is allowed only for those hosts.

## Errors (shown in the node's status line, in red)

- no API key for the host ("set NANOGPT_API_KEY")
- model list unreachable
- provider error text (for example "content refused" or "insufficient balance")
- timeout
- empty answer
- system prompt folder not set or file missing
- active group's prompt not found or ambiguous

## Out of scope

- a history of results
- batches of ideas
- writing automatically at queue time
- per-group writers
- streaming the answer
- a cost budget

## Testing

- **pytest:**
  - Model list mapping: NanoGPT detailed format and a plain OpenAI format.
  - The message layout of **write**, with and without `previous_result` and a reference image.
  - Key-to-host binding: wrong host means no key; a localhost host means no key.
  - `<think>` stripping, cost calculation, and refusal of path traversal in `system_prompt`.
  - All of these against a fake HTTP server; no real network.
- **node tests (`tests/web`):**
  - Removing `//` lines.
  - Finding the active group's prompt by link walk and by group fallback, plus the zero and two error cases, on a small fake graph.
- **Real ComfyUI:**
  - With the user's key, one harmless idea: **write** → **use**.
  - The prompt lands in the active group.
  - The workflow JSON is checked for the absence of the key.
