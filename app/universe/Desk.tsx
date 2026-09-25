import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryAnalysis as Tier0Library } from "../../scripts/lib/liteverse-tier0.mjs";
import { readingPath, TIER_LABELS, type LibraryEntry } from "./library-model";
import { ScientificText } from "./ScientificText";
import type { SkyModel } from "./sky/model";
import type { SkyFocus } from "./sky/SkyScene";
import type { IntelligenceDigest } from "./useLiteverse";

export type DeskView = "triage" | "galaxy" | "compare";

type DeskProps = {
  view: DeskView;
  onViewChange: (view: DeskView) => void;
  entries: readonly LibraryEntry[];
  model: SkyModel;
  library: Tier0Library | null;
  focus: SkyFocus;
  digests: ReadonlyMap<string, IntelligenceDigest>;
  digestQueue: readonly string[];
  intelligenceAvailable: boolean;
  selectedId: string | null;
  onOpenEntry: (id: string) => void;
  onFocusGalaxy: (galaxyId: string) => void;
  onSummarize: (ids: string[]) => void;
  onOpenPDF: (input: { paperId?: string; itemId?: string; page: number; quote?: string }) => void;
  onImport: () => void;
};

type TierFilter = "all" | "0" | "1" | "2";
type SortKey = "centrality" | "year" | "title";
const COMPARE_KINDS = ["question", "method", "result", "limitation", "assumption"] as const;

function firstPoint(entry: LibraryEntry, kinds: readonly string[]) {
  return entry.brief?.keyPoints.find((point) => kinds.includes(point.kind));
}

function pdfTarget(entry: LibraryEntry) {
  return entry.kind === "paper" ? { paperId: entry.id } : { itemId: entry.id };
}

function Triage(props: DeskProps) {
  const [filter, setFilter] = useState<TierFilter>("all");
  const [text, setText] = useState("");
  const [sort, setSort] = useState<SortKey>("centrality");
  const [cursor, setCursor] = useState(0);
  const tableRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const filtered = props.entries.filter((entry) =>
      (filter === "all" || String(entry.tier) === filter) &&
      (!needle || `${entry.title} ${entry.authors} ${entry.regionLabel}`.toLowerCase().includes(needle)));
    return filtered.sort((left, right) => {
      if (sort === "year") return (right.year || 0) - (left.year || 0) || left.title.localeCompare(right.title);
      if (sort === "title") return left.title.localeCompare(right.title);
      return right.centrality - left.centrality || left.tier - right.tier || left.title.localeCompare(right.title);
    });
  }, [filter, props.entries, sort, text]);

  useEffect(() => {
    setCursor((value) => Math.min(value, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    const row = tableRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const counts = useMemo(() => {
    const result = { all: props.entries.length, 0: 0, 1: 0, 2: 0 } as Record<TierFilter, number>;
    for (const entry of props.entries) result[String(entry.tier) as TierFilter] += 1;
    return result;
  }, [props.entries]);

  const current = rows[cursor];
  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => Math.min(rows.length - 1, value + 1));
    } else if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => Math.max(0, value - 1));
    } else if ((event.key === "Enter" || event.key === " ") && current) {
      event.preventDefault();
      props.onOpenEntry(current.id);
    } else if (event.key === "o" && current) {
      const point = current.brief?.keyPoints[0];
      props.onOpenPDF({ ...pdfTarget(current), page: point?.page || 1, quote: point?.text });
    } else if (event.key === "s" && current && props.intelligenceAvailable) {
      props.onSummarize([current.id]);
    }
  };

  if (props.entries.length === 0) {
    return (
      <div className="desk-empty">
        <h2>No papers yet</h2>
        <p>Import PDFs to start. Key points appear here within seconds of reading each file.</p>
        <button type="button" className="primary-button" onClick={props.onImport}>Import PDFs</button>
      </div>
    );
  }

  const unsummarized = rows.filter((entry) => entry.tier === 0 && entry.brief && !props.digests.has(entry.id)).map((entry) => entry.id);

  return (
    <div className="triage" onKeyDown={onKeyDown}>
      <div className="desk-controls">
        <div className="segmented" role="tablist" aria-label="Evidence tier">
          {(["all", "0", "1", "2"] as TierFilter[]).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>
              {value === "all" ? "All" : TIER_LABELS[Number(value) as 0 | 1 | 2]} <span className="count">{counts[value]}</span>
            </button>
          ))}
        </div>
        <input className="text-input" placeholder="Filter by title, author, or region" value={text} onChange={(event) => setText(event.target.value)} aria-label="Filter papers" />
        <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Sort">
          <option value="centrality">Most cited first</option>
          <option value="year">Newest first</option>
          <option value="title">Title</option>
        </select>
        {props.intelligenceAvailable && unsummarized.length ? (
          <button type="button" className="secondary-button" onClick={() => props.onSummarize(unsummarized)}>
            Summarize {unsummarized.length} with Apple Intelligence
          </button>
        ) : null}
      </div>
      <div className="triage-table" ref={tableRef} tabIndex={0} role="grid" aria-label="Papers" aria-rowcount={rows.length}>
        {rows.map((entry, index) => {
          const point = firstPoint(entry, ["result"]) || entry.brief?.keyPoints[0];
          const digest = props.digests.get(entry.id);
          return (
            <div
              key={entry.id}
              data-row={index}
              role="row"
              aria-selected={index === cursor}
              className={`triage-row tier-${entry.tier}${index === cursor ? " is-cursor" : ""}${entry.id === props.selectedId ? " is-selected" : ""}`}
              onClick={() => { setCursor(index); props.onOpenEntry(entry.id); }}
            >
              <span className="triage-tier" role="gridcell" title={TIER_LABELS[entry.tier]}><i /></span>
              <span className="triage-main" role="gridcell">
                <span className="triage-title"><ScientificText>{entry.title}</ScientificText></span>
                <span className="triage-meta">
                  {[entry.authors.split(",")[0], entry.year, entry.regionLabel].filter(Boolean).join(" · ")}
                  {entry.centrality ? ` · cited ×${entry.centrality}` : ""}
                  {props.digestQueue.includes(entry.id) ? " · summarizing…" : ""}
                </span>
                {digest ? <span className="triage-point is-digest">{digest.gist}</span> : point ? (
                  <span className="triage-point"><q>{point.text}</q> <span className="mono">p. {point.page}</span></span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      <p className="desk-hint">J/K move · Enter open · O open PDF at the key point{props.intelligenceAvailable ? " · S summarize on device" : ""}</p>
    </div>
  );
}

function GalaxyBrief(props: DeskProps & { galaxyId: string | null; onGalaxyChange: (id: string) => void }) {
  const galaxy = props.galaxyId ? props.model.galaxyById.get(props.galaxyId) : undefined;
  const entryById = useMemo(() => new Map(props.entries.map((entry) => [entry.id, entry])), [props.entries]);
  const order = useMemo(
    () => galaxy ? readingPath(galaxy.paperIds, props.library?.citationEdges || [], entryById) : [],
    [entryById, galaxy, props.library?.citationEdges],
  );
  return (
    <div className="galaxy-brief">
      <div className="desk-controls">
        <GalaxyPicker model={props.model} value={props.galaxyId} onChange={props.onGalaxyChange} />
      </div>
      {galaxy ? (
        <ol className="brief-list">
          {order.map((id, index) => {
            const entry = entryById.get(id);
            if (!entry) return null;
            const digest = props.digests.get(id);
            const points = entry.brief?.keyPoints.filter((point) => point.kind === "result" || point.kind === "method").slice(0, 2) || [];
            return (
              <li key={id} className={`brief-item tier-${entry.tier}`}>
                <span className="brief-step">{index + 1}</span>
                <div>
                  <button type="button" className="brief-title" onClick={() => props.onOpenEntry(id)}>
                    <ScientificText>{entry.title}</ScientificText>
                  </button>
                  <p className="triage-meta">{[entry.authors.split(",")[0], entry.year, TIER_LABELS[entry.tier]].filter(Boolean).join(" · ")}</p>
                  {digest ? <p className="digest-gist">{digest.gist}</p> : null}
                  {points.map((point) => (
                    <p key={point.id} className="brief-quote">
                      <span className="key-point-kind">{point.kind === "result" ? "Result" : "Method"}</span>
                      <q>{point.text}</q>
                      <button type="button" className="page-link" onClick={() => props.onOpenPDF({ ...pdfTarget(entry), page: point.page, quote: point.text })}>p. {point.page}</button>
                    </p>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      ) : <p className="muted">Choose a galaxy to read it as a sequence.</p>}
    </div>
  );
}

function Compare(props: DeskProps & { galaxyId: string | null; onGalaxyChange: (id: string) => void }) {
  const galaxy = props.galaxyId ? props.model.galaxyById.get(props.galaxyId) : undefined;
  const entryById = useMemo(() => new Map(props.entries.map((entry) => [entry.id, entry])), [props.entries]);
  const members = (galaxy?.paperIds || []).map((id) => entryById.get(id)).filter((entry): entry is LibraryEntry => Boolean(entry));
  return (
    <div className="compare">
      <div className="desk-controls">
        <GalaxyPicker model={props.model} value={props.galaxyId} onChange={props.onGalaxyChange} />
        <span className="fine-print">Cells are verbatim extracted sentences. Click a page to check the source.</span>
      </div>
      {galaxy ? (
        <div className="compare-scroll">
          <table className="compare-table">
            <thead>
              <tr>
                <th scope="col">Paper</th>
                {COMPARE_KINDS.map((kind) => <th key={kind} scope="col">{kind[0].toUpperCase() + kind.slice(1)}</th>)}
              </tr>
            </thead>
            <tbody>
              {members.map((entry) => (
                <tr key={entry.id} className={`tier-${entry.tier}`}>
                  <th scope="row">
                    <button type="button" className="brief-title" onClick={() => props.onOpenEntry(entry.id)}>{entry.shortTitle}</button>
                    <span className="triage-meta">{entry.year || ""}</span>
                  </th>
                  {COMPARE_KINDS.map((kind) => {
                    const point = firstPoint(entry, [kind]);
                    return (
                      <td key={kind}>
                        {point ? (
                          <>
                            <ScientificText>{point.text.length > 260 ? `${point.text.slice(0, 257)}…` : point.text}</ScientificText>
                            <button type="button" className="page-link" onClick={() => props.onOpenPDF({ ...pdfTarget(entry), page: point.page, quote: point.text })}>p. {point.page}</button>
                          </>
                        ) : <span className="muted">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">Choose a galaxy to compare its papers side by side.</p>}
    </div>
  );
}

function GalaxyPicker({ model, value, onChange }: { model: SkyModel; value: string | null; onChange: (id: string) => void }) {
  return (
    <select value={value || ""} onChange={(event) => onChange(event.target.value)} aria-label="Galaxy">
      <option value="" disabled>Choose a galaxy…</option>
      {model.regions.map((region) => (
        <optgroup key={region.id} label={region.label}>
          {region.galaxyIds.map((id) => {
            const galaxy = model.galaxyById.get(id);
            return galaxy ? <option key={id} value={id}>{galaxy.label} ({galaxy.paperIds.length})</option> : null;
          })}
        </optgroup>
      ))}
    </select>
  );
}

export function Desk(props: DeskProps) {
  const focusedGalaxyId = props.focus.level === "galaxy" ? props.focus.galaxyId : null;
  const [galaxyId, setGalaxyId] = useState<string | null>(focusedGalaxyId);
  useEffect(() => {
    if (focusedGalaxyId) setGalaxyId(focusedGalaxyId);
  }, [focusedGalaxyId]);
  const changeGalaxy = (id: string) => {
    setGalaxyId(id);
    props.onFocusGalaxy(id);
  };
  return (
    <div className="desk">
      <div className="desk-tabs" role="tablist" aria-label="Desk view">
        {([["triage", "Triage"], ["galaxy", "Galaxy brief"], ["compare", "Compare"]] as const).map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={props.view === value} onClick={() => props.onViewChange(value)}>{label}</button>
        ))}
      </div>
      {props.view === "triage" ? <Triage {...props} /> : null}
      {props.view === "galaxy" ? <GalaxyBrief {...props} galaxyId={galaxyId} onGalaxyChange={changeGalaxy} /> : null}
      {props.view === "compare" ? <Compare {...props} galaxyId={galaxyId} onGalaxyChange={changeGalaxy} /> : null}
    </div>
  );
}
