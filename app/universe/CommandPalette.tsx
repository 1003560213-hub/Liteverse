import { useEffect, useMemo, useRef, useState } from "react";
import { createSearchIndex } from "../../scripts/lib/liteverse-tier0.mjs";
import { TIER_LABELS, type LibraryEntry } from "./library-model";
import type { SkyModel } from "./sky/model";
import type { SkyFocus } from "./sky/SkyScene";

export type PaletteCommand = { id: string; label: string; hint?: string; run: () => void };

type PaletteItem =
  | { kind: "paper"; id: string; title: string; detail: string; quote?: string }
  | { kind: "place"; id: string; title: string; detail: string; focus: SkyFocus }
  | { kind: "command"; id: string; title: string; detail: string; run: () => void };

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  entries: readonly LibraryEntry[];
  model: SkyModel;
  commands: PaletteCommand[];
  onOpenEntry: (id: string) => void;
  onFocus: (focus: SkyFocus) => void;
};

/** ⌘K: one search for papers (titles, abstracts, extracted key points), places, and commands. */
export function CommandPalette({ open, onClose, entries, model, commands, onOpenEntry, onFocus }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);

  const index = useMemo(() => {
    if (!open) return null;
    const briefs = entries.flatMap((entry) => entry.brief ? [entry.brief] : []);
    const extra = entries
      .filter((entry) => !entry.brief)
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        text: [entry.authors, entry.paper?.summary, entry.paper?.tags.join(" ")].filter(Boolean).join(" "),
      }));
    return createSearchIndex(briefs, extra);
  }, [entries, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const text = query.trim();
    const lower = text.toLowerCase();
    const matchedCommands = commands
      .filter((command) => !lower || command.label.toLowerCase().includes(lower))
      .slice(0, text ? 4 : 8)
      .map((command) => ({ kind: "command" as const, id: command.id, title: command.label, detail: command.hint || "", run: command.run }));
    if (!text) return matchedCommands;
    const places: PaletteItem[] = [];
    for (const region of model.regions) {
      if (region.label.toLowerCase().includes(lower)) {
        places.push({ kind: "place", id: region.id, title: region.label, detail: region.provisional ? "Automatic region" : "Region", focus: { level: "region", regionId: region.id } });
      }
    }
    for (const galaxy of model.galaxies) {
      if (galaxy.label.toLowerCase().includes(lower)) {
        places.push({ kind: "place", id: galaxy.id, title: galaxy.label, detail: `Galaxy · ${galaxy.paperIds.length} papers`, focus: { level: "galaxy", galaxyId: galaxy.id } });
      }
    }
    const papers: PaletteItem[] = (index?.search(text, { limit: 12 }) || []).flatMap((result) => {
      const entry = entryById.get(result.id);
      if (!entry) return [];
      return [{
        kind: "paper" as const,
        id: entry.id,
        title: entry.title,
        detail: [TIER_LABELS[entry.tier], entry.year, entry.authors.split(",")[0]].filter(Boolean).join(" · "),
        quote: result.matchedQuote?.text,
      }];
    });
    return [...papers, ...places.slice(0, 6), ...matchedCommands];
  }, [commands, entryById, index, model.galaxies, model.regions, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.kind === "paper") onOpenEntry(item.id);
    else if (item.kind === "place") onFocus(item.focus);
    else {
      item.run();
      onClose();
    }
    setQuery("");
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="Search papers, key points, galaxies, or commands"
          aria-label="Search"
          aria-controls="palette-results"
          aria-activedescendant={items[active] ? `palette-item-${active}` : undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((value) => Math.min(items.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(items[active]);
            }
          }}
        />
        <ul className="palette-results" id="palette-results" role="listbox">
          {items.map((item, itemIndex) => (
            <li
              key={`${item.kind}:${item.id}`}
              id={`palette-item-${itemIndex}`}
              role="option"
              aria-selected={itemIndex === active}
              className={`palette-item is-${item.kind}${itemIndex === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(itemIndex)}
              onClick={() => choose(item)}
            >
              <span className="palette-kind">{item.kind === "paper" ? "Paper" : item.kind === "place" ? "Go to" : "Command"}</span>
              <span className="palette-title">{item.title}</span>
              {item.detail ? <span className="palette-detail">{item.detail}</span> : null}
              {item.kind === "paper" && item.quote ? <q className="palette-quote">{item.quote}</q> : null}
            </li>
          ))}
          {items.length === 0 ? <li className="palette-empty">No matches.</li> : null}
        </ul>
      </div>
    </div>
  );
}
