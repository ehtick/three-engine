import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;

// QUIET MODE — `.no-hmr` sentinel in the repo root (or VITE_NO_HMR env).
// Disables the HMR/reload PUSH only: the watcher and module graph stay
// fresh, so a manual F5 always gets current code, but a running editor (or
// a puppeteer harness page) is never yanked mid-session by another agent's
// file edits. Made for parallel Claude sessions working in this repo while
// the editor is open. Checked at SERVER START — editing this config
// auto-restarts every running vite, which is how a toggle takes effect;
// delete the sentinel and restart to restore hot reload.
const quietHmr = existsSync(new URL("./.no-hmr", import.meta.url)) || !!process.env.VITE_NO_HMR;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // The repo root, baked in at config-load time.
  //
  // The "Connect Claude / Codex" buttons register `node <repo>/mcp/server.mjs`
  // with the local CLIs, so they need an absolute path to a file in this
  // checkout. Nothing inside the webview can derive that: `import.meta.url` is
  // an http:// URL in dev, and Tauri's path APIs describe the app's install and
  // data directories, not the source tree it happens to be served from. The
  // build system is the only layer that knows, so it says so.
  define: {
    __ENGINE_REPO_ROOT__: JSON.stringify(process.cwd().replaceAll("\\", "/")),
  },

  // The `three` npm package's `package.json` only declares explicit
  // export-map entries for `./webgpu` and `./tsl` — bare `three/addons/*`
  // subpaths are NOT in the export map, so Vite's runtime module
  // resolver fails with "Failed to resolve module specifier" when our
  // postGraph.js dynamic `import("three/addons/tsl/display/...js")`
  // calls hit the browser. Map the prefix onto the actual file layout
  // (`three/examples/jsm/...` = the same files, served from
  // node_modules). We use the multi-line array syntax because the
  // regex form has subtle anchoring issues across Vite versions —
  // this explicit-prefix form is reliable.
  resolve: {
    alias: {
      "three/addons": "three/examples/jsm",
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: quietHmr
      ? false
      : host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // Warm the dep cache before the WebView asks for the first import. Cuts
    // several seconds off `tauri dev` cold start because Vite would
    // otherwise transform three/webgpu + dockview on demand.
    warmup: {
      clientFiles: ["./index.html", "./src/main.jsx"],
    },
  },

  // Pre-bundle deps that are large, slow to transform, or imported from
  // many different lazy chunks. Without this Vite re-esbuilds them per
  // import path on first load, which stretches `tauri dev`'s first WebView
  // paint to multi-seconds.
  //
  // We list post-process addons under their **resolved** alias target
  // (`three/examples/jsm/...`) rather than the bare `three/addons/...`
  // form because `optimizeDeps.include` resolves at config-load time,
  // before the `resolve.alias` plugin fully bootstraps. Pre-bundling
  // them is what makes the first `import("three/addons/...")` resolve
  // instantly instead of triggering an on-demand transform chain.
  //
  // `entries` tells the dep-scanner to walk our source tree when
  // looking for dynamic imports — without this, Vite only scans
  // statically-imported deps and would miss the lazy `import()` calls
  // inside `postGraph.js`, leaving the bare `three/addons/...`
  // specifiers un-resolved at module-graph build time (which surfaces
  // as the "Failed to resolve module specifier" runtime warning).
  // `entries` is just a glob covering our app source so the scanner
  // walks it during cold-start optimization.
  optimizeDeps: {
    entries: ["src/**/*.js", "src/**/*.jsx"],
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "dockview-react",
      "@xyflow/react",
      "three",
      "three/webgpu",
      // External controls / studios' interactive controls
      "three/examples/jsm/controls/OrbitControls.js",
      "three/examples/jsm/controls/TransformControls.js",
      // Post-process addons (TSL display nodes). Each is dynamically
      // `import()`-ed from `postGraph.js`; pre-bundling them shaves
      // hundreds of ms off first-compile + drops a bunch of "Failed
      // to resolve module specifier" errors in the browser console
      // (the `resolve.alias` block above handles the runtime path).
      "three/examples/jsm/tsl/display/SSGINode.js",
      "three/examples/jsm/tsl/display/SSRNode.js",
      "three/examples/jsm/tsl/display/DenoiseNode.js",
      "three/examples/jsm/tsl/display/TRAANode.js",
      "three/examples/jsm/tsl/display/BloomNode.js",
      "three/examples/jsm/tsl/display/GodraysNode.js",
      "three/examples/jsm/tsl/display/depthAwareBlend.js",
      "three/examples/jsm/tsl/display/DepthOfFieldNode.js",
      "three/examples/jsm/tsl/display/ChromaticAberrationNode.js",
      "three/examples/jsm/tsl/display/FilmNode.js",
      "three/examples/jsm/tsl/display/FXAANode.js",
      "three/examples/jsm/tsl/display/SMAANode.js",
      "three/examples/jsm/tsl/display/SobelOperatorNode.js",
      "three/examples/jsm/tsl/display/RGBShiftNode.js",
      "three/examples/jsm/tsl/display/SharpenNode.js",
      "three/examples/jsm/tsl/display/AfterImageNode.js",
      "three/examples/jsm/tsl/display/Sepia.js",
      "three/examples/jsm/tsl/display/BleachBypass.js",
      "three/examples/jsm/tsl/display/DotScreenNode.js",
      "three/examples/jsm/tsl/display/Lut3DNode.js",
      "three/examples/jsm/tsl/display/GaussianBlurNode.js",
      "three/examples/jsm/tsl/display/BilateralBlurNode.js",
      "three/examples/jsm/tsl/display/MotionBlur.js",
      "three/examples/jsm/tsl/display/FSR1Node.js",
      "lucide-react",
      "zustand",
      "immer",
      "esbuild-wasm",
      "nanoid",
      "@tauri-apps/plugin-dialog",
    ],
  },
}));
