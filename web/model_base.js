// Which base model a node is wired to, and which one a LoRA belongs to.
//
// Both the prompt's completion and the library browser need this, and they must
// not be able to disagree about what matches what, so it lives in one place.

/** What a LoRA is filed under: what it says it is, else where it sits.
 *
 * base_model comes from the .civitai.info sidecar and means the same thing in
 * anybody's collection. Folder names only mean something to whoever chose them,
 * so they are the fallback rather than the rule.
 */
export function groupOf(entry) {
  return entry.base_model || entry.folder || "Unsorted";
}

// "Flux.2 Klein 9B" and "flux2 klein 9b" are the same base written twice.
const key = (name) => (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Do these two name the same base model? Unknown never matches anything. */
export function sameBase(a, b) {
  const left = key(a);
  return left !== "" && left === key(b);
}

/** Is this LoRA made for the connected model? True, false, or null for "can't
 * tell" - a LoRA with no sidecar says nothing about its base, and a guess that
 * it does not fit would hide one that works.
 *
 * A base found only from the checkpoint's folder is a folder name, not a base
 * model: "moss" for Unet\moss\, which no Civitai sidecar will ever spell. Held
 * against the sidecars it matched nothing, so on a checkpoint from Hugging Face
 * every properly tagged LoRA read as made for another model. The folder means
 * something to whoever filed it, though, and they filed the LoRAs the same way:
 * a LoRA in Lora\moss\ fits a model in Unet\moss\, whatever its sidecar calls
 * the base. Anywhere else, the folder name is compared as before.
 */
export function fitsBase(entry, base) {
  if (!entry || !base?.name) return null;
  if (base.fromFolder && sameBase(entry.folder, base.name)) return true;
  if (!entry.base_model) return null;
  return sameBase(entry.base_model, base.name);
}

/** The families - as groupOf names them - holding LoRAs that fit this base,
 *  each with how many of its LoRAs do, largest first. */
export function fittingFamilies(entries, base) {
  const counts = new Map();
  for (const entry of entries) {
    if (fitsBase(entry, base) !== true) continue;
    const group = groupOf(entry);
    counts.set(group, (counts.get(group) || 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

/** The connected base, the way a sentence should name it. */
export function describeBase(base) {
  return base?.fromFolder ? `a model filed under ${base.name}` : (base?.name ?? "");
}

/** The model file feeding this node, found by walking back up the graph. */
export function connectedModelName(node) {
  const seen = new Set();
  const walk = (current, depth) => {
    if (!current || depth > 12 || seen.has(current.id)) return null;
    seen.add(current.id);
    for (const widget of current.widgets || []) {
      const isModel = /^(unet_name|ckpt_name|model_name)$/.test(widget.name || "");
      if (isModel && typeof widget.value === "string" && widget.value) return widget.value;
    }
    for (let slot = 0; slot < (current.inputs || []).length; slot++) {
      const found = walk(current.getInputNode?.(slot), depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(node, 0);
}

// Asked of the server once per file: the answer is a sidecar read, and the
// same checkpoint stays connected for as long as anyone keeps typing.
const asked = new Map();

/** Forget the answers, so a sidecar written since is read again. */
export function forgetBases() {
  asked.clear();
}

/** The base model of the file wired into this node, asked of the server.
 *
 * { name, fromFolder }, or null when nothing is known. fromFolder says the name
 * is only the folder the file sits in - see fitsBase for what that changes.
 */
export async function connectedBase(node) {
  const name = connectedModelName(node);
  if (!name) return null;
  if (asked.has(name)) return asked.get(name);

  let answer = null;
  try {
    const info = await fetch(`/warppipe/model/base?name=${encodeURIComponent(name)}`).then((r) =>
      r.json()
    );
    if (info.base_model) answer = { name: info.base_model, fromFolder: false };
  } catch {
    /* fall through to the folder */
  }
  if (!answer) answer = folderBase(name);
  asked.set(name, answer);
  return answer;
}

/** No sidecar: fall back to the folder, which is right for collections filed
 *  that way and simply matches nothing for the rest. */
export function folderBase(modelName) {
  const parts = (modelName || "").replace(/\\/g, "/").split("/");
  return parts.length > 1 && parts[0] ? { name: parts[0], fromFolder: true } : null;
}
