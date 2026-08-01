/**
 * Impostors in a real browser, against a real WebGPU frame (roadmap item 14).
 *
 * The headless test proves the addressing maths. Only a live frame can prove
 * the two halves actually agree:
 *
 *   - that the BAKE captured the object — the atlas has coverage where the
 *     object is and the colour the object is, which is also the only check that
 *     the neutral-ambient capture really approximates albedo,
 *   - that the SHADER samples the frame the camera is looking from, in the
 *     orientation it was baked in. That one is worth the whole file: a v-flip
 *     or a swapped basis vector produces an impostor that is perfectly plausible
 *     and mirrored, and no amount of "is something on screen" catches it.
 *
 * The source is deliberately asymmetric in all three axes — a red box on +X, a
 * blue one on -X, a green one on +Y — so a pixel read can say *which way round*
 * the billboard is, and orbiting to the far side must swap red and blue.
 *
 *   npx vite --port 5201
 *   node scripts/run-impostor-smoke.mjs [url]
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

const run = async (body, arg) =>
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

    // An LOD group with two levels: the real thing, and its impostor. Forcing
    // the impostor level is what puts the billboard on screen in the same place
    // the mesh would be, which is the comparison that matters.
    const group = engine.createEntity({ name: "Prop" });
    group.object3D.position.set(0, 2, 0);

    const source = engine.createEntity({ name: "Prop_LOD0" });
    source.setParent(group);
    for (const [name, position] of [
      ["Right", [1, 0, 0]],
      ["Left", [-1, 0, 0]],
      ["Top", [0, 1, 0]],
    ]) {
      const part = engine.createEntity({ name });
      part.setParent(source);
      part.object3D.position.set(...position);
      part.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
    }

    const level = engine.createEntity({ name: "Prop_Impostor" });
    level.setParent(group);
    const impostor = level.addComponent("impostor", { frames: 8, tile: 64, lit: false });
    const lod = group.addComponent("lod", { levels: [0.6, 0], forcedLevel: -1 });

    globalThis.__ids = {
      group: group.id,
      source: source.id,
      level: level.id,
      parts: source.children.map((c) => c.id),
    };
    globalThis.__COLORS = { Right: "#ff2020", Left: "#2060ff", Top: "#20ff20" };

    const viewport = globalThis.__viewport;
    viewport.orbit.target.set(0, 2, 0);
    viewport.camera.position.set(0, 2, 12);
    viewport.orbit.update();
    engine.scene.updateMatrixWorld(true);
    return { levels: lod.levelCount, ready: impostor.ready };
  });
  check("the impostor scene was built", built.levels === 2 && built.ready === false, JSON.stringify(built));

  // Colour the parts only NOW: a mesh component resolves its material
  // asynchronously even when the `material` prop is empty, so an override
  // applied in the same tick as `addComponent` is quietly replaced by the
  // default white — and every colour assertion below would then read the same
  // grey and blame the impostor. (The LOD smoke was bitten by exactly this.)
  await wait(1500);
  const materials = await run(() => {
    const e = globalThis.__engine;
    const THREE = globalThis.__ENGINE_THREE__;
    return globalThis.__ids.parts.map((id) => {
      const entity = e.getEntity(id);
      const component = entity.getComponent("mesh");
      component.mesh.material = new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color(globalThis.__COLORS[entity.name]),
      });
      return { name: entity.name, color: component.mesh.material.color.getHexString() };
    });
  });
  check(
    "the source's three parts kept their distinct colours",
    materials.map((m) => m.color).join(",") === "ff2020,2060ff,20ff20",
    JSON.stringify(materials),
  );

  // --- The bake --------------------------------------------------------------
  // Re-bake now that the colours have landed; the first attempt captured white.
  await run(() => {
    const e = globalThis.__engine;
    e.impostors.rebake(e.getEntity(globalThis.__ids.level).getComponent("impostor"));
  });
  await wait(3000);

  const baked = await run(() => {
    const e = globalThis.__engine;
    const component = e.getEntity(globalThis.__ids.level).getComponent("impostor");
    const atlas = component.atlas;
    if (!atlas) return { ready: false, error: component.bakeError };

    // Read the middle frame's tile straight out of the baked bytes. The atlas
    // is a DataTexture precisely so this is possible — a render-target texture
    // could only be inspected by drawing it, which is the thing under test.
    const { frames, tile, size, albedoData, normalData } = atlas;
    const col = Math.floor(frames / 2);
    const row = Math.floor(frames / 2);
    const sample = (data, u, v) => {
      const x = Math.floor((col + u) * tile);
      const y = Math.floor((row + v) * tile);
      const at = (y * size + x) * 4;
      return [data[at], data[at + 1], data[at + 2], data[at + 3]];
    };
    let covered = 0;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        if (albedoData[((row * tile + y) * size + col * tile + x) * 4 + 3] > 128) covered++;
      }
    }
    return {
      ready: true,
      size,
      frames,
      radius: atlas.radius,
      covered: covered / (tile * tile),
      centre: sample(albedoData, 0.5, 0.5),
      normalCentre: sample(normalData, 0.5, 0.5),
      corner: sample(albedoData, 0.02, 0.02),
    };
  });
  check("an atlas was baked", baked.ready === true, baked.ready ? `${baked.size}px` : `error: ${baked.error}`);
  check(
    "…with the object's silhouette in it, not an empty frame",
    baked.covered > 0.05 && baked.covered < 0.95,
    `${(baked.covered * 100).toFixed(1)}% coverage`,
  );
  check(
    "…and empty space outside it stayed transparent",
    baked.corner?.[3] === 0,
    `corner alpha ${baked.corner?.[3]}`,
  );
  check(
    "the neutral ambient really captured ALBEDO, not a lighting solution",
    // The centre of the top-down frame is the green box on +Y. If the bake had
    // kept the scene's lighting the channel would be anything but this.
    baked.centre && baked.centre[1] > 140 && baked.centre[0] < 110 && baked.centre[3] > 200,
    `rgba(${baked.centre})`,
  );
  check(
    "the normal atlas holds a real normal where the albedo has coverage",
    baked.normalCentre &&
      Math.abs(baked.normalCentre[0] - 128) + Math.abs(baked.normalCentre[1] - 128) + Math.abs(baked.normalCentre[2] - 128) > 40,
    `rgb(${baked.normalCentre})`,
  );

  // --- Sharing ---------------------------------------------------------------
  const shared = await run(() => {
    const e = globalThis.__engine;
    const THREE = globalThis.__ENGINE_THREE__;
    const template = e.getEntity(globalThis.__ids.source);
    const geometries = template.children.map((c) => c.getComponent("mesh").mesh.geometry);
    const materials = template.children.map((c) => c.getComponent("mesh").mesh.material);
    // Nine more copies of the same prop, sharing geometry and materials — what a
    // prop dropped across a hillside really looks like.
    for (let i = 0; i < 9; i++) {
      const group = e.createEntity({ name: `Copy${i}` });
      group.object3D.position.set(-20 + i * 4, 2, -30);
      const source = e.createEntity({ name: `Copy${i}_LOD0` });
      source.setParent(group);
      template.children.forEach((child, index) => {
        const part = e.createEntity({ name: `Part${index}` });
        part.setParent(source);
        part.object3D.position.copy(child.object3D.position);
        const mesh = part.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
        mesh.mesh.geometry = geometries[index];
        mesh.mesh.material = materials[index];
      });
      const level = e.createEntity({ name: `Copy${i}_Impostor` });
      level.setParent(group);
      level.addComponent("impostor", { frames: 8, tile: 64, lit: false });
      group.addComponent("lod", { levels: [0.6, 0], forcedLevel: 1 });
    }
    e.scene.updateMatrixWorld(true);
    return new Promise((resolve) => {
      let n = 0;
      const step = () => {
        if (++n < 30) return requestAnimationFrame(step);
        resolve({
          atlases: e.impostors.cache.size,
          batches: e.impostors.batches.size,
          instances: [...e.impostors.batches.values()].reduce((sum, b) => sum + b.members.length, 0),
          baked: e.impostors.bakedCount,
          failures: e.impostors.failures,
        });
      };
      requestAnimationFrame(step);
    });
  });
  check(
    "ten props built from one mesh bake ONE atlas",
    shared.atlases === 1,
    `${shared.atlases} atlases, ${shared.baked} bakes, ${shared.failures} failures`,
  );
  check(
    "…and draw in ONE call — the whole reason this is not a mesh per prop",
    shared.batches === 1 && shared.instances === 10,
    `${shared.instances} instances in ${shared.batches} batch(es)`,
  );

  /**
   * Puts the camera at `angle` around the prop and reports the pixels either
   * side of it, plus above and below.
   */
  const look = async (angle) =>
    run((degrees) => {
      const e = globalThis.__engine;
      const viewport = globalThis.__viewport;
      const radians = (degrees * Math.PI) / 180;
      const distance = 9;
      viewport.camera.position.set(Math.sin(radians) * distance, 2, Math.cos(radians) * distance);
      viewport.orbit.target.set(0, 2, 0);
      viewport.orbit.update();
      return new Promise((resolve) => {
        let n = 0;
        const step = () => {
          if (++n < 6) return requestAnimationFrame(step);
          const src = e.renderer.domElement;
          const c = document.createElement("canvas");
          c.width = src.width;
          c.height = src.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(src, 0, 0);
          const cx = Math.floor(c.width / 2);
          const cy = Math.floor(c.height / 2);
          const patch = (dx, dy) => {
            const d = ctx.getImageData(cx + dx - 4, cy + dy - 4, 9, 9).data;
            const sum = [0, 0, 0];
            for (let i = 0; i < d.length; i += 4) {
              sum[0] += d[i];
              sum[1] += d[i + 1];
              sum[2] += d[i + 2];
            }
            const n2 = d.length / 4;
            return sum.map((v) => Math.round(v / n2));
          };
          // The prop is 2 m wide and 9 m away: the side boxes land about a
          // tenth of the frame either side of centre. Sampled from the live
          // canvas size rather than a hard-coded pixel offset, which is what
          // made item 13's decal check miss by 50px.
          const spread = Math.round(c.height * 0.09);
          resolve({
            centre: patch(0, 0),
            left: patch(-spread, 0),
            right: patch(spread, 0),
            above: patch(0, -spread),
            below: patch(0, spread),
          });
        };
        requestAnimationFrame(step);
      });
    }, angle);

  /** "red", "blue", "green" or null for whichever the patch is closest to. */
  const hueOf = (pixel) => {
    const [r, g, b] = pixel;
    if (r < 60 && g < 60 && b < 60) return null;
    if (r > g + 40 && r > b + 40) return "red";
    if (b > r + 40 && b > g + 40) return "blue";
    if (g > r + 40 && g > b + 40) return "green";
    return null;
  };

  // --- The billboard is on screen, the right way round -----------------------
  await run(() => {
    const e = globalThis.__engine;
    // Force the impostor level so the billboard is what is drawn, in exactly
    // the place the mesh would have been.
    e.getEntity(globalThis.__ids.group).getComponent("lod").setProp("forcedLevel", 1);
  });
  await wait(600);

  const front = await look(0);
  check(
    "the impostor is on screen at all",
    hueOf(front.left) !== null || hueOf(front.right) !== null,
    `left ${front.left} right ${front.right}`,
  );
  check(
    "seen from the front, the +X box is on the right and the -X box on the left",
    hueOf(front.right) === "red" && hueOf(front.left) === "blue",
    `left ${hueOf(front.left)} right ${hueOf(front.right)}`,
  );
  check(
    "the +Y box is ABOVE centre — the atlas is not flipped vertically",
    hueOf(front.above) === "green" && hueOf(front.below) === null,
    `above ${hueOf(front.above)} below ${hueOf(front.below)}`,
  );

  const back = await look(180);
  check(
    "orbiting to the far side swaps them — the shader picked a different frame",
    hueOf(back.right) === "blue" && hueOf(back.left) === "red",
    `left ${hueOf(back.left)} right ${hueOf(back.right)}`,
  );

  const side = await look(90);
  check(
    "from the side the near box hides the far one — the frame really is a rendering, not a cutout",
    hueOf(side.centre) === "red" && hueOf(side.left) !== "blue" && hueOf(side.right) !== "blue",
    `centre ${hueOf(side.centre)} left ${hueOf(side.left)} right ${hueOf(side.right)}`,
  );

  const above = await run(() => {
    const viewport = globalThis.__viewport;
    viewport.camera.position.set(0.01, 14, 0.01);
    viewport.orbit.target.set(0, 2, 0);
    viewport.orbit.update();
    return new Promise((resolve) => {
      let n = 0;
      const step = () => {
        if (++n < 6) return requestAnimationFrame(step);
        const src = globalThis.__engine.renderer.domElement;
        const c = document.createElement("canvas");
        c.width = src.width;
        c.height = src.height;
        c.getContext("2d").drawImage(src, 0, 0);
        const d = c.getContext("2d").getImageData(
          Math.floor(c.width / 2) - 4,
          Math.floor(c.height / 2) - 4,
          9,
          9,
        ).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) {
          sum[0] += d[i];
          sum[1] += d[i + 1];
          sum[2] += d[i + 2];
        }
        resolve(sum.map((v) => Math.round(v / (d.length / 4))));
      };
      requestAnimationFrame(step);
    });
  });
  // Asserted as "coloured", not as a particular hue. Directly over the pole is
  // where a hemi-octahedral atlas is at its worst: the frames surrounding the
  // centre are rotations of each other, so blending three of them smears their
  // colours together. That is a property of the mapping, not a bug, and pinning
  // a hue here would be pinning the artefact.
  check(
    "looking straight down still draws the object — the polar frame is not degenerate",
    Math.max(...above) - Math.min(...above) > 40 && Math.max(...above) > 90,
    `rgb(${above})`,
  );

  // --- Switching it off ------------------------------------------------------
  const hidden = await run(() => {
    const e = globalThis.__engine;
    const viewport = globalThis.__viewport;
    viewport.camera.position.set(0, 2, 9);
    viewport.orbit.target.set(0, 2, 0);
    viewport.orbit.update();
    e.getEntity(globalThis.__ids.group).getComponent("lod").setProp("forcedLevel", 0);
    return new Promise((resolve) => {
      let n = 0;
      const step = () => {
        if (++n < 8) return requestAnimationFrame(step);
        const batch = [...e.impostors.batches.values()][0];
        const component = e.getEntity(globalThis.__ids.level).getComponent("impostor");
        const index = batch.members.indexOf(component);
        resolve({
          size: batch.geometry.attributes.aSize.array[index],
          instanceCount: batch.geometry.instanceCount,
        });
      };
      requestAnimationFrame(step);
    });
  });
  check(
    "switching back to the mesh level zeroes the impostor's instance rather than compacting the buffer",
    hidden.size === 0 && hidden.instanceCount === 10,
    JSON.stringify(hidden),
  );

  const removed = await run(() => {
    const e = globalThis.__engine;
    e.getEntity(globalThis.__ids.level).removeComponent("impostor");
    return new Promise((resolve) => {
      let n = 0;
      const step = () => {
        if (++n < 5) return requestAnimationFrame(step);
        resolve({
          instances: [...e.impostors.batches.values()].reduce((sum, b) => sum + b.members.length, 0),
          atlases: e.impostors.cache.size,
        });
      };
      requestAnimationFrame(step);
    });
  });
  check(
    "removing the component takes its instance out but leaves the shared atlas alone",
    removed.instances === 9 && removed.atlases === 1,
    JSON.stringify(removed),
  );

  // The filter is narrow ON PURPOSE. An earlier version dropped anything
  // matching /WebGPU/, which swallowed "Render pipeline creation failed …" —
  // the message that was the entire reason the depth pass wrote nothing. A
  // validation error from the backend is exactly the class of failure a smoke
  // exists to catch, so only the known-benign startup noise is ignored.
  const real = errors.filter((e) => {
    if (/GPUValidationError|pipeline creation failed|Uncaptured/i.test(e)) return true;
    if (/GPUAdapter|Deprecation|favicon|WebGPU is experimental/i.test(e)) return false;
    return !/Failed to load resource/i.test(e);
  });
  if (real.length) {
    console.log("\nConsole errors:");
    for (const e of real.slice(0, 8)) console.log(`  ${e}`);
  }
  check("no console errors", real.length === 0, `${real.length}`);
} catch (error) {
  check("the smoke ran to completion", false, error.message);
} finally {
  await browser.close();
}

console.log(`\nIMPOSTOR-SMOKE ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
