# Benchmark harness

`cbtg bench <tasks.json> [--files n] [--budget tokens]` compares two ways of finding code for the same task, with the same cap on opened files:

- **grep baseline:** case-insensitive search for every task word over the indexable files, open the files with the most matches.
- **graph context:** `cbtg context` output, open the files it lists.

Per task it reports files, source lines and approximate tokens (chars / 4) read, recall and precision against the files you list as relevant, and lookup latency. One-time indexing cost is reported separately by `cbtg index` and is not part of the table.

Task file:

```json
[{ "id": "login", "task": "change the login guard token check", "relevant": ["src/app/auth.guard.ts"] }]
```

Limits, stated plainly:

- Recall and precision are only as good as the `relevant` lists. Write them by hand from real changes (for example files touched in past commits), not from the tool's own output.
- Tokens are an approximation, not a model tokenizer. Fewer tokens with lower recall is not an improvement.
- Final task quality (did the agent finish the change) is not measured here.
- `docs/bench-tasks.example.json` targets this repository and is a smoke test only. No claim about token savings follows from it.
