import * as path from "node:path";
import type { FileFacts, GraphEdge } from "./model.js";

/**
 * Linking for the tree-sitter languages (Python, Go, C#). Evidence follows the Java rules: a path that exists in the repo
 * is `resolved`; a match on a name, directory suffix or namespace is `inferred`; anything else is an external package
 * node. Unknown imports never become guesses about repo files.
 */
interface Indexes {
  /** Python: module path suffix (`a/b/c`) to files, `__init__.py` counted as its directory. */
  pySuffix: Map<string, string[]>;
  /** Go: directory to its non-test files. */
  goDirs: Map<string, string[]>;
  /** C#: namespace to files that declare it. */
  csNamespaces: Map<string, string[]>;
}

const cache = new WeakMap<Record<string, FileFacts>, Indexes>();
const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);

function indexes(files: Record<string, FileFacts>): Indexes {
  let ix = cache.get(files);
  if (ix) return ix;
  ix = { pySuffix: new Map(), goDirs: new Map(), csNamespaces: new Map() };
  for (const f of Object.values(files)) {
    if (f.lang === "py") {
      const mod = f.path.replace(/(\/__init__)?\.py$/, "").split("/");
      for (let i = 0; i < mod.length; i++) push(ix.pySuffix, mod.slice(i).join("/"), f.path);
    } else if (f.lang === "go" && !f.path.endsWith("_test.go")) {
      push(ix.goDirs, path.posix.dirname(f.path), f.path);
    } else if (f.lang === "cs") {
      for (const ns of f.namespaces ?? []) push(ix.csNamespaces, ns, f.path);
    }
  }
  cache.set(files, ix);
  return ix;
}

type EdgeBase = Pick<GraphEdge, "from" | "specifier" | "line">;

/** Python: relative imports resolve from the file's directory, absolute ones from the repo root, then by unique suffix (src layouts). */
function linkPython(f: FileFacts, ix: Indexes, known: Set<string>, edges: GraphEdge[], pkgNode: (n: string) => string): void {
  const fileId = `file:${f.path}`;
  const seen = new Set<string>();
  const add = (e: Omit<GraphEdge, "from" | "kind">) => {
    const key = `${e.to}|${e.evidence}`;
    if (!seen.has(key)) { seen.add(key); edges.push({ from: fileId, kind: "imports", ...e }); }
  };
  const asFile = (base: string) => [`${base}.py`, `${base}/__init__.py`].find((c) => known.has(c));
  for (const imp of f.imports) {
    const base: Pick<GraphEdge, "specifier" | "line"> = { specifier: imp.specifier, line: imp.line };
    const dots = imp.specifier.match(/^\.*/)![0].length;
    const mod = imp.specifier.slice(dots).split(".").filter(Boolean).join("/");
    // `from pkg import sub` may name a module, not a symbol: try the module itself and each imported name below it
    const candidates = (root: string) => [...(mod ? [mod] : []), ...(imp.names.includes("*") ? [] : imp.names.map((n) => (mod ? `${mod}/${n.replace(/\./g, "/")}` : n.replace(/\./g, "/"))))].map((m) => (root ? path.posix.join(root, m) : m));
    if (dots) {
      let dir = path.posix.dirname(f.path);
      for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
      const root = dir === "." ? "" : dir;
      const hits = [...new Set(candidates(root).filter(Boolean).map(asFile).filter((x): x is string => !!x && x !== f.path))];
      const init = !mod && !hits.length && known.has(path.posix.join(root, "__init__.py")) ? [path.posix.join(root, "__init__.py")] : [];
      if (init.length) add({ to: `file:${init[0]}`, evidence: "resolved", ...base });
      else if (hits.length) for (const h of hits) add({ to: `file:${h}`, evidence: "resolved", ...base });
      else add({ to: `file:${path.posix.join(root, mod)}`, evidence: "unresolved", ...base });
      continue;
    }
    const direct = [...new Set(candidates("").map(asFile).filter((x): x is string => !!x && x !== f.path))];
    if (direct.length) { for (const h of direct) add({ to: `file:${h}`, evidence: "resolved", ...base }); continue; }
    const bySuffix = [...new Set(candidates("").flatMap((c) => ix.pySuffix.get(c) ?? []).filter((p) => p !== f.path))];
    if (bySuffix.length === 1) add({ to: `file:${bySuffix[0]}`, evidence: "inferred", ...base });
    else add({ to: pkgNode(imp.specifier.split(".")[0]), evidence: "inferred", ...base });
  }
}

/** Go: an import path is a package directory; the directory whose path the import ends with (longest wins) is the target. */
function linkGo(f: FileFacts, ix: Indexes, edges: GraphEdge[], pkgNode: (n: string) => string): void {
  const fileId = `file:${f.path}`;
  for (const imp of f.imports) {
    const base: EdgeBase = { from: fileId, specifier: imp.specifier, line: imp.line };
    const dirs = [...ix.goDirs.keys()].filter((d) => d !== "." && (imp.specifier === d || imp.specifier.endsWith("/" + d)) && d !== path.posix.dirname(f.path));
    const best = dirs.sort((a, b) => b.length - a.length)[0];
    if (best) for (const t of ix.goDirs.get(best)!) edges.push({ ...base, to: `file:${t}`, kind: "imports", evidence: "inferred" });
    else edges.push({ ...base, to: pkgNode(imp.specifier), kind: "imports", evidence: "inferred" });
  }
}

/** C#: a `using` names a namespace (or a type or alias target inside one); files declaring that namespace are the candidates. */
function linkCSharp(f: FileFacts, ix: Indexes, edges: GraphEdge[], pkgNode: (n: string) => string): void {
  const fileId = `file:${f.path}`;
  for (const imp of f.imports) {
    const base: EdgeBase = { from: fileId, specifier: imp.specifier, line: imp.line };
    const parts = imp.specifier.split(".");
    const ns = [imp.specifier, parts.slice(0, -1).join(".")].find((n) => n && ix.csNamespaces.has(n));
    const targets = ns ? ix.csNamespaces.get(ns)!.filter((p) => p !== f.path) : [];
    if (targets.length) for (const t of targets) edges.push({ ...base, to: `file:${t}`, kind: "imports", evidence: "inferred" });
    else if (!ns) edges.push({ ...base, to: pkgNode(`cs:${parts[0] === "System" || parts[0] === "Microsoft" ? parts[0] : imp.specifier}`), kind: "imports", evidence: "inferred" });
  }
}

export function linkTreeSitter(f: FileFacts, files: Record<string, FileFacts>, known: Set<string>, edges: GraphEdge[], pkgNode: (n: string) => string): void {
  const ix = indexes(files);
  if (f.lang === "py") linkPython(f, ix, known, edges, pkgNode);
  else if (f.lang === "go") linkGo(f, ix, edges, pkgNode);
  else linkCSharp(f, ix, edges, pkgNode);
}
