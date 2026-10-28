// Finds and loads the argdown.config.* that applies to a file, as `argdown --config` would.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { IArgdownRequest } from "@argdown/core";

const NAMES = ["argdown.config.json", "argdown.config.js", "argdown.config.mjs", "argdown.config.cjs"];

// The nearest config in the file's directory or any directory above it.
export const findConfig = async (file: string): Promise<string | undefined> => {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    for (const name of NAMES) {
      const candidate = path.join(dir, name);
      if (await stat(candidate).then((s) => s.isFile(), () => false)) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
};

// Exports are read the way @argdown/node reads them: `config`, `default.config`, or `default`.
const fromModule = (exports: any): IArgdownRequest =>
  exports?.config ?? exports?.default?.config ?? exports?.default ?? {};

const cache = new Map<string, { mtimeMs: number; config: IArgdownRequest }>();

// Reloads the config whenever its file changes.
export const loadConfig = async (configPath: string): Promise<IArgdownRequest> => {
  const { mtimeMs } = await stat(configPath);
  const cached = cache.get(configPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.config;
  }
  const config =
    path.extname(configPath) === ".json"
      ? JSON.parse(await readFile(configPath, "utf8"))
      : fromModule(await import(`${pathToFileURL(configPath).href}?mtime=${mtimeMs}`));
  cache.set(configPath, { mtimeMs, config });
  return config;
};

export const configFor = async (file: string): Promise<{ config: IArgdownRequest; path?: string; error?: string }> => {
  const configPath = await findConfig(file);
  if (!configPath) {
    return { config: {} };
  }
  try {
    return { config: await loadConfig(configPath), path: configPath };
  } catch (e) {
    return { config: {}, path: configPath, error: `${configPath}: ${e instanceof Error ? e.message : String(e)}` };
  }
};
