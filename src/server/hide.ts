// Which statements and arguments to leave off the map, given what the viewer hid.
//
// Hiding a node hides what supports or attacks it, recursively, except what still supports or
// attacks something that stays on the map. Hiding a group hides the nodes in it, the same way.
import { ArgdownTypes, IArgdownResponse, IGroupMapNode, IMapNode, RelationType } from "@argdown/core";

// A statement, argument or group the viewer hid, by title, so it stays hidden across edits.
export interface Hidden {
  kind: "statement" | "argument" | "group";
  title: string;
}

const KIND: Record<string, Hidden["kind"]> = {
  [ArgdownTypes.STATEMENT_MAP_NODE]: "statement",
  [ArgdownTypes.ARGUMENT_MAP_NODE]: "argument",
  [ArgdownTypes.GROUP_MAP_NODE]: "group",
};

// Titles of the statements and arguments to leave off.
export interface Exclusions {
  statements: string[];
  arguments: string[];
}

// `response` has the map with nothing hidden.
export const toExclude = (response: IArgdownResponse, hidden: Hidden[]): Exclusions => {
  const isHidden = (kind: Hidden["kind"], title: string) => hidden.some((h) => h.kind === kind && h.title === title);
  const nodes = new Map<string, IMapNode>();
  const hiding = new Set<string>();

  // Collects the map's nodes, and the ones hidden outright: hidden themselves, or in a hidden group.
  const visit = (node: IMapNode, inHidden: boolean) => {
    const kind = KIND[node.type];
    const group = node as IGroupMapNode;
    const title = (kind === "group" ? group.section?.title : undefined) ?? node.title ?? "";
    const hide = inHidden || (kind !== undefined && isHidden(kind, title));
    nodes.set(node.id, node);
    if (hide) hiding.add(node.id);
    for (const child of group.children ?? []) visit(child, hide);
  };
  for (const node of response.map?.nodes ?? []) visit(node, false);
  const roots = new Set(hiding);

  // Edges point from what supports or attacks to what it supports or attacks. Contrary and
  // contradictory statements attack each other, so neither feeds the other.
  const into = new Map<string, string[]>();
  const outOf = new Map<string, string[]>();
  for (const edge of response.map?.edges ?? []) {
    if (edge.relationType === RelationType.CONTRARY || edge.relationType === RelationType.CONTRADICTORY) continue;
    into.set(edge.to.id, [...(into.get(edge.to.id) ?? []), edge.from.id]);
    outOf.set(edge.from.id, [...(outOf.get(edge.from.id) ?? []), edge.to.id]);
  }

  // Everything that feeds a hidden node, then back out whatever also feeds a node that stays.
  const queue = [...hiding];
  while (queue.length > 0) {
    for (const from of into.get(queue.pop()!) ?? []) {
      if (hiding.has(from)) continue;
      hiding.add(from);
      queue.push(from);
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of hiding) {
      if (roots.has(id) || (outOf.get(id) ?? []).every((to) => hiding.has(to))) continue;
      hiding.delete(id);
      changed = true;
    }
  }

  const titles = (type: ArgdownTypes) =>
    [...hiding].flatMap((id) => {
      const node = nodes.get(id)!;
      return node.type === type ? [node.title ?? ""] : [];
    });
  return { statements: titles(ArgdownTypes.STATEMENT_MAP_NODE), arguments: titles(ArgdownTypes.ARGUMENT_MAP_NODE) };
};
