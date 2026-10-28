// Bundles the language server into dist/cli.js and the viewer into dist/viewer/.
import { copyFile, mkdir } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const copyViewerFiles = {
  name: "copy-viewer-files",
  setup(build) {
    build.onEnd(async () => {
      await mkdir("dist/viewer", { recursive: true });
      await copyFile("src/viewer/index.html", "dist/viewer/index.html");
      await copyFile("src/viewer/viewer.css", "dist/viewer/viewer.css");
    });
  },
};

const builds = [
  {
    entryPoints: ["src/cli.ts"],
    outfile: "dist/cli.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // vscode-languageserver is CommonJS and calls require() for Node's built-ins.
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
    },
  },
  {
    entryPoints: ["src/viewer/viewer.ts"],
    outfile: "dist/viewer/viewer.js",
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    minify: true,
    plugins: [copyViewerFiles],
  },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
