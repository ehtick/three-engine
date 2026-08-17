// matchStockPbr — the §13.15 stock-PBR recognizer.
//
// The contract under test: the canonical imported-PBR graph shapes express as
// plain material properties (so N imports share one program), and EVERYTHING
// else bails to the compile path unchanged. A false MATCH is a rendering bug
// (the graph's real look silently replaced); a false BAIL is only a perf miss.
// Every bail case here guards a specific correctness edge, so keep them.
import { matchStockPbr } from "../src/engine/tslGraph.js";

let failures = 0;
const check = (name, got) => {
  console.log(`  ${got ? "ok  " : "FAIL"} ${name}`);
  if (!got) failures++;
};

const output = { id: "out", type: "output", props: {} };
const bsdf = (props = {}) => ({ id: "bsdf", type: "principledBsdf", props });
const tex = (id, path = `${id}.png`) => ({ id, type: "texture", props: { path } });
const surface = { source: "bsdf", sourceHandle: "out", target: "out", targetHandle: "surface" };
const graph = (nodes, edges) => ({ nodes, edges });

// ── the three canonical import shapes ────────────────────────────────────────
{
  const g = graph([bsdf({ roughness: 0.82, metalness: 0 }), output], [surface]);
  const m = matchStockPbr(g);
  check("constants-only matches", !!m);
  check("constants: roughness carried", m?.roughness === 0.82);
  check("constants: no maps", m?.map === null && m?.normalMap === null);
}
{
  const g = graph(
    [tex("t"), bsdf({ roughness: 0.7 }), output],
    [{ source: "t", sourceHandle: "out", target: "bsdf", targetHandle: "color" }, surface],
  );
  const m = matchStockPbr(g);
  check("texture→color matches", !!m);
  check("wired color pins factor to white (graph path has no factor multiply)", m?.color === "#ffffff");
  check("map path carried", m?.map === "t.png");
}
{
  const g = graph(
    [tex("td"), tex("tn"), { id: "nm", type: "normalMap", props: { scale: 0.8 } }, bsdf({}), output],
    [
      { source: "td", sourceHandle: "out", target: "bsdf", targetHandle: "color" },
      { source: "tn", sourceHandle: "out", target: "nm", targetHandle: "color" },
      { source: "nm", sourceHandle: "out", target: "bsdf", targetHandle: "normal" },
      surface,
    ],
  );
  const m = matchStockPbr(g);
  check("texture+normalMap matches", !!m);
  check("normalMap path carried", m?.normalMap === "tn.png");
  check("normalMap scale carried", m?.normalScale === 0.8);
}

// ── the ORM/ARM shape: what every real glTF import actually looks like ───────
//
// Before this was recognized, 129 of 142 Bistro materials fell to the compile
// path — which meant 129 unique WGSL programs AND (because a `roughnessNode`
// was set) zero static merging, so a 384-mesh scene submitted 384 draws with a
// merge floor of 7.
{
  const g = graph(
    [tex("td"), tex("tarm"), tex("tn"), { id: "nm", type: "normalMap", props: { scale: 1 } },
      bsdf({ roughness: 1, metalness: 1 }), output],
    [
      { source: "td", sourceHandle: "out", target: "bsdf", targetHandle: "color" },
      { source: "tarm", sourceHandle: "g", target: "bsdf", targetHandle: "roughness" },
      { source: "tarm", sourceHandle: "b", target: "bsdf", targetHandle: "metalness" },
      { source: "tn", sourceHandle: "out", target: "nm", targetHandle: "color" },
      { source: "nm", sourceHandle: "out", target: "bsdf", targetHandle: "normal" },
      surface,
    ],
  );
  const m = matchStockPbr(g);
  check("ORM graph matches (one texture feeding .g→roughness and .b→metalness)", !!m);
  check("ORM: roughnessMap carried", m?.roughnessMap === "tarm.png");
  check("ORM: metalnessMap carried", m?.metalnessMap === "tarm.png");
  check("ORM: colour and normal still carried alongside", m?.map === "td.png" && m?.normalMap === "tn.png");
  // three composes `roughness * roughnessMap.g`; the graph path is the texel
  // ALONE. Only a factor of 1 makes those the same number.
  check("ORM: wired roughness pins its factor to 1", m?.roughness === 1);
  check("ORM: wired metalness pins its factor to 1", m?.metalness === 1);
}
{
  // A scalar the author set is DISCARDED by the wire on the graph path, so the
  // stock expression must discard it too rather than multiply the map by it.
  const g = graph(
    [tex("tarm"), bsdf({ roughness: 0.25, metalness: 0.75 }), output],
    [
      { source: "tarm", sourceHandle: "g", target: "bsdf", targetHandle: "roughness" },
      { source: "tarm", sourceHandle: "b", target: "bsdf", targetHandle: "metalness" },
      surface,
    ],
  );
  const m = matchStockPbr(g);
  check("ORM: a wired channel overrides its stored scalar", m?.roughness === 1 && m?.metalness === 1);
}
{
  // Unwired channels keep their scalars even when the other one is mapped.
  const g = graph(
    [tex("tarm"), bsdf({ roughness: 0.25, metalness: 0.75 }), output],
    [{ source: "tarm", sourceHandle: "g", target: "bsdf", targetHandle: "roughness" }, surface],
  );
  const m = matchStockPbr(g);
  check("ORM: an unwired channel keeps its scalar", m?.roughness === 1 && m?.metalness === 0.75);
  check("ORM: half-wired carries only the mapped slot",
    m?.roughnessMap === "tarm.png" && m?.metalnessMap === null);
}

// ── alpha-masked foliage: the colour map's own alpha into opacity ────────────
{
  const g = graph(
    [tex("td"), bsdf({}), output],
    [
      { source: "td", sourceHandle: "out", target: "bsdf", targetHandle: "color" },
      { source: "td", sourceHandle: "a", target: "bsdf", targetHandle: "opacity" },
      surface,
    ],
  );
  const m = matchStockPbr(g);
  check("colour map's own alpha → opacity matches (three's map is a vec4)", !!m);
  check("alpha wire needs no extra slot — it rides on map", m?.map === "td.png");
}

// ── every bail class guards a correctness edge ───────────────────────────────
const bails = [
  // three reaches the diffuse alpha through `map` and nowhere else; its
  // `alphaMap` samples `.g` of a DIFFERENT image, so a foreign alpha wire has
  // no stock spelling at all.
  ["a NON-colour texture's alpha into opacity (three's alphaMap reads .g)",
    graph([tex("td"), tex("ta"), bsdf({}), output],
      [{ source: "td", sourceHandle: "out", target: "bsdf", targetHandle: "color" },
       { source: "ta", sourceHandle: "a", target: "bsdf", targetHandle: "opacity" }, surface])],
  // The channel pairing is not a detail: three's stock material samples
  // `roughnessMap.g` and `metalnessMap.b` and there is no property that reads
  // any other channel, so a swapped wire has no stock expression at all.
  ["ORM channels swapped (.b→roughness has no stock equivalent)",
    graph([tex("t"), bsdf({}), output],
      [{ source: "t", sourceHandle: "b", target: "bsdf", targetHandle: "roughness" }, surface])],
  ["ORM occlusion wired (three's aoMap reads a different UV set)",
    graph([tex("t"), bsdf({}), output],
      [{ source: "t", sourceHandle: "r", target: "bsdf", targetHandle: "ao" }, surface])],
  ["non-black emissive (GI emitter must stay on the graph path)",
    graph([bsdf({ emissive: "#ffffff", emissiveStrength: 10 }), output], [surface])],
  ["opacity ≠ 1",
    graph([bsdf({ opacity: 0.5 }), output], [surface])],
  ["constant ao ≠ 1 (no stock equivalent)",
    graph([bsdf({ ao: 0.5 }), output], [surface])],
  ["value on a wire-only channel (legacy Floor.mat: sheen 0 compiles to a live uniform)",
    graph([bsdf({ sheen: 0 }), output], [surface])],
  ["swizzled texture output (.r into roughness is not a stock shape)",
    graph([tex("t"), bsdf({}), output],
      [{ source: "t", sourceHandle: "r", target: "bsdf", targetHandle: "roughness" }, surface])],
  ["wired texture UV (custom tiling can't ride material props)",
    graph([tex("t"), { id: "u", type: "uv", props: {} }, bsdf({}), output],
      [{ source: "u", sourceHandle: "out", target: "t", targetHandle: "uv" },
       { source: "t", sourceHandle: "out", target: "bsdf", targetHandle: "color" }, surface])],
  ["unknown node type (time-animated graph)",
    graph([{ id: "tm", type: "time", props: {} }, bsdf({}), output], [surface])],
  ["texture fan-out (one texture feeding two channels)",
    graph([tex("t"), bsdf({}), output],
      [{ source: "t", sourceHandle: "out", target: "bsdf", targetHandle: "color" },
       { source: "t", sourceHandle: "out", target: "bsdf", targetHandle: "roughness" }, surface])],
  ["orphan texture node",
    graph([tex("t"), bsdf({}), output], [surface])],
  ["texture without a path",
    graph([{ id: "t", type: "texture", props: {} }, bsdf({}), output],
      [{ source: "t", sourceHandle: "out", target: "bsdf", targetHandle: "color" }, surface])],
  ["no surface wire",
    graph([bsdf({}), output], [])],
  ["empty graph", graph([], [])],
];
for (const [name, g] of bails) check(`bails: ${name}`, matchStockPbr(g) === null);

// Emissive black with strength is fine — black × anything is black.
check("black emissive with strength still matches",
  !!matchStockPbr(graph([bsdf({ emissive: "#000000", emissiveStrength: 5 }), output], [surface])));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall stock-PBR recognizer checks passed");
