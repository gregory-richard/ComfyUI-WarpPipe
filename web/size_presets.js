// The Warp Provider's size presets, as an earlier version saved them.
//
// Kept apart from the extension that uses it so it can be tested without a
// ComfyUI page around it.

const SIZE_RE = /(\d+)\s*[×x]\s*(\d+)/i;

/** Today's label for a preset 4.1 or earlier saved, or null if there is none.
 *
 * Those labels read "Portrait (high-res)         |  3:4   |  1152 ×  1536  |
 * 1.77 MP". The server still takes them and runs them at that size; this puts
 * the label the dropdown offers today in their place, so an old workflow reads
 * like a new one. It goes by the size, which every label has always carried,
 * and takes the nearest option within 16 pixels: four old sizes were not
 * multiples of 16 and moved by 8 to the nearest that is.
 */
export function upgradeSizePreset(value, options) {
  if (typeof value !== "string" || !value.includes("|") || options.includes(value)) return null;
  const old = value.match(SIZE_RE);
  if (!old) return null;
  const width = Number(old[1]);
  const height = Number(old[2]);

  let best = null;
  let bestOff = 17;
  for (const option of options) {
    const size = typeof option === "string" ? option.match(SIZE_RE) : null;
    if (!size) continue;
    const off = Math.abs(Number(size[1]) - width) + Math.abs(Number(size[2]) - height);
    if (off < bestOff) {
      best = option;
      bestOff = off;
    }
  }
  return best;
}
