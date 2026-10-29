// Expands `@include(path)` lines into one text, and maps lines of that text back to the files they
// came from. Argdown's IncludePlugin pastes files in place and keeps no such record.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The text of a file: its open editor buffer, else what is on disk, else undefined.
export type Read = (uri: string) => string | undefined;

// `lines` lines of the expanded text, from `start`, are lines of `uri` from `sourceStart`. 1-based.
export interface Segment {
  start: number;
  lines: number;
  uri: string;
  sourceStart: number;
}

// In the coordinates of the file the problem is in.
export interface IncludeError {
  uri: string;
  line: number;
  column: number;
  message: string;
}

export interface Expanded {
  text: string;
  segments: Segment[];
  // Every file that was included, at any depth.
  includes: Set<string>;
  errors: IncludeError[];
}

// The regex Argdown's IncludePlugin uses, and the form this expansion accepts: alone on its line.
const INCLUDE = /@include\(([^)]+)\)/;
const OWN_LINE = /^\s*@include\(([^)]+)\)\s*$/;

const FRONT_MATTER = /^===+\s*$/;

// Lines after a front matter block at the top of an included file. Argdown applies only the
// root's front matter, so a part's would otherwise be an error.
const bodyStart = (lines: string[]): number => {
  let first = 0;
  while (first < lines.length && lines[first].trim() === "") first++;
  if (first === lines.length || !FRONT_MATTER.test(lines[first])) return 0;
  for (let i = first + 1; i < lines.length; i++) {
    if (FRONT_MATTER.test(lines[i])) return i + 1;
  }
  return 0;
};

export const expand = (rootUri: string, read: Read): Expanded => {
  const out: string[] = [];
  const segments: Segment[] = [];
  const includes = new Set<string>();
  const errors: IncludeError[] = [];
  // Files on the current include chain, for telling a cycle from a second include.
  const stack: string[] = [];

  // Appends line `sourceLine` of `uri`, extending the last segment when it continues it.
  const emit = (text: string, uri: string, sourceLine: number) => {
    out.push(text);
    const last = segments.at(-1);
    if (last && last.uri === uri && last.sourceStart + last.lines === sourceLine && last.start + last.lines === out.length) {
      last.lines++;
    } else {
      segments.push({ start: out.length, lines: 1, uri, sourceStart: sourceLine });
    }
  };

  const resolve = (from: string, target: string): string | undefined =>
    from.startsWith("file:") ? pathToFileURL(path.resolve(path.dirname(fileURLToPath(from)), target)).href : undefined;

  const visit = (uri: string, text: string, isRoot: boolean) => {
    stack.push(uri);
    const lines = text.split(/\r?\n/);
    for (let i = isRoot ? 0 : bodyStart(lines); i < lines.length; i++) {
      const line = lines[i];
      const match = INCLUDE.exec(line);
      if (!match) {
        emit(line, uri, i + 1);
        continue;
      }
      // A failed include leaves an empty line, so the lines around it still line up.
      const fail = (message: string) => {
        errors.push({ uri, line: i + 1, column: match.index + 1, message });
        emit("", uri, i + 1);
      };
      const own = OWN_LINE.exec(line);
      if (!own) {
        fail("@include must be on a line by itself");
        continue;
      }
      const name = own[1].trim();
      const target = resolve(uri, name);
      if (!target) {
        fail("@include needs the file to be saved, to find paths relative to it");
        continue;
      }
      if (stack.includes(target)) {
        fail(`${name} includes itself`);
        continue;
      }
      if (includes.has(target)) {
        fail(`${name} is already included; each file can only be included once`);
        continue;
      }
      const included = read(target);
      if (included === undefined) {
        fail(`${name} not found`);
        continue;
      }
      includes.add(target);
      visit(target, included, false);
    }
    stack.pop();
  };

  const root = read(rootUri);
  if (root === undefined) {
    return {
      text: "",
      segments: [{ start: 1, lines: 1, uri: rootUri, sourceStart: 1 }],
      includes,
      errors: [{ uri: rootUri, line: 1, column: 1, message: "can't read the file" }],
    };
  }
  visit(rootUri, root, true);
  return { text: out.join("\n"), segments, includes, errors };
};

// The file and line a line of the expanded text came from. A line past the end, as an error at
// the end of input can report, counts on from the last segment.
export const toSource = (segments: Segment[], line: number): { uri: string; line: number } => {
  let segment = segments[0];
  for (const s of segments) {
    if (s.start > line) break;
    segment = s;
  }
  return { uri: segment.uri, line: segment.sourceStart + line - segment.start };
};
