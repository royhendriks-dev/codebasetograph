import ts from "typescript";
import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Path-mapping settings of one tsconfig/jsconfig, with `extends` merged in. Directories are repo-relative posix. */
export interface AliasConfig {
  /** Directory that owns the config; it applies to files below it. */
  dir: string;
  /** Directory that `paths` targets and bare specifiers are resolved against. */
  baseDir: string;
  paths: Array<{ pattern: string; targets: string[] }>;
  /** True when `baseUrl` is set, so bare specifiers may also name files below `baseDir`. */
  baseUrl: boolean;
}

const MAX_EXTENDS = 8;

interface RawConfig { baseDir?: string; baseUrl?: boolean; paths?: Record<string, string[]> }

interface ConfigJson { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } }

/** Parses one config file as JSON-with-comments. Never throws: unreadable or invalid files give `undefined`. Nothing is executed. */
async function readJson(root: string, rel: string): Promise<ConfigJson | undefined> {
  let text: string;
  try { text = await fs.readFile(path.join(root, rel), "utf8"); } catch { return undefined; }
  const parsed = ts.parseConfigFileTextToJson(rel, text).config as unknown;
  return parsed && typeof parsed === "object" ? (parsed as ConfigJson) : undefined;
}

/** Repo-relative targets of `extends`. Only relative paths inside the repository; package presets (e.g. "@tsconfig/node20") are not followed. */
function extendsTargets(cfg: ConfigJson, dir: string): string[] {
  const list = typeof cfg.extends === "string" ? [cfg.extends] : Array.isArray(cfg.extends) ? cfg.extends : [];
  return list
    .filter((p): p is string => typeof p === "string" && p.startsWith("."))
    .map((p) => path.posix.normalize(path.posix.join(dir, p)) + (p.endsWith(".json") ? "" : ".json"))
    .filter((t) => !t.startsWith(".."));
}

function ownSettings(cfg: ConfigJson, dir: string): RawConfig {
  const out: RawConfig = {};
  const co = cfg.compilerOptions;
  if (!co || typeof co !== "object") return out;
  if (typeof co.baseUrl === "string") {
    const b = path.posix.normalize(path.posix.join(dir, co.baseUrl));
    if (!b.startsWith("..")) { out.baseDir = b; out.baseUrl = true; }
  }
  if (co.paths && typeof co.paths === "object") {
    out.paths = Object.fromEntries(
      Object.entries(co.paths as Record<string, unknown>).filter((e): e is [string, string[]] => Array.isArray(e[1])).map(([k, v]) => [k, v.filter((x): x is string => typeof x === "string")]),
    );
    // `paths` resolve against the config that declares them when no baseUrl is set.
    out.baseDir ??= dir;
  }
  return out;
}

/** Reads a config and the configs it extends; the child's settings override the parent's. */
async function readRaw(root: string, rel: string, depth: number): Promise<RawConfig> {
  if (depth > MAX_EXTENDS) return {};
  const cfg = await readJson(root, rel);
  if (!cfg) return {};
  const dir = path.posix.dirname(rel);
  let merged: RawConfig = {};
  for (const t of extendsTargets(cfg, dir)) merged = { ...merged, ...(await readRaw(root, t, depth + 1)) };
  return { ...merged, ...ownSettings(cfg, dir) };
}

/** Loads alias settings for every tsconfig/jsconfig found by discovery. Configs without `paths` or `baseUrl` are dropped. */
export async function loadAliasConfigs(root: string, configFiles: string[]): Promise<AliasConfig[]> {
  const out: AliasConfig[] = [];
  for (const rel of [...configFiles].sort()) {
    const raw = await readRaw(root, rel, 0);
    if (!raw.baseUrl && !raw.paths) continue;
    const dir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
    const baseDir = raw.baseDir === "." ? "" : raw.baseDir ?? dir;
    out.push({ dir, baseDir, baseUrl: !!raw.baseUrl,
      paths: Object.entries(raw.paths ?? {}).map(([pattern, targets]) => ({ pattern, targets })) });
  }
  return out;
}

const within = (dir: string, file: string) => dir === "" || file.startsWith(dir + "/");

/** The text matched by `*` when `spec` fits `pattern` (empty string for an exact pattern), or undefined. */
function matchPattern(pattern: string, spec: string): string | undefined {
  const i = pattern.indexOf("*");
  if (i < 0) return pattern === spec ? "" : undefined;
  const pre = pattern.slice(0, i), post = pattern.slice(i + 1);
  const fits = spec.length >= pre.length + post.length && spec.startsWith(pre) && spec.endsWith(post);
  return fits ? spec.slice(pre.length, spec.length - post.length) : undefined;
}

/** The mapping with the longest prefix before `*` wins, like TypeScript does. */
function bestMapping(c: AliasConfig, spec: string): { targets: string[]; star: string } | undefined {
  const hits = c.paths.flatMap((p) => {
    const star = matchPattern(p.pattern, spec);
    return star === undefined ? [] : [{ targets: p.targets, star, prefix: p.pattern.indexOf("*") < 0 ? Infinity : p.pattern.indexOf("*") }];
  });
  return hits.sort((a, b) => b.prefix - a.prefix)[0];
}

/**
 * Candidate base paths (without extension handling) a bare specifier could map to, nearest config first.
 * Pure string work; the caller checks them against the set of indexed files.
 */
export function aliasCandidates(configs: AliasConfig[], fromFile: string, spec: string): string[] {
  const applicable = configs.filter((c) => within(c.dir, fromFile)).sort((a, b) => b.dir.length - a.dir.length);
  return applicable.flatMap((c) => {
    const m = bestMapping(c, spec);
    const mapped = m ? m.targets.map((t) => path.posix.normalize(path.posix.join(c.baseDir, t.replace("*", m.star)))) : [];
    return c.baseUrl ? [...mapped, path.posix.normalize(path.posix.join(c.baseDir, spec))] : mapped;
  });
}
