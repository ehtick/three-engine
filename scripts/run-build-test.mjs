/**
 * Headless checks over the build system's decision-making.
 *
 * Everything here is a pure module — the destination-name allocator, the scene
 * plan, the quality ceiling, the index.html rewrite and the desktop scaffold —
 * deliberately kept free of Tauri and the DOM so the parts of a build that
 * silently produce a *wrong* game (rather than a failed one) are testable in
 * Node. The smoke (`npm run smoke:build`) covers the parts that need a browser.
 *
 * Usage: npm run test:build
 */
import { createAssetNames, splitExtension } from "../src/editor/build/assetNames.js";
import {
  BUILD_DEFAULTS,
  resolveBuildScenes,
  normalizeRelPath,
  toProjectRelative,
} from "../src/editor/build/buildSettings.js";
import {
  themePlayerHtml,
  readableForeground,
  safeColor,
  hexToRgb,
  injectLivePreviewClient,
  PREVIEW_REVISION_PATH,
} from "../src/editor/build/playerHtml.js";
import {
  cargoName,
  bundleIdentifier,
  desktopScaffoldFiles,
  desktopTauriConfig,
} from "../src/editor/build/desktopScaffold.js";
import { QUALITY_PRESETS, applyQualityCeiling } from "../src/engine/sceneSettings.js";
import { sanitizeFileName } from "../src/editor/exportGame.js";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

// --- Destination names -------------------------------------------------------
console.log("\nAsset destination names");
{
  const names = createAssetNames();
  const a = names.claim("C:/proj/textures/wood/color.png");
  const b = names.claim("C:/proj/textures/stone/color.png");
  check("two sources with one basename get different destinations", a !== b, `${a} vs ${b}`);
  eq("the first keeps the natural name", a, "assets/color.png");
  eq("the second is suffixed", b, "assets/color-1.png");

  const again = names.claim("C:/proj/textures/wood/color.png");
  eq("asking twice for one source gives one answer", again, a);
  eq(
    "separators and case don't create a second copy",
    names.claim("c:\\proj\\textures\\wood\\color.png"),
    a,
  );

  eq("a sidecar follows the renamed asset", names.claimSidecar("C:/proj/textures/stone/color.png", ".meta"), "assets/color-1.png.meta");
  check(
    "the copy list carries the original source path",
    names.copyEntries().some(([src]) => src === "C:/proj/textures/stone/color.png"),
  );

  // Generated documents (a rewritten .mat, a transpiled script) share the
  // namespace — otherwise a .mat could be written over a copied file.
  const script = names.claimGenerated("C:/proj/scripts/Player.ts", { rename: (n) => n.replace(/\.ts$/i, ".js") });
  eq("a transpiled script lands as .js", script, "assets/Player.js");
  const clash = names.claimGenerated("C:/proj/other/Player.ts", { rename: (n) => n.replace(/\.ts$/i, ".js") });
  check("two scripts with one name don't collide", clash !== script, `${script} vs ${clash}`);
  check("generated docs are not in the copy list", !names.copyEntries().some(([, rel]) => rel === script));

  eq("release frees the name for reuse", (() => {
    const n = createAssetNames();
    n.claim("/a/x.png");
    n.release("/a/x.png");
    return n.claim("/b/x.png");
  })(), "assets/x.png");

  // The icon belongs beside index.html, not among the game's textures.
  eq("an explicit destination is honoured", names.claimAt("C:/proj/art/logo.png", "icon.png"), "icon.png");
  check(
    "and it still gets copied",
    names.copyEntries().some(([src, rel]) => src === "C:/proj/art/logo.png" && rel === "icon.png"),
  );
  eq(
    "an explicit destination that is taken is uniquified too",
    (() => {
      const n = createAssetNames();
      n.claimAt("/a/one.png", "icon.png");
      return n.claimAt("/b/two.png", "icon.png");
    })(),
    "icon-1.png",
  );

  eq("non-string values pass through", names.claim(null), null);
  eq("extensionless files still work", createAssetNames().claim("/a/LICENSE"), "assets/LICENSE");
  eq("a dotfile keeps its dot", splitExtension(".gitignore"), [".gitignore", ""]);
}

// --- Scene plan --------------------------------------------------------------
console.log("\nScene selection");
{
  const available = ["scenes/Menu.scene", "scenes/Level1.scene", "scenes/Level2.scene"];

  let plan = resolveBuildScenes({ available, build: BUILD_DEFAULTS, mainScene: "scenes/Menu.scene" });
  eq("no explicit start scene falls back to the project's main scene", plan.startScene, "scenes/Menu.scene");
  eq("ships every scene by default", plan.scenes.length, 3);
  eq("the start scene is listed first", plan.scenes[0], "scenes/Menu.scene");

  plan = resolveBuildScenes({
    available,
    build: { ...BUILD_DEFAULTS, startScene: "scenes/Level2.scene" },
    mainScene: "scenes/Menu.scene",
  });
  eq("an explicit start scene wins over the main scene", plan.startScene, "scenes/Level2.scene");

  plan = resolveBuildScenes({
    available,
    build: BUILD_DEFAULTS,
    mainScene: "",
    openScene: "scenes/Level1.scene",
  });
  eq("with neither set, the open scene boots", plan.startScene, "scenes/Level1.scene");

  plan = resolveBuildScenes({
    available,
    build: { ...BUILD_DEFAULTS, startScene: "scenes/Deleted.scene" },
    mainScene: "scenes/Menu.scene",
  });
  eq("a start scene that no longer exists falls back", plan.startScene, "scenes/Menu.scene");
  check("and says so", plan.warnings.some((w) => w.includes("Deleted.scene")), plan.warnings.join(" | "));

  // The one that produces a black screen with no error in a shipped build.
  plan = resolveBuildScenes({
    available,
    build: { ...BUILD_DEFAULTS, startScene: "scenes/Level2.scene", scenes: ["scenes/Menu.scene"] },
  });
  check("a start scene left out of the list is added back", plan.scenes.includes("scenes/Level2.scene"), plan.scenes.join(","));
  check("and warns", plan.warnings.some((w) => w.includes("not in the build list")), plan.warnings.join(" | "));

  plan = resolveBuildScenes({
    available,
    build: { ...BUILD_DEFAULTS, scenes: ["scenes/Menu.scene", "scenes/Gone.scene"] },
    mainScene: "scenes/Menu.scene",
  });
  eq("a listed scene that vanished is dropped", plan.scenes, ["scenes/Menu.scene"]);
  check("and warns", plan.warnings.some((w) => w.includes("Gone.scene")));

  eq(
    "case and separators match the project's own spelling",
    resolveBuildScenes({
      available,
      build: { ...BUILD_DEFAULTS, startScene: "SCENES\\level1.scene" },
    }).startScene,
    "scenes/Level1.scene",
  );

  eq("an empty project resolves to nothing rather than throwing", resolveBuildScenes({ available: [] }).startScene, "");
}

console.log("\nPath helpers");
{
  eq("normalize strips ./ and leading /", normalizeRelPath("./scenes/A.scene"), "scenes/A.scene");
  eq("normalize converts separators", normalizeRelPath("scenes\\sub\\A.scene"), "scenes/sub/A.scene");
  eq(
    "project-relative strips the root",
    toProjectRelative("C:/proj", "C:\\proj\\scenes\\A.scene"),
    "scenes/A.scene",
  );
  eq(
    "a path outside the project is left alone",
    toProjectRelative("C:/proj", "D:/elsewhere/A.scene"),
    "D:/elsewhere/A.scene",
  );
  eq("zip names drop filesystem-hostile characters", sanitizeFileName('My: Game?/v1 *'), "My Game v1");
  eq("a name of nothing but illegal characters still yields one", sanitizeFileName("///"), "game");
}

// --- Quality ceiling ---------------------------------------------------------
console.log("\nQuality presets");
{
  const authored = { performance: { maxDevicePixelRatio: 2, renderScale: 1, volumeStepScale: 1, dynamicResolution: false }, shadows: true };

  const low = applyQualityCeiling(authored, "low");
  check("low lowers the pixel ratio", low.performance.maxDevicePixelRatio === 1, String(low.performance.maxDevicePixelRatio));
  check("low lowers render scale", low.performance.renderScale === QUALITY_PRESETS.low.renderScale);
  check("low turns dynamic resolution on", low.performance.dynamicResolution === true);
  check("low turns shadows off", low.shadows === false);

  // The rule the whole design rests on: a preset may only make things cheaper.
  const cheap = { performance: { maxDevicePixelRatio: 1, renderScale: 0.5, volumeStepScale: 0.3, dynamicResolution: true }, shadows: true };
  const high = applyQualityCeiling(cheap, "high");
  eq(
    "a hand-tuned cheap scene is not raised by a higher preset",
    ["maxDevicePixelRatio", "renderScale", "volumeStepScale"].map((k) => high.performance[k]),
    [1, 0.5, 0.3],
  );
  check("nor is its dynamic resolution turned off", high.performance.dynamicResolution === true);

  const ultra = applyQualityCeiling(authored, "ultra");
  eq("ultra ships the scene exactly as authored", ultra, authored);
  eq("an unknown preset is a no-op, not an error", applyQualityCeiling(authored, "cinematic"), authored);
  eq("no preset is a no-op", applyQualityCeiling(authored, null), authored);

  const noPerf = applyQualityCeiling({}, "low");
  check("a scene with no performance block still gets the ceiling", noPerf.performance.maxDevicePixelRatio === 1);
}

// --- Player HTML -------------------------------------------------------------
console.log("\nLoading screen");
{
  const template = `<!doctype html>
<html><head><title>Three Engine — Game</title></head>
<body><div id="loading">
<!--build:loading-->
<div class="loading-bar"><div class="loading-bar-fill"></div></div>
<div class="loading-label">Loading</div>
<!--/build:loading-->
</div></body></html>`;

  const out = themePlayerHtml(template, {
    title: "Night & Day",
    icon: "icon.png",
    loading: { background: "#101820", accent: "#ffcc00", showTitle: true, showLogo: true },
  });
  check("the tab title is baked in", out.includes("<title>Night &amp; Day</title>"), "");
  check("the title is escaped", !out.includes("<title>Night & Day"), "");
  check("colours reach the CSS variables", out.includes("--loading-bg:#101820") && out.includes("--loading-accent:#ffcc00"));
  check("a favicon is linked", out.includes('<link rel="icon" href="icon.png"'));
  check("the logo shows on the loading screen", out.includes('class="loading-logo" src="icon.png"'));
  check("so does the game title", out.includes('class="loading-title">Night &amp; Day<'));
  check("the progress bar survives the rewrite", out.includes("loading-bar-fill"));
  check("the markers are still there for a re-theme", out.includes("<!--build:loading-->"));

  const off = themePlayerHtml(template, {
    title: "Night",
    icon: "icon.png",
    loading: { background: "#101820", accent: "#ffcc00", showTitle: false, showLogo: false },
  });
  check("logo can be turned off", !off.includes("loading-logo"));
  check("title can be turned off", !off.includes("loading-title"));

  // A colour string lands inside a <style> block, so it is an injection site.
  const injected = themePlayerHtml(template, {
    loading: { background: "red;}body{display:none}#x{a:b", accent: "#0a84ff" },
  });
  check("a non-hex colour is refused, not interpolated", !injected.includes("display:none"), "");
  check("and falls back to the default", injected.includes("--loading-bg:#0d0e11"));
  eq("safeColor accepts the picker's formats", [safeColor("#fff", "x"), safeColor("#a1b2c3", "x"), safeColor("rgb(1,2,3)", "x")], ["#fff", "#a1b2c3", "x"]);

  // A white loading screen must not have invisible white text on it.
  eq("dark backgrounds get light text", readableForeground("#0d0e11"), "255, 255, 255");
  eq("light backgrounds get dark text", readableForeground("#ffffff"), "16, 18, 21");
  eq("short hex expands", hexToRgb("#fff"), [255, 255, 255]);

  const noMarkers = themePlayerHtml("<html><head><title>x</title></head><body></body></html>", {
    title: "Game",
    loading: { background: "#123456" },
  });
  check("a template without markers still gets its colours", noMarkers.includes("--loading-bg:#123456"));
  check("and does not throw", noMarkers.includes("<title>Game</title>"));
}

// --- Live-preview reload client ----------------------------------------------
// The client is injected into the exporter-generated index.html precisely so
// it works with a STALE player template — if these drift, "the hosted preview
// is outdated" comes back as a silent failure.
console.log("\nLive-preview reload client");
{
  const themed = themePlayerHtml(
    "<html><head><title>x</title></head><body><div id=\"game\"></div></body></html>",
    { title: "Game" },
  );
  const revision = 1754200000000;
  const out = injectLivePreviewClient(themed, revision);
  check("the client is injected before </body>", /live-preview-client[\s\S]*<\/body>/.test(out));
  check("the game markup survives", out.includes('<div id="game">'));
  check(
    "it polls the marker the exporter writes last",
    out.includes(`fetch("${PREVIEW_REVISION_PATH}"`),
  );
  eq("the marker path matches the exporter contract", PREVIEW_REVISION_PATH, "__preview_revision.json");
  check("the build's own revision is baked in", out.includes(`const initial = ${revision};`));
  check("polls bypass every cache", out.includes('cache: "no-store"'));
  check("hidden tabs don't poll", out.includes("document.hidden"));
  check("a changed revision reloads", out.includes("location.reload()"));

  const headless = injectLivePreviewClient("<html><head></head></html>", 42);
  check("a template without </body> still gets the client", headless.includes("live-preview-client"));

  // The injection is exporter-conditional (livePreview only), but double-check
  // the theming path alone never smuggles it into a release build.
  check("theming alone does not inject the client", !themed.includes("live-preview-client"));
}

// --- Desktop scaffold --------------------------------------------------------
console.log("\nDesktop scaffold");
{
  eq("cargo names are slugified", cargoName("Night & Day!"), "night-day");
  eq("a title starting with a digit gets a prefix", cargoName("2048"), "game-2048");
  eq("a title of pure punctuation still yields a name", cargoName("!!!"), "game");
  eq("identifiers are reverse-DNS with no underscores", bundleIdentifier("Night & Day"), "com.night-day.game");

  const files = Object.fromEntries(desktopScaffoldFiles({ title: "Night & Day" }));
  for (const rel of ["package.json", "README.md", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/build.rs", "src-tauri/src/main.rs"]) {
    check(`scaffold emits ${rel}`, typeof files[rel] === "string" && files[rel].length > 0);
  }
  const conf = JSON.parse(files["src-tauri/tauri.conf.json"]);
  eq("the shell points at the exported web build", conf.build.frontendDist, "../web");
  check(
    "WebGPU is enabled in the webview (a black window otherwise)",
    conf.app.windows[0].additionalBrowserArgs.includes("--enable-unsafe-webgpu"),
  );
  eq("the product name is the game's", conf.productName, "Night & Day");
  check("the identifier is not Tauri's rejected placeholder", conf.identifier !== "com.tauri.dev", conf.identifier);
  check("Cargo.toml parses as a package with tauri", files["src-tauri/Cargo.toml"].includes('name = "night-day"') && files["src-tauri/Cargo.toml"].includes("tauri = "));
  check("main.rs runs a Tauri builder", files["src-tauri/src/main.rs"].includes("tauri::Builder::default()"));
  check("target/ and node_modules/ are ignored", files[".gitignore"].includes("src-tauri/target/"));

  const noIcon = JSON.parse(desktopTauriConfig({ title: "X", identifier: "com.x.game", hasIcon: false }));
  check("no icon means no icon list to fail on", noIcon.bundle.icon === undefined);
}

console.log(`\nBUILD-TEST ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
