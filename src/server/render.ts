// Runs the Argdown pipeline the CLI's `argdown map` runs, on text held in memory.
import {
  ArgdownApplication,
  ArgumentSelectionPlugin,
  ClosedGroupPlugin,
  ColorPlugin,
  DataPlugin,
  DotExportPlugin,
  ExplodeArgumentsPlugin,
  GroupPlugin,
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

const app = new ArgdownApplication();
app.addPlugin(new ParserPlugin(), "parse-input");
app.addPlugin(new DataPlugin(), "build-model");
app.addPlugin(new ModelPlugin(), "build-model");
app.addPlugin(new ExplodeArgumentsPlugin(), "build-model");
app.addPlugin(new RegroupPlugin(), "build-model");
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
  line?: number;
  column?: number;
  message: string;
}

export type Rendered =
  | { ok: true; dot: string; vizJs: Record<string, unknown>; index: MapIndex; response: IArgdownResponse }
  | { ok: false; errors: RenderError[] };

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

// `config` is the argdown.config.* request; frontmatter in `input` overrides it, as in the CLI.
export const render = (input: string, config: IArgdownRequest = {}): Rendered => {
  const request: IArgdownRequest = {
    ...clone(config),
    input,
    process: PROCESS,
    throwExceptions: false,
    logLevel: "none",
  };
  let response: IArgdownResponse;
  try {
    response = app.run(request);
  } catch (e) {
    return { ok: false, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  const errors: RenderError[] = (response.parserErrors ?? []).map((e: any) => ({
    line: e.token?.startLine,
    column: e.token?.startColumn,
    message: e.message,
  }));
  // A failed parse makes every later plugin throw too; those add nothing.
  if (errors.length === 0) {
    for (const e of response.exceptions ?? []) {
      errors.push({ message: e.message });
    }
  }
  if (errors.length > 0 || !response.dot || !response.map) {
    return { ok: false, errors: errors.length > 0 ? errors : [{ message: "no map produced" }] };
  }
  return { ok: true, dot: response.dot, vizJs: (request as any).vizJs ?? {}, index: buildIndex(response), response };
};
