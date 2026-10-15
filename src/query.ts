import type { Graph, GraphEdge, GraphNode } from "./model.js";

const fileId = (p: string) => `file:${p}`;

/** Case-insensitive substring search over symbol and file names. Exact matches rank first. */
export function findSymbols(g: Graph, term: string, limit = 20): GraphNode[] {
  const t = term.toLowerCase();
  return g.nodes
    .filter((n) => n.kind !== "package" && n.name.toLowerCase().includes(t))
    .sort((a, b) => Number(b.name.toLowerCase() === t) - Number(a.name.toLowerCase() === t) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function dependencies(g: Graph, path: string): GraphEdge[] {
  return g.edges.filter((e) => e.from === fileId(path) && (e.kind === "imports" || e.kind === "reexports"));
}

export function dependents(g: Graph, path: string): GraphEdge[] {
  return g.edges.filter((e) => e.to === fileId(path) && (e.kind === "imports" || e.kind === "reexports"));
}

/** Bounded breadth-first walk over resolved import edges, in both directions. */
export function related(g: Graph, path: string, depth = 1): Array<{ path: string; distance: number }> {
  const seen = new Map<string, number>([[path, 0]]);
  let frontier = [path];
  for (let d = 1; d <= depth; d++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const e of [...dependencies(g, p), ...dependents(g, p)]) {
        if (e.evidence !== "resolved") continue;
        const other = (e.from === fileId(p) ? e.to : e.from).slice(5);
        if (!seen.has(other)) { seen.set(other, d); next.push(other); }
      }
    }
    frontier = next;
  }
  return [...seen].filter(([p]) => p !== path).map(([p, distance]) => ({ path: p, distance }));
}

export interface ContextItem { path: string; lines?: [number, number]; why: string; evidence: string }

/**
 * Task context: match words from the task to symbol/file names, add direct neighbours,
 * and stop when the budget (approximate token count of the rendered text) is reached.
 * Output is a pointer list, not source code: the agent must still open the files it needs.
 */
export function context(g: Graph, task: string, budgetTokens = 800): { text: string; items: ContextItem[]; truncated: boolean } {
  const words = [...new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3))];
  const score = new Map<string, number>();
  const items: ContextItem[] = [];
  for (const n of g.nodes) {
    if (n.kind === "package") continue;
    const hits = words.filter((w) => n.name.toLowerCase().includes(w) || (n.path ?? "").toLowerCase().includes(w)).length;
    if (!hits) continue;
    score.set(n.id, hits);
  }
  const ranked = [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => g.nodes.find((n) => n.id === id)!);
  const seenFiles = new Set<string>();
  for (const n of ranked) {
    items.push({ path: n.path!, lines: n.lines, why: `${n.kind === "symbol" ? n.detail + " " : "file "}${n.name}${n.exported ? " (exported)" : ""} matches task words`, evidence: "extracted" });
    seenFiles.add(n.path!);
  }
  for (const p of [...seenFiles].slice(0, 5)) {
    for (const r of related(g, p, 1)) {
      if (seenFiles.has(r.path)) continue;
      seenFiles.add(r.path);
      items.push({ path: r.path, why: `imports or is imported by ${p}`, evidence: "resolved" });
    }
  }
  const lines: string[] = [];
  let used = 0, truncated = false;
  for (const it of items) {
    const line = `- ${it.path}${it.lines ? `:${it.lines[0]}-${it.lines[1]}` : ""} [${it.evidence}] ${it.why}`;
    const cost = Math.ceil(line.length / 4);
    if (used + cost > budgetTokens) { truncated = true; break; }
    used += cost; lines.push(line);
  }
  const unresolved = g.edges.filter((e) => e.evidence === "unresolved" && [...seenFiles].some((p) => e.from === fileId(p)));
  if (unresolved.length) lines.push(`! ${unresolved.length} unresolved import(s) in these files; the graph may miss links (e.g. tsconfig path aliases).`);
  return { text: lines.join("\n") || "no matches", items, truncated };
}
