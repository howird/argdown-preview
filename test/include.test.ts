import { describe, expect, test } from "vitest";
import { expand, toSource } from "../src/server/include.js";

const files = (map: Record<string, string>) => (uri: string) => map[uri];
const main = "file:///d/main.argdown";
const part = "file:///d/part.argdown";
const deep = "file:///d/sub/deep.argdown";

describe("expand", () => {
  test("a document without includes is its own single segment", () => {
    const e = expand(main, files({ [main]: "a\nb\nc" }));
    expect(e.text).toBe("a\nb\nc");
    expect(e.segments).toEqual([{ start: 1, lines: 3, uri: main, sourceStart: 1 }]);
    expect(e.errors).toEqual([]);
    expect(e.includes).toEqual(new Set());
  });

  test("includes nest, with paths relative to the including file", () => {
    const e = expand(
      main,
      files({
        [main]: "a\n@include(part.argdown)\nb",
        [part]: "p1\n  @include(sub/deep.argdown)  \np2",
        [deep]: "d",
      }),
    );
    expect(e.text).toBe("a\np1\nd\np2\nb");
    expect(e.segments).toEqual([
      { start: 1, lines: 1, uri: main, sourceStart: 1 },
      { start: 2, lines: 1, uri: part, sourceStart: 1 },
      { start: 3, lines: 1, uri: deep, sourceStart: 1 },
      { start: 4, lines: 1, uri: part, sourceStart: 3 },
      { start: 5, lines: 1, uri: main, sourceStart: 3 },
    ]);
    expect(e.includes).toEqual(new Set([part, deep]));
    expect(e.errors).toEqual([]);
  });

  test("a missing file is an error on its line, and the rest still expands", () => {
    const e = expand(main, files({ [main]: "a\n  @include(nope.argdown)\nb" }));
    expect(e.text).toBe("a\n\nb");
    expect(e.errors).toEqual([{ uri: main, line: 2, column: 3, message: "nope.argdown not found" }]);
    expect(e.segments).toEqual([{ start: 1, lines: 3, uri: main, sourceStart: 1 }]);
  });

  test("a file included twice is an error the second time", () => {
    const e = expand(main, files({ [main]: "@include(part.argdown)\n@include(part.argdown)", [part]: "p" }));
    expect(e.text).toBe("p\n");
    expect(e.errors).toEqual([expect.objectContaining({ uri: main, line: 2, message: expect.stringContaining("already") })]);
  });

  test("a cycle is an error in the file that closes it", () => {
    const e = expand(main, files({ [main]: "@include(part.argdown)", [part]: "p\n@include(main.argdown)" }));
    expect(e.text).toBe("p\n");
    expect(e.errors).toEqual([expect.objectContaining({ uri: part, line: 2, message: expect.stringContaining("itself") })]);
  });

  test("an include that isn't alone on its line is an error", () => {
    const e = expand(main, files({ [main]: "[A]: a @include(part.argdown)", [part]: "p" }));
    expect(e.text).toBe("");
    expect(e.errors).toEqual([{ uri: main, line: 1, column: 8, message: "@include must be on a line by itself" }]);
    expect(e.includes).toEqual(new Set());
  });

  test("an untitled root can't include", () => {
    const e = expand("untitled:1", files({ "untitled:1": "a\n@include(part.argdown)" }));
    expect(e.text).toBe("a\n");
    expect(e.errors).toEqual([expect.objectContaining({ uri: "untitled:1", line: 2, message: expect.stringContaining("saved") })]);
  });

  test("front matter is stripped from an included file and kept in the root", () => {
    const e = expand(
      main,
      files({ [main]: "===\ntitle: Main\n===\n@include(part.argdown)", [part]: "===\ntitle: Part\n===\np" }),
    );
    expect(e.text).toBe("===\ntitle: Main\n===\np");
    expect(e.segments.at(-1)).toEqual({ start: 4, lines: 1, uri: part, sourceStart: 4 });
  });
});

describe("toSource", () => {
  const { segments } = expand(main, files({ [main]: "a\n@include(part.argdown)\nb", [part]: "p1\np2" }));

  test("translates each line to the file and line it came from", () => {
    expect([1, 2, 3, 4].map((line) => toSource(segments, line))).toEqual([
      { uri: main, line: 1 },
      { uri: part, line: 1 },
      { uri: part, line: 2 },
      { uri: main, line: 3 },
    ]);
  });

  test("a line past the end counts on from the last segment", () => {
    expect(toSource(segments, 6)).toEqual({ uri: main, line: 5 });
  });
});
