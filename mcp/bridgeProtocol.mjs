/**
 * Shared constants for the editor bridge.
 *
 * Three processes speak this protocol — the broker, the per-session MCP server,
 * and the editor page (`src/editor/api/mcpBridge.js`) — and they are not
 * upgraded together: the editor can stay open across a dozen assistant sessions,
 * and a broker daemon outlives all of them. So the version below is not
 * decoration. It is what lets a freshly-started session notice that the daemon
 * squatting on the port is running last week's code and retire it, instead of
 * failing in some subtler way further down.
 */

/** Default bridge port. Overridable with `ENGINE_MCP_PORT`; the editor's
 *  Project Settings → MCP must agree. */
export const DEFAULT_PORT = 17325;

/**
 * Broker/session protocol version. BUMP THIS whenever the session<->broker
 * message shapes below change in a way an older peer would mishandle.
 *
 * The editor's half is deliberately NOT versioned here: it predates the broker
 * and still speaks exactly what it always did (`hello`, then `{id, ok, result}`
 * replies to `{id, method, params}` requests). Keeping the editor out of the
 * versioned surface is what makes this change zero-risk for a running editor.
 */
export const BRIDGE_PROTOCOL = 1;

/**
 * How long a broker with nothing attached — no editor, no sessions — waits
 * before exiting.
 *
 * It has to be long enough to cover the gap between "the session that spawned me
 * started" and "that session actually connected", and long enough that closing
 * one editor to reopen it does not tear down the daemon underneath. It also has
 * to be finite: the whole reason this rewrite exists is that a process squatting
 * on this port forever is a real failure mode, and a daemon is only an
 * improvement over an orphan if it eventually cleans itself up.
 */
export const IDLE_EXIT_MS = Number(process.env.ENGINE_MCP_IDLE_MS ?? 120_000);

/** Resolved bridge port for this process. */
export const bridgePort = () => Number(process.env.ENGINE_MCP_PORT ?? DEFAULT_PORT);
