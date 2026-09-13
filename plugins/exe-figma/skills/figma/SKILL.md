---
name: figma
description: Read Figma files, frames and components through the figma MCP server of the current context (work, freelance or personal account). Use for /figma, a figma.com link, "get the design", "export this frame", "what does the mockup say", or implementing UI from a Figma file.
---

The `figma` MCP server is started by exe-figma with the personal access token of the current directory's context, so a repo of one organization reads that organization's files. Tools: `get_figma_data` for layout and styles, `download_figma_images` for assets.

## Recipes

| Ask | Do |
|---|---|
| a figma.com link | file key is the segment after `/design/` or `/file/`; `node-id=12-34` in the URL becomes `nodeId` `12:34` |
| one frame or component | `get_figma_data` with `fileKey` and `nodeId`, `depth` 1 or 2 |
| whole page overview | `get_figma_data` with `fileKey` only and `depth` 1, then drill into the node you need |
| icons or images | `download_figma_images` with the node ids and a `localPath` inside the repo |

## Rules

- Always pass `nodeId` when the user points at a frame. A whole file without depth is huge and gets imaged by pxpipe, where exact values become unreliable.
- Quote design values (sizes, colors, spacing) exactly as returned; do not round.
- If the server reports 403 or "not found", the token belongs to another account or the file is in a team this account cannot see. Run `exe ctx show` and `exe doctor --context <name>` and report the failing line. Do not ask the user to paste a token; point them to `exe secret set figma-<context>`.
- Starter-plan files allow only a handful of API reads per month; say so when a request fails with a rate-limit error on a personal file.
- The plugin is enabled per project: `claude plugin enable exe-figma@exe --scope project`, then restart the session.
