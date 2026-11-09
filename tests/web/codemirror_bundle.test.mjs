import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);

test("importing the bundle touches nothing on the page", async () => {
  // ComfyUI imports every .js under web/ as an extension, this one included.
  const untouchable = (name) => () => {
    throw new Error(`${name} used while importing the bundle`);
  };
  const before = new Set(Object.keys(globalThis));
  const body = { appendChild: untouchable("body.appendChild") };
  globalThis.document = {
    documentElement: { style: {} },
    head: { appendChild: untouchable("head.appendChild") },
    body,
    createElement: untouchable("createElement"),
    addEventListener: untouchable("document.addEventListener"),
    querySelector: untouchable("querySelector"),
  };
  globalThis.window = { addEventListener: untouchable("window.addEventListener") };
  try {
    const cm = await import(new URL("web/vendor/codemirror.js", root).href);
    for (const name of ["EditorView", "EditorState", "foldService", "foldGutter", "history"]) {
      assert.ok(cm[name], `${name} is exported`);
    }
    assert.equal(cm.default, undefined);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
  const added = Object.keys(globalThis).filter((key) => !before.has(key));
  assert.deepEqual(added, []);
});

test("the bundle carries the MIT notice, and the licence file sits next to it", () => {
  const bundle = readFileSync(new URL("web/vendor/codemirror.js", root), "utf8");
  const head = bundle.slice(0, 4000);
  assert.match(head, /Permission is hereby granted, free of charge/);
  assert.match(head, /Copyright \(C\) .* Marijn Haverbeke/);
  assert.match(head, /@codemirror\/view@/);

  const licenses = readFileSync(new URL("web/vendor/LICENSE-codemirror.txt", root), "utf8");
  for (const name of ["@codemirror/view", "@codemirror/state", "@lezer/common", "style-mod"]) {
    assert.ok(licenses.includes(name), `${name} is listed`);
  }
});

test("a wheel ships the bundle and its licence", () => {
  const pyproject = readFileSync(new URL("pyproject.toml", root), "utf8");
  assert.match(pyproject, /"web\/vendor\/\*\.js"/);
  assert.match(pyproject, /"web\/vendor\/LICENSE-codemirror\.txt"/);
});
