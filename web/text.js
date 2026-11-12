// Turning untrusted strings into markup, in one place.
//
// Model names, versions and base models all come from filenames and from
// .civitai.info sidecars - JSON downloaded from a website by whichever updater
// wrote it. Anything built with innerHTML has to go through here first, and
// having one copy is what stops a second view from quietly forgetting to.

/** The four characters that would otherwise start markup. */
export function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** As escapeHTML, plus the quote that would close an attribute. */
export function escapeAttr(value) {
  return escapeHTML(value).replace(/"/g, "&quot;");
}

/** A model's bare filename: no folders, no extension. What a tag names. */
export function stemOf(id) {
  return String(id ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/\.[^.]+$/, "");
}

const SECTION_LINE = /^\s*\/\/\/\//;
const COMMENT_LINE = /^(\s*)\/\/ ?/;

/**
 * Comment or uncomment every line a selection touches, the way code editors do:
 * if all of them are comments they are switched back on, otherwise all become
 * comments. Blank lines inside a selection stay blank, a selection ending at the
 * very start of a line leaves that line out, and //// section lines stay put.
 * Returns the range of whole lines to replace and its new text.
 */
export function toggleCommentLines(value, selStart, selEnd) {
  const last = selEnd > selStart && value[selEnd - 1] === "\n" ? selEnd - 1 : selEnd;
  const start = selStart === 0 ? 0 : value.lastIndexOf("\n", selStart - 1) + 1;
  const lineEnd = value.indexOf("\n", last);
  const end = lineEnd === -1 ? value.length : lineEnd;

  const lines = value.slice(start, end).split("\n");
  const single = lines.length === 1;
  const counts = (line) => !SECTION_LINE.test(line) && (single || line.trim() !== "");
  const counted = lines.filter(counts);
  const off = counted.length > 0 && counted.every((line) => COMMENT_LINE.test(line));
  const text = lines
    .map((line) => {
      if (!counts(line)) return line;
      return off ? line.replace(COMMENT_LINE, "$1") : line.replace(/^(\s*)/, "$1// ");
    })
    .join("\n");
  return { start, end, text };
}
