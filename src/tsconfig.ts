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

/** Reads one config file as JSON-with-comments. Never throws: unreadable or invalid files are ignored. Nothing is executed. */
async function readRaw(root: string, rel: string, depth: number): Promise<RawConfig> {
  if (depth > MAX_EXTENDS) return {};
  let text: string;
  try { text = await fs.readFile(path.join(root, rel), "utf8"); } catch { return {}; }
  const parsed = ts.parseConfigFileTextToJson(rel, text).config as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  const cfg = parsed as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
  const dir = path.posix.dirname(rel);
  let out: RawConfig = {};
  const parents = typeof cfg.extends === "string" ? [cfg.extends] : Array.isArray(cfg.extends) ? cfg.extends : [];
  for (const p of parents) {
    // Only relative extends inside the repository; package presets (e.g. "@tsconfig/node20") are not followed.
    if (typeof p !== "string" || !p.startsWith(".")) continue;
    let target = path.posix.normalize(path.posix.join(dir, p));
    if (target.startsWith("..")) continue;
    if (!target.endsWith(".json")) target += ".json";
    out = { ...out, ...(await readRaw(root, target, depth + 1)) };
  }
  const co = cfg.compilerOptions;
  if (co && typeof co === "object") {
    if (typeof co.baseUrl === "string") {
      const b = path.posix.normalize(path.posix.join(dir, co.baseUrl));
      if (!b.startsWith("..")) { out.baseDir = b; out.baseUrl = true; }
    }
    if (co.paths && typeof co.paths === "object") {
      const paths: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(co.paths as Record<string, unknown>)) {
        if (Array.isArray(v)) paths[k] = v.filter((x): x is string => typeof x === "string");
      }
      // `paths` resolve against the config that declares them when no baseUrl is set.
      out.paths = paths;
      if (!out.baseDir) out.baseDir = dir;
    }
  }
  return out;
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

/**
 * Candidate base paths (without extension handling) a bare specifier could map to, nearest config first.
 * Pure string work; the caller checks them against the set of indexed files.
 */
export function aliasCandidates(configs: AliasConfig[], fromFile: string, spec: string): string[] {
  const out: string[] = [];
  const applicable = configs.filter((c) => within(c.dir, fromFile)).sort((a, b) => b.dir.length - a.dir.length);
  for (const c of applicable) {
    let best: { pattern: string; targets: string[]; star: string } | undefined;
    for (const p of c.paths) {
      const i = p.pattern.indexOf("*");
      if (i < 0) { if (p.pattern === spec) { best = { ...p, star: "" }; break; } continue; }
      const pre = p.pattern.slice(0, i), post = p.pattern.slice(i + 1);
      if (spec.length >= pre.length + post.length && spec.startsWith(pre) && spec.endsWith(post)
        && (!best || pre.length > best.pattern.indexOf("*"))) best = { ...p, star: spec.slice(pre.length, spec.length - post.length) };
    }
    if (best) for (const t of best.targets) out.push(path.posix.normalize(path.posix.join(c.baseDir, t.replace("*", best.star))));
    if (c.baseUrl) out.push(path.posix.normalize(path.posix.join(c.baseDir, spec)));
  }
  return out;
}
