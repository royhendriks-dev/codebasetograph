# Changelog

Alle noemenswaardige wijzigingen per release. Versies volgen [semver](https://semver.org/lang/nl/). De versie staat in `package.json`; de tag is `vX.Y.Z`.

## [Unreleased]

### Toegevoegd
- Generieke tree-sitter-extractor (`src/treesitter.ts`) met Python, Go en C#: declaraties, methoden en imports/`using`, plus koppelingen tussen bestanden (`src/linkTreeSitter.ts`). De grammatica's komen uit het bestaande `tree-sitter-wasms` en worden pas geladen als er zulke bestanden zijn.

## [1.0.0] - 2026-10-25

Eerste release van `cbtg`, een lokale, provideronafhankelijke code-graph voor coding agents.

### Toegevoegd
- Indexeren van TypeScript/JavaScript en Java (tree-sitter WASM): imports, declaraties, tsconfig-aliassen en Angular-koppelingen (componenten, directives, pipes).
- Config- en infrabestanden: Dockerfile, CI, Docker Compose, Kubernetes/Kustomize, nginx, SQL, `.properties`/`.env.example` (alleen sleutelnamen), `package.json`/`pom.xml` en Markdown-koppen en -links.
- Koppelingen tussen frontend en backend via HTTP-paden (inferred), tests aan hun bronbestand, Compose `depends_on`, Ingress-backends, HPA-targets en Service-selectors.
- Queries: `context`, `find`, `deps`, `dependents`, `related`, `explain` en `path`, met bewijsniveaus extracted, resolved, inferred en unresolved.
- `cbtg bench`: grep-baseline tegen graph-context op taken met bekende relevante bestanden; Nederlandse stopwoorden, glossary en `--synonyms`.
- `cbtg view` en `cbtg view --graph`: HTML-verkenner en getekende graph.
- `cbtg watch`, `--graph-dir` (graph buiten de repo) en incrementeel indexeren.
- `cbtg mcp` (MCP-server) en `cbtg hook` (Claude Code prompt-hook).
- `cbtg install claude|agents|git`: skill, beheerd AGENTS.md-blok en git-vriendelijke `graph.json` met GitHub Action.
- CI met testdekking van minimaal 80% en SonarCloud-quality gate.
- Releaseflow: `develop` voor features en bugfixes, release via PR `develop` -> `main`, workflow `Release` voor tag en GitHub Release.
