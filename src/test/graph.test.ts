import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexRepo, loadGraph } from "../build.js";
import { parseFile } from "../parse.js";
import { context, dependents, findSymbols } from "../query.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-"));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  return root;
}

const angular = {
  "src/app/user.service.ts": `import { Injectable } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class UserService { load() {} }\n`,
  "src/app/user-list.component.ts": `import { Component } from '@angular/core';\nimport { UserService } from './user.service';\nimport { gone } from './missing';\n@Component({ selector: 'app-user-list', template: '' })\nexport class UserListComponent { constructor(private s: UserService) {} }\n`,
  "src/app/index.ts": `export * from './user.service';\n`,
  "node_modules/x/index.ts": `export const x = 1;`,
  "dist/out.js": `module.exports = 1;`,
  "src/types.d.ts": `export type T = 1;`,
  ".gitignore": `ignored/\n*.gen.ts\n`,
  "ignored/a.ts": `export const a = 1;`,
  "src/b.gen.ts": `export const b = 1;`,
};

test("parse: symbols, Angular roles, imports, re-exports, dynamic import, require", () => {
  const f = parseFile("a.ts", `import a, { b as c } from './x';\nexport * from './y';\nconst z = require('z');\nimport('./lazy');\n@Component({selector:'app-a'})\nexport class A {}\nexport interface I {}\nexport const k = 1;`);
  assert.deepEqual(f.imports.map((i) => [i.specifier, i.reexport, i.dynamic]), [["./x", false, false], ["./y", true, false], ["z", false, false], ["./lazy", false, true]]);
  assert.deepEqual(f.imports[0].names, ["default", "b"]);
  const byName = Object.fromEntries(f.symbols.map((s) => [s.name, s]));
  assert.equal(byName.A.detail, "component[app-a]");
  assert.equal(byName.I.detail, "interface");
  assert.equal(byName.k.exported, true);
});

test("parse: malformed source does not throw and flags the error", () => {
  const f = parseFile("bad.ts", `export class { import from ;; function (`);
  assert.equal(f.parseError, true);
});

test("index: ignore rules, evidence levels, stable ids", async () => {
  const root = await fixture(angular);
  const { graph } = await indexRepo(root);
  const paths = Object.keys(graph.files).sort();
  assert.deepEqual(paths, ["src/app/index.ts", "src/app/user-list.component.ts", "src/app/user.service.ts"]);
  const ev = (spec: string) => graph.edges.find((e) => e.specifier === spec)?.evidence;
  assert.equal(ev("./user.service"), "resolved");
  assert.equal(ev("./missing"), "unresolved");
  assert.equal(ev("@angular/core"), "inferred");
  assert.ok(graph.nodes.some((n) => n.id === "sym:src/app/user.service.ts#UserService"));
  assert.ok(graph.skipped.some((s) => s.path === "src/types.d.ts"));
});

test("query: find, dependents, context with budget", async () => {
  const root = await fixture(angular);
  const { graph } = await indexRepo(root);
  assert.equal(findSymbols(graph, "UserService")[0].id, "sym:src/app/user.service.ts#UserService");
  assert.deepEqual(dependents(graph, "src/app/user.service.ts").map((e) => e.from).sort(),
    ["file:src/app/index.ts", "file:src/app/user-list.component.ts"]);
  const c = context(graph, "change how the user service loads data", 800);
  assert.match(c.text, /user\.service\.ts:\d+-\d+/);
  assert.match(c.text, /unresolved import/);
  const tiny = context(graph, "user service", 5);
  assert.equal(tiny.truncated, true);
});

test("incremental: unchanged files reused, changed re-parsed, deleted removed, links refreshed", async () => {
  const root = await fixture(angular);
  await indexRepo(root);
  const again = await indexRepo(root);
  assert.deepEqual([again.stats.parsed, again.stats.reused], [0, 3]);

  await fs.writeFile(path.join(root, "src/app/user.service.ts"), `export class UserService {}\nexport class Extra {}\n`);
  await fs.rm(path.join(root, "src/app/index.ts"));
  const r = await indexRepo(root);
  assert.deepEqual([r.stats.parsed, r.stats.reused, r.stats.removed], [1, 1, 1]);
  assert.ok(r.graph.nodes.some((n) => n.id.endsWith("#Extra")));
  assert.ok(!r.graph.nodes.some((n) => n.id === "file:src/app/index.ts"));
  assert.ok(!r.graph.edges.some((e) => e.from === "file:src/app/index.ts"));
});

test("persistence: graph reloads; corrupt graph file triggers clean rebuild", async () => {
  const root = await fixture(angular);
  await indexRepo(root);
  assert.ok(await loadGraph(root));
  await fs.writeFile(path.join(root, ".cbtg/graph.json"), "{not json");
  assert.equal(await loadGraph(root), undefined);
  const r = await indexRepo(root);
  assert.equal(r.stats.parsed, 3);
});

test("view: HTML is self-contained and escapes hostile names", async () => {
  const { renderHtml } = await import("../view.js");
  const root = await fixture({ "src/</script><img src=x onerror=alert(1)>.ts": `export const a = 1;` });
  const { graph } = await indexRepo(root);
  const html = renderHtml(graph);
  assert.ok(html.includes("<title>codebasetograph</title>"));
  assert.ok(!html.includes("</script><img"), "name must not break out of the data script");
  assert.doesNotMatch(html, /https?:\/\//, "no external resources");
  assert.doesNotMatch(html, /innerHTML/);
});

test("java: package, imports, annotations, methods, same-package and cross-package links", async () => {
  const root = await fixture({
    "src/main/java/app/user/UserService.java": `package app.user;\nimport java.util.List;\nimport jakarta.inject.Inject;\nimport app.api.Greeter;\n@ApplicationScoped\npublic class UserService extends BaseService implements Greeter {\n  public String hello() { return ""; }\n}\n`,
    "src/main/java/app/user/BaseService.java": `package app.user;\npublic abstract class BaseService {}\n`,
    "src/main/java/app/api/Greeter.java": `package app.api;\npublic interface Greeter {}\n`,
    "src/main/java/app/web/UserResource.java": `package app.web;\nimport app.user.UserService;\nimport app.api.*;\nimport static app.user.UserService.hello;\nimport org.other.Missing;\n@Path("/u")\npublic class UserResource { @GET public void get() {} }\n`,
    "target/gen/Skip.java": `package x; class Skip {}`,
    "src/main/java/app/Broken.java": `package app; public class { void ( `,
  });
  const { graph } = await indexRepo(root);
  assert.ok(!graph.files["target/gen/Skip.java"], "target/ is ignored");
  const svc = graph.nodes.find((n) => n.id === "sym:src/main/java/app/user/UserService.java#UserService")!;
  assert.equal(svc.detail, "class @ApplicationScoped");
  assert.ok(graph.nodes.some((n) => n.id.endsWith("UserService.java#UserService.hello")));
  assert.equal(graph.nodes.find((n) => n.id.endsWith("UserResource.java#UserResource"))!.detail, "class @Path");
  const edge = (from: string, kind: string, spec: string) => graph.edges.find((e) => e.from.endsWith(from) && e.kind === kind && e.specifier === spec);
  assert.equal(edge("UserResource.java", "imports", "app.user.UserService")?.evidence, "resolved");
  assert.equal(edge("UserResource.java", "imports", "app.user.UserService.hello")?.evidence, "resolved", "static import resolves to the type");
  assert.equal(edge("UserResource.java", "imports", "org.other.Missing")?.evidence, "inferred");
  assert.equal(edge("UserResource.java", "imports", "app.api")?.evidence, "inferred", "wildcard is inferred");
  assert.equal(edge("UserService.java", "extends", "BaseService")?.to, "file:src/main/java/app/user/BaseService.java", "same-package supertype");
  assert.equal(edge("UserService.java", "extends", "Greeter")?.evidence, "resolved");
  assert.equal(graph.files["src/main/java/app/Broken.java"].parseError, true);
  assert.deepEqual(dependents(graph, "src/main/java/app/user/UserService.java").map((e) => e.from.split("/").pop()).sort(), ["UserResource.java", "UserResource.java"]);
});

test("cache: facts from an older parser version are re-parsed", async () => {
  const root = await fixture({ "a.ts": `export const a = 1;` });
  await indexRepo(root);
  const gp = path.join(root, ".cbtg/graph.json");
  const g = JSON.parse(await fs.readFile(gp, "utf8"));
  g.files["a.ts"].parser = "ts-0";
  await fs.writeFile(gp, JSON.stringify(g));
  assert.equal((await indexRepo(root)).stats.parsed, 1);
});

test("context ranking: source ranks above specs; stopwords ignored; exported symbol beats private const", async () => {
  const root = await fixture({
    "src/auth.service.ts": `export class AuthService {}\nconst AUTH_URL = '/a';\n`,
    "src/auth.service.spec.ts": `import { AuthService } from './auth.service';\nconst AUTH_SPEC = 1;\n`,
    "tests/e2e/auth.ts": `export const x = 1;`,
  });
  const { graph } = await indexRepo(root);
  const { items } = context(graph, "how to change the auth service", 800);
  const first = items.findIndex((i) => i.path === "src/auth.service.ts");
  const spec = items.findIndex((i) => i.path === "src/auth.service.spec.ts");
  assert.equal(items[0].path, "src/auth.service.ts");
  assert.ok(first < spec, "source before spec");
  const { isTestPath } = await import("../query.js");
  assert.ok(isTestPath("a/b.spec.ts") && isTestPath("tests/e2e/auth.ts") && !isTestPath("src/auth.ts"));
});

const infra = {
  ".github/workflows/ci.yml": `name: ci\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: ./.github/actions/setup\n  deploy:\n    needs: build\n    uses: ./.github/workflows/deploy.yml\n`,
  ".github/workflows/deploy.yml": `on: workflow_call\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/missing\n`,
  ".github/actions/setup/action.yml": `name: setup\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n`,
  "docker-compose.yml": `services:\n  api:\n    build:\n      context: ./backend\n      dockerfile: Dockerfile.dev\n    image: ghcr.io/x/api:1.2\n  web:\n    build: ./frontend\n    env_file: .env\n`,
  "backend/Dockerfile.dev": `FROM node:20\n`,
  "frontend/Dockerfile": `FROM nginx\n`,
  "k8s/config.yaml": `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-config\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  selector:\n    app: web\n`,
  "k8s/deploy.yaml": `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      serviceAccountName: web-sa\n      containers:\n        - name: web\n          image: nginx:1.27\n          envFrom:\n            - configMapRef:\n                name: app-config\n            - secretRef:\n                name: app-secret\n`,
  "k8s/ingress.yaml": `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: web\nspec:\n  rules:\n    - http:\n        paths:\n          - backend:\n              service:\n                name: web\n`,
  "k8s/kustomization.yaml": `resources:\n  - config.yaml\n  - deploy.yaml\n  - missing.yaml\n`,
  "data/i18n.yml": `hello: world\n`,
  "bad.yml": `a: [unclosed\n  b: {`,
};

test("yaml: GitHub Actions, compose, Kubernetes and kustomize produce evidence-labelled references", async () => {
  const root = await fixture(infra);
  const { graph } = await indexRepo(root);
  const edge = (from: string, label: string) => graph.edges.find((e) => e.from === `file:${from}` && e.specifier === label && e.kind === "references");
  // symbols
  assert.ok(graph.nodes.some((n) => n.id === "sym:.github/workflows/ci.yml#build" && n.detail === "job"));
  assert.ok(graph.nodes.some((n) => n.id === "sym:k8s/deploy.yaml#Deployment/web"));
  assert.ok(graph.nodes.some((n) => n.id === "sym:docker-compose.yml#api" && n.detail === "service"));
  // actions
  assert.deepEqual([edge(".github/workflows/ci.yml", "./.github/actions/setup")?.to, edge(".github/workflows/ci.yml", "./.github/actions/setup")?.evidence], ["file:.github/actions/setup/action.yml", "resolved"]);
  assert.equal(edge(".github/workflows/ci.yml", "./.github/workflows/deploy.yml")?.evidence, "resolved");
  assert.equal(edge(".github/workflows/ci.yml", "actions/checkout@v4")?.evidence, "inferred");
  assert.equal(edge(".github/workflows/deploy.yml", "./.github/actions/missing")?.evidence, "unresolved");
  // compose
  assert.equal(edge("docker-compose.yml", "api build")?.to, "file:backend/Dockerfile.dev");
  assert.equal(edge("docker-compose.yml", "web build")?.to, "file:frontend/Dockerfile");
  assert.equal(edge("docker-compose.yml", "ghcr.io/x/api:1.2")?.to, "pkg:image:ghcr.io/x/api");
  assert.ok(!graph.edges.some((e) => /\.env/.test(e.specifier ?? "")), "env_file (secrets) is never followed");
  // kubernetes
  assert.deepEqual([edge("k8s/deploy.yaml", "ConfigMap/app-config")?.to, edge("k8s/deploy.yaml", "ConfigMap/app-config")?.evidence], ["file:k8s/config.yaml", "resolved"]);
  assert.equal(graph.edges.find((e) => e.from === "file:k8s/deploy.yaml" && e.to === "pkg:k8s:Secret/app-secret")?.evidence, "unresolved");
  assert.equal(graph.edges.find((e) => e.from === "file:k8s/deploy.yaml" && e.to === "pkg:k8s:ServiceAccount/web-sa")?.evidence, "unresolved");
  assert.equal(graph.edges.find((e) => e.from === "file:k8s/config.yaml" && e.to === "file:k8s/deploy.yaml")?.evidence, "resolved"); // Service selector -> Deployment labels
  assert.equal(graph.edges.find((e) => e.from === "file:k8s/ingress.yaml" && e.to === "file:k8s/config.yaml")?.evidence, "resolved");
  assert.equal(edge("k8s/kustomization.yaml", "deploy.yaml")?.to, "file:k8s/deploy.yaml");
  assert.equal(edge("k8s/kustomization.yaml", "missing.yaml")?.evidence, "unresolved");
  // noise and safety
  assert.ok(graph.skipped.some((s) => s.path === "data/i18n.yml" && /not a recognised/.test(s.reason)));
  assert.ok(!("data/i18n.yml" in graph.files));
  assert.ok(graph.skipped.some((s) => s.path === "bad.yml"));
  assert.ok(dependents(graph, "backend/Dockerfile.dev").length === 1);
});

test("yaml: unindexed-but-present references add no false unresolved edge; same name twice is inferred; edits refresh links", async () => {
  const root = await fixture({
    "k8s/kustomization.yaml": `resources:\n  - extra.yaml\n  - a.yaml\n`,
    "k8s/extra.yaml": `just: data\n`,
    "k8s/a.yaml": `apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  containers:\n    - name: c\n      image: x\n      envFrom:\n        - configMapRef:\n            name: shared\n`,
    "env1/cm.yaml": `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shared\n`,
    "env2/cm.yaml": `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shared\n`,
  });
  let g = (await indexRepo(root)).graph;
  assert.ok(!g.edges.some((e) => e.specifier === "extra.yaml"));
  const shared = g.edges.filter((e) => e.from === "file:k8s/a.yaml" && e.specifier === "ConfigMap/shared");
  assert.deepEqual(shared.map((e) => e.evidence), ["inferred", "inferred"]);
  await fs.rm(path.join(root, "env2/cm.yaml"));
  g = (await indexRepo(root)).graph;
  assert.deepEqual(g.edges.filter((e) => e.specifier === "ConfigMap/shared").map((e) => e.evidence), ["resolved"]);
  // a Dockerfile is a file node and a YAML parse never throws on hostile input
  const { parseYaml } = await import("../yaml.js");
  assert.equal(parseYaml("x.yml", "a: &a [*a]\n"), undefined);
});
