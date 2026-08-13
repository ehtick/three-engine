import { useEffect, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { createGltfLoader } from "../../engine/gltfLoader.js";
import { throttlePreviewFrame } from "../previewLoop.js";

/**
 * An interactive GLB preview: drag to turn it, pick which animation plays.
 *
 * Built for the asset browsers, where "what am I about to import" is a question
 * a thumbnail cannot answer. A still image of an animated character tells you
 * nothing about whether its walk cycle is usable, and Poly Pizza's catalogue is
 * full of models whose whole value is the clips they ship with.
 *
 * ## Why its own renderer
 *
 * The editor's main WebGPU canvas is claimed by the viewport (see
 * viewportCanvas.js) and cannot be borrowed for a thumbnail. So this owns a
 * small `WebGPURenderer` of its own, like the Asset Inspector's preview and the
 * material/geometry previews do — and, like them, runs through
 * `throttlePreviewFrame`, which caps it at 30fps and skips entirely when the
 * canvas is not visible. That cap is not politeness: a second swapchain
 * presenting at 120Hz serialises against the viewport's present and shows up as
 * viewport frame drops.
 *
 * Exactly one of these is alive at a time in practice (it renders the SELECTED
 * model, and there is one selection), which is what makes a per-instance
 * renderer affordable.
 *
 * ## Loading
 *
 * `src` is passed to the loader as-is. Remote sources therefore have to be
 * CORS-readable — Poly Pizza's CDN sends `Access-Control-Allow-Origin: *`, so
 * the bytes load straight into the webview with no Rust proxy in the way. A
 * host that does not would need `fetch_bytes` and a blob URL instead.
 *
 * ## Interaction
 *
 * It turntables on its own until you touch it, then hands over: showing the
 * model off is the point of the first two seconds, and fighting an auto-spin
 * while trying to look at something is the point of nothing. Drag turns,
 * wheel dollies, and both are clamped so the model cannot be lost off-screen.
 */

/** Framing distance as a multiple of the model's bounding radius. */
const FIT = 2.4;
const MIN_ZOOM = 1.1;
const MAX_ZOOM = 6;
/** Radians/second of idle turntable, before the user takes over. */
const IDLE_SPIN = 0.45;
/** Kept just off the poles: straight down the Y axis gimbal-locks the lookAt. */
const MAX_PITCH = Math.PI / 2 - 0.05;

/**
 * Frees everything a loaded GLTF allocated on the GPU.
 *
 * three does not do this for you, and a browser panel that loads a new model on
 * every click is the exact shape that turns "does not dispose" into hundreds of
 * megabytes. Textures are collected into a set first because materials share
 * them, and disposing one twice is not free.
 */
function disposeScene(root) {
  const textures = new Set();
  root.traverse((object) => {
    const mesh = /** @type {THREE.Mesh} */ (object);
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose?.();
    for (const material of [mesh.material].flat().filter(Boolean)) {
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
      material.dispose?.();
    }
  });
  for (const texture of textures) texture.dispose();
}

export function ModelPreview({ src, className = "" }) {
  const canvasRef = useRef(null);
  const [clips, setClips] = useState([]);
  const [clipIndex, setClipIndex] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // Written by the pointer handlers, read by the frame loop. A ref rather than
  // state because a drag produces a mousemove per frame and re-rendering React
  // at that rate to move a camera would cost more than the render it drives.
  const viewRef = useRef({ yaw: 0.7, pitch: 0.35, zoom: 1, touched: false });
  // Lets the clip <select> reach the mixer without re-running the whole
  // load-and-build effect, which would re-download the model on every change.
  const playRef = useRef(null);

  useEffect(() => {
    let disposed = false;
    let renderer = null;
    let resizeObserver = null;
    let loaded = null;
    setClips([]);
    setClipIndex(0);
    setError(null);
    setLoading(true);
    viewRef.current = { yaw: 0.7, pitch: 0.35, zoom: 1, touched: false };

    if (!src) {
      setLoading(false);
      return undefined;
    }

    (async () => {
      try {
        const gltf = await createGltfLoader().loadAsync(src);
        if (disposed) {
          disposeScene(gltf.scene);
          return;
        }
        loaded = gltf.scene;
        const canvas = canvasRef.current;
        if (!canvas) return;

        renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio ?? 1);
        await renderer.init();
        if (disposed) {
          renderer.dispose();
          disposeScene(gltf.scene);
          return;
        }

        const width = canvas.clientWidth || 280;
        const height = canvas.clientHeight || 200;
        renderer.setSize(width, height, false);
        const camera = new THREE.PerspectiveCamera(40, width / height, 0.01, 100);
        resizeObserver = new ResizeObserver(() => {
          const w = canvas.clientWidth;
          const h = canvas.clientHeight;
          if (w < 1 || h < 1) return;
          renderer?.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        });
        resizeObserver.observe(canvas);

        const scene = new THREE.Scene();
        // Three-point-ish rig rather than one lamp: these are unlit-looking
        // low-poly models, and a single directional light leaves half of every
        // one of them a flat silhouette.
        scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.6));
        const key = new THREE.DirectionalLight(0xffffff, 2.2);
        key.position.set(3, 5, 4);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.7);
        fill.position.set(-4, 2, -3);
        scene.add(fill);
        scene.add(gltf.scene);

        const bounds = new THREE.Box3().setFromObject(gltf.scene);
        const center = bounds.getCenter(new THREE.Vector3());
        const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 1e-4);
        // Near/far derived from the model's own size — a fixed 0.01/100 pair
        // z-fights on a 200-metre model and clips a 2-centimetre one.
        camera.near = radius / 100;
        camera.far = radius * 40;
        camera.updateProjectionMatrix();

        const mixer = gltf.animations?.length ? new THREE.AnimationMixer(gltf.scene) : null;
        let current = null;
        playRef.current = (index) => {
          if (!mixer || !gltf.animations?.[index]) return;
          const next = mixer.clipAction(gltf.animations[index]);
          // Cross-fade rather than cut: switching clips on a character reads as
          // a glitch otherwise, and a quarter second is enough to see the
          // transition without hiding the clip you asked for.
          if (current && current !== next) next.crossFadeFrom(current, 0.25, false);
          next.reset().play();
          current = next;
        };
        setClips((gltf.animations ?? []).map((clip, i) => clip.name || `Clip ${i + 1}`));
        playRef.current(0);
        setLoading(false);

        const timer = new THREE.Timer();
        renderer.setAnimationLoop(throttlePreviewFrame(canvas, () => {
          timer.update();
          const dt = timer.getDelta();
          const view = viewRef.current;
          if (!view.touched) view.yaw += dt * IDLE_SPIN;
          mixer?.update(dt);
          const distance = radius * FIT * view.zoom;
          const cosPitch = Math.cos(view.pitch);
          camera.position.set(
            center.x + Math.sin(view.yaw) * cosPitch * distance,
            center.y + Math.sin(view.pitch) * distance,
            center.z + Math.cos(view.yaw) * cosPitch * distance,
          );
          camera.lookAt(center);
          renderer.render(scene, camera);
        }));
      } catch (err) {
        if (!disposed) {
          setError(String(err?.message ?? err));
          setLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
      playRef.current = null;
      resizeObserver?.disconnect();
      renderer?.setAnimationLoop(null);
      renderer?.dispose();
      // After the renderer, so nothing is mid-submit against a disposed buffer.
      if (loaded) disposeScene(loaded);
    };
  }, [src]);

  // Clip changes drive the mixer directly. Routing them through the load effect
  // would re-download the model every time you picked a different animation.
  useEffect(() => {
    playRef.current?.(clipIndex);
  }, [clipIndex]);

  const onPointerDown = (event) => {
    // Left button only: right-click belongs to the context menu, and middle
    // click is a browser autoscroll gesture we should not swallow.
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    viewRef.current.touched = true;
    viewRef.current.dragging = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event) => {
    const view = viewRef.current;
    if (!view.dragging) return;
    const dx = event.clientX - view.dragging.x;
    const dy = event.clientY - view.dragging.y;
    view.dragging = { x: event.clientX, y: event.clientY };
    view.yaw -= dx * 0.01;
    view.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, view.pitch + dy * 0.01));
  };

  const endDrag = (event) => {
    viewRef.current.dragging = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const onWheel = (event) => {
    // Not preventDefault'd through React: the listener is passive, so the
    // clamp below is what stops the gesture running away, not the event.
    const view = viewRef.current;
    view.touched = true;
    view.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * (1 + Math.sign(event.deltaY) * 0.12)));
  };

  return (
    <div className={`model-preview-3d ${className}`.trim()}>
      <div className="model-preview-stage">
        {error ? (
          <div className="ph-status">Preview unavailable: {error}</div>
        ) : (
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onWheel={onWheel}
            title="Drag to turn · scroll to zoom"
          />
        )}
        {loading && !error && <div className="model-preview-loading">Loading preview…</div>}
      </div>
      {/* One clip is not a choice — the selector only earns its row when there
          is something to switch between. */}
      {clips.length > 1 && (
        <select
          className="ph-category model-preview-clips"
          value={clipIndex}
          onChange={(event) => setClipIndex(Number(event.target.value))}
          title="Animation clip"
        >
          {clips.map((name, i) => (
            <option key={`${name}-${i}`} value={i}>{name}</option>
          ))}
        </select>
      )}
      {clips.length === 1 && <div className="model-preview-clipname">{clips[0]}</div>}
    </div>
  );
}
