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

function price(value) {
  return value == null ? "?" : `$${Number(value).toFixed(2)}`;
}

/** "name · $in/$out · 👁", leaving out what the model list does not say. */
export function modelLabel(m) {
  const parts = [String(m?.name ?? m?.id ?? "")];
  if (m?.prompt_price != null || m?.completion_price != null) {
    parts.push(`${price(m.prompt_price)}/${price(m.completion_price)}`);
  }
  if (m?.vision) parts.push("👁");
  return parts.join(" · ");
}

/** "0.3 ¢ · 8 s · 1,812 → 640 tokens", leaving out what the reply does not say. */
export function formatStatus(r) {
  const parts = [];
  if (r?.cost != null) parts.push(`${Number((r.cost * 100).toFixed(2))} ¢`);
  if (r?.seconds != null) parts.push(`${Math.round(r.seconds)} s`);
  const usage = r?.usage ?? {};
  if (usage.prompt_tokens != null && usage.completion_tokens != null) {
    const fmt = (n) => Number(n).toLocaleString("en-US");
    parts.push(`${fmt(usage.prompt_tokens)} → ${fmt(usage.completion_tokens)} tokens`);
  }
  return parts.join(" · ");
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

/** The library entry a tag's name means, or null. */
export function findLora(index, name) {
  const at = (name || "").trim().toLowerCase();
  return index.get(at) ?? index.get(stemOf(at)) ?? null;
}

const titleOf = (entry) => entry.title || entry.name || stemOf(entry.id);
const triggersOf = (entry) => (Array.isArray(entry.triggers) ? [...entry.triggers] : []);

/**
 * What a write tells the LLM: {available, active, refs}, where refs maps each
 * "L1" to its library entry. Null when the base is unknown or no LoRA fits it.
 */
export function buildLoraLists(entries, base, tags) {
  const fitting = entries.filter((entry) => fitsBase(entry, base) === true);
  if (!fitting.length) return null;

  const index = loraIndex(entries);
  const activeEntries = new Set(tags.map((tag) => findLora(index, tag.name)).filter(Boolean));
  const refs = new Map();
  const available = fitting
    .filter((entry) => !activeEntries.has(entry))
    .slice(0, MAX_AVAILABLE)
    .map((entry, i) => {
      const ref = `L${i + 1}`;
      refs.set(ref, entry);
      return { ref, title: titleOf(entry), triggers: triggersOf(entry) };
    });
  const active = [...activeEntries].map((entry) => ({
    title: titleOf(entry),
    triggers: triggersOf(entry),
  }));
  return { available, active, refs };
}

/** The server's [{ref, strength, reason}] as a version stores them. */
export function resolveSuggestions(raw, refs) {
  if (!Array.isArray(raw) || !refs) return [];
  return raw.flatMap((item) => {
    const entry = refs.get(item?.ref);
    if (!entry) return [];
    return [
      {
        id: entry.id,
        name: entry.name ?? "",
        title: titleOf(entry),
        tag: stemOf(entry.id),
        thumbnail: entry.thumbnail ?? null,
        triggers: triggersOf(entry),
        strength: item.strength,
        reason: String(item.reason ?? ""),
      },
    ];
  });
}

/** What the composer's chip says. `lists` is undefined until it is known. */
export function loraToggleState(on, lists) {
  if (!on) return { text: "LoRAs off", accent: false };
  if (lists === undefined) return { text: "LoRAs on · …", accent: true };
  if (lists === null) return { text: "LoRAs: none for this model", accent: false };
  return { text: `LoRAs on · ${lists.available.length}`, accent: true };
}

// --- Adding a suggestion to a list ---------------------------------------------

// A tag may carry a folder or an extension the bare stem does not have.
function namesLora(name, tag) {
  const wanted = tag.toLowerCase();
  const last = name.trim().toLowerCase().replace(/\\/g, "/").split("/").pop();
  return last === wanted || stemOf(last) === wanted;
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
