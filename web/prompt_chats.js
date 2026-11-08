// The Prompt Writer's chat history: a store of chats, each a list of prompt
// versions. Pure data handling, so it can be tested under node.

export const CHATS_FILE = "warppipe_prompt_chats.json";

const STORE_VERSION = 1;
const DEFAULT_TITLE = "New chat";
const TITLE_WORDS = 6;
const TITLE_CHARS = 40;

export function emptyStore() {
  return { version: STORE_VERSION, chats: [] };
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isId = (v) => typeof v === "string" && v !== "";
const stringOr = (v, fallback) => (typeof v === "string" ? v : fallback);
const numberOrNull = (v) => (Number.isFinite(v) ? v : null);
const stampOf = (v) => (Number.isFinite(v) || isId(v) ? v : 0);

function normalizeImages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((image) => isId(image) || isObject(image));
}

function normalizeVersion(raw, n) {
  return {
    id: raw.id,
    n,
    created: stampOf(raw.created),
    request: stringOr(raw.request, ""),
    images: normalizeImages(raw.images),
    baseId: isId(raw.baseId) ? raw.baseId : null,
    text: raw.text,
    model: stringOr(raw.model, ""),
    systemPrompt: stringOr(raw.systemPrompt, ""),
    cost: numberOrNull(raw.cost),
    seconds: numberOrNull(raw.seconds),
    usage: isObject(raw.usage) ? { ...raw.usage } : {},
  };
}

// The first entry of each id, among those `valid` accepts.
function validUnique(items, valid) {
  const seen = new Set();
  return items.filter((item) => {
    if (!isObject(item) || !isId(item.id) || !valid(item) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function normalizeChat(raw) {
  const versions = validUnique(raw.versions, (v) => typeof v.text === "string");
  return {
    id: raw.id,
    title: stringOr(raw.title, DEFAULT_TITLE),
    titleEdited: raw.titleEdited === true,
    created: stampOf(raw.created),
    updated: stampOf(raw.updated),
    seedPrompt: stringOr(raw.seedPrompt, null),
    versions: versions.map((v, i) => normalizeVersion(v, i + 1)),
  };
}

/** A valid store from anything: bad input is empty, malformed entries are dropped. */
export function normalizeStore(raw) {
  if (!isObject(raw) || raw.version !== STORE_VERSION || !Array.isArray(raw.chats)) {
    return emptyStore();
  }
  const chats = validUnique(raw.chats, (c) => Array.isArray(c.versions));
  return { version: STORE_VERSION, chats: chats.map(normalizeChat) };
}

export function createChat(store, { id, now, seedPrompt = null }) {
  const chat = {
    id,
    title: DEFAULT_TITLE,
    titleEdited: false,
    created: now,
    updated: now,
    seedPrompt,
    versions: [],
  };
  store.chats.push(chat);
  return chat;
}

/** The first words of a request, as a chat title. */
export function titleFrom(request) {
  const words = String(request ?? "")
    .trim()
    .split(/\s+/)
    .slice(0, TITLE_WORDS)
    .join(" ");
  if (!words) return DEFAULT_TITLE;
  // The cut may fall in the middle of an emoji's surrogate pair.
  return words
    .slice(0, TITLE_CHARS)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd();
}

export function addVersion(
  chat,
  {
    id,
    now,
    request,
    images = [],
    baseId = null,
    text,
    model,
    systemPrompt,
    cost = null,
    seconds = null,
    usage = {},
  }
) {
  const version = {
    id,
    n: chat.versions.length + 1,
    created: now,
    request,
    images: [...images],
    baseId,
    text,
    model,
    systemPrompt,
    cost,
    seconds,
    usage: { ...usage },
  };
  chat.versions.push(version);
  chat.updated = now;
  if (!chat.titleEdited && version.n === 1) chat.title = titleFrom(request);
  return version;
}

/**
 * The text a new version builds on: "seed" is the seed prompt, a version id
 * that version, and null the newest version, else the seed prompt.
 */
export function baseText(chat, baseId) {
  if (baseId === "seed") return chat.seedPrompt ?? null;
  if (baseId != null) return chat.versions.find((v) => v.id === baseId)?.text ?? null;
  return chat.versions.at(-1)?.text ?? chat.seedPrompt ?? null;
}

/**
 * Go back to just before a version: it and everything after it leave the chat.
 * Returns the version that was rewound to, so its request can be sent again, or
 * null when the chat has no such version.
 */
export function rewindChat(chat, versionId, now) {
  const index = chat.versions.findIndex((v) => v.id === versionId);
  if (index < 0) return null;
  const [version] = chat.versions.splice(index);
  chat.updated = now;
  return version;
}

export function renameChat(chat, title) {
  const trimmed = String(title ?? "").trim();
  if (!trimmed) return;
  chat.title = trimmed;
  chat.titleEdited = true;
}

export function deleteChat(store, id) {
  const index = store.chats.findIndex((c) => c.id === id);
  if (index < 0) return false;
  store.chats.splice(index, 1);
  return true;
}

// Stamps are whatever the caller passed as `now`: epoch numbers or ISO strings.
function timeOf(stamp) {
  return typeof stamp === "number" ? stamp : Date.parse(stamp) || 0;
}

/** A new array, newest updated first. */
export function sortedChats(store) {
  return [...store.chats].sort((a, b) => timeOf(b.updated) - timeOf(a.updated));
}
