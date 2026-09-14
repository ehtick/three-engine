import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";

/**
 * DEV probe (temporary): ground truth for the indirect-lighting path.
 * Everything here is read-only — no light, material or scene field is written.
 */
defineOp({
  name: "probe.lighting",
  readOnly: true,
  description:
    "DEV: dump the live indirect-lighting state — ambient light parentage/intensity, scene.environment/environmentNode/background, every light in the scene, and a per-mesh material lighting summary for the named entities (or a few terrain/foliage ones).",
  params: {
    ids: { type: "array", description: "Entity ids to inspect. Omit to auto-pick terrain/foliage/architecture meshes." },
    arm: { type: "boolean", description: "Arm a one-shot render-object capture; call again (without arm) to read it." },
  },
  run({ ids, arm }) {
    if (arm) {
      const r = engine.renderer;
      if (!r || typeof r.setRenderObjectFunction !== "function") throw new Error("No WebGPU renderer render-object hook.");
      globalThis.__probeLightingCapture = null;
      const prev = r.getRenderObjectFunction?.() ?? null;
      r.setRenderObjectFunction(function probeHook(object, sceneArg, camera, geometry, material, group, lightsNode, clippingContext) {
        r.setRenderObjectFunction(prev);
        try {
          if (material?.lights === true && !(globalThis.__probeLightingCaptures?.length >= 3)) {
            globalThis.__probeLightingCaptures ??= [];
            const cap = { objectName: object?.name ?? null, materialName: material?.name || material?.type };
            try {
              const g = object?.geometry;
              const col = g?.attributes?.color;
              cap.geometry = {
                positionCount: g?.attributes?.position?.count,
                hasColor: !!col,
                colorCount: col?.count,
                colorItemSize: col?.itemSize,
                colorFirst: col ? Array.from(col.array.slice(0, 9), (v) => +Number(v).toFixed(3)) : null,
              };
              cap.metalness = material.metalness;
              globalThis.__probeLightingCaptures.push(cap);
            } catch (err) {
              cap.error = String(err?.message ?? err);
            }
          }
          if (material?.lights === true && !globalThis.__probeLightingCapture) {
            const lights = (lightsNode?._lights ?? []).map((l) => ({ type: l.type, intensity: l.intensity }));
            let roLights = null;
            let buffers = null;
            try {
              const ro = r._objects.get(object, material, sceneArg, camera, lightsNode, r._currentRenderContext, clippingContext, null);
              const un = ro?.getNodeBuilderState?.().updateNodes ?? [];
              roLights = [];
              for (const n of un) {
                if (!n?.isAnalyticLightNode) continue;
                roLights.push({
                  lightType: n.light?.type ?? null,
                  lightIntensity: n.light?.intensity,
                  nodeColor: n.color ? `#${n.color.getHexString()}` : null,
                  colorNodeValue: n.colorNode?.value?.isColor === true ? `#${n.colorNode.value.getHexString()}` : n.colorNode?.value?.constructor?.name ?? null,
                });
              }
              // The CPU-side uniform data this draw binds, entry by entry.
              const dump = (arr, out, path, depth) => {
                if (!arr || depth > 3 || out.length > 40) return;
                if (ArrayBuffer.isView(arr)) {
                  out.push({ path, floats: Array.from(arr.slice ? arr.slice(0, 44) : [], (v) => +Number(v).toFixed(4)) });
                  return;
                }
                for (const [k, v] of Object.entries(arr)) {
                  if (v && (ArrayBuffer.isView(v) || typeof v === "object")) {
                    dump(v, out, path ? `${path}.${k}` : k, depth + 1);
                  }
                }
              };
              const bindings = ro.getBindings();
              const entries = bindings?.bindings ?? bindings;
              buffers = [];
              if (Array.isArray(entries)) {
                for (const e of entries) {
                  const b = { name: e?.name ?? e?.nodeUniform?.name ?? null, kind: e?.constructor?.name };
                  const floats = [];
                  dump(e, floats, b.name ?? "b", 0);
                  b.floats = floats.slice(0, 8);
                  buffers.push(b);
                }
              }
              globalThis.__probeLightingScene = sceneArg;
              globalThis.__probeLightingObject = object?.name ?? null;
              globalThis.__probeLightingRO = ro;
            } catch (err) {
              roLights = [`ERR:${err?.message}`];
            }
            globalThis.__probeLightingCapture = {
              objectName: object?.name ?? null,
              materialName: material?.name || material?.type,
              materialScalars: {
                metalness: material.metalness,
                roughness: material.roughness,
                metalnessNode: !!material.metalnessNode,
                roughnessNode: !!material.roughnessNode,
                color: material.color ? `#${material.color.getHexString()}` : null,
                vertexColors: !!material.vertexColors,
              },
              sceneArgUuid: sceneArg?.uuid ?? null,
              sceneArgIsEngineScene: sceneArg === engine.scene,
              envSameAsEngineScene: sceneArg?.environment === engine.scene?.environment,
              envOnRenderedScene: sceneArg?.environment ? { uuid: sceneArg.environment.uuid, type: sceneArg.environment.type } : null,
              envIntensityOnRenderedScene: sceneArg?.environmentIntensity ?? null,
              lightsNodeLights: lights,
              renderObjectLights: roLights,
              boundBuffers: buffers,
            };
          }
        } catch (err) {
          globalThis.__probeLightingCapture = { error: String(err?.message ?? err) };
        }
        return r.renderObject(object, sceneArg, camera, geometry, material, group, lightsNode, clippingContext);
      });
      return { armed: true };
    }
    const scene = engine.scene;
    if (!scene) throw new Error("No scene.");

    const ambient = engine.ambientLight;
    const safe = (fn) => { try { return fn(); } catch (err) { return `ERR:${err?.message}`; } };

    const lights = [];
    scene.traverse((o) => {
      if (o.isLight) {
        lights.push({
          name: o.name,
          type: o.type,
          kind: o.userData?.engineOwned ? "engine-owned" : "authored",
          intensity: o.intensity,
          parent: o.parent?.type ?? "ORPHANED",
          visible: o.visible,
          castShadow: !!o.castShadow,
        });
      }
    });

    const picked = [];
    const want = new Set(ids ?? []);
    scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const match = want.size ? want.has(o.userData?.entityId) || want.has(o.userData?.id)
        : /terrain|ground|rock|cliff|foliage|impostor|instanc/i.test(o.name || "") || /Standard|Physical|Phong|Lambert/i.test(o.material?.type || "");
      if (!match || picked.length >= 14) return;
      const m = o.material;
      picked.push({
        name: o.name || "(unnamed)",
        entityTag: o.userData?.entityId ?? null,
        visible: o.visible,
        receiveShadow: !!o.receiveShadow,
        hasVertexColor: !!o.geometry?.attributes?.color,
        materialType: m.type,
        ctor: m.constructor?.name,
        vertexColors: !!m.vertexColors,
        color: m.color ? `#${m.color.getHexString()}` : null,
        envMapIntensity: m.envMapIntensity,
        lightsNode: !!m.lightsNode,
        colorNode: !!m.colorNode,
        metalness: typeof m.metalness === "number" ? m.metalness : null,
        metalnessNode: !!m.metalnessNode,
        roughness: typeof m.roughness === "number" ? m.roughness : null,
        roughnessNode: !!m.roughnessNode,
        emissive: m.emissive ? `#${m.emissive.getHexString()}` : null,
        emissiveIntensity: m.emissiveIntensity,
        transparent: !!m.transparent,
      });
    });

    // Live renderer lighting state + the actual uniform bytes a terrain draw binds.
    const live = safe(() => {
      const r = engine.renderer;
      const out = { lightingEnabled: r?.lighting?.enabled };
      const ln = r?.lighting?.getNode?.(scene);
      out.lightsNodeLights = ln?.getLights?.().map((l) => ({ type: l.type, intensity: l.intensity, name: l.name })) ?? null;

      // Raw sceneData: what three's Nodes actually recorded for this scene.
      try {
        const sd = r.nodes?.get?.(scene);
        const envTex = scene.environment;
        out.sceneData = sd
          ? {
              keys: Object.keys(sd),
              environmentMatches: sd.environment === envTex,
              environmentNodeKind: sd.environmentNode?.constructor?.name ?? null,
              backgroundKind: sd.backgroundNode ? sd.backgroundNode.constructor?.name : null,
            }
          : "no sceneData";
        out.envTextureFlags = envTex
          ? {
              isTexture: envTex.isTexture === true,
              isDataTexture: envTex.isDataTexture === true,
              isCubeTexture: envTex.isCubeTexture === true,
              mapping: envTex.mapping,
              colorSpace: envTex.colorSpace,
              type: envTex.type,
              version: envTex.version,
              constructor: envTex.constructor?.name,
            }
          : null;
        out.environmentNode = (() => {
          const a = r.nodes?.getEnvironmentNode?.(scene);
          const b = r.nodes?.getEnvironmentNode?.(scene);
          return { first: a?.constructor?.name ?? String(a), second: b?.constructor?.name ?? String(b) };
        })();
      } catch (err) {
        out.sceneDataError = err?.message;
      }

      // Light NODES of actual render objects, with the uniform values they
      // currently carry. A light whose update() never ran holds INITIAL black.
      try {
        const lists = r._renderLists;
        const rl = lists?.get?.(scene, engine.camera);
        const items = [...(rl?.opaque ?? [])];
        out.renderItemCount = items.length;
        const rows = [];
        const push = (it, why) => {
          const state = typeof it.getNodeBuilderState === "function" ? it.getNodeBuilderState() : it._nodeBuilderState;
          const un = state?.updateNodes;
          const lights = [];
          for (const n of un ?? []) {
            if (!n?.isAnalyticLightNode) continue;
            lights.push({
              lightType: n.light?.type ?? null,
              lightIntensity: n.light?.intensity,
              nodeColor: n.color ? `#${n.color.getHexString()}` : null,
              colorNodeValue: n.colorNode?.value?.isColor === true ? `#${n.colorNode.value.getHexString()}` : n.colorNode?.value?.constructor?.name ?? null,
            });
          }
          rows.push({
            why,
            tag: `${it.object?.name || ""}|${it.material?.name || it.material?.type || ""}`,
            hadState: !!state,
            updateNodeCount: un?.length ?? null,
            lights,
          });
        };
        let litSeen = 0, stoneSeen = 0;
        for (const it of items) {
          const matName = it.material?.name || it.material?.type || "";
          const objName = it.object?.name || "";
          const lit = it.material?.lights === true || /standard|physical/i.test(matName);
          if (lit && litSeen < 2) { push(it, "first-lit"); litSeen++; continue; }
          if (/stone/i.test(objName + matName) && stoneSeen < 2) { push(it, "stone"); stoneSeen++; }
          if (litSeen >= 2 && stoneSeen >= 2) break;
        }
        out.renderObjectLights = rows;
      } catch (err) {
        out.renderObjectLightsError = err?.message;
      }
      return out;
    });

    return {
      ambient: safe(() => ambient && {
        intensity: ambient.intensity,
        color: `#${ambient.color.getHexString()}`,
        parentType: ambient.parent?.type ?? "ORPHANED (not in a scene!)",
        visible: ambient.visible,
      }),
      scene: safe(() => ({
        id: scene.uuid,
        environment: scene.environment ? { uuid: scene.environment.uuid, type: scene.environment.type, w: scene.environment.image?.width } : null,
        environmentIntensity: scene.environmentIntensity,
        environmentNode: scene.environmentNode ? scene.environmentNode.constructor?.name : null,
        background: scene.background?.isTexture ? "texture" : scene.background?.isColor ? `#${scene.background.getHexString()}` : String(scene.background),
        backgroundIntensity: scene.backgroundIntensity,
        backgroundNode: scene.backgroundNode ? scene.backgroundNode.constructor?.name : null,
        fog: scene.fog ? scene.fog.type ?? "fog" : null,
      })),
      renderer: safe(() => ({
        backend: engine.renderer?.backend?.isWebGPUBackend === true ? "webgpu" : "webgl",
        toneMapping: engine.renderer?.toneMapping,
        toneMappingExposure: engine.renderer?.toneMappingExposure,
        shadowMapEnabled: engine.renderer?.shadowMap?.enabled,
      })),
      live,
      capture: safe(() => {
        const c = globalThis.__probeLightingCapture;
        if (!c) return null;
        const s = globalThis.__probeLightingScene;
        const r = engine.renderer;
        const out = { ...c };
        if (s && r?._nodes) {
          const sd = r._nodes.get(s);
          out.renderedSceneData = {
            environmentMatches: sd.environment === s.environment,
            environmentNodeKind: sd.environmentNode?.constructor?.name ?? null,
          };
          const envNode = r._nodes.getEnvironmentNode(s);
          out.renderedSceneEnvNode = envNode?.constructor?.name ?? String(envNode);
        }
        return out;
      }),
      lights,
      picked,
    };
  },
});
