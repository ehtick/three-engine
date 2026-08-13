# Three Engine

A Tauri 2 + React (plain JS) game engine editor built around three.js r185 WebGPU/TSL,
PlayCanvas/Unity-style. Render with WebGPU when available, fall back to WebGL2.

## Features

**Rendering & lighting**
- WebGPU-first renderer with WebGL2 fallback, running inside Tauri 2
- Real-time global illumination (Split Radiance Cascades): world-space probe cascades,
  multibounce, emissive meshes as area lights with analytic PCSS soft shadows,
  BVH-traced sun/light shadows, exact reflections — one `quality` dial
- Node-based shader graph and particle system editors, volumetric materials
- LOD groups, octahedral impostors, Hi-Z occlusion culling, virtual geometry
  (cluster LOD), dynamic resolution, GPU timestamp profiling

**Authoring**
- Entity + component editor: undo/redo command bus, prefabs, autosave, Play/Stop
  with snapshot restore, Blender-style geometry edit mode (BMesh), splines, terrain
- TypeScript scripting with a fully typed `engine` API, decorator attributes,
  hot reload, multi-script dispatch; typed events system with a no-code node graph
- Timeline sequencer, animator state machines, blend trees, masks, root motion,
  two-bone IK, camera rigs with priority blending
- Texture editor (paint, layers, processing, atlases/sprites), audio editor
  (23 effects, seamless loops, variations, Ogg/Opus export), embedded Monaco
  code editor with vim mode
- Physics via Rapier: collision layers/matrix, shape queries, joints, moving
  platforms; navigation (recast) with debug draw; save system; object pooling;
  decals/trails/line VFX; UI components rendered in one pass

**Content & publishing**
- In-editor asset browsers: Poly Haven, Poly Pizza, Sketchfab, itch.io, ambientCG,
  Google Fonts, Freesound audio library — import without leaving the editor
- Draco + Basis/KTX2 compression on import, binary geometry cache
- One-click build & publish: web/zip/desktop export, Cloudflare Pages deploy,
  live LAN preview server with no-reload hot updates

**Automation**
- Editor API exposed over MCP (`three-engine`): 160+ ops (scene, assets, git,
  profiling, screenshots) so AI agents can drive the whole editor; multi-session
  broker lets several agents share one editor

## Running

```bash
npm install
npm run tauri dev   # full editor in a Tauri window
npm run dev         # vite-only, opens in browser (limited without Tauri APIs)
npm run build       # production editor build
npm run build:player # export a self-contained game template to dist-player/
```

## Project layout

- `src/engine/` — React-free, Tauri-free runtime (exported games ship this)
- `src/editor/` — React editor: command bus, zustand stores, dockview shell, panels
- `src/player/` — React-free game runtime template (consumes `src/engine/`)
- `src/modules/` — optional engine modules (GI, physics, importers, asset browsers)
- `src-tauri/` — Rust side: filesystem, dialogs, opener plugin, bundle config

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
