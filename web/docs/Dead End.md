# Dead End

A utility node that accepts any input but produces no output.

## Overview

The **Dead End** node is a workflow utility that accepts any data type but does nothing with it and produces no output. It creates a true dead end in the execution graph.

## Input

- **input** (optional) — Accepts any data type (wildcard).

## Output

None — this node has no outputs.

## Use Cases

- **Debugging**: Temporarily disconnect a branch of your workflow without deleting nodes.
- **Workflow organization**: Cleanly terminate unused output paths.
- **Testing**: Isolate parts of a workflow during development.

## Important Note

Because this node has no outputs and is not marked as an output node, it will **not trigger execution** on its own. It only runs if it's part of an execution path leading to an output node.
