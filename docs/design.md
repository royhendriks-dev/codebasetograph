# Design note: MVP skeleton

Status: first slice. Describes what exists in this PR and what is deliberately not built yet.

## Reference research (Graphify)

Looked at `Graphify-Labs/graphify` at commit `10130e79ed9caf8f60d998073e097531eaa1a395` (shallow clone, 2026-10-15). Only the top-level docs (`README.md`, `ARCHITECTURE.md`), `pyproject.toml`, and licence files were read; no source was copied and **no behaviour was executed or verified**. The statements below are what its documentation says (maintainer claims), not verified results.

- Python library plus an agent skill; pipeline `detect → extract → build → cluster → report → export`.
- Code is parsed with tree-sitter (~40 languages), claimed deterministic and offline; docs/media use an LLM pass.
- Graph is a NetworkX graph exported as JSON; edges carry a confidence label (`EXTRACTED`/`INFERRED`/`AMBIGUOUS`).
- Dependencies include networkx, numpy, rapidfuzz, tree-sitter and many grammars. Licence: Apache-2.0 (with retained MIT text for earlier contributions).
- Its README quotes benchmark and token-saving figures. We do not rely on them; none are verified against our projects.

Open Phase 1 work: read the actual extractor and incremental-cache code, run its tests, and measure on a real repo.

## What we took as ideas only

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
| `query.ts` | find, deps, dependents, bounded related walk, budgeted task context |
| `view.ts` | Self-contained HTML explorer generated from the graph: search, symbols per file, imports / imported-by with evidence badges. Repo-derived text is set via `textContent` (untrusted input). Not a graph drawing on purpose |
| `java.ts` | Java via tree-sitter (WASM grammar, parse only): package, imports (incl. static and wildcard), top-level types with annotations (e.g. `@Path`, `@ApplicationScoped`), methods, `extends`/`implements` |
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
- Not covered: same-package use without any import or extends (no edge), usages inside method bodies (no call graph), Maven/Gradle modules, annotation processing and generated sources, Kotlin/Scala. Overloaded methods share one node id.
- Cached facts carry a parser version; facts from an older parser version are re-parsed.
- Checked on a copy of Roy's portfolio repo (60 Java + 73 TS files): 133 files indexed in under a second, no parse errors, no unresolved own-package imports. That is a spot check, not an accuracy measurement.

## Known limits

- TypeScript: file-level imports and top-level declarations only: no call graph, no member-level symbols, duplicate names in one file collapse to one node. Java: see above.
- tsconfig/jsconfig `paths` and `baseUrl` (with relative `extends`) resolve to indexed files as `resolved`; the nearest config wins and an unmatched alias stays an `inferred` package. Not supported: package `exports`, monorepo workspaces, package-based `extends`, Angular template/DI edges.
- `.gitignore` support is partial (no negation, no nested files).
- Context ranking is plain name matching. It is a baseline to measure against, not a claim of quality.
- Only tests in `src/test` were run, on small synthetic fixtures. **No larger real-world repository and no token benchmark has been run yet.**

## Next steps

1. Phase 1: finish Graphify research with verified experiments.
2. Angular template/DI edges.
3. Benchmark harness: grep-based baseline vs graph context on the same tasks (files read, lines, tokens, missed relevant files).
4. Real-repo index timing and incremental timing.
5. Optional adapters (MCP, editor integrations) on top of the same JSON graph.
