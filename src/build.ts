import { promises as fs } from "node:fs";
import * as path from "node:path";
import { discover } from "./discover.js";
import { parseFile, TS_PARSER_VERSION } from "./parse.js";
import { parseJava, JAVA_PARSER_VERSION } from "./java.js";
import { parseConfig, CONFIG_PARSER_VERSION } from "./config.js";
import type { FileFacts, Graph, GraphEdge, GraphNode } from "./model.js";

export const GRAPH_DIR = ".cbtg";
export const GRAPH_FILE = "graph.json";

export function languageOf(rel: string): "ts" | "java" | "config" {
  if (rel.endsWith(".java")) return "java";
  return /\.(ya?ml|sql)$/.test(rel) || /(^|\/)Dockerfile[^/]*$/.test(rel) ? "config" : "ts";
}

const CANDIDATE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function resolveRelative(from: string, spec: string, known: Set<string>): string | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  // ESM-style `./x.js` may point at `./x.ts`
  const stripped = base.replace(/\.[cm]?jsx?$/, "");
  const candidates = [base, ...CANDIDATE_EXTS.map((e) => base + e), ...CANDIDATE_EXTS.map((e) => stripped + e),
    ...CANDIDATE_EXTS.map((e) => `${base}/index${e}`)];
  return candidates.find((c) => known.has(c));
}

/** Pure: turns per-file facts into nodes and edges. Always recomputed over all files (cheap, avoids stale cross-file data). */
export function link(files: Record<string, FileFacts>): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const known = new Set(Object.keys(files));
  // Java: fully-qualified type name -> file, and package -> files
  const byFqn = new Map<string, string>();
  const byPackage = new Map<string, string[]>();
  for (const f of Object.values(files)) {
    if (f.lang !== "java") continue;
    const pkg = f.javaPackage ?? "";
    byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), f.path]);
    for (const sym of f.symbols) if (!sym.name.includes(".")) byFqn.set(pkg ? `${pkg}.${sym.name}` : sym.name, f.path);
  }
  const pkgNode = (name: string) => {
    const id = `pkg:${name}`;
    if (!nodes.has(id)) nodes.set(id, { id, kind: "package", name });
    return id;
  };
  for (const f of Object.values(files).sort((a, b) => a.path.localeCompare(b.path))) {
    const fileId = `file:${f.path}`;
    nodes.set(fileId, { id: fileId, kind: "file", name: path.posix.basename(f.path), path: f.path });
    for (const s of f.symbols) {
      const id = `sym:${f.path}#${s.name}`;
      if (!nodes.has(id)) nodes.set(id, { id, kind: "symbol", path: f.path, ...s });
      edges.push({ from: fileId, to: id, kind: "declares", evidence: "extracted", line: s.lines?.[0] });
    }
    if (f.lang === "config") {
      for (const imp of f.imports) {
        const base = { from: fileId, specifier: imp.specifier, line: imp.line, kind: "references" as const };
        if (imp.ref === "path") {
          const hit = known.has(imp.specifier) ? imp.specifier : undefined;
          edges.push({ ...base, to: `file:${hit ?? imp.specifier}`, evidence: hit ? "resolved" : "unresolved" });
        } else {
          edges.push({ ...base, to: pkgNode(`${imp.ref}:${imp.specifier}`), evidence: "inferred" });
        }
      }
      continue;
    }
    if (f.lang === "java") {
      for (const imp of f.imports) {
        const base = { from: fileId, specifier: imp.specifier, line: imp.line };
        if (imp.names[0] === "extends" && !imp.specifier.includes(".")) {
          // supertype by simple name: explicit import first, then same package. Unknown (JDK/external) => no edge, not a guess.
          const viaImport = f.imports.find((i) => !i.wildcard && i.names[0] !== "extends" && i.specifier.endsWith("." + imp.specifier));
          const target = (viaImport && byFqn.get(viaImport.specifier)) ?? byFqn.get(`${f.javaPackage ? f.javaPackage + "." : ""}${imp.specifier}`);
          if (target && target !== f.path) edges.push({ ...base, to: `file:${target}`, kind: "extends", evidence: "resolved" });
          continue;
        }
        if (imp.wildcard) {
          const members = byPackage.get(imp.specifier);
          if (members) for (const m of members) edges.push({ ...base, to: `file:${m}`, kind: "imports", evidence: "inferred" });
          else edges.push({ ...base, to: pkgNode(imp.specifier), kind: "imports", evidence: "inferred" });
          continue;
        }
        // exact type, or a static import of a member (strip the member to find the type)
        const typeFqn = byFqn.has(imp.specifier) ? imp.specifier : imp.specifier.split(".").slice(0, -1).join(".");
        const target = byFqn.get(typeFqn);
        if (target) edges.push({ ...base, to: `file:${target}`, kind: "imports", evidence: "resolved" });
        else edges.push({ ...base, to: pkgNode(imp.specifier.split(".").slice(0, -1).join(".") || imp.specifier), kind: "imports", evidence: "inferred" });
      }
      continue;
    }
    for (const imp of f.imports) {
      const kind = imp.reexport ? "reexports" : "imports";
      if (imp.specifier.startsWith(".")) {
        const target = resolveRelative(f.path, imp.specifier, known);
        edges.push({ from: fileId, to: target ? `file:${target}` : `file:${path.posix.join(path.posix.dirname(f.path), imp.specifier)}`,
          kind, evidence: target ? "resolved" : "unresolved", specifier: imp.specifier, line: imp.line });
      } else {
        // Bare specifier: assumed external package. Could be a tsconfig path alias (not supported yet), so only "inferred".
        const m = imp.specifier.match(/^(@[^/]+\/[^/]+|[^/]+)/);
        const name = m ? m[1] : imp.specifier;
        const id = `pkg:${name.replace(/^node:/, "")}`;
        if (!nodes.has(id)) nodes.set(id, { id, kind: "package", name });
        edges.push({ from: fileId, to: id, kind, evidence: "inferred", specifier: imp.specifier, line: imp.line });
      }
    }
  }
  return { nodes: [...nodes.values()], edges };
}

export interface IndexStats { parsed: number; reused: number; removed: number; files: number }

/** Indexes `root`. Re-parses only files whose content hash changed; links are always rebuilt. */
export async function indexRepo(root: string): Promise<{ graph: Graph; stats: IndexStats }> {
  root = path.resolve(root);
  const previous = await loadGraph(root);
  const { files: found, skipped } = await discover(root);
  const files: Record<string, FileFacts> = {};
  let parsed = 0, reused = 0;
  for (const rel of found) {
    let text: string;
    try { text = await fs.readFile(path.join(root, rel), "utf8"); }
    catch { skipped.push({ path: rel, reason: "unreadable" }); continue; }
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(text).digest("hex");
    const prev = previous?.files[rel];
    const kind = languageOf(rel);
    const parserVersion = { ts: TS_PARSER_VERSION, java: JAVA_PARSER_VERSION, config: CONFIG_PARSER_VERSION }[kind];
    if (prev && prev.hash === hash && prev.parser === parserVersion) { files[rel] = prev; reused++; }
    else { files[rel] = kind === "java" ? await parseJava(rel, text) : kind === "config" ? parseConfig(rel, text) : parseFile(rel, text); parsed++; }
  }
  const removed = previous ? Object.keys(previous.files).filter((p) => !(p in files)).length : 0;
  const graph: Graph = { version: 1, root: path.basename(root), files, ...link(files), skipped };
  const dir = path.join(root, GRAPH_DIR);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, GRAPH_FILE + ".tmp");
  await fs.writeFile(tmp, JSON.stringify(graph));
  await fs.rename(tmp, path.join(dir, GRAPH_FILE)); // atomic replace: a crash never leaves a half-written graph
  return { graph, stats: { parsed, reused, removed, files: found.length } };
}

export async function loadGraph(root: string): Promise<Graph | undefined> {
  try {
    const g = JSON.parse(await fs.readFile(path.join(root, GRAPH_DIR, GRAPH_FILE), "utf8")) as Graph;
    return g.version === 1 ? g : undefined; // unknown/corrupt version => full rebuild
  } catch { return undefined; }
}
