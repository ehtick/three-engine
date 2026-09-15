import * as THREE from "three/webgpu";
import {
  Fn, If, float, int, uint, ivec2, ivec3, vec2, vec3, vec4, uniform, uniformArray, instanceIndex, instancedArray, texture, textureLoad, textureStore, storageTexture,
  workgroupArray, workgroupBarrier, localId, workgroupId, select, atan, cameraPosition, positionWorld, positionGeometry, mix, varying, uv as uvAttribute,
  modelWorldMatrixInverse, modelWorldMatrix, normalize, cross, atomicAdd, atomicStore, atomicLoad, transformNormalToView,
} from "three/tsl";
import { GRAVITY, cascadeBands, cascadeScales, foldingLimit, gaussianNoise, seaSettings, spectrumMoments } from "./waterSpectrumCPU.js";
import { releaseComputeNodes, releaseStorageAttributes } from "../../modules/gi/releaseCompute.js";
import { mipmapBlitter } from "./gpuMipmaps.js";
import { createTextureReadback, createBufferReadback } from "./gpuReadback.js";
import { createFoamFlow } from "./waterFoamFlow.js";

/**
 * ══ THE SPECTRAL SEA, ON THE GPU ═══════════════════════════════════════════
 *
 * Popov72/OceanDemo's ocean (Babylon, MIT) rebuilt in TSL: a JONSWAP/TMA
 * spectrum realized once per settings change, evolved every frame by the
 * dispersion relation, inverse-transformed back to space and merged into the
 * three maps everything else reads — DISPLACEMENT (x, y, z, foam memory),
 * DERIVATIVES (the slopes the normal is built from) and, in `.w`, the JACOBIAN
 * TURBULENCE that says where the surface folded and how long ago.
 *
 * Three CASCADES tile the world at three length scales (250 : 17 : 5, hung
 * from the authored peak wavelength) so the swell, the wind chop and the
 * capillary texture each get a full 256² of spectrum. They tile in WORLD
 * metres, which is the whole point for this engine: the same sea state on a
 * 5 m pool and a 500 m lake, because neither knows how big its box is.
 *
 * `waterSpectrumCPU.js` is the specification: every formula here is the same
 * one, and `scripts/water-spectrum-smoke.html` diffs the two.
 *
 * ── THE TRANSFORM IS TWO DISPATCHES PER CASCADE, NOT SIXTEEN ──────────────
 *
 * Babylon runs log₂N ping-pong passes per direction — 32 tiny dispatches per
 * cascade per frame, which in three is 32 bind-group updates on the CPU
 * every frame. Here each workgroup owns one ROW (or column) in shared memory:
 * 128 threads load it bit-reversed, run the eight butterfly stages with a
 * barrier between them, and write it back. Both packed maps ride in the same
 * kernel, so a cascade's whole 2-D transform is `fftRows` + `fftCols`.
 *
 * ⚠ DISPATCHED BY WORKGROUP COUNT, NOT BY THREAD COUNT. `.compute(number)`
 * makes three prepend `if (index >= count) return;`, and a return before a
 * `workgroupBarrier()` is non-uniform control flow — the shader does not
 * compile. An ARRAY count is a dispatch size and adds no return.
 */
export const SEA_SIZE = 256;
/** How much sea a build quality buys: cascades × resolution. One model, sized
 *  to the device — a phone runs two 128² cascades of the same spectrum. */
export function seaQuality(quality = "high") {
  // ⚠ THE DEVICE CAPS THE TIER. A build's quality is a ship-time choice; a
  // phone that opens it runs the same "ultra" — 3 × 256² cascades, a 1024²
  // foam map behind 131 k particles, 32 k spray drops × 4 billboards, a
  // 256² fluid and a 96 × 32 × 96 spray grid — and read 20 fps on an
  // iPhone (user, 2026-09-07). A phone is capped at `low`, a tablet at
  // `medium`, whatever the build says; the sea itself looks the same.
  // ⚠ THE PARTICLE POOLS ARE NOT TIERED. "Have you cut the number of splash
  // particles on mobile? Please don't, it looks bad" (user, 2026-09-07): the
  // foam and spray pools and the sprites per drop are the ultra count on
  // every device; the tier cuts the sea's cascades, the foam map and the
  // spray grid — the parts the eye cannot count.
  const capped = capQualityForDevice(quality);
  // The foam MAP keeps its 1024² too: at 256² a texel is 2 m of sea and a
  // near particle's disc falls between texel centres — "foam looks almost
  // absent on mobile" (user, 2026-09-07).
  return { low: { size: 128, cascadeCount: 2, foamSize: 1024, sprayGrid: 48 }, medium: { size: 128, cascadeCount: 3, foamSize: 1024, sprayGrid: 64 } }[capped]
    ?? { size: SEA_SIZE, cascadeCount: 3, foamSize: 1024, sprayGrid: 96 };
}
const QUALITY_ORDER = ["low", "medium", "high", "ultra"];
/** The device's ceiling on a quality tier: phones `low`, tablets `medium`. */
export function capQualityForDevice(quality) {
  const ceiling = waterDeviceTier();
  const want = QUALITY_ORDER.indexOf(quality), cap = QUALITY_ORDER.indexOf(ceiling);
  if (want < 0 || cap < 0) return quality;
  return QUALITY_ORDER[Math.min(want, cap)];
}
export function waterDeviceTier() {
  if (globalThis.__waterDeviceTier) return globalThis.__waterDeviceTier;   // a harness or a test may pin it
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const touch = typeof navigator !== "undefined" ? navigator.maxTouchPoints || 0 : 0;
  if (/iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return "low";
  if (/iPad|Android/i.test(ua) || (touch > 1 && /Mac/i.test(ua))) return "medium";   // an iPad reports as a Mac with touch
  return "ultra";
}
/**
 * ══ THE WHITECAP MEMORY (2026-09-07) ══════════════════════════════════════
 *
 * "Our default ocean looks pathetic" — a 500 m sea with soft foam blobs in
 * the 32 m ripple window and NOTHING beyond it. The per-pixel whitecap gate
 * (`seaFoamNode` on the composed Jacobian) is instantaneous and reads the
 * cascades at the pixel's own mip, and a filtered Jacobian averages toward 1:
 * past a few tens of metres the gate can never open, so the far sea is glass
 * while the reference (Popov72/OceanDemo) carries streaky foam to the
 * horizon. Its foam is a MEMORY — "turbulence", the Jacobian's deficit
 * integrated over seconds and decaying — and a memory mip-filters as a
 * COVERAGE, which is exactly what the distance needs.
 *
 * So the sea keeps one: a camera-following window of FOAM_WINDOW_METRES
 * (texel-snapped, like the caustic and ripple windows) over the COMPOSED
 * Jacobian — never per cascade, see the ⛔ below — where each texel holds
 * max(whitecap now, last frame's value × decay). A crest that folds leaves
 * a trail as it travels: the streaks. The lid reads it per pixel
 * (`waterFoam.js`) and per vertex (the solver's far-foam seed), the ripple
 * window's field remains the near-field memory a splash writes into.
 */
export const FOAM_WINDOW_METRES = 512;
/**
 * ══ FOAM IS PARTICLES (2026-09-07, after Gao, Tessendorf & Reinhardt 2021,
 * "Foam, Splash, and Rippling for Spectrum-Based Ocean Surfaces") ═════════
 *
 * The grid memory (max of the gate, decaying, shifted whole texels) gave
 * patches with hard edges that could only smear ("foam still looks awful",
 * user). The paper's model, which the reference footage matches: foam is
 * PARTICLES. They are emitted where the MINIMUM EIGENVALUE of the
 * horizontal displacement's Jacobian falls under a threshold (a fold along
 * one direction, which the determinant alone can miss), spread along the
 * crest — the Jacobian's maximum eigenvector — by a random distance (the
 * whitecap coverage rule), live a random half-to-full lifetime, fade out,
 * and ride the SURFACE'S OWN HORIZONTAL VELOCITY (the time derivative of
 * the displacement, one more FFT per cascade): the filaments and holes of
 * real foam emerge from that advection alone. A hull's waterline hands the
 * pool seeds too. Each frame the live particles are splatted into the
 * whitecap map as soft discs (a render target over the window, additive),
 * and the lid reads the map exactly as it read the memory.
 */
export const FOAM_LIFE_SECONDS = 9;
/** Particles a hull seed asks per square metre per second at full value
 *  (24: a hull's seeds are small discs at low values, and the foam dial's
 *  three-halves power sits on top — "still no foam tail", user, 2026-09-07). */
export const FOAM_SEED_DENSITY = 8;
/**
 * ⛔ PRODUCTION IS A RATE PER SQUARE METRE, NOT A SHARE OF THE POOL. As a
 * share of the dead particles it was bounded by nothing but the pool, and
 * the pool filled to its cap: a leopard skin from the eye to the horizon,
 * a stationary churn of births and deaths, a hull's seeds starved (user,
 * 2026-09-07). A fold is probed FOAM_RATE times a square metre a second,
 * whatever the pool; the density gate stops it at white.
 */
export const FOAM_RATE = 16;
/**
 * A speck's size grows with its distance from the eye — a hundredth of it
 * and a bit — and its birth chance falls with the square of that, so the
 * COVERAGE per square metre is the same at 250 m as at 5 m while the pool
 * carries a few thousand specks instead of a million: the reference is
 * "more small dots than large white blobs" (user, 2026-09-07), and a dot
 * finer than a pixel is a coverage the mips carry anyway.
 */
export const FOAM_SIZE_PER_METRE = .025;
/** The share of a frame's splats the map takes; the rest is last frame's. */
export const FOAM_CARRY = .3;
/**
 * ⛔ THE FOAM DIAL IS A COVERAGE TARGET, NOT A THRESHOLD. A fixed fold
 * threshold gave the harness's preset a sparse sea at 0.5 and the user's
 * steeper sea a white one at 0.3 ("this is 0.3, which is already too
 * much", 2026-09-07): how much of a sea folds under a given threshold is
 * the sea state's business. The foam step's probes are uniform over the
 * window, so the share of them that fold IS the folding fraction of the
 * area; a slow controller (every readback, 20 frames) moves the threshold
 * until that fraction is FOAM_COVERAGE × the dial — 4 % of the area at 1
 * (the trails spread it to a storm's whitecaps), 0.4 % at 0.1 — whatever
 * the waves ("I don't want to depend on those, only on the Foam
 * parameter", user).
 */
export const FOAM_COVERAGE = .04;
/**
 * ══ SPLASH (the paper's second particle system) ═════════════════════════
 * Spray is thrown where a crest folds hard (a stricter threshold than the
 * foam's) — on the front face, with the surface velocity, forward along the
 * wave and up at a speed set by the sea's height, plus Gaussian turbulence
 * (the paper's velocity rules; its PIC/FLIP is what the turbulence at
 * emission makes unnecessary, as the paper itself reports) — and where a
 * body enters the water (waterPhysics.js `addWaterSplash`: a crown at the
 * entry speed). A splash particle flies ballistic in the sea's own time,
 * and where it meets the surface it dies and leaves a RETURN the foam pool
 * reads the same frame: the secondary foam of air entrapment.
 */
/** Spray is thrown within this of the eye (a drop is a few pixels beyond). */
export const SPLASH_REACH_METRES = 80;
/** Billboards drawn per splash particle: a drop is a cloud of drops. */
export const SPLASH_SPRITES = 4;
/**
 * ══ THE SPRAY'S GRID (a PIC/FLIP-lite, after grantkot's liquid) ═══════════
 * "Can we add a bit of fluid motion to them?" A drop flying alone is a
 * bead; water flies as SHEETS and TENDRILS because neighbouring parcels
 * share a velocity and pull on each other. So the spray keeps a 3D grid
 * around the eye (SPRAY_GRID² × SPRAY_GRID_Y cells of SPRAY_CELL metres):
 * each frame every drop scatters its velocity, its position and a count
 * into its cell (fixed-point atomics), and then gathers its cell's and
 * six neighbours': it blends a third of the way toward the shared
 * velocity (PIC), is pulled toward the neighbourhood's centre of mass
 * while the cell is loosely filled (cohesion — the tendril) and pushed
 * away from it when it is packed (pressure — the sheet). Two dispatches
 * of the pool and a clear a frame.
 */
export const SPRAY_GRID = 96, SPRAY_GRID_Y = 32, SPRAY_CELL = .25, SPRAY_GRID_FLOOR = -2;
export const SPRAY_PIC = .35, SPRAY_COHESION = 2.5, SPRAY_PACKED = 10, SPRAY_PRESSURE = .6;
/** Babylon's LOD scale: a cascade fades out of the shading normal past
 *  LOD_SCALE × L metres from the eye, where its texels are under a pixel. */
export const LOD_SCALE = 7.13;
/**
 * ⛔ NO PER-CASCADE FOAM MEMORY, AND NO PER-CASCADE JACOBIAN. Babylon keeps a
 * "turbulence" memory of each cascade's own Jacobian and sums them. A fine
 * cascade's own horizontal gradient is large (it scales with k²·h), so on any
 * choppy sea it "folds" at the centimetre scale constantly — while the
 * COMPOSED surface does nothing of the kind — and the sum whited out the
 * whole pool. The fold test belongs to the sum of the cascades' gradients,
 * taken where the surface is composed (`seaJacobianAt`, in the solver's
 * surface kernel), and the memory belongs to the solver's persistent foam
 * field, which already spreads and dissolves a wake's foam. So the maps carry
 * the ingredients: derivatives (Dyx, Dyz, λDxx, λDzz) and, in
 * displacement.w, λDxz.
 */

/**
 * ⚠ THE TWO OUTPUT MAPS ARE TEXTURE ARRAYS, ONE LAYER PER CASCADE — because
 * the water FRAGMENT binds them, and it already binds the medium's four slot
 * maps, the depth texture, the mirror, the transmission target, the shadow
 * maps, GI's and the environment: three separate derivative textures took it
 * to **18 sampled textures against the portable 16** and the water's pipeline
 * refused to build in the editor. One array is one binding.
 */
function storageMap(size, { half = false, mips = false, name = "", layers = 0 } = {}) {
  const t = layers ? new THREE.StorageArrayTexture(size, size, layers) : new THREE.StorageTexture(size, size);
  t.type = half ? THREE.HalfFloatType : THREE.FloatType;
  t.format = THREE.RGBAFormat;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.name = name;
  return t;
}

// ── THE SPECTRUM, IN TSL (see waterSpectrumCPU.js for the same in JS) ────────
const frequencyNode = (k, depth) => k.mul(GRAVITY).mul(k.mul(depth).min(20).tanh()).sqrt();
const frequencyDerivativeNode = (k, depth) => {
  const kd = k.mul(depth).min(20), th = kd.tanh(), ch = kd.cosh();
  return depth.mul(k).div(ch).div(ch).add(th).mul(GRAVITY).div(frequencyNode(k, depth)).mul(.5);
};
const normalisationFactorNode = (s) => {
  const s2 = s.mul(s), s3 = s2.mul(s), s4 = s3.mul(s);
  const low = s4.mul(-.000564).add(s3.mul(.00776)).sub(s2.mul(.044)).add(s.mul(.192)).add(.163);
  const high = s4.mul(-4.8e-8).add(s3.mul(1.07e-5)).sub(s2.mul(9.53e-4)).add(s.mul(5.9e-2)).add(3.93e-1);
  return select(s.lessThan(5), low, high);
};
const spreadPowerNode = (omega, peakOmega) => select(omega.greaterThan(peakOmega),
  omega.div(peakOmega).abs().pow(-2.5).mul(9.77), omega.div(peakOmega).abs().pow(5).mul(6.97));
const directionNode = (theta, omega, peakOmega, pars) => {
  const s = spreadPowerNode(omega, peakOmega).add(omega.div(peakOmega).min(20).tanh().mul(16).mul(pars.swell).mul(pars.swell));
  const iso = theta.cos().mul(theta.cos()).mul(2 / Math.PI);
  const cos2s = normalisationFactorNode(s).mul(theta.sub(pars.angle).mul(.5).cos().abs().pow(s.mul(2)));
  return iso.add(cos2s.sub(iso).mul(pars.spreadBlend));
};
const tmaNode = (omega, depth) => {
  const omegaH = omega.mul(depth.div(GRAVITY).sqrt());
  return select(omegaH.lessThanEqual(1), omegaH.mul(omegaH).mul(.5),
    select(omegaH.lessThan(2), float(1).sub(float(2).sub(omegaH).pow(2).mul(.5)), float(1)));
};
const jonswapNode = (omega, depth, peakOmega, pars) => {
  const sigma = select(omega.lessThanEqual(peakOmega), float(.07), float(.09));
  const r = omega.sub(peakOmega).pow(2).div(sigma.mul(sigma).mul(2)).div(peakOmega.mul(peakOmega)).negate().exp();
  const oneOverOmega = float(1).div(omega), peakOver = peakOmega.div(omega);
  return pars.scale.mul(tmaNode(omega, depth)).mul(GRAVITY * GRAVITY).mul(oneOverOmega.pow(5))
    .mul(peakOver.pow(4).mul(-1.25).exp()).mul(pars.gamma.abs().pow(r));
};
/** S(k, θ)·|dω/dk|/k — the variance density per Δk² cell, as on the CPU. */
const spectrumNode = (kx, kz, k, u) => {
  const omega = frequencyNode(k, u.depth);
  const theta = atan(kz, kx);
  let s = float(0);
  for (const pars of u.spectra) s = s.add(jonswapNode(omega, u.depth, u.peakOmega, pars).mul(directionNode(theta, omega, u.peakOmega, pars)));
  s = s.mul(select(k.greaterThan(u.kPeak), k.div(u.kPeak).pow(u.tilt), float(1)));
  // Short waves (k > 4·kp, blended over an octave) scale with `rippleStrength`.
  const short = k.div(u.kPeak).sub(2).div(4).clamp(0, 1);
  s = s.mul(float(1).add(u.ripple.sub(1).mul(short.mul(short).mul(float(3).sub(short.mul(2))))));
  s = s.mul(k.div(u.kMax).pow(4).negate().exp());
  return s.mul(frequencyDerivativeNode(k, u.depth).abs()).div(k);
};

const cmul = (a, b) => vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));

/**
 * One in-place radix-2 transform over every row (or column) of two packed
 * maps, unnormalized, positive exponent. Bit reversal happens on the load.
 */
/**
 * One dispatch transforms every LANE (a source/destination texture pair) at
 * once through its own workgroup array — three lanes are 12 KB of the
 * 16 KB shared memory. The velocity (a third lane) used to be two dispatches
 * of its own per cascade: six a frame, ~a third of the FFT's time, gone.
 */
function fftKernel(srcs, dsts, horizontal, size) {
  const LOG2 = Math.log2(size), HALF = size / 2;
  return Fn(() => {
    const lanes = srcs.map((src, n) => [workgroupArray("vec4", size), src, dsts[n]]);
    const t = localId.x.toInt().toVar();
    const line = workgroupId.x.toInt().toVar();
    const coord = (i) => (horizontal ? ivec2(i, line) : ivec2(line, i));
    const reversed = (v) => {
      let r = int(0), x = v;
      for (let b = 0; b < LOG2; b++) { r = r.shiftLeft(int(1)).bitOr(x.bitAnd(int(1))); x = x.shiftRight(int(1)); }
      return r;
    };
    const i0 = t, i1 = t.add(int(HALF));
    for (const [sh, src] of lanes) {
      sh.element(i0).assign(textureLoad(src, coord(reversed(i0))));
      sh.element(i1).assign(textureLoad(src, coord(reversed(i1))));
    }
    workgroupBarrier();
    for (let stage = 1; stage <= LOG2; stage++) {
      const half = 1 << (stage - 1), span = 1 << stage;
      const group = t.div(int(half)), pos = t.mod(int(half));
      const i = group.mul(int(span)).add(pos).toVar(), j = i.add(int(half)).toVar();
      const ang = pos.toFloat().mul(2 * Math.PI / span);
      const w = vec2(ang.cos(), ang.sin()).toVar();
      for (const [sh] of lanes) {
        const a = sh.element(i).toVar(), b = sh.element(j).toVar();
        const bw = vec4(cmul(b.xy, w), cmul(b.zw, w)).toVar();
        sh.element(i).assign(a.add(bw));
        sh.element(j).assign(a.sub(bw));
      }
      workgroupBarrier();
    }
    for (const [sh, , dst] of lanes) {
      textureStore(dst, coord(i0), sh.element(i0));
      textureStore(dst, coord(i1), sh.element(i1));
    }
  })().compute([size, 1, 1], [HALF, 1, 1]);
}

/**
 * The sea: `configure(props, depthMetres)` re-realizes the spectrum,
 * `tick(renderer, dt, time)` advances it. `cascades[i]` exposes the maps.
 */
export function createWaterSpectrum(seaQualityOptions = {}) {
  const { size = SEA_SIZE, cascadeCount = 3, seed = 1337, foamSize = 1024 } = seaQualityOptions;
  const noiseData = gaussianNoise(size, seed);
  const noise = new THREE.DataTexture(noiseData, size, size, THREE.RGFormat, THREE.FloatType);
  noise.minFilter = noise.magFilter = THREE.NearestFilter;
  noise.needsUpdate = true;

  const u = {
    time: uniform(0), dt: uniform(0), lambda: uniform(.35),
    // ── THE CURRENT (2026-09-07) ──────────────────────────────────────────
    // "I want to make it look like the boat is floating, without actually
    // moving it, so I need to scroll the ocean." Every sample of the sea is
    // taken at world + scroll, and scroll advances by the authored current
    // (metres per second) each tick: the sea streams under a fixed lid —
    // geometry, normals, whitecaps, caustics and the buoyancy query alike.
    scroll: uniform(new THREE.Vector2(0, 0)),
    depth: uniform(20), peakOmega: uniform(1), kPeak: uniform(1), kMax: uniform(10), tilt: uniform(0), ripple: uniform(1),
    spectra: [0, 1].map(() => ({ scale: uniform(1), angle: uniform(0), spreadBlend: uniform(1), swell: uniform(.3), gamma: uniform(3.3) })),
  };
  const index = instanceIndex.toInt();
  const px = index.mod(size), py = index.div(size);
  const texel = ivec2(px, py);
  const sign = select(px.add(py).bitAnd(int(1)).equal(int(1)), float(-1), float(1));
  const displacement = storageMap(size, { half: true, mips: true, layers: cascadeCount, name: "sea displacement" });
  const derivatives = storageMap(size, { half: true, mips: true, layers: cascadeCount, name: "sea derivatives" });
  // The surface's horizontal VELOCITY (λ·∂D/∂t, metres per second, the
  // sea's own time) — what the foam particles ride. One more FFT chain.
  const velocity = storageMap(size, { half: true, mips: false, layers: cascadeCount, name: "sea velocity" });
  // ── THE FOAM MAP AND THE PARTICLE POOL ───────────────────────────────
  // The map is a render target the live particles are splatted into every
  // frame; its mips are the coverage the distance reads. ⚠ The mip chain is
  // ALLOCATED through `mipmaps.length` with `generateMipmaps` false: three
  // regenerates a render target's mips after every render with a pass that
  // allocates a view and a bind group per level (the descriptor-heap OOM of
  // gpuMipmaps.js); ours are blitted by `generateMipmaps` below instead.
  // Two targets, ping-ponged: the map is an EXPONENTIAL MOVING AVERAGE of
  // the splats over frames — Sea of Thieves' "progressively blur with
  // feedback". A dense tail's mask fluttered ±20 % a frame as its specks
  // moved and were born, and the lace dissolve flipped cells with it
  // ("appears/disappears rapidly, mostly on the boat's tail", user,
  // 2026-09-07); the carry holds (1 − FOAM_CARRY) of last frame's map at
  // the same world position and the splats add FOAM_CARRY of this frame's.
  const foamTargets = [0, 1].map((k) => {
    const target = new THREE.RenderTarget(foamSize, foamSize, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    target.texture.name = `sea foam ${k}`;
    target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
    target.texture.mipmaps = Array.from({ length: Math.floor(Math.log2(foamSize)) + 1 }, (_, i) => ({ width: foamSize >> i, height: foamSize >> i }));
    return target;
  });
  let foamPhase = 0;
  let foamTarget = foamTargets[0];
  // Reused across frames: `displacement`/`derivatives` never change identity,
  // only the foam slot (index 2) ping-pongs — was a fresh `[a, b, c]` literal
  // allocated every `generateMipmaps()` call.
  const mipTargets = [displacement, derivatives, foamTarget.texture];
  // The pool is sized to the map: 128 k particles behind a 1024² map (a
  // 4 % whitecap coverage of the window is ~10 k m², three discs deep).
  const particleCount = seaQualityOptions.particles ?? (1024 * 1024) >> 3;   // the ultra pool on every tier (see seaQuality)
  const f = {
    size: foamSize, center: uniform(new THREE.Vector2(0, 0)), half: uniform(FOAM_WINDOW_METRES / 2),
    texel: uniform(FOAM_WINDOW_METRES / foamSize),
    gate: uniform(.25), lods: Array.from({ length: cascadeCount }, () => uniform(0)),
    // Foam handed to the pool from outside — a hull's waterline (x, z, a
    // radius in the sea's metres, an acceptance 0–1 against the frame's
    // busiest seed): the tail a boat trails ("there must be a tail behind
    // the boat", user, 2026-09-07). `seedTry` is the share of the pool that
    // probes a seed this frame, sized on the CPU to the foam the seeds ask.
    seedRows: Array.from({ length: 64 }, () => new THREE.Vector4()),
    seedCount: uniform(0, "int"), seedTry: uniform(0),
    // The particle step: the frame's seconds, the sea's time scale, a frame
    // counter for the hashes, the current (m/s), the fold threshold on the
    // minimum eigenvalue, the share of dead particles that probe for a fold
    // this frame (the production rate), the spread along the crest and the
    // disc a particle splats (both metres, from the peak wavelength).
    dt: uniform(0), timeScale: uniform(1), frame: uniform(0, "uint"), currentVel: uniform(new THREE.Vector2(0, 0)),
    threshold: uniform(.55), tryRate: uniform(.3), rippleTry: uniform(0), spread: uniform(2.5), disc: uniform(1.2),
    // The density gate's cap (how white a sheet may get), from the foam dial.
    cap: uniform(.9),
    // Last frame's window centre (the carry samples the old map there).
    prevCenter: uniform(new THREE.Vector2(0, 0)),
    // A particle's full life, real seconds: twice the peak period (a crest
    // outruns the foam it made; the trail is what the wind streaks are).
    life: uniform(FOAM_LIFE_SECONDS), baseLife: FOAM_LIFE_SECONDS,
    zeroLods: Array.from({ length: cascadeCount }, () => uniform(0)),
  };
  f.seeds = uniformArray(f.seedRows, "vec4");
  // (x, z, age, life) and (intensity, size factor, 0, 0). Age ≥ life is dead.
  const particles = instancedArray(particleCount, "vec4");
  const particleAux = instancedArray(particleCount, "vec4");
  let particlesReady = false;
  // How many are alive (an atomic the step counts, read back every few
  // frames): the seeds' probes are sized to the DEAD, not to the pool, so a
  // hull's tail and a splash's foam still come when the sea is busy.
  const liveCounter = instancedArray(new Uint32Array(4), "uint").toAtomic();
  let liveEstimate = 0, liveReadPending = false, liveReadFrame = 0, liveReader = null, seaReader = null;
  let foldProbes = 0, foldHits = 0, lastGate = -1;
  // The splash pool: (x, y, z, age), (vx, vy, vz, life), (intensity, size),
  // and the RETURNS — a particle that met the surface this frame leaves
  // (x, z, intensity, 1) in its own slot, which the foam step reads.
  const splashCount = Math.max(1024, particleCount >> 2);
  const sprayGridN = seaQualityOptions.sprayGrid ?? SPRAY_GRID, sprayGridY = Math.max(8, sprayGridN >> 2 | 0) + (sprayGridN >> 3 | 0), spriteCount = seaQualityOptions.sprites ?? SPLASH_SPRITES;
  const splash = instancedArray(splashCount, "vec4");
  const splashVel = instancedArray(splashCount, "vec4");
  const splashAux = instancedArray(splashCount, "vec4");
  const returns = instancedArray(splashCount, "vec4");
  // The spray's grid: per cell Σv (×256, ints), count; Σp relative to the
  // cell's corner (×256). Fixed-point atomics.
  const sprayCells = sprayGridN * sprayGridN * sprayGridY;
  const sprayGridV = instancedArray(new Int32Array(sprayCells * 4), "int").toAtomic();
  const sprayGridP = instancedArray(new Int32Array(sprayCells * 4), "int").toAtomic();
  const sp = {
    count: splashCount,
    threshold: uniform(.45), tryRate: uniform(.5), reach: uniform(SPLASH_REACH_METRES),
    // The throw speed (m/s, from the sea's height), the wave's direction,
    // the sprite's size (metres), and sea metres → the water's local units
    // (the solver sets it: the sprites live in the lid's object).
    speed: uniform(2), dir: uniform(new THREE.Vector2(1, 0)), size: uniform(.25), scale: uniform(new THREE.Vector3(1, 1, 1)),
    // Impact seeds (x, z, radius, entry speed) — one frame's crown each.
    seedRows: Array.from({ length: 16 }, () => new THREE.Vector4()), seedCount: uniform(0, "int"), seedTry: uniform(0),
    // The share of dead foam particles that probe the returns each frame.
    returnTry: uniform(.3),
    // The water's dials: how much spray (crowns, the fold probes) and how big.
    amount: uniform(1), sizeScale: uniform(1), spreadScale: uniform(1),
    // How far spray flies: every throw speed × √scale (a reach is v²/g, so
    // the reach is linear in the dial). A yacht's crown a fifth of a
    // trawler's ("too huge, does not match the boat scale", user).
    velScale: uniform(1),
  };
  sp.seeds = uniformArray(sp.seedRows, "vec4");
  // Each seed's share of the busiest seed's want (a counted contact seed
  // beside an entry's crown), read by the splash step as its acceptance.
  sp.acceptValues = new Array(16).fill(0);
  sp.accepts = uniformArray(sp.acceptValues, "float");
  // A seed may be a SEGMENT (its end, its outward normal) instead of a disc.
  sp.endRows = Array.from({ length: 16 }, () => new THREE.Vector4());
  sp.ends = uniformArray(sp.endRows, "vec4");
  sp.kindValues = new Array(16).fill(0);
  sp.kinds = uniformArray(sp.kindValues, "float");

  const cascades = Array.from({ length: cascadeCount }, (_, i) => {
    const c = { dk: uniform(1), cutLow: uniform(0), cutHigh: uniform(9999), amplitude: uniform(0), invL: uniform(1), L: 1,
      // This cascade's slope variance (both directions), for the roughness the
      // shading normal must take on where distance fades the cascade out.
      slopeVariance: uniform(0) };
    const h0k = storageMap(size, { name: `sea ${i} h0k` });
    const h0 = storageMap(size, { name: `sea ${i} h0` });
    const wavesData = storageMap(size, { name: `sea ${i} waves` });
    const A = storageMap(size, { name: `sea ${i} A` }), B = storageMap(size, { name: `sea ${i} B` });
    const A2 = storageMap(size, { name: `sea ${i} A2` }), B2 = storageMap(size, { name: `sea ${i} B2` });
    const C = storageMap(size, { name: `sea ${i} C` }), C2 = storageMap(size, { name: `sea ${i} C2` });
    const layer = int(i);

    const initial = Fn(() => {
      const kx = px.toFloat().sub(size / 2).mul(c.dk), kz = py.toFloat().sub(size / 2).mul(c.dk);
      const k = kx.mul(kx).add(kz.mul(kz)).sqrt().toVar();
      If(k.lessThanEqual(c.cutHigh).and(k.greaterThanEqual(c.cutLow)).and(k.greaterThan(0)), () => {
        textureStore(wavesData, texel, vec4(kx, float(1).div(k), kz, frequencyNode(k, u.depth)));
        const a = c.amplitude.mul(spectrumNode(kx, kz, k, u).mul(2).mul(c.dk).mul(c.dk).max(0).sqrt());
        const n = textureLoad(noise, texel).xy;
        textureStore(h0k, texel, vec4(n.x.mul(a), n.y.mul(a), 0, 0));
      }).Else(() => {
        textureStore(wavesData, texel, vec4(kx, 1, kz, 0));
        textureStore(h0k, texel, vec4(0));
      });
    })().compute(size * size);
    const conjugate = Fn(() => {
      const here = textureLoad(h0k, texel).xy;
      const mirror = textureLoad(h0k, ivec2(int(size).sub(px).mod(size), int(size).sub(py).mod(size))).xy;
      textureStore(h0, texel, vec4(here.x, here.y, mirror.x, mirror.y.negate()));
    })().compute(size * size);
    const evolve = Fn(() => {
      const wave = textureLoad(wavesData, texel).toVar();
      const kx = wave.x, invK = wave.y, kz = wave.z, omega = wave.w;
      const phase = omega.mul(u.time);
      const e = vec2(phase.cos(), phase.sin()).toVar();
      const h0v = textureLoad(h0, texel).toVar();
      const h = cmul(h0v.xy, e).add(cmul(h0v.zw, vec2(e.x, e.y.negate()))).toVar();
      const ih = vec2(h.y.negate(), h.x).toVar();
      const Dx = ih.mul(kx).mul(invK), Dy = h, Dz = ih.mul(kz).mul(invK);
      const Dxdx = h.negate().mul(kx).mul(kx).mul(invK), Dydx = ih.mul(kx), Dzdx = h.negate().mul(kx).mul(kz).mul(invK);
      const Dydz = ih.mul(kz), Dzdz = h.negate().mul(kz).mul(kz).mul(invK);
      textureStore(A, texel, vec4(Dx.x.sub(Dz.y), Dx.y.add(Dz.x), Dy.x.sub(Dzdx.y), Dy.y.add(Dzdx.x)));
      textureStore(B, texel, vec4(Dydx.x.sub(Dydz.y), Dydx.y.add(Dydz.x), Dxdx.x.sub(Dzdz.y), Dxdx.y.add(Dzdz.x)));
      // ∂h/∂t = iω(h0 e^{iωt} − h0* e^{−iωt}); the horizontal velocity is
      // i(k/|k|) of it, packed as Dx/Dz are (real → Vx, imaginary → Vz).
      const ht = cmul(h0v.xy, e).sub(cmul(h0v.zw, vec2(e.x, e.y.negate()))).toVar();
      const hd = vec2(ht.y.negate(), ht.x).mul(omega).toVar();
      const ihd = vec2(hd.y.negate(), hd.x).toVar();
      const Vx = ihd.mul(kx).mul(invK), Vz = ihd.mul(kz).mul(invK);
      textureStore(C, texel, vec4(Vx.x.sub(Vz.y), Vx.y.add(Vz.x), 0, 0));
    })().compute(size * size);
    const fftRows = fftKernel([A, B, C], [A2, B2, C2], true, size);
    const fftCols = fftKernel([A2, B2, C2], [A, B, C], false, size);
    const merge = Fn(() => {
      const a = textureLoad(A, texel).mul(sign).toVar(), b = textureLoad(B, texel).mul(sign).toVar();
      const Dx = a.x, Dz = a.y, Dy = a.z, Dxz = a.w, Dyx = b.x, Dyz = b.y, Dxx = b.z, Dzz = b.w;
      storageTexture(displacement).depth(layer).store(texel, vec4(u.lambda.mul(Dx), Dy, u.lambda.mul(Dz), u.lambda.mul(Dxz)));
      storageTexture(derivatives).depth(layer).store(texel, vec4(Dyx, Dyz, Dxx.mul(u.lambda), Dzz.mul(u.lambda)));
      const cv = textureLoad(C, texel).mul(sign).toVar();
      storageTexture(velocity).depth(layer).store(texel, vec4(cv.x.mul(u.lambda), cv.y.mul(u.lambda), 0, 0));
    })().compute(size * size);
    for (const [k, node] of Object.entries({ initial, conjugate, evolve, fftRows, fftCols, merge })) node.__giPassName = `sea${i}.${k}`;
    return { index: i, uniforms: c, get L() { return c.L; },
      textures: [h0k, h0, wavesData, A, B, A2, B2, C, C2],
      kernels: { initial, conjugate, evolve, fftRows, fftCols, merge } };
  });

  let settings = null, dirty = true;
  const spectrum = {
    size, cascades, uniforms: u, noise, displacement, derivatives, velocity,
    // Bound ONCE per consumer graph and shared: the texture node is what a
    // material or kernel binds; a cascade is a LAYER of it.
    nodes: { displacement: texture(displacement), derivatives: texture(derivatives), velocity: texture(velocity) },
    get settings() { return settings; },
    amplitude: 0,
    /** Re-realize the spectrum from the component's wave fields. */
    configure(props, depthMetres) {
      settings = seaSettings(props, depthMetres);
      const bands = cascadeBands(cascadeScales(settings.waveLength, cascadeCount));
      // The expected variance is an integral over k; a 64² estimate of it is
      // within a few percent of the 256² one and a hundred times cheaper.
      const { variance, gradient } = spectrumMoments(64, bands, settings);
      spectrum.amplitude = variance > 0 ? settings.sigma / Math.sqrt(variance) : 0;
      // `choppiness`, capped where the surface would fold (`foldingLimit`).
      settings.lambda = Math.min(settings.lambda, foldingLimit(spectrum.amplitude, gradient));
      u.lambda.value = settings.lambda; u.depth.value = settings.depth;
      u.peakOmega.value = settings.peakOmega; u.kPeak.value = settings.kPeak; u.kMax.value = settings.kMax; u.tilt.value = settings.tilt;
      u.ripple.value = settings.ripple;
      settings.spectra.forEach((pars, i) => { const s = u.spectra[i]; s.scale.value = pars.scale; s.angle.value = pars.angle; s.spreadBlend.value = pars.spreadBlend; s.swell.value = pars.swell; s.gamma.value = pars.gamma; });
      bands.forEach((band, i) => {
        const c = cascades[i].uniforms;
        c.L = band.L; c.invL.value = 1 / band.L; c.dk.value = 2 * Math.PI / band.L; c.cutLow.value = band.cutLow; c.cutHigh.value = band.cutHigh;
        c.amplitude.value = spectrum.amplitude;
        // The x-slope moment of this band alone, doubled for both directions,
        // at the realized amplitude.
        c.slopeVariance.value = 2 * spectrumMoments(64, [band], settings).gradient * spectrum.amplitude * spectrum.amplitude;
        // The foam window reads each cascade at the level whose texel matches
        // its own, or a fine cascade aliases across the window's texels.
        f.lods[i].value = Math.max(0, Math.log2(Math.max(1, f.texel.value / (band.L / size))));
      });
      f.spread.value = Math.max(.2, settings.waveLength * .1);
      f.disc.value = Math.min(1, Math.max(.1, settings.waveLength * .025));   // small specks, not blobs (the reference, user 2026-09-07)
      // ⛔ A FIXED LIFE, NOT THE WAVE'S PERIOD: with the life tied to the
      // peak period a long swell kept its foam twice as long as a short
      // chop and read twice as foamy at the same dial ("I don't want to
      // depend on those, only on the Foam parameter", user, 2026-09-07).
      f.baseLife = FOAM_LIFE_SECONDS;
      f.life.value = f.baseLife;
      // Spray flies at ~1.6 √(g σ): a metre and a half up on a 1 m sea.
      sp.speed.value = 1.6 * Math.sqrt(GRAVITY * Math.max(.02, settings.sigma));
      sp.size.value = Math.min(.3, Math.max(.04, settings.sigma * .25));
      const angle = settings.spectra?.[0]?.angle ?? 0;
      sp.dir.value.set(Math.cos(angle), Math.sin(angle));
      dirty = true;
      return settings;
    },
    /** The sea carries no memory of its own (the solver's foam field does);
     *  a restart re-realizes nothing. Kept so the solver may call it. */
    restart() { particlesReady = false; spectrum.flow?.restart(); },
    /** The dispatches for this frame, in order; `renderer.compute(...)` them.
     *  `eye` is the camera in the sea's metres (a water's local XZ × its
     *  scale) — the foam window follows it; `foam` is the water's dial. */
    passes(dt, time, { eye = null, foam = null, current = null, seeds = null, splashes = null, splash = null, splashSize = null, splashSpread = null, splashScale = null } = {}) {
      // The dials: wide open (0 to a hundred), the pool the only ceiling.
      if (splash != null) sp.amount.value = Math.max(0, Math.min(100, splash));
      if (splashSize != null) sp.sizeScale.value = Math.max(0, Math.min(100, splashSize));
      if (splashSpread != null) sp.spreadScale.value = Math.max(0, Math.min(100, splashSpread));
      if (splashScale != null) sp.velScale.value = Math.sqrt(Math.max(0, Math.min(100, splashScale)));
      const step = Math.min(.1, Math.max(0, dt));
      // Foam handed in this tick (the sea's metres); the rows are consumed
      // here. A seed WANTS particles in proportion to its area and value —
      // FOAM_SEED_DENSITY per square metre per second, a fresh patch white
      // within a second — and the pool's probes are sized to the busiest.
      const count = Math.min(f.seedRows.length, seeds?.length ?? 0);
      let maxWant = 0;
      const wants = new Array(count);
      // The foam dial scales a hull's seeds too ("even on 0.1 there is too
      // much of it", user, 2026-09-07): a fifth at 0, all at 1.
      // ⛔ THE DIAL IS QUADRATIC ON THE INTERACTION SOURCES: linear, 0.1
      // still read as a tenth of a boat's tail ("still too much foam at
      // 0.1", user, 2026-09-07); squared it is a hundredth.
      // ⛔ THE DIAL'S SCALE: "on 0.1 it is like it should be on 0.5 … the
      // maximum at which it looks natural" (user, 2026-09-07). The fold
      // threshold runs .42 → .72 (0.1 barely folds; 0.5 is what 0.3 was),
      // a hull's seeds are linear in the dial, the ripple field's births
      // its square, the returns linear.
      const dial = f.gate.value;
      for (let i = 0; i < count; i++) {
        const [, , r, a] = seeds[i];
        wants[i] = Math.PI * r * r * Math.min(1, a) * FOAM_SEED_DENSITY * step * dial;
        maxWant = Math.max(maxWant, wants[i]);
      }
      for (let i = 0; i < count; i++) f.seedRows[i].set(seeds[i][0], seeds[i][1], seeds[i][2], maxWant > 0 ? wants[i] / maxWant : 0);
      f.seedCount.value = count;
      const dead = Math.max(particleCount * .02, particleCount - liveEstimate);
      f.seedTry.value = maxWant > 0 ? Math.min(1, 1.5 * count * maxWant / dead) : 0;
      // Impacts (the sea's metres, radius, entry speed): a crown of
      // 200 r² v particles, 60–4000, thrown this frame (× SPLASH_SPRITES drops).
      const impacts = Math.min(sp.seedRows.length, splashes?.length ?? 0);
      let maxCrown = 0;
      const crowns = new Array(impacts);
      for (let i = 0; i < impacts; i++) {
        const [, , r, v, count] = splashes[i];
        // A counted seed (contact spray, per frame) or an entry's crown.
        crowns[i] = (count != null ? Math.max(0, count) : Math.min(4000, Math.max(60, 200 * r * r * v))) * sp.amount.value;
        maxCrown = Math.max(maxCrown, crowns[i]);
      }
      for (let i = 0; i < impacts; i++) {
        const [x, z, r, v, , x1, z1, nx, nz] = splashes[i];
        sp.seedRows[i].set(x, z, r, v);
        const segment = x1 != null && z1 != null;
        sp.kindValues[i] = segment ? 1 : 0;
        sp.endRows[i].set(segment ? x1 : x, segment ? z1 : z, nx || 0, nz || 0);
      }
      sp.seedCount.value = impacts;
      sp.seedTry.value = maxCrown > 0 ? Math.min(1, 1.5 * impacts * maxCrown / splashCount) : 0;
      sp.crownAccept = crowns.map((c) => (maxCrown > 0 ? c / maxCrown : 0));
      for (let i = 0; i < 16; i++) sp.acceptValues[i] = sp.crownAccept[i] ?? 0;
      const queue = [];
      if (!settings) return queue;
      if (dirty) { for (const c of cascades) queue.push(c.kernels.initial, c.kernels.conjugate); dirty = false; }
      u.time.value = time * settings.timeScale; u.dt.value = Math.min(.5, Math.max(0, dt));
      for (const c of cascades) queue.push(c.kernels.evolve, c.kernels.fftRows, c.kernels.fftCols, c.kernels.merge);
      // The pool's step: the window snapped to whole texels on the eye, the
      // current, the fold threshold; the particles carry themselves.
      if (foam != null) f.gate.value = Math.max(0, Math.min(1, foam));
      // The fold threshold on the minimum eigenvalue: `foam` 0 opens at 0.45
      // (a fold at the limit), 1 at 0.85 — the paper's 0.55 near 0.25.
      // The dial seeds the threshold; the controller (the readback below)
      // owns it from there. A moved dial re-seeds.
      if (Math.abs(f.gate.value - lastGate) > .02) { f.threshold.value = .42 + .3 * f.gate.value; lastGate = f.gate.value; }
      // The spray's fold threshold rides the CONTROLLED one (trap 64), a
      // little stricter, and its probes are a sixth of the pool: a fixed
      // offset let a steep sea fly 11 k drops at once (the steep arm's
      // blobs, 2026-09-07).
      sp.threshold.value = f.threshold.value - .05;
      sp.tryRate.value = Math.min(1, .15 * sp.amount.value);
      const t = f.texel.value;
      f.prevCenter.value.copy(f.center.value);
      if (eye) f.center.value.set(Math.round(eye[0] / t) * t, Math.round(eye[1] / t) * t);
      if (current && (current[0] || current[1])) {
        // ⚠ THE SCROLL DECREASES. The sea is sampled at world + scroll, so the
        // pattern at W now is what stood at W + scroll before: for the water
        // to travel WITH the current (+v), the scroll must run against it —
        // sampled at world + v·t the sea streamed backwards while the wake
        // went forward ("foam is running in the opposite direction than the
        // current", user, 2026-09-07). The particles ride +v.
        u.scroll.value.x -= current[0] * step; u.scroll.value.y -= current[1] * step;
        f.currentVel.value.set(current[0], current[1]);
      } else f.currentVel.value.set(0, 0);
      f.dt.value = step; f.timeScale.value = settings.timeScale; f.frame.value = (f.frame.value + 1) % 1048576;
      // FOAM_RATE probes a square metre a second over the window, as a share
      // of the pool (a dead particle's chance to probe this frame).
      f.tryRate.value = Math.min(1, FOAM_RATE * (2 * f.half.value) ** 2 * step / particleCount);
      // The ripple window's foam is probed at twice the sea's rate over its own area.
      const ripple = spectrum.ripple;
      f.rippleTry.value = ripple ? Math.min(1, 2 * FOAM_RATE * (2 * ripple.half.value.x * ripple.scale.value.x) * (2 * ripple.half.value.y * ripple.scale.value.z) * step / particleCount) * dial * dial : 0;
      sp.returnTry.value = .3 * dial;
      f.cap.value = .2 + .7 * f.gate.value;
      f.life.value = f.baseLife * (.4 + .6 * f.gate.value);
      {
        const cv = f.currentVel.value, speed = Math.hypot(cv.x, cv.y), k = Math.min(1, speed / .5);
        const ax = sp.dir.value.x * (1 - k) + (speed > 0 ? cv.x / speed : 0) * k, az = sp.dir.value.y * (1 - k) + (speed > 0 ? cv.y / speed : 0) * k;
        const n = Math.hypot(ax, az) || 1;
        f.streakAxis.value.set(ax / n, az / n);
      }
      // The harness's cost arms: `__waterFoamParticles`, `__waterFoamFlow`,
      // `__waterSprayGrid` = false switch a system off for a measurement.
      if (globalThis.__waterFoamParticles === false) return queue;
      const k = ensureKernels();
      if (!particlesReady) { queue.push(k.particleInit, k.splashInit); particlesReady = true; }
      // The fluid first, then the spray's grid, the splash step (its returns
      // feed the foam step), the foam step.
      if (globalThis.__waterFoamFlow !== false) queue.push(...k.flow.passes(step, time, eye));
      queue.push(k.liveReset);
      if (globalThis.__waterSprayGrid !== false) queue.push(k.sprayClear, k.sprayScatter);
      queue.push(k.splashStep, k.particleStep);
      return queue;
    },
    /**
     * ⛔ THE MAPS' MIPS ARE OURS TO MAKE. three regenerates a storage
     * texture's mips only when a SAMPLED binding of it is (re)built after a
     * store binding marked it (Bindings.js), and the sea's arrays are bound
     * once and cached — so every mip above 0 stayed the zero it was created
     * with. Every `.level(n > 0)` read — the clipmap's coarse rings, the
     * far pixels' hardware mip, the foam memory's coverage — read NOTHING:
     * the sea was flat from the sixth ring out (receipt: RMS 0.00 m on
     * levels 6–8, 0.41 on level 5 = 0.8 × mip 0 + 0.2 × an empty mip 1;
     * 2026-09-07). Called after the sea's dispatches and before the surface
     * reads them, so the coarse levels describe THIS frame's sea.
     */
    /** The particles' splat into the foam map — a nested render before the
     *  frame's own, like the caustic pass — then the mips. */
    afterCompute(renderer) {
      if (renderer?.isWebGPURenderer && settings && particlesReady && globalThis.__waterFoamParticles !== false) {
        const nested = globalThis.__giNestedRender;
        globalThis.__giNestedRender = true;
        const target = renderer.getRenderTarget(), alpha = renderer.getClearAlpha();
        renderer.getClearColor(previousClear);
        try {
          // Ping-pong: read the map the lid read last frame, write the other.
          previousFoam.value = foamTargets[foamPhase].texture;
          foamPhase = 1 - foamPhase;
          foamTarget = foamTargets[foamPhase];
          spectrum.nodes.foam.value = foamTarget.texture;
          renderer.setRenderTarget(foamTarget);
          renderer.setClearColor(0x000000, 1);
          renderer.render(splatScene, splatCamera);
        } finally {
          renderer.setClearColor(previousClear, alpha);
          renderer.setRenderTarget(target);
          globalThis.__giNestedRender = nested;
        }
      }
      spectrum.generateMipmaps(renderer);
      if (renderer?.backend?.device && particlesReady && !liveReadPending && ++liveReadFrame >= 20) {
        liveReadFrame = 0; liveReadPending = true;
        liveReader ??= createBufferReadback(renderer, liveCounter.value, { byteLength: 16 });
        (liveReader?.read() ?? Promise.resolve(null)).then((counts) => {
          if (!counts) return;
          liveEstimate = counts[0] || 0; foldProbes = counts[1] || 0; foldHits = counts[2] || 0;
          // The coverage controller: a step in log space toward the target.
          const target = FOAM_COVERAGE * f.gate.value;
          if (foldProbes > 200 && target > 0) {
            const rate = foldHits / foldProbes;
            const move = .03 * Math.max(-1, Math.min(1, Math.log((target + 1e-4) / (rate + 1e-4))));
            f.threshold.value = Math.max(.05, Math.min(.95, f.threshold.value + move));
          }
        }).catch(() => {}).finally(() => { liveReadPending = false; });
      }
    },
    generateMipmaps(renderer) {
      if (globalThis.__waterSeaMips === false) return;   // `__waterSeaMips = false`: the harness's control arm
      // ⛔ NOT three's mipmap pass: it creates a view and a bind group per
      // layer per level per call, and every frame of that exhausted Dawn's
      // D3D12 descriptor heaps ("CreateDescriptorHeap failed with
      // E_OUTOFMEMORY", device lost, 2026-09-07). gpuMipmaps.js builds them
      // once per GPU texture and only encodes passes here.
      const blitter = mipmapBlitter(renderer);
      if (!blitter) return;
      // One encoder, one submit for all three maps — was one of each per
      // texture (three encoders/submits a frame just for mips).
      mipTargets[2] = foamTarget.texture;
      blitter.generateMany(mipTargets);
    },
    tick(renderer, dt, time, options) {
      const queue = spectrum.passes(dt, time, options);
      if (queue.length && renderer?.isWebGPURenderer) { renderer.compute(queue); spectrum.afterCompute(renderer); }
    },
    /**
     * The displacement maps of the cascades that carry height, copied to the
     * CPU for buoyancy — Babylon's `_getDisplacementMap`. Asynchronous and a
     * frame or two behind, which no floating body can see; kept as HALVES and
     * converted at the sample (`sampleDisplacement`), never as a whole map.
     */
    async readback(renderer, count = 2) {
      if (!renderer?.backend?.device || !settings) return null;
      // ⚠ ONE staging buffer for the life of the sea (gpuReadback.js): three's
      // per-call copy was a fresh 1 MB GPU buffer and a fresh 1 MB ArrayBuffer
      // every other frame.
      seaReader ??= createTextureReadback(renderer, displacement, { width: size, height: size, layers: cascadeCount, bytesPerTexel: 8, ArrayType: Uint16Array });
      const maps = await (seaReader?.read(Math.min(count, cascadeCount)) ?? null);
      if (!maps) return null;
      return { cascades: maps.map((map, i) => ({ size, L: cascades[i].L, displacement: map })), scroll: { x: u.scroll.value.x, z: u.scroll.value.y } };
    },
    /** The pool, for a receipt: (x, z, age, life) per particle. */
    async readParticles(renderer) {
      if (!renderer?.getArrayBufferAsync || !particlesReady) return null;
      return new Float32Array(await renderer.getArrayBufferAsync(particles.value));
    },
    /** The splash pool, for a receipt: positions (x, y, z, age) and velocities (vx, vy, vz, life). */
    async readSplashes(renderer) {
      if (!renderer?.getArrayBufferAsync || !particlesReady) return null;
      const [pos, vel] = await Promise.all([renderer.getArrayBufferAsync(splash.value), renderer.getArrayBufferAsync(splashVel.value)]);
      return { pos: new Float32Array(pos), vel: new Float32Array(vel) };
    },
    dispose(renderer) {
      releaseComputeNodes(renderer, [...cascades.flatMap((c) => Object.values(c.kernels)), ...(kernels ? Object.values(kernels).filter((k) => k !== kernels.flow) : [])]);
      spectrum.flow?.dispose(renderer);
      seaReader?.dispose(); seaReader = null; liveReader?.dispose(); liveReader = null;
      releaseStorageAttributes(renderer, [particles.value, particleAux.value, splash.value, splashVel.value, splashAux.value, returns.value, liveCounter.value, sprayGridV.value, sprayGridP.value].filter(Boolean));
      for (const c of cascades) for (const t of c.textures) t.dispose();
      for (const t of foamTargets) t.dispose(); splatMaterial.dispose(); splatGeometry.dispose(); carryMaterial.dispose(); carryMesh.geometry.dispose();
      splashMesh.removeFromParent(); splashMaterial.dispose(); splashGeometry.dispose();
      displacement.dispose(); derivatives.dispose(); velocity.dispose(); noise.dispose();
    },
  };
  spectrum.foam = f;
  spectrum.nodes.foam = texture(foamTarget.texture);
  spectrum.particleCount = particleCount;
  spectrum.splash = sp;
  // PCG on uint arithmetic: three's `hash` truncates its float seed, and a
  // truncated (index + frame) hands the same probes to the next frame's
  // neighbour.
  const pcg = (v) => {
    const state = v.mul(747796405).add(2891336453);
    const word = state.shiftRight(state.shiftRight(28).add(4)).bitXor(state).mul(277803737);
    return word.shiftRight(22).bitXor(word).toFloat().mul(1 / 2 ** 32);
  };
  const rnd = (salt) => pcg(instanceIndex.mul(uint(2654435761)).add(f.frame.mul(uint(2246822519))).add(uint((salt * 668265263) >>> 0)));
  const gauss = (a, b) => a.max(1e-6).log().mul(-2).sqrt().mul(b.mul(6.2831853).cos());
  // ── THE KERNELS, BUILT AT THE FIRST TICK ─────────────────────────────────
  // Late, because the solver hands the sea its RIPPLE WINDOW after the sea
  // is made (`spectrum.ripple`: the field's foam and flow at a local point,
  // the water's scale) — the wake's foam is a particle SOURCE and its flow
  // carries the particles, so a splash's foam, a hull's and a crest's are
  // one system with one motion (the paper's), not two drawn layers.
  let kernels = null;
  const ensureKernels = () => (kernels ??= buildKernels());
  // The foam's fluid (waterFoamFlow.js): a divergence-free perturbation on
  // the sea's surface velocity, on a 128 m window around the eye. Made now
  // — the lid's look reads it per pixel — its kernels at the first tick.
  spectrum.flow = createFoamFlow({
    size: Math.max(64, foamSize >> 2),
    seaFold: (world, lods) => seaFoldAt(spectrum, world, lods ?? f.lods),
    seaVelocity: (world) => seaVelocityAt(spectrum, world, f.zeroLods),
    threshold: f.threshold, timeScale: f.timeScale, ripple: () => spectrum.ripple ?? null,
  });
  spectrum.liveCount = () => liveEstimate;
  spectrum.foldStats = () => ({ probes: foldProbes, folds: foldHits, rate: foldProbes ? foldHits / foldProbes : 0, threshold: f.threshold.value, target: FOAM_COVERAGE * f.gate.value });
  const buildKernels = () => {
    const ripple = spectrum.ripple ?? null;
    const localOf = (world) => vec3(world.x.div(ripple.scale.x), 0, world.y.div(ripple.scale.z));
    // The surface under a point: the sea plus the ripple window's height
    // (a bow wave lifts the lid at the hull — spray born at the sea's own
    // height started UNDER it: "the splashes are just under the water
    // surface", user, 2026-09-07).
    const surfaceAt = (xz) => {
      const sea = seaDisplacementAt(spectrum, xz, f.zeroLods).y;
      return ripple ? sea.add(ripple.at(localOf(xz)).x.mul(ripple.scale.y)) : sea;
    };
    const flow = spectrum.flow;
    // ── THE FOAM STEP ────────────────────────────────────────────────────
    // A live particle rides the surface velocity, the current and — inside
    // the ripple window — the wake's flow, and ages. A dead one probes: a
    // hull seed (`seedTry`), a splash's return (`returnTry`), the ripple
    // window's foam (`rippleTry`, born with the field's value as its
    // chance), or a random point of the window (`tryRate`) where a minimum
    // eigenvalue under the threshold is a fold — born there, moved along
    // the crest (the maximum eigenvector) by a random distance, the
    // whitecap coverage rule.
    const particleInit = Fn(() => {
      particles.element(instanceIndex).assign(vec4(0, 0, 1, 0));   // age 1 ≥ life 0: dead
      particleAux.element(instanceIndex).assign(vec4(0));
    })().compute(particleCount);
    const particleStep = Fn(() => {
      const i = instanceIndex.toInt();
      const p = particles.element(i).toVar();
      If(p.z.lessThan(p.w), () => {
        // The sea's own velocity, the fluid's swirl on top of it (which
        // carries the ripple field's flow inside its window), the current.
        const swirl = flow.at(p.xy), swirlSpeed = swirl.length();
        const vel = seaVelocityAt(spectrum, p.xy, f.zeroLods).mul(f.timeScale).add(swirl.mul(swirlSpeed.min(2).div(swirlSpeed.max(1e-3)))).add(f.currentVel).toVar();
        p.xy.assign(p.xy.add(vel.mul(f.dt)));
        p.z.assign(p.z.add(f.dt));
        particles.element(i).assign(p);
        atomicAdd(liveCounter.element(uint(0)), uint(1));
      }).Else(() => {
        const r0 = rnd(1), r1 = rnd(2), r2 = rnd(3), r3 = rnd(4);
        const born = float(0).toVar(), at = vec2(0).toVar(), scale = float(1).toVar(), streak = float(0).toVar();
        const gate1 = f.seedTry, gate2 = gate1.add(sp.returnTry), gate3 = gate2.add(f.rippleTry), gate4 = gate3.add(f.tryRate);
        If(r0.lessThan(gate1), () => {
          const seed = f.seeds.element(r1.mul(f.seedCount.toFloat()).floor().toInt().clamp(0, 63));
          If(r2.lessThan(seed.w), () => {
            const angle = rnd(5).mul(6.2831853), rad = r3.sqrt().mul(seed.z);
            at.assign(seed.xy.add(vec2(angle.cos(), angle.sin()).mul(rad)));
            born.assign(1);
          });
        }).ElseIf(r0.lessThan(gate2), () => {
          // A splash that met the surface this frame: foam where it landed.
          const ret = returns.element(r1.mul(splashCount).floor().toInt().clamp(0, splashCount - 1));
          If(ret.w.greaterThan(.5), () => {
            const angle = rnd(10).mul(6.2831853), rad = r3.sqrt().mul(f.disc.mul(.4));
            at.assign(ret.xy.add(vec2(angle.cos(), angle.sin()).mul(rad)));
            born.assign(1); scale.assign(ret.z.clamp(.5, 1));
          });
        }).ElseIf(r0.lessThan(gate3), () => {
          // The ripple window's foam — a wake's churn, a splash's, a rim's —
          // probed over the window; the field's value is the chance.
          if (ripple) {
            const centre = vec2(ripple.center.x.mul(ripple.scale.x), ripple.center.y.mul(ripple.scale.z));
            const half = vec2(ripple.half.x.mul(ripple.scale.x), ripple.half.y.mul(ripple.scale.z));
            const probe = centre.add(vec2(r2, r3).sub(.5).mul(half.mul(2)));
            const field = ripple.at(localOf(probe)).w.mul(4).clamp(0, 1);
            If(rnd(29).lessThan(field), () => {
              at.assign(probe); born.assign(1); scale.assign(field.mul(.5).add(.5));
            });
          }
        }).ElseIf(r0.lessThan(gate4), () => {
          const probe = f.center.add(vec2(r2, r3).sub(.5).mul(f.half.mul(2)));
          atomicAdd(liveCounter.element(uint(1)), uint(1));
          const fold = seaFoldAt(spectrum, probe, f.lods);
          If(fold.x.lessThan(f.threshold), () => {
            atomicAdd(liveCounter.element(uint(2)), uint(1));
            // Along the crest by ±spread, a little across it.
            const along = rnd(6).mul(2).sub(1).mul(f.spread), across = rnd(7).sub(.5).mul(f.spread.mul(.25));
            at.assign(probe.add(fold.yz.mul(along)).add(vec2(fold.z.negate(), fold.y).mul(across)));
            born.assign(1); streak.assign(1);
            // Deeper folds make brighter foam.
            scale.assign(f.threshold.sub(fold.x).div(f.threshold.max(1e-3)).mul(2).add(.5).clamp(.5, 1));
          });
        });
        // THE DENSITY GATE (ledger trap 54): a particle is born only where
        // the map is not white yet, so a fold fills to a sheet and stops;
        // the speck's size grows with its distance from the eye and its
        // chance falls with the square of that.
        If(born.greaterThan(.5), () => {
          const here = seaFoamWindowNode(spectrum, at, float(0));
          const sizeFactor = at.sub(f.center).length().mul(FOAM_SIZE_PER_METRE).div(f.disc.max(1e-3)).max(1);
          If(rnd(27).lessThan(f.cap.sub(here).max(0).div(f.cap).div(sizeFactor.mul(sizeFactor))), () => {
            const life = f.life.mul(.5).add(rnd(8).mul(f.life.mul(.5)));
            particles.element(i).assign(vec4(at, 0, life));
            particleAux.element(i).assign(vec4(scale, rnd(9).add(.5).mul(sizeFactor), streak, 0));
          });
        });
      });
    })().compute(particleCount);
    const liveReset = Fn(() => { atomicStore(liveCounter.element(uint(0)), uint(0)); atomicStore(liveCounter.element(uint(1)), uint(0)); atomicStore(liveCounter.element(uint(2)), uint(0)); })().compute(1);
    // ── THE SPLASH STEP ──────────────────────────────────────────────────
    // In the SEA'S time (a slowed sea throws slowed spray): gravity, a
    // little drag, the current (the frame the boat sits still in), and the
    // surface under the particle — met, it dies and leaves a return. A dead
    // one is born at an impact seed (a crown: up at the entry speed, out at
    // a third of it, the rim fastest) or, within `reach` of the eye, at a
    // hard fold: on the crest's front face, thrown with the surface
    // velocity, forward along the wave and up at `speed`, with the paper's
    // Gaussian turbulence (Box–Muller on two hashes).
    const splashInit = Fn(() => {
      splash.element(instanceIndex).assign(vec4(0, 0, 0, 1));   // age 1 ≥ life 0: dead
      splashVel.element(instanceIndex).assign(vec4(0));
      splashAux.element(instanceIndex).assign(vec4(0));
      returns.element(instanceIndex).assign(vec4(0));
    })().compute(splashCount);
    // ── THE SPRAY'S GRID ───────────────────────────────────────────────
    const gridOrigin = () => vec3(f.center.x.sub(sprayGridN * SPRAY_CELL / 2), float(SPRAY_GRID_FLOOR), f.center.y.sub(sprayGridN * SPRAY_CELL / 2));
    const cellOf = (pos) => ivec3(pos.sub(gridOrigin()).div(SPRAY_CELL).floor());
    const cellInside = (c) => c.x.greaterThanEqual(0).and(c.x.lessThan(sprayGridN)).and(c.y.greaterThanEqual(0)).and(c.y.lessThan(sprayGridY)).and(c.z.greaterThanEqual(0)).and(c.z.lessThan(sprayGridN));
    const cellIndex = (c) => c.y.mul(sprayGridN * sprayGridN).add(c.z.mul(sprayGridN)).add(c.x);
    const sprayClear = Fn(() => {
      const k = instanceIndex.toInt();
      atomicStore(sprayGridV.element(k), int(0)); atomicStore(sprayGridP.element(k), int(0));
    })().compute(sprayCells * 4);
    const sprayScatter = Fn(() => {
      const i = instanceIndex.toInt();
      const p = splash.element(i), v = splashVel.element(i);
      If(p.w.lessThan(v.w), () => {
        const c = cellOf(p.xyz);
        If(cellInside(c), () => {
          const base = cellIndex(c).mul(4);
          const rel = p.xyz.sub(gridOrigin()).sub(c.toFloat().mul(SPRAY_CELL));
          atomicAdd(sprayGridV.element(base), v.x.mul(256).toInt());
          atomicAdd(sprayGridV.element(base.add(1)), v.y.mul(256).toInt());
          atomicAdd(sprayGridV.element(base.add(2)), v.z.mul(256).toInt());
          atomicAdd(sprayGridV.element(base.add(3)), int(1));
          atomicAdd(sprayGridP.element(base), rel.x.mul(256).toInt());
          atomicAdd(sprayGridP.element(base.add(1)), rel.y.mul(256).toInt());
          atomicAdd(sprayGridP.element(base.add(2)), rel.z.mul(256).toInt());
        });
      });
    })().compute(splashCount);
    const splashStep = Fn(() => {
      const i = instanceIndex.toInt();
      const p = splash.element(i).toVar(), v = splashVel.element(i).toVar();
      const dts = f.dt.mul(f.timeScale);
      returns.element(i).assign(vec4(0));
      If(p.w.lessThan(v.w), () => {
        // The grid's say: the neighbourhood's shared velocity and centre
        // of mass (its cell and the six faces).
        const c = cellOf(p.xyz);
        If(cellInside(c), () => {
          const sumV = vec3(0).toVar(), sumP = vec3(0).toVar(), count = float(0).toVar();
          const gather = (dx, dy, dz) => {
            const n = c.add(ivec3(dx, dy, dz));
            If(cellInside(n), () => {
              const base = cellIndex(n).mul(4);
              const k = atomicLoad(sprayGridV.element(base.add(3))).toFloat();
              sumV.addAssign(vec3(atomicLoad(sprayGridV.element(base)).toFloat(), atomicLoad(sprayGridV.element(base.add(1))).toFloat(), atomicLoad(sprayGridV.element(base.add(2))).toFloat()).div(256));
              const corner = gridOrigin().add(n.toFloat().mul(SPRAY_CELL));
              sumP.addAssign(vec3(atomicLoad(sprayGridP.element(base)).toFloat(), atomicLoad(sprayGridP.element(base.add(1))).toFloat(), atomicLoad(sprayGridP.element(base.add(2))).toFloat()).div(256).add(corner.mul(k)));
              count.addAssign(k);
            });
          };
          gather(0, 0, 0); gather(1, 0, 0); gather(-1, 0, 0); gather(0, 1, 0); gather(0, -1, 0); gather(0, 0, 1); gather(0, 0, -1);
          If(count.greaterThan(1.5), () => {
            const shared = sumV.div(count), com = sumP.div(count);
            v.xyz.assign(mix(v.xyz, shared, SPRAY_PIC));
            const toCom = com.sub(p.xyz), d = toCom.length();
            const pull = toCom.div(d.max(1e-3));
            // Cohesion while loose, pressure when packed.
            const packed = count.sub(SPRAY_PACKED).max(0);
            v.xyz.addAssign(pull.mul(float(SPRAY_COHESION).mul(d.min(SPRAY_CELL)).div(SPRAY_CELL).sub(packed.mul(SPRAY_PRESSURE))).mul(dts));
          });
        });
        v.y.assign(v.y.sub(dts.mul(GRAVITY)));
        v.xyz.assign(v.xyz.mul(dts.mul(.4).oneMinus().max(0)));
        // The BREAKUP: a sheet flies coherent for a few tenths of a second,
        // then tears into drops — a random walk that grows with age.
        const tear = p.w.mul(1.2).min(1).mul(dts).mul(2.5).mul(sp.spreadScale);
        v.xyz.assign(v.xyz.add(vec3(gauss(rnd(30), rnd(31)), gauss(rnd(32), rnd(33)).mul(.6), gauss(rnd(34), rnd(35))).mul(tear)));
        p.xyz.assign(p.xyz.add(v.xyz.mul(dts)));
        p.xz.assign(p.xz.add(f.currentVel.mul(f.dt)));
        p.w.assign(p.w.add(dts));
        const surface = surfaceAt(p.xz);
        If(p.y.lessThan(surface).and(p.w.greaterThan(.15)), () => {
          returns.element(i).assign(vec4(p.x, p.z, splashAux.element(i).x, 1));
          p.w.assign(v.w.add(1));
        });
        splash.element(i).assign(p); splashVel.element(i).assign(v);
      }).Else(() => {
        const r0 = rnd(11), r1 = rnd(12), r2 = rnd(13), r3 = rnd(14);
        const born = float(0).toVar(), at = vec2(0).toVar(), vel = vec3(0).toVar(), strength = float(1).toVar();
        If(r0.lessThan(sp.seedTry), () => {
          const which = r1.mul(sp.seedCount.toFloat()).floor().toInt().clamp(0, 15);
          const seed = sp.seeds.element(which);
          If(rnd(28).lessThan(sp.accepts.element(which)), () => {
            const angle = rnd(15).mul(6.2831853), rad = r2.sqrt();
            const radial = vec2(angle.cos(), angle.sin()).toVar();
            at.assign(seed.xy.add(radial.mul(rad).mul(seed.z)));
            // A segment seed: born uniformly along it, thrown outward.
            const end = sp.ends.element(which), segment = sp.kinds.element(which).greaterThan(.5);
            If(segment, () => {
              at.assign(mix(seed.xy, end.xy, r2).add(end.zw.mul(rnd(29).sub(.5).mul(seed.z.mul(2)).mul(sp.spreadScale))));
              radial.assign(end.zw.add(vec2(end.w.negate(), end.z).mul(rnd(15).sub(.5).mul(.8))).normalize());
            });
            // A crown is a SHEET before it is drops: its velocity is smooth
            // around the ring (three lobes with a phase from the seed's
            // place), the rim fastest; the breakup comes with age, below.
            const phase = seed.x.mul(7.3).add(seed.y.mul(3.1));
            const lobes = angle.mul(3).add(phase).sin().mul(.5).add(.5);
            const thrown = seed.w.mul(sp.velScale);
            const up = thrown.mul(lobes.mul(.5).add(.55).mul(rad.mul(.4).add(.8))), out = thrown.mul(.4).mul(rad).mul(lobes.mul(.4).add(.6)).mul(sp.spreadScale);
            const turbulence = vec3(gauss(rnd(16), rnd(17)).mul(sp.spreadScale), gauss(rnd(18), rnd(19)), gauss(rnd(20), rnd(21)).mul(sp.spreadScale)).mul(seed.w.mul(.04));
            vel.assign(vec3(radial.x.mul(out), up, radial.y.mul(out)).add(turbulence));
            born.assign(1); strength.assign(1);
          });
        }).ElseIf(r0.lessThan(sp.seedTry.add(sp.tryRate)), () => {
          const probe = f.center.add(vec2(r2, r3).sub(.5).mul(sp.reach.mul(2)));
          const fold = seaFoldAt(spectrum, probe, f.lods);
          If(fold.x.lessThan(sp.threshold), () => {
            const deficit = sp.threshold.sub(fold.x).div(sp.threshold.max(1e-3)).clamp(0, 1);
            const along = rnd(16).mul(2).sub(1).mul(f.spread.mul(.5)).mul(sp.spreadScale), forward = rnd(17).mul(f.spread.mul(.5)).mul(sp.spreadScale);
            at.assign(probe.add(fold.yz.mul(along)).add(sp.dir.mul(forward)));
            const surf = seaVelocityAt(spectrum, at, f.zeroLods).mul(f.timeScale);
            const speed = sp.speed.mul(deficit.mul(.8).add(.4)).mul(sp.velScale);
            const turbulence = vec3(gauss(rnd(18), rnd(19)).mul(.35).mul(sp.spreadScale), gauss(rnd(20), rnd(21)).mul(.3), gauss(rnd(22), rnd(23)).mul(.35).mul(sp.spreadScale)).mul(speed);
            vel.assign(vec3(surf.x.mul(2).add(sp.dir.x.mul(speed).mul(.6)), speed.mul(rnd(24).mul(.8).add(.7)), surf.y.mul(2).add(sp.dir.y.mul(speed).mul(.6))).add(turbulence));
            born.assign(1); strength.assign(deficit.mul(.6).add(.4));
          });
        });
        If(born.greaterThan(.5), () => {
          const y = surfaceAt(at).add(.1);
          splash.element(i).assign(vec4(at.x, y, at.y, 0));
          splashVel.element(i).assign(vec4(vel, float(1.5).add(rnd(25).mul(2.5))));
          // Sizes log-uniform over three octaves: a third to nearly three
          // times the base ("more varied in scale", user, 2026-09-07).
          splashAux.element(i).assign(vec4(strength, float(2).pow(rnd(26).mul(3).sub(1.5)), 0, 0));
        });
      });
    })().compute(splashCount);
    particleInit.__giPassName = "sea.foamInit"; particleStep.__giPassName = "sea.foamStep"; liveReset.__giPassName = "sea.foamLiveReset";
    splashInit.__giPassName = "sea.splashInit"; splashStep.__giPassName = "sea.splashStep";
    sprayClear.__giPassName = "sea.sprayClear"; sprayScatter.__giPassName = "sea.sprayScatter";
    return { particleInit, particleStep, liveReset, splashInit, splashStep, sprayClear, sprayScatter, flow };
  };
  spectrum.flowField = () => spectrum.flow;
  // ── THE SPLAT ────────────────────────────────────────────────────────────
  // Every live particle is a Gaussian of `f.disc` metres (times its size
  // factor) in the map (the window's NDC; the target's row 0 is the TOP, so
  // z runs down as the caustic pass's does), additive, fading as
  // 1 − e^{−remaining/(T/3)} — the paper's — times its intensity; a dead one
  // is clipped away. A fold's foam is a STREAK along the wind (along the
  // current when there is one), 2.5 : 1 at the same area; a hull's and a
  // splash's stays round. Flat tops summed leave rings; Gaussians sum smooth.
  const splatGeometry = new THREE.InstancedBufferGeometry();
  { const plane = new THREE.PlaneGeometry(1, 1); splatGeometry.setAttribute("position", plane.getAttribute("position")); splatGeometry.setAttribute("uv", plane.getAttribute("uv")); splatGeometry.setIndex(plane.getIndex()); }
  splatGeometry.instanceCount = particleCount;
  const splatMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const splatParticle = particles.element(instanceIndex);
  const splatAlive = splatParticle.z.lessThan(splatParticle.w);
  const splatAux = particleAux.element(instanceIndex);
  const streakAxis = uniform(new THREE.Vector2(1, 0));
  f.streakAxis = streakAxis;
  const splatAspect = mix(float(1), float(2.5), splatAux.z);
  const splatAlong = streakAxis.mul(positionGeometry.x).mul(splatAspect.sqrt());
  const splatAcross = vec2(streakAxis.y.negate(), streakAxis.x).mul(positionGeometry.y).div(splatAspect.sqrt());
  // DISPERSION (Sea of Thieves blurs its foam buffer with feedback): a
  // speck grows to two and a half times its size over its life and thins
  // with it, so a patch spreads and dissolves rather than winking out.
  const splatGrow = splatParticle.z.div(splatParticle.w.max(1e-3)).clamp(0, 1).mul(1.5).add(1);
  const splatNdc = splatParticle.xy.sub(f.center).div(f.half).add(splatAlong.add(splatAcross).mul(f.disc.mul(splatAux.y).mul(splatGrow).div(f.half)));
  splatMaterial.vertexNode = vec4(splatNdc.x, splatNdc.y.negate(), select(splatAlive, float(0), float(2)), 1);
  const splatIntensity = varying(
    splatParticle.w.sub(splatParticle.z).max(0).div(f.life.div(3)).negate().exp().oneMinus().mul(splatParticle.z.div(.5).clamp(0, 1)).mul(splatAux.x).div(splatGrow),
    "seaFoamSplat");
  const splatRadius = uvAttribute().sub(.5).length().mul(2);
  splatMaterial.colorNode = vec3(splatRadius.mul(splatRadius).mul(-4).exp().mul(splatIntensity).mul(FOAM_CARRY));
  const splatMesh = new THREE.Mesh(splatGeometry, splatMaterial);
  splatMesh.frustumCulled = false; splatMesh.renderOrder = 1;
  // The carry: last frame's map, at the same world position, × (1 − FOAM_CARRY).
  const previousFoam = texture(foamTargets[1].texture);
  const carryMaterial = new THREE.MeshBasicNodeMaterial({ transparent: false, depthTest: false, depthWrite: false, blending: THREE.NoBlending, side: THREE.DoubleSide, fog: false });
  carryMaterial.vertexNode = vec4(positionGeometry.xy, 0, 1);
  {
    const mapUv = vec2(uvAttribute().x, uvAttribute().y.oneMinus());
    const prevUv = mapUv.add(f.center.sub(f.prevCenter).div(f.half.mul(2)));
    const inside = prevUv.x.greaterThan(0).and(prevUv.x.lessThan(1)).and(prevUv.y.greaterThan(0)).and(prevUv.y.lessThan(1));
    carryMaterial.colorNode = select(inside, previousFoam.sample(prevUv).level(0).xyz, vec3(0)).mul(1 - FOAM_CARRY);
  }
  const carryMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), carryMaterial);
  carryMesh.frustumCulled = false; carryMesh.renderOrder = 0;
  const splatScene = new THREE.Scene(); splatScene.add(carryMesh); splatScene.add(splatMesh);
  const splatCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const previousClear = new THREE.Color();
  // ── THE SPRAY'S SPRITES ─────────────────────────────────────────────────
  // SPLASH_SPRITES billboards per splash particle (jittered a hand around
  // it, sized apart — a drop is a cloud of drops) in the water's local
  // frame (the mesh is a child of the lid's object; `sp.scale` is the sea's
  // metres per local unit), a streak along its velocity fading with age; a
  // dead one has no size.
  const splashGeometry = new THREE.InstancedBufferGeometry();
  { const plane = new THREE.PlaneGeometry(1, 1); splashGeometry.setAttribute("position", plane.getAttribute("position")); splashGeometry.setAttribute("uv", plane.getAttribute("uv")); splashGeometry.setIndex(plane.getIndex()); }
  splashGeometry.instanceCount = splashCount * spriteCount;
  // ⚠ LIT, NOT BASIC. A basic material drew every drop the same white in
  // sun and in shadow ("purely white regardless of shadow or lit", user,
  // 2026-09-07). A standard material takes the sun, its shadow map and
  // GI's probe field (`giParticle`, as the engine's lit particles do); the
  // drop's normal leans toward the sky with a little toward the eye, so
  // it is lit from above and never goes black when the sun is behind it.
  const splashMaterial = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide, fog: false, roughness: 1, metalness: 0 });
  splashMaterial.userData.giParticle = true;
  {
    const which = instanceIndex.div(uint(spriteCount)), k = instanceIndex.mod(uint(spriteCount));
    const part = splash.element(which), velocity = splashVel.element(which), aux = splashAux.element(which);
    const alive = part.w.lessThan(velocity.w);
    const j0 = pcg(instanceIndex.mul(uint(2654435761)).add(uint(11))), j1 = pcg(instanceIndex.mul(uint(2654435761)).add(uint(23))), j2 = pcg(instanceIndex.mul(uint(2654435761)).add(uint(37)));
    const spread = part.w.mul(2).clamp(.45, 1.6);   // the sheet's drops separate with age
    const jitter = select(k.equal(uint(0)), vec3(0), vec3(j0.sub(.5), j1.sub(.5).mul(.6), j2.sub(.5)).mul(sp.size.mul(3)).mul(spread));
    const world = part.xyz.add(jitter);
    const centre = vec3(world.x.div(sp.scale.x), world.y.div(sp.scale.y), world.z.div(sp.scale.z));
    // ⚠ THE BILLBOARD IS BUILT IN WORLD SPACE. In the water's local space
    // (scaled 500 × 60 × 500 on an ocean) a camera-facing plane is skewed
    // and edge-on once the scale is applied — "flat plane textures that do
    // not billboard … hard to see even" (user, 2026-09-07). The basis is
    // world metres; only the finished offset goes back to local through
    // the inverse model matrix (a vector: rotation and scale, no offset).
    const worldPos = modelWorldMatrix.mul(vec4(centre, 1)).xyz;
    const toCam = normalize(cameraPosition.sub(worldPos).add(vec3(0, 1e-5, 0)));
    const velLocal = vec3(velocity.x.div(sp.scale.x), velocity.y.div(sp.scale.y), velocity.z.div(sp.scale.z));
    const along = modelWorldMatrix.mul(vec4(velLocal, 0)).xyz.add(vec3(0, 1e-4, 0));
    const speed = velocity.xyz.length();
    const dir = normalize(along);
    const right = normalize(cross(dir, toCam).add(vec3(1e-5, 0, 0)));
    const up = cross(toCam, right);
    // Bigger while a sheet, smaller as drops.
    const sheet = part.w.mul(1.5).clamp(0, 1).oneMinus().mul(.15).add(1);
    const size = select(alive, sp.size.mul(sp.sizeScale).mul(aux.y).mul(float(2).pow(j2.mul(2).sub(1))).mul(sheet), float(0));
    const stretch = speed.mul(.25).add(1).min(4);
    const offsetWorld = right.mul(positionGeometry.x).add(up.mul(positionGeometry.y).mul(stretch)).mul(size);
    splashMaterial.positionNode = centre.add(modelWorldMatrixInverse.mul(vec4(offsetWorld, 0)).xyz);
    // A sheet is translucent water, a drop is a bright bead: the opacity
    // climbs from .45 to .9 over the first half second.
    const fade = varying(part.w.div(velocity.w.max(1e-3)).oneMinus().clamp(0, 1).mul(aux.x).mul(part.w.mul(2).clamp(0, 1).mul(.55).add(.35)), "seaSplashFade");
    splashMaterial.colorNode = vec3(.9);
    splashMaterial.normalNode = transformNormalToView(normalize(toCam.mul(.5).add(vec3(0, 1, 0))));
    splashMaterial.opacityNode = uvAttribute().sub(.5).length().mul(2).smoothstep(.3, 1).oneMinus().mul(fade).mul(.9);
  }
  const splashMesh = new THREE.Mesh(splashGeometry, splashMaterial);
  splashMesh.frustumCulled = false; splashMesh.renderOrder = 100; splashMesh.name = "sea spray";
  // ⛔ NEVER BATCHED OR MERGED: a GPU-driven instanced geometry whose
  // vertices come from storage buffers has nothing a batcher can copy — the
  // engine's batcher took it and bound an EMPTY storage buffer in the
  // vertex stage ("Binding size for [Buffer] is zero … bindGroup_object",
  // user, 2026-09-07). The lid and the body carry the same flags.
  splashMesh.userData.noBatch = true; splashMesh.userData.noMerge = true;
  splashMesh.castShadow = false; splashMesh.receiveShadow = true;
  spectrum.splashMesh = splashMesh;
  return spectrum;
}

// ── SAMPLING THE SEA, IN TSL ─────────────────────────────────────────────────
//
// `world` is a vec2 in WORLD metres (a water's local XZ times its scale, so the
// tiling is in metres whatever the box). `lods` are per-cascade mip levels for
// a compute stage that has no screen derivatives — a vertex spacing coarser
// than a cascade's texel must read a coarser level or it aliases; a fragment
// passes null and lets the hardware pick.

/** Σ displacement (x, y, z, world metres) over the cascades, and in `.w` the
 *  Σ of λ·Dxz — the cross term the Jacobian of the composed surface needs. */
// ⚠ HALF A TEXEL, AND IT IS NOT A DETAIL. The transform puts sample i at
// x = i·L/N, but a sampler puts texel i's CENTRE at (i + ½)/N — so `x/L`
// alone reads every cascade half a texel early, and the coarse cascade's
// band reaches waves only 2.7 texels long, where half a texel is most of a
// wave. The CPU (`sampleDisplacement`) follows the transform; so must this,
// or buoyancy floats on a sea the eye does not see.
const texelCentre = (spectrum) => .5 / spectrum.size;
export function seaDisplacementAt(spectrum, world, lods = null) {
  let sum = vec4(0);
  spectrum.cascades.forEach((c, i) => {
    const uv = world.add(spectrum.uniforms.scroll).mul(c.uniforms.invL).add(texelCentre(spectrum));
    let s = spectrum.nodes.displacement.sample(uv).depth(i);
    if (lods) s = s.level(lods[i]);
    sum = sum.add(s);
  });
  return sum;
}
/**
 * ⭐ THE JACOBIAN OF THE COMPOSED SURFACE: J = (1 + Σλ·Dxx)(1 + Σλ·Dzz) −
 * (Σλ·Dxz)², summed over the cascades BEFORE the product — the horizontal
 * displacement gradient of the surface the eye sees, not of any one layer.
 * Below zero the surface has folded over itself; that is what foam is made
 * of, and `seaFoamNode` turns its deficit into a source for the foam field.
 * `crossSum` is `seaDisplacementAt(...).w`, already sampled by the caller.
 */
export function seaJacobianAt(spectrum, world, crossSum, lods = null) {
  let dxx = float(0), dzz = float(0);
  spectrum.cascades.forEach((c, i) => {
    const uv = world.add(spectrum.uniforms.scroll).mul(c.uniforms.invL).add(texelCentre(spectrum));
    let s = spectrum.nodes.derivatives.sample(uv).depth(i);
    if (lods) s = s.level(lods[i]);
    dxx = dxx.add(s.z); dzz = dzz.add(s.w);
  });
  return dxx.add(1).mul(dzz.add(1)).sub(crossSum.mul(crossSum));
}
/**
 * The sea's slope (dy/dx, dy/dz, world) from the derivative cascades —
 * Babylon's `slope = (d.x/(1+d.z), d.y/(1+d.w))`, the horizontal displacement
 * folded into the denominator. `weights[i]` fades a cascade (distance LOD,
 * `surfaceDetail`); `lods` as above.
 */
export function seaSlopeAt(spectrum, world, { lods = null, weights = null } = {}) {
  let d = vec4(0);
  spectrum.cascades.forEach((c, i) => {
    const uv = world.add(spectrum.uniforms.scroll).mul(c.uniforms.invL).add(texelCentre(spectrum));
    let s = spectrum.nodes.derivatives.sample(uv).depth(i);
    if (lods) s = s.level(lods[i]);
    if (weights) s = s.mul(weights[i]);
    d = d.add(s);
  });
  return vec2(d.x.div(d.z.add(1)), d.y.div(d.w.add(1)));
}
/**
 * Jacobian foam on the COMPOSED surface: `foam` sets how far into folding a
 * crest has to be. J is 1 on flat water and crosses 0 as the surface folds;
 * at `foam` 1 a crest past J = 0.4 (well into breaking) counts, at 0.25 it
 * takes J < −0.3 — folded right over. This is a SOURCE for the persistent
 * foam field (gridSimulation), which is what gives a fold's foam its life
 * after the crest has moved on.
 */
/**
 * The FOLD itself — the rare event that seeds the persistent foam field
 * (the memory: foam that trails a breaking crest for seconds). Independent
 * of `foam`: at the folding limit the composed Jacobian's first percentile
 * sits near 0.5 on a pond and on an ocean alike, so this opens on the
 * steepest one or two percent of crests. The visible whitecaps are
 * `seaFoamNode`, per pixel and instantaneous; feeding THAT to the field
 * turned a pool into a 90 % sheet within a second (harness, 2026-09-06).
 */
export function seaFoldNode(jacobian) {
  return float(.45).sub(jacobian).div(.15).clamp(0, 1);
}
/**
 * The whitecap memory at a world point (see FOAM_WINDOW_METRES): 0–1, fading
 * to nothing over the window's outer 4 %. `level` for a compute stage (no
 * screen derivatives); a fragment lets the hardware pick — the mips are a
 * COVERAGE, so a far pixel reads the fraction of its footprint that foams.
 */
export function seaFoamWindowNode(spectrum, world, level = null) {
  const f = spectrum.foam;
  if (!f) return float(0);
  const uv = world.sub(f.center).div(f.half.mul(2)).add(.5).toVar();
  const margin = uv.x.min(uv.x.oneMinus()).min(uv.y).min(uv.y.oneMinus());
  let s = spectrum.nodes.foam.sample(uv.clamp(.001, .999));
  if (level != null) s = s.level(level);
  return s.x.mul(margin.smoothstep(0, .04));
}
/**
 * The FOLD of the composed surface: x = the minimum eigenvalue of the
 * horizontal displacement's Jacobian (a fold along one direction reads
 * under ~0.55 — Tessendorf's test, the paper's emission criterion — where
 * the determinant alone could stay near 1), yz = the unit direction of the
 * MAXIMUM eigenvector, i.e. along the crest, which the whitecap coverage
 * rule spreads foam along.
 */
export function seaFoldAt(spectrum, world, lods = null) {
  let dxx = float(0), dzz = float(0);
  spectrum.cascades.forEach((c, i) => {
    const uv = world.add(spectrum.uniforms.scroll).mul(c.uniforms.invL).add(texelCentre(spectrum));
    let s = spectrum.nodes.derivatives.sample(uv).depth(i);
    if (lods) s = s.level(lods[i]);
    dxx = dxx.add(s.z); dzz = dzz.add(s.w);
  });
  const b = seaDisplacementAt(spectrum, world, lods).w;
  const a = dxx.add(1), d = dzz.add(1);
  const tr = a.add(d), det = a.mul(d).sub(b.mul(b));
  const disc = tr.mul(tr).sub(det.mul(4)).max(0).sqrt();
  const lmin = tr.sub(disc).mul(.5), lmax = tr.add(disc).mul(.5);
  // The eigenvector of λmax: (b, λmax − a), or an axis when b vanishes.
  const v = select(b.abs().greaterThan(1e-4), vec2(b, lmax.sub(a)), select(a.greaterThanEqual(d), vec2(1, 0), vec2(0, 1)));
  return vec3(lmin, v.normalize());
}
/** Σ horizontal velocity (metres per second of the sea's time, world) over the cascades. */
export function seaVelocityAt(spectrum, world, lods = null) {
  let sum = vec2(0);
  spectrum.cascades.forEach((c, i) => {
    const uv = world.add(spectrum.uniforms.scroll).mul(c.uniforms.invL).add(texelCentre(spectrum));
    let s = spectrum.nodes.velocity.sample(uv).depth(i);
    if (lods) s = s.level(lods[i]);
    sum = sum.add(s.xy);
  });
  return sum;
}
export function seaFoamNode(jacobian, foam) {
  // ⚠ THE GATE IS ON J ITSELF. It used to open at 1 − J > mix(1.3, .6, foam),
  // i.e. J < −0.3 … 0.4 — and at the ocean preset with full choppiness the
  // composed Jacobian never drops below 0.2 (p1 0.52, p5 0.64, measured on
  // the CPU model, 2026-09-06): whitecaps could not exist by construction.
  // A whitecap is a crest steep enough to fold, and the folding limit keeps
  // the sea just short of it, so the gate sits in the steep tail: `foam` 0
  // opens at J < 0.45 (nothing at the limit), 1 at J < 0.85 (the steepest
  // third), 0.7 — the ocean preset's crests — at J < 0.73.
  return mix(float(.45), float(.85), foam).sub(jacobian).div(.25).clamp(0, 1);
}
/**
 * The per-pixel shading slope: every cascade with Babylon's distance fade
 * (min(LOD_SCALE × L / viewDist, 1) — a cascade drops out of the normal as its
 * texels fall under a pixel). This is what replaced the value-noise "detail
 * normal": real waves, at every scale the spectrum carries, band-limited by
 * the hardware mip chain.
 *
 * `surfaceDetail` is the SUB-VERTEX part of that slope: the difference between
 * the cascades at full resolution and the same cascades at the mip the mesh's
 * vertices sample (`vertexLods`, the solver's `seaLod`). At 0 the pixel normal
 * carries exactly what the geometry does; at 2 the structure finer than a
 * vertex is doubled. Defined this way it works at any peak wavelength — as
 * "the weight of the finest cascade" it scaled a cascade that, on a short
 * peak, carries nothing ("DEAD surfaceDetail", the property sweep, 2026-09-06).
 */
/**
 * The slope variance the shading normal has LOST to distance: each cascade
 * fades out of `seaShadingSlopeNode` as its texels fall under a pixel, and
 * the chop it carried must become ROUGHNESS or the far sea turns to glass —
 * a flat mirror of a flat sky with no sparkle in it (the ocean arm,
 * 2026-09-06). Toksvig's idea: variance that cannot be a normal is a lobe.
 */
export function seaLostSlopeVarianceNode(spectrum) {
  const viewDist = positionWorld.sub(cameraPosition).length();
  let lost = float(0);
  for (const c of spectrum.cascades) {
    const fade = float(1).div(c.uniforms.invL).mul(LOD_SCALE).div(viewDist.max(1e-3)).min(1);
    lost = lost.add(fade.oneMinus().mul(c.uniforms.slopeVariance));
  }
  return lost;
}
export function seaShadingSlopeNode(spectrum, world, surfaceDetail, vertexLods = null) {
  const viewDist = positionWorld.sub(cameraPosition).length();
  let d = vec4(0);
  spectrum.cascades.forEach((c, i) => {
    const uv = world.add(spectrum.uniforms.scroll).mul(c.uniforms.invL).add(texelCentre(spectrum));
    const fade = float(1).div(c.uniforms.invL).mul(LOD_SCALE).div(viewDist.max(1e-3)).min(1);
    const full = spectrum.nodes.derivatives.sample(uv).depth(i);
    let s = full;
    if (vertexLods) {
      const coarse = spectrum.nodes.derivatives.sample(uv).depth(i).level(vertexLods[i]);
      s = coarse.add(full.sub(coarse).mul(surfaceDetail));
    }
    d = d.add(s.mul(fade));
  });
  return vec2(d.x.div(d.z.add(1)), d.y.div(d.w.add(1)));
}
