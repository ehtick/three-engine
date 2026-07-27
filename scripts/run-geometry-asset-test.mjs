/**
 * Round-trip test for the `.geom` binary container (v2) and the v1 JSON reader.
 *
 * The GLB import path writes v2 and every existing project holds v1, so both
 * decoders have to produce identical geometry. Run with `npm run test:geom`.
 */
import assert from "node:assert/strict";
import {
  encodeGeometryAsset,
  decodeGeometryAsset,
  geometryFromAsset,
  GEOMETRY_ASSET_VERSION,
  GEOMETRY_BINARY_VERSION,
} from "../src/engine/geometryAsset.js";

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
};

// A two-triangle quad with normals, UVs, a 4-component tangent, one group and
// one morph target — exercises every branch of the container.
const source = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  attributes: {
    tangent: {
      itemSize: 4,
      normalized: false,
      arrayType: "Float32Array",
      array: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
    },
  },
  morphAttributes: {
    position: [
      {
        itemSize: 3,
        normalized: false,
        arrayType: "Float32Array",
        array: [0, 0, 0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 0, 0.5],
      },
    ],
  },
  morphTargetsRelative: true,
  groups: [{ start: 0, count: 6, materialIndex: 0 }],
};

const v1 = { ...source, version: GEOMETRY_ASSET_VERSION };
const encoded = encodeGeometryAsset({ ...source, version: GEOMETRY_BINARY_VERSION });

console.log("geometry asset container");

check("encodes to a byte buffer with the GEOM magic", () => {
  assert.ok(encoded instanceof Uint8Array);
  assert.equal(String.fromCharCode(...encoded.slice(0, 4)), "GEOM");
  assert.equal(new DataView(encoded.buffer).getUint32(4, true), GEOMETRY_BINARY_VERSION);
});

// The point of the container is scale, so measure it at scale: a 100k-vertex
// mesh is an ordinary GLB primitive, and it is where the v1 JSON writer's cost
// became the dominant term in an import.
check("is several times smaller than the JSON form at realistic size", () => {
  const count = 100_000;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = Math.sin(i) * 10;
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;

  const binaryBytes = encodeGeometryAsset({
    version: GEOMETRY_BINARY_VERSION,
    positions,
    indices,
  }).byteLength;
  // What the previous writer produced: rounded numbers in a JSON document.
  const round6 = (v) => Math.round(v * 1e6) / 1e6;
  const jsonBytes = new TextEncoder().encode(
    JSON.stringify({
      version: GEOMETRY_ASSET_VERSION,
      positions: Array.from(positions, round6),
      indices: Array.from(indices),
    }),
  ).byteLength;

  const ratio = jsonBytes / binaryBytes;
  console.log(
    `       ${(jsonBytes / 1e6).toFixed(1)}MB JSON vs ${(binaryBytes / 1e6).toFixed(1)}MB binary (${ratio.toFixed(1)}x)`,
  );
  assert.ok(ratio > 2, `expected >2x smaller, got ${ratio.toFixed(2)}x`);
});

// Size is the lesser half of the story: v1 spent its time in per-element JS
// (round each float, stringify each number, parse each token, range-check each
// index). That is what made a large import take minutes, so assert on it.
check("encodes and decodes an order of magnitude faster than JSON", () => {
  const count = 300_000;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = Math.sin(i) * 10;
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  const round6 = (v) => Math.round(v * 1e6) / 1e6;

  const time = (fn) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  const jsonMs = time(() => {
    const text = JSON.stringify({
      version: GEOMETRY_ASSET_VERSION,
      positions: Array.from(positions, round6),
      indices: Array.from(indices),
    });
    geometryFromAsset(JSON.parse(text));
  });
  const binaryMs = time(() => {
    const bytes = encodeGeometryAsset({
      version: GEOMETRY_BINARY_VERSION,
      positions,
      indices,
    });
    geometryFromAsset(decodeGeometryAsset(bufferOf(bytes)));
  });

  const speedup = jsonMs / binaryMs;
  console.log(
    `       ${count.toLocaleString()} verts: JSON ${jsonMs.toFixed(0)}ms vs binary ${binaryMs.toFixed(0)}ms (${speedup.toFixed(1)}x)`,
  );
  assert.ok(speedup > 5, `expected >5x faster, got ${speedup.toFixed(1)}x`);
});

const decoded = decodeGeometryAsset(
  encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
);

check("decodes flat arrays as typed-array views", () => {
  assert.ok(decoded.positions instanceof Float32Array);
  assert.deepEqual([...decoded.positions], source.positions);
  assert.deepEqual([...decoded.indices], source.indices);
  assert.deepEqual([...decoded.uvs], source.uvs);
  assert.deepEqual([...decoded.normals], source.normals);
});

check("preserves custom attributes and morph targets", () => {
  assert.equal(decoded.attributes.tangent.itemSize, 4);
  assert.deepEqual([...decoded.attributes.tangent.array], source.attributes.tangent.array);
  assert.deepEqual(
    [...decoded.morphAttributes.position[0].array],
    source.morphAttributes.position[0].array,
  );
  assert.equal(decoded.morphTargetsRelative, true);
});

check("v1 JSON and v2 binary build identical geometry", () => {
  const fromJson = geometryFromAsset(v1);
  const fromBinary = geometryFromAsset(decoded);
  for (const name of ["position", "normal", "uv", "tangent"]) {
    assert.deepEqual(
      [...fromBinary.getAttribute(name).array],
      [...fromJson.getAttribute(name).array],
      `attribute ${name} differs`,
    );
  }
  assert.deepEqual([...fromBinary.index.array], [...fromJson.index.array]);
  assert.deepEqual(fromBinary.groups, fromJson.groups);
  assert.equal(fromBinary.morphTargetsRelative, fromJson.morphTargetsRelative);
  assert.deepEqual(
    [...fromBinary.morphAttributes.position[0].array],
    [...fromJson.morphAttributes.position[0].array],
  );
});

check("rejects out-of-range indices", () => {
  assert.throws(
    () => geometryFromAsset({ ...v1, indices: [0, 1, 99] }),
    /out of range/,
  );
});

check("rejects a non-finite position", () => {
  assert.throws(
    () => geometryFromAsset({ ...v1, positions: [0, 0, 0, 1, NaN, 0, 1, 1, 0, 0, 1, 0] }),
    /Invalid geometry positions/,
  );
});

check("uses 32-bit indices past the 16-bit vertex limit", () => {
  const count = 70000;
  const big = {
    version: GEOMETRY_BINARY_VERSION,
    positions: new Float32Array(count * 3),
    indices: new Uint32Array([0, 1, 69999]),
  };
  const geometry = geometryFromAsset(decodeGeometryAsset(bufferOf(encodeGeometryAsset(big))));
  assert.ok(geometry.index.array instanceof Uint32Array);
  assert.equal(geometry.index.array[2], 69999);
});

function bufferOf(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall geometry asset checks passed");
