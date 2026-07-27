/**
 * MCP bridge settings — an EDITOR preference, not a project setting.
 *
 * This started life in `project.json` alongside snapping and autosave, and that
 * was wrong in a way that showed up immediately: the MCP server is registered
 * with the user's CLIs machine-wide, so "I want assistants to be able to drive
 * my editor" is a fact about the person, not about one project. Storing it
 * per-project meant every new or freshly-opened project came up disabled, and
 * the user had to find the toggle again — and, because project settings only
 * persist on an explicit Save, often lost it on the next restart too.
 *
 * So: localStorage, applied the moment it changes, no Save step. The failure
 * this replaces was "I enabled MCP and it's off again every time I restart".
 *
 * Best-effort persistence, matching `hierarchyPrefs.js` — localStorage can be
 * unavailable (private mode, quota) and the in-memory value still works for the
 * session.
 */
import { create } from "zustand";
import { vmSingleton } from "./singleton.js";

const STORAGE_KEY = "engine.mcp.v1";

export const MCP_DEFAULTS = Object.freeze({
  // Off on a first run: the bridge opens a loopback socket any local process
  // could sit on, and that should be a deliberate choice. Once made, it sticks.
  enabled: false,
  port: 17325,
});

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return { ...MCP_DEFAULTS };
    return {
      enabled: parsed.enabled === true,
      port: Number.isInteger(parsed.port) && parsed.port > 1023 && parsed.port < 65536
        ? parsed.port
        : MCP_DEFAULTS.port,
    };
  } catch {
    return { ...MCP_DEFAULTS };
  }
}

/** Live MCP preference. VM-wide so an HMR reload doesn't fork it — see singleton.js. */
export const useMcpPrefs = vmSingleton("mcpPrefs", () => create(() => load()));

/**
 * Writes a partial update, persists it, and applies it to the bridge.
 *
 * Applying here rather than at a call site is the point: there is exactly one
 * path that changes MCP state, so the toggle, the port field and boot cannot
 * disagree about what is running.
 */
export async function setMcpPrefs(patch) {
  const next = { ...useMcpPrefs.getState(), ...patch };
  useMcpPrefs.setState(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: it just won't survive a restart.
  }
  const { configureMcpBridge } = await import("./api/mcpBridge.js");
  configureMcpBridge(next);
  return next;
}

/** Applies the stored preference to the bridge. Called once at editor boot. */
export async function applyStoredMcpPrefs() {
  const prefs = useMcpPrefs.getState();
  const { configureMcpBridge } = await import("./api/mcpBridge.js");
  configureMcpBridge(prefs);
  return prefs;
}
