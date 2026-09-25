import { useCallback, useEffect, useMemo, useState } from "react";
import { proposePartitions } from "../../scripts/lib/liteverse-tier0.mjs";
import { Atlas } from "./Atlas";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { Desk, type DeskView } from "./Desk";
import { buildGalaxyHierarchy, memoriesByCategory, type PersonalMemory } from "./hierarchy";
import { Inspector, type InspectorSelection } from "./Inspector";
import {
  buildLibraryEntries,
  provisionalLayoutFor,
  skyMetaFor,
  TIER_LABELS,
  type LibraryEntry,
} from "./library-model";
import { SettingsSheet, type SettingsTab } from "./SettingsSheet";
import { buildSkyModel, type FilamentKind } from "./sky/model";
import type { SkyFocus, SkyLens, SkyQuality, SkyTarget } from "./sky/SkyScene";
import { SkyView, type SkyLabel } from "./SkyView";
import { relationDisplayState } from "./types";
import { useLiteverse } from "./useLiteverse";
import { useStoredState } from "./useStoredState";

type Mode = "sky" | "desk";
type QualityPreference = "auto" | SkyQuality;

const LENS_LABELS: Record<SkyLens, string> = {
  tier: "Evidence tier",
  heat: "Research heat",
  year: "Publication year",
  centrality: "Citation centrality",
};

function useReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function useDocumentVisible() {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function LiteratureUniverse() {
  const [mode, setMode] = useStoredState<Mode>("liteverse.mode", "sky");
  const [deskView, setDeskView] = useStoredState<DeskView>("liteverse.deskView", "triage");
  const [atlasOpen, setAtlasOpen] = useStoredState("liteverse.atlasOpen", true);
  const [inspectorOpen, setInspectorOpen] = useStoredState("liteverse.inspectorOpen", true);
  const [lens, setLens] = useStoredState<SkyLens>("liteverse.lens", "tier");
  const [heatScope, setHeatScope] = useStoredState<"project" | "global">("liteverse.heatScope", "project");
  const [qualityPreference, setQualityPreference] = useStoredState<QualityPreference>("liteverse.quality", "auto");
  const [ambientPreference, setAmbientPreference] = useStoredState("liteverse.ambient", true);
  const [layoutOptionId, setLayoutOptionId] = useStoredState<string | null>("liteverse.layoutOption", null);
  const [focus, setFocus] = useState<SkyFocus>({ level: "universe" });
  const [selection, setSelection] = useState<InspectorSelection>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [zoomCommand, setZoomCommand] = useState<{ kind: "in" | "out" | "reset"; nonce: number } | null>(null);
  const reducedMotion = useReducedMotion();
  const documentVisible = useDocumentVisible();

  const goBack = useCallback(() => {
    if (selection) {
      setSelection(null);
      return;
    }
    setFocus((current) => {
      if (current.level === "galaxy" || current.level === "notes") {
        const regionId = current.level === "notes" ? current.regionId : null;
        return regionId ? { level: "region", regionId } : { level: "universe" };
      }
      return { level: "universe" };
    });
  }, [selection]);

  const handleCommand = useCallback((command: string) => {
    switch (command) {
      case "mode.sky": setMode("sky"); break;
      case "mode.desk": setMode("desk"); break;
      case "toggle.atlas": setAtlasOpen((open) => !open); break;
      case "toggle.inspector": setInspectorOpen((open) => !open); break;
      case "palette": setPaletteOpen(true); break;
      case "settings": setSettingsTab("library"); break;
      case "go.back": goBack(); break;
      case "go.universe": setSelection(null); setFocus({ level: "universe" }); break;
      case "zoom.in": setZoomCommand({ kind: "in", nonce: Date.now() }); break;
      case "zoom.out": setZoomCommand({ kind: "out", nonce: Date.now() }); break;
      case "zoom.reset": setZoomCommand({ kind: "reset", nonce: Date.now() }); break;
      default: break;
    }
  }, [goBack, setAtlasOpen, setInspectorOpen, setMode]);

  const state = useLiteverse(handleCommand);
  const { graph, workspace, tier0, power, actions } = state;

  // ------------------------------------------------------------ derived

  const hierarchy = useMemo(() => buildGalaxyHierarchy(graph), [graph]);
  const entries = useMemo(() => buildLibraryEntries({
    graph,
    hierarchy,
    workspace,
    briefs: tier0.briefs,
    library: tier0.library,
    heatScope,
  }), [graph, heatScope, hierarchy, tier0.briefs, tier0.library, workspace]);
  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);

  const partitions = useMemo(() => {
    if (!tier0.library || tier0.library.paperIds.length === 0) return null;
    try {
      return proposePartitions(tier0.library);
    } catch {
      return null;
    }
  }, [tier0.library]);
  const chosenOption = partitions?.options.find((option) => option.id === layoutOptionId) || null;
  const provisional = useMemo(
    () => provisionalLayoutFor(entries, tier0.library, chosenOption),
    [chosenOption, entries, tier0.library],
  );

  const macroCategories = useMemo(() => graph.categories.filter((category) => category.kind !== "system"), [graph.categories]);
  const memoriesByRegion = useMemo(
    () => memoriesByCategory(workspace.projectMemory.items as PersonalMemory[], macroCategories, graph.papers),
    [graph.papers, macroCategories, workspace.projectMemory.items],
  );
  const noteCountByCategory = useMemo(
    () => new Map([...memoriesByRegion.entries()].map(([id, items]) => [id, items.length])),
    [memoriesByRegion],
  );

  const relationLanes = useMemo(() => hierarchy.relationLanes
    .map((lane) => ({ lane, state: relationDisplayState(lane.relation) }))
    .filter((item) => item.state !== "suggestion")
    .map(({ lane, state: laneState }) => ({
      key: lane.key,
      sourceGalaxyId: lane.sourceGalaxyId,
      targetGalaxyId: lane.targetGalaxyId,
      state: laneState as FilamentKind,
    })), [hierarchy.relationLanes]);

  const skyModel = useMemo(() => buildSkyModel({
    graph,
    hierarchy,
    provisional,
    paperMeta: skyMetaFor(entries),
    citationEdges: tier0.library?.citationEdges || [],
    relationLanes,
    noteCountByCategory,
  }), [entries, graph, hierarchy, noteCountByCategory, provisional, relationLanes, tier0.library]);

  // Keep focus valid when data changes.
  useEffect(() => {
    if (focus.level === "galaxy" && !skyModel.galaxyById.has(focus.galaxyId)) setFocus({ level: "universe" });
    if ((focus.level === "region" || focus.level === "notes") && !skyModel.regionById.has(focus.regionId)) setFocus({ level: "universe" });
  }, [focus, skyModel]);

  const selectedEntry = selection?.kind === "entry" ? entryById.get(selection.id) || null : null;

  // ------------------------------------------------------------ navigation

  const openEntry = useCallback((id: string, options: { reveal?: boolean } = {}) => {
    setSelection({ kind: "entry", id });
    setInspectorOpen(true);
    const galaxy = skyModel.galaxyByPaperId.get(id);
    if (galaxy && options.reveal !== false) setFocus({ level: "galaxy", galaxyId: galaxy.id });
  }, [setInspectorOpen, skyModel.galaxyByPaperId]);

  const activate = useCallback((target: SkyTarget | null) => {
    if (!target) {
      setSelection(null);
      return;
    }
    if (target.kind === "region") {
      setSelection(null);
      setFocus({ level: "region", regionId: target.id });
    } else if (target.kind === "galaxy") {
      setSelection(null);
      setFocus({ level: "galaxy", galaxyId: target.id });
    } else if (target.kind === "paper") {
      openEntry(target.id, { reveal: false });
    } else if (target.kind === "black-hole") {
      setSelection({ kind: "notes", regionId: target.regionId });
      setFocus({ level: "notes", regionId: target.regionId });
      setInspectorOpen(true);
    } else if (target.kind === "filament" && target.relationKey) {
      setSelection({ kind: "relation", key: target.relationKey });
      setInspectorOpen(true);
    }
  }, [openEntry, setInspectorOpen]);

  // Global keyboard shortcuts (menus send the same commands natively).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.metaKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (event.metaKey && event.key === ",") {
        event.preventDefault();
        setSettingsTab("library");
        return;
      }
      if (event.metaKey && (event.key === "1" || event.key === "2")) {
        event.preventDefault();
        setMode(event.key === "1" ? "sky" : "desk");
        return;
      }
      if (event.metaKey && event.key === "[") {
        event.preventDefault();
        goBack();
        return;
      }
      if (!typing && event.key === "/" && !paletteOpen) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goBack, paletteOpen, setMode]);

  // ------------------------------------------------------------ labels

  const labels = useMemo<SkyLabel[]>(() => {
    const result: SkyLabel[] = [];
    if (focus.level === "universe") {
      for (const region of skyModel.regions) {
        result.push({
          id: region.id,
          text: region.label,
          detail: `${region.paperCount} ${region.paperCount === 1 ? "paper" : "papers"}${region.provisional ? " · automatic" : ""}`,
          kind: "region",
          position: region.center,
          radius: region.radius * 0.85,
          provisional: region.provisional,
          emphasis: true,
        });
      }
      return result;
    }
    const regionId = focus.level === "galaxy"
      ? skyModel.galaxyById.get(focus.galaxyId)?.regionId
      : focus.regionId;
    const region = regionId ? skyModel.regionById.get(regionId) : undefined;
    if (focus.level === "region" || focus.level === "notes") {
      for (const galaxyId of region?.galaxyIds || []) {
        const galaxy = skyModel.galaxyById.get(galaxyId);
        if (!galaxy) continue;
        result.push({
          id: galaxy.id,
          text: galaxy.label,
          detail: `${galaxy.paperIds.length} ${galaxy.paperIds.length === 1 ? "paper" : "papers"}`,
          kind: "galaxy",
          position: galaxy.position,
          radius: galaxy.radius,
          provisional: galaxy.provisional,
        });
      }
      if (region && region.noteCount > 0) {
        result.push({
          id: region.id,
          text: `${region.noteCount} ${region.noteCount === 1 ? "note" : "notes"}`,
          kind: "black-hole",
          position: region.center,
          radius: 0.35,
          emphasis: true,
        });
      }
      return result;
    }
    const galaxy = skyModel.galaxyById.get(focus.galaxyId);
    if (!galaxy) return result;
    const stars = galaxy.paperIds
      .map((id) => skyModel.starById.get(id))
      .filter((star): star is NonNullable<typeof star> => Boolean(star))
      .sort((left, right) => right.meta.centrality - left.meta.centrality || right.meta.heat - left.meta.heat);
    const selectedId = selection?.kind === "entry" ? selection.id : null;
    stars.slice(0, 18).forEach((star) => result.push({
      id: star.id,
      text: star.meta.shortTitle,
      detail: star.meta.year ? String(star.meta.year) : undefined,
      kind: "paper",
      position: star.position,
      radius: 0,
      emphasis: star.id === selectedId,
    }));
    if (selectedId && !result.some((label) => label.id === selectedId)) {
      const star = skyModel.starById.get(selectedId);
      if (star) result.push({ id: star.id, text: star.meta.shortTitle, kind: "paper", position: star.position, radius: 0, emphasis: true });
    }
    return result;
  }, [focus, selection, skyModel]);

  const keyboardTargets = useMemo(() => {
    const items: Array<{ target: SkyTarget; label: string }> = [];
    if (focus.level === "universe") {
      for (const region of skyModel.regions) {
        items.push({ target: { kind: "region", id: region.id }, label: `Region ${region.label}, ${region.paperCount} papers.` });
      }
    } else if (focus.level === "region" || focus.level === "notes") {
      const region = skyModel.regionById.get(focus.regionId);
      for (const galaxyId of region?.galaxyIds || []) {
        const galaxy = skyModel.galaxyById.get(galaxyId);
        if (galaxy) items.push({ target: { kind: "galaxy", id: galaxy.id }, label: `Galaxy ${galaxy.label}, ${galaxy.paperIds.length} papers.` });
      }
      if (region && region.noteCount > 0) {
        items.push({ target: { kind: "black-hole", regionId: region.id }, label: `Research notes for ${region.label}, ${region.noteCount}.` });
      }
    } else {
      const galaxy = skyModel.galaxyById.get(focus.galaxyId);
      for (const id of galaxy?.paperIds || []) {
        const entry = entryById.get(id);
        if (entry) items.push({ target: { kind: "paper", id }, label: `${TIER_LABELS[entry.tier]} paper, ${entry.shortTitle}.` });
      }
    }
    return items;
  }, [entryById, focus, skyModel]);

  // ------------------------------------------------------------ power

  const constrained = power.lowPowerMode || power.onBattery || power.thermalState === "serious" || power.thermalState === "critical";
  const quality: SkyQuality = qualityPreference === "auto" ? (constrained ? "efficient" : "balanced") : qualityPreference;
  const ambient = ambientPreference && !constrained && !power.occluded && documentVisible && mode === "sky";

  // ------------------------------------------------------------ status

  const counts = useMemo(() => {
    const result = { total: entries.length, extracted: 0, reviewed: 0, verified: 0 };
    for (const entry of entries) {
      if (entry.tier === 0) result.extracted += 1;
      else if (entry.tier === 1) result.reviewed += 1;
      else result.verified += 1;
    }
    return result;
  }, [entries]);
  const preparing = workspace.library.items.filter((item) => item.preparation?.state === "queued").length;
  const needsAttention = workspace.library.items.filter((item) => item.status === "needs_attention" || item.preparation?.state === "needs_attention");

  const breadcrumb = useMemo(() => {
    const parts: Array<{ label: string; onClick?: () => void }> = [{ label: "Universe", onClick: () => { setSelection(null); setFocus({ level: "universe" }); } }];
    const regionId = focus.level === "galaxy" ? skyModel.galaxyById.get(focus.galaxyId)?.regionId : focus.level === "universe" ? null : focus.regionId;
    const region = regionId ? skyModel.regionById.get(regionId) : null;
    if (region) parts.push({ label: region.label, onClick: () => { setSelection(null); setFocus({ level: "region", regionId: region.id }); } });
    if (focus.level === "galaxy") {
      const galaxy = skyModel.galaxyById.get(focus.galaxyId);
      if (galaxy) parts.push({ label: galaxy.label });
    }
    if (focus.level === "notes") parts.push({ label: "Notes" });
    return parts;
  }, [focus, skyModel]);

  const commands = useMemo<PaletteCommand[]>(() => [
    { id: "import", label: "Import PDFs…", hint: "⌘O", run: actions.importPDF },
    { id: "arxiv", label: "Add arXiv paper…", run: () => setSettingsTab("library") },
    { id: "folder", label: "Link a literature folder…", run: actions.linkFolder },
    { id: "sky", label: "Show Sky", hint: "⌘1", run: () => setMode("sky") },
    { id: "desk", label: "Show Desk", hint: "⌘2", run: () => setMode("desk") },
    { id: "triage", label: "Open Triage", run: () => { setMode("desk"); setDeskView("triage"); } },
    { id: "summarize", label: "Summarize unreviewed papers with Apple Intelligence", run: () => actions.summarize(entries.filter((entry) => entry.tier === 0 && entry.brief).map((entry) => entry.id)) },
    { id: "layout", label: "Choose automatic region layout…", run: () => setSettingsTab("layout") },
    { id: "project", label: "Project brief and notes…", run: () => setSettingsTab("project") },
    { id: "settings", label: "Settings…", hint: "⌘,", run: () => setSettingsTab("library") },
    ...(["tier", "heat", "year", "centrality"] as SkyLens[]).map((value) => ({
      id: `lens-${value}`,
      label: `Lens: ${LENS_LABELS[value]}`,
      run: () => setLens(value),
    })),
  ], [actions, entries, setDeskView, setLens, setMode]);

  const isEmpty = entries.length === 0 && state.hasGraph && preparing === 0;
  const activeProject = workspace.projects.items.find((project) => project.id === workspace.projects.activeProjectId);

  return (
    <main className={`app mode-${mode}${atlasOpen ? " has-atlas" : ""}${inspectorOpen ? " has-inspector" : ""}`}>
      <header className="toolbar">
        <div className="toolbar-leading">
          <button
            type="button"
            className="icon-button"
            aria-label={atlasOpen ? "Hide Atlas" : "Show Atlas"}
            aria-pressed={atlasOpen}
            onClick={() => setAtlasOpen((open) => !open)}
          >
            <SidebarIcon />
          </button>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">Liteverse</span>
          </div>
          <select
            className="project-select"
            aria-label="Active project"
            value={workspace.projects.activeProjectId}
            onChange={(event) => actions.selectProject(event.target.value)}
          >
            {workspace.projects.items.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </div>
        <nav className="breadcrumb" aria-label="Location">
          {breadcrumb.map((part, index) => (
            <span key={`${part.label}-${index}`} className="breadcrumb-part">
              {index > 0 ? <span className="breadcrumb-separator" aria-hidden="true">/</span> : null}
              {part.onClick && index < breadcrumb.length - 1
                ? <button type="button" onClick={part.onClick}>{part.label}</button>
                : <span aria-current={index === breadcrumb.length - 1 ? "location" : undefined}>{part.label}</span>}
            </span>
          ))}
        </nav>
        <div className="toolbar-trailing">
          <div className="segmented" role="tablist" aria-label="Workspace mode">
            <button type="button" role="tab" aria-selected={mode === "sky"} onClick={() => setMode("sky")}>Sky</button>
            <button type="button" role="tab" aria-selected={mode === "desk"} onClick={() => setMode("desk")}>Desk</button>
          </div>
          <label className="lens-select">
            <span className="visually-hidden">Lens</span>
            <select value={lens} onChange={(event) => setLens(event.target.value as SkyLens)} aria-label="Colour lens">
              {(Object.keys(LENS_LABELS) as SkyLens[]).map((value) => <option key={value} value={value}>{LENS_LABELS[value]}</option>)}
            </select>
          </label>
          <button type="button" className="search-button" onClick={() => setPaletteOpen(true)}>
            <SearchIcon />
            <span>Search</span>
            <kbd>⌘K</kbd>
          </button>
          <button type="button" className="icon-button" aria-label="Import PDFs" onClick={actions.importPDF}>
            <PlusIcon />
          </button>
          <button type="button" className="icon-button" aria-label="Settings" onClick={() => setSettingsTab("library")}>
            <GearIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={inspectorOpen ? "Hide Inspector" : "Show Inspector"}
            aria-pressed={inspectorOpen}
            onClick={() => setInspectorOpen((open) => !open)}
          >
            <InspectorIcon />
          </button>
        </div>
      </header>

      {atlasOpen ? (
        <Atlas
          model={skyModel}
          entries={entryById}
          focus={focus}
          selectedId={selectedEntry?.id || null}
          onFocus={(next) => { setSelection(null); setFocus(next); }}
          onOpenEntry={(id) => openEntry(id)}
        />
      ) : null}

      <section className="stage" aria-label={mode === "sky" ? "Sky" : "Desk"}>
        <div className="stage-sky" hidden={mode !== "sky"}>
          <SkyView
            model={skyModel}
            focus={focus}
            lens={lens}
            quality={quality}
            ambient={ambient}
            reducedMotion={reducedMotion}
            paused={mode !== "sky" || !documentVisible || power.occluded}
            selectedPaperId={selectedEntry?.id || null}
            highlightedPaperIds={EMPTY_SET}
            labels={labels}
            keyboardTargets={keyboardTargets}
            onActivate={activate}
            onBack={goBack}
            onAnnounce={setAnnouncement}
            zoomCommand={zoomCommand}
          />
          {isEmpty ? (
            <div className="empty-state">
              <p className="eyebrow">An empty deep field</p>
              <h1>Bring your literature</h1>
              <p>
                Add PDFs, an arXiv link, a folder, or your Zotero library. Liteverse reads each paper on this Mac,
                extracts its key points with page references, links papers that cite each other, and arranges them into
                regions and galaxies. No AI is required for this first pass.
              </p>
              <div className="empty-actions">
                <button type="button" className="primary-button" onClick={actions.importPDF}>Import PDFs</button>
                <button type="button" className="secondary-button" onClick={actions.linkFolder}>Link a folder</button>
                <button type="button" className="secondary-button" onClick={() => setSettingsTab("library")}>Add arXiv or Zotero</button>
              </div>
            </div>
          ) : null}
        </div>
        {mode === "desk" ? (
          <Desk
            view={deskView}
            onViewChange={setDeskView}
            entries={entries}
            model={skyModel}
            library={tier0.library}
            focus={focus}
            digests={state.digests}
            digestQueue={state.digestQueue}
            intelligenceAvailable={state.intelligence.available}
            selectedId={selectedEntry?.id || null}
            onOpenEntry={(id) => openEntry(id, { reveal: false })}
            onFocusGalaxy={(galaxyId) => setFocus({ level: "galaxy", galaxyId })}
            onSummarize={actions.summarize}
            onOpenPDF={actions.openPDFAt}
            onImport={actions.importPDF}
          />
        ) : null}
      </section>

      {inspectorOpen ? (
        <Inspector
          selection={selection}
          focus={focus}
          state={state}
          model={skyModel}
          entries={entryById}
          hierarchy={hierarchy}
          memoriesByRegion={memoriesByRegion}
          onClose={() => setSelection(null)}
          onOpenEntry={(id) => openEntry(id)}
          onFocus={(next) => { setSelection(null); setFocus(next); }}
          onSelectNote={(regionId, memoryId) => setSelection({ kind: "note", regionId, memoryId })}
        />
      ) : null}

      <footer className="status-strip" aria-label="Library status">
        <span className="status-item"><b>{counts.total}</b> papers</span>
        <span className="status-item tier-0"><i aria-hidden="true" /> {counts.extracted} extracted</span>
        <span className="status-item tier-1"><i aria-hidden="true" /> {counts.reviewed} reviewed</span>
        <span className="status-item tier-2"><i aria-hidden="true" /> {counts.verified} verified</span>
        {preparing > 0 ? <span className="status-item is-live">Reading {preparing} {preparing === 1 ? "PDF" : "PDFs"}…</span> : null}
        {tier0.processing ? <span className="status-item is-live">Extracting key points… {tier0.pending > 0 ? `${tier0.pending} left` : ""}</span> : null}
        {state.digestQueue.length > 0 ? (
          <span className="status-item is-live">
            Apple Intelligence: {state.digestQueue.length} queued
            <button type="button" className="link-button" onClick={actions.cancelSummaries}>Stop</button>
          </span>
        ) : null}
        {needsAttention.length > 0 ? (
          <button type="button" className="status-item is-attention link-button" onClick={() => setSettingsTab("library")}>
            {needsAttention.length} need attention
          </button>
        ) : null}
        <span className="status-spacer" />
        {state.notice ? <span className="status-item status-notice" role="status">{state.notice}</span> : null}
        {state.error ? <span className="status-item status-error" role="alert">{state.error}</span> : null}
        <span className="status-item" title={`Rendering quality: ${quality}${constrained ? " (power saving)" : ""}`}>
          {constrained ? "Power saving" : quality === "high" ? "High quality" : "Balanced"}
        </span>
        {activeProject ? <span className="status-item status-project">{activeProject.name}</span> : null}
        {state.pendingRefresh ? (
          <button
            type="button"
            className="refresh-button"
            disabled={state.refreshPhase !== "idle"}
            onClick={actions.commitRefresh}
          >
            {state.refreshPhase === "committing" ? "Applying…" : "Apply reviewed update"}
          </button>
        ) : null}
      </footer>

      {state.refreshError ? <div className="toast is-error" role="alert">{state.refreshError}</div> : null}
      {state.runtimeError ? <div className="toast is-error" role="alert">{state.runtimeError}</div> : null}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        entries={entries}
        model={skyModel}
        commands={commands}
        onOpenEntry={(id) => { openEntry(id); setPaletteOpen(false); }}
        onFocus={(next) => { setSelection(null); setFocus(next); setMode("sky"); setPaletteOpen(false); }}
      />

      {settingsTab ? (
        <SettingsSheet
          tab={settingsTab}
          onTabChange={setSettingsTab}
          onClose={() => setSettingsTab(null)}
          state={state}
          entries={entries}
          partitions={partitions}
          layoutOptionId={layoutOptionId}
          onLayoutOptionChange={setLayoutOptionId}
          qualityPreference={qualityPreference}
          onQualityPreferenceChange={setQualityPreference}
          ambientPreference={ambientPreference}
          onAmbientPreferenceChange={setAmbientPreference}
          heatScope={heatScope}
          onHeatScopeChange={setHeatScope}
          effectiveQuality={quality}
          macroCategories={macroCategories}
        />
      ) : null}

      <div className="visually-hidden" aria-live="polite">{announcement}</div>
    </main>
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export type { LibraryEntry };

function SidebarIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.5 3.5v13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function InspectorIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M12.5 3.5v13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12.5 12.5 17 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M10 2.5v2.1M10 15.4v2.1M17.5 10h-2.1M4.6 10H2.5M15.3 4.7l-1.5 1.5M6.2 13.8l-1.5 1.5M15.3 15.3l-1.5-1.5M6.2 6.2 4.7 4.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
