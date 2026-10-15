/** Evidence says how a relationship was established. Never present `inferred`/`unresolved` as fact. */
export type Evidence = "extracted" | "resolved" | "inferred" | "unresolved";

export type NodeKind = "file" | "symbol" | "package";
/** `extends` covers both Java extends and implements. `references` covers config links (Kubernetes names, compose build, CI uses). */
export type EdgeKind = "imports" | "reexports" | "declares" | "extends" | "references";

export interface GraphNode {
  /** Stable id: `file:<relpath>`, `sym:<relpath>#<name>`, `pkg:<name>`. Independent of absolute paths. */
  id: string;
  kind: NodeKind;
  name: string;
  path?: string;
  /** 1-based inclusive line range. */
  lines?: [number, number];
  /** symbol sub-kind: function, class, interface, type, enum, const; or Angular role. */
  detail?: string;
  exported?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  evidence: Evidence;
  /** Raw module specifier, kept for unresolved edges and debugging. */
  specifier?: string;
  line?: number;
}

/** A reference found in config files (YAML, compose, Kubernetes). Resolved over all files in `link`. */
export interface Ref {
  /** path: candidate repo-relative files, first existing wins. object: `Kind/name` of a Kubernetes object. selector: Service label selector. package: external action or image. */
  type: "path" | "object" | "selector" | "package";
  targets?: string[];
  target?: string;
  selector?: Record<string, string>;
  line: number;
  label?: string;
}

/** Per-file result of parsing; resolution into edges happens later, over all files. */
export interface FileFacts {
  path: string;
  hash: string;
  parseError: boolean;
  /** Language and parser version that produced these facts; a mismatch forces a re-parse of cached files. */
  lang?: "ts" | "java" | "yaml" | "other";
  parser?: string;
  /** Java only: declared package. */
  javaPackage?: string;
  symbols: Array<Omit<GraphNode, "id" | "kind" | "path"> & { name: string }>;
  /** YAML/config only: references to resolve, and pod labels per workload symbol (for Service selectors). */
  refs?: Ref[];
  podLabels?: Record<string, Record<string, string>>;
  imports: Array<{ specifier: string; names: string[]; line: number; reexport: boolean; dynamic: boolean; wildcard?: boolean }>;
}

export interface Graph {
  version: 1;
  root: string;
  files: Record<string, FileFacts>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  skipped: Array<{ path: string; reason: string }>;
}
