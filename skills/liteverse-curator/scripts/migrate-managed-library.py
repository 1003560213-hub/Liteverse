#!/usr/bin/env python3
"""Prepare a resumable schema-v3 migration without modifying Graph/current.json."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from typing import Any


DEFAULT_SUPPORT = Path.home() / "Library" / "Application Support" / "Liteverse"
SCHEMA_VERSION = "3.0.0"
CARD_SCHEMA_VERSION = "liteverse-card-v1"
VERIFICATION_STATES = {
    "imported",
    "extracted",
    "needs_ocr",
    "card_draft",
    "evidence_verified",
    "needs_attention",
    "source_missing",
}
REQUIRED_CARD_HEADINGS = (
    "Research question",
    "Methods",
    "Equations and conventions",
    "Main results",
    "Limitations",
    "Project role",
    "Evidence index",
    "Annotation provenance",
)


class MigrationError(RuntimeError):
    """An expected migration precondition or integrity failure."""


def load_materializer() -> Any:
    source = Path(__file__).with_name("materialize-paper.py")
    spec = importlib.util.spec_from_file_location("liteverse_materialize_paper", source)
    if spec is None or spec.loader is None:
        raise MigrationError(f"cannot load materializer: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MATERIALIZER = load_materializer()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def stable(value: Any) -> Any:
    if isinstance(value, list):
        return [stable(item) for item in value]
    if isinstance(value, dict):
        return {key: stable(value[key]) for key in sorted(value)}
    return value


def json_bytes(value: Any) -> bytes:
    return (json.dumps(stable(value), indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp_name)
        raise


def atomic_copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with source.open("rb") as reader, os.fdopen(fd, "wb") as writer:
            shutil.copyfileobj(reader, writer, length=1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
        os.replace(temp_name, target)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp_name)
        raise


def safe_relative(path_value: str, label: str) -> Path:
    candidate = Path(path_value)
    if candidate.is_absolute() or ".." in candidate.parts or not candidate.parts:
        raise MigrationError(f"{label} must be a safe support-relative path: {path_value}")
    return candidate


def resolve_source(support: Path, paper: dict[str, Any]) -> Path:
    value = paper.get("source", {}).get("pdfPath") or paper.get("pdfPath")
    if not isinstance(value, str) or not value.strip():
        raise MigrationError(f"paper {paper.get('id')} has no PDF source path")
    candidate = Path(value).expanduser()
    return candidate.resolve() if candidate.is_absolute() else (support / safe_relative(value, "PDF path")).resolve()


def backup_once(source: Path, backup: Path) -> str | None:
    if not source.exists():
        return None
    source_hash = sha256_file(source)
    if backup.exists():
        if sha256_file(backup) != source_hash:
            raise MigrationError(f"backup collision: {backup}")
        return source_hash
    atomic_copy(source, backup)
    return source_hash


def card_has_schema(text: str) -> bool:
    return all(re.search(rf"^## {re.escape(heading)}\s*$", text, flags=re.MULTILINE) for heading in REQUIRED_CARD_HEADINGS)


def migrated_card(metadata: dict[str, Any], extraction_status: str, legacy_text: str | None) -> str:
    base = MATERIALIZER.card_markdown(metadata, extraction_status).rstrip()
    if not legacy_text:
        return base + "\n"
    quoted = "\n".join(f"> {line}" if line else ">" for line in legacy_text.strip().splitlines())
    marker = (
        "\n\n### Legacy card retained for evidence review\n\n"
        "> The following pre-migration notes are provisional. They are not evidence-indexed and must not be treated as verified claims.\n\n"
        f"{quoted}\n"
    )
    return base + marker


def paper_metadata(
    paper: dict[str, Any],
    source_hash: str,
    extraction_status: str,
    extraction_diagnostics: dict[str, Any],
) -> dict[str, Any]:
    paper_id = paper["id"]
    source = paper.get("source") if isinstance(paper.get("source"), dict) else {}
    source_type = source.get("kind") or ("arxiv" if source.get("arxivId") else "pdf")
    authors = paper.get("authors", [])
    if isinstance(authors, str):
        authors = [authors]
    verification = "needs_ocr" if extraction_status == "needs_ocr" else "card_draft"
    secondary = paper.get("secondaryCategory")
    if not secondary:
        secondary = next(
            (category_id for category_id in paper.get("categoryIds", []) if category_id != paper.get("primaryCategory")),
            None,
        )
    pdf_path = f"Library/PDFs/{paper_id}.pdf"
    card_path = f"Knowledge/cards/{paper_id}.md"
    fulltext_path = f"Knowledge/fulltext/{paper_id}.md"
    return {
        "paperId": paper_id,
        "title": paper.get("title") or paper_id,
        "authors": authors,
        "sourceType": source_type,
        "metadataStatus": "provisional",
        "sha256": source_hash,
        "arxivId": source.get("arxivId"),
        "arxivBase": MATERIALIZER.arxiv_base(source.get("arxivId")),
        "doi": MATERIALIZER.normalize_doi(source.get("doi")),
        "officialUrl": source.get("officialUrl"),
        "pdfPath": pdf_path,
        "cardPath": card_path,
        "fulltextPath": fulltext_path,
        "extractionStatus": extraction_status,
        "verificationStatus": verification,
        "cardSchemaVersion": CARD_SCHEMA_VERSION,
        "evidenceCount": 0,
        "extractionDiagnostics": extraction_diagnostics,
        "primaryCategory": paper.get("primaryCategory"),
        "secondaryCategory": secondary,
        "classificationStatus": paper.get("classificationStatus") or "classified",
        "tags": paper.get("tags") if isinstance(paper.get("tags"), list) else [],
        "libraryItemId": None,
        "libraryItemRevision": None,
        "source": {
            "kind": source_type,
            "pdfPath": pdf_path,
            "sha256": source_hash,
            "arxivId": source.get("arxivId"),
            "doi": MATERIALIZER.normalize_doi(source.get("doi")),
        },
        "artifacts": {
            "cardPath": card_path,
            "fulltextPath": fulltext_path,
            "extractionStatus": extraction_status,
            "cardSchemaVersion": CARD_SCHEMA_VERSION,
            "evidenceCount": 0,
            "extractionDiagnostics": extraction_diagnostics,
        },
    }


def migrated_paper(paper: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    result = dict(paper)
    result.pop("verified", None)
    result.update({
        "pdfPath": metadata["pdfPath"],
        "markdownPath": metadata["cardPath"],
        "fulltextPath": metadata["fulltextPath"],
        "source": metadata["source"],
        "artifacts": metadata["artifacts"],
        "verificationStatus": metadata["verificationStatus"],
        "metadataStatus": metadata["metadataStatus"],
        "classificationStatus": paper.get("classificationStatus") or "classified",
        "useCount": 0,
    })
    return result


def make_snapshot(graph: dict[str, Any], completed: dict[str, dict[str, Any]], timestamp: str) -> dict[str, Any]:
    papers = []
    for paper in graph.get("papers", []):
        entry = completed.get(paper.get("id"))
        if not entry or entry.get("status") != "completed":
            raise MigrationError(f"cannot create snapshot before paper {paper.get('id')} is completed")
        papers.append(migrated_paper(paper, entry["metadata"]))
    categories = []
    for category in graph.get("categories", []):
        migrated = dict(category)
        migrated["kind"] = category.get("kind") or "macro"
        categories.append(migrated)
    snapshot = dict(graph)
    snapshot.update({
        "schemaVersion": SCHEMA_VERSION,
        "revision": int(graph["revision"]) + 1,
        "updated": timestamp,
        "categories": categories,
        "papers": papers,
    })
    return snapshot


def build_plan(support: Path, graph: dict[str, Any], graph_hash: str, run_id: str) -> dict[str, Any]:
    papers = []
    for paper in sorted(graph.get("papers", []), key=lambda item: item.get("id", "")):
        paper_id = paper.get("id")
        if not isinstance(paper_id, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", paper_id):
            raise MigrationError(f"unsafe or missing paper ID: {paper_id}")
        source = resolve_source(support, paper)
        papers.append({
            "paperId": paper_id,
            "status": "pending",
            "sourceOriginalPath": str(source),
            "targetPdfPath": f"Library/PDFs/{paper_id}.pdf",
            "cardPath": f"Knowledge/cards/{paper_id}.md",
            "fulltextPath": f"Knowledge/fulltext/{paper_id}.md",
        })
    return {
        "schemaVersion": 1,
        "migration": "managed-library-v3",
        "runId": run_id,
        "state": "planned",
        "createdAt": utc_now(),
        "updatedAt": utc_now(),
        "baseGraph": {
            "path": "Graph/current.json",
            "sha256": graph_hash,
            "schemaVersion": graph.get("schemaVersion"),
            "revision": graph.get("revision"),
        },
        "targetGraphSchemaVersion": SCHEMA_VERSION,
        "papers": papers,
        "snapshotPath": "snapshot.json",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Copy legacy PDFs into the managed vault and prepare a schema-v3 staged-snapshot input."
    )
    parser.add_argument("--support-dir", type=Path, default=Path(os.environ.get("LITEVERSE_SUPPORT_DIR", DEFAULT_SUPPORT)))
    parser.add_argument("--graph", type=Path, help="Source graph; defaults to Graph/current.json")
    parser.add_argument("--run-id", help="Stable run ID; defaults to graph revision and hash")
    parser.add_argument("--apply", action="store_true", help="Write managed files, backups, manifest, and snapshot")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    support = args.support_dir.expanduser().resolve()
    graph_path = (args.graph.expanduser().resolve() if args.graph else support / "Graph" / "current.json")
    if not graph_path.is_file():
        raise MigrationError(f"graph does not exist: {graph_path}")
    graph_bytes = graph_path.read_bytes()
    graph_hash = sha256_bytes(graph_bytes)
    try:
        graph = json.loads(graph_bytes)
    except json.JSONDecodeError as error:
        raise MigrationError(f"graph is invalid JSON: {error}") from error
    if not isinstance(graph, dict) or not isinstance(graph.get("papers"), list):
        raise MigrationError("graph must be an object with a papers array")
    if graph.get("schemaVersion") not in {"2.0.0", SCHEMA_VERSION}:
        raise MigrationError(f"unsupported source graph schema: {graph.get('schemaVersion')}")
    run_id = args.run_id or f"managed-library-v3-r{graph.get('revision')}-{graph_hash[:12]}"
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}", run_id):
        raise MigrationError("run ID contains unsafe characters")
    run_root = support / "Migrations" / run_id
    manifest_path = run_root / "manifest.json"

    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("baseGraph", {}).get("sha256") != graph_hash:
            raise MigrationError("existing migration manifest belongs to different Graph/current.json bytes")
    else:
        manifest = build_plan(support, graph, graph_hash, run_id)

    if not args.apply:
        print(json.dumps({"mode": "plan", "runRoot": str(run_root), "manifest": manifest}, indent=2, ensure_ascii=False))
        return 0

    lock_path = support / ".locks" / "managed-library-v3.lock"
    failures: list[str] = []
    failure_details: dict[str, str] = {}
    with MATERIALIZER.directory_lock(lock_path):
        run_root.mkdir(parents=True, exist_ok=True)
        backup_graph = run_root / "backups" / "Graph" / "current.json"
        if backup_graph.exists() and sha256_file(backup_graph) != graph_hash:
            raise MigrationError(f"graph backup collision: {backup_graph}")
        if not backup_graph.exists():
            atomic_write(backup_graph, graph_bytes)
        manifest["state"] = "running"
        manifest["updatedAt"] = utc_now()
        atomic_write(manifest_path, json_bytes(manifest))

        for entry in manifest["papers"]:
            paper_id = entry["paperId"]
            paper = next((item for item in graph["papers"] if item.get("id") == paper_id), None)
            if paper is None:
                entry.update({"status": "failed", "error": "paper disappeared from locked graph"})
                failures.append(paper_id)
                atomic_write(manifest_path, json_bytes(manifest))
                continue
            try:
                source = Path(entry["sourceOriginalPath"])
                MATERIALIZER.validate_pdf(source)
                source_hash = sha256_file(source)
                target = support / safe_relative(entry["targetPdfPath"], "target PDF path")
                if target.exists():
                    if sha256_file(target) != source_hash:
                        raise MigrationError(f"managed PDF hash mismatch for {paper_id}; refusing overwrite")
                else:
                    atomic_copy(source, target)
                extraction_diagnostics: dict[str, Any] = {}
                pages = MATERIALIZER.extract_pages(target, extraction_diagnostics)
                meaningful_chars = len(re.sub(r"\s+", "", "".join(pages)))
                extraction_status = "extracted" if meaningful_chars >= max(80, len(pages) * 10) else "needs_ocr"
                metadata = paper_metadata(paper, source_hash, extraction_status, extraction_diagnostics)

                card = support / safe_relative(entry["cardPath"], "card path")
                fulltext = support / safe_relative(entry["fulltextPath"], "fulltext path")
                backup_card = run_root / "backups" / entry["cardPath"]
                backup_fulltext = run_root / "backups" / entry["fulltextPath"]
                current_card = card.read_text(encoding="utf-8") if card.exists() else None
                recorded_card_hash = entry.get("cardSha256")
                if current_card is not None and recorded_card_hash and sha256_file(card) != recorded_card_hash:
                    raise MigrationError(f"card changed after migration for {paper_id}; refusing overwrite")
                if backup_card.exists():
                    legacy_card = backup_card.read_text(encoding="utf-8")
                elif current_card is not None and not card_has_schema(current_card):
                    backup_once(card, backup_card)
                    legacy_card = current_card
                else:
                    legacy_card = None
                expected_card = migrated_card(metadata, extraction_status, legacy_card)
                expected_card_bytes = expected_card.encode("utf-8")
                if not card.exists() or sha256_file(card) != sha256_bytes(expected_card_bytes):
                    atomic_write(card, expected_card_bytes)

                fulltext_text = MATERIALIZER.fulltext_markdown(metadata, pages, extraction_status)
                fulltext_bytes = fulltext_text.encode("utf-8")
                recorded_fulltext_hash = entry.get("fulltextSha256")
                if fulltext.exists() and recorded_fulltext_hash and sha256_file(fulltext) != recorded_fulltext_hash:
                    raise MigrationError(f"full text changed after migration for {paper_id}; refusing overwrite")
                if fulltext.exists() and not recorded_fulltext_hash and sha256_file(fulltext) != sha256_bytes(fulltext_bytes):
                    backup_once(fulltext, backup_fulltext)
                if not fulltext.exists() or sha256_file(fulltext) != sha256_bytes(fulltext_bytes):
                    atomic_write(fulltext, fulltext_bytes)

                entry.update({
                    "status": "completed",
                    "sourceSha256": source_hash,
                    "managedPdfSha256": sha256_file(target),
                    "cardSha256": sha256_file(card),
                    "fulltextSha256": sha256_file(fulltext),
                    "pageCount": len(pages),
                    "meaningfulCharacters": meaningful_chars,
                    "extractionStatus": extraction_status,
                    "extractionDiagnostics": extraction_diagnostics,
                    "verificationStatus": metadata["verificationStatus"],
                    "metadata": metadata,
                    "completedAt": utc_now(),
                })
                entry.pop("error", None)
            except Exception as error:  # Continue so the manifest records every failed source.
                entry.update({"status": "failed", "error": str(error)})
                failures.append(paper_id)
                failure_details[paper_id] = str(error)
            manifest["updatedAt"] = utc_now()
            atomic_write(manifest_path, json_bytes(manifest))

        if failures:
            manifest["state"] = "incomplete"
            manifest["failedPaperIds"] = sorted(set(failures))
            manifest["updatedAt"] = utc_now()
            with contextlib.suppress(FileNotFoundError):
                (run_root / "snapshot.json").unlink()
            atomic_write(manifest_path, json_bytes(manifest))
            details = "; ".join(f"{paper_id}: {failure_details.get(paper_id, 'unknown error')}" for paper_id in sorted(set(failures)))
            raise MigrationError(f"migration incomplete; {details}")

        completed = {entry["paperId"]: entry for entry in manifest["papers"]}
        snapshot = make_snapshot(graph, completed, manifest["createdAt"])
        snapshot_bytes = json_bytes(snapshot)
        atomic_write(run_root / "snapshot.json", snapshot_bytes)
        index = {
            "schemaVersion": 2,
            "papers": [completed[paper["id"]]["metadata"] for paper in sorted(graph["papers"], key=lambda item: item["id"])],
        }
        index_path = support / "Knowledge" / "papers.json"
        recorded_index_hash = manifest.get("indexSha256")
        if index_path.exists() and recorded_index_hash and sha256_file(index_path) != recorded_index_hash:
            raise MigrationError("knowledge index changed after migration; refusing overwrite")
        if index_path.exists() and not recorded_index_hash:
            backup_once(index_path, run_root / "backups" / "Knowledge" / "papers.json")
        atomic_write(index_path, json_bytes(index))
        manifest.update({
            "state": "completed",
            "updatedAt": utc_now(),
            "completedAt": utc_now(),
            "snapshotSha256": sha256_bytes(snapshot_bytes),
            "indexSha256": sha256_file(index_path),
            "failedPaperIds": [],
        })
        atomic_write(manifest_path, json_bytes(manifest))

    print(json.dumps({
        "status": "completed",
        "runId": run_id,
        "papers": len(manifest["papers"]),
        "snapshot": str(run_root / "snapshot.json"),
        "snapshotSha256": manifest["snapshotSha256"],
        "currentGraphModified": False,
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (MigrationError, MATERIALIZER.MaterializeError) as error:
        print(f"migrate-managed-library: {error}", file=sys.stderr)
        raise SystemExit(2)
