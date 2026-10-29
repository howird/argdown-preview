// Runs the Argdown pipeline the CLI's `argdown map` runs, on text held in memory, after expanding
// `@include`s, and leaves off the map what the viewer hid.
import {
  ArgdownApplication,
  ArgumentSelectionPlugin,
  ClosedGroupPlugin,
  ColorPlugin,
  DataPlugin,
  DotExportPlugin,
  ExplodeArgumentsPlugin,
  GroupPlugin,
  IArgdownPlugin,
  IArgdownRequest,
  IArgdownResponse,
  MapPlugin,
  ModelPlugin,
  ParserPlugin,
  PreselectionPlugin,
  RegroupPlugin,
  StatementSelectionPlugin,
} from "@argdown/core";
import { buildIndex, MapIndex } from "../shared/locate.js";
import { Exclusions, Hidden, toExclude } from "./hide.js";
import { expand, Read, toSource } from "./include.js";

// Hiding adds to the selection's exclusions. It runs after the frontmatter is merged in, which
// would otherwise overwrite them item by item.
const EXCLUDE = "argdownPreviewExclude";
const hidePlugin: IArgdownPlugin = {
  name: "HidePlugin",
  run: (request: any) => {
    const exclude: Exclusions | undefined = request[EXCLUDE];
    if (!exclude) return;
    const selection = (request.selection ??= {});
    selection.excludeStatements = [...(selection.excludeStatements ?? []), ...exclude.statements];
    selection.excludeArguments = [...(selection.excludeArguments ?? []), ...exclude.arguments];
  },
};

const app = new ArgdownApplication();
app.addPlugin(new ParserPlugin(), "parse-input");
app.addPlugin(new DataPlugin(), "build-model");
app.addPlugin(new ModelPlugin(), "build-model");
app.addPlugin(new ExplodeArgumentsPlugin(), "build-model");
app.addPlugin(new RegroupPlugin(), "build-model");
app.addPlugin(hidePlugin, "build-map");
app.addPlugin(new PreselectionPlugin(), "build-map");
app.addPlugin(new StatementSelectionPlugin(), "build-map");
app.addPlugin(new ArgumentSelectionPlugin(), "build-map");
app.addPlugin(new MapPlugin(), "build-map");
app.addPlugin(new GroupPlugin(), "build-map");
app.addPlugin(new ClosedGroupPlugin(), "transform-closed-groups");
app.addPlugin(new ColorPlugin(), "colorize");
app.addPlugin(new DotExportPlugin(), "export-dot");

const PROCESS = ["parse-input", "build-model", "build-map", "transform-closed-groups", "colorize", "export-dot"];

export interface RenderError {
  // The file the error is in, when it is known.
  uri?: string;
  line?: number;
  column?: number;
  message: string;
}

// `includes` is every file the root included, whether or not the map rendered. A map can render
// with errors, from includes that failed.
export type Rendered =
  | {
      ok: true;
      dot: string;
      vizJs: Record<string, unknown>;
      index: MapIndex;
      response: IArgdownResponse;
      includes: Set<string>;
      errors: RenderError[];
    }
  | { ok: false; errors: RenderError[]; includes: Set<string> };

// Plugins mutate the request, so each render gets its own copy. A .js config may hold functions,
// which can't be cloned; those configs are copied one level deep.
const clone = (config: IArgdownRequest): IArgdownRequest => {
  try {
    return structuredClone(config);
  } catch {
    return Object.fromEntries(
      Object.entries(config).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? { ...v } : v]),
    );
  }
};

// `config` is the argdown.config.* request; the root's frontmatter overrides it, as in the CLI.
export const render = (rootUri: string, read: Read, config: IArgdownRequest = {}, hidden: Hidden[] = []): Rendered => {
  const expanded = expand(rootUri, read);
  const { segments, includes } = expanded;
  // With something hidden, the map is built twice: once to see what to leave off, then without it.
  const run = (exclude?: Exclusions) => {
    const request: IArgdownRequest = {
      ...clone(config),
      input: expanded.text,
      process: PROCESS,
      throwExceptions: false,
      logLevel: "none",
      ...(exclude ? { [EXCLUDE]: exclude } : {}),
    };
    return { request, response: app.run(request) };
  };
  const errors: RenderError[] = [...expanded.errors];
  let request: IArgdownRequest;
  let response: IArgdownResponse;
  try {
    ({ request, response } = run());
    if (hidden.length > 0 && response.map) ({ request, response } = run(toExclude(response, hidden)));
  } catch (e) {
    errors.push({ message: e instanceof Error ? e.message : String(e) });
    return { ok: false, errors, includes };
  }
  const parserErrors: RenderError[] = (response.parserErrors ?? []).map((e: any) => {
    const line: number | undefined = e.token?.startLine;
    // The end-of-input token has no position.
    return !Number.isFinite(line)
      ? { message: e.message }
      : { ...toSource(segments, line!), column: e.token?.startColumn, message: e.message };
  });
  errors.push(...parserErrors);
  // A failed parse makes every later plugin throw too; those add nothing.
  if (parserErrors.length === 0) {
    for (const e of response.exceptions ?? []) {
      errors.push({ message: e.message });
    }
  }
  if (parserErrors.length > 0 || (response.exceptions ?? []).length > 0 || !response.dot || !response.map) {
    return { ok: false, errors: errors.length > 0 ? errors : [{ message: "no map produced" }], includes };
  }
  return {
    ok: true,
    dot: response.dot,
    vizJs: (request as any).vizJs ?? {},
    index: buildIndex(response, segments),
    response,
    includes,
    errors,
  };
};
