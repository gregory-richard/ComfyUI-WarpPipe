// 🌀 Prompt Writer: a chat-style pop-up, opened from the Write button on each
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
import { formatStatus, listTargets, modelLabel } from "./prompt_writer_core.js";
import {
  CHATS_FILE,
  addVersion,
  baseText,
  createChat,
  deleteChat,
  emptyStore,
  normalizeStore,
  renameChat,
  rewindChat,
  setAutoTitle,
  sortedChats,
} from "./prompt_chats.js";

const SETTING_DIR = "WarpPipe.PromptWriter.SystemPromptDir";
const SETTING_BASE_URL = "WarpPipe.PromptWriter.BaseUrl";
const SETTING_MODEL = "WarpPipe.PromptWriter.Model";
const SETTING_SYSTEM_PROMPT = "WarpPipe.PromptWriter.SystemPrompt";
const SETTING_TEMPERATURE = "WarpPipe.PromptWriter.Temperature";
const SETTING_TITLE_MODEL = "WarpPipe.PromptWriter.TitleModel";
const DEFAULT_TITLE_MODEL = "gemma-4-26b-a4b-it-chimeraxheretic";

const DEFAULT_BASE_URL = "https://nano-gpt.com/api/v1";
const DEFAULT_TEMPERATURE = 0.6;
const TEXT_WIDGET = "text";
const NOT_LISTED = " (not listed)";
const MAX_IMAGES = 8;
const FLASH_MS = 600;
const TICK_MS = 1000;
const TOAST_MS = 4000;

// The composer's height, in lines of its CSS line-height plus padding and border.
const INPUT_LINE = 19;
const INPUT_CHROME = 18;
const INPUT_MIN_LINES = 3;
const INPUT_MAX_LINES = 10;

// A draft's base: null follows the newest version, this one starts without any.
const NO_BASE = "none";

const STYLE = `
.wpw-open {
  position: absolute; top: 4px; right: 14px; z-index: 4;
  height: 18px; padding: 0 7px; font: 11px/16px sans-serif; cursor: pointer;
  color: var(--input-text, #dcdcdc); background: rgba(20, 22, 24, 0.78);
  border: 1px solid var(--border-color, #3a3a3a); border-radius: 4px; opacity: 0.72;
}
.wpw-open:hover { opacity: 1; border-color: #4ec8e8; color: #4ec8e8; }
.wpw-open.is-writing { opacity: 1; color: #1a1a1a; background: #e8c44e; border-color: #e8c44e; }
.wpw-open.has-unseen { opacity: 1; }
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
  --wpw-warp: #4ec8e8;
  --wpw-yellow: #e8c44e;
  --wpw-green: #5fd38a;
  --wpw-red: #f07070;
  --wpw-ground: var(--comfy-menu-bg, #202020);
  --wpw-panel: var(--comfy-input-bg, #171717);
  --wpw-ink: var(--input-text, #dcdcdc);
  --wpw-rule: var(--border-color, #3a3a3a);

  width: min(1280px, 94vw); height: 88vh;
  display: grid; grid-template-columns: 250px minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas: "head head" "rail main";
  background: var(--wpw-ground); color: var(--wpw-ink); color-scheme: dark;
  border: 1px solid var(--wpw-rule); border-radius: 6px; outline: none;
  overflow: hidden; box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
  font: 13px/1.45 sans-serif;
}
.wpw-modal button, .wpw-modal input, .wpw-modal select, .wpw-modal textarea { font: inherit; color: inherit; }
.wpw-modal :focus-visible { outline: 2px solid var(--wpw-warp); outline-offset: 1px; }

.wpw-head {
  grid-area: head; position: relative; display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-bottom: 1px solid var(--wpw-rule);
}
.wpw-title, .wpw-title-input { flex: 1 1 200px; min-width: 0; font-size: 14px; font-weight: 600; }
.wpw-title {
  background: none; border: 1px solid transparent; border-radius: 4px; padding: 4px 6px;
  cursor: text; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wpw-title:hover { border-color: var(--wpw-rule); }
.wpw-title-input { background: var(--wpw-panel); border: 1px solid var(--wpw-warp); border-radius: 4px; padding: 4px 6px; }
.wpw-field {
  height: 30px; box-sizing: border-box; background: var(--wpw-panel);
  border: 1px solid var(--wpw-rule); border-radius: 4px; padding: 0 8px;
}
.wpw-combo {
  flex: 1 1 320px; min-width: 0; cursor: pointer; text-align: left;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wpw-combo.is-error { color: var(--wpw-red); }
.wpw-combo:hover, .wpw-prompts:hover { border-color: var(--wpw-warp); }
.wpw-prompts { flex: 0 1 220px; min-width: 0; cursor: pointer; }
.wpw-icon {
  flex: none; width: 30px; height: 30px; background: none; cursor: pointer; font-size: 15px;
  border: 1px solid var(--wpw-rule); border-radius: 4px;
}
.wpw-icon:hover { border-color: var(--wpw-warp); color: var(--wpw-warp); }

.wpw-pop {
  position: absolute; top: calc(100% - 4px); z-index: 5; box-sizing: border-box;
  background: var(--wpw-ground); border: 1px solid var(--wpw-rule); border-radius: 5px;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.5); padding: 8px;
}
.wpw-models { width: 520px; max-width: 80vw; display: flex; flex-direction: column; gap: 6px; }
.wpw-filter { width: 100%; }
.wpw-options { max-height: 52vh; overflow-y: auto; }
.wpw-option {
  display: block; width: 100%; padding: 4px 8px; background: none; border: 0; border-radius: 3px;
  text-align: left; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wpw-option:hover { background: rgba(78, 200, 232, 0.14); }
.wpw-option.is-current { color: var(--wpw-warp); }
.wpw-none { padding: 8px; opacity: 0.65; }

.wpw-gear { right: 14px; width: 320px; display: flex; flex-direction: column; gap: 8px; }
.wpw-gear label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.wpw-gear .wpw-field { width: 100%; }
.wpw-key-row { display: flex; gap: 6px; }
.wpw-key-row .wpw-field { flex: 1; min-width: 0; }
.wpw-key-state { font-size: 12px; opacity: 0.75; }
.wpw-key-state.is-set { color: var(--wpw-green); opacity: 1; }

.wpw-btn {
  height: 28px; padding: 0 10px; background: none; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--wpw-rule); border-radius: 4px;
}
.wpw-btn:hover { border-color: var(--wpw-warp); color: var(--wpw-warp); }
.wpw-btn:disabled { opacity: 0.45; cursor: default; }
.wpw-primary { background: var(--wpw-warp); border-color: var(--wpw-warp); color: #10181c !important; font-weight: 600; }
.wpw-primary:hover { filter: brightness(1.12); }

.wpw-rail {
  grid-area: rail; display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--wpw-rule); background: var(--wpw-panel);
}
.wpw-new { margin: 10px; flex: none; }
.wpw-chats { flex: 1; min-height: 0; overflow-y: auto; padding: 0 6px 8px; }
.wpw-chat { position: relative; border-radius: 4px; }
.wpw-chat:hover { background: rgba(255, 255, 255, 0.05); }
.wpw-chat.is-open { box-shadow: inset 2px 0 0 var(--wpw-warp); background: rgba(78, 200, 232, 0.09); }
.wpw-chat-open {
  display: block; width: 100%; padding: 6px 28px 6px 10px; background: none; border: 0;
  text-align: left; cursor: pointer;
}
.wpw-chat-title { display: flex; align-items: baseline; gap: 6px; font-weight: 600; }
.wpw-chat-title span:first-child { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wpw-check { color: var(--wpw-green); }
.wpw-chat-sub { font-size: 11px; opacity: 0.68; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wpw-chat-sub.is-writing { color: var(--wpw-yellow); opacity: 1; }
.wpw-chat-sub.is-failed { color: var(--wpw-red); opacity: 1; }
.wpw-chat-del {
  position: absolute; top: 6px; right: 5px; width: 20px; height: 20px; padding: 0; cursor: pointer;
  background: none; border: 0; border-radius: 3px; font-size: 14px; line-height: 18px; opacity: 0;
}
.wpw-chat:hover .wpw-chat-del, .wpw-chat-del:focus-visible { opacity: 0.75; }
.wpw-chat-del:hover { opacity: 1; color: var(--wpw-red); }
.wpw-confirm { padding: 6px 10px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.wpw-confirm span { flex: 1 1 100%; font-size: 12px; }
.wpw-danger { border-color: var(--wpw-red); color: var(--wpw-red); }

.wpw-spin {
  display: inline-block; width: 9px; height: 9px; margin-right: 5px; vertical-align: -1px;
  border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
  animation: wpw-turn 0.8s linear infinite;
}
@keyframes wpw-turn { to { transform: rotate(360deg); } }

.wpw-main { grid-area: main; display: flex; flex-direction: column; min-height: 0; }
.wpw-convo { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.wpw-hint { margin: auto; max-width: 420px; text-align: center; opacity: 0.65; }
.wpw-hint.is-error { color: var(--wpw-red); opacity: 1; }
.wpw-seed {
  padding: 6px 10px; border: 1px dashed var(--wpw-rule); border-radius: 5px; font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.8;
}
.wpw-request {
  align-self: flex-end; max-width: 76%; padding: 7px 11px; border-radius: 10px 10px 2px 10px;
  background: rgba(78, 200, 232, 0.16); white-space: pre-wrap; overflow-wrap: anywhere;
  position: relative;
}
.wpw-request.has-rewind { padding-right: 34px; }
.wpw-rewind {
  position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 5px; background: transparent; color: inherit;
  font-size: 15px; line-height: 1; cursor: pointer; opacity: 0; pointer-events: none;
}
.wpw-request:hover .wpw-rewind, .wpw-rewind:focus-visible { opacity: 1; pointer-events: auto; }
.wpw-rewind:hover { background: rgba(78, 200, 232, 0.3); }
.wpw-request.is-empty { font-style: italic; opacity: 0.8; }
.wpw-thumbs { display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end; margin-top: 5px; }
.wpw-thumbs img { width: 64px; height: 64px; object-fit: cover; border-radius: 4px; display: block; }

.wpw-card { background: var(--wpw-panel); border: 1px solid var(--wpw-rule); border-radius: 5px; padding: 8px 10px; }
.wpw-card.is-newest { border-color: rgba(95, 211, 138, 0.55); }
.wpw-card.is-writing { border-color: var(--wpw-yellow); color: var(--wpw-yellow); }
.wpw-card.is-error { border-color: var(--wpw-red); color: var(--wpw-red); }
.wpw-card-head { display: flex; align-items: center; gap: 8px; min-height: 26px; }
.wpw-card-head.is-toggle { cursor: pointer; }
.wpw-ver { font-weight: 700; flex: none; }
.wpw-status { flex: none; font-size: 12px; opacity: 0.75; max-width: 60%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wpw-status.is-new { color: var(--wpw-green); opacity: 1; }
.wpw-preview { flex: 1; min-width: 0; opacity: 0.75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wpw-spacer { flex: 1; }
.wpw-editor {
  display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 7px 9px; resize: none;
  background: var(--wpw-ground); border: 1px solid var(--wpw-rule); border-radius: 4px;
}
.wpw-text { margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.wpw-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex: none; }
.wpw-actions.is-block { margin-top: 7px; }
.wpw-use-combo { display: inline-flex; }
.wpw-use-combo .wpw-primary { border-radius: 4px 0 0 4px; }
.wpw-target {
  height: 28px; max-width: 190px; padding: 0 4px; background: var(--wpw-ground); cursor: pointer;
  border: 1px solid var(--wpw-warp); border-left: 0; border-radius: 0 4px 4px 0;
}
.wpw-error-text { margin-top: 3px; white-space: pre-wrap; overflow-wrap: anywhere; }

.wpw-composer { flex: none; border-top: 1px solid var(--wpw-rule); padding: 9px 14px 11px; }
.wpw-composer.is-drag { box-shadow: inset 0 0 0 2px var(--wpw-warp); }
.wpw-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 7px; }
.wpw-chip {
  display: inline-flex; align-items: center; gap: 5px; height: 26px; box-sizing: border-box; padding: 0 7px;
  background: var(--wpw-panel); border: 1px solid var(--wpw-rule); border-radius: 13px; font-size: 12px;
}
.wpw-chip img { width: 20px; height: 20px; object-fit: cover; border-radius: 3px; display: block; }
.wpw-chip.is-base { border-color: var(--wpw-warp); color: var(--wpw-warp); }
.wpw-chip.is-off { opacity: 0.7; }
.wpw-chip-btn { cursor: pointer; }
.wpw-chip-btn:hover { border-color: var(--wpw-warp); color: var(--wpw-warp); }
.wpw-chip-x { background: none; border: 0; padding: 0 1px; cursor: pointer; font-size: 14px; line-height: 1; opacity: 0.7; }
.wpw-chip-x:hover { opacity: 1; color: var(--wpw-red); }
.wpw-compose-row { display: flex; align-items: flex-end; gap: 8px; }
.wpw-input {
  flex: 1; min-width: 0; box-sizing: border-box; padding: 8px 10px; resize: none;
  line-height: ${INPUT_LINE}px; background: var(--wpw-panel);
  border: 1px solid var(--wpw-rule); border-radius: 5px;
}
.wpw-send { height: 36px; min-width: 92px; }
.wpw-send.is-stop { background: var(--wpw-yellow); border-color: var(--wpw-yellow); }
.wpw-note { font-size: 12px; margin-top: 5px; opacity: 0.8; }
.wpw-note.is-error { color: var(--wpw-red); opacity: 1; }
.wpw-note:empty { display: none; }
`;

// --- State that outlives the pop-up -------------------------------------------

let store = null;
let storeLoad = null;
let saving = false;
let saveAgain = false;
let ticker = null;
let lastChatId = null;
let listsRun = 0;

/** chat id → the running job. */
const jobs = new Map();
/** chat id → what failed, kept for its Retry. */
const failures = new Map();
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
  const response = await api.fetchApi(route, options);
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
  store = normalizeStore(await response.json());
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
    text: "Write",
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

/** What the next write builds on: {id, text, label}, or null for nothing. */
function chosenBase(chat, draft) {
  if (draft.base === NO_BASE) return null;
  const versions = chat.versions;
  const version = versions.find((v) => v.id === draft.base) ?? versions.at(-1);
  if (version) {
    return {
      id: version.id,
      text: baseText(chat, version.id),
      label: `Builds on v${version.n}`,
    };
  }
  if (chat.seedPrompt) {
    return { id: "seed", text: baseText(chat, "seed"), label: "Builds on: current prompt" };
  }
  return null;
}

function setNote(chatId, text, isError = false) {
  draftOf(chatId).note = text ? { text, isError } : null;
  if (view?.chatId === chatId) renderNote();
}

// --- Writing ------------------------------------------------------------------

function findModel(id) {
  return lists.models.find((m) => m.id === id) ?? null;
}

function startWrite(chat) {
  if (jobs.has(chat.id)) return;
  flushEdits();
  const draft = draftOf(chat.id);
  const request = draft.text.trim();
  const base = chosenBase(chat, draft);
  if (!request && !base?.text?.trim()) {
    setNote(chat.id, "Type what you want first.", true);
    view.input.focus();
    return;
  }
  const model = String(getSetting(SETTING_MODEL, ""));
  if (!model) {
    setNote(chat.id, "Pick a model first.", true);
    return;
  }
  if (draft.uploading) {
    setNote(chat.id, "Wait for the images to finish uploading.", true);
    return;
  }

  let images = [...draft.images];
  let note = null;
  if (images.length && !findModel(model)?.vision) {
    note = { text: "Images left out: this model cannot see images.", isError: false };
    images = [];
  }

  const systemPrompt = String(getSetting(SETTING_SYSTEM_PROMPT, ""));
  const spec = {
    request,
    images,
    baseId: base?.id ?? null,
    model,
    systemPrompt,
    originNode: view.promptNode,
    payload: {
      base_url: baseUrl(),
      model,
      system_prompt: systemPrompt,
      temperature: clampTemperature(getSetting(SETTING_TEMPERATURE, DEFAULT_TEMPERATURE)),
      idea: request,
      previous_result: base?.text ?? "",
      references: images,
    },
  };

  draft.text = "";
  draft.images = [];
  draft.base = null;
  draft.note = note;
  view.input.value = "";
  growInput();
  launch(chat, spec);
}

/** Runs one request; `spec` is everything it needs, so a Retry can repeat it. */
async function launch(chat, spec) {
  failures.delete(chat.id);
  const controller = new AbortController();
  const job = { ...spec, chatId: chat.id, controller, startedAt: Date.now(), dropped: false };
  jobs.set(chat.id, job);
  syncButton(spec.originNode);
  ticker ??= setInterval(tick, TICK_MS);
  refresh(chat.id);

  let out = null;
  let message = null;
  let cancelled = false;
  try {
    out = await postJson("/warppipe/llm/write", spec.payload, controller.signal);
    if (out?.error) message = String(out.error);
    else if (!String(out?.text ?? "").trim()) message = "The model returned no text.";
  } catch (error) {
    if (error?.name === "AbortError") cancelled = true;
    else message = String(error?.message ?? error);
  }

  jobs.delete(chat.id);
  syncButton(spec.originNode);
  if (job.dropped) return;

  if (cancelled) restoreDraft(chat, spec);
  else if (message) {
    failures.set(chat.id, { spec, message });
    toast("error", "Prompt failed", chat.title, 6000);
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
  });
  save();
  if (view?.chatId !== chat.id) {
    unseen.set(chat.id, spec.originNode);
    syncButton(spec.originNode);
  }
  toast("success", "Prompt ready", chat.title);
  if (chat.versions.length === 1) nameChat(chat, spec.request || String(out.text));
}

/** Ask the cheap model for a title. On any failure the chat keeps its first words. */
async function nameChat(chat, source) {
  if (chat.titleEdited) return;
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
  if (!chat.versions.length || !setAutoTitle(chat, out?.title)) return;
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

/** Put a request back into the composer, with its images and what it built on. */
function fillDraft(chat, spec) {
  const draft = draftOf(chat.id);
  draft.text = spec.request ?? "";
  draft.images = (spec.images ?? []).filter((name) => typeof name === "string");
  draft.base = spec.baseId === "seed" ? null : (spec.baseId ?? NO_BASE);
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
  failures.delete(chat.id);
  fillDraft(chat, rewound);
  save();
  focusComposer();
}

/** The same for a request that failed, which never became a version. */
function rewindFailure(chat, failure) {
  failures.delete(chat.id);
  fillDraft(chat, failure.spec);
  focusComposer();
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
  if (model) return { text: modelLabel(model), title: model.id };
  if (!lists.models.length && lists.error) {
    return { text: id || "Model list failed", title: lists.error, isError: true };
  }
  if (!lists.models.length && lists.loading) return { text: "Loading models…" };
  if (id) return { text: `${id}${NOT_LISTED}`, title: id };
  return { text: "Pick a model" };
}

function renderModelButton() {
  const state = modelButtonState();
  view.model.textContent = state.text;
  view.model.title = state.title ?? "";
  view.model.classList.toggle("is-error", !!state.isError);
}

function renderPrompts() {
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
  const top = view.chats.scrollTop;
  view.chats.replaceChildren(...sortedChats(store).map(railRow));
  view.chats.scrollTop = top;
}

function railRow(chat) {
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
  const failed = failures.has(chat.id);
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
  } else {
    const when = timeAgo(chat.updated);
    const text = `${count} version${count === 1 ? "" : "s"}${when ? ` · ${when}` : ""}`;
    sub = el("div", { class: "wpw-chat-sub", text });
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
        unseen.has(chat.id) && el("span", { class: "wpw-check", text: "✓", title: "Finished" })
      ),
      sub
    ),
    button(
      "×",
      () => {
        view.confirmDelete = chat.id;
        renderRail();
      },
      "wpw-chat-del",
      "Delete this chat"
    )
  );
}

function requestBubble(request, images, onRewind) {
  const empty = !request;
  const names = (images ?? []).filter((name) => typeof name === "string");
  return el(
    "div",
    { class: `wpw-request${empty ? " is-empty" : ""}${onRewind ? " has-rewind" : ""}` },
    empty ? "Optimise the prompt" : request,
    onRewind &&
      button(
        "↶",
        onRewind,
        "wpw-rewind",
        "Go back to this message: it moves into the input, and it and everything after it leave the chat"
      ),
    names.length > 0 &&
      el(
        "div",
        { class: "wpw-thumbs" },
        ...names.map((name) => el("img", { src: thumbUrl(name), alt: "", loading: "lazy" }))
      )
  );
}

function refreshTargets() {
  view.targets = listTargets(app.rootGraph) ?? [];
  if (!view.targets.some((target) => target.node === view.targetNode)) {
    view.targetNode =
      view.targets.find((target) => target.node === view.promptNode)?.node ??
      view.targets[0]?.node ??
      null;
  }
}

function targetIndex() {
  return view.targets.findIndex((target) => target.node === view.targetNode);
}

function useCombo(version) {
  const select = el("select", {
    class: "wpw-target",
    title: "The Prompt + LoRAs to write into",
    disabled: !view.targets.length,
    onChange: () => {
      view.targetNode = view.targets[select.selectedIndex]?.node ?? null;
      for (const other of view.modal.querySelectorAll(".wpw-target")) {
        other.selectedIndex = select.selectedIndex;
      }
    },
  });
  const labels = view.targets.length
    ? view.targets.map((target) => target.label)
    : ["No Prompt + LoRAs"];
  select.append(...labels.map((label) => el("option", { text: label })));
  select.selectedIndex = Math.max(0, targetIndex());
  const use = button("Use in", () => useVersion(version), "wpw-btn wpw-primary");
  use.disabled = !view.targets.length;
  return el("span", { class: "wpw-use-combo" }, use, select);
}

function statusText(version) {
  return formatStatus({ cost: version.cost, seconds: version.seconds, usage: version.usage });
}

function finishedText(version) {
  const status = statusText(version);
  return status ? `Finished · ${status}` : "Finished";
}

function versionCard(chat, version, index) {
  const label = `v${version.n}`;
  const newest = index === chat.versions.length - 1;
  const title = version.model ? `${version.model} · ${version.systemPrompt ?? ""}` : undefined;
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
      el(
        "div",
        { class: "wpw-card-head" },
        el("span", { class: "wpw-ver", text: label }),
        el("span", { class: "wpw-status is-new", text: finishedText(version), title })
      ),
      editor,
      el("div", { class: "wpw-actions is-block" }, useCombo(version))
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
    button("Continue from here", () => continueFrom(chat, version)),
    useCombo(version)
  );
  return el(
    "div",
    { class: "wpw-card" },
    el(
      "div",
      { class: "wpw-card-head is-toggle", onClick: toggle, title: open ? "Collapse" : "Expand" },
      el("span", { class: "wpw-ver", text: label }),
      open
        ? el("span", { class: "wpw-status", text: finishedText(version), title })
        : el("span", { class: "wpw-preview", text: version.text }),
      !open && actions
    ),
    open && el("div", { class: "wpw-text", text: version.text }),
    open && actions
  );
}

function renderConvo(stick) {
  flushEdits();
  const chat = currentChat();
  view.editors = [];
  if (!chat) {
    view.convo.replaceChildren();
    return;
  }
  refreshTargets();
  const items = [];
  if (chat.seedPrompt) {
    items.push(
      el("div", {
        class: "wpw-seed",
        text: `Current prompt: ${chat.seedPrompt}`,
        title: chat.seedPrompt,
      })
    );
  }
  chat.versions.forEach((version, index) => {
    const rewind = jobs.has(chat.id) ? null : () => rewindTo(chat, version);
    items.push(requestBubble(version.request, version.images, rewind));
    items.push(versionCard(chat, version, index));
  });

  const job = jobs.get(chat.id);
  if (job) {
    items.push(requestBubble(job.request, job.images));
    items.push(
      el(
        "div",
        { class: "wpw-card is-writing" },
        el("span", { class: "wpw-spin" }),
        "Writing · ",
        secondsEl(job.startedAt)
      )
    );
  }
  const failure = failures.get(chat.id);
  if (failure) {
    items.push(
      requestBubble(failure.spec.request, failure.spec.images, () => rewindFailure(chat, failure))
    );
    items.push(
      el(
        "div",
        { class: "wpw-card is-error" },
        el("div", { class: "wpw-error-text", text: failure.message }),
        el(
          "div",
          { class: "wpw-actions is-block" },
          button("Retry", () => launch(chat, failure.spec))
        )
      )
    );
  }
  if (!items.length) {
    items.push(
      el("div", {
        class: "wpw-hint",
        text: "Describe the prompt you want, or add the current prompt and ask for a change.",
      })
    );
  }

  const top = view.convo.scrollTop;
  view.convo.replaceChildren(...items);
  for (const { editor } of view.editors) fitEditor(editor);
  view.convo.scrollTop = stick ? view.convo.scrollHeight : top;
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

function baseChip(chat, draft) {
  const base = chosenBase(chat, draft);
  if (base) {
    const clear = () => {
      if (base.id === "seed") {
        chat.seedPrompt = null;
        save();
        renderConvo(false);
      } else {
        draft.base = NO_BASE;
      }
      renderChips();
    };
    return chip("is-base", [base.label], clear, "Start without this");
  }
  if (chat.versions.length) {
    const back = () => {
      draft.base = null;
      renderChips();
    };
    return chip("is-off", ["Starts fresh"], back, "Build on the newest version again");
  }
  return button("+ Current prompt", () => takeCurrentPrompt(chat), "wpw-chip wpw-chip-btn");
}

function renderChips() {
  const chat = currentChat();
  if (!chat) {
    view.chips.replaceChildren();
    return;
  }
  const draft = draftOf(chat.id);
  const images = draft.images.map((name) =>
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
  view.chips.replaceChildren(
    button("Add image", pickImages, "wpw-chip wpw-chip-btn"),
    ...images,
    ...uploading,
    baseChip(chat, draft)
  );
}

function renderSend() {
  const job = jobs.get(view.chatId);
  view.send.classList.toggle("is-stop", !!job);
  if (job) view.send.replaceChildren("Stop · ", secondsEl(job.startedAt));
  else view.send.replaceChildren("Write");
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
  lastChatId = id;
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

/** A chat with nothing in it is reused, so "New chat" cannot pile them up. */
function newChat() {
  const empty = sortedChats(store).find(
    (chat) => !chat.versions.length && !jobs.has(chat.id) && !failures.has(chat.id)
  );
  const chat = empty ?? createChat(store, { id: uid(), now: Date.now(), seedPrompt: null });
  if (!empty) save();
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
  failures.delete(chat.id);
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

function takeCurrentPrompt(chat) {
  refreshTargets();
  const widget = targetNow()?.node?.widgets?.find((w) => w.name === TEXT_WIDGET);
  const text = String(widget?.value ?? "");
  if (!text.trim()) {
    setNote(chat.id, "That Prompt + LoRAs is empty.", true);
    return;
  }
  chat.seedPrompt = text;
  save();
  renderConvo(false);
  renderChips();
  renderRail();
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
}

function openPopover(anchor, root) {
  closePopover();
  view.popover = { anchor, root };
  view.head.append(root);
}

function toggleModels() {
  if (view.popover?.anchor === view.model) {
    closePopover();
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
    closePopover();
    renderModelButton();
    view.model.focus();
  };
  const draw = () => {
    const shown = matches();
    const rows = shown.map((model) =>
      button(
        modelLabel(model),
        () => choose(model),
        `wpw-option${model.id === current ? " is-current" : ""}`,
        model.id
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
  const root = el("div", { class: "wpw-pop wpw-models" }, filter, options);
  root.style.left = `${view.model.offsetLeft}px`;
  openPopover(view.model, root);
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

function toggleGear() {
  if (view.popover?.anchor === view.gear) {
    closePopover();
    return;
  }
  const state = el("div", { class: "wpw-key-state" });
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
    placeholder: "API key",
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
  const root = el(
    "div",
    { class: "wpw-pop wpw-gear" },
    el("label", {}, "Base URL", url),
    el("label", {}, "Temperature", temperature),
    el("label", {}, "Title model", titleModel),
    el("div", { class: "wpw-key-row" }, key, button("Save key", saveKey)),
    state,
    button("Refresh lists", () => {
      refreshKeyState(state);
      loadLists(true);
    })
  );
  openPopover(view.gear, root);
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
    setSetting(SETTING_SYSTEM_PROMPT, lists.prompts[lists.prompts.length - 1]);
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
  const model = button("", toggleModels, "wpw-field wpw-combo");
  const prompts = el("select", {
    class: "wpw-field wpw-prompts",
    title: "System prompt",
    onChange: () => setSetting(SETTING_SYSTEM_PROMPT, prompts.value),
  });
  const gear = button("⚙", toggleGear, "wpw-icon", "Server, temperature and API key");
  const head = el(
    "div",
    { class: "wpw-head" },
    title,
    model,
    prompts,
    gear,
    button("×", closeView, "wpw-icon", "Close (Esc)")
  );

  const chats = el("div", { class: "wpw-chats" });
  const rail = el(
    "div",
    { class: "wpw-rail" },
    button("New chat", () => newChat(), "wpw-btn wpw-new"),
    chats
  );

  const convo = el("div", { class: "wpw-convo" });
  const chips = el("div", { class: "wpw-chips" });
  const note = el("div", { class: "wpw-note" });
  const input = el("textarea", {
    class: "wpw-input",
    rows: INPUT_MIN_LINES,
    placeholder: "Describe the prompt, or the change you want. Ctrl+Enter sends.",
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
  const send = button(
    "Write",
    () => {
      const chat = currentChat();
      if (!chat) return;
      const job = jobs.get(chat.id);
      if (job) job.controller.abort();
      else startWrite(chat);
    },
    "wpw-btn wpw-primary wpw-send"
  );
  const composer = el(
    "div",
    { class: "wpw-composer" },
    chips,
    el("div", { class: "wpw-compose-row" }, input, send),
    note
  );
  const main = el("div", { class: "wpw-main" }, convo, composer);

  const modal = el(
    "div",
    {
      class: "wpw-modal",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Prompt Writer",
      tabIndex: -1,
    },
    head,
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
    head,
    title,
    model,
    prompts,
    gear,
    chats,
    convo,
    chips,
    note,
    input,
    send,
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
  renderModelButton();
  renderPrompts();
  growInput();
  input.focus();
}

/** The chat to show: one this node is waiting on, else where the user left off. */
function initialChat(promptNode) {
  const finished = [...unseen].find(([, node]) => node === promptNode)?.[0];
  const writing = [...jobs.values()].find((job) => job.originNode === promptNode)?.chatId;
  const chats = sortedChats(store);
  const last = chats.some((chat) => chat.id === lastChatId) ? lastChatId : chats[0]?.id;
  return finished ?? writing ?? last ?? null;
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
    view.targetNode = promptNode;
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
  const id = initialChat(promptNode);
  if (id) selectChat(id);
  else newChat();
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
  ],
});
