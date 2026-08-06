import { create } from "zustand";
import { vmSingleton } from "../singleton.js";

export const useGeometryEditStore = vmSingleton("geometryEditStore", () => create((set) => ({
  entityId: null,
  enter(entityId) { set({ entityId }); },
  exit() { set({ entityId: null }); },
})));
