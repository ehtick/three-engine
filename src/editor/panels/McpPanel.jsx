import { useEffect } from "react";
import { Check, Plug, RefreshCw, TerminalSquare, X } from "lucide-react";
import { useMcpStore, retryMcpBridge } from "../api/mcpBridge.js";
import { useMcpPrefs, setMcpPrefs } from "../mcpPrefs.js";
import {
  useMcpClientStore,
  refreshMcpClients,
  connectMcpClient,
  disconnectMcpClient,
  MCP_SERVER_NAME,
} from "../mcpClients.js";
import { ClaudeIcon, CodexIcon } from "../icons/BrandIcons.jsx";
import { openPanel } from "../EditorShell.jsx";

/**
 * Assistant access, as its own panel.
 *
 * This used to be a section in Project Settings, and it was bad in three
 * specific ways the redesign is aimed at:
 *
 *   1. Nobody could find it. Three levels down in a settings panel is the wrong
 *      home for a live connection you want to glance at. It now has a menu
 *      entry, a permanent menu-bar chip, and a panel of its own.
 *   2. It explained itself in three paragraphs of prose. Prose is what you
 *      write when the controls don't say what they do. The state is now a
 *      coloured dot and four words; the explanations moved into tooltips, where
 *      they cost nothing until asked for.
 *   3. Each client was a wide button labelled with a sentence. They are now
 *      rows — mark, name, what it resolved to, and one action — so two clients
 *      take less room than one button did, and "is it connected?" is answerable
 *      without reading.
 */

const CLIENTS = {
  claude: { label: "Claude Code", Icon: ClaudeIcon, hint: "claude mcp add" },
  codex: { label: "Codex", Icon: CodexIcon, hint: "codex mcp add" },
};

/** Human summary of the bridge state, and the colour that goes with it. */
function describe(status) {
  if (status === "connected") return { tone: "ok", label: "Connected" };
  if (status === "disabled") return { tone: "off", label: "Off" };
  return { tone: "wait", label: "Waiting for a client" };
}

function ClientRow({ client }) {
  const busy = useMcpClientStore((s) => s.busy) === client.client;
  const meta = CLIENTS[client.client] ?? { label: client.client, Icon: Plug };
  const { Icon } = meta;

  const action = !client.installed ? null : client.registered ? "disconnect" : "connect";

  return (
    <div className={`mcp-client ${client.registered ? "linked" : ""}`}>
      <span className="mcp-client-mark">
        <Icon size={15} />
      </span>
      <span className="mcp-client-text">
        <span className="mcp-client-name">{meta.label}</span>
        <span className="mcp-client-sub" title={client.path ?? undefined}>
          {!client.installed
            ? "Not installed"
            : client.registered
              ? `Registered as ${MCP_SERVER_NAME}`
              : (client.path ?? meta.hint)}
        </span>
      </span>
      {action === null ? (
        <span className="mcp-client-badge muted">—</span>
      ) : (
        <button
          className={`mcp-client-action ${action}`}
          disabled={busy}
          title={
            action === "connect"
              ? `Register the ${MCP_SERVER_NAME} server with ${meta.label}, user-wide.\nRestart any running ${meta.label} session afterwards.`
              : `Remove ${MCP_SERVER_NAME} from ${meta.label}.`
          }
          onClick={() =>
            action === "connect" ? connectMcpClient(client.client) : disconnectMcpClient(client.client)
          }
        >
          {busy ? "…" : action === "connect" ? "Connect" : <Check size={13} />}
        </button>
      )}
    </div>
  );
}

export function McpPanel() {
  const status = useMcpStore((s) => s.status);
  const toolCount = useMcpStore((s) => s.toolCount);
  const callCount = useMcpStore((s) => s.callCount);
  const enabled = useMcpPrefs((s) => s.enabled);
  const port = useMcpPrefs((s) => s.port);
  const clients = useMcpClientStore((s) => s.clients);
  const message = useMcpClientStore((s) => s.message);

  useEffect(() => {
    refreshMcpClients();
  }, []);

  const state = describe(status);

  return (
    <div className="inspector-panel mcp-panel">
      <div className={`mcp-hero ${state.tone}`}>
        <span className="mcp-hero-dot" />
        <span className="mcp-hero-text">
          <span className="mcp-hero-title">{state.label}</span>
          <span className="mcp-hero-sub">
            {status === "connected"
              ? `${toolCount} tools · ${callCount} call${callCount === 1 ? "" : "s"} served`
              : enabled
                ? `Listening on port ${port}`
                : "Assistants cannot reach this editor"}
          </span>
        </span>
        <label className="mcp-switch" title="Enable the bridge. Saved for the editor, not per project.">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setMcpPrefs({ enabled: e.target.checked })}
          />
          <span className="mcp-switch-track" />
        </label>
      </div>

      <div className="mcp-section-label">Clients</div>
      {clients === null ? (
        <div className="mcp-empty">Looking for installed CLIs…</div>
      ) : clients.length === 0 ? (
        <div className="mcp-empty">
          Only available in the desktop app. Register by hand with
          <code>claude mcp add {MCP_SERVER_NAME} -- node &lt;repo&gt;/mcp/server.mjs</code>
        </div>
      ) : (
        clients.map((client) => <ClientRow key={client.client} client={client} />)
      )}
      {message && <div className="mcp-message">{message}</div>}

      <div className="mcp-section-label">Session</div>
      <div className="mcp-actions">
        <button
          className="mcp-action"
          title="Open a terminal inside the editor and run Claude Code or Codex there"
          onClick={() => openPanel("terminal")}
        >
          <TerminalSquare size={13} />
          Open terminal
        </button>
        <button
          className="mcp-action"
          disabled={!enabled || status === "connected"}
          title="Reconnect to a server on this port now, instead of waiting for the next retry"
          onClick={() => retryMcpBridge()}
        >
          <RefreshCw size={13} />
          Retry
        </button>
        <button className="mcp-action" title="Re-check which CLIs are installed" onClick={() => refreshMcpClients()}>
          <Plug size={13} />
          Rescan
        </button>
      </div>

      <div className="mcp-port-row">
        <span>Port</span>
        <input
          className="number-field"
          type="number"
          min={1024}
          max={65535}
          value={port}
          title="Must match the server's ENGINE_MCP_PORT. Change it only if 17325 is taken."
          onChange={(e) => {
            const next = parseInt(e.target.value, 10);
            if (Number.isInteger(next)) setMcpPrefs({ port: next });
          }}
        />
        {status !== "connected" && enabled && (
          <span className="mcp-port-note">
            <X size={11} /> nothing listening
          </span>
        )}
      </div>
    </div>
  );
}
