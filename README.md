# argdown-preview

Live Argdown argument-map preview in your browser: updates as you type, and clicks jump between
the map and your editor.

The map is the one the [Argdown sandbox](https://argdown.org/sandbox/map/viz-js) draws, from the
same `@argdown/core` pipeline and Graphviz. Press a key in Helix to select the node under your
cursor in the map, or click a node to jump to its source. It works over SSH: write on a remote
machine and read on your laptop.

## Use it in a project

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    argdown-preview = {
      url = "github:howird/argdown-preview";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };
  outputs = {argdown-preview, ...}: {
    inherit (argdown-preview) devShells;
  };
}
```

With `use flake` in `.envrc`, the shell has just, watchexec and the three programs below.

| Program | What it does |
| --- | --- |
| `argdown-preview` | The preview, as a language server Helix starts for `.argdown` files |
| `argdown-preview port` | Print the URL and SSH tunnel of each running preview |
| `argdown` | The Argdown CLI, e.g. `argdown map --format pdf` to export the map |
| `argdown-language-server` | Argdown's own language server: diagnostics, symbols, completion, rename |

Or without a flake: `nix run github:howird/argdown-preview#argdown-preview -- port`.

## Helix

```toml
# .helix/languages.toml
[[language]]
name = "argdown"
scope = "source.argdown"
file-types = ["argdown", "ad", "adown"]
comment-tokens = ["//"]
block-comment-tokens = [{ start = "<!--", end = "-->" }, { start = "/*", end = "*/" }]
roots = ["argdown.config.json", "argdown.config.js"]
language-servers = ["argdown-language-server", "argdown-preview"]

[language-server.argdown-language-server]
command = "argdown-language-server"
args = ["--stdio"]

[language-server.argdown-preview]
command = "argdown-preview"

[language-server.argdown-preview.config.preview]
host = "127.0.0.1:0"
```

```toml
# .helix/config.toml: space v selects the node under the cursor in the preview
[keys.normal.space]
v = ["hover", ":lsp-workspace-command argdown.showInPreview"]
```

Hover is how the cursor position reaches the preview: Helix sends it to both servers and pages
their answers. On a title, reference or tag, argdown's page comes first, with the element's
relations. The preview's page names the node `space v` selected, so a missing page means nothing
was selected.

Helix runs the rest of a key's commands when one fails, so one global binding can drive several
previews. With tinymist:

```toml
v = ["hover", ":lsp-workspace-command tinymist.scrollPreview", ":lsp-workspace-command argdown.showInPreview"]
```

There is no tree-sitter grammar for Argdown, so Helix doesn't highlight it.

### Port

The preview listens on `preview.host`, `127.0.0.1:0` by default, which picks a free port. Helix
shows the URL when the server starts, and `argdown-preview port` prints it again, with the
`ssh -NL` line to run on your laptop. A fixed port (`127.0.0.1:23640`) saves the lookup when
you work locally, and `preview.open = true` opens it in your browser when Helix starts.

## What it shows

The preview follows the last `.argdown` file you opened, edited or hovered in, except for files
it includes (see [`@include`](#include)). It renders on
every edit, after typing pauses for 150 ms, and keeps your zoom and position. `f` or **Fit**
fits the map to the window; **SVG** downloads it.

Settings come from the nearest `argdown.config.json`, `.js`, `.mjs` or `.cjs` in or above the
file's directory, and the file's frontmatter (`===`) overrides them, as with `argdown map`.
While the file has a syntax error, the last map stays up under a banner with the error.

### `@include`

`@include(part.argdown)` pastes in another file, with its path relative to the including file.
Included files can include others, and each file can be included once. The text comes from the
editor when the file is open there, and from disk otherwise. Included files that aren't open are
watched, so saving one from elsewhere updates the map.

Unlike `argdown map`:

- `@include` must be on a line by itself.
- An included file's frontmatter is dropped. Only the root file's frontmatter and config apply.
- A missing file, a file included twice, or an include in a file that was never saved is an
  error in the banner on that line, and the rest of the map still renders.

The map, clicks and `space v` all work in the included files: a click opens the part at the
node's line, and errors in a part show in the banner as `part.argdown:12:3: …`.

While you open, edit or hover in a file that the previewed file includes, the preview stays on
the including file and re-renders it. A file it doesn't include replaces it in the preview.

### Which node `space v` selects

The innermost thing on the map that contains the cursor:

- a statement drawn on the map: its node
- anywhere else in an argument (its description, a reference to it, its premises and
  conclusion): the argument
- a heading, or text under it that is in none of the above: its group

### Which line a click opens

The statement's or argument's canonical occurrence, whose text the map shows: the last
definition, or the one marked `{isCanonical: true}`, as Argdown picks it. An argument with no
description opens at its premise-conclusion structure, and a group at its heading. Clicking the
same node again moves to its next occurrence.

## How it works

`src/cli.ts` runs `src/server/lsp.ts`, a stdio language server. It expands `@include`s
(`src/server/include.ts`), keeping which file and line each line came from, and parses every
edit with `@argdown/core` (`src/server/render.ts`), and `src/server/preview.ts` pushes the dot to
`src/viewer/`, which lays it out with `VizJsMap` from `@argdown/map-views`, as the sandbox does.

| Endpoint | Direction |
| --- | --- |
| `GET /events` | Server-sent events: `render` (the dot, or errors) and `select` (a node) |
| `POST /click {svgId}` | map → editor: the server sends `window/showDocument` to Helix |

`src/shared/locate.ts` maps between the two. Each SVG element is named by its `<title>`: `nN`
for a statement or argument (the map node's id), and `cluster_K` for a group, numbered in the
pre-order `DotExportPlugin` writes them in. Statements, arguments and sections carry their
source ranges in the parsed model, which are translated back to the files they came from.

## Developing

`nix develop .#develop` has node and just; `just build`, `just watch`, `just test`, and
`just check` for the nix build and its tests. After changing `package-lock.json`, `just hash`
updates `npmDepsHash` in `flake.nix`.

From a project, point at a local checkout with
`use flake . --override-input argdown-preview path:../argdown-preview` in `.envrc`. After a
change, `direnv reload` and `:lsp-restart` in Helix. To skip the rebuild, set
`command = "node"` and `args = ["../argdown-preview/dist/cli.js"]` for `argdown-preview` in
`.helix/languages.toml`, and `:lsp-restart` after each `just build` (or with `just watch`
running).
