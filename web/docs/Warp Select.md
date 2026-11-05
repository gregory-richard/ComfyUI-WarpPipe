# Warp Select

Pick which Warp Send runs and feed it into Generate.

## Overview

Use one **Warp Select** in the hub. Its dropdown lists all Warp Sends ordered by index. Picking a Send in the dropdown activates it, the same as pressing **activate** on that Send. It outputs the active Send's **warp** and **index**, which you connect to Generate. The **go to active group** button only moves the canvas to the active Send; it does not change which one is active. The node is green while the route is valid and red otherwise.

## Outputs

- **warp** — The warp of the active Send.
- **index** — The index of the active Send, for Generate's model switch.

## Blocked runs

The run is blocked with a message when:

- no Warp Send is active,
- the active Send is muted or bypassed, or sits inside a muted or bypassed subgraph,
- two Sends share a name or an index,
- the active Send has no warp input,
- the workflow has no Warp Send at all.
