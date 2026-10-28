import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { Parser, Language, type Node } from "web-tree-sitter";
import type { FileFacts } from "./model.js";

/**
 * Generic tree-sitter extractor. A language is a small table (grammar, extensions, declaration node types) plus an import
 * collector; the walk, parser loading and fact building are shared. Grammars come from `tree-sitter-wasms` (already a
 * dependency) and are loaded lazily, so a repository without Python/Go/C# files never loads them. Parsing never executes
 * the source. Strings and comments are not read, so they never reach the graph.
 */
export type TsLang = "py" | "go" | "cs";

const require = createRequire(import.meta.url);

type Facts = FileFacts;
type Symbol = Facts["symbols"][number];
type Import = Facts["imports"][number];

const kids = (n: Node | null | undefined): Node[] => (n?.namedChildren ?? []).filter((c): c is Node => c !== null);
const lineRange = (n: Node): [number, number] => [n.startPosition.row + 1, n.endPosition.row + 1];

/** What to do with one node type met while walking declarations. */
interface Decl {
  /** `detail` of the symbol, e.g. "class". May depend on the node (Go: struct/interface/type). */
  detail: string | ((n: Node) => string);
  /** Name of the symbol; the field `name` by default. */
  name?: (n: Node) => string | undefined;
  /** Node types that hold members (methods, properties) of this declaration, searched in its body. */
  members?: Record<string, string>;
  /** Field holding the body; members and nested declarations are searched there. */
  body?: string;
  /** Whether nested declarations in the body become symbols too (C# nested types). */
  nested?: boolean;
}

interface LangSpec {
  grammar: string;
  version: string;
  exts: string[];
  decls: Record<string, Decl>;
  /** Node types walked through without making a symbol (namespaces, decorators, blocks). */
  transparent: Set<string>;
  isExported: (n: Node, name: string) => boolean;
  /** Top-level declarations that are not types or functions (Python/Go constants). Returns a symbol per name. */
  topLevel?: (n: Node) => Array<{ name: string; detail: string }>;
  imports: (root: Node, add: (i: Import) => void) => void;
  /** Namespaces declared in the file (C#), to link `using` directives to files. */
  namespaces?: (root: Node) => string[];
}

const text = (n: Node | null | undefined) => n?.text;

// ---- Python ----
const pyDotted = (n: Node | null | undefined): string => (n ? kids(n).map((c) => c.text).join(".") : "");
const PY: LangSpec = {
  grammar: "python",
  version: "py-1",
  exts: [".py"],
  decls: {
    class_definition: { detail: "class", body: "body", members: { function_definition: "method" } },
    function_definition: { detail: "function" },
  },
  transparent: new Set(["decorated_definition"]),
  isExported: (_n, name) => !name.startsWith("_"),
  topLevel: (n) => {
    if (n.type !== "expression_statement") return [];
    const a = kids(n)[0];
    const left = a?.type === "assignment" ? a.childForFieldName("left") : null;
    return left?.type === "identifier" ? [{ name: left.text, detail: /^[A-Z][A-Z0-9_]*$/.test(left.text) ? "const" : "variable" }] : [];
  },
  imports: (root, add) => {
    for (const n of root.descendantsOfType(["import_statement", "import_from_statement"])) {
      if (!n) continue;
      const line = n.startPosition.row + 1;
      if (n.type === "import_statement") {
        for (const c of kids(n)) {
          const mod = c.type === "aliased_import" ? pyDotted(c.childForFieldName("name")) : c.type === "dotted_name" ? pyDotted(c) : "";
          if (mod) add({ specifier: mod, names: ["*"], line, reexport: false, dynamic: false });
        }
        continue;
      }
      const modNode = n.childForFieldName("module_name");
      let spec = "";
      if (modNode?.type === "relative_import") {
        spec = (text(kids(modNode).find((c) => c.type === "import_prefix")) ?? ".") + pyDotted(kids(modNode).find((c) => c.type === "dotted_name"));
      } else spec = pyDotted(modNode);
      const names: string[] = [];
      for (const c of kids(n)) {
        if (c.id === modNode?.id) continue;
        if (c.type === "wildcard_import") names.push("*");
        else if (c.type === "dotted_name") names.push(pyDotted(c));
        else if (c.type === "aliased_import") names.push(pyDotted(c.childForFieldName("name")));
      }
      if (spec) add({ specifier: spec, names: names.length ? names : ["*"], line, reexport: false, dynamic: false, wildcard: names.includes("*") });
    }
  },
};

// ---- Go ----
const goSpecName = (n: Node) => text(n.childForFieldName("name") ?? kids(n).find((c) => c.type === "type_identifier" || c.type === "identifier"));
const goReceiver = (n: Node): string | undefined => {
  const t = kids(kids(n.childForFieldName("receiver"))[0]).find((c) => c.type !== "identifier");
  return text(t?.type === "pointer_type" ? kids(t)[0] : t);
};
const GO: LangSpec = {
  grammar: "go",
  version: "go-1",
  exts: [".go"],
  decls: {
    function_declaration: { detail: "function" },
    method_declaration: { detail: "method", name: (n) => { const m = text(n.childForFieldName("name")); const r = goReceiver(n); return m && r ? `${r}.${m}` : m; } },
    type_spec: { detail: (n) => { const t = n.childForFieldName("type")?.type; return t === "struct_type" ? "struct" : t === "interface_type" ? "interface" : "type"; }, name: goSpecName },
    type_alias: { detail: "type", name: goSpecName },
  },
  transparent: new Set(["type_declaration"]),
  isExported: (_n, name) => /^[A-Z]/.test(name.split(".").pop() ?? ""),
  topLevel: (n) => {
    if (n.type !== "var_declaration" && n.type !== "const_declaration") return [];
    const detail = n.type === "var_declaration" ? "var" : "const";
    return n.descendantsOfType(["var_spec", "const_spec"]).flatMap((s) => kids(s).filter((c) => c.type === "identifier").slice(0, 1).map((c) => ({ name: c.text, detail })));
  },
  imports: (root, add) => {
    for (const s of root.descendantsOfType("import_spec")) {
      const lit = s?.childForFieldName("path") ?? s?.descendantsOfType("interpreted_string_literal")[0];
      const spec = lit?.text.slice(1, -1);
      if (s && spec) add({ specifier: spec, names: ["*"], line: s.startPosition.row + 1, reexport: false, dynamic: false });
    }
  },
};

// ---- C# ----
const CS_MEMBERS = { method_declaration: "method", constructor_declaration: "constructor", property_declaration: "property" };
const csType = (detail: string): Decl => ({ detail, body: "body", members: CS_MEMBERS, nested: true });
const csName = (n: Node | null | undefined): string => (n ? n.text : "");
const CS: LangSpec = {
  grammar: "c_sharp",
  version: "cs-1",
  exts: [".cs"],
  decls: {
    class_declaration: csType("class"),
    interface_declaration: csType("interface"),
    struct_declaration: csType("struct"),
    record_declaration: csType("record"),
    enum_declaration: { detail: "enum" },
  },
  transparent: new Set(["namespace_declaration", "declaration_list", "file_scoped_namespace_declaration"]),
  isExported: (n) => kids(n).some((c) => c.type === "modifier" && c.text === "public"),
  imports: (root, add) => {
    for (const u of root.descendantsOfType("using_directive")) {
      if (!u) continue;
      const alias = kids(u).some((c) => c.type === "name_equals");
      const target = kids(u).filter((c) => c.type === "qualified_name" || c.type === "identifier").at(-1);
      if (target) add({ specifier: csName(target), names: [alias ? "alias" : /^using\s+static\b/.test(u.text) ? "static" : "*"], line: u.startPosition.row + 1, reexport: false, dynamic: false });
    }
  },
  namespaces: (root) => root.descendantsOfType(["namespace_declaration", "file_scoped_namespace_declaration"]).map((n) => csName(n?.childForFieldName("name") ?? kids(n).find((c) => c.type === "qualified_name" || c.type === "identifier"))).filter(Boolean),
};

const SPECS: Record<TsLang, LangSpec> = { py: PY, go: GO, cs: CS };

export const TREESITTER_PARSER_VERSIONS: Record<TsLang, string> = { py: PY.version, go: GO.version, cs: CS.version };

/** The tree-sitter language of a file path, if any. */
export function treeSitterLangOf(rel: string): TsLang | undefined {
  const dot = rel.lastIndexOf(".");
  const ext = dot < 0 ? "" : rel.slice(dot);
  return (Object.keys(SPECS) as TsLang[]).find((l) => SPECS[l].exts.includes(ext));
}

export const TREESITTER_EXTS = Object.values(SPECS).flatMap((s) => s.exts);

const parsers = new Map<TsLang, Promise<Parser>>();
let initialised: Promise<void> | undefined;
function getParser(lang: TsLang): Promise<Parser> {
  let p = parsers.get(lang);
  if (!p) {
    p = (async () => {
      await (initialised ??= Parser.init());
      const language = await Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${SPECS[lang].grammar}.wasm`));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
    parsers.set(lang, p);
  }
  return p;
}

function declName(d: Decl, n: Node): string | undefined {
  return d.name ? d.name(n) : text(n.childForFieldName("name"));
}

/** Walks declarations: types and functions become symbols, members become `Owner.member`. */
function walk(spec: LangSpec, n: Node, facts: Facts, prefix: string, top: boolean): void {
  for (const c of kids(n)) {
    const d = spec.decls[c.type];
    if (d) {
      const name = declName(d, c);
      if (name) {
        const full = prefix + name;
        const detail = typeof d.detail === "function" ? d.detail(c) : d.detail;
        facts.symbols.push({ name: full, detail, lines: lineRange(c), exported: spec.isExported(c, name) } as Symbol);
        if (d.members || d.nested) {
          const body = (d.body && c.childForFieldName(d.body)) || kids(c).find((x) => x.type === "declaration_list" || x.type === "block");
          for (const m of kids(body)) {
            const md = d.members?.[m.type];
            if (md) {
              const mn = text(m.type === "function_definition" ? m.childForFieldName("name") : (m.childForFieldName("name") ?? kids(m).find((x) => x.type === "identifier")));
              if (mn) facts.symbols.push({ name: `${full}.${mn}`, detail: md, lines: lineRange(m), exported: spec.isExported(m, mn) });
            } else if (m.type === "decorated_definition") {
              const inner = kids(m).find((x) => d.members?.[x.type]);
              const mn = text(inner?.childForFieldName("name"));
              if (inner && mn) facts.symbols.push({ name: `${full}.${mn}`, detail: d.members![inner.type], lines: lineRange(m), exported: spec.isExported(inner, mn) });
            }
          }
          if (d.nested) walk(spec, body ?? c, facts, `${full}.`, false);
        }
      }
    } else if (spec.transparent.has(c.type)) {
      walk(spec, c, facts, prefix, top);
    } else if (top && spec.topLevel) {
      for (const t of spec.topLevel(c)) facts.symbols.push({ name: t.name, detail: t.detail, lines: lineRange(c), exported: spec.isExported(c, t.name) });
    }
  }
}

export async function parseTreeSitter(lang: TsLang, relPath: string, source: string): Promise<FileFacts> {
  const spec = SPECS[lang];
  const parser = await getParser(lang);
  const tree = parser.parse(source);
  const facts: FileFacts = {
    path: relPath, hash: createHash("sha256").update(source).digest("hex"), lang, parser: spec.version,
    parseError: !tree || tree.rootNode.hasError, symbols: [], imports: [],
  };
  if (!tree) return facts;
  try {
    walk(spec, tree.rootNode, facts, "", true);
    spec.imports(tree.rootNode, (i) => facts.imports.push(i));
    const ns = spec.namespaces?.(tree.rootNode);
    if (ns?.length) facts.namespaces = [...new Set(ns)];
  } finally {
    tree.delete();
  }
  return facts;
}
