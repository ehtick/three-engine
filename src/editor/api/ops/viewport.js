/**
 * Seeing and aiming: the ops that let an assistant look at the scene it is
 * building instead of reasoning about it purely from numbers.
 *
 * This is the single largest capability gap the API had. Everything else here
 * reads or writes structure — names, transforms, component props — and none of
 * it answers "does this look right?". A wall placed one unit off, a light
 * inside geometry, a material that came out black: all invisible to a caller
 * that can only read transforms, and all obvious in one frame.
 *
 * ## Capture goes through a render target, not the canvas
 *
 * The obvious `canvas.toDataURL()` does not work here. The canvas is a WebGPU
 * surface; after a frame is presented its contents are not guaranteed to be
 * readable, and three's WebGPU backend does not configure the context with a
 * preserved drawing buffer. So we render one extra frame into an offscreen
 * `RenderTarget` and read that back — which also decouples the screenshot's
 * resolution from whatever size the panel happens to be, and lets a caller ask
 * for a small image (the default) rather than paying for a 4K readback that a
 * model will only see downscaled anyway.
 */
import * as THREE from "three/webgpu";
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { getViewportHandle } from "../../viewportHandle.js";
import { EDITOR_LAYER } from "../../../engine/editorLayers.js";
import { getEntityBoundingSphere } from "../../../engine/viewFrustum.js";
import { useConsoleStore } from "../../store/consoleStore.js";
import { isViewportFreezeEnabled, setViewportFreezeEnabled } from "../../viewportFreeze.js";

/** Caps the readback so a caller can't ask for a gigabyte of pixels. */
const MAX_DIM = 2048;

const _sphere = new THREE.Sphere();
const _box = new THREE.Box3();

/** The camera a screenshot should use: the editor's view, or the game camera. */
function pickCamera(which) {
  const viewport = getViewportHandle();
  if (which === "game") {
    if (!engine.camera) throw new Error("No active game camera in this scene.");
    return engine.camera;
  }
  if (!viewport?.camera) {
    throw new Error("No viewport is open — open the Viewport panel to take a screenshot.");
  }
  return viewport.camera;
}

/**
 * Renders one frame at `width`x`height` and returns it as a PNG data URL.
 *
 * The camera's aspect is temporarily overridden to match the requested size and
 * restored afterwards; without that, a 512x512 request through a wide viewport
 * camera returns a horizontally squashed image that reads as a modelling error
 * rather than a framing artefact.
 */
async function capture({ width, height, camera, includeGizmos }) {
  const renderer = engine.renderer;
  if (!renderer) throw new Error("The renderer is not ready yet.");

  const target = new THREE.RenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
  });

  const prevAspect = camera.aspect;
  const prevTarget = renderer.getRenderTarget();
  const gizmosWereVisible = camera.layers.isEnabled(EDITOR_LAYER);
  try {
    if (!includeGizmos) camera.layers.disable(EDITOR_LAYER);
    if (camera.isPerspectiveCamera) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    renderer.setRenderTarget(target);
    renderer.render(engine.scene, camera);
    renderer.setRenderTarget(prevTarget);

    // NOTE the signature: on WebGPU `readRenderTargetPixelsAsync` RETURNS the
    // pixels and its 6th argument is a texture index, not a destination buffer
    // (that is the WebGL shape). Passing an array there indexes
    // `renderTarget.textures[<array>]`, yields undefined, and fails inside the
    // backend with "Invalid value used as weak map key".
    const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);

    // WebGPU requires `bytesPerRow` to be a multiple of 256, and three returns
    // the mapped buffer with that padding still in it. Indexing it tightly
    // "works" — you get a plausible PNG of the right size — but every row after
    // the first is offset a little further, so the image comes out sheared and
    // nothing about the result says so. Unpad explicitly.
    const rowBytes = width * 4;
    const paddedRow = Math.ceil(rowBytes / 256) * 256;

    // Render targets are bottom-up; canvases are top-down. Doing the flip in
    // the same pass as the unpad keeps this to one row copy each.
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const from = (height - 1 - y) * paddedRow;
      // The final row is short by design — three sizes the buffer as
      // (height-1)*paddedRow + rowBytes — so clamp rather than over-read.
      const available = Math.max(0, Math.min(rowBytes, raw.length - from));
      if (available > 0) image.data.set(raw.subarray(from, from + available), y * rowBytes);
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  } finally {
    if (camera.isPerspectiveCamera && prevAspect) {
      camera.aspect = prevAspect;
      camera.updateProjectionMatrix();
    }
    if (gizmosWereVisible) camera.layers.enable(EDITOR_LAYER);
    renderer.setRenderTarget(prevTarget);
    target.dispose();
  }
}

defineOp({
  name: "viewport.screenshot",
  readOnly: true,
  description:
    "Render the current scene and return it as a PNG image. THE way to check what a scene actually looks like — call it after building or changing anything visual, rather than inferring the result from transforms. Gizmos, grid and selection outlines are excluded by default so you see the scene, not the editor.",
  params: {
    width: { type: "number", default: 720, description: "Image width in pixels (max 2048)." },
    height: { type: "number", default: 480, description: "Image height in pixels (max 2048)." },
    camera: {
      type: "string",
      default: "editor",
      enum: ["editor", "game"],
      description: "'editor' is the viewport view you are moving; 'game' is the scene's active camera component.",
    },
    includeGizmos: {
      type: "boolean",
      default: false,
      description: "Include editor-only overlays (grid, light helpers, selection box).",
    },
  },
  async run({ width = 720, height = 480, camera = "editor", includeGizmos = false }) {
    const w = Math.max(16, Math.min(MAX_DIM, Math.round(width)));
    const h = Math.max(16, Math.min(MAX_DIM, Math.round(height)));
    const dataUrl = await capture({ width: w, height: h, camera: pickCamera(camera), includeGizmos });
    // `__image` is the convention the MCP server looks for to emit an image
    // content block instead of JSON text. See mcp/server.mjs.
    return {
      __image: { mimeType: "image/png", base64: dataUrl.slice(dataUrl.indexOf(",") + 1) },
      width: w,
      height: h,
      camera,
    };
  },
});

defineOp({
  name: "viewport.getCamera",
  readOnly: true,
  description: "Where the editor viewport camera is and what it is looking at.",
  params: {},
  run() {
    const viewport = getViewportHandle();
    if (!viewport?.camera) throw new Error("No viewport is open.");
    return {
      position: viewport.camera.position.toArray(),
      target: viewport.orbit?.target?.toArray() ?? [0, 0, 0],
      fov: viewport.camera.fov ?? null,
      orthographic: !!viewport.camera.isOrthographicCamera,
    };
  },
});

defineOp({
  name: "viewport.setCamera",
  description:
    "Move the editor viewport camera. Use before viewport.screenshot to look at a particular place from a particular angle.",
  params: {
    position: { type: "array", description: "[x, y, z] eye position.", items: { type: "number" } },
    target: { type: "array", description: "[x, y, z] point to look at.", items: { type: "number" } },
  },
  run({ position, target }) {
    const viewport = getViewportHandle();
    if (!viewport?.camera) throw new Error("No viewport is open.");
    if (position) viewport.camera.position.set(position[0], position[1], position[2]);
    if (target && viewport.orbit) viewport.orbit.target.set(target[0], target[1], target[2]);
    // OrbitControls owns the camera's orientation, so setting position alone
    // does nothing visible until it recomputes — this is the step that is easy
    // to miss and produces a "the camera didn't move" report.
    viewport.orbit?.update();
    if (!viewport.orbit && target) viewport.camera.lookAt(target[0], target[1], target[2]);
    return {
      position: viewport.camera.position.toArray(),
      target: viewport.orbit?.target?.toArray() ?? null,
    };
  },
});

/** World-space bounds of an entity's renderable content, including descendants. */
function boundsOf(entity) {
  const ok = getEntityBoundingSphere(entity, _sphere);
  if (!ok || !Number.isFinite(_sphere.radius)) return null;
  _sphere.getBoundingBox(_box);
  return {
    center: _sphere.center.toArray(),
    radius: _sphere.radius,
    min: _box.min.toArray(),
    max: _box.max.toArray(),
    size: _box.getSize(new THREE.Vector3()).toArray(),
  };
}

defineOp({
  name: "viewport.focus",
  description:
    "Frame an entity (or the whole scene) in the viewport, then you can screenshot it. Equivalent to pressing F in the editor.",
  params: {
    id: { type: "string", description: "Entity to frame; omit to frame the whole scene." },
    distance: { type: "number", description: "Multiplier on the fitted distance. >1 pulls back." },
  },
  run({ id, distance = 2.2 }) {
    const viewport = getViewportHandle();
    if (!viewport?.camera) throw new Error("No viewport is open.");

    let center;
    let radius;
    if (id) {
      const entity = engine.getEntity(id);
      if (!entity) throw new Error(`No entity with id "${id}"`);
      const bounds = boundsOf(entity);
      if (!bounds) throw new Error(`Entity "${entity.name}" has no renderable geometry to frame.`);
      center = new THREE.Vector3().fromArray(bounds.center);
      radius = bounds.radius;
    } else {
      const box = new THREE.Box3();
      let any = false;
      for (const entity of engine.entities.values()) {
        if (!getEntityBoundingSphere(entity, _sphere) || !Number.isFinite(_sphere.radius)) continue;
        _sphere.getBoundingBox(_box);
        box.union(_box);
        any = true;
      }
      if (!any) throw new Error("The scene has nothing renderable to frame.");
      center = box.getCenter(new THREE.Vector3());
      radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2);
    }

    // Keep the current viewing DIRECTION and just change how far away we are —
    // re-framing from a fixed angle would throw away whatever view the user set
    // up, which is surprising when an assistant does it mid-session.
    const dir = new THREE.Vector3()
      .subVectors(viewport.camera.position, viewport.orbit?.target ?? center)
      .normalize();
    if (!Number.isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-6) dir.set(1, 0.8, 1).normalize();
    const dist = Math.max(0.5, radius * distance);
    viewport.camera.position.copy(center).addScaledVector(dir, dist);
    viewport.orbit?.target.copy(center);
    viewport.orbit?.update();
    return { center: center.toArray(), radius, distance: dist };
  },
});

defineOp({
  name: "viewport.setFreezeWhenUnfocused",
  description:
    "Toggle whether the viewport stops rendering while another panel is focused (Project Settings → Editor → 'Freeze unfocused viewport'). ON by default, so a heavy scene doesn't steal the main thread from whatever panel the user is working in; turn it OFF before watching something run unattended, since nothing is ever focused in a headless session. Omit `enabled` to just read the current setting.",
  params: {
    enabled: {
      type: "boolean",
      description: "true (the default) to pause an unfocused viewport, false to always render.",
    },
  },
  run({ enabled }) {
    if (enabled !== undefined) setViewportFreezeEnabled(!!enabled);
    return { enabled: isViewportFreezeEnabled() };
  },
});

defineOp({
  name: "entity.getBounds",
  readOnly: true,
  description:
    "World-space bounding box and sphere of an entity's renderable content, including its children. Use it before placing things next to each other — sizes are otherwise unknowable from transforms alone, since a 'box' mesh's real extent depends on its geometry and scale.",
  params: { id: { type: "string", required: true } },
  run({ id }) {
    const entity = engine.getEntity(id);
    if (!entity) throw new Error(`No entity with id "${id}"`);
    const bounds = boundsOf(entity);
    if (!bounds) return { id, empty: true, reason: "No renderable geometry on this entity or its children." };
    return { id, empty: false, ...bounds };
  },
});

defineOp({
  name: "console.read",
  readOnly: true,
  description:
    "Recent editor console output, newest last. Call this after writing a script, importing an asset, or any edit that might fail asynchronously — errors surface here rather than in the tool result that caused them.",
  params: {
    level: {
      type: "string",
      enum: ["all", "error", "warn"],
      default: "all",
      description: "Filter by severity.",
    },
    limit: { type: "number", default: 50, description: "How many of the most recent entries to return." },
  },
  run({ level = "all", limit = 50 }) {
    const entries = useConsoleStore.getState().entries ?? [];
    const wanted = level === "all" ? entries : entries.filter((entry) => entry.level === level);
    const take = Math.max(1, Math.min(500, Math.round(limit)));
    return wanted.slice(-take).map((entry) => ({
      level: entry.level,
      message: entry.message,
      time: entry.time instanceof Date ? entry.time.toISOString() : String(entry.time),
    }));
  },
});
