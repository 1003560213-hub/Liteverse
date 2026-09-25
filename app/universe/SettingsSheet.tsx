import { useEffect, useState } from "react";
import type { PartitionProposal as PartitionProposals } from "../../scripts/lib/liteverse-tier0.mjs";
import type { LibraryEntry } from "./library-model";
import type { SkyQuality } from "./sky/SkyScene";
import type { Category } from "./types";
import type { LiteverseState } from "./useLiteverse";
import { projectBriefText, type LibraryItem } from "./workspace";

export type SettingsTab = "library" | "project" | "layout" | "intelligence" | "display";

type SettingsSheetProps = {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onClose: () => void;
  state: LiteverseState;
  entries: readonly LibraryEntry[];
  partitions: PartitionProposals | null;
  layoutOptionId: string | null;
  onLayoutOptionChange: (id: string | null) => void;
  qualityPreference: "auto" | SkyQuality;
  onQualityPreferenceChange: (value: "auto" | SkyQuality) => void;
  ambientPreference: boolean;
  onAmbientPreferenceChange: (value: boolean) => void;
  heatScope: "project" | "global";
  onHeatScopeChange: (value: "project" | "global") => void;
  effectiveQuality: SkyQuality;
  macroCategories: Category[];
};

const TABS: Array<[SettingsTab, string]> = [
  ["library", "Library"],
  ["project", "Project"],
  ["layout", "Layout"],
  ["intelligence", "Intelligence"],
  ["display", "Display"],
];

const ARXIV_PATTERN = /^(?:https:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)?(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?(?:\.pdf)?$/i;

function itemState(item: LibraryItem) {
  if (item.preparation?.state === "queued") return "Reading PDF";
  if (item.preparation?.extractionStatus === "needs_ocr") return "Scanned PDF: text recognition failed";
  if (item.preparation?.state === "needs_attention") return item.preparation.reason || "Preparation needs attention";
  if (item.disposition === "duplicate") return "Duplicate of an existing paper";
  if (item.status === "needs_attention") return "Needs attention";
  if (item.status === "ready_to_refresh") return "Reviewed · waiting to be applied";
  if (item.status === "organized") return "In the universe";
  return "Extracted · unreviewed";
}

function LibraryTab({ state }: SettingsSheetProps) {
  const [arxiv, setArxiv] = useState("");
  const [includePDFs, setIncludePDFs] = useState(false);
  const { workspace, actions, busy } = state;
  const queue = workspace.library.items.filter((item) => item.catalogSource !== "universe" && item.status !== "organized");
  const attention = queue.filter((item) => item.status === "needs_attention" || item.preparation?.state === "needs_attention");
  const arxivValid = ARXIV_PATTERN.test(arxiv.trim());
  return (
    <div className="sheet-panel">
      <section className="sheet-section">
        <h3>Add literature</h3>
        <p className="fine-print">
          PDFs are read on this Mac. Linked folders and Zotero attachments stay where they are; Liteverse stores only
          their path and fingerprint.
        </p>
        <div className="button-grid">
          <button type="button" className="primary-button" disabled={busy === "pdf"} onClick={actions.importPDF}>Import PDFs…</button>
          <button type="button" className="secondary-button" disabled={busy === "folder"} onClick={actions.linkFolder}>Link a folder…</button>
          <button type="button" className="secondary-button" disabled={busy === "folder"} onClick={actions.connectZotero}>Connect Zotero…</button>
        </div>
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!arxivValid) return;
            actions.addArxiv(arxiv.trim());
            setArxiv("");
          }}
        >
          <input
            className="text-input"
            placeholder="arXiv ID or URL, e.g. 2101.01234"
            value={arxiv}
            onChange={(event) => setArxiv(event.target.value)}
            aria-label="arXiv identifier"
          />
          <button type="submit" className="secondary-button" disabled={!arxivValid || busy === "arxiv"}>Add</button>
        </form>
        <p className="fine-print">An arXiv link downloads only that paper and its official metadata.</p>
      </section>

      <section className="sheet-section">
        <div className="section-heading">
          <h3>Intake queue</h3>
          {attention.length > 1 ? (
            <button type="button" className="secondary-button" onClick={() => actions.retryAllPreparation(attention.map((item) => ({ id: item.id, revision: item.revision })))}>
              Retry all {attention.length}
            </button>
          ) : null}
        </div>
        {queue.length === 0 ? <p className="muted">Nothing waiting. Every imported paper is in the universe.</p> : (
          <ul className="queue-list">
            {queue.slice(0, 200).map((item) => {
              const failed = item.status === "needs_attention" || item.preparation?.state === "needs_attention";
              return (
                <li key={item.id} className={failed ? "is-attention" : undefined}>
                  <span className="queue-title">{item.displayTitle}</span>
                  <span className="queue-state">{itemState(item)}</span>
                  {failed ? <button type="button" className="link-button" onClick={() => actions.retryPreparation(item.id, item.revision)}>Retry</button> : null}
                </li>
              );
            })}
          </ul>
        )}
        {queue.length > 200 ? <p className="fine-print">Showing 200 of {queue.length}. Use Desk → Triage for the full list.</p> : null}
      </section>

      <section className="sheet-section">
        <h3>Backup</h3>
        <label className="checkbox">
          <input type="checkbox" checked={includePDFs} onChange={(event) => setIncludePDFs(event.target.checked)} />
          Include managed PDFs (linked PDFs are never copied)
        </label>
        <div className="button-grid">
          <button type="button" className="secondary-button" onClick={() => actions.exportBackup(includePDFs)}>Export backup…</button>
          <button type="button" className="secondary-button" onClick={actions.importBackup}>Verify and restore a backup…</button>
        </div>
        {workspace.health?.managedVaultPath ? <p className="fine-print mono">{workspace.health.managedVaultPath}</p> : null}
      </section>
    </div>
  );
}

function ProjectTab({ state }: SettingsSheetProps) {
  const { workspace, actions } = state;
  const [brief, setBrief] = useState(() => projectBriefText(workspace.researchInformation));
  const [dirty, setDirty] = useState(false);
  const [newProject, setNewProject] = useState("");
  useEffect(() => {
    if (!dirty) setBrief(projectBriefText(workspace.researchInformation));
  }, [dirty, workspace.researchInformation]);
  useEffect(() => {
    setDirty(false);
  }, [workspace.projects.activeProjectId]);
  const memory = workspace.projectMemory.items.filter((item) => item.state === "active" && item.type !== "project_context" && item.presentation?.kind !== "note");
  return (
    <div className="sheet-panel">
      <section className="sheet-section">
        <h3>Project</h3>
        <div className="inline-form">
          <select value={workspace.projects.activeProjectId} onChange={(event) => actions.selectProject(event.target.value)} aria-label="Active project">
            {workspace.projects.items.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <input className="text-input" placeholder="New project name" value={newProject} onChange={(event) => setNewProject(event.target.value)} aria-label="New project name" />
          <button type="button" className="secondary-button" disabled={!newProject.trim()} onClick={() => { actions.createProject(newProject); setNewProject(""); }}>Create</button>
        </div>
        <p className="fine-print">Papers are shared across projects. Notes, research heat, and memory belong to one project.</p>
      </section>
      <section className="sheet-section">
        <h3>Project brief</h3>
        <p className="fine-print">Goals, conventions, assumptions, and open questions. Saved as your own declaration in the project’s append-only memory.</p>
        <textarea
          className="note-editor"
          rows={8}
          value={brief}
          onChange={(event) => { setBrief(event.target.value); setDirty(true); }}
          aria-label="Project brief"
        />
        <div className="row-actions">
          <button
            type="button"
            className="primary-button"
            disabled={!dirty || !brief.trim() || state.busy === "brief"}
            onClick={() => {
              actions.saveProjectBrief(brief, workspace.projects.activeProjectId, workspace.researchInformation.draft.revision);
              setDirty(false);
            }}
          >
            Save brief
          </button>
        </div>
      </section>
      {memory.length ? (
        <section className="sheet-section">
          <h3>Structured memory</h3>
          <ul className="memory-list">
            {memory.slice(0, 60).map((item) => (
              <li key={item.memoryId || item.id}>
                <span className="chip">{item.type.replaceAll("_", " ")}</span>
                <span>{item.title || item.statement}</span>
                <span className="fine-print">{item.evidenceState.replaceAll("_", " ")}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {workspace.tasks.length || workspace.artifacts.length || workspace.contextPacks.length ? (
        <section className="sheet-section">
          <h3>AI task history</h3>
          <p className="fine-print">
            {workspace.tasks.length} tasks · {workspace.contextPacks.length} context packs · {workspace.artifacts.length} code or experiment records,
            written by the Liteverse Skills.
          </p>
          <details>
            <summary>Show recent tasks</summary>
            <ul className="memory-list">
              {workspace.tasks.slice(0, 20).map((task) => (
                <li key={task.taskHash}><span className="mono">{task.taskHash.slice(0, 10)}</span> <span>{task.summary || task.status}</span></li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}
    </div>
  );
}

function LayoutTab(props: SettingsSheetProps) {
  const { partitions, layoutOptionId, onLayoutOptionChange, state } = props;
  const curator = state.workspace.partitionProposals;
  return (
    <div className="sheet-panel">
      <section className="sheet-section">
        <h3>Automatic regions</h3>
        <p className="fine-print">
          Unreviewed papers are grouped by shared references (bibliographic coupling), co-citation, and shared
          vocabulary. Choose the organizing principle you prefer; reviewed regions are never moved.
        </p>
        {partitions ? (
          <div className="option-list" role="radiogroup" aria-label="Automatic layout">
            <label className={`option${layoutOptionId === null ? " is-selected" : ""}`}>
              <input type="radio" name="layout" checked={layoutOptionId === null} onChange={() => onLayoutOptionChange(null)} />
              <span className="option-title">Default clusters</span>
              <span className="fine-print">Balanced mix of citations and vocabulary.</span>
            </label>
            {partitions.options.map((option) => (
              <label key={option.id} className={`option${layoutOptionId === option.id ? " is-selected" : ""}`}>
                <input type="radio" name="layout" checked={layoutOptionId === option.id} onChange={() => onLayoutOptionChange(option.id)} />
                <span className="option-title">{option.principle}</span>
                <span className="fine-print">{option.regions.length} regions · {option.regions.map((region) => `${region.label} (${region.paperIds.length})`).slice(0, 5).join(", ")}{option.regions.length > 5 ? "…" : ""}</span>
              </label>
            ))}
            {!partitions.materiallyDistinct ? <p className="fine-print">{partitions.notes || "The options differ only slightly for this library."}</p> : null}
          </div>
        ) : <p className="muted">Automatic layouts appear once key points have been extracted.</p>}
      </section>
      {curator ? (
        <section className="sheet-section">
          <h3>Curator proposal awaiting your choice</h3>
          <p className="fine-print">{curator.searchSummary}</p>
          <ol className="curator-options">
            {curator.options.map((option) => (
              <li key={option.optionId}>
                <b>{option.name}</b> — {option.summary}
              </li>
            ))}
          </ol>
          <p className="fine-print">Tell your AI assistant which option to apply. The Curator records the choice and stages the update for you to apply here.</p>
        </section>
      ) : null}
    </div>
  );
}

function IntelligenceTab({ state, entries }: SettingsSheetProps) {
  const { intelligence, digests, digestQueue, tier0, actions } = state;
  const unsummarized = entries.filter((entry) => entry.brief && !digests.has(entry.id)).map((entry) => entry.id);
  return (
    <div className="sheet-panel">
      <section className="sheet-section">
        <h3>Apple Intelligence</h3>
        <p className={intelligence.available ? "status-ok" : "muted"}>
          {intelligence.available ? `Available on this Mac${intelligence.model ? ` · ${intelligence.model}` : ""}` : intelligence.reason}
        </p>
        <p className="fine-print">
          Writes a short on-device summary for a paper from its verbatim key points. Nothing leaves your Mac. Summaries
          are drafts: they are labelled as such, never become evidence, and never change reviewed cards or Usage.
        </p>
        {intelligence.available ? (
          <div className="button-grid">
            <button type="button" className="primary-button" disabled={!unsummarized.length} onClick={() => actions.summarize(unsummarized)}>
              Summarize {unsummarized.length} {unsummarized.length === 1 ? "paper" : "papers"}
            </button>
            {digestQueue.length ? <button type="button" className="secondary-button" onClick={actions.cancelSummaries}>Stop ({digestQueue.length} queued)</button> : null}
          </div>
        ) : null}
        <p className="fine-print">{digests.size} summaries stored.</p>
      </section>
      <section className="sheet-section">
        <h3>Key-point extraction</h3>
        <p className="fine-print">
          Local and deterministic: abstract, key sentences with page numbers, quantities, references, and citation links.
          {` ${tier0.briefs.size} papers processed.`}
        </p>
        {tier0.error ? <p className="inline-error">{tier0.error}</p> : null}
        <button type="button" className="secondary-button" disabled={tier0.processing} onClick={actions.rebuildTier0}>
          {tier0.processing ? "Extracting…" : "Rebuild key points"}
        </button>
      </section>
    </div>
  );
}

function DisplayTab(props: SettingsSheetProps) {
  return (
    <div className="sheet-panel">
      <section className="sheet-section">
        <h3>Rendering quality</h3>
        <div className="option-list" role="radiogroup" aria-label="Rendering quality">
          {([
            ["auto", "Automatic", "Power saving on battery, in Low Power Mode, or when the Mac is hot; Balanced otherwise."],
            ["efficient", "Power saving", "Fewest stars per galaxy, standard resolution, no ambient motion."],
            ["balanced", "Balanced", "Detailed galaxies at 1.5× resolution with slow rotation."],
            ["high", "High", "Full detail at Retina resolution. Best on a connected power adapter."],
          ] as const).map(([value, label, detail]) => (
            <label key={value} className={`option${props.qualityPreference === value ? " is-selected" : ""}`}>
              <input type="radio" name="quality" checked={props.qualityPreference === value} onChange={() => props.onQualityPreferenceChange(value)} />
              <span className="option-title">{label}</span>
              <span className="fine-print">{detail}</span>
            </label>
          ))}
        </div>
        <p className="fine-print">Currently: {props.effectiveQuality}.</p>
      </section>
      <section className="sheet-section">
        <label className="checkbox">
          <input type="checkbox" checked={props.ambientPreference} onChange={(event) => props.onAmbientPreferenceChange(event.target.checked)} />
          Let galaxies rotate slowly when the Mac is on power (never on battery or with Reduce Motion)
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={props.heatScope === "global"} onChange={(event) => props.onHeatScopeChange(event.target.checked ? "global" : "project")} />
          Research heat counts use across all projects
        </label>
      </section>
    </div>
  );
}

export function SettingsSheet(props: SettingsSheetProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props]);
  return (
    <div className="sheet-backdrop" onMouseDown={props.onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-header">
          <h2>Settings</h2>
          <div className="tabs" role="tablist">
            {TABS.map(([value, label]) => (
              <button key={value} type="button" role="tab" aria-selected={props.tab === value} onClick={() => props.onTabChange(value)}>{label}</button>
            ))}
          </div>
          <button type="button" className="icon-button panel-close" aria-label="Close settings" onClick={props.onClose}>×</button>
        </div>
        {props.state.error ? <p className="inline-error">{props.state.error}</p> : null}
        {props.state.notice ? <p className="inline-notice">{props.state.notice}</p> : null}
        {props.tab === "library" ? <LibraryTab {...props} /> : null}
        {props.tab === "project" ? <ProjectTab {...props} /> : null}
        {props.tab === "layout" ? <LayoutTab {...props} /> : null}
        {props.tab === "intelligence" ? <IntelligenceTab {...props} /> : null}
        {props.tab === "display" ? <DisplayTab {...props} /> : null}
      </div>
    </div>
  );
}
