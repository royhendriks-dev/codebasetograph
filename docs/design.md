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
| `cli.ts` | `cbtg` commands |

Language choice: TypeScript/Node, because the TS compiler API is the most accurate parser for TS/Angular and matches the primary stack. Python+tree-sitter was not evaluated yet; revisit when more languages are needed.

## Data model

- Nodes: `file:<relpath>`, `sym:<relpath>#<name>` (with line range, kind, exported flag, Angular role), `pkg:<name>`. Ids contain no absolute paths.
- Edges: `imports`, `reexports`, `declares`.
- Evidence: `extracted` (syntax), `resolved` (import matched to indexed file), `inferred` (bare specifier assumed to be an npm package), `unresolved` (relative import with no target).

## Incremental updates

Per-file facts are cached by SHA-256 of content. Changed files are re-parsed, deleted files dropped, and cross-file links are **always recomputed from all facts**. This costs little and removes the class of stale-edge bugs. A corrupt or unknown-version graph file is ignored and rebuilt. Writes go through a temp file and rename.

## Known limits

- File-level imports and top-level declarations only: no call graph, no member-level symbols, duplicate names in one file collapse to one node.
- No tsconfig `paths`, package `exports`, monorepo workspaces, or Angular template/DI edges. Aliased imports show as `inferred` packages.
- `.gitignore` support is partial (no negation, no nested files).
- Context ranking is plain name matching. It is a baseline to measure against, not a claim of quality.
- Only tests in `src/test` were run, on small synthetic fixtures. **No larger real-world repository and no token benchmark has been run yet.**

## Next steps

1. Phase 1: finish Graphify research with verified experiments.
2. tsconfig path resolution and Angular template/DI edges.
3. Benchmark harness: grep-based baseline vs graph context on the same tasks (files read, lines, tokens, missed relevant files).
4. Real-repo index timing and incremental timing.
5. Optional adapters (MCP, editor integrations) on top of the same JSON graph.
