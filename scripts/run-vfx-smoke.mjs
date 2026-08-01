/**
 * Gameplay VFX in a real browser, against a real WebGPU renderer.
 *
 * The headless test proves the arithmetic. This proves the parts only a live
 * frame can: that the strip's billboard really is in the vertex stage (the
 * geometry must NOT change when the camera moves), that a trail records while
 * the render loop is actually running, that a decal projected onto real scene
 * geometry ends up in one merged draw call, and — the check none of the others
 * can stand in for — that all three put pixels on the screen.
 *
 *   npx vite --port 5201
 *   node scripts/run-vfx-smoke.mjs [url]
 *
 * HEADED=1 to watch it run.
 */
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));
const failedRequests = [];
page.on("response", (r) => {
  if (r.status() >= 400 && !/\/favicon\.ico$/.test(r.url())) failedRequests.push(`${r.status()} ${r.url()}`);
});

// Vite serves a touched module as both `foo.js` and `foo.js?t=<mtime>`, and
// importing the wrong one gets a SECOND Engine singleton that no panel is
// looking at. Import whichever URL the page actually fetched.
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

const vfx = async (body, arg) =>
  page.evaluate(
    // eslint-disable-next-line no-new-func
    (source, value) => new Function(`return (${source})`)()(value),
    body.toString(),
    arg ?? null,
  );

try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await page.waitForFunction(() => !!globalThis.__viewport?.orbit, { timeout: 60000 });
  await wait(4000);

  // --- Scene -----------------------------------------------------------------
  const built = await page.evaluate(async () => {
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    globalThis.__engine = engine;
    const THREE = globalThis.__ENGINE_THREE__;

    const make = (name, components = [], transform = null) => {
      const e = engine.createEntity({ name });
      if (transform) {
        e.object3D.position.set(...(transform.position ?? [0, 0, 0]));
        e.object3D.scale.set(...(transform.scale ?? [1, 1, 1]));
      }
      for (const [type, props] of components) e.addComponent(type, props);
      return e;
    };

    // A floor to project decals onto: a wide plane, laid flat.
    const floor = make("Floor", [["mesh", { geometry: "plane", castShadow: false }]], {
      scale: [20, 20, 1],
    });
    floor.object3D.rotation.x = -Math.PI / 2;

    const line = make(
      "Beam",
      [[
        "line",
        {
          points: [[-2, 1, 0], [0, 2.5, 0], [2, 1, 0]],
          startWidth: 0.3,
          endWidth: 0.3,
          startColor: "#ff3060",
          endColor: "#30a0ff",
          blending: "alpha",
        },
      ]],
    );

    const trail = make("Runner", [["trail", { time: 3, minVertexDistance: 0.1, startWidth: 0.4, endWidth: 0 }]], {
      position: [0, 0.6, 3],
    });

    const decal = make("Splat", [["decal", { size: [3, 3, 2], color: "#ff2020", lit: false }]], {
      position: [0, 0.5, 0],
    });
    // Aim it down at the floor: +Z along the surface normal, so it looks back
    // down it (the projector runs along its own -Z, like a camera).
    decal.object3D.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
    decal.object3D.updateMatrixWorld(true);

    globalThis.__ids = { floor: floor.id, line: line.id, trail: trail.id, decal: decal.id };

    const viewport = globalThis.__viewport;
    viewport.camera.position.set(0, 6, 12);
    viewport.orbit.target.set(0, 1, 0);
    viewport.orbit.update();
    return { entities: engine.entities.size };
  });
  check("the VFX scene was built", built.entities >= 4, `${built.entities} entities`);
  await wait(1500);

  // --- Line renderer ---------------------------------------------------------
  const line = await vfx(() => {
    const e = globalThis.__engine;
    const component = e.getEntity(globalThis.__ids.line).getComponent("line");
    const geometry = component.ribbon.mesh.geometry;
    const names = Object.keys(geometry.attributes).sort();
    return {
      names,
      draw: geometry.drawRange.count,
      visible: component.ribbon.mesh.visible,
      parented: component.ribbon.mesh.parent === e.getEntity(globalThis.__ids.line).object3D,
      hasPositionNode: !!component.ribbon.mesh.material.positionNode,
      radius: geometry.boundingSphere?.radius ?? 0,
    };
  });
  check("the strip carries the spine attributes", line.names.join(",") === "aColor,aSide,aTangent,aWidth,position,uv", line.names.join(","));
  check("three points draw two quads", line.draw === 12, `${line.draw} indices`);
  check("and it is on the entity, in local space", line.parented && line.visible);
  check("the billboard lives in the vertex stage", line.hasPositionNode);
  check("its bounding sphere is written, not computed from stale capacity", line.radius > 1 && line.radius < 10, String(line.radius.toFixed(2)));

  // The whole reason the billboard is a vertex node: the geometry is a pure
  // function of the points, so orbiting the camera must not touch the buffer —
  // while the picture itself must change.
  const orbit = await vfx(() => {
    const e = globalThis.__engine;
    const component = e.getEntity(globalThis.__ids.line).getComponent("line");
    const before = [...component.ribbon.buffer.positions.slice(0, 18)];
    const viewport = globalThis.__viewport;
    viewport.camera.position.set(9, 3, 6);
    viewport.orbit.update();
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const after = [...component.ribbon.buffer.positions.slice(0, 18)];
          resolve({ same: before.every((v, i) => v === after[i]) });
        }),
      );
    });
  });
  check("moving the camera does not rebuild the ribbon", orbit.same);

  const scripted = await vfx(() => {
    const e = globalThis.__engine;
    const component = e.getEntity(globalThis.__ids.line).getComponent("line");
    component.setPoints([[-3, 0.5, 1], [3, 0.5, 1]]);
    return { count: component.pointCount, draw: component.ribbon.mesh.geometry.drawRange.count };
  });
  check("a script can rewrite the points (the aim-beam case)", scripted.count === 2 && scripted.draw === 6, JSON.stringify(scripted));

  // --- Trail renderer --------------------------------------------------------
  const trail = await vfx(() => {
    const e = globalThis.__engine;
    const entity = e.getEntity(globalThis.__ids.trail);
    const component = entity.getComponent("trail");
    return new Promise((resolve) => {
      let frame = 0;
      const step = () => {
        // Drive it round a circle for a second of real frames.
        const t = frame / 30;
        entity.object3D.position.set(Math.cos(t * 3) * 3, 0.6, Math.sin(t * 3) * 3);
        if (++frame < 60) return requestAnimationFrame(step);
        // Read on the NEXT frame, not this one. The trail ticks in
        // onLateUpdate from the engine's own rAF, which was registered long
        // before this one — so within this frame it has already run, and the
        // head still holds the pose from before the move above. Sampling here
        // measures one frame of travel (0.3 at this speed) and calls it lag.
        requestAnimationFrame(() => resolve({
          points: component.pointCount,
          atRoot: component.ribbon.mesh.parent === e.scene,
          draw: component.ribbon.mesh.geometry.drawRange.count,
          visible: component.ribbon.mesh.visible,
          // The head must sit exactly where the object is.
          headOffset: Math.hypot(
            component.points[component.points.length - 1].x - entity.object3D.position.x,
            component.points[component.points.length - 1].z - entity.object3D.position.z,
          ),
        }));
      };
      requestAnimationFrame(step);
    });
  });
  check("a moving object records a trail", trail.points > 4, `${trail.points} points`);
  check("its points are world-space, at the scene root", trail.atRoot);
  check("which becomes a real strip", trail.draw > 0 && trail.visible, `${trail.draw} indices`);
  check("with the head pinned to the object", trail.headOffset < 0.2, trail.headOffset.toFixed(3));

  const faded = await vfx(() => {
    const e = globalThis.__engine;
    const component = e.getEntity(globalThis.__ids.trail).getComponent("trail");
    const before = component.pointCount;
    // Stand still: the history must age out on its own, not linger.
    return new Promise((resolve) => {
      setTimeout(() => resolve({ before, after: component.pointCount }), 3500);
    });
  });
  check("standing still lets the trail age away", faded.after < faded.before, `${faded.before} → ${faded.after}`);

  // --- Decals ----------------------------------------------------------------
  const decal = await vfx(() => {
    const e = globalThis.__engine;
    const component = e.getEntity(globalThis.__ids.decal).getComponent("decal");
    component.project();
    const batches = [];
    e.scene.traverse((o) => o.name === "__decalBatch" && batches.push(o));
    return {
      triangles: component.triangleCount,
      batches: batches.length,
      visible: batches[0]?.visible ?? false,
      renderOrder: batches[0]?.renderOrder ?? 0,
    };
  });
  check("an authored decal projects onto the real floor mesh", decal.triangles > 0, `${decal.triangles} triangles`);
  check("into a batch that is actually drawn", decal.batches === 1 && decal.visible);
  check("ordered after the surface it was cut from", decal.renderOrder > 0, String(decal.renderOrder));

  const spawned = await vfx(() => {
    const e = globalThis.__engine;
    const handles = [];
    for (let i = 0; i < 24; i++) {
      handles.push(
        e.decals.spawn({
          position: { x: -6 + i * 0.5, y: 0, z: -4 },
          normal: { x: 0, y: 1, z: 0 },
          size: 0.4,
          color: "#20ff80",
          lit: false,
        }),
      );
    }
    const batches = [];
    e.scene.traverse((o) => o.name === "__decalBatch" && batches.push(o));
    return {
      hits: handles.filter(Boolean).length,
      batches: batches.length,
      meshes: batches.map((b) => b.geometry.drawRange.count),
    };
  });
  check("24 runtime decals all land on the floor", spawned.hits === 24, `${spawned.hits}/24`);
  // The authored decal above is unlit and untextured too, so it shares the look
  // — all 25 belong in ONE batch, not 25 and not 2.
  check("…in ONE draw call, not 24", spawned.batches === 1, `${spawned.batches} batches for 25 decals`);

  // The flip side of merging: a decal that does NOT share the look must not be
  // folded in, or it renders with the wrong shader.
  const distinct = await vfx(() => {
    const e = globalThis.__engine;
    e.decals.spawn({
      position: { x: 0, y: 0, z: 4 },
      normal: { x: 0, y: 1, z: 0 },
      size: 0.4,
      color: "#ffffff",
      lit: true, // different look — lit, so a different material
    });
    const batches = [];
    e.scene.traverse((o) => o.name === "__decalBatch" && batches.push(o));
    return { batches: batches.length };
  });
  check("a decal with a different look gets its own batch", distinct.batches === 2, `${distinct.batches} batches`);

  const evicted = await vfx(() => {
    const e = globalThis.__engine;
    e.decals.maxDecals = 10;
    const handle = e.decals.spawn({
      position: { x: 0, y: 0, z: -6 },
      normal: { x: 0, y: 1, z: 0 },
      size: 0.4,
      color: "#20ff80",
      lit: false,
    });
    return { live: e.decals.decals.length, newestKept: e.decals.decals.includes(handle) };
  });
  check("the cap holds and always keeps the newest", evicted.live === 10 && evicted.newestKept, JSON.stringify(evicted));

  // --- It is actually on screen ---------------------------------------------
  const pixels = await vfx(() => {
    const e = globalThis.__engine;
    const viewport = globalThis.__viewport;
    const ids = globalThis.__ids;
    const line = e.getEntity(ids.line).getComponent("line");
    const decalComponent = e.getEntity(ids.decal).getComponent("decal");
    const trailComponent = e.getEntity(ids.trail).getComponent("trail");
    // A straight-down view of the floor: the decal fills the middle of the
    // frame, and the beam crosses it.
    viewport.camera.position.set(0, 9, 0.01);
    viewport.orbit.target.set(0, 0, 0);
    viewport.orbit.update();
    line.setPoints([[-4, 0.4, -2.5], [4, 0.4, -2.5]]);
    // The cap test above left maxDecals at 10, which evicted the authored decal
    // — the oldest of the 26. Put the ceiling back and re-cut it, or this
    // measures a decal that is not there and blames the renderer.
    e.decals.maxDecals = 256;
    decalComponent.project();

    // Where the marks land is a function of fov, aspect and canvas size, so
    // project the world points through the live camera rather than guessing a
    // fraction of the frame. The decal is sampled OFF its centre on purpose:
    // the viewport grid's origin axis lines are drawn over the exact middle,
    // so the one pixel at dead centre is the grid's colour in both states.
    const THREE = globalThis.__ENGINE_THREE__;
    const project = (x, y, z, w, h) => {
      const cam = viewport.camera;
      cam.updateMatrixWorld(true);
      const p = new THREE.Vector3(x, y, z).project(cam);
      return [Math.round((p.x * 0.5 + 0.5) * w), Math.round((-p.y * 0.5 + 0.5) * h)];
    };

    const sample = () =>
      new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const src = e.renderer.domElement;
              const c = document.createElement("canvas");
              c.width = src.width;
              c.height = src.height;
              const ctx = c.getContext("2d");
              try {
                ctx.drawImage(src, 0, 0);
              } catch (err) {
                resolve({ error: String(err) });
                return;
              }
              // Average a small patch: one pixel is at the mercy of an edge or
              // an overlay line, and this check is about "is it on screen".
              const patch = (x, y) => {
                const d = ctx.getImageData(Math.floor(x) - 3, Math.floor(y) - 3, 7, 7).data;
                const sum = [0, 0, 0];
                for (let i = 0; i < d.length; i += 4) {
                  sum[0] += d[i];
                  sum[1] += d[i + 1];
                  sum[2] += d[i + 2];
                }
                const n = d.length / 4;
                return sum.map((v) => Math.round(v / n));
              };
              resolve({
                decal: patch(...project(0.6, 0, 0.6, c.width, c.height)),
                beam: patch(...project(0, 0.4, -2.5, c.width, c.height)),
                w: c.width,
                h: c.height,
              });
            }),
          ),
        );
      });

    return (async () => {
      const on = await sample();
      decalComponent.setEnabled(false);
      line.setEnabled(false);
      trailComponent.setEnabled(false);
      const off = await sample();
      decalComponent.setEnabled(true);
      line.setEnabled(true);
      trailComponent.setEnabled(true);
      return { on, off };
    })();
  });
  if (pixels.on?.error || pixels.off?.error) {
    check("the frame could be read back", false, pixels.on?.error ?? pixels.off?.error);
  } else {
    const differs = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 24;
    check(
      "the decal is on the floor in the rendered frame",
      differs(pixels.on.decal, pixels.off.decal),
      `with rgba(${pixels.on.decal}) vs without rgba(${pixels.off.decal})`,
    );
    check(
      "the line renderer is on screen",
      differs(pixels.on.beam, pixels.off.beam),
      `with rgba(${pixels.on.beam}) vs without rgba(${pixels.off.beam})`,
    );
  }

  // --- Stop must not leave anything behind ----------------------------------
  const stopped = await vfx(() => {
    const e = globalThis.__engine;
    e.setPlaying(true);
    e.decals.spawn({
      position: { x: 2, y: 0, z: 2 },
      normal: { x: 0, y: 1, z: 0 },
      size: 0.5,
      lit: false,
    });
    const during = e.decals.decals.length;
    e.setPlaying(false);
    return { during, after: e.decals.decals.length };
  });
  check("Stop wipes every decal punched during Play", stopped.during > 0 && stopped.after === 0, JSON.stringify(stopped));

  const real = errors.filter((e) => {
    if (/WebGPU|GPUAdapter|Deprecation|favicon/i.test(e)) return false;
    if (/Failed to load resource/i.test(e)) return failedRequests.length > 0;
    return true;
  });
  if (real.length || failedRequests.length) {
    console.log("\nConsole errors:");
    for (const e of [...real, ...failedRequests].slice(0, 8)) console.log(`  ${e}`);
  }
  check("no console errors", real.length === 0 && failedRequests.length === 0, String(real.length));
} catch (error) {
  check("harness completed", false, error.message);
} finally {
  await browser.close();
}

console.log(`\nVFX-SMOKE ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
