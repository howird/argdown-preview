// argdown-preview: the language server (default), or `port` to find running previews.
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLanguageServer } from "./server/lsp.js";

// `port` finds previews by this name, as `ss` shows it.
const NAME = "argdown-preview";

const usage = `usage: argdown-preview [--stdio]   run the language server (Helix starts this)
       argdown-preview port        print the URL and SSH tunnel of each running preview`;

// Each port a running argdown-preview listens on, from `ss`.
const ports = (): number[] => {
  const out = execFileSync("ss", ["-ltnpH"], { encoding: "utf8" });
  const found = new Set<number>();
  for (const line of out.split("\n")) {
    if (!line.includes(`"${NAME}"`)) continue;
    const local = line.trim().split(/\s+/)[3] ?? "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (port) found.add(port);
  }
  return [...found].sort((a, b) => a - b);
};

const printPorts = () => {
  const found = ports();
  if (found.length === 0) {
    console.error("argdown-preview isn't listening on any port; open a .argdown file in helix first");
    process.exit(1);
  }
  for (const port of found) {
    console.log(`argdown-preview: http://127.0.0.1:${port}`);
    console.log(`  ssh -NL ${port}:127.0.0.1:${port} ${os.userInfo().username}@${os.hostname()}`);
  }
};

const [command] = process.argv.slice(2);
if (command === "port") {
  printPorts();
} else if (command === undefined || command === "--stdio" || command === "lsp") {
  process.title = NAME;
  runLanguageServer(path.join(path.dirname(fileURLToPath(import.meta.url)), "viewer"));
} else {
  console.error(usage);
  process.exit(command === "-h" || command === "--help" ? 0 : 2);
}
