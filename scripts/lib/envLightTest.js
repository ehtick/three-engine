// Headless check: does the scene-settings HDRI actually light shadowed surfaces?
// Same path the editor uses (applySettingsToScene -> loadEnvironmentAsset), a sun at the
// user's intensity, a grey standard sphere + ground, and screen points on the lit side,
// the shadow side and the cast shadow.
import { Engine, THREE, registerBuiltInComponents } from '/src/engine/index.js';
import { applySettingsToScene } from '/src/engine/sceneSettings.js';

const W = 960, H = 540;
export async function setup(canvas) {
  registerBuiltInComponents();
  const engine = new Engine(); engine.setSize(W, H);
  await engine.init(canvas);
  const renderer = engine.renderer, scene = engine.scene;
  const sun = new THREE.DirectionalLight('#ffffff', 20);
  sun.position.set(-6, 10, 4); sun.target.position.set(0, 0, 0);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: .1, far: 40 });
  scene.add(sun, sun.target);
  const grey = new THREE.MeshStandardNodeMaterial({ color: '#b0b0b0', roughness: .9, metalness: 0 });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.2, 48, 24), grey);
  sphere.position.set(0, 1.2, 0); sphere.castShadow = sphere.receiveShadow = true; scene.add(sphere);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), grey);
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const camera = new THREE.PerspectiveCamera(45, W / H, .05, 200);
  camera.position.set(4.5, 3.2, -6); camera.lookAt(0, 1, 0);
  engine.camera = camera; scene.add(camera);
  const ambient = engine.ambientLight ?? new THREE.AmbientLight('#ffffff', 0);
  if (!ambient.parent) scene.add(ambient);

  const settingsFor = ({ env, ambientIntensity = 0, toneMapping = 'neutral' }) => ({
    background: '#202329', ambientColor: '#ffffff', ambientIntensity,
    environment: { cubemap: env ? '/artifacts/env-test/kloofendal.hdr' : '', background: true, lighting: true, intensity: 1, rotation: 0, blur: 0 },
    fog: { type: 'none' }, toneMapping, exposure: 1, shadows: true,
    shadow: { type: 'PCFSoftShadowMap', autoUpdate: true, needsUpdate: false },
  });
  const project = p => { const v = new THREE.Vector3(...p).project(camera); return [Math.round((v.x + 1) / 2 * W), Math.round((1 - v.y) / 2 * H)]; };
  const sunDir = sun.position.clone().sub(sun.target.position).normalize();
  const points = {
    sphereLit: project(sphere.position.clone().addScaledVector(sunDir, 1.19).toArray()),
    sphereShadow: project(sphere.position.clone().addScaledVector(sunDir, -1.19).add(new THREE.Vector3(0, 0, 0)).toArray()),
    groundLit: project([3, 0, -2.5]),
    groundShadow: project(new THREE.Vector3(0, 1.2, 0).addScaledVector(sunDir, -1.2 / sunDir.y).setY(0).toArray()),
  };
  const run = async (arm) => {
    applySettingsToScene(settingsFor(arm), scene, ambient, renderer);
    const until = performance.now() + 15000;
    while (arm.env && !scene.environment && performance.now() < until) await new Promise(r => setTimeout(r, 100));
    for (let i = 0; i < 6; i++) { await renderer.compileAsync(scene, camera); renderer.render(scene, camera); await renderer.backend.device.queue.onSubmittedWorkDone(); }
    const env = scene.environment;
    let maxValue = null, nonFinite = 0;
    if (env?.image?.data) {
      const d = env.image.data, half = env.type === THREE.HalfFloatType;
      const decode = half ? v => THREE.DataUtils.fromHalfFloat(v) : v => v;
      maxValue = 0;
      for (let i = 0; i < d.length; i += 4 * 7) { const v = decode(d[i]); if (!Number.isFinite(v)) nonFinite++; else maxValue = Math.max(maxValue, v); }
    }
    return { arm, points, environment: env ? { type: env.type, half: env.type === THREE.HalfFloatType, mapping: env.mapping, size: [env.image?.width, env.image?.height], maxValue, nonFinite } : null,
      environmentIntensity: scene.environmentIntensity, environmentNode: !!scene.environmentNode, background: scene.background?.isTexture ? 'texture' : scene.background?.isColor ? 'color' : String(scene.background) };
  };
  return { run };
}
