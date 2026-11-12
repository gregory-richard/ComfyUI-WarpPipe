import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHATS_FILE,
  CURRENT_PROMPT,
  NEW_PROMPT,
  addVersion,
  clearFailure,
  recordFailure,
  dropQuestion,
  openQuestion,
  startLabel,
  startOptions,
  startValue,
  baseText,
  createChat,
  deleteChat,
  emptyStore,
  isStore,
  latestChatFor,
  mergedDraft,
  normalizeStore,
  renameChat,
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
    targetLabel: null,
    versions: [],
    pending: null,
    failure: null,
  });
  assert.equal(store.chats[0], chat);
  assert.equal(createChat(store, { id: "b", now: 6, seedPrompt: "seed" }).seedPrompt, "seed");
  assert.equal(store.chats.length, 2);
});

test("createChat accepts the label of its target", () => {
  const chat = createChat(emptyStore(), { id: "a", now: 5, targetLabel: "Hero" });
  assert.equal(chat.targetLabel, "Hero");
});

test("normalizeStore keeps a chat's targetLabel and defaults a missing one", () => {
  const raw = {
    version: 1,
    chats: [
      { id: "a", versions: [], targetLabel: "Hero" },
      { id: "b", versions: [] },
      { id: "c", versions: [], targetLabel: 7 },
    ],
  };
  assert.deepEqual(
    normalizeStore(raw).chats.map((c) => c.targetLabel),
    ["Hero", null, null]
  );
});

test("latestChatFor finds the most recently updated chat with that label", () => {
  const store = emptyStore();
  createChat(store, { id: "old", now: 1, targetLabel: "Hero" });
  createChat(store, { id: "new", now: 3, targetLabel: "Hero" });
  createChat(store, { id: "other", now: 9, targetLabel: "Sky" });
  createChat(store, { id: "none", now: 10 });
  assert.equal(latestChatFor(store, "Hero").id, "new");
  assert.equal(latestChatFor(store, "Sky").id, "other");
  assert.equal(latestChatFor(store, "Gone"), null);
});

test("latestChatFor never matches an unknown label to a chat without one", () => {
  const store = emptyStore();
  createChat(store, { id: "none", now: 10 });
  assert.equal(latestChatFor(store, null), null);
  assert.equal(latestChatFor(store, undefined), null);
});

const SUGGESTION = {
  id: "sub/soft.safetensors",
  name: "soft",
  title: "Soft Light",
  tag: "soft",
  thumbnail: "/t?name=soft",
  triggers: ["softlight"],
  strength: 0.75,
  reason: "adds light",
};

test("addVersion stores its suggestions as copies", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  const given = [{ ...SUGGESTION, triggers: ["softlight"] }];
  const v = addVersion(chat, version("v1", 2, { suggestions: given }));
  assert.deepEqual(v.suggestions, [SUGGESTION]);
  given[0].triggers.push("changed");
  assert.deepEqual(v.suggestions[0].triggers, ["softlight"]);
});

test("a version remembers which LoRAs were active when it was written", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  assert.deepEqual(addVersion(chat, version("v1", 2)).activeLoras, []);
  const v = addVersion(chat, version("v2", 3, { activeLoras: [SUGGESTION] }));
  assert.deepEqual(v.activeLoras, [SUGGESTION]);
  const raw = { version: 1, chats: [{ id: "c", versions: [{ id: "v", text: "t" }] }] };
  assert.deepEqual(normalizeStore(raw).chats[0].versions[0].activeLoras, []);
  raw.chats[0].versions[0].activeLoras = [SUGGESTION, { id: "x" }];
  assert.deepEqual(normalizeStore(raw).chats[0].versions[0].activeLoras, [SUGGESTION]);
});

test("addVersion defaults to no suggestions", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  assert.deepEqual(addVersion(chat, version("v1", 2)).suggestions, []);
});

function storeWithSuggestions(suggestions) {
  return {
    version: 1,
    chats: [{ id: "c", versions: [{ id: "v", text: "t", suggestions }] }],
  };
}

test("normalizeStore keeps well-formed suggestions", () => {
  const out = normalizeStore(storeWithSuggestions([SUGGESTION]));
  assert.deepEqual(out.chats[0].versions[0].suggestions, [SUGGESTION]);
});

test("normalizeStore tolerates versions without suggestions", () => {
  const out = normalizeStore({ version: 1, chats: [{ id: "c", versions: [{ id: "v", text: "t" }] }] });
  assert.deepEqual(out.chats[0].versions[0].suggestions, []);
  const odd = normalizeStore(storeWithSuggestions("nope"));
  assert.deepEqual(odd.chats[0].versions[0].suggestions, []);
});

test("normalizeStore drops malformed suggestions and repairs the optional fields", () => {
  const out = normalizeStore(
    storeWithSuggestions([
      null,
      "x",
      { ...SUGGESTION, tag: "" },
      { ...SUGGESTION, id: 3 },
      { ...SUGGESTION, strength: "0.8" },
      { id: "a", tag: "a", strength: 1, triggers: ["t", 4], thumbnail: 7 },
    ])
  );
  assert.deepEqual(out.chats[0].versions[0].suggestions, [
    {
      id: "a",
      name: "",
      title: "",
      tag: "a",
      thumbnail: null,
      triggers: ["t"],
      strength: 1,
      reason: "",
    },
  ]);
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
    suggestions: [],
    activeLoras: [],
    questions: [],
    basePrompt: null,
    reasoning: "",
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

test("isStore tells a store this version can read from anything else", () => {
  assert.equal(isStore(emptyStore()), true);
  for (const raw of [null, [], {}, { version: 2, chats: [] }, { version: 1, chats: {} }]) {
    assert.equal(isStore(raw), false);
  }
});

test("mergedDraft: a request put back joins what was already typed", () => {
  const empty = { text: "", images: [] };
  assert.deepEqual(mergedDraft(empty, { text: "back", images: ["a"] }, 8), {
    text: "back",
    images: ["a"],
    overflow: false,
  });
  assert.deepEqual(
    mergedDraft({ text: "typed", images: ["b", "a"] }, { text: "back", images: ["a"] }, 8),
    { text: "back\n\ntyped", images: ["a", "b"], overflow: false }
  );
  assert.equal(mergedDraft({ text: "  ", images: [] }, { text: "back", images: [] }, 8).text, "back");
  assert.equal(mergedDraft({ text: "typed", images: [] }, { text: "", images: [] }, 8).text, "typed");
});

test("mergedDraft says when the images no longer fit", () => {
  const out = mergedDraft({ text: "", images: ["c", "d"] }, { text: "", images: ["a", "b"] }, 3);
  assert.deepEqual(out.images, ["a", "b", "c"]);
  assert.equal(out.overflow, true);
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
    suggestions: [],
    activeLoras: [],
    questions: [],
    basePrompt: null,
    reasoning: "",
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

// --- steps, questions and where a step starts -------------------------------------

test("a version keeps the questions on the way and the prompt it started from", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  const turns = [{ question: "Q", answer: "A" }];
  const v = addVersion(
    chat,
    version("v1", 2, { questions: turns, basePrompt: "THE PROMPT", baseId: CURRENT_PROMPT })
  );
  assert.deepEqual(v.questions, [{ question: "Q", answer: "A" }]);
  assert.equal(v.basePrompt, "THE PROMPT");
  turns[0].answer = "changed";
  assert.equal(v.questions[0].answer, "A");
  const raw = JSON.parse(JSON.stringify({ version: 1, chats: [chat] }));
  raw.chats[0].versions[0].questions.push({ question: "", answer: "x" }, { question: "Q2" }, "junk");
  assert.deepEqual(normalizeStore(raw).chats[0].versions[0].questions, [
    { question: "Q", answer: "A" },
  ]);
});

test("openQuestion puts a step on hold, dropQuestion takes it back", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  const step = { request: "warmer", images: ["a.png"], baseId: "v1", basePrompt: null, turns: [] };
  const pending = openQuestion(chat, step, "Sun in frame?", 5);
  assert.deepEqual(pending, {
    request: "warmer",
    images: ["a.png"],
    baseId: "v1",
    basePrompt: null,
    turns: [],
    question: "Sun in frame?",
  });
  assert.equal(chat.updated, 5);
  step.images.push("b.png");
  assert.deepEqual(chat.pending.images, ["a.png"]);
  assert.equal(dropQuestion(chat), pending);
  assert.equal(chat.pending, null);
  assert.equal(dropQuestion(chat), null);
});

test("normalizeStore keeps a step that waits for an answer, and drops a broken one", () => {
  const store = emptyStore();
  const chat = createChat(store, { id: "c", now: 1 });
  const turns = [{ question: "Q", answer: "A" }];
  openQuestion(chat, { request: "r", images: [], baseId: null, basePrompt: "P", turns }, "Q2", 2);
  assert.deepEqual(normalizeStore(JSON.parse(JSON.stringify(store))), store);
  for (const pending of [null, "x", {}, { question: "" }, { request: "r" }]) {
    const raw = { version: 1, chats: [{ id: "c", versions: [], pending }] };
    assert.equal(normalizeStore(raw).chats[0].pending, null);
  }
});

test("startOptions: edit a version, newest first, or the current prompt, or write a new one", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  assert.deepEqual(startOptions(chat, "Krea 2"), [
    { value: CURRENT_PROMPT, label: "Edit current prompt (Krea 2)" },
    { value: NEW_PROMPT, label: "New prompt" },
  ]);
  addVersion(chat, version("v1", 2, { request: "a red bicycle by the lake at dawn please" }));
  addVersion(chat, version("v2", 3, { request: "" }));
  addVersion(chat, version("v3", 4));
  assert.deepEqual(
    startOptions(chat, null).map((o) => o.label),
    [
      "Edit v3 (newest)",
      "Edit v2 (optimised)",
      "Edit v1 (a red bicycle by the lake)",
      "Edit current prompt (the For node)",
      "New prompt",
    ]
  );
  assert.deepEqual(
    startOptions(chat, null).map((o) => o.value),
    ["v3", "v2", "v1", CURRENT_PROMPT, NEW_PROMPT]
  );
});

test("startValue: a draft's choice while it exists, else the newest version, else nothing", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  assert.equal(startValue(chat, null), NEW_PROMPT);
  assert.equal(startValue(chat, CURRENT_PROMPT), CURRENT_PROMPT);
  addVersion(chat, version("v1", 2));
  addVersion(chat, version("v2", 3));
  assert.equal(startValue(chat, null), "v2");
  assert.equal(startValue(chat, "v1"), "v1");
  assert.equal(startValue(chat, "gone"), "v2");
  assert.equal(startValue(chat, NEW_PROMPT), NEW_PROMPT);
});

test("startLabel says where a step started", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  addVersion(chat, version("v1", 2));
  assert.equal(startLabel(chat, "v1"), "edit of v1");
  assert.equal(startLabel(chat, CURRENT_PROMPT), "edit of the current prompt");
  assert.equal(startLabel(chat, "seed"), "edit of the current prompt");
  assert.equal(startLabel(chat, null), "new prompt");
  assert.equal(startLabel(chat, "gone"), "new prompt");
});

test("a version keeps what the model thought, and an old one has nothing", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  assert.equal(addVersion(chat, version("v1", 2, { reasoning: "why" })).reasoning, "why");
  const raw = { version: 1, chats: [{ id: "c", versions: [{ id: "v", text: "t" }] }] };
  assert.equal(normalizeStore(raw).chats[0].versions[0].reasoning, "");
  raw.chats[0].versions[0].reasoning = 5;
  assert.equal(normalizeStore(raw).chats[0].versions[0].reasoning, "");
});

// --- a failed request survives a reload ---------------------------------------------

const FAILED = {
  request: "warmer light",
  images: ["a.png"],
  baseId: "v1",
  basePrompt: null,
  turns: [{ question: "Q", answer: "A" }],
  answer: "A",
  originNode: { id: 7 },
  loraRefs: new Map(),
  payload: { idea: "warmer light" },
};

test("recordFailure keeps what a Retry needs, and nothing that only lives in the page", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  recordFailure(chat, FAILED, "Insufficient balance", 5);
  assert.deepEqual(chat.failure, {
    request: "warmer light",
    images: ["a.png"],
    baseId: "v1",
    basePrompt: null,
    turns: [{ question: "Q", answer: "A" }],
    answer: "A",
    message: "Insufficient balance",
  });
  assert.equal(chat.updated, 5);
  FAILED.images.push("b.png");
  assert.deepEqual(chat.failure.images, ["a.png"]);
  FAILED.images.pop();
});

test("clearFailure says whether there was one to clear", () => {
  const chat = createChat(emptyStore(), { id: "c", now: 1 });
  assert.equal(clearFailure(chat), false);
  recordFailure(chat, FAILED, "x", 2);
  assert.equal(clearFailure(chat), true);
  assert.equal(chat.failure, null);
});

test("normalizeStore keeps a saved failure, and drops a broken one", () => {
  const store = emptyStore();
  const chat = createChat(store, { id: "c", now: 1 });
  recordFailure(chat, { request: "r" }, "Timed out", 2);
  assert.deepEqual(normalizeStore(JSON.parse(JSON.stringify(store))), store);
  assert.deepEqual(chat.failure, {
    request: "r",
    images: [],
    baseId: null,
    basePrompt: null,
    turns: [],
    answer: null,
    message: "Timed out",
  });
  for (const failure of [null, "x", {}, { request: "r" }, { message: "m" }, { request: 3, message: "m" }]) {
    const raw = { version: 1, chats: [{ id: "c", versions: [], failure }] };
    assert.equal(normalizeStore(raw).chats[0].failure, null);
  }
});
