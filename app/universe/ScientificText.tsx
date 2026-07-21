import { Fragment, type ReactNode } from "react";
import { scientificSegments, type ScientificSegment } from "./scientific-text";

type ScientificTextProps = {
  children: string;
  className?: string;
  as?: "p" | "div" | "span" | "pre";
};

function renderSegment(segment: ScientificSegment, index: number): ReactNode {
  if (segment.kind === "text") {
    return segment.value.split("\n").map((line, lineIndex, lines) => (
      <Fragment key={`${index}-${lineIndex}`}>
        {line}
        {lineIndex < lines.length - 1 && <br />}
      </Fragment>
    ));
  }
  return (
    <span
      key={index}
      className={`${segment.kind === "math" ? "scientific-math" : "scientific-code"} ${segment.block ? "is-block" : ""}`.trim()}
      aria-label={segment.kind === "math" ? `Formula: ${segment.value}` : undefined}
    >
      {segment.value}
    </span>
  );
}

export function ScientificText({
  children,
  className = "",
  as: Element = "span",
}: ScientificTextProps) {
  return (
    <Element className={`scientific-text ${className}`.trim()}>
      {scientificSegments(children).map(renderSegment)}
    </Element>
  );
}
