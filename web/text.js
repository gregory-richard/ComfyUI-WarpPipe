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
