import { useState } from "react";
import { ChevronRight } from "lucide-react";

/**
 * The layout language shared by the two settings panels (Project and Scene).
 *
 * These are deliberately NOT the inspector's `.field-row` / `.field-label`.
 * The inspector gives every label a fixed 76px column because its rows are
 * `Position X/Y/Z` — three-character labels next to three number fields. A
 * settings sheet is the other shape: the labels are phrases ("Watch project
 * files", "Max device pixel ratio") and most controls are one switch, so here
 * the label takes the room and the control is pinned right.
 *
 * The other rule these encode is that prose is a last resort. Both panels had
 * grown paragraphs explaining what a row does, which is text you re-read every
 * visit and cannot skim past to reach the control underneath. Anything a
 * tooltip can carry goes in `hint`; what is left is one line of `Note`.
 */

/**
 * One row of the sheet: label, then the control column.
 *
 * `sub` marks a setting that only means anything while the row above it is on
 * (the script poll under script reload, MSAA under antialias). It indents and
 * dims the label, which is what makes the greyed-out state legible as "its
 * parent is off" rather than as "this is broken".
 *
 * `wide` hands the room to the control — for a path or a title, where 146px of
 * field is not enough to see what you typed.
 *
 * `hint` is the row's tooltip. It is where the explanation goes.
 */
export function Row({ label, hint = null, disabled = false, wide = false, sub = false, children = null }) {
  return (
    <div
      className={`settings-row${wide ? " wide" : ""}${sub ? " sub" : ""}${disabled ? " disabled" : ""}`}
      title={hint}
    >
      <span className="settings-label">{label}</span>
      <div className="settings-control">{children}</div>
    </div>
  );
}

export function Toggle({ checked, onChange, disabled = false }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/** The one line of prose a section is allowed. `footer` is the panel-level
 *  variant that sits outside every section and carries its own padding. */
export function Note({ danger = false, footer = false, children = null }) {
  return (
    <div className={`settings-note${danger ? " danger" : ""}${footer ? " footer" : ""}`}>
      {children}
    </div>
  );
}

/**
 * A collapsible settings group. Open/closed is remembered per section id (not
 * per project or per scene) in localStorage: which groups you care about is a
 * fact about how you work, and re-collapsing Keybindings on every visit is
 * exactly the papercut collapsing was meant to remove.
 */
export function Section({ id, title, defaultOpen = true, children }) {
  const key = `settingsSection.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? defaultOpen : saved === "1";
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () => {
    setOpen((was) => {
      try {
        localStorage.setItem(key, was ? "0" : "1");
      } catch {
        // Private mode / quota — the section still opens, it just won't persist.
      }
      return !was;
    });
  };
  return (
    <div className={`inspector-section settings-section${open ? " open" : ""}`}>
      <button className={`section-header toggle${open ? " open" : ""}`} onClick={toggle}>
        <ChevronRight size={12} className="section-chevron" />
        {title}
      </button>
      {open ? <div className="settings-body">{children}</div> : null}
    </div>
  );
}
