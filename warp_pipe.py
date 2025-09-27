import comfy.samplers
import hashlib
import uuid

# Global storage for warp data; keys are unique per Warp instance
warp_storage = {}

class Warp:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "warp"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "warp": ("CONTROL", {}),  # copy from existing warp if provided
                "model": ("MODEL", {}),
                "clip": ("CLIP", {}),
                "clip_vision": ("CLIP_VISION", {}),
                "vae": ("VAE", {}),
                "conditioning_positive": ("CONDITIONING", {}),
                "conditioning_negative": ("CONDITIONING", {}),
                "image": ("IMAGE", {}),
                "latent": ("LATENT", {}),
                "prompt_positive": ("STRING", {"default": ""}),
                "prompt_negative": ("STRING", {"default": ""}),
                "initial_steps": ("INT", {"default": 20, "min": 1, "max": 200}),
                "detailer_steps": ("INT", {"default": 0, "min": 0, "max": 200}),
                "upscaler_steps": ("INT", {"default": 0, "min": 0, "max": 200}),
                "cfg": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 50.0}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {}),
            }
        }

    RETURN_TYPES = ("CONTROL",)
    RETURN_NAMES = ("warp",)

    def __init__(self):
        # Unique ID for this warp instance
        self._warp_id = uuid.uuid4().hex

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        h = hashlib.sha256()
        for key in sorted(kwargs.keys()):
            h.update(repr(kwargs[key]).encode('utf-8'))
        return h.hexdigest()

    def warp(
        self,
        warp=None,
        model=None,
        clip=None,
        clip_vision=None,
        vae=None,
        conditioning_positive=None,
        conditioning_negative=None,
        image=None,
        latent=None,
        prompt_positive=None,
        prompt_negative=None,
        initial_steps=None,
        detailer_steps=None,
        upscaler_steps=None,
        cfg=None,
        sampler_name=None,
        scheduler=None
    ):
        # If warp input provided, copy existing data
        if isinstance(warp, dict) and "id" in warp:
            prev_id = warp["id"]
            data = warp_storage.get(prev_id, {}).copy()
        else:
            data = {}

        # Apply any new inputs
        updates = {
            "model": model,
            "clip": clip,
            "clip_vision": clip_vision,
            "vae": vae,
            "conditioning_positive": conditioning_positive,
            "conditioning_negative": conditioning_negative,
            "image": image,
            "latent": latent,
            "prompt_positive": prompt_positive,
            "prompt_negative": prompt_negative,
            "initial_steps": initial_steps,
            "detailer_steps": detailer_steps,
            "upscaler_steps": upscaler_steps,
            "cfg": cfg,
            "sampler_name": sampler_name,
            "scheduler": scheduler
        }
        for key, val in updates.items():
            if val is not None:
                data[key] = val

        warp_storage[self._warp_id] = data
        return ({"id": self._warp_id},)

class Unwarp:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "unwarp"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "warp": ("CONTROL", {}),  # CONTROL carries the warp ID
            }
        }

    RETURN_TYPES = (
        "MODEL",
        "CLIP",
        "CLIP_VISION",
        "VAE",
        "CONDITIONING",
        "CONDITIONING",
        "IMAGE",
        "LATENT",
        "STRING",
        "STRING",
        "INT",
        "INT",
        "INT",
        "FLOAT",
        comfy.samplers.KSampler.SAMPLERS,
        comfy.samplers.KSampler.SCHEDULERS,
    )
    RETURN_NAMES = (
        "model",
        "clip",
        "clip_vision",
        "vae",
        "conditioning_positive",
        "conditioning_negative",
        "image",
        "latent",
        "prompt_positive",
        "prompt_negative",
        "initial_steps",
        "detailer_steps",
        "upscaler_steps",
        "cfg",
        "sampler_name",
        "scheduler",
    )

    def unwarp(self, warp):
        if not isinstance(warp, dict) or "id" not in warp:
            raise ValueError("Invalid warp signal. Ensure it comes from a Warp node.")
        warp_id = warp["id"]
        data = warp_storage.get(warp_id, {})
        return (
            data.get("model"),
            data.get("clip"),
            data.get("clip_vision"),
            data.get("vae"),
            data.get("conditioning_positive"),
            data.get("conditioning_negative"),
            data.get("image"),
            data.get("latent"),
            data.get("prompt_positive"),
            data.get("prompt_negative"),
            data.get("initial_steps"),
            data.get("detailer_steps"),
            data.get("upscaler_steps"),
            data.get("cfg"),
            data.get("sampler_name"),
            data.get("scheduler"),
        )

# Register nodes under capitalized names
NODE_CLASS_MAPPINGS = {
    "Warp": Warp,
    "Unwarp": Unwarp
}
