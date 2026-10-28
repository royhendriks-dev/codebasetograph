import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Graph, HistoryCommit } from "./model.js";
import { STOPWORDS } from "./words.js";

const run = promisify(execFile);

/** Newest commits kept in the graph. Older work says less about where today's code lives, and the graph stays small. */
export const MAX_COMMITS = 2000;
/** Commits that touch more indexed files than this are bulk changes (formatting, renames, data dumps) and say little about one task. */
export const MAX_FILES_PER_COMMIT = 100;
const MAX_WORDS_PER_COMMIT = 40;
const TRAILER = /^(signed-off-by|co-authored-by|reviewed-by|acked-by|claude-session|change-id|cc):/i;

/**
 * Words of a commit message that can match a task: lower-cased, at least 3 characters, no stop words, no pure numbers or
 * hashes, no trailer lines (`Signed-off-by:`, `Co-Authored-By:`) and no URLs. Only these words are stored, never the message.
 */
export function messageWords(message: string): string[] {
  const body = message.split("\n").filter((l) => !TRAILER.test(l.trim())).join("\n").replace(/https?:\/\/\S+/g, " ");
  const out = new Set<string>();
  for (const w of body.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w) || /^(?=.*\d)[0-9a-f]{7,}$/.test(w)) continue;
    out.add(w);
    if (out.size >= MAX_WORDS_PER_COMMIT) break;
  }
  return [...out];
}

/**
 * Reads the commit history of the work tree at `root` with `git log` (read-only; no hooks run for `log`). Paths are relative
 * to `root` (`--relative`), so a graph of a sub-folder of a repository only sees its own files. Merges are skipped: their
 * files are already listed on the commits they bring in. Returns [] when `root` is not a git work tree or git is missing.
 */
export async function readGitHistory(root: string, max = MAX_COMMITS): Promise<Array<HistoryCommit & { allFiles: string[] }>> {
  let stdout: string;
  try {
    ({ stdout } = await run("git", ["-C", root, "log", "--no-merges", "--relative", "--name-only", "--no-ext-diff", "-n", String(max), "--format=%x01%H%x00%ct%x00%B%x00"],
      { maxBuffer: 256 * 1024 * 1024 }));
  } catch { return []; }
  const commits: Array<HistoryCommit & { allFiles: string[] }> = [];
  for (const block of stdout.split("\x01").slice(1)) {
    const [hash, time, message, rest = ""] = block.split("\x00");
    const allFiles = rest.split("\n").map((f) => f.trim()).filter(Boolean);
    commits.push({ id: hash.slice(0, 12), time: Number(time), words: messageWords(message), files: allFiles, allFiles });
  }
  return commits;
}

/**
 * The history stored in the graph: per commit only its words and the indexed files it touched. Commits that touch no
 * indexed file (for example a bot commit that only updates `.cbtg/graph.json`) are dropped, so committing the graph never
 * changes the history it was built from. `previous` commits (from the last graph) are kept when git no longer shows them,
 * so a shallow clone, as in CI, does not throw away history that a full clone recorded earlier.
 */
export function historyForGraph(found: Array<HistoryCommit>, files: Graph["files"], previous: HistoryCommit[] = []): HistoryCommit[] {
  const byId = new Map<string, HistoryCommit>();
  for (const c of [...found, ...previous]) {
    const kept = c.files.filter((f) => f in files);
    if (byId.has(c.id) || !kept.length || kept.length > MAX_FILES_PER_COMMIT || !c.words.length) continue;
    byId.set(c.id, { id: c.id, time: c.time, words: c.words, files: kept.sort() });
  }
  // Stable sort: commits with the same time keep git's order (newest first).
  return [...byId.values()].sort((a, b) => b.time - a.time).slice(0, MAX_COMMITS);
}
