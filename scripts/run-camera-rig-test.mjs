/**
 * Camera rigs (roadmap item 7): virtual cameras, priority blending, boom arms
 * with wall avoidance, damping, and impulse shake.
 *
 * Everything here is a number a camera either lands on or doesn't, which is
 * exactly what makes camera code worth testing headlessly: "the camera feels
 * floaty" is unfalsifiable, but "the same rig settles in the same place at 30Hz
 * and 240Hz" is not — and that one property is the difference between a rig
 * that behaves on the machine it was authored on and one that behaves
 * everywhere.
 */
import assert from "node:assert/strict";

const stubElement = () => ({
  style: {},
  appendChild() {},
  removeChild() {},
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  classList: { add() {}, remove() {} },
  parentElement: null,
});
globalThis.document ??= {
  body: stubElement(),
  createElement: stubElement,
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
globalThis.window ??= {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  performance: globalThis.performance,
  crypto: globalThis.crypto,
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const THREE = await import("three/webgpu");
const { damp, dampAngle, dampFactor, blendCurve, orbitOffset, resolveCollision } = await import(
  "../src/engine/camera/rigMath.js"
);
const { ImpulseSystem } = await import("../src/engine/camera/impulse.js");
const { Engine, registerBuiltInComponents } = await import("../src/engine/index.js");

registerBuiltInComponents();

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};
const near = (actual, expected, tol, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: expected ~${expected}, got ${actual} (tolerance ${tol})`,
  );
const section = (title) => console.log(`\n${title}`);

/** Runs the engine's update stages without a renderer. */
const tick = (engine, dt) => {
  engine.cameraImpulse.update(dt);
  for (const fn of engine.updateCallbacks) fn(dt);
  for (const entry of [...engine.lateUpdateCallbacks]) entry.fn(dt);
};

// ---------------------------------------------------------------------------

section("damping");

await check("damping is frame-rate independent", () => {
  // The bug this exists to prevent: `lerp(a, b, dt * k)` converges at a
  // different rate per frame rate, so the same rig glides on a 240Hz machine
  // and snaps on a 30Hz one.
  const settle = (steps, dt) => {
    let value = 0;
    for (let i = 0; i < steps; i++) value = damp(value, 10, 0.3, dt);
    return value;
  };
  const at30 = settle(30, 1 / 30);
  const at240 = settle(240, 1 / 240);
  near(at30, at240, 1e-3, "one second of damping at two frame rates");
});

await check("the damping value is a time constant, not a magic number", () => {
  // ~63% of the gap closed after exactly `damping` seconds. Stated as a test so
  // the tooltip and the maths can't drift apart.
  near(dampFactor(0.5, 0.5), 1 - Math.exp(-1), 1e-9, "one time constant");
  near(dampFactor(0.5, 1.5), 1 - Math.exp(-3), 1e-9, "three time constants");
});

await check("zero damping snaps and a zero delta does not move", () => {
  near(damp(0, 10, 0, 1 / 60), 10, 1e-9, "no damping");
  near(damp(0, 10, 0.3, 0), 0, 1e-9, "no time passed");
});

await check("angle damping takes the short way round ±180°", () => {
  // 170° chasing -170° is a 20° move, not a 340° one. Without the wrap the
  // camera spins the whole way round the world from a one-degree change.
  const from = THREE.MathUtils.degToRad(170);
  const to = THREE.MathUtils.degToRad(-170);
  const stepped = dampAngle(from, to, 0.1, 1 / 60);
  assert.ok(stepped > from, `should keep increasing past π, got ${stepped}`);
  assert.ok(stepped - from < 0.2, "and by a small amount");
});

await check("blend curves are clamped and hit both ends exactly", () => {
  for (const style of ["linear", "easeIn", "easeOut", "easeInOut"]) {
    near(blendCurve(0, style), 0, 1e-9, `${style} at 0`);
    near(blendCurve(1, style), 1, 1e-9, `${style} at 1`);
    near(blendCurve(-3, style), 0, 1e-9, `${style} below range`);
    near(blendCurve(9, style), 1, 1e-9, `${style} above range`);
  }
  near(blendCurve(0.5, "easeInOut"), 0.5, 1e-9, "symmetric at the midpoint");
});

await check("the boom arm yaws around world up without rolling the horizon", () => {
  const out = new THREE.Vector3();
  orbitOffset(out, 0, 0, 4);
  near(out.z, 4, 1e-9, "behind the target at yaw 0");
  orbitOffset(out, Math.PI / 2, 0, 4);
  near(out.x, 4, 1e-9, "a quarter turn puts it on +X");
  near(out.y, 0, 1e-9, "and level");
  orbitOffset(out, 0, Math.PI / 4, 4);
  near(out.y, 4 * Math.SQRT1_2, 1e-9, "pitch raises it");
  near(out.length(), 4, 1e-9, "arm length is preserved at any angle");
});

await check("collision snaps inward and eases outward", () => {
  // A physics stub that reports a wall 1.5m from the pivot.
  const physics = { shapecast: () => ({ distance: 1.5, point: [0, 0, 0], normal: [0, 0, 1], entity: null }) };
  const pivot = new THREE.Vector3();
  const dir = new THREE.Vector3(0, 0, 1);
  const pulled = resolveCollision(physics, pivot, dir, 4, { radius: 0.25, padding: 0.05, previousDistance: 4, recovery: 0.3, dt: 1 / 60 });
  near(pulled, 1.45, 1e-9, "snapped to the wall immediately");
  const recovering = resolveCollision(null, pivot, dir, 4, { previousDistance: 1.45, recovery: 0.3, dt: 1 / 60 });
  assert.ok(recovering > 1.45 && recovering < 2, `eased back out, got ${recovering}`);
});

// ---------------------------------------------------------------------------

section("impulses");

await check("an impulse decays to nothing and retires itself", () => {
  const system = new ImpulseSystem();
  system.emit({ magnitude: 1, duration: 0.5, frequency: 20 });
  const pos = new THREE.Vector3();
  const euler = new THREE.Euler();
  system.update(0.05);
  system.sample(null, pos, euler);
  const early = pos.length();
  assert.ok(early > 0, "shakes at the start");
  system.update(0.4);
  system.sample(null, pos, euler);
  assert.ok(pos.length() < early, `decays (${pos.length()} vs ${early})`);
  system.update(0.2);
  assert.equal(system.count, 0, "and is gone once its duration elapses");
  system.sample(null, pos, euler);
  near(pos.length(), 0, 1e-9, "leaving no residue");
});

await check("distance attenuates an impulse to silence past its radius", () => {
  const system = new ImpulseSystem();
  system.emit({ position: [0, 0, 0], magnitude: 1, duration: 1, radius: 10 });
  system.update(0.1);
  const pos = new THREE.Vector3();
  const euler = new THREE.Euler();
  system.sample(new THREE.Vector3(0, 0, 0), pos, euler);
  const atSource = pos.length();
  system.sample(new THREE.Vector3(5, 0, 0), pos, euler);
  const halfway = pos.length();
  system.sample(new THREE.Vector3(11, 0, 0), pos, euler);
  const outside = pos.length();
  assert.ok(atSource > halfway, `nearer is stronger (${atSource} vs ${halfway})`);
  near(outside, 0, 1e-9, "beyond the radius, nothing");
});

await check("a radius-less impulse is global", () => {
  const system = new ImpulseSystem();
  system.emit({ position: [0, 0, 0], magnitude: 1, duration: 1, radius: 0 });
  system.update(0.1);
  const pos = new THREE.Vector3();
  const euler = new THREE.Euler();
  system.sample(new THREE.Vector3(1000, 0, 0), pos, euler);
  assert.ok(pos.length() > 0, "reaches across the level");
});

await check("impulses are deterministic and additive", () => {
  const run = () => {
    const system = new ImpulseSystem();
    system.emit({ magnitude: 0.5, duration: 1, frequency: 15 });
    system.update(0.2);
    const pos = new THREE.Vector3();
    system.sample(null, pos, new THREE.Euler());
    return pos.clone();
  };
  // Same seed sequence per system instance — a replay or a test shakes the same
  // way twice, and a failing shake test fails the same way twice.
  const a = run();
  const b = run();
  assert.ok(a.distanceTo(b) < 1e-12, `identical runs (${a.toArray()} vs ${b.toArray()})`);

  const system = new ImpulseSystem();
  system.emit({ magnitude: 0.5, duration: 1, frequency: 15 });
  system.emit({ magnitude: 0.5, duration: 1, frequency: 15 });
  system.update(0.2);
  const both = new THREE.Vector3();
  system.sample(null, both, new THREE.Euler());
  assert.equal(system.count, 2, "two live impulses");
  assert.ok(both.length() > a.length(), "two shakes are stronger than one");
});

await check("combined shake is clamped so a barrage can't fling the camera", () => {
  const system = new ImpulseSystem();
  for (let i = 0; i < 20; i++) system.emit({ magnitude: 5, duration: 1, frequency: 12 });
  system.update(0.2);
  const pos = new THREE.Vector3();
  const euler = new THREE.Euler();
  system.sample(null, pos, euler);
  assert.ok(pos.length() <= system.maxDisplacement + 1e-9, `displacement ${pos.length()}`);
  assert.ok(Math.abs(euler.y) <= system.maxRotation + 1e-9, `rotation ${euler.y}`);
});

// ---------------------------------------------------------------------------

section("virtual cameras");

/** An engine with a target and a real camera entity, ready to play. */
function rigScene({ camProps = {} } = {}) {
  const engine = new Engine();
  const target = engine.createEntity({ name: "Player" });
  const cameraEntity = engine.createEntity({ name: "Main Camera" });
  const brain = cameraEntity.addComponent("camera", { blendTime: 0.5, ...camProps });
  engine.playing = true;
  return { engine, target, cameraEntity, brain };
}

const addVcam = (engine, name, props) => {
  const entity = engine.createEntity({ name });
  const vcam = entity.addComponent("vcam", props);
  return { entity, vcam };
};

await check("a virtual camera registers itself with the engine", () => {
  const { engine } = rigScene();
  assert.equal(engine.virtualCameras.size, 0);
  const { entity } = addVcam(engine, "Follow", { follow: "" });
  assert.equal(engine.virtualCameras.size, 1);
  entity.removeComponent("vcam");
  assert.equal(engine.virtualCameras.size, 0, "and unregisters on removal");
});

await check("the highest-priority camera wins", () => {
  const { engine, brain } = rigScene();
  const low = addVcam(engine, "Low", { priority: 5, body: "none" });
  const high = addVcam(engine, "High", { priority: 20, body: "none" });
  assert.equal(brain.pickVirtualCamera(engine), high.vcam);
  low.vcam.setProp("priority", 50);
  assert.equal(brain.pickVirtualCamera(engine), low.vcam, "changing priority re-picks");
});

await check("a disabled camera is not a candidate", () => {
  const { engine, brain } = rigScene();
  const low = addVcam(engine, "Low", { priority: 5, body: "none" });
  const high = addVcam(engine, "High", { priority: 20, body: "none" });
  high.vcam.setEnabled(false);
  assert.equal(brain.pickVirtualCamera(engine), low.vcam);
});

await check("solo outranks every priority", () => {
  const { engine, brain } = rigScene();
  const low = addVcam(engine, "Low", { priority: 5, body: "none" });
  addVcam(engine, "High", { priority: 100, body: "none" });
  low.vcam.setSolo(true);
  assert.equal(brain.pickVirtualCamera(engine), low.vcam);
  low.vcam.setSolo(false);
  assert.notEqual(brain.pickVirtualCamera(engine), low.vcam, "and releases cleanly");
});

await check("a boom arm sits behind its target at the authored distance", () => {
  const { engine, target, cameraEntity } = rigScene();
  target.object3D.position.set(3, 0, -7);
  addVcam(engine, "Follow", {
    priority: 10,
    follow: target.id,
    body: "orbital",
    distance: 5,
    yaw: 0,
    pitch: 0,
    offset: [0, 1, 0],
    collision: false,
  });
  tick(engine, 1 / 60);
  const pivot = new THREE.Vector3(3, 1, -7);
  near(cameraEntity.object3D.position.distanceTo(pivot), 5, 1e-4, "arm length");
  near(cameraEntity.object3D.position.z, pivot.z + 5, 1e-4, "behind, on +Z at yaw 0");
});

await check("the first frame snaps rather than gliding in from nowhere", () => {
  // A camera that has been idle since level load would otherwise evaluate from
  // a stale position and swoop across the map to catch up.
  const { engine, target, cameraEntity } = rigScene();
  target.object3D.position.set(50, 0, 50);
  addVcam(engine, "Follow", {
    priority: 10,
    follow: target.id,
    body: "orbital",
    distance: 4,
    pitch: 0,
    offset: [0, 0, 0],
    positionDamping: 2,
    verticalDamping: 2,
    collision: false,
  });
  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.distanceTo(target.object3D.position), 4, 1e-4, "already in place");
});

await check("damping makes the camera trail a moving target and then catch up", () => {
  const { engine, target, cameraEntity } = rigScene();
  addVcam(engine, "Follow", {
    priority: 10,
    follow: target.id,
    body: "transposer",
    offset: [0, 0, 5],
    positionDamping: 0.4,
    verticalDamping: 0.4,
    aim: "none",
    collision: false,
  });
  tick(engine, 1 / 60);
  target.object3D.position.set(20, 0, 0);
  tick(engine, 1 / 60);
  const lagging = cameraEntity.object3D.position.x;
  assert.ok(lagging > 0 && lagging < 20, `trails the jump, got x=${lagging}`);
  for (let i = 0; i < 300; i++) tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.x, 20, 1e-2, "and settles on target");
});

await check("warp() drops the camera onto its target immediately", () => {
  const { engine, target, cameraEntity } = rigScene();
  const { vcam } = addVcam(engine, "Follow", {
    priority: 10,
    follow: target.id,
    body: "transposer",
    offset: [0, 0, 5],
    positionDamping: 2,
    verticalDamping: 2,
    aim: "none",
    collision: false,
  });
  tick(engine, 1 / 60);
  target.object3D.position.set(0, 0, 100);
  vcam.warp();
  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.z, 105, 1e-3, "no swoop across the level");
});

await check("aim points the camera's -Z at the look-at target", () => {
  const { engine, target, cameraEntity } = rigScene();
  target.object3D.position.set(0, 0, 0);
  addVcam(engine, "Follow", {
    priority: 10,
    follow: target.id,
    lookAt: target.id,
    body: "transposer",
    offset: [0, 0, 8],
    positionDamping: 0,
    verticalDamping: 0,
    aimDamping: 0,
    aim: "lookAt",
    collision: false,
  });
  tick(engine, 1 / 60);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraEntity.object3D.quaternion);
  near(forward.z, -1, 1e-4, "looking back toward the origin");
  near(forward.x, 0, 1e-4, "and level");
});

await check("the aim offset raises the framing without moving the camera", () => {
  const { engine, target, cameraEntity } = rigScene();
  addVcam(engine, "Follow", {
    priority: 10,
    follow: target.id,
    body: "transposer",
    offset: [0, 0, 8],
    aimOffset: [0, 4, 0],
    positionDamping: 0,
    verticalDamping: 0,
    aimDamping: 0,
    collision: false,
  });
  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.y, 0, 1e-6, "camera stayed level");
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraEntity.object3D.quaternion);
  assert.ok(forward.y > 0.1, `but it looks upward, got y=${forward.y}`);
});

await check("hardLock rides the target exactly — the first-person case", () => {
  const { engine, target, cameraEntity } = rigScene();
  target.object3D.position.set(1, 2, 3);
  target.object3D.rotation.y = Math.PI / 3;
  addVcam(engine, "FPS", {
    priority: 10,
    follow: target.id,
    body: "hardLock",
    offset: [0, 1.7, 0],
    aim: "follow",
    positionDamping: 0,
    verticalDamping: 0,
  });
  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.x, 1, 1e-6, "x");
  near(cameraEntity.object3D.position.y, 3.7, 1e-6, "y (offset applied)");
  near(cameraEntity.object3D.position.z, 3, 1e-6, "z");
  near(cameraEntity.object3D.quaternion.angleTo(target.object3D.quaternion), 0, 1e-6, "and shares its rotation");
});

await check("a transposer offset can be bound to the target's own axes", () => {
  const { engine, target, cameraEntity } = rigScene();
  target.object3D.rotation.y = Math.PI / 2; // facing +X's opposite; local +Z -> world +X
  addVcam(engine, "Over Shoulder", {
    priority: 10,
    follow: target.id,
    body: "transposer",
    bindingMode: "local",
    offset: [0, 0, 5],
    aim: "none",
    positionDamping: 0,
    verticalDamping: 0,
    collision: false,
  });
  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.x, 5, 1e-4, "offset rotated into the target's frame");
  near(cameraEntity.object3D.position.z, 0, 1e-4, "not left along world Z");
});

await check("the boom arm pulls in when a wall is behind the target", () => {
  const { engine, target, cameraEntity } = rigScene();
  // Stub physics: a wall 2m from the pivot, whichever way we look.
  engine.physics = {
    shapecast: () => ({ distance: 2, point: [0, 0, 0], normal: [0, 0, -1], entity: null }),
  };
  addVcam(engine, "Follow", {
    priority: 10,
    follow: target.id,
    body: "orbital",
    distance: 6,
    pitch: 0,
    offset: [0, 0, 0],
    collision: true,
    collisionPadding: 0.1,
  });
  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.distanceTo(target.object3D.position), 1.9, 1e-3, "pulled to just short of the wall");
});

await check("...and eases back out once the wall is gone", () => {
  const { engine, target, cameraEntity } = rigScene();
  let blocked = true;
  engine.physics = {
    shapecast: () => (blocked ? { distance: 2, point: [0, 0, 0], normal: [0, 0, -1], entity: null } : null),
  };
  addVcam(engine, "Follow", {
    priority: 10,
    follow: target.id,
    body: "orbital",
    distance: 6,
    pitch: 0,
    offset: [0, 0, 0],
    collision: true,
    collisionPadding: 0.1,
    collisionRecovery: 0.3,
  });
  tick(engine, 1 / 60);
  blocked = false;
  tick(engine, 1 / 60);
  const partway = cameraEntity.object3D.position.distanceTo(target.object3D.position);
  assert.ok(partway > 1.9 && partway < 6, `eased, not popped, got ${partway}`);
  for (let i = 0; i < 300; i++) tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.distanceTo(target.object3D.position), 6, 1e-2, "back to full length");
});

// ---------------------------------------------------------------------------

section("blending");

await check("switching priority blends rather than cutting", () => {
  const { engine, cameraEntity, brain } = rigScene({ camProps: { blendTime: 1, blendStyle: "linear" } });
  const a = addVcam(engine, "A", { priority: 20, body: "none" });
  const b = addVcam(engine, "B", { priority: 10, body: "none" });
  a.entity.object3D.position.set(0, 0, 0);
  b.entity.object3D.position.set(10, 0, 0);
  a.entity.object3D.updateMatrixWorld(true);
  b.entity.object3D.updateMatrixWorld(true);

  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.x, 0, 1e-6, "starts on A");

  b.vcam.setProp("priority", 30);
  for (let i = 0; i < 30; i++) tick(engine, 1 / 60);
  const midway = cameraEntity.object3D.position.x;
  assert.ok(midway > 2 && midway < 8, `halfway through the blend, got x=${midway}`);
  assert.equal(brain.live, b.vcam, "B is live");

  for (let i = 0; i < 60; i++) tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.x, 10, 1e-4, "and arrives on B");
  assert.equal(brain.blendFrom, null, "with the blend retired");
});

await check("a shot's own blend time overrides the camera's default", () => {
  const { engine, cameraEntity } = rigScene({ camProps: { blendTime: 5, blendStyle: "linear" } });
  const a = addVcam(engine, "A", { priority: 20, body: "none", blendTime: -1 });
  const b = addVcam(engine, "B", { priority: 10, body: "none", blendTime: 0 });
  a.entity.object3D.position.set(0, 0, 0);
  b.entity.object3D.position.set(10, 0, 0);
  a.entity.object3D.updateMatrixWorld(true);
  b.entity.object3D.updateMatrixWorld(true);
  tick(engine, 1 / 60);
  b.vcam.setProp("priority", 30);
  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.x, 10, 1e-6, "blendTime 0 is a hard cut");
});

await check("the first shot of a scene does not blend in from the camera's start pose", () => {
  const { engine, cameraEntity } = rigScene({ camProps: { blendTime: 2 } });
  cameraEntity.object3D.position.set(-100, -100, -100);
  const a = addVcam(engine, "A", { priority: 20, body: "none" });
  a.entity.object3D.position.set(4, 5, 6);
  a.entity.object3D.updateMatrixWorld(true);
  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.x, 4, 1e-6, "cuts straight to the first shot");
});

await check("the field of view blends too", () => {
  const { engine, brain } = rigScene({ camProps: { fov: 60, blendTime: 1, blendStyle: "linear" } });
  const a = addVcam(engine, "Wide", { priority: 20, body: "none", fov: 90 });
  const b = addVcam(engine, "Tele", { priority: 10, body: "none", fov: 30 });
  a.entity.object3D.updateMatrixWorld(true);
  b.entity.object3D.updateMatrixWorld(true);
  tick(engine, 1 / 60);
  near(brain.camera.fov, 90, 1e-4, "starts wide");
  b.vcam.setProp("priority", 30);
  for (let i = 0; i < 30; i++) tick(engine, 1 / 60);
  const mid = brain.camera.fov;
  assert.ok(mid > 35 && mid < 85, `mid-blend focal length, got ${mid}`);
  for (let i = 0; i < 60; i++) tick(engine, 1 / 60);
  near(brain.camera.fov, 30, 1e-3, "and ends telephoto");
});

await check("a shot with no FOV override leaves the camera's own lens alone", () => {
  const { engine, brain } = rigScene({ camProps: { fov: 55 } });
  const a = addVcam(engine, "A", { priority: 20, body: "none", fov: 0 });
  a.entity.object3D.updateMatrixWorld(true);
  tick(engine, 1 / 60);
  near(brain.camera.fov, 55, 1e-6, "unchanged");
});

await check("a camera parented under a moving object still lands where the shot says", () => {
  // The pose is world-space; the entity transform is parent-relative. Skipping
  // the conversion offsets the camera by its parent's transform, twice.
  const engine = new Engine();
  const rig = engine.createEntity({ name: "Vehicle" });
  rig.object3D.position.set(100, 0, 0);
  const cameraEntity = engine.createEntity({ name: "Cam", parent: rig });
  cameraEntity.addComponent("camera", {});
  const shot = addVcam(engine, "Shot", { priority: 10, body: "none" });
  shot.entity.object3D.position.set(7, 3, -2);
  shot.entity.object3D.updateMatrixWorld(true);
  engine.playing = true;
  tick(engine, 1 / 60);
  cameraEntity.object3D.updateMatrixWorld(true);
  const world = cameraEntity.object3D.getWorldPosition(new THREE.Vector3());
  near(world.x, 7, 1e-4, "world x");
  near(world.y, 3, 1e-4, "world y");
  near(world.z, -2, 1e-4, "world z");
});

// ---------------------------------------------------------------------------

section("shake");

await check("an impulse displaces the live camera and then lets it settle back", () => {
  const { engine, cameraEntity } = rigScene();
  const a = addVcam(engine, "A", { priority: 20, body: "none" });
  a.entity.object3D.position.set(0, 0, 0);
  a.entity.object3D.updateMatrixWorld(true);
  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.length(), 0, 1e-9, "still to begin with");

  engine.cameraImpulse.emit({ magnitude: 0.5, duration: 0.4, frequency: 20 });
  tick(engine, 1 / 60);
  assert.ok(cameraEntity.object3D.position.length() > 0, "shaken");
  for (let i = 0; i < 40; i++) tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.length(), 0, 1e-9, "and back to rest");
});

await check("shake scale turns it down without touching the impulse", () => {
  const measure = (shake) => {
    const { engine, cameraEntity } = rigScene({ camProps: { shake } });
    const a = addVcam(engine, "A", { priority: 20, body: "none" });
    a.entity.object3D.updateMatrixWorld(true);
    tick(engine, 1 / 60);
    engine.cameraImpulse.emit({ magnitude: 0.5, duration: 0.4, frequency: 20 });
    tick(engine, 1 / 60);
    return cameraEntity.object3D.position.length();
  };
  const full = measure(1);
  const half = measure(0.5);
  near(half, full * 0.5, 1e-6, "half the shake");
  near(measure(0), 0, 1e-9, "and zero disables it");
});

await check("an Impulse Source fires from where its entity is", () => {
  const { engine } = rigScene();
  const source = engine.createEntity({ name: "Explosion" });
  source.object3D.position.set(12, 0, -4);
  const impulse = source.addComponent("impulsesource", { magnitude: 0.6, radius: 20 });
  const emitted = impulse.fire();
  assert.ok(emitted, "returns the impulse it made");
  near(emitted.position.x, 12, 1e-6, "at the entity's world position");
  near(emitted.magnitude, 0.6, 1e-9, "with the authored magnitude");
  const stronger = impulse.fire({ magnitude: 2 });
  near(stronger.magnitude, 2, 1e-9, "and per-shot overrides apply");
  assert.equal(engine.cameraImpulse.count, 2);
});

await check("a directional source kicks along its own facing", () => {
  const { engine } = rigScene();
  const source = engine.createEntity({ name: "Recoil" });
  source.object3D.rotation.y = Math.PI / 2; // local -Z now points at world -X
  source.object3D.updateMatrixWorld(true);
  const impulse = source.addComponent("impulsesource", { directional: true, direction: [0, 0, -1] });
  const emitted = impulse.fire();
  near(emitted.direction.x, -1, 1e-6, "rotated into world space");
  near(emitted.direction.z, 0, 1e-6, "not left along world -Z");
});

await check("leaving Play mode clears every live impulse", () => {
  const { engine } = rigScene();
  engine.cameraImpulse.emit({ magnitude: 1, duration: 10 });
  assert.equal(engine.cameraImpulse.count, 1);
  engine.setPlaying(false);
  assert.equal(engine.cameraImpulse.count, 0, "the editor viewport must not keep rattling");
});

// ---------------------------------------------------------------------------

section("editor safety");

await check("the rig does not move the camera in the editor by default", () => {
  const { engine, cameraEntity } = rigScene();
  engine.playing = false;
  cameraEntity.object3D.position.set(1, 2, 3);
  const shot = addVcam(engine, "A", { priority: 10, body: "none" });
  shot.entity.object3D.position.set(50, 50, 50);
  shot.entity.object3D.updateMatrixWorld(true);
  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.x, 1, 1e-9, "authored transform untouched");
});

await check("preview moves it, and turning preview off puts it back", () => {
  const { engine, cameraEntity, brain } = rigScene({ camProps: { previewRigInEditor: true } });
  engine.playing = false;
  cameraEntity.object3D.position.set(1, 2, 3);
  const shot = addVcam(engine, "A", { priority: 10, body: "none" });
  shot.entity.object3D.position.set(50, 50, 50);
  shot.entity.object3D.updateMatrixWorld(true);
  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.x, 50, 1e-6, "preview shows the framing");
  brain.setProp("previewRigInEditor", false);
  tick(engine, 1 / 60);
  near(cameraEntity.object3D.position.x, 1, 1e-6, "and the authored pose is restored");
  near(cameraEntity.object3D.position.z, 3, 1e-6, "exactly");
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall camera rig checks passed");
process.exit(failures ? 1 : 0);
