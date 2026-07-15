# Security policy

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use GitHub's
private vulnerability reporting feature for this repository and include:

- the affected version and platform;
- the smallest reproducible steps;
- the expected and observed behavior;
- the security impact;
- any relevant logs with personal paths, task identifiers, paper content, and
  credentials removed.

Maintainers will acknowledge a complete report as soon as practical, confirm
whether it is in scope, and coordinate disclosure after a fix is available.

## Scope

Security-sensitive areas include workspace path confinement, PDF and backup
handling, WebKit/native bridge messages, hash and revision validation,
append-only ledgers, arXiv network retrieval, and accidental exposure of local
research data.

Scientific disagreement, an inaccurate user-authored note, or an unsupported AI
inference is not by itself a security vulnerability. A defect that silently
promotes unverified content, bypasses provenance checks, or exposes private
workspace data may be security relevant.

Only the latest released minor version receives security fixes. Older releases
may be asked to upgrade before a report is investigated.
