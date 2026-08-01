import { getComponentClass } from "../components/registry.js";
import { Component } from "../components/Component.js";

/**
 * Reading and writing the one thing a property track drives: a named property
 * on an entity's transform or on one of its components.
 *
 * Shared by the runtime (which writes it every frame) and by the editor's
 * record mode (which reads it to make a key). Keeping both on the same
 * accessor is what guarantees that recording a value and playing it back
 * produce the same number — the classic failure here is an editor that records
 * degrees against a runtime that writes radians, which looks like the animation
 * is 57× too fast rather than like a unit mismatch.
 */

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/**
 * The transform "component" is addressed as the empty string, so a track needs
 * no special-casing to point at it — it is just a component id that happens to
 * be built in.
 */
export const TRANSFORM_COMPONENT = "";

export const TRANSFORM_PROPERTIES = [
  { key: "position", label: "Position", valueType: "vec3" },
  // Degrees, like the inspector shows and like joint limits are authored —
  // a rotation key reading 1.5707963 is not something anyone can edit.
  { key: "rotation", label: "Rotation", valueType: "euler" },
  { key: "scale", label: "Scale", valueType: "vec3" },
];

/** Inspector schema types a timeline can drive, mapped to keyed value types. */
const SCHEMA_TYPE_TO_VALUE_TYPE = {
  number: "number",
  boolean: "boolean",
  color: "color",
  vec3: "vec3",
  select: "text",
  text: "text",
};

/**
 * Every property of a component a timeline can animate, derived from the
 * component's own schema. Nothing is hand-listed, so a component that gains a
 * property gains the ability to be keyed on the same day.
 *
 * Asset/entity/prefab references are excluded: they are identity, not
 * magnitude, and a track that steps a mesh between two .glb paths at 60Hz is a
 * loading storm rather than an animation.
 */
export function animatableProperties(componentType) {
  if (componentType === TRANSFORM_COMPONENT) return TRANSFORM_PROPERTIES;
  const cls = getComponentClass(componentType);
  if (!cls) return [];
  const out = [];
  for (const field of cls.schema ?? []) {
    const valueType = SCHEMA_TYPE_TO_VALUE_TYPE[field?.type];
    if (!valueType || !field.key) continue;
    out.push({ key: field.key, label: field.label ?? field.key, valueType, field });
  }
  return out;
}

/** The value type a track should use for a property, or null if unanimatable. */
export function valueTypeFor(componentType, property) {
  return animatableProperties(componentType).find((p) => p.key === property)?.valueType ?? null;
}

/**
 * Reads the live value of a bound property, in the same units a key stores.
 * Returns `undefined` when the target doesn't exist — the caller decides
 * whether that is worth a warning (the runtime warns once; record mode skips).
 */
export function readProperty(entity, componentType, property, valueType) {
  if (!entity) return undefined;
  if (componentType === TRANSFORM_COMPONENT) {
    const object = entity.object3D;
    if (!object) return undefined;
    if (property === "position") return object.position.toArray();
    if (property === "scale") return object.scale.toArray();
    if (property === "rotation") {
      return [object.rotation.x * DEG, object.rotation.y * DEG, object.rotation.z * DEG];
    }
    return undefined;
  }
  const component = entity.getComponent?.(componentType);
  if (!component) return undefined;
  const value = component.props?.[property];
  // Vec3 props are stored as arrays; hand back a copy so a caller stashing it
  // as a key's value can't alias the component's own array.
  return Array.isArray(value) ? [...value] : value;
}

/**
 * Components whose `onPropChanged` is the base implementation rebuild
 * themselves (detach + attach) on every write — fine for an inspector edit,
 * ruinous at 60Hz. Warned once per component/property so the author learns why
 * their timeline made the frame rate collapse, without a log line per frame.
 */
const warnedRebuilds = new Set();

/**
 * Writes a value onto a bound property.
 *
 * Deliberately does NOT go through `Component.setProp`: that emits
 * `component-changed` + `hierarchy-changed`, and `hierarchy-changed` makes
 * every listener rebuild something proportional to scene size. One of those per
 * animated property per frame turns a four-track timeline into a scene-sized
 * rebuild sixty times a second. The editor's mirror going momentarily stale
 * during playback is the correct trade — the viewport shows the truth, and the
 * runtime restores the authored values when it unbinds.
 */
export function writeProperty(entity, componentType, property, value, valueType) {
  if (!entity || value === undefined) return false;
  if (componentType === TRANSFORM_COMPONENT) {
    const object = entity.object3D;
    if (!object || !Array.isArray(value)) return false;
    if (property === "position") object.position.set(value[0], value[1], value[2]);
    else if (property === "scale") object.scale.set(value[0], value[1], value[2]);
    else if (property === "rotation") {
      object.rotation.set(value[0] * RAD, value[1] * RAD, value[2] * RAD);
    } else return false;
    return true;
  }
  const component = entity.getComponent?.(componentType);
  if (!component) return false;
  component.props[property] = Array.isArray(value) ? [...value] : value;
  // Inherits the base detach/attach implementation → every write is a rebuild.
  if (component.onPropChanged === Component.prototype.onPropChanged) {
    const id = `${componentType}.${property}`;
    if (!warnedRebuilds.has(id)) {
      warnedRebuilds.add(id);
      console.warn(
        `Timeline: animating ${id} rebuilds the ${componentType} component every frame ` +
          `(it doesn't override onPropChanged). Expect it to be slow.`,
      );
    }
  }
  component.onPropChanged?.(property, value);
  return true;
}
