// argdown-preview: the language server.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLanguageServer } from "./server/lsp.js";

const usage = "usage: argdown-preview [--stdio]   run the language server (Helix starts this)";

const [command] = process.argv.slice(2);
if (command === undefined || command === "--stdio" || command === "lsp") {
  process.title = "argdown-preview";
  runLanguageServer(path.join(path.dirname(fileURLToPath(import.meta.url)), "viewer"));
} else {
  console.error(usage);
  process.exit(command === "-h" || command === "--help" ? 0 : 2);
}
