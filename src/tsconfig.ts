import { promises as fs } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

export interface PathRule { prefix: string; suffix: string; star: boolean; targets: string[] }
/** Aliases that apply to files under `dir` (repo-relative, "" = root). `pathsBase` is where `paths` targets resolve from. */
export interface Alias { dir: string; baseDir?: string; pathsBase: string; rules: PathRule[] }

interface Options { baseUrl?: string; paths?: Record<string, string[]>; baseDir?: string; pathsBase?: string }

async function readOptions(root: string, rel: string, depth = 0): Promise<Options> {
  if (depth > 5) return {};
  let text: string;
  try { text = await fs.readFile(path.join(root, rel), "utf8"); } catch { return {}; }
  const json = ts.parseConfigFileTextToJson(rel, text).config as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } } | undefined;
  if (!json || typeof json !== "object") return {};
  const dir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
  let opts: Options = {};
  if (typeof json.extends === "string" && json.extends.startsWith(".")) {
    const ext = path.posix.join(dir, json.extends.endsWith(".json") ? json.extends : json.extends + ".json");
    opts = await readOptions(root, ext, depth + 1);
  }
  const co = json.compilerOptions;
  if (co && typeof co.baseUrl === "string") { opts.baseUrl = co.baseUrl; opts.baseDir = path.posix.normalize(path.posix.join(dir, co.baseUrl)); }
  if (co && co.paths && typeof co.paths === "object") {
    opts.paths = co.paths as Record<string, string[]>;
    opts.pathsBase = opts.baseDir ?? dir; // TS: paths resolve from baseUrl if set, else from the config that declares them
  }
  return opts;
}

/** One Alias per directory holding tsconfig*.json files that declare baseUrl or paths (their rules are unioned). Config files are only read as JSON. */
export async function loadAliases(root: string, configs: string[]): Promise<Alias[]> {
  const byDir = new Map<string, Alias>();
  for (const rel of [...configs].sort((a, b) => a.localeCompare(b))) {
    const o = await readOptions(root, rel);
    if (o.baseDir === undefined && !o.paths) continue;
    const dir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
    const a = byDir.get(dir) ?? { dir, baseDir: o.baseDir, pathsBase: o.pathsBase ?? o.baseDir ?? dir, rules: [] };
    a.baseDir ??= o.baseDir;
    for (const [pattern, targets] of Object.entries(o.paths ?? {})) {
      if (!Array.isArray(targets) || a.rules.some((r) => `${r.prefix}${r.star ? "*" : ""}${r.suffix}` === pattern)) continue;
      const i = pattern.indexOf("*");
      a.rules.push({ prefix: i < 0 ? pattern : pattern.slice(0, i), suffix: i < 0 ? "" : pattern.slice(i + 1), star: i >= 0, targets: targets.filter((t) => typeof t === "string") });
    }
    byDir.set(dir, a);
  }
  return [...byDir.values()];
}

/** Nearest alias set whose directory contains `file`. */
export function aliasFor(aliases: Alias[], file: string): Alias | undefined {
  return aliases.filter((a) => a.dir === "" || file.startsWith(a.dir + "/")).sort((x, y) => y.dir.length - x.dir.length)[0];
}
