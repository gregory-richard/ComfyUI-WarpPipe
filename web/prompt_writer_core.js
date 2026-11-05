// Pure helpers for the Prompt Writer: labels, the status line, and finding
// the Prompt + LoRAs node the active Warp Send draws from.
//
// No DOM and no `app`, so it can be tested under node.

import { collectSends } from "./warp_route.js";

export const PROMPT_TYPE = "Warp Lora Prompt";
const SUBGRAPH_INPUT_ID = -10;
const SUBGRAPH_OUTPUT_ID = -20;

/** The prompt without its `//` title lines, and with runs of blank lines collapsed. */
export function stripTitles(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line));
  return lines
    .join("\n")
    .replace(/\n(?:[ \t]*\n)+/g, "\n\n")
    .trim();
}

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

// --- Finding the target prompt -------------------------------------------------

// Links are a Map in current frontends and a plain object in older ones.
function linkStore(graph) {
  return graph?.links ?? graph?._links ?? null;
}

function linksOf(graph) {
  const links = linkStore(graph);
  if (!links) return [];
  return links instanceof Map ? [...links.values()] : Object.values(links);
}

function linkById(graph, id) {
  const links = linkStore(graph);
  if (id == null || !links) return null;
  return (links instanceof Map ? links.get(id) : links[id]) ?? null;
}

function nodeById(graph, id) {
  return (graph?._nodes ?? []).find((n) => String(n.id) === String(id)) ?? null;
}

// For each subgraph, the subgraph nodes that use it and the graph they sit in.
function instancesOf(rootGraph) {
  const out = new Map();
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const node of graph._nodes ?? []) {
      if (!node.subgraph) continue;
      if (!out.has(node.subgraph)) out.set(node.subgraph, []);
      out.get(node.subgraph).push({ graph, node });
      walk(node.subgraph);
    }
  };
  walk(rootGraph);
  return out;
}

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

function groupAt(graph, node) {
  const c = centre(node);
  return (graph?._groups ?? graph?.groups ?? []).find((g) => {
    const b = bounds(g);
    return b && inside(b, c);
  });
}

/**
 * Walk upstream from `start` through input links, into subgraph nodes (from
 * their outputs) and out of subgraphs (through their input node), collecting
 * the Prompt + LoRAs nodes. The walk does not go past a prompt.
 */
function promptsUpstream(rootGraph, startGraph, start) {
  const instances = instancesOf(rootGraph);
  const graphIds = new Map();
  const graphId = (graph) => {
    if (!graphIds.has(graph)) graphIds.set(graph, graphIds.size);
    return graphIds.get(graph);
  };
  const found = new Set();
  const visited = new Set();
  // `stack`: the subgraph nodes entered on the way here, innermost last.
  const queue = [{ graph: startGraph, node: start, stack: [] }];

  // Follow the link `linkId` arriving in `graph` back to its origin.
  const follow = (graph, linkId, stack) => {
    const link = linkById(graph, linkId);
    if (!link) return;
    if (link.origin_id === SUBGRAPH_INPUT_ID) {
      // Out of this subgraph: continue from the subgraph node's matching input.
      const parents = stack.length ? [stack[stack.length - 1]] : (instances.get(graph) ?? []);
      const rest = stack.slice(0, -1);
      for (const parent of parents) {
        follow(parent.graph, parent.node.inputs?.[link.origin_slot]?.link, rest);
      }
      return;
    }
    const origin = nodeById(graph, link.origin_id);
    if (!origin) return;
    if (origin.subgraph) {
      // Into the subgraph: continue from what feeds that output.
      const inner = origin.subgraph;
      const innerStack = [...stack, { graph, node: origin }];
      for (const l of linksOf(inner)) {
        if (l.target_id === SUBGRAPH_OUTPUT_ID && l.target_slot === link.origin_slot) {
          follow(inner, l.id, innerStack);
        }
      }
      return;
    }
    queue.push({ graph, node: origin, stack });
  };

  while (queue.length) {
    const { graph, node, stack } = queue.shift();
    const key = `${stack.map((s) => graphId(s.graph) + "/" + s.node.id).join(":")}|${graphId(graph)}/${node.id}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (node !== start && node.type === PROMPT_TYPE) {
      found.add(node);
      continue;
    }
    for (const input of node.inputs ?? []) follow(graph, input.link, stack);
  }
  return [...found];
}

/**
 * The Prompt + LoRAs node of the active Warp Send's group: by link walk,
 * else the one inside the same LGraphGroup as the Send. `group` names that
 * group: its title, or the Send's name.
 */
export function findTargetPrompt(rootGraph) {
  const send = collectSends(rootGraph).find((s) => s.active);
  if (!send) return { error: "Activate a Warp Send first" };

  const box = groupAt(send.graph, send.node);
  const group = box?.title || send.name;

  let prompts = promptsUpstream(rootGraph, send.graph, send.node);
  if (prompts.length === 0 && box) {
    const b = bounds(box);
    prompts = (send.graph._nodes ?? []).filter(
      (n) => n.type === PROMPT_TYPE && inside(b, centre(n))
    );
  }
  if (prompts.length === 0) return { error: `No Prompt + LoRAs found for "${group}"` };
  if (prompts.length > 1) {
    return { error: `"${group}" has ${prompts.length} Prompt + LoRAs nodes; keep one` };
  }
  return { node: prompts[0], group };
}
