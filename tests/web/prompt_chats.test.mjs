import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHATS_FILE,
  addVersion,
  baseText,
  createChat,
  deleteChat,
  emptyStore,
  normalizeStore,
  renameChat,
  rewindChat,
  setAutoTitle,
  sortedChats,
  titleFrom,
} from "../../web/prompt_chats.js";

function version(id, now, extra = {}) {
  return {
    id,
    now,
    request: `ask ${id}`,
    text: `text ${id}`,
    model: "m",
    systemPrompt: "s",
    ...extra,
  };
}

function chatWith(...ids) {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  ids.forEach((id, i) => addVersion(chat, version(id, 10 + i)));
  return chat;
}

const ids = (chats) => chats.map((c) => c.id);

test("CHATS_FILE and emptyStore", () => {
  assert.equal(CHATS_FILE, "warppipe_prompt_chats.json");
  assert.deepEqual(emptyStore(), { version: 1, chats: [] });
  assert.notEqual(emptyStore().chats, emptyStore().chats);
});

test("createChat adds a fresh chat to the store", () => {
  const store = emptyStore();
  const chat = createChat(store, { id: "a", now: 5 });
  assert.deepEqual(chat, {
    id: "a",
    title: "New chat",
    titleEdited: false,
    created: 5,
    updated: 5,
    seedPrompt: null,
    versions: [],
  });
  assert.equal(store.chats[0], chat);
  assert.equal(createChat(store, { id: "b", now: 6, seedPrompt: "seed" }).seedPrompt, "seed");
  assert.equal(store.chats.length, 2);
});

test("addVersion fills every field and numbers from 1", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  const v = addVersion(chat, {
    id: "v1",
    now: 7,
    request: "a red fox",
    images: ["fox.png [input]"],
    baseId: "seed",
    text: "PROMPT",
    model: "m",
    systemPrompt: "s.txt",
    cost: 0.1,
    seconds: 2,
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  assert.deepEqual(v, {
    id: "v1",
    n: 1,
    created: 7,
    request: "a red fox",
    images: ["fox.png [input]"],
    baseId: "seed",
    text: "PROMPT",
    model: "m",
    systemPrompt: "s.txt",
    cost: 0.1,
    seconds: 2,
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  assert.equal(chat.versions[0], v);
  assert.equal(chat.updated, 7);
  assert.equal(chat.created, 1);
  assert.equal(addVersion(chat, version("v2", 8)).n, 2);
});

test("addVersion defaults", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  const v = addVersion(chat, version("v", 2));
  assert.deepEqual(v.images, []);
  assert.equal(v.baseId, null);
  assert.equal(v.cost, null);
  assert.equal(v.seconds, null);
  assert.deepEqual(v.usage, {});
});

test("addVersion keeps its own copy of images and usage", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  const images = ["a.png"];
  const usage = { prompt_tokens: 1 };
  const v = addVersion(chat, version("v", 2, { images, usage }));
  images.push("b.png");
  usage.prompt_tokens = 9;
  assert.deepEqual(v.images, ["a.png"]);
  assert.deepEqual(v.usage, { prompt_tokens: 1 });
});

test("the first version names the chat, a later one does not", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  addVersion(chat, version("v1", 2, { request: "a red fox in snow" }));
  assert.equal(chat.title, "a red fox in snow");
  addVersion(chat, version("v2", 3, { request: "make it blue instead" }));
  assert.equal(chat.title, "a red fox in snow");
});

test("a chat renamed before its first version keeps that name", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  renameChat(chat, "Mine");
  addVersion(chat, version("v1", 2));
  assert.equal(chat.title, "Mine");
});

test("titleFrom", () => {
  assert.equal(titleFrom("one two three"), "one two three");
  assert.equal(titleFrom("one two three four five six seven eight"), "one two three four five six");
  assert.equal(titleFrom("  spaced \n\t out   words "), "spaced out words");
  assert.equal(titleFrom(""), "New chat");
  assert.equal(titleFrom("   "), "New chat");
  assert.equal(titleFrom(null), "New chat");
  assert.equal(titleFrom(undefined), "New chat");
  assert.equal(titleFrom("x".repeat(60)), "x".repeat(40));
  const words = titleFrom("abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij");
  assert.ok(words.length <= 40);
  assert.equal(words, words.trim());
});

test("titleFrom never ends on half an emoji", () => {
  assert.equal(titleFrom("x".repeat(39) + "🦊"), "x".repeat(39));
});

test("baseText: seed", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1, seedPrompt: "SEED" });
  addVersion(chat, version("v1", 2));
  assert.equal(baseText(chat, "seed"), "SEED");
  assert.equal(baseText(chatWith("v1"), "seed"), null);
});

test("baseText: a version id, including an older one", () => {
  const chat = chatWith("v1", "v2", "v3");
  assert.equal(baseText(chat, "v1"), "text v1");
  assert.equal(baseText(chat, "v2"), "text v2");
  assert.equal(baseText(chat, "nope"), null);
});

test("baseText: null means newest, else seed, else nothing", () => {
  assert.equal(baseText(chatWith("v1", "v2"), null), "text v2");
  assert.equal(baseText(chatWith("v1", "v2"), undefined), "text v2");
  const seeded = createChat(emptyStore(), { id: "c", now: 1, seedPrompt: "SEED" });
  assert.equal(baseText(seeded, null), "SEED");
  assert.equal(baseText(chatWith(), null), null);
});

test("a version based on an older one becomes the newest", () => {
  const chat = chatWith("v1", "v2");
  const v3 = addVersion(chat, version("v3", 20, { baseId: "v1" }));
  assert.equal(v3.baseId, "v1");
  assert.equal(v3.n, 3);
  assert.equal(baseText(chat, null), "text v3");
  assert.equal(baseText(chat, v3.baseId), "text v1");
});

test("renameChat", () => {
  const chat = chatWith();
  renameChat(chat, "  Named  ");
  assert.equal(chat.title, "Named");
  assert.equal(chat.titleEdited, true);
  const untouched = chatWith();
  renameChat(untouched, "   ");
  renameChat(untouched, "");
  renameChat(untouched, null);
  assert.equal(untouched.title, "New chat");
  assert.equal(untouched.titleEdited, false);
});

test("deleteChat", () => {
  const store = emptyStore();
  createChat(store, { id: "a", now: 1 });
  createChat(store, { id: "b", now: 2 });
  assert.equal(deleteChat(store, "a"), true);
  assert.deepEqual(ids(store.chats), ["b"]);
  assert.equal(deleteChat(store, "a"), false);
});

test("sortedChats: newest updated first, without changing the store", () => {
  const store = emptyStore();
  const a = createChat(store, { id: "a", now: 1 });
  createChat(store, { id: "b", now: 2 });
  createChat(store, { id: "c", now: 3 });
  addVersion(a, version("v", 10));
  assert.deepEqual(ids(sortedChats(store)), ["a", "c", "b"]);
  assert.deepEqual(ids(store.chats), ["a", "b", "c"]);
});

test("sortedChats: ISO timestamps sort by time too", () => {
  const store = emptyStore();
  createChat(store, { id: "old", now: "2026-11-08T09:00:00.000Z" });
  createChat(store, { id: "new", now: "2026-11-08T10:00:00.000Z" });
  assert.deepEqual(ids(sortedChats(store)), ["new", "old"]);
});

test("normalizeStore: junk gives an empty store", () => {
  const junk = [
    null,
    undefined,
    0,
    "x",
    true,
    [],
    {},
    { chats: "x" },
    { chats: [] },
    { version: 2, chats: [] },
    { version: "1", chats: [] },
    { version: 1 },
    { version: 1, chats: {} },
  ];
  for (const raw of junk) assert.deepEqual(normalizeStore(raw), emptyStore());
});

test("normalizeStore: a valid store survives unchanged", () => {
  const store = emptyStore();
  const chat = createChat(store, { id: "c", now: 1, seedPrompt: "S" });
  addVersion(chat, version("v1", 2, { images: ["a.png"], cost: 0.5, seconds: 3 }));
  addVersion(chat, version("v2", 3, { baseId: "v1", usage: { prompt_tokens: 4 } }));
  renameChat(chat, "Named");
  assert.deepEqual(normalizeStore(JSON.parse(JSON.stringify(store))), store);
});

test("normalizeStore: drops malformed chats", () => {
  const out = normalizeStore({
    version: 1,
    chats: [
      null,
      1,
      "x",
      [],
      {},
      { id: 5, versions: [] },
      { id: "", versions: [] },
      { id: "noVersions" },
      { id: "badVersions", versions: "x" },
      { id: "ok", versions: [] },
    ],
  });
  assert.deepEqual(ids(out.chats), ["ok"]);
});

test("normalizeStore: drops malformed versions and renumbers", () => {
  const out = normalizeStore({
    version: 1,
    chats: [
      {
        id: "c",
        versions: [
          { id: "v1", text: "one", n: 1 },
          null,
          { id: "noText" },
          { text: "noId" },
          { id: "v3", text: "three", n: 5 },
        ],
      },
    ],
  });
  assert.deepEqual(
    out.chats[0].versions.map((v) => [v.id, v.n]),
    [
      ["v1", 1],
      ["v3", 2],
    ]
  );
});

test("normalizeStore: repairs the fields it can", () => {
  const out = normalizeStore({
    version: 1,
    chats: [
      {
        id: "c",
        title: 5,
        titleEdited: "yes",
        created: {},
        updated: null,
        seedPrompt: 7,
        versions: [
          {
            id: "v",
            text: "t",
            request: 4,
            images: "x",
            baseId: 3,
            model: null,
            systemPrompt: {},
            cost: "free",
            seconds: "long",
            usage: [],
          },
        ],
      },
    ],
  });
  const [chat] = out.chats;
  assert.equal(chat.title, "New chat");
  assert.equal(chat.titleEdited, false);
  assert.equal(chat.created, 0);
  assert.equal(chat.updated, 0);
  assert.equal(chat.seedPrompt, null);
  assert.deepEqual(chat.versions[0], {
    id: "v",
    n: 1,
    created: 0,
    request: "",
    images: [],
    baseId: null,
    text: "t",
    model: "",
    systemPrompt: "",
    cost: null,
    seconds: null,
    usage: {},
  });
});

test("normalizeStore: drops junk image entries, keeps names and objects", () => {
  const images = ["a.png", { name: "b.png" }, 3, null, "", []];
  const out = normalizeStore({
    version: 1,
    chats: [{ id: "c", versions: [{ id: "v", text: "t", images }] }],
  });
  assert.deepEqual(out.chats[0].versions[0].images, ["a.png", { name: "b.png" }]);
});

test("normalizeStore: duplicate ids keep the first", () => {
  const out = normalizeStore({
    version: 1,
    chats: [
      {
        id: "c",
        title: "first",
        versions: [
          { id: "v", text: "a" },
          { id: "v", text: "b" },
        ],
      },
      { id: "c", title: "second", versions: [] },
    ],
  });
  assert.equal(out.chats.length, 1);
  assert.equal(out.chats[0].title, "first");
  assert.deepEqual(
    out.chats[0].versions.map((v) => v.text),
    ["a"]
  );
});

test("normalizeStore does not share objects with its input", () => {
  const raw = {
    version: 1,
    chats: [{ id: "c", versions: [{ id: "v", text: "t", images: ["a"] }] }],
  };
  const out = normalizeStore(raw);
  out.chats[0].versions[0].images.push("b");
  out.chats[0].title = "changed";
  assert.deepEqual(raw.chats[0].versions[0].images, ["a"]);
  assert.equal(raw.chats[0].title, undefined);
});

test("rewindChat removes the version and everything after it", () => {
  const store = emptyStore();
  const chat = createChat(store, { id: "c", now: 1 });
  for (const n of [1, 2, 3]) {
    addVersion(chat, { id: `v${n}`, now: n, request: `r${n}`, images: [], text: `t${n}` });
  }
  const removed = rewindChat(chat, "v2", 9);
  assert.equal(removed.request, "r2");
  assert.deepEqual(
    chat.versions.map((v) => v.id),
    ["v1"]
  );
  assert.equal(chat.updated, 9);
  assert.equal(baseText(chat, null), "t1");
});

test("rewindChat on the first version empties the chat and the next one retitles it", () => {
  const store = emptyStore();
  const chat = createChat(store, { id: "c", now: 1 });
  addVersion(chat, { id: "v1", now: 1, request: "first idea", images: [], text: "t" });
  rewindChat(chat, "v1", 2);
  assert.equal(chat.versions.length, 0);
  const next = addVersion(chat, { id: "v2", now: 3, request: "other idea", images: [], text: "x" });
  assert.equal(next.n, 1);
  assert.equal(chat.title, "other idea");
});

test("rewindChat ignores an unknown version", () => {
  const store = emptyStore();
  const chat = createChat(store, { id: "c", now: 1 });
  addVersion(chat, { id: "v1", now: 1, request: "r", images: [], text: "t" });
  assert.equal(rewindChat(chat, "nope", 2), null);
  assert.equal(chat.versions.length, 1);
  assert.equal(chat.updated, 1);
});

test("setAutoTitle replaces an automatic title but never one the user typed", () => {
  const store = emptyStore();
  const chat = createChat(store, { id: "c", now: 1 });
  assert.equal(setAutoTitle(chat, "Red bicycle"), true);
  assert.equal(chat.title, "Red bicycle");
  assert.equal(chat.updated, 1);
  assert.equal(setAutoTitle(chat, "  "), false);
  renameChat(chat, "Mine");
  assert.equal(setAutoTitle(chat, "Other"), false);
  assert.equal(chat.title, "Mine");
});
