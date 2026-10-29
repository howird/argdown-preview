// Drives the built language server over stdio, as Helix does.
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

const cli = path.resolve("dist/cli.js");
const dir = mkdtempSync(path.join(tmpdir(), "argdown-preview-"));
const file = path.join(dir, "cats.argdown");
const uri = pathToFileURL(file).href;
const source = readFileSync(new URL("fixtures/cats.argdown", import.meta.url), "utf8");
writeFileSync(path.join(dir, "argdown.config.json"), JSON.stringify({ dot: { graphVizSettings: { rankdir: "LR" } } }));
writeFileSync(file, source);

// The include fixtures, in their own directory so files written there trigger the watcher.
const includeDir = path.join(dir, "include");
mkdirSync(includeDir);
for (const name of ["main.argdown", "part.argdown", "objections.argdown"]) {
  copyFileSync(new URL(`fixtures/include/${name}`, import.meta.url), path.join(includeDir, name));
}
const includeFile = (name: string) => path.join(includeDir, name);
const includeUri = (name: string) => pathToFileURL(includeFile(name)).href;

let server: ChildProcess;
let rpc: MessageConnection;
let url: string;
const shown: any[] = [];
const events: { event: string; data: any }[] = [];
let stream: AbortController;

// Resolves once `check` passes, retrying until a deadline.
const eventually = async <T>(check: () => T, ms = 5000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return check();
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
};

const last = (event: string) => {
  const found = events.filter((e) => e.event === event).at(-1);
  if (!found) throw new Error(`no ${event} event`);
  return found.data;
};

beforeAll(async () => {
  server = spawn(process.execPath, [cli], { stdio: ["pipe", "pipe", "inherit"] });
  rpc = createMessageConnection(new StreamMessageReader(server.stdout!), new StreamMessageWriter(server.stdin!));
  const messages: string[] = [];
  rpc.onNotification("window/showMessage", ({ message }) => {
    messages.push(message);
  });
  rpc.onNotification("window/logMessage", () => {});
  rpc.onRequest("window/showDocument", (params) => {
    shown.push(params);
    return { success: true };
  });
  rpc.listen();
  await rpc.sendRequest("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(dir).href,
    capabilities: { window: { showDocument: { support: true } } },
    initializationOptions: { preview: { host: "127.0.0.1:0" } },
  });
  await rpc.sendNotification("initialized", {});
  url = await eventually(() => {
    const match = messages.join("\n").match(/http:\/\/127\.0\.0\.1:\d+/);
    if (!match) throw new Error("no URL announced");
    return match[0];
  });

  stream = new AbortController();
  const response = await fetch(`${url}/events`, { signal: stream.signal });
  (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
});

afterAll(async () => {
  stream?.abort();
  await rpc?.sendRequest("shutdown").catch(() => {});
  server?.kill();
});

// The next render event after `count` events had arrived.
const nextRender = (count: number) =>
  eventually(() => {
    const s = events.slice(count).find((e) => e.event === "render");
    if (!s) throw new Error("no render yet");
    return s.data;
  });

// The SVG id of the node whose tooltip starts with `text`.
const nodeId = (dot: string, text: string) => dot.match(new RegExp(`(n\\d+) \\[[^\\n]*tooltip="${text}`))?.[1];

test("serves the viewer", async () => {
  const page = await fetch(url).then((r) => r.text());
  expect(page).toContain("viewer.js");
  expect((await fetch(`${url}/viewer.js`)).status).toBe(200);
});

test("opening a document renders its map with the nearest config", async () => {
  await rpc.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "argdown", version: 1, text: source },
  });
  const state = await eventually(() => last("render"));
  expect(state.file).toBe(file);
  expect(state.errors).toEqual([]);
  expect(state.dot).toContain('rankdir = "LR"');
});

test("hover describes the node, and showInPreview selects it", async () => {
  const hover: any = await rpc.sendRequest("textDocument/hover", {
    textDocument: { uri },
    position: { line: 5, character: 10 },
  });
  expect(hover.contents.value).toBe("**\\<Purr\\>**: Cats purr when they are happy.");
  await rpc.sendRequest("workspace/executeCommand", { command: "argdown.showInPreview" });
  expect(await eventually(() => last("select"))).toEqual({ svgId: "n1" });
});

test("clicking a node opens its occurrences in turn", async () => {
  const click = (svgId: string) => fetch(`${url}/click`, { method: "POST", body: JSON.stringify({ svgId }) });
  await click("n0");
  await eventually(() => expect(shown).toHaveLength(1));
  await click("n0");
  await eventually(() => expect(shown).toHaveLength(2));
  expect(shown.map((s) => s.selection.start)).toEqual([
    { line: 4, character: 0 },
    { line: 9, character: 0 },
  ]);
  expect(shown[0]).toMatchObject({ uri, takeFocus: true });
});

test("go to definition finds where a statement is defined", async () => {
  const locations: any = await rpc.sendRequest("textDocument/definition", {
    textDocument: { uri },
    position: { line: 9, character: 2 },
  });
  // Argdown's range for a statement takes in the relations under it.
  expect(locations).toEqual([{ uri, range: { start: { line: 4, character: 0 }, end: { line: 5, character: 42 } } }]);
});

test("hiding a node lays out the map without it, until it is shown again", async () => {
  const before = last("render").dot;
  const allergies = nodeId(before, "Many people")!;
  let count = events.length;
  await fetch(`${url}/hide`, { method: "POST", body: JSON.stringify({ svgId: allergies }) });
  const hidden = await nextRender(count);
  expect(hidden.hidden).toEqual([{ kind: "argument", title: "Allergies" }]);
  expect(nodeId(hidden.dot, "Many people")).toBeUndefined();
  expect(nodeId(hidden.dot, "Cats purr")).toBeDefined();
  count = events.length;
  await fetch(`${url}/unhide`, { method: "POST", body: JSON.stringify({ kind: "argument", title: "Allergies" }) });
  const shownAgain = await nextRender(count);
  expect(shownAgain.hidden).toEqual([]);
  expect(shownAgain.dot).toBe(before);
});

test("an edit with an error keeps the last map and reports the error", async () => {
  const before = last("render").dot;
  const count = events.length;
  await rpc.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: `${source}\n<Broken>\n\n(1) a\n(2) b\n` }],
  });
  const state = await eventually(() => {
    const s = events.slice(count).find((e) => e.event === "render");
    if (!s) throw new Error("no render yet");
    return s.data;
  });
  expect(state.dot).toBe(before);
  expect(state.errors[0].line).toBe(23);
});

const open = (uri: string, text: string) =>
  rpc.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "argdown", version: 1, text } });

test("a root renders with the files it includes", async () => {
  const count = events.length;
  await open(includeUri("main.argdown"), readFileSync(includeFile("main.argdown"), "utf8"));
  const state = await nextRender(count);
  expect(state.file).toBe(includeFile("main.argdown"));
  expect(state.errors).toEqual([]);
  expect(nodeId(state.dot, "Many people")).toBeDefined();
});

test("opening a part the root includes keeps the root up", async () => {
  const count = events.length;
  await open(includeUri("part.argdown"), readFileSync(includeFile("part.argdown"), "utf8"));
  expect((await nextRender(count)).file).toBe(includeFile("main.argdown"));
});

test("hover in a part describes its node", async () => {
  const hover: any = await rpc.sendRequest("textDocument/hover", {
    textDocument: { uri: includeUri("part.argdown") },
    position: { line: 4, character: 3 },
  });
  expect(hover.contents.value).toBe("**\\<Purr\\>**: Cats purr when they are happy.");
});

test("go to definition from a part finds the definition in the root", async () => {
  const locations: any = await rpc.sendRequest("textDocument/definition", {
    textDocument: { uri: includeUri("objections.argdown") },
    position: { line: 2, character: 2 },
  });
  expect(locations).toEqual([
    expect.objectContaining({ uri: includeUri("main.argdown"), range: expect.objectContaining({ start: { line: 8, character: 0 } }) }),
  ]);
});

test("clicking a node defined in a part opens the part", async () => {
  const purr = nodeId(last("render").dot, "Cats purr")!;
  const count = shown.length;
  await fetch(`${url}/click`, { method: "POST", body: JSON.stringify({ svgId: purr }) });
  await eventually(() => expect(shown).toHaveLength(count + 1));
  expect(shown.at(-1)).toMatchObject({ uri: includeUri("part.argdown"), selection: { start: { line: 4, character: 0 } } });
});

test("editing an open part re-renders the root", async () => {
  const count = events.length;
  await rpc.sendNotification("textDocument/didChange", {
    textDocument: { uri: includeUri("part.argdown"), version: 2 },
    contentChanges: [{ text: `${readFileSync(includeFile("part.argdown"), "utf8")}\n[Fluffy]: Cats are fluffy.\n  +> [Great]\n` }],
  });
  const state = await nextRender(count);
  expect(state.file).toBe(includeFile("main.argdown"));
  expect(nodeId(state.dot, "Cats are fluffy")).toBeDefined();
});

test("an error in a part is reported in the part's file", async () => {
  const count = events.length;
  await rpc.sendNotification("textDocument/didChange", {
    textDocument: { uri: includeUri("part.argdown"), version: 3 },
    contentChanges: [{ text: `${readFileSync(includeFile("part.argdown"), "utf8")}\n<Broken>\n\n(1) a\n(2) b\n` }],
  });
  const state = await nextRender(count);
  expect(state.file).toBe(includeFile("main.argdown"));
  expect(state.errors).toEqual([expect.objectContaining({ file: includeFile("part.argdown"), line: 17 })]);
  await rpc.sendNotification("textDocument/didChange", {
    textDocument: { uri: includeUri("part.argdown"), version: 4 },
    contentChanges: [{ text: readFileSync(includeFile("part.argdown"), "utf8") }],
  });
});

test("writing an included file that isn't open re-renders the root", async () => {
  await eventually(() => expect(last("render").errors).toEqual([]));
  const count = events.length;
  writeFileSync(
    includeFile("objections.argdown"),
    `${readFileSync(includeFile("objections.argdown"), "utf8")}\n[Cute]: Cats are cute.\n  +> [Great]\n`,
  );
  const state = await nextRender(count);
  expect(state.file).toBe(includeFile("main.argdown"));
  expect(nodeId(state.dot, "Cats are cute")).toBeDefined();
});

test("opening a file no root includes renders it alone", async () => {
  const alone = path.join(includeDir, "alone.argdown");
  const count = events.length;
  await open(pathToFileURL(alone).href, "[Alone]: On its own.\n  + <Why>: Because.\n");
  const state = await nextRender(count);
  expect(state.file).toBe(alone);
  expect(nodeId(state.dot, "On its own")).toBeDefined();
});

test("`port` finds the running preview", () => {
  const out = execFileSync(process.execPath, [cli, "port"], { encoding: "utf8" });
  expect(out).toContain(url);
  expect(out).toMatch(/ssh -NL (\d+):127\.0\.0\.1:\1 /);
});
