// Script-runtime smoke test: proves what a real user script can actually
// import, by pushing script source through the real pipeline
// (transpileScript -> linkEngineImports -> blob import) in a real browser.
//
//   npx vite --port 5202
//   node scripts/run-script-runtime-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// Why a browser harness and not a unit test: the whole mechanism under test is
// module resolution. `linkEngineImports` rewrites bare specifiers to the proxy
// chunks' `import.meta.url`, and whether that URL is importable from a `blob:`
// URL is a browser behaviour — Node can't observe it, and a Vite build can't
// either (it type-checks nothing and executes nothing).
//
// The specific regression this guards: `threeRuntime.js` used to enumerate ~28
// three classes read off a global, so `import { InstancedMesh } from "three"`
// in a user script evaluated to `undefined` with no error anywhere. Any change
// that reintroduces an allowlist, or that lets the proxy get inlined into
// another chunk (breaking `import.meta.url`), fails the SURFACE checks below.
//
// START THE DEV SERVER FRESH. Vite serves files edited since startup under
// `…?t=<mtime>`, which yields a second module instance of anything the harness
// imports by path — see run-nodegraph-smoke.mjs for the full story.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5202/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

const errors = [];
page.on("console", (m) => {
  const text = m.text();
  if (m.type() === "error") errors.push(text);
  if (/SCRIPT-SMOKE/.test(text)) console.log(text);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 6000));

// ---------------------------------------------------------------------------
// The user script under test. Written the way a real gameplay script would be:
// TypeScript, decorators, all four supported specifiers. It reports back
// through a global rather than returning, because it is imported as a module.
// ---------------------------------------------------------------------------
const USER_SCRIPT = `
import { Script, attribute, Vector3, Quaternion, MathUtils, Spherical } from "engine";
import * as THREE from "three";
import { InstancedMesh, MeshStandardNodeMaterial, BoxGeometry, AnimationMixer } from "three/webgpu";
import { Fn, uniform, vec3 } from "three/tsl";

export default class Turret extends Script {
  @attribute({ type: "number", default: 7, min: 0, max: 20 })
  rpm = 7;

  @attribute({ type: "vec3", default: [0, 1, 0] })
  muzzle: [number, number, number] = [0, 1, 0];

  onStart() {
    globalThis.__SMOKE__ = {
      // "engine" surface — math must be real constructors with real methods.
      engineMath: {
        vector3: new Vector3(1, 2, 3).length(),
        quaternionInvert: typeof new Quaternion().invert === "function",
        mathUtilsLerp: MathUtils.lerp(0, 10, 0.5),
        spherical: typeof new Spherical().setFromVector3 === "function",
      },
      // The three surface a script can reach. Every one of these was
      // \`undefined\` under the old 28-symbol allowlist except Mesh/Group.
      surface: {
        instancedMesh: typeof InstancedMesh,
        nodeMaterial: typeof MeshStandardNodeMaterial,
        boxGeometry: typeof BoxGeometry,
        animationMixer: typeof AnimationMixer,
        // Namespace idiom via bare "three".
        nsInstancedMesh: typeof THREE.InstancedMesh,
        nsTextureLoader: typeof THREE.TextureLoader,
        nsExportNames: Object.keys(THREE),
      },
      // TSL — the material pipeline is TSL-native, so scripts need it.
      tsl: {
        fn: typeof Fn,
        uniform: typeof uniform,
        vec3Callable: typeof vec3(1, 2, 3) === "object",
      },
      // Instantiating something non-trivial proves the classes are wired to
      // their real dependencies, not just present as names.
      constructs: (() => {
        const m = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardNodeMaterial(), 4);
        return { isInstancedMesh: m.isInstancedMesh === true, count: m.count };
      })(),
      // Cross-boundary identity: a Vector3 built in this script must be
      // \`instanceof\` the engine's Vector3, or there are two copies of three.
      probeVector: new Vector3(4, 0, 3),
      probeCtorIsThreeNs: new Vector3() instanceof THREE.Vector3,
      attributes: Turret.attributes,
      rpm: this.rpm,
    };
  }
}
`;

const out = await page.evaluate(async (source) => {
  const { transpileScript } = await import("/src/editor/assetLoader.js");
  const { linkEngineImports, resolveRuntimeUrls } = await import("/src/engine/scriptRuntime.js");
  const { THREE } = await import("/src/engine/index.js");

  const urls = await resolveRuntimeUrls();
  const linked = await linkEngineImports(await transpileScript(source));

  // No bare specifier may survive the rewrite — a leftover one would throw at
  // import time in the browser, but we want the diagnostic before that.
  const leftovers = [...linked.matchAll(/from\s*["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((s) => !/^(https?:|blob:|data:)/.test(s));

  const blobUrl = URL.createObjectURL(new Blob([linked], { type: "text/javascript" }));
  let mod, importError = null;
  try {
    mod = await import(/* @vite-ignore */ blobUrl);
  } catch (err) {
    importError = String(err?.message ?? err);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  if (importError) return { importError, leftovers, urls };

  // Run the lifecycle hook the way ScriptComponent would.
  const instance = new mod.default();
  instance.onStart();
  const smoke = globalThis.__SMOKE__;

  return {
    leftovers,
    urls,
    ...smoke,
    // Identity has to be judged out here, against the engine's own import.
    identity: {
      vectorIsEngineVector: smoke.probeVector instanceof THREE.Vector3,
      lengthAcrossBoundary: smoke.probeVector.length(),
      probeCtorIsThreeNs: smoke.probeCtorIsThreeNs,
      engineNsExportNames: Object.keys(THREE),
    },
    proxyUrlsAbsolute: Object.values(urls).every((u) => /^https?:\/\//.test(u)),
  };
}, USER_SCRIPT);

if (out.importError) {
  console.log(` FAIL  user script failed to import — ${out.importError}`);
  console.log(`        unresolved specifiers: ${JSON.stringify(out.leftovers)}`);
  console.log(`        proxy urls: ${JSON.stringify(out.urls, null, 2)}`);
  await browser.close();
  process.exit(1);
}

// --- resolution -------------------------------------------------------------
check("every bare specifier was rewritten", out.leftovers.length === 0, JSON.stringify(out.leftovers));
check("proxy URLs are absolute http(s)", out.proxyUrlsAbsolute === true, JSON.stringify(out.urls));
check(
  'all four specifiers resolve ("engine", "three", "three/webgpu", "three/tsl")',
  ["engine", "three", "three/webgpu", "three/tsl"].every((k) => out.urls[k]),
  Object.keys(out.urls).join(", "),
);
check(
  '"three" and "three/webgpu" share one proxy',
  out.urls.three === out.urls["three/webgpu"],
  `${out.urls.three} vs ${out.urls["three/webgpu"]}`,
);

// --- "engine" math surface --------------------------------------------------
check("Vector3 is a real class with real methods", out.engineMath.vector3 === Math.sqrt(14), `length()=${out.engineMath.vector3}`);
check("Quaternion has invert() (not the phantom inverse())", out.engineMath.quaternionInvert === true);
check("MathUtils.lerp works", out.engineMath.mathUtilsLerp === 5);
check("Spherical is exported (new to the engine surface)", out.engineMath.spherical === true);

// --- the three surface ------------------------------------------------------
for (const [name, key] of [
  ["InstancedMesh", "instancedMesh"],
  ["MeshStandardNodeMaterial", "nodeMaterial"],
  ["BoxGeometry", "boxGeometry"],
  ["AnimationMixer", "animationMixer"],
  ["THREE.InstancedMesh (namespace idiom)", "nsInstancedMesh"],
  ["THREE.TextureLoader (namespace idiom)", "nsTextureLoader"],
]) {
  check(`${name} resolves from a user script`, out.surface[key] === "function", `typeof = ${out.surface[key]}`);
}
check(
  "the script sees the full three surface, not an allowlist",
  out.surface.nsExportNames.length > 400,
  `${out.surface.nsExportNames.length} exports (old allowlist was 28)`,
);

// Compare the actual name sets rather than counts. A count can pass while a
// symbol is silently missing, and it drifts every time three adds an export —
// the invariant we care about is "the script sees everything the engine sees,
// plus only the proxy's own documented internals".
{
  const scriptNames = new Set(out.surface.nsExportNames);
  const engineNames = out.identity.engineNsExportNames;
  const missing = engineNames.filter((n) => !scriptNames.has(n));
  const PROXY_INTERNALS = new Set(["default", "__SELF_URL__"]);
  const extra = out.surface.nsExportNames.filter(
    (n) => !engineNames.includes(n) && !PROXY_INTERNALS.has(n),
  );
  check(
    "the script sees every symbol the engine sees",
    missing.length === 0,
    missing.length ? `missing ${missing.length}: ${missing.slice(0, 8).join(", ")}` : `${engineNames.length} symbols`,
  );
  check(
    "the proxy adds nothing beyond its documented internals",
    extra.length === 0,
    extra.length ? `unexpected: ${extra.slice(0, 8).join(", ")}` : "default + __SELF_URL__ only",
  );
}

// --- TSL --------------------------------------------------------------------
check("Fn resolves from three/tsl", out.tsl.fn === "function", `typeof = ${out.tsl.fn}`);
check("uniform resolves from three/tsl", out.tsl.uniform === "function", `typeof = ${out.tsl.uniform}`);
check("TSL node factories are callable", out.tsl.vec3Callable === true);

// --- real construction + identity -------------------------------------------
check("InstancedMesh actually constructs", out.constructs.isInstancedMesh === true, `count=${out.constructs.count}`);
check(
  "a script's Vector3 IS the engine's Vector3 (single three instance)",
  out.identity.vectorIsEngineVector === true,
);
check('"engine" math and "three" math are the same constructor', out.identity.probeCtorIsThreeNs === true);
check("vectors cross the boundary intact", out.identity.lengthAcrossBoundary === 5, `length()=${out.identity.lengthAcrossBoundary}`);

// --- decorators / attributes -------------------------------------------------
check(
  "@attribute registered both fields",
  out.attributes?.rpm?.type === "number" && out.attributes?.muzzle?.type === "vec3",
  JSON.stringify(out.attributes),
);
check("class field default survived transpilation", out.rpm === 7, `rpm=${out.rpm}`);

// ---------------------------------------------------------------------------
const hard = errors.filter((e) => !/WebGPU|GPUAdapter|deprecat|Failed to load resource/i.test(e));
if (hard.length) {
  console.log("\nconsole errors:");
  for (const e of hard.slice(0, 10)) console.log(`  ${e}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSCRIPT-SMOKE ${failed.length === 0 && hard.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks`);
await browser.close();
process.exit(failed.length === 0 && hard.length === 0 ? 0 : 1);
