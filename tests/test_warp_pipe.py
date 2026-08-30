import asyncio
import hashlib
import inspect
import json
import time

import pytest

V3_NODE_IDS = {"Warp", "Unwarp", "Warp Provider", "FD Scheduler Adapter", "Dead End"}
# The Civitai save node is currently registered on the legacy path only.
NODE_IDS = V3_NODE_IDS | {"Save Image Civitai"}


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
