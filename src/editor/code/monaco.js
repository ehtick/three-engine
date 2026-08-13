// @ts-nocheck
/**
 * The editor's code editor: one Monaco instance configuration, shared by the
 * Code panel and the Inspector's inline editor.
 *
 * ## Why an embedded editor at all
 *
 * The point of this app is that a game can be made without leaving it. Sending
 * the user to VS Code to change one line of a script breaks that in the most
 * ordinary case there is, and "Open in IDE" is still here for when the user
 * genuinely wants their own setup — it just isn't the only way to read a file
 * anymore.
 *
 * ## Why Monaco rather than a highlighter
 *
 * A syntax-highlighted read-only view would have been a tenth of this. It
 * would also have been the wrong thing: the scripting surface is deliberately
 * fully typed (`engine.d.ts` is generated so a script never has to look
 * anything up), and that investment only pays off in an editor with a real
 * language service. Monaco carries TypeScript's, so the in-app editor gets the
 * same completions, hovers, signature help and inline errors the user's IDE
 * would give them — against the same declarations, from the same file.
 *
 * ## Type declarations, in two tiers
 *
 * `engine.d.ts` / `editor.d.ts` are bundled into the app as raw strings
 * (`projectTypes.js` already imports them to scaffold projects), so they are
 * registered synchronously at setup: the API the user actually writes against
 * is known before the first keystroke.
 *
 * three's declarations are ~970 files vendored per-project on disk, far too
 * much to block on. They load in the background on first use, over a single
 * batched `read_text_files` call, and `three` resolves to `any` until they
 * land. That ordering matters: blocking startup on 12 MB of `@types/three`
 * would make opening a script feel broken, whereas `Vector3` going from `any`
 * to typed a second later is invisible.
 */

import { vmSingleton } from "../singleton.js";
import ENGINE_DTS from "../../engine/script-types/engine.d.ts?raw";
import EDITOR_DTS from "../../engine/script-types/editor.d.ts?raw";

/** Monaco's own module namespace, loaded once and shared. */
let monacoPromise = null;

/**
 * Monaco's language services run in web workers. Vite's `?worker` suffix
 * bundles each as its own chunk and hands back a constructor, which is what
 * `MonacoEnvironment` has to return. Skipping this leaves Monaco trying to
 * `importScripts` a path that does not exist in a Vite build — the visible
 * symptom being an editor that highlights but never completes anything.
 */
async function installWorkers() {
  if (globalThis.MonacoEnvironment?.getWorker) return;
  const [{ default: EditorWorker }, { default: TsWorker }, { default: JsonWorker }, { default: CssWorker }] =
    await Promise.all([
      import("monaco-editor/esm/vs/editor/editor.worker?worker"),
      import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
      import("monaco-editor/esm/vs/language/json/json.worker?worker"),
      import("monaco-editor/esm/vs/language/css/css.worker?worker"),
    ]);
  globalThis.MonacoEnvironment = {
    getWorker(_id, label) {
      if (label === "typescript" || label === "javascript") return new TsWorker();
      if (label === "json") return new JsonWorker();
      if (label === "css" || label === "scss" || label === "less") return new CssWorker();
      return new EditorWorker();
    },
  };
}

/**
 * The editor's own colours, as a Monaco theme.
 *
 * Monaco's stock `vs-dark` is a different grey from every other surface in the
 * app, and an editor pane that doesn't match the panel it sits in reads as an
 * embedded website rather than part of the tool. The token colours are tuned
 * against `--bg-1`, the panel background these editors always sit on.
 */
function defineTheme(monaco) {
  monaco.editor.defineTheme("engine-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "ececee" },
      { token: "comment", foreground: "6b7280", fontStyle: "italic" },
      { token: "keyword", foreground: "c792ea" },
      { token: "number", foreground: "f4bf4f" },
      { token: "string", foreground: "9ece6a" },
      { token: "type", foreground: "34c8ae" },
      { token: "type.identifier", foreground: "34c8ae" },
      { token: "identifier", foreground: "d6d8dd" },
      { token: "delimiter", foreground: "86888f" },
      { token: "tag", foreground: "59c2ff" },
      { token: "attribute.name", foreground: "e2a33c" },
      { token: "attribute.value", foreground: "9ece6a" },
    ],
    colors: {
      "editor.background": "#151619",
      "editor.foreground": "#ececee",
      "editorLineNumber.foreground": "#4a4d56",
      "editorLineNumber.activeForeground": "#9ea1a9",
      "editorCursor.foreground": "#0a84ff",
      "editor.selectionBackground": "#0a84ff40",
      "editor.inactiveSelectionBackground": "#0a84ff20",
      "editor.lineHighlightBackground": "#ffffff08",
      "editorIndentGuide.background1": "#ffffff10",
      "editorIndentGuide.activeBackground1": "#ffffff28",
      "editorWidget.background": "#1c1d22",
      "editorWidget.border": "#ffffff21",
      "editorSuggestWidget.background": "#1c1d22",
      "editorSuggestWidget.border": "#ffffff21",
      "editorSuggestWidget.selectedBackground": "#0a84ff2a",
      "editorHoverWidget.background": "#1c1d22",
      "editorHoverWidget.border": "#ffffff21",
      "editorGutter.background": "#151619",
      "scrollbarSlider.background": "#ffffff14",
      "scrollbarSlider.hoverBackground": "#ffffff22",
      "scrollbarSlider.activeBackground": "#ffffff33",
      "editorBracketMatch.background": "#0a84ff22",
      "editorBracketMatch.border": "#0a84ff66",
      "editorError.foreground": "#ff5d55",
      "editorWarning.foreground": "#e2a33c",
      "minimap.background": "#151619",
    },
  });
}

/**
 * Compiler options for both JS and TS.
 *
 * Deliberately the same set `projectTypes.js` writes into the project's
 * `tsconfig.json`. If these two drift, the in-app editor and the user's IDE
 * disagree about their own code — one flags an error the other doesn't — and
 * there is no way for the user to tell which one is lying.
 */
function compilerOptions(monaco) {
  return {
    target: monaco.languages.typescript.ScriptTarget.ES2022,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    lib: ["es2022", "dom", "dom.iterable"],
    allowJs: true,
    checkJs: false,
    noEmit: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    experimentalDecorators: true,
    useDefineForClassFields: false,
    strict: false,
    baseUrl: "file:///",
    paths: {
      engine: ["file:///engine-types/engine.d.ts"],
      editor: ["file:///engine-types/editor.d.ts"],
      three: ["file:///engine-types/three/build/three.module.d.ts"],
      "three/webgpu": ["file:///engine-types/three/build/three.webgpu.d.ts"],
      "three/tsl": ["file:///engine-types/three/build/three.tsl.d.ts"],
      "three/addons/*": ["file:///engine-types/three/examples/jsm/*"],
    },
  };
}

/**
 * A stand-in for three, used until (or instead of) the real declarations.
 *
 * Without *some* declaration for the module, every `import * as THREE from
 * "three"` is a red squiggle on line 1 — which trains the user to ignore the
 * error markers entirely, and that is far worse than `THREE` being `any` for a
 * second. Registered under a filename the real declarations never use, so
 * loading them later simply adds a better match rather than conflicting.
 */
const THREE_FALLBACK_DTS = `
declare module "three" { const THREE: any; export = THREE; }
declare module "three/webgpu" { const THREE: any; export = THREE; }
declare module "three/tsl" { const TSL: any; export = TSL; }
declare module "three/addons/*" { const addon: any; export = addon; }
`;

/** Registered extra-lib URIs, so a re-setup doesn't add them twice. */
const state = vmSingleton("code:monaco", () => ({
  libs: new Set(),
  threeLoadedFor: null, // project root whose three types are registered
  threeLoading: null,
}));

function addLib(monaco, contents, uri) {
  if (state.libs.has(uri)) return;
  state.libs.add(uri);
  monaco.languages.typescript.typescriptDefaults.addExtraLib(contents, uri);
  monaco.languages.typescript.javascriptDefaults.addExtraLib(contents, uri);
}

/**
 * Registers a declaration file that CHANGES during a session — currently the
 * project's generated event declarations, which are rewritten every time the
 * Events panel saves.
 *
 * Deliberately not `addLib`: that one dedupes by URI and never replaces, which
 * is right for the engine's own bundled declarations (they can't change while
 * the app runs) and exactly wrong here — the second save of the session would
 * be dropped and the user would watch autocomplete go stale with no way to
 * refresh short of restarting. Monaco replaces a same-URI lib and bumps its
 * internal version, so re-registering is both correct and cheap.
 */
export async function registerExtraLib(contents, uri) {
  const monaco = await loadMonaco();
  monaco.languages.typescript.typescriptDefaults.addExtraLib(contents, uri);
  monaco.languages.typescript.javascriptDefaults.addExtraLib(contents, uri);
}

/**
 * Loads Monaco (once) with the editor's theme, compiler options and the
 * bundled engine declarations already registered.
 */
export function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = (async () => {
    await installWorkers();
    const monaco = await import("monaco-editor");
    defineTheme(monaco);
    for (const defaults of [
      monaco.languages.typescript.typescriptDefaults,
      monaco.languages.typescript.javascriptDefaults,
    ]) {
      defaults.setCompilerOptions(compilerOptions(monaco));
      defaults.setEagerModelSync(true);
      // 2307 = "cannot find module". Suppressed because a project script can
      // legitimately import a sibling script by a relative path Monaco has no
      // model for until that file is also open, and a permanent error on a
      // line that runs fine is the fastest way to make diagnostics worthless.
      defaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        diagnosticCodesToIgnore: [2307],
      });
    }
    addLib(monaco, ENGINE_DTS, "file:///engine-types/engine.d.ts");
    addLib(monaco, EDITOR_DTS, "file:///engine-types/editor.d.ts");
    addLib(monaco, THREE_FALLBACK_DTS, "file:///engine-types/three-fallback.d.ts");
    return monaco;
  })();
  return monacoPromise;
}

/**
 * Registers the project's vendored `@types/three` with the language service.
 *
 * Safe to call repeatedly and from anywhere — it is a no-op once the current
 * project's declarations are in, and concurrent callers share one read. Never
 * throws: a project scaffolded before three types existed simply keeps the
 * `any` fallback, which is a worse editor, not a broken one.
 *
 * @param {string} projectRoot
 */
export async function ensureThreeTypes(projectRoot) {
  if (!projectRoot) return false;
  if (state.threeLoadedFor === projectRoot) return true;
  if (state.threeLoading) return state.threeLoading;
  state.threeLoading = (async () => {
    try {
      const monaco = await loadMonaco();
      const { invoke } = await import("@tauri-apps/api/core");
      const root = `${String(projectRoot).replace(/[\\/]$/, "")}/engine-types`;
      // ~970 files come back in one IPC response. That is one round trip by
      // design (see the header), but it is also the single biggest payload the
      // editor ever moves across it, so when opening a script feels slow this
      // is the first number worth having.
      const readStart = performance.now();
      const files = await invoke("read_text_files", { root, suffix: ".d.ts" });
      const readMs = Math.round(performance.now() - readStart);
      if (!files?.length) return false;
      const registerStart = performance.now();
      for (const file of files) {
        // Monaco resolves `paths` against the URIs libs are registered under,
        // so the on-disk layout has to be reproduced exactly under file:///.
        // Getting this wrong doesn't error — it silently resolves nothing.
        const relative = String(file.path)
          .replaceAll("\\", "/")
          .slice(String(projectRoot).replaceAll("\\", "/").replace(/\/$/, "").length + 1);
        addLib(monaco, file.contents, `file:///${relative}`);
      }
      state.threeLoadedFor = projectRoot;
      const registerMs = Math.round(performance.now() - registerStart);
      if (readMs + registerMs > 800) {
        console.warn(
          `[code] three declarations: ${files.length} files, read ${readMs}ms, registered ${registerMs}ms`,
        );
      }
      return true;
    } catch (error) {
      console.warn(`[code] three declarations unavailable: ${error?.message ?? error}`);
      return false;
    } finally {
      state.threeLoading = null;
    }
  })();
  return state.threeLoading;
}

/** Monaco's language id for a file, from its extension. */
export function languageForPath(path) {
  const ext = String(path ?? "").split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
      return "typescript";
    case "tsx":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "javascript";
    case "json":
    case "scene":
    case "prefab":
    case "entity":
    case "mat":
    case "anim":
    case "timeline":
    case "atlas":
    case "cubemap":
    case "meta":
    case "tex":
      // Every one of these is JSON on disk. Typing them as JSON is what gets
      // the user folding, bracket matching and validation on a `.mat` — files
      // they are otherwise told to never open.
      return "json";
    case "md":
      return "markdown";
    case "css":
      return "css";
    case "html":
      return "html";
    case "wgsl":
    case "glsl":
    case "frag":
    case "vert":
      return "wgsl";
    case "toml":
      return "ini";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return "plaintext";
  }
}

/** True when this file is worth opening in the code editor at all. */
export function isTextEditablePath(path) {
  return languageForPath(path) !== "plaintext" || /\.(txt|log|ini|env|gitignore)$/i.test(String(path ?? ""));
}

/**
 * A stable Monaco model per project file.
 *
 * Models are shared rather than created per mount on purpose: the Inspector's
 * inline editor and the Code panel can be showing the same file at the same
 * time, and two models would mean two copies of the text, two undo stacks, and
 * a save that silently discards whichever pane the user wasn't looking at.
 * One model means both panes are literally the same document.
 */
export async function getModel(path, contents) {
  const monaco = await loadMonaco();
  // `file:///` + the real path, so relative imports between two open scripts
  // resolve against each other the way they do on disk.
  const uri = monaco.Uri.parse(`file:///${String(path).replaceAll("\\", "/").replace(/^\/+/, "")}`);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;
  return monaco.editor.createModel(contents ?? "", languageForPath(path), uri);
}

/** Drops the model for `path` (after a delete/rename), if one exists. */
export async function disposeModel(path) {
  if (!monacoPromise) return;
  const monaco = await monacoPromise;
  const uri = monaco.Uri.parse(`file:///${String(path).replaceAll("\\", "/").replace(/^\/+/, "")}`);
  monaco.editor.getModel(uri)?.dispose();
}
