# WarpPipe - ComfyUI Custom Nodes

WarpPipe is a set of custom nodes for ComfyUI that provides a data bundling and transfer system. It allows you to package multiple data types (models, conditioning, images, etc.) into a single "warp" object that can be passed between nodes and then unpacked later in your workflow.

## Features

- **Warp Node**: Bundles multiple ComfyUI data types into a single transferable object
- **Unwarp Node**: Unpacks the bundled data back into individual outputs
- **Flexible Data Transfer**: Pass models, CLIP, VAE, conditioning, images, latents, and workflow parameters together
- **Chain-able**: Warp nodes can copy and extend data from other warp nodes
- **Workflow Simplification**: Reduces cable clutter in complex workflows

## Installation

### Method 1: ComfyUI Manager (Recommended)
1. Open ComfyUI Manager
2. Search for "WarpPipe"
3. Click Install

### Method 2: Manual Installation
1. Navigate to your ComfyUI `custom_nodes` directory
2. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/warp_pipe-comfyui.git
   ```
3. Restart ComfyUI

### Method 3: Download ZIP
1. Download the ZIP file from this repository
2. Extract to `ComfyUI/custom_nodes/warp_pipe-comfyui/`
3. Restart ComfyUI

## Nodes

### Warp Node
**Category**: `Custom/WarpPipe Nodes`

Bundles multiple data types into a single "warp" object.

**Inputs** (all optional):
- `warp`: Copy data from an existing warp object
- `model`: MODEL object
- `clip`: CLIP object  
- `clip_vision`: CLIP_VISION object
- `vae`: VAE object
- `conditioning_positive`: Positive conditioning
- `conditioning_negative`: Negative conditioning
- `image`: IMAGE object
- `latent`: LATENT object
- `prompt_positive`: Positive prompt string
- `prompt_negative`: Negative prompt string
- `initial_steps`: Initial sampling steps (INT)
- `detailer_steps`: Detail enhancement steps (INT)
- `upscaler_steps`: Upscaling steps (INT)
- `cfg`: CFG scale (FLOAT)
- `sampler_name`: Sampler name
- `scheduler`: Scheduler type

**Outputs**:
- `warp`: Bundled data object (CONTROL type)

### Unwarp Node
**Category**: `Custom/WarpPipe Nodes`

Unpacks a warp object back into individual data types.

**Inputs**:
- `warp`: The warp object to unpack (CONTROL type)

**Outputs** (in order):
- `model`: MODEL object
- `clip`: CLIP object
- `clip_vision`: CLIP_VISION object
- `vae`: VAE object
- `conditioning_positive`: Positive conditioning
- `conditioning_negative`: Negative conditioning
- `image`: IMAGE object
- `latent`: LATENT object
- `prompt_positive`: Positive prompt string
- `prompt_negative`: Negative prompt string
- `initial_steps`: Initial sampling steps
- `detailer_steps`: Detail enhancement steps
- `upscaler_steps`: Upscaling steps
- `cfg`: CFG scale
- `sampler_name`: Sampler name
- `scheduler`: Scheduler type

## Usage Examples

### Basic Usage
1. Add a **Warp** node to your workflow
2. Connect your models, conditioning, and other data to the Warp node inputs
3. Connect the Warp output to an **Unwarp** node
4. Use the Unwarp outputs in the rest of your workflow

### Chaining Warps
```
[Model] → [Warp A] → [Some Processing] → [Warp B] → [Unwarp] → [KSampler]
              ↑                            ↑
         [Additional Data]           [More Data]
```

Warp B can copy all data from Warp A and add additional data, creating a cumulative bundle.

### Workflow Organization
Use WarpPipe to:
- **Reduce visual clutter** by bundling related data
- **Create reusable modules** that accept and return warp objects
- **Simplify complex workflows** with many interconnected nodes
- **Pass workflow state** between different processing stages

## Technical Details

- **Data Storage**: Uses a global storage system with unique IDs per warp instance
- **Data Types**: Supports all standard ComfyUI data types
- **Memory Management**: Automatic cleanup when warp objects are no longer referenced
- **Compatibility**: Works with all existing ComfyUI nodes and custom nodes

## Troubleshooting

### Node Not Appearing
- Ensure you've restarted ComfyUI after installation
- Check the console for any error messages during startup
- Verify all files are in the correct directory

### Function Errors
- Make sure you're using the latest version of ComfyUI
- Check that all node connections are valid
- Verify input data types match expected formats

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details

## Changelog

### v1.0.0
- Initial release
- Basic Warp and Unwarp functionality
- Support for all major ComfyUI data types
