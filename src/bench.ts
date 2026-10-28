import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discover } from "./discover.js";
import { context } from "./query.js";
import { taskWords } from "./words.js";
import type { Graph } from "./model.js";

/** One benchmark task: a natural-language task plus the files a human says are relevant (the ground truth). */
export interface BenchTask { id: string; task: string; relevant: string[] }

export interface ApproachResult {
  /** Files the agent would open under this approach, in order, capped at `maxFiles`. */
  files: string[];
  /** Source lines in those files. */
  lines: number;
  /** Approximate tokens (chars / 4) of everything the agent reads: lookup output plus opened files. */
  tokens: number;
  /** Fraction of ground-truth files among `files`. */
  recall: number;
  /** Fraction of `files` that are ground truth. */
  precision: number;
  /** 1-based position of the first ground-truth file among `files`, 0 when none was found. */
  firstHit: number;
  ms: number;
}

export interface BenchRow { id: string; task: string; baseline: ApproachResult; graph: ApproachResult }
export interface BenchOptions { maxFiles?: number; budget?: number; synonyms?: Record<string, string[]> }

const run = promisify(execFile);
const tokensOf = (text: string) => Math.ceil(text.length / 4);

function score(files: string[], relevant: string[]) {
  const rel = new Set(relevant);
  const hit = files.filter((f) => rel.has(f)).length;
  return { recall: rel.size ? hit / rel.size : 0, precision: files.length ? hit / files.length : 0, firstHit: files.findIndex((f) => rel.has(f)) + 1 };
}

async function measure(root: string, files: string[], lookupText: string, ms: number, relevant: string[]): Promise<ApproachResult> {
  let lines = 0, tokens = tokensOf(lookupText);
  for (const f of files) {
    const text = await fs.readFile(path.join(root, f), "utf8");
    lines += text.split("\n").length;
    tokens += tokensOf(text);
  }
  return { files, lines, tokens, ms, ...score(files, relevant) };
}

/**
 * Conventional baseline: a case-insensitive text search for every task word over the same indexable files
 * (what an agent does with grep), then open the files with the most matches. No graph, no ranking beyond match count.
 */
export async function baselineSearch(root: string, task: string, maxFiles: number, synonyms: Record<string, string[]> = {}): Promise<{ files: string[]; output: string }> {
  const ws = taskWords(task, synonyms); // same word list as the graph side, so the comparison stays like for like
  const { files } = await discover(root);
  const counts: Array<[string, number]> = [];
  const out: string[] = [];
  for (const f of files) {
    const text = (await fs.readFile(path.join(root, f), "utf8")).toLowerCase();
    let n = 0;
    for (const w of ws) n += text.split(w).length - 1;
    if (n > 0) { counts.push([f, n]); out.push(`${f}:${n}`); }
  }
  counts.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { files: counts.slice(0, maxFiles).map(([f]) => f), output: out.join("\n") };
}

/** Runs each task through both approaches with the same file cap, so the comparison is like for like. */
export async function runBenchmark(root: string, g: Graph, tasks: BenchTask[], opts: BenchOptions = {}): Promise<BenchRow[]> {
  const maxFiles = opts.maxFiles ?? 5, budget = opts.budget ?? 800;
  const rows: BenchRow[] = [];
  for (const t of tasks) {
    let t0 = performance.now();
    const b = await baselineSearch(root, t.task, maxFiles, opts.synonyms);
    const baseline = await measure(root, b.files, b.output, performance.now() - t0, t.relevant);
    t0 = performance.now();
    const c = context(g, t.task, budget, opts.synonyms);
    const gms = performance.now() - t0;
    const gfiles = [...new Set(c.shown.map((i) => i.path))].filter((p) => p in g.files).slice(0, maxFiles); // only what the agent sees within the budget
    const graph = await measure(root, gfiles, c.text, gms, t.relevant);
    rows.push({ id: t.id, task: t.task, baseline, graph });
  }
  return rows;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Markdown table plus totals. Reports both sides; it does not assert that either is better. */
export function renderReport(rows: BenchRow[], opts: BenchOptions = {}): string {
  const head = `| task | approach | files | lines | tokens | recall | precision | ms |\n|---|---|---|---|---|---|---|---|`;
  const line = (id: string, name: string, r: ApproachResult) =>
    `| ${id} | ${name} | ${r.files.length} | ${r.lines} | ${r.tokens} | ${pct(r.recall)} | ${pct(r.precision)} | ${r.ms.toFixed(1)} |`;
  const body = rows.flatMap((r) => [line(r.id, "grep baseline", r.baseline), line(r.id, "graph context", r.graph)]);
  const avg = (f: (r: BenchRow) => ApproachResult, k: "lines" | "tokens" | "recall" | "precision") =>
    rows.length ? rows.reduce((s, r) => s + f(r)[k], 0) / rows.length : 0;
  const totals = (name: string, f: (r: BenchRow) => ApproachResult) =>
    `| mean | ${name} | | ${avg(f, "lines").toFixed(0)} | ${avg(f, "tokens").toFixed(0)} | ${pct(avg(f, "recall"))} | ${pct(avg(f, "precision"))} | |`;
  const found = (f: (r: BenchRow) => ApproachResult) => pct(rows.length ? rows.filter((r) => f(r).firstHit > 0).length / rows.length : 0);
  const mrr = (f: (r: BenchRow) => ApproachResult) => (rows.length ? rows.reduce((s, r) => s + (f(r).firstHit ? 1 / f(r).firstHit : 0), 0) / rows.length : 0).toFixed(2);
  return [
    `Benchmark: ${rows.length} task(s), file cap ${opts.maxFiles ?? 5}, graph budget ${opts.budget ?? 800} tokens. Tokens are approximate (chars/4).`,
    "Recall is only as good as the ground truth in the task file. One-time indexing cost is not included.",
    "", head, ...body, totals("grep baseline", (r) => r.baseline), totals("graph context", (r) => r.graph),
    "",
    `At least one relevant file among the opened files: grep baseline ${found((r) => r.baseline)}, graph context ${found((r) => r.graph)}.`,
    `Mean reciprocal rank of the first relevant file (1 = always first): grep baseline ${mrr((r) => r.baseline)}, graph context ${mrr((r) => r.graph)}.`,
  ].join("\n");
}

/** Reads and validates a task file; throws a readable error instead of benchmarking garbage. */
export async function loadTasks(file: string): Promise<BenchTask[]> {
  const data = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  if (!Array.isArray(data)) throw new Error("task file must be a JSON array");
  return data.map((t, i) => {
    const o = t as Partial<BenchTask>;
    if (typeof o.task !== "string" || !Array.isArray(o.relevant) || o.relevant.some((r) => typeof r !== "string") || o.relevant.length === 0)
      throw new Error(`task ${i}: needs "task" (string) and a non-empty "relevant" (array of repo-relative paths)`);
    return { id: typeof o.id === "string" ? o.id : `t${i + 1}`, task: o.task, relevant: o.relevant };
  });
}

// Hooks are disabled and Git LFS files stay pointers: checking out an old commit must not run anything from the repository.
const git = (args: string[], cwd: string) =>
  run("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } }).then((r) => r.stdout);

export interface GitTask extends BenchTask { parent: string }
export interface GitBenchOptions extends BenchOptions { ref?: string; tasks?: number; maxRelevant?: number; /** false: index without commit history, to measure what the history adds. */ history?: boolean }

/** Commits that are not a code task: dependency bumps, releases, version and changelog updates, merges of a branch, bot updates. */
const NOT_A_TASK = /^(chore|build\(deps\)|bump|release|merge (branch|remote|develop|main))(?![a-z])|dependabot|changelog|^v?\d+\.\d+\.\d+$/i;

/** A PR title or commit subject as a task: ticket prefixes (`ABC-12 `, `ABC - `) and a trailing `(#12)` are dropped. */
export function taskTitle(subject: string): string {
  return subject.replace(/^([A-Z][A-Z0-9]+-\d+|[A-Z]{2,10})\s*-?\s+/, "").replace(/\s*\(#\d+\)\s*$/, "").trim();
}

/**
 * Tasks from git history: every commit on the first-parent line of `ref` (a squash-merged or merged pull request, or a
 * direct commit) becomes a task. The task is its title (for a merge commit, the pull request title on its second line),
 * the ground truth the files it modified that already existed before it. Files it added are left out: no search can
 * find a file that does not exist yet. Newest first, at most `limit`.
 */
export async function tasksFromGit(root: string, ref = "HEAD", limit = 50): Promise<Array<GitTask & { commit: string; modified: string[] }>> {
  const log = await git(["log", "--first-parent", "-n", String(limit * 4), "--format=%x01%H%x00%P%x00%s%x00%b", ref], root);
  const out: Array<GitTask & { commit: string; modified: string[] }> = [];
  for (const block of log.split("\x01").slice(1)) {
    const [commit, parents, subject, body = ""] = block.split("\x00");
    const parent = parents.split(" ")[0];
    if (!parent) continue;
    const title = taskTitle(/^Merge pull request /.test(subject) ? (body.split("\n").find((l) => l.trim()) ?? "") : subject);
    if (!title || NOT_A_TASK.test(title) || NOT_A_TASK.test(subject)) continue;
    const modified = (await git(["diff", "--name-only", "--relative", "--no-renames", "--diff-filter=M", parent, commit], root)).split("\n").filter(Boolean);
    if (!modified.length) continue;
    const id = subject.match(/#(\d+)/)?.[1];
    out.push({ id: id ? `PR${id}` : commit.slice(0, 8), task: title, relevant: modified, parent, commit, modified });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Benchmark on the repository's own history, without hindsight: for each task the repository is checked out at the
 * commit before the change (in a temporary git worktree, hooks disabled), indexed there (only the history git shows at
 * that point), and both approaches search that state. Ground truth: modified files that the index knows (at most
 * `maxRelevant`; larger changes are not one task). Tasks run oldest first so indexing stays incremental.
 */
export async function runGitBenchmark(root: string, opts: GitBenchOptions = {}): Promise<BenchRow[]> {
  const { indexRepo } = await import("./build.js");
  root = path.resolve(root);
  const top = (await git(["rev-parse", "--show-toplevel"], root)).trim();
  const sub = path.relative(top, root);
  const tasks = (await tasksFromGit(root, opts.ref ?? "HEAD", opts.tasks ?? 50)).reverse();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-bench-"));
  const tree = path.join(tmp, "tree"), graphDir = path.join(tmp, "graph");
  const rows: BenchRow[] = [];
  try {
    for (const t of tasks) {
      if (rows.length === 0 && !(await fs.stat(tree).catch(() => undefined))) await git(["worktree", "add", "-q", "--detach", tree, t.parent], top);
      else await git(["checkout", "-q", "--detach", t.parent], tree);
      const at = path.join(tree, sub);
      const { graph } = await indexRepo(at, graphDir, { history: opts.history === false ? "off" : "git" });
      // Markdown is left out of the ground truth: in many repositories every change also updates a README or changelog,
      // and those files mention everything, so they would reward plain text search for bookkeeping instead of finding code.
      const relevant = t.relevant.filter((f) => f in graph.files && !f.endsWith(".md"));
      if (!relevant.length || relevant.length > (opts.maxRelevant ?? 12)) continue;
      rows.push(...(await runBenchmark(at, graph, [{ id: t.id, task: t.task, relevant }], opts)));
    }
  } finally {
    await git(["worktree", "remove", "--force", tree], top).catch(() => undefined);
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return rows.reverse();
}
