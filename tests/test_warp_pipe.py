import asyncio
import hashlib
import inspect
import json
import pathlib
import sys
import time
import types

import pytest

V3_NODE_IDS = {"Warp", "Unwarp", "Warp Provider", "FD Scheduler Adapter", "Dead End"}
# The Civitai save node is currently registered on the legacy path only.
NODE_IDS = V3_NODE_IDS | {"Save Image Civitai", "Warp Lora Prompt"}


def test_legacy_registration_and_node_contracts(warp_pipe):
    assert set(warp_pipe.NODE_CLASS_MAPPINGS) == NODE_IDS
    assert set(warp_pipe.NODE_DISPLAY_NAME_MAPPINGS) == NODE_IDS

    for node_class in warp_pipe.NODE_CLASS_MAPPINGS.values():
        assert isinstance(vars(node_class)["INPUT_TYPES"], classmethod)
        assert callable(getattr(node_class, node_class.FUNCTION))
        assert len(node_class.RETURN_TYPES) == len(node_class.RETURN_NAMES)

    assert warp_pipe.DeadEnd().dead_end() == ()


def test_custom_validation_only_bypasses_link_type_checks(warp_pipe):
    for node_class in (warp_pipe.Warp, warp_pipe.FDSchedulerAdapter, warp_pipe.DeadEnd):
        signature = inspect.signature(node_class.VALIDATE_INPUTS)
        assert list(signature.parameters) == ["input_types"]

    assert warp_pipe.Warp.VALIDATE_INPUTS({"image": "IMAGE"}) is True
    assert warp_pipe.Warp.VALIDATE_INPUTS({"sampler_name": ["external_sampler"]}) is True
    assert "expected 'IMAGE'" in warp_pipe.Warp.VALIDATE_INPUTS({"image": "MODEL"})


def test_warp_round_trip_preserves_falsey_values_and_inheritance(warp_pipe):
    first_signal = warp_pipe.Warp().warp(
        prompt_positive="",
        seed=0,
        cfg=0.0,
        sampler_name="euler",
        scheduler="normal",
    )[0]
    second_signal = warp_pipe.Warp().warp(
        warp=first_signal,
        prompt_negative="later",
    )[0]

    values = dict(zip(warp_pipe.Unwarp.RETURN_NAMES, warp_pipe.Unwarp().unwarp(second_signal)))
    assert values["prompt_positive"] == ""
    assert values["prompt_negative"] == "later"
    assert values["seed"] == 0
    assert values["cfg"] == 0.0
    assert values["sampler_name"] == "euler"
    assert values["scheduler"] == "normal"


def test_unwarp_returns_none_for_absent_or_missing_fields(warp_pipe):
    assert all(value is None for value in warp_pipe.Unwarp().unwarp())

    signal = warp_pipe.Warp().warp(model_1=object())[0]
    values = dict(zip(warp_pipe.Unwarp.RETURN_NAMES, warp_pipe.Unwarp().unwarp(signal)))
    assert values["model_1"] is not None
    assert values["sampler_name"] is None
    assert values["scheduler"] is None
    assert values["width"] is None
    assert values["height"] is None


def test_storage_cleanup_enforces_age_and_hard_cap(warp_pipe, monkeypatch):
    monkeypatch.setattr(warp_pipe, "_STORAGE_MAX_ENTRIES", 2)
    signals = [warp_pipe.Warp().warp(seed=index)[0] for index in range(3)]

    assert len(warp_pipe.warp_storage) == 2
    assert signals[0]["id"] not in warp_pipe.warp_storage
    assert signals[-1]["id"] in warp_pipe.warp_storage

    stale_id = signals[1]["id"]
    warp_pipe._storage_timestamps[stale_id] = time.time() - warp_pipe._STORAGE_MAX_AGE_SECONDS - 1
    warp_pipe.cleanup_warp_storage()
    assert stale_id not in warp_pipe.warp_storage
    assert stale_id not in warp_pipe._storage_timestamps


def test_unwarp_refreshes_storage_timestamp(warp_pipe):
    signal = warp_pipe.Warp().warp(seed=1)[0]
    warp_id = signal["id"]
    warp_pipe._storage_timestamps[warp_id] = 1.0

    warp_pipe.Unwarp().unwarp(signal)

    assert warp_pipe._storage_timestamps[warp_id] > 1.0


def test_provider_parses_presets_and_builds_expected_latent(warp_pipe):
    result = warp_pipe.WarpProvider().provide(
        batch_size=2,
        size_preset="Widescreen | 16:9 | 1920 × 1080 | 2.07 MP",
    )

    assert result[0]["samples"].shape == (2, 4, 135, 240)
    assert result[-2:] == (1920, 1080)


@pytest.mark.parametrize(
    ("width", "height", "batch_size", "exception"),
    [
        (63, 1024, 1, ValueError),
        (1025, 1024, 1, ValueError),
        (1024, 1024, 0, ValueError),
        (1024.0, 1024, 1, TypeError),
    ],
)
def test_empty_latent_rejects_invalid_linked_values(
    warp_pipe, width, height, batch_size, exception
):
    with pytest.raises(exception):
        warp_pipe._create_empty_latent(width, height, batch_size)


def test_scheduler_fallbacks_are_registered_and_coerced(warp_pipe):
    for scheduler in warp_pipe.RES4LYF_SCHEDULERS:
        assert scheduler in warp_pipe.SAFE_SCHEDULERS
        assert scheduler in warp_pipe.comfy.samplers.SCHEDULER_HANDLERS
        assert warp_pipe.coerce_scheduler(scheduler) == scheduler

    assert warp_pipe.coerce_scheduler("unknown") == "karras"
    assert warp_pipe.coerce_sampler("unknown") == "euler"
    assert warp_pipe.coerce_scheduler_fd("AYS SDXL") == "AYS SDXL"


def test_v3_entrypoint_schemas_and_execution(warp_pipe_loader):
    warp_pipe = warp_pipe_loader(enable_v3=True)

    assert hasattr(warp_pipe, "comfy_entrypoint")
    assert not hasattr(warp_pipe, "NODE_CLASS_MAPPINGS")

    extension = asyncio.run(warp_pipe.comfy_entrypoint())
    nodes = asyncio.run(extension.get_node_list())
    schemas = [node.GET_SCHEMA() for node in nodes]

    assert {schema.node_id for schema in schemas} == V3_NODE_IDS
    combo_outputs = [
        output for schema in schemas for output in schema.outputs if output.io_type == "COMBO"
    ]
    assert combo_outputs
    assert all(output.options for output in combo_outputs)

    signal = warp_pipe.WarpV3.execute(prompt_positive="hello")[0]
    values = warp_pipe.UnwarpV3.execute(signal)
    assert values[10] == "hello"


@pytest.mark.parametrize("enable_v3", [False, True])
def test_package_exports_only_one_registration_path(package_loader, enable_v3):
    package = package_loader(enable_v3=enable_v3)

    # __all__ ordering carries no meaning, so compare membership rather than
    # sequence; the point of this test is which path is exported, not its order.
    if enable_v3:
        assert set(package.__all__) == {"comfy_entrypoint", "WEB_DIRECTORY"}
        assert not hasattr(package, "NODE_CLASS_MAPPINGS")
    else:
        assert set(package.NODE_CLASS_MAPPINGS) == NODE_IDS
        assert set(package.__all__) == {
            "NODE_CLASS_MAPPINGS",
            "NODE_DISPLAY_NAME_MAPPINGS",
            "WEB_DIRECTORY",
        }


# ---------------------------------------------------------------------------
# Civitai metadata
# ---------------------------------------------------------------------------

RGTHREE_GRAPH = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sdxl/base.safetensors"}},
    "2": {
        "class_type": "LoraLoader",
        "inputs": {"lora_name": "style/abstract.safetensors", "strength_model": 0.8},
    },
    "3": {
        "class_type": "Power Lora Loader (rgthree)",
        "inputs": {
            "lora_1": {"lora": "detail.safetensors", "strength": 0.6, "on": True},
            "lora_2": {"lora": "off.safetensors", "strength": 1.0, "on": False},
            "lora_3": {"lora": "None", "strength": 1.0, "on": True},
        },
    },
}


def test_collect_graph_resources_reads_standard_and_stacked_loaders(warp_pipe):
    checkpoint, loras = warp_pipe.collect_graph_resources(RGTHREE_GRAPH)

    assert checkpoint == "sdxl/base.safetensors"
    assert loras == [("style/abstract.safetensors", 0.8), ("detail.safetensors", 0.6)]


def test_collect_graph_resources_tolerates_junk(warp_pipe):
    assert warp_pipe.collect_graph_resources(None) == (None, [])
    assert warp_pipe.collect_graph_resources({"a": "not-a-node"}) == (None, [])
    assert warp_pipe.collect_graph_resources({"a": {"class_type": "X"}}) == (None, [])


def test_extract_lora_tags(warp_pipe):
    tags = warp_pipe.extract_lora_tags("a cat <lora:foo:0.5> and <lora:bar:1.2>")

    assert tags == [("foo", 0.5), ("bar", 1.2)]
    assert warp_pipe.extract_lora_tags(None) == []
    assert warp_pipe.extract_lora_tags("no tags here") == []


def test_build_parameters_matches_a1111_shape(warp_pipe):
    text = warp_pipe.build_civitai_parameters(
        positive="a portrait",
        negative="blurry",
        steps=30,
        sampler_name="dpmpp_2m",
        scheduler="karras",
        cfg=7.0,
        seed=123,
        width=1024,
        height=768,
        model_name="sdxl/base.safetensors",
        model_hash="67ab2fd8ec",
        loras=[("AbstractPainting", 0.8, "df7c757437")],
    )
    lines = text.split("\n")

    assert lines[0] == "a portrait <lora:AbstractPainting:0.8>"
    assert lines[1] == "Negative prompt: blurry"
    assert "Steps: 30" in lines[2]
    assert "Schedule type: karras" in lines[2]
    assert "Size: 1024x768" in lines[2]
    assert "Model hash: 67ab2fd8ec" in lines[2]
    assert "Model: base" in lines[2]
    assert 'Lora hashes: "AbstractPainting: df7c757437"' in lines[2]


def test_build_parameters_does_not_duplicate_existing_tags(warp_pipe):
    text = warp_pipe.build_civitai_parameters(
        positive="a cat <lora:foo:0.5>",
        loras=[("foo", 0.5, "aaaaaaaaaa")],
    )

    assert text.split("\n")[0].count("<lora:foo") == 1


def test_build_parameters_omits_missing_fields(warp_pipe):
    text = warp_pipe.build_civitai_parameters(positive="just a prompt")

    assert "Negative prompt:" not in text
    assert "Lora hashes" not in text
    assert "Steps:" not in text


def test_sidecar_hash_is_preferred_over_rehashing(warp_pipe, tmp_path):
    model = tmp_path / "some_lora.safetensors"
    model.write_bytes(b"pretend weights")
    sidecar = tmp_path / "some_lora.civitai.info"
    sidecar.write_text(
        json.dumps({"files": [{"hashes": {"SHA256": "DF7C757437EF3696E76EE5CC18C06368"}}]}),
        encoding="utf-8",
    )

    # Ten characters, lowercased - the AutoV2 form Civitai indexes on.
    assert warp_pipe.model_autov2(str(model)) == "df7c757437"


def test_falls_back_to_hashing_when_no_sidecar(warp_pipe, tmp_path):
    model = tmp_path / "bare.safetensors"
    model.write_bytes(b"pretend weights")

    expected = hashlib.sha256(b"pretend weights").hexdigest()[:10]
    assert warp_pipe.model_autov2(str(model)) == expected


def test_missing_file_hashes_to_none(warp_pipe, tmp_path):
    assert warp_pipe.model_autov2(str(tmp_path / "nope.safetensors")) is None
    assert warp_pipe.model_autov2(None) is None


def test_save_node_contract(warp_pipe):
    node = warp_pipe.NODE_CLASS_MAPPINGS["Save Image Civitai"]

    assert node.OUTPUT_NODE is True
    assert node.RETURN_TYPES == ()
    hidden = node.INPUT_TYPES()["hidden"]
    assert hidden["prompt"] == "PROMPT"
    assert hidden["extra_pnginfo"] == "EXTRA_PNGINFO"


def test_build_metadata_combines_warp_values_and_graph(warp_pipe):
    warp = warp_pipe.Warp().warp(
        prompt_positive="a portrait",
        prompt_negative="blurry",
        seed=123,
        steps_1=30,
        cfg=7.0,
        width=1024,
        height=768,
    )[0]

    text = warp_pipe.SaveImageCivitai().build_metadata(warp=warp, prompt=RGTHREE_GRAPH)

    assert text.startswith("a portrait")
    assert "Negative prompt: blurry" in text
    assert "Steps: 30" in text
    assert "Seed: 123" in text
    assert "Size: 1024x768" in text
    # Names come through even when the files are absent and cannot be hashed.
    assert "<lora:abstract:0.8>" in text
    assert "<lora:detail:0.6>" in text


# A Flux-style graph: a UNet loader, a stacked LoRA loader with one slot off,
# and a second unrelated branch that must not leak into the metadata.
BRANCHED_GRAPH = {
    "10": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux/krea2.safetensors"}},
    "11": {
        "class_type": "Power Lora Loader (rgthree)",
        "inputs": {
            "model": ["10", 0],
            "lora_1": {"lora": "detail.safetensors", "strength": 0.7, "on": True},
            "lora_2": {"lora": "unused.safetensors", "strength": 1.0, "on": False},
        },
    },
    "12": {"class_type": "KSampler", "inputs": {"model": ["11", 0]}},
    "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0]}},
    "20": {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": "sdxl/other.safetensors"},
    },
    "21": {
        "class_type": "LoraLoader",
        "inputs": {"model": ["20", 0], "lora_name": "wrong.safetensors", "strength_model": 1.0},
    },
    "99": {"class_type": "Save Image Civitai", "inputs": {"images": ["13", 0]}},
}


def test_unet_loaders_are_detected_not_just_checkpoints(warp_pipe):
    model, _ = warp_pipe.collect_graph_resources(BRANCHED_GRAPH, start_id="99")

    assert model == "flux/krea2.safetensors"


def test_tracing_ignores_branches_that_did_not_make_the_image(warp_pipe):
    _, loras = warp_pipe.collect_graph_resources(BRANCHED_GRAPH, start_id="99")

    assert loras == [("detail.safetensors", 0.7)]


def test_without_a_start_id_the_whole_graph_is_considered(warp_pipe):
    _, loras = warp_pipe.collect_graph_resources(BRANCHED_GRAPH)
    names = [name for name, _ in loras]

    assert "wrong.safetensors" in names


def test_trace_upstream_walks_links(warp_pipe):
    reachable = warp_pipe.trace_upstream(BRANCHED_GRAPH, "99")

    assert {"99", "13", "12", "11", "10"} <= reachable
    assert "20" not in reachable
    assert "21" not in reachable


def test_trace_upstream_handles_unknown_start(warp_pipe):
    assert warp_pipe.trace_upstream(BRANCHED_GRAPH, None) is None
    assert warp_pipe.trace_upstream(BRANCHED_GRAPH, "does-not-exist") is None


# ---------------------------------------------------------------------------
# Prompt + LoRAs
# ---------------------------------------------------------------------------

# Long, foldered names like the ones a real loras folder holds.
LORA_ON_DISK = "sdxl/w4r10ck - detail tweaker (sdxl).safetensors"
OTHER_LORA = "ill/somebody - other thing (ill).safetensors"


@pytest.fixture
def lora_folder(monkeypatch, tmp_path):
    """A loras folder holding one real file with a Civitai sidecar."""
    weights = tmp_path / "detail.safetensors"
    weights.write_bytes(b"weights")
    (tmp_path / "detail.civitai.info").write_text(
        json.dumps(
            {
                "files": [{"hashes": {"SHA256": "ABCDEF0123456789"}}],
                "trainedWords": ["detail tweaker, sharp focus"],
            }
        ),
        encoding="utf-8",
    )

    module = types.ModuleType("folder_paths")
    module.get_filename_list = lambda kind: [LORA_ON_DISK, OTHER_LORA]
    module.get_full_path = lambda kind, name: str(weights) if name == LORA_ON_DISK else None
    monkeypatch.setitem(sys.modules, "folder_paths", module)
    return weights


def test_a_tag_may_name_any_unambiguous_fragment(warp_pipe, lora_folder):
    names = [LORA_ON_DISK, OTHER_LORA]

    assert warp_pipe.resolve_lora_name(LORA_ON_DISK, names) == LORA_ON_DISK
    assert warp_pipe.resolve_lora_name("detail tweaker", names) == LORA_ON_DISK
    assert warp_pipe.resolve_lora_name("w4r10ck - detail tweaker (sdxl)", names) == LORA_ON_DISK


def test_ambiguous_or_unknown_tags_are_skipped(warp_pipe, caplog):
    names = ["a/thing one.safetensors", "b/thing two.safetensors"]

    assert warp_pipe.resolve_lora_name("thing", names) is None
    assert warp_pipe.resolve_lora_name("nothing like this", names) is None
    assert warp_pipe.resolve_lora_name("", names) is None


def test_strip_lora_tags_leaves_a_clean_prompt(warp_pipe):
    text = "a portrait <lora:foo:0.8> in the rain <lora:bar:1>"

    assert warp_pipe.strip_lora_tags(text) == "a portrait in the rain"
    assert warp_pipe.strip_lora_tags(None) == ""


def test_trigger_words_are_split_out_of_the_sidecar(warp_pipe, lora_folder):
    assert warp_pipe.civitai_trigger_words(str(lora_folder)) == ["detail tweaker", "sharp focus"]
    assert warp_pipe.civitai_trigger_words(None) == []


def test_plan_resolves_hash_and_trigger_words(warp_pipe, lora_folder):
    resolved, words = warp_pipe.WarpLoraPrompt().plan("a portrait <lora:detail tweaker:0.8>")

    assert len(resolved) == 1
    assert resolved[0]["name"] == LORA_ON_DISK
    assert resolved[0]["weight"] == 0.8
    # Read from the sidecar rather than hashing the file again.
    assert resolved[0]["hash"] == "abcdef0123"
    assert words == ["detail tweaker", "sharp focus"]


def test_trigger_words_are_only_added_when_asked(warp_pipe, lora_folder):
    node = warp_pipe.WarpLoraPrompt()
    text = "a portrait <lora:detail tweaker:0.8>"

    _, _, plain, _ = node.apply(text=text)
    assert plain == "a portrait"

    _, _, expanded, _ = node.apply(text=text, insert_trigger_words=True)
    assert expanded == "a portrait, detail tweaker, sharp focus"


def test_trigger_words_are_not_duplicated(warp_pipe, lora_folder):
    node = warp_pipe.WarpLoraPrompt()

    _, _, prompt, _ = node.apply(
        text="a portrait, sharp focus <lora:detail tweaker:0.8>", insert_trigger_words=True
    )

    assert prompt.lower().count("sharp focus") == 1


def test_applied_loras_are_recorded_in_the_warp(warp_pipe, lora_folder):
    _, _, _, warp = warp_pipe.WarpLoraPrompt().apply(text="x <lora:detail tweaker:0.8>")

    stored = warp_pipe.warp_storage[warp["id"]]["loras"]
    assert stored == [
        {"name": "w4r10ck - detail tweaker (sdxl)", "weight": 0.8, "hash": "abcdef0123"}
    ]


def test_save_node_prefers_the_warp_over_the_graph(warp_pipe, lora_folder):
    _, _, _, warp = warp_pipe.WarpLoraPrompt().apply(text="a portrait <lora:detail tweaker:0.8>")

    # A graph naming a different LoRA must not override what was actually applied.
    text = warp_pipe.SaveImageCivitai().build_metadata(warp=warp, prompt=BRANCHED_GRAPH)

    assert "w4r10ck - detail tweaker (sdxl): abcdef0123" in text
    assert "detail.safetensors" not in text


def test_an_unresolvable_tag_fails_the_run(warp_pipe, lora_folder):
    # Generating without a LoRA the prompt asked for gives a wrong image and
    # wrong metadata, so this is louder than a console warning on purpose.
    with pytest.raises(warp_pipe.LoraTagError, match="matches no file"):
        warp_pipe.WarpLoraPrompt().apply(text="a portrait <lora:ghost:1>")


def test_an_ambiguous_tag_names_the_candidates(warp_pipe):
    names = [
        "sdxl/creator - secret sauce (sdxl).safetensors",
        "flux2/creator - secret sauce (flux2).safetensors",
    ]

    with pytest.raises(warp_pipe.LoraTagError) as excinfo:
        warp_pipe.resolve_lora_name("secret sauce", names, strict=True)

    assert "matches 2 files" in str(excinfo.value)
    assert "secret sauce (sdxl)" in str(excinfo.value)


def test_a_folder_prefix_disambiguates(warp_pipe):
    names = [
        "sdxl/creator - secret sauce (sdxl).safetensors",
        "flux2/creator - secret sauce (flux2).safetensors",
    ]

    assert warp_pipe.resolve_lora_name("sdxl/", names) == names[0]
    assert warp_pipe.resolve_lora_name("flux2/creator", names) == names[1]


def test_slash_direction_does_not_matter(warp_pipe):
    # Filenames come back with backslashes on Windows; nobody types those.
    names = ["sdxl\creator - thing (sdxl).safetensors"]

    assert warp_pipe.resolve_lora_name("sdxl/creator - thing (sdxl)", names) == names[0]
    assert warp_pipe.resolve_lora_name("SDXL/CREATOR - THING (SDXL)", names) == names[0]


def test_lora_tags_in_text_are_found_without_a_warp(warp_pipe, lora_folder):
    # The Prompt + LoRAs node keeps its tags in a text input, so the graph still
    # records them even when its warp output is left unconnected.
    graph = {
        "5": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux/krea2.safetensors"}},
        "6": {
            "class_type": "Warp Lora Prompt",
            "inputs": {"model": ["5", 0], "text": "a portrait <lora:detail tweaker:0.8>"},
        },
        "7": {"class_type": "KSampler", "inputs": {"model": ["6", 0]}},
        "9": {"class_type": "Save Image Civitai", "inputs": {"images": ["7", 0]}},
    }

    text = warp_pipe.SaveImageCivitai().build_metadata(warp=None, prompt=graph, unique_id="9")

    assert "Model: krea2" in text
    # The fragment in the tag is expanded to the real file, then hashed.
    assert 'Lora hashes: "w4r10ck - detail tweaker (sdxl): abcdef0123"' in text


def test_every_node_has_a_documentation_page():
    docs = pathlib.Path(__file__).resolve().parents[1] / "web" / "docs"
    documented = {path.stem for path in docs.glob("*.md")}

    assert NODE_IDS <= documented


def test_save_node_is_idle_when_nothing_is_connected(warp_pipe):
    # Bypassing an upstream branch should leave this node idle rather than
    # failing the whole prompt on a missing required input.
    node = warp_pipe.NODE_CLASS_MAPPINGS["Save Image Civitai"]
    assert "images" in node.INPUT_TYPES()["optional"]
    assert "images" not in node.INPUT_TYPES()["required"]

    assert warp_pipe.SaveImageCivitai().save_images(images=None) == {"ui": {"images": []}}
    assert warp_pipe.SaveImageCivitai().save_images(images=[]) == {"ui": {"images": []}}


def test_a_typo_suggests_the_right_file(warp_pipe):
    names = [
        "krea2/loraholic - fake breast slider - v1 (krea2).safetensors",
        "sdxl/w4r10ck - detail tweaker (sdxl).safetensors",
    ]

    with pytest.raises(warp_pipe.LoraTagError) as excinfo:
        warp_pipe.resolve_lora_name(
            "loraholic - fake brest slider - v1 (krea2)", names, strict=True
        )
    assert "loraholic - fake breast slider - v1 (krea2)" in str(excinfo.value)

    # A typo in a short fragment is matched against the name's parts.
    with pytest.raises(warp_pipe.LoraTagError) as excinfo:
        warp_pipe.resolve_lora_name("detial tweaker", names, strict=True)
    assert "detail tweaker" in str(excinfo.value)


def test_apply_to_clip_is_exposed_and_defaults_on(warp_pipe):
    spec = warp_pipe.WarpLoraPrompt.INPUT_TYPES()["required"]["apply_to_clip"]

    assert spec[0] == "BOOLEAN"
    assert spec[1]["default"] is True
    assert spec[1]["label_off"] == "model only"


def test_model_only_leaves_the_clip_untouched(warp_pipe, lora_folder, monkeypatch):
    seen = {}
    sentinel_clip = object()

    def fake_load(model, clip, lora, s_model, s_clip, lora_metadata=None):
        seen["clip_arg"] = clip
        seen["strength_clip"] = s_clip
        return "patched-model", None if clip is None else "patched-clip"

    comfy_sd = types.ModuleType("comfy.sd")
    comfy_sd.load_lora_for_models = fake_load
    comfy_utils = types.ModuleType("comfy.utils")
    comfy_utils.load_torch_file = lambda p, safe_load=True, return_metadata=True: ({}, None)
    # "import comfy.sd" resolves through the parent package, so it needs one.
    comfy_pkg = types.ModuleType("comfy")
    comfy_pkg.__path__ = []
    comfy_pkg.sd = comfy_sd
    comfy_pkg.utils = comfy_utils
    monkeypatch.setitem(sys.modules, "comfy", comfy_pkg)
    monkeypatch.setitem(sys.modules, "comfy.sd", comfy_sd)
    monkeypatch.setitem(sys.modules, "comfy.utils", comfy_utils)

    model, clip, _, _ = warp_pipe.WarpLoraPrompt().apply(
        text="x <lora:detail tweaker:0.8>",
        apply_to_clip=False,
        model="a-model",
        clip=sentinel_clip,
    )

    assert seen["clip_arg"] is None
    assert seen["strength_clip"] == 0.0
    assert model == "patched-model"
    assert clip is sentinel_clip  # untouched
