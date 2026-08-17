import ReactDOM from "react-dom/client";
import { Suspense, lazy } from "react";
import "dockview-react/dist/styles/dockview.css";
import "./editor/theme.css";
import { installConsoleCapture } from "./editor/store/consoleStore.js";
import { ProjectHub } from "./editor/ProjectHub.jsx";
import { useProjectStore, basename } from "./editor/store/projectStore.js";
import { installStartupReopen } from "./editor/startupReopen.js";

installConsoleCapture();
// Before the hub/shell decision below, and deliberately NOT behind the engine:
// this reopens the last project (and, after `editor.reload`, the exact scene)
// from a boot that has no project open — which is exactly the boot where the
// ops module is never imported. It also sets `restoring` synchronously, so the
// first render below already knows not to paint the hub.
installStartupReopen();

// EditorShell (and everything it transitively pulls in — dockview's panel
// components, the engine module graph, MenuBar, scene IO) is lazy-loaded
// behind a Suspense boundary. The project hub renders inside the first frame
// without paying for any of that.
const EditorShell = lazy(() =>
  import("./editor/EditorShell.jsx").then((m) => ({ default: m.EditorShell })),
);

const Splash = ({ children }) => (
  <div className="editor-splash">{children}</div>
);

function App() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const hubSkipped = useProjectStore((s) => s.hubSkipped);
  // The project being reopened, or false. Named rather than a bare boolean so
  // the splash can say WHICH project — on a slow drive this is the only thing
  // on screen for a second or two, and "Opening GAME…" is the difference
  // between waiting and wondering.
  const restoring = useProjectStore((s) => s.restoring);

  if (rootPath || hubSkipped) {
    return (
      <Suspense fallback={<Splash>Loading editor…</Splash>}>
        <EditorShell />
      </Suspense>
    );
  }
  // Between launch and the last project opening. Showing the hub here instead
  // would flash a picker the user never gets to use.
  if (restoring) return <Splash>Opening {basename(restoring)}…</Splash>;
  return <ProjectHub />;
}

// No StrictMode: its dev-mode double-mount would tear down and re-create the
// WebGPU renderer; the engine singleton is managed explicitly instead.
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
