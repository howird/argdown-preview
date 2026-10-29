// Maps between source positions and the map's SVG elements, both ways.
//
// Each SVG element is named by its <title>: `nN` for statement and argument nodes (the map node
// id), `cluster_K` for groups (DotExportPlugin numbers them in pre-order).
//
// Argdown reports positions in the text with `@include`s expanded; the index holds them in the
// files they came from.
import {
  ArgdownTypes,
  HasLocation,
  IArgdownResponse,
  IArgument,
  IEquivalenceClass,
  IGroupMapNode,
  IMapNode,
  ISection,
} from "@argdown/core";
import type { Segment } from "../server/include.js";

export interface Location {
  uri: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface Target {
  kind: "statement" | "argument" | "group";
  title: string;
  // One-line description for hover: the statement's text, or the argument's description.
  text?: string;
  // Where the element appears in the source. The canonical occurrence, whose text the map shows,
  // comes first; the rest follow in document order, across files.
  occurrences: Location[];
}

// A source range, and the range in the expanded text it was clipped from, which decides the
// innermost of several that contain a position.
interface Range {
  location: Location;
  whole: Omit<Location, "uri">;
}

export interface MapIndex {
  targets: Record<string, Target>;
  // Every source range that belongs to an element on the map; forward search picks the smallest.
  ranges: (Range & { svgId: string })[];
  // Where each statement and argument is defined, on the map or not, keyed `statement:Title` or
  // `argument:Title`. The canonical definition comes first.
  definitions: Record<string, Location[]>;
  // Every place a statement or argument is written: its definitions and its references.
  symbols: (Range & { key: string })[];
}

// A location in the expanded text.
type Span = Omit<Location, "uri">;

const toLocation = (l: HasLocation): Span | undefined =>
  l.startLine === undefined || l.endLine === undefined
    ? undefined
    : {
        startLine: l.startLine,
        startColumn: l.startColumn ?? 1,
        endLine: l.endLine,
        endColumn: l.endColumn ?? Number.MAX_SAFE_INTEGER,
      };

const byPosition = (a: Span, b: Span) => a.startLine - b.startLine || a.startColumn - b.startColumn;

// The canonical occurrence first, then the rest in source order.
const ordered = (canonical: Span | undefined, rest: Span[]): Span[] => {
  const sorted = rest.slice().sort(byPosition);
  if (!canonical) {
    return sorted;
  }
  return [canonical, ...sorted.filter((l) => byPosition(l, canonical) !== 0)];
};

// A span in the files it came from: one piece per segment it overlaps, each clipped to its segment.
const pieces = (span: Span, segments: Segment[]): Location[] => {
  const out: Location[] = [];
  for (const s of segments) {
    const last = s.start + s.lines - 1;
    if (last < span.startLine || s.start > span.endLine) continue;
    const startLine = Math.max(span.startLine, s.start);
    const endLine = Math.min(span.endLine, last);
    out.push({
      uri: s.uri,
      startLine: s.sourceStart + startLine - s.start,
      startColumn: startLine === span.startLine ? span.startColumn : 1,
      endLine: s.sourceStart + endLine - s.start,
      endColumn: endLine === span.endLine ? span.endColumn : Number.MAX_SAFE_INTEGER,
    });
  }
  return out;
};

export const buildIndex = (response: IArgdownResponse, segments: Segment[]): MapIndex => {
  const targets: Record<string, Target> = {};
  const ranges: MapIndex["ranges"] = [];
  const definitions: MapIndex["definitions"] = {};
  const symbols: MapIndex["symbols"] = [];
  // Occurrences are sorted while still in the expanded text, so their order holds across files.
  // An occurrence is where a jump lands, so only its first piece is kept.
  const add = (svgId: string, target: Omit<Target, "occurrences"> & { occurrences: Span[] }, extraRanges: Span[] = []) => {
    targets[svgId] = { ...target, occurrences: target.occurrences.flatMap((o) => pieces(o, segments).slice(0, 1)) };
    for (const span of [...target.occurrences, ...extraRanges]) {
      for (const location of pieces(span, segments)) {
        ranges.push({ location, whole: span, svgId });
      }
    }
  };

  const addNode = (node: IMapNode) => {
    const title = node.title ?? "";
    if (node.type === ArgdownTypes.STATEMENT_MAP_NODE) {
      const ec = response.statements?.[title];
      if (!ec) return;
      const members = ec.members.flatMap((m) => toLocation(m) ?? []);
      const canonical = IEquivalenceClass.getCanonicalMember(ec);
      add(node.id, {
        kind: "statement",
        title,
        text: canonical?.text?.trim(),
        occurrences: ordered(canonical && toLocation(canonical), members),
      });
    } else if (node.type === ArgdownTypes.ARGUMENT_MAP_NODE) {
      const argument = response.arguments?.[title];
      if (!argument) return;
      const members = argument.members.flatMap((m) => toLocation(m) ?? []);
      // Without a description, the argument is defined by its premise-conclusion structure.
      const pcs = argument.pcs.length > 0 ? toLocation(argument) : undefined;
      const canonical = IArgument.getCanonicalMember(argument);
      const occurrences = ordered((canonical && toLocation(canonical)) ?? pcs, pcs ? [...members, pcs] : members);
      add(node.id, { kind: "argument", title, text: canonical?.text?.trim(), occurrences });
    }
  };

  let groupCount = 0;
  const visit = (node: IMapNode) => {
    if (node.type !== ArgdownTypes.GROUP_MAP_NODE) {
      addNode(node);
      return;
    }
    groupCount++;
    const group = node as IGroupMapNode;
    const section: ISection | undefined = group.section;
    const heading = section?.heading ? toLocation(section.heading) : undefined;
    const body = section ? toLocation(section) : undefined;
    add(
      `cluster_${groupCount}`,
      { kind: "group", title: section?.title ?? group.title ?? "", occurrences: heading ? [heading] : [] },
      body ? [body] : [],
    );
    for (const child of group.children ?? []) {
      visit(child);
    }
  };
  for (const node of response.map?.nodes ?? []) {
    visit(node);
  }

  // Like `add`, for the definitions and every written occurrence of a statement or argument.
  const addSymbol = (key: string, defined: Span[], written: Span[]) => {
    definitions[key] = defined.flatMap((o) => pieces(o, segments).slice(0, 1));
    for (const span of written) {
      for (const location of pieces(span, segments)) {
        symbols.push({ location, whole: span, key });
      }
    }
  };
  for (const ec of Object.values(response.statements ?? {})) {
    const canonical = IEquivalenceClass.getCanonicalMember(ec);
    const defined = ec.members.filter((m) => !m.isReference).flatMap((m) => toLocation(m) ?? []);
    const written = ec.members.flatMap((m) => toLocation(m) ?? []);
    addSymbol(`statement:${ec.title}`, ordered(canonical && toLocation(canonical), defined), written);
  }
  for (const argument of Object.values(response.arguments ?? {})) {
    const pcs = argument.pcs.length > 0 ? toLocation(argument) : undefined;
    const canonical = IArgument.getCanonicalMember(argument);
    const defined = argument.members.filter((m) => !m.isReference).flatMap((m) => toLocation(m) ?? []);
    const written = argument.members.flatMap((m) => toLocation(m) ?? []);
    addSymbol(
      `argument:${argument.title}`,
      ordered((canonical && toLocation(canonical)) ?? pcs, pcs ? [...defined, pcs] : defined),
      pcs ? [...written, pcs] : written,
    );
  }
  return { targets, ranges, definitions, symbols };
};

const contains = (l: Span, line: number, column: number) =>
  (line > l.startLine || (line === l.startLine && column >= l.startColumn)) &&
  (line < l.endLine || (line === l.endLine && column <= l.endColumn + 1));

const size = (l: Span) => [l.endLine - l.startLine, l.endColumn - l.startColumn];

// The innermost of `ranges` that contains a 1-based line and column of `uri`.
const innermost = <R extends Range>(ranges: R[], uri: string, line: number, column: number): R | undefined => {
  let best: R | undefined;
  for (const r of ranges) {
    if (r.location.uri !== uri || !contains(r.location, line, column)) continue;
    if (!best) {
      best = r;
      continue;
    }
    const [lines, columns] = size(r.whole);
    const [bestLines, bestColumns] = size(best.whole);
    if (lines < bestLines || (lines === bestLines && columns < bestColumns)) {
      best = r;
    }
  }
  return best;
};

// The SVG element for the innermost thing on the map at a 1-based line and column of `uri`.
export const svgIdAt = (index: MapIndex, uri: string, line: number, column: number): string | undefined =>
  innermost(index.ranges, uri, line, column)?.svgId;

// Where the innermost statement or argument at a 1-based line and column of `uri` is defined.
export const definitionsAt = (index: MapIndex, uri: string, line: number, column: number): Location[] => {
  const symbol = innermost(index.symbols, uri, line, column);
  return symbol ? index.definitions[symbol.key] : [];
};
