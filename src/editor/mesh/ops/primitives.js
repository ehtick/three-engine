/**
 * Blender's Add Mesh menu (Shift+A) for Edit Mode.
 *
 * A primitive is built as a `THREE.BufferGeometry` and handed straight to the
 * kernel's own importer, so quad reconstruction, UV seams and the welding rules
 * are exactly the ones an imported model goes through — there is no second,
 * subtly different path for geometry the editor itself creates.
 *
 * Everything here matches Blender's defaults: a plane and a circle are two
 * units across and lie flat, a cube is two units on a side, a cylinder and a
 * cone are two deep, and the new geometry arrives at the 3D cursor and is left
 * as the only thing selected.
 */

import * as THREE from "three/webgpu";
import { addEdge, addFace, addVert } from "../bmesh.js";
import { meshFromBufferGeometry } from "../io.js";
import { clearSelection, flushSelection } from "../select.js";

/**
 * The menu, in Blender's order. `mode` is the select mode the new geometry is
 * most useful in — a circle has no faces, so landing in face mode with an empty
 * selection would look like the operator had failed.
 */
export const PRIMITIVES = [
  { id: "plane", label: "Plane" },
  { id: "cube", label: "Cube" },
  { id: "circle", label: "Circle" },
  { id: "uvsphere", label: "UV Sphere" },
  { id: "icosphere", label: "Ico Sphere" },
  { id: "cylinder", label: "Cylinder" },
  { id: "cone", label: "Cone" },
  { id: "torus", label: "Torus" },
  { id: "grid", label: "Grid" },
];

/**
 * Y-up, not Blender's Z-up: a plane, a circle and a grid are horizontal, which
 * is the axis three builds them across rather than the one it defaults to.
 */
const flat = (geometry) => geometry.rotateX(-Math.PI / 2);

function buildGeometry(kind, options = {}) {
  const size = options.size ?? 2;
  const radius = options.radius ?? 1;
  const segments = options.segments ?? 32;
  switch (kind) {
    case "plane": return flat(new THREE.PlaneGeometry(size, size));
    case "grid": return flat(new THREE.PlaneGeometry(size, size, options.subdivisions ?? 10, options.subdivisions ?? 10));
    // Blender's Add Circle defaults to Fill Type "Nothing", so this one is a
    // bare loop and is built directly rather than through a triangle buffer.
    case "circle": return null;
    case "cube": return new THREE.BoxGeometry(size, size, size);
    case "uvsphere": return new THREE.SphereGeometry(radius, segments, options.rings ?? 16);
    // three counts subdivisions from 0 where Blender counts from 1, so its
    // `detail: 1` is Blender's default "Subdivisions: 2" — 80 triangles.
    case "icosphere": return new THREE.IcosahedronGeometry(radius, Math.max(0, (options.subdivisions ?? 2) - 1));
    case "cylinder": return new THREE.CylinderGeometry(radius, radius, options.depth ?? 2, segments);
    case "cone": return new THREE.ConeGeometry(radius, options.depth ?? 2, segments);
    case "torus": return new THREE.TorusGeometry(radius, options.tube ?? 0.25, options.tubularSegments ?? 12, options.radialSegments ?? 48).rotateX(-Math.PI / 2);
    default: return null;
  }
}

/** An unfilled loop of `segments` vertices, lying flat. */
function addCircle(mesh, at, { radius = 1, segments = 32 } = {}) {
  clearSelection(mesh);
  const ring = [];
  for (let index = 0; index < segments; index++) {
    const angle = (index / segments) * Math.PI * 2;
    const vert = addVert(mesh, [at[0] + Math.cos(angle) * radius, at[1], at[2] + Math.sin(angle) * radius]);
    vert.select = true;
    ring.push(vert);
  }
  for (let index = 0; index < ring.length; index++) {
    const edge = addEdge(mesh, ring[index], ring[(index + 1) % ring.length]);
    if (edge) edge.select = true;
  }
  flushSelection(mesh, "edge");
  return { added: { verts: ring.length, edges: ring.length, faces: 0 }, mode: "edge" };
}

/**
 * Adds `kind` to `mesh` at `at`, and leaves the new geometry — and only the new
 * geometry — selected.
 *
 * Returns `{ added, mode }` where `mode` is the select mode the caller should
 * switch to, or `{ error }` for an unknown primitive.
 */
export function addPrimitive(mesh, kind, { at = [0, 0, 0], material = 0, ...options } = {}) {
  if (!PRIMITIVES.some((entry) => entry.id === kind)) return { error: `Unknown primitive "${kind}"` };
  if (kind === "circle") return addCircle(mesh, at, options);

  const geometry = buildGeometry(kind, options);
  if (!geometry) return { error: `Unknown primitive "${kind}"` };

  let source;
  try {
    source = meshFromBufferGeometry(geometry);
  } finally {
    geometry.dispose();
  }

  clearSelection(mesh);

  // Copied element by element rather than by merging the two meshes: ids come
  // from the destination's counter, so nothing can collide with what is
  // already there, and the copies are the ones that end up selected.
  const vertOf = new Map();
  for (const vert of source.verts) {
    const copy = addVert(mesh, [vert.co[0] + at[0], vert.co[1] + at[1], vert.co[2] + at[2]]);
    copy.select = true;
    vertOf.set(vert, copy);
  }
  for (const edge of source.edges) {
    const copy = addEdge(mesh, vertOf.get(edge.v1), vertOf.get(edge.v2));
    if (copy) {
      copy.seam = edge.seam;
      copy.sharp = edge.sharp;
      copy.select = true;
    }
  }
  let faces = 0;
  for (const face of source.faces) {
    const copy = addFace(mesh, face.loops.map((loop) => vertOf.get(loop.v)), {
      uvs: face.loops.map((loop) => [...loop.uv]),
      material,
      smooth: face.smooth,
    });
    if (copy) {
      copy.select = true;
      faces++;
    }
  }

  const mode = faces ? "face" : source.edges.size ? "edge" : "vert";
  flushSelection(mesh, mode);
  return {
    added: { verts: vertOf.size, edges: source.edges.size, faces },
    mode,
  };
}
