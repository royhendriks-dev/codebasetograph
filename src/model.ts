/** Evidence says how a relationship was established. Never present `inferred`/`unresolved` as fact. */
export type Evidence = "extracted" | "resolved" | "inferred" | "unresolved";

export type NodeKind = "file" | "symbol" | "package";
/** `extends` covers both Java extends and implements. */
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

/** Per-file result of parsing; resolution into edges happens later, over all files. */
export interface FileFacts {
  path: string;
  hash: string;
  parseError: boolean;
  /** Language and parser version that produced these facts; a mismatch forces a re-parse of cached files. */
  lang?: "ts" | "java" | "config" | "asset";
  parser?: string;
  /** Angular: simple element selector of a component declared here, and custom elements used in its (inline or html) template. */
  selectors?: string[];
  elements?: string[];
  /** Java only: simple names of types used in this file (declared types excluded), for same-package links without an import. */
  javaTypes?: string[];
  /** TS/JS: URL-like string literals (start with "/", template parts as `{}`), used to link a client to the backend route it calls. */
  urls?: string[];
  /** Java only: full JAX-RS routes (class `@Path` + method `@Path`), path parameters as `{name}`. */
  routes?: string[];
  /** Java only: declared package. */
  javaPackage?: string;
  symbols: Array<Omit<GraphNode, "id" | "kind" | "path"> & { name: string }>;
  imports: Array<{ specifier: string; names: string[]; line: number; reexport: boolean; dynamic: boolean; wildcard?: boolean; ref?: "path" | "image" | "action" | "object" | "doc" }>;
}

export interface Graph {
  version: 1;
  /** tsconfig baseUrl/paths found in the repo; kept so linking is reproducible from the graph file. */
  aliases?: import("./tsconfig.js").Alias[];
  root: string;
  files: Record<string, FileFacts>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  skipped: Array<{ path: string; reason: string }>;
}
