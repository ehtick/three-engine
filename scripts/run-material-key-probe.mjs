// MATERIAL PROGRAM-KEY PROBE — why do N same-family materials mint N programs?
//
// §13.15 measured the material compile wave at 26 distinct fragment shaders for
// 27 same-bucket materials, and the WGSL diff (normalized for three's node-id
// naming leak) showed within-family pairs to be the SAME program modulo
// numbering, declaration order and one temp-materialization choice. So the cost
// is not structural variety — it is three.js re-running codegen because the
// PROGRAM CACHE KEY differs per material instance. This probe names the exact
// key component that differs, per family, by reconstructing r185's
// `RenderObject.getMaterialCacheKey()` property walk WITH the property names
// kept (the renderer throws them away — RenderObject.js:803 comments out
// `property + ':'`), then diffing two same-family materials property by
// property.
//
// Run:  node scripts/run-material-key-probe.mjs [baseUrl]
// Env:  PROJECT=<path>   (defaults to the GAME project, same as the boot probe)
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let waveDone = false;
page.on("console", (m) => {
  const t = m.text();
  if (/compile wave: materials \d+ms, computes \d+ms/.test(t)) waveDone = true;
});

await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  globalThis.__giSrcProbes = true;
}, PROJECT);

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });

// The scene must be fully loaded and materials attached; the wave-done line is
// the cheapest signal that everything renderable exists. Cap the wait — key
// analysis does not actually need the compiles to have finished.
const deadline = Date.now() + 240000;
while (Date.now() < deadline && !waveDone) await wait(500);
await wait(1500);

const report = await page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const renderer = engine.renderer;
  const isWebGPU = renderer?.backend?.isWebGPUBackend === true;

  // ── EXACT replica of r185 RenderObject.js getKeys() ────────────────────────
  const protoKeysCache = new Map();
  const getKeys = (obj) => {
    const keys = Object.keys(obj);
    let protoKeys = protoKeysCache.get(obj.constructor);
    if (protoKeys === undefined) {
      protoKeys = [];
      let proto = Object.getPrototypeOf(obj);
      while (proto) {
        const descriptors = Object.getOwnPropertyDescriptors(proto);
        for (const key in descriptors) {
          if (typeof descriptors[key]?.get === "function") protoKeys.push(key);
        }
        proto = Object.getPrototypeOf(proto);
      }
      protoKeysCache.set(obj.constructor, protoKeys);
    }
    return keys.concat(protoKeys);
  };

  // ── EXACT replica of the getMaterialCacheKey property walk, but keeping the
  //    property names the renderer discards ─────────────────────────────────
  const keyParts = (material) => {
    const parts = [];
    let custom = "(threw)";
    try { custom = String(material.customProgramCacheKey()); } catch {}
    parts.push(["customProgramCacheKey", custom]);
    for (const property of getKeys(material)) {
      if (/^(is[A-Z]|_)|^(visible|version|uuid|name|opacity|userData)$/.test(property)) continue;
      let value;
      try { value = material[property]; } catch { continue; }
      let valueKey;
      if (value !== null && value !== undefined) {
        const type = typeof value;
        if (type === "number") {
          valueKey = property === "side" ? String(value) : (value !== 0 ? "1" : "0");
        } else if (type === "object") {
          valueKey = "{";
          if (value.isTexture) {
            valueKey += value.mapping;
            if (isWebGPU) {
              valueKey += value.magFilter;
              valueKey += value.minFilter;
              valueKey += value.wrapS;
              valueKey += value.wrapT;
              valueKey += value.wrapR;
            }
          }
          valueKey += "}";
        } else {
          valueKey = String(value);
        }
      } else {
        valueKey = String(value);
      }
      parts.push([property, valueKey]);
    }
    return parts;
  };

  // ── Collect every material actually hanging on a rendered mesh ────────────
  const materials = new Map(); // material -> { objects: [], parts, family }
  engine.scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isInstancedMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat) continue;
      let entry = materials.get(mat);
      if (!entry) {
        const maps = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap"]
          .filter((k) => !!mat[k]);
        entry = { objects: [], parts: keyParts(mat), family: `${mat.type}[${maps.join("+")}]`, name: mat.name || "(unnamed)" };
        materials.set(mat, entry);
      }
      entry.objects.push({
        name: obj.name || "(unnamed)",
        instanced: obj.isInstancedMesh === true || (obj.count ?? 1) > 1,
        geoAttrs: obj.geometry ? Object.keys(obj.geometry.attributes).sort().join(",") : "",
      });
    }
  });

  // ── Group by family, then by full key inside the family ───────────────────
  const families = new Map();
  for (const [, e] of materials) {
    const fam = families.get(e.family) ?? { members: [] };
    e.fullKey = e.parts.map(([k, v]) => `${k}=${v}`).join("|");
    fam.members.push(e);
    families.set(e.family, fam);
  }

  const out = { isWebGPU, totalMaterials: materials.size, families: [] };
  for (const [family, fam] of families) {
    const byKey = new Map();
    for (const m of fam.members) (byKey.get(m.fullKey) ?? byKey.set(m.fullKey, []).get(m.fullKey)).push(m);
    const f = {
      family,
      members: fam.members.length,
      distinctKeys: byKey.size,
      names: fam.members.map((m) => m.name).slice(0, 30),
      instancedObjects: fam.members.flatMap((m) => m.objects).filter((o) => o.instanced).length,
      geoAttrSets: [...new Set(fam.members.flatMap((m) => m.objects.map((o) => o.geoAttrs)))],
      diff: null,
    };
    // The payload: property-level diff of the first two DIFFERENT-key members.
    if (byKey.size > 1) {
      const [a, b] = [...byKey.values()].map((g) => g[0]);
      const pa = new Map(a.parts), pb = new Map(b.parts);
      const props = new Set([...pa.keys(), ...pb.keys()]);
      const diffs = [];
      for (const p of props) {
        if ((pa.get(p) ?? "(absent)") !== (pb.get(p) ?? "(absent)")) {
          diffs.push({ prop: p, a: pa.get(p) ?? "(absent)", b: pb.get(p) ?? "(absent)" });
        }
      }
      f.diff = { aName: a.name, bName: b.name, diffs };
    }
    out.families.push(f);
  }
  out.families.sort((x, y) => y.members - x.members);
  return out;
});

await browser.close();

console.log(`\nbackend WebGPU: ${report.isWebGPU}   materials on rendered meshes: ${report.totalMaterials}\n`);
for (const f of report.families) {
  console.log(`── ${f.family}  members ${f.members}  DISTINCT KEYS ${f.distinctKeys}  instancedObjs ${f.instancedObjects}`);
  console.log(`   names: ${f.names.join(", ")}`);
  if (f.geoAttrSets.length > 1) console.log(`   geometry attr sets differ: ${f.geoAttrSets.join(" / ")}`);
  if (f.diff) {
    console.log(`   key diff  ${f.diff.aName}  vs  ${f.diff.bName}:`);
    if (f.diff.diffs.length === 0) {
      console.log(`     (property walk IDENTICAL — the fork is customProgramCacheKey, geometry, or the object.uuid instancing term)`);
    }
    for (const d of f.diff.diffs) console.log(`     ${d.prop}:  ${d.a}   ≠   ${d.b}`);
  }
  console.log("");
}
console.log(`(a family with members>1 and distinctKeys=1 SHOULD share one program; distinctKeys=members means every instance compiles its own)`);
