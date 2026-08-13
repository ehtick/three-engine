// @ts-check

/**
 * Per-draw-call attribution — WHICH object, WHICH material, WHICH pass.
 *
 * The stats overlay reports one number: "93 draw calls". That is enough to know
 * a frame submits too much and useless for knowing what to do about it, because
 * the number is a sum over passes that have completely different fixes. Halving
 * the main opaque pass and halving the shadow pass are different pieces of work,
 * and a scene whose count is dominated by a depth prepass is not a scene with a
 * material problem at all.
 *
 * So this samples the truth rather than modelling it. `WebGPURenderer.renderObject`
 * is the single funnel every draw goes through — main pass, every shadow cascade,
 * an impostor bake, the occluder depth pass, a post-render gizmo pass — and it is
 * handed the object, the scene, the camera, the geometry and the material it is
 * about to submit. Wrapping it for one frame yields an exact ledger. Nothing is
 * inferred from the scene graph, so a draw the graph does not explain (an engine
 * proxy, a nested render, a pass some module installed) shows up anyway, which is
 * the entire point of measuring instead of reasoning.
 *
 * ## Frame boundaries
 *
 * Capture opens from an `onUpdate` callback and closes from `onPostRender`, so
 * the window covers everything the tick submits: occlusion depth, impostor bakes,
 * pre-render passes (GI), the main draw, and the post-render overlays. Note the
 * last of those are NOT in `renderer.info.render.drawCalls` — the engine snapshots
 * that counter immediately after the main render, before the post passes run — so
 * this audit's total is legitimately HIGHER than the overlay's number. Both are
 * reported, and the difference is itself a finding.
 *
 * ## Pass identity
 *
 * A pass is (render target, camera). The target separates the shadow atlas from
 * the canvas; the camera separates shadow cascades and cubemap faces from each
 * other. `scene.overrideMaterial` is captured too, because that is what says
 * "this is a depth-only pass" — a shadow draw of a lit material still reports the
 * lit material here, and reading the count without that flag makes it look like
 * the scene draws its materials twice for no reason.
 */

/**
 * How many DRAW CALLS one `renderObject` submission actually costs.
 *
 * Almost always one — but not for a `BatchedMesh`. three's WebGPU backend has no
 * multi-draw: it loops `drawIndexed` once per sub-geometry and ticks
 * `info.update` each time. So a BatchedMesh is one submission and N draw calls,
 * and counting it as one would make a batching change that moves nothing look
 * like a large win. (That asymmetry is also the reason BatchedMesh is not a way
 * to lower this number: it saves bind-group and pipeline churn, not draws.)
 */
function drawCost(object) {
  if (object?.isBatchedMesh) return object._multiDrawCount ?? 1;
  return 1;
}

/**
 * Triangles one submission puts through the pipeline: the geometry's own count,
 * times the instance count for an InstancedMesh (a batch proxy is ONE draw and
 * many triangles, and conflating those is how instancing looks like a regression).
 */
function triangleCount(geometry, object, group) {
  if (!geometry) return 0;
  let indices;
  if (group && group.count !== Infinity) indices = group.count;
  else if (geometry.index) indices = geometry.index.count;
  else indices = geometry.attributes?.position?.count ?? 0;
  const instances = object?.isInstancedMesh ? object.count : 1;
  return Math.floor(indices / 3) * Math.max(1, instances);
}

/** Short stable label for a render target (the canvas is `null`). */
function targetLabel(target) {
  if (!target) return "canvas";
  const size = `${target.width}x${target.height}`;
  const name = target.texture?.name || target.name || "";
  return `${name || "rt"}:${size}#${target.id ?? ""}`;
}

/**
 * What has to AGREE for two submissions to be merge candidates, ignoring the
 * geometry and the material themselves. Two draws with the same flag key and
 * different materials are a material problem (solvable by merging materials);
 * two draws with different flag keys are a pipeline-state problem (not solvable
 * that way at all), and the split analysis exists to keep those apart.
 */
function flagKey(object, material) {
  return [
    material?.type ?? "?",
    material?.transparent ? "transparent" : "opaque",
    `side${material?.side ?? 0}`,
    material?.alphaTest ? `alphaTest${material.alphaTest}` : "noAlphaTest",
    `blend${material?.blending ?? 1}`,
    material?.depthWrite === false ? "noDepthWrite" : "depthWrite",
    `layers${object?.layers?.mask ?? 1}`,
    `order${object?.renderOrder ?? 0}`,
    object?.castShadow ? "casts" : "noCast",
    object?.receiveShadow ? "receives" : "noReceive",
  ].join("|");
}

/**
 * Records every draw call for `frames` frames.
 *
 * @param {any} engine
 * @param {{frames?: number, timeoutMs?: number}} [options]
 * @returns {Promise<any>} the aggregated ledger (see `#summarise`)
 */
export async function auditDrawCalls(engine, { frames = 1, timeoutMs = 4000 } = {}) {
  const renderer = engine?.renderer;
  if (!renderer) throw new Error("No renderer.");
  if (typeof renderer.renderObject !== "function") {
    throw new Error("This renderer has no renderObject hook — the audit cannot see individual draws.");
  }

  const wanted = Math.max(1, Math.min(10, Math.round(frames)));
  /** @type {any[][]} */
  const capturedFrames = [];
  /** @type {any[] | null} */
  let current = null;
  let capturing = false;

  const original = renderer.renderObject;
  renderer.renderObject = function patchedRenderObject(object, scene, camera, geometry, material, group, ...rest) {
    if (capturing && current) {
      current.push({
        target: targetLabel(renderer.getRenderTarget?.() ?? null),
        cameraId: camera?.uuid ?? "?",
        cameraType: camera?.type ?? "?",
        cameraName: camera?.name ?? "",
        override: scene?.overrideMaterial?.type ?? null,
        objectName: object?.name ?? "",
        objectType: object?.type ?? "?",
        entityId: object?.userData?.entityId ?? null,
        batchProxy: !!object?.userData?.batchProxy,
        instances: object?.isInstancedMesh ? object.count : 1,
        draws: drawCost(object),
        materialId: material?.uuid ?? "?",
        materialName: material?.name ?? "",
        materialType: material?.type ?? "?",
        geometryId: geometry?.uuid ?? "?",
        triangles: triangleCount(geometry, object, group),
        flags: flagKey(object, material),
        multiMaterialGroup: group ? (group.materialIndex ?? 0) : null,
      });
    }
    return original.call(this, object, scene, camera, geometry, material, group, ...rest);
  };

  // The engine snapshots renderer.info right after the main render; read the
  // same field the overlay does so the audit can be reconciled against it.
  /** @type {number[]} */
  const overlayCounts = [];

  const stopUpdate = engine.onUpdate(() => {
    if (capturedFrames.length >= wanted) return;
    current = [];
    capturing = true;
  });
  const stopPost = engine.onPostRender(() => {
    if (!capturing || !current) return;
    capturing = false;
    capturedFrames.push(current);
    overlayCounts.push(engine.stats?.readout?.drawCalls ?? 0);
    current = null;
  });

  try {
    const deadline = Date.now() + Math.max(250, Math.min(20_000, timeoutMs));
    while (capturedFrames.length < wanted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  } finally {
    stopUpdate();
    stopPost();
    capturing = false;
    renderer.renderObject = original;
  }

  if (!capturedFrames.length) {
    throw new Error(
      "No frame was rendered during the capture window. The editor suspends an unfocused " +
        "viewport and a GI compile wave suspends rendering outright — focus the viewport and retry.",
    );
  }
  return summarise(engine, capturedFrames, overlayCounts);
}

/**
 * Collapses the raw ledger. The LAST captured frame is reported rather than a
 * mean: draw counts are integers that a bake or a one-off pass perturbs, and an
 * average of 82 and 140 is a frame that never happened.
 */
function summarise(engine, capturedFrames, overlayCounts) {
  const records = capturedFrames[capturedFrames.length - 1];
  const sumDraws = (frame) => frame.reduce((n, r) => n + r.draws, 0);
  const perFrameTotals = capturedFrames.map(sumDraws);

  const entityName = (id) => (id ? engine.entities?.get(id)?.name ?? id : null);

  /** @type {Map<string, any>} */
  const passes = new Map();
  for (const record of records) {
    const key = `${record.target}|${record.cameraId}|${record.override ?? ""}`;
    let pass = passes.get(key);
    if (!pass) {
      pass = {
        target: record.target,
        camera: record.cameraName || record.cameraType,
        depthOnly: record.override,
        draws: 0,
        triangles: 0,
        materials: new Map(),
        geometries: new Set(),
        flagKeys: new Map(),
      };
      passes.set(key, pass);
    }
    pass.draws += record.draws;
    pass.triangles += record.triangles;
    pass.geometries.add(record.geometryId);
    const label =
      record.materialName ||
      `${record.materialType}#${String(record.materialId).slice(0, 6)}`;
    let material = pass.materials.get(record.materialId);
    if (!material) {
      material = { material: label, type: record.materialType, draws: 0, triangles: 0, objects: [] };
      pass.materials.set(record.materialId, material);
    }
    material.draws += record.draws;
    material.triangles += record.triangles;
    if (material.objects.length < 8) {
      material.objects.push(
        record.batchProxy
          ? `${record.objectName} [batch proxy x${record.instances}]`
          : entityName(record.entityId) || record.objectName || record.objectType,
      );
    }
    const flagBucket = pass.flagKeys.get(record.flags) ?? { draws: 0, materials: new Set() };
    flagBucket.draws += record.draws;
    flagBucket.materials.add(record.materialId);
    pass.flagKeys.set(record.flags, flagBucket);
  }

  const passList = [...passes.values()]
    .sort((a, b) => b.draws - a.draws)
    .map((pass) => ({
      pass: pass.depthOnly ? `${pass.target} (depth-only via ${pass.depthOnly})` : pass.target,
      camera: pass.camera,
      draws: pass.draws,
      triangles: pass.triangles,
      distinctMaterials: pass.materials.size,
      distinctGeometries: pass.geometries.size,
      // The floor this pass could reach if every draw sharing a pipeline state
      // were merged into one: one draw per flag key. Not a promise — it ignores
      // whether the materials can actually be unified — but it bounds the prize.
      floorIfMerged: pass.flagKeys.size,
      byMaterial: [...pass.materials.values()]
        .sort((a, b) => b.draws - a.draws)
        .slice(0, 40)
        .map((m) => ({
          material: m.material,
          draws: m.draws,
          triangles: m.triangles,
          objects: m.objects,
        })),
      splits: [...pass.flagKeys.entries()]
        .sort((a, b) => b[1].draws - a[1].draws)
        .map(([flags, bucket]) => ({
          state: flags,
          draws: bucket.draws,
          distinctMaterials: bucket.materials.size,
        })),
    }));

  const total = sumDraws(records);
  const overlay = overlayCounts[overlayCounts.length - 1] ?? 0;
  return {
    framesCaptured: capturedFrames.length,
    drawsPerFrame: perFrameTotals,
    totalDraws: total,
    submissions: records.length,
    totalTriangles: records.reduce((n, r) => n + r.triangles, 0),
    overlayDrawCalls: overlay,
    // Post-render passes (selection outline, gizmos, debug draw) submit after
    // the engine snapshots renderer.info, so they are invisible to the overlay.
    unreportedByOverlay: total - overlay,
    passes: passList,
    merging: mergingReport(engine),
    playing: !!engine.playing,
  };
}

/**
 * What static merging actually did, per group.
 *
 * The totals alone cannot answer the only question that matters about a merged
 * group — whether it was worth building. A group that removes nineteen draws for
 * 64 MB and one that removes two for 85 MB look identical in a draw-call count
 * and are completely different decisions, so both halves of the ratio are
 * reported per group, alongside what was refused and why.
 */
function mergingReport(engine) {
  const system = engine.merging;
  if (!system?.enabled) return { enabled: false };
  let bytes = 0;
  const groups = system.groups.map((group) => {
    bytes += group.textureBytes ?? 0;
    return {
      proxy: group.mesh.name,
      meshes: group.members.length,
      materials: group.materials.length,
      drawsSaved: group.members.length - 1,
      textureMB: +((group.textureBytes ?? 0) / 1048576).toFixed(1),
      // The whole justification, in one number.
      mbPerDrawSaved: +(
        (group.textureBytes ?? 0) /
        1048576 /
        Math.max(1, group.members.length - 1)
      ).toFixed(1),
    };
  });
  return {
    enabled: true,
    groups,
    // Per pass — the same merge removes these draws from the colour pass, the
    // depth prepass and every shadow cascade alike, which is where the leverage
    // actually comes from.
    drawsSavedPerPass: system.savedDrawCalls,
    addedTextureMB: +(bytes / 1048576).toFixed(1),
    unstableEntities: system._unstable?.size ?? 0,
  };
}
