#!/usr/bin/env node
import { graphDirOf, indexRepo, loadGraph } from "./build.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { renderHtml } from "./view.js";
import { overview, renderOverviewMarkdown } from "./overview.js";
import { renderGraphHtml, DEFAULT_MAX_NODES } from "./viewGraph.js";
import { watchRepo } from "./watch.js";
import { handleLine, hookOutput } from "./agent.js";
import { createInterface } from "node:readline";
import { loadSynonyms } from "./words.js";
import { loadTasks, renderReport, runBenchmark, runGitBenchmark } from "./bench.js";
import { installAgents, installClaude, installGit, nextSteps, removeAgents, removeClaude, removeGit, type Scope } from "./install.js";
import { fileURLToPath } from "node:url";
import { context, dependencies, dependents, explain, findSymbols, related, resolveTarget, shortestPath } from "./query.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const root = flag("root") ?? process.cwd();
const graphDir = flag("graph-dir");
const positional = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1] ?? "").startsWith("--"));

const usage = `cbtg <command> [--root dir] [--graph-dir dir]   (--graph-dir keeps the graph outside the repo, which then stays untouched)
  index                       build or update .cbtg/graph.json
  watch [--debounce ms]       index once, then re-index after every file change (Ctrl+C to stop)
  find <term>                 symbols and files whose name contains term
  deps <file>                 what <file> imports
  dependents <file>           who imports <file>
  related <file> [--depth n]  files within n import hops
  explain <name|path>         location, symbols and links of one file or symbol (exit 3: ambiguous, 4: not found)
  path <from> <to>            shortest chain of resolved links between two files or symbols
  view [--out file]           write a self-contained HTML explorer (default .cbtg/graph.html)
  view --graph [--max-nodes n] [--out file]   drawn file graph (default .cbtg/graph-map.html, 400 nodes)
  view --overview [--out dir]  folder-level summary without file or symbol names: overview.json and GRAPH.md (Mermaid), default in .cbtg/
  bench <tasks.json> [--files n] [--budget tokens] [--synonyms file.json]   compare grep baseline with graph context on tasks with known relevant files
  bench --from-git [--ref ref] [--tasks n] [--files n] [--budget tokens] [--no-history]   same, with tasks from the git history: each commit is searched in the state before it
  install git [--cbtg-repo url] [--cbtg-ref ref] [--views-branch branch] [--remove]   commit the graph: .gitattributes, AGENTS.md block, GitHub workflow that refreshes it on every PR and the views after every merge to the branch (default main)
  install claude|agents [--scope user|project] [--remove]   install the skill for Claude Code (~/.claude/skills or <root>/.claude/skills), or a marked block in <root>/AGENTS.md for other agents
  mcp                         MCP server over stdio (tools: cbtg_context, cbtg_find, cbtg_deps, cbtg_dependents, cbtg_related, cbtg_explain, cbtg_path)
  hook                        Claude Code UserPromptSubmit hook: reads the hook JSON on stdin, prints task context for the prompt (nothing if there is no graph)
  context "<task>" [--budget tokens] [--synonyms file.json]   pointer list of task-relevant code (Dutch words are mapped to English; the optional file adds your own, {"inloggen":["login"]})`;

async function main() {
  if (cmd === "index") {
    const { stats, graph } = await indexRepo(root, graphDir);
    console.log(`indexed ${stats.files} files (parsed ${stats.parsed}, reused ${stats.reused}, removed ${stats.removed}); ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.skipped.length} skipped`);
    return;
  }
  if (cmd === "install") {
    const target = positional[0];
    const scope = (flag("scope") ?? "user") as Scope;
    if ((target !== "claude" && target !== "agents" && target !== "git") || (scope !== "user" && scope !== "project")) { console.error("usage: cbtg install claude|agents|git [--scope user|project] [--remove] [--cbtg-repo url] [--cbtg-ref ref]"); process.exit(2); }
    const remove = rest.includes("--remove");
    const results = target === "git" ? await (remove ? removeGit(root) : installGit(root, { repo: flag("cbtg-repo"), ref: flag("cbtg-ref"), viewsBranch: flag("views-branch") }))
      : [target === "claude" ? await (remove ? removeClaude : installClaude)(scope, root) : await (remove ? removeAgents : installAgents)(root)];
    for (const r of results) console.log(`${r.target}: ${r.action} ${r.file}`);
    if (!remove && target === "git") console.log("Now run `cbtg index` and commit .cbtg/graph.json, .cbtg/.gitignore, .gitattributes, AGENTS.md and the workflow.");
    if (!remove) console.log(nextSteps(fileURLToPath(import.meta.url)));
    return;
  }
  if (cmd === "watch") {
    const ctl = new AbortController();
    process.once("SIGINT", () => ctl.abort());
    process.once("SIGTERM", () => ctl.abort());
    await watchRepo({ root, graphDir, debounceMs: flag("debounce") ? Number(flag("debounce")) : undefined, signal: ctl.signal, onIndex: (line, ok) => (ok ? console.log : console.error)(line) });
    return;
  }
  if (cmd === "mcp") {
    for await (const line of createInterface({ input: process.stdin })) {
      const out = line.trim() ? await handleLine(line, root, graphDir) : undefined;
      if (out) process.stdout.write(out + "\n");
    }
    return;
  }
  if (cmd === "hook") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const out = await hookOutput(Buffer.concat(chunks).toString("utf8"), root, graphDir).catch(() => "");
    if (out) console.log(out);
    return;
  }
  if (cmd === "bench" && rest.includes("--from-git")) {
    const opts = { maxFiles: Number(flag("files") ?? 5), budget: Number(flag("budget") ?? 800), synonyms: flag("synonyms") ? await loadSynonyms(path.resolve(flag("synonyms")!)) : {},
      ref: flag("ref"), tasks: Number(flag("tasks") ?? 50), history: !rest.includes("--no-history") };
    console.log(renderReport(await runGitBenchmark(root, opts), opts));
    return;
  }
  const g = await loadGraph(root, graphDir);
  if (!g) { console.error("no graph found; run `cbtg index` first"); process.exit(1); }
  const arg = positional[0] ?? "";
  const synonyms = async () => (flag("synonyms") ? loadSynonyms(path.resolve(flag("synonyms")!)) : {});
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
    case "view": {
      if (rest.includes("--overview")) {
        const dir = path.resolve(flag("out") ?? graphDirOf(root, graphDir));
        const o = overview(g);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "overview.json"), JSON.stringify(o, null, 1) + "\n");
        await fs.writeFile(path.join(dir, "GRAPH.md"), renderOverviewMarkdown(o));
        console.log(`wrote ${path.join(dir, "overview.json")} and ${path.join(dir, "GRAPH.md")}`);
        break;
      }
      const map = process.argv.includes("--graph");
      const out = path.resolve(flag("out") ?? path.join(graphDirOf(root, graphDir), map ? "graph-map.html" : "graph.html"));
      const max = Number(flag("max-nodes") ?? DEFAULT_MAX_NODES);
      if (!Number.isInteger(max) || max < 1) { console.error("--max-nodes must be a positive integer"); process.exit(2); }
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, map ? renderGraphHtml(g, max) : renderHtml(g));
      console.log(`wrote ${out}`);
      break;
    }
    case "context": { const r = context(g, arg, Number(flag("budget") ?? 800), await synonyms()); console.log(r.text); if (r.truncated) console.log("(truncated by budget)"); break; }
    case "bench": {
      if (!arg) { console.error("usage: cbtg bench <tasks.json> | cbtg bench --from-git"); process.exit(1); }
      const opts = { maxFiles: Number(flag("files") ?? 5), budget: Number(flag("budget") ?? 800), synonyms: await synonyms() };
      console.log(renderReport(await runBenchmark(path.resolve(root), g, await loadTasks(path.resolve(arg)), opts), opts));
      break;
    }
    default: console.log(usage);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
