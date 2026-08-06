/**
 * Fired on `window` by the Modules panel whenever a per-module API key/token
 * is connected or disconnected there (see ModulesPanel.jsx's
 * ModuleCredential). Browse/import panels — Sketchfab, itch.io — read the
 * token once at mount and listen for this to drop stale "not connected"
 * state without needing a shared store: dockview keeps inactive tabs mounted
 * rather than remounting them on reactivation, so a panel opened before the
 * key was connected would otherwise stay wrong until reopened.
 *
 * Kept in its own file (no React) so panels that only need the event name
 * don't statically pull in ModulesPanel.jsx's full component tree — that
 * panel is lazy-loaded on purpose.
 */
export const CREDENTIAL_CHANGED_EVENT = "engine:credential-changed";
