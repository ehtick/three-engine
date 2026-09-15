import * as THREE from "three/webgpu";
import { property } from "three/src/nodes/core/PropertyNode.js";
import { float, If, uniform, vec3, vec4 } from "three/tsl";
import { positionWorld } from "three/src/nodes/accessors/Position.js";
import { cameraFar, cameraNear, cameraPosition, cameraViewMatrix } from "three/src/nodes/accessors/Camera.js";
import { Loop } from "three/src/nodes/utils/LoopNode.js";
import { linearDepth, viewZToPerspectiveDepth } from "three/src/nodes/display/ViewportDepthNode.js";
import { modelRadius } from "three/src/nodes/accessors/ModelNode.js";
import LightingModel from "three/src/nodes/core/LightingModel.js";
import { LTC_Evaluate_Volume } from "three/src/nodes/functions/BSDF/LTC.js";
import { runtimeQuality } from "./sceneSettings.js";

const scatteringDensity = property("vec3");
const linearDepthRay = property("vec3");
const outgoingRayLight = property("vec3");
const transmittance = property("vec3");

export class EngineVolumetricLightingModel extends LightingModel {
  constructor() {
    super();
  }

  start(builder) {
    const { material } = builder;

    const startPos = property("vec3");
    const endPos = property("vec3");
    const isFrontToBack = property("bool");

    If(
      cameraPosition.sub(positionWorld).length().greaterThan(modelRadius.mul(2)),
      () => {
        startPos.assign(cameraPosition);
        endPos.assign(positionWorld);
        isFrontToBack.assign(true);
      },
    ).Else(() => {
      startPos.assign(positionWorld);
      endPos.assign(cameraPosition);
      isFrontToBack.assign(false);
    });

    const viewVector = endPos.sub(startPos);
    // The per-material step count, scaled by the scene-wide volume quality
    // knob (Scene Settings → Performance). The raymarch loop is the entire
    // per-pixel cost of a volume, so this single multiplier is the global
    // "volume quality" dial. Floor of 1 keeps degenerate scales rendering.
    //
    // ⚠ A JS-TIME CONSTANT, NOT A UNIFORM. `Loop(node, …)` where `node` reads
    // a uniform buffer compiles a DYNAMIC loop — the driver can't see the
    // bound at compile time, so it can't unroll or size registers for it.
    // `Loop(number, …)` bakes the count into the WGSL as a literal, like any
    // other fixed-count loop. Baked here, at BUILD time (`start()` runs once
    // per material (re)compile); a later quality-dial change can't reach an
    // already-built program, so `volumeQualityWatch` below catches it and
    // requests exactly one rebuild.
    const bakedStepScale = runtimeQuality.volumeStepScale;
    material.__volumeStepScale = bakedStepScale;
    const steps = Math.max(1, Math.round(material.steps * bakedStepScale));
    // ⛔ `material.needsUpdate = true` ALONE DOES NOT REBUILD THIS PROGRAM.
    // Three's own cache-key walk (`RenderObject.getMaterialCacheKey`) reduces
    // every plain numeric material property to on/off, so `material.steps`
    // can never signal a change by itself — bumping `version` only makes
    // `RenderObjects.get()` re-check the cache key, and an unchanged key
    // takes the cheap "just bump the version" branch, never calling `start()`
    // again. Same trap and same fix `GISystem.js` uses for its roughness
    // bucket (`giRoughnessBucketOf`): fold the LIVE dial value into
    // `customProgramCacheKey()`, so a later change makes the key disagree
    // with the build's `initialCacheKey` — the actual condition three uses
    // to dispose and recompile. Installed once; reads the live global, not
    // the baked snapshot, so the disagreement is visible before the rebuild
    // it triggers ever runs.
    if (!material.__volumeCacheKeyPatched) {
      material.__volumeCacheKeyPatched = true;
      const original = material.customProgramCacheKey.bind(material);
      material.customProgramCacheKey = () => original() + "|vol" + runtimeQuality.volumeStepScale;
    }
    // The only per-frame check this needs — `start()` itself only runs at a
    // rebuild, so something has to notice the dial moved and ask three to
    // look again. Piggybacks on three's existing per-frame uniform-update
    // pass rather than adding a new one of our own; a uniform absent from
    // the compiled graph would never have its update callback invoked, so
    // its (always zero) value is folded into `distTravelled`'s already
    // harmless starting point below instead of sitting unused.
    const volumeQualityWatch = uniform(0).onRenderUpdate(({ material }) => {
      if (material.__volumeStepScale !== runtimeQuality.volumeStepScale) material.needsUpdate = true;
      return 0;
    });
    const stepSize = viewVector.length().div(steps).toVar();
    const rayDir = viewVector.normalize().toVar();

    const distTravelled = float(0.0).add(volumeQualityWatch).toVar();
    transmittance.assign(vec3(1));

    if (material.offsetNode) {
      distTravelled.addAssign(material.offsetNode.mul(stepSize));
    }

    Loop(steps, () => {
      const positionRay = startPos.add(rayDir.mul(distTravelled));
      const positionViewRay = cameraViewMatrix.mul(vec4(positionRay, 1)).xyz;

      if (material.depthNode !== null) {
        linearDepthRay.assign(linearDepth(viewZToPerspectiveDepth(positionViewRay.z, cameraNear, cameraFar)));
        builder.context.sceneDepthNode = linearDepth(material.depthNode).toVar();
      }

      builder.context.positionWorld = positionRay;
      builder.context.shadowPositionWorld = positionRay;
      builder.context.positionView = positionViewRay;

      scatteringDensity.assign(0);

      let scatteringNode;
      let scatteringEmissiveNode;

      if (material.scatteringNode) {
        scatteringNode = material.scatteringNode({ positionRay });
      }

      if (material.scatteringEmissiveNode) {
        scatteringEmissiveNode = material.scatteringEmissiveNode({ positionRay });
      }

      super.start(builder);

      if (scatteringNode) {
        scatteringDensity.mulAssign(scatteringNode);
      }

      const stepLight = scatteringDensity.mul(0.01).toVar();

      if (scatteringEmissiveNode) {
        stepLight.addAssign(scatteringEmissiveNode.mul(0.01));
      }

      const falloff = scatteringDensity.mul(0.01).negate().mul(stepSize).exp();

      If(isFrontToBack, () => {
        outgoingRayLight.addAssign(stepLight.mul(transmittance).mul(stepSize));
      }).Else(() => {
        outgoingRayLight.assign(outgoingRayLight.mul(falloff).add(stepLight.mul(stepSize)));
      });

      transmittance.mulAssign(falloff);
      distTravelled.addAssign(stepSize);
    });
  }

  scatteringLight(lightColor, builder) {
    const sceneDepthNode = builder.context.sceneDepthNode;

    if (sceneDepthNode) {
      If(sceneDepthNode.greaterThanEqual(linearDepthRay), () => {
        scatteringDensity.addAssign(lightColor);
      });
    } else {
      scatteringDensity.addAssign(lightColor);
    }
  }

  direct({ lightNode, lightColor }, builder) {
    if (lightNode.isAnalyticLightNode !== true || lightNode.light.distance === undefined) return;

    const directLight = lightColor.xyz.toVar();

    if (lightNode.shadowNode !== null) {
      directLight.mulAssign(lightNode.shadowNode);
    }

    this.scatteringLight(directLight, builder);
  }

  directRectArea({ lightColor, lightPosition, halfWidth, halfHeight }, builder) {
    const p0 = lightPosition.add(halfWidth).sub(halfHeight);
    const p1 = lightPosition.sub(halfWidth).sub(halfHeight);
    const p2 = lightPosition.sub(halfWidth).add(halfHeight);
    const p3 = lightPosition.add(halfWidth).add(halfHeight);

    const P = builder.context.positionView;

    const directLight = lightColor.xyz.mul(LTC_Evaluate_Volume({ P, p0, p1, p2, p3 })).pow(1.5);

    this.scatteringLight(directLight, builder);
  }

  finish(builder) {
    builder.context.outgoingLight.assign(outgoingRayLight);
  }
}

export default EngineVolumetricLightingModel;
