import type { FileFacts, GraphEdge, GraphNode } from "./model.js";

/**
 * Pure: turns the `refs` of config files into edges. Kept apart from `link` (code imports) so each stays small.
 * - path: first candidate that is an indexed file is `resolved`; a candidate that exists but is not indexed adds no edge;
 *   otherwise `unresolved`.
 * - object (`Kind/name`): one defining file is `resolved`, several (same name in different namespaces or overlays) are `inferred`,
 *   none is `unresolved` (it may be created elsewhere, e.g. by Helm).
 * - selector: workloads whose pod labels contain every selector pair are `resolved`; no match adds no edge.
 * - package: external GitHub Action or container image, `inferred`.
 */
export function linkRefs(files: Record<string, FileFacts>, present: Set<string> = new Set()): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const known = new Set(Object.keys(files));
  const objects = new Map<string, string[]>();
  const workloads: Array<{ path: string; labels: Record<string, string> }> = [];
  for (const f of Object.values(files)) {
    if (f.lang !== "yaml") continue;
    for (const s of f.symbols) objects.set(s.name, [...(objects.get(s.name) ?? []), f.path]);
    for (const labels of Object.values(f.podLabels ?? {})) workloads.push({ path: f.path, labels });
  }
  for (const f of Object.values(files).sort((a, b) => a.path.localeCompare(b.path))) {
    for (const r of f.refs ?? []) {
      const from = `file:${f.path}`;
      const base = { from, kind: "references" as const, line: r.line, specifier: r.label ?? r.target };
      if (r.type === "path") {
        const hit = (r.targets ?? []).find((t) => known.has(t));
        if (hit) { if (hit !== f.path) edges.push({ ...base, to: `file:${hit}`, evidence: "resolved" }); }
        else if (!(r.targets ?? []).some((t) => present.has(t))) edges.push({ ...base, to: `file:${r.targets?.[0]}`, evidence: "unresolved" });
      } else if (r.type === "object") {
        const defs = [...new Set(objects.get(r.target!) ?? [])].filter((p) => p !== f.path);
        if (defs.length === 0 && !(objects.get(r.target!) ?? []).includes(f.path)) {
          const id = `pkg:k8s:${r.target}`;
          nodes.set(id, { id, kind: "package", name: `k8s:${r.target}` });
          edges.push({ ...base, to: id, evidence: "unresolved" });
        }
        for (const d of defs) edges.push({ ...base, to: `file:${d}`, evidence: defs.length === 1 ? "resolved" : "inferred" });
      } else if (r.type === "selector") {
        const sel = Object.entries(r.selector ?? {});
        const hits = new Set(workloads.filter((w) => w.path !== f.path && sel.every(([k, v]) => w.labels[k] === v)).map((w) => w.path));
        for (const h of hits) edges.push({ ...base, to: `file:${h}`, evidence: "resolved" });
      } else {
        const id = `pkg:${r.target}`;
        nodes.set(id, { id, kind: "package", name: r.target! });
        edges.push({ ...base, to: id, evidence: "inferred" });
      }
    }
  }
  return { nodes: [...nodes.values()], edges };
}
