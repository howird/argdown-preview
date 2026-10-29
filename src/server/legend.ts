// Which tag colours the map uses, for the viewer's legend.
//
// A tag is listed when it decides the colour of at least one node or group on the map, by the
// rules `ColorPlugin` colours them by.
import { ArgdownTypes, IArgdownRequest, IArgdownResponse, IGroupMapNode, IMapNode, ITagData } from "@argdown/core";

export interface LegendEntry {
  tag: string;
  // The colour `ColorPlugin` gave the tag's statements and arguments.
  color: string;
}

// Mirrors `ColorPlugin`'s `getTagWithHighestPriority`, which isn't exported: the highest priority
// wins, a missing one counting as 0, and on a tie the earlier tag.
const winner = (tags: string[], data: Record<string, ITagData>) =>
  tags.reduce((best, tag) => ((data[tag]?.priority ?? 0) > (data[best]?.priority ?? 0) ? tag : best));

// `request` is the one the map was rendered with, so `request.color` has `ColorPlugin`'s defaults.
export const legendFor = (request: IArgdownRequest, response: IArgdownResponse): LegendEntry[] => {
  const settings: any = request.color ?? {};
  const tagData = response.tags ?? {};
  const used = new Set<string>();

  // `overridden` is whether a colour setting other than the tags decides the item's colour.
  const use = (item: { data?: any; tags?: string[] } | undefined, overridden: boolean, byTag: boolean) => {
    if (!item || !byTag || !item.tags?.length) return;
    if (overridden || (!settings.ignoreColorData && item.data?.color !== undefined)) return;
    used.add(winner(item.tags, tagData));
  };

  const visit = (node: IMapNode) => {
    if (node.type === ArgdownTypes.STATEMENT_MAP_NODE) {
      const title = node.title ?? "";
      use(response.statements?.[title], settings.statementColors?.[title] !== undefined, settings.colorizeByTag);
    } else if (node.type === ArgdownTypes.ARGUMENT_MAP_NODE) {
      const title = node.title ?? "";
      use(response.arguments?.[title], settings.argumentColors?.[title] !== undefined, settings.colorizeByTag);
    } else if (node.type === ArgdownTypes.GROUP_MAP_NODE) {
      const group = node as IGroupMapNode;
      const section = group.section;
      use(section, section !== undefined && !!settings.groupColors?.[section.title ?? ""], settings.colorizeGroupsByTag);
      for (const child of group.children ?? []) visit(child);
    }
  };
  for (const node of response.map?.nodes ?? []) visit(node);

  return Object.values(tagData).flatMap(({ tag, color }) =>
    tag && color && used.has(tag) ? [{ tag, color }] : [],
  );
};
