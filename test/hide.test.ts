import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ArgdownTypes, IGroupMapNode, IMapNode } from "@argdown/core";
import { Hidden } from "../src/server/hide.js";
import { render } from "../src/server/render.js";

const uri = new URL("fixtures/cats.argdown", import.meta.url).href;
const source = readFileSync(new URL(uri), "utf8");

// The titles of the statements and arguments on the map of `text`, with `hidden` hidden.
const onMap = (text: string, hidden: Hidden[], config?: any) => {
  const rendered = render(uri, (u) => (u === uri ? text : undefined), config, hidden);
  if (!rendered.ok) throw new Error(JSON.stringify(rendered.errors));
  const titles: string[] = [];
  const visit = (node: IMapNode) => {
    if (node.type === ArgdownTypes.GROUP_MAP_NODE) (node as IGroupMapNode).children?.forEach(visit);
    else titles.push(node.title ?? "");
  };
  rendered.response.map!.nodes.forEach(visit);
  return titles.sort();
};

describe("hiding", () => {
  test("nothing hidden shows everything", () => {
    expect(onMap(source, [])).toEqual(["Allergies", "Great", "Purr"]);
  });

  test("a statement hides with what supports or attacks it", () => {
    expect(onMap(source, [{ kind: "statement", title: "Great" }])).toEqual([]);
  });

  test("an argument hides alone when nothing feeds it", () => {
    expect(onMap(source, [{ kind: "argument", title: "Purr" }])).toEqual(["Allergies", "Great"]);
  });

  test("a group hides the nodes in it, and what supports or attacks them", () => {
    const text = "# One\n\n[A]: a\n  + <X>: x\n\n# Two\n\n<Y>: y\n  +> [A]\n";
    expect(onMap(text, [{ kind: "group", title: "Two" }])).toEqual(["A", "X"]);
    expect(onMap(text, [{ kind: "group", title: "One" }])).toEqual([]);
  });

  test("what also supports something on the map stays", () => {
    const text = "[A]: a\n  + <X>: x\n    +> [B]: b\n  + <Y>: y\n    - <Z>: z\n";
    expect(onMap(text, [])).toEqual(["A", "B", "X", "Y", "Z"]);
    expect(onMap(text, [{ kind: "statement", title: "A" }])).toEqual(["B", "X"]);
  });

  test("a title that is no longer in the document hides nothing", () => {
    expect(onMap(source, [{ kind: "argument", title: "Gone" }])).toEqual(["Allergies", "Great", "Purr"]);
  });

  test("hiding adds to the exclusions in the config and frontmatter", () => {
    const text = "[A]: a\n  + <X>: x\n  + <Y>: y\n  + <W>: w\n";
    const config = { selection: { excludeArguments: ["X"] } };
    expect(onMap(text, [{ kind: "argument", title: "Y" }], config)).toEqual(["A", "W"]);
    const frontmatter = `===\nselection:\n  excludeArguments: [X]\n===\n\n${text}`;
    expect(onMap(frontmatter, [{ kind: "argument", title: "Y" }])).toEqual(["A", "W"]);
  });
});
