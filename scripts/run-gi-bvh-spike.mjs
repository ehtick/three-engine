// SPIKE: can three-mesh-bvh's packed BVH be traversed in WGSL on this
// r185 WebGPU/TSL stack, correctly and fast? See src/modules/gi/bvh/bvhGpu.js
// for the traversal + packing. This harness builds a ~16k-tri TorusKnot BVH,
// fires 512 deterministic rays through both `bvh.raycastFirst` (CPU) and a
// WGSL compute pass calling `bvhIntersectFirstHitFn` (GPU), and compares
// hit distances. A second pass times 200,000 rays x5 dispatches.
//
// Boilerplate (chrome path / WebGPU flags / "Skip the project" loop / settle
// waits) copied from scripts/run-gi-sdf-hires.mjs. Run against a SCOPED vite
// on port 5234 — never 5201/5233 (other harnesses own those).
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5234/";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840, deviceScaleFactor: 1 });
page.on("console", (message) => {
  const text = message.text();
  if (/BVH-SPIKE/.test(text) || message.type() === "error") console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
for (let i = 0; i < 40; i++) {
  const ready = await page.evaluate(() => {
    if (globalThis.__viewport?.orbit) return true;
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
    return !!globalThis.__viewport?.orbit;
  });
  if (ready) break;
  await new Promise((r) => setTimeout(r, 500));
}
await new Promise((r) => setTimeout(r, 3000));

const summary = await page.evaluate(async () => {
  const log = (...args) => console.log("BVH-SPIKE", ...args);

  try {
    const { THREE } = await import("/src/engine/index.js");
    const TSL = await import("/node_modules/three/build/three.tsl.js");
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const { buildBvhTextures, bvhIntersectFirstHitFn } = await import("/src/modules/gi/bvh/bvhGpu.js");

    const engine = await ensureEngine();
    globalThis.__engine = engine;
    const renderer = engine.renderer;
    if (!renderer) throw new Error("no engine.renderer");

    // ---------------------------------------------------------- BVH build
    const geometry = new THREE.TorusKnotGeometry(1, 0.28, 200, 40);
    const triCountRaw = geometry.index.count / 3;
    log(`geometry tris=${triCountRaw}`);

    const t0Build = performance.now();
    const packed = buildBvhTextures(geometry);
    const buildMs = performance.now() - t0Build;
    log(
      `bvh built in ${buildMs.toFixed(1)}ms nodeCount=${packed.nodeCount} triCount=${packed.triCount} vertexCount=${packed.vertexCount}`,
    );

    // ---------------------------------------------------------- ray gen
    // Deterministic LCG (Numerical Recipes constants).
    function makeLcg(seed) {
      let state = seed >>> 0;
      return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
    }

    // Origins on a radius-4 sphere; directions aimed at the world origin
    // (where the knot is centered) plus jitter, so a meaningful fraction of
    // rays miss the geometry entirely.
    function genRays(count, seed, jitterAmount) {
      const rng = makeLcg(seed);
      const origins = new Float32Array(count * 3);
      const dirs = new Float32Array(count * 3);
      const R = 4;
      for (let i = 0; i < count; i++) {
        const theta = rng() * Math.PI * 2;
        const phi = Math.acos(2 * rng() - 1);
        const ox = R * Math.sin(phi) * Math.cos(theta);
        const oy = R * Math.sin(phi) * Math.sin(theta);
        const oz = R * Math.cos(phi);
        origins[i * 3 + 0] = ox;
        origins[i * 3 + 1] = oy;
        origins[i * 3 + 2] = oz;

        let dx = -ox;
        let dy = -oy;
        let dz = -oz;
        const dlen = Math.hypot(dx, dy, dz) || 1;
        dx /= dlen;
        dy /= dlen;
        dz /= dlen;

        dx += (rng() * 2 - 1) * jitterAmount;
        dy += (rng() * 2 - 1) * jitterAmount;
        dz += (rng() * 2 - 1) * jitterAmount;
        const dlen2 = Math.hypot(dx, dy, dz) || 1;
        dirs[i * 3 + 0] = dx / dlen2;
        dirs[i * 3 + 1] = dy / dlen2;
        dirs[i * 3 + 2] = dz / dlen2;
      }
      return { origins, dirs };
    }

    // ---------------------------------------------------------- GPU dispatch helper
    const { Fn, instanceIndex, instancedArray } = TSL;

    function buildComputeNode(originsArr, dirsArr, count) {
      const originBuf = instancedArray(originsArr, "vec3");
      const dirBuf = instancedArray(dirsArr, "vec3");
      const outBuf = instancedArray(count, "vec4");
      const computeNode = Fn(() => {
        const ro = originBuf.element(instanceIndex).toVar();
        const rd = dirBuf.element(instanceIndex).toVar();
        const hit = bvhIntersectFirstHitFn(
          ro,
          rd,
          packed.boundsBuffer,
          packed.contentsBuffer,
          packed.indexBuffer,
          packed.positionBuffer,
        );
        outBuf.element(instanceIndex).assign(hit);
      })().compute(count);
      return { computeNode, outBuf };
    }

    async function dispatch(originsArr, dirsArr, count) {
      const { computeNode, outBuf } = buildComputeNode(originsArr, dirsArr, count);
      renderer.compute(computeNode);
      const buf = await renderer.getArrayBufferAsync(outBuf.value);
      return new Float32Array(buf);
    }

    // ---------------------------------------------------------- correctness pass (512 rays)
    const CORRECT_N = 512;
    let jitter = 0.85;
    let origins;
    let dirs;
    let cpuMisses = 0;
    // Tune jitter once so the mix is meaningfully mixed (not all-hit or
    // all-miss) — a torus knot's central hole already makes plain
    // origin-aimed rays miss often, so this usually needs at most one pass.
    for (let attempt = 0; attempt < 4; attempt++) {
      ({ origins, dirs } = genRays(CORRECT_N, 0xc0ffee, jitter));
      const ray = new THREE.Ray();
      cpuMisses = 0;
      for (let i = 0; i < CORRECT_N; i++) {
        ray.origin.set(origins[i * 3], origins[i * 3 + 1], origins[i * 3 + 2]);
        ray.direction.set(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]);
        const hit = packed.bvh.raycastFirst(ray, THREE.DoubleSide);
        if (!hit) cpuMisses++;
      }
      const missFrac = cpuMisses / CORRECT_N;
      log(`jitter=${jitter.toFixed(3)} cpuMisses=${cpuMisses}/${CORRECT_N} (${(missFrac * 100).toFixed(1)}%)`);
      if (missFrac > 0.05 && missFrac < 0.6) break;
      jitter = missFrac <= 0.05 ? jitter * 1.6 : jitter * 0.6;
    }

    // Recompute the authoritative CPU distances (or -1) for the final ray set.
    const cpuT = new Float32Array(CORRECT_N);
    {
      const ray = new THREE.Ray();
      for (let i = 0; i < CORRECT_N; i++) {
        ray.origin.set(origins[i * 3], origins[i * 3 + 1], origins[i * 3 + 2]);
        ray.direction.set(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]);
        const hit = packed.bvh.raycastFirst(ray, THREE.DoubleSide);
        cpuT[i] = hit ? hit.distance : -1;
      }
    }

    const gpuOut = await dispatch(origins, dirs, CORRECT_N);

    let agree = 0;
    let hits = 0;
    let misses = 0;
    const disagreements = [];
    for (let i = 0; i < CORRECT_N; i++) {
      const tCpu = cpuT[i];
      const tGpu = gpuOut[i * 4 + 0];
      const cpuMiss = tCpu < 0;
      const gpuMiss = tGpu < 0;
      if (cpuMiss) misses++;
      else hits++;

      let ok;
      if (cpuMiss && gpuMiss) ok = true;
      else if (cpuMiss !== gpuMiss) ok = false;
      else ok = Math.abs(tGpu - tCpu) < Math.max(1e-3, 1e-3 * Math.abs(tCpu));

      if (ok) agree++;
      else if (disagreements.length < 8) disagreements.push({ i, tCpu, tGpu });
    }
    log(`agreement: ${agree}/${CORRECT_N} (hits ${hits}, misses ${misses})`);
    if (disagreements.length) log(`sample disagreements: ${JSON.stringify(disagreements)}`);

    // ---------------------------------------------------------- timing pass (200k rays x5)
    const TIMING_N = 200000;
    const { origins: to, dirs: td } = genRays(TIMING_N, 0x5eed5eed, jitter);
    const { computeNode: timingNode, outBuf: timingOut } = buildComputeNode(to, td, TIMING_N);

    const runsMs = [];
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      renderer.compute(timingNode);
      await renderer.getArrayBufferAsync(timingOut.value);
      const ms = performance.now() - t0;
      runsMs.push(ms);
      log(`timing run ${run}: ${ms.toFixed(2)}ms`);
    }
    const bestMs = Math.min(...runsMs);
    const raysPerSec = TIMING_N / (bestMs / 1000);
    log(`best ${TIMING_N} rays: ${bestMs.toFixed(2)}ms (${Math.round(raysPerSec)} rays/s)`);

    return {
      ok: true,
      nodeCount: packed.nodeCount,
      triCount: packed.triCount,
      vertexCount: packed.vertexCount,
      buildMs,
      agree,
      total: CORRECT_N,
      hits,
      misses,
      runsMs,
      bestMs,
      raysPerSec,
    };
  } catch (error) {
    log(`ERROR: ${error?.stack ?? error?.message ?? error}`);
    return { ok: false, error: String(error?.stack ?? error?.message ?? error) };
  }
});

console.log("\n=== BVH WGSL traversal spike ===");
if (!summary.ok) {
  console.log(`SPIKE FAIL (harness error: ${summary.error})`);
  await browser.close();
  process.exit(1);
}

console.log(`geometry: nodeCount=${summary.nodeCount} triCount=${summary.triCount} vertexCount=${summary.vertexCount} (build ${summary.buildMs.toFixed(1)}ms)`);
console.log(`agreement: ${summary.agree}/${summary.total} (hits ${summary.hits}, misses ${summary.misses})`);
console.log(`timing: runs=[${summary.runsMs.map((m) => m.toFixed(1)).join(", ")}]ms best=${summary.bestMs.toFixed(2)}ms rays/s=${Math.round(summary.raysPerSec)}`);

const pass = summary.agree >= 507;
console.log(pass ? "SPIKE PASS" : "SPIKE FAIL");
console.log(`  agreement ${summary.agree}/${summary.total} (${((summary.agree / summary.total) * 100).toFixed(1)}%)`);
console.log(`  200000 rays: ${summary.bestMs.toFixed(2)}ms best, ${Math.round(summary.raysPerSec).toLocaleString()} rays/s`);

await browser.close();
process.exit(pass ? 0 : 1);
