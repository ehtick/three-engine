/**
 * Timeline assets (.timeline): a sequencer track list serialized as JSON.
 *
 *   {
 *     version: 1,
 *     duration: 5,          // seconds; the authored length (see `timelineExtent`)
 *     frameRate: 30,        // editor snapping + the unit the ruler counts in
 *     tracks: [ ... ]
 *   }
 *
 * Two track shapes exist, and every kind is one of them:
 *
 *   - **point tracks** carry `keys: [{ t, ... }]` sorted by time.
 *     `property` (keyframes, with interpolation) and `event` (markers).
 *   - **range tracks** carry `clips: [{ id, start, duration, ... }]` sorted by
 *     start. `activation`, `animation`, `audio` and `camera`.
 *
 * Keeping it to exactly two shapes is what lets the dope-sheet draw, drag,
 * select and delete items without a branch per kind — a timeline editor is
 * mostly generic item manipulation, and a third shape would double it.
 *
 * ---------------------------------------------------------------------------
 * Targets and bindings
 *
 * A track names its target by **entity id** (`track.target`). That is the right
 * default: most timelines are authored against one scene, and typing an id into
 * a shared table for every door in the level is worse than the problem it
 * solves. For the cases where a timeline IS shared — the same "open" sequence on
 * twelve doors — the director component carries a `bindings` map
 * (`trackId -> entityId`) that overrides the track's own target, so one asset
 * drives twelve entities without twelve copies.
 */

export const TIMELINE_VERSION = 1;
export const TIMELINE_EXT = "timeline";

/** Track kinds, in the order the "Add Track" menu offers them. */
export const TRACK_KINDS = ["property", "activation", "animation", "audio", "camera", "event"];

/** Kinds whose items are points in time rather than ranges. */
const POINT_KINDS = new Set(["property", "event"]);

export const INTERPOLATIONS = ["smooth", "linear", "step", "bezier"];

/**
 * Value types a property track can carry.
 *   number  — a plain scalar
 *   vec3    — [x, y, z]
 *   euler   — [x, y, z] in DEGREES (see below)
 *   color   — "#rrggbb"
 *   boolean — stepped, never interpolated
 *   text    — stepped (a select/enum prop)
 *
 * Euler is separate from vec3 for two reasons: the value is authored in degrees
 * (a rotation track showing 1.5707963 is unreadable, the same reasoning that put
 * joint limits in degrees), and interpolation has to take the short way around —
 * a key at 350° followed by one at 10° is a 20° turn, not a 340° spin backwards.
 */
export const VALUE_TYPES = ["number", "vec3", "euler", "color", "boolean", "text"];

/** What a director does when it reaches the end. */
export const WRAP_MODES = ["once", "hold", "loop", "pingPong"];

const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export function isPointTrack(kind) {
  return POINT_KINDS.has(kind);
}

/** The array of items on a track, whichever shape it is. Never null. */
export function trackItems(track) {
  if (!track) return [];
  return (isPointTrack(track.kind) ? track.keys : track.clips) ?? [];
}

/** The field name `trackItems` read from — for writing a modified list back. */
export function trackItemsKey(track) {
  return isPointTrack(track?.kind) ? "keys" : "clips";
}

/** The time an item occupies the playhead at (its start, for a range item). */
export function itemStart(item) {
  return Number.isFinite(item?.t) ? item.t : (item?.start ?? 0);
}

/** How long an item lasts. Point items are instants, so zero. */
export function itemDuration(item) {
  return Number.isFinite(item?.duration) ? Math.max(0, item.duration) : 0;
}

export function createTimeline(patch = {}) {
  return {
    version: TIMELINE_VERSION,
    duration: 5,
    frameRate: 30,
    tracks: [],
    ...patch,
  };
}

/** A blank timeline, used by "New Timeline" in the Assets panel. */
export function createDefaultTimeline() {
  return createTimeline();
}

export function createTrack(kind, patch = {}) {
  const base = {
    id: uid("track"),
    kind: TRACK_KINDS.includes(kind) ? kind : "property",
    name: "",
    target: "",
    muted: false,
  };
  if (isPointTrack(base.kind)) base.keys = [];
  else base.clips = [];
  if (base.kind === "property") {
    base.component = "";
    base.property = "";
    base.valueType = "number";
  }
  return { ...base, ...patch };
}

export function createKey(t, v, patch = {}) {
  return { id: uid("key"), t, v, interp: "smooth", inT: 0, outT: 0, ...patch };
}

export function createClipItem(start, duration, patch = {}) {
  return { id: uid("clip"), start, duration, ...patch };
}

/**
 * A human name for a track that has none. Derived rather than stored so
 * renaming the property a track drives keeps the label honest.
 */
export function trackLabel(track, entityName = "") {
  if (track?.name) return track.name;
  if (track?.kind === "property") {
    const prop = track.property || "(property)";
    const owner = track.component ? track.component : "transform";
    return entityName ? `${entityName} · ${owner}.${prop}` : `${owner}.${prop}`;
  }
  const kind = track?.kind ?? "track";
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  return entityName ? `${entityName} · ${label}` : label;
}

function normalizeKey(key, valueType) {
  const interp =
    valueType === "boolean" || valueType === "text"
      ? "step" // there is no halfway between true and false
      : INTERPOLATIONS.includes(key?.interp)
        ? key.interp
        : "smooth";
  return {
    id: key?.id ?? uid("key"),
    t: Number.isFinite(key?.t) ? key.t : 0,
    v: key?.v,
    interp,
    inT: Number.isFinite(key?.inT) ? key.inT : 0,
    outT: Number.isFinite(key?.outT) ? key.outT : 0,
  };
}

function normalizeMarker(key) {
  return {
    id: key?.id ?? uid("key"),
    t: Number.isFinite(key?.t) ? key.t : 0,
    method: key?.method ?? "",
    arg: key?.arg ?? "",
  };
}

function normalizeClip(clip, kind) {
  const out = {
    id: clip?.id ?? uid("clip"),
    start: Number.isFinite(clip?.start) ? clip.start : 0,
    // A zero-length clip is invisible and un-grabbable in the dope sheet, so it
    // reads as "the drop didn't work". One frame at 30fps is the floor.
    duration: Number.isFinite(clip?.duration) ? Math.max(1 / 30, clip.duration) : 1,
  };
  if (kind === "animation") {
    out.clip = clip?.clip ?? "";
    out.speed = Number.isFinite(clip?.speed) ? clip.speed : 1;
    out.clipOffset = Number.isFinite(clip?.clipOffset) ? clip.clipOffset : 0;
    out.loopClip = clip?.loopClip !== false;
    out.blendIn = Number.isFinite(clip?.blendIn) ? Math.max(0, clip.blendIn) : 0;
    out.blendOut = Number.isFinite(clip?.blendOut) ? Math.max(0, clip.blendOut) : 0;
  } else if (kind === "audio") {
    out.asset = clip?.asset ?? "";
    out.volume = Number.isFinite(clip?.volume) ? clip.volume : 1;
    out.loop = !!clip?.loop;
  } else if (kind === "camera") {
    out.vcam = clip?.vcam ?? "";
    // -1 = "use the Camera component's default blend", the same convention
    // VirtualCameraComponent.blendTime already uses.
    out.blend = Number.isFinite(clip?.blend) ? clip.blend : -1;
  }
  return out;
}

export function normalizeTrack(track, index = 0) {
  const kind = TRACK_KINDS.includes(track?.kind) ? track.kind : "property";
  const out = {
    id: track?.id ?? uid("track"),
    kind,
    name: track?.name ?? "",
    target: track?.target ?? "",
    muted: !!track?.muted,
  };
  if (kind === "property") {
    out.component = track?.component ?? "";
    out.property = track?.property ?? "";
    out.valueType = VALUE_TYPES.includes(track?.valueType) ? track.valueType : "number";
    out.keys = (track?.keys ?? [])
      .map((key) => normalizeKey(key, out.valueType))
      .sort((a, b) => a.t - b.t);
  } else if (kind === "event") {
    out.keys = (track?.keys ?? []).map(normalizeMarker).sort((a, b) => a.t - b.t);
  } else {
    out.clips = (track?.clips ?? [])
      .map((clip) => normalizeClip(clip, kind))
      .sort((a, b) => a.start - b.start);
  }
  if (!out.name) out.name = trackLabel(out) === "" ? `Track ${index + 1}` : "";
  return out;
}

/**
 * Fills in defaults so neither the runtime nor the editor ever branches on
 * "missing". Rebuilds rather than mutates — the caller's JSON may be a cached
 * asset about to be normalized again.
 */
export function normalizeTimeline(json) {
  const tracks = (json?.tracks ?? []).map(normalizeTrack);
  const authored = Number.isFinite(json?.duration) ? Math.max(0, json.duration) : 5;
  return {
    version: TIMELINE_VERSION,
    // The authored duration is a floor, not a truth: dragging a clip past the
    // end must not silently cut it off (and a timeline whose last key sits
    // beyond `duration` is exactly what an import or a hand-edit produces).
    duration: Math.max(authored, timelineExtent({ tracks })),
    frameRate: Number.isFinite(json?.frameRate) && json.frameRate > 0 ? json.frameRate : 30,
    tracks,
  };
}

/** The last moment any track has something on it. */
export function timelineExtent(timeline) {
  let end = 0;
  for (const track of timeline?.tracks ?? []) {
    for (const item of trackItems(track)) {
      end = Math.max(end, itemStart(item) + itemDuration(item));
    }
  }
  return end;
}

/**
 * Every asset path a timeline references (audio clips today). Used by scene
 * preloading so a cutscene's audio is in memory before it starts rather than
 * arriving two seconds into the shot.
 */
export function collectTimelineAssets(timeline) {
  const out = [];
  for (const track of timeline?.tracks ?? []) {
    if (track.kind !== "audio") continue;
    for (const clip of track.clips ?? []) {
      if (clip.asset) out.push(clip.asset);
    }
  }
  return out;
}
