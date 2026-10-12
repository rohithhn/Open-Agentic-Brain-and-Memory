# LongMemEval-S — retrieval results

> **Update 2026-10-02: pseudo-relevance feedback (`bin/lib/prf.mjs`) now ships.** `results.json` is the
> run with it. Main setting (round units, `brain_recall`, hybrid): any@1 87.7 (=), any@5 98.3 (=),
> any@10 98.9 (=), **all@5 84.7 → 87.4, all@10 91.7 → 94.3, ndcg@10 90.5 → 91.2**. Over all 784 numbers
> in `results.json`: 716 unchanged, 60 up, 8 down (largest: multi-session unit_any@10 95.0 → 92.6, i.e.
> 3 of 121 questions; temporal any@5 96.1 → 95.3, 1 question). Faithfulness check 20/20. The tables
> below are the pre-PRF run; method and selection in `evals/multihop/RESULTS.md`.

> **End-to-end QA accuracy (2026-10-02, `qa.mjs`, all 500 questions incl. 30 abstention, Claude Sonnet reader):**
>
> | run | Claude judge | GPT judge (gpt-6-luna via codex, `evals/rejudge-gpt.mjs`) | agreement |
> |---|---:|---:|---:|
> | k=20 rounds, pre-PRF (`qa-main.json`) | 88.2 | 84.8* | 95.4 |
> | k=20 rounds, PRF (`qa-prf.json`) | 89.2 | – | – |
> | k=40 rounds, PRF (`qa-prf-k40.json`) | 92.8 | 92.2 | 98.6 |
> | **k=40 rounds, PRF + deep recall (`qa-deep-k40.json`, rerank 256 tok)** | **94.2** | **93.4** | **98.8** |
> | same retrieval, **gpt-6-luna reader + judge** via OpenAI API (`qa-luna-deep-k40.json`, 2026-10-08) | – | 90.0 (Luna judge) | – |
>
> **LongMemEval-M** (2026-10-08, `qa-m-luna-deep-k40.json`): the large variant, ~1.27M tokens of history per question
> (~2,500 rounds, ~500 sessions; too large to give any current model in full). Same search, gpt-6-luna reader + judge:
> **83.0** on all 500 (S on the same setup: 90.0). The reader saw ~19k tokens per question, 98.5% less than the
> history; all evidence was in context for 97.9% of answerable questions. By type: single-session-assistant 100,
> single-session-user 94.3, knowledge-update 92.3, temporal 80.5, multi-session 72.9, preference 56.7. ~$1.
> Streamed one question at a time (`stream.mjs`, ~0.7 GB peak memory).
>
> deep-k40 by type (Claude judge): single-session user/assistant/preference 100, knowledge-update 96.2, temporal 91.7,
> multi-session 88.7, abstention 90.0; evidence in context 99.6%; ~30k reader tokens; deep retrieval p50 2.4 s.
> Luna run by type: single-session-assistant 100, single-session-user 98.6, knowledge-update 94.9, temporal 88.0,
> preference 83.3, multi-session 82.0 (~$1). Same search, weaker reader: about 4 points below the Claude reader.
> k=40 (pre-deep) by type (Claude judge): single-session-user 100, single-session-assistant 98.2, knowledge-update 97.4,
> preference 96.7, temporal 91.0, multi-session 85.0, abstention 90.0. About 31.7k reader tokens per question
> against about 127.6k for the full history. Judge prompts are LongMemEval's own (`prompts.mjs`).
> *The main run stored only the last 600 chars of each answer; the GPT judge therefore missed the
> personalisation at the start of preference answers (46.7 vs 96.7). Later runs store full answers.

_Run 2026-10-01 on branch `overnight-roadmap`, after the `brain_context` query fix (see "Before / after"). Full set, no subset. Numbers are copied from
[`results.json`](results.json), which the harness writes; a second run from the embedding cache gave
byte-identical results. The full run was repeated after the `brain_context` BM25 depth was corrected
from 60 to the product's 50: only the round-unit `brain_context` hybrid numbers changed (overall by at
most 0.3 points; by type, single-session-assistant any@1 82.1 → 80.4). Every other number was unchanged._

## What this measures (and what it does not)

**Retrieval only.** For each question we ask: does the brain's own search put the chat session that
holds the answer near the top of that question's history? Nobody reads the retrieved text, no answer
is generated, no LLM judges anything.

**These are not LongMemEval QA-accuracy numbers.** Leaderboards for memory products usually report QA
accuracy: an LLM answers from what was retrieved and another LLM grades it. That is a different, harder
metric. Do not compare the numbers below to those.

## Dataset

| | |
|---|---|
| Source | Hugging Face `xiaowu0162/longmemeval-cleaned` (the maintainers' Sept 2025 replacement for the original `xiaowu0162/longmemeval`, with noisy history sessions removed) |
| Revision | `98d7416c24c778c2fee6e6f3006e7a073259d48f` (pinned in `run.mjs`) |
| File | `longmemeval_s_cleaned.json`, 277,383,467 bytes, sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` (checked on every run) |
| Questions | 500 in the file. **470 scored**: the 30 abstention questions (`*_abs`) have no evidence to retrieve and are excluded, as in the official retrieval evaluation |
| Haystack | about 48 sessions (about 490 turns) per question; 94,955 distinct texts embedded across all questions (unique by text hash) |

## Method

1. **One store per question.** Each question's haystack goes into a fresh temporary SQLite store with the
   product schema (`bin/lib/store.mjs`). BM25 term statistics therefore come from that one history, the
   way a user's brain holds one history. The store is deleted afterwards. The real `~/.claude-brain`
   is never opened.
2. **Units.** Each session becomes observations at two granularities, and both are reported:
   - **round**: one user turn plus the assistant reply after it (an assistant turn with no user turn
     before it is a round of its own). This is the main setting.
   - **session**: the whole session as one observation.

   Each observation's `narrative` is the raw turns (`user: … / assistant: …`). There is no title, no
   facts and no distillation, so this is a harder input than the brain's usual distilled memories.
   Thirteen haystacks list the same session id twice; both copies are kept.
3. **Embeddings.** The product's model and settings (`bin/lib/embed.mjs`): `Xenova/all-MiniLM-L6-v2`,
   q8, mean pooling, normalized, int8-quantized, over `embedText()`, which is **the first 1,200 chars**
   of the unit. Vectors are written to `observation_vectors` exactly as `brain embed --apply` writes them.
4. **Queries.** Two ways the product turns a question into a search:
   - **recall** is `brain_recall`'s query: every token OR'd (`ftsMatchExpr`), input capped at 200 chars.
   - **context** is `brain_context`'s query (`bm25Query`): since the fix it is the same builder as recall,
     every token OR'd (`ftsMatchExpr`), input capped at 300 chars. Before the fix it was the first six
     words longer than 3 chars, OR'd.
5. **Ranking.**
   - **bm25**: FTS5 `rank`. Each query fetches the BM25 depth its tool fetches: 60 rows for **recall**
     (`recallSearch` at limit 20: max(20×3, 50)) and 50 for **context** (`retrieveContext` at its
     default limit 6: max(6×3, 50)).
   - **hybrid**: that BM25 list fused with `semanticSearch()` (top 50, cosine ≥ 0.3) by RRF (k=60,
     `fuseRows`), as `recallSearch()` and `retrieveContext()` do. The RRF input therefore matches each
     tool exactly. The one place we go deeper than the product: `brain_context` in BM25-only mode
     fetches 18 rows, and we fetch 50. That is a prefix of the same FTS5 order, so no rank changes; it
     only lets @10 be scored.

   Both then go through `rerankByLifecycle` (a no-op here, since every row is active) and keep the top
   50 units. A consistency check runs on the first 5 questions: our top 20 must equal what
   `recallSearch({limit: 20})` returns on the same store. **20 of 20 comparisons were identical.** The
   harness would fail if hybrid were requested and semantic search were unavailable, so BM25 results are
   never reported under the hybrid label.
6. **Metrics** (the paper's "retrieve rounds, report sessions" convention):
   - Ranked units are deduplicated to sessions in first-seen order.
   - `recall_any@k`: at least one evidence session (`answer_session_ids`) is in the top k sessions.
   - `recall_all@k`: every evidence session is in the top k sessions.
   - `ndcg_any@k`: binary-relevance NDCG.
   - `unit_any@k`: a round carrying the dataset's `has_answer` flag is itself in the top k rounds
     (round granularity only).
   - Values are means over the 470 questions, in percent.

   These metrics follow the definitions in the LongMemEval paper, but this is **our implementation**,
   not the official retrieval script. Our units and truncation differ from its setups, so the numbers
   are not directly comparable to the paper's tables.

Dates are stored but never used for ranking; nothing here does temporal reasoning.

## Results

### Main: round units, `brain_recall` query (470 questions)

| metric | BM25 | hybrid (BM25 + MiniLM, RRF) | Δ |
|---|---:|---:|---:|
| recall_any@1 | 85.3 | **87.7** | +2.4 |
| recall_any@3 | 93.2 | **96.0** | +2.8 |
| recall_any@5 | 96.0 | **98.3** | +2.3 |
| recall_any@10 | 98.1 | **98.9** | +0.8 |
| recall_all@5 | 81.1 | **84.7** | +3.6 |
| recall_all@10 | 89.4 | **91.7** | +2.3 |
| ndcg_any@10 | 88.4 | **90.5** | +2.1 |
| unit_any@1 (exact evidence round first) | **59.4** | 53.6 | **−5.8** |
| unit_any@5 | 84.3 | **86.0** | +1.7 |
| unit_any@10 | 91.1 | **93.6** | +2.5 |

### Other settings (recall_any@1 / @5 / @10 · recall_all@5 / @10 · ndcg@10)

| setting | BM25 | hybrid |
|---|---|---|
| session units, `brain_recall` query | **87.9** / **97.0** / 98.9 · 83.6 / 90.4 · **90.4** | 84.3 / 96.8 / **99.1** · **84.7** / **91.1** · 89.5 |
| round units, `brain_context` query | 85.3 / 96.0 / 98.1 · 81.1 / 89.4 · 88.4 | **87.9** / **98.3** / 98.9 · **84.9** / **91.7** · **90.6** |
| session units, `brain_context` query | **87.9** / **97.0** / 98.9 · 83.6 / 90.4 · **90.4** | 84.3 / 96.8 / **99.1** · **84.7** / **91.1** · 89.5 |

### By question type: round units, `brain_recall` query

| type | n | BM25 any@1 | hybrid any@1 | BM25 any@5 | hybrid any@5 | BM25 all@5 | hybrid all@5 |
|---|---:|---:|---:|---:|---:|---:|---:|
| single-session-user | 64 | **93.8** | 90.6 | 100 | 100 | 100 | 100 |
| single-session-assistant | 56 | 100 | 100 | 100 | 100 | 100 | 100 |
| single-session-preference | 30 | 40.0 | **70.0** | 76.7 | **96.7** | 76.7 | **96.7** |
| knowledge-update | 72 | **95.8** | 94.4 | 100 | 100 | 94.4 | 94.4 |
| multi-session | 121 | 83.5 | **87.6** | 96.7 | **98.3** | 63.6 | **69.4** |
| temporal-reasoning | 127 | 81.1 | 81.1 | 93.7 | **96.1** | 73.2 | **76.4** |

Per-question wins and losses of hybrid against BM25 (round units, `brain_recall` query):

| metric | hybrid better | hybrid worse |
|---|---:|---:|
| any@1 | 27 | 16 (7 temporal, 3 knowledge-update, 3 multi-session, 3 single-session-user) |
| any@5 | 11 | 0 |
| all@5 | 22 | 5 |

## Before / after: `brain_context` query fix (2026-10-01)

`brain_context` (and every other caller of `retrieveContext`) built its FTS5 query with `bm25Query`:
the first six words longer than 3 chars. It now uses `brain_recall`'s `ftsMatchExpr` (quoted tokens OR'd,
300-char input cap; the builder lives in `bin/lib/fts.mjs`, re-exported by `recall.mjs`). `brain_recall`
itself is untouched: all four `recall` rows in `results.json` are byte-identical before and after.
"Before" is the previous run of this harness on commit `d8c8f5a` (`results.json` at that commit).

`brain_context` query, round units, 470 questions (the main setting):

| metric | BM25 before | BM25 after | hybrid before | hybrid after |
|---|---:|---:|---:|---:|
| recall_any@1 | 67.7 | **85.3** (+17.6) | 83.4 | **87.9** (+4.5) |
| recall_any@3 | 84.9 | **93.2** (+8.3) | 95.5 | **96.0** (+0.5) |
| recall_any@5 | 88.5 | **96.0** (+7.5) | 97.7 | **98.3** (+0.6) |
| recall_any@10 | 92.6 | **98.1** (+5.5) | 99.1 | 98.9 (−0.2) |
| recall_all@5 | 66.6 | **81.1** (+14.5) | 80.6 | **84.9** (+4.3) |
| recall_all@10 | 76.0 | **89.4** (+13.4) | 86.8 | **91.7** (+4.9) |
| ndcg_any@10 | 75.3 | **88.4** (+13.1) | 87.5 | **90.6** (+3.1) |
| unit_any@1 | 40.4 | **59.6** (+19.2) | 46.8 | **54.0** (+7.2) |
| unit_any@5 | 71.7 | **84.3** (+12.6) | 84.0 | **85.7** (+1.7) |
| unit_any@10 | 81.1 | **91.1** (+10.0) | 92.8 | **93.6** (+0.8) |

By question type, round units, `brain_context` query, any@1 before → after:

| type | n | BM25 | hybrid |
|---|---:|---:|---:|
| single-session-user | 64 | 92.2 → 93.8 | 92.2 → 90.6 |
| single-session-assistant | 56 | 32.1 → 100 | 80.4 → 100 |
| single-session-preference | 30 | 30.0 → 40.0 | 63.3 → 70.0 |
| knowledge-update | 72 | 90.3 → 95.8 | 94.4 → 95.8 |
| multi-session | 121 | 70.2 → 83.5 | 83.5 → 87.6 |
| temporal-reasoning | 127 | 64.6 → 81.1 | 78.7 → 81.1 |

Session units, `brain_context` query: BM25 any@1 70.0 → 87.9, all@5 67.7 → 83.6; hybrid any@1 80.2 → 84.3,
all@5 78.7 → 84.7. Every BM25 number rose; the few hybrid regressions are small: single-session-user any@1
92.2 → 90.6 (one question), knowledge-update all@5 97.2 → 94.4, round-unit any@10 99.1 → 98.9.

Why single-session-assistant moves most (32.1 → 100 BM25): those questions open with a preamble ("I'm
checking our previous chat about…", "I was wondering if you could remind me…") that used up the six
slots before the identifying words (a name, a place, a dish), so the old builder never searched for them.

**In-domain check (`brain eval`, `evals/questions.jsonl`, 139 questions).** Run with a fake `HOME` holding a
`.backup` copy of the real store (43,807 observations; the copy has no embedding vectors, so this is BM25
retrieval, which is also what `brain_context` does for a user who has not run `brain embed`). Same
questions, old code from `git archive d8c8f5a`, new code from the working tree, both from throwaway
copies under `/tmp` so no report file landed in the repo:

| | questions answered | full brain | raw-obs baseline |
|---|---:|---:|---:|
| before | 96 / 139 | 69% | 69% |
| after | **121 / 139** | **87%** | **87%** |

26 questions flipped to a hit and one flipped to a miss (`gtm-approval-insert`: a long OR query pulls
more rows of the same project ahead of the one that carries the answer). Net +25.

## Where we lose (honestly)

- **Exact top-1 round.** Hybrid puts the precise evidence round first less often than BM25 (53.6 vs
  59.4). Fusion lifts rounds that are *about* the topic, often in the right session, over the round
  whose exact words answer the question. The session-level any@1 still goes up, which is why this only
  shows in `unit_any@1`.
- **Hybrid on whole sessions is not better at the top.** With session units, hybrid loses any@1 (84.3
  vs 87.9). It is worse on 26 questions and better on 9, mostly single-session-user, knowledge-update
  and temporal questions. The cause is our 1,200-char embedding cap: the model sees only the start of a
  roughly 10-turn session, so the semantic list is noise for evidence that appears later in the session.
  This matters for the product, because long raw observations get the same truncation.
- **Multi-session questions.** When the answer is spread over several sessions, getting *all* of them
  into the top 5 is the weak spot: 63.6% with BM25 and 69.4% with hybrid. Temporal reasoning is second
  worst (73.2 and 76.4). Retrieval ignores dates entirely.
- **Preferences with plain BM25.** Questions like "can you recommend…" share few words with the session
  where the user stated the preference. BM25 gets 40% at @1 and hybrid gets 70%.
- **`brain_context` used to have a weak keyword query** (fixed, see "Before / after"). It took only the
  first six long words, which dropped BM25 from 85.3 to 67.7 at @1; hybrid mostly hid this (83.4)
  because the embedding sees the whole question. The fix gives it recall's query, so context and recall
  now match on BM25 (any@1 85.3 for both, any@5 96.0, all@5 81.1) and differ only by the input cap (300
  vs 200 chars; one round-unit `unit_any@1` point of difference: 59.6 vs 59.4).

## Cold start: first search in a fresh MCP server (S10, 2026-10-01)

Not a LongMemEval number; it lives here because it uses the same cached model. Question: with vectors in
the store, how long does the first `brain_recall` take in a freshly spawned `bin/mcp-server.mjs`
(library import + model load + reading every vector), against the server's 10 s per-call deadline?

Setup: a copy of the real store (43,807 observations; `sqlite3 ... ?immutable=1 ".backup"` into
`/tmp/s10/home/.claude-brain/brain.db`), backfilled with `runEmbed --apply` into that copy (43,807
vectors, 9.2 min) using a model cache copied to `/tmp/s10/models`. Nothing under the real
`~/.claude-brain` was written. Each run spawns N servers at once and sends initialize, then three
`brain_recall` calls (`evals/longmemeval/coldstart.mjs`). N > 1 is many apps starting their servers
together (each app runs its own). "Throttled" runs everything under `taskpolicy -b` (background QoS,
efficiency cores) as a stand-in for a slower or busy Mac. Apple M5, 10 cores, 16 GB, Node 26, page
cache warm (a truly cold disk would add to every row). Times in ms, min / median / max over the N
servers.

Where a single idle cold start goes (one process, `getEmbedder` then `semanticSearch`): library import
40-53, model load 55, first query embedding 3, vector matrix read 82 (767 the first time after the copy,
cold page cache), warm search 21-23. RSS 12 MB at start, 38 after the library, 112 after the model,
about 180 with the matrix.

Before (commit c1bb46a: model and matrix loaded inside the first query, no budget):

| servers | first recall | 2nd | 3rd | RSS after searching (MB) |
|---|---|---|---|---|
| 1, idle | 242-279 | 75-88 | 22-24 | 268-270 |
| 8 | 742 / 799 / 809 | 160 / 176 / 200 | 39 / 60 / 65 | 209-241 |
| 16 | 2190 / 2283 / 2452 | 318 / 409 / 460 | 114 / 201 / 254 | 166-212 |
| 32 | 3859 / 4551 / 5202 | 512 / 989 / 1294 | 51 / 256 / 527 | 116-166 |
| 1, throttled | 2226 | 355 | 112 | 267 |
| 8, throttled | 3539 / 3597 / 3729 | 1057 / 1134 / 1468 | 184 / 425 / 440 | 261-278 |
| 16, throttled | 6861 / 7380 / 7701 | 2236 / 2405 / 2616 | 300 / 728 / 918 | 259-269 |
| 24, throttled | **10824 / 12324 / 13542** | 2674 / 3211 / 3612 | 262 / 853 / 1145 | 118-159 |

So yes, it can pass the deadline: with 24 servers starting at once on a throttled CPU every first recall
took over 10 s. (RSS under heavy concurrency reads low because macOS compresses memory under pressure.)
BM25 alone (`BRAIN_EMBED=0`) for reference: 62 / 51 / 2 ms idle, RSS 57 MB; 1298 / 1457 / 1545 ms for
the first recall with 24 throttled servers.

Profile of one of 24 throttled cold starts: library import ~1.1 s, model load ~2.0 s (creating the ONNX
session is one synchronous block on the main thread), reading the 43.8k vectors ~2.2 s (one synchronous
`SELECT`). Nothing else in the process, timers included, runs during a synchronous block.

The fix (bin/lib/embed.mjs, bin/mcp-server.mjs):
- The MCP server gives semantic search a cold-start budget of 2.5 s (`SEMANTIC_BUDGET_MS`). The first
  query waits at most that long for model + vectors, then answers with BM25 alone; the load carries on
  in the background and later queries are hybrid. The budget is per cold start, not per query: a query
  that arrives while a load has already outlasted it gets BM25 at once instead of waiting again. The
  CLI (`brain recall`) passes no budget and waits, as before.
- The vectors are read in chunks of 2,000 inside one read transaction, yielding to the event loop
  between chunks, and only after the model has loaded (a store whose model will not load never reads
  them).
- Memory: the model still loads only when a search arrives, and only when the store has vectors and
  `BRAIN_EMBED` is not `0`. A server that never searches stays at ~49 MB. `BRAIN_EMBED_PREWARM=1` loads
  model + vectors in the background right after initialize, for a single long-lived server (a desktop
  app) that wants hybrid search from its first call. It is off by default because it costs every server
  ~200 MB whether or not it ever searches.

After:

| servers | first recall | 2nd | 3rd | RSS after searching (MB) | BM25 fallbacks per server |
|---|---|---|---|---|---|
| 1, idle | 236-260 | 77-82 | 20-22 | 240-246 | 0 |
| 8 | 535 / 595 / 612 | 151 / 170 / 175 | 32 / 39 / 52 | 234-249 | 0 |
| 16 | 1195 / 1289 / 1429 | 236 / 278 / 349 | 29 / 68 / 95 | 230-261 | 0 |
| 32 | 2851 / 3225 / 3781 | 467 / 684 / 1053 | 73 / 205 / 333 | 146-206 | 0 (1 server: 1) |
| 1, throttled | 1232 | 420 | 98 | 240 | 0 |
| 8, throttled | 3524 / 3773 / 3902 | 961 / 1050 / 1210 | 111 / 372 / 399 | 224-261 | 0 (1 server: 3) |
| 16, throttled | 3985 / 4451 / 4609 | 887 / 1032 / 1528 | 33 / 166 / 629 | 180-192 | 3 |
| 24, throttled | **5192 / 5613 / 5984** | 1556 / 1775 / 2730 | 98 / 1045 / 1234 | 164-184 | 3 |

Up to 16 servers on an unthrottled CPU every query is hybrid, the first one included, at the same speed
as before. Under the heaviest load the first recall drops from 10.8-13.5 s (past the deadline) to
5.2-6.0 s, at the price of BM25-only answers until the model is in. It is not 2.5 s because BM25
itself takes ~1.4 s under that load, and the background load's synchronous blocks (ONNX session
creation, library evaluation) delay everything queued behind them; with `BRAIN_DEBUG=1` the semantic
step reports giving up at 2.53-2.82 s. Moving the model into a worker thread would remove the second
part; not done here. Throttled runs are noisy: the single-server throttled row moved by about 1 s
between otherwise identical runs, so read the before/after difference there as noise.

Opt-in prewarm, 2 s think time between initialize and the first search: first recall 277 ms without,
111 ms with; RSS right after initialize 49 MB without, 253 MB with. With 8 servers and 3 s think time:
first recall 152 / 183 / 205 ms, RSS after initialize 232-252 MB.

Reproduce (the copy of the real store is made by `evals/lib/private-copy.mjs`: a 0700 directory, a 0600
file, read through an immutable backup, deleted when the run ends however it ends; never copy the real
store by hand into `/tmp`). `--backfill` runs `runEmbed --apply` into the private copy (about 9 minutes
for 43,807 observations), so do it once and run every measurement inside the same process, where the
copy is the fake `$HOME`:

    cp -R evals/longmemeval/data/models "$SCRATCHPAD/s10-models"      # the model cache is public data
    node evals/lib/private-copy.mjs --home -- sh -c '
      node evals/longmemeval/coldstart.mjs --home "$HOME" --models "$M" --backfill --n 8
      taskpolicy -b node evals/longmemeval/coldstart.mjs --home "$HOME" --models "$M" --n 24
      node evals/longmemeval/coldstart.mjs --home "$HOME" --models "$M" --delay 2000 --env "{\"BRAIN_EMBED_PREWARM\":\"1\"}"'
    # (export M="$SCRATCHPAD/s10-models" first)

`coldstart.mjs --real` does the copy itself for a single measurement.

## Caveats

- LongMemEval is English personal-assistant chat (ShareGPT/UltraChat filler plus synthetic evidence
  sessions), not coding-session memory. Our own eval (`brain eval`, `evals/questions.jsonl`) is the
  in-domain check.
- The evidence sessions are topically distinct from the filler, so session-level recall on LongMemEval-S
  is high for any competent lexical retriever. The informative numbers are @1, `recall_all`, and the
  per-type rows.
- Depth: `brain_recall` returns at most 20 memories and `brain_context` injects at most 6. The @k
  metrics here are scored on a ranking up to 50 units deep.

## Reproduce

    node evals/longmemeval/run.mjs                    # full set; downloads the dataset + model into evals/longmemeval/data/ (gitignored)
    node evals/longmemeval/run.mjs --stride 10        # deterministic subset: every 10th question by id
    node evals/longmemeval/run.mjs --limit 20 --bm25-only
    node evals/longmemeval-test.mjs                   # unit tests (synthetic data, no download)

Cost on this Mac (10-core Apple silicon, 16 GB):
- First run: about 80 minutes, almost all of it embedding the 94,955 distinct texts at about 20 per
  second on the CPU, in one process. (Our log shows 94,217 of them embedded in that run: 738 were already
  cached from an earlier partial run.) A second process made both slower.
- Every later run: about 2 minutes, because vectors are cached by text hash in
  `data/embed-cache.db`.

Per-question rows are in `data/per-question.jsonl`.

## Notes on the run files (added 2026-10-12)

- The `config.retrieval` strings in `qa-prf.json` and `qa-prf-k40.json` omit pseudo-relevance
  feedback, but both runs used it (the context given to the reader matches a PRF ranking on every
  question). `qa-main.json` is the run without it.
- The deep-recall LongMemEval runs truncated each cross-encoder pair to 256 tokens through the
  `BRAIN_RERANK_MAX_TOKENS` environment variable; the run files do not record this.
- `longmemeval_m_cleaned.json` (used by `qa-m-luna-deep-k40`) comes from the same Hugging Face
  revision `98d7416c24c778c2fee6e6f3006e7a073259d48f`; 2,737,100,077 bytes, sha256
  `9d79e5524794a2e6900a3aa9cb7d9152c5a3e8319c9a87c25494ba1eacee495f`.
- In `qa-main` and `qa-prf`, stored answers keep only their last 600 characters.
