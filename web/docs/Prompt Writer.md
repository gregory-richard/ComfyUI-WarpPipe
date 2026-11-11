# Prompt Writer

Have an LLM write and rewrite an image prompt in a chat, and put the version you like into a 🌀 Prompt + LoRAs.

## Overview

Every **Prompt + LoRAs** has an **✨ AI** button on the top-right corner of its text box. It opens the Prompt Writer, a pop-up with your chats on the left and the conversation on the right. Say what you want and press the round **↑** in the input (or Ctrl+Enter). Each answer is a new version in the chat. Press **Send to prompt** on a version to write it into a Prompt + LoRAs. Writing a prompt never queues an image, and the Prompt Writer takes no part in a run.

Writing goes on in the background. You can close the pop-up (Esc or ×; clicking outside it does nothing), start something in another chat, or go back to the canvas. The **✨ AI** button turns yellow while a chat opened from that node is writing and shows a green dot when one has finished and you have not looked at it yet. A toast says when a prompt is ready.

## Header

- **Title** — Click to rename the chat. A new chat is named after your first request.
- **For** — The Prompt + LoRAs this chat writes for. **Send to prompt**, **Edit current prompt** and the LoRA suggestions all use it. Each chat remembers its own choice by the node's label (its group title, else its own title). A new chat starts on the node you opened it from, and if a remembered label is no longer in the workflow the chat falls back to that node, else to the first one.
- **Model** — Type to filter. Each entry shows the price per million input/output tokens and 👁 for models that see images. A model that is no longer listed stays selected and reads "(not listed)".
- **System prompt** — The `.txt` files in your system prompt folder.
- **Eye** — Shows the selected system prompt, read-only.
- **Cog** — The server and the key:
  - **Base URL** — The OpenAI-compatible server. Default `https://nano-gpt.com/api/v1`. LM Studio, Ollama and llama.cpp work too; plain `http://` is allowed only for `localhost`, `127.0.0.1` and `::1`.
  - **Temperature** — 0–2, default 0.6.
  - **API key** and **Save key** — See Setup.
  - **Refresh lists** — Reloads the model list (otherwise cached for an hour) and the system prompt list.

## Chats

The **✨ AI** button of a node opens the most recent chat for that node, or a new empty chat if it has none; while the pop-up is open it switches the same way. A node that is writing or has an unseen result opens that chat first.

**New chat** is at the top of the left rail. Each chat shows how many versions it has and when it last changed, a yellow `Writing 4 s` while it writes, `Waiting for your answer` while the AI has a question, and a green check (a ? for a question) until you open it. Its **⋮** menu renames or deletes it; deleting asks first. Several chats can write at the same time.

## Versions

Each **Write** is one card: its version number, what it changed (`edit of v2`, `edit of the current prompt` or `new prompt`), what it cost and how long it took (e.g. `Finished · 0.3 ¢ · 8 s · 1,812 → 640 tokens`), then what you asked for with its images and any questions the AI asked on the way, and then the prompt it wrote. The LLM sees only what it edits, your request and those questions and answers, never the rest of the chat, which is why it is not shown as a conversation.

The newest version is open and editable; your edit is saved when you click away. Older versions are one line with your request; click to read them.

- **→ Send to prompt** — Writes the version's text, exactly as it is, into the Prompt + LoRAs chosen under **For**, as one undo step. That node flashes and the pop-up closes. It writes only the prompt and never touches the LoRA lists.
- **Pencil** — On older versions: the next request edits this version.
- **Undo arrow** (appears on hover) — Goes back to that request: it moves into the input with its images and what it edited, above anything you had typed there, and it and everything after it leave the chat.
- **Chat titles** — While the first version is being written, a cheap model names the chat from your message (**Title model** under the gear, about 0.002 ¢ per title). A title you typed always stays; an empty field or a failure keeps the first words of your message.
- **⋮ on a chat** — **Rename** or **Delete** it.

A request that fails shows a red card with the message and **Retry**, and does not count as a version.

## Writing a request

The box at the bottom grows with your text. Images you add show above the text, and a row of tools sits under it:

- **Image** — Add images; drag and drop and Ctrl+V work too. Up to 8 per request, uploaded to `input/`. They are sent only when the model has vision; otherwise they are left out and the Prompt Writer says so.
- **What the next request does** — Sent to the LLM with your request, so a change request returns the complete updated prompt:
  - **Edit v3 · newest** (or an older version) — The newest is chosen until you pick another; the pencil on an older version picks it too.
  - **Edit current prompt** — The text in the prompt box of the **For** node, read when you press **↑**. The card keeps it under "The current prompt it edited", so you can see what went.
  - **New prompt** — A new prompt from your request alone.
  - Editing with an empty box asks the LLM to optimise the prompt.
- **LoRAs** — **Off**, **List** or **All**; the choice is kept and the numbers say how many LoRAs each offers. See LoRA suggestions.
- **↑** — Sends (Ctrl+Enter does too). It is a yellow stop button while the chat writes; the seconds count in the card. Text you have not sent stays in its chat until ComfyUI's page is reloaded.

## Questions

Your system prompt may tell the LLM to ask instead of writing, for instance when a request contradicts itself. The Prompt Writer tells it to start such a reply with `===QUESTION===`, and shows it as a yellow **Question** card instead of a version, with nothing to send. **↑** then answers: type your answer and the LLM gets the same prompt to edit, your request, its question and your answer. It may ask again. Once it writes, the card becomes the next version and keeps the questions and answers. The undo arrow on the question card takes your request back into the input instead.

## LoRA suggestions

With **LoRAs** on **List** or **All**, each **Write** tells the LLM about your LoRAs:

- **Available, with All** — The LoRAs in your library made for the model wired into the **For** node, minus the ones already in use. Only LoRAs whose base model is known to match are listed, up to 1000.
- **Available, with List** — Only the LoRAs switched off with `//` in that node's LoRA list, and in the model 2 list while it is switched on.
- **Active** — The LoRAs in that node's prompt and LoRA list, and in the model 2 list while it is switched on, leaving out lines switched off with `//`. They count as your choice: the LLM writes the prompt to work with them, uses their trigger words where they fit, and leaves out the trigger words of anything else.

With **Off**, the LLM hears nothing about LoRAs and suggests none.

Under each version, **Active LoRAs** shows what was on when it was written, with its strength and a check while it is still on. Press the check to comment its line out and **+** to switch it on again; the version's text stays as it is. A LoRA written in the prompt text shows a check but is not switched from here.

The LLM may answer with LoRAs that would clearly help the image: with LoRAs active at most two, and only for something they do not already cover; with none active up to five. They appear under the version as **Suggested LoRAs**, each with its preview, a strength and a short reason. **Nothing is added on its own.** Press **+** on a suggestion to:

- switch on its commented line if the LoRA is already in the list, keeping the weight written there, or otherwise add `<lora:name:0.80>` as a new last line of the LoRA list of the **For** node, as one undo step;
- put the LoRA's trigger words, if it has any, as a new first line of that version.

The chip then shows a check. Press it again to undo that: a line that was added goes, a line that was already there is commented out again, and the trigger line is removed if that first line is unchanged. The check follows the list: it is off again if you delete or comment out the tag yourself, and it reflects whichever node **For** is on.

## Setup

- **System prompt folder** — Settings → WarpPipe → Prompt Writer. Only `.txt` files directly in that folder are listed.
- **API key** — Type it once under ⚙ and click **Save key**. The backend stores it in `ComfyUI/user/warppipe_llm_keys.json` for the host of the base URL, it survives restarts, and the browser can never read it back; the field only shows whether a key is set. Alternatively set the environment variable `NANOGPT_API_KEY`. For other servers you can also put `{"host": "key"}` entries in `ComfyUI/user/warppipe_llm_keys.json`. A key is sent only to its own host. Local servers get no key unless the file names them.

The key is never stored in a workflow, in image metadata or in the browser. WarpPipe never writes, logs or returns it.

## Where chats are stored

Chats are stored in the ComfyUI user folder, in `warppipe_prompt_chats.json` (`ComfyUI/user/default/` on a single-user install). They are never stored in a workflow or in images. The base URL, model, system prompt and temperature are ComfyUI settings.
