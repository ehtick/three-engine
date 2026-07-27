import * as THREE from "three";
import { meshFromBufferGeometry, bufferGeometryFromMesh } from "./editor/mesh/io.js";
import * as B from "./editor/mesh/bmesh.js";
import * as S from "./editor/mesh/select.js";
import * as E from "./editor/mesh/ops/extrude.js";
import * as T from "./editor/mesh/ops/topology.js";
import * as UV from "./editor/mesh/ops/uv.js";

function checkerTexture() {
  const size = 512, canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d"), cells = 8, step = size / cells;
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    ctx.fillStyle = (x + y) % 2 ? "#e8e8e8" : "#3a6ea5";
    ctx.fillRect(x * step, y * step, step, step);
  }
  ctx.fillStyle = "#d94f38"; ctx.fillRect(0, 0, step, step);
  ctx.fillStyle = "#4caf50"; ctx.fillRect(0, size - step, step, step);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  // Repeat, not clamp: new geometry legitimately extends past the 0..1 tile
  // (a bevel strip continues past the edge of its source face's island), and
  // clamping turns that into stripes of the last texture row.
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const texture = checkerTexture();

/** Rebuild in the core THREE namespace so class identity always matches. */
function toCore(source) {
  const g = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"]) {
    const a = source.getAttribute(name);
    if (a) g.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize));
  }
  const i = source.getIndex();
  if (i) g.setIndex(Array.from(i.array));
  return g;
}

function render(label, geometry) {
  const cell = document.createElement("div"); cell.className = "cell";
  const canvas = document.createElement("canvas"); canvas.width = 340; canvas.height = 300;
  cell.appendChild(canvas);
  const tag = document.createElement("span"); tag.textContent = label; cell.appendChild(tag);
  document.getElementById("grid").appendChild(cell);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0x2b2b2b);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 340 / 300, 0.1, 100);
  camera.position.set(3.4, 2.8, 3.4); camera.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(3, 5, 4); scene.add(key);
  const g = toCore(geometry); g.computeVertexNormals();
  scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8, side: THREE.DoubleSide })));
  renderer.render(scene, camera);
}

const box = () => meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));

render("1 source BoxGeometry", new THREE.BoxGeometry(2, 2, 2));
render("2 loaded + tessellated", bufferGeometryFromMesh(box()));

{
  const mesh = box();
  const top = [...mesh.faces].find((f) => B.faceCenter(f)[1] > 0.9);
  S.setSelection(mesh, "face", [top]);
  const r = E.insetFaces(mesh);
  const t = Math.min(0.4, r.maxThickness);
  for (const v of r.verts) { const o = r.perVertexOffsets.get(v); v.co = [v.co[0]+o[0]*t, v.co[1]+o[1]*t, v.co[2]+o[2]*t]; }
  E.updateSideUVs(r.sides);
  render(`3 inset t=${t.toFixed(2)} max=${r.maxThickness.toFixed(2)}`, bufferGeometryFromMesh(mesh));
}
{
  const mesh = box();
  const e = [...mesh.edges].find((x) => Math.abs(x.v1.co[0]-1)<1e-6 && Math.abs(x.v1.co[1]-1)<1e-6 && Math.abs(x.v2.co[0]-1)<1e-6 && Math.abs(x.v2.co[1]-1)<1e-6);
  S.setSelection(mesh, "edge", [e]);
  T.bevelEdges(mesh, S.selected(mesh, "edge"), { width: 0.4, segments: 1 });
  render("4 bevel one edge", bufferGeometryFromMesh(mesh));
}
{ const mesh = box(); S.selectAll(mesh, "face"); T.subdivideFaces(mesh, S.selected(mesh, "face"), 2); render("5 subdivide x2", bufferGeometryFromMesh(mesh)); }
{ const mesh = box(); UV.unwrapBox(mesh); render("6 unwrapBox", bufferGeometryFromMesh(mesh)); }
{
  const mesh = box();
  const top = [...mesh.faces].find((f) => B.faceCenter(f)[1] > 0.9);
  S.setSelection(mesh, "face", [top]);
  const r = E.extrudeFaceRegion(mesh);
  for (const v of r.verts) v.co = [v.co[0], v.co[1] + 0.8, v.co[2]];
  E.updateSideUVs(r.sides);
  render("7 extrude", bufferGeometryFromMesh(mesh));
}
render("8 sphere SOURCE", new THREE.SphereGeometry(1.4, 20, 14));
render("9 sphere loaded", bufferGeometryFromMesh(meshFromBufferGeometry(new THREE.SphereGeometry(1.4, 20, 14))));
render("10 cylinder SOURCE", new THREE.CylinderGeometry(1.2, 1.2, 2, 20));
render("11 cylinder loaded", bufferGeometryFromMesh(meshFromBufferGeometry(new THREE.CylinderGeometry(1.2, 1.2, 2, 20))));
window.__ready = true;
