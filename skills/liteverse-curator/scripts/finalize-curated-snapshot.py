#!/usr/bin/env python3
"""Synchronize curated cards into full-text metadata and an unstaged graph snapshot.

This integrity gate never touches Graph/current.json, Usage, queues, or a
pending Refresh.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any


DEFAULT_SUPPORT = Path.home() / "Library" / "Application Support" / "Liteverse"
REQUIRED_HEADINGS = (
    "Research question",
    "Methods",
    "Equations and conventions",
    "Main results",
    "Limitations",
    "Project role",
    "Evidence index",
    "Annotation provenance",
)
SCIENTIFIC_HEADINGS = REQUIRED_HEADINGS[:6]
ALLOWED_VERIFICATION = {
    "imported",
    "extracted",
    "needs_ocr",
    "card_draft",
    "evidence_verified",
    "needs_attention",
    "source_missing",
}


class FinalizationError(RuntimeError):
    """A curated artifact failed an integrity precondition."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)
        raise


def parse_scalar(value: str) -> Any:
    value = value.strip()
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def parse_frontmatter(text: str, path: Path) -> tuple[dict[str, Any], str, list[str]]:
    match = re.match(r"\A---\r?\n(.*?)\r?\n---\r?\n(.*)\Z", text, flags=re.DOTALL)
    if not match:
        raise FinalizationError(f"missing YAML frontmatter: {path}")
    lines = match.group(1).splitlines()
    metadata: dict[str, Any] = {}
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            raise FinalizationError(f"invalid frontmatter line in {path}: {line}")
        key, value = line.split(":", 1)
        metadata[key.strip()] = parse_scalar(value)
    return metadata, match.group(2), lines


def json_value(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ": "))


def update_frontmatter(text: str, path: Path, updates: dict[str, Any]) -> str:
    _, body, lines = parse_frontmatter(text, path)
    remaining = dict(updates)
    output: list[str] = []
    for line in lines:
        if ":" not in line:
            output.append(line)
            continue
        key = line.split(":", 1)[0].strip()
        if key in remaining:
            output.append(f"{key}: {json_value(remaining.pop(key))}")
        else:
            output.append(line)
    for key, value in remaining.items():
        output.append(f"{key}: {json_value(value)}")
    return "---\n" + "\n".join(output) + "\n---\n" + body


def safe_support_path(support: Path, relative: str, label: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or not candidate.parts or ".." in candidate.parts:
        raise FinalizationError(f"{label} must be support-relative: {relative}")
    resolved_support = support.resolve()
    resolved = (support / candidate).resolve()
    if resolved != resolved_support and resolved_support not in resolved.parents:
        raise FinalizationError(f"{label} escapes the support directory: {relative}")
    return resolved


def refuse_protected_graph_target(path: Path) -> None:
    """Refuse graph files whose location is immutable by contract.

    Check both the lexical absolute path and the symlink-resolved path.  This is
    intentionally independent of the selected support directory: a caller must
    not bypass the guard with ``--support-dir`` or an unrelated temporary root.
    """

    candidates = {
        Path(os.path.abspath(path.expanduser())),
        path.expanduser().resolve(),
    }
    for candidate in candidates:
        parts = candidate.parts
        for index, part in enumerate(parts):
            if part != "Graph":
                continue
            tail = parts[index + 1 :]
            if tail == ("current.json",):
                raise FinalizationError("refusing to modify Graph/current.json")
            if tail and tail[0] == "staged":
                raise FinalizationError("refusing to modify immutable Graph/staged artifact")
            if tail and tail[0] == "history":
                raise FinalizationError("refusing to modify immutable Graph/history artifact")


def section(text: str, heading: str) -> str:
    match = re.search(
        rf"^## {re.escape(heading)}\s*$\n(.*?)(?=^## |\Z)",
        text,
        flags=re.MULTILINE | re.DOTALL,
    )
    if not match:
        raise FinalizationError(f"missing card heading: {heading}")
    return match.group(1).strip()


def cleaned_bullets(value: str, limit: int) -> list[str]:
    bullets: list[str] = []
    for raw in value.splitlines():
        if not raw.startswith("- "):
            continue
        cleaned = re.sub(r"(?:\s*\[E\d+\])+\s*", " ", raw[2:])
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if cleaned:
            bullets.append(cleaned)
        if len(bullets) >= limit:
            break
    return bullets


def bullet_blocks(value: str) -> list[str]:
    """Return top-level Markdown bullets, including indented continuation text."""

    bullets: list[str] = []
    current: list[str] | None = None
    for raw in value.splitlines():
        if raw.startswith("- "):
            if current is not None:
                bullets.append(" ".join(current).strip())
            current = [raw[2:].strip()]
        elif current is not None and (raw.startswith("  ") or raw.startswith("\t")):
            current.append(raw.strip())
    if current is not None:
        bullets.append(" ".join(current).strip())
    return bullets


def parse_evidence_entries(value: str, paper_id: str, strict: bool) -> dict[int, str]:
    entries: dict[int, str] = {}
    evidence_pattern = re.compile(
        r"^E(\d+)\s+(?:—|--|-)\s+(.+?)\s+(?:—|--|-)\s+(.+)$"
    )
    for bullet in bullet_blocks(value):
        match = evidence_pattern.match(bullet)
        if not match:
            if strict:
                raise FinalizationError(f"malformed evidence index entry for {paper_id}: {bullet}")
            continue
        evidence_id = int(match.group(1))
        if evidence_id in entries:
            raise FinalizationError(f"duplicate evidence ID E{evidence_id} for {paper_id}")
        locator = match.group(2).strip()
        paraphrase = match.group(3).strip()
        if strict:
            validate_evidence_locator(locator, paper_id, evidence_id)
            if not paraphrase:
                raise FinalizationError(f"evidence E{evidence_id} has no paraphrase for {paper_id}")
        entries[evidence_id] = locator
    return entries


def validate_evidence_locator(locator: str, paper_id: str, evidence_id: int) -> None:
    """Require an explicit original-source locator, never a vague placeholder."""

    if re.search(r"\b(?:todo|unknown|unspecified|none|n/?a)\b|\?", locator, re.IGNORECASE):
        raise FinalizationError(f"evidence E{evidence_id} has a placeholder locator for {paper_id}")

    explicit_patterns = (
        # PDF/page forms used by the managed library, including page ranges.
        r"\b(?:p|pp)\.?\s*[1-9]\d*(?:\s*[–—-]\s*[1-9]\d*)?\b",
        r"\bpages?\s*[:.]?\s*[1-9]\d*(?:\s*[–—-]\s*[1-9]\d*)?\b",
        # Named or numbered source sections.
        r"\bsec(?:tion)?s?\.?\s*(?:[A-Z0-9][A-Z0-9_.:()–—-]*)",
        r"\b(?:abstract|introduction|methods?|results?|discussion|conclusions?|appendix(?:\s+[A-Z0-9][A-Z0-9_.:()–—-]*)?)\b",
        # Numbered equations, figures, and tables.
        r"\beq(?:uation)?s?\.?\s*\(?[A-Z0-9][A-Z0-9_.:–—-]*\)?",
        r"\bfig(?:ure)?s?\.?\s*[A-Z0-9][A-Z0-9_.:()–—-]*",
        r"\btables?\.?\s*[A-Z0-9][A-Z0-9_.:()–—-]*",
        # Common CJK source-location forms, encoded to keep source prose English.
        r"\u7b2c\s*[1-9]\d*\s*\u9875",
        r"\u7b2c\s*[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u53430-9]+\s*\u8282",
        r"(?:\u516c\u5f0f|\u65b9\u7a0b|\u56fe|\u8868)\s*[\uff08(]?[A-Z0-9\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+[\uff09)]?",
    )
    if not any(re.search(pattern, locator, re.IGNORECASE) for pattern in explicit_patterns):
        raise FinalizationError(
            f"evidence E{evidence_id} lacks an explicit page/section/equation/figure/table locator for {paper_id}"
        )


def validate_scientific_evidence_references(
    body: str,
    paper_id: str,
    evidence_ids: set[int],
) -> None:
    for heading in SCIENTIFIC_HEADINGS:
        bullets = bullet_blocks(section(body, heading))
        if not bullets:
            raise FinalizationError(f"verified scientific section has no bullets for {paper_id}: {heading}")
        for bullet in bullets:
            references = [int(value) for value in re.findall(r"\[E(\d+)\]", bullet)]
            if not references:
                raise FinalizationError(
                    f"scientific bullet has no evidence reference for {paper_id} in {heading}: {bullet}"
                )
            missing = sorted(set(references) - evidence_ids)
            if missing:
                formatted = ", ".join(f"E{value}" for value in missing)
                raise FinalizationError(
                    f"scientific bullet references unknown evidence for {paper_id} in {heading}: {formatted}"
                )


def validate_fulltext_source_markers(text: str, paper_id: str) -> None:
    if not re.search(r"<!--\s*page:\s*[1-9]\d*\s*-->", text):
        raise FinalizationError(f"verified card fulltext has no positive page marker: {paper_id}")


def validate_card(
    paper_id: str,
    metadata: dict[str, Any],
    body: str,
    pdf_hash: str,
    card_path: Path,
) -> int:
    if metadata.get("paper_id") != paper_id:
        raise FinalizationError(f"card paper_id mismatch: {card_path}")
    if metadata.get("source_sha256") != pdf_hash:
        raise FinalizationError(f"card/PDF SHA-256 mismatch: {paper_id}")
    status = metadata.get("verification_status")
    if status not in ALLOWED_VERIFICATION:
        raise FinalizationError(f"invalid verification_status for {paper_id}: {status}")
    for heading in REQUIRED_HEADINGS:
        section(body, heading)
    strict_evidence = status in {"evidence_verified", "needs_attention"}
    evidence_entries = parse_evidence_entries(section(body, "Evidence index"), paper_id, strict_evidence)
    evidence_count = metadata.get("evidence_count")
    if not isinstance(evidence_count, int) or evidence_count < 0:
        raise FinalizationError(f"invalid evidence_count for {paper_id}")
    if evidence_count != len(evidence_entries):
        raise FinalizationError(
            f"evidence_count mismatch for {paper_id}: metadata {evidence_count}, index {len(evidence_entries)}"
        )
    if evidence_entries and list(evidence_entries) != list(range(1, len(evidence_entries) + 1)):
        raise FinalizationError(f"non-sequential evidence IDs for {paper_id}")
    curated_body = body.split("### Legacy card retained for evidence review", 1)[0]
    if status in {"evidence_verified", "needs_attention"}:
        if evidence_count == 0:
            raise FinalizationError(f"{status} card has no evidence: {paper_id}")
        if re.search(r"\bTODO\b", curated_body, flags=re.IGNORECASE):
            raise FinalizationError(f"curated card still contains TODO: {paper_id}")
        validate_scientific_evidence_references(body, paper_id, set(evidence_entries))
    return evidence_count


def finalize(args: argparse.Namespace) -> dict[str, Any]:
    support = args.support_dir.expanduser().resolve()
    refuse_protected_graph_target(args.snapshot)
    snapshot_path = args.snapshot.expanduser().resolve()
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    if not str(snapshot.get("schemaVersion", "")).startswith("3."):
        raise FinalizationError("only schema-v3 unstaged snapshots may be finalized")

    papers = snapshot.get("papers")
    if not isinstance(papers, list):
        raise FinalizationError("snapshot papers must be an array")
    updated_fulltexts: list[str] = []
    prepared_fulltexts: list[tuple[Path, str]] = []
    status_counts: dict[str, int] = {}

    for paper in papers:
        if not isinstance(paper, dict) or not isinstance(paper.get("id"), str):
            raise FinalizationError("invalid snapshot paper")
        paper_id = paper["id"]
        artifacts = paper.get("artifacts") if isinstance(paper.get("artifacts"), dict) else {}
        source = paper.get("source") if isinstance(paper.get("source"), dict) else {}
        card_relative = paper.get("markdownPath") or artifacts.get("cardPath")
        fulltext_relative = paper.get("fulltextPath") or artifacts.get("fulltextPath")
        pdf_relative = source.get("pdfPath") or paper.get("pdfPath")
        if not all(isinstance(value, str) and value for value in (card_relative, fulltext_relative, pdf_relative)):
            raise FinalizationError(f"paper {paper_id} is missing managed artifact paths")

        card_path = safe_support_path(support, card_relative, "card path")
        fulltext_path = safe_support_path(support, fulltext_relative, "fulltext path")
        pdf_path = safe_support_path(support, pdf_relative, "PDF path")
        if not card_path.is_file() or not fulltext_path.is_file() or not pdf_path.is_file():
            raise FinalizationError(f"managed artifact missing for {paper_id}")

        card_text = card_path.read_text(encoding="utf-8")
        card, card_body, _ = parse_frontmatter(card_text, card_path)
        pdf_hash = sha256_file(pdf_path)
        evidence_count = validate_card(paper_id, card, card_body, pdf_hash, card_path)
        status = card["verification_status"]
        status_counts[status] = status_counts.get(status, 0) + 1

        title = card.get("title")
        authors = card.get("authors")
        if not isinstance(title, str) or not title.strip():
            raise FinalizationError(f"card title missing for {paper_id}")
        if not isinstance(authors, list) or not authors or not all(isinstance(item, str) and item.strip() for item in authors):
            raise FinalizationError(f"card authors missing for {paper_id}")

        summary_parts = cleaned_bullets(section(card_body, "Research question"), 1)
        summary_parts += cleaned_bullets(section(card_body, "Main results"), 1)
        project_role = cleaned_bullets(section(card_body, "Project role"), 2)
        if not summary_parts or not project_role:
            raise FinalizationError(f"card lacks graph summary/project role content: {paper_id}")

        primary = card.get("primary_category")
        secondary = card.get("secondary_category")
        paper["title"] = title.strip()
        paper["authors"] = ", ".join(item.strip() for item in authors)
        paper["metadataStatus"] = card.get("metadata_status", "provisional")
        paper["verificationStatus"] = status
        paper["summary"] = " ".join(summary_parts)
        paper["projectRole"] = " ".join(project_role)
        paper["primaryCategory"] = primary
        paper["categoryIds"] = [primary] + ([secondary] if secondary else [])
        paper["classificationStatus"] = card.get("classification_status", "provisional")
        paper["tags"] = card.get("tags") if isinstance(card.get("tags"), list) else []
        paper["source"] = {
            **source,
            "kind": card.get("source_type", "pdf"),
            "pdfPath": pdf_relative,
            "sha256": pdf_hash,
            "arxivId": card.get("arxiv_id"),
            "doi": card.get("doi"),
        }
        paper["artifacts"] = {
            **artifacts,
            "cardPath": card_relative,
            "fulltextPath": fulltext_relative,
            "extractionStatus": card.get("extraction_status"),
            "cardSchemaVersion": card.get("card_schema_version", "liteverse-card-v1"),
            "evidenceCount": evidence_count,
        }
        paper["useCount"] = 0

        fulltext_text = fulltext_path.read_text(encoding="utf-8")
        if status in {"evidence_verified", "needs_attention"}:
            validate_fulltext_source_markers(fulltext_text, paper_id)
        next_fulltext = update_frontmatter(fulltext_text, fulltext_path, {
            "title": title.strip(),
            "authors": authors,
            "metadata_status": card.get("metadata_status", "provisional"),
            "source_sha256": pdf_hash,
            "arxiv_id": card.get("arxiv_id"),
            "doi": card.get("doi"),
            "extraction_status": card.get("extraction_status"),
            "verification_status": status,
        })
        next_fulltext = re.sub(r"(?m)^# .*?$", f"# {title.strip()}", next_fulltext, count=1)
        if next_fulltext != fulltext_text:
            updated_fulltexts.append(paper_id)
            prepared_fulltexts.append((fulltext_path, next_fulltext))

    snapshot["updated"] = utc_now()
    serialized = json.dumps(snapshot, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    if not args.dry_run:
        # Two-phase validation: no full text is changed until every paper in the
        # complete snapshot has passed all source/evidence checks.
        for fulltext_path, next_fulltext in prepared_fulltexts:
            atomic_write(fulltext_path, next_fulltext)
        atomic_write(snapshot_path, serialized)
    return {
        "status": "validated" if args.dry_run else "finalized",
        "snapshot": str(snapshot_path),
        "paperCount": len(papers),
        "updatedFulltexts": updated_fulltexts,
        "verificationStatusCounts": status_counts,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--support-dir", type=Path, default=DEFAULT_SUPPORT)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> None:
    try:
        result = finalize(parse_args())
    except (FinalizationError, OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"finalize-curated-snapshot: {error}") from error
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
