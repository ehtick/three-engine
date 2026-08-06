/**
 * Rewrites the player template's `index.html` for one build: page title,
 * favicon, and the loading screen's colours/logo.
 *
 * This is a string transform on purpose. The loading screen is visible before
 * a single byte of `scene.json` has been fetched, so anything read at runtime
 * would show the engine's default dark blue for a beat and *then* snap to the
 * game's colours — the one moment of a build where a flash of the wrong brand
 * is most obvious. Baking it into the HTML costs nothing and has no flash.
 *
 * Pure: no Tauri, no DOM. `npm run test:build` covers it.
 */

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/**
 * Colours land inside a `<style>` block, where an unvalidated string would be
 * a CSS injection (`red;} body{display:none` closes the rule). Only the hex
 * forms the colour pickers produce are accepted; anything else falls back.
 */
export function safeColor(value, fallback) {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(value ?? ""))
    ? String(value)
    : fallback;
}

/** `#rgb` / `#rrggbb` (with or without alpha) to `[r, g, b]` 0…255. */
export function hexToRgb(hex) {
  const h = String(hex).replace("#", "");
  const full = h.length <= 4 ? [...h.slice(0, 3)].map((c) => c + c).join("") : h.slice(0, 6);
  const n = Number.parseInt(full, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [0, 0, 0];
}

/**
 * Foreground for text sitting on `background`: white on a dark screen, near
 * black on a light one. Without this, picking a white loading background
 * produces an invisible progress bar and an invisible title — a build setting
 * whose effect is "the loading screen is now blank" is a trap, not an option.
 * Relative luminance (Rec. 709 coefficients), thresholded at the usual 0.55.
 */
export function readableForeground(background) {
  const [r, g, b] = hexToRgb(background);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? "16, 18, 21" : "255, 255, 255";
}

const LOADING_START = "<!--build:loading-->";
const LOADING_END = "<!--/build:loading-->";

/**
 * @param html    the template's index.html
 * @param options { title, icon (build-relative path or ""), loading }
 */
export function themePlayerHtml(html, { title = "", icon = "", loading = {} } = {}) {
  let out = String(html);

  // Title. The player also sets document.title on boot from the shipped
  // config, but that runs after the bundle has parsed — long enough for the
  // browser tab (and, worse, a bookmark) to read "Three Engine — Game".
  if (title) {
    out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  }

  const background = safeColor(loading.background, "#0d0e11");
  const accent = safeColor(loading.accent, "#0a84ff");
  const head = [];
  if (icon) {
    head.push(`<link rel="icon" href="${escapeHtml(icon)}" />`);
    // Colours the browser/OS chrome around the game on mobile and on some
    // desktop PWAs, so a full-bleed game doesn't sit in a white frame.
    head.push(`<meta name="theme-color" content="${background}" />`);
  } else {
    head.push(`<meta name="theme-color" content="${background}" />`);
  }
  head.push(
    `<style id="build-theme">:root{--loading-bg:${background};--loading-accent:${accent};` +
      `--loading-fg:${readableForeground(background)}}</style>`,
  );
  out = out.replace(/<\/head>/i, `${head.map((line) => `    ${line}`).join("\n")}\n  </head>`);

  // Loading screen contents. A template without the markers (someone shipped
  // their own index.html) keeps whatever it has — the colours above still
  // applied, so this degrades to "less customised", not "broken".
  const start = out.indexOf(LOADING_START);
  const end = out.indexOf(LOADING_END);
  if (start !== -1 && end > start) {
    const parts = [];
    if (icon && loading.showLogo !== false) {
      parts.push(`<img class="loading-logo" src="${escapeHtml(icon)}" alt="" />`);
    }
    if (title && loading.showTitle !== false) {
      parts.push(`<div class="loading-title">${escapeHtml(title)}</div>`);
    }
    parts.push('<div class="loading-bar"><div class="loading-bar-fill"></div></div>');
    parts.push('<div class="loading-label">Loading</div>');
    out =
      out.slice(0, start + LOADING_START.length) +
      `\n      ${parts.join("\n      ")}\n      ` +
      out.slice(end);
  }

  return out;
}

/** The build-relative marker both sides of the live-reload handshake agree
 *  on: the exporter writes it LAST, so a changed revision means "a complete
 *  new build is on disk". */
export const PREVIEW_REVISION_PATH = "__preview_revision.json";

/**
 * Injects the live-update client into a LIVE PREVIEW build's index.html.
 *
 * The rebuild loop keeps the served files fresh, but a browser (worst of all
 * a phone across the room) runs whatever it loaded until someone remembers to
 * refresh — which reads as "the hosted build is outdated". A reload poll used
 * to live inside the player bundle itself, but that put the staleness fix
 * inside the very artifact that goes stale: a build made from an old
 * dist-player template shipped an old (or no) poll. index.html is regenerated
 * by the exporter on EVERY build, so a client injected here works no matter
 * how old the template is.
 *
 * The client baselines on its FIRST successful poll rather than carrying a
 * baked-in revision: that keeps an unchanged index.html byte-identical across
 * rebuilds, which is what lets the exporter's change manifest tell "a material
 * was tweaked" apart from "the page itself changed".
 *
 * When the revision flips, the client prefers the player runtime's in-place
 * hook (`window.__playerLiveUpdate(changed)`) — materials re-apply live, a
 * scene edit restarts the scene without paying for a page load, WebGPU init
 * and shader compiles. A page that skipped intermediate rebuilds (a gizmo
 * drag outruns the 1s poll; a hidden tab misses many) unions the missed
 * deltas from the manifest's short history instead of giving up. It falls
 * back to a full `location.reload()` whenever the hook is missing (a stale
 * player template), declines (engine code changed), throws, or the running
 * revision is older than the whole history window.
 *
 * Deliberately dumb transport: no SSE, no sockets, nothing added to the Rust
 * server. One tiny same-origin fetch per second over the existing keep-alive
 * connection, `no-store` so the poll itself can never be cached. Fetch
 * failures are tolerated silently — the server dies with the editor, and when
 * it comes back with a fresh build the next successful poll catches up.
 * Hidden tabs don't poll; a phone updates when it is next looked at.
 *
 * Published builds never see this: the exporter only injects it when
 * `livePreview` is set, so a shipped game contains no polling loop.
 */
export function injectLivePreviewClient(html) {
  const client =
    `<script id="live-preview-client">(() => {\n` +
    `  let current = null;\n` +
    `  let busy = false;\n` +
    `  const tick = async () => {\n` +
    `    if (busy || document.hidden) return;\n` +
    `    busy = true;\n` +
    `    try {\n` +
    `      const res = await fetch("${PREVIEW_REVISION_PATH}", { cache: "no-store" });\n` +
    `      if (res.ok) {\n` +
    `        const data = await res.json();\n` +
    `        if (data && data.revision) {\n` +
    `          if (current === null) {\n` +
    `            current = data.revision;\n` +
    `          } else if (data.revision !== current) {\n` +
    `            const seen = current;\n` +
    `            current = data.revision;\n` +
    `            const hot = window.__playerLiveUpdate;\n` +
    `            let delta = null;\n` +
    `            if (data.previous === seen && Array.isArray(data.changed)) {\n` +
    `              delta = data.changed;\n` +
    `            } else if (Array.isArray(data.history)) {\n` +
    `              const i = data.history.findIndex((e) => e && e.revision === seen);\n` +
    `              if (i >= 0) {\n` +
    `                delta = [];\n` +
    `                for (const e of data.history.slice(i + 1)) {\n` +
    `                  if (!Array.isArray(e?.changed)) { delta = null; break; }\n` +
    `                  delta.push(...e.changed);\n` +
    `                }\n` +
    `              }\n` +
    `            }\n` +
    `            let applied = false;\n` +
    `            if (hot && delta) {\n` +
    `              try { applied = await hot(delta); } catch {}\n` +
    `            }\n` +
    `            if (!applied) location.reload();\n` +
    `          }\n` +
    `        }\n` +
    `      }\n` +
    `    } catch {}\n` +
    `    busy = false;\n` +
    `  };\n` +
    `  setInterval(tick, 1000);\n` +
    `  tick();\n` +
    `})();</script>`;
  const out = String(html);
  // Before </body> when the template has one; appended otherwise, which every
  // browser still executes.
  return /<\/body>/i.test(out)
    ? out.replace(/<\/body>/i, `  ${client}\n  </body>`)
    : `${out}\n${client}\n`;
}
