import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { loadTextureAsset } from "../textureAsset.js";
import {
  atlasImagePath,
  findAnimation,
  findRegion,
  frameAt,
  loadAtlasAsset,
  regionUv,
} from "../sprite/atlasAsset.js";
import { buildNineSliceQuad, buildSpriteQuad, spriteSize } from "../sprite/spriteGeometry.js";

const _cameraWorld = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _selfWorld = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();

/**
 * A textured quad in the world, from a sprite atlas or a plain image.
 *
 * Core engine, not part of the Texture Editor module: what the editor authors —
 * atlases, pivots, nine-slice borders, sprite animations — has to be usable by
 * a shipped game whether or not anyone enabled an editor tool.
 *
 * ## A sprite's size comes from its pixels
 *
 * `pixelsPerUnit` is the only scale knob. Two frames of one animation trimmed
 * to different sizes must not change size on screen, and a 64px icon beside a
 * 128px one should be half as big without a per-sprite scale factor to
 * maintain. The same number converts the nine-slice border, so a sprite and its
 * border can never disagree about scale.
 *
 * ## Animation runs on game time
 *
 * `engine.deltaTime`, so bullet time slows a sprite animation and a pause menu
 * freezes it — the same rule the particle sim and the trail follow. Playback
 * position is runtime state (`resetOnStop`), or leaving Play would leave the
 * sprite on whatever frame it happened to reach.
 *
 * ## Billboarding is CPU-side, and that is a real limitation
 *
 * Each sprite owns its mesh, so orienting it toward `engine.camera` costs one
 * quaternion per sprite per frame and needs no custom vertex stage. The
 * limitation is the one every CPU billboard has: with two cameras rendering the
 * same frame, only the active one is faced. For thousands of sprites, or for a
 * correct shadow pass, the particle system is the right tool — this is for the
 * dozens of markers, pickups and 2D actors a scene actually has.
 */
export class SpriteComponent extends Component {
  static type = "sprite";
  static label = "Sprite";
  static tags = ["rendering", "2d"];
  // Playback position only — the authored props are untouched by Play.
  static resetOnStop = true;

  static defaults = {
    atlas: "", // .atlas asset; empty = use `texture` whole
    region: "", // region name inside the atlas
    texture: "", // plain image, when no atlas is used
    animation: "", // animation name inside the atlas
    playOnStart: true,
    speed: 1,
    pixelsPerUnit: 100,
    color: "#ffffff",
    opacity: 1,
    flipX: false,
    flipY: false,
    billboard: "none", // none | full | y
    sliced: false, // use the region's nine-slice border at an authored size
    size: [1, 1], // world units, only when `sliced`
    lit: false,
    blending: "alpha", // alpha | additive
    alphaTest: 0.01,
    castShadow: false,
  };

  static schema = [
    { key: "atlas", label: "Atlas", type: "asset", exts: ["atlas"] },
    { key: "region", label: "Region", type: "string" },
    { key: "texture", label: "Texture", type: "asset", exts: ["png", "jpg", "jpeg", "webp"] },
    { key: "animation", label: "Animation", type: "string" },
    { key: "playOnStart", label: "Play On Start", type: "boolean" },
    { key: "speed", label: "Speed", type: "number", min: 0, step: 0.1 },
    { key: "pixelsPerUnit", label: "Pixels Per Unit", type: "number", min: 1, step: 1 },
    { key: "color", label: "Tint", type: "color" },
    { key: "opacity", label: "Opacity", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "flipX", label: "Flip X", type: "boolean" },
    { key: "flipY", label: "Flip Y", type: "boolean" },
    { key: "billboard", label: "Billboard", type: "select", options: ["none", "full", "y"] },
    { key: "sliced", label: "Nine-slice", type: "boolean" },
    { key: "size", label: "Size", type: "vec2" },
    { key: "lit", label: "Lit", type: "boolean" },
    { key: "blending", label: "Blending", type: "select", options: ["alpha", "additive"] },
    { key: "alphaTest", label: "Alpha Cutoff", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
  ];

  onAttach() {
    this.generation = (this.generation ?? 0) + 1;
    this.atlasDef = null;
    this.texture = null;
    this.time = 0;
    this.playing = false;
    this.currentFrame = null;
    this.currentRegion = null;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(48), 3));
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(32), 2));
    this.geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(48), 3));
    this.geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(54), 1));

    this.mesh = new THREE.Mesh(this.geometry, this.#buildMaterial());
    this.mesh.userData.entityId = this.entity.id;
    // Its vertices are rewritten whenever the frame changes, so it must never
    // be folded into a static batch.
    this.mesh.userData.noBatch = true;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.props.castShadow === true;
    this.mesh.receiveShadow = this.props.lit === true;
    this.entity.object3D.add(this.mesh);

    this.#load();
    this.unsubTick = this.entity.engine?.onUpdate((dt) => this.tick(dt));
  }

  onDetach() {
    this.generation++;
    this.unsubTick?.();
    this.unsubTick = null;
    if (this.mesh) {
      this.entity.object3D.remove(this.mesh);
      this.mesh.material.dispose();
      this.mesh = null;
    }
    this.geometry?.dispose();
    this.geometry = null;
    this.texture?.dispose();
    this.texture = null;
    this.atlasDef = null;
  }

  onDisable() {
    if (this.mesh) this.mesh.visible = false;
  }

  onEnable() {
    if (this.mesh) this.mesh.visible = true;
  }

  onPropChanged(key) {
    if (!this.mesh) return;
    if (key === "atlas" || key === "texture") {
      this.#load();
      return;
    }
    if (key === "lit" || key === "blending" || key === "alphaTest") {
      this.mesh.material.dispose();
      this.mesh.material = this.#buildMaterial();
      this.mesh.receiveShadow = this.props.lit === true;
      return;
    }
    if (key === "castShadow") {
      this.mesh.castShadow = this.props.castShadow === true;
      return;
    }
    if (key === "animation") {
      this.time = 0;
      this.playing = this.props.playOnStart !== false && !!this.props.animation;
    }
    if (key === "color" || key === "opacity") {
      this.#applyTint();
      return;
    }
    this.#refresh();
  }

  #buildMaterial() {
    const Material = this.props.lit ? THREE.MeshStandardNodeMaterial : THREE.MeshBasicNodeMaterial;
    const material = new Material();
    material.transparent = true;
    material.depthWrite = this.props.blending !== "additive";
    material.blending = this.props.blending === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending;
    material.side = THREE.DoubleSide;
    // A cutoff, not a hard alpha test: sprites are antialiased at the edges,
    // and discarding at 0.5 leaves a jagged silhouette. The default only drops
    // fully-transparent texels so they stop writing depth.
    material.alphaTest = Math.max(0, Math.min(1, this.props.alphaTest ?? 0.01));
    material.map = this.texture ?? null;
    this.#applyTint(material);
    return material;
  }

  #applyTint(target = this.mesh?.material) {
    if (!target) return;
    target.color = target.color ?? new THREE.Color();
    target.color.set(this.props.color ?? "#ffffff");
    target.opacity = this.props.opacity ?? 1;
    target.needsUpdate = true;
  }

  async #load() {
    const generation = ++this.generation;
    try {
      let imagePath = this.props.texture;
      if (this.props.atlas) {
        const def = await loadAtlasAsset(this.props.atlas);
        if (generation !== this.generation) return;
        this.atlasDef = def;
        imagePath = atlasImagePath(def, this.props.atlas);
      } else {
        this.atlasDef = null;
      }
      if (!imagePath) {
        this.#refresh();
        return;
      }
      const texture = await loadTextureAsset(imagePath, { colorSpace: THREE.SRGBColorSpace });
      if (generation !== this.generation || !this.mesh) {
        texture.dispose();
        return;
      }
      this.texture?.dispose();
      this.texture = texture;
      this.mesh.material.map = texture;
      this.mesh.material.needsUpdate = true;
      this.playing = this.props.playOnStart !== false && !!this.props.animation;
      this.time = 0;
      this.#refresh();
    } catch (error) {
      console.warn(`Sprite failed to load (${this.props.atlas || this.props.texture}):`, error);
    }
  }

  /** The region the sprite is currently showing, or a whole-image stand-in. */
  #resolveRegion() {
    const def = this.atlasDef;
    const image = this.texture?.image;
    if (!def) {
      const w = image?.width ?? 1;
      const h = image?.height ?? 1;
      return { name: "", rect: [0, 0, w, h], pivot: [0.5, 0.5], border: [0, 0, 0, 0] };
    }
    const name = this.currentFrame || this.props.region;
    return findRegion(def, name) ?? def.regions[0] ?? null;
  }

  #textureSize() {
    const def = this.atlasDef;
    if (def && def.size[0] && def.size[1]) return def.size;
    const image = this.texture?.image;
    return [image?.width ?? 1, image?.height ?? 1];
  }

  /** Rewrites the geometry for the current region. */
  #refresh() {
    if (!this.mesh || !this.geometry) return;
    const region = this.#resolveRegion();
    if (!region) {
      this.mesh.visible = false;
      return;
    }
    // The engine is the single writer of the ENTITY's visibility (the rule LOD
    // groups and occlusion culling both follow); this is the component's own
    // child mesh, toggled only by its own enable/disable.
    this.currentRegion = region;

    const [texW, texH] = this.#textureSize();
    const uv = regionUv({ size: [texW, texH] }, region, { width: texW, height: texH });
    const ppu = this.props.pixelsPerUnit || 100;

    const data = this.props.sliced
      ? buildNineSliceQuad({
          width: Math.max(1e-4, this.props.size?.[0] ?? 1),
          height: Math.max(1e-4, this.props.size?.[1] ?? 1),
          uv,
          region: region.rect,
          border: region.border,
          pixelsPerUnit: ppu,
          pivot: region.pivot,
          flipX: this.props.flipX,
          flipY: this.props.flipY,
          textureSize: [texW, texH],
        })
      : (() => {
          const [w, h] = spriteSize(region.rect, ppu);
          return buildSpriteQuad({
            width: w,
            height: h,
            uv,
            pivot: region.pivot,
            flipX: this.props.flipX,
            flipY: this.props.flipY,
          });
        })();

    this.#writeGeometry(data);
  }

  #writeGeometry({ positions, uvs, indices }) {
    const geometry = this.geometry;
    const position = geometry.getAttribute("position");
    const uvAttr = geometry.getAttribute("uv");
    const normal = geometry.getAttribute("normal");
    const index = geometry.getIndex();

    position.array.set(positions);
    uvAttr.array.set(uvs);
    for (let i = 0; i < positions.length / 3; i++) {
      normal.array[i * 3] = 0;
      normal.array[i * 3 + 1] = 0;
      normal.array[i * 3 + 2] = 1;
    }
    index.array.fill(0);
    index.array.set(indices);

    position.needsUpdate = true;
    uvAttr.needsUpdate = true;
    normal.needsUpdate = true;
    index.needsUpdate = true;
    geometry.setDrawRange(0, indices.length);
    // Written, never computed: the buffers are over-allocated for the
    // nine-slice case, so a computed sphere would measure the stale tail past
    // the live vertices. Same trap the ribbons hit — it presents as "the sprite
    // sometimes disappears".
    const extent = Math.max(...positions.filter((_, i) => i % 3 !== 2).map(Math.abs), 1e-3);
    geometry.boundingSphere = geometry.boundingSphere ?? new THREE.Sphere();
    geometry.boundingSphere.center.set(0, 0, 0);
    geometry.boundingSphere.radius = extent * 1.5;
    geometry.boundingBox = null;
  }

  tick(dt) {
    if (!this.mesh) return;
    const animation = this.atlasDef && this.props.animation
      ? findAnimation(this.atlasDef, this.props.animation)
      : null;

    if (animation && this.playing) {
      this.time += (dt ?? 0) * (this.props.speed ?? 1);
      const frame = frameAt(animation, this.time);
      if (frame !== this.currentFrame) {
        this.currentFrame = frame;
        this.#refresh();
      }
      // A non-looping animation reports done once, at the moment it finishes,
      // rather than every frame it spends holding its last pose.
      if (!animation.loop && this.time * animation.fps >= animation.frames.length && this.playing) {
        this.playing = false;
        this.entity?.emit?.("sprite-animation-end", this.props.animation);
      }
    } else if (!this.currentFrame && this.props.region && this.currentRegion?.name !== this.props.region) {
      this.#refresh();
    }

    this.#billboard();
  }

  #billboard() {
    const mode = this.props.billboard;
    if (mode !== "full" && mode !== "y") {
      // An authored rotation is the sprite's own: never write to it in the
      // default mode, or a sprite laid flat as a ground decal snaps upright.
      return;
    }
    const camera = this.entity.engine?.camera;
    if (!camera) return;
    camera.getWorldPosition(_cameraWorld);
    this.mesh.getWorldPosition(_selfWorld);
    _lookTarget.copy(_cameraWorld);
    // Cylindrical billboarding keeps the sprite upright and only yaws — what a
    // tree, a pickup or a health bar wants. Full billboarding also pitches,
    // which reads as the sprite tipping over as the camera rises.
    if (mode === "y") _lookTarget.y = _selfWorld.y;
    this.mesh.lookAt(_lookTarget);
    // The mesh is a child of the entity, so cancel the parent's rotation.
    this.entity.object3D.getWorldQuaternion(_quaternion);
    this.mesh.quaternion.premultiply(_quaternion.invert());
  }

  // --- script API ---------------------------------------------------------

  /** Plays an animation by name (or restarts the current one). */
  play(name = this.props.animation) {
    if (name !== this.props.animation) this.setProp?.("animation", name);
    this.time = 0;
    this.playing = true;
    this.currentFrame = null;
    this.#refresh();
    return this;
  }

  pause() {
    this.playing = false;
    return this;
  }

  resume() {
    if (this.props.animation) this.playing = true;
    return this;
  }

  /** Stops and returns to the authored still region. */
  stop() {
    this.playing = false;
    this.time = 0;
    this.currentFrame = null;
    this.#refresh();
    return this;
  }

  /** Shows a still region by name — for state-driven sprites with no timeline. */
  setRegion(name) {
    this.playing = false;
    this.currentFrame = null;
    this.setProp?.("region", name);
    this.#refresh();
    return this;
  }

  get isPlaying() {
    return this.playing;
  }

  /** Region name currently on screen — the animation's frame, or the still. */
  get frame() {
    return this.currentFrame || this.props.region || "";
  }

  /** Region names in this sprite's atlas, for UI and debugging. */
  get regionNames() {
    return (this.atlasDef?.regions ?? []).map((r) => r.name);
  }
}
