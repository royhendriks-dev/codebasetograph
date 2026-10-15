import { promises as fs } from "node:fs";
import * as path from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", ".angular", ".next", ".nx",
  ".cache", ".cbtg", "tmp", ".turbo", "target", ".gradle", ".idea",
]);
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".java", ".yml", ".yaml", ".sql", ".conf", ".properties", ".html", ".scss", ".css"]);
/** `.env.example` style templates only: a real `.env` is never indexed. */
const ENV_TEMPLATE = /^\.env(\.[\w-]+)?\.(example|sample|template)$/;
const isIndexable = (name: string) => EXTS.has(path.extname(name)) || /^Dockerfile(\.[\w.-]+)?$/.test(name) || ENV_TEMPLATE.test(name);
const MAX_BYTES = 1_000_000;

/** Minimal .gitignore support: plain names, `dir/`, `*.ext`, `/anchored`. Negation is not supported. */
function compileIgnore(lines: string[]): (rel: string, isDir: boolean) => boolean {
  const rules = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((l) => {
      const dirOnly = l.endsWith("/");
      const anchored = l.startsWith("/") || l.slice(0, -1).includes("/");
      const body = l.replace(/^\//, "").replace(/\/$/, "");
      const re = new RegExp(
        "^" + body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$",
      );
      return { dirOnly, anchored, re };
    });
  return (rel, isDir) =>
    rules.some((r) => {
      if (r.dirOnly && !isDir) return false;
      if (r.anchored) return r.re.test(rel);
      return r.re.test(path.posix.basename(rel));
    });
}

export interface Discovered {
  files: string[];
  /** tsconfig*.json / jsconfig.json files, for alias resolution. Read as JSON only. */
  configs: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/** Walks `root`, returns repo-relative posix paths of indexable source files. Never follows symlinks. */
export async function discover(root: string): Promise<Discovered> {
  let ignored: (rel: string, isDir: boolean) => boolean = () => false;
  try {
    ignored = compileIgnore((await fs.readFile(path.join(root, ".gitignore"), "utf8")).split(/\r?\n/));
  } catch { /* no .gitignore */ }

  const files: string[] = [];
  const configs: string[] = [];
  const skipped: Discovered["skipped"] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(e.name) || ignored(rel, true)) continue;
        await walk(rel);
      } else if (e.isFile()) {
        if (ignored(rel, false)) continue;
        if (/^(tsconfig(\.[\w.-]+)?|jsconfig)\.json$/.test(e.name)) { configs.push(rel); continue; }
        if (!isIndexable(e.name)) continue;
        if (/\.d\.[cm]?ts$/.test(e.name) || /\.min\.[cm]?js$/.test(e.name)) {
          skipped.push({ path: rel, reason: "generated/declaration file" });
          continue;
        }
        const st = await fs.stat(path.join(root, rel));
        if (st.size > MAX_BYTES) {
          skipped.push({ path: rel, reason: `larger than ${MAX_BYTES} bytes` });
          continue;
        }
        files.push(rel);
      }
    }
  }
  await walk("");
  return { files, configs, skipped };
}
