// The Prompt Writer's chat history: a store of chats, each a list of prompt
// versions. Pure data handling, so it can be tested under node.

export const CHATS_FILE = "warppipe_prompt_chats.json";
/** Start from the text in the prompt box of the For node, read when Write is pressed. */
export const CURRENT_PROMPT = "prompt";
/** Start from nothing: a new prompt from the request alone. */
export const NEW_PROMPT = "none";

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

function isSuggestion(raw) {
  return isObject(raw) && isId(raw.id) && isId(raw.tag) && Number.isFinite(raw.strength);
}

/** Only what names the LoRA and its weight is required: the rest is for display. */
function normalizeSuggestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isSuggestion).map((item) => ({
    id: item.id,
    name: stringOr(item.name, ""),
    title: stringOr(item.title, ""),
    tag: item.tag,
    thumbnail: stringOr(item.thumbnail, null),
    triggers: Array.isArray(item.triggers)
      ? item.triggers.filter((word) => typeof word === "string")
      : [],
    strength: item.strength,
    reason: stringOr(item.reason, ""),
    ...(item.addedHow === "appended" || item.addedHow === "enabled"
      ? { addedHow: item.addedHow }
      : {}),
  }));
}

const isTurn = (raw) => isObject(raw) && isId(raw.question) && isId(raw.answer);

/** The questions the AI asked on the way to a version, each with its answer. */
function normalizeTurns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isTurn).map(({ question, answer }) => ({ question, answer }));
}

/** A step that waits for the answer to a question, or null. */
function normalizePending(raw) {
  if (!isObject(raw) || !isId(raw.question) || typeof raw.request !== "string") return null;
  return {
    request: raw.request,
    images: normalizeImages(raw.images),
    baseId: isId(raw.baseId) ? raw.baseId : null,
    basePrompt: stringOr(raw.basePrompt, null),
    turns: normalizeTurns(raw.turns),
    question: raw.question,
  };
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
    suggestions: normalizeSuggestions(raw.suggestions),
    activeLoras: normalizeSuggestions(raw.activeLoras),
    questions: normalizeTurns(raw.questions),
    basePrompt: stringOr(raw.basePrompt, null),
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
    targetLabel: stringOr(raw.targetLabel, null),
    versions: versions.map((v, i) => normalizeVersion(v, i + 1)),
    pending: normalizePending(raw.pending),
  };
}

/** Is this a chat file this version can read? One it cannot must not be saved over. */
export function isStore(raw) {
  return isObject(raw) && raw.version === STORE_VERSION && Array.isArray(raw.chats);
}

/** A valid store from anything: bad input is empty, malformed entries are dropped. */
export function normalizeStore(raw) {
  if (!isStore(raw)) return emptyStore();
  const chats = validUnique(raw.chats, (c) => Array.isArray(c.versions));
  return { version: STORE_VERSION, chats: chats.map(normalizeChat) };
}

export function createChat(store, { id, now, seedPrompt = null, targetLabel = null }) {
  const chat = {
    id,
    title: DEFAULT_TITLE,
    titleEdited: false,
    created: now,
    updated: now,
    seedPrompt,
    targetLabel,
    versions: [],
    pending: null,
  };
  store.chats.push(chat);
  return chat;
}

/** The first words of a text, or "" when it has none. */
function firstWords(text) {
  const words = String(text ?? "")
    .trim()
    .split(/\s+/)
    .slice(0, TITLE_WORDS)
    .join(" ");
  // The cut may fall in the middle of an emoji's surrogate pair.
  return words
    .slice(0, TITLE_CHARS)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd();
}

/** The first words of a request, as a chat title. */
export function titleFrom(request) {
  return firstWords(request) || DEFAULT_TITLE;
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
    suggestions = [],
    activeLoras = [],
    questions = [],
    basePrompt = null,
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
    suggestions: normalizeSuggestions(suggestions),
    activeLoras: normalizeSuggestions(activeLoras),
    questions: normalizeTurns(questions),
    basePrompt,
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

/**
 * The AI asked instead of writing: the step waits in the chat for an answer.
 * `step` is {request, images, baseId, basePrompt, turns}, the turns being the
 * questions already answered on the way.
 */
export function openQuestion(chat, step, question, now) {
  chat.pending = {
    request: step.request ?? "",
    images: [...(step.images ?? [])],
    baseId: step.baseId ?? null,
    basePrompt: step.basePrompt ?? null,
    turns: normalizeTurns(step.turns),
    question,
  };
  chat.updated = now;
  return chat.pending;
}

/** The waiting step leaves the chat; returned, or null when there was none. */
export function dropQuestion(chat) {
  const pending = chat.pending ?? null;
  chat.pending = null;
  return pending;
}

/** What the next Write does: edit a version, newest first, or the current prompt, or write anew. */
export function startOptions(chat, targetLabel) {
  const versions = [...chat.versions].reverse().map((v, i) => ({
    value: v.id,
    label: `Edit v${v.n} · ${i === 0 ? "newest" : firstWords(v.request) || "optimised"}`,
  }));
  return [
    ...versions,
    { value: CURRENT_PROMPT, label: `Edit current prompt · ${targetLabel || "the For node"}` },
    { value: NEW_PROMPT, label: "New prompt" },
  ];
}

/** Which of them is chosen: the draft's own choice while it exists, else the newest version. */
export function startValue(chat, base) {
  if (base === CURRENT_PROMPT || base === NEW_PROMPT) return base;
  if (base != null && chat.versions.some((v) => v.id === base)) return base;
  return chat.versions.at(-1)?.id ?? NEW_PROMPT;
}

/** How a step says where it started. "seed" is how older chats said current prompt. */
export function startLabel(chat, baseId) {
  if (baseId === CURRENT_PROMPT || baseId === "seed") return "edit of the current prompt";
  const version = chat.versions.find((v) => v.id === baseId);
  return version ? `edit of v${version.n}` : "new prompt";
}

/**
 * A request put back into a composer that may already hold something: the
 * request comes first and nothing typed is lost. `overflow` says images were
 * left out because more than `maxImages` would not be sent.
 */
export function mergedDraft(held, back, maxImages) {
  const images = [...new Set([...back.images, ...held.images])];
  return {
    text: [back.text, held.text].filter((part) => part.trim()).join("\n\n"),
    images: images.slice(0, maxImages),
    overflow: images.length > maxImages,
  };
}

/** A generated title; one the user typed always stays. */
export function setAutoTitle(chat, title) {
  const trimmed = String(title ?? "").trim();
  if (!trimmed || chat.titleEdited) return false;
  chat.title = trimmed;
  return true;
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

/** The most recently updated chat for this target, or null. */
export function latestChatFor(store, label) {
  if (label == null) return null;
  return sortedChats(store).find((chat) => chat.targetLabel === label) ?? null;
}
