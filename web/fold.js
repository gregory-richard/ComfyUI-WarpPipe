// Folding a text box: lines starting //// are section headers.
//
// Everything here is about what a box shows. The text itself is never touched,
// so a folded LoRA still loads and folded prose still goes to the model. The
// DOM side lives in prompt_ui.js; this is the part that needs no page.

import { escapeHTML } from "./text.js";

// Matched one line at a time, so \s cannot run on into the line after.
const HEADER_LINE = /^\s*\/\/\/\/\s*(.*)$/;

const LORA_TAG = /<lora:[^<>\n]*>/gi;

/** How many LoRA tags a stretch of text holds, and how many are not behind a //. */
export function countLoras(text) {
  let total = 0;
  let active = 0;
  for (const line of String(text ?? "").split("\n")) {
    const note = line.indexOf("//");
    for (const match of line.matchAll(LORA_TAG)) {
      total += 1;
      if (note === -1 || match.index < note) active += 1;
    }
  }
  return { total, active };
}

/** What a folded section says it holds: its LoRAs if it has any, otherwise its lines. */
export function sectionSummary({ lineCount, loraCount, activeLoras }) {
  if (loraCount > 0)
    return `${loraCount} LoRA${loraCount === 1 ? "" : "s"} · ${activeLoras} active`;
  return `${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

/**
 * The sections of a text, with exact character offsets.
 *
 * Each section's header line is headerStart to headerEnd, without its newline.
 * The body is bodyStart to bodyEnd, without the newline before the next header,
 * and is empty (the two equal) when nothing is written there. lineCount leaves
 * out blank lines at the end of the body, which only space the sections apart.
 *
 * A key is the title plus which of that title this is, "Style#0", so a section
 * keeps its key when the text around it changes.
 */
export function parseSections(text) {
  const value = text ?? "";
  const sections = [];
  const seen = new Map();
  let at = 0;
  for (const line of value.split("\n")) {
    const match = HEADER_LINE.exec(line);
    if (match) {
      const title = match[1].trimEnd();
      const nth = seen.get(title) ?? 0;
      seen.set(title, nth + 1);
      const headerEnd = at + line.length;
      sections.push({
        key: `${title}#${nth}`,
        title,
        headerStart: at,
        headerEnd,
        bodyStart: Math.min(headerEnd + 1, value.length),
        bodyEnd: value.length,
        lineCount: 0,
        loraCount: 0,
        activeLoras: 0,
      });
    }
    at += line.length + 1;
  }
  sections.forEach((section, i) => {
    const next = sections[i + 1];
    if (next) section.bodyEnd = Math.max(section.bodyStart, next.headerStart - 1);
    const body = value.slice(section.bodyStart, section.bodyEnd).trimEnd();
    section.lineCount = body ? body.split("\n").length : 0;
    const loras = countLoras(body);
    section.loraCount = loras.total;
    section.activeLoras = loras.active;
  });
  const end = sections.length ? Math.max(0, sections[0].headerStart - 1) : value.length;
  return { preamble: { start: 0, end, text: value.slice(0, end) }, sections };
}

/** The folded keys that still name a section, in the order they were folded. */
export function pruneFolded(keys, sections) {
  if (!Array.isArray(keys)) return [];
  const live = new Set(sections.map((section) => section.key));
  return keys.filter((key) => live.has(key));
}

/**
 * The view's markup: a header row and, unless folded, the body of each section.
 *
 * `folded` is a Set of keys and `paintRange(start, end)` colours that stretch
 * of the text. data-at and data-end say which characters a block holds, which
 * is how a click on it is turned back into a place in the text.
 */
export function foldMarkup(text, { preamble, sections }, folded, paintRange) {
  const block = (start, end) =>
    `<div class="wpf-text" data-at="${start}" data-end="${end}">${paintRange(start, end)}</div>`;

  let html = sections[0]?.headerStart > 0 ? block(preamble.start, preamble.end) : "";
  sections.forEach((section, i) => {
    const { headerStart, headerEnd, bodyStart, bodyEnd, title } = section;
    const shut = folded.has(section.key);
    const titleEnd = headerStart + text.slice(headerStart, headerEnd).trimEnd().length;
    const count = sectionSummary(section);
    html +=
      `<div class="wpf-head${shut ? " is-folded" : ""}" data-i="${i}">` +
      `<span class="wpf-fold" title="${shut ? "Unfold" : "Fold"}">${shut ? "▸" : "▾"}</span>` +
      `<span class="wpf-title" data-at="${titleEnd - title.length}" data-end="${titleEnd}">` +
      `${escapeHTML(title)}</span>` +
      (shut ? `<span class="wpf-count">· ${count}</span>` : "") +
      "</div>";
    // An empty body can still be a blank line, which the box shows; it is only
    // nothing at all when the header ends the text or the next one follows it.
    const next = sections[i + 1]?.headerStart ?? Infinity;
    if (!shut && bodyStart > headerEnd && bodyStart < next) html += block(bodyStart, bodyEnd);
  });
  return html;
}
