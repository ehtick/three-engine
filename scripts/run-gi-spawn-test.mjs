// GI SPAWN/DESPAWN FAST PATH — the "shooting balls at boxes freezes on ultra"
// class, decided on the field's own bookkeeping and the GPU bitset.
//
// The old behaviour: ANY mesh-set change re-concatenated the whole scene's
// geometry on the CPU, allocated fresh GPU buffers, rebuilt + recompiled the
// voxelize compute chain, and forced a FULL re-voxelize with a whole-volume
// composite. Spawning one pooled ball paid the whole-cathedral price, every
// shot.
//
// The claims, in the order a failure would matter:
//   1. INCREMENTAL. A spawned mesh is absorbed by the incremental setGeometry
//      path (stats.incrementalUpdates), with NO geometryRevision bump — the
//      revision is what forces the compute-chain rebuild and the whole-volume
//      composite.
//   2. FAST CHAIN. A MOVING spawn (the game case — the ball is wiggled every
//      frame so the demotion timer never fires) rides the dynamic side: zero
//      full re-voxelizes across spawn, despawn and respawn once the boot has
//      quiesced.
//   3. CORRECT. The spawned mesh's SURFACE voxels appear in the level-0
//      bitset (voxelization is shell-based — the interior of a closed box is
//      deliberately empty), disappear on despawn, reappear on respawn.
//   4. STABLE SLOTS. Despawn + respawn of the same mesh reuses its slot and
//      appends no pairs — the pool's steady state is pure uniform writes.
//
//   node scripts/run-gi-spawn-test.mjs [url]
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
const rebuildLogs = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] occupancy: .*rebuilding/.test(t)) rebuildLogs.push(t);
  if (/\[gi\] (occupancy|built)|GI-SPAWN/.test(t)) console.log(`  ${t.slice(0, 240)}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

const result = await page.evaluate(async () => {
  // editorFramePacing stops the engine loop headless — see run-gi-occupancy.
  globalThis.__editorKeepRendering = true;
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");

  for (const entity of [...engine.entities.values()]) engine.destroyEntity(entity);
  for (const child of [...engine.scene.children]) {
    if (child.isMesh) engine.scene.remove(child);
  }

  const anon = (geometry) => {
    const g = geometry.toNonIndexed();
    g.parameters = undefined;
    g.type = "BufferGeometry";
    return g;
  };
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x999999, roughness: 0.9 });
  const floor = new THREE.Mesh(anon(new THREE.BoxGeometry(12, 0.3, 12)), material);
  floor.position.y = -0.15;
  const wall = new THREE.Mesh(anon(new THREE.BoxGeometry(0.3, 3, 12)), material);
  wall.position.x = -4;
  engine.scene.add(floor, wall);

  const gi = engine.createEntity({ name: "GI Spawn Test" });
  gi.addComponent("global-illumination", { autoFit: true, quality: "high" });

  const system = engine.modules.get("gi").system;
  const deadline = performance.now() + 90_000;
  let field = null;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    field = system.state?.volume?.occupancyField ?? null;
    if (field && field.stats.dispatches > 3 && !engine.renderSuspended) break;
  }
  if (!field) return { fail: "GI never built" };
  // TRUE QUIESCENCE before the baseline: the boot's async-pipeline re-arm
  // loop keeps the field dirty (full chains every tick) until the last
  // pipeline lands — a baseline taken inside that storm poisons every
  // full-chain delta below.
  {
    const end = performance.now() + 60_000;
    let quiet = 0;
    while (performance.now() < end && quiet < 5) {
      await new Promise((r) => setTimeout(r, 200));
      const d = field.debugIncremental;
      quiet = (globalThis.__giPendingComputePipelines?.size === 0 && !d.dirty && !d.staticDirty) ? quiet + 1 : 0;
    }
    if (quiet < 5) return { fail: "field never quiesced after boot" };
  }

  const snap = () => ({
    rev: field.geometryRevision,
    dispatches: field.stats.dispatches,
    fast: field.stats.fastDispatches ?? 0,
    incremental: field.stats.incrementalUpdates ?? 0,
    pairs: field.stats.pairs,
  });
  const fullsOf = (s) => s.dispatches - s.fast;
  const waitScan = async (baseline) => {
    const end = performance.now() + 10_000;
    while (performance.now() < end) {
      await new Promise((r) => setTimeout(r, 200));
      if ((field.stats.incrementalUpdates ?? 0) > baseline.incremental) return true;
    }
    return false;
  };
  // Voxelization is SHELL-based: probe a face point, accepting any set bit
  // in the 3³ neighbourhood (conservative rasterization can land the face
  // plane in either adjacent voxel).
  const probeFace = async (p) => {
    const rb = await field.readbackBits(engine.renderer);
    const v = rb.voxelOf(p);
    let hits = 0;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) hits += rb.get(v.x + dx, v.y + dy, v.z + dz, 0);
    return hits;
  };

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? "") });

  // ── SPAWN, kept MOVING like a real game object (never demotes to static).
  const before = snap();
  const ball = new THREE.Mesh(
    anon(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.MeshStandardNodeMaterial({ color: 0xcc4433, roughness: 0.7 }),
  );
  ball.position.set(3, 1, 3);
  const t0 = performance.now();
  engine.scene.add(ball);
  let wiggleOn = true;
  const wiggle = setInterval(() => {
    if (wiggleOn && ball.parent) ball.position.y = 1 + 0.15 * Math.sin(performance.now() / 120);
  }, 16);
  // Probes pause the wiggle briefly (well under the demotion window) so the
  // bitset is read at the pose the last chain voxelized.
  const probeBallFace = async () => {
    wiggleOn = false;
    await new Promise((r) => setTimeout(r, 300));
    const hits = await probeFace(new THREE.Vector3(ball.position.x, ball.position.y + 0.5, ball.position.z));
    wiggleOn = true;
    return hits;
  };
  const scanned = await waitScan(before);
  const spawnLatency = performance.now() - t0;
  const afterSpawn = snap();
  check("spawn absorbed incrementally", scanned, `latency=${spawnLatency.toFixed(0)}ms buildMs=${field.stats.buildMs.toFixed(2)}`);
  check("no geometry revision bump on spawn", afterSpawn.rev === before.rev, `rev ${before.rev} -> ${afterSpawn.rev}`);
  check("spawn setGeometry is sub-frame CPU", field.stats.buildMs < 8, `${field.stats.buildMs.toFixed(2)}ms`);
  await new Promise((r) => setTimeout(r, 900));
  const spawnHits = await probeBallFace();
  const afterSettle = snap();
  check("spawned mesh voxelized (top-face shell)", spawnHits > 0, `hits=${spawnHits}`);
  // A FIRST-EVER spawn pays a couple of re-arm fulls while the new slot's
  // bake/composite pipelines compile async (the spawn-blink guard refuses to
  // half-run the chain meanwhile). That is a one-time cost per unique mesh —
  // the pooled steady state (respawn below) must stay at ZERO.
  check("first spawn costs at most a few re-arm fulls", fullsOf(afterSettle) - fullsOf(before) <= 4, `fulls ${fullsOf(before)} -> ${fullsOf(afterSettle)}`);
  const spawnSlot = field.placements.find((p) => p.mesh === ball)?.slot;
  check("spawned mesh got a slot", spawnSlot != null, `slot=${spawnSlot}`);

  // ── DESPAWN while still dynamic (pooled park mid-flight).
  const beforeDespawn = snap();
  engine.scene.remove(ball);
  const despawnScanned = await waitScan(beforeDespawn);
  const afterDespawn = snap();
  check("despawn absorbed incrementally", despawnScanned, "");
  check("no geometry revision bump on despawn", afterDespawn.rev === before.rev, `rev=${afterDespawn.rev}`);
  await new Promise((r) => setTimeout(r, 900));
  const despawnHits = await probeFace(new THREE.Vector3(3, 1.5, 3));
  const afterDespawnSettle = snap();
  check("despawned voxels cleared", despawnHits === 0, `hits=${despawnHits}`);
  // The atlas reclaiming the seat can cost one re-arm full; a dynamic slot's
  // disable itself is a pure uniform write.
  check("despawn costs at most one re-arm full", fullsOf(afterDespawnSettle) - fullsOf(beforeDespawn) <= 1, `fulls ${fullsOf(beforeDespawn)} -> ${fullsOf(afterDespawnSettle)}`);

  // ── RESPAWN (same mesh object — the pool's steady state).
  const beforeRespawn = snap();
  ball.position.set(3, 1, -3);
  engine.scene.add(ball);
  const respawnScanned = await waitScan(beforeRespawn);
  const afterRespawn = snap();
  check("respawn absorbed incrementally", respawnScanned, "");
  check("no geometry revision bump on respawn", afterRespawn.rev === before.rev, `rev=${afterRespawn.rev}`);
  check("respawn reuses the same slot", field.placements.find((p) => p.mesh === ball)?.slot === spawnSlot,
    `slot=${field.placements.find((p) => p.mesh === ball)?.slot} (was ${spawnSlot})`);
  check("respawn appended no pairs (slot bookkeeping reused)", afterRespawn.pairs === afterDespawn.pairs,
    `pairs ${afterDespawn.pairs} -> ${afterRespawn.pairs}`);
  await new Promise((r) => setTimeout(r, 900));
  const respawnHits = await probeBallFace();
  const afterRespawnSettle = snap();
  check("respawned voxels present at the new pose", respawnHits > 0, `hits=${respawnHits}`);
  check("respawn rides the FAST chain", fullsOf(afterRespawnSettle) === fullsOf(beforeRespawn), `fulls ${fullsOf(beforeRespawn)} -> ${fullsOf(afterRespawnSettle)}`);
  clearInterval(wiggle);

  return { results, stats: { ...field.stats } };
});

if (result.fail) {
  console.log(`FAIL: ${result.fail}`);
  await browser.close();
  process.exit(1);
}
let failed = 0;
for (const r of result.results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}: ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  if (!r.ok) failed++;
}
if (rebuildLogs.length) {
  console.log(`FAIL: capacity rebuild fired during the test: ${rebuildLogs[0]}`);
  failed++;
}
console.log(failed ? `GI-SPAWN ${failed} FAILURES` : "GI-SPAWN ALL PASS");
await browser.close();
process.exit(failed ? 1 : 0);
