# Prompt Writer

Have an LLM write and rewrite an image prompt in a chat, and put the version you like into a 🌀 Prompt + LoRAs.

## Overview

Every **Prompt + LoRAs** has a small **Write** button on the top-right corner of its text box. It opens the Prompt Writer, a pop-up with your chats on the left and the conversation on the right. Say what you want and press **Write** (or Ctrl+Enter). Each answer is a new version in the chat. Press **Use in** on a version to write it into a Prompt + LoRAs. Writing a prompt never queues an image, and the Prompt Writer takes no part in a run.

Writing goes on in the background. You can close the pop-up (Esc or ×; clicking outside it does nothing), start something in another chat, or go back to the canvas. The **Write** button turns yellow while a chat opened from that node is writing and shows a green dot when one has finished and you have not looked at it yet. A toast says when a prompt is ready.

## Header

- **Title** — Click to rename the chat. A new chat is named after your first request.
- **Model** — Type to filter. Each entry shows the price per million input/output tokens and 👁 for models that see images. A model that is no longer listed stays selected and reads "(not listed)".
- **System prompt** — The `.txt` files in your system prompt folder.
- **⚙** — The server and the key:
  - **Base URL** — The OpenAI-compatible server. Default `https://nano-gpt.com/api/v1`. LM Studio, Ollama and llama.cpp work too; plain `http://` is allowed only for `localhost`, `127.0.0.1` and `::1`.
  - **Temperature** — 0–2, default 0.6.
  - **API key** and **Save key** — See Setup.
  - **Refresh lists** — Reloads the model list (otherwise cached for an hour) and the system prompt list.

## Chats

**New chat** is at the top of the left rail. Each chat shows how many versions it has and when it last changed, a yellow `Writing 4 s` while it writes, and a green check until you open it after it finished. Hover over a chat for its delete button, which asks first. Several chats can write at the same time.

## Versions

Each request appears on the right with its images, and each answer as a card with its version number, what it cost and how long it took, e.g. `Finished · 0.3 ¢ · 8 s · 1,812 → 640 tokens`.

The newest version is open and editable; your edit is saved when you click away. Older versions are one line, click to read them.

- **Use in** — Writes the version's text, exactly as it is, into the Prompt + LoRAs chosen beside it, as one undo step. That node flashes and the pop-up closes. The list starts on the node you opened the pop-up from, and your choice applies to every card.
- **Continue from here** — On older versions: the next **Write** builds on this one.
- **↶ on a message** (appears on hover) — Goes back to that message: it moves into the input with its images, and it and everything after it leave the chat.

A request that fails shows a red card with the message and **Retry**, and does not count as a version.

## Writing a request

The box at the bottom grows with your text. Above it:

- **Images** — **Add image**, drag and drop, or Ctrl+V; up to 8 per request, uploaded to `input/`. They are sent only when the model has vision; otherwise they are left out and the Prompt Writer says so.
- **Base** — What the next **Write** starts from, sent to the LLM along with your request, so a change request returns the complete updated prompt.
  - In a new empty chat, **+ Current prompt** starts from the text of the chosen Prompt + LoRAs and then reads `Builds on: current prompt`.
  - Once there is a version, it reads `Builds on v3`. The **×** clears it, so the next **Write** starts without a base.
  - With a base and an empty box, **Write** asks the LLM to optimise that prompt.

While a chat writes, **Write** becomes **Stop** with a seconds counter. Text you have not sent stays in its chat until ComfyUI's page is reloaded.

## Setup

- **System prompt folder** — Settings → WarpPipe → Prompt Writer. Only `.txt` files directly in that folder are listed.
- **API key** — Type it once under ⚙ and click **Save key**. The backend stores it in `ComfyUI/user/warppipe_llm_keys.json` for the host of the base URL, it survives restarts, and the browser can never read it back; the field only shows whether a key is set. Alternatively set the environment variable `NANOGPT_API_KEY`. For other servers you can also put `{"host": "key"}` entries in `ComfyUI/user/warppipe_llm_keys.json`. A key is sent only to its own host. Local servers get no key unless the file names them.

The key is never stored in a workflow, in image metadata or in the browser. WarpPipe never writes, logs or returns it.

## Where chats are stored

Chats are stored in the ComfyUI user folder, in `warppipe_prompt_chats.json` (`ComfyUI/user/default/` on a single-user install). They are never stored in a workflow or in images. The base URL, model, system prompt and temperature are ComfyUI settings.
