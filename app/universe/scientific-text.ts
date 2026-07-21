export type ScientificSegment = {
  kind: "text" | "math" | "code";
  value: string;
  block?: boolean;
};

const TOKEN_PATTERN = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$\n]+\$|\\\([^\n]*?\\\)|`[^`\n]+`)/g;
const BARE_FORMULA_PATTERN = /(^|[^\w])((?:\\[A-Za-z]+|[A-Za-z][A-Za-z0-9]*)(?:_\{[^}\n]+\}|_[A-Za-z0-9]+|\^\{[^}\n]+\}|\^[A-Za-z0-9+-]+)+(?:\([^\n)]*\))?)/g;

export function scientificSegments(value: string): ScientificSegment[] {
  const segments: ScientificSegment[] = [];
  let cursor = 0;
  for (const match of value.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ kind: "text", value: value.slice(cursor, index) });
    const token = match[0];
    if (token.startsWith("`")) {
      segments.push({ kind: "code", value: token.slice(1, -1) });
    } else {
      const block = token.startsWith("$$") || token.startsWith("\\[");
      const trim = token.startsWith("$$")
        ? 2
        : token.startsWith("\\[") || token.startsWith("\\(")
          ? 2
          : 1;
      segments.push({ kind: "math", value: token.slice(trim, -trim), block });
    }
    cursor = index + token.length;
  }
  if (cursor < value.length) segments.push({ kind: "text", value: value.slice(cursor) });
  if (segments.length === 0) segments.push({ kind: "text", value });

  return segments.flatMap((segment) => {
    if (segment.kind !== "text") return segment;
    const result: ScientificSegment[] = [];
    let textCursor = 0;
    for (const match of segment.value.matchAll(BARE_FORMULA_PATTERN)) {
      const index = match.index ?? 0;
      const prefix = match[1] || "";
      const formula = match[2] || "";
      const formulaIndex = index + prefix.length;
      if (formulaIndex > textCursor) {
        result.push({ kind: "text", value: segment.value.slice(textCursor, formulaIndex) });
      }
      result.push({ kind: "math", value: formula });
      textCursor = formulaIndex + formula.length;
    }
    if (textCursor < segment.value.length) {
      result.push({ kind: "text", value: segment.value.slice(textCursor) });
    }
    return result.length > 0 ? result : segment;
  });
}
