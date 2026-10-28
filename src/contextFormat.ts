import { componentBundle } from "./angular.js";
import type { Evidence, Graph, GraphNode } from "./model.js";
import { dependencies, dependents } from "./query.js";

const fileId = (p: string) => `file:${p}`;
/** Share of a top file's score that a direct neighbour inherits, per link evidence. */
const NEIGHBOUR_SHARE: Partial<Record<Evidence, number>> = { resolved: 0.5, inferred: 0.3 };
/** A bundle file (template, style, spec) follows its component a bit below a resolved neighbour. */
const BUNDLE_SHARE = 0.4;

export interface FileHit {
  path: string;
  score: number;
  /** Symbols that matched, best first. Empty for files found only through a link. */
  symbols: GraphNode[];
  /** Matched through the file name itself rather than a symbol. */
  fileMatch: boolean;
  evidence: Evidence;
  why: string;
}

/**
 * Adds the direct neighbours of the best files, and the Angular bundle of a scoring `.ts`, to the ranking with a share of
 * the score of the file that pulled them in. Before this they were appended after all matches and almost never fit the budget.
 * `resolved` links count 50%, `inferred` 30%, `unresolved` ones are ignored (they point at nothing known).
 */
export function addNeighbours(g: Graph, hits: FileHit[], top = 5): FileHit[] {
  const byPath = new Map(hits.map((h) => [h.path, h]));
  const paths = Object.keys(g.files);
  const pulled = new Map<string, FileHit>();
  const pull = (path: string, score: number, evidence: Evidence, why: string) => {
    if (byPath.has(path)) return;
    const prev = pulled.get(path);
    if (!prev || prev.score < score) pulled.set(path, { path, score, symbols: [], fileMatch: false, evidence, why });
  };
  for (const h of [...hits].sort((a, b) => b.score - a.score).slice(0, top)) {
    for (const e of [...dependencies(g, h.path), ...dependents(g, h.path)]) {
      const share = NEIGHBOUR_SHARE[e.evidence];
      if (share === undefined) continue;
      const other = (e.from === fileId(h.path) ? e.to : e.from);
      if (!other.startsWith("file:")) continue;
      pull(other.slice(5), h.score * share, e.evidence, `linked with ${h.path}`);
    }
    for (const p of componentBundle(paths, h.path)) pull(p, h.score * BUNDLE_SHARE, "inferred", `bundle of ${h.path}`);
  }
  return [...hits, ...pulled.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/** One line per file: `- path [evidence] kind name:line, kind name:line, kind name:line (+2 more)`; at most `maxSymbols` symbols. */
export function renderFileLine(h: FileHit, maxSymbols = 3): string {
  const syms = h.symbols.slice(0, maxSymbols).map((s) => `${s.detail ? s.detail + " " : ""}${s.name}${s.lines ? ":" + s.lines[0] : ""}${s.exported ? "*" : ""}`);
  const more = h.symbols.length - syms.length;
  const body = syms.length ? syms.join(", ") + (more > 0 ? ` (+${more} more)` : "") : h.fileMatch ? "file name matches" : h.why;
  return `- ${h.path} [${h.evidence}] ${body}`;
}
