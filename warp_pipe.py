import hashlib
import uuid
import threading
from typing import Dict, Any, Optional

try:
    import comfy.samplers
except ImportError:
    # Fallback for development/testing environments
    class MockKSampler:
        SAMPLERS = ["euler", "euler_ancestral", "heun", "dpm_2", "dpm_2_ancestral", "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral", "dpmpp_sde", "dpmpp_2m"]
        SCHEDULERS = ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform"]
    
    class MockSamplers:
        KSampler = MockKSampler
    
    class MockComfy:
        samplers = MockSamplers
    
    comfy = MockComfy()

# Safe scheduler/sampler lists for compatibility (pulled dynamically from Comfy)
try:
    SAFE_SAMPLERS = list(getattr(comfy.samplers.KSampler, "SAMPLERS", []))
except Exception:
    SAFE_SAMPLERS = []

try:
    SAFE_SCHEDULERS = list(getattr(comfy.samplers.KSampler, "SCHEDULERS", []))
except Exception:
    SAFE_SCHEDULERS = []

# Compatibility mappings for exotic schedulers
SCHEDULER_ALIASES = {
    "AYS SDXL": "karras",
    "AYS SD1": "karras", 
    "AYS SVD": "karras",
    "GITS[coeff=1.2]": "karras",
    "LTXV[default]": "karras",
    "OSS FLUX": "karras",
    "OSS Wan": "karras",
    "OSS Chroma": "karras",
}

# FaceDetailer-specific scheduler enum set
FD_SCHEDULERS = [
    "simple",
    "sgm_uniform",
    "karras",
    "exponential",
    "ddim_uniform",
    "beta",
    "normal",
    "linear_quadratic",
    "kl_optimal",
    # FaceDetailer exotic options
    "AYS SDXL",
    "AYS SD1",
    "AYS SVD",
    "GITS[coeff=1.2]",
    "LTXV[default]",
    "OSS FLUX",
    "OSS Wan",
    "OSS Chroma",
]

def coerce_scheduler(name: str) -> str:
    """
    Coerce scheduler name to a safe, compatible value.
    
    Args:
        name: The scheduler name to coerce
        
    Returns:
        A safe scheduler name that ComfyUI will accept
    """
    if name in SAFE_SCHEDULERS:
        return name
    return SCHEDULER_ALIASES.get(name, "karras")

def coerce_scheduler_fd(name: str) -> str:
    """
    Coerce scheduler into FaceDetailer's accepted set.
    
    Args:
        name: The scheduler name to coerce for FaceDetailer compatibility
        
    Returns:
        A scheduler name that FaceDetailer will accept
    """
    if name in FD_SCHEDULERS:
        return name
    # Try alias map; if alias within FD list, return it, else fallback to karras
    alias = SCHEDULER_ALIASES.get(name)
    if alias in FD_SCHEDULERS:
        return alias
    return "karras"

def coerce_sampler(name: str) -> str:
    """
    Coerce sampler name to a safe, compatible value.
    
    Args:
        name: The sampler name to coerce
        
    Returns:
        A safe sampler name that ComfyUI will accept
    """
    if name in SAFE_SAMPLERS:
        return name
    # Default fallback for any unknown samplers
    return "euler"

# Global storage for warp data; keys are unique per Warp instance
warp_storage: Dict[str, Dict[str, Any]] = {}
_storage_lock = threading.Lock()

def cleanup_warp_storage():
    """Clean up unused warp storage entries"""
    with _storage_lock:
        # In a real implementation, you'd track active warp IDs
        # For now, we'll keep the simple approach but add the infrastructure
        pass

class Warp:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "warp"
    DISPLAY_NAME = "Warp Bundle"
    DESCRIPTION = "Bundle multiple data types into a single warp object"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "warp": ("CONTROL", {}),  # copy from existing warp if provided
                "prompt_positive": ("STRING", {"forceInput": True}),
                "prompt_negative": ("STRING", {"forceInput": True}),
                "conditioning_positive": ("CONDITIONING", {}),
                "conditioning_negative": ("CONDITIONING", {}),
                "image": ("IMAGE", {}),
                "mask": ("MASK", {}),
                "model": ("MODEL", {}),
                "clip": ("CLIP", {}),
                "clip_vision": ("CLIP_VISION", {}),
                "vae": ("VAE", {}),
                "latent": ("LATENT", {}),
                "batch_size": ("INT", {"forceInput": True}),
                "seed": ("INT", {"forceInput": True}),
                "steps_1": ("INT", {"forceInput": True}),
                "steps_2": ("INT", {"forceInput": True}),
                "steps_3": ("INT", {"forceInput": True}),
                "cfg": ("FLOAT", {"forceInput": True}),
                # Accept enum (matches KSampler)
                "sampler_name": (getattr(comfy.samplers.KSampler, "SAMPLERS", []), {"forceInput": True}),
                "scheduler": (getattr(comfy.samplers.KSampler, "SCHEDULERS", []), {"forceInput": True}),
                "width": ("INT", {"forceInput": True}),
                "height": ("INT", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("CONTROL",)
    RETURN_NAMES = ("warp",)

    def __init__(self):
        # Unique ID for this warp instance
        self._warp_id = uuid.uuid4().hex

    @classmethod
    def IS_CHANGED(cls, **kwargs) -> str:
        h = hashlib.sha256()
        for key in sorted(kwargs.keys()):
            if kwargs[key] is not None:  # Only hash non-None values
                h.update(f"{key}:{repr(kwargs[key])}".encode('utf-8'))
        return h.hexdigest()
    
    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs) -> bool:
        """Validate inputs - always return True for optional inputs"""
        return True

    def warp(
        self,
        warp: Optional[Dict[str, Any]] = None,
        image: Optional[Any] = None,
        mask: Optional[Any] = None,
        model: Optional[Any] = None,
        clip: Optional[Any] = None,
        clip_vision: Optional[Any] = None,
        vae: Optional[Any] = None,
        conditioning_positive: Optional[Any] = None,
        conditioning_negative: Optional[Any] = None,
        latent: Optional[Any] = None,
        prompt_positive: Optional[str] = None,
        prompt_negative: Optional[str] = None,
        batch_size: Optional[int] = None,
        seed: Optional[int] = None,
        steps_1: Optional[int] = None,
        steps_2: Optional[int] = None,
        steps_3: Optional[int] = None,
        cfg: Optional[float] = None,
        sampler_name: Optional[str] = None,
        scheduler: Optional[str] = None,
        width: Optional[int] = None,
        height: Optional[int] = None
    ) -> tuple:
        # If warp input provided, copy existing data
        if isinstance(warp, dict) and "id" in warp:
            prev_id = warp["id"]
            data = warp_storage.get(prev_id, {}).copy()
        else:
            data = {}

        # Normalize sampler/scheduler values
        normalized_sampler = coerce_sampler(sampler_name) if sampler_name is not None else None
        normalized_scheduler = coerce_scheduler(scheduler) if scheduler is not None else None

        # Apply any new inputs
        updates = {
            "image": image,
            "mask": mask,
            "model": model,
            "clip": clip,
            "clip_vision": clip_vision,
            "vae": vae,
            "conditioning_positive": conditioning_positive,
            "conditioning_negative": conditioning_negative,
            "latent": latent,
            "prompt_positive": prompt_positive,
            "prompt_negative": prompt_negative,
            "batch_size": batch_size,
            "seed": seed,
            "steps_1": steps_1,
            "steps_2": steps_2,
            "steps_3": steps_3,
            "cfg": cfg,
            "sampler_name": normalized_sampler,
            "scheduler": normalized_scheduler,
            "width": width,
            "height": height
        }
        for key, val in updates.items():
            if val is not None:
                data[key] = val

        with _storage_lock:
            warp_storage[self._warp_id] = data
        return ({"id": self._warp_id},)

class Unwarp:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "unwarp"
    DISPLAY_NAME = "Unwarp Bundle"
    DESCRIPTION = "Unpack a warp object back into individual data types"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "warp": ("CONTROL", {}),  # CONTROL carries the warp ID
            }
        }

    RETURN_TYPES = (
        "IMAGE",
        "MASK",
        "MODEL",
        "CLIP",
        "CLIP_VISION",
        "VAE",
        "CONDITIONING",
        "CONDITIONING",
        "LATENT",
        "STRING",
        "STRING",
        "INT",
        "INT",
        "INT",
        "INT",
        "INT",
        "FLOAT",
        getattr(comfy.samplers.KSampler, "SAMPLERS", []),
        getattr(comfy.samplers.KSampler, "SCHEDULERS", []),
        "INT",
        "INT",
    )
    RETURN_NAMES = (
        "image",
        "mask",
        "model",
        "clip",
        "clip_vision",
        "vae",
        "conditioning_positive",
        "conditioning_negative",
        "latent",
        "prompt_positive",
        "prompt_negative",
        "batch_size",
        "seed",
        "steps_1",
        "steps_2",
        "steps_3",
        "cfg",
        "sampler_name",
        "scheduler",
        "width",
        "height",
    )

    def unwarp(self, warp: Dict[str, Any]) -> tuple:
        if not isinstance(warp, dict) or "id" not in warp:
            raise ValueError("Invalid warp signal. Ensure it comes from a Warp node.")
        
        warp_id = warp["id"]
        with _storage_lock:
            data = warp_storage.get(warp_id, {})
        
        if not data:
            raise ValueError(f"Warp data not found for ID: {warp_id}. The warp may have been cleaned up or corrupted.")
        # Get width and height (either calculated from size_preset or direct values)
        width = data.get("width", 1024)
        height = data.get("height", 1024)
        
        return (
            data.get("image"),
            data.get("mask"),
            data.get("model"),
            data.get("clip"),
            data.get("clip_vision"),
            data.get("vae"),
            data.get("conditioning_positive"),
            data.get("conditioning_negative"),
            data.get("latent"),
            data.get("prompt_positive"),
            data.get("prompt_negative"),
            data.get("batch_size"),
            data.get("seed"),
            data.get("steps_1"),
            data.get("steps_2"),
            data.get("steps_3"),
            data.get("cfg"),
            coerce_sampler(data.get("sampler_name", "euler")),
            coerce_scheduler(data.get("scheduler", "karras")),
            width,
            height,
        )

class WarpProvider:
    """Parameter and latent provider for warp workflows"""
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "provide"
    DISPLAY_NAME = "Warp Provider"
    DESCRIPTION = "Generate latents and parameters for warp workflows"

    @classmethod
    def INPUT_TYPES(cls):
        # SDXL preset dimensions (common aspect ratios and sizes)
        sdxl_sizes = [
            "1024x1024",   # 1:1 Square
            "1152x896",    # 9:7 Landscape
            "896x1152",    # 7:9 Portrait
            "1216x832",    # 3:2 Landscape
            "832x1216",    # 2:3 Portrait
            "1344x768",    # 7:4 Landscape
            "768x1344",    # 4:7 Portrait
            "1536x640",    # 12:5 Ultrawide
            "640x1536",    # 5:12 Tall
            "Custom",      # Allow custom dimensions
        ]
        
        return {
            "optional": {
                # Generation Parameters
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "steps_1": ("INT", {"default": 20, "min": 1, "max": 200}),
                "steps_2": ("INT", {"default": 0, "min": 0, "max": 200}),
                "steps_3": ("INT", {"default": 0, "min": 0, "max": 200}),
                "cfg": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 50.0}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "normal"}),
                
                # Image Size Parameters
                "size_preset": (sdxl_sizes, {"default": "1024x1024"}),
                "custom_width": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "custom_height": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
            }
        }

    RETURN_TYPES = ("LATENT", "INT", "INT", "INT", "INT", "INT", "FLOAT", getattr(comfy.samplers.KSampler, "SAMPLERS", []), getattr(comfy.samplers.KSampler, "SCHEDULERS", []), "INT", "INT")
    RETURN_NAMES = ("latent", "batch_size", "seed", "steps_1", "steps_2", "steps_3", "cfg", "sampler_name", "scheduler", "width", "height")

    def provide(
        self,
        batch_size: int = 1,
        seed: int = 0,
        steps_1: int = 20,
        steps_2: int = 0,
        steps_3: int = 0,
        cfg: float = 7.0,
        sampler_name: str = "euler",
        scheduler: str = "normal",
        size_preset: str = "1024x1024",
        custom_width: int = 1024,
        custom_height: int = 1024
    ) -> tuple:
        
        # Helper function to create empty latent image
        def create_empty_latent(width: int, height: int, batch_size: int):
            import torch
            # Create empty latent tensor (standard for Stable Diffusion)
            # Latent space is 1/8 the size of image space for SD
            latent_width = width // 8
            latent_height = height // 8
            latent = torch.zeros([batch_size, 4, latent_height, latent_width])
            return {"samples": latent}

        # Determine actual dimensions from preset or custom values
        # LOGIC: If "Custom" is selected, use custom_width/custom_height fields
        # Otherwise, parse the preset string (e.g., "1024x1024" -> width=1024, height=1024)
        if size_preset == "Custom":
            width, height = custom_width, custom_height
        else:
            # Parse preset dimensions (e.g., "1024x1024" -> 1024, 1024)
            try:
                width_str, height_str = size_preset.split("x")
                width, height = int(width_str), int(height_str)
            except ValueError:
                # Fallback to default if parsing fails
                width, height = 1024, 1024

        # Create empty latent image based on dimensions and batch size
        latent = create_empty_latent(width, height, batch_size)
        
        # Use the provided seed directly (rgthree-comfy will handle seed control)
        actual_seed = seed
        
        # Return all outputs with coercion for compatibility
        return (
            latent,                          # LATENT
            batch_size,                      # INT
            actual_seed,                     # INT
            steps_1,                         # INT
            steps_2,                         # INT
            steps_3,                         # INT
            cfg,                             # FLOAT
            coerce_sampler(sampler_name),    # SAMPLER
            coerce_scheduler(scheduler),     # SCHEDULER
            width,                           # INT
            height                           # INT
        )

# Adapter: KSampler scheduler enum -> FaceDetailer scheduler enum
class FDSchedulerAdapter:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "adapt"
    DISPLAY_NAME = "FD Scheduler Adapter"
    DESCRIPTION = "Convert KSampler scheduler to FaceDetailer scheduler"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scheduler": (getattr(comfy.samplers.KSampler, "SCHEDULERS", []), {}),
            }
        }

    RETURN_TYPES = (FD_SCHEDULERS,)
    RETURN_NAMES = ("scheduler",)

    def adapt(self, scheduler: str) -> tuple:
        return (coerce_scheduler_fd(scheduler),)

# Register nodes under capitalized names
NODE_CLASS_MAPPINGS = {
    "Warp": Warp,
    "Unwarp": Unwarp,
    "Warp Provider": WarpProvider,
    "FD Scheduler Adapter": FDSchedulerAdapter
}

# Optional: Display names for the UI (newer ComfyUI feature)
NODE_DISPLAY_NAME_MAPPINGS = {
    "Warp": "🔀 Warp Bundle",
    "Unwarp": "🔄 Unwarp Bundle",
    "Warp Provider": "🏭 Warp Provider",
    "FD Scheduler Adapter": "🧩 FD Scheduler Adapter"
}

# Optional: Web directory for custom UI files (if you add them later)
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
