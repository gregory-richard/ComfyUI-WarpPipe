# WarpPipe - ComfyUI Custom Nodes

WarpPipe is a comprehensive set of custom nodes for ComfyUI that provides a data bundling and transfer system. It allows you to package multiple data types (models, conditioning, images, etc.) into a single "warp" object that can be passed between nodes and then unpacked later in your workflow.

## Features

- **🔀 Warp Node**: Bundles multiple ComfyUI data types into a single transferable object
- **🔄 Unwarp Node**: Unpacks the bundled data back into individual outputs  
- **🏭 Warp Provider**: Generates latents and parameters for warp workflows with preset dimensions
- **🧩 FD Scheduler Adapter**: Converts KSampler schedulers to FaceDetailer-compatible schedulers
- **🚫 Dead End Node**: Accepts any input type but produces no output - perfect for debugging and workflow control
- **Flexible Data Transfer**: Pass models, CLIP, VAE, conditioning, images, latents, and workflow parameters together
- **Chain-able**: Warp nodes can copy and extend data from other warp nodes
- **Workflow Simplification**: Reduces cable clutter in complex workflows
- **Scheduler Compatibility**: Automatic coercion of exotic schedulers to safe, compatible values

## Installation

### Method 1: ComfyUI Manager (Recommended)
1. Open ComfyUI Manager
2. Search for "WarpPipe"
3. Click Install

### Method 2: Manual Installation
1. Navigate to your ComfyUI `custom_nodes` directory
2. Clone this repository:
   ```bash
   git clone https://github.com/gregory-richard/ComfyUi-WarpPipe.git
   ```
3. Restart ComfyUI

### Method 3: Download ZIP
1. Download the ZIP file from this repository
2. Extract to `ComfyUI/custom_nodes/warp_pipe-comfyui/`
3. Restart ComfyUI

## Nodes

### 🔀 Warp Node
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
- `mask`: MASK object
- `latent`: LATENT object
- `prompt_positive`: Positive prompt string
- `prompt_negative`: Negative prompt string
- `batch_size`: Batch size (INT)
- `seed`: Random seed (INT)
- `steps_1`: Primary sampling steps (INT)
- `steps_2`: Secondary sampling steps (INT)
- `steps_3`: Tertiary sampling steps (INT)
- `cfg`: CFG scale (FLOAT)
- `sampler_name`: Sampler name
- `scheduler`: Scheduler type
- `width`: Image width (INT)
- `height`: Image height (INT)

**Outputs**:
- `warp`: Bundled data object (CONTROL type)

### 🔄 Unwarp Node
**Category**: `Custom/WarpPipe Nodes`

Unpacks a warp object back into individual data types.

**Inputs**:
- `warp`: The warp object to unpack (CONTROL type)

**Outputs** (in order):
- `image`: IMAGE object
- `mask`: MASK object
- `model`: MODEL object
- `clip`: CLIP object
- `clip_vision`: CLIP_VISION object
- `vae`: VAE object
- `conditioning_positive`: Positive conditioning
- `conditioning_negative`: Negative conditioning
- `latent`: LATENT object
- `prompt_positive`: Positive prompt string
- `prompt_negative`: Negative prompt string
- `batch_size`: Batch size
- `seed`: Random seed
- `steps_1`: Primary sampling steps
- `steps_2`: Secondary sampling steps
- `steps_3`: Tertiary sampling steps
- `cfg`: CFG scale
- `sampler_name`: Sampler name
- `scheduler`: Scheduler type
- `width`: Image width
- `height`: Image height

### 🏭 Warp Provider Node
**Category**: `Custom/WarpPipe Nodes`

Generates latents and parameters for warp workflows with convenient preset dimensions.

**Inputs** (all optional):
- `batch_size`: Number of images to generate (default: 1)
- `seed`: Random seed (default: 0)
- `steps_1`: Primary sampling steps (default: 20)
- `steps_2`: Secondary sampling steps (default: 0)
- `steps_3`: Tertiary sampling steps (default: 0)
- `cfg`: CFG scale (default: 7.0)
- `sampler_name`: Sampler to use (default: "euler")
- `scheduler`: Scheduler to use (default: "normal")
- `size_preset`: Preset dimensions (1024x1024, 1152x896, etc.)
- `custom_width`: Custom width when "Custom" preset selected
- `custom_height`: Custom height when "Custom" preset selected

**Outputs**:
- `latent`: Generated empty latent
- `batch_size`: Batch size
- `seed`: Random seed
- `steps_1`: Primary sampling steps
- `steps_2`: Secondary sampling steps
- `steps_3`: Tertiary sampling steps
- `cfg`: CFG scale
- `sampler_name`: Sampler name
- `scheduler`: Scheduler type
- `width`: Image width
- `height`: Image height

### 🧩 FD Scheduler Adapter Node
**Category**: `Custom/WarpPipe Nodes`

Converts KSampler schedulers to FaceDetailer-compatible schedulers.

**Inputs**:
- `scheduler`: KSampler scheduler type

**Outputs**:
- `scheduler`: FaceDetailer-compatible scheduler

### 🚫 Dead End Node
**Category**: `Custom/WarpPipe Nodes`

A true dead end node that accepts any input type but produces no output. Perfect for debugging workflows, temporarily disabling branches, or testing specific parts of your workflow without affecting downstream execution.

**Inputs**:
- `input`: Any data type (*) - accepts any ComfyUI data type

**Outputs**:
- None - this node produces no outputs and does not trigger execution

**Use Cases**:
- **Debugging**: Connect any output to test if a workflow branch executes
- **Temporary Disabling**: Redirect workflow paths without deleting connections
- **Testing**: Isolate parts of complex workflows during development
- **Workflow Control**: Create clean endpoints for experimental branches

## Usage Examples

### Basic Usage
1. Add a **🔀 Warp** node to your workflow
2. Connect your models, conditioning, and other data to the Warp node inputs
3. Connect the Warp output to an **🔄 Unwarp** node
4. Use the Unwarp outputs in the rest of your workflow

### Using Warp Provider
1. Add a **🏭 Warp Provider** node to generate latents and parameters
2. Choose from preset dimensions (1024x1024, 1152x896, etc.) or use custom sizes
3. Connect the outputs directly to your sampling nodes or bundle them with a **🔀 Warp** node

### Chaining Warps
```
[Model] → [Warp A] → [Some Processing] → [Warp B] → [Unwarp] → [KSampler]
              ↑                            ↑
         [Additional Data]           [More Data]
```

Warp B can copy all data from Warp A and add additional data, creating a cumulative bundle.

### FaceDetailer Compatibility
```
[KSampler Scheduler] → [🧩 FD Scheduler Adapter] → [FaceDetailer Node]
```

Use the FD Scheduler Adapter to ensure scheduler compatibility with FaceDetailer nodes.

### Debugging and Workflow Control
```
[Model] → [KSampler] → [🚫 Dead End]
                    ↘ [VAE Decode] → [Save Image]
```

Use the Dead End node to temporarily disable the upper branch while keeping the lower branch active. Perfect for testing different workflow paths without deleting connections.

### Workflow Organization
Use WarpPipe to:
- **Reduce visual clutter** by bundling related data
- **Create reusable modules** that accept and return warp objects
- **Simplify complex workflows** with many interconnected nodes
- **Pass workflow state** between different processing stages
- **Handle scheduler compatibility** between different node types
- **Debug and test workflows** using the Dead End node for branch control

## Technical Details

- **Data Storage**: Uses a global storage system with unique IDs per warp instance
- **Data Types**: Supports all standard ComfyUI data types (MODEL, CLIP, VAE, CONDITIONING, IMAGE, LATENT, etc.)
- **Memory Management**: Thread-safe storage with automatic cleanup infrastructure
- **Scheduler Compatibility**: Automatic coercion of exotic schedulers to safe, compatible values
- **Preset Dimensions**: Built-in SDXL-optimized aspect ratios and sizes
- **Thread Safety**: All storage operations are protected by threading locks
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

### v2.1.0
- **Minor Feature Release** - Added workflow debugging capabilities
- Added **🚫 Dead End** node for workflow debugging and branch control
- Perfect for temporarily disabling workflow paths without deleting connections
- Accepts any input type using universal "*" type specifier
- True dead end - produces no outputs and doesn't trigger execution
- Enhanced workflow organization and testing capabilities
- Updated documentation with Dead End usage examples

### v2.0.0
- **Major Feature Release** - Complete WarpPipe ecosystem
- Added **🏭 Warp Provider** node with preset dimensions and latent generation
- Added **🧩 FD Scheduler Adapter** for FaceDetailer compatibility
- Enhanced scheduler compatibility with automatic coercion system
- Added support for mask data type
- Improved error handling and validation with ComfyUI import fallbacks
- Added comprehensive documentation and usage examples
- Thread-safe storage implementation with proper locking
- Support for multiple sampling steps (steps_1, steps_2, steps_3)
- Enhanced code structure with detailed docstrings
- Professional-grade documentation and README refresh
- Full backward compatibility maintained

### v1.0.0
- Initial release
- Basic **🔀 Warp** and **🔄 Unwarp** functionality
- Support for all major ComfyUI data types
