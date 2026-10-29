// Serves the viewer and pushes maps to it over server-sent events.
import { readFile } from "node:fs/promises";
import http from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import type { Hidden } from "./hide.js";

// What the viewer shows. `dot` is the last map that rendered; `errors` are from the latest edit.
export interface ViewState {
  file: string;
  dot?: string;
  vizJs?: Record<string, unknown>;
  // `file` is set when the error is in another file than the previewed one, such as an included one.
  errors: { file?: string; line?: number; column?: number; message: string }[];
  // What is hidden from this file's map, in the order it was hidden.
  hidden: Hidden[];
}

export interface Handlers {
  // A click on the map's element `svgId`.
  click: (svgId: string) => void;
  // Hide the element `svgId`.
  hide: (svgId: string) => void;
  // Show `item` again, or everything when it is undefined.
  unhide: (item: Hidden | undefined) => void;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export class PreviewServer {
  private clients = new Set<http.ServerResponse>();
  private state?: ViewState;
  private selected?: string;
  private server: http.Server;

  constructor(
    private viewerDir: string,
    private handlers: Handlers,
  ) {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => fail(res, 500, String(e))));
  }

  // Resolves to the URL the preview is served at. Port 0 picks a free one.
  listen(host: string, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        const { port } = this.server.address() as AddressInfo;
        resolve(`http://${host}:${port}`);
      });
    });
  }

  show(state: ViewState) {
    if (state.file !== this.state?.file) {
      this.selected = undefined;
    }
    this.state = state;
    this.send("render", state);
  }

  select(svgId: string) {
    this.selected = svgId;
    this.send("select", { svgId });
  }

  close() {
    for (const client of this.clients) client.end();
    this.server.close();
  }

  private send(event: string, data: unknown) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) client.write(message);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.flushHeaders();
      this.clients.add(res);
      req.on("close", () => this.clients.delete(res));
      if (this.state) res.write(`event: render\ndata: ${JSON.stringify(this.state)}\n\n`);
      if (this.selected) res.write(`event: select\ndata: ${JSON.stringify({ svgId: this.selected })}\n\n`);
      return;
    }
    if (req.method === "POST" && ["/click", "/hide", "/unhide"].includes(url.pathname)) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      if (url.pathname === "/unhide") {
        const item = data.kind === undefined ? undefined : { kind: data.kind, title: data.title };
        if (item && !(["statement", "argument", "group"].includes(item.kind) && typeof item.title === "string")) {
          return fail(res, 400, "bad item");
        }
        this.handlers.unhide(item);
      } else {
        if (typeof data.svgId !== "string") return fail(res, 400, "missing svgId");
        if (url.pathname === "/click") {
          this.selected = data.svgId;
          this.handlers.click(data.svgId);
        } else {
          // Node ids change when the map is built without it.
          this.selected = undefined;
          this.handlers.hide(data.svgId);
        }
      }
      res.writeHead(204).end();
      return;
    }
    const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
    const type = TYPES[path.extname(name)];
    if (!type) return fail(res, 404, "not found");
    const content = await readFile(path.join(this.viewerDir, name)).catch(() => undefined);
    if (!content) return fail(res, 404, "not found");
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" }).end(content);
  }
}

const fail = (res: http.ServerResponse, status: number, message: string) => {
  if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(message);
};
