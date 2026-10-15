import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { Parser, Language, type Node } from "web-tree-sitter";
import type { FileFacts } from "./model.js";

export const JAVA_PARSER_VERSION = "java-3";
const require = createRequire(import.meta.url);

let parserPromise: Promise<Parser> | undefined;
/** Loads the Java grammar (WASM, bundled in node_modules). Parsing never executes the source. */
function getParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    await Parser.init();
    const lang = await Language.load(require.resolve("tree-sitter-wasms/out/tree-sitter-java.wasm"));
    const p = new Parser();
    p.setLanguage(lang);
    return p;
  })();
  return parserPromise;
}

const kids = (n: Node | null | undefined): Node[] => (n?.namedChildren ?? []).filter((c): c is Node => c !== null);
const allKids = (n: Node): Node[] => n.children.filter((c): c is Node => c !== null);

const TYPE_NODES: Record<string, string> = {
  class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum",
  record_declaration: "record", annotation_type_declaration: "annotation",
};

function annotationsOf(n: Node): string[] {
  const mods = kids(n).find((c) => c.type === "modifiers");
  if (!mods) return [];
  return kids(mods)
    .filter((c) => c.type === "marker_annotation" || c.type === "annotation")
    .map((c) => c.childForFieldName("name")?.text ?? "")
    .filter(Boolean);
}
const hasModifier = (n: Node, m: string) => allKids(kids(n).find((c) => c.type === "modifiers") ?? n).some((c) => c.type === m);

export async function parseJava(relPath: string, text: string): Promise<FileFacts> {
  const parser = await getParser();
  const tree = parser.parse(text);
  const facts: FileFacts = {
    path: relPath, hash: createHash("sha256").update(text).digest("hex"), lang: "java", parser: JAVA_PARSER_VERSION,
    parseError: !tree || tree.rootNode.hasError, symbols: [], imports: [],
  };
  if (!tree) return facts;
  const root = tree.rootNode;
  const line = (n: Node) => n.startPosition.row + 1;
  const lines = (n: Node): [number, number] => [n.startPosition.row + 1, n.endPosition.row + 1];

  for (const c of kids(root)) {
    if (c.type === "package_declaration") {
      facts.javaPackage = kids(c).find((x) => x.type === "scoped_identifier" || x.type === "identifier")?.text;
    } else if (c.type === "import_declaration") {
      const id = kids(c).find((x) => x.type === "scoped_identifier" || x.type === "identifier");
      if (!id) continue;
      const wildcard = kids(c).some((x) => x.type === "asterisk");
      facts.imports.push({ specifier: id.text, names: [wildcard ? "*" : id.text.split(".").pop()!], line: line(c), reexport: false, dynamic: false, wildcard });
    } else if (TYPE_NODES[c.type]) {
      const name = c.childForFieldName("name")?.text;
      if (!name) continue;
      const ann = annotationsOf(c);
      const detail = [TYPE_NODES[c.type], ...ann.map((a) => "@" + a)].join(" ");
      facts.symbols.push({ name, detail, lines: lines(c), exported: hasModifier(c, "public") });
      const heritage = [
        ...(c.childForFieldName("superclass")?.descendantsOfType("type_identifier") ?? []),
        ...(c.childForFieldName("interfaces")?.descendantsOfType("type_identifier") ?? []),
      ].filter((t): t is Node => t !== null).map((t) => t.text);
      // heritage is stored as pseudo-imports of simple names; linking resolves them through imports/package
      for (const h of heritage) facts.imports.push({ specifier: h, names: ["extends"], line: line(c), reexport: false, dynamic: false });
      const body = c.childForFieldName("body");
      for (const m of kids(body)) {
        if (m.type === "method_declaration" || m.type === "constructor_declaration") {
          const mn = m.childForFieldName("name")?.text;
          if (mn) facts.symbols.push({ name: `${name}.${mn}`, detail: ["method", ...annotationsOf(m).map((a) => "@" + a)].join(" "), lines: lines(m), exported: hasModifier(m, "public") });
        }
      }
    }
  }
  // type names used anywhere in the file; same-package classes need no import, so this is the only trace of the use
  const declared = new Set(facts.symbols.filter((x) => !x.name.includes(".")).map((x) => x.name));
  const used = new Set(root.descendantsOfType("type_identifier").map((t) => t?.text).filter((t): t is string => !!t && !declared.has(t)));
  if (used.size) facts.javaTypes = [...used].sort((a, b) => a.localeCompare(b)).slice(0, 300);
  return facts;
}
