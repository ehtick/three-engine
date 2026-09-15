import * as THREE from "three/webgpu";
import { clamp, float, normalView, positionViewDirection, pow, reflector, vec3 } from "three/tsl";
import { Component } from "./Component.js";
import { subscribeMaterial } from "../materialAsset.js";

/**
 * True mirror reflections for a FLAT surface — a polished floor, a still pool,
 * a wall mirror.
 *
 * This is the first tier of the reflection plan (docs/GI_PLAN.md): a planar
 * surface is the one case where a reflection can be *exact and cheap at the
 * same time*, because the whole surface shares one mirrored camera. Screen-
 * space reflections cannot show anything that is off-screen or behind the
 * viewer — which on a floor is most of what you would see in it — and the GI
 * mirror trace resolves the scene only as well as its field. Reflecting the
 * scene through the plane has neither limit: it is the real geometry, from the
 * mirrored viewpoint, at whatever resolution you pay for.
 *
 * ## The cost, stated plainly
 *
 * One extra render of the scene per reflector, per frame. That is the deal
 * planar reflections make everywhere they are used, and it is why this is a
 * component you place deliberately rather than a material checkbox: two of
 * these on screen means three scene renders. `resolution` is the dial — a
 * mirror is high-frequency detail seen through a Fresnel falloff, so half
 * resolution is usually indistinguishable and a quarter of the fill cost.
 *
 * ## Which way the surface faces
 *
 * `normalAxis` is the entity's LOCAL axis pointing out of the reflective face,
 * and it defaults to `+Z` because that is where a `plane` primitive's normal
 * points before you rotate it flat (three's own `PlaneGeometry` lies in XY).
 * For the top face of a box slab, that is `+Y`. Get this wrong and the
 * reflection simply does not draw — the reflector treats a surface viewed from
 * behind as having nothing to show.
 *
 * ## Arbitration with GI
 *
 * A smooth floor is also in GI's mirror roughness bucket, so without this the
 * surface would show a planar reflection AND a traced one, blended by nothing
 * in particular. While attached, the component marks its materials
 * `userData.planarReflection`, which GI reads at two points: `giLight` compiles
 * no reflection path for them, and `GISystem` leaves them out of the exact
 * reflection prepass's mirror mask (so they cost it no rays either). Planar
 * wins on the surfaces it owns; GI keeps everything else.
 */
export class PlanarReflectionComponent extends Component {
  static type = "planar-reflection";
  static label = "Planar Reflection";
  static tags = ["rendering", "3d"];
  static defaults = {
    normalAxis: "+Z",
    resolution: 0.5,
    intensity: 1,
    tint: "#ffffff",
    fresnel: true,
    fresnelPower: 5,
    blur: true,
    bounces: false,
  };
  static schema = [
    { key: "normalAxis", label: "Surface Normal", type: "select", options: ["+Z", "-Z", "+Y", "-Y", "+X", "-X"] },
    { key: "intensity", label: "Intensity", type: "number", min: 0, max: 2, step: 0.01 },
    { key: "tint", label: "Tint", type: "color" },
    { key: "resolution", label: "Resolution Scale", type: "number", min: 0.1, max: 1, step: 0.05 },
    { key: "fresnel", label: "Fresnel Falloff", type: "boolean" },
    { key: "fresnelPower", label: "Fresnel Power", type: "number", min: 1, max: 8, step: 0.1 },
    { key: "blur", label: "Blur By Roughness", type: "boolean" },
    { key: "bounces", label: "Reflect Other Mirrors", type: "boolean" },
  ];

  onAttach() {
    this._restore = [];
    this._node = null;
    this._target = null;

    const root = this.entity?.object3D;
    if (!root) return;
    // ── WAIT FOR A LIVE RENDERER (2026-08-22, "boots black" round 2) ──────
    // On scene load the attach chain (including the material self-heal below)
    // can run BEFORE the WebGPU renderer exists — measured on the user's
    // Level: heal re-attach at t=13.8s, "Renderer backend: WebGPU" at
    // t=14.7s. A reflector node created against no renderer never renders
    // its mirrored pass, and nothing later re-creates it — the mirror is
    // stably black until a manual remove+add (which works precisely because
    // a live add has a renderer). Defer the whole attach until the engine
    // has one; the material self-heal then subscribes against the current
    // (post-load) instances anyway.
    if (!this.entity?.engine?.renderer) {
      if (this._rendererWait == null) {
        const tick = () => {
          this._rendererWait = null;
          if (!this.entity) return; // detached while waiting
          if (this.entity.engine?.renderer) { this.onAttach(); return; }
          this._rendererWait = requestAnimationFrame(tick);
        };
        this._rendererWait = requestAnimationFrame(tick);
      }
      return;
    }
    // ── RE-ARM AFTER EVERY GI COMPILE WAVE (2026-08-22, "boots black") ────
    // The reflector's mirrored pass creates its render pipelines the first
    // time it runs — and on scene load that happens while GISystem's compile
    // wave has the postprocess MRT pinned across a multi-second await, which
    // makes them the invalid-pipeline class: cached, no console error, and
    // the mirror is black forever. (Measured on the user's Level: mirror
    // black on every load; a manual remove+add — which recreates the
    // reflector AFTER the wave — always fixed it.) GISystem emits
    // `gi-compile-wave-done` at the wave's commit point; recreating the
    // reflector then costs one target realloc and compiles clean. Capped in
    // case some future wave is triggered by the re-attach itself.
    const engine = this.entity.engine;
    if (engine?.on && !this._waveUnsub) {
      const onWaveDone = () => {
        if (this._healQueued || !this.entity) return;
        if ((this._waveReattaches = (this._waveReattaches ?? 0) + 1) > 8) return;
        this._healQueued = true;
        queueMicrotask(() => {
          this._healQueued = false;
          if (!this.entity || this._attached === false) return; // detached while queued
          this.onDetach();
          this.onAttach();
        });
      };
      engine.on("gi-compile-wave-done", onWaveDone);
      this._waveUnsub = () => engine.off?.("gi-compile-wave-done", onWaveDone);
    }
    // ── SELF-HEAL (2026-08-22) ────────────────────────────────────────────
    // The composite below lives on MATERIAL INSTANCES, and the mesh component
    // swaps those out from under us: the async .mat load on scene open runs
    // AFTER this attach (the symptom was a mirror that worked when added live
    // and booted BLACK on every scene load — the composite sat on the
    // placeholder material), and every material edit (material_set, inspector,
    // graph change) rebuilds the instance the same way. `subscribeMaterial`
    // fires on exactly those events; the microtask defer lets the mesh
    // component's own subscriber swap `mesh.material` first, so the re-attach
    // captures the CURRENT instance instead of racing it in Set order.
    this._materialUnsubs = [...this.#materialPaths()].map((path) =>
      subscribeMaterial(path, () => {
        if (this._healQueued) return;
        this._healQueued = true;
        queueMicrotask(() => {
          this._healQueued = false;
          if (!this.entity || this._attached === false) return; // detached while queued
          this.onDetach();
          this.onAttach();
        });
      }),
    );
    const meshes = [];
    root.traverse((object) => {
      if (object.isMesh && !object.userData.editorOnly) meshes.push(object);
    });
    if (meshes.length === 0) {
      console.warn("[planar-reflection] no mesh on this entity — nothing to reflect off.");
      return;
    }

    const props = this.props;
    // ONE reflector for the whole entity, not one per mesh: the reflection is a
    // property of the PLANE, so a multi-mesh floor shares a single mirrored
    // render rather than paying for one each.
    const target = new THREE.Object3D();
    orientToAxis(target, props.normalAxis);
    // The target's world matrix IS the mirror plane (position + its local +Z as
    // the normal), so it has to ride the surface — parenting it to the first
    // mesh is what makes moving or rotating the entity just work.
    meshes[0].add(target);
    this._target = target;

    const node = reflector({
      target,
      resolutionScale: clampNumber(props.resolution, 0.1, 1, 0.5),
      // Mipmaps exist so `blur` has something to sample: a rough surface reads
      // a coarser level instead of a mirror-sharp one.
      generateMipmaps: props.blur !== false,
      // Off by default — a reflector that renders other reflectors multiplies
      // scene renders, and two facing mirrors is the pathological case.
      bounces: props.bounces === true,
    });
    this._node = node;
    // ── TELL GI THIS IS A NESTED RENDER (2026-08-22) ──────────────────────
    // GI's deferred screen textures are keyed to the MAIN camera; giLight
    // samples them by a resolve-camera projection so the mirrored pass reads
    // each point's own GI — but points the main view cannot see have no
    // correct GI anywhere, and giLight zeroes them ONLY when it knows it is
    // inside a nested render. The reflector's whole mirrored pass runs
    // inside `updateBefore`, so bracketing it flips the flag GISystem's
    // renderGroup uniform re-reads per render.
    const base = node._reflectorBaseNode ?? node;
    if (typeof base?.updateBefore === "function") {
      const original = base.updateBefore.bind(base);
      base.updateBefore = (frame) => {
        globalThis.__giNestedRender = true;
        try {
          return original(frame);
        } finally {
          globalThis.__giNestedRender = false;
        }
      };
    }

    const tint = new THREE.Color(props.tint ?? "#ffffff");
    const intensity = Math.max(0, props.intensity ?? 1);
    // A GLB's materials are shared by every instance of that model
    // (modelAsset.js), so patching one would put this mirror on all of them:
    // swap in a private copy first, one per shared material, undone on detach.
    this._swaps = [];
    const privateCopies = new Map();
    for (const mesh of meshes) {
      const isArray = Array.isArray(mesh.material);
      const materials = isArray ? mesh.material : [mesh.material];
      for (let index = 0; index < materials.length; index++) {
        let material = materials[index];
        if (material?.userData?.modelTemplate) {
          let own = privateCopies.get(material);
          if (!own) {
            own = material.clone();
            delete own.userData.modelTemplate;
            privateCopies.set(material, own);
          }
          this._swaps.push({ mesh, index, isArray, original: material, own });
          if (isArray) materials[index] = own;
          else mesh.material = own;
          material = own;
        }
        if (!material || this._restore.some((entry) => entry.material === material)) continue;
        this.#applyTo(material, node, tint, intensity);
      }
    }
  }

  /**
   * Composites the reflection into one material and records everything needed
   * to put it back. Restoring exactly is the whole reason this is a list of
   * captured values rather than a "clear these fields" teardown: the material
   * may be authored, shared, or shader-graph-built, and detaching the component
   * must leave it byte-identical to how it arrived.
   */
  #applyTo(material, node, tint, intensity) {
    this._restore.push({
      material,
      emissiveNode: material.emissiveNode ?? null,
      planarFlag: material.userData.planarReflection,
    });

    // The reflection is added AFTER lighting, as emission rather than as an
    // indirect-specular term. That is deliberate: three's lighting model has no
    // outside hook for "replace this surface's environment specular", and a
    // mirror's reflection is by definition light leaving the surface that the
    // BRDF did not compute. Fresnel is what keeps it physical — a mirror floor
    // seen straight down is mostly its own albedo, and mostly reflection at a
    // grazing angle.
    const weight = this.props.fresnel === false
      ? float(intensity)
      : pow(clamp(float(1).sub(normalView.dot(positionViewDirection).abs()), 0, 1), float(Math.max(1, this.props.fresnelPower ?? 5)))
        .mul(intensity);

    // `blur` samples a coarser mip on rougher surfaces. Without a roughness
    // input the sharp level is correct, so an unset roughness costs nothing.
    const source = this.props.blur !== false && material.roughnessNode
      ? node.level(float(material.roughnessNode).mul(6))
      : node;

    const contribution = vec3(source).mul(vec3(tint.r, tint.g, tint.b)).mul(weight);
    material.emissiveNode = material.emissiveNode ? vec3(material.emissiveNode).add(contribution) : contribution;
    // Read by giLight (compiles no reflection path) and GISystem (leaves the
    // mesh out of the exact-reflection mirror mask) — see the class comment.
    material.userData.planarReflection = true;
    material.needsUpdate = true;
  }

  /**
   * Material asset paths of every mesh component on this entity and its
   * children — the set the self-heal subscribes to. Reads component PROPS
   * (the paths), not mesh.material (the instances), because the instances
   * are exactly what the heal exists to chase.
   */
  #materialPaths() {
    const paths = new Set();
    const walk = (entity) => {
      if (!entity) return;
      const meshComp = entity.getComponent?.("mesh");
      if (meshComp?.props) {
        for (const key of ["material", "material2", "material3", "material4", "material5", "material6", "material7", "material8"]) {
          if (meshComp.props[key]) paths.add(meshComp.props[key]);
        }
      }
      for (const child of entity.children ?? []) walk(child);
    };
    walk(this.entity);
    return paths;
  }

  onDetach() {
    if (this._rendererWait != null) {
      cancelAnimationFrame(this._rendererWait);
      this._rendererWait = null;
    }
    this._waveUnsub?.();
    this._waveUnsub = null;
    for (const unsubscribe of this._materialUnsubs ?? []) unsubscribe();
    this._materialUnsubs = [];
    for (const entry of this._restore ?? []) {
      entry.material.emissiveNode = entry.emissiveNode;
      if (entry.planarFlag === undefined) delete entry.material.userData.planarReflection;
      else entry.material.userData.planarReflection = entry.planarFlag;
      entry.material.needsUpdate = true;
    }
    this._restore = [];
    const disposed = new Set();
    for (const { mesh, index, isArray, original, own } of this._swaps ?? []) {
      if (isArray) mesh.material[index] = original;
      else mesh.material = original;
      if (!disposed.has(own)) {
        disposed.add(own);
        own.dispose();
      }
    }
    this._swaps = [];
    this._target?.removeFromParent();
    this._target = null;
    // Frees the reflector's render target — without this every prop edit (which
    // detaches and re-attaches) would leak one full-size target.
    this._node?.dispose?.();
    this._node = null;
  }
}

const clampNumber = (value, min, max, fallback) =>
  (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

/**
 * Points the reflector target's local +Z — the axis `ReflectorNode` reads as
 * the mirror normal — along the named local axis of the surface.
 */
function orientToAxis(object, axis) {
  const half = Math.PI / 2;
  switch (axis) {
    case "+Y": object.rotation.set(-half, 0, 0); break;
    case "-Y": object.rotation.set(half, 0, 0); break;
    case "+X": object.rotation.set(0, half, 0); break;
    case "-X": object.rotation.set(0, -half, 0); break;
    case "-Z": object.rotation.set(Math.PI, 0, 0); break;
    default: object.rotation.set(0, 0, 0); break; // "+Z"
  }
}
