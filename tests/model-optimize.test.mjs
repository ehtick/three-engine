// Gate: build-time model optimization (build/modelOptimize.js) — dedup/prune/
// weld before Draco must not change what the engine can see: triangle count,
// node names, animations, skins, morph targets, leaf sockets, extra attributes.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Document, NodeIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression } from "@gltf-transform/extensions";
import { draco, prune } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { optimizeModelDocument } from "../src/editor/build/modelOptimize.js";

function stats(doc) {
  const root = doc.getRoot();
  let triangles = 0;
  let vertices = 0;
  let morphTargets = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const count = prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION").getCount();
      if (prim.getMode() === 4) triangles += count / 3;
      vertices += prim.getAttribute("POSITION").getCount();
      morphTargets += prim.listTargets().length;
    }
  }
  return {
    triangles,
    vertices,
    morphTargets,
    nodeNames: root.listNodes().map((n) => n.getName()).sort(),
    animations: root.listAnimations().map((a) => [a.getName(), a.listChannels().length]),
    skins: root.listSkins().map((s) => s.listJoints().length),
  };
}

function fixtureDoc() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  // Two triangles over six vertices, two of them bitwise duplicates → weld merges.
  const position = doc.createAccessor().setType("VEC3").setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]));
  // A UV set no material samples — prune's default would strip it.
  const uv = doc.createAccessor().setType("VEC2").setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]));
  const prim = doc.createPrimitive().setAttribute("POSITION", position).setAttribute("TEXCOORD_0", uv)
    .setMaterial(doc.createMaterial("Body"));
  const mesh = doc.createMesh("Quad").addPrimitive(prim);
  const socket = doc.createNode("Socket_Hand"); // empty leaf, found by name at runtime
  const body = doc.createNode("Body").setMesh(mesh).addChild(socket);
  doc.createScene("Scene").addChild(body);
  return doc;
}

test("synthetic: keeps leaf sockets and unused attributes, welds duplicates", async () => {
  const doc = fixtureDoc();
  const before = stats(doc);
  await optimizeModelDocument(doc);
  const after = stats(doc);
  assert.equal(after.triangles, before.triangles);
  assert.deepEqual(after.nodeNames, before.nodeNames);
  assert.ok(after.vertices < before.vertices, `weld merged vertices ${before.vertices} → ${after.vertices}`);
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  assert.ok(prim.getAttribute("TEXCOORD_0"), "unused UV set kept");
});

test("negative control: default prune drops exactly what the gate protects", async () => {
  const doc = fixtureDoc();
  await doc.transform(prune());
  const names = doc.getRoot().listNodes().map((n) => n.getName());
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  assert.ok(!names.includes("Socket_Hand"), "default prune drops the empty leaf socket");
  assert.ok(!prim.getAttribute("TEXCOORD_0"), "default prune drops the unsampled UV set");
});

const FIXTURES = [
  "src/modules/character-controller/assets/CharacterModel.glb",
  "artifacts/kimodo/Walking.glb",
].filter((p) => existsSync(p));

for (const path of FIXTURES) {
  test(`real GLB survives optimize + Draco: ${path}`, async () => {
    const [encoder, decoder] = await Promise.all([draco3d.createEncoderModule(), draco3d.createDecoderModule()]);
    const io = new NodeIO().registerExtensions([KHRDracoMeshCompression])
      .registerDependencies({ "draco3d.encoder": encoder, "draco3d.decoder": decoder });
    const original = new Uint8Array(readFileSync(path));
    const doc = await io.readBinary(original);
    const before = stats(doc);

    await optimizeModelDocument(doc);
    const optimizedBytes = await io.writeBinary(doc);
    const optimized = stats(await io.readBinary(optimizedBytes));

    const plain = await io.readBinary(original);
    await plain.transform(draco());
    const dracoOnlyBytes = await io.writeBinary(plain);

    await doc.transform(draco());
    const finalBytes = await io.writeBinary(doc);
    const final = stats(await io.readBinary(finalBytes));

    console.log(
      `${path}: ${original.byteLength} B → optimized ${optimizedBytes.byteLength} B → +draco ${finalBytes.byteLength} B ` +
        `(draco alone ${dracoOnlyBytes.byteLength} B); tris ${before.triangles}, verts ${before.vertices}→${optimized.vertices}, ` +
        `nodes ${before.nodeNames.length}, anims ${before.animations.length}, skins ${before.skins.length}, morphs ${before.morphTargets}`,
    );
    for (const s of [optimized, final]) {
      assert.equal(s.triangles, before.triangles);
      assert.deepEqual(s.nodeNames, before.nodeNames);
      assert.deepEqual(s.animations, before.animations);
      assert.deepEqual(s.skins, before.skins);
      assert.equal(s.morphTargets, before.morphTargets);
    }
    assert.ok(finalBytes.byteLength <= dracoOnlyBytes.byteLength * 1.02, "optimize does not make the Draco output bigger");
  });
}
