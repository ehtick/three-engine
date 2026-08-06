import { useEffect, useState } from "react";

/**
 * Whether this dockview panel is the visible tab of its group.
 *
 * Dockview does not unmount an inactive tab — it detaches the element and
 * leaves React running (see the dockview note in the editor docs). That is the
 * right default, because unmounting would throw away panel state, and for the
 * document-holding editors — Audio, Texture, Geometry — that state is *unsaved
 * user work*. A blanket "unmount when hidden" would silently discard a
 * half-finished edit every time someone clicked another tab.
 *
 * The cost of that default is that a hidden panel keeps paying for anything it
 * subscribed to: timers, animation frames, event buses, network polling. This
 * hook is how a panel stops paying without giving up its state — idle while
 * hidden, resume when shown.
 *
 * Panels receive `api` from dockview automatically (`withPanelSuspense`
 * forwards its props). It's absent when a panel is rendered outside dockview —
 * a test harness, a preview — so the default is "visible", which keeps those
 * cases working rather than silently dead.
 */
export function usePanelVisible(api) {
  const [visible, setVisible] = useState(() => api?.isVisible ?? true);

  useEffect(() => {
    if (!api?.onDidVisibilityChange) {
      setVisible(true);
      return undefined;
    }
    setVisible(api.isVisible ?? true);
    const disposable = api.onDidVisibilityChange((event) => {
      setVisible(event?.isVisible ?? api.isVisible ?? true);
    });
    return () => disposable?.dispose?.();
  }, [api]);

  return visible;
}
