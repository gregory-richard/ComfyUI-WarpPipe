---
name: comfyui-publish
description: Publish ComfyUI custom nodes to the Comfy Registry. Covers pyproject.toml metadata, semantic versioning, changelog conventions, GitHub Actions CI/CD, and comfy-cli publishing. Use when the user wants to publish, release, version, or update a custom node on the registry.
---

# Publishing ComfyUI Custom Nodes

## Quick Reference

Publishing requires: a Comfy Registry account, a publisher ID, a `pyproject.toml` with `[tool.comfy]` metadata, and either `comfy-cli` or GitHub Actions.

Docs: https://docs.comfy.org/registry/publishing
Specs: https://docs.comfy.org/registry/specifications

## pyproject.toml Structure

The `pyproject.toml` must include both `[project]` and `[tool.comfy]` sections:

```toml
[project]
name = "your-node-name"          # Unique ID. Immutable after creation. No "ComfyUI" prefix.
version = "1.0.0"                # Semantic versioning (MAJOR.MINOR.PATCH)
description = "Brief description"
license = { text = "MIT" }
requires-python = ">=3.9"
dependencies = []                # Or use dynamic from requirements.txt

[project.urls]
Repository = "https://github.com/user/repo"

[tool.comfy]
PublisherId = "your-publisher-id"  # From registry.comfy.org profile
DisplayName = "Your Node Name"
Icon = "https://raw.githubusercontent.com/.../icon.png"    # Square, max 400x400
Banner = "https://raw.githubusercontent.com/.../banner.png" # 21:9 ratio
```

### Name Requirements
- Case-insensitive, no leading numbers/special chars, no consecutive special chars
- Only alphanumeric, hyphens, underscores, periods. Max 100 chars
- Don't include "ComfyUI" in the name

### Optional Fields
- `requires-comfyui = ">=1.0.0"` - ComfyUI version compatibility
- `includes = ['dist']` - Force-include gitignored folders
- `classifiers` for OS/GPU compatibility

## Semantic Versioning

Follow [semver](https://semver.org/):
- **PATCH** (Z): Bug fixes, no API changes
- **MINOR** (Y): New features, backward compatible
- **MAJOR** (X): Breaking changes (renamed types, removed inputs, changed behavior)

## Release Workflow

### Step-by-step release process

1. **Develop** on a feature/fix branch
2. **Update `CHANGELOG.md`** with changes under new version header
3. **Bump version** in `pyproject.toml` (`version = "X.Y.Z"`)
4. **Update `version.txt`** if the project uses one (keep in sync)
5. **Commit** with conventional message: `release: vX.Y.Z`
6. **Push to main** - GitHub Action auto-publishes on `pyproject.toml` change
7. **Create GitHub Release** (optional but recommended) with tag `vX.Y.Z`

### Commit Convention for Releases

```
release: vX.Y.Z

- Summary of changes
- Another change
```

For regular development commits, use conventional prefixes:
- `feat:` new features
- `fix:` bug fixes
- `refactor:` code restructuring
- `docs:` documentation changes
- `chore:` maintenance tasks

## CHANGELOG.md Format

```markdown
# Changelog

## [X.Y.Z] - YYYY-MM-DD

### Breaking Changes
- Description of breaking change

### Added
- New feature description

### Fixed
- Bug fix description

### Improved
- Enhancement description
```

## Publishing Methods

### Option 1: GitHub Actions (recommended)

File: `.github/workflows/publish_action.yml`

```yaml
name: Publish to Comfy Registry
on:
  workflow_dispatch:
  push:
    branches:
      - main
    paths:
      - "pyproject.toml"

jobs:
  publish-node:
    name: Publish Custom Node to Registry
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      - name: Publish Custom Node
        uses: Comfy-Org/publish-node-action@main
        with:
          personal_access_token: ${{ secrets.REGISTRY_ACCESS_TOKEN }}
```

**Setup**: Go to repo Settings > Secrets and Variables > Actions > New Repository Secret. Name: `REGISTRY_ACCESS_TOKEN`, Value: your API key from https://registry.comfy.org/nodes.

Triggers on any push to `main` that modifies `pyproject.toml`.

### Option 2: Manual CLI

```bash
comfy node publish
```

Prompts for API key. On Windows, right-click paste (Ctrl+V may add `\x16`).

## Pre-publish Checklist

- [ ] Version bumped in `pyproject.toml`
- [ ] `version.txt` updated (if used)
- [ ] `CHANGELOG.md` updated with new version section
- [ ] All node classes registered in `NODE_CLASS_MAPPINGS`
- [ ] `__init__.py` exports `NODE_CLASS_MAPPINGS`, `NODE_DISPLAY_NAME_MAPPINGS`, `WEB_DIRECTORY`
- [ ] `requirements.txt` lists all dependencies (no ComfyUI/torch/torchvision)
- [ ] No secrets or credentials in committed files
- [ ] Test nodes load without errors in ComfyUI console
