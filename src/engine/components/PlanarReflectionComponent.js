import * as THREE from "three/webgpu";
import { clamp, float, normalView, positionViewDirection, pow, reflector, vec3 } from "three/tsl";
import { Component } from "./Component.js";

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

    const tint = new THREE.Color(props.tint ?? "#ffffff");
    const intensity = Math.max(0, props.intensity ?? 1);
    for (const mesh of meshes) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
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

  onDetach() {
    for (const entry of this._restore ?? []) {
      entry.material.emissiveNode = entry.emissiveNode;
      if (entry.planarFlag === undefined) delete entry.material.userData.planarReflection;
      else entry.material.userData.planarReflection = entry.planarFlag;
      entry.material.needsUpdate = true;
    }
    this._restore = [];
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
