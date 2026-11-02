import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeBase,
  fitsBase,
  fittingFamilies,
  folderBase,
  sameBase,
} from "../../web/model_base.js";

// Index entries as the server builds them: folder is the first directory of the
// file's path inside the loras folder, base_model what its sidecar says.
const lora = (folder, base_model = null) => ({ folder, base_model });

// The real case: a MOSS-Image finetune from Hugging Face, never on Civitai,
// so it has no sidecar and will never get one.
const KROMOSS = "moss\\kromoss - v1.0 int8 (moss).safetensors";

test("a checkpoint with no sidecar is known by its folder, and says so", () => {
  assert.deepEqual(folderBase(KROMOSS), { name: "moss", fromFolder: true });
  assert.deepEqual(folderBase("moss/sub/file.safetensors"), { name: "moss", fromFolder: true });
  assert.equal(folderBase("loose file.safetensors"), null);
  assert.equal(folderBase(""), null);
});

test("on a model known by its folder, the LoRAs filed beside it fit", () => {
  const base = folderBase(KROMOSS);

  // Properly tagged on Civitai: these all read orange before.
  assert.equal(fitsBase(lora("moss", "MOSS Image"), base), true);
  // No sidecar either, but filed in the same place.
  assert.equal(fitsBase(lora("moss"), base), true);
  // Folders are matched the way base names are: case and spelling aside.
  assert.equal(fitsBase(lora("Moss", "MOSS Image"), base), true);
});

test("anywhere else the folder name is still only compared, never assumed", () => {
  const base = folderBase(KROMOSS);

  assert.equal(fitsBase(lora("sdxl", "SDXL 1.0"), base), false);
  // A LoRA that says nothing, filed elsewhere: can't tell.
  assert.equal(fitsBase(lora("misc"), base), null);
  assert.equal(fitsBase(lora("", null), base), null);
  // A sidecar that happens to spell the folder still matches, as it did.
  assert.equal(fitsBase(lora("misc", "moss"), base), true);
});

test("a base read from a sidecar is the rule, and the folder plays no part", () => {
  const base = { name: "Krea 2", fromFolder: false };

  assert.equal(fitsBase(lora("krea2", "Krea 2"), base), true);
  assert.equal(fitsBase(lora("Krea 2", "Flux.2 D"), base), false);
  assert.equal(fitsBase(lora("krea2"), base), null);
});

test("unknown never matches", () => {
  assert.equal(sameBase("", ""), false);
  assert.equal(sameBase(null, undefined), false);
  assert.equal(fitsBase(lora("moss", "MOSS Image"), null), null);
  assert.equal(fitsBase(null, folderBase(KROMOSS)), null);
});

test("the browser's families follow the same rule, largest first", () => {
  const entries = [
    lora("moss", "MOSS Image"),
    lora("moss", "MOSS Image"),
    lora("moss"),
    lora("sdxl", "SDXL 1.0"),
    lora("misc"),
  ];

  const families = fittingFamilies(entries, folderBase(KROMOSS));
  assert.deepEqual(
    [...families],
    [
      ["MOSS Image", 2],
      ["moss", 1],
    ]
  );
  assert.equal(fittingFamilies(entries, null).size, 0);
});

test("the warning names a folder as a folder", () => {
  assert.equal(describeBase(folderBase(KROMOSS)), "a model filed under moss");
  assert.equal(describeBase({ name: "Krea 2", fromFolder: false }), "Krea 2");
});
