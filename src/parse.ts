import ts from "typescript";
import { isTestPath } from "./query.js";
import { createHash } from "node:crypto";
import type { FileFacts } from "./model.js";
import { attributeSelector, customElements, elementSelector } from "./angular.js";

const ANGULAR = new Set(["Component", "Directive", "Pipe", "Injectable", "NgModule"]);

/** Parses source text with the TypeScript parser. Source is never executed. Malformed input yields partial facts. */
export const TS_PARSER_VERSION = "ts-4";

export function parseFile(relPath: string, text: string): FileFacts {
  const hash = createHash("sha256").update(text).digest("hex");
  const kind = /\.(tsx|jsx)$/.test(relPath) ? ts.ScriptKind.TSX : relPath.endsWith("js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind);
  const facts: FileFacts = { path: relPath, hash, lang: "ts", parser: TS_PARSER_VERSION, parseError: false, symbols: [], imports: [] };
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  facts.parseError = !!parseDiagnostics && parseDiagnostics.length > 0;

  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const endLineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
  const isExported = (n: ts.Node) =>
    !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));

  const addSymbol = (name: string, detail: string, n: ts.Node, exported: boolean) =>
    facts.symbols.push({ name, detail, lines: [lineOf(n), endLineOf(n)], exported });

  /** Angular templateUrl/styleUrl(s) are relative to the component file even without a leading "./". */
  function addUrl(url: string, key: string, n: ts.Node): void {
    const spec = url.startsWith(".") ? url : "./" + url;
    facts.imports.push({ specifier: spec, names: [key], line: lineOf(n), reexport: false, dynamic: false, ref: "path" });
  }

  /** One property of an Angular decorator argument: selector, pipe name, template/style files or inline template. Returns the role suffix. */
  function decoratorProperty(role: string, key: string, v: ts.Expression): string {
    if (key === "selector" && ts.isStringLiteralLike(v)) {
      const sel = elementSelector(v.text) ?? attributeSelector(v.text);
      if (sel) (facts.selectors ??= []).push(sel);
      return `[${v.text}]`;
    }
    if (key === "name" && role === "pipe" && ts.isStringLiteralLike(v)) (facts.selectors ??= []).push(`|${v.text}`);
    else if ((key === "templateUrl" || key === "styleUrl") && ts.isStringLiteralLike(v)) addUrl(v.text, key, v);
    else if (key === "styleUrls" && ts.isArrayLiteralExpression(v)) v.elements.filter(ts.isStringLiteralLike).forEach((e) => addUrl(e.text, key, e));
    else if (key === "template" && ts.isStringLiteralLike(v)) facts.elements = [...new Set([...(facts.elements ?? []), ...customElements(v.text)])].sort((a, b) => a.localeCompare(b));
    return "";
  }

  function angularRole(n: ts.ClassDeclaration): string | undefined {
    for (const d of ts.getDecorators(n) ?? []) {
      const call = d.expression;
      if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !ANGULAR.has(call.expression.text)) continue;
      const base = call.expression.text.toLowerCase();
      let role = base;
      const arg = call.arguments[0];
      const props = arg && ts.isObjectLiteralExpression(arg) ? arg.properties : [];
      for (const p of props) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) role += decoratorProperty(base, p.name.text, p.initializer);
      }
      return role;
    }
    return undefined;
  }

  /** URL-like literals, e.g. '/api/auth' or `/api/${game}/highscores` (substitutions become `{}`). Matching happens at link time. */
  const addRoute = (text: string) => {
    if (/^\/[\w-]+\/[\w{}/.-]*$/.test(text) && text.length <= 120 && (facts.urls?.length ?? 0) < 40 && !facts.urls?.includes(text)) (facts.urls ??= []).push(text);
  };
  const templateText = (t: ts.TemplateExpression) => t.head.text + t.templateSpans.map((sp) => "{}" + sp.literal.text).join("");

  function visit(n: ts.Node, top: boolean): void {
    if (!isTestPath(relPath)) {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) addRoute(n.text);
      else if (ts.isTemplateExpression(n)) addRoute(templateText(n));
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const names: string[] = [];
      const c = n.importClause;
      if (c?.name) names.push("default");
      if (c?.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) names.push("*");
        else c.namedBindings.elements.forEach((e) => names.push((e.propertyName ?? e.name).text));
      }
      facts.imports.push({ specifier: n.moduleSpecifier.text, names, line: lineOf(n), reexport: false, dynamic: false });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const names = n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : ["*"];
      facts.imports.push({ specifier: n.moduleSpecifier.text, names, line: lineOf(n), reexport: true, dynamic: false });
    } else if (ts.isCallExpression(n)) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) {
        if (n.expression.kind === ts.SyntaxKind.ImportKeyword) {
          facts.imports.push({ specifier: arg.text, names: ["*"], line: lineOf(n), reexport: false, dynamic: true });
        } else if (ts.isIdentifier(n.expression) && n.expression.text === "require") {
          facts.imports.push({ specifier: arg.text, names: ["*"], line: lineOf(n), reexport: false, dynamic: false });
        }
      }
    }

    if (top) {
      if (ts.isFunctionDeclaration(n) && n.name) addSymbol(n.name.text, "function", n, isExported(n));
      else if (ts.isClassDeclaration(n) && n.name) addSymbol(n.name.text, angularRole(n) ?? "class", n, isExported(n));
      else if (ts.isInterfaceDeclaration(n)) addSymbol(n.name.text, "interface", n, isExported(n));
      else if (ts.isTypeAliasDeclaration(n)) addSymbol(n.name.text, "type", n, isExported(n));
      else if (ts.isEnumDeclaration(n)) addSymbol(n.name.text, "enum", n, isExported(n));
      else if (ts.isVariableStatement(n)) {
        for (const d of n.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) addSymbol(d.name.text, "const", n, isExported(n));
        }
      }
    }
    ts.forEachChild(n, (c) => visit(c, false));
  }
  sf.statements.forEach((s) => visit(s, true));
  return facts;
}
