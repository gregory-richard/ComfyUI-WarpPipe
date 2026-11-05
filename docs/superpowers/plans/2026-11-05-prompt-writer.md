# Prompt Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single hub node, 🌀 Prompt Writer. It sends an idea, an optional reference image and the user's system-prompt file to an OpenAI-compatible LLM (NanoGPT by default), shows the result, and with **use** writes it into the active Warp Send group's 🌀 Prompt + LoRAs.

**Architecture:**
- **Backend:** a stdlib-only module `prompt_writer.py` holds all HTTP and secret handling. It covers the model list, the chat call, key-to-host binding and system-prompt files, and can be tested without ComfyUI or aiohttp.
- **Routes:** thin aiohttp handlers in `warp_pipe._register_routes` expose it.
- **Frontend:** a virtual frontend node, `web/prompt_writer.js`, is built like Warp Select. Its pure logic lives in `web/prompt_writer_core.js` and is unit-tested with `node --test`.

**Tech Stack:**
- Python 3.9+ stdlib: `urllib.request`, `json`, `base64`, `http.server` for tests.
- aiohttp routes, only inside ComfyUI.
- LiteGraph/ComfyUI frontend 1.57 ES modules.
- `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-05-prompt-writer-design.md`

## Global Constraints

- **Branch:** `feat/prompt-writer`, which is based on `feat/warp-send-select`. Commit there only and never push.
- **No new Python dependencies.** `prompt_writer.py` imports only the stdlib, so the local test Python has no aiohttp.
- **Default `base_url`:** `https://nano-gpt.com/api/v1`. The model list is `GET {base_url}/models?detailed=true` and the chat is `POST {base_url}/chat/completions`.
- **API keys:**
  - A key is used only when the request URL's host equals the key's host.
  - `NANOGPT_API_KEY` applies to the hosts `nano-gpt.com` and `api.nano-gpt.com`.
  - Optionally, `<ComfyUI user dir>/warppipe_llm_keys.json` holds `{"host": "key"}`.
  - Keys are never logged, returned or written.
- **Plain `http://`** is allowed only for the hosts `localhost`, `127.0.0.1` and `::1`; anything else is rejected before any request.
- **System-prompt folder:** the ComfyUI setting `WarpPipe.PromptWriter.SystemPromptDir`. Only `.txt` files directly inside it are listed or read, and a name containing `/`, `\` or `..` is refused.
- **Timeouts:** the chat call has a 180 s timeout and the model list a 30 s timeout. The model list is cached per `base_url` for 3600 s, and `refresh=1` bypasses the cache.
- **Defaults:** `temperature` is 0.6 (FLOAT 0–2, step 0.05). The node's title is `🌀 Prompt Writer` and its type is `Warp Prompt Writer`.
- **English UI.**
- **Status line format:** `0.3 ¢ · 8 s · 1,812 → 640 tokens`, with the cost part omitted when the cost is null.
- **use:**
  - Removes every line whose first non-blank characters are `//`.
  - Collapses runs of two or more blank lines into one.
  - Trims the text.

## Review Focus

1. **NanoGPT behind Cloudflare** rejects the default `Python-urllib` User-Agent. Every request sends `User-Agent: ComfyUI-WarpPipe/<version.txt>` (test in Task 1).
2. **Thinking models** return `reasoning`/`reasoning_content` and sometimes inline `<think>…</think>`, or only a reasoning field and empty `content`. The result must be the visible answer, and an empty answer is the error "The model returned no text" (test in Task 1).
3. **A shared or downloaded workflow sets `base_url` to a foreign host.** No key may be sent there, even though the user's NanoGPT key exists (test in Task 1).
4. **Provider error bodies** (HTTP 4xx/5xx with JSON `{"error": {"message": …}}` or plain text, such as insufficient balance or content refused) must surface as that message. They must never become a Python traceback or an empty string (test in Task 1).
5. **The active group's Prompt + LoRAs sits inside a subgraph, or the group has two of them** (ZIT+ZIB). The link walk must cross subgraph boundaries, and two distinct prompts are an error that names the group (test in Task 3).

---

### Task 1: `prompt_writer.py` core (stdlib, no ComfyUI)

**Files:**
- Create: `prompt_writer.py`
- Test: `tests/test_prompt_writer.py`

**Interfaces:**
- Produces (all in `prompt_writer.py`):
  - `class PromptWriterError(Exception)`: its message is user-facing.
  - `key_for(url: str, env: Mapping[str, str], key_file: Optional[Path]) -> Optional[str]`
  - `check_url(url: str) -> None`: raises `PromptWriterError` for non-https on a non-local host, or for a scheme other than http or https.
  - `map_models(payload: dict) -> list[dict]`: returns items `{id, name, prompt_price, completion_price, vision}`, with prices in USD per million tokens or None, and the list sorted by `name` case-insensitively.
  - `list_models(base_url: str, *, api_key: Optional[str], refresh: bool = False, opener=urllib.request.urlopen) -> list[dict]`: with the cache.
  - `system_prompt_names(folder: Optional[str]) -> list[str]`
  - `read_system_prompt(folder: Optional[str], name: str) -> str`
  - `build_messages(system: str, idea: str, previous_result: Optional[str], image_data_url: Optional[str]) -> list[dict]`
  - `parse_reply(payload: dict) -> str`
  - `cost_of(payload: dict, model: Optional[dict]) -> Optional[float]`: returns USD.
  - `write(base_url: str, model_id: str, system: str, temperature: float, idea: str, previous_result: Optional[str], image_data_url: Optional[str], *, api_key: Optional[str], model: Optional[dict], opener=urllib.request.urlopen) -> dict`: returns `{text, seconds, usage, cost}`.
  - `USER_AGENT: str`: `"ComfyUI-WarpPipe/" + version.txt contents stripped`.

- [ ] **Step 1: Write the failing tests.**
  - Load the module by path the way conftest loads `warp_pipe` (importlib from `PROJECT_ROOT / "prompt_writer.py"`).
  - Run HTTP through a real `http.server.ThreadingHTTPServer` on 127.0.0.1 in a fixture. It records each request's path, headers and JSON body, and replies from a per-test queue.
  - Use `opener=urllib.request.urlopen` against `http://127.0.0.1:<port>/api/v1`.

```python
def test_key_bound_to_host():
    env = {"NANOGPT_API_KEY": "k1"}
    assert pw.key_for("https://nano-gpt.com/api/v1", env, None) == "k1"
    assert pw.key_for("https://api.nano-gpt.com/api/v1", env, None) == "k1"
    assert pw.key_for("https://evil.example/api/v1", env, None) is None
    assert pw.key_for("https://nano-gpt.com.evil.example/v1", env, None) is None
    assert pw.key_for("http://127.0.0.1:1234/v1", env, None) is None

def test_key_file_names_other_hosts(tmp_path):
    f = tmp_path / "warppipe_llm_keys.json"; f.write_text('{"127.0.0.1": "local"}')
    assert pw.key_for("http://127.0.0.1:1234/v1", {}, f) == "local"
    assert pw.key_for("http://localhost:1234/v1", {}, f) is None

def test_check_url():
    pw.check_url("https://nano-gpt.com/api/v1"); pw.check_url("http://localhost:1234/v1")
    for bad in ("http://nano-gpt.com/api/v1", "ftp://x/y", "file:///c:/x"):
        with pytest.raises(pw.PromptWriterError): pw.check_url(bad)

def test_map_models_nanogpt_and_plain():
    nano = {"data": [{"id": "b", "name": "Beta", "pricing": {"prompt": 0.3, "completion": 1.2},
                      "capabilities": {"vision": True}},
                     {"id": "a", "name": "alpha"}]}
    assert pw.map_models(nano) == [
        {"id": "a", "name": "alpha", "prompt_price": None, "completion_price": None, "vision": False},
        {"id": "b", "name": "Beta", "prompt_price": 0.3, "completion_price": 1.2, "vision": True}]
    assert pw.map_models({"data": [{"id": "m1"}]})[0]["name"] == "m1"   # plain OpenAI

def test_list_models_sends_key_and_user_agent_and_caches(server): ...
    # asserts: path == "/api/v1/models?detailed=true"; headers Authorization == "Bearer k";
    # User-Agent == pw.USER_AGENT and startswith "ComfyUI-WarpPipe/"; second call → no new request;
    # refresh=True → new request

def test_system_prompt_files(tmp_path):
    (tmp_path / "v2.6.txt").write_text("SYS", encoding="utf-8"); (tmp_path / "notes.md").write_text("x")
    assert pw.system_prompt_names(str(tmp_path)) == ["v2.6.txt"]
    assert pw.read_system_prompt(str(tmp_path), "v2.6.txt") == "SYS"
    for bad in ("../x.txt", "a/b.txt", "a\\b.txt", "notes.md", "missing.txt"):
        with pytest.raises(pw.PromptWriterError): pw.read_system_prompt(str(tmp_path), bad)
    with pytest.raises(pw.PromptWriterError, match="SystemPromptDir"): pw.system_prompt_names(None)

def test_build_messages():
    assert pw.build_messages("S", "idea", None, None) == [
        {"role": "system", "content": "S"}, {"role": "user", "content": "idea"}]
    m = pw.build_messages("S", "warmer light", "OLD", "data:image/png;base64,AAA")
    assert m[1] == {"role": "assistant", "content": "OLD"}
    assert m[2] == {"role": "user", "content": [
        {"type": "text", "text": "warmer light"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}}]}

def test_parse_reply_strips_thinking():
    msg = lambda **kw: {"choices": [{"message": kw}]}
    assert pw.parse_reply(msg(content="<think>x</think>\n// Overview\n- A")) == "// Overview\n- A"
    assert pw.parse_reply(msg(content="P", reasoning="long")) == "P"
    with pytest.raises(pw.PromptWriterError, match="returned no text"):
        pw.parse_reply(msg(content="", reasoning_content="only thoughts"))

def test_cost_of():
    usage = {"prompt_tokens": 1000, "completion_tokens": 500}
    model = {"prompt_price": 0.3, "completion_price": 1.2}
    assert pw.cost_of({"usage": usage}, model) == pytest.approx(0.0009)
    assert pw.cost_of({"usage": {**usage, "cost": 0.002}}, model) == 0.002
    assert pw.cost_of({"usage": usage}, None) is None

def test_write_round_trip(server): ...
    # reply {"choices":[{"message":{"content":"PROMPT"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}
    # assert body == {"model": "m", "temperature": 0.6, "stream": False, "messages": [...]}
    # result["text"] == "PROMPT"; result["usage"] == {"prompt_tokens": 10, "completion_tokens": 5}
    # isinstance(result["seconds"], float)

def test_write_surfaces_provider_errors(server): ...
    # 402 {"error":{"message":"Insufficient balance"}} → PromptWriterError("Insufficient balance")
    # 500 text "upstream down" → PromptWriterError whose message contains "upstream down" and "500"
    # message never contains the api key value
```

- [ ] **Step 2: Run the tests to confirm they fail.**
  - Run: `python -m pytest tests/test_prompt_writer.py -q`
  - Expected: the tests fail or error because `prompt_writer.py` does not exist.

- [ ] **Step 3: Implement `prompt_writer.py` with the interfaces above.**
  - **HTTP:** use `urllib.request.Request` with `User-Agent`, `Accept: application/json` and, when a key is present, `Authorization: Bearer`. Call `check_url` before every request.
  - **Error message:** on `HTTPError`, parse the body as JSON for `error.message`, then `error`, then `message`; otherwise use the text, truncated to 300 characters, prefixed with `HTTP <code>: `.
  - **Timeouts:** a timeout or `URLError` becomes a `PromptWriterError` naming the host.
  - **Thinking:** strip `<think>…</think>` with `re.sub(r"(?s)<think>.*?</think>", "", text).strip()`.
  - **Price paths:** read `pricing.prompt`/`pricing.completion`, or `pricing.input`/`pricing.output`.
  - **Cache:** a module dict `{base_url: (time.monotonic(), models)}`.

- [ ] **Step 4: Run the tests again.**
  - Run: `python -m pytest tests/test_prompt_writer.py -q`, then `python -m pytest -q`.
  - Expected: all pass, and the existing 133 still pass.

- [ ] **Step 5: Commit.**

```bash
git add prompt_writer.py tests/test_prompt_writer.py
git commit -m "feat(prompt-writer): stdlib LLM client with host-bound keys"
```

### Task 2: Backend routes

**Files:**
- Modify: `warp_pipe.py`, the `_register_routes()` function at about line 2312.
- Modify: `prompt_writer.py`, adding the request handling it can own.
- Test: `tests/test_prompt_writer.py`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `prompt_writer.handle_write(body: dict, *, env, key_file: Path, settings: dict, image_path: Callable[[str], Optional[str]], opener=...) -> dict`
  - `prompt_writer.handle_models(base_url: str, refresh: bool, *, env, key_file) -> dict` returns `{"models": [...]}`.
  - `prompt_writer.handle_system_prompts(settings: dict) -> dict` returns `{"names": [...]}`.
  - Routes, used by Task 4:
    - `GET /warppipe/llm/models?base_url=&refresh=1`
    - `GET /warppipe/llm/system_prompts`
    - `POST /warppipe/llm/write`
  - Every handler returns `{"error": str}` with HTTP 200 on a `PromptWriterError`, so the frontend shows the message.

- [ ] **Step 1: Write the failing tests for the handlers (no aiohttp).**

```python
def test_handle_write_uses_setting_folder_and_reference(server, tmp_path):
    (tmp_path / "s.txt").write_text("SYS", encoding="utf-8")
    img = tmp_path / "ref.png"; img.write_bytes(b"\x89PNG")
    out = pw.handle_write(
        {"base_url": server.url, "model": "m", "system_prompt": "s.txt", "temperature": 0.6,
         "idea": "i", "previous_result": "", "reference": "ref.png"},
        env={}, key_file=tmp_path / "none.json",
        settings={"WarpPipe.PromptWriter.SystemPromptDir": str(tmp_path)},
        image_path=lambda name: str(img) if name == "ref.png" else None)
    # request messages[0] == system "SYS"; user content has image_url starting "data:image/png;base64,"
    # empty previous_result → no assistant turn; out has text/seconds/usage/cost

def test_handle_write_unknown_reference_is_error(...):   # image_path returns None → {"error": ...}
def test_handle_system_prompts_without_setting():
    assert "SystemPromptDir" in pw.handle_system_prompts({})["error"]
```

  - The `model` for the cost comes from the cached list for that `base_url` (`list_models` with no refresh). If the list fails, the cost is null and **write** still succeeds.
  - The MIME type of the reference comes from `mimetypes.guess_type`, defaulting to `image/png`.

- [ ] **Step 2: Run the new tests to confirm they fail.**
  - Run: `python -m pytest tests/test_prompt_writer.py -q -k handle`
  - Expected: FAIL, `handle_write` not defined.

- [ ] **Step 3: Implement the handlers in `prompt_writer.py`.**
  - Add `register(routes, web, *, user_dir: str, settings_loader, image_path)` to `prompt_writer.py`.
  - In `_register_routes()`, call it with:
    - `user_dir=folder_paths.get_user_directory()`
    - `settings_loader(request)`, which reads `comfy.settings.json` through `PromptServer.instance.user_manager.get_request_user_filepath(request, "comfy.settings.json")` and returns `{}` on any failure
    - `image_path=lambda n: folder_paths.get_annotated_filepath(n) if folder_paths.exists_annotated_filepath(n) else None`
  - **Blocking calls:** the handlers run `handle_*` through `asyncio.to_thread`.
  - **Key file:** `Path(user_dir) / "warppipe_llm_keys.json"`, and `env` is `os.environ`.
  - **Import:** `from . import prompt_writer`, with a fallback to `import prompt_writer`, the same pattern `__init__.py` uses.

- [ ] **Step 4: Run all Python tests.**
  - Run: `python -m pytest -q`
  - Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add prompt_writer.py warp_pipe.py tests/test_prompt_writer.py
git commit -m "feat(prompt-writer): /warppipe/llm routes"
```

### Task 3: Frontend pure helpers

**Files:**
- Create: `web/prompt_writer_core.js`
- Test: `tests/web/prompt_writer.test.mjs`
- Modify: `package.json`, adding the test file to the `test` script.

**Interfaces:**
- Consumes: `collectSends(rootGraph)` from `web/warp_route.js`; its items carry the Send node and an `active` flag (read the file for the exact item shape).
- Produces:
  - `stripTitles(text: string) -> string`
  - `modelLabel(m: {name, prompt_price, completion_price, vision}) -> string`
  - `formatStatus(r: {cost, seconds, usage}) -> string`
  - `findTargetPrompt(rootGraph) -> {node, group: string} | {error: string}`: `node` is the `Warp Lora Prompt` node, and `group` is the title of the LGraphGroup containing the Send, or the Send's name.

- [ ] **Step 1: Write the failing tests.**

```js
test("stripTitles removes // lines and collapses blanks", () => {
  assert.equal(stripTitles("// Overview\n- A\n\n\n  // Subject 1\n- B\n"), "- A\n\n- B");
});
test("modelLabel", () => {
  assert.equal(modelLabel({ name: "Q", prompt_price: 0.3, completion_price: 1.2, vision: true }),
               "Q · $0.30/$1.20 · 👁");
  assert.equal(modelLabel({ name: "Q", prompt_price: null, completion_price: null, vision: false }), "Q");
});
test("formatStatus", () => {
  assert.equal(formatStatus({ cost: 0.003, seconds: 8.2,
    usage: { prompt_tokens: 1812, completion_tokens: 640 } }), "0.3 ¢ · 8 s · 1,812 → 640 tokens");
  assert.equal(formatStatus({ cost: null, seconds: 12.6, usage: {} }), "13 s");
});
// findTargetPrompt on fake graphs (same fake-node style as warp_route.test.mjs, with links map):
//  - active Send ← Warp ← Prompt (direct links) → that prompt node
//  - prompt inside a subgraph node whose inner output feeds the subgraph output → found
//  - no link path, but Prompt inside the same group bounds as the Send → found (fallback)
//  - two distinct prompts upstream → {error} mentioning the group title
//  - no active Send → {error: "Activate a Warp Send first"}
```

- [ ] **Step 2: Run the tests to confirm they fail.**
  - Run: `node --test tests/web/prompt_writer.test.mjs`
  - Expected: FAIL, module not found.

- [ ] **Step 3: Implement `web/prompt_writer_core.js`.**
  - **Link walk:**
    - It is a breadth-first search over input links: `graph.links[id].origin_id` in `graph`.
    - When the origin is a subgraph node, continue from the inner node feeding that output (`node.subgraph`, via its `outputNode` input links).
    - When the walk reaches a subgraph input node (`origin_id === -10`), continue from the parent subgraph node's matching input.
    - Keep a visited set.
  - **Fallback:** the group whose `_bounding`/`pos`+`size` contains the Send's centre, then the `Warp Lora Prompt` nodes whose centres lie inside it.
  - **Restrictions:** no DOM and no `app` import, so it runs under node.

- [ ] **Step 4: Run the web tests.**
  - Run: `npm test`
  - Expected: all pass (the existing 40 plus the new ones).

- [ ] **Step 5: Commit.**

```bash
git add web/prompt_writer_core.js tests/web/prompt_writer.test.mjs package.json
git commit -m "feat(prompt-writer): pure helpers for labels, status and target prompt"
```

### Task 4: 🌀 Prompt Writer node, docs and version

**Files:**
- Create: `web/prompt_writer.js`
- Create: `web/docs/Prompt Writer.md`
- Modify:
  - `README.md` (node list)
  - `WIKI.md` (a section like Warp Select's)
  - `CHANGELOG.md` (a new `## [4.3.0] - 2026-11-05` above 4.2.0)
  - `version.txt` and `pyproject.toml` version → `4.3.0`
  - `pyproject.toml` package-data: add `"*.py"` only if `prompt_writer.py` is not already shipped. Verify with `python -m build --wheel` only if `build` is installed; otherwise reason from setuptools package-dir.

**Interfaces:**
- Consumes: the routes from Task 2, the helpers from Task 3, and `collectSends` from `warp_route.js`.
- Produces: the node type `Warp Prompt Writer`.

- [ ] **Step 1: Build the virtual node in `web/prompt_writer.js`, following `registerSelect()` in `web/warp_send.js`.**
  - `isVirtualNode = true` and `serialize_widgets = true`. It has no inputs or outputs.
  - **Widgets, in order:**
    - `base_url` (text)
    - `model` (combo whose values come from the last loaded list)
    - `system_prompt` (combo)
    - `temperature` (number)
    - `reference` (text, shown as the file name, plus a button "reference…" that opens a file picker and uploads through `api.fetchApi("/upload/image", {method: "POST", body: FormData})`, plus "clear")
    - `idea` and `result`, each a multiline STRING via `ComfyWidgets.STRING` from `../../scripts/widgets.js`, as other WarpPipe widgets import it
    - buttons: `write`, `new`, `from prompt`, `use`, `refresh models`
    - a status line drawn in the node footer
  - **Model labels:** the combo shows `modelLabel(m)`, but the stored value is the id. Keep a map from label to id, store the id in `properties.model_id` and display the label. An id that is not in the list shows `"<id> (not listed)"`.
  - **write:**
    - It POSTs the payload.
    - While it is in flight, the button reads `writing…`, and a second click aborts the request with `AbortController`.
    - On success it sets `result` and the status. On `{error}` it shows the error in red in the status line.
    - The reference is sent only if the selected model has `vision`; otherwise the status shows `reference ignored: model has no vision`.
  - **use and from prompt:**
    - Both use `findTargetPrompt(app.rootGraph)`.
    - **use** sets `node.widgets.find(w => w.name === "text").value = stripTitles(result)`, calls `widget.callback?.(value)` and `app.graph.setDirtyCanvas(true, true)`, and flashes the target (`node.boxcolor`, about 600 ms).
    - Errors go to the status line.
  - **The setting:** register `WarpPipe.PromptWriter.SystemPromptDir` in `app.registerExtension({settings: [...]})` with type `text`, the category `["WarpPipe", "Prompt Writer", "System prompt folder"]` and a tooltip saying that only `.txt` files directly in this folder are listed.
  - **Loading lists:** the model and system-prompt lists load when the node is created or configured, and again on **refresh models**.

- [ ] **Step 2: Run the static checks.**
  - Run: `npm run check`
  - Expected: lint, format and tests all pass.

- [ ] **Step 3: Write the docs (style of `web/docs/Warp Select.md`) and do the version bump.**
  - The docs state that the key goes in `NANOGPT_API_KEY` or in `user/warppipe_llm_keys.json`, and that it is never stored in workflows.
  - Run: `python -m pytest -q && npm test`
  - Expected: all pass.

- [ ] **Step 4: Commit.**

```bash
git add web/prompt_writer.js "web/docs/Prompt Writer.md" README.md WIKI.md CHANGELOG.md version.txt pyproject.toml
git commit -m "feat(prompt-writer): hub node with write/use, docs, 4.3.0"
```

### Task 5: Live verification and workflow (controller, not a subagent)

- [ ] **Step 1: Restart ComfyUI** (allowed without asking). Check the log for `/warppipe/llm` registration and the absence of import errors.
- [ ] **Step 2: Wait for the key.** The user sets `NANOGPT_API_KEY`; ComfyUI must be restarted after that. Never type or read the key.
- [ ] **Step 3: Add the node to the hub of `Img (26-11-06).json`.**
  - Place it at the top of the "Workflow" group on the 10-px grid.
  - Set `system_prompt` to `image_master_prompt_v2.6.txt` and the setting to `C:\Users\grego\OneDrive\_Projects\Blue\generations - images`.
  - Back up the file to the scratchpad first.
- [ ] **Step 4: Live test in the browser pane.**
  - Run a harmless idea ("a woman reading in a café by a window, afternoon") → **write**, then **use**.
  - Check that the Krea 2 Prompt + LoRAs `text` holds the prompt without `//` lines.
  - Check that the status shows cost and seconds.
  - Run `JSON.stringify(app.graph.serialize())` and confirm the key does not appear in it (search for the first 6 characters the user confirms, or `Bearer`).
- [ ] **Step 5: Do the same in Vue Nodes 2.0**, then switch the setting back to classic.
