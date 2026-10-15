import { createHash } from "node:crypto";
import * as path from "node:path";
import { isMap, LineCounter, parseAllDocuments, type Document } from "yaml";
import type { FileFacts, Ref } from "./model.js";

export const YAML_PARSER_VERSION = "yaml-1";
export const OTHER_PARSER_VERSION = "other-1";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A file that is indexed as a plain file node (no symbols), so references to it can resolve. */
export function parseOther(relPath: string, text: string): FileFacts {
  return { path: relPath, hash: createHash("sha256").update(text).digest("hex"), parseError: false, lang: "other", parser: OTHER_PARSER_VERSION, symbols: [], imports: [] };
}

/** Image reference without tag or digest: `ghcr.io/x/app:1.2` -> `ghcr.io/x/app`. */
const imageName = (s: string) => s.replace(/@.*$/, "").replace(/:[^/:]*$/, "");

/** `actions/checkout@v4` -> `actions/checkout`; `owner/repo/sub@ref` -> `owner/repo`. Local and docker:// uses are handled elsewhere. */
const actionName = (s: string) => s.split("@")[0].split("/").slice(0, 2).join("/");

function pathRef(from: string, target: string, line: number, label: string): Ref {
  const base = path.posix.normalize(from === "" ? target : path.posix.join(from, target));
  return { type: "path", targets: [base, `${base}/action.yml`, `${base}/action.yaml`, `${base}/kustomization.yaml`, `${base}/kustomization.yml`, `${base}/Dockerfile`], line, label };
}

function stepsRefs(steps: unknown[], line: number, out: Ref[]): void {
  for (const s of steps) {
    const uses = isObj(s) ? str(s.uses) : undefined;
    if (!uses || uses.startsWith("docker://")) continue;
    if (uses.startsWith("./")) out.push(pathRef("", uses.slice(2), line, uses));
    else out.push({ type: "package", target: `action:${actionName(uses)}`, line, label: uses });
  }
}

/** Walks a Kubernetes object for pod specs (Pod, Deployment, CronJob, ...) and collects references by name. */
function podSpecRefs(node: unknown, line: number, out: Ref[], depth = 0): void {
  if (depth > 8 || !isObj(node)) return;
  if (Array.isArray(node.containers)) {
    for (const c of [...arr(node.containers), ...arr(node.initContainers)]) {
      if (!isObj(c)) continue;
      const image = str(c.image);
      if (image) out.push({ type: "package", target: `image:${imageName(image)}`, line, label: image });
      for (const e of arr(c.envFrom)) if (isObj(e)) {
        const cm = isObj(e.configMapRef) ? str(e.configMapRef.name) : undefined, sec = isObj(e.secretRef) ? str(e.secretRef.name) : undefined;
        if (cm) out.push({ type: "object", target: `ConfigMap/${cm}`, line });
        if (sec) out.push({ type: "object", target: `Secret/${sec}`, line });
      }
      for (const e of arr(c.env)) {
        const vf = isObj(e) && isObj(e.valueFrom) ? e.valueFrom : undefined;
        const cm = vf && isObj(vf.configMapKeyRef) ? str(vf.configMapKeyRef.name) : undefined, sec = vf && isObj(vf.secretKeyRef) ? str(vf.secretKeyRef.name) : undefined;
        if (cm) out.push({ type: "object", target: `ConfigMap/${cm}`, line });
        if (sec) out.push({ type: "object", target: `Secret/${sec}`, line });
      }
    }
    for (const v of arr(node.volumes)) if (isObj(v)) {
      const cm = isObj(v.configMap) ? str(v.configMap.name) : undefined, sec = isObj(v.secret) ? str(v.secret.secretName) : undefined;
      const pvc = isObj(v.persistentVolumeClaim) ? str(v.persistentVolumeClaim.claimName) : undefined;
      if (cm) out.push({ type: "object", target: `ConfigMap/${cm}`, line });
      if (sec) out.push({ type: "object", target: `Secret/${sec}`, line });
      if (pvc) out.push({ type: "object", target: `PersistentVolumeClaim/${pvc}`, line });
    }
    const sa = str(node.serviceAccountName);
    if (sa) out.push({ type: "object", target: `ServiceAccount/${sa}`, line });
  }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => podSpecRefs(x, line, out, depth + 1)); else podSpecRefs(v, line, out, depth + 1);
  }
}

const stringMap = (v: unknown): Record<string, string> =>
  isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string") as Array<[string, string]>) : {};

/**
 * Parses a YAML file with the `yaml` library (pure parser, no tags executed, alias count capped).
 * Only recognised kinds are indexed: GitHub Actions workflows and actions, Docker Compose, Kubernetes manifests, kustomization.
 * Anything else returns `undefined` so arbitrary YAML data does not add noise nodes.
 */
export function parseYaml(relPath: string, text: string): FileFacts | undefined {
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lc }) as Document.Parsed[];
  const facts: FileFacts = { path: relPath, hash: createHash("sha256").update(text).digest("hex"), parseError: false, lang: "yaml", parser: YAML_PARSER_VERSION, symbols: [], imports: [], refs: [], podLabels: {} };
  const refs = facts.refs!;
  const lineAt = (offset: number) => lc.linePos(offset).line;
  const dir = path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath);
  const base = path.posix.basename(relPath);
  const add = (name: string, detail: string, start: number, end: number) => facts.symbols.push({ name, detail, lines: [lineAt(start), lineAt(Math.max(start, end - 1))], exported: false });
  /** Symbol per entry of a top-level map (`jobs`, `services`); returns each entry's JS value and start line. */
  const entries = (doc: Document.Parsed, key: string, detail: string): Array<[string, unknown, number]> => {
    const node = doc.get(key, true);
    if (!isMap(node)) return [];
    const js = (doc.toJS() as Obj)[key] as Obj;
    return node.items.flatMap((p) => {
      const k = String((p.key as { value?: unknown })?.value ?? ""), kr = (p.key as { range?: number[] } | null)?.range, vr = (p.value as { range?: number[] } | null)?.range;
      if (!k || !kr) return [];
      add(k, detail, kr[0], vr ? vr[1] : kr[1]);
      return [[k, js?.[k], lineAt(kr[0])] as [string, unknown, number]];
    });
  };

  let recognised = false;
  for (const doc of docs) {
    if (doc.errors.length > 0) { facts.parseError = true; continue; }
    const js = doc.toJS({ maxAliasCount: 50 }) as unknown;
    if (!isObj(js)) continue;
    const range = (doc.contents as { range?: number[] } | null)?.range;

    if (/^kustomization\.ya?ml$/.test(base)) {
      recognised = true;
      for (const key of ["resources", "bases", "components"]) for (const r of arr(js[key])) {
        const t = str(r); if (t && !/^[a-z]+:\/\//.test(t) && !t.includes("github.com")) refs.push(pathRef(dir, t, 1, t));
      }
      for (const p of arr(js.patches)) { const t = isObj(p) ? str(p.path) : undefined; if (t) refs.push(pathRef(dir, t, 1, t)); }
      for (const p of arr(js.patchesStrategicMerge)) { const t = str(p); if (t && !t.includes("\n")) refs.push(pathRef(dir, t, 1, t)); }
      continue;
    }
    if (relPath.startsWith(".github/") && isObj(js.jobs)) {
      recognised = true;
      for (const [name, job, line] of entries(doc, "jobs", "job")) {
        if (!isObj(job)) continue;
        const reusable = str(job.uses);
        if (reusable) stepsRefs([{ uses: reusable }], line, refs);
        stepsRefs(arr(job.steps), line, refs);
      }
      continue;
    }
    if (relPath.startsWith(".github/") && isObj(js.runs)) {
      recognised = true;
      add(str(js.name) ?? path.posix.basename(dir), "action", range?.[0] ?? 0, range?.[1] ?? 0);
      stepsRefs(arr(js.runs.steps), 1, refs);
      continue;
    }
    if (/(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(relPath) && isObj(js.services)) {
      recognised = true;
      for (const [name, svc, line] of entries(doc, "services", "service")) {
        if (!isObj(svc)) continue;
        const image = str(svc.image);
        if (image) refs.push({ type: "package", target: `image:${imageName(image)}`, line, label: image });
        const b = svc.build;
        const context = typeof b === "string" ? b : isObj(b) ? str(b.context) ?? "." : undefined;
        if (context !== undefined) {
          const dockerfile = isObj(b) ? str(b.dockerfile) ?? "Dockerfile" : "Dockerfile";
          const ctxDir = path.posix.normalize(dir ? path.posix.join(dir, context) : context);
          refs.push({ type: "path", targets: [path.posix.normalize(ctxDir === "." ? dockerfile : `${ctxDir}/${dockerfile}`)], line, label: `${name} build` });
        }
      }
      continue;
    }
    const kind = str(js.kind), meta = isObj(js.metadata) ? js.metadata : undefined, name = meta ? str(meta.name) : undefined;
    if (str(js.apiVersion) && kind && name) {
      recognised = true;
      const sym = `${kind}/${name}`;
      add(sym, kind, range?.[0] ?? 0, range?.[1] ?? 0);
      const line = facts.symbols[facts.symbols.length - 1].lines![0];
      podSpecRefs(js.spec, line, refs);
      const spec = isObj(js.spec) ? js.spec : {};
      const tpl = isObj(spec.template) && isObj(spec.template.metadata) ? stringMap(spec.template.metadata.labels) : {};
      const podLabels = kind === "Pod" ? stringMap(meta?.labels) : tpl;
      if (Object.keys(podLabels).length) facts.podLabels![sym] = podLabels;
      if (kind === "Service") {
        const selector = stringMap(spec.selector);
        if (Object.keys(selector).length) refs.push({ type: "selector", selector, line, label: `${sym} selector` });
      }
      if (kind === "Ingress") {
        const backends: unknown[] = [spec.defaultBackend, ...arr(spec.rules).flatMap((r) => (isObj(r) && isObj(r.http) ? arr(r.http.paths).map((p) => (isObj(p) ? p.backend : undefined)) : []))];
        for (const b of backends) { const svc = isObj(b) && isObj(b.service) ? str(b.service.name) : undefined; if (svc) refs.push({ type: "object", target: `Service/${svc}`, line }); }
      }
      if (kind === "HorizontalPodAutoscaler" && isObj(spec.scaleTargetRef)) {
        const k = str(spec.scaleTargetRef.kind), n = str(spec.scaleTargetRef.name);
        if (k && n) refs.push({ type: "object", target: `${k}/${n}`, line });
      }
    }
  }
  return recognised ? facts : undefined;
}
