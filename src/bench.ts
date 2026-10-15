import { promises as fs } from "node:fs";
import * as path from "node:path";
import { discover } from "./discover.js";
import { context } from "./query.js";
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
  ms: number;
}

export interface BenchRow { id: string; task: string; baseline: ApproachResult; graph: ApproachResult }
export interface BenchOptions { maxFiles?: number; budget?: number }

const STOP = new Set(["the", "and", "for", "how", "what", "where", "with", "from", "that", "this", "een", "het", "van", "voor", "met", "hoe"]);
const words = (task: string) => [...new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
const tokensOf = (text: string) => Math.ceil(text.length / 4);

function score(files: string[], relevant: string[]) {
  const rel = new Set(relevant);
  const hit = files.filter((f) => rel.has(f)).length;
  return { recall: rel.size ? hit / rel.size : 0, precision: files.length ? hit / files.length : 0 };
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
export async function baselineSearch(root: string, task: string, maxFiles: number): Promise<{ files: string[]; output: string }> {
  const ws = words(task);
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
    const b = await baselineSearch(root, t.task, maxFiles);
    const baseline = await measure(root, b.files, b.output, performance.now() - t0, t.relevant);
    t0 = performance.now();
    const c = context(g, t.task, budget);
    const gms = performance.now() - t0;
    const gfiles = [...new Set(c.items.map((i) => i.path))].filter((p) => p in g.files).slice(0, maxFiles);
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
  return [
    `Benchmark: ${rows.length} task(s), file cap ${opts.maxFiles ?? 5}, graph budget ${opts.budget ?? 800} tokens. Tokens are approximate (chars/4).`,
    "Recall is only as good as the ground truth in the task file. One-time indexing cost is not included.",
    "", head, ...body, totals("grep baseline", (r) => r.baseline), totals("graph context", (r) => r.graph),
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
