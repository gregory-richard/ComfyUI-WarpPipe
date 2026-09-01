// The model library, fetched once and shared.
//
// Both views want it: the prompt colours its tags against it and completes from
// it, and the browser lists it. They used to hold a cache each and fetch
// /warppipe/loras separately, which is the expensive call on the server - it
// reads a sidecar for every file in the folder. One cache means one fetch, and
// it also means the two can never be describing different libraries.

let pending = null;
let cached = null;

// Throws on failure rather than returning nothing: the browser wants to say why
// it is empty, and the prompt - which does not care - catches at its own call.
async function ask(url, key) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json())[key] || [];
}

/** Every LoRA. */
export async function loras() {
  return (await everything()).filter((entry) => entry.kind !== "embeddings");
}

/** Every LoRA and embedding, in one list. Each carries its own `kind`. */
export function everything() {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;

  pending = Promise.all([
    ask("/warppipe/loras", "loras"),
    // An installation may have no embeddings folder configured, and that is not
    // a reason for the LoRAs to be unavailable too.
    ask("/warppipe/embeddings", "embeddings").catch(() => []),
  ])
    .then(([lora, embedding]) => {
      cached = [...lora, ...embedding];
      return cached;
    })
    .finally(() => {
      pending = null;
    });

  return pending;
}

/** Forget it, so a model added since is picked up on the next ask. */
export function forget() {
  cached = null;
  pending = null;
}
