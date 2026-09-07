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

/** The base model of the file wired into this node, asked of the server. */
export async function connectedBase(node) {
  const name = connectedModelName(node);
  if (!name) return null;
  if (asked.has(name)) return asked.get(name);

  let answer = null;
  try {
    const info = await fetch(`/warppipe/model/base?name=${encodeURIComponent(name)}`).then((r) =>
      r.json()
    );
    answer = info.base_model || null;
  } catch {
    /* fall through to the folder */
  }
  if (!answer) {
    // No sidecar: fall back to the folder, which is right for collections filed
    // that way and simply matches nothing for the rest.
    const parts = name.replace(/\\/g, "/").split("/");
    answer = parts.length > 1 ? parts[0] : null;
  }
  asked.set(name, answer);
  return answer;
}
