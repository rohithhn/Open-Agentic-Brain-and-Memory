# LoCoMo end-to-end QA

LLM-judge accuracy ("J") on LoCoMo, the benchmark mem0 publishes on. The brain
retrieves, an LLM answers from the retrieved memories, a second LLM call judges
the answer against the gold answer. Companion to `evals/longmemeval/qa.mjs`.

For reference, mem0's paper reports J: mem0 66.9, mem0-graph 68.4, Zep ~66,
LangMem 58.1, OpenAI memory 52.9, full-context 72.9 (categories 1-4 only).

## Result (2026-10-02, `qa-main.json`)

All 1,540 scored questions, round units, k=20, Claude Sonnet reader and judge.

| | J |
|---|---:|
| **Overall** | **80.5** |
| single-hop (cat 4, n=841) | 88.5 |
| temporal (cat 2, n=321) | 81.9 |
| open-domain (cat 3, n=96) | 67.7 |
| multi-hop (cat 1, n=282) | 59.6 |
| category-averaged | 74.4 |

Evidence fully in the retrieved context for 68.4% of questions; retrieval p50 5 ms, p95 10 ms;
about 3.6k reader tokens per question (including roughly 1k of fixed `claude -p` overhead, estimated from the per-question files) against about
26k for the whole conversation. Multi-hop is the weak spot: the evidence is spread over sessions and
the top 20 rounds often miss part of it.

Not directly comparable to mem0's table: their reader and judge are gpt-4o-mini, and our judge prompt
is written in the style of theirs, not copied from a pinned file. Map categories by name, not by id:
the dataset's integer ids (above) do not follow the column order in mem0's paper.

**With PRF (`qa-prf.json`, same settings):** J **81.8** — multi-hop 59.6 → **66.7**, temporal 82.2, open-domain 69.8,
single-hop 88.0. GPT re-judge of the pre-PRF run (`rejudge-gpt-main.json`, gpt-6-luna via codex): 83.6 vs
Claude's 80.5, verdict agreement 95.4%.

**Same model, with and without memory (GPT, `qa-luna-main.json` / `qa-luna-full.json`, 2026-10-07).** Reader
and judge gpt-6-luna via the OpenAI API (`--reader gpt-6-luna --judge gpt-6-luna`; `--full-context` gives the
reader the whole conversation instead of retrieved memories):

| | J | multi-hop | temporal | open-domain | single-hop | reader tokens / q | cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| brain_recall, 20 rounds | 78.8 | 65.6 | 76.9 | 59.4 | 86.2 | ~2,000 | $0.47 |
| full conversation | 89.3 | 85.1 | 88.2 | 62.5 | 94.2 | ~20,800 | $3.36 |
| **brain_recall + deep recall, 40 rounds** (`qa-luna-deep-k40.json`, 2026-10-08) | **86.6** | **80.5** | **84.1** | **63.5** | **92.2** | ~3,700 | $0.73 |

Full context wins on LoCoMo (conversations are ~26k tokens and fit in context), as it does in mem0's own paper
(72.9 vs 66.9). With deep recall and 40 rounds, retrieval reaches **97% of full-context accuracy (86.6 vs 89.3)
with ~18% of the tokens at about a fifth of the cost**, and ties it on open-domain (63.5 vs 62.5, about one
question of 96). Deep recall
closed most of the multi-hop gap (65.6 -> 80.5; evidence fully in context 83.3%).

## Dataset pin

`locomo10.json` from https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
(2,805,274 bytes), sha256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.
License: the LoCoMo repository is CC BY-NC 4.0 (Maharana et al., ACL 2024, arXiv:2402.17753). The
questions and gold answers in `proof/` stay under that license (attribution, non-commercial use
only), not this project's Apache 2.0 license.
Not committed: `evals/locomo/data/` is git-ignored. Fetch it with
`curl -L -o evals/locomo/data/locomo10.json <url above>` (the harness prints this if it is missing).

10 conversations, 5,882 dialogue turns, 1,986 questions: 282 cat 1, 321 cat 2, 96 cat 3,
841 cat 4, 446 cat 5. Scored: categories 1-4 = **1,540 questions**. Category 5
(adversarial, no gold answer) is excluded, as in mem0's paper.

### Category mapping

The LoCoMo repo does not document the integer ids. Read off the data:

| id | meaning | evidence in the data |
|----|---------|----------------------|
| 1 | multi-hop | list/aggregate answers across sessions ("What did Caroline research?") |
| 2 | temporal | "When did ...?" with a date answer |
| 3 | open-domain | commonsense inference ("Would Caroline still want ...?"), 96 questions |
| 4 | single-hop | one-fact lookups from one turn |
| 5 | adversarial | no `answer`, only `adversarial_answer` |

Note that mem0's paper lists its columns in a different order (single-hop,
multi-hop, open-domain, temporal) and the ids are commonly mislabeled in
third-party code. We report by the mapping above. Four questions have no
evidence ids; they only affect the `evidenceInContext` metric.

## Method

- **Units.** One turn = `Speaker: text` plus ` [shares image: <blip_caption>]` when the
  turn has an image, stored as one observation carrying the session `date_time`. A
  `round` unit is a turn plus the next turn in the same session (non-overlapping pairs).
- **Store.** One fresh temp store per conversation via `buildStore` from
  `evals/longmemeval/lib.mjs` (shared, not copied). Embeddings are cached in
  `data/embed-cache.db`; the model dir reuses `evals/longmemeval/data/models` if present.
- **Retrieval.** `rankUnits` with query `recall`, mode `hybrid` (BM25 + MiniLM, RRF) —
  the same ranking `brain_recall` runs. The top `--k` (default 20) units go to the
  reader in chronological order with their dates. No question date exists in LoCoMo.
- **Reader / judge.** `claude -p`, copied verbatim from longmemeval/qa.mjs: no hooks,
  settings, MCP, tools or session persistence, `BRAIN_DISTILLER=1`, temp cwd. The reader
  may reason briefly, then ends with `Answer: ...`; only that final answer is judged.
  The judge prompt follows mem0's published LLM-as-a-judge (J) prompt: generous on
  wording, same topic / same date counts, CORRECT or WRONG returned as JSON.

### Why round units are the default

`node evals/locomo/retrieval.mjs` (retrieval only, no LLM, all 1,536 questions with
evidence; "all" = every evidence turn is in the top k units):

| config | evidence all | evidence any | avg context tokens |
|--------|-------------|--------------|-------------------|
| turn@10 | 50.5 | 62.4 | 347 |
| turn@20 | 60.4 | 73.9 | 684 |
| turn@40 | 68.8 | 82.2 | 1,371 |
| round@10 | 58.7 | 72.7 | 743 |
| round@20 | 68.4 | 82.9 | 1,460 |

At an equal token budget turn and round retrieve the same (turn@40 vs round@20, a tie
within noise). Round wins on practicalities: it needs half the units (so half the
ranking depth) for the same coverage, its context holds a question and its reply
together (many LoCoMo turns are short replies that are meaningless alone), and
`--k 20` rounds lands near the ~1.5k-token memory budgets mem0 reports. Use `--unit turn`
to switch. Multi-hop (cat 1) is the weak spot for any top-k: evidence-all is only ~20%.

## Run

```
# smoke test (5 questions)
node evals/locomo/qa.mjs --limit 5 --jobs 3 --tag smoke

# full benchmark: 1,540 questions, 3,080 claude -p calls
node evals/locomo/qa.mjs --k 20 --reader sonnet --judge sonnet --jobs 6 --tag main
```

Flags: `--k`, `--unit round|turn`, `--reader`, `--judge`, `--jobs`, `--stride N`
(every Nth question, e.g. 8 for a ~190-question pilot), `--limit N`, `--tag`,
`--adversarial` (also run category 5, reported separately and never in the headline).
Results append to `data/qa-<tag>.jsonl` and re-running resumes (answered ids are skipped);
the summary is `evals/locomo/qa-<tag>.json`: overall J, J by category, a category-averaged
J, retrieval p50/p95, avg reader tokens vs the full conversation (~chars/4), and cost.

## Caveats

- The reader and judge are Claude (sonnet by default), not gpt-4o-mini as in mem0's
  paper. A stronger reader lifts every system; compare to mem0's numbers directionally,
  not as like-for-like.
- The judge prompt is written in the style of mem0's published one from memory of its
  wording, not copied from a pinned file.
- `avgReaderTokens` includes the fixed `claude -p` prompt overhead (roughly 1k tokens, estimated from the per-question files), so it
  overstates the memory payload; `contextChars` per row is the retrieved-text size.
- The full-conversation token figure is an estimate (chars/4), the same one longmemeval uses.
- The retrieval store holds raw turns: no distillation, no graph, nothing the product's
  curation layer would add. This is the floor of the brain's recall, not its ceiling.

## Notes on the run files (added 2026-10-12)

- `qa-luna-main.json` and `qa-prf.json` say "hybrid … RRF k=60" without mentioning
  pseudo-relevance feedback, but both used it (the reader's context matches the PRF ranking on all
  1,540 questions).
- `qa-luna-full.json` is the whole-conversation baseline; its `k` and retrieval fields are
  irrelevant to that run.
- Costs are estimates at $0.10 / $0.50 per million input / output tokens.
