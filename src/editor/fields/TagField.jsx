import { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

/**
 * Tag chips + an add box, shared by the entity inspector and the asset
 * inspector so a tag looks and behaves the same wherever it appears.
 *
 * Tags are the cheap way to answer "all the pickups" or "everything that
 * belongs to level 2" without inventing a naming convention or a folder
 * hierarchy that fights the one you already have. Entities get them for
 * runtime queries (`engine.findByTag`), assets get them for browsing.
 *
 * Existing tags in the project are offered as suggestions — without that,
 * every tag list drifts into "enemy", "Enemy" and "enemies" within a week.
 */

/** Tags are matched exactly at runtime, so normalise on the way in. */
export const normalizeTag = (value) => String(value ?? "").trim().replace(/\s+/g, "-");

export function TagField({ tags = [], onChange, suggestions = [], placeholder = "Add tag…" }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  const matches = useMemo(() => {
    const needle = draft.trim().toLowerCase();
    return suggestions
      .filter((tag) => !tags.includes(tag))
      .filter((tag) => !needle || tag.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [suggestions, tags, draft]);

  const add = (value) => {
    const tag = normalizeTag(value);
    setDraft("");
    setOpen(false);
    if (!tag || tags.includes(tag)) return;
    onChange([...tags, tag].sort());
  };

  const remove = (tag) => onChange(tags.filter((t) => t !== tag));

  return (
    <div className="tag-field">
      <div className="tag-chips">
        {tags.map((tag) => (
          <span className="tag-chip" key={tag}>
            {tag}
            <button className="tag-chip-remove" title={`Remove "${tag}"`} onClick={() => remove(tag)}>
              <X size={9} />
            </button>
          </span>
        ))}
        <div className="tag-input-wrap">
          <input
            ref={inputRef}
            className="tag-input"
            type="text"
            value={draft}
            placeholder={tags.length ? "" : placeholder}
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            // A blur that lands on a suggestion button must not close the menu
            // before the click registers, hence the frame of delay.
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add(matches.length && draft.trim() === "" ? matches[0] : draft);
              } else if (e.key === "Backspace" && !draft && tags.length) {
                remove(tags[tags.length - 1]);
              } else if (e.key === "Escape") {
                setDraft("");
                setOpen(false);
                e.currentTarget.blur();
              }
            }}
          />
          {open && matches.length > 0 && (
            <div className="tag-suggestions">
              {matches.map((tag) => (
                <button
                  key={tag}
                  className="tag-suggestion"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    add(tag);
                    inputRef.current?.focus();
                  }}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
