import { promises as fs } from "node:fs";
import * as path from "node:path";
import { discover } from "./discover.js";
import { parseFile } from "./parse.js";
import type { FileFacts, Graph, GraphEdge, GraphNode } from "./model.js";

export const GRAPH_DIR = ".cbtg";
export const GRAPH_FILE = "graph.json";

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
  for (const f of Object.values(files).sort((a, b) => a.path.localeCompare(b.path))) {
    const fileId = `file:${f.path}`;
    nodes.set(fileId, { id: fileId, kind: "file", name: path.posix.basename(f.path), path: f.path });
    for (const s of f.symbols) {
      const id = `sym:${f.path}#${s.name}`;
      if (!nodes.has(id)) nodes.set(id, { id, kind: "symbol", path: f.path, ...s });
      edges.push({ from: fileId, to: id, kind: "declares", evidence: "extracted", line: s.lines?.[0] });
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
    if (prev && prev.hash === hash) { files[rel] = prev; reused++; }
    else { files[rel] = parseFile(rel, text); parsed++; }
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
