import type { Entity } from "engine";

declare module "engine" {
  interface EngineEventMap {
    /** A sensor collider started/stopped overlapping another collider. */
    trigger: [event: { a: Entity; b: Entity; started: boolean }];
    /** A solid collider started/stopped touching another collider. */
    collision: [event: { a: Entity; b: Entity; started: boolean }];
  }
}
