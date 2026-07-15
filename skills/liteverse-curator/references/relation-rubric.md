# Liteverse relation rubric v1

Use rubric ID `liteverse-relation-v1`. Scientific strength and evidential confidence are different values.

## Strength components

Choose exactly one allowed score for each component:

| Component | Allowed scores | Meaning of higher levels |
|---|---:|---|
| `directDependency` | 0, 12, 24, 35 | Explicit citation, inheritance, extension, reproduction, or direct academic dependency |
| `coreQuestion` | 0, 8, 16, 25 | Overlap of the central scientific question rather than broad topic similarity |
| `methodContinuity` | 0, 7, 14, 20 | Continuity of method, equation, data, simulation setup, or measurement |
| `resultRelationship` | 0, 7, 14, 20 | Dependency, complementarity, comparison, tension, or contradiction between results |

The script sums the four values; the maximum is 100. Every nonzero component must list evidence IDs. Project relevance is stored separately and contributes zero points.

## Evidence requirements

Each evidence record identifies one of the two papers and contains a faithful paraphrase plus at least one original-source locator: page, section, equation, figure, or table. Numeric locator values must be positive integers; page `0`, negative values, and fractional numeric locators are invalid. A formal candidate or verified link needs located evidence from both papers. Metadata, abstracts alone, filenames, shared tags, and model intuition are not sufficient.

## Confidence

Provide component scores from 0 through 100:

- `sourceCoverage`: 40% — how completely the relevant original passages were checked.
- `locatorPrecision`: 35% — precision of page, section, equation, figure, or table locations.
- `crossConfirmation`: 25% — how well the interpretation is confirmed across both papers.

The script computes `round(0.40*sourceCoverage + 0.35*locatorPrecision + 0.25*crossConfirmation)`.

## Publication state

- `suggestion`: strength below 40, confidence below 50, or missing located evidence from either paper. Do not draw a line.
- `candidate`: strength 40–59 with confidence at least 50, or strength at least 60 with confidence 50–74. Draw a dashed line.
- `verified`: strength at least 60 and confidence at least 75, with located evidence from both papers. Draw a solid line.

Existing unscored links keep their former value only as `legacyConfidence` and display `Awaiting score`. Never convert it into strength.
