// Folding a text box: lines starting //// are section headers.
//
// Everything here is about what a box shows. The text itself is never touched,
// so a folded LoRA still loads and folded prose still goes to the model. The
// DOM side lives in prompt_editor.js; this is the part that needs no page.

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

/**
 * A folded section's label in columns. countWidth and activeWidth are the widest
 * numbers of any section in the box, so counts of one, two or three digits line
 * up, and folding another section cannot move them.
 */
export function foldLabelParts(section, sections) {
  const shown = (item) => (item.loraCount > 0 ? item.loraCount : item.lineCount);
  const digits = (value) => String(value).length;
  const hasLoras = section.loraCount > 0;
  const count = shown(section);
  return {
    count,
    unit: `${hasLoras ? "LoRA" : "line"}${count === 1 ? "" : "s"}`,
    active: hasLoras ? section.activeLoras : null,
    countWidth: Math.max(...sections.map((item) => digits(shown(item)))),
    activeWidth: Math.max(
      1,
      ...sections.filter((item) => item.loraCount > 0).map((item) => digits(item.activeLoras))
    ),
  };
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
