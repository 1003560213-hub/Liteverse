#!/usr/bin/env python3
"""Materialize a PDF or an official arXiv source into Liteverse Markdown."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
from typing import Any, Iterable
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


DEFAULT_SUPPORT = Path.home() / "Library" / "Application Support" / "Liteverse"
PAPER_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ARXIV_RE = re.compile(
    r"(?:https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/)?"
    r"(?P<id>(?:\d{4}\.\d{4,5}|[a-zA-Z.\-]+/\d{7})(?:v\d+)?)"
    r"(?:\.pdf)?/?$",
    re.IGNORECASE,
)


class MaterializeError(RuntimeError):
    """Expected input or extraction failure."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalized_text(value: str | None) -> str:
    if not value:
        return ""
    return " ".join(re.sub(r"[^\w]+", " ", value.casefold(), flags=re.UNICODE).split())


def normalize_doi(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", value.strip(), flags=re.I)
    return cleaned.casefold() or None


def arxiv_base(value: str | None) -> str | None:
    if not value:
        return None
    return re.sub(r"v\d+$", "", value, flags=re.I).casefold()


def slug(value: str) -> str:
    ascii_value = value.encode("ascii", "ignore").decode("ascii").casefold()
    result = re.sub(r"[^a-z0-9]+", "-", ascii_value).strip("-")
    return result[:72].strip("-") or "paper"


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


def write_json(path: Path, value: Any) -> None:
    atomic_write(path, (json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode())


@contextlib.contextmanager
def directory_lock(lock_path: Path, timeout: float = 15.0) -> Iterable[None]:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    while True:
        try:
            lock_path.mkdir()
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise MaterializeError(f"timed out waiting for lock: {lock_path}")
            time.sleep(0.05)
    try:
        yield
    finally:
        with contextlib.suppress(FileNotFoundError):
            lock_path.rmdir()


def parse_arxiv(value: str) -> str:
    match = ARXIV_RE.fullmatch(value.strip())
    if not match:
        raise MaterializeError(f"invalid arXiv ID or URL: {value}")
    return match.group("id")


def http_bytes(url: str, timeout: float, accept: str) -> tuple[bytes, str]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Liteverse-Curator/1.0 (research literature materializer)", "Accept": accept},
    )
    try:
        try:
            import certifi  # type: ignore

            tls_context = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            tls_context = ssl.create_default_context()
        with urllib.request.urlopen(request, timeout=timeout, context=tls_context) as response:
            return response.read(), response.headers.get("Content-Type", "")
    except (urllib.error.URLError, TimeoutError) as error:
        curl = shutil.which("curl")
        if curl and isinstance(getattr(error, "reason", None), ssl.SSLCertVerificationError):
            result = subprocess.run(
                [
                    curl,
                    "--fail",
                    "--location",
                    "--silent",
                    "--show-error",
                    "--connect-timeout",
                    str(max(1, int(timeout))),
                    "--max-time",
                    str(max(1, int(timeout))),
                    "--user-agent",
                    "Liteverse-Curator/1.0 (research literature materializer)",
                    "--header",
                    f"Accept: {accept}",
                    url,
                ],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            if result.returncode == 0:
                return result.stdout, ""
            raise MaterializeError(
                f"network request failed for {url}: {result.stderr.decode(errors='replace').strip()}"
            ) from error
        raise MaterializeError(f"network request failed for {url}: {error}") from error


def fetch_arxiv(arxiv_id: str, timeout: float, temp_dir: Path) -> tuple[Path, dict[str, Any]]:
    query = urllib.parse.urlencode({"id_list": arxiv_id})
    feed_bytes, _ = http_bytes(f"https://export.arxiv.org/api/query?{query}", timeout, "application/atom+xml")
    try:
        root = ET.fromstring(feed_bytes)
    except ET.ParseError as error:
        raise MaterializeError(f"arXiv returned invalid metadata XML: {error}") from error
    atom = {"a": "http://www.w3.org/2005/Atom", "x": "http://arxiv.org/schemas/atom"}
    entry = root.find("a:entry", atom)
    if entry is None:
        raise MaterializeError(f"official arXiv metadata contains no entry for {arxiv_id}")

    canonical_url = (entry.findtext("a:id", default="", namespaces=atom) or "").strip()
    canonical_id = canonical_url.rsplit("/", 1)[-1]
    if arxiv_base(canonical_id) != arxiv_base(arxiv_id):
        raise MaterializeError(
            f"arXiv metadata identity mismatch: requested {arxiv_id}, received {canonical_id or 'unknown'}"
        )
    title = " ".join((entry.findtext("a:title", default="", namespaces=atom) or "").split())
    authors = [
        " ".join((node.findtext("a:name", default="", namespaces=atom) or "").split())
        for node in entry.findall("a:author", atom)
    ]
    authors = [author for author in authors if author]
    doi = normalize_doi(entry.findtext("x:doi", default="", namespaces=atom))
    if not title or not authors:
        raise MaterializeError(f"official arXiv metadata is incomplete for {arxiv_id}")

    pdf_bytes, content_type = http_bytes(
        f"https://arxiv.org/pdf/{urllib.parse.quote(arxiv_id, safe='/')}.pdf",
        timeout,
        "application/pdf",
    )
    if b"%PDF-" not in pdf_bytes[:1024]:
        raise MaterializeError(f"arXiv PDF download was not a PDF (content type {content_type or 'unknown'})")
    pdf_path = temp_dir / "source.pdf"
    pdf_path.write_bytes(pdf_bytes)
    metadata = {
        "arxivId": canonical_id or arxiv_id,
        "title": title,
        "authors": authors,
        "doi": doi,
        "published": entry.findtext("a:published", default="", namespaces=atom) or None,
        "updated": entry.findtext("a:updated", default="", namespaces=atom) or None,
        "officialUrl": canonical_url or f"https://arxiv.org/abs/{arxiv_id}",
    }
    return pdf_path, metadata


def validate_pdf(path: Path) -> None:
    if not path.is_file():
        raise MaterializeError(f"PDF does not exist: {path}")
    if path.stat().st_size < 8:
        raise MaterializeError(f"PDF is empty or truncated: {path}")
    with path.open("rb") as handle:
        if b"%PDF-" not in handle.read(1024):
            raise MaterializeError(f"file is not a PDF: {path}")


class PdfLogCapture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


@contextlib.contextmanager
def capture_pdf_warnings() -> Iterable[PdfLogCapture]:
    logger = logging.getLogger("pypdf")
    handler = PdfLogCapture()
    old_level = logger.level
    old_propagate = logger.propagate
    logger.addHandler(handler)
    logger.setLevel(logging.WARNING)
    logger.propagate = False
    try:
        yield handler
    finally:
        logger.removeHandler(handler)
        logger.setLevel(old_level)
        logger.propagate = old_propagate


def extract_with_python(path: Path) -> tuple[list[str] | None, str | None]:
    readers: list[tuple[str, Any]] = []
    try:
        from pypdf import PdfReader  # type: ignore

        readers.append(("pypdf", PdfReader))
    except ImportError:
        pass
    try:
        import pdfplumber  # type: ignore

        with pdfplumber.open(path) as document:
            return [(page.extract_text() or "").replace("\x00", "") for page in document.pages], "pdfplumber"
    except ImportError:
        pass
    except Exception:
        if not readers:
            raise
    for _, reader_type in readers:
        document = reader_type(str(path))
        return [(page.extract_text() or "").replace("\x00", "") for page in document.pages], "pypdf"
    return None, None


def extract_pages(path: Path, diagnostics: dict[str, Any] | None = None) -> list[str]:
    with capture_pdf_warnings() as captured:
        try:
            pages, engine = extract_with_python(path)
        except Exception as error:
            raise MaterializeError(f"PDF parser rejected {path.name}: {error}") from error
    unique_warnings = list(dict.fromkeys(captured.messages))
    if diagnostics is not None:
        diagnostics.update({
            "engine": engine,
            "warningCount": len(captured.messages),
            "warningSamples": unique_warnings[:20],
        })
    if pages is not None:
        if not pages:
            raise MaterializeError(f"PDF contains no pages: {path}")
        return pages

    command = shutil.which("pdftotext")
    if not command:
        raise MaterializeError("PDF extraction requires pypdf, pdfplumber, or the pdftotext command")
    result = subprocess.run(
        [command, "-enc", "UTF-8", str(path), "-"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise MaterializeError(f"pdftotext rejected {path.name}: {result.stderr.decode(errors='replace').strip()}")
    pages = result.stdout.decode("utf-8", errors="replace").split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    if not pages:
        raise MaterializeError(f"PDF contains no pages: {path}")
    if diagnostics is not None:
        diagnostics["engine"] = "pdftotext"
    return pages


def read_index(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schemaVersion": 1, "papers": []}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MaterializeError(f"refusing invalid knowledge index {path}: {error}") from error
    if not isinstance(value, dict) or not isinstance(value.get("papers"), list):
        raise MaterializeError(f"refusing invalid knowledge index {path}: expected papers array")
    return value


def duplicate_of(index: dict[str, Any], identity: dict[str, Any]) -> dict[str, Any] | None:
    title_key = normalized_text(identity.get("title"))
    author_key = "|".join(sorted(normalized_text(item) for item in identity.get("authors", []) if item))
    for paper in index["papers"]:
        if paper.get("sha256") == identity["sha256"]:
            return paper
        if identity.get("arxivBase") and paper.get("arxivBase") == identity["arxivBase"]:
            return paper
        if identity.get("doi") and normalize_doi(paper.get("doi")) == identity["doi"]:
            return paper
        paper_authors = "|".join(
            sorted(normalized_text(item) for item in paper.get("authors", []) if item)
        )
        if title_key and author_key and normalized_text(paper.get("title")) == title_key and paper_authors == author_key:
            return paper
    return None


def yaml_value(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def fulltext_markdown(metadata: dict[str, Any], pages: list[str], extraction_status: str) -> str:
    lines = [
        "---",
        f"paper_id: {yaml_value(metadata['paperId'])}",
        f"title: {yaml_value(metadata['title'])}",
        f"authors: {yaml_value(metadata['authors'])}",
        f"metadata_status: {yaml_value(metadata.get('metadataStatus', 'provisional'))}",
        f"source_type: {yaml_value(metadata['sourceType'])}",
        f"source_sha256: {yaml_value(metadata['sha256'])}",
        f"arxiv_id: {yaml_value(metadata.get('arxivId'))}",
        f"doi: {yaml_value(metadata.get('doi'))}",
        f"extraction_status: {yaml_value(extraction_status)}",
        f"extraction_engine: {yaml_value(metadata.get('extractionDiagnostics', {}).get('engine'))}",
        f"extraction_warning_count: {yaml_value(metadata.get('extractionDiagnostics', {}).get('warningCount', 0))}",
        f"verification_status: {yaml_value(metadata['verificationStatus'])}",
        f"library_item_id: {yaml_value(metadata.get('libraryItemId'))}",
        f"library_item_revision: {yaml_value(metadata.get('libraryItemRevision'))}",
        "annotation_revisions: []",
        "---",
        "",
        f"# {metadata['title']}",
        "",
    ]
    for number, text in enumerate(pages, 1):
        lines.extend([f"<!-- page: {number} -->", ""])
        cleaned = text.strip()
        lines.extend([cleaned if cleaned else "[No extractable text on this page.]", ""])
    return "\n".join(lines).rstrip() + "\n"


def card_markdown(metadata: dict[str, Any], extraction_status: str) -> str:
    lines = [
        "---",
        f"paper_id: {yaml_value(metadata['paperId'])}",
        f"title: {yaml_value(metadata['title'])}",
        f"authors: {yaml_value(metadata['authors'])}",
        f"metadata_status: {yaml_value(metadata.get('metadataStatus', 'provisional'))}",
        f"source_type: {yaml_value(metadata['sourceType'])}",
        f"source_sha256: {yaml_value(metadata['sha256'])}",
        f"arxiv_id: {yaml_value(metadata.get('arxivId'))}",
        f"doi: {yaml_value(metadata.get('doi'))}",
        f"pdf_path: {yaml_value(metadata['pdfPath'])}",
        f"fulltext_path: {yaml_value(metadata['fulltextPath'])}",
        f"extraction_status: {yaml_value(extraction_status)}",
        f"extraction_engine: {yaml_value(metadata.get('extractionDiagnostics', {}).get('engine'))}",
        f"extraction_warning_count: {yaml_value(metadata.get('extractionDiagnostics', {}).get('warningCount', 0))}",
        f"verification_status: {yaml_value(metadata['verificationStatus'])}",
        "card_schema_version: liteverse-card-v1",
        "evidence_count: 0",
        f"library_item_id: {yaml_value(metadata.get('libraryItemId'))}",
        f"library_item_revision: {yaml_value(metadata.get('libraryItemRevision'))}",
        "annotation_revisions: []",
        f"primary_category: {yaml_value(metadata.get('primaryCategory'))}",
        f"secondary_category: {yaml_value(metadata.get('secondaryCategory'))}",
        f"classification_status: {yaml_value(metadata.get('classificationStatus', 'provisional'))}",
        f"tags: {yaml_value(metadata.get('tags', []))}",
        "---",
        "",
        f"# {metadata['title']}",
        "",
        "## Research question",
        "",
        "- TODO: Read the original text and add evidence-backed content.",
        "",
        "## Methods",
        "",
        "- TODO: Identify methods with evidence locators.",
        "",
        "## Equations and conventions",
        "",
        "- TODO: Record definitions, units, and conventions before comparing papers.",
        "",
        "## Main results",
        "",
        "- TODO: Record only results supported by the original text.",
        "",
        "## Limitations",
        "",
        "- TODO: Record stated and evidence-backed limitations.",
        "",
        "## Project role",
        "",
        "- TODO: Keep project relevance separate from scientific relationship strength.",
        "",
        "## Evidence index",
        "",
        "- TODO: Add entries such as `E1 — p. 3, Sec. 2 — faithful paraphrase`.",
        "",
        "## Annotation provenance",
        "",
        "- Integrated annotations: none.",
        "- On integration, append `<!-- liteverse-annotation-provenance: {\"annotationId\":\"<id>\",\"sourceRevision\":<positive-integer>} -->`.",
    ]
    if extraction_status == "needs_ocr":
        lines.extend(["", "> Extraction status: needs OCR. Do not complete this card from the filename or title alone."])
    return "\n".join(lines).rstrip() + "\n"


def choose_paper_id(requested: str | None, metadata: dict[str, Any], sha256: str, index: dict[str, Any]) -> str:
    if requested:
        if not PAPER_ID_RE.fullmatch(requested):
            raise MaterializeError("--paper-id must contain lowercase letters, digits, and single hyphen separators")
        candidate = requested
    elif metadata.get("arxivId"):
        candidate = slug(f"arxiv-{arxiv_base(metadata['arxivId'])}")
    else:
        candidate = slug(metadata["title"])
    ids = {paper.get("paperId") for paper in index["papers"]}
    if candidate not in ids:
        return candidate
    alternate = f"{candidate}-{sha256[:8]}"
    if alternate not in ids:
        return alternate
    raise MaterializeError(f"paper ID collision for {candidate}; provide a unique --paper-id")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Preserve and deduplicate a PDF/arXiv paper, then write page-marked full text and a card skeleton."
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--pdf", type=Path, help="Local PDF path")
    source.add_argument("--arxiv", help="Official arXiv ID, abs URL, or PDF URL")
    parser.add_argument("--paper-id", help="Stable lowercase Liteverse paper ID")
    parser.add_argument("--title", help="Exact title for a local PDF; defaults to the filename stem")
    parser.add_argument("--author", action="append", default=[], help="Exact author for a local PDF; repeat as needed")
    parser.add_argument("--doi", help="DOI for a local PDF")
    parser.add_argument("--library-item-id", help="Locked library.json item ID that produced this paper")
    parser.add_argument("--library-revision", type=int, help="Locked positive library item revision")
    parser.add_argument(
        "--support-dir",
        type=Path,
        default=Path(os.environ.get("LITEVERSE_SUPPORT_DIR", DEFAULT_SUPPORT)),
        help="Liteverse Application Support root",
    )
    parser.add_argument("--timeout", type=float, default=30.0, help="Network timeout in seconds")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if bool(args.library_item_id) != (args.library_revision is not None):
        raise MaterializeError("--library-item-id and --library-revision must be supplied together")
    if args.library_revision is not None and args.library_revision < 1:
        raise MaterializeError("--library-revision must be a positive integer")
    support = args.support_dir.expanduser().resolve()
    knowledge = support / "Knowledge"
    index_path = knowledge / "papers.json"
    with tempfile.TemporaryDirectory(prefix="liteverse-materialize-") as temp_name:
        temp_dir = Path(temp_name)
        if args.arxiv:
            requested_arxiv = parse_arxiv(args.arxiv)
            source_pdf, source_metadata = fetch_arxiv(requested_arxiv, args.timeout, temp_dir)
            source_type = "arxiv"
        else:
            source_pdf = args.pdf.expanduser().resolve()
            source_metadata = {
                "arxivId": None,
                "title": (args.title or source_pdf.stem).strip(),
                "authors": [author.strip() for author in args.author if author.strip()],
                "doi": normalize_doi(args.doi),
                "officialUrl": None,
            }
            source_type = "pdf"
        validate_pdf(source_pdf)
        source_hash = sha256_file(source_pdf)
        extraction_diagnostics: dict[str, Any] = {}
        pages = extract_pages(source_pdf, extraction_diagnostics)
        meaningful_chars = len(re.sub(r"\s+", "", "".join(pages)))
        extraction_status = "extracted" if meaningful_chars >= max(80, len(pages) * 10) else "needs_ocr"

        with directory_lock(support / ".locks" / "materialize-paper.lock"):
            index = read_index(index_path)
            identity = {
                "sha256": source_hash,
                "arxivBase": arxiv_base(source_metadata.get("arxivId")),
                "doi": normalize_doi(source_metadata.get("doi")),
                "title": source_metadata["title"],
                "authors": source_metadata["authors"],
            }
            duplicate = duplicate_of(index, identity)
            if duplicate:
                print(json.dumps({"status": "duplicate", "paper": duplicate}, indent=2, ensure_ascii=False))
                return 0

            paper_id = choose_paper_id(args.paper_id, source_metadata, source_hash, index)
            pdf_path = support / "Library" / "PDFs" / f"{paper_id}.pdf"
            fulltext_path = knowledge / "fulltext" / f"{paper_id}.md"
            card_path = knowledge / "cards" / f"{paper_id}.md"
            metadata = {
                **source_metadata,
                "paperId": paper_id,
                "sourceType": source_type,
                "metadataStatus": "official_verified" if source_type == "arxiv" else "provisional",
                "sha256": source_hash,
                "arxivBase": arxiv_base(source_metadata.get("arxivId")),
                "doi": normalize_doi(source_metadata.get("doi")),
                "pdfPath": f"Library/PDFs/{paper_id}.pdf",
                "fulltextPath": f"Knowledge/fulltext/{paper_id}.md",
                "cardPath": f"Knowledge/cards/{paper_id}.md",
                "extractionStatus": extraction_status,
                "extractionDiagnostics": extraction_diagnostics,
                "verificationStatus": "needs_ocr" if extraction_status == "needs_ocr" else "card_draft",
                "cardSchemaVersion": "liteverse-card-v1",
                "evidenceCount": 0,
                "primaryCategory": None,
                "secondaryCategory": None,
                "classificationStatus": "provisional",
                "tags": [],
                "materializedAt": utc_now(),
                "libraryItemId": args.library_item_id,
                "libraryItemRevision": args.library_revision,
            }
            metadata["source"] = {
                "kind": source_type,
                "pdfPath": metadata["pdfPath"],
                "sha256": source_hash,
                "arxivId": metadata.get("arxivId"),
                "doi": metadata.get("doi"),
            }
            metadata["artifacts"] = {
                "cardPath": metadata["cardPath"],
                "fulltextPath": metadata["fulltextPath"],
                "extractionStatus": extraction_status,
                "cardSchemaVersion": "liteverse-card-v1",
                "evidenceCount": 0,
                "extractionDiagnostics": extraction_diagnostics,
            }

            pdf_path.parent.mkdir(parents=True, exist_ok=True)
            if source_pdf != pdf_path:
                atomic_write(pdf_path, source_pdf.read_bytes())
            atomic_write(fulltext_path, fulltext_markdown(metadata, pages, extraction_status).encode("utf-8"))
            atomic_write(card_path, card_markdown(metadata, extraction_status).encode("utf-8"))
            index["papers"].append(metadata)
            index["papers"].sort(key=lambda paper: paper["paperId"])
            write_json(index_path, index)
            print(json.dumps({"status": extraction_status, "paper": metadata}, indent=2, ensure_ascii=False))
            return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MaterializeError as error:
        print(f"materialize-paper: {error}", file=sys.stderr)
        raise SystemExit(2)
