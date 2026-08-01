/**
 * The UI system in a real browser, against a real WebGPU renderer.
 *
 * Covers what the headless test cannot: that a screen-space canvas is a *plane
 * in the world* while editing (rather than a sheet over the viewport), that a
 * world panel follows its entity, that SDF glyphs actually become geometry and
 * draw, that nine-slice keeps its corners, and that a menu can be driven with
 * no mouse.
 *
 *   npx vite --port 5201
 *   node scripts/run-ui-smoke.mjs [url]
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
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));
// A bare "Failed to load resource" console line names no URL, and the browser's
// own /favicon.ico probe 404s in dev. Correlating the console line with the
// recorded responses keeps a genuinely missing module failing the run while the
// favicon does not.
const failedRequests = [];
page.on("response", (r) => {
  if (r.status() >= 400 && !/\/favicon\.ico$/.test(r.url())) failedRequests.push(`${r.status()} ${r.url()}`);
});

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
  await wait(6000);

  // --- Build a small menu ----------------------------------------------------
  const built = await page.evaluate(async () => {
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    globalThis.__engine = engine;

    const make = (name, parent, components) => {
      const e = engine.createEntity({ name });
      if (parent) e.setParent(parent);
      for (const [type, props] of components) e.addComponent(type, props);
      return e;
    };

    const screen = make("Screen", null, [["uiscreen", { referenceWidth: 800, referenceHeight: 600 }]]);
    const panel = make("Panel", screen, [
      ["uielement", { anchorMin: [0.5, 0.5], anchorMax: [0.5, 0.5], pivot: [0.5, 0.5], pos: [0, 0], size: [400, 300] }],
      ["uiimage", { color: "#223344", cornerRadius: 12 }],
    ]);
    const label = make("Label", panel, [
      ["uielement", { anchorMin: [0.5, 0], anchorMax: [0.5, 0], pivot: [0.5, 0], pos: [0, 20], size: [360, 60] }],
      ["uitext", { text: "Pause", fontSize: 40, outlineWidth: 2 }],
    ]);
    const buttonAt = (name, y) => {
      const e = make(name, panel, [
        ["uielement", { anchorMin: [0.5, 0], anchorMax: [0.5, 0], pivot: [0.5, 0], pos: [0, y], size: [200, 48] }],
        ["uiimage", { color: "#ffffff", cornerRadius: 8 }],
        ["uibutton", {}],
      ]);
      return e;
    };
    const resume = buttonAt("Resume", 100);
    const options = buttonAt("Options", 160);
    const quit = buttonAt("Quit", 220);

    // A world-space panel bolted to a moving object — the health-bar case.
    const enemy = make("Enemy", null, []);
    enemy.object3D.position.set(3, 1, 0);
    const bar = make("HealthBar", enemy, [
      ["uiscreen", { renderMode: "world", referenceWidth: 200, referenceHeight: 40, worldScale: 0.005 }],
    ]);
    make("Fill", bar, [
      ["uielement", { anchorMin: [0, 0], anchorMax: [1, 1], pos: [0, 0], size: [0, 0] }],
      ["uiimage", { color: "#e04040", fillMode: "horizontal", fillAmount: 0.6 }],
    ]);

    globalThis.__ids = {
      screen: screen.id, panel: panel.id, label: label.id,
      resume: resume.id, options: options.id, quit: quit.id,
      enemy: enemy.id, bar: bar.id,
    };
    return { entities: engine.entities.size };
  });
  check("the menu was built", built.entities >= 9, String(built.entities));
  await wait(1200);

  const ui = async (body, arg) =>
    page.evaluate(
      // eslint-disable-next-line no-new-func
      (source, value) => new Function(`return (${source})`)()(value),
      body.toString(),
      arg ?? null,
    );

  // --- Editor: a screen-space canvas is a plane, not an overlay --------------
  const editing = await ui(() => {
    const e = globalThis.__engine;
    const screen = e.getEntity(globalThis.__ids.screen).getComponent("uiscreen");
    const panel = e.getEntity(globalThis.__ids.panel);
    return {
      mode: screen.mode,
      unit: screen.unit,
      uiWidth: screen.uiWidth,
      // The panel's mesh, in world space.
      panelWorld: panel.object3D.getWorldPosition(new (globalThis.__ENGINE_THREE__.Vector3)()).toArray(),
    };
  });
  check("a screen canvas is shown as a plane while editing", editing.mode === "plane", String(editing.mode));
  check("sized from the reference resolution, not the window", editing.uiWidth === 800, String(editing.uiWidth));
  check("scaled into world units", editing.unit === 0.01, String(editing.unit));

  // Moving the screen entity has to move the plane — the whole point of the
  // change. A pinned overlay would keep the panel at the origin.
  const moved = await ui(() => {
    const e = globalThis.__engine;
    const screen = e.getEntity(globalThis.__ids.screen);
    screen.object3D.position.set(10, 2, -4);
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const panel = e.getEntity(globalThis.__ids.panel);
          const v = panel.object3D.getWorldPosition(new (globalThis.__ENGINE_THREE__.Vector3)());
          resolve({ x: v.x, y: v.y, z: v.z, rootX: screen.object3D.position.x });
        }),
      );
    });
  });
  check("the plane can be moved aside from the scene", Math.abs(moved.x - 10) < 0.5, JSON.stringify(moved));
  check("and its transform is not stomped every frame", moved.rootX === 10, String(moved.rootX));

  // The overlay preview puts it back over the viewport.
  const preview = await ui(() => {
    const e = globalThis.__engine;
    e.uiSystem.setOverlayPreview(true);
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const screen = e.getEntity(globalThis.__ids.screen);
          resolve({
            mode: screen.getComponent("uiscreen").mode,
            rootX: screen.object3D.position.x,
            uiWidth: screen.getComponent("uiscreen").uiWidth,
          });
        }),
      );
    });
  });
  check("the overlay preview switches it back to a HUD", preview.mode === "overlay", String(preview.mode));
  check("which pins the root to the origin", preview.rootX === 0, String(preview.rootX));
  check("and sizes it from the canvas", preview.uiWidth !== 800, String(preview.uiWidth));
  await ui(() => globalThis.__engine.uiSystem.setOverlayPreview(false));

  // --- World panel -----------------------------------------------------------
  const world = await ui(() => {
    const e = globalThis.__engine;
    const bar = e.getEntity(globalThis.__ids.bar).getComponent("uiscreen");
    const fill = e.getEntity(globalThis.__ids.bar).children[0];
    const v = fill.object3D.getWorldPosition(new (globalThis.__ENGINE_THREE__.Vector3)());
    const size = bar.worldSize;
    return { mode: bar.mode, unit: bar.unit, world: [v.x, v.y, v.z], size };
  });
  check("a world screen renders as a panel", world.mode === "world", String(world.mode));
  check("it follows the entity it is parented to", Math.abs(world.world[0] - 3) < 0.2 && Math.abs(world.world[1] - 1) < 0.2, JSON.stringify(world.world));
  check("its world size comes from reference × worldScale", Math.abs(world.size.w - 1) < 1e-6 && Math.abs(world.size.h - 0.2) < 1e-6, JSON.stringify(world.size));

  const billboard = await ui(() => {
    const e = globalThis.__engine;
    const bar = e.getEntity(globalThis.__ids.bar);
    const THREE = globalThis.__ENGINE_THREE__;
    const toCam = new THREE.Vector3();
    e.camera.getWorldPosition(toCam);
    const barPos = new THREE.Vector3();
    bar.object3D.getWorldPosition(barPos);
    toCam.sub(barPos).normalize();
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(bar.object3D.getWorldQuaternion(new THREE.Quaternion()));
    return { dot: normal.dot(toCam) };
  });
  check("and faces the camera", billboard.dot > 0.9, String(billboard.dot.toFixed(3)));

  // --- SDF text --------------------------------------------------------------
  const text = await ui(() => {
    const e = globalThis.__engine;
    const label = e.getEntity(globalThis.__ids.label);
    const comp = label.getComponent("uitext");
    const mesh = comp.mesh;
    const pos = mesh?.geometry?.getAttribute?.("position");
    return {
      mode: comp.mode,
      vertices: pos?.count ?? 0,
      indices: mesh?.geometry?.getIndex?.()?.count ?? 0,
      atlasReady: !!comp.font?.texture,
      // "Pause" is five glyphs, four quads' worth of vertices each.
      glyphs: (pos?.count ?? 0) / 4,
      measured: comp.measure(360),
    };
  });
  check("text renders through the SDF path by default", text.mode === "sdf", String(text.mode));
  check("one quad per glyph reaches the geometry", text.glyphs === 5, `${text.glyphs} glyphs`);
  check("indexed as triangles", text.indices === 30, String(text.indices));
  check("the atlas texture exists", text.atlasReady);
  check("and the text measures to something sensible", text.measured.w > 40 && text.measured.h > 20, JSON.stringify(text.measured));

  // Scaling must NOT re-rasterize anything: the same geometry and the same
  // atlas serve every size. That is the entire reason for the SDF path.
  const scaled = await ui(() => {
    const e = globalThis.__engine;
    const comp = e.getEntity(globalThis.__ids.label).getComponent("uitext");
    const before = comp.mesh.geometry.getAttribute("position").array[0];
    comp.setProp?.("fontSize", 12);
    comp.props.fontSize = 12;
    comp.drawKey = null;
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const after = comp.mesh.geometry.getAttribute("position").array[0];
          resolve({ before, after, sameAtlas: comp.font === globalThis.__engine.uiSystem && false, atlas: comp.font.texture.image.width });
        }),
      );
    });
  });
  check("changing the font size re-lays the glyphs", scaled.before !== scaled.after, `${scaled.before} → ${scaled.after}`);
  check("without changing the atlas", scaled.atlas === 512, String(scaled.atlas));

  const raster = await ui(() => {
    const e = globalThis.__engine;
    const comp = e.getEntity(globalThis.__ids.label).getComponent("uitext");
    comp.props.sdf = false;
    comp.onPropChanged("sdf");
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => resolve({ mode: comp.mode, hasCanvas: !!comp.canvas })),
      );
    });
  });
  check("the raster path is still reachable for emoji/exotic fonts", raster.mode === "raster" && raster.hasCanvas, String(raster.mode));
  await ui(() => {
    const comp = globalThis.__engine.getEntity(globalThis.__ids.label).getComponent("uitext");
    comp.props.sdf = true;
    comp.onPropChanged("sdf");
  });

  // --- Nine-slice ------------------------------------------------------------
  const slice = await ui(async () => {
    const e = globalThis.__engine;
    const THREE = globalThis.__ENGINE_THREE__;
    // A 16×16 texture whose 4px border is red and whose middle is blue.
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(4, 4, 8, 8);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    const image = e.getEntity(globalThis.__ids.panel).getComponent("uiimage");
    image.texture = tex;
    image.props.imageType = "sliced";
    image.props.sliceLeft = 4;
    image.props.sliceRight = 4;
    image.props.sliceTop = 4;
    image.props.sliceBottom = 4;
    image.onPropChanged("imageType");
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const u = image.mesh.material.userData.uiUniforms;
          resolve({
            texSize: [u.texSize.value.x, u.texSize.value.y],
            slice: [u.slice.value.x, u.slice.value.y, u.slice.value.z, u.slice.value.w],
          });
        }),
      );
    });
  });
  check("nine-slice reads the texture's real pixel size", slice.texSize[0] === 16 && slice.texSize[1] === 16, JSON.stringify(slice.texSize));
  check("and carries the insets in texture pixels", slice.slice.join(",") === "4,4,4,4", slice.slice.join(","));

  const clamped = await ui(() => {
    const e = globalThis.__engine;
    const image = e.getEntity(globalThis.__ids.panel).getComponent("uiimage");
    image.props.sliceLeft = 999;
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => resolve(image.mesh.material.userData.uiUniforms.slice.value.x)),
      );
    });
  });
  check("an inset larger than the texture is clamped, not inverted", clamped === 8, String(clamped));

  // --- Focus navigation ------------------------------------------------------
  const nav = await ui(() => {
    const e = globalThis.__engine;
    const focus = e.uiSystem.focus;
    const button = (id) => e.getEntity(globalThis.__ids[id]).getComponent("uibutton");
    focus.clear();
    focus.move({ x: 0, y: 1 }); // nothing focused yet → take the first
    const first = focus.current?.entity.name;
    focus.move({ x: 0, y: 1 });
    const second = focus.current?.entity.name;
    focus.move({ x: 0, y: 1 });
    const third = focus.current?.entity.name;
    focus.move({ x: 0, y: 1 }); // past the end
    const past = focus.current?.entity.name;
    focus.move({ x: 0, y: -1 });
    const back = focus.current?.entity.name;
    const tintFocused = e.getEntity(globalThis.__ids.options).getComponent("uiimage").tint.getHexString();
    return {
      first, second, third, past, back,
      focusedFlag: button("options").focused,
      tintFocused,
      candidates: focus.candidates(e.uiSystem.screenOf(button("resume").entity)).length,
    };
  });
  check("the first navigation press picks a button", nav.first === "Resume", String(nav.first));
  check("Down walks the menu", nav.second === "Options" && nav.third === "Quit", `${nav.second}, ${nav.third}`);
  check("and stops at the end rather than wrapping into nothing", nav.past === "Quit", String(nav.past));
  check("Up comes back", nav.back === "Options", String(nav.back));
  check("the focused button knows it", nav.focusedFlag === true);
  check("and shows the focus tint", nav.tintFocused !== "ffffff", `#${nav.tintFocused}`);
  check("all three buttons are navigable", nav.candidates === 3, String(nav.candidates));

  const override = await ui(() => {
    const e = globalThis.__engine;
    const quit = e.getEntity(globalThis.__ids.quit).getComponent("uibutton");
    quit.props.navDown = globalThis.__ids.resume; // wrap around
    const focus = e.uiSystem.focus;
    focus.set(quit);
    focus.move({ x: 0, y: 1 });
    const wrapped = focus.current?.entity.name;
    // A disabled button must not be reachable.
    e.getEntity(globalThis.__ids.options).getComponent("uibutton").props.interactable = false;
    focus.set(e.getEntity(globalThis.__ids.resume).getComponent("uibutton"));
    focus.move({ x: 0, y: 1 });
    const skipped = focus.current?.entity.name;
    e.getEntity(globalThis.__ids.options).getComponent("uibutton").props.interactable = true;
    return { wrapped, skipped };
  });
  check("an explicit nav override wraps the menu", override.wrapped === "Resume", String(override.wrapped));
  check("a disabled button is skipped", override.skipped === "Quit", String(override.skipped));

  const submitted = await ui(() => {
    const e = globalThis.__engine;
    return new Promise((resolve) => {
      const seen = [];
      const off = (entity) => seen.push(entity.name);
      e.on("ui-click", off);
      e.uiSystem.focus.set(e.getEntity(globalThis.__ids.quit).getComponent("uibutton"));
      e.uiSystem.focus.current.click();
      setTimeout(() => {
        e.off("ui-click", off);
        resolve(seen);
      }, 50);
    });
  });
  check("submitting the focused button clicks it", submitted.join(",") === "Quit", submitted.join(","));

  // --- It actually draws -----------------------------------------------------
  const drawn = await ui(() => {
    const e = globalThis.__engine;
    e.uiSystem.setOverlayPreview(true);
    return new Promise((resolve) => {
      // Two frames so the overlay pass has certainly run with the new mode.
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
          const mid = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
          const corner = ctx.getImageData(4, 4, 1, 1).data;
          resolve({ mid: [...mid], corner: [...corner], w: c.width, h: c.height });
        }),
      );
    });
  });
  if (drawn.error) {
    check("the frame could be read back", false, drawn.error);
  } else {
    check(
      "the UI panel is actually on screen",
      drawn.mid[3] > 0 && (drawn.mid[0] !== drawn.corner[0] || drawn.mid[2] !== drawn.corner[2]),
      `centre rgba(${drawn.mid}) vs corner rgba(${drawn.corner})`,
    );
  }
  await ui(() => globalThis.__engine.uiSystem.setOverlayPreview(false));

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

console.log(`\nUI-SMOKE ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
