import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { render } from "../src/server/render.js";
import { MapIndex, svgIdAt } from "../src/shared/locate.js";

const uri = new URL("fixtures/cats.argdown", import.meta.url).href;
const source = readFileSync(new URL(uri), "utf8");

// Renders `text` as the file at `uri`.
const renderText = (text: string, config?: any) => render(uri, (u) => (u === uri ? text : undefined), config);

const rendered = renderText(source);
if (!rendered.ok) throw new Error(JSON.stringify(rendered.errors));
const { index, dot } = rendered;

// The SVG id of the target with this kind and title.
const idIn = (index: MapIndex, kind: string, title: string) =>
  Object.entries(index.targets).find(([, t]) => t.kind === kind && t.title === title)?.[0];
const id = (kind: string, title: string) => idIn(index, kind, title);

describe("svgIdAt", () => {
  test("a statement on the map selects its node", () => {
    expect(svgIdAt(index, uri, 5, 3)).toBe(id("statement", "Great"));
    expect(svgIdAt(index, uri, 10, 3)).toBe(id("statement", "Great"));
  });

  test("an argument's description, reference or premise-conclusion structure selects the argument", () => {
    expect(svgIdAt(index, uri, 6, 12)).toBe(id("argument", "Purr"));
    expect(svgIdAt(index, uri, 13, 3)).toBe(id("argument", "Purr"));
    // (1) is a premise that isn't on the map.
    expect(svgIdAt(index, uri, 15, 6)).toBe(id("argument", "Purr"));
  });

  test("a statement on the map wins inside a premise-conclusion structure", () => {
    expect(svgIdAt(index, uri, 18, 7)).toBe(id("statement", "Great"));
  });

  test("a heading or the text under it selects its group", () => {
    expect(svgIdAt(index, uri, 3, 2)).toBe(id("group", "Pros"));
    expect(svgIdAt(index, uri, 9, 1)).toBe(id("group", "Cons"));
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
    const twice = renderText("[A]: First text.\n\n[A]: Second text.\n  + [B]: b\n\n[A]: Third text. {isCanonical: true}\n\n[A]\n");
    if (!twice.ok) throw new Error(JSON.stringify(twice.errors));
    const a = Object.values(twice.index.targets).find((t) => t.title === "A")!;
    expect(a.text).toBe("Third text.");
    expect(a.occurrences.map((o) => o.startLine)).toEqual([6, 1, 3, 8]);
    const last = renderText("[A]: First text.\n\n[A]: Second text.\n  + [B]: b\n");
    if (!last.ok) throw new Error(JSON.stringify(last.errors));
    expect(Object.values(last.index.targets).find((t) => t.title === "A")!.occurrences[0].startLine).toBe(3);
  });

  test("a group's occurrence is its heading", () => {
    expect(index.targets[id("group", "Cons")!].occurrences).toEqual([
      { uri, startLine: 8, startColumn: 1, endLine: 8, endColumn: 7 },
    ]);
  });
});

describe("render", () => {
  test("frontmatter overrides the config", () => {
    const config = { dot: { graphVizSettings: { rankdir: "LR" } } } as any;
    const fromConfig = renderText(source, config);
    const fromFrontmatter = renderText(`===\ndot:\n  graphVizSettings:\n    rankdir: TB\n===\n\n${source}`, config);
    expect(fromConfig.ok && fromConfig.dot).toContain('rankdir = "LR"');
    expect(fromFrontmatter.ok && fromFrontmatter.dot).toContain('rankdir = "TB"');
  });

  test("a render doesn't change the config it was given", () => {
    const config = { dot: { graphVizSettings: { rankdir: "LR" } } } as any;
    renderText(`===\ndot:\n  graphVizSettings:\n    rankdir: TB\n===\n\n${source}`, config);
    expect(config.dot.graphVizSettings.rankdir).toBe("LR");
  });

  test("a syntax error reports its line", () => {
    const broken = renderText("<A>\n\n(1) a\n(2) b\n");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.errors).toEqual([expect.objectContaining({ line: 4 })]);
  });
});

describe("includes", () => {
  const at = (name: string) => new URL(`fixtures/include/${name}`, import.meta.url).href;
  const main = at("main.argdown");
  const part = at("part.argdown");
  const objections = at("objections.argdown");
  const read = (u: string) => {
    try {
      return readFileSync(fileURLToPath(u), "utf8");
    } catch {
      return undefined;
    }
  };
  const included = render(main, read);
  if (!included.ok) throw new Error(JSON.stringify(included.errors));
  const { index } = included;
  const id = (kind: string, title: string) => idIn(index, kind, title);

  test("the map has the nodes of every file, and lists the files included", () => {
    expect(id("argument", "Purr")).toBeDefined();
    expect(id("argument", "Allergies")).toBeDefined();
    expect(included.errors).toEqual([]);
    expect(included.includes).toEqual(new Set([part, objections]));
  });

  test("a cursor in a part selects its node", () => {
    expect(svgIdAt(index, part, 5, 3)).toBe(id("argument", "Purr"));
    expect(svgIdAt(index, objections, 4, 8)).toBe(id("argument", "Allergies"));
    // The same position in the root is something else.
    expect(svgIdAt(index, main, 5, 3)).not.toBe(id("argument", "Purr"));
  });

  test("a cursor in a part under a heading from the root selects that group", () => {
    expect(svgIdAt(index, objections, 1, 3)).toBe(id("group", "Cons"));
  });

  test("occurrences carry their file and follow document order across files", () => {
    const great = index.targets[id("statement", "Great")!];
    expect(great.occurrences.map((o) => [o.uri, o.startLine])).toEqual([
      [main, 9],
      [part, 12],
      [objections, 3],
    ]);
  });

  test("an error in a part reports the part's file and line", () => {
    const broken = render(main, (u) => (u === part ? `${read(part)}\n<Broken>\n\n(1) a\n(2) b\n` : read(u)));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.errors).toEqual([expect.objectContaining({ uri: part, line: 17 })]);
  });

  test("a missing include is reported, and the rest still renders", () => {
    const missing = render(main, (u) => (u === objections ? undefined : read(u)));
    expect(missing.ok).toBe(true);
    expect(missing.errors).toEqual([expect.objectContaining({ uri: main, line: 16, column: 1 })]);
  });
});
