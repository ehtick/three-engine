import { defineConfig } from "vite";
import { renameSync } from "node:fs";

// Builds the standalone game player (no React, no Tauri) into dist-player/,
// used as the template by the editor's File → Export Game.
export default defineConfig({
  // RELATIVE, not the default "/". itch.io serves a game from
  // `https://html.itch.zone/html/<id>/index.html`, and so does every other
  // "unzip it into a subfolder" host — an absolute `/assets/player-x.js`
  // resolves against the domain root there and 404s, which is a white page
  // with no error the developer ever sees locally (localhost:port/ IS the
  // root, so the bug is invisible until it is in front of players).
  base: "./",
  build: {
    outDir: "dist-player",
    // The engine's own chunks are namespaced away from the flat `assets/`
    // folder the exporter fills with game content, so a texture can never
    // land on a bundle chunk's name.
    assetsDir: "_engine",
    rollupOptions: { input: "player.html" },
    chunkSizeWarningLimit: 2500,
  },
  plugins: [
    {
      name: "rename-entry-to-index",
      closeBundle: () => renameSync("dist-player/player.html", "dist-player/index.html"),
    },
    {
      // The template is PREBUILT: exports/browser previews copy dist-player
      // as-is, so after engine-source changes a dev checkout silently ships
      // day-old runtime code (cost a debugging session: the browser preview
      // ran the deleted SDF bake pipeline for a day). Stamp the build time
      // where exportGame can read and report it.
      name: "stamp-build-time",
      transformIndexHtml: (html) => html.replace("<head>", `<head>\n  <!-- player-template-built ${new Date().toISOString()} -->`),
    },
  ],
});
