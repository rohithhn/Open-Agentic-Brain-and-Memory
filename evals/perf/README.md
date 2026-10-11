# Systems benchmark (evals/perf)

Our own measured equivalents of the latency / token / footprint numbers memory vendors market
(mem0: "91% lower p95 latency, 90% fewer tokens vs full-context"; Zep: latency claims).
Everything is measured on this machine, on synthetic stores, with no network and no real user data.

```
node evals/perf/bench.mjs            # 1k, 10k, 50k, 100k  (a few minutes)
node evals/perf/bench.mjs --quick    # 1k, 10k
node evals/perf/bench.mjs --sizes=1000,25000 --out=/some/path.json
```

Output: `evals/perf/results.json` (machine info, method, every number below) plus a compact table on stdout.
Needs Node >= 22. Semantic ("hybrid") numbers need the MiniLM model and `@huggingface/transformers`;
the bench looks in `evals/longmemeval/data/models` (override with `BRAIN_MODEL_DIR`) and, if absent,
reports hybrid as skipped with the reason instead of failing.

## What is measured

| Area | Measurement |
|---|---|
| Scale | stores of 1k / 10k / 50k / 100k observations, product schema (`ensureSchema`, FTS5 + triggers + lifecycle columns) |
| `recallSearch` | p50 / p95 / p99 over 200 varied queries, BM25-only (`BRAIN_EMBED=0`) and hybrid (BM25 + int8 vector scan fused by RRF) |
| `brain_context` | same, through `taskContext` -> `retrieveContextHybrid` -> `retrieveContext` (the code path the MCP tool runs) |
| Cold start | first query in a fresh process (hybrid includes model load + loading every vector into the matrix) |
| Storage | DB size in MB and bytes/observation, with and without the 384-byte vector per row |
| Ingest | obs/s in 1000-row transactions (with FTS5 triggers), and one-autocommit-per-row (what a capture hook does) |
| Semantic pieces | real query-encode latency (warm), model load time, real doc-embedding throughput, query-embed + vector-scan alone |
| SessionStart | in-process render time of the hook payload on the 10k store, and the real hook process wall time (`node bin/lib/sessionstart.mjs --hook`), plus its byte caps |
| MCP | spawn `node bin/mcp-server.mjs` (temp HOME, `BRAIN_TEST=1`), time to first `initialize` / `tools/list` response, tool count; and end-to-end `tools/call` latency for `brain_recall` / `brain_context` over stdio on the 10k store |
| Token economics | tokens (chars/4) that `brain_context` injects vs dumping every memory into the prompt; the SessionStart size cap |
| Footprint | runtime npm dependencies (0), optional deps, JS lines in `bin/`, model size on disk |

## Method and honest caveats

* **Synthetic data.** Memories are generated deterministically (seeded mulberry32, `SEED` in the file)
  from vocabulary lists: varied titles, 3-6 sentence narratives (~450 chars), JSON facts, concepts, files,
  30 projects, 9 types, 18 months of dates, Zipf-skewed word and identifier choice so there is a realistic
  long tail of rare terms (identifiers, error codes, file paths). No personal data. Absolute BM25 latency
  depends on corpus term statistics; real stores will differ, the scaling shape should not.
* **Queries.** 200 deterministic queries of 1-14 tokens in 8 shapes ("how did we fix the X in Y",
  identifier + tech, error code, decision questions, file path, single noun...). `brain_recall` ORs
  every token, so long queries are the realistic worst case for FTS5 ranking. No project filter.
* **Vectors.** Computing 100k real embeddings (~170 docs/s here) would take ~10 minutes per store, so the
  latency stores get random int8 unit vectors (dim 384, `x * 127`, same table and layout as
  `brain embed --apply`). The scan cost depends only on row count and dimension, not vector content.
  So the semantic/fusion path is exercised rather than short-circuited (random vectors never pass the
  `MIN_SIM = 0.3` floor), the first 40 queries get "planted" neighbour rows at cosine 0.42-0.82 to the
  real embedding of that query; other queries find hits through their similarity to those. Because the
  vectors are synthetic, **this bench measures speed, not retrieval quality** (see `evals/longmemeval`
  for quality).
* **Real embedder.** One query encode is timed warm with the real quantized MiniLM through `getEmbedder`
  (100 encodes after a warm-up inference). The hybrid rows include it (plus the scan) on every query.
* **Process model.** `retrieveContext` reads the module-level `MEMORY_DB`, so each measurement runs in a
  child process whose `HOME` is the temp dir (the store sits at `$HOME/.claude-brain/brain.db` with its
  `READY` marker). The parent never imports `bin/lib`. Timings are wall-clock inside one warm process;
  `recallSearch` opens/closes its read-only handle per call, exactly as in the product.
* **brain_context as shipped** also searches this repo's `wiki/`, `learnings/` and workflows (read-only).
  That part is not synthetic and does not scale with store size; the token section therefore reports an
  obs-only variant (wiki/learnings/workflows off) next to the as-shipped one.
* **Cold start** is a fresh process but the OS page cache is warm (the file was just written), so a
  true cold-disk first query can be slower.
* **Full-context baseline** for the token comparison is every observation rendered as
  `- [project] title: narrative` with no truncation. That is the "dump the memory store" baseline;
  it grows linearly, `brain_context` is capped by its 8000-char budget (~2k tokens) and 6 rows.
* Single machine, single run, no pinning of CPU frequency; treat sub-millisecond differences as noise.

## Safety

`evals/perf/bench.mjs` imports `../test-env.mjs` first (`BRAIN_TEST=1`). Every store and every child's
`HOME` live in an `fs.mkdtemp` directory removed in a `finally` (and on SIGINT/SIGTERM/crash). Children
get an explicit env: no inherited `BRAIN_*` overrides, `HOME`/`USERPROFILE` = temp, `BRAIN_TEST=1`.
Workers refuse to run unless `HOME` is a bench temp dir. `~/.claude-brain`, `~/.claude*`, `~/.codex`,
`~/.cursor`, `~/.gemini` and `config.json` are never opened or written.
