import asyncio
import inspect
import time

import pytest

NODE_IDS = {"Warp", "Unwarp", "Warp Provider", "FD Scheduler Adapter", "Dead End"}


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

    assert {schema.node_id for schema in schemas} == NODE_IDS
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
