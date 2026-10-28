# Benchmark harness

`cbtg bench <tasks.json> [--files n] [--budget tokens]` compares two ways of finding code for the same task, with the same cap on opened files:

- **grep baseline:** case-insensitive search for every task word over the indexable files, open the files with the most matches.
- **graph context:** `cbtg context` output, open the files it lists.

Per task it reports files, source lines and approximate tokens (chars / 4) read, recall and precision against the files you list as relevant, and lookup latency. One-time indexing cost is reported separately by `cbtg index` and is not part of the table.

## From git history: `cbtg bench --from-git`

`cbtg bench --from-git [--ref ref] [--tasks n] [--files n] [--budget tokens] [--no-history]` needs no task file. Every commit on the first-parent line of `ref` (default `HEAD`) is a task: a squash-merged or merged pull request, or a direct commit. The task is its title (for a merge commit, the pull request title on its second line; ticket prefixes like `ABC-12` and a trailing `(#12)` are dropped). The ground truth is the files it modified that the index knows; added files are left out (no search can find a file that does not exist yet) and so is Markdown (a README or changelog updated alongside every change would reward text search for bookkeeping). Dependency bumps, releases, changelog updates and `chore:` commits are skipped, and so are commits with more than 12 relevant files.

No hindsight: for each task the repository is checked out at the commit before it, in a temporary git worktree with hooks disabled and Git LFS files left as pointers, and indexed there with only the history git shows at that point. Both approaches search that state. Tasks run oldest first, so indexing is incremental. The worktree is removed afterwards. `--no-history` indexes without commit history, to see what the history adds.

Besides the table it reports how often at least one relevant file was among the opened files, and the mean reciprocal rank of the first one (1 = always first, 0.5 = on average second).

## Task file

Task file:

```json
[{ "id": "login", "task": "change the login guard token check", "relevant": ["src/app/auth.guard.ts"] }]
```

Limits, stated plainly:

- Recall and precision are only as good as the `relevant` lists. Write them by hand from real changes (for example files touched in past commits), not from the tool's own output.
- Tokens are an approximation, not a model tokenizer. Fewer tokens with lower recall is not an improvement.
- Final task quality (did the agent finish the change) is not measured here.
- `docs/bench-tasks.example.json` targets this repository and is a smoke test only. No claim about token savings follows from it.
