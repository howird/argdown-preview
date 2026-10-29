// What the map's colours and shapes mean, for the viewer's legend.
//
// A tag is listed when it decides the colour of at least one node or group on the map, by the
// rules `ColorPlugin` colours them by.
import { ArgdownTypes, IArgdownRequest, IArgdownResponse, IGroupMapNode, IMapNode, ITagData } from "@argdown/core";

// Argdown draws a statement with its colour as the border and a white fill, and an argument and
// a group filled with their colour, whatever the tags.
export type Kind = "statement" | "argument" | "group";

export interface LegendEntry {
  tag: string;
  // The colour `ColorPlugin` gave the tag's statements and arguments.
  color: string;
  // What on the map the tag colours, in the order of `Kind`.
  kinds: Kind[];
}

export interface Legend {
  // The kinds of node on the map, statements before arguments.
  kinds: Exclude<Kind, "group">[];
  tags: LegendEntry[];
}

const KINDS: Kind[] = ["statement", "argument", "group"];

// Mirrors `ColorPlugin`'s `getTagWithHighestPriority`, which isn't exported: the highest priority
// wins, a missing one counting as 0, and on a tie the earlier tag.
const winner = (tags: string[], data: Record<string, ITagData>) =>
  tags.reduce((best, tag) => ((data[tag]?.priority ?? 0) > (data[best]?.priority ?? 0) ? tag : best));

// `request` is the one the map was rendered with, so `request.color` has `ColorPlugin`'s defaults.
export const legendFor = (request: IArgdownRequest, response: IArgdownResponse): Legend => {
  const settings: any = request.color ?? {};
  const tagData = response.tags ?? {};
  // The kinds each tag colours.
  const used = new Map<string, Set<Kind>>();
  const kinds = new Set<Kind>();

  // `overridden` is whether a colour setting other than the tags decides the item's colour.
  const use = (kind: Kind, item: { data?: any; tags?: string[] } | undefined, overridden: boolean, byTag: boolean) => {
    if (!item || !byTag || !item.tags?.length) return;
    if (overridden || (!settings.ignoreColorData && item.data?.color !== undefined)) return;
    const tag = winner(item.tags, tagData);
    used.set(tag, (used.get(tag) ?? new Set()).add(kind));
  };

  const visit = (node: IMapNode) => {
    if (node.type === ArgdownTypes.STATEMENT_MAP_NODE) {
      const title = node.title ?? "";
      kinds.add("statement");
      use("statement", response.statements?.[title], settings.statementColors?.[title] !== undefined, settings.colorizeByTag);
    } else if (node.type === ArgdownTypes.ARGUMENT_MAP_NODE) {
      const title = node.title ?? "";
      kinds.add("argument");
      use("argument", response.arguments?.[title], settings.argumentColors?.[title] !== undefined, settings.colorizeByTag);
    } else if (node.type === ArgdownTypes.GROUP_MAP_NODE) {
      const group = node as IGroupMapNode;
      const section = group.section;
      use("group", section, section !== undefined && !!settings.groupColors?.[section.title ?? ""], settings.colorizeGroupsByTag);
      for (const child of group.children ?? []) visit(child);
    }
  };
  for (const node of response.map?.nodes ?? []) visit(node);

  return {
    kinds: (["statement", "argument"] as const).filter((k) => kinds.has(k)),
    tags: Object.values(tagData).flatMap(({ tag, color }) => {
      const colours = tag && used.get(tag);
      return tag && color && colours ? [{ tag, color, kinds: KINDS.filter((k) => colours.has(k)) }] : [];
    }),
  };
};
