// The language server Helix runs: renders each edit to the preview, selects the node under the
// last hover on `argdown.showInPreview`, and opens the source of a clicked node in the editor.
//
// The preview shows a root document and the files it includes. Editing, hovering or opening one of
// those parts keeps that root up; any other document becomes the root.
import { spawn } from "node:child_process";
import { FSWatcher, readFileSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  createConnection,
  Hover,
  MarkupKind,
  MessageType,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { svgIdAt, Target } from "../shared/locate.js";
import { configFor } from "./config.js";
import { PreviewServer } from "./preview.js";
import { render, Rendered } from "./render.js";

export const SHOW_IN_PREVIEW = "argdown.showInPreview";

// Edits re-render once typing pauses for this long.
const DEBOUNCE_MS = 150;

interface Options {
  host: string;
  open: boolean;
}

const readOptions = (init: any): Options => ({
  host: typeof init?.preview?.host === "string" ? init.preview.host : "127.0.0.1:0",
  open: init?.preview?.open === true,
});

const toPath = (uri: string) => (uri.startsWith("file:") ? fileURLToPath(uri) : uri);

export const runLanguageServer = (viewerDir: string) => {
  const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
  const documents = new TextDocuments(TextDocument);
  const log = (message: string) => connection.console.log(`[argdown-preview] ${message}`);
  // A plain notification: connection.window.show*Message sends a request, which Helix doesn't answer.
  const notify = (type: MessageType, message: string) =>
    connection.sendNotification("window/showMessage", { type, message });
  process.on("unhandledRejection", (e) => log(`unhandled: ${e}`));

  // The document the preview shows, its last successful render, the files each root included in
  // its latest render, and where the last hover was.
  let current: string | undefined;
  const renders = new Map<string, Extract<Rendered, { ok: true }>>();
  const includes = new Map<string, Set<string>>();
  let hover: { uri: string; line: number; column: number } | undefined;
  // Clicking the same node again moves on to its next occurrence.
  let lastClick: { svgId: string; occurrence: number } | undefined;
  const timers = new Map<string, NodeJS.Timeout>();
  // Included files that aren't open, so edits made elsewhere re-render the root.
  const watchers = new Map<string, FSWatcher>();
  let options: Options = readOptions(undefined);

  // An open document's text, else the file on disk.
  const read = (uri: string): string | undefined => {
    const document = documents.get(uri);
    if (document) return document.getText();
    if (!uri.startsWith("file:")) return undefined;
    try {
      return readFileSync(toPath(uri), "utf8");
    } catch {
      return undefined;
    }
  };

  // The document to render for `uri`: the current root if it includes `uri`, else `uri` itself.
  const rootFor = (uri: string) => (current && includes.get(current)?.has(uri) ? current : uri);

  const syncWatchers = () => {
    const wanted = new Set<string>();
    if (current && documents.get(current)) {
      for (const uri of includes.get(current) ?? []) {
        if (!documents.get(uri)) wanted.add(uri);
      }
    }
    for (const [uri, watcher] of watchers) {
      if (wanted.has(uri)) continue;
      watcher.close();
      watchers.delete(uri);
    }
    for (const uri of wanted) {
      if (watchers.has(uri)) continue;
      // Editors that save by renaming over the file leave this watcher on the old one. It is
      // dropped, and the render this schedules watches the new file.
      const drop = () => {
        watcher.close();
        if (watchers.get(uri) === watcher) watchers.delete(uri);
      };
      let watcher: FSWatcher;
      try {
        watcher = watch(toPath(uri), (event) => {
          if (event === "rename") drop();
          if (current) schedule(current, DEBOUNCE_MS);
        });
      } catch {
        continue;
      }
      watcher.on("error", drop);
      watchers.set(uri, watcher);
    }
  };

  const preview = new PreviewServer(viewerDir, (svgId) => {
    const target = current ? renders.get(current)?.index.targets[svgId] : undefined;
    if (!current || !target || target.occurrences.length === 0) return;
    const occurrence =
      lastClick?.svgId === svgId ? (lastClick.occurrence + 1) % target.occurrences.length : 0;
    lastClick = { svgId, occurrence };
    const { uri, startLine, startColumn } = target.occurrences[occurrence];
    const position = { line: startLine - 1, character: startColumn - 1 };
    connection.window
      .showDocument({ uri, takeFocus: true, selection: { start: position, end: position } })
      .catch((e) => log(`showDocument failed: ${e}`));
  });

  const update = async (uri: string) => {
    if (!documents.get(uri)) return;
    const file = toPath(uri);
    const { config, error } = await configFor(file);
    const rendered = render(uri, read, config);
    // The viewer names the file of an error that isn't in the root.
    const errors = rendered.errors.map(({ uri: from, ...e }) => (from && from !== uri ? { ...e, file: toPath(from) } : e));
    if (error) errors.unshift({ message: error });
    if (rendered.ok) renders.set(uri, rendered);
    includes.set(uri, rendered.includes);
    if (uri !== current) {
      current = uri;
      lastClick = undefined;
    }
    syncWatchers();
    const last = renders.get(uri);
    preview.show({ file, dot: last?.dot, vizJs: last?.vizJs, errors });
  };

  const schedule = (part: string, delay: number) => {
    const uri = rootFor(part);
    clearTimeout(timers.get(uri));
    timers.set(
      uri,
      setTimeout(() => {
        timers.delete(uri);
        update(uri).catch((e) => log(`render failed: ${e}`));
      }, delay),
    );
  };

  // Renders the root for `part` now if an edit is still waiting, so lookups see the text the editor has.
  const flush = async (part: string) => {
    const uri = rootFor(part);
    if (timers.has(uri) || !renders.has(uri) || uri !== current) {
      clearTimeout(timers.get(uri));
      timers.delete(uri);
      await update(uri);
    }
  };

  connection.onInitialize((params) => {
    options = readOptions(params.initializationOptions);
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        executeCommandProvider: { commands: [SHOW_IN_PREVIEW] },
      },
      serverInfo: { name: "argdown-preview" },
    };
  });

  connection.onInitialized(async () => {
    try {
      const url = await preview.listen(options.host);
      log(`preview at ${url}`);
      notify(MessageType.Info, `argdown-preview: ${url}`);
      if (options.open) openInBrowser(url);
    } catch (e) {
      notify(MessageType.Error, `argdown-preview: can't listen on ${options.host}: ${e}`);
    }
  });

  documents.onDidOpen(({ document }) => {
    syncWatchers();
    schedule(document.uri, 0);
  });
  documents.onDidChangeContent(({ document }) => schedule(document.uri, DEBOUNCE_MS));
  documents.onDidClose(({ document }) => {
    clearTimeout(timers.get(document.uri));
    timers.delete(document.uri);
    renders.delete(document.uri);
    includes.delete(document.uri);
    syncWatchers();
  });

  connection.onHover(async ({ textDocument, position }): Promise<Hover | null> => {
    hover = { uri: textDocument.uri, line: position.line + 1, column: position.character + 1 };
    await flush(textDocument.uri);
    const rendered = renders.get(rootFor(textDocument.uri));
    const svgId = rendered && svgIdAt(rendered.index, textDocument.uri, hover.line, hover.column);
    const target = svgId ? rendered.index.targets[svgId] : undefined;
    return target ? { contents: { kind: MarkupKind.Markdown, value: describe(target) } } : null;
  });

  connection.onExecuteCommand(async ({ command }) => {
    if (command !== SHOW_IN_PREVIEW || !hover) return;
    await flush(hover.uri);
    const rendered = renders.get(rootFor(hover.uri));
    const svgId = rendered && svgIdAt(rendered.index, hover.uri, hover.line, hover.column);
    if (svgId) preview.select(svgId);
  });

  connection.onShutdown(() => {
    for (const watcher of watchers.values()) watcher.close();
    preview.close();
  });
  documents.listen(connection);
  connection.listen();
};

// Helix drops what looks like inline HTML, such as `<Title>`, so the title is escaped.
const escape = (text: string) => text.replace(/[\\`*_[\]<>#]/g, "\\$&");

const describe = (target: Target) => {
  const title =
    target.kind === "argument" ? `<${target.title}>` : target.kind === "statement" ? `[${target.title}]` : target.title;
  return target.text ? `**${escape(title)}**: ${target.text}` : `**${escape(title)}**`;
};

const openInBrowser = (url: string) => {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
};
