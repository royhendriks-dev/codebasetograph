import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexRepo } from "../build.js";
import { customElements, attributeSelector } from "../angular.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-"));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  return root;
}

test("angular: template uses of attribute directives and pipes are collected", () => {
  const html = `<div appHighlight [appTooltip]="t" (appClick)="x()"></div>\n<p>{{ price | money:'EUR' }} {{ a || b }}</p>\n<span [title]="d | date"></span>`;
  assert.deepEqual(customElements(html), ["[appClick]", "[appHighlight]", "[appTooltip]", "|date", "|money"]);
  assert.equal(attributeSelector("button[appHighlight]"), "[appHighlight]");
  assert.equal(attributeSelector("[plain]"), undefined);
  assert.equal(attributeSelector("app-x"), undefined);
});

test("angular: directive and pipe usage in a template links to the declaring file (inferred)", async () => {
  const root = await fixture({
    "src/highlight.directive.ts": `import { Directive } from '@angular/core';\n@Directive({ selector: '[appHighlight]' })\nexport class HighlightDirective {}\n`,
    "src/money.pipe.ts": `import { Pipe } from '@angular/core';\n@Pipe({ name: 'money' })\nexport class MoneyPipe {}\n`,
    "src/view.component.ts": `import { Component } from '@angular/core';\n@Component({ selector: 'app-view', template: '<b appHighlight>{{ p | money }}</b>' })\nexport class ViewComponent {}\n`,
  });
  const { graph } = await indexRepo(root);
  const out = graph.edges.filter((e) => e.from === "file:src/view.component.ts" && e.kind === "references").map((e) => [e.to, e.evidence, e.specifier]);
  assert.deepEqual(out.sort(), [["file:src/highlight.directive.ts", "inferred", "[appHighlight]"], ["file:src/money.pipe.ts", "inferred", "|money"]]);
});
