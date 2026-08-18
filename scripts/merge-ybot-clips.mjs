// One-off: merge the user's separately-downloaded Mixamo Y Bot pieces into one
// GLB the editor's normal import pipeline can unpack.
//
// Mixamo always exports a character and its animations as SEPARATE FBX files
// that happen to share one skeleton (same bone names/hierarchy) — the
// character download carries the mesh + a trivial default clip, and each
// animation download carries NO mesh, just that same skeleton plus one clip
// named "mixamo.com" (every download uses that name, so all four would
// collide if merged as-is). three's exporter/mixer bind animation tracks to
// scene nodes BY NAME, not by originating file, so attaching clips loaded
// from other files onto Y Bot's own skeleton needs no retargeting math — only
// a rename so the four clips stay distinguishable once combined.
//
// Run from anywhere — paths are resolved relative to this script, not the
// working directory:
//   node scripts/merge-ybot-clips.mjs
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Source FBX files and the merged output both live in the character-controller
// module, alongside the .anim graph data that references them — "the
// character module" is one folder, not scripts/ plus wherever a one-off
// conversion happened to run.
const moduleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/modules/character-controller");
const sourceDir = path.join(moduleDir, "assets/source");
const outPath = path.join(moduleDir, "assets/CharacterModel.glb");

// Minimal DOM stubs — FBXLoader/GLTFExporter only reach for these at module
// load time; Y Bot carries no textures to decode (checked: both its
// materials are flat MeshPhongMaterial colours, no maps), so nothing here
// needs a real canvas.
globalThis.self = globalThis;
globalThis.document ??= { createElement: () => ({ style: {} }), createElementNS: () => ({ style: {} }) };
globalThis.window ??= { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
// GLTFExporter's binary path reads its output Blob back through a
// browser-only FileReader; Node's Blob (global since v18) already has
// arrayBuffer(), so the polyfill is just wiring that through the same
// onloadend callback shape the exporter expects.
class NodeFileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
}
globalThis.FileReader ??= NodeFileReader;

const read = (name) => {
  const buf = fs.readFileSync(path.join(sourceDir, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

const ybotRoot = new FBXLoader().parse(read("Y Bot.fbx"), "");

const clipFrom = (file, name) => {
  const root = new FBXLoader().parse(read(file), "");
  const clip = root.animations[0];
  if (!clip) throw new Error(`${file} has no animation clip`);
  clip.name = name;
  return clip;
};

const clips = [
  clipFrom("Idle.fbx", "Idle"),
  clipFrom("Running.fbx", "Running"),
  clipFrom("Jumping Up.fbx", "JumpUp"),
  clipFrom("Jumping Down.fbx", "JumpDown"),
];
// Replace Y Bot's own trivial baked clips ("mixamo.com" 0.03s, "Take 001"
// 0s) — they're not usable poses, just whatever the character download
// happened to carry.
ybotRoot.animations = clips;

// Mixamo exports in centimetres: the raw bind pose measures ~180 units tall.
// `characterRig.js` would scale correctly either way — it MEASURES the
// native height rather than assuming metres — but a GLB that reads as 1.8 m
// instead of 180 "units" is the sane thing to hand anyone who opens it in a
// viewer later, Blender included. Root-level uniform scale is safe for a
// skinned mesh: bone bind matrices and the skeleton hierarchy all still
// compose through the same transform, unlike scaling geometry in place.
ybotRoot.scale.setScalar(0.01);
ybotRoot.updateMatrixWorld(true);

// Y Bot's stock materials are Mixamo's auto-rigger preview colours — a dark
// teal body (Alpha_Body_MAT, #14566a) and near-black joint markers
// (Alpha_Joints_MAT, #1f2b2d), meant to be legible against Mixamo's own dark
// UI, not to look like a character. Flattened to white here rather than left
// for every project to notice and fix individually.
let recoloured = 0;
ybotRoot.traverse((object) => {
  if (!object.isMesh) return;
  for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
    material.color.set("#ffffff");
    recoloured++;
  }
});
console.log(`recoloured ${recoloured} material(s) to white`);

console.log(`merging ${clips.map((c) => `${c.name} (${c.duration.toFixed(2)}s, ${c.tracks.length} tracks)`).join(", ")}`);

const glb = await new GLTFExporter().parseAsync(ybotRoot, {
  binary: true,
  animations: clips,
  onlyVisible: false,
  truncateDrawRange: false,
});
if (!(glb instanceof ArrayBuffer)) throw new Error("export did not produce a binary GLB");

fs.writeFileSync(outPath, Buffer.from(glb));
console.log(`wrote ${outPath}: ${(glb.byteLength / 1048576).toFixed(2)} MB`);
