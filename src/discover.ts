import { promises as fs } from "node:fs";
import * as path from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", ".angular", ".next", ".nx",
  ".cache", ".cbtg", "tmp", ".turbo", "target", ".gradle", ".idea",
]);
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".java", ".yml", ".yaml", ".sql", ".conf", ".properties", ".md", ".html", ".scss", ".css"]);
/** `.env.example` style templates only: a real `.env` is never indexed. */
const ENV_TEMPLATE = /^\.env(\.[\w-]+)?\.(example|sample|template)$/;
const isIndexable = (name: string) => EXTS.has(path.extname(name)) || /^(package\.json|pom\.xml)$/.test(name) || /^Dockerfile(\.[\w.-]+)?$/.test(name) || ENV_TEMPLATE.test(name);
const MAX_BYTES = 1_000_000;

/** Result of one rule file for a path: true = ignored, false = re-included by `!rule`, undefined = no rule matches. */
type IgnoreMatcher = (rel: string, isDir: boolean) => boolean | undefined;

/** Translates one gitignore glob (without leading or trailing slash) to a regex over a posix path. */
function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const dirPrefix = glob[i + 2] === "/" && (i === 0 || glob[i - 1] === "/"); // "**/" matches zero or more directories
      const dirSuffix = i + 2 === glob.length && i > 0 && glob[i - 1] === "/"; // "/**" matches everything inside
      out += dirPrefix ? "(?:[^/]+/)*" : dirSuffix ? ".+" : ".*";
      i += dirPrefix ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += /[\\^$.+(){}|[\]]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${out}$`);
}

/**
 * .gitignore support for one file: plain names, `dir/`, `*`, `?`, `**`, `/anchored`, `a/b` (anchored) and `!negation`.
 * Like git, the last matching rule wins. Paths are relative to the directory that holds the .gitignore.
 */
function compileIgnore(lines: string[]): IgnoreMatcher {
  const rules = lines
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l && !l.startsWith("#"))
    .map((raw) => {
      const negated = raw.startsWith("!");
      const l = negated || raw.startsWith("\\!") || raw.startsWith("\\#") ? raw.slice(1) : raw;
      const dirOnly = l.endsWith("/");
      const anchored = l.startsWith("/") || l.slice(0, -1).includes("/");
      const body = l.replace(/^\//, "").replace(/\/$/, "");
      return { negated, dirOnly, anchored, re: globToRegex(body) };
    });
  return (rel, isDir) => {
    let result: boolean | undefined;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(r.anchored ? rel : path.posix.basename(rel))) result = !r.negated;
    }
    return result;
  };
}

export interface Discovered {
  files: string[];
  /** tsconfig*.json / jsconfig.json files, for alias resolution. Read as JSON only. */
  configs: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/** Walks `root`, returns repo-relative posix paths of indexable source files. Never follows symlinks. */
export async function discover(root: string): Promise<Discovered> {
  /** The .gitignore files met on the way down, each with the directory it lives in. */
  type Scope = { dir: string; match: IgnoreMatcher };
  const readScope = async (dir: string): Promise<Scope | undefined> => {
    try {
      return { dir, match: compileIgnore((await fs.readFile(path.join(root, dir, ".gitignore"), "utf8")).split(/\r?\n/)) };
    } catch { return undefined; /* no .gitignore here */ }
  };
  /** A deeper .gitignore overrides a shallower one; inside a file the last rule wins. */
  const isIgnored = (scopes: Scope[], rel: string, isDir: boolean) => {
    let result = false;
    for (const sc of scopes) result = sc.match(sc.dir ? rel.slice(sc.dir.length + 1) : rel, isDir) ?? result;
    return result;
  };

  const files: string[] = [];
  const configs: string[] = [];
  const skipped: Discovered["skipped"] = [];

  async function walk(dir: string, parents: Scope[]): Promise<void> {
    const own = dir ? await readScope(dir) : undefined;
    const scopes = own ? [...parents, own] : parents;
    const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(e.name) || isIgnored(scopes, rel, true)) continue;
        await walk(rel, scopes);
      } else if (e.isFile()) {
        if (isIgnored(scopes, rel, false)) continue;
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
  const rootScope = await readScope("");
  await walk("", rootScope ? [rootScope] : []);
  return { files, configs, skipped };
}
