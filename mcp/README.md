# Engine Editor MCP server

Lets an assistant drive the editor: inspect the scene, create and edit entities
and components, read and write project files, run the game, undo.

The tools are not defined here. They are the editor's own operation registry
(`src/editor/api/registry.js`) — the same surface in-editor scripts use through
`import { Editor } from "editor"`. Adding an op in `src/editor/api/ops/` makes it
an MCP tool with no change to this directory.

## Setup

**1. Turn the bridge on in the editor.** Open the **Assistant (MCP)** panel —
View → Assistant (MCP), or click the `MCP` chip in the menu bar — and flip the
switch. It is off on a first run, because it opens a loopback socket any local
process could sit on; after that the choice is remembered for the editor (not
per project), so it survives restarts.

**2. Register the server with your client.** The same panel lists the CLIs it
found, with a **Connect** button each. They run the CLI's own `mcp add` with the
absolute path to this server, user-wide,
and are idempotent (pressing again after moving the repo updates the path). A
button greys out when that CLI isn't installed, and a registered client shows a
tick. Restart any already-running CLI session to pick the server up.

By hand, if you prefer or aren't in the desktop app:

```sh
claude mcp add three-engine -- node /absolute/path/to/engine/mcp/server.mjs
codex  mcp add three-engine -- node /absolute/path/to/engine/mcp/server.mjs
```

Or, for a client that reads a JSON config:

```json
{
  "mcpServers": {
    "three-engine": {
      "command": "node",
      "args": ["/absolute/path/to/engine/mcp/server.mjs"]
    }
  }
}
```

Start the editor (`npm run dev`, or the desktop app) and open a project. Order
doesn't matter — whichever starts second connects to the first.

**3. Optionally, run the CLI inside the editor.** View → Terminal opens a real
terminal panel docked with Assets, with one-click Claude Code / Codex / Shell.
It starts in the open project's directory, so the assistant and the editor are
looking at the same thing without alt-tabbing. It is a genuine PTY, not a chat
box — permission prompts, `/` commands and Ctrl-C all work.

## How it fits together

```
assistant ──stdio(MCP)──▶ mcp/server.mjs ──WebSocket──▶ editor (src/editor/api/mcpBridge.js)
                                                             │
                                                             ▼
                                                     registry.js → commandBus
```

The server is a short-lived process the MCP client spawns; the editor is a long-
lived browser/webview that cannot listen on a socket. So the server hosts the
WebSocket on `127.0.0.1` and the editor dials in, reconnecting with backoff —
expect the bridge to connect and disconnect repeatedly across a working session
as conversations start and end.

Every mutating tool runs through the editor's command bus, so anything an
assistant does lands on the undo stack and can be reverted with Ctrl+Z (or the
`history_undo` tool) exactly like a hand edit.

## Tools

`editor_status` always exists, even with no editor connected — call it first if
other tools are missing, since it distinguishes "the editor is closed" from a
real failure. Everything else is generated from the registry:

| Group | Tools |
|---|---|
| **Sight** | `viewport_screenshot` `viewport_getCamera` `viewport_setCamera` `viewport_focus` `entity_getBounds` `console_read` |
| **Batching** | `batch` |
| Entities | `entity_list` `entity_get` `entity_create` `entity_delete` `entity_rename` `entity_reparent` `entity_duplicate` `entity_setTransform` `entity_setTags` |
| Components | `component_types` `component_add` `component_remove` `component_setProp` |
| Materials | `material_create` `material_get` `material_set` |
| Prefabs | `prefab_list` `prefab_instantiate` `prefab_createFromEntity` |
| Selection | `selection_get` `selection_set` `selection_selectAssets` |
| History | `history_get` `history_undo` `history_redo` |
| Play mode | `play_get` `play_set` |
| Scene / project | `scene_get` `scene_save` `scene_open` `scene_getSettings` `scene_setSettings` `project_get` |
| Assets | `asset_list` `asset_read` `asset_write` `asset_import` `asset_createScript` `asset_openInIDE` `asset_reveal` |
| Modules | `module_list` `module_setEnabled` |

### The two that change how you work

**`viewport_screenshot` returns a real image.** Without it an assistant builds
3D scenes blind — it can read transforms but cannot tell that a wall is inside
another wall, that a light is buried in geometry, or that a material came out
black. Take one after anything visual, and use `viewport_focus` /
`viewport_setCamera` to aim first. `entity_getBounds` is its companion: sizes
are not inferable from transforms, because a mesh's real extent depends on its
geometry as well as its scale.

**`batch` runs many ops as one undo step.** Building a room is a dozen calls;
one at a time that is a dozen round trips and a dozen separate entries on the
undo stack, so a user who dislikes the result has to press Ctrl+Z twelve times
and guess when to stop. Inside a batch, `"$0"` in a later step's arguments
resolves to the id returned by step 0 — that is how you attach a component to an
entity you just created. It is not atomic: if step 7 fails, steps 1–6 happened,
and the response says exactly which — but one undo still removes all of them.

MCP forbids dots in tool names, so `entity.create` is advertised as
`entity_create`; the server maps it back.

`component_types` is the discovery tool — it returns every registered component
type with its defaults and inspector schema, which is what tells an assistant
what `component_add` will accept.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ENGINE_MCP_PORT` | `17325` | Bridge port. Must match the port in the Assistant (MCP) panel. |
| `ENGINE_MCP_TIMEOUT_MS` | `30000` | How long a forwarded call may take. |
| `ENGINE_MCP_GRACE_MS` | `10000` | How long `tools/list` waits for an editor at startup. |

Two editors cannot share a port; the second server to start exits with an
explanation. Run a second instance on another port by setting `ENGINE_MCP_PORT`
on the server and matching it in that editor's Assistant (MCP) panel.

## Scope, deliberately

Writes are confined to the open project folder (`insideProject` in
`src/editor/api/ops/assets.js`). That is a blast-radius limit, not a security
boundary — the bridge has the editor's full privileges, and anything on the
local machine that can reach the port can use it. Leave it disabled when you
are not using it.

## Testing

```sh
npm run test:mcp         # server + protocol, against a fake editor — no browser
npm run smoke:mcp        # end-to-end: real server, real editor, real scene edits
npm run smoke:editor-api # the ops themselves, incl. screenshot + batch (HEADED)
npm run smoke:authoring  # materials, scene look, prefabs, import, modules
npm run smoke:mcp-ui     # the Assistant panel, DOM-only (incl. survives-a-reload)
npm run smoke:terminal   # the terminal panel's frontend, against a shimmed PTY
npm run test:rust        # the Rust half: a real PTY, and CLI resolution
```

The terminal is the one feature no single test covers end to end: the PTY lives
in Rust and the emulator in the webview, and they only meet in the desktop app.
`test:rust` proves a real pseudo-terminal runs a child and returns its output;
`smoke:terminal` proves the panel spawns, renders, and forwards keystrokes
correctly against a stand-in. Both passing is strong evidence, not proof.
