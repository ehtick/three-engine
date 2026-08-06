import { create } from "zustand";
import { vmSingleton } from "../singleton.js";

/**
 * Mirrors engine.playing / engine.paused for React; playMode.js is the source
 * of truth. `paused` is game time only — the render loop keeps running, which
 * is what makes a paused frame inspectable in the first place.
 */
export const usePlayStore = vmSingleton("playStore", () => create(() => ({ playing: false, paused: false })));
