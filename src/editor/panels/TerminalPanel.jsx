import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { RotateCcw, Trash2, TerminalSquare } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { useProjectStore } from "../store/projectStore.js";
import { vmSingleton } from "../singleton.js";

/**
 * A real terminal inside the editor, so `claude` and `codex` can be driven
 * without alt-tabbing away from the scene they are editing.
 *
 * ## Why a terminal and not a chat box
 *
 * A chat UI over `claude -p` would be less code and much worse: it loses the
 * permission prompts, the streaming tool output, `/` commands, Ctrl-C, session
 * resume — everything that makes these CLIs usable. They are full-screen TUI
 * programs, so the honest way to host one is to give it a terminal. That means
 * a PTY on the Rust side (`src-tauri/src/pty.rs`) and a terminal emulator here;
 * xterm.js is the emulator, and it is the only thing in this file that
 * understands escape sequences.
 *
 * ## Session identity outlives the component
 *
 * The PTY is keyed by a stable id held in a module-level map, not by component
 * state. Dockview unmounts and remounts panels when they are dragged between
 * containers or hidden behind a tab, and a remount that started a second
 * `claude` would silently fork the conversation — two processes, two sessions,
 * one visible. On remount we check `pty_alive` and reattach to the running
 * session instead, replaying the scrollback we kept.
 *
 * Scrollback is kept here rather than asked for again because a PTY has no
 * history to re-request: whatever was not captured is gone. The cap is
 * generous but finite, since these CLIs emit a lot of redraws.
 */

const SCROLLBACK_LIMIT = 400_000; // characters of decoded output kept per session

/**
 * id -> { buffer, program } for every session started this app run.
 *
 * VM-wide rather than merely module-level: an HMR re-evaluation of this file
 * would otherwise hand the remounted panel an empty map, so it would decide no
 * session existed and start a second `claude` against the still-running first
 * one. Same class of bug as the duplicated command bus — see `singleton.js`.
 */
const sessions = vmSingleton("terminalSessions", () => new Map());

/** Panels are singletons per Dockview id, so one terminal id is enough. */
const SESSION_ID = "editor-terminal-main";

const PROGRAMS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "shell", label: "Shell" },
];

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

/** The OS shell, for the "Shell" option and as the fallback host for a CLI we
 *  could not resolve to an absolute path. */
function defaultShell() {
  if (navigator.userAgent.includes("Windows")) return { command: "powershell.exe", args: ["-NoLogo"] };
  return { command: process?.env?.SHELL || "/bin/bash", args: ["-l"] };
}

export function TerminalPanel() {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const [program, setProgram] = useState(() => sessions.get(SESSION_ID)?.program ?? "claude");
  const [status, setStatus] = useState("starting");
  const [available, setAvailable] = useState(null); // { claude: path|null, codex: path|null }
  const rootPath = useProjectStore((s) => s.rootPath);

  // Which CLIs exist, so the picker can gray out what isn't installed and we can
  // spawn by absolute path (the app's PATH is not the shell's — see
  // `resolve_cli` in mcp_clients.rs).
  useEffect(() => {
    let live = true;
    invoke("detect_terminal_programs")
      .then((pairs) => live && setAvailable(Object.fromEntries(pairs)))
      .catch(() => live && setAvailable({}));
    return () => (live = false);
  }, []);

  // Create the emulator once. `useLayoutEffect` so the host div has been laid
  // out before `fit()` measures it — fitting against a zero-height element
  // produces a 1-row terminal that never recovers.
  useLayoutEffect(() => {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, "Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: {
        background: "#101114",
        foreground: "#ececee",
        cursor: "#4aa3ff",
        selectionBackground: "rgba(74, 163, 255, 0.28)",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      // Panel not laid out yet; the ResizeObserver below fits again shortly.
    }

    const onData = term.onData((data) => {
      invoke("pty_write", { id: SESSION_ID, data }).catch(() => {});
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        invoke("pty_resize", { id: SESSION_ID, cols: term.cols, rows: term.rows }).catch(() => {});
      } catch {
        // Zero-sized while hidden behind another tab; nothing to do.
      }
    });
    observer.observe(hostRef.current);

    return () => {
      onData.dispose();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      // The PTY is deliberately NOT killed here: a remount must reattach to the
      // same claude session rather than start a new one.
    };
  }, []);

  // Stream PTY output into the emulator.
  useEffect(() => {
    let unlisten = null;
    let live = true;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const offData = await listen("pty://data", ({ payload }) => {
        if (payload.id !== SESSION_ID) return;
        const bytes = atob(payload.data);
        const record = sessions.get(SESSION_ID);
        if (record) {
          record.buffer += bytes;
          if (record.buffer.length > SCROLLBACK_LIMIT) {
            record.buffer = record.buffer.slice(-SCROLLBACK_LIMIT);
          }
        }
        // Raw bytes, not a decoded string: `atob` yields one char per byte, and
        // xterm's Uint8Array path runs its own UTF-8 decoder with state across
        // writes, which is what keeps box-drawing characters intact when a
        // sequence straddles two reads.
        const buf = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
        termRef.current?.write(buf);
      });
      const offExit = await listen("pty://exit", ({ payload }) => {
        if (payload.id !== SESSION_ID) return;
        if (live) setStatus("exited");
        termRef.current?.write("\r\n\x1b[2m[process exited — press Restart]\x1b[0m\r\n");
      });
      unlisten = () => {
        offData();
        offExit();
      };
    })();
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  /** Starts (or restarts) the session with `next`. */
  const start = async (next = program, { force = false } = {}) => {
    const term = termRef.current;
    if (!term) return;
    const record = sessions.get(SESSION_ID);

    // Reattach rather than respawn when the same program is already running —
    // this is the Dockview-remount path.
    if (!force && record?.program === next) {
      try {
        if (await invoke("pty_alive", { id: SESSION_ID })) {
          term.reset();
          if (record.buffer) {
            const buf = new Uint8Array(record.buffer.length);
            for (let i = 0; i < record.buffer.length; i++) buf[i] = record.buffer.charCodeAt(i);
            term.write(buf);
          }
          setStatus("running");
          return;
        }
      } catch {
        // Not in Tauri, or the backend is gone — fall through to spawn.
      }
    }

    const shell = defaultShell();
    let command = shell.command;
    let args = shell.args;
    if (next !== "shell") {
      const resolved = available?.[next];
      if (!resolved) {
        term.reset();
        term.write(
          `\x1b[33m${next} was not found on this machine.\x1b[0m\r\n` +
            `Install it, then press Restart. You can use the Shell option meanwhile.\r\n`,
        );
        setStatus("missing");
        return;
      }
      command = resolved;
      args = [];
    }

    sessions.set(SESSION_ID, { buffer: "", program: next });
    term.reset();
    setStatus("starting");
    try {
      await invoke("pty_spawn", {
        id: SESSION_ID,
        command,
        args,
        // Start in the open project so `claude` picks up that project's context
        // and its `.mcp.json`, rather than wherever the app was launched from.
        cwd: rootPath ?? null,
        cols: term.cols,
        rows: term.rows,
        env: null,
      });
      setStatus("running");
    } catch (err) {
      setStatus("error");
      term.write(`\x1b[31m${String(err)}\x1b[0m\r\n`);
    }
  };

  // Start once the CLI probe has answered, so the first spawn already knows
  // whether `claude` resolves.
  useEffect(() => {
    if (available === null) return;
    start(program);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  const pick = (next) => {
    setProgram(next);
    start(next, { force: true });
  };

  return (
    <div className="terminal-panel">
      <div className="panel-toolbar">
        <TerminalSquare size={13} />
        {PROGRAMS.map((entry) => {
          const missing = entry.id !== "shell" && available && !available[entry.id];
          return (
            <button
              key={entry.id}
              className={`toolbar-btn ${program === entry.id ? "active" : ""}`}
              disabled={missing}
              title={missing ? `${entry.label} is not installed` : `Run ${entry.label} here`}
              onClick={() => pick(entry.id)}
            >
              {entry.label}
            </button>
          );
        })}
        <div className="menu-spacer" />
        <span className={`terminal-status ${status}`}>{status}</span>
        <button className="toolbar-btn" title="Restart the session" onClick={() => start(program, { force: true })}>
          <RotateCcw size={12} />
        </button>
        <button
          className="toolbar-btn"
          title="Clear the screen (does not restart)"
          onClick={() => {
            termRef.current?.clear();
            const record = sessions.get(SESSION_ID);
            if (record) record.buffer = "";
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
