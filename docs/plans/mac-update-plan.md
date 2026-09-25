# Liteverse macOS update plan (post-0.5.0)

Status: proposal for review. Nothing in this document is implemented yet.
Baseline: `main` at v0.5.0 (commit `b654c06`). File and line references point to
that commit.

## 0. Summary

1. **Speed is limited by the design, not by compute.** A paper is invisible to
   search, galaxy grouping, shortlists, and Context Packs until an AI agent has
   reviewed it in a serial 3–5-paper batch. It then needs a manual Refresh.
   Relations are scored pair by pair (up to 24 candidates per paper). For
   1,000 papers this means 200–334 review batches and up to 24,000 pair
   reviews. Local preparation is also serial.
   **Fix:** make ingestion tiered.
   - **Tier 0 (local, deterministic, parallel):** every paper becomes visible,
     searchable, summarized with verbatim quotes that carry page locators, and
     connected by citation edges resolved from its reference list.
   - **Tier 1 (AI):** reviews one *galaxy* at a time instead of 3–5 papers.
   - **Tier 2 (existing strict verification):** runs only on demand.
2. **A meaningful part of the product surface is marginal, duplicated, or
   dead.** Rough estimate: about 2,000 lines of app code plus about ten build
   dependencies. Examples: three search boxes, two project switchers, two context-building
   engines, a context "queue" that nothing reads, a whole unused
   web/Cloudflare build, legacy research-information flows, and dead bridge
   actions. Remove or merge these *before* porting the renderer, so the new UI
   is built on less code.
3. **Replace the renderer, not only the art.** Today every galaxy and nebula is
   a flat PNG billboard drawn with Canvas 2D. That is about 50 MB of PNGs
   (about 136 MB decoded at source size). New Blender PNGs would still be
   stickers. The plan:
   - WebGL2 via three.js inside the existing WKWebView.
   - Galaxies built in Blender as real 3D point clouds from physically
     parameterized profiles.
   - Nebulae as layered or volumetric bakes.
   - Render on demand, with a laptop power mode driven by native power,
     thermal, and occlusion state.

Section 8 lists the decisions needed before implementation. Several relax
current AGENTS.md policy, so they must be your explicit choice.

---

## 1. Current state (verified evidence)

### 1.1 Throughput bottlenecks

| Finding | Evidence |
|---|---|
| Local preparation is serial: one worker process per paper, a serial dispatch queue, and an exclusive worker lock | `macos/LiteverseApp.m:7856-7858`, `macos/LiteverseLocalWorker.swift:1686` |
| No reference-list parsing; no DOI/arXiv extraction from text; no citation edges. The Curator docs mention "explicit citation matches", but no code produces them | `LiteverseLocalWorker.swift:202,282-288`; `skills/liteverse-curator/SKILL.md:21` |
| Only one active review batch, 3–5 papers, default budget 36,000 characters | `skills/liteverse-curator/scripts/build-review-batch.mjs:231-232,257` |
| Card drafts are invisible downstream: search keeps only `evidence_verified`/`needs_attention`, and Context Packs skip `card_draft` | `scripts/lib/liteverse-search.mjs:413-415`, `scripts/lib/liteverse-context.mjs:151` |
| Relation merge only updates existing relation IDs, and no script appends new relations | `merge-relation-review.mjs:117-118` |
| Adoption needs at least one author. A local PDF gets authors only from a Zotero hint or the PDF Author attribute | `adopt-review-results.mjs:493`, `LiteverseLocalWorker.swift:877-882` |
| `evidence_verified` is refused while metadata is `provisional`, and local PDFs are always `provisional` | `stage-refresh.mjs:333-336`, `LiteverseLocalWorker.swift:891` |
| Every finalize re-hashes every PDF in the corpus, and stage re-hashes every linked PDF | `finalize-curated-snapshot.py:409-432`, `stage-refresh.mjs:235-284` |
| The search index is always rebuilt in full and only by Node. The app opens it read-only, so in-app BM25 search fails until someone runs the CLI | `liteverse-search.mjs:135-296`, `LiteverseApp.m:2561-2576` |
| Each prepared paper rewrites all of `library.json` and pushes the whole workspace to the WebView | `LiteverseApp.m:4396,4423,3411-3506` |
| No OCR: `needs_ocr` becomes a permanent `needs_attention` | `LiteverseLocalWorker.swift:1892` |
| `Work/LocalPipeline` is never pruned, and a managed PDF is stored three times | `LiteverseApp.m:4769`, worker `:1882-1885`, `adopt-review-results.mjs:622-640` |

No existing benchmark measures worker throughput or end-to-end curation time.
The "1,000-item queue" test measures one batch build only
(`tests/curator-review-batch.test.mjs:412-439`).

### 1.2 Rendering

- **Technology:**
  - Canvas 2D (`LiteratureUniverse.tsx:1870`) with a hand-written perspective
    projection (`:2303-2324`).
  - PNG billboards with a fixed small roll angle; no inclination and no
    foreshortening.
  - The "3D rings" in the 0.5.0 notes describe galaxy *positions*
    (`scripts/lib/liteverse-galaxy-contract.mjs:194-207`), not drawn geometry.
- **Code shape:** the renderer is one ~1,720-line React effect (`:1867-3587`).
  A change to the graph or memory rebuilds every sprite and re-decodes every
  PNG. Wheel zoom re-renders the whole component.
- **Frame loop:** `requestAnimationFrame` fires every display refresh even when
  it skips drawing (`:2351-2353`). The idle target is 12 fps with perpetual
  twinkle and orbit animation.
- **Native side:**
  - No power, thermal, or occlusion handling in `LiteverseApp.m`.
  - Window minimum 900×620, default at most 1320×820. A standard title bar
    sits above an 80 px web header.
  - No View or Window menu, no full-screen item, no frame autosave.
  - Magnification is disabled, and there is no pinch or pan handling
    (drag = orbit, scroll = zoom).
- **Laptop fit:**
  - The default "looks like" resolution of a 13-inch MacBook Air (M4) is
    1470×956 points ([Apple spec](https://support.apple.com/en-us/122209)).
  - The header region chips already overflow there (see README screenshot).
  - The paper drawer covers about 40% of the canvas on a 1280-px-wide window.

### 1.3 Product surface

- **Size:** `LiteverseApp.m` 8,202 lines; `LiteratureUniverse.tsx` 5,066;
  `SettingsDrawer.tsx` 1,543; `globals.css` 3,528.
- **Web path:** the Next/vinext/Cloudflare build is not loaded by the Mac app
  (`LiteverseApp.m:7903-7921`). It survives for `npm run dev` and one SSR
  test (`tests/rendered-html.test.mjs:12-31`).

---

## 2. Invariants kept

These stay non-negotiable:

- Immutable, hash-pinned artifacts.
- Append-only ledgers.
- The Usage counting rules.
- No relation without located evidence in both papers.
- No silent promotion of any status.
- Public builds start empty.

Every new tier is an explicit, visible state. It is never a relabelled
`evidence_verified`.

---

## 3. Workstream A — Speed: tiered knowledge (highest priority)

### 3.1 Tier model

| Tier | Produced by | Contents | Visible in universe/search | Allowed as evidence |
|---|---|---|---|---|
| 0 Indexed | Native worker, no AI, parallel | Metadata, abstract, sections, **Paper Brief** (verbatim key points plus key quantities, each with a page, character range, and `pageTextSha256`), parsed references, in-library citation edges | Yes, labelled "Extracted · unreviewed" | Verbatim quotes only, labelled `extracted_unreviewed`; never paraphrase (decision D1) |
| 1 Digested | AI agent through the CLI, **one galaxy per packet** | Per-paper gist and comparison-matrix cells, each citing Tier-0 quote IDs; typed relation proposals citing quotes from both papers | Yes, labelled "AI digest" | Relations stay `candidate` |
| 2 Verified | Existing strict flow, **on demand** | Original-page-reviewed card, `evidence_verified` claims, verified relations | Yes | Yes (unchanged) |

Tier 2 is triggered when:
- a paper is adopted into a Context Pack;
- the user clicks **Verify**;
- a relation is to be marked verified.

A human can also attest a quote in the in-app PDF viewer (§3.6). That
attestation records provenance `user`.

### 3.2 Parallel, incremental local preparation

- **Concurrency:**
  - Replace the global worker lock with per-job locks.
  - Run N concurrent jobs: N = min(4, performance cores / 2) on AC power, and
    1–2 on battery or Low Power Mode.
  - Add a per-job timeout; a timeout yields `needs_attention`, not a hang.
- **I/O:**
  - Coalesce `library.json` writes (debounce about 1–2 s).
  - Push *deltas* to the UI instead of the full workspace.
  - Remove the 30 s JS polling that duplicates the native vnode watchers.
- **Hashing:**
  - One shared hash cache (a SQLite table keyed on device, inode, size, and
    mtime in nanoseconds) used by the App, the worker, and Node.
  - Stream hashing in Node; `fileSha` currently reads whole files into memory.
  - Finalize and stage verify only changed papers. `doctor` keeps the full
    audit.
- **Search index:**
  - Build it **natively** and incrementally. The app already links `sqlite3`.
  - Keep one schema shared with the Node CLI, enforced by a contract test.
  - Index Tier-0 content with tier labels so search works immediately.
- **Catalog pin:** replace the whole-catalog fingerprint with per-paper
  revision pins, and re-run strict dedupe at adoption. This removes the
  "catalog fingerprint is stale" failures that currently need one manual
  Retry per item.
- **Retry:** add bulk retry and automatic retry after catalog drift.
- **OCR:** use Apple Vision (`VNRecognizeTextRequest`) for `needs_ocr` pages
  with `extraction_engine: vision_ocr`. Key points from OCR pages carry a
  quality flag. Equations in OCR text are unreliable.
- **Storage:**
  - Store PDFs content-addressed by SHA-256, once. Use APFS clones where a
    copy is unavoidable.
  - Prune `Work/LocalPipeline` after adoption.

### 3.3 Identity and references (makes connections deterministic)

1. **Identity:**
   - Detect the arXiv identifier from the arXiv margin stamp on page 1, the
     filename, or PDF metadata.
   - Detect a DOI from the first two pages.
   - With a detected ID and opt-in enrichment (D4), fetch arXiv metadata
     (authors, abstract, `journal_ref`, DOI). This resolves the author and
     `provisional` gates in §1.1 for most papers.
   - The arXiv legacy API allows at most one request every 3 s over a single
     connection ([arXiv API ToU](https://info.arxiv.org/help/api/tou.html)).
     Batch the `id_list` queries.
2. **Reference-section parsing (worker):**
   - Locate the last References/Bibliography heading.
   - Segment entries by numeric labels or hanging author-year blocks.
   - Reconstruct column order from PDFKit selection bounds when two-column
     reading order is wrong.
   - Extract identifiers per entry: new- and old-style arXiv IDs and DOIs.
3. **Resolution to library papers:**
   - Exact arXiv or DOI match → `cites` edge, `match: exact`.
   - Otherwise first author + year + journal/volume/page (from
     `journal_ref`), or title tokens when present → `match: probable`.
     These require one-click confirmation and are never auto-verified.
     Many physics and astronomy reference styles omit titles, so the journal
     triple matters.
4. **Citation contexts:**
   - Map in-text markers (`[12]`, `Author et al. 2014a`) to entries.
   - Store the citing sentence with its page and character range.
   - This sentence is the natural evidence locator on the citing side of any
     later typed relation.
5. **Optional field services** (opt-in, user token, off by default):
   - NASA ADS returns curated reference and citation lists for astronomy
     papers. Its documented limit is 5,000 requests/day
     ([ADS rate limits](https://ui.adsabs.harvard.edu/help/policies/rate-limits)).
   - arXiv LaTeX source (`.bbl`, section structure, equations) is far cleaner
     than PDF text for equation-heavy papers.
   - Both need decision D4.

Keep one distinction explicit in the UI and data: a citation is
**bibliographic** ("A cites B"). It is not agreement, dependence, or
contradiction. Those remain typed relations that need evidence.

### 3.4 Paper Brief (extractive, no generation)

**Candidate sentences** come from:
- the abstract;
- the last paragraphs of the introduction;
- the conclusions, summary, or discussion section;
- figure captions.

**Scoring** extends the existing cue lists (`LiteverseLocalWorker.swift:206-270`)
with:
- a section prior;
- first-person plural;
- numbers with units;
- a *penalty* for sentences that carry citation markers, because these usually
  describe prior work, not the paper's own result;
- explicit negation and assumption flags.

**Selection:** up to 8 key points balanced across question, method, result,
and limitation, chosen with maximal marginal relevance to avoid redundancy
(Carbonell & Goldstein, SIGIR 1998).

**Key quantities:** value, unit, surrounding sentence, and locator. This is
regex-based and flagged low-confidence on OCR or garbled math.

**Keyphrases:** TF-IDF n-grams against the library corpus, with symbol-aware
tokenization (the existing Greek aliasing in `liteverse-core.mjs:568-607`).

Every item is a verbatim span with a hash-pinned locator, so the Brief cannot
hallucinate. It can still misattribute context, which is why it stays Tier 0.

### 3.5 Connection graph and clustering (replaces Codex-authored partitions for routing)

- **Paper similarity graph:** a weighted sum of three signals:
  - bibliographic coupling (shared references; Kessler 1963), cosine-normalized;
  - in-library co-citation (Small 1973);
  - TF-IDF cosine over Brief plus abstract.

  Keep the top 10 neighbours per paper. Down-weight review articles with very
  long reference lists.
- **Communities:** Leiden (Traag, Waltman & van Eck 2019) at two resolutions:
  a coarse one for macro regions (at most 10, at least 4 papers each) and a
  fine one for galaxies (at most 12 per nebula). Implement it natively in
  Swift. At ≤5k nodes the cost is negligible, and the App has no bundled Node.
- **Stability:** repeat over several seeds and resolutions and report adjusted
  Rand index per cluster. Unstable clusters stay provisional. This replaces
  the hand-authored "consistency ≥ 70" input with a measured quantity, while
  the existing gates (≥4 papers, ≤10 regions) stay.
- **Three partition options, deterministic:**
  1. citation-structure weighted;
  2. content weighted;
  3. hybrid at a coarser resolution.

  The existing ≥15% co-membership-difference check applies. If the corpus
  does not support three materially different options, report that instead of
  inventing one; the current "exactly three" rule needs this escape hatch
  (D3).
- **Labels:** automatic class-based TF-IDF phrases (as in BERTopic,
  arXiv:2203.05794). The user or AI may rename them.
- **Galaxy grouping:** switch galaxy routing affinity from tag Jaccard plus
  relation weight (`liteverse-galaxy-contract.mjs:116-129`) to this graph.
  Tags exist only after AI assignment, so today's grouping is degenerate for
  unreviewed papers. This changes `hierarchy.assignmentSha256` and needs a
  migration.

### 3.6 Working views for fast reading

The canvas is for overview. Throughput work happens in dense views.

- **Triage** (keyboard-first table):
  - J/K move; Space opens the Brief.
  - P pins the paper (queues Tier 2), R marks it relevant to the active
    project (a project-memory event), X skips.
  - Bulk-confirm probable citation matches and duplicates.
- **Galaxy Brief:**
  - automatic labels;
  - foundational papers (in-library citation in-degree);
  - a *reading path* (topological order of the in-library citation graph,
    oldest foundations first);
  - disagreements (Tier-1 `contradicts` candidates);
  - open questions.
- **Compare matrix:** rows are papers; columns are question, system/model,
  method, key assumption, main result, and validity regime. Tier-0 quotes fill
  it first; Tier-1 cells replace them with quote-cited digests.
- **In-app PDF viewer** (native PDFKit window):
  - opens at the exact evidence page with the character range highlighted;
  - "Confirm quote" records a user attestation.

  This replaces the duplicate Open PDF / Open PDF to verify / Open Markdown
  buttons.

### 3.7 Tier-1 AI review per galaxy

- **Packet:** new CLI command `curation galaxy build --galaxy <id>`. It
  contains all Tier-0 Briefs (quote IDs), citation contexts, existing
  relations, and project conventions, within the existing character-budget
  mechanism.
- **Output:**
  - a gist per paper;
  - comparison-matrix cells;
  - typed relations only for pairs linked by a citation edge or among the
    top-k coupling neighbours inside the galaxy (k ≈ 5), instead of a
    24-candidate BM25 shortlist per paper;
  - flags for duplicates and errata.
- **Validation:** a deterministic validator rejects any cell or relation
  without existing, hash-pinned quote IDs, and any relation without quotes
  from *both* papers.
- **Status:** relations stay `candidate` until Tier 2.
- **Effect:** visibility and connection no longer wait on AI at all. AI
  packets drop from one per 3–5 papers to one per galaxy (galaxies hold about
  5–12 papers by `liteverse-galaxy-contract.mjs:131-138`), and pair
  selection becomes evidence-driven.

### 3.8 Refresh

- Tier-0 additions are deterministic and additive. They apply live through an
  App-owned validated commit, with a small "N papers added" notice.
- Staged Refresh remains for AI-reviewed and structural changes (taxonomy,
  verified relations) (D5).

### 3.9 Measurement and acceptance

**Phase 0 builds the harness.** The targets below are initial design goals, to
be revised once the Phase 0 baseline exists.

| Metric | How | Initial target |
|---|---|---|
| Time from import to searchable, briefed, clustered | Synthetic PDF generator (committed); opt-in local real corpus (never committed) | 500 text-layer PDFs in ≤ 10 min on a base M1 laptop on AC power |
| Key-point quality | Local eval against existing `evidence_verified` cards: overlap of Brief spans with evidence-index character ranges | Report recall@8 per section kind; set the target after the baseline |
| Citation-edge precision | Hand-checked sample of 200 resolved edges | Exact-ID edges ≥ 0.98; probable edges reported, never auto-verified |
| Cluster stability | ARI across seeds and resolutions | Report per cluster; gate new regions on it |
| AI packets per 1,000 papers | Count | About 100 galaxy packets vs 200–334 batches today |

Only aggregate numbers from private-library evaluations may be committed.

---

## 4. Workstream B — Efficiency: remove or merge

Rule: a feature stays only if it serves import, understanding, connection,
verification, or project memory, and it has exactly one entry point.

| Item | Evidence | Action |
|---|---|---|
| Web/Cloudflare/Next template path: `vinext`, `next`, `wrangler`, `@cloudflare/vite-plugin`, `@vitejs/plugin-rsc`, `react-server-dom-webpack`, `drizzle-*`, Tailwind/PostCSS (unused), `worker/`, `db/`, `drizzle/`, `examples/d1`, `.openai/`, `scripts/sites-vite-plugin.ts`, `app/chatgpt-auth.ts` (no importers), `app/layout.tsx`, `app/page.tsx`, `next.config.ts`, unused SVGs | Not loaded by the app (`LiteverseApp.m:7903-7921`); only `npm run dev` and one SSR test use it | **Delete.** Dev loop: `vite dev` on the desktop config plus a mock bridge module. Replace the SSR test with a `react-dom/server` render. Replace `eslint-config-next` with plain `typescript-eslint` and `eslint-plugin-react-hooks` |
| ~150 lines of browser-fallback branches in the UI | `LiteratureUniverse.tsx:1054-1084,3994-4405` | **Delete**; the mock bridge covers dev |
| `data/universe.json` (identical to the empty seed), `data/user-annotations.json` (unreferenced) | `cmp`/grep | **Delete** |
| Context tab: local preview (display-only, not copyable), a second BM25 box, "Queue formal CLI build" (writes `context-requests.jsonl`, which nothing reads) | `SettingsDrawer.tsx:1260-1414`; ObjC preview `LiteverseApp.m:2904-3113`; queue `:6996-7028` | **Delete.** Context Packs belong to the Retriever CLI. Keep a read-only "Packs used by this project" list in the Project panel |
| Three search boxes (header substring, library filter, Context BM25) and two engines (ObjC and Node) | §5.6 of the inventory | **One ⌘K search** over the native index (papers, quotes, notes, commands); library filter becomes a column filter in the Library view |
| Two project switchers | `LiteratureUniverse.tsx:4493`, `SettingsDrawer.tsx:703` | **Keep one** (toolbar). Add rename and archive, which are missing today |
| "Research Information" textarea (the same text shown three times), its legacy queue (`pending_setup`/`pending_update`, written by no current code), and `publish-research` | `LiteverseApp.m:6549-6821`; `scripts/codex-workspace-queue.mjs` | **Replace** with a structured Project Brief editor (goals, conventions, open questions) writing ordinary memory events. Remove the legacy queue after a one-time migration |
| Region documents called "Knowledge Card", which collides with the paper card; no edit or retire in the UI; `retireRegionDocument` exists natively but is never sent | `LiteverseApp.m:6408-6481` | **Rename** to Notes; add edit and retire (wire the existing bridge); allow adding a note from the black hole itself |
| Paper annotations framed as "Awaiting Codex curation" | `LiteratureUniverse.tsx:4879-4926` | **Keep, simplify:** notes are the user's own, searchable immediately; integration into a card is an explicit action |
| Artifacts tab and Task Timeline (read-only views of agent-written data) | `SettingsDrawer.tsx:1239-1256,1416-1447` | **Merge** into the Project panel as collapsible sections |
| Regions tab whose main action is "Copy selection for Codex" | `SettingsDrawer.tsx:503-508,1507-1518` | **Replace** with in-app choice between the three deterministic options, recorded as an append-only user decision (D3) |
| Header nebula chip bar, header Back/Reset, breadcrumb, Escape: four ways to navigate | `LiteratureUniverse.tsx:4505-4566` | **Keep** breadcrumb, Escape/⌘[ and swipe-back; the sidebar Atlas replaces the chip bar |
| Zoom slider and ± widget | `ZoomControl.tsx` | **Delete**; use pinch, ⌘+/⌘−/⌘0, and a small zoom readout |
| Project/Global heat toggle, three lane checkboxes, and a strength slider (heat changes nebula radius by at most 3.5%) | `LiteratureUniverse.tsx:4527-4530,4629-4655,2468-2478` | **Merge** into one Lens menu: Heat, Year, Tier, Citation centrality, Relation type |
| Duplicate open buttons; two native open routes | Paper drawer `:4815-4876`; `open` vs `openLibraryItem` | **One action:** "Open at evidence" (PDF viewer), plus "Reveal in Finder" |
| Backup import that only copies to `Recovered/` with no way to activate it | `LiteverseApp.m:7753-7824` | **Complete** it: verify, show a diff summary, then switch with explicit confirmation |
| Library health grid computed twice (UI and native); unused native counters; `searchProjection` always `[]` | `LiteverseApp.m:1376-1473,3491` | **Replace** with one status strip fed by native counts |
| Legacy hot-path migrations run on every load; `seedKnowledgeCardsIfNeeded` with an empty seed; `codex-note-queue.mjs mark` throws | `LiteverseApp.m:704-846,414-483,1005-1055` | **Run once**, gated by a workspace schema version; delete the empty seed path and the throwing command |
| Folder and Zotero intake with near-duplicate merge logic | `LiteverseApp.m:5040-5120` vs `:5512-5592` | **Factor** into one linked-source routine |
| Python materializer (`materialize-paper.py`, pypdf) alongside the Swift worker | Legacy managed path only | **Retire** after a migration release; one extractor |
| Per-version release workflows (`publish-v0.4.0.yml`, `publish-v0.5.0.yml`) | Diff is only version and trigger | **One** tag-triggered workflow |
| Two JS error emitters; `didFinishNavigation` debug probe | `LiteverseApp.m:7862-7872,7955-7961` | **Keep one**; remove the probe |

**Added** because they are core and missing:
- File/View/Go/Window menus and standard shortcuts;
- a real Settings window (⌘,) that holds only configuration;
- window frame autosave;
- full screen.

**Documentation:** AGENTS.md, the three SKILL.md files, and the README must be
updated in the same releases to match the tier model and the decisions.

---

## 5. Workstream C — Design, 3D galaxies, laptops

### 5.1 Rendering architecture

- **Engine:** three.js with WebGL2 in the existing WKWebView.
  - WebGL2 is available on the macOS 13 baseline.
  - WebGPU is enabled by default only from Safari/macOS 26
    ([WebKit, Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)),
    so it is an optional later backend.
  - A native Metal/RealityKit rewrite is not recommended: it would discard
    about 6,600 lines of working UI for little visual gain.
- **Scene module:** move rendering out of the React effect into
  `app/universe/scene/`. React posts view-model diffs; the scene owns its
  loop.
- **Asset loading:** serve assets and graph JSON through a `WKURLSchemeHandler`
  (`liteverse-asset://`). Loaders use `fetch`/XHR, and today everything loads
  from `file://`, which is fragile for glTF.
- **Scene graph:**
  - Instanced point sprites for background stars (one draw call).
  - Galaxy point clouds (§5.2).
  - Instanced paper stars with per-instance attributes (tier, heat, year).
  - Line-segment "filaments" for citation flow and typed relations.
  - DOM-overlay labels with a count budget, for crisp SF text and VoiceOver.
- **Picking:** CPU ray tests against bounding spheres (N is small).

### 5.2 Blender asset pipeline

- **Location:** `tools/blender/`, run headless:
  `blender --background --factory-startup --python build_galaxies.py -- --seed …`.
  - Pin one Blender LTS release. Record the Blender version, script SHA-256,
    and seed in an asset manifest.
  - Maintainers regenerate locally; CI checks committed outputs against the
    manifest (hashes, point counts, byte budget).
- **Galaxies:** 10 archetypes, matching today's roster so the assignment
  contract's quota and reuse rules carry over: grand-design spiral, barred
  spiral, flocculent spiral, elliptical, lenticular, ring, irregular dwarf,
  interacting pair, starburst, Seyfert.
  - Built from physically motivated profiles: exponential disk, Sérsic bulge,
    logarithmic spiral arms with an explicit pitch angle, a bar, dust lanes
    along the inner arm edges, star-forming clumps, and colour by stellar
    population.
  - Per-point attributes: position, colour, size, population, and
    cylindrical radius. The radius drives slow differential rotation in the
    vertex shader, Ω(R) ≈ v₀ / √(R² + R_c²), which approximates a flat
    rotation curve.
- **Export:**
  - glTF with loose points plus custom attributes. Blender's exporter needs
    both "Loose Points" and "Attributes" enabled, and custom attributes must be
    underscore-prefixed
    ([Blender manual](https://docs.blender.org/manual/en/4.0/addons/import_export/scene_gltf2.html)).
  - A known issue blocks point-cloud export without a radius attribute
    ([glTF-Blender-IO #2769](https://github.com/KhronosGroup/glTF-Blender-IO/issues/2769)).
    Spike S2 verifies this path; the fallback is a small custom binary buffer
    plus JSON written from the same script.
  - Post-process with glTF-Transform (quantize).
  - Two levels of detail per galaxy: about 40–60k points (focused) and about
    5–8k points (nebula view). Plus a 256 px Cycles impostor for sub-40 px
    universe-view sizes.
- **Nebulae:** Blender volumetric look-dev, shipped in two forms:
  - 3–5 depth-slice layers (KTX2) giving true parallax as the camera orbits
    (default, laptop-safe);
  - an optional low-resolution 3D density texture (≤128³) ray-marched at half
    resolution in the focused view on AC power only.
- **Black hole:** a 3D accretion-disk mesh with an emissive shader.
- **Budget:** at most about 15 MB of shipped 3D assets, down from about 50 MB of
  PNGs. All outputs are project-generated and recorded in
  `ASSET_LICENSES.md`.

### 5.3 Visual encoding that carries data

- Galaxy size ∝ log(paper count); brightness = heat lens.
- Inside a galaxy (D8 design choice):
  - radius from in-library citation centrality: the bulge holds the
    foundational papers;
  - azimuth along the arms from publication year.
- Star colour = active lens (tier by default, so unreviewed vs verified is
  always visible).
- Inter-galaxy filaments: width ∝ citation flow; colour = typed relation
  status (verified solid, candidate dashed).
- Morphology stays an identity cue only. It must not suggest a scientific
  property it does not encode.

### 5.4 Interface concept

"Rare UI" is read here as *distinctive, not generic*. Proposed direction:
**Observatory**, the app as an instrument.

- **Two modes:**
  - **Sky** (⌘1): the 3D universe, for overview and connection discovery.
  - **Desk** (⌘2): Triage, Galaxy Brief, Compare, and Reader, for dense work.
- **Layout:**
  - Full-size content view with a transparent title bar merged into a 44–52 pt
    toolbar. This recovers the 28 pt title bar plus most of the 80 px header.
  - Collapsible left **Atlas** (outline of regions → galaxies → papers, with
    tier badges; also the accessible navigation).
  - Right **Inspector** that *resizes* the scene instead of covering it.
  - Bottom status strip: indexed / briefed / digested / verified counts and
    ingestion progress.
- **Visual language:**
  - Near-black blue field and 1 px hairlines.
  - SF Mono readouts with tabular figures.
  - Catalog-style designations (`LV-G07 · 14 papers`).
  - A coordinate graticule that fades in with zoom.
  - One accent per lens.
  - Opaque or translucent fills instead of stacked `backdrop-filter` blurs over
    a live scene.
- **Alternatives** (for D8):
  - (b) *Star atlas*: engraved-chart aesthetic with a light reading mode.
  - (c) Minimal native macOS styling.
- **First step:** clickable prototypes of the Sky and Desk screens at
  1470×956 before building.

### 5.5 Laptop mode

- **Native power bridge:**
  - `NSProcessInfo.lowPowerModeEnabled` with its power-state notification;
  - `thermalState` with its notification;
  - battery vs AC from IOKit power sources;
  - `NSWindowDidChangeOcclusionStateNotification`.

  All of this reaches the scene as one `power` state.
- **Render on demand:**
  - No animation frames while static.
  - Frames during interaction and transitions.
  - Optional ambient motion for a few seconds after input: off on battery by
    default, never while occluded.
- **Quality tiers:**
  - Battery: impostors and low-LOD points, 1.0× render scale.
  - Balanced.
  - High: volumes, 1.5–2.0× render scale, dynamic resolution from frame time.
- **Trackpad:**
  - Pinch = zoom toward the cursor.
  - Two-finger scroll = pan.
  - Rotate gesture or ⌥-drag = orbit.
  - Swipe back = up one level.
  - Force click or Space = Quick Look of the Brief.
- **Layout targets:** minimum 1280×800; primary 1470×956. Test every view at
  both.
- **Acceptance** (initial targets, measured with Instruments and `powermetrics`
  on a base M1 laptop):
  - ~0 GPU work while static;
  - smooth interaction at 1470×956;
  - bounded memory for a 1,000-paper library.

---

## 6. Phases and releases

Sizes are rough, for one developer. S ≈ days, M ≈ 1–3 weeks, L ≈ 4–8 weeks.

| Phase | Scope | Size | Output |
|---|---|---|---|
| 0 Baseline | Ingestion benchmark harness, extraction-quality eval, energy/fps harness. Spikes: S1 three.js GLB in WKWebView through a custom scheme on a base laptop; S2 Blender point-cloud export; S3 PDFKit throughput at 1/2/4 jobs; S4 reference parsing on ~50 real two-column papers; S5 Vision OCR | M | Numbers that replace the targets in §3.9 and §5.5 |
| 1 Prune | Workstream B; mock bridge; menus; Settings window; docs | M | 0.6.0-alpha |
| 2 Speed | §3.2–3.8; CLI and Skill updates; migrations | L | **0.6.0** |
| 3 Visual | §5.1–5.5; prototypes first; Blender assets | L (S1/S2 run in Phase 0) | **0.7.0** |
| 4 Optional | Field enrichment (ADS/LaTeX source); on-device model experiment (D6) | M | Behind flags |

Pruning comes first because it shrinks what the renderer and UI rewrite must
carry. Speed comes before visuals because it is the stated top priority, and
because the new views and encodings depend on Tier-0 data.

---

## 7. Risks

- **Extraction quality on math-heavy, two-column PDFs.** PDFKit text can
  garble equations and column order. Mitigations: column reconstruction,
  quality flags, and opt-in LaTeX source. Never present key quantities from
  garbled pages without a flag.
- **Reference styles without titles.** Fuzzy matches can create false edges.
  They stay `probable` until confirmed; only exact-ID edges are automatic.
- **Coupling ≠ relationship.** Coupling and text similarity measure topical
  proximity and only route; they never create typed relations. Clusters are
  resolution- and seed-dependent, so stability is reported.
- **Policy erosion.** Tiers could blur the fail-closed design. Mitigations:
  - a visible tier on every item;
  - Context Pack filters by tier;
  - tests asserting that Tier 0/1 content never counts as `evidence_verified`
    and never enters Usage.
- **Contract churn.** New galaxy grouping and asset IDs change assignment
  hashes. This needs a migration plus test updates (`galaxy-hierarchy`,
  `performance-guards`, `rendered-html`, `nebula-expansion`).
- **Blender export path.** Point-cloud glTF export has known edge cases. S2
  runs before committing to the format.
- **Scope.** Phases 2 and 3 are each large. Ship 0.6.0 before starting full
  Phase 3 work.

---

## 8. Decisions needed

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Tier-0 (extracted, unreviewed) papers visible in the universe and search; verbatim quotes usable in Context Packs with an explicit label | Yes |
| D2 | Citation edges as a separate bibliographic layer (not scientific relations) | Yes |
| D3 | In-app partition choice among deterministic options (today only Codex may record a choice); allow fewer than three options when the corpus does not support three materially different ones | Yes |
| D4 | Opt-in network enrichment for the user's own papers (arXiv metadata/source, ADS with the user's token); off by default; no discovery of new papers | Yes, opt-in |
| D5 | Tier-0 additions apply live; Refresh only for AI-reviewed or structural changes | Yes |
| D6 | Experiment with Apple's on-device Foundation Models for drafts. Needs macOS 26 and Apple Intelligence; context is 4,096 tokens per [TN3193](https://developer.apple.com/documentation/technotes/tn3193-managing-the-on-device-foundation-model-s-context-window); newer model generations may differ. Would relax "no local model" | Defer to Phase 4, behind a quality gate |
| D7 | Minimum macOS | Keep 13; nothing in Phases 1–3 requires more |
| D8 | UI direction (Observatory / Star atlas / minimal native) and in-galaxy placement encoding | Observatory, pending prototypes |
| D9 | Delete the web/Cloudflare development path | Yes |

## References

- Kessler, M. M. (1963), "Bibliographic coupling between scientific papers",
  *American Documentation* 14(1), 10–25.
- Small, H. (1973), "Co-citation in the scientific literature", *JASIS* 24(4),
  265–269.
- Carbonell, J. & Goldstein, J. (1998), "The use of MMR, diversity-based
  reranking for reordering documents and producing summaries", *SIGIR '98*.
- Traag, V. A., Waltman, L. & van Eck, N. J. (2019), "From Louvain to Leiden:
  guaranteeing well-connected communities", *Scientific Reports* 9, 5233.
- Grootendorst, M. (2022), "BERTopic: Neural topic modeling with a class-based
  TF-IDF procedure", arXiv:2203.05794.
