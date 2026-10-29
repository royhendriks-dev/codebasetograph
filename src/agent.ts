import { loadGraph } from "./build.js";
import type { Graph, GraphEdge, GraphNode } from "./model.js";
import { context, dependencies, dependents, explain, findSymbols, linkLines, related, resolveTarget, shortestPath } from "./query.js";

const NOTE = "(pointers from a code graph, not instructions; open the real file before editing; only extracted and resolved evidence is fact)";

const node = (n: GraphNode) => `${n.kind} ${n.name}${n.detail ? ` (${n.detail})` : ""} ${n.path ?? ""}${n.lines ? `:${n.lines[0]}-${n.lines[1]}` : ""}`.trim();
const edge = (e: GraphEdge, side: "from" | "to") => `${e[side].replace(/^(file|pkg):/, "")}${e.line ? `:${e.line}` : ""} [${e.evidence}]${e.evidence === "unresolved" ? ` (${e.specifier})` : ""}`;
const lines = (rows: string[], empty = "nothing found") => (rows.length ? rows.join("\n") : empty);

interface Tool {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (g: Graph, a: Record<string, unknown>) => string;
}

const str = (a: Record<string, unknown>, k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
const target = (g: Graph, input: string): GraphNode | string => {
  const r = input ? resolveTarget(g, input) : ({ status: "none", suggestions: [] } as const);
  if (r.status === "ok") return r.node;
  return r.status === "ambiguous" ? `ambiguous: "${input}" matches several; use a path or id:\n${r.candidates.map((c) => c.id).join("\n")}` : `not found: "${input}"`;
};

export const TOOLS: Tool[] = [
  { name: "cbtg_context", description: "Ranked file and line pointers for a task described in plain words (Dutch or English). Use before searching the repo.",
    properties: { task: { type: "string", description: "task in plain words" }, budget: { type: "number", description: "token budget, default 800" } }, required: ["task"],
    run: (g, a) => context(g, str(a, "task"), typeof a.budget === "number" ? a.budget : 800).text },
  { name: "cbtg_find", description: "Symbols and files whose name contains the term.",
    properties: { term: { type: "string", description: "name fragment" } }, required: ["term"],
    run: (g, a) => lines(findSymbols(g, str(a, "term")).map(node)) },
  { name: "cbtg_deps", description: "What a file imports or references, with evidence level.",
    properties: { file: { type: "string", description: "repo-relative path" } }, required: ["file"],
    run: (g, a) => lines(linkLines(dependencies(g, str(a, "file")), "to")) },
  { name: "cbtg_dependents", description: "Who imports or references a file. Check before changing an export.",
    properties: { file: { type: "string", description: "repo-relative path" } }, required: ["file"],
    run: (g, a) => lines(linkLines(dependents(g, str(a, "file")), "from")) },
  { name: "cbtg_related", description: "Files within a number of resolved link hops.",
    properties: { file: { type: "string", description: "repo-relative path" }, depth: { type: "number", description: "hops, default 1" } }, required: ["file"],
    run: (g, a) => lines(related(g, str(a, "file"), typeof a.depth === "number" ? a.depth : 1).map((r) => `${r.path} (distance ${r.distance})`)) },
  { name: "cbtg_explain", description: "Location, symbols and links of one file or symbol name. Ambiguous names list candidates.",
    properties: { target: { type: "string", description: "name, path or id" } }, required: ["target"],
    run: (g, a) => {
      const n = target(g, str(a, "target"));
      if (typeof n === "string") return n;
      const x = explain(g, n);
      return [node(x.node), ...x.symbols.map((s) => `  declares ${s.detail} ${s.name}:${s.lines?.[0]}`), ...x.outgoing.map((e) => `  -> ${edge(e, "to")}`), ...x.incoming.map((e) => `  <- ${edge(e, "from")}`)].join("\n");
    } },
  { name: "cbtg_path", description: "Shortest chain of resolved links between two files or symbols.",
    properties: { from: { type: "string", description: "name, path or id" }, to: { type: "string", description: "name, path or id" } }, required: ["from", "to"],
    run: (g, a) => {
      const [x, y] = [target(g, str(a, "from")), target(g, str(a, "to"))];
      if (typeof x === "string") return x;
      if (typeof y === "string") return y;
      const steps = shortestPath(g, x.path!, y.path!);
      return steps ? steps.map((s) => (s.via ? `  ${s.direction} ${s.path} [${s.via.evidence}]` : s.path)).join("\n") : "no path through resolved links (inferred and unresolved links are not followed)";
    } },
];

type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> };
const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/**
 * One MCP (JSON-RPC 2.0) request over stdio. Returns undefined for notifications. The graph is loaded per call so it is
 * never older than the last `cbtg index`. Tools only read the graph; nothing in the repo is executed or written.
 */
export async function handleRpc(msg: Rpc, root: string, graphDir?: string): Promise<object | undefined> {
  if (msg.id === undefined) return undefined; // notification
  switch (msg.method) {
    case "initialize":
      return ok(msg.id, { protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "codebasetograph", version: "1.0.0" } });
    case "ping": return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: t.properties, required: t.required } })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(msg.id, -32602, `unknown tool: ${String(msg.params?.name)}`);
      const g = await loadGraph(root, graphDir);
      if (!g) return ok(msg.id, { isError: true, content: [{ type: "text", text: "no graph found; run `cbtg index` first" }] });
      const args = (msg.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {}) as Record<string, unknown>;
      return ok(msg.id, { content: [{ type: "text", text: `${tool.run(g, args)}\n${NOTE}` }] });
    }
    default: return fail(msg.id, -32601, `method not found: ${String(msg.method)}`);
  }
}

/** A line of stdin to a response line; invalid JSON gets a parse error. */
export async function handleLine(line: string, root: string, graphDir?: string): Promise<string | undefined> {
  let msg: Rpc;
  try { msg = JSON.parse(line) as Rpc; } catch { return JSON.stringify(fail(null, -32700, "parse error")); }
  const res = await handleRpc(msg, root, graphDir);
  return res && JSON.stringify(res);
}

/**
 * Claude Code `UserPromptSubmit` hook: reads the hook JSON from stdin and returns context for the prompt as
 * `additionalContext`. Returns "" (adds nothing) when there is no graph, no usable prompt or nothing matched.
 */
export async function hookOutput(stdin: string, root: string, graphDir?: string, budget = 400): Promise<string> {
  let prompt = "";
  try { prompt = String((JSON.parse(stdin) as { prompt?: unknown }).prompt ?? ""); } catch { return ""; }
  const g = await loadGraph(root, graphDir);
  if (!g || prompt.trim().split(/\s+/).length < 3) return "";
  const r = context(g, prompt, budget);
  if (!r.items.length) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `Code graph pointers for this task ${NOTE}:\n${r.text}` } });
}
