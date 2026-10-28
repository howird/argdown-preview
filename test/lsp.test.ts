// Drives the built language server over stdio, as Helix does.
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("`port` finds the running preview", () => {
  const out = execFileSync(process.execPath, [cli, "port"], { encoding: "utf8" });
  expect(out).toContain(url);
  expect(out).toMatch(/ssh -NL (\d+):127\.0\.0\.1:\1 /);
});
