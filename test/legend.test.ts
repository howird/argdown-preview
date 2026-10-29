import { describe, expect, test } from "vitest";
import { Hidden } from "../src/server/hide.js";
import { render } from "../src/server/render.js";

const uri = "file:///legend.argdown";

// The legend of `text`'s map, with `hidden` hidden.
const legendOf = (text: string, config?: any, hidden: Hidden[] = []) => {
  const rendered = render(uri, (u) => (u === uri ? text : undefined), config, hidden);
  if (!rendered.ok) throw new Error(JSON.stringify(rendered.errors));
  return rendered;
};
const tagsOf = (text: string, config?: any, hidden: Hidden[] = []) =>
  legendOf(text, config, hidden).legend.tags.map((e) => e.tag);

describe("legend", () => {
  test("lists each tag in the order it first appears, with its colour", () => {
    const rendered = legendOf("[A]: a #con\n  + <X>: x #pro\n  - <Y>: y #con\n");
    const { statements, arguments: args } = rendered.response;
    expect(rendered.legend.tags).toEqual([
      { tag: "con", color: statements!["A"].color, kinds: ["statement", "argument"] },
      { tag: "pro", color: args!["X"].color, kinds: ["argument"] },
    ]);
    expect(rendered.legend.tags[0].color).not.toBe(rendered.legend.tags[1].color);
  });

  test("lists the kinds of node on the map, statements first", () => {
    expect(legendOf("<X>: x\n  + [A]: a\n").legend.kinds).toEqual(["statement", "argument"]);
    expect(legendOf("[A]: a\n  + [B]: b\n").legend.kinds).toEqual(["statement"]);
  });

  test("leaves out a kind that is only hidden", () => {
    const text = "[A]: a\n  + [B]: b\n  + <X>: x\n";
    expect(legendOf(text, undefined, [{ kind: "argument", title: "X" }]).legend.kinds).toEqual(["statement"]);
  });

  test("is empty without tags", () => {
    expect(tagsOf("[A]: a\n  + <X>: x\n")).toEqual([]);
  });

  test("lists only the tag that wins a node's colour", () => {
    const text = "[A]: a #one #two\n  + <X>: x\n";
    expect(tagsOf(text)).toEqual(["one"]);
    expect(tagsOf(text, { color: { tagColors: { two: { color: "#ff0000", priority: 1 } } } })).toEqual(["two"]);
  });

  test("leaves out a tag that is only on hidden nodes", () => {
    const text = "[A]: a #pro\n  + <X>: x\n  - [B]: b #con\n";
    expect(tagsOf(text)).toEqual(["pro", "con"]);
    expect(tagsOf(text, undefined, [{ kind: "statement", title: "B" }])).toEqual(["pro"]);
  });

  test("leaves out a tag whose node is coloured by its data", () => {
    expect(tagsOf('[A]: a #pro {color: "#123456"}\n  + <X>: x\n')).toEqual([]);
  });

  test("lists a heading's tag only when groups are coloured by tag", () => {
    const text = "# Cats #pets\n\n[A]: a\n  + <X>: x\n";
    expect(tagsOf(text)).toEqual([]);
    expect(legendOf(text, { color: { colorizeGroupsByTag: true } }).legend.tags).toEqual([
      expect.objectContaining({ tag: "pets", kinds: ["group"] }),
    ]);
  });
});
