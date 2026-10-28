# Design note: MVP skeleton

Status: first slice. Describes what exists in this PR and what is deliberately not built yet.

## Prior art

Similar open-source tools were studied through their public documentation only; no source was copied and **no behaviour was executed or verified**. The statements below describe what such tools typically claim (maintainer claims), not verified results.

- Typical shape: a library plus an agent skill with a pipeline like `detect → extract → build → cluster → report → export`.
- Code is parsed with tree-sitter, claimed deterministic and offline; docs and media use an LLM pass.
- The graph is exported as JSON; edges carry a confidence label (extracted / inferred / ambiguous).
- Such tools quote benchmark and token-saving figures. We do not rely on them; none are verified against our projects.

Open research work: read comparable extractor and incremental-cache designs, run their tests, and measure on a real repo.

## Ideas we took

Persistent graph that agents query before reading files; confidence labels on edges; local deterministic parsing. Data model, code and CLI here are independently designed.

## Architecture (this PR)

```
discover -> parse (per file) -> link (all files) -> graph.json -> query -> CLI / agent skill
```

| Module | Responsibility |
|---|---|
| `discover.ts` | Walk repo, default exclusions, simple `.gitignore`, skip `.d.ts`/minified/large files, no symlinks |
| `parse.ts` | TypeScript compiler API (parse only, nothing executed): imports, re-exports, `require`, dynamic `import('literal')`, top-level declarations, Angular decorator roles and selectors |
| `build.ts` | Per-file cache by content hash, linking, atomic write of `.cbtg/graph.json` |
| `query.ts` | find, deps, dependents, bounded related walk, budgeted task context (names + commit history) |
| `history.ts` | `git log` (read-only) to per-commit message words and touched indexed files, stored in the graph |
| `view.ts` | Self-contained HTML explorer generated from the graph: search, symbols per file, imports / imported-by with evidence badges. Repo-derived text is set via `textContent` (untrusted input). This is the list view for reading |
| `viewGraph.ts` | `cbtg view --graph`: drawn file graph for humans (agents use the queries). One self-contained page, no libraries or network: canvas, in-page force layout, nodes = linked files coloured and pulled together per folder cluster (project folder + innermost folder, generic parts like `src`/`main`/`java` skipped; cluster names drawn on the map), edges coloured by evidence, click highlights neighbours and lists the file's links and symbols (max 40), search, drag/zoom. The layout uses grid-based repulsion and runs a few iterations per animation frame, so the page stays responsive and draws while it settles (1,500 synthetic files: about 2.5 s in headless Chromium; checked with a screenshot, not a usability test). File-to-file edges only, duplicates collapsed, truncated to the most connected `--max-nodes` (default 400) files and the page says so. Names are drawn with canvas or `textContent`, never `innerHTML` |
| `java.ts` | Java via tree-sitter (WASM grammar, parse only): package, imports (incl. static and wildcard), top-level types with annotations (e.g. `@Path`, `@ApplicationScoped`), methods, `extends`/`implements` |
| `config.ts` | Dockerfile (stages, base images), YAML (GitHub workflows: jobs and `uses`; docker compose: services, images, build context; Kubernetes: kind/name, images and Secret/ConfigMap/PVC/ServiceAccount references; Kustomize: resources, bases, components and patches), SQL (`CREATE TABLE/INDEX/VIEW/TYPE` by regex) and nginx `.conf` (location, upstream, server_name and `add_header` names by line regex). Uses the `yaml` package (ISC, pinned, no code execution) |
| `cli.ts` | `cbtg` commands |

Language choice: TypeScript/Node, because the TS compiler API is the most accurate parser for TS/Angular and matches the primary stack. Python+tree-sitter was not evaluated yet; revisit when more languages are needed.

## Data model

- Nodes: `file:<relpath>`, `sym:<relpath>#<name>` (with line range, kind, exported flag, Angular role), `pkg:<name>`. Ids contain no absolute paths.
- Edges: `imports`, `reexports`, `declares`.
- Evidence: `extracted` (syntax), `resolved` (import matched to indexed file), `inferred` (bare specifier assumed to be an npm package), `unresolved` (relative import with no target).

## Incremental updates

Per-file facts are cached by SHA-256 of content. Changed files are re-parsed, deleted files dropped, and cross-file links are **always recomputed from all facts**. This costs little and removes the class of stale-edge bugs. A corrupt or unknown-version graph file is ignored and rebuilt. Writes go through a temp file and rename.

## Java (added after the first skeleton)

- Parser: `web-tree-sitter` 0.25.10 (MIT) with the Java grammar from `tree-sitter-wasms` 0.1.13 (Unlicense), both pinned: newer web-tree-sitter versions failed to load these grammar files in a local check. Pure WASM, no native build.
- Linking: an import resolves (`resolved`) when its fully-qualified type is declared in an indexed file; a static import resolves to its type. Wildcard imports are `inferred` (which classes are used is unknown). Anything else (JDK, jakarta, org.*) is an `inferred` package node. `extends`/`implements` edges exist only when the supertype resolves via an explicit import or the same package; unknown supertypes produce no edge rather than a guess.
- Same-package use without an import: type names used in a file are stored (`javaTypes`) and matched to types of the same package, as `references` with evidence `inferred` (a name match, not a resolved usage). Skipped when the target is already linked by import or `extends`.
- Not covered: usages inside method bodies (no call graph), Maven/Gradle modules, annotation processing and generated sources, Kotlin/Scala. Overloaded methods share one node id.
- Cached facts carry a parser version; facts from an older parser version are re-parsed.
- Checked on a copy of Roy's portfolio repo (60 Java + 73 TS files): 133 files indexed in under a second, no parse errors, no unresolved own-package imports. That is a spot check, not an accuracy measurement.

## Config and infrastructure files

- Symbols: workflow jobs, compose services, Kubernetes `Kind/name`, Docker stages, SQL tables/indexes. Edges are `references`: compose `build` to the Dockerfile (`resolved` if indexed, else `unresolved`), local workflow `uses` likewise; container images and GitHub actions become `pkg:image:...` / `pkg:action:...` nodes and are `inferred` (the graph does not know what they contain).
- Client to backend: TS files keep URL-like string literals (`'/api/auth'`, `` `/api/${game}/highscores` `` as `/api/{}/highscores`; test files skipped), Java files keep full JAX-RS routes (class `@Path` + method `@Path`). A TS file links to the Java file whose route agrees segment by segment up to the shorter of the two (at least two segments, `{x}` matches one segment, best exact fit wins). `references`, `inferred`: a string that looks like a route is not proof it is called. Only JAX-RS; Spring/Express/Nest routes are not read.
- Tests: `foo.spec.ts`/`foo.test.ts` link to `foo.ts` next to it, `FooTest.java`/`FooTests.java`/`FooIT.java` to the unique `Foo.java` (`references`, `inferred`, specifier `test of`; skipped when the test already imports its subject or the name is ambiguous). A convention, not proof.
- Kustomize: `resources`/`bases`/`components`/`patches` are `references` to local files (a directory points at its `kustomization.yaml`; remote URLs are skipped). Kubernetes `secretKeyRef`/`configMapRef`/`volumes`/`serviceAccountName` link to the file declaring that `Kind/name`: `inferred` when exactly one other file declares it (namespace is not checked), `unresolved` when none does (e.g. created outside the repo), no edge when ambiguous. Interpolated images: `${VAR:-default}` uses the default, anything else is skipped; a compose service with `build` has no image edge.
- Not covered: Helm templates and Kustomize generators/transformers (templated YAML may be flagged `parseError`), `depends_on`/service-to-service links, linking an image to the compose service or k8s manifest that builds it, Gradle files, SQL beyond CREATE statements.

- Not covered: Helm templates and Kustomize generators/transformers (templated YAML may be flagged `parseError`), linking an image to the compose service or k8s manifest that builds it, `package.json`/`pom.xml` dependency lists, SQL beyond CREATE statements.
- Security: YAML is parsed only; the parser is pinned to a version without the nested-collection stack-overflow advisory found by `npm audit` in 2.8.x, and a parse crash is caught and recorded as `parseError`.

## tsconfig aliases and Angular links

- `tsconfig*.json` / `jsconfig.json` are read as JSON (comments allowed, `extends` followed for relative paths, max 5 levels). `baseUrl` and `paths` become per-directory alias rules; the nearest directory wins. An import that matches a rule is `resolved` when the target file is indexed and `unresolved` when the rule matched but no file exists; a bare import that matches no rule stays an `inferred` package.
- Angular: `templateUrl`, `styleUrl` and `styleUrls` become `references` edges to the `.html`/`.scss`/`.css` file (`resolved` or `unresolved`). `.html`, `.scss` and `.css` are indexed as plain file nodes; stylesheets are not parsed.
- Custom elements used in an HTML or inline template are linked to the component whose `selector` is exactly that tag, but only when exactly one component has that selector, and always as `inferred`: the tag may come from a library, and whether the component is actually imported into the using component or module is not checked. The same applies to camelCase attribute directives (`[appFoo]`, `button[appFoo]`; used as `appFoo`, `[appFoo]=` or `(appFoo)=`) and pipes (`@Pipe({name})`, used as `| name` inside `{{ }}` or a quoted binding). Not matched: class selectors, `:not()`/selector lists, lowercase attribute selectors (too many HTML attributes look alike), Angular DI (already covered by imports) and router routes (covered by the dynamic `import()` in `loadComponent`). The portfolio repo uses no pipes or attribute directives, so this is tested on fixtures only; the 30-task benchmark is unchanged (72%).
- Not covered: DI (`inject()`/constructor types), router config, structural directives, pipes, `exports`/`imports` maps in `package.json`, monorepo workspace package names.

## Known limits

- TypeScript: file-level imports and top-level declarations only: no call graph, no member-level symbols, duplicate names in one file collapse to one node. Java: see above.
- No package `exports`, monorepo workspace package names, or Angular DI/router edges. Imports that no tsconfig rule covers show as `inferred` packages.
- `.gitignore` support is partial (no negation, no nested files).
- Context ranking is name matching plus commit history (see below). Measured with `cbtg bench --from-git`; not measured is whether an agent finishes tasks better.
- Only tests in `src/test` were run, on small synthetic fixtures. **No larger real-world repository and no token benchmark has been run yet.**

## Next steps

1. Phase 1: finish the prior-art research with verified experiments.
2. Angular DI and router edges.
3. Benchmark harness: grep-based baseline vs graph context on the same tasks (files read, lines, tokens, missed relevant files).
4. Real-repo index timing and incremental timing.
5. Optional adapters (MCP, editor integrations) on top of the same JSON graph.

## Config keys (`.properties`, `.env.example`)

- Only key names become symbols (`config key`); values are never read into the graph because they may be secrets. A real `.env` is never indexed, only `.env.example`/`.sample`/`.template`. Max 500 keys per file, parser `config-5`. Quoted keys with spaces are not recognised.

## Markdown

- `.md` files: headings (h1-h6, outside code fences, max 300) become symbols (`md hN`); relative links to indexed files become `references` edges, evidence `resolved` (URLs, images, missing targets and links leaving the repo give no edge). Parser `config-6`.
- Ranking: Markdown files and headings count x0.3 in `context`, like tests. Measured on the portfolio copy (30 code-edit tasks): graph recall 72% to 70%, tokens 5.5k to 6.6k; the grep baseline also drops (51% to 32%) because docs add matches. The tasks all target code, so this cost is expected; a documentation question is not covered by this benchmark.

## package.json and pom.xml

- `package.json`: dependency names (all four sections) become `imports` edges to the same `pkg:<name>` node TS imports use, evidence `extracted` (read straight from the file, not resolved). Scripts become symbols (`script:build`); versions and script commands are never stored. `workspaces` globs are not expanded.
- `pom.xml` (regex, not an XML parser, comments stripped): own artifactId as symbol, `<module>` as path reference to the child `pom.xml` (resolved or unresolved), `<dependency>` as `groupId:artifactId`. A dependency whose artifactId is declared by exactly one other pom in the repo links to that file (`inferred`: name match); others become `pkg:maven:<g>:<a>` (`extracted`). Dependencies with `${...}` properties are skipped; parent poms are not followed. Parser `config-7`.
- Ranking: npm scripts and maven artifacts count x0.3 (names like `test`/`build` match too many tasks). 30-task portfolio benchmark: recall 70% (same as after Markdown), tokens ~6.5k.

## Infra links (compose, Kubernetes)

- compose `depends_on` (list or map): an edge between the two service symbols in the same file (`references`, `resolved`, specifier `depends_on`). Unknown service names give no edge.
- Kubernetes: an Ingress `backend` service name and a HorizontalPodAutoscaler `scaleTargetRef` become object references like Secrets already are (`inferred` when one file declares that `Kind/name`, `unresolved` when none does).
- A Service links to workloads in another file whose pod template labels contain all of its `selector` labels (Deployment, StatefulSet, DaemonSet, Job, CronJob; `inferred`: namespaces are ignored). A Service and workload in the same file get no file edge. Parser `config-8`.
- Not done: Helm and kustomize generators, NetworkPolicy selectors, image to manifest. 30-task portfolio benchmark unchanged (70%).

## Agent access (`mcp`, `hook`)

- `src/agent.ts`: a hand-written MCP server over stdio (JSON-RPC 2.0, newline-delimited; `initialize`, `ping`, `tools/list`, `tools/call`) so there is no SDK dependency. Seven read-only tools wrap the query functions; the graph is loaded per call. Unknown methods and bad JSON get JSON-RPC errors.
- `cbtg hook`: Claude Code `UserPromptSubmit` hook; prompt -> `context` (400 token budget) -> `additionalContext`. Silent (empty output, exit 0) on any problem so it can never block a prompt.
- Every tool and hook output ends with a note that graph output is pointers, not instructions (names in the graph come from untrusted repository text).
- Not verified: behaviour in a live MCP client or Claude Code session; only the protocol messages are tested. No token saving is claimed for the hook: it adds context to every prompt, so its value has to be measured (agent benchmark).

## Watch mode

- `src/watch.ts` + `cbtg watch`: recursive `fs.watch` on the repo root; events are debounced (300 ms default) into one incremental `indexRepo` run; runs never overlap (a change during a run schedules one more); ignored folders and the graph directory are skipped so writing the graph does not trigger itself. Indexing errors are reported and watching continues. Stops on SIGINT/SIGTERM.
- Limits: relies on platform file events (recursive `fs.watch` needs Node >= 20; unreliable on some network or container mounts); a rename is seen as a change, the cache then drops the old path on the next run.

## Commit history (`history.ts`)

- Why: on 71 past portfolio pull requests (graph built before each one), 43% of the files a change touched shared no word with the task (Dutch task, English names; texts in data files). Commit messages are in the team's words and already say which files belong to "opstartscherm" or "versieblokken".
- Index: `git -C <root> log --no-merges --relative --name-only -n 2000`. Per commit: first 12 hash characters, commit time, at most 40 message words (lower-cased, 3+ characters, stop words, trailers such as `Co-Authored-By:`, URLs, numbers and hex hashes removed) and the touched files that are indexed. Commits without indexed files (a bot commit that only updates `.cbtg/graph.json`) or with more than 100 are dropped. One commit per line in `graph.json`, newest first.
- Shallow clones: by default the commits of the previous graph that git no longer shows are kept (`history: "merge"`); the benchmark uses `history: "git"` so an older state never sees later commits.
- Ranking: per task word an idf over commits (rare words count more); a commit adds the sum of its matched word weights, divided by log(2 + files touched), to each file it touched (Markdown x0.3). Words match like names do (equal, or one is a 4+ character prefix of the other).
- Context: name ranking (best match + half of further matches; files linked to the five best get 50% (resolved) or 30% (inferred) of that file's score, tests half) and history ranking are merged with reciprocal rank fusion (k = 10). At most 3 symbol lines per file. Without history the name ranking is used as is.
- Measured (`cbtg bench --from-git`, 5 opened files, at least one relevant file found, names only -> names + history): portfolio 39% -> 61% (71 tasks), codebasetograph 76% -> 90% (29), recipes-for-me 33% -> 67% (15). Grep in the same runs: 34%, 97%, 87%.
- Not done: weighting recent commits higher, co-change (files that change together), renames across history (old paths drop out when the file no longer exists).
