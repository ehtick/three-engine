// @ts-check
import { Component } from "./Component.js";
import { runActions } from "../events/actions.js";
import { collectTriggers, runGraph } from "../events/graph.js";

/**
 * Wires events to behaviour without a script.
 *
 * This is Godot's Signals dock and Unity's `UnityEvent` inspector, combined
 * into one component: each row reads
 *
 *     WHEN <something happens>   THEN <do these things>
 *
 * Godot stores its connections on the emitter node and Unity stores its
 * response list on the component that fires it; this stores both halves on
 * whichever entity the author thinks the behaviour belongs to, which is the
 * only arrangement that can express "when the GLOBAL event `wave-cleared`
 * fires, open THIS door" without inventing an owner for the global event.
 *
 * ## Why the handlers are attached once and gated, rather than attached on Play
 *
 * Subscribing on `play-changed` sounds tidier but loses every event emitted
 * during the same frame Play starts — including `scene-loaded`, which is
 * exactly what a "when the level loads" row is for. So the subscriptions live
 * for as long as the component does, and each one checks `engine.playing`
 * before running anything. Nothing fires while the author is editing, which
 * matters more than it sounds: a `destroy` action triggered by
 * `hierarchy-changed` in edit mode would eat the scene as it was being built.
 */
export class EventBindingComponent extends Component {
  static type = "events";
  static label = "Events";
  static tags = ["play-mode", "logic"];
  // `once` bookkeeping is runtime state that must not survive a Stop — a row
  // marked once that fired in the last session has to be armed again for the
  // next one.
  static resetOnStop = true;

  static defaults = {
    /**
     * [{ id, enabled, once, when: {...}, do: [action, ...] }]
     *
     * One array rather than a component per row: a door reacting to four
     * different things is one idea, and four components called "Events (2)"
     * is not a readable inspector.
     */
    bindings: [],

    /**
     * The node graph, for wiring a row list cannot express — a condition, a
     * value passed from one action to the next, several triggers sharing one
     * chain. See `events/graph.js`.
     *
     * A SECOND, independent piece of wiring on this component, not another view
     * of `bindings`. Converting a graph with a branch into rows is lossy, and a
     * lossy round-trip through an editor is how authored work quietly
     * disappears; both run, and the panel shows whichever you are using.
     */
    graph: null,
  };

  static schema = [
    // Rendered by the inspector's Event Bindings section, not the generic field
    // list. Declared anyway so the scene loader's entity-id remap can find the
    // ids buried inside it — the same reason TimelineComponent declares its
    // `bindings` map as a hidden `entityMap`.
    { key: "bindings", label: "Bindings", type: "bindings", hidden: true },
    { key: "graph", label: "Graph", type: "eventGraph", hidden: true },
  ];

  onAttach() {
    /** @type {Array<() => void>} */
    this._unsubs = [];
    /** @type {Set<string>} */
    this._fired = new Set();
    // Editor-only, armed by the Event Graph panel — see `traceGraph`.
    this.graphTrace ??= null;
    this.graphTraceSeq ??= 0;
    this.#subscribe();
    // Lifecycle rows can't be driven by a bus — there is no "start" event on
    // the engine — so they hang off play-changed directly.
    this._unsubPlay = this.entity.engine.on("play-changed", (playing) => {
      this._fired.clear();
      this.#runLifecycle(playing ? "start" : "stop");
    });
    if (this.entity.engine.playing) this.#runLifecycle("start");
  }

  onDetach() {
    this.#runLifecycle("destroy");
    for (const unsub of this._unsubs ?? []) unsub();
    this._unsubs = [];
    this._unsubPlay?.();
    this._unsubPlay = null;
  }

  onPropChanged(key) {
    if (key !== "bindings" && key !== "graph") return;
    // The graph caches its edge index on the object; a replaced graph must not
    // inherit the previous one's, or edits would run against the old wiring.
    if (key === "graph" && this.props.graph) delete this.props.graph.__index;
    // Re-subscribing rather than the base class's detach/attach: a full rebuild
    // would fire the `destroy` lifecycle row every time the author edits a
    // different row, which in edit mode is harmless only by accident.
    for (const unsub of this._unsubs ?? []) unsub();
    this._unsubs = [];
    this._fired.clear();
    this.#subscribe();
  }

  onDisable() {
    for (const unsub of this._unsubs ?? []) unsub();
    this._unsubs = [];
  }

  onEnable() {
    this.#subscribe();
  }

  /** Attaches one listener per non-lifecycle row, and per graph trigger node. */
  #subscribe() {
    const engine = this.entity?.engine;
    if (!engine) return;
    for (const [index, binding] of (this.props.bindings ?? []).entries()) {
      if (!binding || binding.enabled === false) continue;
      const when = binding.when ?? {};
      const fire = (...args) => this.#fire(binding, index, args);
      const unsub = this.#listen(when, fire, engine);
      if (unsub) this._unsubs.push(unsub);
    }
    // A graph's trigger nodes subscribe exactly like a row's `when` — the two
    // share `#listen`, so a source added to one is available in the other
    // without a second implementation to keep in step.
    for (const node of collectTriggers(this.props.graph)) {
      const when = { source: node.type.slice("on-".length), ...(node.props ?? {}) };
      if (when.source === "lifecycle") continue; // driven by #runLifecycle
      // The graph node types are `on-engine-event` / `on-entity-event` /
      // `on-component-event`; `#listen` keys off the short source name.
      when.source = when.source.replace(/-event$/, "");
      const unsub = this.#listen(when, (...args) => this.#fireGraph(node.id, args), engine);
      if (unsub) this._unsubs.push(unsub);
    }
  }

  /** Runs the graph from one trigger node, honouring the play gate. */
  #fireGraph(nodeId, args) {
    const engine = this.entity?.engine;
    if (!engine?.playing) return;
    runGraph(
      this.props.graph,
      nodeId,
      { engine, self: this.entity, args, params: [] },
      this._fired,
      this.graphTrace,
    );
    if (this.graphTrace) this.graphTraceSeq++;
  }

  /**
   * Starts (or stops) recording which graph nodes actually run.
   *
   * Off unless the Event Graph panel is open. A graph triggered by a per-frame
   * event would otherwise write to a Map nobody is reading, on the hot path, for
   * the life of the game — the same argument as the emission monitor's tap.
   *
   * `graphTraceSeq` lets the panel poll cheaply: unchanged means nothing ran,
   * so there is nothing to re-render.
   */
  traceGraph(on = true) {
    this.graphTrace = on ? (this.graphTrace ?? new Map()) : null;
    this.graphTraceSeq = 0;
  }

  /**
   * Attaches the one listener a `when` describes, and returns its unsubscribe.
   *
   * Returns null for a row that names something that isn't there (a component
   * the entity doesn't have, an input action that doesn't exist). Deliberately
   * quiet: half-built rows are the normal state of an inspector being used, and
   * a console warning per frame per unfinished row is what makes people stop
   * reading the console.
   */
  #listen(when, fire, engine) {
    switch (when.source) {
      case "entity": {
        if (!when.event) return null;
        const target = when.target ? engine.getEntity(when.target) : this.entity;
        return target ? target.on(when.event, fire) : null;
      }
      case "component": {
        if (!when.event || !when.component) return null;
        const component = this.entity.getComponent(when.component);
        return component ? component.on(when.event, fire) : null;
      }
      case "input": {
        if (!when.action) return null;
        return when.edge === "released"
          ? engine.input.onRelease(when.action, fire)
          : engine.input.onAction(when.action, fire);
      }
      case "lifecycle":
        return null; // driven by #runLifecycle, not by a bus
      case "engine":
      default:
        if (!when.event) return null;
        return engine.on(when.event, fire);
    }
  }

  /** Runs every lifecycle row — and every lifecycle graph trigger — for `phase`. */
  #runLifecycle(phase) {
    for (const [index, binding] of (this.props.bindings ?? []).entries()) {
      if (!binding || binding.enabled === false) continue;
      if (binding.when?.source !== "lifecycle") continue;
      if ((binding.when.phase ?? "start") !== phase) continue;
      this.#fire(binding, index, []);
    }
    for (const node of collectTriggers(this.props.graph)) {
      if (node.type !== "on-lifecycle") continue;
      if ((node.props?.phase ?? "start") !== phase) continue;
      this.#fireGraph(node.id, []);
    }
  }

  /**
   * Runs one row's actions, honouring `once` and the play gate.
   *
   * `once` is tracked per row index rather than per binding object because the
   * array is replaced wholesale on every inspector edit — holding the object
   * would re-arm every row the moment anything was typed.
   */
  #fire(binding, index, args) {
    const engine = this.entity?.engine;
    if (!engine?.playing) return;
    if (binding.once) {
      const key = String(binding.id ?? index);
      if (this._fired.has(key)) return;
      this._fired.add(key);
    }
    const run = () =>
      runActions(binding.do, {
        engine,
        self: this.entity,
        args,
        // The catalog entry, so an action can use `$cause` and not just `$0`.
        params: engine.events?.get?.(binding.when?.event)?.params ?? [],
      });
    // "Deferred" in Godot's sense: run on the next frame rather than inside the
    // emit. The reason it exists is that an action which destroys or reparents
    // an entity while the emitter is still iterating its listener set is how
    // you get half a frame applied to a scene that no longer matches it.
    //
    // `time.nextFrame()` returns a Promise — it does NOT take a callback — and
    // resolves on the frame domain, so a paused game defers until it resumes
    // rather than firing during the pause.
    if (!binding.deferred) {
      run();
      return;
    }
    const wait = engine.time?.nextFrame?.();
    if (wait?.then) wait.then(run);
    else queueMicrotask(run);
  }
}
