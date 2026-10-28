import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { configFor } from "../src/server/config.js";

const project = () => {
  const root = mkdtempSync(path.join(tmpdir(), "argdown-config-"));
  mkdirSync(path.join(root, "chapters"));
  return { root, file: path.join(root, "chapters", "one.argdown") };
};

test("no config gives an empty request", async () => {
  const { file } = project();
  expect((await configFor(file)).config).toEqual({});
});

test("the nearest config above the file applies", async () => {
  const { root, file } = project();
  writeFileSync(path.join(root, "argdown.config.json"), '{"group": {"groupDepth": 3}}');
  expect(await configFor(file)).toEqual({ config: { group: { groupDepth: 3 } }, path: path.join(root, "argdown.config.json") });
  writeFileSync(path.join(root, "chapters", "argdown.config.json"), '{"group": {"groupDepth": 1}}');
  expect((await configFor(file)).config).toEqual({ group: { groupDepth: 1 } });
});

test("a .js config is read from `config`, `default.config` or `default`", async () => {
  for (const source of [
    "export const config = { logLevel: 'x' };",
    "export default { config: { logLevel: 'x' } };",
    "module.exports = { logLevel: 'x' };",
  ]) {
    const { root, file } = project();
    const name = source.startsWith("module") ? "argdown.config.cjs" : "argdown.config.mjs";
    writeFileSync(path.join(root, name), source);
    expect((await configFor(file)).config).toEqual({ logLevel: "x" });
  }
});

test("a changed config is reloaded", async () => {
  const { root, file } = project();
  const config = path.join(root, "argdown.config.mjs");
  writeFileSync(config, "export default { logLevel: 'a' };");
  expect((await configFor(file)).config).toEqual({ logLevel: "a" });
  writeFileSync(config, "export default { logLevel: 'b' };");
  utimesSync(config, new Date(), new Date(Date.now() + 1000));
  expect((await configFor(file)).config).toEqual({ logLevel: "b" });
});

test("a broken config is reported, not thrown", async () => {
  const { root, file } = project();
  writeFileSync(path.join(root, "argdown.config.json"), "{");
  const result = await configFor(file);
  expect(result.config).toEqual({});
  expect(result.error).toContain("argdown.config.json");
});
