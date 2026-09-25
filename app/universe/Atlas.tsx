import { useState } from "react";
import type { LibraryEntry } from "./library-model";
import type { SkyModel } from "./sky/model";
import type { SkyFocus } from "./sky/SkyScene";

type AtlasProps = {
  model: SkyModel;
  entries: ReadonlyMap<string, LibraryEntry>;
  focus: SkyFocus;
  selectedId: string | null;
  onFocus: (focus: SkyFocus) => void;
  onOpenEntry: (id: string) => void;
};

function designation(prefix: string, index: number) {
  return `${prefix}${String(index + 1).padStart(2, "0")}`;
}

/**
 * The outline of the universe: regions → galaxies → papers. It is the fast,
 * keyboard- and VoiceOver-friendly way to move through the library and
 * mirrors exactly what the Sky draws.
 */
export function Atlas({ model, entries, focus, selectedId, onFocus, onOpenEntry }: AtlasProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const focusedRegionId = focus.level === "region" || focus.level === "notes"
    ? focus.regionId
    : focus.level === "galaxy" ? model.galaxyById.get(focus.galaxyId)?.regionId : null;
  const focusedGalaxyId = focus.level === "galaxy" ? focus.galaxyId : null;
  const committed = model.regions.filter((region) => !region.provisional);
  const provisional = model.regions.filter((region) => region.provisional);

  const renderRegion = (region: SkyModel["regions"][number], index: number) => {
    const open = expanded[region.id] ?? region.id === focusedRegionId;
    return (
      <li key={region.id} className={`atlas-region${region.id === focusedRegionId ? " is-current" : ""}`}>
        <div className="atlas-row">
          <button
            type="button"
            className="atlas-disclosure"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${region.label}`}
            onClick={() => setExpanded((current) => ({ ...current, [region.id]: !open }))}
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          </button>
          <button type="button" className="atlas-label" onClick={() => onFocus({ level: "region", regionId: region.id })}>
            <span className="atlas-code">{designation(region.provisional ? "A" : "R", index)}</span>
            <span className="atlas-dot" style={{ background: region.color }} aria-hidden="true" />
            <span className="atlas-name">{region.label}</span>
            <span className="atlas-count">{region.paperCount}</span>
          </button>
        </div>
        {open ? (
          <ul className="atlas-galaxies">
            {region.galaxyIds.map((galaxyId, galaxyIndex) => {
              const galaxy = model.galaxyById.get(galaxyId);
              if (!galaxy) return null;
              const galaxyOpen = galaxy.id === focusedGalaxyId;
              return (
                <li key={galaxy.id} className={galaxyOpen ? "is-current" : undefined}>
                  <button type="button" className="atlas-label" onClick={() => onFocus({ level: "galaxy", galaxyId: galaxy.id })}>
                    <span className="atlas-code">{designation("G", galaxyIndex)}</span>
                    <span className="atlas-name">{galaxy.label}</span>
                    <span className="atlas-count">{galaxy.paperIds.length}</span>
                  </button>
                  {galaxyOpen ? (
                    <ul className="atlas-papers">
                      {galaxy.paperIds.map((paperId) => {
                        const entry = entries.get(paperId);
                        if (!entry) return null;
                        return (
                          <li key={paperId}>
                            <button
                              type="button"
                              className={`atlas-paper tier-${entry.tier}${paperId === selectedId ? " is-selected" : ""}`}
                              onClick={() => onOpenEntry(paperId)}
                              title={entry.title}
                            >
                              <i aria-hidden="true" />
                              <span>{entry.shortTitle}</span>
                              {entry.year ? <span className="atlas-year">{entry.year}</span> : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
            {region.noteCount > 0 ? (
              <li>
                <button type="button" className="atlas-label" onClick={() => onFocus({ level: "notes", regionId: region.id })}>
                  <span className="atlas-code">BH</span>
                  <span className="atlas-name">Research notes</span>
                  <span className="atlas-count">{region.noteCount}</span>
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <aside className="atlas" aria-label="Atlas">
      <div className="atlas-header">
        <button type="button" className={`atlas-root${focus.level === "universe" ? " is-current" : ""}`} onClick={() => onFocus({ level: "universe" })}>
          Universe
        </button>
      </div>
      <div className="atlas-scroll">
        {committed.length > 0 ? (
          <>
            <p className="atlas-section">Reviewed regions</p>
            <ul className="atlas-regions">{committed.map(renderRegion)}</ul>
          </>
        ) : null}
        {provisional.length > 0 ? (
          <>
            <p className="atlas-section" title="Grouped automatically from shared references and vocabulary. Not yet reviewed.">
              Automatic regions
            </p>
            <ul className="atlas-regions">{provisional.map(renderRegion)}</ul>
          </>
        ) : null}
        {model.regions.length === 0 ? <p className="atlas-empty">No papers yet.</p> : null}
      </div>
    </aside>
  );
}
