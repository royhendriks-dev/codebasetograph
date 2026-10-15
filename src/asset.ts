import { createHash } from "node:crypto";
import { customElements } from "./angular.js";
import type { FileFacts } from "./model.js";

export const ASSET_PARSER_VERSION = "asset-2";

/** HTML templates and stylesheets: file nodes, plus custom elements used in HTML. No parsing of styles. */
export function parseAsset(relPath: string, text: string): FileFacts {
  const facts: FileFacts = { path: relPath, hash: createHash("sha256").update(text).digest("hex"), lang: "asset", parser: ASSET_PARSER_VERSION, parseError: false, symbols: [], imports: [] };
  if (relPath.endsWith(".html")) {
    const els = customElements(text);
    if (els.length) facts.elements = els;
  }
  return facts;
}
