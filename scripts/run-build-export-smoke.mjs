/**
 * The export walk, run against a REAL project through the editor's own code.
 *
 * The headless test proves the naming rules in isolation; this proves the
 * exporter uses them — over a project deliberately shaped like the one that
 * broke it. Downloaded PBR sets all name their maps the same thing, so
 * `textures/wood/color.png` and `textures/stone/color.png` are the normal case,
 * not a contrived one. Before this, both were copied to `assets/color.png`: the
 * build shipped, and one of the two materials silently wore the other's
 * texture. Nothing short of driving the real walk catches that, because the
 * bug is in the *mapping*, not in any single function.
 *
 * The Tauri shim serves the project read-only and stands in for the write
 * commands, so the manifest the exporter would have written is captured
 * instead of hitting the disk.
 *
 *   npx vite --port 5201
 *   node scripts/run-build-export-smoke.mjs [url]
 *
 * HEADED=1 to watch, KEEP=1 to leave the scratch project behind.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const ROOT = path.join(os.tmpdir(), "build-export-smoke").replaceAll("\\", "/");
const OUT = path.join(os.tmpdir(), "build-export-smoke-out").replaceAll("\\", "/");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// --- A project whose asset names collide ------------------------------------
// 1x1 PNG. The exporter never decodes these; it only has to route them.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const write = (rel, contents) => {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return `${ROOT}/${rel.replaceAll("\\", "/")}`;
};

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const woodTex = write("textures/wood/color.png", PNG);
const stoneTex = write("textures/stone/color.png", PNG);
// Two materials that share a basename too — documents go through a different
// code path (they are re-emitted, not copied) and collided just as silently.
const woodMat = write("materials/wood/Surface.mat", JSON.stringify({ name: "Wood", map: woodTex, color: "#ffffff" }));
const stoneMat = write("materials/stone/Surface.mat", JSON.stringify({ name: "Stone", map: stoneTex, color: "#888888" }));
write("art/logo.png", PNG);
write("scripts/Player.ts", "export default class Player { onUpdate() {} }\n");
const playerScript = `${ROOT}/scripts/Player.ts`;

const entity = (id, name, components = []) => ({
  id,
  name,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  components,
  children: [],
});
write(
  "scenes/Main.scene",
  JSON.stringify({
    version: 1,
    name: "Main",
    entities: [
      entity("wood", "Wood Box", [{ type: "mesh", props: { geometry: "box", material: woodMat } }]),
      entity("stone", "Stone Box", [{ type: "mesh", props: { geometry: "box", material: stoneMat } }]),
      entity("player", "Player", [{ type: "script", props: { scripts: [{ path: playerScript }] } }]),
      entity("cam", "Camera", [{ type: "camera", props: {} }]),
    ],
  }),
);
write("scenes/Level2.scene", JSON.stringify({ version: 1, name: "Level2", entities: [entity("c2", "Camera 2", [{ type: "camera", props: {} }])] }));
// A third scene that must NOT ship — the scene list is an allow-list.
write("scenes/Scratch.scene", JSON.stringify({ version: 1, name: "Scratch", entities: [] }));

write(
  "project.json",
  JSON.stringify(
    {
      name: "Collide",
      mainScene: "",
      settings: {
        game: { title: "Collide", saveVersion: 1 },
        build: {
          startScene: "scenes/Main.scene",
          scenes: ["scenes/Main.scene", "scenes/Level2.scene"],
          quality: "medium",
          target: "web",
          icon: "art/logo.png",
          loading: { background: "#123456", accent: "#abcdef", showTitle: true, showLogo: true },
        },
      },
    },
    null,
    2,
  ),
);

// --- Drive the editor -------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

/** Whatever the exporter asked the Rust side to write. */
let manifest = null;
const binaryWrites = [];
const zipCalls = [];

await installTauriShim(page, {
  writableRoot: OUT,
  verbose: !!process.env.VERBOSE,
  extraCommands: {
    export_game: (args) => {
      manifest = args;
      return null;
    },
    read_player_template: ({ rel }) => fs.readFileSync(path.join("dist-player", rel), "utf8"),
    write_binary_file: ({ path: p, contents }) => {
      binaryWrites.push([p, contents?.length ?? 0]);
      return null;
    },
    zip_dir: (args) => {
      zipCalls.push(args);
      return 0;
    },
  },
});

// Import the module instance the APP is using, not a fresh copy: Vite rewrites
// imports of files edited since the server started to `…?t=<mtime>`, so a bare
// import from the harness would load a SECOND editor with its own stores.
await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await new Promise((r) => setTimeout(r, 4000));

  // Opening a project ends in a store `refresh()` that routinely outlives the
  // `page.evaluate` that started it — puppeteer then rejects with "Promise was
  // collected". Park the result on the page and poll for it instead.
  await page.evaluate((root) => {
    globalThis.__opened = false;
    globalThis
      .__importLive("/src/editor/store/projectStore.js")
      .then((m) => m.useProjectStore.getState().openProject(root))
      .finally(() => {
        globalThis.__opened = true;
      });
  }, ROOT);
  await page.waitForFunction(() => globalThis.__opened === true, { timeout: 60000, polling: 200 });
  await new Promise((r) => setTimeout(r, 3000));

  // Kick the export off and park the result, rather than holding a CDP promise
  // across a long chain of store refreshes (which puppeteer garbage-collects).
  await page.evaluate((outDir) => {
    globalThis.__build = { done: false };
    globalThis
      .__importLive("/src/editor/exportGame.js")
      .then((m) => m.exportGame({ outDir }))
      .then((report) => Object.assign(globalThis.__build, { report, done: true }))
      .catch((error) => Object.assign(globalThis.__build, { error: String(error?.stack ?? error), done: true }));
  }, OUT);
  await page.waitForFunction(() => globalThis.__build?.done, { timeout: 120000, polling: 250 });
  const { report, error } = await page.evaluate(() => ({
    report: globalThis.__build.report,
    error: globalThis.__build.error ?? null,
  }));
  if (error) throw new Error(error);

  check("the export reports success", report?.ok === true, report?.error ?? "");
  check("it received a manifest to write", !!manifest, "");
  if (!manifest) throw new Error("export_game was never called");

  const assets = manifest.assets ?? [];
  const files = manifest.files ?? [];
  const dests = [...assets.map(([, rel]) => rel), ...files.map(([rel]) => rel)];
  const dupes = dests.filter((rel, i) => dests.indexOf(rel) !== i);
  check("no two shipped files claim the same destination", dupes.length === 0, [...new Set(dupes)].join(", "));

  const destOf = (source) => assets.find(([src]) => src.toLowerCase() === source.toLowerCase())?.[1] ?? null;
  const woodDest = destOf(woodTex);
  const stoneDest = destOf(stoneTex);
  check("both same-named textures ship", !!woodDest && !!stoneDest, `${woodDest} / ${stoneDest}`);
  check("under different names", woodDest !== stoneDest, `${woodDest} vs ${stoneDest}`);

  // The point of the whole exercise: each material must still name ITS OWN
  // texture after the rename. Uniqueness alone would be satisfied by a build
  // where both materials point at the same file.
  const fileBody = (predicate) => files.find(([rel]) => predicate(rel))?.[1];
  const matBodies = files.filter(([rel]) => rel.endsWith(".mat")).map(([rel, body]) => [rel, JSON.parse(body)]);
  check("both materials ship", matBodies.length === 2, matBodies.map(([rel]) => rel).join(", "));
  const wood = matBodies.find(([, def]) => def.name === "Wood")?.[1];
  const stone = matBodies.find(([, def]) => def.name === "Stone")?.[1];
  check("the wood material still points at the wood texture", wood?.map === woodDest, `${wood?.map} (want ${woodDest})`);
  check("the stone material still points at the stone texture", stone?.map === stoneDest, `${stone?.map} (want ${stoneDest})`);
  check(
    "the two materials do not share a texture",
    wood?.map !== stone?.map,
    `${wood?.map} vs ${stone?.map}`,
  );

  // The scene has to agree with the manifest, or the build ships correct files
  // nobody can find.
  const scene = JSON.parse(manifest.sceneJson);
  const matRefs = scene.entities
    .flatMap((e) => e.components ?? [])
    .filter((c) => c.type === "mesh")
    .map((c) => c.props.material);
  check("the scene names two distinct materials", new Set(matRefs).size === 2, matRefs.join(", "));
  check(
    "every material the scene names was shipped",
    matRefs.every((ref) => files.some(([rel]) => rel === ref)),
    matRefs.join(", "),
  );

  // Scripts: transpiled, renamed, and referenced by the new name.
  const scriptRef = scene.entities.flatMap((e) => e.components ?? []).find((c) => c.type === "script")?.props.scripts[0].path;
  check("the script reference points at a .js", /\.js$/.test(scriptRef ?? ""), String(scriptRef));
  check("and that file ships", files.some(([rel]) => rel === scriptRef), String(scriptRef));
  check("transpiled, not copied verbatim", !(fileBody((rel) => rel === scriptRef) ?? "").includes(": void"), "");

  // Build settings actually took.
  check("the configured start scene booted", scene.name === "Main", String(scene.name));
  check("scene.json records which path it is a copy of", scene.player?.startScene === "scenes/Main.scene", String(scene.player?.startScene));
  check("the quality preset shipped", scene.player?.quality === "medium", String(scene.player?.quality));
  check("the game title shipped", scene.player?.title === "Collide", String(scene.player?.title));

  const shippedScenes = files.filter(([rel]) => rel.endsWith(".scene")).map(([rel]) => rel);
  check("only the listed scenes ship", shippedScenes.length === 2, shippedScenes.join(", "));
  check("the scene left off the list is absent", !shippedScenes.some((s) => /Scratch/.test(s)), shippedScenes.join(", "));

  // index.html is rewritten, not just copied.
  const indexHtml = fileBody((rel) => rel === "index.html");
  check("index.html is rewritten for this game", !!indexHtml, "");
  check("with the configured loading colours", (indexHtml ?? "").includes("--loading-bg:#123456"), "");
  check("and the game's title", (indexHtml ?? "").includes("<title>Collide</title>"), "");

  // The icon goes beside index.html, not into assets/ — a favicon among the
  // game's textures reads like one of them.
  check(
    "the icon ships at the build root",
    assets.some(([src, rel]) => /logo\.png$/i.test(src) && rel === "icon.png"),
    assets.filter(([src]) => /logo/i.test(src)).map(([, rel]) => rel).join(", ") || "not shipped",
  );
  check("index.html links it as the favicon", (indexHtml ?? "").includes('<link rel="icon" href="icon.png"'), "");
  check("and shows it on the loading screen", (indexHtml ?? "").includes('class="loading-logo" src="icon.png"'), "");

  // --- The other two targets -------------------------------------------------
  // Same game, different delivery. Both take branches the web target never
  // touches, and a throw in either is invisible until someone picks it.
  const runTargetExport = async (target, outDir) => {
    manifest = null;
    zipCalls.length = 0;
    await page.evaluate(
      async ({ target: t, outDir: dir }) => {
        globalThis.__build = { done: false };
        const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
        const meta = useProjectStore.getState().projectMeta;
        useProjectStore.setState({
          projectMeta: { ...meta, settings: { ...meta.settings, build: { ...meta.settings.build, target: t } } },
        });
        globalThis
          .__importLive("/src/editor/exportGame.js")
          .then((m) => m.exportGame({ outDir: dir }))
          .then((r) => Object.assign(globalThis.__build, { report: r, done: true }))
          .catch((e) => Object.assign(globalThis.__build, { error: String(e?.stack ?? e), done: true }));
      },
      { target, outDir },
    );
    await page.waitForFunction(() => globalThis.__build?.done, { timeout: 120000, polling: 250 });
    return page.evaluate(() => ({ report: globalThis.__build.report, error: globalThis.__build.error ?? null }));
  };

  const zipRun = await runTargetExport("zip", `${OUT}/zip`);
  check("the zip target builds", zipRun.report?.ok === true, zipRun.error ?? zipRun.report?.error ?? "");
  check("it zipped the build folder", zipCalls.length === 1, JSON.stringify(zipCalls));
  check(
    "the archive is named after the game",
    /Collide\.zip$/.test(zipCalls[0]?.dest ?? ""),
    zipCalls[0]?.dest ?? "",
  );
  // The archive must be a SIBLING of what it archives. Written inside, it
  // would be walked into itself — a zip containing a growing copy of itself.
  check(
    "the build goes in its own folder",
    zipCalls[0]?.dir === `${OUT}/zip/Collide`,
    `${zipCalls[0]?.dir} (want ${OUT}/zip/Collide)`,
  );
  check(
    "and the archive sits beside it, not inside it",
    zipCalls[0]?.dest === `${OUT}/zip/Collide.zip`,
    String(zipCalls[0]?.dest),
  );
  check(
    "the manifest was written into that folder",
    manifest?.outDir === `${OUT}/zip/Collide`,
    String(manifest?.outDir),
  );

  const desktopOut = `${OUT}/desktop`;
  const desktopRun = await runTargetExport("desktop", desktopOut);
  check("the desktop target builds", desktopRun.report?.ok === true, desktopRun.error ?? desktopRun.report?.error ?? "");
  check(
    "the game itself goes under web/",
    manifest?.outDir === `${desktopOut}/web`,
    String(manifest?.outDir),
  );
  const scaffolded = (rel) => fs.existsSync(path.join(desktopOut, rel));
  check(
    "the Tauri project is written beside it",
    ["package.json", "README.md", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/src/main.rs"].every(scaffolded),
    fs.existsSync(desktopOut) ? fs.readdirSync(desktopOut).join(", ") : "nothing written",
  );
  if (scaffolded("src-tauri/tauri.conf.json")) {
    const conf = JSON.parse(fs.readFileSync(path.join(desktopOut, "src-tauri/tauri.conf.json"), "utf8"));
    check("its shell points at the web build", conf.build.frontendDist === "../web", String(conf.build.frontendDist));
    check("and carries the game's name", conf.productName === "Collide", String(conf.productName));
  }
  check(
    "the icon is written for the native bundle",
    binaryWrites.some(([p]) => p.endsWith("src-tauri/icons/icon.png")),
    binaryWrites.map(([p]) => p).join(", ") || "none",
  );

  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (err) {
  check("harness completed", false, err.message);
} finally {
  await browser.close();
  if (!process.env.KEEP) {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.rmSync(OUT, { recursive: true, force: true });
  }
}

console.log(`\nBUILD-EXPORT-SMOKE ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
