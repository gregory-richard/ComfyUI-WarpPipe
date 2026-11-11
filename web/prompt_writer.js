// 🌀 Prompt Writer: a chat-style pop-up, opened from the ✨ AI button on each
// 🌀 Prompt + LoRAs, where an LLM writes and rewrites an image prompt.
//
// It exists only in the frontend, so it never takes part in a queued prompt.
// Every network call goes through the /warppipe/llm routes; the browser never
// sees an API key. Chats live in the ComfyUI user folder, never in a workflow.
//
// What a write depends on is module-level, not part of the pop-up: several
// chats can write at once, and all of them carry on after it is closed.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { loras as loraLibrary } from "./library.js";
import { connectedBase } from "./model_base.js";
import {
  addTriggerLine,
  appendLoraTag,
  buildLoraLists,
  isLoraListed,
  listTargets,
  disableLoraTag,
  enableLoraTag,
  loraScopeCounts,
  targetOffLoraTags,
  modelLabel,
  modelPrice,
  removeLoraTag,
  removeTriggerLine,
  resolveSuggestions,
  resolveTarget,
  splitLines,
  statusParts,
  targetLoraTags,
} from "./prompt_writer_core.js";
import {
  CHATS_FILE,
  CURRENT_PROMPT,
  NEW_PROMPT,
  addVersion,
  clearFailure,
  createChat,
  deleteChat,
  dropQuestion,
  emptyStore,
  isStore,
  latestChatFor,
  mergedDraft,
  normalizeStore,
  openQuestion,
  recordFailure,
  renameChat,
  rewindChat,
  setAutoTitle,
  sortedChats,
  startLabel,
  startOptions,
  startValue,
} from "./prompt_chats.js";

const SETTING_DIR = "WarpPipe.PromptWriter.SystemPromptDir";
const SETTING_BASE_URL = "WarpPipe.PromptWriter.BaseUrl";
const SETTING_MODEL = "WarpPipe.PromptWriter.Model";
const SETTING_SYSTEM_PROMPT = "WarpPipe.PromptWriter.SystemPrompt";
const SETTING_TEMPERATURE = "WarpPipe.PromptWriter.Temperature";
const SETTING_TITLE_MODEL = "WarpPipe.PromptWriter.TitleModel";
const SETTING_LORA_SCOPE = "WarpPipe.PromptWriter.LoraScope";
const LORA_SCOPES = ["off", "list", "all"];
const DEFAULT_TITLE_MODEL = "gemma-4-26b-a4b-it-chimeraxheretic";

const DEFAULT_BASE_URL = "https://nano-gpt.com/api/v1";
const DEFAULT_TEMPERATURE = 0.6;
const TEXT_WIDGET = "text";
const LORAS_WIDGET = "loras";
// The node's text boxes in the order they are drawn, the way prompt_ui.js finds them.
const BOX_WIDGETS = [TEXT_WIDGET, LORAS_WIDGET, "loras_2"];
const NOT_LISTED = " (not listed)";
const MAX_IMAGES = 8;
const FLASH_MS = 600;
const TICK_MS = 1000;
const TOAST_MS = 4000;
const LIVE_MS = 100;

// The composer's height, in lines of its CSS line-height plus padding and border.
const INPUT_LINE = 19;
const INPUT_CHROME = 13;
const INPUT_MIN_LINES = 3;
const INPUT_MAX_LINES = 10;

const PLACEHOLDER_WRITE = "Describe the prompt, or the change you want. Ctrl+Enter sends.";
const PLACEHOLDER_ANSWER = "Answer the question. Ctrl+Enter sends.";
const ATTACH_TITLE = "Add images (or drop or paste them here)";
const REWIND_TITLE =
  "Go back to this request: it moves into the input, and it and everything after it leave the chat";

const STYLE = `
.wpw-open {
  position: absolute; top: 4px; right: 14px; z-index: 4;
  height: 26px; padding: 0 10px; font: 400 14px/26px var(--font-inter, Inter, Arial, sans-serif); cursor: pointer;
  color: #fff; background: var(--primary-background, #0b8ce9); border: 0; border-radius: 6px;
}
.wpw-open:hover { background: var(--primary-background-hover, #31b9f4); }
.wpw-open.is-writing { color: #1a1a1a; background: #e8c44e; border-color: #e8c44e; }
.wpw-open.has-unseen::after {
  content: ""; position: absolute; top: -3px; right: -3px; width: 8px; height: 8px;
  border-radius: 50%; background: #5fd38a; box-shadow: 0 0 0 1px #1a1a1a;
}

/* The pop-up sits over ComfyUI's toasts otherwise, and they report from here. */
body:has(.wpw-backdrop) .p-toast { z-index: 1500 !important; }

.wpw-backdrop {
  position: fixed; inset: 0; z-index: 1400;
  background: rgba(0, 0, 0, 0.62);
  display: flex; align-items: center; justify-content: center;
}
.wpw-modal {
  --wpw-warp: var(--primary-background, #0b8ce9);
  --wpw-warp-hover: var(--primary-background-hover, #31b9f4);
  --wpw-raised: var(--secondary-background, #262729);
  --wpw-raised-hover: var(--secondary-background-hover, #313235);
  --wpw-yellow: #e8c44e;
  --wpw-green: #5fd38a;
  --wpw-red: #f07070;
  --wpw-ground: var(--comfy-menu-bg, #202020);
  --wpw-panel: var(--secondary-background, var(--comfy-input-bg, #262729));
  --wpw-ink: var(--base-foreground, var(--input-text, #fff));
  --wpw-rule: var(--border-default, var(--border-color, #494a50));
  --wpw-line: color-mix(in srgb, var(--wpw-rule) 55%, transparent);
  --wpw-muted: color-mix(in srgb, var(--wpw-ink) 58%, transparent);

  position: relative; width: min(1280px, 94vw); height: 88vh;
  display: grid; grid-template-columns: 248px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr);
  grid-template-areas: "rail main";
  background: var(--wpw-ground); color: var(--wpw-ink); color-scheme: dark;
  border: 1px solid var(--wpw-rule); border-radius: 10px; outline: none;
  overflow: hidden; box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
  font: 400 14px/1.45 var(--font-inter, Inter, Arial, sans-serif);
}
.wpw-modal button, .wpw-modal input, .wpw-modal select, .wpw-modal textarea { font: inherit; color: inherit; }
.wpw-modal :focus-visible { outline: 2px solid var(--wpw-warp); outline-offset: 1px; }
.wpw-modal .pi { font-size: inherit; line-height: 1; }
.wpw-spacer { flex: 1; }

.wpw-icon {
  flex: none; width: 30px; height: 30px; padding: 0; background: none; cursor: pointer; font-size: 14px;
  border: 0; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; color: var(--wpw-muted);
}
.wpw-icon:hover { background: var(--wpw-raised-hover); color: var(--wpw-ink); }
.wpw-btn {
  height: 30px; padding: 0 12px; background: var(--wpw-raised); cursor: pointer; white-space: nowrap;
  border: 0; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.wpw-btn .pi { font-size: 12px; }
.wpw-btn:hover { background: var(--wpw-raised-hover); }
.wpw-btn:disabled { opacity: 0.45; cursor: default; }
.wpw-primary { background: var(--wpw-warp); color: #fff !important; }
.wpw-primary:hover { background: var(--wpw-warp-hover); }
.wpw-field {
  height: 30px; box-sizing: border-box; background: var(--wpw-ground);
  border: 1px solid var(--wpw-rule); border-radius: 6px; padding: 0 8px;
}
.wpw-danger { color: var(--wpw-red); }

/* The rail: the app, its settings, and the chats. */
.wpw-rail {
  grid-area: rail; display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--wpw-line); background: var(--wpw-panel);
}
.wpw-rail-head { display: flex; align-items: center; gap: 6px; padding: 12px 10px 6px 16px; }
.wpw-brand { flex: 1; display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.wpw-brand .pi { color: var(--wpw-warp); }
.wpw-new { margin: 6px 10px 10px; flex: none; background: none; border: 1px solid var(--wpw-line); }
.wpw-new:hover { background: var(--wpw-raised-hover); }
.wpw-chats { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 10px; }
.wpw-chat { position: relative; border-radius: 7px; }
.wpw-chat + .wpw-chat { margin-top: 1px; }
.wpw-chat:hover { background: rgba(255, 255, 255, 0.04); }
.wpw-chat.is-open { background: color-mix(in srgb, var(--wpw-warp) 16%, transparent); }
.wpw-chat-open {
  display: block; width: 100%; padding: 8px 30px 8px 10px; background: none; border: 0;
  text-align: left; cursor: pointer;
}
.wpw-chat-title { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; }
.wpw-chat-title span:first-child { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wpw-check { flex: none; color: var(--wpw-green); font-size: 11px; }
.wpw-chat-sub {
  display: flex; gap: 10px; margin-top: 1px; font-size: 11.5px; color: var(--wpw-muted);
  white-space: nowrap; overflow: hidden;
}
.wpw-chat-sub.is-writing, .wpw-chat-sub.is-question { color: var(--wpw-yellow); }
.wpw-chat-sub.is-failed { color: var(--wpw-red); }
.wpw-chat-more {
  position: absolute; top: 7px; right: 4px; width: 22px; height: 22px; padding: 0; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  background: none; border: 0; border-radius: 5px; font-size: 12px; color: var(--wpw-muted); opacity: 0;
}
.wpw-chat:hover .wpw-chat-more, .wpw-chat.is-open .wpw-chat-more, .wpw-chat-more:focus-visible { opacity: 1; }
.wpw-chat-more:hover { background: var(--wpw-raised-hover); color: var(--wpw-ink); }
.wpw-rename-input {
  width: 100%; height: 30px; box-sizing: border-box; padding: 0 8px;
  background: var(--wpw-ground); border: 1px solid var(--wpw-warp); border-radius: 6px;
}
.wpw-confirm { padding: 8px 10px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.wpw-confirm span { flex: 1 1 100%; font-size: 12px; }

/* Pop-overs: the settings and the chat menu. */
.wpw-pop {
  position: absolute; z-index: 6; box-sizing: border-box;
  background: var(--wpw-ground); border: 1px solid var(--wpw-rule); border-radius: 9px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5); padding: 6px;
}
.wpw-chat-menu { position: fixed; width: 130px; display: flex; flex-direction: column; }
.wpw-menu-item {
  height: 30px; padding: 0 8px; background: none; border: 0; border-radius: 5px;
  text-align: left; cursor: pointer;
}
.wpw-menu-item:hover { background: var(--wpw-raised-hover); }
.wpw-menu-item.is-danger { color: var(--wpw-red); }
.wpw-settings {
  top: 48px; left: 12px; width: 420px; max-width: calc(100% - 24px); max-height: calc(100% - 60px);
  overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px;
}
.wpw-settings-title { font-size: 14px; font-weight: 600; margin-bottom: 2px; }
.wpw-set { display: grid; grid-template-columns: 104px minmax(0, 1fr); align-items: center; gap: 10px; font-size: 13px; }
.wpw-set-name { color: var(--wpw-muted); font-size: 12px; }
.wpw-set-control { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wpw-set-control > .wpw-field { flex: 1; min-width: 0; }
.wpw-set-group { margin-top: 4px; padding-top: 12px; border-top: 1px solid var(--wpw-line); }
.wpw-combo {
  display: flex; align-items: center; gap: 8px; cursor: pointer; text-align: left; white-space: nowrap; overflow: hidden;
}
.wpw-combo.is-error { color: var(--wpw-red); }
.wpw-combo:hover, .wpw-prompts:hover { border-color: var(--wpw-warp); }
.wpw-combo .pi-chevron-down { font-size: 10px; color: var(--wpw-muted); }
.wpw-prompts { cursor: pointer; }
.wpw-prompts option { background: var(--wpw-ground); color: var(--wpw-ink); }
.wpw-models { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--wpw-line); border-radius: 8px; }
.wpw-filter { width: 100%; }
.wpw-options { max-height: 38vh; overflow-y: auto; }
.wpw-option {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 5px 8px; background: none; border: 0;
  border-radius: 5px; text-align: left; cursor: pointer;
}
.wpw-option:hover { background: color-mix(in srgb, var(--wpw-warp) 14%, transparent); }
.wpw-option.is-current { color: var(--wpw-warp); }
.wpw-option-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wpw-option-price { flex: none; font-size: 11.5px; color: var(--wpw-muted); font-variant-numeric: tabular-nums; }
.wpw-option .pi-eye { flex: none; font-size: 11px; color: var(--wpw-muted); }
.wpw-none { padding: 8px; color: var(--wpw-muted); }
.wpw-peek-text {
  max-height: 34vh; overflow-y: auto; padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere;
  font-size: 12.5px; line-height: 1.55; user-select: text; background: var(--wpw-panel); border-radius: 8px;
}
.wpw-key-state { font-size: 12px; color: var(--wpw-muted); }
.wpw-key-state.is-set { color: var(--wpw-green); }

.wpw-spin {
  display: inline-block; flex: none; width: 9px; height: 9px; margin-right: 6px; vertical-align: -1px;
  border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
  animation: wpw-turn 0.8s linear infinite;
}
@keyframes wpw-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .wpw-spin { animation-duration: 2.4s; } }

/* The chat: its title and node on top, then a reading column of cards and the input. */
.wpw-main { grid-area: main; display: flex; flex-direction: column; min-height: 0; }
.wpw-chat-head {
  display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 24px;
  border-bottom: 1px solid var(--wpw-line);
}
.wpw-title, .wpw-title-input { flex: 0 1 auto; min-width: 0; max-width: 60%; font-size: 16px; font-weight: 600; }
.wpw-title {
  background: none; border: 1px solid transparent; border-radius: 6px; padding: 3px 8px; margin-left: -9px;
  cursor: text; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wpw-title:hover { border-color: var(--wpw-line); }
.wpw-title-input { flex: 1 1 auto; background: var(--wpw-panel); border: 1px solid var(--wpw-warp); border-radius: 6px; padding: 3px 8px; }
.wpw-for { flex: none; display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--wpw-muted); }
.wpw-modal .wpw-target {
  height: 30px; box-sizing: border-box; min-width: 120px; max-width: 240px; padding: 0 8px; cursor: pointer;
  font-size: 13px; font-weight: 500; color: var(--wpw-ink); background: var(--wpw-panel);
  border: 1px solid color-mix(in srgb, var(--wpw-warp) 65%, transparent); border-radius: 6px;
}
.wpw-modal .wpw-target:hover { border-color: var(--wpw-warp); }
.wpw-modal .wpw-target:disabled { opacity: 0.6; cursor: default; }
.wpw-target option { background: var(--wpw-ground); color: var(--wpw-ink); }

.wpw-convo { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 24px 28px; display: flex; flex-direction: column; gap: 14px; }
.wpw-convo > * { width: 100%; max-width: 780px; margin-inline: auto; box-sizing: border-box; flex: none; }
.wpw-convo > .wpw-hint { margin: auto; max-width: 420px; text-align: center; color: var(--wpw-muted); }
.wpw-hint.is-error { color: var(--wpw-red); }

.wpw-card { background: var(--wpw-panel); border: 1px solid var(--wpw-line); border-radius: 10px; padding: 12px 14px; }
.wpw-card.is-newest { border-color: color-mix(in srgb, var(--wpw-warp) 45%, var(--wpw-rule)); }
.wpw-card.is-writing, .wpw-card.is-question { border-color: color-mix(in srgb, var(--wpw-yellow) 55%, transparent); }
.wpw-card.is-error { border-color: color-mix(in srgb, var(--wpw-red) 60%, transparent); }
.wpw-card-head { display: flex; align-items: center; gap: 10px; min-height: 24px; }
.wpw-card-head.is-toggle { cursor: pointer; }
.wpw-ver { flex: none; font-size: 13px; font-weight: 600; }
.wpw-from { flex: none; font-size: 12px; color: var(--wpw-muted); }
.wpw-status {
  flex: none; display: flex; align-items: center; gap: 12px; max-width: 65%; overflow: hidden;
  font-size: 12px; color: var(--wpw-muted); white-space: nowrap; font-variant-numeric: tabular-nums;
}
.wpw-card.is-writing .wpw-status, .wpw-card.is-question .wpw-status { color: var(--wpw-yellow); }
.wpw-card.is-error .wpw-status { color: var(--wpw-red); }
.wpw-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--wpw-green); margin-right: -4px; }
.wpw-preview { flex: 1; min-width: 0; color: var(--wpw-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* What was asked: a quiet margin line, so the prompt below it is what stands out. */
.wpw-ask {
  position: relative; margin-top: 10px; padding: 2px 34px 2px 12px;
  border-left: 2px solid color-mix(in srgb, var(--wpw-warp) 55%, transparent);
}
.wpw-said { display: flex; gap: 10px; align-items: baseline; }
.wpw-said + .wpw-said { margin-top: 5px; }
.wpw-who { flex: none; width: 26px; font-size: 11px; color: var(--wpw-muted); }
.wpw-said-text { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.wpw-said.is-empty .wpw-said-text { font-style: italic; color: var(--wpw-muted); }
.wpw-said.is-question .wpw-who, .wpw-said.is-question .wpw-said-text { color: var(--wpw-yellow); }
.wpw-rewind {
  position: absolute; top: 0; right: 0; width: 26px; height: 26px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; background: transparent; color: var(--wpw-muted);
  font-size: 12px; cursor: pointer; opacity: 0; pointer-events: none;
}
.wpw-rewind.is-inline { position: static; flex: none; }
.wpw-ask:hover .wpw-rewind, .wpw-card-head:hover .wpw-rewind, .wpw-rewind:focus-visible { opacity: 1; pointer-events: auto; }
.wpw-rewind:hover { background: var(--wpw-raised-hover); color: var(--wpw-ink); }
.wpw-thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 0 36px; }
.wpw-thumbs img { width: 64px; height: 64px; object-fit: cover; border-radius: 6px; display: block; }
.wpw-quote { margin-bottom: 6px; font-size: 12px; }
.wpw-quote summary { cursor: pointer; color: var(--wpw-muted); }
.wpw-quote-text {
  margin-top: 4px; padding: 6px 10px; max-height: 30vh; overflow-y: auto; white-space: pre-wrap;
  overflow-wrap: anywhere; background: var(--wpw-ground); border-radius: 6px; user-select: text;
}
.wpw-hint-line { margin-top: 8px; font-size: 12px; color: var(--wpw-muted); }
/* What the model thought: quiet, scrolled to its newest line while it comes. */
.wpw-thinking { margin-top: 10px; font-size: 12px; }
.wpw-thinking summary { cursor: pointer; color: var(--wpw-muted); width: max-content; }
.wpw-thinking-text {
  margin-top: 6px; max-height: 180px; overflow-y: auto; padding: 8px 10px; border-radius: 6px;
  background: var(--wpw-ground); color: var(--wpw-muted); line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
}
.wpw-text.is-live { color: color-mix(in srgb, var(--wpw-ink) 80%, transparent); }

/* The prompt itself, set for reading. */
.wpw-modal .wpw-editor, .wpw-text { font-size: 13.5px; line-height: 1.6; }
.wpw-modal .wpw-editor {
  display: block; width: 100%; box-sizing: border-box; margin-top: 12px; padding: 10px 12px; resize: none;
  background: var(--wpw-ground); border: 1px solid transparent; border-radius: 8px;
}
.wpw-modal .wpw-editor:hover { border-color: var(--wpw-line); }
.wpw-modal .wpw-editor:focus { border-color: color-mix(in srgb, var(--wpw-warp) 70%, transparent); outline: none; }
.wpw-text { margin-top: 12px; padding: 0 2px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.wpw-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex: none; }
.wpw-actions.is-block { margin-top: 12px; }
.wpw-error-text { margin-top: 10px; color: var(--wpw-red); white-space: pre-wrap; overflow-wrap: anywhere; }

.wpw-suggest { margin-top: 12px; }
.wpw-suggest-label { font-size: 12px; color: var(--wpw-muted); margin-bottom: 6px; }
.wpw-suggest-row { display: flex; flex-wrap: wrap; gap: 6px; }
/* A fixed box, and + and the check share one size: pressing moves nothing. */
.wpw-lora {
  display: flex; align-items: center; gap: 8px; box-sizing: border-box;
  width: 290px; max-width: 100%; height: 48px; padding: 4px 6px 4px 4px;
  background: var(--wpw-ground); border: 1px solid var(--wpw-line); border-radius: 8px;
}
.wpw-lora.is-added { border-color: color-mix(in srgb, var(--wpw-warp) 70%, transparent); }
.wpw-lora-thumb {
  flex: none; display: block; width: 38px; height: 38px; object-fit: cover;
  border-radius: 5px; background: var(--wpw-raised);
}
.wpw-lora-body { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
.wpw-lora-top { display: flex; align-items: baseline; gap: 6px; font-size: 12px; font-weight: 500; }
.wpw-lora-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wpw-lora-strength { flex: none; font-size: 11px; font-weight: 400; color: var(--wpw-muted); font-variant-numeric: tabular-nums; }
.wpw-lora-reason { font-size: 11px; color: var(--wpw-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wpw-lora-add {
  flex: none; width: 26px; height: 26px; padding: 0; cursor: pointer; font-size: 11px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--wpw-raised); border: 0; border-radius: 6px;
}
.wpw-lora-add:hover { background: var(--wpw-raised-hover); }
.wpw-lora.is-added .wpw-lora-add { background: var(--wpw-warp); color: #fff; }
.wpw-lora.is-added .wpw-lora-add:hover { background: var(--wpw-warp-hover); }
.wpw-lora-add:disabled { cursor: default; opacity: 0.6; }
/* What is on already takes little room, so what is new stands out. */
.wpw-lora.is-compact { width: auto; max-width: 260px; height: 30px; padding: 2px 4px 2px 2px; gap: 6px; }
.wpw-lora.is-compact .wpw-lora-thumb { width: 24px; height: 24px; }
.wpw-lora.is-compact .wpw-lora-add { width: 22px; height: 22px; font-size: 10px; }

/* The input: one box with the images, the text, and its tools. */
.wpw-composer { flex: none; padding: 4px 24px 18px; }
.wpw-composer > * { max-width: 780px; margin-inline: auto; }
.wpw-box { border: 1px solid var(--wpw-rule); border-radius: 12px; background: var(--wpw-panel); }
.wpw-box:focus-within { border-color: color-mix(in srgb, var(--wpw-warp) 75%, transparent); }
.wpw-composer.is-drag .wpw-box { border-color: var(--wpw-warp); box-shadow: 0 0 0 3px color-mix(in srgb, var(--wpw-warp) 25%, transparent); }
.wpw-attached { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 12px 0; }
.wpw-attached:empty { display: none; }
.wpw-input {
  display: block; width: 100%; box-sizing: border-box; padding: 11px 14px 4px; resize: none;
  line-height: ${INPUT_LINE}px; background: transparent; border: 0;
}
.wpw-modal .wpw-input:focus-visible { outline: none; }
.wpw-tools { display: flex; align-items: center; gap: 6px; padding: 4px 8px 8px 8px; }
.wpw-tools-left { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.wpw-tool {
  flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: none;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px; color: var(--wpw-muted);
}
.wpw-tool:hover { background: var(--wpw-raised-hover); color: var(--wpw-ink); }
.wpw-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; box-sizing: border-box; padding: 0 8px;
  background: var(--wpw-ground); border: 1px solid var(--wpw-line); border-radius: 13px; font-size: 12px;
}
.wpw-chip img { width: 20px; height: 20px; object-fit: cover; border-radius: 4px; display: block; }
.wpw-chip.is-base { border-color: color-mix(in srgb, var(--wpw-warp) 60%, transparent); color: var(--wpw-warp); }
.wpw-chip-x { background: none; border: 0; padding: 0 1px; cursor: pointer; font-size: 14px; line-height: 1; color: var(--wpw-muted); }
.wpw-chip-x:hover { color: var(--wpw-red); }
.wpw-start-chip { gap: 6px; padding: 0 4px 0 10px; font-size: 11px; }
.wpw-modal .wpw-start {
  height: 22px; max-width: 280px; padding: 0 2px; border: 0; background: transparent;
  color: var(--wpw-warp); font-size: 12px; font-weight: 500; cursor: pointer;
}
.wpw-start option { background: var(--wpw-ground); color: var(--wpw-ink); }
.wpw-seg {
  display: inline-flex; align-items: center; height: 26px; overflow: hidden;
  border: 1px solid var(--wpw-line); border-radius: 13px; font-size: 12px;
}
.wpw-seg-label { padding: 0 8px 0 10px; color: var(--wpw-muted); white-space: nowrap; }
.wpw-seg-btn { height: 100%; padding: 0 9px; background: none; border: 0; cursor: pointer; white-space: nowrap; }
.wpw-seg-btn:hover { background: var(--wpw-raised-hover); }
.wpw-seg-btn.is-on { background: var(--wpw-warp); color: #fff; }
.wpw-seg-count { margin-left: 5px; opacity: 0.6; font-variant-numeric: tabular-nums; }
.wpw-seg-btn.is-on .wpw-seg-count { opacity: 0.85; }
/* Round and the same size whatever it does: write, answer or stop. */
.wpw-send {
  flex: none; width: 32px; height: 32px; padding: 0; border-radius: 50%; font-size: 13px;
  display: inline-flex; align-items: center; justify-content: center;
}
.wpw-send.is-stop { background: var(--wpw-yellow); color: #1a1a1a !important; }
.wpw-note { font-size: 12px; margin-top: 6px; padding-left: 4px; color: var(--wpw-muted); }
.wpw-note.is-error { color: var(--wpw-red); }
.wpw-note:empty { display: none; }
`;

// --- State that outlives the pop-up -------------------------------------------

let store = null;
let storeLoad = null;
let saving = false;
let saveAgain = false;
let ticker = null;
let listsRun = 0;
let loraRun = 0;

/** chat id → the running job. */
const jobs = new Map();
/** chat id → the node it was written from, until the chat is opened. */
const unseen = new Map();
/** chat id → the unsent composer. */
const drafts = new Map();
/** Prompt + LoRAs node → its Write button. */
const buttons = new WeakMap();

/** Settings changed from here, readable at once however the frontend stores them. */
const written = new Map();

const lists = { models: [], prompts: [], loading: false, error: "" };

/** The open pop-up: its elements and what it is showing. Null while closed. */
let view = null;

// --- Small helpers ------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child != null && child !== false));
  return node;
}

function button(text, onClick, className = "wpw-btn", title) {
  return el("button", { type: "button", class: className, text, title, onClick });
}

/** One of ComfyUI's own PrimeIcons. */
function icon(name) {
  return el("i", { class: `pi ${name}`, "aria-hidden": "true" });
}

/** A button that is only an icon; the title says what it does. */
function iconButton(name, onClick, className, title) {
  return el(
    "button",
    { type: "button", class: className, title, "aria-label": title, onClick },
    icon(name)
  );
}

/** A button with an icon before its words. */
function labelledButton(name, text, onClick, className = "wpw-btn", title) {
  return el("button", { type: "button", class: className, title, onClick }, icon(name), text);
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureStyle() {
  if (document.getElementById("wpw-style")) return;
  document.head.appendChild(el("style", { id: "wpw-style", textContent: STYLE }));
}

function getSetting(id, fallback) {
  if (written.has(id)) return written.get(id);
  const value = app.extensionManager?.setting?.get?.(id) ?? app.ui?.settings?.getSettingValue?.(id);
  return value ?? fallback;
}

function setSetting(id, value) {
  written.set(id, value);
  const manager = app.extensionManager?.setting;
  const done = manager?.set
    ? manager.set(id, value)
    : app.ui?.settings?.setSettingValue?.(id, value);
  Promise.resolve(done).catch((error) => console.error("[WarpPipe] setting", id, error));
}

function baseUrl() {
  return String(getSetting(SETTING_BASE_URL, "")).trim() || DEFAULT_BASE_URL;
}

function clampTemperature(value) {
  const number = Number(value);
  if (value === "" || value == null || !Number.isFinite(number)) return DEFAULT_TEMPERATURE;
  return Math.min(2, Math.max(0, number));
}

function toast(severity, summary, detail, life = TOAST_MS) {
  app.extensionManager?.toast?.add?.({ severity, summary, detail, life });
}

function redraw() {
  app.canvas?.setDirty?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

/** Records the current graph as one undo step, where the frontend allows it. */
function checkpoint() {
  const tracker =
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker ??
    app.workflowManager?.activeWorkflow?.changeTracker;
  tracker?.checkState?.();
}

function flash(node) {
  const before = node.boxcolor;
  node.boxcolor = "#6f6";
  redraw();
  setTimeout(() => {
    node.boxcolor = before;
    redraw();
  }, FLASH_MS);
}

async function getJson(route, options) {
  return readJson(await api.fetchApi(route, options));
}

async function readJson(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    return { error: `HTTP ${response.status}: no JSON answer` };
  }
  if (!response.ok && !body?.error) return { error: `HTTP ${response.status}` };
  return body ?? { error: "empty answer" };
}

function postJson(route, payload, signal) {
  return getJson(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
}

/**
 * A write, read as it streams: each {"type": "delta"} line goes to `onPiece`, and
 * the final {"type": "done"} line is what this returns. A server that answers in
 * one piece, or with an error, is read as plain JSON.
 */
async function streamJson(route, payload, signal, onPiece) {
  const response = await api.fetchApi(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.body || !(response.headers.get("Content-Type") ?? "").includes("ndjson")) {
    return readJson(response);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  let done = null;
  const take = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event?.type === "done") done = event;
    else if (event?.type === "delta") onPiece(event);
  };
  for (;;) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    const split = splitLines(rest + decoder.decode(value, { stream: true }));
    rest = split.rest;
    split.lines.forEach(take);
  }
  if (rest.trim()) take(rest);
  return done ?? { error: "The answer broke off before it was complete." };
}

function secondsSince(started) {
  return `${Math.max(0, Math.round((Date.now() - started) / 1000))} s`;
}

function timeAgo(when) {
  const at = new Date(when).getTime();
  if (!at) return "";
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(at).toLocaleDateString("en-US");
}

/** Uploaded names are "subfolder/name" when there is a subfolder. */
function thumbUrl(name) {
  const at = name.lastIndexOf("/");
  const filename = encodeURIComponent(at < 0 ? name : name.slice(at + 1));
  const subfolder = at < 0 ? "" : `&subfolder=${encodeURIComponent(name.slice(0, at))}`;
  return api.apiURL(`/view?filename=${filename}&type=input${subfolder}`);
}

function secondsEl(started) {
  const span = el("span", { text: secondsSince(started) });
  span.dataset.started = String(started);
  return span;
}

function tick() {
  if (!jobs.size) {
    clearInterval(ticker);
    ticker = null;
  }
  if (!view) return;
  for (const span of view.modal.querySelectorAll("[data-started]")) {
    span.textContent = secondsSince(Number(span.dataset.started));
  }
}

// --- Persistence --------------------------------------------------------------

async function readStore() {
  const response = await api.getUserData(CHATS_FILE);
  if (response.status === 404) {
    store = emptyStore();
    return;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const raw = await response.json();
  if (!isStore(raw)) throw new Error("not a chat file this version can read");
  store = normalizeStore(raw);
}

/** A failed read is left unloaded, so a later save cannot overwrite the file. */
function ensureStore() {
  if (store) return Promise.resolve();
  storeLoad ??= readStore().finally(() => {
    storeLoad = null;
  });
  return storeLoad;
}

async function save() {
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  try {
    do {
      saveAgain = false;
      await api.storeUserData(CHATS_FILE, store, {
        stringify: true,
        overwrite: true,
        throwOnError: true,
      });
    } while (saveAgain);
  } catch (error) {
    console.error("[WarpPipe] saving chats", error);
    toast("error", "Could not save chats", String(error?.message ?? error), 6000);
  } finally {
    saving = false;
  }
}

// --- The Write button on each prompt ------------------------------------------

function syncButton(node) {
  const element = node ? buttons.get(node) : null;
  if (!element) return;
  const writing = [...jobs.values()].some((job) => job.originNode === node);
  const finished = [...unseen.values()].includes(node);
  element.classList.toggle("is-writing", writing);
  element.classList.toggle("has-unseen", finished);
  element.title = writing
    ? "Prompt Writer: writing…"
    : finished
      ? "Prompt Writer: a prompt is ready"
      : "Open the Prompt Writer";
}

/** The button for this node, made once; the caller places it over the text box. */
export function writeButtonFor(node) {
  let element = buttons.get(node);
  if (element) return element;
  ensureStyle();
  element = el("button", {
    type: "button",
    class: "wpw-open",
    text: "✨ AI",
    // The canvas selects and drags on the same press underneath.
    onPointerdown: (event) => event.stopPropagation(),
    onDblclick: (event) => event.stopPropagation(),
    onClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPromptWriter(node);
    },
  });
  buttons.set(node, element);
  syncButton(node);
  return element;
}

// --- Drafts and the base of the next write ------------------------------------

function draftOf(chatId) {
  let draft = drafts.get(chatId);
  if (!draft) {
    draft = { text: "", images: [], base: null, uploading: 0, note: null };
    drafts.set(chatId, draft);
  }
  return draft;
}

function currentChat() {
  if (!view || !store) return null;
  return store.chats.find((chat) => chat.id === view.chatId) ?? null;
}

/** What the next write starts from: {id, text, prompt}, or null for nothing. */
function chosenBase(chat, draft) {
  const value = startValue(chat, draft.base);
  if (value === NEW_PROMPT) return null;
  if (value === CURRENT_PROMPT) {
    const widget = targetNow()?.node?.widgets?.find((w) => w.name === TEXT_WIDGET);
    return { id: CURRENT_PROMPT, text: String(widget?.value ?? ""), prompt: true };
  }
  const version = chat.versions.find((v) => v.id === value);
  return { id: version.id, text: version.text, prompt: false };
}

/** What a Write sends: a new request, or the answer to the question the AI asked. */
function nextStep(chat, draft) {
  const typed = draft.text.trim();
  const pending = chat.pending;
  if (pending) {
    if (!typed) return { error: "Type your answer first." };
    return {
      request: pending.request,
      images: pending.images,
      baseId: pending.baseId,
      basePrompt: pending.basePrompt,
      baseText:
        pending.basePrompt ?? chat.versions.find((v) => v.id === pending.baseId)?.text ?? "",
      turns: [...pending.turns, { question: pending.question, answer: typed }],
      answer: typed,
    };
  }
  const base = chosenBase(chat, draft);
  if (base?.prompt && !base.text.trim()) return { error: "That Prompt + LoRAs is empty." };
  if (!typed && !base?.text?.trim()) return { error: "Type what you want first." };
  return {
    request: typed,
    images: [...draft.images],
    baseId: base?.id ?? null,
    basePrompt: base?.prompt ? base.text : null,
    baseText: base?.text ?? "",
    turns: [],
    answer: null,
  };
}

function setNote(chatId, text, isError = false) {
  draftOf(chatId).note = text ? { text, isError } : null;
  if (view?.chatId === chatId) renderNote();
}

// --- What the LLM is told about LoRAs -----------------------------------------

function loraScope() {
  const scope = getSetting(SETTING_LORA_SCOPE, "all");
  return LORA_SCOPES.includes(scope) ? scope : "all";
}

/** The lists a write for this node would send; null when there is nothing to send. */
async function loraListsFor(node, scope) {
  try {
    const [entries, base] = await Promise.all([loraLibrary(), connectedBase(node)]);
    return buildLoraLists(entries, base, targetLoraTags(node), {
      scope,
      listed: targetOffLoraTags(node),
    });
  } catch (error) {
    console.warn("[WarpPipe] LoRA library", error);
    return null;
  }
}

/** Done once per request, so a Retry repeats what failed. */
async function attachLoras(spec) {
  if (spec.loraRefs) return;
  spec.loraRefs = new Map();
  if (spec.loraScope === "off") return;
  const lists = await loraListsFor(spec.loraNode, spec.loraScope);
  if (!lists) return;
  spec.payload.loras = { available: lists.available, active: lists.active };
  spec.loraRefs = lists.refs;
  spec.activeLoras = lists.activeChips;
}

// --- Writing ------------------------------------------------------------------

function findModel(id) {
  return lists.models.find((m) => m.id === id) ?? null;
}

function startWrite(chat) {
  if (jobs.has(chat.id)) return;
  flushEdits();
  refreshTargets();
  const draft = draftOf(chat.id);
  const model = String(getSetting(SETTING_MODEL, ""));
  if (!model) {
    setNote(chat.id, "Pick a model first.", true);
    return;
  }
  if (draft.uploading) {
    setNote(chat.id, "Wait for the images to finish uploading.", true);
    return;
  }
  const step = nextStep(chat, draft);
  if (step.error) {
    setNote(chat.id, step.error, true);
    view.input.focus();
    return;
  }

  // An answer goes with the images its request already sent.
  let images = step.images;
  let note = null;
  if (step.answer == null && images.length && !findModel(model)?.vision) {
    note = { text: "Images left out: this model cannot see images.", isError: false };
    images = [];
  }

  const systemPrompt = String(getSetting(SETTING_SYSTEM_PROMPT, ""));
  const spec = {
    request: step.request,
    images,
    baseId: step.baseId,
    basePrompt: step.basePrompt,
    turns: step.turns,
    answer: step.answer,
    model,
    systemPrompt,
    originNode: view.promptNode,
    loraScope: loraScope(),
    loraNode: view.targetNode,
    payload: {
      base_url: baseUrl(),
      model,
      system_prompt: systemPrompt,
      temperature: clampTemperature(getSetting(SETTING_TEMPERATURE, DEFAULT_TEMPERATURE)),
      idea: step.request,
      previous_result: step.baseText,
      references: images,
      turns: step.turns,
    },
  };

  draft.text = "";
  if (step.answer == null) {
    draft.images = [];
    draft.base = null;
  }
  draft.note = note;
  view.input.value = "";
  growInput();
  launch(chat, spec);
}

/** Runs one request; `spec` is everything it needs, so a Retry can repeat it. */
async function launch(chat, spec) {
  if (clearFailure(chat)) save();
  const controller = new AbortController();
  const job = {
    ...spec,
    chatId: chat.id,
    controller,
    startedAt: Date.now(),
    dropped: false,
    thinking: "",
    text: "",
    tokens: 0,
  };
  jobs.set(chat.id, job);
  syncButton(spec.originNode);
  ticker ??= setInterval(tick, TICK_MS);
  refresh(chat.id);
  if (!chat.versions.length && !spec.titleAsked && spec.answer == null) {
    spec.titleAsked = true;
    nameChat(chat, spec);
  }

  let out = null;
  let message = null;
  let cancelled = false;
  try {
    await attachLoras(spec);
    out = await streamJson("/warppipe/llm/write", spec.payload, controller.signal, (piece) => {
      job.thinking += piece.thinking ?? "";
      job.text += piece.text ?? "";
      job.tokens = piece.tokens ?? job.tokens;
      paintLiveSoon();
    });
    if (out?.error) message = String(out.error);
    else if (!String(out?.question ?? out?.text ?? "").trim()) {
      message = "The model returned no text.";
    }
  } catch (error) {
    if (error?.name === "AbortError") cancelled = true;
    else message = String(error?.message ?? error);
  }

  jobs.delete(chat.id);
  syncButton(spec.originNode);
  if (job.dropped) return;

  if (cancelled) restoreDraft(chat, spec);
  else if (message) {
    recordFailure(chat, spec, message, Date.now());
    save();
    toast("error", "Prompt failed", chat.title, 6000);
  } else if (out.question) {
    askQuestion(chat, spec, out);
  } else {
    finish(chat, spec, out);
  }
  refresh(chat.id);
}

function finish(chat, spec, out) {
  addVersion(chat, {
    id: uid(),
    now: Date.now(),
    request: spec.request,
    images: spec.images,
    baseId: spec.baseId,
    text: String(out.text),
    model: spec.model,
    systemPrompt: spec.systemPrompt,
    cost: out.cost,
    seconds: out.seconds,
    usage: out.usage,
    suggestions: resolveSuggestions(out.suggestions, spec.loraRefs),
    activeLoras: spec.activeLoras ?? [],
    questions: spec.turns ?? [],
    basePrompt: spec.basePrompt ?? null,
    reasoning: String(out.reasoning ?? ""),
  });
  dropQuestion(chat);
  // The first version titles the chat with its first words; a generated title wins.
  if (spec.aiTitle) setAutoTitle(chat, spec.aiTitle);
  save();
  if (view?.chatId !== chat.id) {
    unseen.set(chat.id, spec.originNode);
    syncButton(spec.originNode);
  }
  toast("success", "Prompt ready", chat.title);
}

/** The AI asked instead of writing: the step waits in the chat for the answer. */
function askQuestion(chat, spec, out) {
  openQuestion(chat, spec, String(out.question), Date.now());
  if (spec.aiTitle) setAutoTitle(chat, spec.aiTitle);
  save();
  if (view?.chatId !== chat.id) {
    unseen.set(chat.id, spec.originNode);
    syncButton(spec.originNode);
  }
  toast("info", "The AI has a question", chat.title);
}

/** Ask the cheap model for a title while the prompt is written. On failure the first words stay. */
async function nameChat(chat, spec) {
  if (chat.titleEdited) return;
  const source = spec.request || spec.payload?.previous_result || "";
  if (!source.trim()) return;
  const model = String(getSetting(SETTING_TITLE_MODEL, DEFAULT_TITLE_MODEL)).trim();
  if (!model) return;
  let out;
  try {
    out = await getJson("/warppipe/llm/title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: baseUrl(), model, source }),
    });
  } catch (error) {
    console.warn("[WarpPipe] chat title", error);
    return;
  }
  if (out?.error) {
    console.warn("[WarpPipe] chat title", out.error);
    return;
  }
  spec.aiTitle = out?.title;
  if (!setAutoTitle(chat, out?.title)) return;
  save();
  if (!view) return;
  renderRail();
  if (view.chatId === chat.id) renderTitle();
}

/** After Stop, the request goes back into the composer unless a new one is there. */
function restoreDraft(chat, spec) {
  const draft = draftOf(chat.id);
  if (draft.text.trim() || draft.images.length) return;
  fillDraft(chat, spec);
}

/** Put a request back into the composer with its images and starting point, or an answer back. */
function fillDraft(chat, spec) {
  const draft = draftOf(chat.id);
  const answering = spec.answer != null;
  const merged = mergedDraft(
    draft,
    {
      text: (answering ? spec.answer : spec.request) ?? "",
      images: answering ? [] : (spec.images ?? []).filter((name) => typeof name === "string"),
    },
    MAX_IMAGES
  );
  draft.text = merged.text;
  draft.images = merged.images;
  if (!answering) {
    draft.base = spec.baseId === "seed" ? CURRENT_PROMPT : (spec.baseId ?? NEW_PROMPT);
  }
  if (merged.overflow) {
    draft.note = { text: `At most ${MAX_IMAGES} images per request.`, isError: true };
  }
  if (view?.chatId === chat.id) {
    view.input.value = draft.text;
    growInput();
  }
}

/** Show the composer again after a request moved back into it. */
function focusComposer() {
  renderRail();
  renderConvo(false);
  renderChips();
  renderSend();
  renderNote();
  view.input.focus();
  view.input.setSelectionRange(view.input.value.length, view.input.value.length);
}

/** The message goes back into the input; it and everything after it leave the chat. */
function rewindTo(chat, version) {
  if (jobs.has(chat.id)) return;
  flushEdits();
  const rewound = rewindChat(chat, version.id, Date.now());
  if (!rewound) return;
  dropQuestion(chat);
  clearFailure(chat);
  fillDraft(chat, rewound);
  save();
  focusComposer();
}

/** The request of a step that waits for an answer goes back into the input instead. */
function rewindQuestion(chat) {
  if (jobs.has(chat.id)) return;
  const step = dropQuestion(chat);
  if (!step) return;
  clearFailure(chat);
  fillDraft(chat, step);
  save();
  focusComposer();
}

/** The same for a request that failed, which never became a version. */
function rewindFailure(chat) {
  const failure = chat.failure;
  clearFailure(chat);
  if (failure) fillDraft(chat, failure);
  save();
  focusComposer();
}

/** A failed request built again from what the chat kept, so a Retry works after a reload too. */
function retrySpec(chat, failure) {
  const baseText =
    failure.basePrompt ?? chat.versions.find((v) => v.id === failure.baseId)?.text ?? "";
  return withCurrentSettings({
    request: failure.request,
    images: failure.images,
    baseId: failure.baseId,
    basePrompt: failure.basePrompt,
    turns: failure.turns,
    answer: failure.answer,
    titleAsked: true,
    originNode: view.promptNode,
    loraScope: loraScope(),
    loraNode: view.targetNode,
    payload: {
      idea: failure.request,
      previous_result: baseText,
      references: failure.images,
      turns: failure.turns,
    },
  });
}

// --- Images -------------------------------------------------------------------

async function uploadImage(file) {
  const body = new FormData();
  body.append("image", file);
  const response = await api.fetchApi("/upload/image", { method: "POST", body });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

async function addImages(chatId, files) {
  const images = files.filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  const draft = draftOf(chatId);
  const room = Math.max(0, MAX_IMAGES - draft.images.length - draft.uploading);
  if (images.length > room) setNote(chatId, `At most ${MAX_IMAGES} images per request.`, true);
  const chips = () => {
    if (view?.chatId === chatId) renderChips();
  };
  const accepted = images.slice(0, room);
  draft.uploading += accepted.length;
  chips();
  for (const file of accepted) {
    try {
      draft.images.push(await uploadImage(file));
    } catch (error) {
      setNote(chatId, `Upload failed: ${error?.message ?? error}`, true);
    }
    draft.uploading -= 1;
    chips();
  }
}

function pickImages() {
  const chatId = view.chatId;
  const input = el("input", { type: "file", accept: "image/*", multiple: true });
  input.addEventListener("change", () => addImages(chatId, [...(input.files ?? [])]));
  input.click();
}

function hasFiles(event) {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

// --- Rendering ----------------------------------------------------------------

function refresh(chatId) {
  if (!view) return;
  renderRail();
  if (view.chatId !== chatId) return;
  renderTitle();
  renderConvo(true);
  renderChips();
  renderSend();
  renderNote();
}

function renderTitle() {
  const chat = currentChat();
  view.title.textContent = chat?.title || "New chat";
}

function modelButtonState() {
  const id = String(getSetting(SETTING_MODEL, ""));
  const model = findModel(id);
  if (model)
    return { text: model.name || model.id, price: modelPrice(model), title: modelLabel(model) };
  if (!lists.models.length && lists.error) {
    return { text: id || "Model list failed", title: lists.error, isError: true };
  }
  if (!lists.models.length && lists.loading) return { text: "Loading models…" };
  if (id) return { text: `${id}${NOT_LISTED}`, title: id };
  return { text: "Pick a model" };
}

/** The settings are a pop-over: while it is closed there is nothing to draw. */
function renderModelButton() {
  if (!view?.model) return;
  const state = modelButtonState();
  view.model.replaceChildren(
    el("span", { class: "wpw-option-name", text: state.text }),
    ...(state.price ? [el("span", { class: "wpw-option-price", text: state.price })] : []),
    icon("pi-chevron-down")
  );
  view.model.title = state.title ?? "";
  view.model.classList.toggle("is-error", !!state.isError);
}

function renderPrompts() {
  if (!view?.prompts) return;
  const current = String(getSetting(SETTING_SYSTEM_PROMPT, ""));
  const names = [...lists.prompts];
  if (current && !names.includes(current)) names.unshift(current);
  const options = names.map((name) => el("option", { value: name, text: name }));
  if (!options.length) {
    options.push(el("option", { value: "", text: "No system prompts" }));
  }
  view.prompts.replaceChildren(...options);
  view.prompts.value = current;
}

function renderRail() {
  if (view.railRenaming) return;
  const top = view.chats.scrollTop;
  view.chats.replaceChildren(...sortedChats(store).map(railRow));
  view.chats.scrollTop = top;
}

const MENU_W = 130;
const MENU_H = 76;

function openChatMenu(chat, anchor) {
  if (view.popover?.chatId === chat.id) {
    closePopover();
    return;
  }
  const item = (label, action, extra = "") =>
    button(
      label,
      () => {
        closePopover();
        action();
      },
      `wpw-menu-item${extra}`
    );
  const root = el(
    "div",
    { class: "wpw-pop wpw-chat-menu" },
    item("Rename", () => beginRailRename(chat)),
    item(
      "Delete",
      () => {
        view.confirmDelete = chat.id;
        renderRail();
      },
      " is-danger"
    )
  );
  const box = anchor.getBoundingClientRect();
  const below = box.bottom + 2 + MENU_H <= window.innerHeight;
  root.style.top = `${below ? box.bottom + 2 : box.top - 2 - MENU_H}px`;
  root.style.left = `${Math.max(4, box.right - MENU_W)}px`;
  openPopover(anchor, root);
  view.popover.chatId = chat.id;
}

/** The title in the list becomes a field. Enter or leaving it saves; Esc cancels. */
function beginRailRename(chat) {
  view.railRename = chat.id;
  view.renaming = { cancel: () => endRailRename(chat, false) };
  renderRail();
  view.railRenaming = true;
  const input = view.chats.querySelector(".wpw-rename-input");
  input?.focus();
  input?.select();
}

function endRailRename(chat, commit) {
  if (!view?.railRenaming) return;
  const value = view.chats.querySelector(".wpw-rename-input")?.value.trim() ?? "";
  view.railRenaming = false;
  view.railRename = null;
  view.renaming = null;
  if (commit && value && value !== chat.title) {
    renameChat(chat, value);
    save();
  }
  renderRail();
  if (chat.id === view.chatId) renderTitle();
}

function railRow(chat) {
  if (view.railRename === chat.id) {
    return el(
      "div",
      { class: "wpw-chat wpw-confirm" },
      el("input", {
        class: "wpw-rename-input",
        value: chat.title ?? "",
        maxLength: 120,
        onBlur: () => endRailRename(chat, true),
        onKeydown: (event) => {
          if (event.key === "Enter") endRailRename(chat, true);
        },
      })
    );
  }
  if (view.confirmDelete === chat.id) {
    return el(
      "div",
      { class: "wpw-chat wpw-confirm" },
      el("span", { text: `Delete "${chat.title}"?` }),
      button("Delete", () => removeChat(chat), "wpw-btn wpw-danger"),
      button("Keep", () => {
        view.confirmDelete = null;
        renderRail();
      })
    );
  }
  const job = jobs.get(chat.id);
  const failed = !!chat.failure;
  const count = chat.versions.length;
  let sub;
  if (job) {
    sub = el(
      "div",
      { class: "wpw-chat-sub is-writing" },
      el("span", { class: "wpw-spin" }),
      "Writing ",
      secondsEl(job.startedAt)
    );
  } else if (failed) {
    sub = el("div", { class: "wpw-chat-sub is-failed", text: "Failed" });
  } else if (chat.pending) {
    sub = el("div", { class: "wpw-chat-sub is-question", text: "Waiting for your answer" });
  } else {
    const when = timeAgo(chat.updated);
    sub = el(
      "div",
      { class: "wpw-chat-sub" },
      el("span", { text: `${count} version${count === 1 ? "" : "s"}` }),
      when && el("span", { text: when })
    );
  }
  return el(
    "div",
    { class: `wpw-chat${chat.id === view.chatId ? " is-open" : ""}` },
    el(
      "button",
      { type: "button", class: "wpw-chat-open", onClick: () => selectChat(chat.id) },
      el(
        "div",
        { class: "wpw-chat-title" },
        el("span", { text: chat.title, title: chat.title }),
        unseen.has(chat.id) &&
          el(
            "span",
            {
              class: "wpw-check",
              title: chat.pending ? "The AI has a question" : "Finished",
            },
            icon(chat.pending ? "pi-question-circle" : "pi-check")
          )
      ),
      sub
    ),
    (() => {
      const more = iconButton(
        "pi-ellipsis-v",
        () => openChatMenu(chat, more),
        "wpw-chat-more",
        "More"
      );
      return more;
    })()
  );
}

/**
 * What a step asked for: where it started, the request and its images, and the
 * questions on the way. `question` is one still waiting for its answer.
 */
function stepAsk(chat, step, { onRewind = null, question = null } = {}) {
  const said = (who, text, extra = "") =>
    el(
      "div",
      { class: `wpw-said${extra}` },
      el("span", { class: "wpw-who", text: who }),
      el("span", { class: "wpw-said-text", text })
    );
  const names = (step.images ?? []).filter((name) => typeof name === "string");
  const quote = step.basePrompt ?? (step.baseId === "seed" ? chat.seedPrompt : null);
  const turns = step.turns ?? step.questions ?? [];
  return el(
    "div",
    { class: "wpw-ask" },
    quote &&
      el(
        "details",
        { class: "wpw-quote" },
        el("summary", { text: "The current prompt it edited" }),
        el("div", { class: "wpw-quote-text", text: quote })
      ),
    said("You", step.request || "Optimise the prompt", step.request ? "" : " is-empty"),
    names.length > 0 &&
      el(
        "div",
        { class: "wpw-thumbs" },
        ...names.map((name) => el("img", { src: thumbUrl(name), alt: "", loading: "lazy" }))
      ),
    ...turns.flatMap((turn) => [
      said("AI", turn.question, " is-question"),
      said("You", turn.answer),
    ]),
    question && said("AI", question, " is-question"),
    onRewind && iconButton("pi-undo", onRewind, "wpw-rewind", REWIND_TITLE)
  );
}

/** What the model is doing, from what has come so far. */
function phaseOf(job) {
  if (job.text) return "Writing";
  if (job.thinking) return "Thinking";
  return "Waiting for the model";
}

function tokensText(job) {
  return job.tokens ? `≈ ${Number(job.tokens).toLocaleString("en-US")} tokens` : "";
}

/** What the model thought: open while it thinks, closed under a finished version. */
function thinkingBlock(text, open) {
  const body = el("div", { class: "wpw-thinking-text", text });
  const block = el(
    "details",
    { class: "wpw-thinking", open },
    el("summary", { text: "Thinking" }),
    body
  );
  return { block, body };
}

/** The card of a write in progress, with handles to fill as the pieces come. */
function liveCard(chat, job, label) {
  const phase = el("span", { text: phaseOf(job) });
  const tokens = el("span", { text: tokensText(job) });
  const status = el(
    "span",
    { class: "wpw-status" },
    el("span", { class: "wpw-spin" }),
    phase,
    secondsEl(job.startedAt),
    tokens
  );
  const thinking = thinkingBlock(job.thinking, !job.text);
  thinking.block.hidden = !job.thinking;
  const text = el("div", { class: "wpw-text is-live", text: job.text });
  text.hidden = !job.text;
  view.live = { chatId: chat.id, phase, tokens, thinking, text, closed: !!job.text };
  return el(
    "div",
    { class: "wpw-card is-writing" },
    cardHead(chat, label, job.baseId, status),
    stepAsk(chat, job),
    thinking.block,
    text
  );
}

let livePaint = null;

/** Pieces come fast; the card catches up a few times a second. */
function paintLiveSoon() {
  livePaint ??= setTimeout(() => {
    livePaint = null;
    paintLive();
  }, LIVE_MS);
}

function paintLive() {
  const live = view?.live;
  const job = live ? jobs.get(live.chatId) : null;
  if (!job || view.chatId !== live.chatId) return;
  const convo = view.convo;
  const following = convo.scrollHeight - convo.scrollTop - convo.clientHeight < 60;
  live.phase.textContent = phaseOf(job);
  live.tokens.textContent = tokensText(job);
  if (job.thinking) {
    live.thinking.block.hidden = false;
    live.thinking.body.textContent = job.thinking;
    live.thinking.body.scrollTop = live.thinking.body.scrollHeight;
  }
  if (job.text) {
    // Once the answer starts, the thinking steps aside; it can be opened again.
    if (!live.closed) {
      live.thinking.block.open = false;
      live.closed = true;
    }
    live.text.hidden = false;
    live.text.textContent = job.text;
  }
  if (following) convo.scrollTop = convo.scrollHeight;
}

/** A card's first line: its name, where it started, and how it stands. */
function cardHead(chat, label, baseId, status) {
  return el(
    "div",
    { class: "wpw-card-head" },
    el("span", { class: "wpw-ver", text: label }),
    el("span", { class: "wpw-from", text: startLabel(chat, baseId) }),
    el("span", { class: "wpw-spacer" }),
    status
  );
}

/** The chat's target, by its label: the graph may have changed since it was chosen. */
function refreshTargets() {
  view.targets = listTargets(app.rootGraph) ?? [];
  const label = currentChat()?.targetLabel;
  view.targetNode = resolveTarget(view.targets, label, view.promptNode)?.node ?? null;
  renderTargets();
}

function targetIndex() {
  return view.targets.findIndex((target) => target.node === view.targetNode);
}

/** The options are rebuilt only when they change, so a re-render cannot close an open list. */
function renderTargets() {
  const select = view.target;
  const labels = view.targets.length
    ? view.targets.map((target) => target.label)
    : ["No Prompt + LoRAs"];
  const key = labels.join("\n");
  if (select.dataset.labels !== key) {
    select.dataset.labels = key;
    select.replaceChildren(...labels.map((label) => el("option", { text: label })));
  }
  select.disabled = !view.targets.length;
  select.selectedIndex = Math.max(0, targetIndex());
}

function chooseTarget() {
  const chat = currentChat();
  const target = view.targets[view.target.selectedIndex];
  if (!chat || !target) return;
  chat.targetLabel = target.label;
  save();
  renderConvo(false);
  renderChips();
}

function labelOfNode(node) {
  return (listTargets(app.rootGraph) ?? []).find((target) => target.node === node)?.label ?? null;
}

function sendButton(version, primary) {
  const use = button(
    "Send to prompt",
    () => useVersion(version),
    primary ? "wpw-btn wpw-primary" : "wpw-btn",
    "Write this version into the prompt of the For node"
  );
  use.disabled = !view.targets.length;
  return use;
}

/** The LoRA boxes of the target that count: the list, and list 2 while it is on. */
function targetLoraWidgets() {
  const widgets = targetNow()?.node?.widgets ?? [];
  const named = (name) => widgets.find((w) => w.name === name);
  const list = [named(LORAS_WIDGET)];
  if (named("loras_2_on")?.value === true) list.push(named("loras_2"));
  return list.filter(Boolean);
}

/** A tag written in the prompt itself is on, but sits in a line of prose. */
function isInPromptText(tag) {
  const widgets = targetNow()?.node?.widgets ?? [];
  return isLoraListed(widgets.find((w) => w.name === TEXT_WIDGET)?.value, tag);
}

/** One LoRA under a version. `compact` is for one that was on when the version was written. */
function loraChip(chat, version, item, compact) {
  const listed = targetLoraWidgets().some((w) => isLoraListed(w.value, item.tag));
  const inText = !listed && isInPromptText(item.tag);
  const on = listed || inText;
  const where = targetNow()?.label ?? "the chosen node";
  const title = item.title || item.name || item.tag;
  const words = item.triggers.join(", ");
  const verb = compact ? (on ? "Switch off in" : "Switch on in") : on ? "Remove from" : "Add to";
  const toggle = iconButton(
    on ? "pi-check" : "pi-plus",
    () => toggleSuggestion(chat, version, item, { keepText: compact }),
    "wpw-lora-add",
    inText ? "Written in the prompt text" : `${verb} the LoRA list of ${where}`
  );
  toggle.disabled = inText;
  return el(
    "div",
    {
      class: `wpw-lora${on ? " is-added" : ""}${compact ? " is-compact" : ""}`,
      title: words ? `${title}\n${words}` : title,
    },
    item.thumbnail
      ? el("img", { class: "wpw-lora-thumb", src: item.thumbnail, alt: "", loading: "lazy" })
      : el("span", { class: "wpw-lora-thumb" }),
    el(
      "span",
      { class: "wpw-lora-body" },
      el(
        "span",
        { class: "wpw-lora-top" },
        el("span", { class: "wpw-lora-title", text: title }),
        el("span", { class: "wpw-lora-strength", text: item.strength.toFixed(2) })
      ),
      !compact && el("span", { class: "wpw-lora-reason", text: item.reason })
    ),
    toggle
  );
}

function loraRow(label, chips) {
  if (!chips.length) return null;
  return el(
    "div",
    { class: "wpw-suggest" },
    el("div", { class: "wpw-suggest-label", text: label }),
    el("div", { class: "wpw-suggest-row" }, ...chips)
  );
}

/** What was on when this version was written, then what the LLM would add. */
function loraRows(chat, version) {
  const chips = (items, compact) =>
    (items ?? []).map((item) => loraChip(chat, version, item, compact));
  return [
    loraRow("Active LoRAs", chips(version.activeLoras, true)),
    loraRow("Suggested LoRAs", chips(version.suggestions, false)),
  ];
}

/** A finished version's line: a dot, then what it cost, how long it took and its tokens. */
function statusEl(version, model) {
  const parts = statusParts({ cost: version.cost, seconds: version.seconds, usage: version.usage });
  return el(
    "span",
    { class: "wpw-status", title: model ? `Finished with ${model}` : "Finished" },
    el("span", { class: "wpw-dot" }),
    ...parts.map((text) => el("span", { text }))
  );
}

function versionCard(chat, version, index, busy) {
  const label = `v${version.n}`;
  const newest = index === chat.versions.length - 1;
  const title = version.model ? `${version.model} · ${version.systemPrompt ?? ""}` : undefined;
  const rewind = busy ? null : () => rewindTo(chat, version);
  if (newest) {
    const editor = el("textarea", {
      class: "wpw-editor",
      value: version.text,
      spellcheck: false,
      onInput: () => fitEditor(editor),
      onBlur: () => saveEdit(version, editor),
    });
    view.editors.push({ version, editor });
    return el(
      "div",
      { class: "wpw-card is-newest" },
      cardHead(chat, label, version.baseId, statusEl(version, title)),
      stepAsk(chat, version, { onRewind: rewind }),
      version.reasoning && thinkingBlock(version.reasoning, false).block,
      editor,
      ...loraRows(chat, version),
      el("div", { class: "wpw-actions is-block" }, sendButton(version, true))
    );
  }

  const open = view.expanded.has(version.id);
  const toggle = () => {
    if (open) view.expanded.delete(version.id);
    else view.expanded.add(version.id);
    renderConvo(false);
  };
  const stop = (event) => event.stopPropagation();
  const actions = el(
    "div",
    { class: `wpw-actions${open ? " is-block" : ""}`, onClick: stop },
    !open && rewind && iconButton("pi-undo", rewind, "wpw-rewind is-inline", REWIND_TITLE),
    iconButton(
      "pi-pencil",
      () => continueFrom(chat, version),
      "wpw-icon",
      "Edit this version next"
    ),
    sendButton(version, false)
  );
  const head = open
    ? cardHead(chat, label, version.baseId, statusEl(version, title))
    : el(
        "div",
        { class: "wpw-card-head" },
        el("span", { class: "wpw-ver", text: label }),
        el("span", { class: "wpw-preview", text: version.request || "Optimise the prompt" }),
        actions
      );
  head.classList.add("is-toggle");
  head.title = open ? "Collapse" : "Expand";
  head.addEventListener("click", toggle);
  return el(
    "div",
    { class: "wpw-card" },
    head,
    open && stepAsk(chat, version, { onRewind: rewind }),
    open && version.reasoning && thinkingBlock(version.reasoning, false).block,
    open && el("div", { class: "wpw-text", text: version.text }),
    ...(open ? loraRows(chat, version) : []),
    open && actions
  );
}

function renderConvo(stick) {
  flushEdits();
  const chat = currentChat();
  view.editors = [];
  view.live = null;
  if (!chat) {
    view.convo.replaceChildren();
    return;
  }
  refreshTargets();
  const job = jobs.get(chat.id);
  const failure = chat.failure;
  const items = chat.versions.map((version, index) => versionCard(chat, version, index, !!job));
  const next = `v${chat.versions.length + 1}`;
  if (job) {
    items.push(liveCard(chat, job, next));
  } else if (failure) {
    items.push(
      el(
        "div",
        { class: "wpw-card is-error" },
        cardHead(chat, next, failure.baseId, el("span", { class: "wpw-status", text: "Failed" })),
        stepAsk(chat, failure, { onRewind: () => rewindFailure(chat) }),
        el("div", { class: "wpw-error-text", text: failure.message }),
        el(
          "div",
          { class: "wpw-actions is-block" },
          labelledButton("pi-refresh", "Retry", () => launch(chat, retrySpec(chat, failure)))
        )
      )
    );
  } else if (chat.pending) {
    items.push(
      el(
        "div",
        { class: "wpw-card is-question" },
        cardHead(
          chat,
          "Question",
          chat.pending.baseId,
          el("span", { class: "wpw-status", text: "Waiting for your answer" })
        ),
        stepAsk(chat, chat.pending, {
          onRewind: () => rewindQuestion(chat),
          question: chat.pending.question,
        }),
        el("div", {
          class: "wpw-hint-line",
          text: "Answer in the box below. To take your request back instead, use the undo arrow beside it.",
        })
      )
    );
  }
  if (!items.length) {
    items.push(
      el("div", {
        class: "wpw-hint",
        text: "Describe the prompt you want. To change the prompt that is in the node, choose Edit current prompt below.",
      })
    );
  }

  const top = view.convo.scrollTop;
  view.convo.replaceChildren(...items);
  for (const { editor } of view.editors) fitEditor(editor);
  view.convo.scrollTop = stick ? view.convo.scrollHeight : top;
}

/** A Retry takes what the settings say now: the model may be why it failed. */
function withCurrentSettings(spec) {
  const model = String(getSetting(SETTING_MODEL, ""));
  const systemPrompt = String(getSetting(SETTING_SYSTEM_PROMPT, ""));
  return {
    ...spec,
    model,
    systemPrompt,
    payload: {
      ...spec.payload,
      base_url: baseUrl(),
      model,
      system_prompt: systemPrompt,
      temperature: clampTemperature(getSetting(SETTING_TEMPERATURE, DEFAULT_TEMPERATURE)),
    },
  };
}

function chip(className, children, onClear, clearTitle) {
  return el(
    "span",
    { class: `wpw-chip ${className}` },
    ...children,
    onClear &&
      el("button", {
        type: "button",
        class: "wpw-chip-x",
        text: "×",
        title: clearTitle,
        "aria-label": clearTitle,
        onClick: onClear,
      })
  );
}

/** The options are rebuilt only when they change, so a re-render cannot close an open list. */
function renderStart(chat, draft) {
  const options = startOptions(chat, targetNow()?.label);
  const key = options.map((option) => `${option.value}\t${option.label}`).join("\n");
  if (view.start.dataset.options !== key) {
    view.start.dataset.options = key;
    view.start.replaceChildren(
      ...options.map((option) => el("option", { value: option.value, text: option.label }))
    );
  }
  view.start.value = startValue(chat, draft.base);
  view.startIcon.className = `pi ${view.start.value === NEW_PROMPT ? "pi-sparkles" : "pi-pencil"}`;
}

function chooseStart() {
  const chat = currentChat();
  if (!chat) return;
  draftOf(chat.id).base = view.start.value;
  renderStart(chat, draftOf(chat.id));
}

function renderChips() {
  const chat = currentChat();
  if (!chat) {
    view.attached.replaceChildren();
    view.toolsLeft.replaceChildren();
    return;
  }
  const draft = draftOf(chat.id);
  // An answer goes with the request's own images and starting point.
  const answering = !!chat.pending;
  const images = answering
    ? []
    : draft.images.map((name) =>
        chip(
          "",
          [el("img", { src: thumbUrl(name), alt: "", title: name })],
          () => {
            draft.images = draft.images.filter((other) => other !== name);
            renderChips();
          },
          "Remove this image"
        )
      );
  const uploading = draft.uploading > 0 ? [chip("", ["Uploading…"])] : [];
  renderStart(chat, draft);
  view.attached.replaceChildren(...images, ...uploading);
  const answeringChip = chip("is-base", [icon("pi-question-circle"), "Answering the question"]);
  const tools = [
    !answering && view.attach,
    answering ? answeringChip : view.startChip,
    view.loraScope,
  ];
  view.toolsLeft.replaceChildren(...tools.filter(Boolean));
  renderLoraScope();
}

const LORA_SCOPE_TITLES = {
  off: "The LLM is told nothing about LoRAs.",
  list: "The LLM may suggest LoRAs switched off in this node's LoRA list.",
  all: "The LLM may suggest any of your LoRAs for this model.",
};

function drawLoraScope(counts) {
  const shown = loraScopeCounts(counts);
  const names = { off: "Off", list: "List", all: "All" };
  const scope = loraScope();
  for (const [key, control] of view.loraScopeButtons) {
    const count = key === "off" ? [] : [el("span", { class: "wpw-seg-count", text: shown[key] })];
    control.replaceChildren(names[key], ...count);
    control.title = LORA_SCOPE_TITLES[key];
    control.classList.toggle("is-on", key === scope);
  }
}

/** Asks anew each time: the counts follow the target and what is in its lists. */
async function renderLoraScope() {
  const run = ++loraRun;
  const [list, all] = await Promise.all([
    loraListsFor(view.targetNode, "list"),
    loraListsFor(view.targetNode, "all"),
  ]);
  if (view && run === loraRun) {
    drawLoraScope({ list: list?.available.length ?? 0, all: all?.available.length ?? 0 });
  }
}

function chooseLoraScope(scope) {
  setSetting(SETTING_LORA_SCOPE, scope);
  drawLoraScope(undefined);
  renderLoraScope();
}

function renderSend() {
  const job = jobs.get(view.chatId);
  const answering = !!currentChat()?.pending;
  view.send.classList.toggle("is-stop", !!job);
  view.sendIcon.className = `pi ${job ? "pi-stop" : "pi-arrow-up"}`;
  const label = job ? "Stop" : `${answering ? "Answer" : "Write"} (Ctrl+Enter)`;
  view.send.title = label;
  view.send.setAttribute("aria-label", label);
  view.input.placeholder = answering ? PLACEHOLDER_ANSWER : PLACEHOLDER_WRITE;
}

function renderNote() {
  const note = view.chatId ? draftOf(view.chatId).note : null;
  view.note.textContent = note?.text ?? "";
  view.note.classList.toggle("is-error", !!note?.isError);
}

function growInput() {
  const input = view.input;
  const least = INPUT_MIN_LINES * INPUT_LINE + INPUT_CHROME;
  const most = INPUT_MAX_LINES * INPUT_LINE + INPUT_CHROME;
  input.style.height = "auto";
  const wanted = input.scrollHeight + 2;
  input.style.height = `${Math.min(most, Math.max(least, wanted))}px`;
  input.style.overflowY = wanted > most ? "auto" : "hidden";
}

function fitEditor(editor) {
  editor.style.height = "auto";
  editor.style.height = `${Math.min(editor.scrollHeight + 2, window.innerHeight * 0.45)}px`;
}

function saveEdit(version, editor) {
  if (version.text === editor.value) return;
  version.text = editor.value;
  save();
}

function flushEdits() {
  for (const { version, editor } of view?.editors ?? []) saveEdit(version, editor);
}

// --- What the controls do ------------------------------------------------------

function selectChat(id) {
  flushEdits();
  view.chatId = id;
  view.confirmDelete = null;
  view.expanded.clear();
  if (unseen.has(id)) {
    const node = unseen.get(id);
    unseen.delete(id);
    syncButton(node);
  }
  view.input.value = draftOf(id).text;
  growInput();
  renderTitle();
  renderRail();
  renderConvo(true);
  renderChips();
  renderSend();
  renderNote();
}

/**
 * A chat with nothing in it is reused, so "New chat" cannot pile them up. One
 * that holds a draft or a seed is only reused for its own target: those were
 * written for that node.
 */
function reusableChat(label) {
  const empty = sortedChats(store).filter(
    (chat) => !chat.versions.length && !chat.pending && !jobs.has(chat.id) && !chat.failure
  );
  const untouched = (chat) => {
    const draft = drafts.get(chat.id);
    return !chat.seedPrompt && !draft?.text && !draft?.images.length && !draft?.uploading;
  };
  return empty.find((chat) => chat.targetLabel === label) ?? empty.find(untouched) ?? null;
}

function newChat() {
  const label = labelOfNode(view.promptNode);
  const chat =
    reusableChat(label) ??
    createChat(store, { id: uid(), now: Date.now(), seedPrompt: null, targetLabel: label });
  chat.targetLabel = label;
  save();
  selectChat(chat.id);
  view.input.focus();
}

function removeChat(chat) {
  const job = jobs.get(chat.id);
  if (job) {
    job.dropped = true;
    job.controller.abort();
  }
  const node = unseen.get(chat.id);
  unseen.delete(chat.id);
  drafts.delete(chat.id);
  syncButton(node);
  deleteChat(store, chat.id);
  save();
  view.confirmDelete = null;
  if (view.chatId !== chat.id) {
    renderRail();
    return;
  }
  view.editors = [];
  const next = sortedChats(store)[0];
  if (next) selectChat(next.id);
  else newChat();
}

function continueFrom(chat, version) {
  draftOf(chat.id).base = version.id;
  renderChips();
  view.input.focus();
}

function targetNow() {
  return view.targets[targetIndex()] ?? null;
}

function useVersion(version) {
  flushEdits();
  const target = targetNow();
  const widget = target?.node?.widgets?.find((w) => w.name === TEXT_WIDGET);
  if (!widget) {
    setNote(view.chatId, "That node has no text box to write into.", true);
    return;
  }
  if (!version.text.trim()) {
    setNote(view.chatId, "This version is empty.", true);
    return;
  }
  widget.value = version.text;
  widget.callback?.(version.text);
  flash(target.node);
  redraw();
  checkpoint();
  toast("success", "Prompt used", target.label);
  closeView();
}

/** The textarea showing a widget, if one is on screen. Nodes 2.0 gives the widget no handle. */
function textareaOf(node, widget) {
  const own = widget.inputEl ?? widget.element;
  if (own?.tagName === "TEXTAREA" && own.isConnected) return own;
  const root = document.querySelector(`[data-node-id="${node.id}"]`);
  const shown = (node.widgets ?? []).filter((w) => BOX_WIDGETS.includes(w.name) && !w._wpeHidden);
  return root?.querySelectorAll("textarea")[shown.indexOf(widget)] ?? null;
}

/** The node colours its tags on `input`, which setting a widget's value does not fire. */
function writeLoraList(node, widget, value) {
  widget.value = value;
  widget.callback?.(value);
  const area = textareaOf(node, widget);
  if (!area) return;
  // A framework's listener reads the box back, so the box has to hold the new text first.
  area.value = value;
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The open editor is written too, or re-rendering would save its old text back. */
function setVersionText(version, text) {
  version.text = text;
  const open = view.editors.find((item) => item.version === version);
  if (open) open.editor.value = text;
}

/**
 * The only way a suggestion reaches a list: pressing its + adds it, pressing again
 * removes it. `keepText` leaves the version alone: a LoRA that was on when it was
 * written has its trigger words in there already, where the LLM put them.
 */
function toggleSuggestion(chat, version, suggestion, { keepText = false } = {}) {
  flushEdits();
  refreshTargets();
  const target = targetNow();
  const widgets = targetLoraWidgets();
  if (!widgets.length) {
    setNote(chat.id, "That node has no LoRA list to add to.", true);
    return;
  }
  const { tag, strength, triggers } = suggestion;
  const holder = widgets.find((w) => isLoraListed(w.value, tag));
  if (holder) {
    // Text this added goes away again; a line that was already there is only switched off.
    const value = String(holder.value ?? "");
    const next =
      suggestion.addedHow === "appended" ? removeLoraTag(value, tag) : disableLoraTag(value, tag);
    writeLoraList(target.node, holder, next);
    delete suggestion.addedHow;
  } else {
    const off = widgets
      .map((w) => ({ w, next: enableLoraTag(w.value, tag) }))
      .find((item) => item.next !== null);
    if (off) {
      writeLoraList(target.node, off.w, off.next);
      suggestion.addedHow = "enabled";
    } else {
      writeLoraList(target.node, widgets[0], appendLoraTag(widgets[0].value, tag, strength));
      suggestion.addedHow = "appended";
    }
  }
  if (!keepText) {
    const text = (holder ? removeTriggerLine : addTriggerLine)(version.text, triggers);
    if (text !== version.text) setVersionText(version, text);
  }
  save();
  redraw();
  checkpoint();
  renderConvo(false);
  renderChips();
}

function beginRename() {
  const chat = currentChat();
  if (!chat || view.renaming) return;
  let done = false;
  const finish = (commit) => {
    if (done || !view) return;
    done = true;
    view.renaming = null;
    input.replaceWith(view.title);
    const title = input.value.trim();
    if (commit && title && title !== chat.title) {
      renameChat(chat, title);
      save();
      renderRail();
    }
    renderTitle();
  };
  const input = el("input", {
    class: "wpw-title-input",
    value: chat.title ?? "",
    maxLength: 120,
    onBlur: () => finish(true),
    onKeydown: (event) => {
      if (event.key === "Enter") finish(true);
    },
  });
  view.renaming = { cancel: () => finish(false) };
  view.title.replaceWith(input);
  input.focus();
  input.select();
}

function closePopover() {
  if (!view?.popover) return;
  view.popover.root.remove();
  view.popover = null;
  view.model = view.prompts = null;
}

function openPopover(anchor, root) {
  closePopover();
  view.popover = { anchor, root };
  view.modal.append(root);
}

let peekRun = 0;

/** Show the selected system prompt, read-only, under its field in the settings. */
async function showPeek(panel) {
  panel.peek?.remove();
  const name = view.prompts?.value ?? "";
  const text = el("div", { class: "wpw-peek-text", text: "Loading…" });
  panel.peek = text;
  panel.promptRow.after(text);
  const run = ++peekRun;
  let out;
  try {
    out = await getJson(`/warppipe/llm/system_prompt?name=${encodeURIComponent(name)}`);
  } catch (error) {
    out = { error: String(error?.message ?? error) };
  }
  if (run !== peekRun) return;
  text.textContent = out?.error ?? out?.text ?? "";
}

function togglePeek(panel) {
  if (!panel.peek) {
    showPeek(panel);
    return;
  }
  panel.peek.remove();
  panel.peek = null;
}

/** The model list opens under the model field: type to filter, Enter takes the first. */
function toggleModels(panel) {
  if (panel.models) {
    panel.models.remove();
    panel.models = null;
    return;
  }
  const options = el("div", { class: "wpw-options" });
  const current = String(getSetting(SETTING_MODEL, ""));
  const matches = () => {
    const terms = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return lists.models.filter((model) => {
      const hay = `${modelLabel(model)} ${model.id}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  };
  const choose = (model) => {
    setSetting(SETTING_MODEL, model.id);
    toggleModels(panel);
    renderModelButton();
    view.model?.focus();
  };
  const draw = () => {
    const rows = matches().map((model) =>
      el(
        "button",
        {
          type: "button",
          class: `wpw-option${model.id === current ? " is-current" : ""}`,
          title: model.id,
          onClick: () => choose(model),
        },
        el("span", { class: "wpw-option-name", text: model.name || model.id }),
        el("span", { class: "wpw-option-price", text: modelPrice(model) }),
        model.vision && icon("pi-eye")
      )
    );
    if (rows.length) options.replaceChildren(...rows);
    else options.replaceChildren(el("div", { class: "wpw-none", text: "No model matches." }));
  };
  const filter = el("input", {
    class: "wpw-field wpw-filter",
    type: "search",
    placeholder: `Filter ${lists.models.length} models`,
    onInput: draw,
    onKeydown: (event) => {
      if (event.key !== "Enter") return;
      const first = matches()[0];
      if (first) choose(first);
    },
  });
  panel.models = el("div", { class: "wpw-models" }, filter, options);
  panel.modelRow.after(panel.models);
  draw();
  filter.focus();
  options.querySelector(".is-current")?.scrollIntoView({ block: "center" });
}

async function refreshKeyState(state) {
  const out = await getJson(
    `/warppipe/llm/key_status?base_url=${encodeURIComponent(baseUrl())}`
  ).catch((error) => ({ error: String(error?.message ?? error) }));
  if (out?.error) {
    state.textContent = out.error;
    state.className = "wpw-key-state";
    return;
  }
  state.textContent = out.set ? "Key set" : "No key set";
  state.title = out.set && out.source ? `From ${out.source}` : "";
  state.className = `wpw-key-state${out.set ? " is-set" : ""}`;
}

/** One row of the settings: a name, and what sets it. */
function settingRow(name, ...controls) {
  return el(
    "div",
    { class: "wpw-set" },
    el("span", { class: "wpw-set-name", text: name }),
    el("div", { class: "wpw-set-control" }, ...controls)
  );
}

/** Everything that is set once and then left alone: the model, the system prompt, the server. */
function toggleGear() {
  if (view.popover?.anchor === view.gear) {
    closePopover();
    return;
  }
  const panel = { models: null, peek: null };
  const state = el("div", { class: "wpw-key-state" });
  const model = el("button", {
    type: "button",
    class: "wpw-field wpw-combo",
    onClick: () => toggleModels(panel),
  });
  const prompts = el("select", {
    class: "wpw-field wpw-prompts",
    onChange: () => {
      setSetting(SETTING_SYSTEM_PROMPT, prompts.value);
      if (panel.peek) showPeek(panel);
    },
  });
  const eye = iconButton("pi-eye", () => togglePeek(panel), "wpw-icon", "Read this system prompt");
  const url = el("input", {
    class: "wpw-field",
    type: "text",
    spellcheck: false,
    value: baseUrl(),
    onChange: () => {
      const value = url.value.trim() || DEFAULT_BASE_URL;
      url.value = value;
      setSetting(SETTING_BASE_URL, value);
      // Another server's models, prices and vision marks do not apply here.
      lists.models = [];
      refreshKeyState(state);
      loadLists(false);
    },
  });
  const temperature = el("input", {
    class: "wpw-field",
    type: "number",
    min: 0,
    max: 2,
    step: 0.05,
    value: clampTemperature(getSetting(SETTING_TEMPERATURE, DEFAULT_TEMPERATURE)),
    onChange: () => {
      const value = clampTemperature(temperature.value);
      temperature.value = value;
      setSetting(SETTING_TEMPERATURE, value);
    },
  });
  const titleModel = el("input", {
    class: "wpw-field",
    type: "text",
    value: String(getSetting(SETTING_TITLE_MODEL, DEFAULT_TITLE_MODEL)),
    title: "Model id that names new chats. Empty keeps the first words of your message.",
    onChange: () => setSetting(SETTING_TITLE_MODEL, titleModel.value.trim()),
  });
  const key = el("input", {
    class: "wpw-field",
    type: "password",
    autocomplete: "off",
    placeholder: "Paste a key to save it",
  });
  const saveKey = async () => {
    const typed = key.value;
    key.value = "";
    if (!typed.trim()) {
      state.textContent = "Type the API key first";
      state.className = "wpw-key-state";
      return;
    }
    const out = await postJson("/warppipe/llm/key", { base_url: baseUrl(), key: typed }).catch(
      (error) => ({ error: String(error?.message ?? error) })
    );
    if (out?.error) {
      state.textContent = out.error;
      state.className = "wpw-key-state";
      return;
    }
    refreshKeyState(state);
  };
  key.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveKey();
  });
  panel.modelRow = settingRow("Model", model);
  panel.promptRow = settingRow("System prompt", prompts, eye);
  const server = el(
    "div",
    { class: "wpw-set-group" },
    settingRow("Server", url),
    el("div", { style: "height: 10px" }),
    settingRow("API key", key, button("Save", saveKey)),
    el("div", { style: "height: 6px" }),
    settingRow(
      "",
      state,
      el("span", { class: "wpw-spacer" }),
      button("Refresh lists", () => {
        refreshKeyState(state);
        loadLists(true);
      })
    )
  );
  const root = el(
    "div",
    { class: "wpw-pop wpw-settings" },
    el("div", { class: "wpw-settings-title", text: "Settings" }),
    panel.modelRow,
    panel.promptRow,
    settingRow("Temperature", temperature),
    settingRow("Title model", titleModel),
    server
  );
  openPopover(view.gear, root);
  view.model = model;
  view.prompts = prompts;
  renderModelButton();
  renderPrompts();
  refreshKeyState(state);
}

async function loadLists(refreshModels) {
  const run = ++listsRun;
  lists.loading = true;
  lists.error = "";
  if (view) renderModelButton();
  const query = `base_url=${encodeURIComponent(baseUrl())}${refreshModels ? "&refresh=1" : ""}`;
  let models;
  let prompts;
  try {
    [models, prompts] = await Promise.all([
      getJson(`/warppipe/llm/models?${query}`),
      getJson("/warppipe/llm/system_prompts"),
    ]);
  } catch (error) {
    models = { error: `Model list unreachable: ${error?.message ?? error}` };
    prompts = { error: "" };
  }
  if (run !== listsRun) return;

  const errors = [];
  if (models?.error) errors.push(models.error);
  else lists.models = Array.isArray(models?.models) ? models.models : [];
  if (prompts?.error) errors.push(prompts.error);
  else if (Array.isArray(prompts?.names)) lists.prompts = prompts.names;
  lists.loading = false;
  lists.error = errors.join(" · ");

  if (!getSetting(SETTING_SYSTEM_PROMPT, "") && lists.prompts.length) {
    setSetting(SETTING_SYSTEM_PROMPT, lists.prompts[0]);
  }
  if (!view) return;
  renderModelButton();
  renderPrompts();
  if (lists.error && view.chatId) setNote(view.chatId, lists.error, true);
}

// --- The pop-up ---------------------------------------------------------------

function closeView() {
  if (!view) return;
  flushEdits();
  view.renaming?.cancel();
  window.removeEventListener("keydown", view.onWindowKey, true);
  window.removeEventListener("keyup", view.onWindowKey, true);
  window.removeEventListener("paste", view.onWindowPaste, true);
  view.backdrop.remove();
  view = null;
}

function dismiss() {
  if (view.popover) closePopover();
  else if (view.renaming) view.renaming.cancel();
  else closeView();
}

function buildView(promptNode) {
  const stop = (event) => event.stopPropagation();
  const title = button("New chat", beginRename, "wpw-title", "Click to rename");
  const target = el("select", {
    class: "wpw-target",
    title: "The Prompt + LoRAs this chat writes for",
    onChange: chooseTarget,
  });
  const gear = iconButton(
    "pi-cog",
    toggleGear,
    "wpw-icon",
    "Settings: model, system prompt, server"
  );
  const chatHead = el(
    "div",
    { class: "wpw-chat-head" },
    title,
    el("span", { class: "wpw-spacer" }),
    el("label", { class: "wpw-for" }, "For", target),
    iconButton("pi-times", closeView, "wpw-icon", "Close (Esc)")
  );

  const chats = el("div", { class: "wpw-chats" });
  const rail = el(
    "div",
    { class: "wpw-rail" },
    el(
      "div",
      { class: "wpw-rail-head" },
      el("span", { class: "wpw-brand" }, icon("pi-sparkles"), "Prompt Writer"),
      gear
    ),
    labelledButton("pi-plus", "New chat", () => newChat(), "wpw-btn wpw-new"),
    chats
  );

  const convo = el("div", { class: "wpw-convo" });
  const attached = el("div", { class: "wpw-attached" });
  const toolsLeft = el("div", { class: "wpw-tools-left" });
  const attach = iconButton("pi-image", pickImages, "wpw-tool", ATTACH_TITLE);
  const start = el("select", {
    class: "wpw-start",
    title: "What the next Write does: edit a version or the current prompt, or write a new prompt",
    onChange: () => chooseStart(),
  });
  const startIcon = icon("pi-pencil");
  const startChip = el("label", { class: "wpw-chip is-base wpw-start-chip" }, startIcon, start);
  const loraScopeButtons = new Map(
    LORA_SCOPES.map((scope) => [scope, button("", () => chooseLoraScope(scope), "wpw-seg-btn")])
  );
  const loraScopeEl = el(
    "span",
    { class: "wpw-seg" },
    el("span", { class: "wpw-seg-label", text: "LoRAs" }),
    ...loraScopeButtons.values()
  );
  const note = el("div", { class: "wpw-note" });
  const input = el("textarea", {
    class: "wpw-input",
    rows: INPUT_MIN_LINES,
    placeholder: PLACEHOLDER_WRITE,
    onInput: () => {
      draftOf(view.chatId).text = input.value;
      growInput();
    },
    onKeydown: (event) => {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const chat = currentChat();
      if (chat) startWrite(chat);
    },
  });
  const sendIcon = icon("pi-arrow-up");
  const send = el(
    "button",
    {
      type: "button",
      class: "wpw-btn wpw-primary wpw-send",
      title: "Write (Ctrl+Enter)",
      "aria-label": "Write (Ctrl+Enter)",
      onClick: () => {
        const chat = currentChat();
        if (!chat) return;
        const job = jobs.get(chat.id);
        if (job) job.controller.abort();
        else startWrite(chat);
      },
    },
    sendIcon
  );
  const composer = el(
    "div",
    { class: "wpw-composer" },
    el(
      "div",
      { class: "wpw-box" },
      attached,
      input,
      el("div", { class: "wpw-tools" }, toolsLeft, send)
    ),
    note
  );
  const main = el("div", { class: "wpw-main" }, chatHead, convo, composer);

  const modal = el(
    "div",
    {
      class: "wpw-modal",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Prompt Writer",
      tabIndex: -1,
    },
    rail,
    main
  );
  const backdrop = el("div", { class: "wpw-backdrop" }, modal);

  // Bubbling out of the pop-up would reach ComfyUI's hotkeys and the canvas.
  for (const type of ["keydown", "keyup", "wheel", "copy", "cut"]) {
    backdrop.addEventListener(type, stop);
  }
  modal.addEventListener("pointerdown", (event) => {
    const pop = view?.popover;
    if (pop && !pop.root.contains(event.target) && !pop.anchor.contains(event.target)) {
      closePopover();
    }
  });

  // ComfyUI loads a dropped file as a workflow. Text dragged between fields is left alone.
  const dragOver = (event) => {
    event.stopPropagation();
    if (!hasFiles(event)) return;
    event.preventDefault();
    composer.classList.add("is-drag");
  };
  backdrop.addEventListener("dragenter", dragOver);
  backdrop.addEventListener("dragover", dragOver);
  backdrop.addEventListener("dragleave", (event) => {
    event.stopPropagation();
    if (!backdrop.contains(event.relatedTarget)) composer.classList.remove("is-drag");
  });
  backdrop.addEventListener("drop", (event) => {
    event.stopPropagation();
    composer.classList.remove("is-drag");
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (view?.chatId) addImages(view.chatId, [...event.dataTransfer.files]);
  });

  // On the window, so these work with the focus anywhere: outside the pop-up
  // nothing in it would see them, and ComfyUI would act on them instead.
  const onWindowKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "keydown") dismiss();
      return;
    }
    if (!backdrop.contains(event.target)) event.stopPropagation();
  };
  const onWindowPaste = (event) => {
    // Stopped, not prevented: pasted text still lands in the focused field.
    event.stopPropagation();
    const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
      file.type.startsWith("image/")
    );
    if (!files.length || !view?.chatId) return;
    event.preventDefault();
    addImages(view.chatId, files);
  };
  window.addEventListener("keydown", onWindowKey, true);
  window.addEventListener("keyup", onWindowKey, true);
  window.addEventListener("paste", onWindowPaste, true);

  view = {
    backdrop,
    modal,
    title,
    target,
    model: null,
    prompts: null,
    gear,
    chats,
    convo,
    attached,
    toolsLeft,
    attach,
    loraScope: loraScopeEl,
    start,
    startIcon,
    startChip,
    loraScopeButtons,
    note,
    input,
    send,
    sendIcon,
    onWindowKey,
    onWindowPaste,
    promptNode,
    targetNode: promptNode,
    targets: [],
    chatId: null,
    editors: [],
    expanded: new Set(),
    popover: null,
    renaming: null,
    confirmDelete: null,
  };
  document.body.appendChild(backdrop);
  drawLoraScope(undefined);
  renderModelButton();
  renderPrompts();
  growInput();
  input.focus();
}

/** The chat to show: one this node is waiting on, else its most recent, else null for a new one. */
function initialChat(promptNode) {
  const finished = [...unseen].find(([, node]) => node === promptNode)?.[0];
  const writing = [...jobs.values()].find((job) => job.originNode === promptNode)?.chatId;
  return finished ?? writing ?? latestChatFor(store, labelOfNode(promptNode))?.id ?? null;
}

function showChatOf(promptNode) {
  const id = initialChat(promptNode);
  if (id) selectChat(id);
  else newChat();
}

function showLoadFailure(promptNode, error) {
  view.convo.replaceChildren(
    el("div", {
      class: "wpw-hint is-error",
      text: `Could not read the saved chats (${CHATS_FILE} in the ComfyUI user folder): ${error?.message ?? error}`,
    }),
    el(
      "div",
      { class: "wpw-actions" },
      button("Try again", () => {
        closeView();
        openPromptWriter(promptNode);
      })
    )
  );
}

export async function openPromptWriter(promptNode) {
  ensureStyle();
  if (view) {
    view.promptNode = promptNode;
    if (store) showChatOf(promptNode);
    return;
  }
  buildView(promptNode);
  try {
    await ensureStore();
  } catch (error) {
    console.error("[WarpPipe] reading chats", error);
    if (view) showLoadFailure(promptNode, error);
    return;
  }
  if (!view) return;
  showChatOf(view.promptNode);
  growInput();
  loadLists(false);
}

app.registerExtension({
  name: "WarpPipe.PromptWriter",
  settings: [
    {
      id: SETTING_DIR,
      name: "System prompt folder",
      type: "text",
      defaultValue: "",
      category: ["WarpPipe", "Prompt Writer", "System prompt folder"],
      tooltip:
        "Folder of system prompts for 🌀 Prompt Writer. Only .txt files directly in this folder are listed.",
    },
    {
      id: SETTING_BASE_URL,
      name: "Prompt Writer base URL",
      type: "hidden",
      defaultValue: DEFAULT_BASE_URL,
    },
    { id: SETTING_MODEL, name: "Prompt Writer model", type: "hidden", defaultValue: "" },
    {
      id: SETTING_TITLE_MODEL,
      name: "Prompt Writer title model",
      type: "hidden",
      defaultValue: DEFAULT_TITLE_MODEL,
    },
    {
      id: SETTING_SYSTEM_PROMPT,
      name: "Prompt Writer system prompt",
      type: "hidden",
      defaultValue: "",
    },
    {
      id: SETTING_TEMPERATURE,
      name: "Prompt Writer temperature",
      type: "hidden",
      defaultValue: DEFAULT_TEMPERATURE,
    },
    {
      id: SETTING_LORA_SCOPE,
      name: "Prompt Writer LoRA suggestions",
      type: "hidden",
      defaultValue: "all",
    },
  ],
});
