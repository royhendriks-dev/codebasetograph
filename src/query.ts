import type { Graph, GraphEdge, GraphNode } from "./model.js";
import { taskWords } from "./words.js";

const fileId = (p: string) => `file:${p}`;

/** Edge kinds that link two files: code imports, Java supertypes, config/CI/Angular references. `declares` is file-to-symbol and not a link. */
const LINK_KINDS = new Set<GraphEdge["kind"]>(["imports", "reexports", "extends", "references"]);

/** Case-insensitive substring search over symbol and file names. Exact matches rank first. */
export function findSymbols(g: Graph, term: string, limit = 20): GraphNode[] {
  const t = term.toLowerCase();
  return g.nodes
    .filter((n) => n.kind !== "package" && n.name.toLowerCase().includes(t))
    .sort((a, b) => Number(b.name.toLowerCase() === t) - Number(a.name.toLowerCase() === t) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function dependencies(g: Graph, path: string): GraphEdge[] {
  return g.edges.filter((e) => e.from === fileId(path) && LINK_KINDS.has(e.kind));
}

export function dependents(g: Graph, path: string): GraphEdge[] {
  return g.edges.filter((e) => e.to === fileId(path) && LINK_KINDS.has(e.kind));
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


/** Spec/test files are rarely the file to edit first; they still match, but rank lower. */
export function isTestPath(p: string): boolean {
  return /\.(spec|test)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)(__tests__|tests?|e2e)\//.test(p);
}

/**
 * Plain, explainable scoring (a baseline to measure against, not a quality claim):
 * exact name match 3, name contains word 2, path contains word 1; exported symbols +1; tests x0.3; Markdown headings, npm scripts and maven artifacts x0.3; config keys x0.5 (many per file, would crowd out code).
 * Non-exported symbols need a name match; a path-only match is kept for files, not for symbols.
 */
export function scoreNode(n: GraphNode, words: string[]): number {
  const name = n.name.toLowerCase(), path = (n.path ?? "").toLowerCase();
  let s = 0;
  for (const w of words) {
    if (name === w) s += 3;
    else if (name.includes(w)) s += 2;
    else if (n.kind === "file" && path.includes(w)) s += 1;
  }
  if (s === 0) return 0;
  if (n.kind === "symbol" && n.exported) s += 1;
  if ((n.path && isTestPath(n.path)) || n.detail?.startsWith("md h") || n.detail === "npm script" || n.detail === "maven artifact" || (n.kind === "file" && n.path?.endsWith(".md"))) s *= 0.3;
  if (n.detail === "config key") s *= 0.5;
  return s;
}

export interface ContextItem { path: string; lines?: [number, number]; why: string; evidence: string }

/**
 * Task context: match words from the task to symbol/file names, add direct neighbours,
 * and stop when the budget (approximate token count of the rendered text) is reached.
 * Output is a pointer list, not source code: the agent must still open the files it needs.
 */
export function context(g: Graph, task: string, budgetTokens = 800, synonyms: Record<string, string[]> = {}): { text: string; items: ContextItem[]; truncated: boolean } {
  const words = taskWords(task, synonyms);
  const score = new Map<string, number>();
  const items: ContextItem[] = [];
  for (const n of g.nodes) {
    if (n.kind === "package") continue;
    const s = scoreNode(n, words);
    if (s > 0) score.set(n.id, s);
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
  if (unresolved.length) lines.push(`! ${unresolved.length} unresolved import(s) in these files; the graph may miss links (e.g. an alias that is not in any tsconfig).`);
  return { text: lines.join("\n") || "no matches", items, truncated };
}

export type Resolved =
  | { status: "ok"; node: GraphNode }
  | { status: "ambiguous"; candidates: GraphNode[] }
  | { status: "none"; suggestions: GraphNode[] };

/**
 * Resolves user input to one file or symbol without guessing: a repo path or `file:`/`sym:` id wins, then an exact name
 * (case-insensitive). Several exact matches are reported as candidates instead of picking one.
 */
export function resolveTarget(g: Graph, input: string): Resolved {
  const byId = g.nodes.find((n) => n.id === input || n.id === `file:${input}` || n.id === `sym:${input}`);
  if (byId) return { status: "ok", node: byId };
  const t = input.toLowerCase();
  const exact = g.nodes.filter((n) => n.kind !== "package" && n.name.toLowerCase() === t);
  if (exact.length === 1) return { status: "ok", node: exact[0] };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact.slice(0, 10) };
  return { status: "none", suggestions: findSymbols(g, input, 5) };
}

const fileOf = (n: GraphNode) => n.path!;

/** Everything the graph knows about one file or symbol: location, symbols, and incoming/outgoing links with evidence. */
export function explain(g: Graph, node: GraphNode): { node: GraphNode; symbols: GraphNode[]; outgoing: GraphEdge[]; incoming: GraphEdge[] } {
  const p = fileOf(node);
  return {
    node,
    symbols: node.kind === "file" ? g.nodes.filter((n) => n.kind === "symbol" && n.path === p) : [],
    outgoing: dependencies(g, p),
    incoming: dependents(g, p),
  };
}

export interface PathStep { path: string; via?: GraphEdge; direction?: "imports" | "imported by" }

/**
 * Shortest chain of `resolved` links between two files (either direction per hop). Inferred and unresolved links are
 * ignored on purpose: a path through them would present a guess as a connection.
 */
export function shortestPath(g: Graph, from: string, to: string, maxHops = 8): PathStep[] | undefined {
  if (from === to) return [{ path: from }];
  const prev = new Map<string, PathStep & { from: string }>();
  let frontier = [from];
  const seen = new Set([from]);
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const e of [...dependencies(g, p), ...dependents(g, p)]) {
        if (e.evidence !== "resolved") continue;
        const out = e.from === fileId(p);
        const other = (out ? e.to : e.from).slice(5);
        if (seen.has(other)) continue;
        seen.add(other);
        prev.set(other, { from: p, path: other, via: e, direction: out ? "imports" : "imported by" });
        if (other === to) {
          const steps: PathStep[] = [];
          for (let cur: string | undefined = to; cur; cur = prev.get(cur)?.from) {
            const s = prev.get(cur);
            steps.unshift(s ? { path: s.path, via: s.via, direction: s.direction } : { path: cur });
          }
          return steps;
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return undefined;
}
