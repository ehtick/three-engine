// NOTE: strict type-checking intentionally not enabled here — ~17 pre-existing
// errors unrelated to events (JSX prop-shape mismatches on field components,
// `KeyItem`/`ClipItem` element typing), a follow-up.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Circle,
  Diamond,
  Film,
  Pause,
  Play,
  Plus,
  Save,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import { engine } from "../engineInstance.js";
import { ContextMenu } from "../ContextMenu.jsx";
import { NumberField } from "../fields/NumberField.jsx";
import { AssetField } from "../fields/AssetField.jsx";
import { invoke } from "../assetOps.js";
import { basename } from "../store/projectStore.js";
import { extOf, AUDIO_EXTENSIONS } from "../assetLoader.js";
import {
  INTERPOLATIONS,
  TRACK_KINDS,
  createClipItem,
  createKey,
  createTimeline,
  createTrack,
  isPointTrack,
  itemDuration,
  itemStart,
  normalizeTimeline,
  trackItems,
  trackItemsKey,
  trackLabel,
} from "../../engine/timeline/timelineAsset.js";
import { defaultValueFor, evaluateKeys, isSteppedType } from "../../engine/timeline/curve.js";
import { TimelineRuntime } from "../../engine/timeline/TimelineRuntime.js";
import {
  animatableProperties,
  readProperty,
  valueTypeFor,
} from "../../engine/timeline/propertyBinding.js";

/**
 * The dope sheet: a track list on the left, a time ruler and lanes on the
 * right, a playhead across both.
 *
 * Two things shape this panel more than anything else.
 *
 * **Preview owns the scene while it is bound, and gives it all back.** Scrubbing
 * writes real values onto real components — that is the whole point, you have to
 * see the light dim — so the runtime captures every value it touches and puts it
 * back when the panel unbinds (Stop, switching asset, closing the tab). Without
 * that, looking at a timeline permanently rewrites the scene it animates.
 *
 * **Editing is snapshot-undo, locally.** A keyframe editor needs Ctrl+Z far more
 * often than the scene does, and every edit here is a small mutation of one JSON
 * document — so the panel keeps its own stack of timeline snapshots rather than
 * pushing dozens of scene commands onto the global bus. EditorChrome stands down
 * from Ctrl+Z / Delete while the pointer is over the panel, the same way it does
 * for the node graphs.
 */

const MIN_PX_PER_SEC = 20;
const MAX_PX_PER_SEC = 600;
const TRACK_HEIGHT = 26;
const RULER_HEIGHT = 24;
const LIST_WIDTH = 232;
const AUTOSAVE_KEY = "engine.autosave.timeline";

const KIND_LABELS = {
  property: "Property",
  activation: "Activation",
  animation: "Animation",
  audio: "Audio",
  camera: "Camera Shot",
  event: "Event",
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Seconds → "0:02.35", the form a ruler can be read at a glance. */
function formatTime(t) {
  const sign = t < 0 ? "-" : "";
  const abs = Math.abs(t);
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  return `${sign}${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Nice tick spacing for the current zoom: 1, 2, 5, 10… seconds. */
function tickStep(pxPerSec) {
  const targetPx = 80;
  const raw = targetPx / pxPerSec;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const mult of [1, 2, 5, 10]) {
    if (raw <= pow * mult) return pow * mult;
  }
  return pow * 10;
}

// ---------------------------------------------------------------------------
// which asset the panel is editing
// ---------------------------------------------------------------------------

/**
 * A `.timeline` selected in the Assets panel wins; otherwise the selected
 * entity's Timeline component points at one. Selecting the director and having
 * the panel follow is how anyone expects this to work — the alternative is
 * hunting for the file every time.
 */
function useTimelinePath() {
  const assetPath = useSelectionStore((s) => s.assetPath);
  const ids = useSelectionStore((s) => s.ids);
  const entities = useSceneStore((s) => s.entities);
  return useMemo(() => {
    if (assetPath && extOf(assetPath) === "timeline") return assetPath;
    for (const id of ids ?? []) {
      const asset = entities?.[id]?.components?.timeline?.asset;
      if (asset && extOf(asset) === "timeline") return asset;
    }
    return null;
  }, [assetPath, ids, entities]);
}

/** Every director in the scene pointed at this asset. */
function findDirectors(path) {
  const out = [];
  if (!path) return out;
  const key = (p) => String(p ?? "").replaceAll("\\", "/");
  for (const entity of engine.entities?.values?.() ?? []) {
    const director = entity.getComponent?.("timeline");
    if (director && key(director.props.asset) === key(path)) out.push(director);
  }
  return out;
}

// ---------------------------------------------------------------------------
// lanes
// ---------------------------------------------------------------------------

const KeyItem = memo(function KeyItem({ item, x, selected, onPointerDown, onContextMenu }) {
  return (
    <div
      className={`timeline-key${selected ? " selected" : ""}`}
      style={{ left: x }}
      data-item-id={item.id}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      title={`${itemStart(item).toFixed(3)}s`}
    />
  );
});

const ClipItem = memo(function ClipItem({
  item,
  x,
  width,
  label,
  selected,
  onPointerDown,
  onContextMenu,
}) {
  return (
    <div
      className={`timeline-clip${selected ? " selected" : ""}`}
      style={{ left: x, width: Math.max(4, width) }}
      data-item-id={item.id}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      <span className="timeline-clip-grip left" data-edge="start" />
      <span className="timeline-clip-label">{label}</span>
      <span className="timeline-clip-grip right" data-edge="end" />
    </div>
  );
});

const Lane = memo(function Lane({
  track,
  pxPerSec,
  selectedItemId,
  onItemPointerDown,
  onItemContextMenu,
  onLaneDoubleClick,
  onLaneContextMenu,
  clipLabel,
}) {
  const point = isPointTrack(track.kind);
  return (
    <div
      className={`timeline-lane kind-${track.kind}${track.muted ? " muted" : ""}`}
      data-track-id={track.id}
      onDoubleClick={(e) => onLaneDoubleClick(track, e)}
      onContextMenu={(e) => onLaneContextMenu(track, e)}
    >
      {trackItems(track).map((item) =>
        point ? (
          <KeyItem
            key={item.id}
            item={item}
            x={itemStart(item) * pxPerSec}
            selected={item.id === selectedItemId}
            onPointerDown={(e) => onItemPointerDown(track, item, e)}
            onContextMenu={(e) => onItemContextMenu(track, item, e)}
          />
        ) : (
          <ClipItem
            key={item.id}
            item={item}
            x={itemStart(item) * pxPerSec}
            width={itemDuration(item) * pxPerSec}
            label={clipLabel(track, item)}
            selected={item.id === selectedItemId}
            onPointerDown={(e) => onItemPointerDown(track, item, e)}
            onContextMenu={(e) => onItemContextMenu(track, item, e)}
          />
        ),
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// track list rows
// ---------------------------------------------------------------------------

function TrackRow({ track, entities, selected, onSelect, onPatch, onDelete, onKeyNow }) {
  const entityName = entities?.[track.target]?.name ?? "";
  const label = trackLabel(track, "");
  return (
    <div
      className={`timeline-track-row${selected ? " selected" : ""}`}
      onPointerDown={() => onSelect(track.id)}
      data-track-row={track.id}
    >
      <span className={`timeline-track-kind kind-${track.kind}`} title={KIND_LABELS[track.kind]} />
      <div className="timeline-track-name" title={`${label}${entityName ? ` · ${entityName}` : ""}`}>
        <span className="timeline-track-title">{label}</span>
        {track.kind !== "camera" && (
          <span className="timeline-track-target">{entityName || "— no target —"}</span>
        )}
      </div>
      {track.kind === "property" && (
        <button
          className="icon-btn tiny"
          title="Key the current value at the playhead"
          onClick={(e) => {
            e.stopPropagation();
            onKeyNow(track);
          }}
        >
          <Diamond size={11} />
        </button>
      )}
      <button
        className={`icon-btn tiny${track.muted ? " active" : ""}`}
        title={track.muted ? "Muted — click to enable" : "Mute this track"}
        onClick={(e) => {
          e.stopPropagation();
          onPatch(track.id, { muted: !track.muted });
        }}
      >
        {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
      </button>
      <button
        className="icon-btn tiny"
        title="Delete track"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(track.id);
        }}
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// add-track popover
// ---------------------------------------------------------------------------

function AddTrackPopover({ onAdd, onClose }) {
  const entities = useSceneStore((s) => s.entities);
  const selectedIds = useSelectionStore((s) => s.ids);
  const [kind, setKind] = useState("property");
  const [target, setTarget] = useState(selectedIds?.[0] ?? "");
  const [component, setComponent] = useState("");
  const [property, setProperty] = useState("position");

  const entityList = useMemo(
    () =>
      Object.values(entities ?? {})
        .map((e) => ({ id: e.id, name: e.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [entities],
  );
  // Only components that actually exist on the chosen entity — offering the
  // full registry would let you key a light on an entity that has none.
  const componentList = useMemo(() => {
    const present = Object.keys(entities?.[target]?.components ?? {});
    return ["", ...present.filter((type) => animatableProperties(type).length)];
  }, [entities, target]);
  const propertyList = useMemo(() => animatableProperties(component), [component]);

  useEffect(() => {
    if (!propertyList.some((p) => p.key === property)) {
      setProperty(propertyList[0]?.key ?? "");
    }
  }, [propertyList, property]);

  const add = () => {
    const patch = { target: kind === "camera" ? "" : target };
    if (kind === "property") {
      patch.component = component;
      patch.property = property;
      patch.valueType = valueTypeFor(component, property) ?? "number";
    }
    onAdd(kind, patch);
    onClose();
  };

  return (
    <div className="timeline-add-popover" onPointerDown={(e) => e.stopPropagation()}>
      <label className="timeline-add-row">
        <span>Kind</span>
        <select className="select-field" value={kind} onChange={(e) => setKind(e.target.value)}>
          {TRACK_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {kind !== "camera" && (
        <label className="timeline-add-row">
          <span>Target</span>
          <select className="select-field" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">— the director's entity —</option>
            {entityList.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === "property" && (
        <>
          <label className="timeline-add-row">
            <span>Component</span>
            <select
              className="select-field"
              value={component}
              onChange={(e) => setComponent(e.target.value)}
            >
              {componentList.map((type) => (
                <option key={type} value={type}>
                  {type === "" ? "Transform" : type}
                </option>
              ))}
            </select>
          </label>
          <label className="timeline-add-row">
            <span>Property</span>
            <select
              className="select-field"
              value={property}
              onChange={(e) => setProperty(e.target.value)}
            >
              {propertyList.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <div className="timeline-add-actions">
        <button className="toolbar-btn" onClick={onClose}>
          Cancel
        </button>
        <button className="toolbar-btn primary" onClick={add}>
          Add Track
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// selected-item inspector
// ---------------------------------------------------------------------------

function ValueField({ valueType, value, onCommit }) {
  if (valueType === "boolean") {
    return (
      <input type="checkbox" checked={!!value} onChange={(e) => onCommit(e.target.checked)} />
    );
  }
  if (valueType === "color") {
    return (
      <input
        type="color"
        className="color-field"
        value={value ?? "#ffffff"}
        onChange={(e) => onCommit(e.target.value)}
      />
    );
  }
  if (valueType === "vec3" || valueType === "euler") {
    const arr = Array.isArray(value) ? value : [0, 0, 0];
    return (
      <div className="timeline-vec3">
        {["X", "Y", "Z"].map((axis, i) => (
          <NumberField
            key={axis}
            value={arr[i] ?? 0}
            step={valueType === "euler" ? 1 : 0.01}
            onCommit={(v) => onCommit(arr.map((old, j) => (j === i ? v : old)))}
          />
        ))}
      </div>
    );
  }
  if (valueType === "text") {
    return (
      <input
        className="text-field"
        value={value ?? ""}
        onChange={(e) => onCommit(e.target.value)}
      />
    );
  }
  return <NumberField value={Number(value) || 0} step={0.01} onCommit={onCommit} />;
}

function ItemInspector({ track, item, entities, onPatch, onDelete }) {
  if (!track || !item) {
    return (
      <div className="timeline-inspector empty">
        Select a key or clip — double-click an empty lane to make one.
      </div>
    );
  }
  const patch = (p) => onPatch(track.id, item.id, p);
  const rows = [];
  rows.push(
    <label key="time" className="timeline-insp-row">
      <span>{isPointTrack(track.kind) ? "Time" : "Start"}</span>
      <NumberField
        value={itemStart(item)}
        min={0}
        step={0.05}
        onCommit={(v) => patch(isPointTrack(track.kind) ? { t: v } : { start: v })}
      />
    </label>,
  );
  if (!isPointTrack(track.kind)) {
    rows.push(
      <label key="dur" className="timeline-insp-row">
        <span>Duration</span>
        <NumberField value={item.duration} min={0.01} step={0.05} onCommit={(v) => patch({ duration: v })} />
      </label>,
    );
  }
  if (track.kind === "property") {
    rows.push(
      <label key="value" className="timeline-insp-row wide">
        <span>Value</span>
        <ValueField valueType={track.valueType} value={item.v} onCommit={(v) => patch({ v })} />
      </label>,
    );
    if (!isSteppedType(track.valueType)) {
      rows.push(
        <label key="interp" className="timeline-insp-row">
          <span>Interp</span>
          <select
            className="select-field"
            value={item.interp}
            onChange={(e) => patch({ interp: e.target.value })}
          >
            {INTERPOLATIONS.filter(
              // Explicit tangents are scalars, so they only mean something on a
              // single-component track. Offering "bezier" on a vec3 would imply
              // handles the dope sheet has nowhere to show.
              (i) => i !== "bezier" || track.valueType === "number",
            ).map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>,
      );
      if (item.interp === "bezier" && track.valueType === "number") {
        rows.push(
          <label key="inT" className="timeline-insp-row">
            <span>In Slope</span>
            <NumberField value={item.inT} step={0.1} onCommit={(v) => patch({ inT: v })} />
          </label>,
          <label key="outT" className="timeline-insp-row">
            <span>Out Slope</span>
            <NumberField value={item.outT} step={0.1} onCommit={(v) => patch({ outT: v })} />
          </label>,
        );
      }
    }
  }
  if (track.kind === "event") {
    rows.push(
      <label key="method" className="timeline-insp-row">
        <span>Method</span>
        <input
          className="text-field"
          value={item.method ?? ""}
          placeholder="onExplode"
          onChange={(e) => patch({ method: e.target.value })}
        />
      </label>,
      <label key="arg" className="timeline-insp-row">
        <span>Argument</span>
        <input
          className="text-field"
          value={item.arg ?? ""}
          onChange={(e) => patch({ arg: e.target.value })}
        />
      </label>,
    );
  }
  if (track.kind === "animation") {
    rows.push(
      <label key="clip" className="timeline-insp-row">
        <span>Clip</span>
        <input
          className="text-field"
          value={item.clip ?? ""}
          placeholder="Run"
          onChange={(e) => patch({ clip: e.target.value })}
        />
      </label>,
      <label key="speed" className="timeline-insp-row">
        <span>Speed</span>
        <NumberField value={item.speed} step={0.1} onCommit={(v) => patch({ speed: v })} />
      </label>,
      <label key="loop" className="timeline-insp-row">
        <span>Loop</span>
        <input
          type="checkbox"
          checked={item.loopClip !== false}
          onChange={(e) => patch({ loopClip: e.target.checked })}
        />
      </label>,
      <label key="bi" className="timeline-insp-row">
        <span>Blend In</span>
        <NumberField value={item.blendIn} min={0} step={0.05} onCommit={(v) => patch({ blendIn: v })} />
      </label>,
      <label key="bo" className="timeline-insp-row">
        <span>Blend Out</span>
        <NumberField value={item.blendOut} min={0} step={0.05} onCommit={(v) => patch({ blendOut: v })} />
      </label>,
    );
  }
  if (track.kind === "audio") {
    rows.push(
      <label key="asset" className="timeline-insp-row wide">
        <span>Clip</span>
        <AssetField
          descriptor={{ key: "asset", exts: AUDIO_EXTENSIONS }}
          value={item.asset ?? ""}
          onCommit={(v) => patch({ asset: v })}
        />
      </label>,
      <label key="vol" className="timeline-insp-row">
        <span>Volume</span>
        <NumberField value={item.volume} min={0} max={2} step={0.05} onCommit={(v) => patch({ volume: v })} />
      </label>,
    );
  }
  if (track.kind === "camera") {
    rows.push(
      <label key="vcam" className="timeline-insp-row">
        <span>Shot</span>
        <select
          className="select-field"
          value={item.vcam ?? ""}
          onChange={(e) => patch({ vcam: e.target.value })}
        >
          <option value="">— none —</option>
          {Object.values(entities ?? {})
            .filter((e) => e.components?.vcam)
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
        </select>
      </label>,
      <label key="blend" className="timeline-insp-row">
        <span>Blend (s)</span>
        <NumberField
          value={item.blend}
          min={-1}
          step={0.05}
          onCommit={(v) => patch({ blend: v })}
        />
      </label>,
    );
  }
  return (
    <div className="timeline-inspector">
      <span className="timeline-insp-title">{KIND_LABELS[track.kind]}</span>
      {rows}
      <button className="toolbar-btn danger" onClick={() => onDelete(track.id, item.id)}>
        Delete
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the panel
// ---------------------------------------------------------------------------

export function TimelinePanel() {
  const path = useTimelinePath();
  const entities = useSceneStore((s) => s.entities);
  const [timeline, setTimeline] = useState(() => createTimeline());
  const [dirty, setDirty] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(120);
  const [snap, setSnap] = useState(true);
  const [selection, setSelection] = useState({ trackId: null, itemId: null });
  const [menu, setMenu] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [autosave, setAutosave] = useState(() => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const rootRef = useRef(null);
  const lanesRef = useRef(null);
  const listRef = useRef(null);
  const runtimeRef = useRef(null);
  const timeRef = useRef(0);
  const timelineRef = useRef(timeline);
  const undoRef = useRef({ past: [], future: [] });
  const baselineRef = useRef(new Map());
  const dragRef = useRef(null);

  timelineRef.current = timeline;
  timeRef.current = time;

  const duration = timeline.duration || 1;
  const frameStep = 1 / (timeline.frameRate || 30);
  const contentWidth = duration * pxPerSec + 240;

  // --- loading ---------------------------------------------------------------

  useEffect(() => {
    let live = true;
    if (!path) {
      setTimeline(createTimeline());
      return () => {};
    }
    (async () => {
      try {
        const json = JSON.parse(await invoke("read_text_file", { path }));
        if (!live) return;
        setTimeline(normalizeTimeline(json));
        undoRef.current = { past: [], future: [] };
        setDirty(false);
        setSelection({ trackId: null, itemId: null });
        setTime(0);
      } catch (err) {
        console.error(`Failed to open timeline: ${err}`);
      }
    })();
    return () => {
      live = false;
    };
  }, [path]);

  // --- preview runtime -------------------------------------------------------

  /** The director whose bindings should resolve this preview, if any. */
  const resolveTarget = useCallback(
    (track) => {
      const director = findDirectors(path)[0];
      if (director) return director.resolveTrackTarget(track);
      return track.target ? engine.getEntity(track.target) ?? null : null;
    },
    [path],
  );

  const ensureRuntime = useCallback(() => {
    if (!runtimeRef.current) {
      runtimeRef.current = new TimelineRuntime(engine, timelineRef.current, {
        resolveTarget,
        name: path ? basename(path) : "timeline",
      });
    }
    return runtimeRef.current;
  }, [path, resolveTarget]);

  /** Captures what the live scene currently reads, so record mode can tell a
   *  user edit apart from the preview's own writes. */
  const refreshBaseline = useCallback(() => {
    const map = new Map();
    for (const track of timelineRef.current.tracks) {
      if (track.kind !== "property") continue;
      const entity = resolveTarget(track);
      if (!entity) continue;
      map.set(track.id, readProperty(entity, track.component, track.property, track.valueType));
    }
    baselineRef.current = map;
  }, [resolveTarget]);

  const recordingRef = useRef(false);
  recordingRef.current = recording;

  const sampleAt = useCallback(
    (t, { audio = false } = {}) => {
      const runtime = ensureRuntime();
      runtime.bind();
      runtime.sample(t, { audio });
      setPreviewing(true);
      // Only record mode needs the baseline, and it walks every property track —
      // no reason to pay for it sixty times a second during plain playback.
      if (recordingRef.current) refreshBaseline();
    },
    [ensureRuntime, refreshBaseline],
  );

  const stopPreview = useCallback(() => {
    setPlaying(false);
    runtimeRef.current?.unbind();
    setPreviewing(false);
  }, []);

  /**
   * Two ways a live preview can outlive the panel being usable, both of which
   * end with the posed values being saved into the scene as if authored:
   *
   *  1. **The tab is switched away.** Dockview DETACHES an inactive tab's
   *     element without unmounting its React component, so no cleanup runs and
   *     the badge that says "the scene is being posed" is not on screen either.
   *     `isConnected` is the honest test for it.
   *  2. **Play starts.** The director owns the timeline from then on; two things
   *     driving the same tracks is a fight nobody wins.
   */
  useEffect(() => {
    if (!previewing) return undefined;
    const unsubPlay = engine.on("play-changed", (isPlaying) => {
      if (isPlaying) stopPreview();
    });
    const id = setInterval(() => {
      if (rootRef.current && !rootRef.current.isConnected) stopPreview();
    }, 400);
    return () => {
      unsubPlay?.();
      clearInterval(id);
    };
  }, [previewing, stopPreview]);

  // Keep the bound runtime in step with edits, so a key dragged while the
  // preview is live updates the scene under the playhead immediately.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !previewing) return;
    runtime.setTimeline(timeline);
    runtime.sample(timeRef.current, { audio: false });
    refreshBaseline();
  }, [timeline, previewing, refreshBaseline]);

  // Unbind on unmount / asset switch — the scene must not be left posed by a
  // panel that isn't on screen any more.
  useEffect(() => {
    return () => {
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, [path]);

  // --- playback --------------------------------------------------------------

  useEffect(() => {
    if (!playing) return undefined;
    let last = performance.now();
    let frame = 0;
    const step = () => {
      const now = performance.now();
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const next = timeRef.current + dt;
      if (next >= duration) {
        setTime(duration);
        sampleAt(duration, { audio: true });
        setPlaying(false);
        return;
      }
      setTime(next);
      timeRef.current = next;
      sampleAt(next, { audio: true });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, sampleAt]);

  // --- mutation + undo -------------------------------------------------------

  const commit = useCallback((recipe) => {
    setTimeline((prev) => {
      const draft = structuredClone(prev);
      const result = recipe(draft);
      if (result === false) return prev;
      const next = normalizeTimeline(draft);
      undoRef.current.past.push(prev);
      if (undoRef.current.past.length > 200) undoRef.current.past.shift();
      undoRef.current.future.length = 0;
      return next;
    });
    setDirty(true);
  }, []);

  const undo = useCallback(() => {
    const { past, future } = undoRef.current;
    if (!past.length) return;
    setTimeline((cur) => {
      future.push(cur);
      return past.pop();
    });
    setDirty(true);
  }, []);

  const redo = useCallback(() => {
    const { past, future } = undoRef.current;
    if (!future.length) return;
    setTimeline((cur) => {
      past.push(cur);
      return future.pop();
    });
    setDirty(true);
  }, []);

  // --- saving ----------------------------------------------------------------

  const save = useCallback(async () => {
    if (!path) return;
    const json = timelineRef.current;
    await invoke("save_scene", { path, contents: JSON.stringify(json, null, 2) });
    setDirty(false);
    // Directors hold a parsed copy; without this the next Play would run the
    // version on disk from before this edit.
    for (const director of findDirectors(path)) director.applyTimeline(structuredClone(json));
    console.log(`Timeline saved: ${path}`);
  }, [path]);

  useEffect(() => {
    if (!autosave || !dirty) return undefined;
    const id = setTimeout(() => save(), 200);
    return () => clearTimeout(id);
  }, [autosave, dirty, timeline, save]);

  // --- track + item operations ----------------------------------------------

  const addTrack = useCallback(
    (kind, patch) => {
      commit((draft) => {
        draft.tracks.push(createTrack(kind, patch));
      });
    },
    [commit],
  );

  const patchTrack = useCallback(
    (trackId, patch) => {
      commit((draft) => {
        const track = draft.tracks.find((t) => t.id === trackId);
        if (!track) return false;
        Object.assign(track, patch);
      });
    },
    [commit],
  );

  const deleteTrack = useCallback(
    (trackId) => {
      commit((draft) => {
        draft.tracks = draft.tracks.filter((t) => t.id !== trackId);
      });
      setSelection((s) => (s.trackId === trackId ? { trackId: null, itemId: null } : s));
    },
    [commit],
  );

  const patchItem = useCallback(
    (trackId, itemId, patch) => {
      commit((draft) => {
        const track = draft.tracks.find((t) => t.id === trackId);
        if (!track) return false;
        const list = track[trackItemsKey(track)];
        const item = list?.find((i) => i.id === itemId);
        if (!item) return false;
        Object.assign(item, patch);
      });
    },
    [commit],
  );

  const deleteItem = useCallback(
    (trackId, itemId) => {
      commit((draft) => {
        const track = draft.tracks.find((t) => t.id === trackId);
        if (!track) return false;
        const key = trackItemsKey(track);
        track[key] = (track[key] ?? []).filter((i) => i.id !== itemId);
      });
      setSelection((s) => (s.itemId === itemId ? { trackId: s.trackId, itemId: null } : s));
    },
    [commit],
  );

  /** Snaps a time to the frame grid (and never below zero). */
  const snapTime = useCallback(
    (t) => {
      const clamped = Math.max(0, t);
      return snap ? Math.round(clamped / frameStep) * frameStep : clamped;
    },
    [snap, frameStep],
  );

  /**
   * Writes a key at the playhead holding whatever the bound property currently
   * reads. This is the "key it" verb — from the track row's diamond button, from
   * a double-click on an empty lane, and from record mode.
   */
  const keyTrackAt = useCallback(
    (track, t, explicitValue) => {
      const entity = resolveTarget(track);
      const live =
        explicitValue !== undefined
          ? explicitValue
          : entity
            ? readProperty(entity, track.component, track.property, track.valueType)
            : undefined;
      const value =
        live !== undefined
          ? live
          : (evaluateKeys(track.keys, t, track.valueType) ?? defaultValueFor(track.valueType));
      commit((draft) => {
        const target = draft.tracks.find((x) => x.id === track.id);
        if (!target) return false;
        const at = target.keys.find((k) => Math.abs(k.t - t) < 1e-4);
        if (at) at.v = value;
        else target.keys.push(createKey(t, value));
      });
    },
    [commit, resolveTarget],
  );

  const onLaneDoubleClick = useCallback(
    (track, event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const t = snapTime((event.clientX - rect.left) / pxPerSec);
      if (track.kind === "property") {
        keyTrackAt(track, t);
        return;
      }
      commit((draft) => {
        const target = draft.tracks.find((x) => x.id === track.id);
        if (!target) return false;
        if (target.kind === "event") target.keys.push({ id: `key-${Math.random().toString(36).slice(2, 8)}`, t, method: "", arg: "" });
        else target.clips.push(createClipItem(t, 1));
      });
    },
    [commit, keyTrackAt, pxPerSec, snapTime],
  );

  // --- dragging items + scrubbing -------------------------------------------

  const beginScrub = useCallback(
    (event) => {
      const rect = lanesRef.current?.getBoundingClientRect();
      if (!rect) return;
      const scrollLeft = lanesRef.current.scrollLeft;
      const move = (e) => {
        const t = clamp(snapTime((e.clientX - rect.left + scrollLeft) / pxPerSec), 0, duration);
        setTime(t);
        timeRef.current = t;
        sampleAt(t);
      };
      move(event);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [duration, pxPerSec, sampleAt, snapTime],
  );

  const onItemPointerDown = useCallback(
    (track, item, event) => {
      event.stopPropagation();
      setSelection({ trackId: track.id, itemId: item.id });
      if (event.button !== 0) return;
      const edge = event.target?.dataset?.edge ?? null;
      const startX = event.clientX;
      const origin = { start: itemStart(item), duration: itemDuration(item) };
      dragRef.current = { moved: false };
      const move = (e) => {
        const delta = (e.clientX - startX) / pxPerSec;
        if (Math.abs(e.clientX - startX) < 2 && !dragRef.current.moved) return;
        dragRef.current.moved = true;
        if (edge === "start") {
          const start = clamp(snapTime(origin.start + delta), 0, origin.start + origin.duration - frameStep);
          patchItem(track.id, item.id, {
            start,
            duration: origin.start + origin.duration - start,
          });
        } else if (edge === "end") {
          patchItem(track.id, item.id, {
            duration: Math.max(frameStep, snapTime(origin.duration + delta)),
          });
        } else if (isPointTrack(track.kind)) {
          patchItem(track.id, item.id, { t: snapTime(origin.start + delta) });
        } else {
          patchItem(track.id, item.id, { start: snapTime(origin.start + delta) });
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        dragRef.current = null;
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [frameStep, patchItem, pxPerSec, snapTime],
  );

  const onItemContextMenu = useCallback(
    (track, item, event) => {
      event.preventDefault();
      event.stopPropagation();
      setSelection({ trackId: track.id, itemId: item.id });
      const items = [];
      if (track.kind === "property" && !isSteppedType(track.valueType)) {
        items.push({ header: "Interpolation" });
        for (const interp of INTERPOLATIONS) {
          if (interp === "bezier" && track.valueType !== "number") continue;
          items.push({
            label: interp,
            hint: item.interp === interp ? "current" : undefined,
            action: () => patchItem(track.id, item.id, { interp }),
          });
        }
        items.push({ separator: true });
      }
      items.push({
        label: "Move to Playhead",
        action: () =>
          patchItem(track.id, item.id, isPointTrack(track.kind) ? { t: timeRef.current } : { start: timeRef.current }),
      });
      items.push({ label: "Delete", danger: true, action: () => deleteItem(track.id, item.id) });
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [deleteItem, patchItem],
  );

  const onLaneContextMenu = useCallback(
    (track, event) => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const t = snapTime((event.clientX - rect.left) / pxPerSec);
      const items = [
        {
          label: track.kind === "property" ? "Add Key Here" : "Add Clip Here",
          action: () => onLaneDoubleClick(track, { currentTarget: event.currentTarget, clientX: event.clientX }),
        },
        { label: track.muted ? "Unmute Track" : "Mute Track", action: () => patchTrack(track.id, { muted: !track.muted }) },
        { separator: true },
        { label: "Delete Track", danger: true, action: () => deleteTrack(track.id) },
      ];
      setMenu({ x: event.clientX, y: event.clientY, items, at: t });
    },
    [deleteTrack, onLaneDoubleClick, patchTrack, pxPerSec, snapTime],
  );

  // --- record mode -----------------------------------------------------------

  useEffect(() => {
    if (!recording) return undefined;
    // Recording is authoring, not watching: playback would fight every edit.
    setPlaying(false);
    refreshBaseline();
    const unsub = engine.onUpdate(() => {
      const current = timelineRef.current;
      let hit = null;
      for (const track of current.tracks) {
        if (track.kind !== "property" || track.muted) continue;
        const entity = resolveTarget(track);
        if (!entity) continue;
        const live = readProperty(entity, track.component, track.property, track.valueType);
        if (live === undefined) continue;
        const before = baselineRef.current.get(track.id);
        if (JSON.stringify(live) === JSON.stringify(before)) continue;
        baselineRef.current.set(track.id, live);
        hit = { track, live };
      }
      // One key per frame is enough — a gizmo drag moves one property at a time,
      // and batching more would need a single commit anyway.
      if (hit) keyTrackAt(hit.track, snapTime(timeRef.current), hit.live);
    });
    return unsub;
  }, [recording, keyTrackAt, refreshBaseline, resolveTarget, snapTime]);

  // --- keyboard --------------------------------------------------------------

  useEffect(() => {
    const onKey = (e) => {
      const root = rootRef.current;
      if (!root) return;
      const inPanel = root.contains(e.target) || root.matches(":hover");
      if (!inPanel) return;
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (ctrl && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (ctrl && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selection.itemId) {
          e.preventDefault();
          deleteItem(selection.trackId, selection.itemId);
        }
      } else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const next = clamp(timeRef.current + dir * frameStep, 0, duration);
        setTime(next);
        timeRef.current = next;
        sampleAt(next);
      } else if (e.key === "Home") {
        setTime(0);
        sampleAt(0);
      } else if (e.key === "End") {
        setTime(duration);
        sampleAt(duration);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteItem, duration, frameStep, redo, sampleAt, save, selection, undo]);

  // Ctrl+wheel zooms around the pointer, like every other timeline.
  const onWheel = useCallback(
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setPxPerSec((cur) => clamp(cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15), MIN_PX_PER_SEC, MAX_PX_PER_SEC));
    },
    [],
  );

  const syncScroll = useCallback((e) => {
    if (listRef.current) listRef.current.scrollTop = e.currentTarget.scrollTop;
  }, []);

  const clipLabel = useCallback(
    (track, item) => {
      if (track.kind === "animation") return item.clip || "(no clip)";
      if (track.kind === "audio") return item.asset ? basename(item.asset) : "(no clip)";
      if (track.kind === "camera") return entities?.[item.vcam]?.name ?? "(no shot)";
      return "";
    },
    [entities],
  );

  const selectedTrack = timeline.tracks.find((t) => t.id === selection.trackId) ?? null;
  const selectedItem = selectedTrack
    ? trackItems(selectedTrack).find((i) => i.id === selection.itemId) ?? null
    : null;

  const ticks = useMemo(() => {
    const step = tickStep(pxPerSec);
    const out = [];
    for (let t = 0; t <= duration + step; t += step) out.push(Math.round(t * 1e4) / 1e4);
    return out;
  }, [duration, pxPerSec]);

  if (!path) {
    return (
      <div className="timeline-panel empty" ref={rootRef}>
        <Film size={22} opacity={0.5} />
        <p>Select a .timeline asset, or an entity with a Timeline component.</p>
        <p className="dim">Assets → right-click → New Timeline.</p>
      </div>
    );
  }

  return (
    <div className="timeline-panel" ref={rootRef}>
      <div className="panel-toolbar timeline-toolbar">
        <button
          className="toolbar-btn icon-only"
          title={playing ? "Pause" : "Play preview"}
          onClick={() => {
            if (!playing) sampleAt(timeRef.current, { audio: true });
            setPlaying((p) => !p);
          }}
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <button
          className="toolbar-btn icon-only"
          title="Stop preview and restore the scene"
          disabled={!previewing}
          onClick={() => {
            stopPreview();
            setTime(0);
          }}
        >
          <Square size={13} />
        </button>
        <button
          className={`toolbar-btn icon-only${recording ? " recording" : ""}`}
          title={
            recording
              ? "Recording — moving a bound object writes a key at the playhead"
              : "Record: capture edits to tracked properties as keys"
          }
          onClick={() => setRecording((r) => !r)}
        >
          <Circle size={13} fill={recording ? "currentColor" : "none"} />
        </button>
        <span className="timeline-time" data-testid="timeline-time">
          {formatTime(time)} <span className="dim">/ {formatTime(duration)}</span>
        </span>
        <span className="game-toolbar-sep" />
        <label className="timeline-toolbar-field" title="Authored length in seconds">
          <span>Len</span>
          <NumberField
            value={timeline.duration}
            min={0.1}
            step={0.5}
            onCommit={(v) => commit((draft) => void (draft.duration = v))}
          />
        </label>
        <label className="timeline-toolbar-field" title="Frame rate used for snapping">
          <span>FPS</span>
          <NumberField
            value={timeline.frameRate}
            min={1}
            max={240}
            step={1}
            onCommit={(v) => commit((draft) => void (draft.frameRate = Math.round(v)))}
          />
        </label>
        <button
          className={`toolbar-btn${snap ? " active" : ""}`}
          title="Snap edits to the frame grid"
          onClick={() => setSnap((s) => !s)}
        >
          Snap
        </button>
        <span className="game-toolbar-spacer" />
        <div className="timeline-add-wrap">
          <button className="toolbar-btn" onClick={() => setAddOpen((o) => !o)}>
            <Plus size={12} /> Track
          </button>
          {addOpen && <AddTrackPopover onAdd={addTrack} onClose={() => setAddOpen(false)} />}
        </div>
        <button
          className={`toolbar-btn icon-only${autosave ? " active" : ""}`}
          title={autosave ? "Autosave on" : "Autosave off — click Save to commit"}
          onClick={() =>
            setAutosave((cur) => {
              const next = !cur;
              try {
                localStorage.setItem(AUTOSAVE_KEY, next ? "1" : "0");
              } catch {
                /* private mode — the toggle still works for this session */
              }
              return next;
            })
          }
        >
          <Zap size={13} />
        </button>
        <button className="toolbar-btn" disabled={!dirty || autosave} onClick={save}>
          <Save size={12} /> Save
        </button>
      </div>

      <div className="timeline-body">
        <div className="timeline-list" ref={listRef} style={{ width: LIST_WIDTH }}>
          <div className="timeline-list-head" style={{ height: RULER_HEIGHT }}>
            {timeline.tracks.length} {timeline.tracks.length === 1 ? "track" : "tracks"}
          </div>
          {timeline.tracks.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              entities={entities}
              selected={track.id === selection.trackId}
              onSelect={(id) => setSelection({ trackId: id, itemId: null })}
              onPatch={patchTrack}
              onDelete={deleteTrack}
              onKeyNow={(t) => keyTrackAt(t, snapTime(timeRef.current))}
            />
          ))}
          {!timeline.tracks.length && (
            <div className="timeline-empty-hint">No tracks yet — add one above.</div>
          )}
        </div>

        <div className="timeline-lanes" ref={lanesRef} onScroll={syncScroll} onWheel={onWheel}>
          <div className="timeline-content" style={{ width: contentWidth }}>
            <div
              className="timeline-ruler"
              style={{ height: RULER_HEIGHT }}
              onPointerDown={beginScrub}
            >
              {ticks.map((t) => (
                <div key={t} className="timeline-tick" style={{ left: t * pxPerSec }}>
                  <span>{formatTime(t)}</span>
                </div>
              ))}
            </div>
            {timeline.tracks.map((track) => (
              <Lane
                key={track.id}
                track={track}
                pxPerSec={pxPerSec}
                selectedItemId={selection.trackId === track.id ? selection.itemId : null}
                onItemPointerDown={onItemPointerDown}
                onItemContextMenu={onItemContextMenu}
                onLaneDoubleClick={onLaneDoubleClick}
                onLaneContextMenu={onLaneContextMenu}
                clipLabel={clipLabel}
              />
            ))}
            <div
              className="timeline-playhead"
              data-testid="timeline-playhead"
              style={{ left: time * pxPerSec, height: RULER_HEIGHT + timeline.tracks.length * TRACK_HEIGHT }}
            />
          </div>
        </div>
      </div>

      <ItemInspector
        track={selectedTrack}
        item={selectedItem}
        entities={entities}
        onPatch={patchItem}
        onDelete={deleteItem}
      />

      {previewing && (
        <div className="timeline-preview-badge" title="The scene is posed by this timeline">
          Preview
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {addOpen && <div className="dropdown-overlay" onPointerDown={() => setAddOpen(false)} />}
    </div>
  );
}
