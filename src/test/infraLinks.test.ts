import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexRepo } from "../build.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-"));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  return root;
}

test("compose depends_on links the service symbols (list and map form)", async () => {
  const root = await fixture({
    "compose.yaml": `services:\n  web:\n    image: nginx\n    depends_on:\n      api:\n        condition: service_healthy\n  api:\n    image: acme/api\n    depends_on: [db, ghost]\n  db:\n    image: postgres\n  odd:\n    image: x\n    depends_on: 5\n`,
  });
  const { graph } = await indexRepo(root);
  const links = graph.edges.filter((e) => e.specifier === "depends_on").map((e) => `${e.from.split("#")[1]}>${e.to.split("#")[1]}:${e.evidence}`).sort();
  assert.deepEqual(links, ["service:api>service:db:resolved", "service:web>service:api:resolved"]);
});

test("kubernetes: Ingress backends, HPA targets and Service selectors link to what they point at", async () => {
  const root = await fixture({
    "k8s/app.yaml": `apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web }\nspec:\n  template:\n    metadata:\n      labels: { app: web, tier: front }\n    spec: { containers: [{ name: c, image: nginx }] }\n---\napiVersion: batch/v1\nkind: CronJob\nmetadata: { name: job }\nspec:\n  jobTemplate:\n    spec:\n      template:\n        metadata:\n          labels: { app: job }\n`,
    "k8s/svc.yaml": `apiVersion: v1\nkind: Service\nmetadata: { name: web }\nspec:\n  selector: { app: web }\n---\napiVersion: v1\nkind: Service\nmetadata: { name: nothing }\nspec:\n  selector: { app: nobody }\n---\napiVersion: v1\nkind: Service\nmetadata: { name: external }\nspec: { type: ExternalName }\n`,
    "k8s/ingress.yaml": `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: { name: in }\nspec:\n  rules:\n    - http:\n        paths:\n          - backend: { service: { name: web } }\n          - backend: { serviceName: legacy }\n`,
    "k8s/hpa.yaml": `apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata: { name: h }\nspec:\n  scaleTargetRef: { kind: Deployment, name: web }\n`,
  });
  const { graph } = await indexRepo(root);
  const from = (f: string) => graph.edges.filter((e) => e.from === `file:${f}` && e.kind === "references").map((e) => `${e.to}:${e.evidence}`).sort();
  assert.deepEqual(from("k8s/svc.yaml"), ["file:k8s/app.yaml:inferred"]);
  assert.deepEqual(from("k8s/ingress.yaml"), ["file:k8s/svc.yaml:inferred", "pkg:k8s:Service/legacy:unresolved"]);
  assert.deepEqual(from("k8s/hpa.yaml"), ["file:k8s/app.yaml:inferred"]);
});
