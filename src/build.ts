import { promises as fs } from "node:fs";
import * as path from "node:path";
import { discover } from "./discover.js";
import { parseFile, TS_PARSER_VERSION } from "./parse.js";
import { parseJava, JAVA_PARSER_VERSION } from "./java.js";
import { parseConfig, CONFIG_PARSER_VERSION } from "./config.js";
import { parseAsset, ASSET_PARSER_VERSION } from "./asset.js";
import { aliasFor, loadAliases, type Alias } from "./tsconfig.js";
import type { FileFacts, Graph, GraphEdge, GraphNode } from "./model.js";
import { isTestPath } from "./query.js";

export const GRAPH_DIR = ".cbtg";
export const GRAPH_FILE = "graph.json";

export function languageOf(rel: string): "ts" | "java" | "config" | "asset" {
  if (rel.endsWith(".java")) return "java";
  if (/\.(html|scss|css)$/.test(rel)) return "asset";
  return /\.(ya?ml|sql|conf)$/.test(rel) || /(^|\/)Dockerfile[^/]*$/.test(rel) ? "config" : "ts";
}

const CANDIDATE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function resolveRelative(from: string, spec: string, known: Set<string>): string | undefined {
  return resolveBase(path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)), known);
}

/** Finds the indexed file a path-like import points at (extension and index-file lookup). */
function resolveBase(base: string, known: Set<string>): string | undefined {
  // ESM-style `./x.js` may point at `./x.ts`
  const stripped = base.replace(/\.[cm]?jsx?$/, "");
  const candidates = [base, ...CANDIDATE_EXTS.map((e) => base + e), ...CANDIDATE_EXTS.map((e) => stripped + e),
    ...CANDIDATE_EXTS.map((e) => `${base}/index${e}`)];
  return candidates.find((c) => known.has(c));
}

/** Pure: turns per-file facts into nodes and edges. Always recomputed over all files (cheap, avoids stale cross-file data). */
export function link(files: Record<string, FileFacts>, aliases: Alias[] = []): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const known = new Set(Object.keys(files));
  // Java: fully-qualified type name -> file, and package -> files
  const byFqn = new Map<string, string>();
  const byPackage = new Map<string, string[]>();
  for (const f of Object.values(files)) {
    if (f.lang !== "java") continue;
    const pkg = f.javaPackage ?? "";
    byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), f.path]);
    for (const sym of f.symbols) if (!sym.name.includes(".")) byFqn.set(pkg ? `${pkg}.${sym.name}` : sym.name, f.path);
  }
  // k8s `Kind/name` -> declaring files
  const objectOwners = new Map<string, string[]>();
  for (const f of Object.values(files)) if (f.lang === "config") for (const sym of f.symbols) if (sym.detail?.startsWith("k8s ")) objectOwners.set(sym.name, [...(objectOwners.get(sym.name) ?? []), f.path]);
  const pkgNode = (name: string) => {
    const id = `pkg:${name}`;
    if (!nodes.has(id)) nodes.set(id, { id, kind: "package", name });
    return id;
  };
  for (const f of Object.values(files).sort((a, b) => a.path.localeCompare(b.path))) {
    const fileId = `file:${f.path}`;
    nodes.set(fileId, { id: fileId, kind: "file", name: path.posix.basename(f.path), path: f.path });
    for (const s of f.symbols) {
      const id = `sym:${f.path}#${s.name}`;
      if (!nodes.has(id)) nodes.set(id, { id, kind: "symbol", path: f.path, ...s });
      edges.push({ from: fileId, to: id, kind: "declares", evidence: "extracted", line: s.lines?.[0] });
    }
    if (f.lang === "config") {
      for (const imp of f.imports) {
        const base = { from: fileId, specifier: imp.specifier, line: imp.line, kind: "references" as const };
        if (imp.ref === "path") {
          // a kustomize resource may be a directory: its kustomization file is the target
          const hit = [imp.specifier, `${imp.specifier}/kustomization.yaml`, `${imp.specifier}/kustomization.yml`].find((c) => known.has(c));
          edges.push({ ...base, to: `file:${hit ?? imp.specifier}`, evidence: hit ? "resolved" : "unresolved" });
        } else if (imp.ref === "object") {
          // Kind/name declared in exactly one other indexed file. Namespace is not checked, so only "inferred".
          const owners = objectOwners.get(imp.specifier)?.filter((p) => p !== f.path) ?? [];
          if (owners.length === 1) edges.push({ ...base, to: `file:${owners[0]}`, evidence: "inferred" });
          else if (owners.length === 0 && !objectOwners.get(imp.specifier)) edges.push({ ...base, to: pkgNode(`k8s:${imp.specifier}`), evidence: "unresolved" });
        } else {
          edges.push({ ...base, to: pkgNode(`${imp.ref}:${imp.specifier}`), evidence: "inferred" });
        }
      }
      continue;
    }
    if (f.lang === "java") {
      for (const imp of f.imports) {
        const base = { from: fileId, specifier: imp.specifier, line: imp.line };
        if (imp.names[0] === "extends" && !imp.specifier.includes(".")) {
          // supertype by simple name: explicit import first, then same package. Unknown (JDK/external) => no edge, not a guess.
          const viaImport = f.imports.find((i) => !i.wildcard && i.names[0] !== "extends" && i.specifier.endsWith("." + imp.specifier));
          const target = (viaImport && byFqn.get(viaImport.specifier)) ?? byFqn.get(`${f.javaPackage ? f.javaPackage + "." : ""}${imp.specifier}`);
          if (target && target !== f.path) edges.push({ ...base, to: `file:${target}`, kind: "extends", evidence: "resolved" });
          continue;
        }
        if (imp.wildcard) {
          const members = byPackage.get(imp.specifier);
          if (members) for (const m of members) edges.push({ ...base, to: `file:${m}`, kind: "imports", evidence: "inferred" });
          else edges.push({ ...base, to: pkgNode(imp.specifier), kind: "imports", evidence: "inferred" });
          continue;
        }
        // exact type, or a static import of a member (strip the member to find the type)
        const typeFqn = byFqn.has(imp.specifier) ? imp.specifier : imp.specifier.split(".").slice(0, -1).join(".");
        const target = byFqn.get(typeFqn);
        if (target) edges.push({ ...base, to: `file:${target}`, kind: "imports", evidence: "resolved" });
        else edges.push({ ...base, to: pkgNode(imp.specifier.split(".").slice(0, -1).join(".") || imp.specifier), kind: "imports", evidence: "inferred" });
      }
      // same-package use needs no import: link referenced type names that match a type in the package (inferred)
      const linked = new Set(edges.filter((e) => e.from === fileId).map((e) => e.to));
      const prefix = f.javaPackage ? `${f.javaPackage}.` : "";
      for (const name of f.javaTypes ?? []) {
        const target = byFqn.get(`${prefix}${name}`);
        if (!target || target === f.path || linked.has(`file:${target}`)) continue;
        linked.add(`file:${target}`);
        edges.push({ from: fileId, to: `file:${target}`, kind: "references", evidence: "inferred", specifier: name });
      }
      continue;
    }
    for (const imp of f.imports) {
      const kind = imp.ref === "path" ? "references" : imp.reexport ? "reexports" : "imports";
      const alias = !imp.specifier.startsWith(".") ? resolveAlias(aliasFor(aliases, f.path), imp.specifier, known) : undefined;
      if (alias) {
        edges.push({ from: fileId, to: `file:${alias.target ?? alias.attempted}`, kind, evidence: alias.target ? "resolved" : "unresolved", specifier: imp.specifier, line: imp.line });
      } else if (imp.specifier.startsWith(".")) {
        const target = resolveRelative(f.path, imp.specifier, known);
        edges.push({ from: fileId, to: target ? `file:${target}` : `file:${path.posix.join(path.posix.dirname(f.path), imp.specifier)}`,
          kind, evidence: target ? "resolved" : "unresolved", specifier: imp.specifier, line: imp.line });
      } else {
        // Bare specifier: assumed external package. No tsconfig alias matched, so this is only "inferred".
        const m = imp.specifier.match(/^(@[^/]+\/[^/]+|[^/]+)/);
        const name = m ? m[1] : imp.specifier;
        const id = `pkg:${name.replace(/^node:/, "")}`;
        if (!nodes.has(id)) nodes.set(id, { id, kind: "package", name });
        edges.push({ from: fileId, to: id, kind, evidence: "inferred", specifier: imp.specifier, line: imp.line });
      }
    }
  }
  linkSelectors(files, edges);
  linkRoutes(files, edges);
  linkTests(files, edges);
  return { nodes: [...nodes.values()], edges };
}

/** `paths` / `baseUrl` lookup. Returns undefined when the specifier is not an alias at all (so it stays a package). */
function resolveAlias(alias: Alias | undefined, spec: string, known: Set<string>): { target?: string; attempted: string } | undefined {
  if (!alias) return undefined;
  for (const r of alias.rules) {
    const hit = r.star ? spec.length >= r.prefix.length + r.suffix.length && spec.startsWith(r.prefix) && spec.endsWith(r.suffix) : spec === r.prefix;
    if (!hit) continue;
    const captured = r.star ? spec.slice(r.prefix.length, spec.length - r.suffix.length) : "";
    let first = "";
    for (const t of r.targets) {
      const base = path.posix.normalize(path.posix.join(alias.pathsBase, t.replace("*", captured)));
      first ||= base;
      const target = resolveBase(base, known);
      if (target) return { target, attempted: base };
    }
    return { attempted: first || spec };
  }
  if (alias.baseDir !== undefined) {
    const base = path.posix.normalize(path.posix.join(alias.baseDir, spec));
    const target = resolveBase(base, known);
    if (target) return { target, attempted: base };
  }
  return undefined;
}

/**
 * Angular: a custom element used in a template points at the component whose `selector` is exactly that tag.
 * Only unique selectors are linked, and the evidence is `inferred`: the template may use a tag from a library,
 * and whether the component is actually imported into the declaring module/component is not checked.
 */
function linkSelectors(files: Record<string, FileFacts>, edges: GraphEdge[]): void {
  const owners = new Map<string, string[]>();
  for (const f of Object.values(files)) for (const sel of f.selectors ?? []) owners.set(sel, [...(owners.get(sel) ?? []), f.path]);
  for (const f of Object.values(files)) {
    for (const el of f.elements ?? []) {
      const o = owners.get(el);
      if (o?.length === 1 && o[0] !== f.path) edges.push({ from: `file:${f.path}`, to: `file:${o[0]}`, kind: "references", evidence: "inferred", specifier: `<${el}>` });
    }
  }
}

const routeParts = (r: string) => r.split("/").filter(Boolean).map((p) => (p.startsWith("{") ? "{}" : p));

/**
 * Client to backend: a URL-like literal in a TS file and a JAX-RS route in a Java file point at each other when their
 * path segments agree (`{x}` matches any one segment) up to the shorter of the two, over at least two segments. The
 * shorter side is a prefix because a client often keeps only the base ("/api/auth") and appends the rest. Evidence is
 * `inferred`: a string that looks like a route is not proof that it is called.
 */
function linkRoutes(files: Record<string, FileFacts>, edges: GraphEdge[]): void {
  const backend = Object.values(files).filter((f) => f.routes?.length);
  if (!backend.length) return;
  const seen = new Set<string>();
  for (const f of Object.values(files)) {
    for (const url of f.urls ?? []) {
      const u = routeParts(url);
      // a `{param}` segment may swallow a literal one ('/api/auth' fits '/api/{game}/x'), so keep only the best exact fits
      const hits: Array<{ path: string; exact: number }> = [];
      for (const b of backend) {
        let best = -1;
        for (const r of b.routes!) {
          const rp = routeParts(r), n = Math.min(u.length, rp.length);
          if (n < 2 || !u.slice(0, n).every((seg, i) => seg === rp[i] || seg === "{}" || rp[i] === "{}")) continue;
          best = Math.max(best, u.slice(0, n).filter((seg, i) => seg === rp[i]).length);
        }
        if (best >= 0) hits.push({ path: b.path, exact: best });
      }
      const top = Math.max(0, ...hits.map((h) => h.exact));
      for (const h of hits) {
        const key = `${f.path}>${h.path}`;
        if (h.exact === top && !seen.has(key)) { seen.add(key); edges.push({ from: `file:${f.path}`, to: `file:${h.path}`, kind: "references", evidence: "inferred", specifier: url }); }
      }
    }
  }
}

/**
 * Test files by naming convention: `foo.spec.ts` / `foo.test.ts` next to `foo.ts`, `FooTest.java` (also Tests, IT) for the
 * unique `Foo.java`. Convention, not proof, so the evidence is `inferred`; skipped when the test already imports its subject.
 */
function linkTests(files: Record<string, FileFacts>, edges: GraphEdge[]): void {
  const known = new Set(Object.keys(files));
  const javaByName = new Map<string, string[]>();
  for (const p of known) if (p.endsWith(".java") && !isTestPath(p)) javaByName.set(path.posix.basename(p, ".java"), [...(javaByName.get(path.posix.basename(p, ".java")) ?? []), p]);
  const linked = new Set(edges.map((e) => `${e.from}>${e.to}`));
  for (const t of known) {
    let subject: string | undefined;
    const ts = t.match(/^(.*)\.(?:spec|test)\.([cm]?[jt]sx?)$/);
    if (ts) subject = [`${ts[1]}.${ts[2]}`, `${ts[1]}.ts`, `${ts[1]}.tsx`].find((c) => known.has(c) && c !== t);
    else if (t.endsWith(".java")) {
      const m = path.posix.basename(t, ".java").match(/^(.+?)(?:Tests?|IT)$/);
      const c = m ? javaByName.get(m[1]) : undefined;
      if (c?.length === 1) subject = c[0];
    }
    if (!subject || linked.has(`file:${t}>file:${subject}`)) continue;
    edges.push({ from: `file:${t}`, to: `file:${subject}`, kind: "references", evidence: "inferred", specifier: "test of" });
  }
}

export interface IndexStats { parsed: number; reused: number; removed: number; files: number }

/** Where the graph lives: `graphDir` when given (so a read-only repo is never written to), else `<root>/.cbtg`. */
export const graphDirOf = (root: string, graphDir?: string) => path.resolve(graphDir ?? path.join(root, GRAPH_DIR));

/** Indexes `root`. Re-parses only files whose content hash changed; links are always rebuilt. */
export async function indexRepo(root: string, graphDir?: string): Promise<{ graph: Graph; stats: IndexStats }> {
  root = path.resolve(root);
  const previous = await loadGraph(root, graphDir);
  const { files: found, configs, skipped } = await discover(root);
  const aliases = await loadAliases(root, configs);
  const files: Record<string, FileFacts> = {};
  let parsed = 0, reused = 0;
  for (const rel of found) {
    let text: string;
    try { text = await fs.readFile(path.join(root, rel), "utf8"); }
    catch { skipped.push({ path: rel, reason: "unreadable" }); continue; }
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(text).digest("hex");
    const prev = previous?.files[rel];
    const kind = languageOf(rel);
    const parserVersion = { ts: TS_PARSER_VERSION, java: JAVA_PARSER_VERSION, config: CONFIG_PARSER_VERSION, asset: ASSET_PARSER_VERSION }[kind];
    if (prev && prev.hash === hash && prev.parser === parserVersion) { files[rel] = prev; reused++; }
    else { files[rel] = kind === "java" ? await parseJava(rel, text) : kind === "config" ? parseConfig(rel, text) : kind === "asset" ? parseAsset(rel, text) : parseFile(rel, text); parsed++; }
  }
  const removed = previous ? Object.keys(previous.files).filter((p) => !(p in files)).length : 0;
  const graph: Graph = { version: 1, root: path.basename(root), files, aliases, ...link(files, aliases), skipped };
  const dir = graphDirOf(root, graphDir);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, GRAPH_FILE + ".tmp");
  await fs.writeFile(tmp, JSON.stringify(graph));
  await fs.rename(tmp, path.join(dir, GRAPH_FILE)); // atomic replace: a crash never leaves a half-written graph
  return { graph, stats: { parsed, reused, removed, files: found.length } };
}

export async function loadGraph(root: string, graphDir?: string): Promise<Graph | undefined> {
  try {
    const g = JSON.parse(await fs.readFile(path.join(graphDirOf(root, graphDir), GRAPH_FILE), "utf8")) as Graph;
    return g.version === 1 ? g : undefined; // unknown/corrupt version => full rebuild
  } catch { return undefined; }
}
