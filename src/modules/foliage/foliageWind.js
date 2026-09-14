import * as THREE from "three/webgpu";
import { Fn, If, abs, attribute, buffer, cos, float, fract, instanceIndex, instancedBufferAttribute, instancedDynamicBufferAttribute, mat4, max, min, normalLocal, positionGeometry, positionLocal, sin, sqrt, texture, uv, vec2, vec3, vec4 } from "three/tsl";
import { installFoliageLeafLighting } from "./foliageLighting.js";

// Two scrolling noise scales are the shared field described by Sucker Punch:
// https://blog.playstation.com/?p=345372. Circular grass arcs preserve length;
// tree joints use separate main/detail resonance bands (GPU Gems 3, ch.6/16).
// One tiny periodic texture carries fronts, delayed fronts and fine detail.
let windTexture;
function getWindTexture() {
  if (windTexture) return windTexture;
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
    const front = offset => {
      const phase = ((u + offset) / (Math.PI * 2) * 2 + .13 * Math.sin(v) + .04 * Math.sin(v * 3) + 3) % 1;
      const smooth = (a, b, value) => { const t = THREE.MathUtils.clamp((value - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
      return smooth(0, .16, phase) * (1 - smooth(.30, .98, phase)) * (.78 + .22 * Math.sin(v * 3 + u));
    };
    const coarse = front(0), lagged = front(.16);
    const fine = .5 + .22 * Math.sin(u * 5 + v * 3) + .16 * Math.cos(v * 7 - u * 2) + .1 * Math.sin(u * 9 - v * 6);
    const index = (y * size + x) * 4;
    data[index] = Math.round(THREE.MathUtils.clamp(coarse, 0, 1) * 255);
    data[index + 1] = Math.round(THREE.MathUtils.clamp(fine, 0, 1) * 255);
    data[index + 2] = Math.round(THREE.MathUtils.clamp(lagged, 0, 1) * 255);
    data[index + 3] = Math.round(THREE.MathUtils.clamp(.5 + .27 * Math.sin(u * 13 - v * 7) + .18 * Math.sin(u * 17 + v * 11), 0, 1) * 255);
  }
  windTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  windTexture.name = "Foliage shared wind field";
  windTexture.wrapS = windTexture.wrapT = THREE.RepeatWrapping;
  windTexture.minFilter = windTexture.magFilter = THREE.LinearFilter;
  windTexture.needsUpdate = true;
  return windTexture;
}

/** Force, turbulence, delayed force and detail. Exactly two vertex samples. */
export function foliageWindSample(uniforms, worldPosition) {
  const time = uniforms.time.mul(uniforms.speed);
  const scale = max(uniforms.gustScale, .5);
  const heading = uniforms.direction.xz.div(max(uniforms.direction.xz.length(), .0001));
  const along = worldPosition.xz.dot(heading), across = worldPosition.xz.dot(vec2(heading.y.negate(), heading.x));
  const flow = vec2(along.sub(time.mul(2)), across).div(scale.mul(4));
  const broad = texture(getWindTexture(), flow).level(0);
  const fine = texture(getWindTexture(), flow.mul(3.7).add(vec2(time.mul(.007), time.mul(-.009)))).level(0);
  const amplitude = uniforms.gustStrength.mul(1.8).add(.08);
  return vec4(float(.20).add(broad.r.mul(amplitude)), fine.g.mul(2).sub(1).mul(uniforms.turbulence), float(.20).add(broad.b.mul(amplitude)), fine.a.mul(2).sub(1));
}

/** Public two-channel field probe; the living shader also uses delayed force. */
export function foliageWindField(uniforms, worldPosition) { return foliageWindSample(uniforms, worldPosition).xy; }

// Smooth triangle waves supply separate resonance bands without additional
// texture reads or transcendental functions (GPU Gems 3, chapters 6 and 16).
function smoothWave(phase) {
  const triangle = abs(fract(phase).mul(2).sub(1));
  return triangle.mul(triangle).mul(float(3).sub(triangle.mul(2))).mul(2).sub(1);
}

/**
 * A saturating bend: `v/(1+|v|) * limit`, so the angle approaches `limit` and
 * never overshoots into a fold.
 *
 * ⭐⭐ THE LIMIT IS NOT A CONSTANT ANY MORE — `reach` SCALES IT WITH THE WIND.
 *
 * Every cap here was a fixed angle, and the stiff ones are TINY: a trunk could
 * lean 0.075 rad, 4.3°, whatever the weather. So the whole system was already
 * against its ceiling in an ordinary breeze and a gale looked the same as one —
 * the user's "maximum wind strength still almost does not affect the scene".
 * Multiplying the cap by `reach` (1 at the default 2 m/s scene wind, rising to
 * 4 in a storm) means a stronger wind bends further rather than just faster,
 * which is the difference a person actually sees across a field.
 */
function softLimit(value, limit, reach = null) {
  // ⚠ LOOSE `==`: a uniforms object built somewhere that predates `reach`
  //   hands `undefined`, and `undefined.mul` is a TSL graph that throws at
  //   BUILD time — which in this engine is an invisible object, not an error.
  const capped = reach == null ? float(limit) : reach.mul(limit);
  return value.div(float(1).add(abs(value))).mul(capped);
}

function localWindDirection(matrix, direction) {
  const x = matrix.mul(vec4(1, 0, 0, 0)).xyz, y = matrix.mul(vec4(0, 1, 0, 0)).xyz, z = matrix.mul(vec4(0, 0, 1, 0)).xyz;
  return vec3(direction.dot(x).div(max(x.dot(x), .000001)), direction.dot(y).div(max(y.dot(y), .000001)), direction.dot(z).div(max(z.dot(z), .000001)));
}

/** Shortest rotation from one unit tangent to another, without atan/acos. */
function rotateBetween(vector, from, to) {
  const axis = from.cross(to);
  return vector.add(axis.cross(vector)).add(axis.cross(axis.cross(vector)).div(max(float(1).add(from.dot(to)), .02)));
}

/** A circular centerline at fraction t of its fixed arc length. */
function arcCenter(up, toward, angle, length, t) {
  const a = angle.mul(t), a2 = a.mul(a);
  const sinc = abs(a).lessThan(.002).select(float(1).sub(a2.div(6)), sin(a).div(max(abs(a), .000001)));
  const cosc = abs(a).lessThan(.002).select(a.mul(.5).sub(a.mul(a2).div(24)), float(1).sub(cos(a)).div(max(abs(a), .000001)));
  return up.mul(sinc).add(toward.mul(cosc)).mul(length.mul(t));
}

/** Rodrigues rotation keeps every vertex's root distance exactly constant. */
export function rotateFoliageVector(vector, axis, angle) {
  const c = cos(angle), s = sin(angle);
  return vector.mul(c).add(axis.cross(vector).mul(s)).add(axis.mul(axis.dot(vector)).mul(float(1).sub(c)));
}

// Keep matrix inputs uniform/vertex attributes, never an extra storage buffer.
// This mirrors Three r185's instancing choice so large chunks remain portable.
const matrixAttributes = new WeakMap();

/** Synchronize only this foliage object's compiled matrix mirrors. Three r185
 * uploads geometry before its ordinary OnFrameUpdate events; version-driven
 * static buffers therefore need their versions/ranges forwarded earlier. */
export function createFoliageMatrixSync(source, bufferAttributes) {
  let mirrors;
  return () => {
    // BufferAttributeNode.attribute is populated after graph setup. Resolve on
    // the first object update, retaining the small list rather than the builder.
    mirrors ??= [...new Set(bufferAttributes.map(entry => entry.node?.attribute?.data)
      .filter(buffer => buffer?.array === source.array))];
    for (const mirror of mirrors) if (mirror.version !== source.version) {
      mirror.clearUpdateRanges();
      mirror.updateRanges.push(...source.updateRanges);
      mirror.version = source.version;
    }
  };
}

// ⭐⭐ ONE READ PER MESH, NOT ONE PER CALL SITE (09-13 fix) — `foliageAnimatedPosition`
// (the tree/meadow motion) and `foliageFadeNode` (the P1-B LOD crossfade,
// `foliageMaterial.js`) each need the instance's full 4x4 matrix and each used to
// call this function independently. Every call below the UBO threshold mints FOUR
// FRESH `instancedBufferAttribute` node objects (`[0,4,8,12].map(bufferFn...)`) —
// three's `NodeBuilder.getBufferAttributeFromNode` dedupes buffer-attribute nodes
// by NODE IDENTITY (`getDataFromNode(node, 'vertex')`), never by the underlying
// buffer+offset they read, so two independently-constructed mat4 reads of the
// EXACT SAME interleaved mirror still cost eight vertex-input locations instead of
// four. That extra, unshared read is exactly what pushed a large "living surface"
// chunk past WebGPU's sixteen-attribute ceiling once the LOD crossfade added its
// own second call site.
//
// ⚠ CANNOT key the cache on the `builder` PARAMETER: each nested `Fn(...)()` call
// site gets its OWN fresh `secureNodeBuilder` Proxy wrapping the one real
// NodeBuilder for this compile (see three's `ShaderNode.call`), so `builder` is a
// DIFFERENT object at each call site even within one build — a `WeakMap` keyed on
// it would never hit. `builder.object` (the mesh) IS the same value through every
// proxy (`Reflect.get` forwards to the same target), so key on that instead —
// guarded by `source` identity so a mesh that later gets handed a NEW
// `instanceMatrix` (chunk repartition) invalidates the old node rather than
// silently reading stale data forever.
//
// This intentionally also lets the SAME node survive across passes (colour,
// shadow, GI prepass) for one mesh — safe, because `getDataFromNode`'s own
// dedup lives on each pass's real builder instance, not on the node, so every
// pass still registers its own `@location` from this shared node exactly as it
// would from a freshly-minted one. The one thing that must NOT be skipped on a
// cache hit is the per-pass mirror-sync registration below: each pass's own
// `builder.bufferAttributes` list needs its OWN `OnBeforeObjectUpdate` hook or
// that pass's copy of the interleaved mirror goes stale (frozen shadow-pass
// instances) — so that registration always runs, independent of node caching.
const matrixNodeByObject = new WeakMap();

export function foliageInstanceMatrix(builder) {
  const object = builder.object;
  const source = object?.instanceMatrix;
  if (!source) return mat4(1);
  const count = Math.max(1, source.count);
  const needsAttribute = count * 64 > builder.getUniformBufferLimit();
  if (needsAttribute) {
    // Update BOTH Three's position matrix and our root matrix before upload.
    // Matching only their late OnFrameUpdate would leave both static GPU buffers
    // one frame behind after LOD compaction. No renderer-wide patch is needed.
    // Always registered, even on a cached-node hit — see the file comment above.
    THREE.TSL.OnBeforeObjectUpdate(createFoliageMatrixSync(source, builder.bufferAttributes));
  }
  const cached = matrixNodeByObject.get(object);
  if (cached && cached.source === source) return cached.node;
  let node;
  if (needsAttribute) {
    let interleaved = matrixAttributes.get(source);
    if (!interleaved) {
      interleaved = new THREE.InstancedInterleavedBuffer(source.array, 16, 1);
      matrixAttributes.set(source, interleaved);
    }
    const bufferFn = source.usage === THREE.DynamicDrawUsage ? instancedDynamicBufferAttribute : instancedBufferAttribute;
    node = mat4(...[0, 4, 8, 12].map(offset => bufferFn(interleaved, "vec4", 16, offset)));
  } else {
    node = buffer(source.array, "mat4", count).element(instanceIndex);
  }
  matrixNodeByObject.set(object, { source, node });
  return node;
}

/** Shared mathematical core used by the actual vertex shader and GPU checks. */
export function bendFoliageBlade(uniforms, p, root, up, bladeT) {
  const field = foliageWindField(uniforms, root);
  const direction = uniforms.direction.sub(up.mul(up.dot(uniforms.direction)));
  const axisRaw = up.cross(direction);
  const axis = axisRaw.div(max(axisRaw.length(), .0001));
  const t = bladeT.clamp(0, 1);
  const angle = min(uniforms.strength.mul(field.x.add(field.y.mul(t.mul(t)).mul(.22))), 1.15).mul(t).mul(min(axisRaw.length(), 1));
  return root.add(rotateFoliageVector(p.sub(root), axis, angle));
}

// Tree rotations are small. Fifth-order Rodrigues coefficients avoid several
// sin/cos pairs per leaf while remaining accurate at the bounded angles below.
function rotateSmall(vector, axis, angle) {
  const a2 = angle.mul(angle), a4 = a2.mul(a2);
  const c = float(1).sub(a2.mul(.5)).add(a4.div(24));
  const s = angle.mul(float(1).sub(a2.div(6)).add(a4.div(120)));
  return vector.mul(c).add(axis.cross(vector).mul(s)).add(axis.mul(axis.dot(vector)).mul(float(1).sub(c)));
}

function animateArcMeadow(uniforms, matrix, blade, curve, p, field) {
  const root = vec3(blade.x, 0, blade.y), t = blade.w.clamp(0, 1), length = blade.z;
  const time = uniforms.time.mul(uniforms.speed);
  const phase = blade.xy.dot(vec2(17.31, 11.7)).add(curve.z.mul(2.7));
  const wind = localWindDirection(matrix, uniforms.direction);
  const isFlower = curve.z.lessThan(-.5);
  const stemUp = vec3(curve.x, sqrt(max(float(1).sub(curve.xy.dot(curve.xy)), .0001)), curve.y);
  const up = isFlower.select(stemUp, vec3(0, 1, 0));
  const acrossWind = wind.sub(up.mul(wind.dot(up)));
  const direction = acrossWind.div(max(acrossWind.length(), .0001));
  const force = isFlower.select(field.z, field.x).mul(uniforms.strength);
  const bend = softLimit(force, isFlower.select(.95, 1.35), uniforms.reach).mul(min(acrossWind.length(), 1));
  // Additional curvature, not an extra displacement: the tip response grows
  // naturally with arc distance while centerline length remains fixed.
  const flutterWave = smoothWave(time.mul(isFlower.select(.43, 1.7)).add(phase));
  const flutter = softLimit(uniforms.strength, .12).mul(uniforms.turbulence).mul(flutterWave.mul(.65).add(field.y.mul(.35)));
  const windCurve = direction.mul(bend).add(up.cross(direction).mul(flutter));
  const restDirection = vec3(curve.x, 0, curve.y);
  const curvature = isFlower.select(windCurve, restDirection.mul(curve.z).add(windCurve));
  const angle = curvature.length(), toward = curvature.div(max(angle, .000001));
  const center = root.add(arcCenter(up, toward, angle, length, t));
  const tangent = up.mul(cos(angle.mul(t))).add(toward.mul(sin(angle.mul(t))));
  const restAngle = max(curve.z, 0).mul(t);
  const restTangent = isFlower.select(up, vec3(0, cos(restAngle), 0).add(restDirection.mul(sin(restAngle))));
  const restCenter = isFlower.select(root.add(up.mul(length.mul(t))), root.add(arcCenter(vec3(0, 1, 0), restDirection, max(curve.z, 0), length, t)));
  const restOffset = positionGeometry.sub(restCenter);
  const movedOffset = rotateBetween(restOffset, restTangent, tangent);
  const localDelta = center.add(movedOffset).sub(positionGeometry);
  const worldFrom = matrix.mul(vec4(restTangent, 0)).xyz.normalize(), worldTo = matrix.mul(vec4(tangent, 0)).xyz.normalize();
  normalLocal.assign(rotateBetween(normalLocal, worldFrom, worldTo));
  return p.add(matrix.mul(vec4(localDelta, 0)).xyz);
}

function animateTree(uniforms, matrix, p, props) {
  const branch = attribute("treeBranch", "vec4"), branchAxis = attribute("treeBranchAxis", "vec4");
  const leaf = attribute("treeLeaf", "vec4"), leafAxis = attribute("treeLeafAxis", "vec4");
  const root = matrix.mul(vec4(0, 0, 0, 1)).xyz;
  const field = foliageWindSample(uniforms, root);
  const up = matrix.mul(vec4(0, 1, 0, 0)).xyz.normalize();
  const time = uniforms.time.mul(uniforms.speed), rootPhase = root.xz.dot(vec2(.071, .093));
  const position = p.toVar();
  If(leafAxis.w.greaterThan(.5), () => {
    const pivot = matrix.mul(vec4(leaf.xyz, 1)).xyz;
    const stem = matrix.mul(vec4(leafAxis.xyz, 0)).xyz.normalize();
    const rawAxis = stem.cross(uniforms.direction), axis = rawAxis.div(max(rawAxis.length(), .0001));
    const progress = uv().y.clamp(0, 1), phase = leaf.w.add(rootPhase);
    const flutter = smoothWave(time.mul(2.13).add(phase)).mul(.6).add(smoothWave(time.mul(3.17).add(phase.mul(.73))).mul(.25)).add(field.w.mul(.15));
    const angle = softLimit(uniforms.strength, .55, uniforms.reach).mul(field.x.mul(.12).add(flutter.mul(uniforms.turbulence))).mul(progress).mul(min(rawAxis.length(), 1));
    const twist = softLimit(uniforms.strength, .24, uniforms.reach).mul(uniforms.turbulence).mul(smoothWave(time.mul(2.71).add(phase.mul(1.37)))).mul(progress.mul(progress));
    const moved = rotateSmall(position.sub(pivot), axis, angle);
    const turnedStem = rotateSmall(stem, axis, angle);
    position.assign(pivot.add(rotateSmall(moved, turnedStem, twist)));
    normalLocal.assign(rotateSmall(rotateSmall(normalLocal, axis, angle), turnedStem, twist));
  });
  const pivot = matrix.mul(vec4(branch.xyz, 1)).xyz;
  const limb = matrix.mul(vec4(branchAxis.xyz, 0)).xyz.normalize();
  const limbRawAxis = limb.cross(uniforms.direction), limbAxis = limbRawAxis.div(max(limbRawAxis.length(), .0001));
  const limbPhase = branch.xyz.dot(vec3(.173, .327, .271)).add(rootPhase);
  const resonance = smoothWave(time.mul(.31).add(limbPhase)).mul(.14).add(smoothWave(time.mul(.53).add(limbPhase.mul(.71))).mul(.06));
  const limbAngle = softLimit(uniforms.strength.mul(field.z.add(resonance)), .18, uniforms.reach).mul(branch.w).mul(min(limbRawAxis.length(), 1));
  position.assign(pivot.add(rotateSmall(position.sub(pivot), limbAxis, limbAngle)));
  normalLocal.assign(rotateSmall(normalLocal, limbAxis, limbAngle));
  const trunkRawAxis = up.cross(uniforms.direction), trunkAxis = trunkRawAxis.div(max(trunkRawAxis.length(), .0001));
  const trunkDrive = field.z.add(smoothWave(time.mul(.13).add(rootPhase)).mul(.05));
  const anchorHeight = leafAxis.w.greaterThan(.5).select(leaf.y, positionGeometry.y).div(Math.max(.02, Number(props.height) || 8)).clamp(0, 1);
  const trunkAngle = softLimit(uniforms.strength.mul(trunkDrive), .075, uniforms.reach).mul(anchorHeight).mul(min(trunkRawAxis.length(), 1));
  normalLocal.assign(rotateSmall(normalLocal, trunkAxis, trunkAngle));
  return root.add(rotateSmall(position.sub(root), trunkAxis, trunkAngle));
}

export function foliageAnimatedPosition(uniforms, props) {
  const meadow = props.species === "grass" || props.species === "wildflowers";
  return Fn((builder) => {
    const p = positionLocal.toVar();
    const result = p.toVar();
    const treeMotion = builder.geometry.hasAttribute("treeBranchAxis");
    const weight = (treeMotion ? attribute("treeBranchAxis", "vec4").w : attribute("foliageWind", "float")).clamp(0, 1);
    If(uniforms.strength.greaterThan(0), () => {
      if (meadow && builder.geometry.hasAttribute("foliageBlade")) {
        const blade = attribute("foliageBlade", "vec4");
        const matrix = foliageInstanceMatrix(builder);
        const root = matrix.mul(vec4(blade.x, 0, blade.y, 1)).xyz;
        const up = matrix.mul(vec4(0, 1, 0, 0)).xyz.normalize();
        const field = foliageWindSample(uniforms, root);
        if (builder.geometry.hasAttribute("foliageCurve")) {
          const curve = attribute("foliageCurve", "vec4");
          If(curve.z.greaterThan(-1.5), () => { result.assign(animateArcMeadow(uniforms, matrix, blade, curve, p, field)); }).Else(() => {
            result.assign(bendFoliageBlade(uniforms, p, root, up, blade.w));
          });
        } else {
        const axisRaw = up.cross(uniforms.direction);
        const axis = axisRaw.div(max(axisRaw.length(), .0001));
        const t = blade.w.clamp(0, 1);
        const angle = min(uniforms.strength.mul(field.x.add(field.y.mul(t.mul(t)).mul(.22))), 1.15).mul(t).mul(min(axisRaw.length(), 1));
        result.assign(root.add(rotateFoliageVector(p.sub(root), axis, angle)));
        // Normals follow the same rotation; there is no fragment-stage wind.
        normalLocal.assign(rotateFoliageVector(normalLocal, axis, angle));
        }
      } else if (treeMotion) {
        result.assign(animateTree(uniforms, foliageInstanceMatrix(builder), p, props));
      } else {
        const field = foliageWindField(uniforms, p);
        const slow = sin(uniforms.time.mul(uniforms.speed).mul(.65).add(p.x.mul(.11)).add(p.z.mul(.09)));
        const branch = field.x.mul(.65).add(slow.mul(.12));
        const leafFlutter = field.y.mul(weight.mul(weight)).mul(.12);
        result.addAssign(uniforms.direction.mul(branch.add(leafFlutter).mul(uniforms.strength).mul(weight)));
      }
    });
    const push = vec3(0).toVar();
    If(uniforms.interaction.greaterThan(0), () => {
      for (const collider of uniforms.colliders) If(collider.center.w.greaterThan(0), () => {
        const delta = p.sub(collider.center.xyz);
        const local = vec3(delta.dot(collider.x.xyz), delta.dot(collider.y.xyz), delta.dot(collider.z.xyz));
        const extent = vec3(collider.x.w, collider.y.w, collider.z.w);
        const outside = local.sub(local.clamp(extent.negate(), extent));
        const sphereDistance = max(local.length().sub(extent.x), 0);
        const distance = collider.center.w.greaterThan(1.5).select(sphereDistance, outside.length());
        const influence = float(1).sub(distance.div(max(uniforms.radius, .01))).clamp(0, 1);
        const away = vec3(delta.x.add(.0001), 0, delta.z.add(.0001)).normalize();
        push.addAssign(away.mul(influence.mul(weight).mul(uniforms.interaction)));
      });
    });
    return result.add(push.div(max(push.length(), 1)));
  })();
}

/** Animate the atlas quad without moving its lower edge or changing its bake. */
export function setupFoliageImpostorMaterial(material, uniforms, props = {}) {
  const isMeadow = props.species === "grass" || props.species === "wildflowers";
  const sway = source => Fn(() => {
    const p = source.toVar();
    const center = attribute("aCenter", "vec3");
    const size = attribute("aSize", "float");
    const weight = positionGeometry.y.add(.5).clamp(0, 1);
    const field = foliageWindSample(uniforms, center);
    const force = (isMeadow ? field.x : field.z).add(field.y.mul(.05)).mul(uniforms.strength);
    const amount = softLimit(force, isMeadow ? 1.35 : .10).mul(weight.mul(weight));
    return p.add(uniforms.direction.mul(amount).mul(isMeadow ? size.mul(.2) : size));
  })();
  material.positionNode = sway(material.positionNode);
  // The shadow caster sways with the picture (and keeps the impostor's
  // push away from the light — `impostorMaterial.js#castShadowPositionNode`).
  if (material.castShadowPositionNode) material.castShadowPositionNode = sway(material.castShadowPositionNode);
  // Trees get the same canopy light as the tree they replace, or the handoff
  // is a brightness pop (`foliageLighting.js`). Never grass: any view term
  // made the sward flip pale/black by camera angle (09-13).
  if (!isMeadow) installFoliageLeafLighting(material, float(1));
  // Three's shadow override also needs the impostor's authored coverage — but
  // a material that arrived with its OWN maskShadowNode
  // (`createImpostorMaterial`'s shadow-biased handoff, which replays the fade
  // at `userData.foliageShadowLodFar` AND folds in this same coverage) already
  // says everything this rebuild would, and rebuilding would REPLACE the
  // shadow handoff with the colour decision. Keep theirs; rebuild only as the
  // fallback for materials without one.
  if (material.opacityNode && !material.maskShadowNode) {
    material.maskShadowNode = material.opacityNode.greaterThan(material.alphaTest || .35);
  }
  material.needsUpdate = true;
  return material;
}
