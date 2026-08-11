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

// ── every bail class guards a correctness edge ───────────────────────────────
const bails = [
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
