// Bundle what the prompt boxes use of CodeMirror into web/vendor/codemirror.js,
// and write the licence file that has to travel with it.
//
// This lives outside web/ on purpose: ComfyUI imports every .js under web/ as
// an extension. The bundle it produces is imported that way too, which is why
// it may only export things and never do anything on import.
//
// Run with: npm run build:editor

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "scripts", "codemirror_entry.mjs");
const outDir = path.join(root, "web", "vendor");
const outFile = path.join(outDir, "codemirror.js");
const licenseFile = path.join(outDir, "LICENSE-codemirror.txt");

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  legalComments: "inline",
  metafile: true,
  write: false,
  logLevel: "warning",
});

/** The packages that actually ended up in the bundle, by name. */
function packagesIn(metafile) {
  const names = new Set();
  const inBundle = Object.values(metafile.outputs)[0].inputs;
  for (const input of Object.keys(inBundle)) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, "/"));
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

function packageInfo(name) {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  const { version, license } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  if (license !== "MIT") throw new Error(`${name} is ${license}, expected MIT`);
  const text = readFileSync(path.join(dir, "LICENSE"), "utf8").replace(/\r\n/g, "\n").trim();
  return { name, version, text };
}

const packages = packagesIn(result.metafile).map(packageInfo);

// The minifier has nothing to keep: these packages carry their licence in a
// file rather than in a comment. So the notices are written at the top by hand.
const copyrights = [
  ...new Set(
    packages.flatMap((p) => p.text.split("\n").filter((line) => /^Copyright/i.test(line)))
  ),
];
const permission = packages[0].text.slice(packages[0].text.indexOf("Permission is hereby"));
const banner = [
  "/*!",
  " * CodeMirror 6, bundled for ComfyUI-WarpPipe. Built by npm run build:editor.",
  ` * Contains: ${packages.map((p) => `${p.name}@${p.version}`).join(", ")}.`,
  " * Full licence texts: LICENSE-codemirror.txt, next to this file.",
  " *",
  ...copyrights.map((line) => ` * ${line}`),
  " *",
  ...permission.split("\n").map((line) => ` * ${line}`.trimEnd()),
  " */",
  "",
].join("\n");

const licenses = [
  "Third-party notices for web/vendor/codemirror.js.",
  "All of these packages are distributed under the MIT License.",
  "",
  ...packages.flatMap((p) => ["=".repeat(72), `${p.name} ${p.version}`, "=".repeat(72), p.text, ""]),
].join("\n");

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, banner + result.outputFiles[0].text);
writeFileSync(licenseFile, licenses);

const kb = (file) => (statSync(file).size / 1024).toFixed(1);
console.log(`web/vendor/codemirror.js: ${kb(outFile)} KB, ${packages.length} packages`);
