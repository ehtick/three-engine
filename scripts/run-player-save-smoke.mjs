/**
 * Save/load in a REAL exported build (src/engine/saveSystem.js end to end).
 *
 * `npm run test:saves` proves the logic against an in-memory backend. What it
 * cannot prove is the thing a player actually depends on: that closing the tab
 * and coming back finds the save still there. So this builds a small game,
 * serves it over HTTP, drives it in Chrome, saves a slot, **reloads the page**,
 * and loads it back — through the default localStorage backend, real script
 * modules fetched over the network, and a real scene change.
 *
 * Run `npm run build:player` first (this serves dist-player).
 */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(root, "dist-player");
const out = path.join(root, ".tmp-save-smoke");

if (!existsSync(template)) {
  console.error("dist-player/ is missing — run `npm run build:player` first.");
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
};

// --- Fixture game -----------------------------------------------------------
const entity = (id, name, extra = {}) => ({
  id,
  name,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  components: [],
  children: [],
  ...extra,
});
const camera = (id, name) => entity(id, name, { components: [{ type: "camera", props: {} }] });
const scripted = (id, name, file) =>
  entity(id, name, {
    components: [{ type: "script", props: { scripts: [{ path: file, enabled: true, attributes: {} }] } }],
  });

const startScene = {
  version: 1,
  name: "Level1",
  player: { title: "Save Smoke", saveId: "save-smoke", saveVersion: 1 },
  entities: [scripted("player", "Player", "scripts/Player.js"), camera("l1-cam", "Level 1 Camera")],
};
const level2 = {
  version: 1,
  name: "Level2",
  entities: [scripted("player", "Player", "scripts/Player.js"), camera("l2-cam", "Level 2 Camera")],
};

// A real script module, fetched and linked by the player's own loader.
const PLAYER_SCRIPT = `
export default class Player {
  health = 100;
  coins = 0;
  onSave() { return { health: this.health, coins: this.coins }; }
  onLoad(data) { this.health = data?.health ?? 100; this.coins = data?.coins ?? 0; }
}
`;

await rm(out, { recursive: true, force: true });
await cp(template, out, { recursive: true });
await writeFile(path.join(out, "scene.json"), JSON.stringify(startScene));
await mkdir(path.join(out, "scenes"), { recursive: true });
await writeFile(path.join(out, "scenes", "Level2.scene"), JSON.stringify(level2));
await mkdir(path.join(out, "scripts"), { recursive: true });
await writeFile(path.join(out, "scripts", "Player.js"), PLAYER_SCRIPT);

// --- Serve it ---------------------------------------------------------------
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".scene": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm",
};
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\//, "") || "index.html";
  try {
    const body = await readFile(path.join(out, rel));
    res.writeHead(200, { "Content-Type": MIME[path.extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

// --- Drive it ---------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

/** Boots the player and waits until scripts are live. */
async function boot() {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => globalThis.__engine?.playing === true, { timeout: 45000 });
  await page.waitForFunction(
    () => !!globalThis.__engine.getEntity("player")?.getComponent("script")?.slots?.[0]?.instance,
    { timeout: 20000 },
  );
}

const script = (extra = "") =>
  `globalThis.__engine.getEntity("player").getComponent("script").slots[0].instance${extra}`;

try {
  await boot();
  check("the build boots with its save namespace applied", await page.evaluate(() => globalThis.__engine.saves.namespace) === "save-smoke");
  check(
    "saves report themselves as durable (real localStorage, not the memory fallback)",
    await page.evaluate(() => globalThis.__engine.saves.durable) === true,
  );

  // --- write a slot ---------------------------------------------------------
  await page.evaluate(`(async () => {
    ${script(".health = 37")};
    ${script(".coins = 12")};
    globalThis.__engine.getEntity("player").object3D.position.set(4, 1, -2);
    globalThis.__engine.saves.state.set("checkpoint", "cave");
    globalThis.__engine.prefs.set("volume", 0.25);
    await globalThis.__engine.prefs.flush();
    await globalThis.__engine.saves.save(1);
  })()`);

  const stored = await page.evaluate(() =>
    Object.keys(globalThis.localStorage).filter((k) => k.startsWith("engine.save.v1.save-smoke")),
  );
  check(
    "the slot and the prefs really landed in localStorage",
    stored.some((k) => k.endsWith(".slot.1")) && stored.some((k) => k.endsWith(".prefs")),
    stored.join(", "),
  );

  // --- reload the page, as a player closing the tab would -------------------
  await boot();

  check(
    "after a reload the script is back at its defaults",
    await page.evaluate(script(".health")) === 100,
  );
  check(
    "...but preferences were already restored at boot",
    await page.evaluate(() => globalThis.__engine.prefs.get("volume")) === 0.25,
  );

  const list = await page.evaluate(() => globalThis.__engine.saves.list());
  check("the slot survived the reload and lists", list.length === 1 && list[0].slot === "1", JSON.stringify(list));
  check("its header names the scene it belongs to", list[0]?.scene === "scene.json", String(list[0]?.scene));

  const loaded = await page.evaluate(() => globalThis.__engine.saves.load(1));
  check("loading the slot reports success", loaded === true);

  const after = await page.evaluate(`(() => ({
    health: ${script(".health")},
    coins: ${script(".coins")},
    position: globalThis.__engine.getEntity("player").object3D.position.toArray(),
    checkpoint: globalThis.__engine.saves.state.get("checkpoint"),
  }))()`);
  check("script state came back through onLoad", after.health === 37 && after.coins === 12, JSON.stringify(after));
  check("the player is standing where they saved", after.position.join(",") === "4,1,-2", after.position.join(","));
  check("progress state came back with the slot", after.checkpoint === "cave", String(after.checkpoint));

  // --- a save taken in another level restores that level --------------------
  await page.evaluate(() => globalThis.__engine.loadScene("scenes/Level2.scene"));
  await page.waitForFunction(
    () => globalThis.__engine.scenes.active?.path === "scenes/Level2.scene" &&
      !!globalThis.__engine.getEntity("player")?.getComponent("script")?.slots?.[0]?.instance,
    { timeout: 30000 },
  );
  await page.evaluate(`(async () => {
    ${script(".health = 5")};
    await globalThis.__engine.saves.save("level2");
  })()`);
  await page.evaluate(() => globalThis.__engine.loadScene("scene.json"));
  await page.waitForFunction(() => globalThis.__engine.scenes.active?.path === "scene.json", { timeout: 30000 });

  await page.evaluate(() => globalThis.__engine.saves.load("level2"));
  await page.waitForFunction(() => globalThis.__engine.scenes.active?.path === "scenes/Level2.scene", { timeout: 30000 });
  check("loading a save taken in another level takes you back to that level", true);
  check("...with its script state", await page.evaluate(script(".health")) === 5);

  // --- deletion -------------------------------------------------------------
  await page.evaluate(() => globalThis.__engine.saves.delete(1));
  check("a deleted slot is gone", await page.evaluate(() => globalThis.__engine.saves.has(1)) === false);
  check(
    "deleting a save leaves preferences standing",
    await page.evaluate(() => globalThis.__engine.prefs.get("volume")) === 0.25,
  );

  const fatal = pageErrors.filter((m) => !/WebGPU|GPUAdapter|deprecat/i.test(m));
  check("no page errors", fatal.length === 0, fatal.slice(0, 2).join(" | "));
} catch (error) {
  failures++;
  console.error("  FAIL harness threw");
  console.error(`       ${error.message}`);
} finally {
  await browser.close();
  server.close();
  await rm(out, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} player save check(s) failed`);
  process.exit(1);
}
console.log("\nall player save checks passed");
