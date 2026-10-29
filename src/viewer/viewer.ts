// The browser side: renders each map the server pushes and reports clicks back to it.
import { VizJsMap } from "@argdown/map-views";

interface ViewState {
  file: string;
  dot?: string;
  vizJs?: Record<string, unknown>;
  errors: { file?: string; line?: number; column?: number; message: string }[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const container = $<HTMLDivElement>("map");
const fileName = $<HTMLSpanElement>("file");
const banner = $<HTMLDivElement>("errors");

// Keeps the SVG graphviz produced, before the viewer resizes and transforms it, for export.
class ArgdownMap extends VizJsMap {
  svgSource = "";
  async renderAsync(dot: string, options: any) {
    this.svgSource = await super.renderAsync(dot, options);
    return this.svgSource;
  }
}
const map = new ArgdownMap(container);

let shown: { file: string; dot?: string } | undefined;
let selected: string | undefined;
// Renders run one at a time, and only the newest waiting one runs.
let rendering: Promise<void> = Promise.resolve();
let pending: ViewState | undefined;

const elementFor = (svgId: string) =>
  [...container.querySelectorAll<SVGGElement>("g.node, g.cluster")].find(
    (g) => g.querySelector(":scope > title")?.textContent === svgId,
  );

const highlight = (svgId: string | undefined, pan: boolean) => {
  container.querySelector(".selected")?.classList.remove("selected");
  selected = svgId;
  const element = svgId ? elementFor(svgId) : undefined;
  if (!element) return;
  element.classList.add("selected");
  if (pan) map.zoomManager.moveToElement(element);
};

const showErrors = (errors: ViewState["errors"]) => {
  banner.hidden = errors.length === 0;
  banner.textContent = errors
    .map((e) => {
      const file = e.file ? `${e.file.split("/").pop()}:` : "";
      return e.line ? `${file}${e.line}${e.column ? `:${e.column}` : ""}: ${e.message}` : `${file && `${file} `}${e.message}`;
    })
    .join("\n");
};

const show = async (state: ViewState) => {
  fileName.textContent = state.file.split("/").pop() ?? state.file;
  document.title = `${fileName.textContent} · argdown-preview`;
  showErrors(state.errors);
  if (!state.dot || (shown?.file === state.file && shown.dot === state.dot)) return;
  // Keep the view while editing the same file; fit the map when it is new.
  const keep = shown?.file === state.file;
  const { scale, position } = map.zoomManager.state;
  if (!keep) selected = undefined;
  shown = { file: state.file, dot: state.dot };
  await map.render({
    dot: state.dot,
    settings: state.vizJs,
    ...(keep ? { scale, position: { ...position } } : {}),
  });
  highlight(selected, false);
};

const enqueue = (state: ViewState) => {
  pending = state;
  rendering = rendering.then(async () => {
    if (pending !== state) return;
    pending = undefined;
    await show(state).catch((e) => showErrors([...state.errors, { message: `render: ${e}` }]));
  });
};

const events = new EventSource("events");
events.addEventListener("render", (e) => enqueue(JSON.parse((e as MessageEvent).data)));
events.addEventListener("select", (e) => {
  const { svgId } = JSON.parse((e as MessageEvent).data);
  rendering = rendering.then(() => highlight(svgId, true));
});

container.addEventListener("click", (e) => {
  const element = (e.target as Element).closest("g.node, g.cluster");
  const svgId = element?.querySelector(":scope > title")?.textContent;
  if (!svgId) return;
  highlight(svgId, false);
  fetch("click", { method: "POST", body: JSON.stringify({ svgId }) });
});

const fit = () => map.zoomManager.showAllAndCenterMap();

const exportSvg = () => {
  if (!map.svgSource) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([map.svgSource], { type: "image/svg+xml" }));
  link.download = (shown?.file.split("/").pop() ?? "map").replace(/\.argdown$/, "") + ".svg";
  link.click();
  URL.revokeObjectURL(link.href);
};

// Auto follows the system. The choice is remembered per browser, where storage works.
const THEMES = ["auto", "light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const themeButton = $<HTMLButtonElement>("theme");

const applyTheme = (theme: Theme) => {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme[0].toUpperCase() + theme.slice(1);
};

let theme: Theme = "auto";
try {
  const saved = localStorage.getItem("argdown-preview-theme");
  if (THEMES.includes(saved as Theme)) theme = saved as Theme;
} catch {}
applyTheme(theme);

themeButton.addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
  try {
    localStorage.setItem("argdown-preview-theme", theme);
  } catch {}
});

$("fit").addEventListener("click", fit);
$("export").addEventListener("click", exportSvg);
document.addEventListener("keydown", (e) => {
  if (e.key === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) fit();
});
