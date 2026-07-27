import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  deltaTime,
  float,
  hash,
  instanceIndex,
  instancedArray,
  int,
  cross,
  dot,
  normalize,
  cameraPosition,
  modelWorldMatrixInverse,
  positionLocal,
  smoothstep,
  time,
  texture as tslTexture,
  uniform,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import { Component } from "./Component.js";
import {
  compileParticleGraph,
  legacyPropsToGraph,
  particleGraphSignature,
  DEFAULT_PARTICLE_GRAPH,
} from "../particleGraph.js";
import { ParticleColliderField } from "../particleColliders.js";
import { registerGiEmitter } from "../giEmitters.js";

const MAX_CAPACITY = 200_000;
const GRID_SLOTS = 4;
const MAX_LIGHTS = 8;
const LIGHT_SAMPLES = 128; // particles read back per frame to place the lights

const unitQuad = new THREE.PlaneGeometry(1, 1);

// Scratch reused by the GI-emitter aggregation (runs per readback, not per frame).
const _giCenter = new THREE.Vector3();
const _giScale = new THREE.Vector3();

// Built-in particle geometries, shared across all systems (never disposed).
const builtinGeometryCache = new Map();
function builtinGeometry(type) {
  if (!type || type === "quad") return null;
  let geo = builtinGeometryCache.get(type);
  if (geo) return geo;
  if (type === "plane") geo = new THREE.PlaneGeometry(1, 1);
  else if (type === "box") geo = new THREE.BoxGeometry(1, 1, 1);
  else if (type === "sphere") geo = new THREE.SphereGeometry(0.5, 12, 8);
  else if (type === "cylinder") geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  else if (type === "cone") geo = new THREE.ConeGeometry(0.5, 1, 12);
  else if (type === "torus") geo = new THREE.TorusGeometry(0.5, 0.2, 8, 16);
  else return null;
  builtinGeometryCache.set(type, geo);
  return geo;
}

/** Builds a per-instance cell hash from an integer grid coordinate (xyz). */
function hashCell(coord) {
  const xi = int(coord.x);
  const yi = int(coord.y);
  const zi = int(coord.z);
  return xi.mul(73856093).bitXor(yi.mul(19349663)).bitXor(zi.mul(83492791));
}

/**
 * Node-graph GPU particle system. The graph (props.graph) compiles to TSL:
 * an init compute pass, a per-frame update pass (age/respawn/forces/
 * integration/collision), and a render material whose size/color/opacity are
 * graph expressions evaluated per instance. Per-particle state lives in
 * storage buffers; everything simulates on the GPU, in the editor too.
 *
 * A graph can hold several System nodes — each becomes one independent
 * "subsystem" here (own buffers, own compute passes, own render object),
 * all parented under the same entity. That's how one component can run
 * multiple emitters (e.g. a flame body plus a layer of embers) at once.
 *
 * Value-only graph edits (slider drags) never rebuild: hot params compile
 * to uniforms and `onPropChanged` routes structure-preserving edits through
 * `compiled.updateParams`. Only structural edits (nodes/edges/booleans/
 * selects/assets/capacity) pay for a recompile.
 *
 * Old scenes with pre-graph props (count/shape/startColor/…) are converted
 * to an equivalent graph on attach.
 */
export class ParticleComponent extends Component {
  static type = "particles";
  static label = "Particles";
  static defaults = { graph: null };
  // The node editor (Window → Particles) is the real UI; nothing to inspect here.
  static schema = [];

  onAttach() {
    this.generation = (this.generation ?? 0) + 1;
    this.subsystems = [];
    this.compiled = null;
    this.graphSignature = null;
    let graph = this.props.graph;
    if (!graph && this.props.startColor !== undefined) graph = legacyPropsToGraph(this.props);
    if (!graph) graph = DEFAULT_PARTICLE_GRAPH;
    this.#build(graph, this.generation);
  }

  async #build(graph, generation) {
    let compiled;
    try {
      compiled = await compileParticleGraph(graph, { entity: this.entity });
    } catch (err) {
      console.error(`Particle graph failed to compile: ${err.message ?? err}`);
      return;
    }
    if (generation !== this.generation) return; // detached/rebuilt meanwhile

    this.compiled = compiled;
    this.graphSignature = particleGraphSignature(graph);

    for (const sys of compiled.systems) {
      const subsystem = this.#buildSubsystem(sys);
      if (subsystem) this.subsystems.push(subsystem);
    }

    this.unsubUpdate = this.entity.engine.onUpdate(() => this.#tick());
  }

  #buildSubsystem(sys) {
    const s = sys.system;
    const u = sys.u;
    const capacity = Math.min(MAX_CAPACITY, Math.max(1, Math.floor(s.capacity)));

    const positions = instancedArray(capacity, "vec3");
    const velocities = instancedArray(capacity, "vec3");
    const ages = instancedArray(capacity, "float");

    // Per-particle lifetime, stable per index in every context.
    const lifetimeOf = (indexFloat) =>
      u.lifetime.mul(hash(indexFloat.add(555)).mul(u.lifetimeJitter).oneMinus()).max(0.05);

    // A context bundles what attribute nodes resolve to in one evaluation
    // domain. `rand(k)` in spawn contexts is salted per respawn cycle.
    const makeComputeCtx = (key, salt) => {
      const index = instanceIndex.toFloat();
      const age = ages.element(instanceIndex);
      const life = lifetimeOf(index);
      return {
        key,
        cache: new Map(),
        index,
        position: positions.element(instanceIndex),
        velocity: velocities.element(instanceIndex),
        age,
        life01: age.div(life).clamp(0, 1),
        rand: (k) => hash(index.add(salt).add(k * 1013)),
      };
    };

    const initCompute = Fn(() => {
      const ctx = makeComputeCtx("spawn", float(0));
      positions.element(instanceIndex).assign(sys.spawnPosition(ctx));
      velocities.element(instanceIndex).assign(sys.spawnVelocity(ctx));
      // Negative age = not born yet. Staggering births across one lifetime
      // makes emission ramp in particle-by-particle instead of the whole
      // capacity erupting from the emitter at once on build/restart.
      ages.element(instanceIndex).assign(hash(instanceIndex).mul(u.lifetime).negate());
    })().compute(capacity);

    // Scene collision: reuse the engine-wide collider field, lazily created.
    let colliderField = null;
    let collisionMatrices = null;
    if (s.sceneCollision) {
      colliderField = (this.entity.engine.particleColliders ??= new ParticleColliderField(this.entity.engine));
      colliderField.addUser();
      // Particles simulate in entity-local space; colliders live in world
      // space. These uniforms bridge the two per frame (see #tick).
      collisionMatrices = {
        world: uniform(new THREE.Matrix4()),
        inverse: uniform(new THREE.Matrix4()),
      };
    }

    const updateCompute = Fn(() => {
      const index = instanceIndex.toFloat();
      const position = positions.element(instanceIndex);
      const velocity = velocities.element(instanceIndex);
      const age = ages.element(instanceIndex);
      const life = lifetimeOf(index);

      age.addAssign(deltaTime);
      // Respawn on death — or on birth (age just crossed 0), so a not-yet-born
      // particle that drifted while hidden snaps back to its spawn point.
      const justBorn = age.greaterThanEqual(0).and(age.sub(deltaTime).lessThan(0));
      If(age.greaterThanEqual(life).or(justBorn), () => {
        // time-derived salt → fresh randoms every respawn cycle
        const ctx = makeComputeCtx("spawn", time.mul(1e3));
        age.assign(0);
        position.assign(sys.spawnPosition(ctx));
        velocity.assign(sys.spawnVelocity(ctx));
      });

      if (sys.force) {
        const ctx = makeComputeCtx("update", float(77.7));
        velocity.addAssign(sys.force(ctx).mul(deltaTime));
      }
      position.addAssign(velocity.mul(deltaTime));

      if (s.floor === "bounce") {
        If(position.y.lessThan(u.floorY).and(velocity.y.lessThan(0)), () => {
          position.assign(vec3(position.x, u.floorY.mul(2).sub(position.y), position.z));
          velocity.assign(vec3(velocity.x.mul(0.85), velocity.y.negate().mul(u.bounce), velocity.z.mul(0.85)));
        });
      } else if (s.floor === "kill") {
        If(position.y.lessThan(u.floorY), () => age.assign(life));
      }

      if (colliderField) {
        const pr = u.collisionRadius;
        // Colliders are world-space: move the particle into world space,
        // resolve there, then transform the result back to entity space.
        const wPos = collisionMatrices.world.mul(vec4(position, 1)).xyz.toVar();
        const wVel = collisionMatrices.world.mul(vec4(velocity, 0)).xyz.toVar();

        const resolve = (n, push) => {
          wPos.addAssign(n.mul(push));
          const vn = dot(wVel, n);
          If(vn.lessThan(0), () => {
            wVel.subAssign(n.mul(vn).mul(u.bounceFactor));
            wVel.mulAssign(u.frictionFactor);
          });
        };

        Loop({ start: 0, end: colliderField.countUniform }, ({ i }) => {
          const base = i.mul(4);
          const a = colliderField.buffer.element(base);
          const b = colliderField.buffer.element(base.add(1));
          const c = colliderField.buffer.element(base.add(2));
          const d = colliderField.buffer.element(base.add(3));
          const center = a.yzw;
          const isBox = a.x.lessThan(0.5);

          If(isBox, () => {
            const right = b.xyz;
            const up = c.xyz;
            const fwd = d.xyz;
            const halfExtent = vec3(b.w, c.w, d.w);
            const rel = wPos.sub(center);
            const local = vec3(dot(rel, right), dot(rel, up), dot(rel, fwd)).toVar();
            const clamped = local.clamp(halfExtent.negate(), halfExtent);
            const closest = center.add(right.mul(clamped.x)).add(up.mul(clamped.y)).add(fwd.mul(clamped.z));
            const diff = wPos.sub(closest).toVar();
            const dist = diff.length().toVar();
            If(dist.greaterThan(1e-5), () => {
              If(dist.lessThan(pr), () => resolve(diff.div(dist), pr.sub(dist)));
            }).Else(() => {
              // Center is inside the box: push out through the nearest face
              // (the old code silently ignored this case, so particles that
              // tunneled in stayed trapped inside).
              const pen = halfExtent.sub(local.abs()).toVar();
              If(pen.x.lessThanEqual(pen.y).and(pen.x.lessThanEqual(pen.z)), () => {
                resolve(right.mul(local.x.sign()), pen.x.add(pr));
              }).ElseIf(pen.y.lessThanEqual(pen.z), () => {
                resolve(up.mul(local.y.sign()), pen.y.add(pr));
              }).Else(() => {
                resolve(fwd.mul(local.z.sign()), pen.z.add(pr));
              });
            });
          }).Else(() => {
            const colliderRadius = b.w;
            const diff = wPos.sub(center);
            const dist = diff.length().toVar();
            const targetDist = pr.add(colliderRadius);
            If(dist.greaterThan(1e-5).and(dist.lessThan(targetDist)), () =>
              resolve(diff.div(dist), targetDist.sub(dist)),
            );
          });
        });

        position.assign(collisionMatrices.inverse.mul(vec4(wPos, 1)).xyz);
        velocity.assign(collisionMatrices.inverse.mul(vec4(wVel, 0)).xyz);
      }
    })().compute(capacity);

    // Particle-particle collision: a spatial hash grid rebuilt every frame.
    // Approximate by design (fixed slots per cell, last-writer-wins on hash
    // collisions) so it needs no atomics — good enough for visual clumping
    // and pushback, not an exhaustive physics solve.
    let clearCompute = null;
    let scatterCompute = null;
    let resolveCompute = null;
    if (s.selfCollision) {
      const cellCount = capacity;
      const cellSlots = instancedArray(cellCount * GRID_SLOTS, "int");
      const cellCoordOf = (pos) => pos.mul(u.invCellSize).floor();

      clearCompute = Fn(() => {
        cellSlots.element(instanceIndex).assign(int(-1));
      })().compute(cellCount * GRID_SLOTS);

      scatterCompute = Fn(() => {
        const pos = positions.element(instanceIndex);
        const h = hashCell(cellCoordOf(pos)).abs().mod(cellCount);
        const slot = hash(instanceIndex.toFloat().add(31.7)).mul(GRID_SLOTS).floor().mod(GRID_SLOTS).toInt();
        cellSlots.element(h.mul(GRID_SLOTS).add(slot)).assign(int(instanceIndex));
      })().compute(capacity);

      resolveCompute = Fn(() => {
        const pos = positions.element(instanceIndex).toVar();
        const vel = velocities.element(instanceIndex).toVar();
        const coord = cellCoordOf(pos);
        const radius = u.collisionRadius;
        const elasticity = u.collisionElasticity;
        const selfIndex = int(instanceIndex);

        Loop({ start: -1, end: 2 }, ({ i: dx }) => {
          Loop({ start: -1, end: 2 }, ({ i: dy }) => {
            Loop({ start: -1, end: 2 }, ({ i: dz }) => {
              const neighborCoord = coord.add(vec3(dx.toFloat(), dy.toFloat(), dz.toFloat()));
              const h = hashCell(neighborCoord).abs().mod(cellCount);
              Loop({ start: 0, end: GRID_SLOTS }, ({ i: slot }) => {
                const otherIdx = cellSlots.element(h.mul(GRID_SLOTS).add(slot));
                If(otherIdx.greaterThanEqual(0).and(otherIdx.notEqual(selfIndex)), () => {
                  const otherPos = positions.element(otherIdx.toUint());
                  const delta = pos.sub(otherPos);
                  const dist = delta.length();
                  const minDist = radius.mul(2);
                  If(dist.greaterThan(1e-5).and(dist.lessThan(minDist)), () => {
                    const n = delta.div(dist);
                    const overlap = minDist.sub(dist);
                    pos.addAssign(n.mul(overlap).mul(0.5));
                    vel.addAssign(n.mul(overlap).mul(elasticity));
                  });
                });
              });
            });
          });
        });

        positions.element(instanceIndex).assign(pos);
        velocities.element(instanceIndex).assign(vel);
      })().compute(capacity);
    }

    // Render context: same expressions, but reading instanced attributes.
    const renderIndex = instanceIndex.toFloat();
    const renderAge = ages.toAttribute();
    const renderLife = lifetimeOf(renderIndex);
    const renderCtx = {
      key: "render",
      cache: new Map(),
      index: renderIndex,
      position: positions.toAttribute(),
      velocity: velocities.toAttribute(),
      age: renderAge,
      life01: renderAge.div(renderLife).clamp(0, 1),
      rand: (k) => hash(renderIndex.add(k * 1013)),
    };

    const shapedGeometry = builtinGeometry(s.geometryType);
    const advanced = !!(s.castShadow || s.receiveShadow || s.geometry || s.lit || shapedGeometry);
    const { object, material } = advanced
      ? this.#buildInstancedRenderer(sys, s, capacity, renderCtx, shapedGeometry)
      : this.#buildSpriteRenderer(sys, s, capacity, renderCtx);

    object.userData.entityId = this.entity.id;
    this.entity.object3D.add(object);
    object.visible = this._enabled;

    // Optional lighting integration: a handful of real point lights follow
    // clusters of live particles (see #buildLightRig / #updateLights).
    const lightRig = this.#buildLightRig(sys, s, capacity, { positions, velocities, ages }, lifetimeOf);
    // Publish the cloud to the GI module as a dynamic emitter. The provider is
    // pulled once per frame by GISystem#refreshEmitterSlots and returns null
    // until the first cluster readback lands, so an unbuilt or empty system
    // simply parks its slot at radius 0.
    let unregisterGiEmitter = null;
    if (lightRig?.giEmission) {
      unregisterGiEmitter = registerGiEmitter(this.entity.engine, () => lightRig.giShape);
    }

    return {
      sysProps: s,
      positions,
      velocities,
      ages,
      initCompute,
      updateCompute,
      clearCompute,
      scatterCompute,
      resolveCompute,
      object,
      material,
      colliderField,
      collisionMatrices,
      lightRig,
      unregisterGiEmitter,
      initialized: false,
    };
  }

  #buildSpriteRenderer(sys, s, capacity, renderCtx) {
    const material = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: s.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    material.positionNode = renderCtx.position;

    const sizeJitter = hash(renderCtx.index.add(999)).mul(sys.u.sizeJitter).oneMinus();
    material.scaleNode = sys.size(renderCtx).mul(sizeJitter).max(0);
    this.#applyColorAndOpacity(material, sys, renderCtx);

    const sprite = new THREE.Sprite(material);
    sprite.count = capacity;
    sprite.frustumCulled = false;
    return { object: sprite, material };
  }

  /**
   * Shadow-casting / custom-geometry / lit particles render as a real
   * InstancedMesh. The default quad is billboarded per-instance (in object
   * space, via modelWorldMatrixInverse so it works regardless of the
   * entity's own transform); built-in shapes and custom .glb geometry skip
   * billboarding and optionally orient to face the particle's velocity.
   */
  #buildInstancedRenderer(sys, s, capacity, renderCtx, shapedGeometry) {
    const geometry = sys.customGeometry ?? shapedGeometry ?? unitQuad;
    const billboard = !sys.customGeometry && !shapedGeometry;
    // receiveShadow needs a light-model material — basic is unlit, so a
    // receiving particle silently upgrades to the standard material.
    const lit = !!(s.lit || s.receiveShadow);
    const MaterialClass = lit ? THREE.MeshStandardNodeMaterial : THREE.MeshBasicNodeMaterial;
    const material = new MaterialClass({
      transparent: true,
      depthWrite: false,
      blending: s.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    // Default shadow rendering culls front faces; a single-sided billboard
    // quad would never reach the shadow map. Render both sides there.
    material.shadowSide = THREE.DoubleSide;

    const sizeJitter = hash(renderCtx.index.add(999)).mul(sys.u.sizeJitter).oneMinus();
    const size = sys.size(renderCtx).mul(sizeJitter).max(0);
    const center = renderCtx.position;

    let localOffset;
    if (!billboard) {
      // Real 3D geometry: no billboarding. Optionally align +Y to velocity.
      if (s.faceVelocity) {
        const dir = normalize(renderCtx.velocity.add(vec3(1e-5, 0, 0)));
        const up = vec3(0, 1, 0);
        const right = normalize(cross(up, dir));
        const trueUp = cross(dir, right);
        localOffset = right.mul(positionLocal.x).add(dir.mul(positionLocal.y)).add(trueUp.mul(positionLocal.z)).mul(size);
      } else {
        localOffset = positionLocal.mul(size);
      }
    } else {
      // Default quad: billboard toward the camera, computed in object space
      // (via modelWorldMatrixInverse) so it's correct under any entity
      // transform without needing camera-space vertex trickery.
      const cameraLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
      const toCam = normalize(cameraLocal.sub(center).add(vec3(0, 1e-5, 0)));
      const worldUp = vec3(0, 1, 0);
      const right = normalize(cross(worldUp, toCam));
      const up = cross(toCam, right);
      localOffset = right.mul(positionLocal.x).add(up.mul(positionLocal.y)).mul(size);
    }

    material.positionNode = center.add(localOffset);
    // TSL's shadow pass uses raw geometry positions by default — it does
    // NOT pick up `positionNode` overrides, so billboarding / per-particle
    // offsets would collapse to a pile at the entity origin and a
    // directional light's tight orthographic frustum would simply miss the
    // result. `castShadowPositionNode` is the supported hook for projecting
    // a transformed vertex into the shadow map; mirror `positionNode` here
    // so the same per-instance quad is rasterized into the shadow buffer.
    if (s.castShadow) material.castShadowPositionNode = center.add(localOffset);
    this.#applyColorAndOpacity(material, sys, renderCtx);

    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.frustumCulled = false;
    mesh.castShadow = !!s.castShadow;
    mesh.receiveShadow = !!s.receiveShadow;
    fillIdentityInstanceMatrix(mesh);
    return { object: mesh, material };
  }

  #applyColorAndOpacity(material, sys, renderCtx) {
    let rgb = sys.color(renderCtx);
    let mask;
    if (sys.spriteTexture) {
      const texel = tslTexture(sys.spriteTexture, uv());
      rgb = rgb.mul(texel.rgb);
      mask = texel.a;
    } else {
      mask = smoothstep(0.5, 0.15, uv().sub(0.5).length());
    }
    const alpha = sys.opacity ? sys.opacity(renderCtx) : renderCtx.life01.oneMinus();
    // Unborn particles (negative age, see initCompute) are fully hidden.
    const born = renderCtx.age.greaterThanEqual(0).toFloat();
    const alphaMask = alpha.clamp(0, 1).mul(mask).mul(born);
    if (material.isMeshStandardNodeMaterial) {
      // Lit path: color goes through the light model (no full-strength
      // emissive — that would wash out any received shadow).
      material.colorNode = vec4(rgb, 1);
      material.opacityNode = alphaMask;
    } else {
      material.colorNode = vec4(rgb, alphaMask);
    }
    // Shadow pass: discard the transparent parts so cast shadows take the
    // sprite/soft-circle shape instead of the full quad.
    material.maskShadowNode = alphaMask.greaterThan(0.35);
  }

  /**
   * Builds the particle→light bridge for one subsystem, when its System
   * node asks for lights (lightCount > 0):
   *
   *   1. a tiny compute pass samples LIGHT_SAMPLES particles (position,
   *      graph color, alpha) into a small buffer,
   *   2. #updateLights reads that buffer back asynchronously and runs one
   *      k-means relaxation per frame (seeds persist across frames), and
   *   3. each cluster drives one THREE.PointLight parented to the entity.
   *
   * The readback is ~4 KB and throttled to one in flight, so the cost is a
   * couple frames of latency on the lights — invisible in practice.
   */
  #buildLightRig(sys, s, capacity, buffers, lifetimeOf) {
    const count = Math.min(MAX_LIGHTS, Math.max(0, Math.floor(s.lightCount ?? 0)));
    const giEmission = !!s.giEmission;
    // GI emission needs the same sampled positions/colours as the point-light
    // clusters, so the rig is built for either feature. With `lightCount: 0`
    // and GI emission on, the sampling runs but no PointLight is created —
    // which is the point: the light comes from the radiance field, not from a
    // stand-in light.
    if (!count && !giEmission) return null;

    const samples = Math.min(LIGHT_SAMPLES, capacity);
    const sampleBuffer = instancedArray(samples * 2, "vec4");
    const stride = Math.max(1, Math.floor(capacity / samples));

    const sampleCompute = Fn(() => {
      const idx = instanceIndex.mul(stride).mod(capacity);
      const indexF = idx.toFloat();
      const age = buffers.ages.element(idx);
      const life = lifetimeOf(indexF);
      const ctx = {
        key: "lightSample",
        cache: new Map(),
        index: indexF,
        position: buffers.positions.element(idx),
        velocity: buffers.velocities.element(idx),
        age,
        life01: age.div(life).clamp(0, 1),
        rand: (k) => hash(indexF.add(k * 1013)),
      };
      const rgb = vec3(sys.color(ctx));
      const alpha = (sys.opacity ? sys.opacity(ctx) : ctx.life01.oneMinus()).clamp(0, 1);
      sampleBuffer.element(instanceIndex.mul(2)).assign(vec4(ctx.position, alpha));
      sampleBuffer.element(instanceIndex.mul(2).add(1)).assign(vec4(rgb, 0));
    })().compute(samples);

    const lights = [];
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, s.lightDistance ?? 6, 2);
      light.userData.engineOwned = true;
      light.raycast = () => {};
      // Seed positions spread out so clusters don't all collapse into one.
      light.position.set(Math.cos((i / count) * Math.PI * 2) * 0.5, 0.5, Math.sin((i / count) * Math.PI * 2) * 0.5);
      this.entity.object3D.add(light);
      lights.push(light);
    }

    return {
      count,
      samples,
      sampleBuffer,
      sampleCompute,
      lights,
      readPending: false,
      giEmission,
      giStrength: Math.max(0, s.giEmissionStrength ?? 1),
      // Published to the GI module's per-frame emitter slot. Null until the
      // first readback lands, and back to null whenever the cloud has no live
      // particles — a slot showing a stale sphere would keep lighting the room
      // after the effect ended.
      giShape: null,
      // scratch accumulators reused every frame (no per-frame allocation)
      accum: new Float32Array(Math.max(1, count) * 7), // x,y,z,r,g,b,weight per cluster
    };
  }

  /** One async readback + one k-means relaxation; updates the point lights. */
  #updateLights(sub, renderer) {
    const rig = sub.lightRig;
    if (rig.readPending) return;
    rig.readPending = true;
    const generation = this.generation;
    renderer
      .getArrayBufferAsync(rig.sampleBuffer.value)
      .then((buffer) => {
        rig.readPending = false;
        if (generation !== this.generation) return; // component rebuilt meanwhile
        const data = new Float32Array(buffer);
        const s = sub.sysProps;
        const { count, lights, accum } = rig;
        accum.fill(0);

        // Aggregate the whole cloud into ONE emitter shape for GI: weighted
        // centroid, weighted mean colour, and a radius that covers the spread.
        // GI emitter slots are scarce (MAX_EMITTERS) and model an emissive
        // *sphere*, so one sphere per system is the honest mapping — the
        // k-means clusters below stay dedicated to the point-light path.
        let gx = 0;
        let gy = 0;
        let gz = 0;
        let gr = 0;
        let gg = 0;
        let gb = 0;
        let gw = 0;

        let total = 0;
        for (let i = 0; i < rig.samples; i++) {
          const o = i * 8;
          const alpha = data[o + 3];
          if (alpha < 0.05) continue;
          const x = data[o];
          const y = data[o + 1];
          const z = data[o + 2];
          if (rig.giEmission) {
            gx += x * alpha;
            gy += y * alpha;
            gz += z * alpha;
            gr += data[o + 4] * alpha;
            gg += data[o + 5] * alpha;
            gb += data[o + 6] * alpha;
            gw += alpha;
          }
          // assign to the nearest light (seeds = last frame's positions)
          let best = 0;
          let bestDist = Infinity;
          for (let k = 0; k < count; k++) {
            const lp = lights[k].position;
            const dx = lp.x - x;
            const dy = lp.y - y;
            const dz = lp.z - z;
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestDist) {
              bestDist = d;
              best = k;
            }
          }
          const a = best * 7;
          accum[a] += x * alpha;
          accum[a + 1] += y * alpha;
          accum[a + 2] += z * alpha;
          accum[a + 3] += data[o + 4] * alpha;
          accum[a + 4] += data[o + 5] * alpha;
          accum[a + 5] += data[o + 6] * alpha;
          accum[a + 6] += alpha;
          total += alpha;
        }

        if (rig.giEmission) {
          if (gw <= 1e-4) {
            rig.giShape = null;
          } else {
            const inv = 1 / gw;
            _giCenter.set(gx * inv, gy * inv, gz * inv);
            // Second pass for the spread. Particles simulate in ENTITY-LOCAL
            // space; GI emitter slots are world-space, so the centre is
            // transformed and the radius scaled by the entity's largest axis.
            let spread = 0;
            for (let i = 0; i < rig.samples; i++) {
              const o = i * 8;
              if (data[o + 3] < 0.05) continue;
              const dx = data[o] - _giCenter.x;
              const dy = data[o + 1] - _giCenter.y;
              const dz = data[o + 2] - _giCenter.z;
              spread = Math.max(spread, Math.sqrt(dx * dx + dy * dy + dz * dz));
            }
            const object = this.entity.object3D;
            object.updateWorldMatrix(true, false);
            object.getWorldScale(_giScale);
            _giCenter.applyMatrix4(object.matrixWorld);
            const scale = Math.max(Math.abs(_giScale.x), Math.abs(_giScale.y), Math.abs(_giScale.z));
            const k = rig.giStrength * inv;
            rig.giShape = {
              center: _giCenter.clone(),
              // A zero-radius emitter contributes nothing, and a cloud of
              // co-located particles legitimately measures ~0 spread.
              radius: Math.max(0.05, spread * scale),
              r: gr * k,
              g: gg * k,
              b: gb * k,
            };
          }
        }

        if (!rig.count) return; // GI-emission-only rig: no point lights to drive
        const baseIntensity = s.lightIntensity ?? 5;
        for (let k = 0; k < count; k++) {
          const a = k * 7;
          const w = accum[a + 6];
          const light = lights[k];
          light.distance = s.lightDistance ?? 6;
          if (w <= 1e-4 || total <= 1e-4) {
            light.intensity += (0 - light.intensity) * 0.2; // fade out empty clusters
            continue;
          }
          const inv = 1 / w;
          // smooth toward the new cluster mean to avoid light flicker
          light.position.x += (accum[a] * inv - light.position.x) * 0.3;
          light.position.y += (accum[a + 1] * inv - light.position.y) * 0.3;
          light.position.z += (accum[a + 2] * inv - light.position.z) * 0.3;
          light.color.setRGB(
            Math.min(1, accum[a + 3] * inv),
            Math.min(1, accum[a + 4] * inv),
            Math.min(1, accum[a + 5] * inv),
          );
          const target = baseIntensity * (w / total) * count;
          light.intensity += (target - light.intensity) * 0.3;
        }
      })
      .catch(() => {
        rig.readPending = false;
      });
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1; // cancels in-flight builds
    this.unsubUpdate?.();
    this.unsubUpdate = null;
    for (const sub of this.subsystems ?? []) {
      this.entity.object3D.remove(sub.object);
      sub.material.dispose();
      // Geometry (default quad, built-in shape, or a cached custom-geometry
      // asset) is shared across subsystems/components — never disposed here.
      sub.colliderField?.removeUser();
      // Drops this system's GI emitter slot; without it a destroyed effect
      // keeps lighting the scene from a provider closure nothing can reach.
      sub.unregisterGiEmitter?.();
      for (const light of sub.lightRig?.lights ?? []) {
        this.entity.object3D.remove(light);
        light.dispose();
      }
    }
    this.subsystems = [];
    this.compiled = null;
    this.graphSignature = null;
  }

  onPropChanged(key) {
    // Value-only graph edits (slider drags in the node editor) go straight
    // into the compiled uniforms — no TSL recompile, no pipeline rebuild.
    if (key === "graph" && this.compiled && this.props.graph) {
      if (particleGraphSignature(this.props.graph) === this.graphSignature) {
        this.compiled.updateParams(this.props.graph);
        return;
      }
    }
    this.onDetach();
    this.onAttach();
  }

  onDisable() {
    // Hide the render objects and skip the GPU compute pass — both
    // contribute meaningfully to cost when a particle system is offscreen.
    for (const sub of this.subsystems ?? []) {
      sub.object.visible = false;
      for (const light of sub.lightRig?.lights ?? []) light.visible = false;
    }
  }

  onEnable() {
    for (const sub of this.subsystems ?? []) {
      sub.object.visible = true;
      for (const light of sub.lightRig?.lights ?? []) light.visible = true;
    }
  }

  /** Re-runs the init pass for every subsystem (editor Restart button). */
  restart() {
    for (const sub of this.subsystems ?? []) sub.initialized = false;
  }

  #tick() {
    if (!this.enabled) return;
    if (!this.isInView()) return;
    const renderer = this.entity.engine.renderer;
    if (!renderer) return;
    // Refresh collider storage in the same callback that dispatches compute.
    // A separate engine update hook made correctness depend on callback order
    // and could leave rebuilt systems reading a stale/empty GPU buffer.
    let colliderField = null;
    for (const sub of this.subsystems ?? []) {
      if (!sub.colliderField) continue;
      colliderField = sub.colliderField;
      break; // ParticleColliderField is an engine-wide singleton.
    }
    colliderField?.refresh();

    // All passes are batched into one renderer.compute() call — a single
    // command encoder / compute pass instead of one submit per dispatch.
    const queue = (this._computeQueue ??= []);
    queue.length = 0;
    for (const sub of this.subsystems ?? []) {
      if (!sub.updateCompute) continue;
      if (sub.collisionMatrices) {
        this.entity.object3D.updateWorldMatrix(true, false);
        const m = this.entity.object3D.matrixWorld;
        sub.collisionMatrices.world.value.copy(m);
        sub.collisionMatrices.inverse.value.copy(m).invert();
      }
      if (!sub.initialized) {
        sub.initialized = true;
        queue.push(sub.initCompute);
      }
      queue.push(sub.updateCompute);
      if (sub.clearCompute) queue.push(sub.clearCompute);
      if (sub.scatterCompute) queue.push(sub.scatterCompute);
      if (sub.resolveCompute) queue.push(sub.resolveCompute);
      if (sub.lightRig) queue.push(sub.lightRig.sampleCompute);
    }
    if (queue.length) renderer.compute(queue);
    for (const sub of this.subsystems ?? []) {
      if (sub.lightRig) this.#updateLights(sub, renderer);
    }
  }
}

/** Every instance keeps an identity matrix — offsets come from positionNode, not instanceMatrix. */
function fillIdentityInstanceMatrix(mesh) {
  const m = new THREE.Matrix4();
  const array = mesh.instanceMatrix.array;
  for (let i = 0; i < mesh.count; i++) array.set(m.elements, i * 16);
  mesh.instanceMatrix.needsUpdate = true;
}
