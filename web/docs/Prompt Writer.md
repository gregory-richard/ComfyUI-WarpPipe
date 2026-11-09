# Prompt Writer

Have an LLM write and rewrite an image prompt in a chat, and put the version you like into a 🌀 Prompt + LoRAs.

## Overview

Every **Prompt + LoRAs** has an **✨ AI** button on the top-right corner of its text box. It opens the Prompt Writer, a pop-up with your chats on the left and the conversation on the right. Say what you want and press **Write** (or Ctrl+Enter). Each answer is a new version in the chat. Press **Send to prompt** on a version to write it into a Prompt + LoRAs. Writing a prompt never queues an image, and the Prompt Writer takes no part in a run.

Writing goes on in the background. You can close the pop-up (Esc or ×; clicking outside it does nothing), start something in another chat, or go back to the canvas. The **✨ AI** button turns yellow while a chat opened from that node is writing and shows a green dot when one has finished and you have not looked at it yet. A toast says when a prompt is ready.

## Header

- **Title** — Click to rename the chat. A new chat is named after your first request.
- **For** — The Prompt + LoRAs this chat writes for. **Send to prompt**, **+ Current prompt** and the LoRA suggestions all use it. Each chat remembers its own choice by the node's label (its group title, else its own title). A new chat starts on the node you opened it from, and if a remembered label is no longer in the workflow the chat falls back to that node, else to the first one.
- **Model** — Type to filter. Each entry shows the price per million input/output tokens and 👁 for models that see images. A model that is no longer listed stays selected and reads "(not listed)".
- **System prompt** — The `.txt` files in your system prompt folder.
- **⚙** — The server and the key:
  - **Base URL** — The OpenAI-compatible server. Default `https://nano-gpt.com/api/v1`. LM Studio, Ollama and llama.cpp work too; plain `http://` is allowed only for `localhost`, `127.0.0.1` and `::1`.
  - **Temperature** — 0–2, default 0.6.
  - **API key** and **Save key** — See Setup.
  - **Refresh lists** — Reloads the model list (otherwise cached for an hour) and the system prompt list.

## Chats

The **✨ AI** button of a node opens the most recent chat for that node, or a new empty chat if it has none; while the pop-up is open it switches the same way. A node that is writing or has an unseen result opens that chat first.

**New chat** is at the top of the left rail. Each chat shows how many versions it has and when it last changed, a yellow `Writing 4 s` while it writes, and a green check until you open it after it finished. Hover over a chat for its delete button, which asks first. Several chats can write at the same time.

## Versions

Each request appears on the right with its images, and each answer as a card with its version number, what it cost and how long it took, e.g. `Finished · 0.3 ¢ · 8 s · 1,812 → 640 tokens`.

The newest version is open and editable; your edit is saved when you click away. Older versions are one line, click to read them.

- **Send to prompt** — Writes the version's text, exactly as it is, into the Prompt + LoRAs chosen under **For**, as one undo step. That node flashes and the pop-up closes. It writes only the prompt and never touches the LoRA lists.
- **Continue from here** — On older versions: the next **Write** builds on this one.
- **↶ on a message** (appears on hover) — Goes back to that message: it moves into the input with its images, and it and everything after it leave the chat.
- **Chat titles** — While the first version is being written, a cheap model names the chat from your message (**Title model** under the gear, about 0.002 ¢ per title). A title you typed always stays; an empty field or a failure keeps the first words of your message.
- **⋮ on a chat** — **Rename** or **Delete** it.
- **👁** — Shows the selected system prompt, read-only.

A request that fails shows a red card with the message and **Retry**, and does not count as a version.

## Writing a request

The box at the bottom grows with your text. Above it:

- **Images** — **Add image**, drag and drop, or Ctrl+V; up to 8 per request, uploaded to `input/`. They are sent only when the model has vision; otherwise they are left out and the Prompt Writer says so.
- **Base** — What the next **Write** starts from, sent to the LLM along with your request, so a change request returns the complete updated prompt.
  - In a new empty chat, **+ Current prompt** starts from the text of the chosen Prompt + LoRAs and then reads `Builds on: current prompt`.
  - Once there is a version, it reads `Builds on v3`. The **×** clears it, so the next **Write** starts without a base.
  - With a base and an empty box, **Write** asks the LLM to optimise that prompt.
- **LoRAs** — Click to switch between `LoRAs on · 201` and `LoRAs off`; the choice is kept. See LoRA suggestions.

While a chat writes, **Write** becomes **Stop** with a seconds counter. Text you have not sent stays in its chat until ComfyUI's page is reloaded.

## LoRA suggestions

With the **LoRAs** chip on, each **Write** tells the LLM about your LoRAs:

- **Available** — The LoRAs in your library made for the model wired into the **For** node, minus the ones already in use. The number on the chip is how many. Only LoRAs whose base model is known to match are listed, up to 1000. If the model is unknown or none fit, the chip reads `LoRAs: none for this model` and nothing is sent.
- **Active** — The LoRAs in that node's prompt and LoRA list, and in the model 2 list while it is switched on, leaving out lines switched off with `//`. The LLM uses their trigger words where they fit, and leaves out the trigger words of anything else.

With the chip off, the LLM hears nothing about LoRAs and suggests none.

The LLM may answer with up to five LoRAs that would clearly help the image. They appear under the version as **Suggested LoRAs**, each with its preview, a strength and a short reason. **Nothing is added on its own.** Press **+** on a suggestion to:

- add `<lora:name:0.80>` as a new last line of the LoRA list of the **For** node, as one undo step;
- put the LoRA's trigger words, if it has any, as a new first line of that version.

The chip then shows a check. Press it again to take the tag out of the list and remove the trigger line, if that first line is unchanged. The check follows the list: it is off again if you delete or comment out the tag yourself, and it reflects whichever node **For** is on.

## Setup

- **System prompt folder** — Settings → WarpPipe → Prompt Writer. Only `.txt` files directly in that folder are listed.
- **API key** — Type it once under ⚙ and click **Save key**. The backend stores it in `ComfyUI/user/warppipe_llm_keys.json` for the host of the base URL, it survives restarts, and the browser can never read it back; the field only shows whether a key is set. Alternatively set the environment variable `NANOGPT_API_KEY`. For other servers you can also put `{"host": "key"}` entries in `ComfyUI/user/warppipe_llm_keys.json`. A key is sent only to its own host. Local servers get no key unless the file names them.

The key is never stored in a workflow, in image metadata or in the browser. WarpPipe never writes, logs or returns it.

## Where chats are stored

Chats are stored in the ComfyUI user folder, in `warppipe_prompt_chats.json` (`ComfyUI/user/default/` on a single-user install). They are never stored in a workflow or in images. The base URL, model, system prompt and temperature are ComfyUI settings.
