import * as THREE from "three/webgpu";
import { createGrassMaterial, createGrassUniforms } from "./grassMaterial.js";
import { deriveGrassBaseColor, grassBladeGeometry, grassFieldCost, grassFieldExtremes, grassFieldTexture, grassFrustumWindow, grassFullWindow, grassHexPitch, grassRings, grassViewCorners, packGrassField, sampleGrassField, grassSwardTones } from "./grassField.js";

/**
 * The drawn-grass renderer, owned by whatever wants to draw a sward.
 *
 * It is not a component. `FoliageComponent` holds one for its `grass` species
 * instead of running its scatter pipeline, so grass stays one concept in the
 * editor — a Foliage component — while being drawn the only way a continuous
 * sward can afford to be: a few instanced rings following the camera, with
 * every blade derived in the vertex shader from the world cell it stands in.
 */
export class GrassRenderer {
  constructor(parent, windUniforms) {
    this.group = new THREE.Group();
    this.group.name = "Grass";
    this.group.matrixAutoUpdate = false;
    this.group.matrixWorldAutoUpdate = false;
    parent.add(this.group);
    this.windUniforms = windUniforms;
    this.rings = [];
    this.stats = { blades: 0, triangles: 0, draws: 0 };
    this._field = null; this._fieldTexture = null; this._groundTexture = null;
    this._settings = null;
    this._inverse = new THREE.Matrix4();
    this._ownerScale = 1;
    this._cameraLocal = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._fieldY = null;
  }

  /** Blades, reach and appearance. Rebuilds only when a value that changes the
   * draws or the shader has actually moved. */
  configure(settings) {
    const next = {
      blades: 480000, near: 5, far: 70, density: 1, height: .18, width: .022,
      // ⛔ 09-13 OWNER RECEIPT: overhead/three-quarter shots showed dark
      // swirls and camouflage blobs — a whole clump leaning together exposed
      // dark roots and the dark ground between them, and the shared lean
      // read as directional streaks. Lean magnitude 0.38 → 0.24 (less of the
      // sward tips over in one rest direction) and, in `grassMaterial.js`,
      // `CLUMP_INFLUENCE` 0.4 → 0.2 with the per-blade yaw jitter widened to
      // ±70° so no clump leans as one — the wind swell on top is unchanged.
      heightVariation: .45, lean: .24, groundBlend: .6, style: "natural",
      brightness: .65, occlusion: .65, variation: .2, specular: 0, roughness: 1, sky: 1,
      color: "#3f5a24", tipColor: "#8fa557", dryColor: "#b9ab63",
      castShadow: false, receiveShadow: true, ...settings,
    };
    const structural = ["blades", "near", "far", "width", "height", "style"];
    const rebuild = !this._settings || structural.some(key => this._settings[key] !== next[key]);
    this._settings = next;
    if (rebuild) this._build(); else this._push();
    return next;
  }

  /** The ground to grow on: terrain height, density, height scale, dryness and
   * the landscape's own colour, in the owner's local metre frame.
   *
   * ⛔ THIS USED TO REBUILD EVERY RING'S MATERIAL ON EVERY CALL. A terrain edit
   * calls this once per repaint, and the freeze ledger caught it: 257 node
   * builds — five seconds — from a few sculpt strokes, because a texture's
   * new *pixels* triggered the same full teardown as an actual budget change.
   * Only the SHAPE of the node graph — whether a field or a ground colour
   * exists at all — needs a rebuild; new samples at the same on/off status are
   * just new texture data on the material that already exists. */
  setField(packed) {
    if (packed && (!ArrayBuffer.isView(packed.data) || packed.data.length !== packed.size * packed.size * 4)) {
      throw new TypeError("A packed grass field needs size × size RGBA samples");
    }
    const next = packed ?? null;
    if (this._field === next) return this._field;
    const hadField = !!this._field, hadGround = !!this._field?.ground;
    this._field = next;
    this._fieldY = grassFieldExtremes(next);
    const hasField = !!this._field, hasGround = !!this._field?.ground;
    if (!this.rings.length || hadField !== hasField || hadGround !== hasGround) {
      this._build();
    } else {
      this._syncFieldTextures();
      this._push();
    }
    return this._field;
  }

  /** Write the current field's samples into the textures the materials
   * already reference, in place — never a new texture object, so nothing
   * downstream of it (the node graph, the material, the draw) has to change. */
  _syncFieldTextures() {
    if (!this._field) return;
    const { data, ground, size } = this._field;
    if (this._fieldTexture) { this._fieldTexture.image = { data, width: size, height: size }; this._fieldTexture.needsUpdate = true; }
    if (ground && this._groundTexture) { this._groundTexture.image = { data: ground, width: size, height: size }; this._groundTexture.needsUpdate = true; }
  }

  /** Derive the ground from scattered placements, for a field nobody handed
   * one to. Each placement contributes its height and its own scale; the
   * density is how many landed nearby. */
  setFieldFromPlacements(placements, { extent = 64, resolution = 128, origin = [0, 0], radius = 1.6 } = {}) {
    if (!placements?.length) return this.setField(null);
    const size = Math.max(8, Math.min(512, Math.round(resolution)));
    const half = extent / 2, step = extent / (size - 1);
    const weight = new Float32Array(size * size), height = new Float32Array(size * size), scale = new Float32Array(size * size);
    const spread = Math.max(1, Math.round(radius / step));
    for (const placement of placements) {
      const [x, y, z] = placement.position;
      const column = Math.round((x - origin[0] + half) / step), row = Math.round((z - origin[1] + half) / step);
      for (let dz = -spread; dz <= spread; dz++) for (let dx = -spread; dx <= spread; dx++) {
        const c = column + dx, r = row + dz;
        if (c < 0 || r < 0 || c >= size || r >= size) continue;
        const falloff = Math.max(0, 1 - Math.hypot(dx, dz) / (spread + .5));
        const index = r * size + c;
        weight[index] += falloff; height[index] += y * falloff; scale[index] += (placement.scale ?? 1) * falloff;
      }
    }
    const sample = (x, z) => {
      const column = Math.min(size - 1, Math.max(0, Math.round((x - origin[0] + half) / step)));
      const row = Math.min(size - 1, Math.max(0, Math.round((z - origin[1] + half) / step)));
      const index = row * size + column, mass = weight[index];
      if (mass <= 1e-6) return { height: 0, density: 0, scale: 1, dryness: 0 };
      return { height: height[index] / mass, density: Math.min(1, mass / (spread + 1)), scale: scale[index] / mass, dryness: 0 };
    };
    return this.setField(packGrassField(sample, { extent, resolution: size, origin }));
  }

  get field() { return this._field; }
  sampleField(x, z) { return sampleGrassField(this._field, x, z); }

  _release() {
    for (const ring of this.rings) {
      ring.mesh.removeFromParent();
      ring.mesh.geometry.dispose();
      ring.material.dispose();
    }
    this.rings = [];
    this._fieldTexture?.dispose(); this._fieldTexture = null;
    this._groundTexture?.dispose(); this._groundTexture = null;
  }

  _build() {
    const settings = this._settings;
    if (!settings) return;
    this._release();
    this._fieldTexture = grassFieldTexture(this._field);
    this._groundTexture = grassFieldTexture(this._field, "ground");
    const layout = grassRings({ near: settings.near, far: settings.far, blades: settings.blades });
    for (const ring of layout) {
      // Each ring carries its own uniform block. One shared block cannot serve
      // three draws in a frame: the last write would win for all of them.
      const uniforms = createGrassUniforms();
      const material = createGrassMaterial(uniforms, this.windUniforms,
        { style: settings.style, fieldTexture: this._fieldTexture, groundTexture: this._groundTexture,
          outermost: ring.index === layout.length - 1 });
      // A tuft ring's own blades are wider (`widthScale`) and, for ring 1/2,
      // shorter (`heightScale`, relative to ring 0's own blade height) — a
      // fan covers more ground per instance without a taller or wider blade
      // everywhere.
      const width = settings.width * (ring.widthScale || 1);
      const height = settings.height * (ring.heightScale || 1);
      const geometry = grassBladeGeometry(ring.segments, { width, height, tuft: ring.tuft });
      geometry.instanceCount = ring.instances;
      // Ring 1's fan clusters inside its own cell, at a fraction of the
      // cell's own size — big enough to read as a fan, never wide enough to
      // wander into the neighbour's cell. Ring 2's fuzz fan instead gets a
      // fixed 0.3 m fan width regardless of its (much larger) cell: a hillside
      // silhouette needs a fibrous EDGE, not a fan that grows with distance.
      uniforms.tuftSpread.value = ring.tuft > 1 ? (ring.index === 2 ? .15 : ring.cell * .35) : 0;
      // Ring 0's OWN cell size, pushed to every ring (including ring 0
      // itself) — the ring hand-over lottery hashes at this one fixed scale
      // so every ring agrees exactly which physical blade-sized patch owns a
      // given spot, whatever that ring's own (coarser) lattice is.
      uniforms.cell0.value = layout[0].cell;
      const full = grassFullWindow(ring);
      uniforms.window.value.set(full.column, full.row, full.columns, 0);
      // A fan ring's own tip fades toward the ground colour: a tuft fan
      // leaves real gaps between its members, and without this the ground
      // glimpsed through them is bare soil, not the sward's own tone — a
      // ring of stubble on brown dirt instead of a thinning carpet. Ring 0
      // has no fan (`tuft` = 1) and no gap to speak of, so this is 0 there
      // by construction rather than a hardcoded index check — the fraction
      // grows with how far apart this ring's own fan actually spreads
      // (`tuftSpread`) relative to its own cell, capped at the same 0.5 a
      // ring-1 fan always reached. `grassMaterial.js` ramps this in smoothly
      // from zero at the ring's own inner seam, so nothing about which ring
      // number this is can produce a hard edge at the hand-over.
      const gapReach = ring.cell * .35;
      uniforms.tipGround.value = ring.tuft > 1 && gapReach > 0
        ? Math.min(1, uniforms.tuftSpread.value / gapReach) * .5 : 0;
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), ring.outer * 2);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `Grass ring ${ring.index}`;
      // Every blade is placed in the shader, so nothing about this mesh's own
      // bounds describes where its geometry lands. Culling happens per camera
      // in `_cull` instead, on the ring's grid.
      mesh.frustumCulled = false;
      mesh.castShadow = !!settings.castShadow;
      mesh.receiveShadow = !!settings.receiveShadow;
      mesh.userData.grassRing = ring;
      mesh.userData.foliageOwned = true;
      // GI policy (2026-09-13): every blade is placed in the vertex shader —
      // GI has no per-blade instance to seat and no useful triangle to bake
      // (this mesh's own geometry is one drawArraysInstanced call, not the
      // field it covers). Never seat/bake/count this in GI; the grass surface
      // still receives GI through its own material's field lookup.
      mesh.userData.giTrace = "none";
      mesh.userData.giMobility = "static";
      const record = { ...ring, uniforms, material, mesh };
      // Runs for every camera that draws the ring — the view, a shadow map, a
      // reflection — so each pass issues only the blades in its own frustum.
      mesh.onBeforeRender = (_renderer, _scene, camera) => this._cull(record, camera);
      this.group.add(mesh);
      this.rings.push(record);
    }
    const cost = grassFieldCost(layout);
    this.stats = { blades: cost.instances, triangles: cost.triangles, draws: cost.draws };
    this._push();
  }

  _push() {
    const settings = this._settings;
    if (!settings) return;
    const density = Math.max(0, Math.min(1, Number(settings.density) || 0));
    for (const ring of this.rings) {
      const uniforms = ring.uniforms;
      uniforms.ring.value.set(ring.size, ring.columns, ring.cell, ring.hole);
      // ⛔ 09-13 HEX LATTICE FOOTPRINT FIX: rows ≠ columns any more (a hex
      // lattice's row pitch is shorter than its column spacing, so the same
      // physical `size` needs more rows) — pushed as its own uniform.
      uniforms.rows.value = ring.rows ?? ring.columns;
      uniforms.blade.value.set(settings.width * (ring.widthScale || 1), settings.height * (ring.heightScale || 1),
        settings.lean, settings.heightVariation);
      uniforms.density.value = density;
      uniforms.fade.value.set(Math.max(1, settings.far * .82), Math.max(2, settings.far));
      // ⭐ THE ROOT IS DERIVED, NEVER AUTHORED. An author's `color` prop
      // (barkColor) used to feed the root directly; a comb of one flat green
      // root under a same-toned tip is what "no gradient" looked like. The
      // World only ever authors leaf/dry TIP tones now — the root always
      // follows from the tip, darker and greener, so a gradient exists even
      // when nobody paints a separate root colour.
      // Tip/dry clamps and the derived root live in `grassSwardTones` (grassField.js),
      // shared with every ground painter that has to meet this sward.
      const tones = grassSwardTones(settings.tipColor, settings.dryColor);
      uniforms.tip.value.copy(tones.tip);
      // ⛔ 09-13: TIP SATURATION CLAMPED. A picker-chosen tip could land at
      // full saturation and near-full lightness — a mass of grass at that
      // extreme reads as a solid poster colour, not fibre, and it was the
      // "over-saturated yellow tips" half of the owner's verdict. Capping in
      // HSL rather than on the raw RGB keeps hue exactly where the author put
      // it; only how vivid/bright the tip may get is bounded.
      // ⛔⛔ 09-14 THE CLAMP RAN IN LINEAR SPACE. `getHSL`/`setHSL` default to
      // three's working space (linear sRGB), where a picker green like
      // #617e11 has saturation 0.94 — the 0.6 cap then lifted its blue ~6×
      // (0.006 → 0.037) and the sward came out olive-grey before any light
      // touched it. Under sun 20 the lit tip measured saturation 0.55 against
      // 0.86 for the same clamp in sRGB; that washed-out tip is what "pale and
      // uncontrollable in hard light" was. The limits were authored as picker
      // values, so they are applied in the picker's own space.
      // 09-13 "pale white no matter what colors I choose": a 0.62-lightness tip under a
      // real sun clips to white through the tone map. Grass albedo is DARK (0.1-0.25
      // luminance in the field); hold the tip at 0.48 and let the sun make it bright.
      uniforms.base.value.copy(tones.base);
      // The dry tone may go warmer, never lighter than the tip: pale straw over green
      // tips was what bleached the sward.
      uniforms.dry.value.copy(tones.dry);
      const blend = Number(settings.groundBlend);
      uniforms.blend.value = Number.isFinite(blend) ? Math.max(0, Math.min(1, blend)) : .6;
      const number = (value, fallback, hi = 1) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(hi, Number(value))) : fallback;
      uniforms.tone.value.set(number(settings.brightness, .65, 2), number(settings.occlusion, .7),
        number(settings.variation, .35), number(settings.sky, 1, 2));
      // Roughness and the specular rim are plain material properties, so an
      // author can take the glint off a sward without recompiling its shader.
      ring.material.roughness = number(settings.roughness, .95);
      ring.material.specularIntensity = number(settings.specular, .12);
      ring.material.envMapIntensity = number(settings.sky, 1, 2);
      if (Array.isArray(settings.sunDirection) && settings.sunDirection.length === 3) {
        uniforms.sun.value.fromArray(settings.sunDirection);
      }
      if (this._field) uniforms.field.value.set(this._field.origin[0], this._field.origin[1], this._field.extent, 1 / this._field.size);
      ring.mesh.castShadow = !!settings.castShadow;
      ring.mesh.receiveShadow = !!settings.receiveShadow;
      // Per-cascade caster culling (csmShadowNode.js): blades stand within `far`
      // of the camera; their tallest possible blade decides reach and the texel floor.
      ring.mesh.userData.shadowCasterRange = [0, Math.max(2, settings.far)];
      ring.mesh.userData.shadowCasterHeight = settings.height * (ring.heightScale || 1) * 1.3
        * (1 + Math.max(0, Number(settings.heightVariation) || 0)) * Math.max(this._fieldY?.[2] ?? 1, .01);
    }
  }

  /**
   * Move each ring's window to the camera.
   *
   * Every ring snaps to a whole number of ITS OWN cell. The blades are hashed
   * from the world cell they stand in, so a ring that shifts by one of its own
   * cells hands each cell back to itself; a fractional offset would re-derive
   * them every frame and the field would swim.
   *
   * ⛔ HEX LATTICE: x snaps to whole COLUMNS (`cell`), z snaps to whole ROWS
   * (the hex row pitch, `cell·√3/2`) — the two axes are no longer the same
   * spacing.
   */
  followCamera(x, z) {
    const snapped = [];
    for (const ring of this.rings) {
      const cell = ring.cell, pitch = grassHexPitch(cell);
      const origin = [(Math.round(x / cell) * cell) || 0, (Math.round(z / pitch) * pitch) || 0];
      ring.uniforms.origin.value.set(origin[0], origin[1]);
      snapped.push(origin);
    }
    return snapped;
  }

  /** Follow the camera in the owner's frame. Blades are placed in that frame,
   * so every distance in the shader has to be measured in it too. */
  update(object3D, camera, sunDirection = null) {
    if (!this.rings.length || !camera) return;
    // The atmosphere publishes the live sun on the engine (`engine.sunDirection`);
    // the blade translucency term reads it every frame.
    if (sunDirection && sunDirection.length === 3) for (const ring of this.rings) ring.uniforms.sun.value.fromArray(sunDirection);
    object3D?.updateWorldMatrix?.(true, false);
    if (object3D) this._inverse.copy(object3D.matrixWorld).invert(); else this._inverse.identity();
    this._ownerScale = object3D ? object3D.matrixWorld.getMaxScaleOnAxis() || 1 : 1;
    // ⛔ THE CAMERA'S WORLD POSITION, NEVER `camera.position`.
    // In the editor the viewport camera sits at the root, so the two are the
    // same and reading the local one looks correct. In play the camera hangs
    // off a rig, so `position` is a metre or so of local offset: the rings then
    // centre near the origin instead of on the player, who is left standing in
    // the outermost ring — one triangle a blade, a fraction of the density and
    // fully flattened normals. "In playmode, grass looks different, more
    // sparse, single triangle, and a different color" is all one bug.
    camera.updateWorldMatrix?.(true, false);
    camera.getWorldPosition(this._cameraLocal).applyMatrix4(this._inverse);
    this.followCamera(this._cameraLocal.x, this._cameraLocal.z);
    for (const ring of this.rings) ring.uniforms.camera.value.copy(this._cameraLocal);
  }

  /**
   * Narrow one ring's draw to the part of its grid `camera` can see.
   *
   * ⛔ THE RINGS ARE SQUARES AROUND THE CAMERA. Without this every blade behind
   * the lens, and every blade outside a narrow view, ran the whole vertex
   * shader only to be clipped. The window keeps the draw's instance count equal
   * to the slots in view; the shader offsets the index by the window's corner.
   * The rings' ORIGIN still follows the main camera (`update`) — only which
   * slots are issued depends on the camera drawing them.
   */
  _cull(ring, camera) {
    const view = camera && !camera.isArrayCamera && this._settings ? this._visibleWindow(ring, camera) : null;
    const span = view ?? grassFullWindow(ring);
    ring.uniforms.window.value.set(span.column, span.row, Math.max(1, span.columns), 0);
    ring.mesh.geometry.instanceCount = span.columns * span.rows;
    return span;
  }

  _visibleWindow(ring, camera) {
    const settings = this._settings;
    // The tallest a blade of this ring can stand: the field's largest height
    // scale, the clump's lift (≤ 1.3) and the per-blade variation. It pads
    // both the slab and the ground window, since lean and wind move a tip
    // sideways by at most its height.
    const [low, high, scale] = this._fieldY ?? [0, 0, 1];
    const bladeTop = settings.height * (ring.heightScale || 1) * Math.max(scale, .01) * 1.3
      * (1 + Math.max(0, Number(settings.heightVariation) || 0));
    const minY = low - .5, maxY = high + bladeTop + .5;
    const margin = ring.cell * 1.5 + (ring.uniforms.tuftSpread.value || 0) + bladeTop;
    const origin = ring.uniforms.origin.value;
    const halfX = ring.columns * ring.cell / 2 + margin;
    const halfZ = (ring.rows ?? ring.columns) * grassHexPitch(ring.cell) / 2 + margin;
    // Nothing deeper than the ring's farthest corner can hold one of its
    // blades, so the view volume stops there instead of at the camera's far
    // plane. Depth never exceeds distance; the owner's scale converts it.
    this._eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this._inverse);
    const dx = Math.abs(this._eye.x - origin.x) + halfX, dz = Math.abs(this._eye.z - origin.y) + halfZ;
    const dy = Math.max(Math.abs(this._eye.y - minY), Math.abs(this._eye.y - maxY));
    const corners = grassViewCorners(camera, this._inverse, Math.hypot(dx, dy, dz) * this._ownerScale);
    if (!corners) return null;
    return grassFrustumWindow(ring, [origin.x, origin.y], corners, { minY, maxY, margin });
  }

  setVisible(visible) { this.group.visible = !!visible; }

  dispose() {
    this._release();
    this.group.removeFromParent();
    this._field = null; this._settings = null;
  }
}
