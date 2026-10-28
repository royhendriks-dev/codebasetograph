import type { Graph } from "./model.js";
import { isTestPath, nameTokens, sharesStem } from "./query.js";

/** Most identifier words kept per file, so the graph stays small; the most frequent words win. */
export const MAX_IDENT_WORDS = 150;

/**
 * Turns identifier names (variables, functions, properties, parameters) into the distinct lower-case words kept on a file.
 * Only names go in, never string literals or comments, so the graph still holds no file contents.
 */
export function identWords(names: Iterable<string>): string[] {
  const count = new Map<string, number>();
  for (const name of names) for (const t of nameTokens(name)) if (t.length >= 3 && !/^\d+$/.test(t)) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_IDENT_WORDS).map(([w]) => w).sort((a, b) => a.localeCompare(b));
}

/**
 * Extra ranking by identifier words: a file scores for every task word that equals or shares a stem with one of its identifier
 * words, weighted by how rare that word is across files (inverse document frequency). Test files score x0.3, as in `scoreNode`.
 * Returns the paths with a score above 0, best first.
 */
export function rankByIdents(g: Graph, words: string[]): Array<{ path: string; score: number }> {
  const files = Object.values(g.files).filter((f) => f.idents?.length);
  if (!files.length || !words.length) return [];
  const hits = new Map<string, Set<string>>(words.map((w) => [w, new Set<string>()]));
  for (const f of files) for (const w of words) if (f.idents!.some((t) => t === w || sharesStem(t, w))) hits.get(w)!.add(f.path);
  const total = Math.max(files.length, 2);
  const out: Array<{ path: string; score: number }> = [];
  for (const f of files) {
    let score = 0;
    for (const w of words) {
      const df = hits.get(w)!.size;
      if (hits.get(w)!.has(f.path)) score += Math.max(0.2, Math.log(total / df) / Math.log(total));
    }
    if (score > 0) out.push({ path: f.path, score: isTestPath(f.path) ? score * 0.3 : score });
  }
  return out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}
