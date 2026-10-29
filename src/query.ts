import type { Graph, GraphEdge, GraphNode } from "./model.js";
import { componentBundle } from "./angular.js";
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

/**
 * One output line per linked file and evidence level: a file that imports the same module twice (a normal and a type
 * import, or a static and a dynamic one) is listed once with every line number, `a.ts:3,18 [resolved]`.
 * Unresolved links stay apart per specifier, since each one is a different missing target.
 */
export function linkLines(edges: GraphEdge[], side: "from" | "to"): string[] {
  const groups = new Map<string, { target: string; evidence: string; lines: number[]; specifier?: string }>();
  for (const e of edges) {
    const target = e[side].replace(/^(file|pkg):/, "");
    const key = `${target}\u0000${e.evidence}\u0000${e.evidence === "unresolved" ? e.specifier ?? "" : ""}`;
    const g = groups.get(key) ?? { target, evidence: e.evidence, lines: [], specifier: e.evidence === "unresolved" ? e.specifier : undefined };
    if (e.line !== undefined && !g.lines.includes(e.line)) g.lines.push(e.line);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => `${g.target}${g.lines.length ? ":" + g.lines.sort((a, b) => a - b).join(",") : ""} [${g.evidence}]${g.specifier !== undefined ? ` (${g.specifier})` : ""}`);
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

/** Splits an identifier or file name into lower-case words: `LoginRateLimiter.java` gives login, rate, limiter, java. */
export function nameTokens(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** A name word and a task word match when they are equal or one is a prefix of the other (lang/language, failure/failures); 4 characters minimum so short words do not match everything. */
export function sharesStem(token: string, word: string): boolean {
  const [short, long] = token.length <= word.length ? [token, word] : [word, token];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * Plain, explainable scoring (a baseline to measure against, not a quality claim):
 * exact name match 3, name contains word 2, path contains word 1; exported symbols +1; tests x0.3; Markdown headings, npm scripts and maven artifacts x0.3; config keys x0.5 (many per file, would crowd out code).
 * Non-exported symbols need a name match; a path-only match is kept for files, not for symbols.
 */
export function scoreNode(n: GraphNode, words: string[], weight: (w: string) => number = () => 1): number {
  const name = n.name.toLowerCase(), path = (n.path ?? "").toLowerCase();
  const tokens = nameTokens(n.name);
  let s = 0;
  for (const w of words) {
    const k = weight(w);
    if (name === w) s += 3 * k;
    else if (name.includes(w)) s += 2 * k;
    else if (tokens.some((t) => sharesStem(t, w))) s += 1.5 * k;
    else if (n.kind === "file" && path.includes(w)) s += k;
  }
  if (s === 0) return 0;
  if (n.kind === "symbol" && n.exported) s += 1;
  if ((n.path && isTestPath(n.path)) || n.detail?.startsWith("md h") || n.detail === "npm script" || n.detail === "maven artifact" || (n.kind === "file" && n.path?.endsWith(".md"))) s *= 0.3;
  if (n.detail === "config key") s *= 0.5;
  return s;
}

/**
 * Rarer words say more: a word that appears in the names of many files ("request", "frontend") is weighted down, one that
 * appears in few ("limiter") keeps full weight. Computed from the graph itself, so it adapts to any repository.
 */
export function wordWeights(g: Graph, words: string[]): (w: string) => number {
  const files = new Set(g.nodes.filter((n) => n.path).map((n) => n.path!));
  const total = Math.max(files.size, 2);
  const hit = new Map<string, Set<string>>(words.map((w) => [w, new Set<string>()]));
  for (const n of g.nodes) {
    if (!n.path || n.kind === "package") continue;
    const name = n.name.toLowerCase(), tokens = nameTokens(n.name);
    for (const w of words) if (name.includes(w) || tokens.some((t) => sharesStem(t, w))) hit.get(w)!.add(n.path);
  }
  return (w) => {
    const df = hit.get(w)?.size ?? 0;
    return df === 0 ? 1 : Math.min(1, Math.max(0.2, Math.log(total / df) / Math.log(total)));
  };
}

export interface ContextItem { path: string; lines?: [number, number]; why: string; evidence: string }

/** Symbol lines shown per file in `context`; one large file must not use the whole budget. */
const SYMBOLS_PER_FILE = 3;
/** Share of a top file's score that a directly linked file gets, by evidence of the link. */
const NEIGHBOUR_SHARE: Record<string, number> = { resolved: 0.5, inferred: 0.3 };
/** Template, style and spec next to a matching component join the ranking with this share of its score. */
const BUNDLE_SHARE = 0.4;

/**
 * Files ranked by the words of earlier commits that touched them. Commit messages are written in the team's own words
 * ("opstartscherm", "dark mode"), so they link task language to files even when no file or symbol name contains the word.
 * Words are weighted by how rare they are among commits; a commit that touches many files spreads its weight over them.
 * Returns score and the matched words per file.
 */
export function historyRanking(g: Graph, words: string[]): Map<string, { score: number; words: Set<string> }> {
  const out = new Map<string, { score: number; words: Set<string> }>();
  const commits = g.history ?? [];
  if (!commits.length || !words.length) return out;
  const hits = (c: { words: string[] }, w: string) => c.words.some((a) => a === w || sharesStem(a, w));
  const idf = new Map(words.map((w) => [w, Math.log(1 + commits.length / (1 + commits.filter((c) => hits(c, w)).length))]));
  for (const c of commits) {
    const matched = words.filter((w) => hits(c, w));
    if (!matched.length) continue;
    const share = matched.reduce((s, w) => s + idf.get(w)!, 0) / Math.log(2 + c.files.length);
    for (const f of c.files) {
      const r = out.get(f) ?? out.set(f, { score: 0, words: new Set() }).get(f)!;
      r.score += f.endsWith(".md") ? share * 0.3 : share;
      for (const w of matched) r.words.add(w);
    }
  }
  return out;
}

/** Reciprocal rank fusion: merges ranked lists by position only, so scores on different scales need no calibration. */
function fuse(lists: string[][], k = 10): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((p, i) => score.set(p, (score.get(p) ?? 0) + 1 / (k + i + 1)));
  return [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([p]) => p);
}

/**
 * Task context: match words from the task to symbol/file names, give files linked to the best matches part of their score,
 * merge that ranking with the commit-history ranking, and stop when the budget (approximate token count of the rendered
 * text) is reached. Output is a pointer list, not source code: the agent must still open the files it needs.
 */
export function context(g: Graph, task: string, budgetTokens = 800, synonyms: Record<string, string[]> = {}): { text: string; items: ContextItem[]; shown: ContextItem[]; truncated: boolean } {
  const words = taskWords(task, synonyms);
  const weight = wordWeights(g, words);
  // Matches per file, best first. Files rank by their best match plus half of every further match, so a file where several names match beats a file with one lucky symbol.
  const matches = new Map<string, Array<[number, GraphNode]>>();
  for (const n of g.nodes) {
    if (n.kind === "package") continue;
    const s = scoreNode(n, words, weight);
    if (s > 0) (matches.get(n.path!) ?? matches.set(n.path!, []).get(n.path!)!).push([s, n]);
  }
  const fileScore = new Map<string, number>();
  for (const [p, list] of matches) {
    list.sort((a, b) => b[0] - a[0] || a[1].id.localeCompare(b[1].id));
    fileScore.set(p, list.reduce((sum, [s], i) => sum + (i === 0 ? s : s / 2), 0));
  }
  const byScore = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([p]) => p);
  // Files imported by or importing the five best matches join the ranking with part of that file's score.
  const nameScore = new Map(fileScore);
  const via = new Map<string, string>();
  for (const p of byScore(fileScore).slice(0, 5)) {
    for (const e of [...dependencies(g, p), ...dependents(g, p)]) {
      const other = e.from === fileId(p) ? e.to : e.from;
      const share = NEIGHBOUR_SHARE[e.evidence] ?? 0;
      if (!other.startsWith("file:") || other === fileId(p) || !share) continue;
      const q = other.slice(5);
      nameScore.set(q, (nameScore.get(q) ?? 0) + fileScore.get(p)! * share * (isTestPath(q) ? 0.5 : 1));
      if (!fileScore.has(q) && !via.has(q)) via.set(q, p);
    }
  }
  const paths = Object.keys(g.files);
  for (const p of byScore(fileScore).slice(0, 5)) {
    for (const q of componentBundle(paths, p)) {
      nameScore.set(q, (nameScore.get(q) ?? 0) + fileScore.get(p)! * BUNDLE_SHARE * (isTestPath(q) ? 0.5 : 1));
      if (!fileScore.has(q) && !via.has(q)) via.set(q, p);
    }
  }
  const history = historyRanking(g, words);
  const ranking = history.size ? fuse([byScore(nameScore), byScore(new Map([...history].map(([p, h]) => [p, h.score])))]) : byScore(nameScore);
  const items: ContextItem[] = [];
  for (const p of ranking) {
    const own = matches.get(p);
    if (own) {
      // One item per file: the best symbols on a single line, so one large file does not eat the budget.
      const top = own.slice(0, SYMBOLS_PER_FILE).map(([, n]) => n);
      const names = top.map((n) => `${n.kind === "symbol" ? n.detail + " " : "file "}${n.name}${n.exported ? "*" : ""}${n.kind === "symbol" && n.lines ? `:${n.lines[0]}-${n.lines[1]}` : ""}`);
      const more = own.length - top.length;
      items.push({ path: p, lines: top[0].lines, why: `${names.join(", ")}${more > 0 ? ` (+${more} more)` : ""} match task words`, evidence: "extracted" });
    } else if (via.has(p)) {
      const bundled = componentBundle(paths, via.get(p)!).includes(p) && !dependencies(g, via.get(p)!).concat(dependents(g, via.get(p)!)).some((e) => e.from === fileId(p) || e.to === fileId(p));
      items.push(bundled ? { path: p, why: `template, style or spec of ${via.get(p)}`, evidence: "inferred" } : { path: p, why: `imports or is imported by ${via.get(p)}`, evidence: "resolved" });
    } else if (history.has(p)) {
      items.push({ path: p, why: `changed in earlier commits about ${[...history.get(p)!.words].slice(0, 3).join(", ")}`, evidence: "inferred" });
    }
  }
  const lines: string[] = [];
  const shown: ContextItem[] = [];
  let used = 0, truncated = false;
  for (const it of items) {
    const line = `- ${it.path} [${it.evidence}] ${it.why}`;
    const cost = Math.ceil(line.length / 4);
    if (used + cost > budgetTokens) { truncated = true; break; }
    used += cost; lines.push(line); shown.push(it);
  }
  const shownFiles = new Set(shown.map((i) => i.path));
  const unresolved = g.edges.filter((e) => e.evidence === "unresolved" && shownFiles.has(e.from.slice(5)));
  if (unresolved.length) lines.push(`! ${unresolved.length} unresolved import(s) in these files; the graph may miss links (e.g. an alias that is not in any tsconfig).`);
  return { text: lines.join("\n") || "no matches", items, shown, truncated };
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
