import { useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { PopoverMenu } from "./PopoverMenu.jsx";

/**
 * A dropdown that is actually ours.
 *
 * A native `<select>` can be styled down to its trigger and no further: the
 * open list is drawn by the platform, so inside a dark editor it appears as a
 * white box with barely-legible text, and no amount of CSS on `option` fixes
 * it in a WebView. Every other menu in this app is a portalled `PopoverMenu`
 * for exactly that reason; this puts the same body behind a field-shaped
 * trigger so a choice list stops being the one control that looks foreign.
 *
 * Also better behaved than the native control in two ways that matter here:
 * the menu can overhang a narrow docked panel (see `PopoverMenu` on why an
 * in-flow one shoves the layout sideways), and the current value is marked
 * with a tick rather than by platform-dependent highlighting.
 *
 * @param {{ value: string,
 *           options: Array<string | { value: string, label?: string, hint?: string }>,
 *           onChange: (value: string) => void,
 *           title?: string, disabled?: boolean, className?: string,
 *           align?: "left" | "right", capitalize?: boolean }} props
 */
export function SelectField({
  value,
  options,
  onChange,
  title,
  disabled = false,
  className = "",
  align = "left",
  capitalize = false,
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);

  const items = options.map((option) =>
    typeof option === "string" ? { value: option, label: option } : { label: option.value, ...option },
  );
  const current = items.find((item) => item.value === value);

  return (
    <div className={`select-wrap ${className}`} ref={anchorRef}>
      <button
        type="button"
        className={`tx-select ${open ? "open" : ""} ${capitalize ? "cap" : ""}`}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tx-select-value">{current?.label ?? value ?? ""}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <PopoverMenu anchorRef={anchorRef} className="tx-select-menu" onClose={() => setOpen(false)}>
          {items.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`dropdown-item ${item.value === value ? "selected" : ""}`}
              title={item.hint}
              onClick={() => {
                setOpen(false);
                if (item.value !== value) onChange(item.value);
              }}
            >
              <span className={`menu-item-label ${capitalize ? "cap" : ""}`}>{item.label}</span>
              {item.value === value && <Check size={12} className="tx-select-tick" />}
            </button>
          ))}
        </PopoverMenu>
      )}
    </div>
  );
}
