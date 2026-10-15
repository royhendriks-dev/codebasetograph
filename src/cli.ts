#!/usr/bin/env node
import { indexRepo, loadGraph } from "./build.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { renderHtml } from "./view.js";
import { loadTasks, renderReport, runBenchmark } from "./bench.js";
import { context, dependencies, dependents, explain, findSymbols, related, resolveTarget, shortestPath } from "./query.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const root = flag("root") ?? process.cwd();
const positional = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1] ?? "").startsWith("--"));

const usage = `cbtg <command> [--root dir]
  index                       build or update .cbtg/graph.json
  find <term>                 symbols and files whose name contains term
  deps <file>                 what <file> imports
  dependents <file>           who imports <file>
  related <file> [--depth n]  files within n import hops
  explain <name|path>         location, symbols and links of one file or symbol (exit 3: ambiguous, 4: not found)
  path <from> <to>            shortest chain of resolved links between two files or symbols
  view [--out file]           write a self-contained HTML explorer (default .cbtg/graph.html)
  bench <tasks.json> [--files n] [--budget tokens]   compare grep baseline with graph context on tasks with known relevant files
  context "<task>" [--budget tokens]   pointer list of task-relevant code`;

async function main() {
  if (cmd === "index") {
    const { stats, graph } = await indexRepo(root);
    console.log(`indexed ${stats.files} files (parsed ${stats.parsed}, reused ${stats.reused}, removed ${stats.removed}); ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.skipped.length} skipped`);
    return;
  }
  const g = await loadGraph(root);
  if (!g) { console.error("no graph found; run `cbtg index` first"); process.exit(1); }
  const arg = positional[0] ?? "";
  const fmt = (e: { from: string; to: string; evidence: string; line?: number; specifier?: string }, side: "from" | "to") =>
    `${e[side].replace(/^(file|pkg):/, "")}${e.line ? `:${e.line}` : ""} [${e.evidence}]${e.evidence === "unresolved" ? ` (${e.specifier})` : ""}`;
  switch (cmd) {
    case "find": for (const n of findSymbols(g, arg)) console.log(`${n.kind} ${n.name}${n.detail ? ` (${n.detail})` : ""} ${n.path}${n.lines ? `:${n.lines[0]}-${n.lines[1]}` : ""}`); break;
    case "deps": for (const e of dependencies(g, arg)) console.log(fmt(e, "to")); break;
    case "dependents": for (const e of dependents(g, arg)) console.log(fmt(e, "from")); break;
    case "related": for (const r of related(g, arg, Number(flag("depth") ?? 1))) console.log(`${r.path} (distance ${r.distance})`); break;
    case "explain": case "path": {
      const inputs = cmd === "path" ? [positional[0], positional[1]] : [arg];
      const nodes = [];
      for (const input of inputs) {
        const r = input ? resolveTarget(g, input) : ({ status: "none", suggestions: [] } as const);
        if (r.status === "ambiguous") { console.error(`ambiguous: "${input}" matches several; use a path or id`); for (const c of r.candidates) console.error(`  ${c.id}`); process.exit(3); }
        if (r.status === "none") { console.error(`not found: "${input ?? ""}"`); for (const c of r.suggestions) console.error(`  did you mean ${c.id}?`); process.exit(4); }
        nodes.push(r.node);
      }
      if (cmd === "explain") {
        const x = explain(g, nodes[0]);
        console.log(`${x.node.kind} ${x.node.name}${x.node.detail ? ` (${x.node.detail})` : ""} ${x.node.path}${x.node.lines ? `:${x.node.lines[0]}-${x.node.lines[1]}` : ""}`);
        for (const s of x.symbols) console.log(`  declares ${s.detail} ${s.name}:${s.lines?.[0]}`);
        for (const e of x.outgoing) console.log(`  -> ${fmt(e, "to")}`);
        for (const e of x.incoming) console.log(`  <- ${fmt(e, "from")}`);
      } else {
        const steps = shortestPath(g, nodes[0].path!, nodes[1].path!);
        if (!steps) { console.log("no path through resolved links (inferred and unresolved links are not followed)"); process.exit(4); }
        for (const st of steps) console.log(st.via ? `  ${st.direction} ${st.path}:${st.via.line ?? ""} [${st.via.evidence}]` : steps[0] === st ? st.path : `  ${st.path}`);
      }
      break;
    }
    case "view": { const out = path.resolve(flag("out") ?? path.join(root, ".cbtg", "graph.html")); await fs.mkdir(path.dirname(out), { recursive: true }); await fs.writeFile(out, renderHtml(g)); console.log(`wrote ${out}`); break; }
    case "context": { const r = context(g, arg, Number(flag("budget") ?? 800)); console.log(r.text); if (r.truncated) console.log("(truncated by budget)"); break; }
    case "bench": {
      if (!arg) { console.error("usage: cbtg bench <tasks.json>"); process.exit(1); }
      const opts = { maxFiles: Number(flag("files") ?? 5), budget: Number(flag("budget") ?? 800) };
      console.log(renderReport(await runBenchmark(path.resolve(root), g, await loadTasks(path.resolve(arg)), opts), opts));
      break;
    }
    default: console.log(usage);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
