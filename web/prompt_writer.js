// 🌀 Prompt Writer: a hub node that has an LLM write an image prompt from an
// idea, an optional reference image and the user's own system prompt, and
// puts the result into the active Warp Send group's 🌀 Prompt + LoRAs.
//
// It exists only in the frontend (like Warp Select), so it never takes part in
// a queued prompt. Every network call goes through the /warppipe/llm routes;
// the browser never sees an API key.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";
import { forwardToCanvas } from "./compare_widget.js";
import { findTargetPrompt, formatStatus, modelLabel, stripTitles } from "./prompt_writer_core.js";

const NODE_ID = "Warp Prompt Writer";
const TITLE = "🌀 Prompt Writer";
const CATEGORY = "Custom/WarpPipe Nodes";
const SETTING_DIR = "WarpPipe.PromptWriter.SystemPromptDir";

const DEFAULT_BASE_URL = "https://nano-gpt.com/api/v1";
const DEFAULT_SIZE = [480, 720];
const MODEL_PROP = "model_id";
const NOT_LISTED = " (not listed)";
const FLASH_MS = 600;

const ACTIONS_H = 126;
const BUTTON_H = 26;
const STATUS_COLOR = "#bbb";
const ERROR_COLOR = "#f66";

function rootGraph() {
  return app.rootGraph ?? app.graph ?? null;
}

function redraw() {
  app.canvas?.setDirty?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function widgetNamed(node, name) {
  return (node.widgets ?? []).find((w) => w.name === name) ?? null;
}

/** Records the current graph as one undo step, where the frontend allows it. */
function checkpoint() {
  const tracker =
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker ??
    app.workflowManager?.activeWorkflow?.changeTracker;
  tracker?.checkState?.();
}

async function getJson(route, options) {
  const response = await api.fetchApi(route, options);
  let body;
  try {
    body = await response.json();
  } catch {
    return { error: `HTTP ${response.status}: no JSON answer` };
  }
  if (!response.ok && !body?.error) return { error: `HTTP ${response.status}` };
  return body ?? { error: "empty answer" };
}

/** A multiline STRING the way ComfyUI makes one, with a plain text fallback. */
function addMultiline(node, name) {
  const made = ComfyWidgets?.STRING?.(
    node,
    name,
    ["STRING", { multiline: true, default: "" }],
    app
  );
  const widget = made?.widget ?? widgetNamed(node, name);
  if (widget) return widget;
  return node.addWidget("text", name, "", () => {});
}

function makeButton(text, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  Object.assign(button.style, {
    flex: "1 1 0",
    minWidth: "0",
    height: `${BUTTON_H}px`,
    padding: "0 4px",
    borderRadius: "6px",
    border: "1px solid #555",
    background: "#2b2b2b",
    color: "#ddd",
    font: "13px sans-serif",
    cursor: "pointer",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function row(...children) {
  const div = document.createElement("div");
  Object.assign(div.style, { display: "flex", gap: "4px", width: "100%" });
  div.append(...children);
  return div;
}

function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

function registerNode() {
  const { LiteGraph, LGraphNode } = window;

  class PromptWriterNode extends LGraphNode {
    static title = TITLE;
    static category = CATEGORY;

    constructor(title) {
      super(title ?? TITLE);
      this.isVirtualNode = true;
      this.serialize_widgets = true;
      this.properties = this.properties ?? {};
      if (!(MODEL_PROP in this.properties)) this.properties[MODEL_PROP] = "";

      this._models = [];
      this._labelToId = new Map();
      this._systemPrompts = [];
      this._abort = null;
      this._loadTimer = null;

      this.addWidget("text", "base_url", DEFAULT_BASE_URL, () => {
        if (!app.configuringGraph) this.loadSoon();
      });

      const node = this;
      const modelOptions = {};
      Object.defineProperty(modelOptions, "values", {
        get: () => {
          const labels = node._models.map((m) => modelLabel(m));
          return labels.length ? labels : [node.modelWidget?.value ?? ""];
        },
        enumerable: true,
        configurable: true,
      });
      this.modelWidget = this.addWidget(
        "combo",
        "model",
        "",
        (value) => {
          const id = node._labelToId.get(value);
          if (id != null) node.properties[MODEL_PROP] = id;
        },
        modelOptions
      );

      const promptOptions = {};
      Object.defineProperty(promptOptions, "values", {
        get: () => {
          const names = [...node._systemPrompts];
          const current = node.promptWidget?.value;
          if (current && !names.includes(current)) names.unshift(current);
          return names.length ? names : [""];
        },
        enumerable: true,
        configurable: true,
      });
      this.promptWidget = this.addWidget("combo", "system_prompt", "", () => {}, promptOptions);

      this.addWidget("number", "temperature", 0.6, () => {}, {
        min: 0,
        max: 2,
        step: 0.5,
        step2: 0.05,
        round: 0.01,
        precision: 2,
      });

      this.referenceWidget = this.addWidget("text", "reference", "", () => {});

      this.ideaWidget = addMultiline(this, "idea");
      this.resultWidget = addMultiline(this, "result");

      this.addActions();
      this.size = [
        Math.max(DEFAULT_SIZE[0], this.size?.[0] ?? 0),
        Math.max(DEFAULT_SIZE[1], this.size?.[1] ?? 0),
      ];
      this.loadSoon();
    }

    /** Buttons and status line: one DOM widget, the same in both renderers. */
    addActions() {
      const root = document.createElement("div");
      Object.assign(root.style, {
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        width: "100%",
        height: `${ACTIONS_H}px`,
        boxSizing: "border-box",
      });
      this.writeButton = makeButton("write", () => this.write());
      const status = document.createElement("div");
      Object.assign(status.style, {
        font: "12px sans-serif",
        lineHeight: "18px",
        color: STATUS_COLOR,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      });
      this.statusEl = status;
      const keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.autocomplete = "off";
      keyInput.placeholder = "API key (saved in ComfyUI, never in the workflow)";
      Object.assign(keyInput.style, {
        flex: "3 1 0",
        minWidth: "0",
        height: `${BUTTON_H}px`,
        boxSizing: "border-box",
        padding: "0 6px",
        borderRadius: "6px",
        border: "1px solid #555",
        background: "#1e1e1e",
        color: "#ddd",
        font: "13px sans-serif",
      });
      keyInput.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") this.saveKey();
      });
      this.keyInput = keyInput;
      this.keyButton = makeButton("save key", () => this.saveKey());
      root.append(
        row(keyInput, this.keyButton),
        row(
          makeButton("reference…", () => this.uploadReference()),
          makeButton("clear reference", () => this.setReference("")),
          makeButton("refresh models", () => this.load(true))
        ),
        row(
          this.writeButton,
          makeButton("new", () => this.clearResult()),
          makeButton("from prompt", () => this.fromPrompt()),
          makeButton("use", () => this.use())
        ),
        status
      );
      forwardToCanvas(root, () => app.canvas?.canvas ?? null);
      const widget = this.addDOMWidget("prompt_writer_actions", "warp-prompt-writer", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => ACTIONS_H,
        getMaxHeight: () => ACTIONS_H,
      });
      if (widget) widget.serialize = false;
    }

    baseUrl() {
      return String(this.value("base_url") ?? "").trim() || DEFAULT_BASE_URL;
    }

    async refreshKeyStatus() {
      const out = await getJson(
        `/warppipe/llm/key_status?base_url=${encodeURIComponent(this.baseUrl())}`
      );
      if (!this.keyButton || out?.error) return;
      this.keyButton.textContent = out.set ? "key set ✓ (replace)" : "save key";
      this.keyButton.title = out.set ? `key from ${out.source}` : "";
    }

    /** Sends the typed key to the backend once; the field is cleared and never filled again. */
    async saveKey() {
      const key = this.keyInput?.value ?? "";
      if (!key.trim()) {
        this.setStatus("Type the API key into the field first", true);
        return;
      }
      const out = await getJson("/warppipe/llm/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_url: this.baseUrl(), key }),
      });
      if (this.keyInput) this.keyInput.value = "";
      if (out?.error) {
        this.setStatus(out.error, true);
        return;
      }
      this.setStatus("API key saved");
      this.refreshKeyStatus();
    }

    setStatus(text, isError = false) {
      if (!this.statusEl) return;
      this.statusEl.textContent = text ?? "";
      this.statusEl.title = text ?? "";
      this.statusEl.style.color = isError ? ERROR_COLOR : STATUS_COLOR;
    }

    value(name) {
      return widgetNamed(this, name)?.value;
    }

    setValue(widget, value) {
      if (!widget) return;
      widget.value = value;
      widget.callback?.(value);
      redraw();
    }

    setReference(name) {
      this.setValue(this.referenceWidget, name);
    }

    clearResult() {
      this.setValue(this.resultWidget, "");
      this.setStatus("");
      checkpoint();
    }

    onConfigure() {
      // Saved before properties.model_id existed: the combo held the id.
      if (!this.properties[MODEL_PROP] && this.modelWidget?.value) {
        const value = String(this.modelWidget.value);
        this.properties[MODEL_PROP] = value.endsWith(NOT_LISTED)
          ? value.slice(0, -NOT_LISTED.length)
          : value;
      }
      this.showModel();
      this.loadSoon();
    }

    onRemoved() {
      this._abort?.abort();
      clearTimeout(this._loadTimer);
    }

    loadSoon() {
      clearTimeout(this._loadTimer);
      this._loadTimer = setTimeout(() => this.load(false), 0);
    }

    selectedModel() {
      const id = this.properties[MODEL_PROP];
      return this._models.find((m) => m.id === id) ?? null;
    }

    /** Shows the stored model id as its label, or as "(not listed)". */
    showModel() {
      if (!this.modelWidget) return;
      const id = this.properties[MODEL_PROP];
      const model = this.selectedModel();
      const label = !id ? "" : model ? modelLabel(model) : `${id}${NOT_LISTED}`;
      if (this.modelWidget.value !== label) this.modelWidget.value = label;
      redraw();
    }

    async load(refresh) {
      this.refreshKeyStatus();
      const baseUrl = String(this.value("base_url") ?? "").trim() || DEFAULT_BASE_URL;
      this.setStatus("loading models…");
      const query = `base_url=${encodeURIComponent(baseUrl)}${refresh ? "&refresh=1" : ""}`;
      let models;
      let prompts;
      try {
        [models, prompts] = await Promise.all([
          getJson(`/warppipe/llm/models?${query}`),
          getJson("/warppipe/llm/system_prompts"),
        ]);
      } catch (error) {
        this.setStatus(`model list unreachable: ${error?.message ?? error}`, true);
        return;
      }

      const errors = [];
      if (models?.error) errors.push(models.error);
      else {
        this._models = Array.isArray(models?.models) ? models.models : [];
        this._labelToId = new Map(this._models.map((m) => [modelLabel(m), m.id]));
      }
      if (prompts?.error) errors.push(prompts.error);
      else {
        this._systemPrompts = Array.isArray(prompts?.names) ? prompts.names : [];
        if (!this.promptWidget.value && this._systemPrompts.length) {
          this.promptWidget.value = this._systemPrompts[0];
        }
      }
      this.showModel();
      if (errors.length) this.setStatus(errors.join(" · "), true);
      else this.setStatus(`${this._models.length} models`);
    }

    async uploadReference() {
      const file = await pickFile();
      if (!file) return;
      const body = new FormData();
      body.append("image", file);
      this.setStatus("uploading reference…");
      try {
        const response = await api.fetchApi("/upload/image", { method: "POST", body });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const name = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
        this.setReference(name);
        this.setStatus(`reference: ${name}`);
        checkpoint();
      } catch (error) {
        this.setStatus(`upload failed: ${error?.message ?? error}`, true);
      }
    }

    async write() {
      if (this._abort) {
        this._abort.abort();
        return;
      }
      const model = this.properties[MODEL_PROP];
      if (!model) {
        this.setStatus("Pick a model first", true);
        return;
      }
      const idea = String(this.ideaWidget?.value ?? "");
      const previous = String(this.resultWidget?.value ?? "");
      if (!idea.trim() && !previous.trim()) {
        this.setStatus("Write an idea first", true);
        return;
      }

      let reference = String(this.referenceWidget?.value ?? "").trim();
      let notice = "";
      if (reference && !this.selectedModel()?.vision) {
        reference = "";
        notice = "reference ignored: model has no vision";
      }

      const payload = {
        base_url: String(this.value("base_url") ?? "").trim() || DEFAULT_BASE_URL,
        model,
        system_prompt: String(this.promptWidget?.value ?? ""),
        temperature: Number(this.value("temperature") ?? 0.6),
        idea,
        previous_result: previous.trim() ? previous : "",
        reference: reference || null,
      };

      const controller = new AbortController();
      this._abort = controller;
      this.writeButton.textContent = "writing…";
      this.setStatus(notice ? `${notice} · writing…` : "writing…");
      try {
        const out = await getJson("/warppipe/llm/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (out?.error) {
          this.setStatus(out.error, true);
        } else {
          this.setValue(this.resultWidget, String(out?.text ?? ""));
          const status = formatStatus(out ?? {});
          this.setStatus(notice ? `${status} · ${notice}` : status);
          checkpoint();
        }
      } catch (error) {
        if (error?.name === "AbortError") this.setStatus("cancelled");
        else this.setStatus(String(error?.message ?? error), true);
      } finally {
        this._abort = null;
        this.writeButton.textContent = "write";
      }
    }

    target() {
      const root = rootGraph();
      if (!root) return { error: "No graph" };
      const found = findTargetPrompt(root);
      if (found.error) return found;
      const text = widgetNamed(found.node, "text");
      if (!text) return { error: `The prompt in "${found.group}" has no text widget` };
      return { ...found, text };
    }

    fromPrompt() {
      const found = this.target();
      if (found.error) {
        this.setStatus(found.error, true);
        return;
      }
      this.setValue(this.ideaWidget, String(found.text.value ?? ""));
      this.setStatus(`idea from "${found.group}"`);
      checkpoint();
    }

    use() {
      const found = this.target();
      if (found.error) {
        this.setStatus(found.error, true);
        return;
      }
      const value = stripTitles(String(this.resultWidget?.value ?? ""));
      if (!value) {
        this.setStatus("Nothing to use: the result is empty", true);
        return;
      }
      found.text.value = value;
      found.text.callback?.(value);
      flash(found.node);
      redraw();
      checkpoint();
      this.setStatus(`used in "${found.group}"`);
    }
  }

  LiteGraph.registerNodeType(NODE_ID, PromptWriterNode);
}

function flash(node) {
  const before = node.boxcolor;
  node.boxcolor = "#6f6";
  redraw();
  setTimeout(() => {
    node.boxcolor = before;
    redraw();
  }, FLASH_MS);
}

app.registerExtension({
  name: "WarpPipe.PromptWriter",
  settings: [
    {
      id: SETTING_DIR,
      name: "System prompt folder",
      type: "text",
      defaultValue: "",
      category: ["WarpPipe", "Prompt Writer", "System prompt folder"],
      tooltip:
        "Folder of system prompts for 🌀 Prompt Writer. Only .txt files directly in this folder are listed.",
    },
  ],
  registerCustomNodes() {
    registerNode();
  },
});
