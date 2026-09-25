import { useEffect, useMemo, useState } from "react";
import type { GalaxyHierarchy, PersonalMemory } from "./hierarchy";
import { readingPath, TIER_DETAILS, TIER_LABELS, type LibraryEntry } from "./library-model";
import { ScientificText } from "./ScientificText";
import type { SkyModel } from "./sky/model";
import type { SkyFocus } from "./sky/SkyScene";
import {
  normalizedPercent,
  paperCardPath,
  paperVerificationState,
  relationDisplayState,
  type PaperIntegrityIssue,
  type Relation,
} from "./types";
import type { Annotation, LiteverseState } from "./useLiteverse";
import type { WorkspaceHealth } from "./workspace";

export type InspectorSelection =
  | { kind: "entry"; id: string }
  | { kind: "relation"; key: string }
  | { kind: "notes"; regionId: string }
  | { kind: "note"; regionId: string; memoryId: string }
  | null;

type InspectorProps = {
  selection: InspectorSelection;
  focus: SkyFocus;
  state: LiteverseState;
  model: SkyModel;
  entries: ReadonlyMap<string, LibraryEntry>;
  hierarchy: GalaxyHierarchy;
  memoriesByRegion: Map<string, PersonalMemory[]>;
  onClose: () => void;
  onOpenEntry: (id: string) => void;
  onFocus: (focus: SkyFocus) => void;
  onSelectNote: (regionId: string, memoryId: string) => void;
};

const KIND_LABELS: Record<string, string> = {
  question: "Question",
  method: "Method",
  result: "Result",
  limitation: "Limitation",
  assumption: "Assumption",
};

const RELATION_LABELS: Record<string, string> = {
  extends: "Extends",
  supports: "Supports",
  contradicts: "Contradicts",
  complements: "Complements",
  method_predecessor: "Method lineage",
  method_context: "Method context",
  historical_predecessor: "Earlier work",
  uses_method_of: "Uses method of",
  reproduces: "Reproduces",
  compares: "Compares",
};

function integrityIssue(paperId: string, health?: WorkspaceHealth): PaperIntegrityIssue | undefined {
  if (!health) return undefined;
  if (health.missingSourcePaperIds?.includes(paperId)) return "source_missing";
  if (health.hashMismatchPaperIds?.includes(paperId)) return "source_hash_mismatch";
  if (health.missingSourceHashPaperIds?.includes(paperId)) return "source_hash_missing";
  if (health.missingCardPaperIds?.includes(paperId)) return "card_missing";
  if (health.missingFulltextPaperIds?.includes(paperId)) return "fulltext_missing";
  return undefined;
}

function PanelHeader({ eyebrow, title, onClose }: { eyebrow: string; title: string; onClose?: () => void }) {
  return (
    <div className="panel-header">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {onClose ? <button type="button" className="icon-button panel-close" aria-label="Close" onClick={onClose}>×</button> : null}
    </div>
  );
}

function PaperLink({ entry, onOpen, detail }: { entry?: LibraryEntry; onOpen: (id: string) => void; detail?: string }) {
  if (!entry) return null;
  return (
    <button type="button" className={`paper-link tier-${entry.tier}`} onClick={() => onOpen(entry.id)}>
      <i aria-hidden="true" />
      <span className="paper-link-title">{entry.shortTitle}</span>
      <span className="paper-link-detail">{detail || entry.year || ""}</span>
    </button>
  );
}

function PaperInspector({ entry, props }: { entry: LibraryEntry; props: InspectorProps }) {
  const { state } = props;
  const [tab, setTab] = useState<"points" | "notes" | "links" | "card">("points");
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const brief = entry.brief;
  const digest = state.digests.get(entry.id);
  const queued = state.digestQueue.includes(entry.id);
  const paper = entry.paper;
  const verification = paper ? paperVerificationState(paper, integrityIssue(paper.id, state.workspace.health)) : null;
  const library = state.tier0.library;

  useEffect(() => {
    setTab("points");
    setDraft("");
    setEditingId(null);
  }, [entry.id]);

  useEffect(() => {
    if (tab === "card" && paper && state.knowledgeCard?.paperId !== paper.id) {
      state.actions.loadKnowledgeCard(paper.id, paperCardPath(paper), paper.artifacts?.integrity?.cardSha256);
    }
  }, [paper, state.actions, state.knowledgeCard?.paperId, tab]);

  const openAt = (page: number, quote?: string) => {
    state.actions.openPDFAt(entry.kind === "paper"
      ? { paperId: entry.id, page, quote }
      : { itemId: entry.id, page, quote });
  };

  const outgoing = useMemo(() => (library?.citationEdges || []).filter((edge) => edge.source === entry.id), [entry.id, library]);
  const incoming = useMemo(() => (library?.citationEdges || []).filter((edge) => edge.target === entry.id), [entry.id, library]);
  const neighbors = library?.neighbors?.[entry.id] || [];
  const relations = useMemo(() => (state.graph.relations || []).filter((relation) =>
    (relation.source === entry.id || relation.target === entry.id) && relationDisplayState(relation) !== "suggestion"), [entry.id, state.graph.relations]);
  const annotations = state.annotations
    .filter((annotation) => annotation.paperId === entry.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const saveNote = () => {
    const text = draft.trim();
    if (!text) return;
    const now = new Date().toISOString();
    const existing = editingId ? state.annotations.find((annotation) => annotation.id === editingId) : undefined;
    const annotation: Annotation = {
      id: existing?.id || `${entry.id}-${now.replace(/\D/g, "")}`,
      paperId: entry.id,
      paperTitle: entry.title,
      text,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      status: "pending",
      revision: (existing?.revision || 0) + 1,
    };
    state.actions.saveAnnotation(annotation);
    setDraft("");
    setEditingId(null);
  };

  return (
    <div className="inspector-body">
      <div className="paper-heading">
        <div className="chips">
          <span className={`tier-chip tier-${entry.tier}`} title={TIER_DETAILS[entry.tier]}>{TIER_LABELS[entry.tier]}</span>
          {entry.year ? <span className="chip">{entry.year}</span> : null}
          {brief?.identity?.arxivIds?.[0] ? <span className="chip mono">arXiv:{brief.identity.arxivIds[0]}</span> : null}
          {entry.centrality > 0 ? <span className="chip" title="Cited by this many papers in your library">Cited ×{entry.centrality}</span> : null}
        </div>
        <h2 className="paper-title"><ScientificText>{entry.title}</ScientificText></h2>
        {entry.authors ? <p className="paper-authors">{entry.authors}</p> : null}
        <button type="button" className="icon-button panel-close" aria-label="Close" onClick={props.onClose}>×</button>
      </div>

      <div className="tabs" role="tablist">
        {(["points", "notes", "links", ...(paper ? ["card"] as const : [])] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
            {value === "points" ? "Key points" : value === "notes" ? `Notes${annotations.length ? ` ${annotations.length}` : ""}` : value === "links" ? `Links${outgoing.length + incoming.length + relations.length ? ` ${outgoing.length + incoming.length + relations.length}` : ""}` : "Card"}
          </button>
        ))}
      </div>

      {tab === "points" ? (
        <div className="tab-panel">
          {digest ? (
            <section className="digest">
              <p className="eyebrow">Apple Intelligence · on-device draft</p>
              <p className="digest-gist">{digest.gist}</p>
              {digest.keyPoints.length ? (
                <ul className="digest-points">
                  {digest.keyPoints.map((point, index) => <li key={index}>{point.text}</li>)}
                </ul>
              ) : null}
              <p className="fine-print">Generated from the verbatim key points below. Not evidence; check the quoted pages.</p>
            </section>
          ) : brief && state.intelligence.available ? (
            <button type="button" className="secondary-button full" disabled={queued} onClick={() => state.actions.summarize([entry.id])}>
              {queued ? "Summarizing on this Mac…" : "Summarize with Apple Intelligence"}
            </button>
          ) : null}
          {state.digestError && queued ? <p className="inline-error">{state.digestError}</p> : null}

          {paper && entry.tier > 0 && paper.summary ? (
            <section className="summary-block">
              <p className="eyebrow">Reviewed summary</p>
              <p><ScientificText>{paper.summary}</ScientificText></p>
              {verification ? <p className={`fine-print tone-${verification.tone}`}>{verification.label} — {verification.detail}</p> : null}
            </section>
          ) : null}

          {brief ? (
            <>
              <ol className="key-points">
                {brief.keyPoints.map((point) => (
                  <li key={point.id} className={`key-point kind-${point.kind}`}>
                    <span className="key-point-kind">{KIND_LABELS[point.kind] || point.kind}</span>
                    <q><ScientificText>{point.text}</ScientificText></q>
                    <button type="button" className="page-link" onClick={() => openAt(point.page, point.text)}>p. {point.page}</button>
                  </li>
                ))}
              </ol>
              {brief.keyPoints.length === 0 ? <p className="muted">No key sentences were detected. Open the PDF or add a note.</p> : null}
              {brief.quantities.length ? (
                <section>
                  <p className="eyebrow">Quantities</p>
                  <ul className="quantities">
                    {brief.quantities.slice(0, 8).map((quantity) => (
                      <li key={quantity.id}>
                        <span className="mono">{quantity.text}</span>
                        <button type="button" className="page-link" onClick={() => openAt(quantity.page, quantity.text)}>p. {quantity.page}</button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {brief.abstract ? (
                <details className="abstract">
                  <summary>Abstract</summary>
                  <p><ScientificText>{brief.abstract.text}</ScientificText></p>
                </details>
              ) : null}
              <p className="fine-print">
                Key points are verbatim sentences selected locally from the extracted text
                {brief.quality !== "good" ? ` (text quality: ${brief.quality})` : ""}. They are not reviewed claims.
              </p>
            </>
          ) : (
            <p className="muted">{state.tier0.processing ? "Extracting key points…" : "Key points appear after the PDF has been read."}</p>
          )}
        </div>
      ) : null}

      {tab === "notes" ? (
        <div className="tab-panel">
          <textarea
            className="note-editor"
            value={draft}
            placeholder="Your observation, question, or interpretation"
            onChange={(event) => setDraft(event.target.value)}
            rows={4}
          />
          <div className="row-actions">
            {editingId ? <button type="button" className="secondary-button" onClick={() => { setDraft(""); setEditingId(null); }}>Cancel</button> : null}
            <button type="button" className="primary-button" disabled={!draft.trim()} onClick={saveNote}>
              {state.annotationState === "saving" ? "Saving…" : editingId ? "Save changes" : "Add note"}
            </button>
          </div>
          <ul className="note-list">
            {annotations.map((annotation) => (
              <li key={annotation.id}>
                <p>{annotation.text}</p>
                <div className="note-meta">
                  <span>{new Date(annotation.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
                  <span>{annotation.status === "organized" ? "Integrated into card" : "Your note"}</span>
                  <button type="button" className="link-button" onClick={() => { setEditingId(annotation.id); setDraft(annotation.text); }}>Edit</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tab === "links" ? (
        <div className="tab-panel">
          {relations.length ? (
            <section>
              <p className="eyebrow">Reviewed relationships</p>
              <ul className="link-list">
                {relations.map((relation) => {
                  const otherId = relation.source === entry.id ? relation.target : relation.source;
                  const displayState = relationDisplayState(relation);
                  return (
                    <li key={relation.id}>
                      <PaperLink entry={props.entries.get(otherId)} onOpen={props.onOpenEntry} detail={`${RELATION_LABELS[relation.type] || relation.label || relation.type} · ${displayState}`} />
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {outgoing.length ? (
            <section>
              <p className="eyebrow">Cites in your library</p>
              <ul className="link-list">
                {outgoing.map((edge) => (
                  <li key={`${edge.target}-${edge.refIndex}`}>
                    <PaperLink entry={props.entries.get(edge.target)} onOpen={props.onOpenEntry} detail={edge.match === "exact" ? `via ${edge.via}` : "probable match"} />
                    {edge.contexts?.[0] ? (
                      <q className="citation-context">
                        <ScientificText>{edge.contexts[0].text}</ScientificText>
                        <button type="button" className="page-link" onClick={() => openAt(edge.contexts[0].page, edge.contexts[0].text)}>p. {edge.contexts[0].page}</button>
                      </q>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {incoming.length ? (
            <section>
              <p className="eyebrow">Cited by in your library</p>
              <ul className="link-list">
                {incoming.map((edge) => (
                  <li key={`${edge.source}-${edge.refIndex}`}>
                    <PaperLink entry={props.entries.get(edge.source)} onOpen={props.onOpenEntry} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {neighbors.length ? (
            <section>
              <p className="eyebrow">Closest papers</p>
              <ul className="link-list">
                {neighbors.slice(0, 6).map((neighbor) => (
                  <li key={neighbor.id}>
                    <PaperLink
                      entry={props.entries.get(neighbor.id)}
                      onOpen={props.onOpenEntry}
                      detail={neighbor.coupling > neighbor.text ? "shared references" : "shared vocabulary"}
                    />
                  </li>
                ))}
              </ul>
              <p className="fine-print">Citations are bibliographic facts; closeness is a similarity score. Neither states agreement.</p>
            </section>
          ) : null}
          {!relations.length && !outgoing.length && !incoming.length && !neighbors.length ? (
            <p className="muted">No links found yet.</p>
          ) : null}
        </div>
      ) : null}

      {tab === "card" && paper ? (
        <div className="tab-panel">
          {state.knowledgeCard?.paperId === paper.id ? (
            state.knowledgeCard.error ? <p className="inline-error">{state.knowledgeCard.error}</p> : (
              <>
                {state.knowledgeCard.sections.map((section) => (
                  <section key={section.id} className="card-section">
                    <p className="eyebrow">{section.title}</p>
                    <div className="card-text"><ScientificText>{section.content}</ScientificText></div>
                  </section>
                ))}
                {state.knowledgeCard.evidence.length ? (
                  <section className="card-section">
                    <p className="eyebrow">Evidence</p>
                    <ul className="evidence-list">
                      {state.knowledgeCard.evidence.map((item) => (
                        <li key={item.id}><b>{item.id}</b> {item.locator ? <span className="mono">{item.locator}</span> : null} {item.text}</li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </>
            )
          ) : <p className="muted">Loading the knowledge card…</p>}
        </div>
      ) : null}

      <div className="inspector-actions">
        <button type="button" className="secondary-button" onClick={() => openAt(brief?.keyPoints[0]?.page || 1)}>Open PDF</button>
        {entry.item ? (
          <button type="button" className="secondary-button" onClick={() => state.actions.revealLibraryItem(entry.id, entry.item?.sourceType === "arxiv")}>
            {entry.item.sourceType === "arxiv" ? "arXiv page" : "Show source"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function GalaxyInspector({ galaxyId, props }: { galaxyId: string; props: InspectorProps }) {
  const galaxy = props.model.galaxyById.get(galaxyId);
  const library = props.state.tier0.library;
  const path = useMemo(
    () => galaxy ? readingPath(galaxy.paperIds, library?.citationEdges || [], props.entries) : [],
    [galaxy, library?.citationEdges, props.entries],
  );
  if (!galaxy) return null;
  const region = props.model.regionById.get(galaxy.regionId);
  const members = galaxy.paperIds.map((id) => props.entries.get(id)).filter((entry): entry is LibraryEntry => Boolean(entry));
  const foundational = [...members].filter((entry) => entry.centrality > 0).sort((a, b) => b.centrality - a.centrality).slice(0, 4);
  const phrases = new Map<string, number>();
  for (const member of members) {
    for (const phrase of library?.keyphrases?.[member.id] || []) {
      phrases.set(phrase.phrase, (phrases.get(phrase.phrase) || 0) + phrase.weight);
    }
  }
  const topPhrases = [...phrases.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const unsummarized = members.filter((entry) => entry.brief && !props.state.digests.has(entry.id)).map((entry) => entry.id);
  return (
    <div className="inspector-body">
      <PanelHeader eyebrow={`${galaxy.provisional ? "Automatic galaxy" : "Galaxy"} · ${region?.label || ""}`} title={galaxy.label} />
      <div className="stats">
        <div><b>{members.length}</b><span>papers</span></div>
        <div><b>{members.filter((entry) => entry.tier === 2).length}</b><span>verified</span></div>
        <div><b>{members.filter((entry) => entry.tier === 0).length}</b><span>unreviewed</span></div>
      </div>
      {topPhrases.length ? (
        <section>
          <p className="eyebrow">Shared vocabulary</p>
          <div className="phrase-cloud">{topPhrases.map(([phrase]) => <span key={phrase} className="chip">{phrase}</span>)}</div>
        </section>
      ) : null}
      {foundational.length ? (
        <section>
          <p className="eyebrow">Foundational here</p>
          <ul className="link-list">
            {foundational.map((entry) => <li key={entry.id}><PaperLink entry={entry} onOpen={props.onOpenEntry} detail={`cited ×${entry.centrality}`} /></li>)}
          </ul>
        </section>
      ) : null}
      <section>
        <p className="eyebrow">Reading path</p>
        <ol className="reading-path">
          {path.map((id) => <li key={id}><PaperLink entry={props.entries.get(id)} onOpen={props.onOpenEntry} /></li>)}
        </ol>
        <p className="fine-print">Ordered so that cited papers come before the papers that build on them.</p>
      </section>
      {props.state.intelligence.available && unsummarized.length ? (
        <button type="button" className="secondary-button full" onClick={() => props.state.actions.summarize(unsummarized)}>
          Summarize {unsummarized.length} {unsummarized.length === 1 ? "paper" : "papers"} with Apple Intelligence
        </button>
      ) : null}
    </div>
  );
}

function RegionInspector({ regionId, props }: { regionId: string; props: InspectorProps }) {
  const region = props.model.regionById.get(regionId);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  if (!region) return null;
  const notes = props.memoriesByRegion.get(regionId) || [];
  const { workspace, graph, actions } = props.state;
  return (
    <div className="inspector-body">
      <PanelHeader eyebrow={region.provisional ? "Automatic region · not reviewed" : "Region"} title={region.label} />
      <div className="stats">
        <div><b>{region.paperCount}</b><span>papers</span></div>
        <div><b>{region.galaxyIds.length}</b><span>galaxies</span></div>
        <div><b>{notes.length}</b><span>notes</span></div>
      </div>
      <section>
        <p className="eyebrow">Galaxies</p>
        <ul className="link-list">
          {region.galaxyIds.map((id) => {
            const galaxy = props.model.galaxyById.get(id);
            return galaxy ? (
              <li key={id}>
                <button type="button" className="paper-link" onClick={() => props.onFocus({ level: "galaxy", galaxyId: id })}>
                  <span className="paper-link-title">{galaxy.label}</span>
                  <span className="paper-link-detail">{galaxy.paperIds.length}</span>
                </button>
              </li>
            ) : null;
          })}
        </ul>
      </section>
      {!region.provisional ? (
        <section>
          <p className="eyebrow">Research notes</p>
          <ul className="link-list">
            {notes.map((note) => {
              const id = note.memoryId || note.id || "";
              return (
                <li key={id}>
                  <button type="button" className="paper-link" onClick={() => props.onSelectNote(regionId, id)}>
                    <span className="paper-link-title">{note.presentation?.title || note.title || "Untitled note"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <input className="text-input" placeholder="Note title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <textarea className="note-editor" rows={4} placeholder="A decision, convention, or open question for this region" value={content} onChange={(event) => setContent(event.target.value)} />
          <div className="row-actions">
            <button type="button" className="secondary-button" onClick={() => actions.importNote({ projectId: workspace.projects.activeProjectId, memoryRevision: workspace.projectMemory.revision, graphRevision: graph.revision ?? 0, categoryId: regionId })}>
              Import .md
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!title.trim() || !content.trim()}
              onClick={() => {
                actions.saveNote({
                  projectId: workspace.projects.activeProjectId,
                  memoryRevision: workspace.projectMemory.revision,
                  graphRevision: graph.revision ?? 0,
                  categoryId: regionId,
                  title: title.trim(),
                  content,
                  format: "markdown",
                });
                setTitle("");
                setContent("");
              }}
            >
              Add note
            </button>
          </div>
        </section>
      ) : (
        <p className="fine-print">
          Automatic regions group unreviewed papers by shared references and vocabulary. They become reviewed regions
          when an AI curation pass assigns the papers.
        </p>
      )}
    </div>
  );
}

function NoteInspector({ regionId, memoryId, props }: { regionId: string; memoryId: string; props: InspectorProps }) {
  const note = (props.memoriesByRegion.get(regionId) || []).find((item) => (item.memoryId || item.id) === memoryId);
  if (!note) return <RegionInspector regionId={regionId} props={props} />;
  const { workspace, graph, actions } = props.state;
  const provenance = Array.isArray(note.provenance) ? note.provenance.join(", ") : note.provenance;
  return (
    <div className="inspector-body">
      <PanelHeader eyebrow={`Note · ${props.model.regionById.get(regionId)?.label || ""}`} title={note.presentation?.title || note.title || "Untitled note"} onClose={props.onClose} />
      <div className="chips">
        <span className="chip">{note.evidenceState.replaceAll("_", " ")}</span>
        <span className="chip">{provenance}</span>
      </div>
      <div className="note-content"><ScientificText>{note.content || note.statement || ""}</ScientificText></div>
      <div className="row-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            actions.retireNote({ projectId: workspace.projects.activeProjectId, memoryRevision: workspace.projectMemory.revision, graphRevision: graph.revision ?? 0, categoryId: regionId, memoryId });
            props.onClose();
          }}
        >
          Retire note
        </button>
      </div>
      <p className="fine-print">Retiring keeps the note in the append-only history but removes it from the region.</p>
    </div>
  );
}

function RelationInspector({ relationKey, props }: { relationKey: string; props: InspectorProps }) {
  const lanes = props.hierarchy.relationLanes.filter((lane) => lane.key === relationKey);
  if (!lanes.length) return null;
  const source = props.model.galaxyById.get(lanes[0].sourceGalaxyId);
  const target = props.model.galaxyById.get(lanes[0].targetGalaxyId);
  const describe = (relation: Relation) => {
    const strength = normalizedPercent(relation.strength);
    const confidence = normalizedPercent(relation.confidence);
    return [relationDisplayState(relation), strength !== undefined ? `strength ${Math.round(strength)}%` : null, confidence !== undefined ? `confidence ${Math.round(confidence)}%` : null].filter(Boolean).join(" · ");
  };
  return (
    <div className="inspector-body">
      <PanelHeader eyebrow="Relationship lanes" title={`${source?.label || "?"} ↔ ${target?.label || "?"}`} onClose={props.onClose} />
      <ul className="relation-list">
        {lanes.map((lane) => (
          <li key={lane.id}>
            <p className="relation-title">{RELATION_LABELS[lane.relation.type] || lane.relation.label || lane.relation.type}</p>
            <p className="fine-print">{describe(lane.relation)}</p>
            <div className="relation-papers">
              <PaperLink entry={props.entries.get(lane.relation.source)} onOpen={props.onOpenEntry} />
              <PaperLink entry={props.entries.get(lane.relation.target)} onOpen={props.onOpenEntry} />
            </div>
            {lane.relation.note ? <p><ScientificText>{lane.relation.note}</ScientificText></p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function UniverseInspector({ props }: { props: InspectorProps }) {
  const entries = [...props.entries.values()];
  const foundational = entries.filter((entry) => entry.centrality > 0).sort((a, b) => b.centrality - a.centrality).slice(0, 6);
  const unreviewed = entries.filter((entry) => entry.tier === 0).length;
  const edges = props.state.tier0.library?.citationEdges.length || 0;
  return (
    <div className="inspector-body">
      <PanelHeader eyebrow="Overview" title="Your universe" />
      <div className="stats">
        <div><b>{entries.length}</b><span>papers</span></div>
        <div><b>{props.model.galaxies.length}</b><span>galaxies</span></div>
        <div><b>{edges}</b><span>citation links</span></div>
      </div>
      {unreviewed > 0 ? (
        <section className="callout">
          <p><b>{unreviewed}</b> {unreviewed === 1 ? "paper is" : "papers are"} extracted but not reviewed.</p>
          <p className="fine-print">
            Skim them in Desk → Triage. For reviewed cards and verified relationships, ask your AI assistant to run
            the Liteverse Curator on one galaxy at a time.
          </p>
        </section>
      ) : null}
      {foundational.length ? (
        <section>
          <p className="eyebrow">Most cited in your library</p>
          <ul className="link-list">
            {foundational.map((entry) => <li key={entry.id}><PaperLink entry={entry} onOpen={props.onOpenEntry} detail={`cited ×${entry.centrality}`} /></li>)}
          </ul>
        </section>
      ) : null}
      <p className="fine-print">Drag to orbit · pinch or ⌘-scroll to zoom · two-finger scroll to pan · ⌘K to search.</p>
    </div>
  );
}

export function Inspector(props: InspectorProps) {
  const { selection, focus } = props;
  let content: React.ReactNode;
  if (selection?.kind === "entry") {
    const entry = props.entries.get(selection.id);
    content = entry ? <PaperInspector entry={entry} props={props} /> : null;
  } else if (selection?.kind === "relation") {
    content = <RelationInspector relationKey={selection.key} props={props} />;
  } else if (selection?.kind === "note") {
    content = <NoteInspector regionId={selection.regionId} memoryId={selection.memoryId} props={props} />;
  } else if (selection?.kind === "notes" || focus.level === "notes") {
    const regionId = selection?.kind === "notes" ? selection.regionId : focus.level === "notes" ? focus.regionId : "";
    content = <RegionInspector regionId={regionId} props={props} />;
  } else if (focus.level === "galaxy") {
    content = <GalaxyInspector galaxyId={focus.galaxyId} props={props} />;
  } else if (focus.level === "region") {
    content = <RegionInspector regionId={focus.regionId} props={props} />;
  } else {
    content = <UniverseInspector props={props} />;
  }
  return <aside className="inspector" aria-label="Inspector">{content}</aside>;
}
