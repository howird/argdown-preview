// Maps between source positions and the map's SVG elements, both ways.
//
// Each SVG element is named by its <title>: `nN` for statement and argument nodes (the map node
// id), `cluster_K` for groups (DotExportPlugin numbers them in pre-order).
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

export interface Location {
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
  // comes first.
  occurrences: Location[];
}

export interface MapIndex {
  targets: Record<string, Target>;
  // Every source range that belongs to an element on the map; forward search picks the smallest.
  ranges: { location: Location; svgId: string }[];
}

const toLocation = (l: HasLocation): Location | undefined =>
  l.startLine === undefined || l.endLine === undefined
    ? undefined
    : {
        startLine: l.startLine,
        startColumn: l.startColumn ?? 1,
        endLine: l.endLine,
        endColumn: l.endColumn ?? Number.MAX_SAFE_INTEGER,
      };

const byPosition = (a: Location, b: Location) => a.startLine - b.startLine || a.startColumn - b.startColumn;

// The canonical occurrence first, then the rest in source order.
const ordered = (canonical: Location | undefined, rest: Location[]): Location[] => {
  const sorted = rest.slice().sort(byPosition);
  if (!canonical) {
    return sorted;
  }
  return [canonical, ...sorted.filter((l) => byPosition(l, canonical) !== 0)];
};

export const buildIndex = (response: IArgdownResponse): MapIndex => {
  const targets: Record<string, Target> = {};
  const ranges: MapIndex["ranges"] = [];
  const add = (svgId: string, target: Target, extraRanges: Location[] = []) => {
    targets[svgId] = target;
    for (const location of [...target.occurrences, ...extraRanges]) {
      ranges.push({ location, svgId });
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
  return { targets, ranges };
};

const contains = (l: Location, line: number, column: number) =>
  (line > l.startLine || (line === l.startLine && column >= l.startColumn)) &&
  (line < l.endLine || (line === l.endLine && column <= l.endColumn + 1));

const size = (l: Location) => [l.endLine - l.startLine, l.endColumn - l.startColumn];

// The SVG element for the innermost thing on the map at a 1-based line and column.
export const svgIdAt = (index: MapIndex, line: number, column: number): string | undefined => {
  let best: MapIndex["ranges"][number] | undefined;
  for (const r of index.ranges) {
    if (!contains(r.location, line, column)) continue;
    if (!best) {
      best = r;
      continue;
    }
    const [lines, columns] = size(r.location);
    const [bestLines, bestColumns] = size(best.location);
    if (lines < bestLines || (lines === bestLines && columns < bestColumns)) {
      best = r;
    }
  }
  return best?.svgId;
};
