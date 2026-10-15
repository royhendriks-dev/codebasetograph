import { createHash } from "node:crypto";
import * as path from "node:path";
import { LineCounter, type Document, isMap, isScalar, isSeq, parseAllDocuments, type Node as YNode } from "yaml";
import type { FileFacts } from "./model.js";

export const CONFIG_PARSER_VERSION = "config-5";

type Symbols = FileFacts["symbols"];
type Imports = FileFacts["imports"];

/** Image name without tag/digest. Strings with `${VAR}` interpolation stay as written: the real image is unknown. */
const strip = (image: string) => image.replace(/@sha256:.*$/, "").replace(/:[^/:]+$/, "");

/**
 * Image name for the graph, or undefined when it cannot be known. `${VAR:-default}` uses the default;
 * any other interpolation is skipped instead of becoming a made-up package node.
 */
function imageName(image: string): string | undefined {
  const m = image.match(/^\$\{[A-Za-z_]\w*:?-([^}]+)\}$/);
  const v = m ? m[1] : image;
  return v.includes("${") || v.includes("$(") ? undefined : strip(v);
}

function plain(node: unknown, doc: Document): unknown {
  return node && typeof (node as { toJS?: unknown }).toJS === "function" ? (node as { toJS: (d: Document) => unknown }).toJS(doc) : node;
}
const asObj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** Dockerfile: stages and base images. Plain line parser, never executes anything. */
function parseDockerfile(text: string, symbols: Symbols, imports: Imports): void {
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = raw.match(/^\s*FROM\s+(?:--\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i);
    if (!m) return;
    const line = i + 1;
    if (m[2]) symbols.push({ name: `stage:${m[2]}`, detail: "docker stage", lines: [line, line] });
    // `FROM <earlier stage>` is not an image
    if (!symbols.some((s) => s.name === `stage:${m[1]}`) && m[1] !== "scratch") {
      imports.push({ specifier: strip(m[1]), names: ["FROM"], line, reexport: false, dynamic: false, ref: "image" });
    }
  });
}

/** SQL: CREATE TABLE/INDEX/VIEW/TYPE by regex. Heuristic, not a SQL parser. */
function parseSql(text: string, symbols: Symbols): void {
  const re = /create\s+(?:or\s+replace\s+)?(?:unique\s+)?(table|index|view|type|materialized\s+view)\s+(?:if\s+not\s+exists\s+)?("?[\w.]+"?)/gi;
  for (const m of text.matchAll(re)) {
    const line = text.slice(0, m.index).split("\n").length;
    symbols.push({ name: m[2].replace(/"/g, ""), detail: `sql ${m[1].toLowerCase().replace(/\s+/g, " ")}`, lines: [line, line] });
  }
}

const NGINX_RULES: Array<[RegExp, string]> = [
  [/^add_header\s+([\w-]+)/, "header"],
  [/^location\s+(?:[=~*^]+\s+)?(\S+)/, "location"],
  [/^upstream\s+([^\s;{]+)/, "upstream"],
  [/^server_name\s+([^\s;]+)/, "server_name"],
];

/** nginx `.conf`: server/upstream/location blocks and the headers they set, by line regex. Heuristic, not an nginx parser. */
function parseNginx(text: string, symbols: Symbols): void {
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    for (const [re, label] of NGINX_RULES) {
      const m = re.exec(line);
      if (!m) continue;
      const name = `${label}:${m[1]}`;
      if (!seen.has(name)) { seen.add(name); symbols.push({ name, detail: "nginx", lines: [i + 1, i + 1] }); }
      break;
    }
  });
}

/** `.properties` and `.env.example`: key names only. Values are never read into the graph (they may be secrets). */
function parseKeys(text: string, symbols: Symbols): void {
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = /^\s*(?:export\s+)?([\w.-]{1,200})\s*[=:]/.exec(raw);
    if (!m || /^\s*[#!]/.test(raw) || seen.has(m[1]) || seen.size >= 500) return;
    seen.add(m[1]);
    symbols.push({ name: m[1], detail: "config key", lines: [i + 1, i + 1] });
  });
}

function collectImages(v: unknown, out: string[], depth = 0): void {
  if (depth > 40 || !v || typeof v !== "object") return;
  if (Array.isArray(v)) { v.forEach((x) => collectImages(x, out, depth + 1)); return; }
  for (const [k, x] of Object.entries(v)) {
    if (k === "image" && typeof x === "string") out.push(x);
    else collectImages(x, out, depth + 1);
  }
}

const objRef = (kind: string, name: unknown, line: number, via: string, imports: Imports) => {
  if (typeof name === "string" && name && !name.includes("$")) imports.push({ specifier: `${kind}/${name}`, names: [via], line, reexport: false, dynamic: false, ref: "object" });
};

/** Kubernetes references to Secret/ConfigMap/PVC/ServiceAccount by name (env, envFrom, volumes, serviceAccountName). */
function collectObjectRefs(v: unknown, line: number, imports: Imports, depth = 0): void {
  if (depth > 40 || !v || typeof v !== "object") return;
  if (Array.isArray(v)) { v.forEach((x) => collectObjectRefs(x, line, imports, depth + 1)); return; }
  const o = v as Record<string, unknown>;
  for (const [k, x] of Object.entries(o)) {
    const name = asObj(x)?.name;
    if (k === "secretKeyRef" || k === "secretRef") objRef("Secret", name, line, k, imports);
    else if (k === "configMapKeyRef" || k === "configMapRef") objRef("ConfigMap", name, line, k, imports);
    else if (k === "secret") objRef("Secret", asObj(x)?.secretName, line, k, imports);
    else if (k === "configMap") objRef("ConfigMap", name, line, k, imports);
    else if (k === "persistentVolumeClaim") objRef("PersistentVolumeClaim", asObj(x)?.claimName, line, k, imports);
    else if (k === "serviceAccountName") objRef("ServiceAccount", x, line, k, imports);
    else collectObjectRefs(x, line, imports, depth + 1);
  }
}

/** kustomization.yaml: local resources, bases, components and patch files become path references. Remote URLs are skipped. */
function parseKustomization(relPath: string, j: Record<string, unknown>, line: number, imports: Imports): void {
  const dir = path.posix.dirname(relPath);
  const add = (v: unknown) => {
    if (typeof v !== "string" || v.includes("://") || v.startsWith("git@") || v.includes("$")) return;
    imports.push({ specifier: path.posix.normalize(path.posix.join(dir, v)), names: ["kustomize"], line, reexport: false, dynamic: false, ref: "path" });
  };
  for (const k of ["resources", "bases", "components", "patchesStrategicMerge"]) if (Array.isArray(j[k])) j[k].forEach(add);
  if (Array.isArray(j.patches)) j.patches.forEach((p) => add(asObj(p)?.path));
}

function parseYaml(relPath: string, text: string, symbols: Symbols, imports: Imports): boolean {
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lc });
  const isWorkflow = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(relPath);
  const lineOf = (n: YNode | null | undefined) => (n && n.range ? lc.linePos(n.range[0]).line : 1);
  let error = false;

  for (const doc of docs) {
    if (doc.errors.length) error = true;
    const root = doc.contents;
    if (!isMap(root)) continue;
    const top = (key: string) => root.items.find((p) => isScalar(p.key) && p.key.value === key);

    const jobs = isWorkflow ? top("jobs") : undefined;
    if (jobs && isMap(jobs.value)) {
      for (const j of jobs.value.items) {
        if (!isScalar(j.key)) continue;
        const start = lineOf(j.key as YNode), end = j.value && (j.value as YNode).range ? lc.linePos((j.value as YNode).range![1]).line : start;
        symbols.push({ name: `job:${String(j.key.value)}`, detail: "workflow job", lines: [start, end] });
      }
      const uses: Array<{ spec: string; line: number }> = [];
      const walk = (n: unknown) => {
        if (isMap(n)) for (const p of n.items) {
          if (isScalar(p.key) && p.key.value === "uses" && isScalar(p.value) && typeof p.value.value === "string") uses.push({ spec: p.value.value, line: lineOf(p.value as YNode) });
          else walk(p.value);
        } else if (isSeq(n)) n.items.forEach(walk);
      };
      walk(jobs.value);
      for (const u of uses) {
        if (u.spec.startsWith("./")) imports.push({ specifier: u.spec.replace(/^\.\//, ""), names: ["uses"], line: u.line, reexport: false, dynamic: false, ref: "path" });
        else if (!u.spec.startsWith("docker://")) imports.push({ specifier: u.spec.replace(/@.*$/, ""), names: ["uses"], line: u.line, reexport: false, dynamic: false, ref: "action" });
      }
      continue;
    }

    const services = top("services");
    if (services && isMap(services.value)) { // docker compose
      for (const s of services.value.items) {
        if (!isScalar(s.key)) continue;
        const name = String(s.key.value), line = lineOf(s.key as YNode);
        const end = s.value && (s.value as YNode).range ? lc.linePos((s.value as YNode).range![1]).line : line;
        symbols.push({ name: `service:${name}`, detail: "compose service", lines: [line, end] });
        const cfg = asObj(plain(s.value, doc));
        if (!cfg) continue;
        const b = cfg.build;
        // with `build` the image is only the tag of the result, not a dependency
        const img = typeof cfg.image === "string" && b === undefined ? imageName(cfg.image) : undefined;
        if (img) imports.push({ specifier: img, names: ["image"], line, reexport: false, dynamic: false, ref: "image" });
        const ctx = typeof b === "string" ? b : typeof asObj(b)?.context === "string" ? (asObj(b)!.context as string) : undefined;
        if (ctx !== undefined) {
          const df = typeof asObj(b)?.dockerfile === "string" ? (asObj(b)!.dockerfile as string) : "Dockerfile";
          const dir = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), ctx));
          imports.push({ specifier: path.posix.join(dir, df), names: ["build"], line, reexport: false, dynamic: false, ref: "path" });
        }
      }
      continue;
    }

    const j = asObj(plain(root, doc));
    if (j && /(^|\/)kustomization\.ya?ml$/.test(relPath)) {
      symbols.push({ name: "Kustomization", detail: "kustomize", lines: [lineOf(root as YNode), lc.linePos(root.range![1]).line] });
      parseKustomization(relPath, j, lineOf(root as YNode), imports);
      continue;
    }
    if (j && typeof j.apiVersion === "string" && typeof j.kind === "string") { // kubernetes
      const name = asObj(j.metadata)?.name;
      const line = lineOf(root as YNode);
      symbols.push({ name: `${j.kind}/${typeof name === "string" ? name : "?"}`, detail: `k8s ${j.kind}`, lines: [line, lc.linePos(root.range![1]).line] });
      const images: string[] = [];
      collectImages(j, images);
      for (const im of images) { const n = imageName(im); if (n) imports.push({ specifier: n, names: ["image"], line, reexport: false, dynamic: false, ref: "image" }); }
      const refs: Imports = [];
      collectObjectRefs(j, line, refs);
      for (const r of refs) if (!imports.some((i) => i.ref === "object" && i.specifier === r.specifier)) imports.push(r); // once per file
    }
  }
  return error;
}

/** Parses Dockerfiles, YAML (GitHub workflows, docker compose, Kubernetes) and SQL. Content is only parsed, never executed. */
export function parseConfig(relPath: string, text: string): FileFacts {
  const facts: FileFacts = { path: relPath, hash: createHash("sha256").update(text).digest("hex"), lang: "config", parser: CONFIG_PARSER_VERSION, parseError: false, symbols: [], imports: [] };
  try {
    const base = path.posix.basename(relPath);
    if (/^Dockerfile/.test(base)) parseDockerfile(text, facts.symbols, facts.imports);
    else if (base.endsWith(".conf")) parseNginx(text, facts.symbols);
    else if (base.endsWith(".properties") || /^\.env/.test(base)) parseKeys(text, facts.symbols);
    else if (base.endsWith(".sql")) parseSql(text, facts.symbols);
    else facts.parseError = parseYaml(relPath, text, facts.symbols, facts.imports);
  } catch {
    facts.parseError = true; // e.g. pathological nesting: keep whatever was collected, flag the file
  }
  return facts;
}
