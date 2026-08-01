import * as THREE from "three/webgpu";
import { blend1D, blend2D, syncTimeScales } from "./anim/blendTree.js";
import { drivenNodes, filterClipToMask, makeAdditiveClip, resolveMaskBones } from "./anim/mask.js";
import { findRootBone, RootMotionExtractor } from "./anim/rootMotion.js";

/**
 * Animation controller assets (.anim): a Unity/PlayCanvas-style state machine
 * serialized as JSON.
 *
 *   {
 *     version: 2,
 *     parameters: [{ name, type: "number"|"boolean"|"trigger", default? }],
 *     layers: [{
 *       id, name,
 *       weight: 0..1,                       // authored default; scripts can drive it
 *       blend: "override" | "additive",
 *       mask: { bones: [...], includeChildren?, invert? } | null,
 *       states: [{
 *         id, name, speed?, loop?, x?, y?,  // x/y are graph-editor positions
 *         kind: "clip" | "blend1d" | "blend2d",
 *         clip,                             // kind "clip"
 *         blendParam, blendParamY,          // kind "blend1d"/"blend2d"
 *         blendMode: "cartesian"|"directional",
 *         syncTime?: boolean,               // default true — see blendTree.js
 *         children: [{ clip, threshold, px, py, speed? }]
 *       }],
 *       startTransitions: [{ to, conditions }],
 *       transitions: [{
 *         id, from: "<stateId>"|"__any__", to: "<stateId>",
 *         duration?: seconds, exitTime?: 0..1|null, offset?: 0..1,
 *         conditions: [{ param, op, value }]
 *       }]
 *     }]
 *   }
 *
 * Version 1 files were flat — `states`/`transitions`/`startTransitions` at the
 * top level, one implicit layer. `normalizeGraph` folds those into a single
 * "Base Layer" on load, so old controllers keep working untouched and are
 * upgraded in place the next time the Animator panel saves.
 *
 * The `__start__` pseudo-state is the entrance to a layer's graph. Drag a wire
 * from the Start node to a state to declare it the default entry — the first
 * Start→X transition whose conditions pass (against parameter defaults) wins;
 * without any, the runtime falls back to the first state in the list.
 *
 * ---------------------------------------------------------------------------
 * Why this owns action weights instead of using crossFadeTo()
 *
 * three's `crossFadeTo`/`fadeIn` schedule weight interpolants inside the mixer.
 * That is fine for one state machine, but layers need the *composed* weight of
 * every contributing action to be exact — an override layer at weight 1 must
 * fully replace the base layer, and the mixer's per-track normalisation only
 * produces that if the numbers going in are right. So transitions here are
 * timed by the runtime and written with `setEffectiveWeight` each frame. It
 * also makes blend trees possible at all: their children's weights change every
 * frame from a parameter, which no scheduled interpolant can express.
 */

export const ANY_STATE = "__any__";
export const START_STATE = "__start__";

// Minimum time a freshly-entered state is protected from being reversed out of
// (seconds). Even zero-duration transitions get this much dwell so a graph with
// overlapping/contradictory conditions can't flip back every frame — which,
// because each entry resets the clip to time 0, freezes the model on its first
// frame instead of playing.
const MIN_TRANSITION_LOCK = 0.05;

// The base layer is never allowed to reach exactly zero weight. Bones that no
// override layer's mask covers would otherwise have NO contributor at all and
// freeze at whatever the mixer last wrote. three normalises each track by the
// cumulative weight of its contributors, so a lone contributor at 1e-4 still
// produces its pose exactly — the floor costs nothing and removes the cliff.
const BASE_WEIGHT_FLOOR = 1e-4;

const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export function createDefaultAnimator() {
  return {
    version: 2,
    parameters: [],
    layers: [createLayer("Base Layer")],
  };
}

export function createLayer(name = "Layer") {
  return {
    id: uid("layer"),
    name,
    weight: 1,
    blend: "override",
    mask: null,
    states: [],
    startTransitions: [],
    transitions: [],
  };
}

export function createClipState(name, clip = "") {
  const id = uid("state");
  return { id, name, kind: "clip", clip, speed: 1, loop: true, x: 0, y: 0 };
}

/** Fills in defaults so the runtime and the editor never branch on "missing". */
function normalizeState(state) {
  const kind = state.kind === "blend1d" || state.kind === "blend2d" ? state.kind : "clip";
  const out = {
    speed: 1,
    loop: true,
    x: 0,
    y: 0,
    ...state,
    kind,
  };
  if (kind === "clip") {
    out.clip = state.clip ?? "";
  } else {
    out.children = (state.children ?? []).map((c) => ({
      clip: c.clip ?? "",
      threshold: Number.isFinite(c.threshold) ? c.threshold : 0,
      px: Number.isFinite(c.px) ? c.px : 0,
      py: Number.isFinite(c.py) ? c.py : 0,
      speed: Number.isFinite(c.speed) ? c.speed : 1,
    }));
    out.blendParam = state.blendParam ?? "";
    out.syncTime = state.syncTime !== false;
    if (kind === "blend2d") {
      out.blendParamY = state.blendParamY ?? "";
      out.blendMode = state.blendMode === "directional" ? "directional" : "cartesian";
    }
  }
  return out;
}

function normalizeLayer(layer, index) {
  return {
    id: layer.id ?? uid("layer"),
    name: layer.name ?? (index === 0 ? "Base Layer" : `Layer ${index}`),
    weight: Number.isFinite(layer.weight) ? layer.weight : 1,
    blend: layer.blend === "additive" ? "additive" : "override",
    mask: layer.mask?.bones?.length ? layer.mask : null,
    states: (layer.states ?? []).map(normalizeState),
    startTransitions: layer.startTransitions ?? [],
    transitions: layer.transitions ?? [],
    startPosition: layer.startPosition,
    anyPosition: layer.anyPosition,
  };
}

/**
 * Accepts a v1 or v2 graph and returns a v2 one. Never mutates the input —
 * the editor keeps its own copy and the component may be handed a shared
 * object.
 */
export function normalizeGraph(graph) {
  if (!graph) return createDefaultAnimator();
  const parameters = graph.parameters ?? [];
  if (Array.isArray(graph.layers) && graph.layers.length) {
    return { version: 2, parameters, layers: graph.layers.map(normalizeLayer) };
  }
  return {
    version: 2,
    parameters,
    layers: [
      normalizeLayer(
        {
          id: "layer-base",
          name: "Base Layer",
          weight: 1,
          blend: "override",
          mask: null,
          states: graph.states ?? [],
          startTransitions: graph.startTransitions ?? [],
          transitions: graph.transitions ?? [],
          startPosition: graph.startPosition,
          anyPosition: graph.anyPosition,
        },
        0,
      ),
    ],
  };
}

function compare(op, a, b) {
  switch (op) {
    case ">": return a > b;
    case "<": return a < b;
    case ">=": return a >= b;
    case "<=": return a <= b;
    case "!=": return a !== b;
    case "==":
    default:
      return a === b;
  }
}

// ---------------------------------------------------------------------------
// clip binding
// ---------------------------------------------------------------------------

/**
 * Hands out one `AnimationAction` per (layer, state, child, region) slot.
 *
 * The reason this isn't just `mixer.clipAction(clip)`: three caches actions by
 * clip + root, so two slots playing the same clip would share ONE action — and
 * therefore one playhead. Entering the second state would yank the first one's
 * time, and a blend tree with the same clip at two thresholds (a perfectly
 * reasonable thing to author) would collapse into a single child. Repeat users
 * get a cloned clip so they get their own action.
 */
class ClipBinder {
  constructor(mixer, clips, { root = null } = {}) {
    this.mixer = mixer;
    this.byName = new Map();
    for (const clip of clips ?? []) if (!this.byName.has(clip.name)) this.byName.set(clip.name, clip);
    this.root = root;
    // Shared across every layer of one animator: an unmasked override layer
    // playing the same clip as the base layer would otherwise land on the same
    // cached action and the two layers would share a playhead.
    this._used = new Set();
    this.missing = new Set();
  }

  get(name) {
    return this.byName.get(name) ?? null;
  }

  /** @returns {THREE.AnimationAction|null} */
  acquire(name, { allowed = null, additive = false, loop = true } = {}) {
    const source = this.byName.get(name);
    if (!source) {
      if (name && !this.missing.has(name)) {
        this.missing.add(name);
        console.warn(`Animator: clip "${name}" not found on this model`);
      }
      return null;
    }
    let clip = filterClipToMask(source, allowed);
    if (!clip) return null; // this region excludes every track the clip drives
    if (additive) clip = makeAdditiveClip(clip);
    if (this._used.has(clip)) clip = cloneClip(clip);
    this._used.add(clip);
    const action = this.mixer.clipAction(clip, this.root ?? undefined, clip.blendMode);
    action.loop = loop ? THREE.LoopRepeat : THREE.LoopOnce;
    action.clampWhenFinished = true;
    action.enabled = true;
    action.setEffectiveWeight(0);
    action.zeroSlopeAtStart = false;
    action.zeroSlopeAtEnd = false;
    return action;
  }
}

function cloneClip(clip) {
  const copy = clip.clone();
  copy.blendMode = clip.blendMode;
  return copy;
}

// ---------------------------------------------------------------------------
// mask regions
// ---------------------------------------------------------------------------

/**
 * Splits a layer's skeleton coverage into regions of bones that all see the
 * SAME set of override layers above them.
 *
 * This exists because of one detail of three's mixer: `PropertyMixer.apply`
 * blends its accumulated value toward the BIND POSE by `1 - cumulativeWeight`.
 * So the contributors to a bone must add up to exactly 1, or the character
 * partially snaps to T-pose. That rules out the obvious implementation of
 * layers — "down-weight the base layer so the upper one wins" — because an
 * action's weight applies to ALL of its tracks, so lowering the base layer to
 * make room for a masked aim overlay would also drain the legs, which the
 * overlay doesn't cover and can't refill.
 *
 * Splitting the clip instead gives each region its own action and its own
 * weight, and the per-region weights telescope to exactly 1 on every bone:
 *
 *   base region "arms" = (1 - wAim)    aim layer = wAim
 *   base region "legs" = 1
 *
 * Regions are computed once at build time (masks don't change at runtime, only
 * weights do), so per frame this is a handful of multiplications.
 */
function computeRegions(index, layers, coverage, allNames) {
  const own = layers[index].allowed; // Set | null (null = the whole skeleton)
  const attenuators = [];
  for (let j = index + 1; j < layers.length; j++) {
    // Additive layers add on top of the result; they never replace it, so they
    // don't take weight away from anyone.
    if (!layers[j].additive) attenuators.push(j);
  }
  if (!attenuators.length) return [{ allowed: own, attenuators: [] }];

  const names = own ? [...own] : allNames;
  const groups = new Map();
  for (const name of names) {
    const covering = attenuators.filter((j) => coverage[j].has(name));
    const key = covering.join(",");
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { allowed: new Set(), attenuators: covering }));
    group.allowed.add(name);
  }
  const regions = [...groups.values()];
  // One region means nothing was actually split — keep the layer's own mask
  // (possibly null) so the common case doesn't pay for a filtered clip copy.
  if (regions.length === 1) return [{ allowed: own, attenuators: regions[0].attenuators }];
  return regions;
}

/**
 * The bones a layer can actually write: its mask, narrowed to the nodes its
 * clips genuinely drive.
 *
 * The narrowing matters. If a mask covers the spine but the aim clip only
 * animates the arms, treating the spine as "covered" would take that weight
 * away from the base layer with nothing to replace it — and the spine would
 * drift toward the bind pose in proportion to the layer's weight. A mask that
 * over-reaches its clips is ordinary authoring, not a mistake, so the runtime
 * resolves it instead of reporting it.
 */
function layerCoverage(layer, binder) {
  const driven = new Set();
  for (const state of layer.layer.states ?? []) {
    const names = state.kind === "clip" ? [state.clip] : (state.children ?? []).map((c) => c.clip);
    for (const name of names) {
      const clip = binder.get(name);
      if (clip) drivenNodes(clip, driven);
    }
  }
  if (!layer.allowed) return driven;
  const out = new Set();
  for (const name of layer.allowed) if (driven.has(name)) out.add(name);
  return out;
}

// ---------------------------------------------------------------------------
// states
// ---------------------------------------------------------------------------

/**
 * One state's playback: a single clip, or a blend tree's worth of clips whose
 * relative weights are recomputed from parameters every frame — each of them
 * further split across the layer's mask regions.
 */
class StateRuntime {
  constructor(state, binder, { regions, additive }) {
    this.state = state;
    this.kind = state.kind;
    this.defs = this.kind === "clip" ? [{ clip: state.clip, speed: 1 }] : state.children ?? [];
    this.entries = [];
    const loop = state.loop !== false;
    for (let defIndex = 0; defIndex < this.defs.length; defIndex++) {
      const def = this.defs[defIndex];
      for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
        const action = binder.acquire(def.clip, {
          allowed: regions[regionIndex].allowed,
          additive,
          loop,
        });
        if (!action) continue;
        this.entries.push({ action, clip: action.getClip(), defIndex, regionIndex });
      }
    }
    this.weights = this.defs.map((_, i) => (i === 0 ? 1 : 0));
    this._durations = this.defs.map(
      (_, i) => this.entries.find((e) => e.defIndex === i)?.clip.duration ?? 0,
    );
    this._speeds = this.defs.map((d) => d.speed ?? 1);
  }

  get valid() {
    return this.entries.length > 0;
  }

  /** Restarts every clip from the top (or from `offset`, normalized 0..1). */
  enter(offset = 0) {
    for (const { action, clip } of this.entries) {
      action.reset();
      action.time = offset > 0 ? Math.min(offset, 1) * clip.duration : 0;
      action.setEffectiveWeight(0);
      action.play();
    }
  }

  stop() {
    for (const { action } of this.entries) action.stop();
  }

  /** Recomputes child weights and playback rates from the current parameters. */
  refresh(params) {
    if (!this.entries.length) return;
    const state = this.state;
    const stateSpeed = Number.isFinite(state.speed) ? state.speed : 1;
    if (this.kind === "clip") {
      this.weights[0] = 1;
      for (const entry of this.entries) entry.action.timeScale = stateSpeed;
      return;
    }
    const x = numberParam(params, state.blendParam);
    this.weights =
      this.kind === "blend1d"
        ? blend1D(this.defs, x)
        : blend2D(this.defs, x, numberParam(params, state.blendParamY), state.blendMode);
    const scales =
      state.syncTime !== false
        ? syncTimeScales(this._durations, this.weights, this._speeds)
        : this._speeds;
    for (const entry of this.entries) {
      entry.action.timeScale = scales[entry.defIndex] * stateSpeed;
    }
  }

  /**
   * Normalized 0..1 progress, taken from the highest-weighted child. Exit-time
   * conditions are measured against this, and a blend tree's children are
   * cycle-synced anyway (see `syncTimeScales`), so the dominant one speaks for
   * all of them.
   */
  get normalizedTime() {
    let best = -1;
    let bestWeight = -1;
    for (let i = 0; i < this.defs.length; i++) {
      if (this.weights[i] > bestWeight) {
        bestWeight = this.weights[i];
        best = i;
      }
    }
    const entry = best < 0 ? null : this.entries.find((e) => e.defIndex === best);
    if (!entry || !entry.clip.duration) return 1;
    const t = entry.action.time / entry.clip.duration;
    return entry.action.loop === THREE.LoopRepeat ? t - Math.floor(t) : Math.min(t, 1);
  }

  /** Writes `regionWeight * childWeight * fade` onto each action. */
  apply(regionWeights, fade, out) {
    for (const entry of this.entries) {
      const w = (regionWeights[entry.regionIndex] ?? 0) * this.weights[entry.defIndex] * fade;
      entry.action.setEffectiveWeight(w);
      if (w > 0) out?.push({ action: entry.action, clip: entry.clip, weight: w });
    }
  }
}

function numberParam(params, name) {
  const value = params?.[name];
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return 0;
}

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------

/**
 * One layer's state machine. Built in two phases: the constructor resolves the
 * mask, and `build()` creates the actions — because a layer's regions depend on
 * the masks of the layers ABOVE it, which don't exist yet at construction time.
 */
class LayerRuntime {
  constructor(layer, host, root) {
    this.layer = layer;
    this.host = host;
    this.weight = THREE.MathUtils.clamp(layer.weight ?? 1, 0, 1);
    this.additive = layer.blend === "additive";
    this.allowed = resolveMaskBones(root, layer.mask);
    this.masked = !!this.allowed;
    this.states = new Map();
    this.regions = [];
    this.regionWeights = [];
    this.currentId = null;
    this.prevId = null;
    this.fade = { elapsed: 0, duration: 0 };
    this.transitionLock = 0;
    this.timeInState = 0;
    this._leftId = null;
  }

  build(binder, regions) {
    this.regions = regions;
    this.regionWeights = regions.map(() => 0);
    // States with no playable clip are kept, not dropped. An empty state is how
    // you author "this layer does nothing right now" — the thing an override
    // layer transitions to when the aim pose should stop applying — and
    // transitions still have to be able to name it.
    for (const state of this.layer.states ?? []) {
      this.states.set(state.id, new StateRuntime(state, binder, { regions, additive: this.additive }));
    }
    const entry = this.#resolveEntry();
    if (entry) this.enter(entry, 0);
  }

  #resolveEntry() {
    for (const t of this.layer.startTransitions ?? []) {
      if (!this.states.has(t.to)) continue;
      if (this.#conditionsPass(t, { ignoreExitTime: true })) return t.to;
    }
    return this.layer.states?.[0]?.id ?? null;
  }

  get currentState() {
    return this.currentId ? this.states.get(this.currentId)?.state ?? null : null;
  }

  enter(stateId, fade = 0, offset = 0) {
    const next = this.states.get(stateId);
    if (!next) return;
    const from = this.currentId;
    // A third transition arriving mid-crossfade: the state that was already
    // fading out is dropped outright rather than kept as a third contributor.
    // Three-way blends of a state machine's own history are never what the
    // author drew, and keeping them alive is how "the character is stuck at 40%
    // of a walk" happens.
    if (this.prevId && this.prevId !== from) this.states.get(this.prevId)?.stop();
    this.prevId = null;
    this.fade.elapsed = 0;
    this.fade.duration = 0;
    if (from && from !== stateId) {
      // Re-entering the SAME state is a restart, never a crossfade with itself:
      // one runtime can't hold two playheads, and blending a state against
      // itself would write its weight twice and land on the second value.
      if (fade > 0) {
        this.prevId = from;
        this.fade.duration = fade;
      } else {
        this.states.get(from)?.stop();
      }
    }
    this._leftId = from;
    this.currentId = stateId;
    next.enter(offset);
    this.timeInState = 0;
    this.transitionLock = Math.max(fade, MIN_TRANSITION_LOCK);
  }

  /** Force-play by state name or id (editor preview / scripted override). */
  play(nameOrId, fade = 0.2) {
    for (const [id, runtime] of this.states) {
      if (id === nameOrId || runtime.state.name === nameOrId) {
        this.enter(id, fade);
        return true;
      }
    }
    return false;
  }

  #conditionsPass(transition, { ignoreExitTime = false } = {}) {
    const params = this.host.params;
    const types = this.host.paramTypes;
    const conditions = transition.conditions ?? [];
    for (const c of conditions) {
      const value = params[c.param];
      if (types[c.param] === "trigger") {
        if (!value) return false;
      } else if (!compare(c.op ?? "==", value, c.value)) {
        return false;
      }
    }
    if (ignoreExitTime) return true;
    const exitTime = transition.exitTime ?? (conditions.length === 0 ? 1 : null);
    if (exitTime == null) return true;
    const current = this.currentId ? this.states.get(this.currentId) : null;
    const normalized = current ? current.normalizedTime : 1;
    return normalized >= Math.min(exitTime, 1) - 1e-4;
  }

  #consumeTriggers(transition) {
    for (const c of transition.conditions ?? []) {
      if (this.host.paramTypes[c.param] === "trigger") this.host.params[c.param] = false;
    }
  }

  /** Advances the crossfade timer and takes at most one transition. */
  evaluate(dt) {
    this.timeInState += dt;
    if (this.transitionLock > 0) this.transitionLock -= dt;
    if (this.fade.duration > 0) {
      this.fade.elapsed += dt;
      if (this.fade.elapsed >= this.fade.duration) {
        this.fade.duration = 0;
        if (this.prevId) this.states.get(this.prevId)?.stop();
        this.prevId = null;
      }
    }
    if (!this.currentId) return;

    for (const t of this.layer.transitions ?? []) {
      if (t.to === this.currentId) continue; // self-loops would reset to frame 0 forever
      const fromCurrent = t.from === this.currentId;
      const fromAny = t.from === ANY_STATE;
      if (!fromCurrent && !fromAny) continue;
      if (!this.states.has(t.to)) continue;
      // Anti-thrash: while the crossfade into the current state is still
      // settling, don't reverse straight back into the state we just left.
      // Overlapping conditions (Walk→Run at speed>2 and Run→Walk at speed<3,
      // both true at 2.5) would otherwise flip every frame, and each entry
      // resets the clip — freezing the model on frame 0.
      if (this.transitionLock > 0 && t.to === this._leftId) continue;
      if (!this.#conditionsPass(t)) continue;
      this.#consumeTriggers(t);
      this.enter(t.to, t.duration ?? 0.25, t.offset ?? 0);
      break;
    }
  }

  /** Recomputes blend-tree weights for whichever states are contributing. */
  refresh(params) {
    this.states.get(this.currentId)?.refresh(params);
    if (this.prevId) this.states.get(this.prevId)?.refresh(params);
  }

  /** Writes this layer's action weights and records its contributions. */
  apply(layers, out) {
    for (let r = 0; r < this.regions.length; r++) {
      let w = this.weight;
      for (const j of this.regions[r].attenuators) w *= 1 - layers[j].weight;
      this.regionWeights[r] = w;
    }
    const current = this.states.get(this.currentId);
    const prev = this.prevId ? this.states.get(this.prevId) : null;
    let t = 1;
    if (prev && this.fade.duration > 0) {
      t = THREE.MathUtils.clamp(this.fade.elapsed / this.fade.duration, 0, 1);
    }
    current?.apply(this.regionWeights, t, out);
    prev?.apply(this.regionWeights, 1 - t, out);
  }

  stopAll() {
    for (const runtime of this.states.values()) runtime.stop();
  }
}

// ---------------------------------------------------------------------------
// animator
// ---------------------------------------------------------------------------

export class AnimatorRuntime {
  /**
   * @param graph  parsed .anim JSON (v1 or v2)
   * @param mixer  THREE.AnimationMixer bound to the model root
   * @param clips  THREE.AnimationClip[] available on the model
   * @param options `{ root, entityObject, rootMotion: { enabled, applyY, applyRotation, bone } }`
   */
  constructor(graph, mixer, clips, options = {}) {
    this.graph = normalizeGraph(graph);
    this.mixer = mixer;
    this.params = {};
    this.contributions = [];
    this.baseContributions = [];

    for (const p of this.graph.parameters ?? []) {
      this.params[p.name] = p.default ?? (p.type === "number" ? 0 : false);
    }
    this.paramTypes = Object.fromEntries((this.graph.parameters ?? []).map((p) => [p.name, p.type]));

    const root = options.root ?? mixer.getRoot();
    this.layers = this.graph.layers.map((layer) => new LayerRuntime(layer, this, root));
    // The base layer is authoritative: its authored weight is ignored (a base
    // layer at 0.3 means "the character is 70% not animated", which is never
    // what anyone wants) and it always contributes fully.
    if (this.layers[0]) this.layers[0].weight = 1;

    const binder = new ClipBinder(mixer, clips, { root });
    const allNames = [];
    root?.traverse((object) => {
      if (object.name) allNames.push(object.name);
    });
    const coverage = this.layers.map((layer) => layerCoverage(layer, binder));
    this.layers.forEach((layer, i) =>
      layer.build(binder, computeRegions(i, this.layers, coverage, allNames)),
    );

    this.rootMotion = null;
    const rm = options.rootMotion;
    if (rm?.enabled) {
      const bone = findRootBone(root, clips, rm.bone ?? "");
      if (bone) {
        this.rootMotion = new RootMotionExtractor(options.entityObject ?? root, bone, {
          applyY: rm.applyY,
          applyRotation: rm.applyRotation,
        });
      } else {
        console.warn("Root motion is on, but this model has no bone carrying root translation.");
      }
    }
  }

  get currentState() {
    return this.layers[0]?.currentState ?? null;
  }

  /** Per-layer current state names — what the editor's readout shows. */
  get layerStates() {
    return this.layers.map((l) => l.currentState?.name ?? null);
  }

  setParam(name, value) {
    if (!(name in this.params)) return console.warn(`Animator: unknown parameter "${name}"`);
    this.params[name] = value;
  }

  /** Triggers stay set until a transition consumes them. */
  setTrigger(name) {
    this.setParam(name, true);
  }

  getParam(name) {
    return this.params[name];
  }

  /** Resolves a layer by index or name. */
  layer(ref = 0) {
    if (typeof ref === "number") return this.layers[ref] ?? null;
    return this.layers.find((l) => l.layer.name === ref || l.layer.id === ref) ?? null;
  }

  setLayerWeight(ref, weight) {
    const layer = this.layer(ref);
    if (!layer) return console.warn(`Animator: no layer "${ref}"`);
    // Index 0 is structural, not a dial — see the constructor.
    if (layer === this.layers[0]) return;
    layer.weight = THREE.MathUtils.clamp(weight, 0, 1);
  }

  getLayerWeight(ref) {
    return this.layer(ref)?.weight ?? 0;
  }

  /** Force-play a state (editor preview / scripted override). */
  play(stateName, fade = 0.2, layerRef = 0) {
    const layer = this.layer(layerRef);
    if (!layer?.play(stateName, fade)) console.warn(`Animator: no state "${stateName}"`);
  }

  update(dt) {
    // Order matters: decide transitions and weights FIRST, then let the mixer
    // apply them. Advancing the mixer first would pose the frame with last
    // frame's weights, so a blend driven by a fast-moving parameter would lag
    // it by one frame — visible as the legs answering the stick late.
    for (const layer of this.layers) {
      layer.evaluate(dt);
      layer.refresh(this.params);
    }

    this.contributions.length = 0;
    this.baseContributions.length = 0;
    for (let i = 0; i < this.layers.length; i++) {
      this.layers[i].apply(this.layers, i === 0 ? this.baseContributions : this.contributions);
    }
    this.contributions.push(...this.baseContributions);

    // Root motion comes from the base layer only. An upper layer's masked clip
    // has had the root track filtered out anyway, and letting an aim overlay
    // steer the character would be a bug you would chase for a long time.
    this.rootMotion?.snapshot(this.baseContributions);
    this.mixer.update(dt);
    this.rootMotion?.extract(this.baseContributions, dt);
  }

  dispose() {
    for (const layer of this.layers) layer.stopAll();
    this.mixer.stopAllAction();
  }
}
