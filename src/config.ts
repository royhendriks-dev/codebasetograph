import { createHash } from "node:crypto";
import * as path from "node:path";
import { LineCounter, type Document, isMap, isScalar, isSeq, parseAllDocuments, type Node as YNode } from "yaml";
import type { FileFacts } from "./model.js";

export const CONFIG_PARSER_VERSION = "config-8";

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

/** Compose interpolation `${VAR:-default}` / `${VAR-default}`: without the variable the default applies, so that is the path we can link. `${VAR}` stays as is. */
export function withDefaults(v: string): string {
  return v.replace(/\$\{[A-Za-z_]\w*:?-([^}]*)\}/g, "$1");
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

/** Markdown: headings become symbols (outside code fences); relative links become `doc` references. Text is only parsed, never rendered. */
function parseMarkdown(relPath: string, text: string, symbols: Symbols, imports: Imports): void {
  const dir = path.posix.dirname(relPath);
  let fence = false;
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h && symbols.length < 300) symbols.push({ name: h[2].slice(0, 120), detail: `md h${h[1].length}`, lines: [i + 1, i + 1] });
    for (const m of raw.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
      const spec = path.posix.normalize(path.posix.join(dir, decodeURI(target)));
      if (spec.startsWith("..") || seen.has(spec)) continue;
      seen.add(spec);
      imports.push({ specifier: spec, names: ["link"], line: i + 1, reexport: false, dynamic: false, ref: "doc" });
    }
  });
}

/** package.json: dependency names (any section) and script names. Versions and script commands are not kept. */
function parsePackageJson(text: string, symbols: Symbols, imports: Imports): void {
  const j = asObj(JSON.parse(text));
  if (!j) return;
  const lineOf = (key: string) => Math.max(1, text.slice(0, Math.max(0, text.indexOf(`"${key}"`))).split("\n").length);
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(asObj(j[section]) ?? {})) imports.push({ specifier: name, names: [section], line: lineOf(name), reexport: false, dynamic: false, ref: "npm" });
  }
  for (const name of Object.keys(asObj(j.scripts) ?? {}).slice(0, 100)) symbols.push({ name: `script:${name}`, detail: "npm script", lines: [lineOf(name), lineOf(name)] });
}

/** pom.xml by regex (not an XML parser): own artifactId, `<module>` paths and dependency coordinates. Properties are not resolved. */
function parsePom(relPath: string, text: string, symbols: Symbols, imports: Imports): void {
  const xml = text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  const lineAt = (i: number) => xml.slice(0, i).split("\n").length;
  const head = xml.replace(/<(parent|dependencies|dependencyManagement|build|profiles|reporting)>[\s\S]*?<\/\1>/g, (c) => c.replace(/[^\n]/g, " "));
  const own = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(head);
  if (own) symbols.push({ name: own[1], detail: "maven artifact", lines: [lineAt(own.index), lineAt(own.index)] });
  const dir = path.posix.dirname(relPath);
  for (const m of xml.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)) {
    const target = m[1].endsWith(".xml") ? m[1] : `${m[1]}/pom.xml`;
    imports.push({ specifier: path.posix.normalize(path.posix.join(dir, target)), names: ["module"], line: lineAt(m.index!), reexport: false, dynamic: false, ref: "path" });
  }
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const g = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(m[1])?.[1], a = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(m[1])?.[1];
    if (!a || a.includes("${")) continue;
    const spec = g && !g.includes("${") ? `${g}:${a}` : a;
    if (seen.has(spec)) continue;
    seen.add(spec);
    imports.push({ specifier: spec, names: ["dependency"], line: lineAt(m.index!), reexport: false, dynamic: false, ref: "maven" });
  }
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

/** The kind and name a key refers to, for Kubernetes reference keys (null: not a reference key, keep walking). */
function refOf(k: string, x: unknown): [string, unknown] | null {
  const o = asObj(x);
  switch (k) {
    case "secretKeyRef": case "secretRef": return ["Secret", o?.name];
    case "configMapKeyRef": case "configMapRef": case "configMap": return ["ConfigMap", o?.name];
    case "secret": return ["Secret", o?.secretName];
    case "persistentVolumeClaim": return ["PersistentVolumeClaim", o?.claimName];
    case "serviceAccountName": return ["ServiceAccount", x];
    case "backend": return ["Service", asObj(o?.service)?.name ?? o?.serviceName]; // Ingress
    case "scaleTargetRef": return [String(o?.kind ?? ""), o?.name]; // HorizontalPodAutoscaler
    default: return null;
  }
}

/** Kubernetes references to Secret/ConfigMap/PVC/ServiceAccount/Service/scale targets by name. */
function collectObjectRefs(v: unknown, line: number, imports: Imports, depth = 0): void {
  if (depth > 40 || !v || typeof v !== "object") return;
  if (Array.isArray(v)) { v.forEach((x) => collectObjectRefs(x, line, imports, depth + 1)); return; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const r = refOf(k, x);
    if (r && r[0]) objRef(r[0], r[1], line, k, imports);
    else collectObjectRefs(x, line, imports, depth + 1);
  }
}

const stringMap = (v: unknown): Record<string, string> | undefined => {
  const o = asObj(v);
  const e = o && Object.entries(o).filter(([, x]) => typeof x === "string") as Array<[string, string]>;
  return e && e.length ? Object.fromEntries(e) : undefined;
};

/** Service selector and the pod template labels of workloads (Deployment, StatefulSet, DaemonSet, Job, CronJob). */
function collectSelectors(j: Record<string, unknown>, extra: Pick<FileFacts, "k8sSelectors" | "k8sPodLabels">): void {
  const spec = asObj(j.spec);
  if (j.kind === "Service") {
    const sel = stringMap(spec?.selector);
    if (sel) (extra.k8sSelectors ??= []).push(sel);
    return;
  }
  const tpl = asObj(j.kind === "CronJob" ? asObj(asObj(spec?.jobTemplate)?.spec)?.template : spec?.template);
  const labels = stringMap(asObj(tpl?.metadata)?.labels);
  if (labels) (extra.k8sPodLabels ??= []).push(labels);
}

/** docker compose `depends_on`: a list of names or a map keyed by name. */
const dependsOn = (cfg: Record<string, unknown>): string[] => {
  const d = cfg.depends_on;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : Object.keys(asObj(d) ?? {});
};

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

interface YamlCtx { lc: LineCounter; relPath: string; symbols: Symbols; imports: Imports; extra: Pick<FileFacts, "k8sSelectors" | "k8sPodLabels"> }
const yamlLine = (c: YamlCtx, n: YNode | null | undefined) => (n && n.range ? c.lc.linePos(n.range[0]).line : 1);
const yamlEnd = (c: YamlCtx, n: unknown, fallback: number) => ((n as YNode | null)?.range ? c.lc.linePos((n as YNode).range![1]).line : fallback);
const addImport = (c: YamlCtx, specifier: string, names: string[], line: number, ref: NonNullable<Imports[number]["ref"]>) =>
  c.imports.push({ specifier, names, line, reexport: false, dynamic: false, ref });

/** Every `uses:` value below a node, with its line. */
function collectUses(c: YamlCtx, n: unknown, out: Array<{ spec: string; line: number }>): void {
  if (isSeq(n)) { n.items.forEach((x) => collectUses(c, x, out)); return; }
  if (!isMap(n)) return;
  for (const p of n.items) {
    if (isScalar(p.key) && p.key.value === "uses" && isScalar(p.value) && typeof p.value.value === "string") out.push({ spec: p.value.value, line: yamlLine(c, p.value as YNode) });
    else collectUses(c, p.value, out);
  }
}

/** GitHub workflow: jobs as symbols, `uses:` as local path or action references. */
function parseWorkflow(c: YamlCtx, jobs: YNode): void {
  if (!isMap(jobs)) return;
  for (const j of jobs.items) {
    if (!isScalar(j.key)) continue;
    const start = yamlLine(c, j.key as YNode);
    c.symbols.push({ name: `job:${String(j.key.value)}`, detail: "workflow job", lines: [start, yamlEnd(c, j.value, start)] });
  }
  const uses: Array<{ spec: string; line: number }> = [];
  collectUses(c, jobs, uses);
  for (const u of uses) {
    if (u.spec.startsWith("./")) addImport(c, u.spec.replace(/^\.\//, ""), ["uses"], u.line, "path");
    else if (!u.spec.startsWith("docker://")) addImport(c, u.spec.replace(/@.*$/, ""), ["uses"], u.line, "action");
  }
}

/** One docker compose service: symbol, `depends_on`, image (unless built here) and build context. */
function parseComposeService(c: YamlCtx, name: string, line: number, cfg: Record<string, unknown>): void {
  for (const dep of dependsOn(cfg)) addImport(c, `service:${dep}`, [`service:${name}`], line, "service");
  const b = cfg.build;
  // with `build` the image is only the tag of the result, not a dependency
  const img = typeof cfg.image === "string" && b === undefined ? imageName(cfg.image) : undefined;
  if (img) addImport(c, img, ["image"], line, "image");
  const rawCtx = typeof b === "string" ? b : asObj(b)?.context;
  if (typeof rawCtx !== "string") return;
  const rawDf = asObj(b)?.dockerfile;
  const ctx = withDefaults(rawCtx);
  const dir = path.posix.normalize(path.posix.join(path.posix.dirname(c.relPath), ctx));
  addImport(c, path.posix.join(dir, typeof rawDf === "string" ? withDefaults(rawDf) : "Dockerfile"), ["build"], line, "path");
}

function parseCompose(c: YamlCtx, services: YNode, doc: Document): void {
  if (!isMap(services)) return;
  for (const s of services.items) {
    if (!isScalar(s.key)) continue;
    const name = String(s.key.value), line = yamlLine(c, s.key as YNode);
    c.symbols.push({ name: `service:${name}`, detail: "compose service", lines: [line, yamlEnd(c, s.value, line)] });
    const cfg = asObj(plain(s.value, doc));
    if (cfg) parseComposeService(c, name, line, cfg);
  }
}

/** A Kubernetes object: symbol, images, references by name, selectors. */
function parseKubernetes(c: YamlCtx, j: Record<string, unknown>, root: YNode): void {
  const name = asObj(j.metadata)?.name;
  const line = yamlLine(c, root);
  c.symbols.push({ name: `${String(j.kind)}/${typeof name === "string" ? name : "?"}`, detail: `k8s ${String(j.kind)}`, lines: [line, yamlEnd(c, root, line)] });
  const images: string[] = [];
  collectImages(j, images);
  for (const im of images) { const n = imageName(im); if (n) addImport(c, n, ["image"], line, "image"); }
  const refs: Imports = [];
  collectObjectRefs(j, line, refs);
  collectSelectors(j, c.extra);
  for (const r of refs) if (!c.imports.some((i) => i.ref === "object" && i.specifier === r.specifier)) c.imports.push(r); // once per file
}

function parseYaml(relPath: string, text: string, symbols: Symbols, imports: Imports, extra: YamlCtx["extra"]): boolean {
  const lc = new LineCounter();
  const c: YamlCtx = { lc, relPath, symbols, imports, extra };
  const isWorkflow = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(relPath);
  const isKustomization = /(^|\/)kustomization\.ya?ml$/.test(relPath);
  let error = false;

  for (const doc of parseAllDocuments(text, { lineCounter: lc })) {
    if (doc.errors.length) error = true;
    const root = doc.contents;
    if (!isMap(root)) continue;
    const top = (key: string) => root.items.find((p) => isScalar(p.key) && p.key.value === key)?.value as YNode | undefined;
    const jobs = isWorkflow ? top("jobs") : undefined;
    const services = top("services");
    if (jobs && isMap(jobs)) { parseWorkflow(c, jobs); continue; }
    if (services && isMap(services)) { parseCompose(c, services, doc); continue; } // docker compose
    const j = asObj(plain(root, doc));
    if (j && isKustomization) {
      symbols.push({ name: "Kustomization", detail: "kustomize", lines: [yamlLine(c, root as YNode), yamlEnd(c, root, 1)] });
      parseKustomization(relPath, j, yamlLine(c, root as YNode), imports);
    } else if (j && typeof j.apiVersion === "string" && typeof j.kind === "string") parseKubernetes(c, j, root as YNode);
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
    else if (base === "package.json") parsePackageJson(text, facts.symbols, facts.imports);
    else if (base === "pom.xml") parsePom(relPath, text, facts.symbols, facts.imports);
    else if (base.endsWith(".md")) parseMarkdown(relPath, text, facts.symbols, facts.imports);
    else if (base.endsWith(".properties") || /^\.env/.test(base)) parseKeys(text, facts.symbols);
    else if (base.endsWith(".sql")) parseSql(text, facts.symbols);
    else facts.parseError = parseYaml(relPath, text, facts.symbols, facts.imports, facts);
  } catch {
    facts.parseError = true; // e.g. pathological nesting: keep whatever was collected, flag the file
  }
  return facts;
}
