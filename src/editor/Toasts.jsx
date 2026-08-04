import { AlertTriangle, AlertCircle, Info, X } from "lucide-react";
import { useToastStore, dismissToast } from "./toasts.js";

const ICONS = { error: AlertTriangle, warn: AlertCircle, info: Info };

/** Bottom-right toast stack. Mounted once in EditorShell, above everything. */
export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="toast-stack">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.level] ?? Info;
        return (
          <div key={toast.id} className={`toast toast-${toast.level}`}>
            <Icon size={14} className="toast-icon" />
            <div className="toast-body">
              <div className="toast-title">{toast.title}</div>
              {toast.detail ? <div className="toast-detail">{toast.detail}</div> : null}
            </div>
            <button
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismissToast(toast.id)}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
