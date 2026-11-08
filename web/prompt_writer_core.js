// Pure helpers for the Prompt Writer: labels, the status line, and listing the
// Prompt + LoRAs nodes a prompt can be sent to.
//
// No DOM and no `app`, so it can be tested under node.

import { allNodes } from "./warp_route.js";

export const PROMPT_TYPE = "Warp Lora Prompt";
const BOOKMARK = /\s*\[(\d+)\]\s*$/;

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
