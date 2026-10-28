import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { render } from "../src/server/render.js";
import { svgIdAt } from "../src/shared/locate.js";

const source = readFileSync(new URL("fixtures/cats.argdown", import.meta.url), "utf8");
const rendered = render(source);
if (!rendered.ok) throw new Error(JSON.stringify(rendered.errors));
const { index, dot } = rendered;

// The SVG id of the target with this kind and title.
const id = (kind: string, title: string) =>
  Object.entries(index.targets).find(([, t]) => t.kind === kind && t.title === title)?.[0];

describe("svgIdAt", () => {
  test("a statement on the map selects its node", () => {
    expect(svgIdAt(index, 5, 3)).toBe(id("statement", "Great"));
    expect(svgIdAt(index, 10, 3)).toBe(id("statement", "Great"));
  });

  test("an argument's description, reference or premise-conclusion structure selects the argument", () => {
    expect(svgIdAt(index, 6, 12)).toBe(id("argument", "Purr"));
    expect(svgIdAt(index, 13, 3)).toBe(id("argument", "Purr"));
    // (1) is a premise that isn't on the map.
    expect(svgIdAt(index, 15, 6)).toBe(id("argument", "Purr"));
  });

  test("a statement on the map wins inside a premise-conclusion structure", () => {
    expect(svgIdAt(index, 18, 7)).toBe(id("statement", "Great"));
  });

  test("a heading or the text under it selects its group", () => {
    expect(svgIdAt(index, 3, 2)).toBe(id("group", "Pros"));
    expect(svgIdAt(index, 9, 1)).toBe(id("group", "Cons"));
  });

  test("groups are numbered in the order the dot export names them", () => {
    for (const [svgId, target] of Object.entries(index.targets)) {
      if (target.kind !== "group") continue;
      const label = dot.match(new RegExp(`subgraph ${svgId} \\{\\n\\s*label = <<FONT[^>]*>([^<]*)<`))?.[1];
      expect(label).toBe(target.title);
    }
  });
});

describe("occurrences", () => {
  test("the canonical occurrence comes first, then the rest in source order", () => {
    const great = index.targets[id("statement", "Great")!];
    expect(great.occurrences.map((o) => o.startLine)).toEqual([5, 10, 18]);
  });

  test("an argument's description comes before its reference and premise-conclusion structure", () => {
    const purr = index.targets[id("argument", "Purr")!];
    expect(purr.occurrences.map((o) => o.startLine)).toEqual([6, 13, 15]);
  });

  test("a statement defined twice opens at the definition the map shows, as Argdown picks it", () => {
    const twice = render("[A]: First text.\n\n[A]: Second text.\n  + [B]: b\n\n[A]: Third text. {isCanonical: true}\n\n[A]\n");
    if (!twice.ok) throw new Error(JSON.stringify(twice.errors));
    const a = Object.values(twice.index.targets).find((t) => t.title === "A")!;
    expect(a.text).toBe("Third text.");
    expect(a.occurrences.map((o) => o.startLine)).toEqual([6, 1, 3, 8]);
    const last = render("[A]: First text.\n\n[A]: Second text.\n  + [B]: b\n");
    if (!last.ok) throw new Error(JSON.stringify(last.errors));
    expect(Object.values(last.index.targets).find((t) => t.title === "A")!.occurrences[0].startLine).toBe(3);
  });

  test("a group's occurrence is its heading", () => {
    expect(index.targets[id("group", "Cons")!].occurrences).toEqual([
      { startLine: 8, startColumn: 1, endLine: 8, endColumn: 7 },
    ]);
  });
});

describe("render", () => {
  test("frontmatter overrides the config", () => {
    const config = { dot: { graphVizSettings: { rankdir: "LR" } } } as any;
    const fromConfig = render(source, config);
    const fromFrontmatter = render(`===\ndot:\n  graphVizSettings:\n    rankdir: TB\n===\n\n${source}`, config);
    expect(fromConfig.ok && fromConfig.dot).toContain('rankdir = "LR"');
    expect(fromFrontmatter.ok && fromFrontmatter.dot).toContain('rankdir = "TB"');
  });

  test("a render doesn't change the config it was given", () => {
    const config = { dot: { graphVizSettings: { rankdir: "LR" } } } as any;
    render(`===\ndot:\n  graphVizSettings:\n    rankdir: TB\n===\n\n${source}`, config);
    expect(config.dot.graphVizSettings.rankdir).toBe("LR");
  });

  test("a syntax error reports its line", () => {
    const broken = render("<A>\n\n(1) a\n(2) b\n");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.errors).toEqual([expect.objectContaining({ line: 4 })]);
  });
});
