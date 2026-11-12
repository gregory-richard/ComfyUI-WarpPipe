// Pure helpers for the Prompt Writer: labels, the status line, listing the
// Prompt + LoRAs nodes a prompt can be sent to, and what the LLM is told about
// LoRAs.
//
// No DOM and no `app`, so it can be tested under node.

import { fitsBase } from "./model_base.js";
import { stemOf } from "./text.js";
import { allNodes } from "./warp_route.js";

export const PROMPT_TYPE = "Warp Lora Prompt";
const BOOKMARK = /\s*\[(\d+)\]\s*$/;

// The same tag the prompt colours and the backend loads.
const TAG_RE = /<lora:([^:>]+):(-?[0-9]*\.?[0-9]+)([^>]*)>/gi;
const COMMENT = "//";
const TRIGGER_JOIN = ", ";
// What the server takes; more would only be numbers it throws away.
const MAX_AVAILABLE = 1000;
// The extensions ComfyUI gives a model file. Any other dot is part of the name.
const MODEL_EXT = /\.(?:safetensors|ckpt|pt2?|pth|bin|pkl|sft)$/i;

function price(value) {
  return value == null ? "?" : `$${Number(value).toFixed(2)}`;
}

/** "$in/$out" per million tokens, or "" when the model list does not say. */
export function modelPrice(m) {
  if (m?.prompt_price == null && m?.completion_price == null) return "";
  return `${price(m.prompt_price)}/${price(m.completion_price)}`;
}

/** "name · $in/$out · 👁", leaving out what the model list does not say. */
export function modelLabel(m) {
  const parts = [String(m?.name ?? m?.id ?? ""), modelPrice(m)].filter(Boolean);
  if (m?.vision) parts.push("👁");
  return parts.join(" · ");
}

/** ["0.3 ¢", "8 s", "1,812 → 640 tokens"], leaving out what the reply does not say. */
export function statusParts(r) {
  const parts = [];
  if (r?.cost != null) parts.push(`${Number((r.cost * 100).toFixed(2))} ¢`);
  if (r?.seconds != null) parts.push(`${Math.round(r.seconds)} s`);
  const usage = r?.usage ?? {};
  if (usage.prompt_tokens != null && usage.completion_tokens != null) {
    const fmt = (n) => Number(n).toLocaleString("en-US");
    parts.push(`${fmt(usage.prompt_tokens)} → ${fmt(usage.completion_tokens)} tokens`);
  }
  return parts;
}

// --- Listing the targets -------------------------------------------------------

function centre(node) {
  const [x, y] = node.pos ?? [0, 0];
  const [w, h] = node.size ?? [0, 0];
  return [x + w / 2, y + h / 2];
}

function bounds(group) {
  if (group._bounding?.length >= 4) return [...group._bounding];
  if (group.pos && group.size) return [...group.pos, ...group.size];
  return null;
}

function inside(b, [x, y]) {
  return x >= b[0] && y >= b[1] && x <= b[0] + b[2] && y <= b[1] + b[3];
}

// The smallest group around the node's centre, so nested groups name the inner one.
function groupAt(graph, node) {
  const c = centre(node);
  let best = null;
  let bestArea = Infinity;
  for (const group of graph?._groups ?? graph?.groups ?? []) {
    const b = bounds(group);
    if (!b || !inside(b, c)) continue;
    const area = b[2] * b[3];
    if (area < bestArea) {
      best = group;
      bestArea = area;
    }
  }
  return best;
}

// Each prompt node with the top-level node that places it on the canvas. Graphs
// are visited once, so a subgraph used several times counts for its first use.
function promptsWithAnchor(rootGraph) {
  const seen = new Set([rootGraph]);
  const out = [];
  for (const top of rootGraph?._nodes ?? []) {
    const nodes = top.subgraph ? allNodes(top.subgraph, [], seen) : [top];
    for (const node of nodes) {
      if (node.type === PROMPT_TYPE) out.push({ node, anchor: top });
    }
  }
  return out;
}

const rank = (entry) => entry.number ?? Number.MAX_SAFE_INTEGER;

/**
 * Every Prompt + LoRAs node as {node, label}: the label is its group's title
 * without the bookmark, else the node's title. Bookmarked groups come first,
 * by number; equal labels get " (2)", " (3)".
 */
export function listTargets(rootGraph) {
  const entries = promptsWithAnchor(rootGraph).map(({ node, anchor }) => {
    const title = String(groupAt(rootGraph, anchor)?.title ?? "");
    const number = title.match(BOOKMARK)?.[1];
    return {
      node,
      number: number == null ? null : Number(number),
      label: title.replace(BOOKMARK, "").trim() || String(node.title || PROMPT_TYPE),
    };
  });
  entries.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

  const used = new Set();
  return entries.map(({ node, label }) => {
    let unique = label;
    for (let n = 2; used.has(unique); n++) unique = `${label} (${n})`;
    used.add(unique);
    return { node, label: unique };
  });
}

/** The chat's chosen target, else the node the pop-up was opened from, else the first. */
export function resolveTarget(targets, label, originNode) {
  return (
    targets.find((target) => target.label === label) ??
    targets.find((target) => target.node === originNode) ??
    targets[0] ??
    null
  );
}

// --- The LoRAs of a target -----------------------------------------------------

function commentedAt(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return text.slice(lineStart, index).includes(COMMENT);
}

/** Every <lora:NAME:WEIGHT> that is not behind a // on its line, as {name, weight}. */
export function activeLoraTags(text) {
  const value = String(text ?? "");
  const found = [];
  for (const match of value.matchAll(TAG_RE)) {
    if (commentedAt(value, match.index)) continue;
    found.push({ name: match[1].trim(), weight: parseFloat(match[2]) });
  }
  return found;
}

/** The tags a target has switched on: its prompt, its list, and list 2 while that is on. */
export function targetLoraTags(node) {
  const valueOf = (name) => node?.widgets?.find((widget) => widget.name === name)?.value;
  const names = ["text", "loras"];
  if (valueOf("loras_2_on") === true) names.push("loras_2");
  return names.flatMap((name) => activeLoraTags(valueOf(name)));
}

/** Every <lora:NAME:WEIGHT> that is behind a // on its line, as {name, weight}. */
export function switchedOffLoraTags(text) {
  const value = String(text ?? "");
  const found = [];
  for (const match of value.matchAll(TAG_RE)) {
    if (commentedAt(value, match.index)) {
      found.push({ name: match[1].trim(), weight: parseFloat(match[2]) });
    }
  }
  return found;
}

/** The tags switched off in a target's LoRA lists. */
export function targetOffLoraTags(node) {
  const valueOf = (name) => node?.widgets?.find((widget) => widget.name === name)?.value;
  const names = ["loras"];
  if (valueOf("loras_2_on") === true) names.push("loras_2");
  return names.flatMap((name) => switchedOffLoraTags(valueOf(name)));
}

/** Every name a tag might use for a file; the first file of a name keeps it. */
export function loraIndex(entries) {
  const index = new Map();
  for (const entry of entries) {
    const noExt = entry.id.replace(/\.[^.]+$/, "");
    for (const key of [stemOf(entry.id), noExt, noExt.replace(/\\/g, "/")]) {
      const at = key.toLowerCase();
      if (!index.has(at)) index.set(at, entry);
    }
  }
  return index;
}

/** What a tag calls a LoRA, without folders or a model file's extension. */
function bareName(name) {
  return String(name ?? "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(MODEL_EXT, "");
}

/** The library entry a tag's name means, or null. */
export function findLora(index, name) {
  const at = (name || "").trim().toLowerCase();
  return index.get(at) ?? index.get(bareName(at)) ?? null;
}

const titleOf = (entry) => entry.title || entry.name || stemOf(entry.id);
const triggersOf = (entry) => (Array.isArray(entry.triggers) ? [...entry.triggers] : []);

/** A LoRA as a version stores it: what its chip shows and what its tag says. */
function chipOf(entry, strength, reason = "") {
  return {
    id: entry.id,
    name: entry.name ?? "",
    title: titleOf(entry),
    tag: stemOf(entry.id),
    thumbnail: entry.thumbnail ?? null,
    triggers: triggersOf(entry),
    strength,
    reason,
  };
}

/**
 * What a write tells the LLM: {available, active, refs, activeChips}, where refs
 * maps each "L1" to its library entry and activeChips is what a version stores of
 * the LoRAs that are on. Scope "all" offers every LoRA that fits the base; scope
 * "list" offers the LoRAs switched off in the target's own lists. `listed` is
 * those tags: a LoRA in it keeps the weight written there. Null when there is
 * nothing to offer and nothing on.
 */
export function buildLoraLists(entries, base, tags, { scope = "all", listed = [] } = {}) {
  const index = loraIndex(entries);
  const firstWeights = (found) => {
    const weights = new Map();
    for (const tag of found) {
      const entry = findLora(index, tag.name);
      if (entry && !weights.has(entry)) weights.set(entry, tag.weight);
    }
    return weights;
  };
  const weights = firstWeights(listed);
  const activeWeights = firstWeights(tags);
  const pool =
    scope === "list"
      ? [...weights.keys()]
      : entries.filter((entry) => fitsBase(entry, base) === true);
  if (scope !== "list" && !pool.length && !activeWeights.size) return null;

  const refs = new Map();
  const available = pool
    .filter((entry) => !activeWeights.has(entry))
    .slice(0, MAX_AVAILABLE)
    .map((entry, i) => {
      const ref = `L${i + 1}`;
      refs.set(ref, weights.has(entry) ? { ...entry, listedWeight: weights.get(entry) } : entry);
      return { ref, title: titleOf(entry), triggers: triggersOf(entry) };
    });
  const active = [...activeWeights.keys()].map((entry) => ({
    title: titleOf(entry),
    triggers: triggersOf(entry),
  }));
  const activeChips = [...activeWeights].map(([entry, weight]) => chipOf(entry, weight));
  return { available, active, refs, activeChips };
}

/** The server's [{ref, strength, reason}] as a version stores them. */
export function resolveSuggestions(raw, refs) {
  if (!Array.isArray(raw) || !refs) return [];
  return raw.flatMap((item) => {
    const entry = refs.get(item?.ref);
    if (!entry) return [];
    return [chipOf(entry, entry.listedWeight ?? item.strength, String(item.reason ?? ""))];
  });
}

/**
 * How much a model may think before it writes, as NanoGPT names the levels.
 * "" sends nothing, so the model keeps its own default.
 */
export const REASONING_LEVELS = [
  ["", "Model default"],
  ["none", "Off"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
];

/** A level the server knows, else "" for the model's default. */
export function reasoningLevel(value) {
  return REASONING_LEVELS.some(([level]) => level && level === value) ? value : "";
}

/** Whole lines out of streamed text, and the unfinished rest kept for the next piece. */
export function splitLines(text) {
  const parts = text.split("\n");
  const rest = parts.pop();
  return { lines: parts.filter((line) => line.trim()), rest };
}

/** What the composer's scope buttons say. `counts` is undefined until it is known. */
export function loraScopeCounts(counts) {
  if (counts === undefined) return { list: "…", all: "…" };
  return { list: String(counts.list ?? 0), all: String(counts.all ?? 0) };
}

// --- Adding a suggestion to a list ---------------------------------------------

// A tag may carry a folder or an extension the bare stem does not have.
function namesLora(name, tag) {
  return bareName(name).toLowerCase() === tag.toLowerCase();
}

/** Is an uncommented tag with this name in the text? */
export function isLoraListed(text, tag) {
  return activeLoraTags(text).some((found) => namesLora(found.name, tag));
}

/** The text with <lora:TAG:STRENGTH> as its own last line. */
export function appendLoraTag(text, tag, strength) {
  const line = `<lora:${tag}:${Number(strength).toFixed(2)}>`;
  const value = String(text ?? "");
  if (!value) return line;
  return value.endsWith("\n") ? value + line : `${value}\n${line}`;
}

/**
 * The text without any uncommented tag of this name. A line that held only the
 * tag goes with it; anything else on the line stays.
 */
export function removeLoraTag(text, tag) {
  const kept = [];
  for (const line of String(text ?? "").split("\n")) {
    const left = line.replace(TAG_RE, (raw, name, _weight, _rest, at) =>
      !line.slice(0, at).includes(COMMENT) && namesLora(name, tag) ? "" : raw
    );
    if (left === line) kept.push(line);
    else if (left.trim()) kept.push(left.trim());
  }
  return kept.join("\n");
}

/** The text with the first commented line holding this tag switched on, or null. */
export function enableLoraTag(text, tag) {
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)\/\/ ?(.*)$/.exec(lines[i]);
    if (!match) continue;
    if (activeLoraTags(match[2]).some((found) => namesLora(found.name, tag))) {
      lines[i] = match[1] + match[2];
      return lines.join("\n");
    }
  }
  return null;
}

/** The text with the first line that switches this tag on commented out. */
export function disableLoraTag(text, tag) {
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (activeLoraTags(lines[i]).some((found) => namesLora(found.name, tag))) {
      lines[i] = lines[i].replace(/^(\s*)/, "$1// ");
      break;
    }
  }
  return lines.join("\n");
}

/** The text with the trigger words as a new first line, unless they already are one. */
export function addTriggerLine(text, triggers) {
  if (!triggers.length) return text;
  const line = triggers.join(TRIGGER_JOIN);
  return text.split("\n", 1)[0] === line ? text : `${line}\n${text}`;
}

/** The text without its first line, if that line is still exactly the trigger words. */
export function removeTriggerLine(text, triggers) {
  if (!triggers.length) return text;
  const line = triggers.join(TRIGGER_JOIN);
  if (text === line) return "";
  return text.startsWith(`${line}\n`) ? text.slice(line.length + 1) : text;
}

// --- What changed from the version before --------------------------------------

// Words, runs of spaces and single marks, so a change is shown word by word.
const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const WORD = /[\p{L}\p{N}]/u;
// Past this many cells a comparison is not worth the wait: it is a rewrite anyway.
const MAX_CELLS = 4_000_000;
// More than this share of the words changed reads better side by side than marked.
const REWRITE_SHARE = 0.6;

function tokens(text) {
  return String(text ?? "").match(TOKEN) ?? [];
}

/** The longest common subsequence of two token lists, as same/del/add steps. */
function lcsSteps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    return [
      ...a.map((text) => ({ type: "del", text })),
      ...b.map((text) => ({ type: "add", text })),
    ];
  }
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const steps = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      steps.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      steps.push({ type: "del", text: a[i++] });
    } else {
      steps.push({ type: "add", text: b[j++] });
    }
  }
  while (i < n) steps.push({ type: "del", text: a[i++] });
  while (j < m) steps.push({ type: "add", text: b[j++] });
  return steps;
}

/**
 * What turned `before` into `after`, word by word: [{type: "same" | "del" | "add", text}].
 * The same parts and the deleted ones give back `before`, the same parts and the
 * added ones give back `after`. Changed words next to each other read as one
 * change, the spaces between them included.
 */
export function diffWords(before, after) {
  const a = tokens(before);
  const b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const steps = [
    { type: "same", text: a.slice(0, start).join("") },
    ...lcsSteps(a.slice(start, endA), b.slice(start, endB)),
    { type: "same", text: a.slice(endA).join("") },
  ];

  const parts = [];
  const push = (type, text) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.type === type) last.text += text;
    else parts.push({ type, text });
  };
  let del = "";
  let add = "";
  let gap = "";
  const flush = () => {
    push("del", del);
    push("add", add);
    del = add = "";
  };
  for (const step of steps) {
    if (step.type === "same") {
      if ((del || add) && /^\s+$/.test(step.text)) {
        gap += step.text;
        continue;
      }
      flush();
      push("same", gap + step.text);
      gap = "";
      continue;
    }
    // Spaces between two changed words belong to both sides of the change.
    del += gap;
    add += gap;
    gap = "";
    if (step.type === "del") del += step.text;
    else add += step.text;
  }
  flush();
  push("same", gap);
  return parts;
}

/** Words added and removed, the share of the words that changed, and whether that is a rewrite. */
export function diffStats(parts) {
  const words = (text) => tokens(text).filter((token) => WORD.test(token)).length;
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const part of parts) {
    const count = words(part.text);
    if (part.type === "add") added += count;
    else if (part.type === "del") removed += count;
    else same += count;
  }
  const total = added + removed + 2 * same;
  const share = total ? (added + removed) / total : 0;
  return { added, removed, share, rewrite: share > REWRITE_SHARE };
}
