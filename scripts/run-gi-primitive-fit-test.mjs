// Unit test for the imported-geometry primitive classifier (primitiveFit.js).
//
// Pure node, no browser, no GPU — the classifier is plain arithmetic over a
// position buffer, so it does not need the editor and cannot inherit the
// editor harnesses' intermittent boot flake.
//
// The bar is asymmetric on purpose. A MISS costs quality (the mesh bakes to a
// grid, exactly as before). A FALSE POSITIVE replaces real geometry with a
// solid block and seals whatever was behind it — so the rejection cases below
// matter more than the acceptance ones.
import * as THREE from "three";
import { fitPrimitive } from "../src/modules/gi/primitiveFit.js";

// Imported geometry has no `parameters`; strip it so we exercise the same path
// a GLB does rather than the construction-args shortcut.
const asImported = (geometry) => {
  const g = geometry.clone();
  delete g.parameters;
  g.computeBoundingBox();
  return g;
};

let failed = 0;
const check = (name, actual, expected) => {
  const ok = expected === null ? actual === null : actual?.type === expected;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name} → ${actual ? actual.type : "null"} (expected ${expected ?? "null"})`);
  if (!ok) failed++;
};
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// --- should be recognised -------------------------------------------------
check("BoxGeometry(2,3,4)", fitPrimitive(asImported(new THREE.BoxGeometry(2, 3, 4))), "box");
check("BoxGeometry tessellated 4x4x4", fitPrimitive(asImported(new THREE.BoxGeometry(2, 2, 2, 4, 4, 4))), "box");
check("PlaneGeometry(5,5)", fitPrimitive(asImported(new THREE.PlaneGeometry(5, 5))), "box");
check("PlaneGeometry tessellated", fitPrimitive(asImported(new THREE.PlaneGeometry(5, 5, 8, 8))), "box");
check("SphereGeometry(1.5)", fitPrimitive(asImported(new THREE.SphereGeometry(1.5, 32, 24))), "sphere");

// --- must NOT be recognised ----------------------------------------------
check("TorusKnotGeometry", fitPrimitive(asImported(new THREE.TorusKnotGeometry(1, 0.3, 64, 16))), null);
check("TorusGeometry", fitPrimitive(asImported(new THREE.TorusGeometry(1, 0.3, 16, 32))), null);
check("CylinderGeometry (no GPU kind yet)", fitPrimitive(asImported(new THREE.CylinderGeometry(1, 1, 3, 32))), null);
check("ConeGeometry", fitPrimitive(asImported(new THREE.ConeGeometry(1, 2, 32))), null);
check("IcosahedronGeometry (faceted, not a sphere)", fitPrimitive(asImported(new THREE.IcosahedronGeometry(1, 0))), null);

// A box with one face removed — an OPEN shell. Fitting it solid would seal
// whatever is inside, which is the failure mode the six-face test exists for.
{
  // Drop the +x face. Positions alone cannot show the hole (every remaining
  // corner still touches the +x plane) — the normals are what reveal it, so
  // they have to come along.
  const box = asImported(new THREE.BoxGeometry(2, 2, 2)).toNonIndexed();
  const pos = box.attributes.position;
  const nrm = box.attributes.normal;
  const keptP = [];
  const keptN = [];
  for (let i = 0; i < pos.count; i++) {
    if (nrm.getX(i) > 0.9) continue; // drop every +x-facing vertex
    keptP.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    keptN.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
  }
  const open = new THREE.BufferGeometry();
  open.setAttribute("position", new THREE.Float32BufferAttribute(keptP, 3));
  open.setAttribute("normal", new THREE.Float32BufferAttribute(keptN, 3));
  open.computeBoundingBox();
  check("box missing a face (open shell)", fitPrimitive(open), null);
}

// A squashed sphere: the atlas stores ONE radius, so an ellipsoid must stay
// baked rather than read its largest axis in every direction.
{
  const ellipsoid = asImported(new THREE.SphereGeometry(1, 32, 24));
  ellipsoid.scale(1, 0.4, 1);
  ellipsoid.computeBoundingBox();
  check("ellipsoid (squashed sphere)", fitPrimitive(ellipsoid), null);
}

// --- fitted values must be right, not just the right kind -----------------
{
  const fit = fitPrimitive(asImported(new THREE.BoxGeometry(2, 6, 4)));
  const ok = fit && near(fit.half[0], 1) && near(fit.half[1], 3) && near(fit.half[2], 2);
  console.log(`${ok ? "PASS" : "FAIL"}: box half-extents ${fit ? fit.half.map((v) => v.toFixed(2)).join(",") : "-"} (expected 1.00,3.00,2.00)`);
  if (!ok) failed++;
}
{
  // The case that matters for the leak: a thin sheet keeps its REAL thickness
  // instead of being rounded up to a field cell.
  const sheet = asImported(new THREE.BoxGeometry(4, 4, 0.05));
  const fit = fitPrimitive(sheet);
  const ok = fit && near(fit.half[2], 0.025);
  console.log(`${ok ? "PASS" : "FAIL"}: 5cm sheet keeps its thickness (half ${fit ? fit.half[2].toFixed(4) : "-"}, expected 0.0250)`);
  if (!ok) failed++;
}
{
  const fit = fitPrimitive(asImported(new THREE.SphereGeometry(2.5, 32, 24)));
  const ok = fit && near(fit.half[0], 2.5, 0.02);
  console.log(`${ok ? "PASS" : "FAIL"}: sphere radius ${fit ? fit.half[0].toFixed(3) : "-"} (expected 2.500)`);
  if (!ok) failed++;
}
{
  // Off-origin geometry must report its own centre, not the world origin.
  const moved = asImported(new THREE.BoxGeometry(2, 2, 2));
  moved.translate(10, -3, 7);
  moved.computeBoundingBox();
  const fit = fitPrimitive(moved);
  const ok = fit && near(fit.center[0], 10) && near(fit.center[1], -3) && near(fit.center[2], 7);
  console.log(`${ok ? "PASS" : "FAIL"}: off-origin centre ${fit ? fit.center.map((v) => v.toFixed(1)).join(",") : "-"} (expected 10.0,-3.0,7.0)`);
  if (!ok) failed++;
}

console.log(failed === 0 ? "\nGI-PF ALL PASS" : `\nGI-PF ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
