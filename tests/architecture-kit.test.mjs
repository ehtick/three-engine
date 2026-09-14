import test from "node:test";
import assert from "node:assert/strict";
import { buildArchitectureFormGeometry, describeBuilding } from "../src/modules/architecture/formGeometry.js";
import { normalizeArchitectureModel, resolveArchitectureForm, getArchitectureFormFootprint } from "../src/modules/architecture/formModel.js";
import { STYLE_IDS, getStyle, validateStyle, resolveStyle, normalizeStyleParams, SURFACE_KINDS, listStyles } from "../src/modules/architecture/styles/catalog.js";
import { STATIC_LAYERS, layerIndexFor } from "../src/modules/architecture/styles/surfaces.js";
import { createRng } from "../src/modules/architecture/styles/rng.js";
import { openingOutline, headY, headRise } from "../src/modules/architecture/kit/openingShape.js";
import { KitMesh, clipPolygon2 } from "../src/modules/architecture/kit/kitMesh.js";
import { ARCHITECTURE_PREVIEW_SCENARIOS as SCENARIOS } from "../scripts/lib/architecturePreviewScenarios.js";

const box = (id, position, size, extra = {}) => ({ id, shape: "box", position, size, rotationY: 0, roof: "auto", roofHeight: null, windows: true, ...extra });
const styled = (model, id, seed = 1, params) => ({ ...model, style: { id, seed, ...(params ? { params } : {}) } });
const tri = (geometry, i) => { const p = geometry.attributes.position, idx = geometry.index; return [0, 1, 2].map(k => { const v = idx.getX(i * 3 + k); return [p.getX(v), p.getY(v), p.getZ(v)]; }); };

test("every catalogue style validates; unknown ids fall back; the listing carries swatches", () => {
  assert.ok(STYLE_IDS.length >= 15);
  for (const id of STYLE_IDS) assert.doesNotThrow(() => validateStyle(getStyle(id)), id);
  assert.equal(getStyle("nope").id, "timber-medieval");
  assert.ok(listStyles().every(s => s.swatch.length === 3 && s.label));
  assert.throws(() => validateStyle({ ...getStyle("castle"), roof: { ...getStyle("castle").roof, cover: "glass" } }));
});

test("style params are clamped and applied without mutating the catalogue", () => {
  assert.deepEqual(normalizeStyleParams({ roofPitch: 500, overhang: -2, wall: "#123456", junk: 1 }), { roofPitch: 70, overhang: 0, wall: "#123456" });
  const s = resolveStyle("tiny-glade", { roofPitch: 30, chimneys: 0, plinth: false, wall: "#ff0000" });
  assert.ok(Math.abs(s.roof.pitch - 30 * Math.PI / 180) < 1e-9);
  assert.equal(s.roof.chimney, 0); assert.equal(s.walls.plinth.type, "none"); assert.deepEqual(s.palette.wall, ["#ff0000"]);
  assert.notEqual(getStyle("tiny-glade").walls.plinth.type, "none");
  const model = normalizeArchitectureModel({ forms: [box("a", [0, 0, 0], [6, 4, 5])], style: { id: "castle", seed: 2, params: { overhang: 9 } } });
  assert.deepEqual(model.style, { id: "castle", seed: 2, params: { overhang: 1.5 } });
});

test("auto roofs follow the style: castle boxes are flat, tiny-glade boxes gable, towers cone/dome/flat", () => {
  const form = normalizeArchitectureModel({ forms: [box("a", [0, 0, 0], [8, 4, 6])] }).forms[0];
  assert.equal(resolveArchitectureForm(form, resolveStyle("castle")).roof, "flat");
  const glade = resolveArchitectureForm(form, resolveStyle("tiny-glade"));
  assert.equal(glade.roof, "gable");
  assert.ok(Math.abs(glade.roofHeight - 3 * Math.tan(44 * Math.PI / 180)) < 1e-6, "roof height follows the style pitch over the half span");
  const tower = normalizeArchitectureModel({ forms: [{ id: "t", shape: "round", position: [0, 0, 0], size: [4, 8, 4], roof: "auto", roofHeight: null }] }).forms[0];
  assert.equal(resolveArchitectureForm(tower, resolveStyle("plaster-mediterranean")).roof, "dome");
  assert.equal(resolveArchitectureForm(tower, resolveStyle("modern")).roof, "flat");
  assert.equal(resolveArchitectureForm(tower, resolveStyle("gothic")).roof, "hip");
  const wall = normalizeArchitectureModel({ forms: [{ id: "w", kind: "wall", position: [0, 0, 0], size: [6, 2, .5], roof: "auto" }] }).forms[0];
  assert.equal(resolveArchitectureForm(wall, resolveStyle("castle")).roof, "none");
});

test("every style builds every preview scenario: finite, bounded, four materials at most, deterministic", () => {
  for (const id of STYLE_IDS) for (const [name, make] of Object.entries(SCENARIOS)) {
    const built = buildArchitectureFormGeometry(styled(make(), id, 3));
    const p = built.geometry.attributes.position.array;
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) assert.fail(`${id}/${name} has a non-finite vertex`);
    assert.ok(built.stats.triangles < 160000, `${id}/${name} ${built.stats.triangles} triangles`);
    const styledRoles = built.materials.filter(m => m.styled).map(m => m.role);
    assert.ok(styledRoles.every(r => ["surface", "glass", "metal", "light"].includes(r)), `${id}/${name} ${styledRoles}`);
    assert.equal(built.geometry.attributes.styleTint.itemSize, 4);
    built.geometry.dispose();
  }
  const a = buildArchitectureFormGeometry(styled(SCENARIOS.lplan(), "stone-cottage", 7)).geometry.attributes.position.array;
  const b = buildArchitectureFormGeometry(styled(SCENARIOS.lplan(), "stone-cottage", 7)).geometry.attributes.position.array;
  assert.deepEqual([...a], [...b]);
});

test("picking ranges still cover every index exactly once in a styled model", () => {
  const built = buildArchitectureFormGeometry(styled(SCENARIOS.tower(), "tiny-glade"));
  const covered = new Uint8Array(built.geometry.index.count);
  for (const s of built.surfaces) for (let i = s.start; i < s.start + s.count; i++) covered[i]++;
  assert.ok(covered.every(v => v === 1));
  assert.ok(built.surfaces.some(s => s.kind === "roof" && s.formId === "tower"), "a round roof is pickable as that form's roof");
});

test("one automatic entrance per connected building, none when a door is authored", () => {
  const doors = model => describeBuilding(model).walls.flatMap(w => w.openings).filter(o => o.kind === "door").length;
  assert.equal(doors(styled(SCENARIOS.cottage(), "tiny-glade")), 1);
  assert.equal(doors(styled(SCENARIOS.cells(), "tiny-glade")), 1, "grown cells are one building");
  const two = { forms: [box("a", [0, 0, 0], [6, 4, 5]), box("b", [20, 0, 0], [6, 4, 5])], openings: [], paths: [] };
  assert.equal(doors(styled(two, "tiny-glade")), 2);
  const authored = { ...SCENARIOS.cottage(), openings: [{ id: "d", formId: "main", position: [1, 1.1, 3], normal: [0, 0, 1], width: 1.1, height: 2.2, kind: "door" }] };
  assert.equal(doors(styled(authored, "tiny-glade")), 1);
  assert.equal(doors(SCENARIOS.cottage()), 0, "unstyled massing keeps its old behaviour");
});

test("style detail never lands inside a neighbouring form", () => {
  for (const id of ["tiny-glade", "timber-medieval", "castle", "gothic", "industrial"]) for (const name of ["lplan", "tower", "cells", "bridge"]) {
    const model = normalizeArchitectureModel(styled(SCENARIOS[name](), id));
    const style = resolveStyle(id);
    const forms = model.forms.map(f => resolveArchitectureForm(f, style));
    const built = buildArchitectureFormGeometry(model);
    const inside = (form, point) => {
      const c = Math.cos(form.rotationY), s = Math.sin(form.rotationY), dx = point[0] - form.position[0], dz = point[2] - form.position[2];
      const lx = dx * c - dz * s, lz = dx * s + dz * c, m = .12;
      if (point[1] < form.position[1] + m || point[1] > form.position[1] + form.size[1] - m) return false;
      if (form.shape === "round") return (lx / (form.size[0] / 2 - m)) ** 2 + (lz / (form.size[2] / 2 - m)) ** 2 < 1;
      return Math.abs(lx) < form.size[0] / 2 - m && Math.abs(lz) < form.size[2] / 2 - m;
    };
    for (const range of built.surfaces.filter(s => s.detail && s.formId)) {
      const owner = forms.find(f => f.id === range.formId);
      for (let i = range.start; i < range.start + range.count; i += 3) {
        const t = tri(built.geometry, i / 3), c = [0, 1, 2].map(k => (t[0][k] + t[1][k] + t[2][k]) / 3);
        const intruded = forms.find(f => f !== owner && inside(f, c));
        // Roof slabs of a lower wing legitimately tuck under a taller wall; walls/openings may not.
        if (intruded && range.kind !== "roof" && range.kind !== "roof-detail") assert.fail(`${id}/${name}: ${range.kind} of ${owner.id} inside ${intruded.id} at ${c.map(v => v.toFixed(2))}`);
      }
    }
    built.geometry.dispose();
  }
});

test("a styled gable roof overhangs its eaves by the style overhang, and no further", () => {
  const model = styled({ forms: [box("a", [0, 0, 0], [8, 4, 6], { roofAxis: "x", windows: false })], openings: [], paths: [] }, "tiny-glade", 1, { chimneys: 0 });
  const built = buildArchitectureFormGeometry(model), overhang = getStyle("tiny-glade").roof.overhang;
  let maxZ = 0, maxX = 0;
  for (const range of built.surfaces.filter(s => s.kind === "roof" || s.kind === "roof-detail")) for (let i = range.start; i < range.start + range.count; i++) {
    const v = built.geometry.index.getX(i), p = built.geometry.attributes.position;
    maxZ = Math.max(maxZ, Math.abs(p.getZ(v))); maxX = Math.max(maxX, Math.abs(p.getX(v)));
  }
  assert.ok(maxZ > 3 + overhang * .8 && maxZ < 3 + overhang + .5, `eave reach ${maxZ}`);
  assert.ok(maxX > 4 + overhang * .8 && maxX < 4 + overhang + .5, `verge reach ${maxX}`);
});

test("castle flat roofs and free-standing walls carry battlements above their tops", () => {
  const model = styled({ forms: [box("keep", [0, 0, 0], [8, 6, 8], { windows: false }), { id: "w", kind: "wall", shape: "box", position: [12, 0, 0], size: [8, 4, 1.4], roof: "none", windows: false }], openings: [], paths: [] }, "castle");
  const built = buildArchitectureFormGeometry(model), p = built.geometry.attributes.position;
  let keepTop = 0, wallTop = 0;
  for (let i = 0; i < p.count; i++) { if (Math.abs(p.getX(i)) < 5) keepTop = Math.max(keepTop, p.getY(i)); else wallTop = Math.max(wallTop, p.getY(i)); }
  assert.ok(keepTop > 6 + 1.2, `keep crenellations reach ${keepTop}`);
  assert.ok(wallTop > 4 + .8, `wall crenellations reach ${wallTop}`);
});

test("round walls shade smoothly: outward normals follow the drum, not 24 flat facets", () => {
  const model = styled({ forms: [{ id: "t", shape: "round", position: [0, 0, 0], size: [4, 6, 4], roof: "flat", windows: false }], openings: [], paths: [] }, "modern");
  const built = buildArchitectureFormGeometry(model), n = built.geometry.attributes.normal, p = built.geometry.attributes.position;
  let checked = 0;
  for (const range of built.surfaces.filter(s => s.kind === "wall" && !s.interior && !s.detail)) for (let i = range.start; i < range.start + range.count; i++) {
    const v = built.geometry.index.getX(i), radial = [p.getX(v), 0, p.getZ(v)], l = Math.hypot(radial[0], radial[2]);
    if (l < 1.5) continue;
    assert.ok((n.getX(v) * radial[0] + n.getZ(v) * radial[2]) / l > .999); checked++;
  }
  assert.ok(checked > 40);
});

test("describeBuilding frames stay right-handed and openings sit inside their fragments", () => {
  for (const id of ["tiny-glade", "modern", "castle"]) {
    const d = describeBuilding(styled(SCENARIOS.tower(), id));
    for (const w of d.walls) {
      const [t, u, n] = [w.tangent, w.up, w.normal];
      const cross = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
      assert.ok(cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] > .99);
      for (const o of w.openings) assert.ok(o.u + o.width / 2 > -1e-3 && o.u + o.width / 2 < w.width + 1e-3 && o.v + o.height / 2 > -1e-3 && o.v + o.height / 2 < w.height + 1e-3);
    }
  }
});

test("opening outlines are convex, start at the sill and reach the full height", () => {
  for (const head of ["flat", "round", "pointed", "segment"]) {
    const pts = openingOutline(1, 2, head, 12);
    let sign = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cr) < 1e-9) continue;
      if (!sign) sign = Math.sign(cr); else assert.equal(Math.sign(cr), sign, `${head} convex`);
    }
    assert.ok(Math.abs(Math.max(...pts.map(p => p[1])) - 2) < 1e-6, head);
    assert.ok(Math.abs(headY(1, 2, head, 0) - (2 - headRise(1, 2, head))) < 1e-6, `${head} springs at the jamb`);
  }
});

test("surface layers: one per kind, stable", () => {
  assert.deepEqual(STATIC_LAYERS.map(l => l.kind), [...SURFACE_KINDS]);
  const seen = new Set(SURFACE_KINDS.map(k => layerIndexFor(k)));
  assert.equal(seen.size, SURFACE_KINDS.length);
  assert.equal(layerIndexFor("unknown"), layerIndexFor("plaster"));
});

test("kit primitives: bevelled boxes close, clipping keeps convex pieces inside the clipper", () => {
  const kit = new KitMesh();
  kit.box({ o: [0, 0, 0], t: [1, 0, 0], u: [0, 1, 0], n: [0, 0, 1] }, -1, 1, -1, 1, -1, 1, { bevel: .1 });
  assert.equal(kit.triangles, 44);
  const bucket = [...kit.buckets.values()][0];
  let volume = 0;
  for (let i = 0; i < bucket.position.length; i += 9) {
    const [a, b, c] = [0, 3, 6].map(k => bucket.position.slice(i + k, i + k + 3));
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  assert.ok(volume > 7.5 && volume < 8, `outward-wound closed volume ${volume}`);
  const piece = clipPolygon2([[-1, -1], [3, -1], [3, 3], [-1, 3]], [[0, 0], [2, 0], [0, 2]]);
  assert.ok(piece.every(([x, y]) => x > -1e-9 && y > -1e-9 && x + y < 2 + 1e-9));
  assert.equal(createRng(4).next(), createRng(4).next());
  void getArchitectureFormFootprint;
});
