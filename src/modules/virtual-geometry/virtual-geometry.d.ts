import type { Object3D } from "engine";

declare module "engine" {
  interface EngineEventMap {
    /** Only present when the Virtual Geometry module is enabled. */
    "virtual-geometry-ready": [event: { mesh: Object3D; path: string; dag: unknown }];
    "virtual-geometry-changed": [event: { path: string }];
  }
}
