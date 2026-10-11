# Multi-hop retrieval experiments

Goal: raise multi-hop evidence coverage of brain_recall's hybrid ranking without lowering anything else.
Experiments only: nothing in `bin/` or the existing evals was touched. Code: `compare.mjs` (all variants, both
benchmarks), `report.mjs` (tables). Raw numbers: `results-r{1..4}-{locomo,lme}.json`; the variant definitions of each
round are in `extra-variants-r*.json`. Reproduce: `node evals/multihop/compare.mjs [--variants name,name]`, then `node evals/multihop/report.mjs -r4`.

## Method

* Same pool for every variant: the baseline is exactly the product's pipeline (BM25 depth 60 with every token OR'd, MiniLM int8
  semantic top 50 with MIN_SIM 0.3, RRF k=60, depth 50). It reproduced `recallSearch`/`rankUnits` top-50 identically on
  34 of 34 spot-checked questions (30 LoCoMo, 4 LongMemEval). Each variant starts from that ranking, so BM25/semantic input is
  identical, and the same k is scored for everyone. Neighbour expansion (D) is the only stage that can add units that were
  not in the baseline pool; it pays for them out of the same k.
* LoCoMo: round units (turn pairs), 10 conversations, the 1,536 scored category 1-4 questions that have evidence
  (stride 1), evidence-all / evidence-any @10 and @20. LongMemEval-S: round units, all 470 non-abstention questions
  (stride 1), session-level recall_any@1/5/10, recall_all@5/10, ndcg@10 (the harness's `scoreRanking`).
* Baseline on LongMemEval here is any@1 87.7, any@5 98.3, all@5 84.9, all@10 91.7, ndcg@10 90.6 (results.json says
  all@5 84.7 and ndcg@10 90.5: the harness code has moved slightly since that file was written; every variant is compared with the
  baseline of this run, not with results.json). LoCoMo cat 1 baseline: all@20 19.9, matching the ~20% quoted.
* "+ms/q" = extra latency per query over the baseline, measured in-process on these small stores (about 300-500 units): the
  extra BM25 and semantic lists, the query embedding, the term statistics and the fusion. It includes one extra MiniLM query
  embedding (about 4-6 ms) and scales roughly like one more `recall` call, so on a 100k-row store expect about one extra
  BM25 query plus one extra vector scan (tens of ms), not 8 ms.
* Guard (the acceptance rule): no LongMemEval headline metric (any@1/5/10, all@5/10, ndcg@10) lower by more than 0.3, and no LoCoMo
  category lower on any of the four metrics at either k (tolerance 0.05, i.e. rounding only).

## Variants

* A PRF: take the top m units of the baseline ranking, pick the top t terms by tf-idf over the store's units (sum over feedback units of
  (1+ln tf) * ln(N/df); excluding query terms, a stopword list, terms shorter than 3 characters, df<2 and df > 10% of units), then
  `prf-b` = a second BM25 on query + terms; `prf-bs` = that plus a semantic list on "query + terms"; `prf-s` = semantic list only;
  `prf-vec` = Rocchio (query vector + mean of the m feedback vectors). Each extra list is RRF-fused with the baseline list (weight w, baseline weight 1).
  `pinN` = the baseline's first N hits keep their places and PRF only reorders what is below them.
* B split on " and ", ",", ";", "or", "both", "&", "as well as", "versus", "then" (parts of at least 2 content tokens, at most 4); each part is ranked hybrid and fused with the full-question list.
* C per-session cap (3 or 5) with back-fill. D neighbour expansion: after each of the top j hits insert the next round (or next and previous) of the same session.

## Headline table: one row per idea, same pool, same k

LoCoMo overall and category 1 (multi-hop), LongMemEval overall. Every number is a percentage; deltas are against the baseline row.

| variant | LoCoMo all@10 | all@20 | any@10 | any@20 | cat1 all@10 | cat1 all@20 | cat1 any@10 | cat1 any@20 | LME any@1 | any@5 | any@10 | all@5 | all@10 | ndcg@10 | +ms/q | guard |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 58.7 | 68.4 | 72.7 | 82.9 | 13.1 | 19.9 | 70.2 | 80.9 | 87.7 | 98.3 | 98.9 | 84.9 | 91.7 | 90.6 | 0 | - |
| A prf-bs m5 t10 w1 (no pin) | 61.1 | 71.7 | 74.4 | 85.0 | 16.0 | 27.0 | 70.9 | 83.7 | 85.1 | 97.9 | 98.9 | 87.2 | 93.8 | 91.0 | 8.8 | fail (any@1 -2.6) |
| A prf-b m5 t10 w1 (no pin) | 63.7 | 70.3 | 77.1 | 83.5 | 13.1 | 23.4 | 67.7 | 80.1 | 86.0 | 97.9 | 98.9 | 86.0 | 93.2 | 90.8 | 2.0 | fail (cat1 any -2.5) |
| A prf-vec m3 w1 (no pin) | 54.7 | 62.6 | 67.9 | 76.7 | 12.4 | 18.4 | 67.0 | 77.7 | 87.2 | 98.1 | 99.6 | 88.7 | 94.7 | 91.8 | 4.6 | fail (LoCoMo -8) |
| B split w0.5 | 58.5 | 68.6 | 72.3 | 83.1 | 13.1 | 19.9 | 69.1 | 81.2 | 84.0 | 97.0 | 98.7 | 81.1 | 91.3 | 88.2 | 0.9 | fail (LME any@1 -3.7) |
| C cap3 | 56.9 | 65.8 | 70.9 | 80.6 | 12.8 | 19.5 | 69.9 | 80.5 | 87.7 | 98.3 | 98.9 | 84.9 | 91.7 | 90.6 | 0 | fail (LoCoMo -3.6) |
| C cap5 | 58.7 | 68.2 | 72.7 | 82.7 | 13.1 | 19.9 | 70.2 | 80.9 | 87.7 | 98.3 | 98.9 | 84.9 | 91.7 | 90.6 | 0 | fail (-0.3, no gain) |
| D nbr-both j3 | 62.4 | 71.4 | 73.8 | 85.0 | 13.1 | 20.6 | 65.2 | 81.2 | 87.7 | 98.3 | 98.9 | 84.9 | 91.7 | 90.6 | 0 | fail (cat1 any@10 -5.0) |
| **E: A prf-bs m8 t10 w1 pin5** | **60.4** | **71.1** | **73.7** | **83.9** | **15.6** | **26.2** | **71.3** | **81.6** | **87.7** | **98.3** | **98.9** | **87.7** | **94.0** | **91.2** | **8.2 (LoCoMo 6.2)** | **PASS** |

Notes: C and D are structurally inert on LongMemEval's session-level scoring (a demoted or inserted unit never changes the
first-seen order of sessions), so they are free there; their cost is on LoCoMo, where C loses and D trades cat-1 any@10 (neighbours push other
hits out) for broad gains on categories 2-4. B (splitting) rarely fires on LoCoMo questions and, when it does on LongMemEval, drags fillers into the top ranks.

## Recommendation: A, PRF with `prf-bs`, m=8, t=10, w=1, pin the baseline top 5 (no B, C or D)

Per-category, LoCoMo (all@10 / all@20 / any@10 / any@20), baseline to E:

| cat | baseline | E |
|---|---|---|
| 1 multi-hop | 13.1 / 19.9 / 70.2 / 80.9 | 15.6 / 26.2 / 71.3 / 81.6 |
| 2 temporal | 68.5 / 76.9 / 74.5 / 82.9 | 69.2 / 78.8 / 74.8 / 82.9 |
| 3 open-domain | 28.3 / 38.0 / 46.7 / 57.6 | 30.4 / 44.6 / 48.9 / 64.1 |
| 4 single-hop | 73.6 / 84.7 / 75.6 / 86.3 | 75.3 / 86.1 / 76.8 / 87.3 |

* Multi-hop (cat 1) evidence-all@20: 19.9 to 26.2 (+6.3, 25 questions won, 7 lost); overall evidence-all@20 68.4 to 71.1 (+2.7), all@10 +1.7.
  No LoCoMo category is lower on any of the four metrics. Per question (all@20): 78 wins, 36 losses of 1,536.
* LongMemEval: any@1 87.7, any@10 98.9 unchanged; any@5 98.3 unchanged (1 win, 1 loss); all@5 84.9 to 87.7 (+2.8; 15 wins, 2 losses);
  all@10 91.7 to 94.0 (+2.3; 11 wins, 0 losses); ndcg@10 90.6 to 91.2; multi-session all@10 80.2 to 86.8. Nothing regresses.
* Cost: one extra BM25 plus one extra semantic query (one query embedding) plus one fusion per recall; +6.2 ms/q LoCoMo, +8.2 ms/q LongMemEval on 300-500 unit stores.
* Why pinning is essential: the unpinned versions of the same PRF lift all@5/all@10 but displace the top hit (LME any@1 87.7 to 85.1) and cat-1 any@10, so they fail the guard.
  Pinning the baseline's first 5 hits protects any@1/any@5 and the head of the list while PRF reorders the tail, where the second and third hop of a multi-hop question sit. Pin 8 with m=5 t=15 (also PASS: LME all@10 94.3, LoCoMo cat1 all@20 25.2) is an equally safe alternative; pins below 5 cost 1-2 questions on LME any@5 (-0.2 to -0.4).
* Caveat (selection effect): about 100 variants were screened on these same benchmarks; the PRF gain is large and shared by the whole family (every `prf-bs` row with m>=3, t>=5 lifts cat-1 all@20 by 4-7 points on LoCoMo and LME all@10 by 1.3-3.2), so the direction is not a selection artefact, but the exact 0.1s are tuned. The LME any@5 guard flips by a single question (0.2 points), so treat pin and m as robust within a range (m 5-8, pin 5-8), not as points.
* Not worth it: the Rocchio vector PRF (`prf-vec`) helps LongMemEval most (all@10 94.7) but costs LoCoMo 6-8 points (short two-turn rounds drift); BM25-only PRF raises all@10 overall (+4.6) but loses cat-1 any;
  semantic-only PRF fails the guard; B split is neutral to harmful; C is neutral to harmful. D neighbour expansion helps LoCoMo categories 2-4 by +1.5 to +3.6 (all@10 +1.5 to +3.7 with PRF on top: `E + nbr-next j1`: LoCoMo all@10 62.5, all@20 72.5, any@10 75.6) but lowers one LoCoMo category by 0.4 (strict guard fails) and is a no-op on LME; it is a candidate follow-up if the guard is relaxed to a tolerance of 0.5.

## How to implement in the product

Add it in `bin/lib/recall.mjs`, inside `recallSearch()`, as a second pass applied to the fused list: after
`fuseRows(bm25, semantic, fetchRows)` has produced the 50 fused rows and before `rerankByLifecycle(...)` (and the same in
`retrieveContext()` between its `fuseRows` and `rerankByLifecycle`). Put the logic in a new function in `bin/lib/embed.mjs`
or a new leaf module (`bin/lib/prf.mjs`), `prfRerank({ db, query, fused, bm25Depth, semantic })`:

1. Take `fb = fused.slice(0, 8)` (rows' `narrative/title/facts` text; the harness used the unit text). Only run when `fused.length >= 8`.
2. Term statistics: query FTS5 vocab (`fts5vocab(observations_fts,'row')`, as `pruneCommonTerms` already does) for df and N; tokenise the feedback rows with the same `[a-z0-9]+` tokeniser as `ftsMatchExpr`. Score terms by sum of (1+ln tf)*ln(N/df) over the 8 rows; drop query tokens, a small stopword list, tokens under 3 characters, df<2 and df > 0.1 N; keep the top 10. (Below about 50 rows skip PRF.)
3. Run a second BM25 with `ftsMatchExpr(query) + ' OR ' + terms.map(t => '"'+t+'"').join(' OR ')`, same LIMIT as the first, and a second `semanticSearch({ query: query + ' ' + terms.join(' ') })` (reuses the loaded matrix; one extra query embedding).
4. Fuse with weighted RRF, k=60: the already-fused list weight 1, PRF BM25 list weight 1, PRF semantic list weight 1 (each list contributes w/(60+rank+1)); take depth 50.
5. Pin: the first 5 rows of the original fused list stay in positions 1-5 (skip them in the PRF order), the PRF order fills the rest. Then `rerankByLifecycle` as today, so archived/superseded rows keep their handling and the extra lists must go through the same lifecycle filter.
6. Fail open: if the second list throws or semantic is unavailable (`semanticSearch` returns null), return the fused list unchanged (with semantic off, run the BM25-only variant, which is untested and should be gated behind its own measurement before enabling; the unpinned prf-b row above is the nearest data point and failed the guard).
7. Keep `limit`/`offset` paging semantics: do the PRF over the same top-50 candidate list, then slice.

A reference implementation of every stage is in `evals/multihop/compare.mjs` (`STAGES.prf`, `expansionTerms`, `wrerf`/`wrrf`).
Ship it behind `BRAIN_PRF=0` as an off switch and add the guard numbers above to `evals/longmemeval/RESULTS.md` when it lands.

## Full tables

Round 1 is every first-pass variant (A-E). Round 4 adds the pinned PRF family. Rounds 2 and 3 (pin and parameter sweeps) are in the JSON files and `report.mjs -r2|-r3`.

### Round 1 (unpinned A, B, C, D, first combinations)

#### LoCoMo (round units, 1536 questions, cat 1-4)

| variant | all@10 | any@10 | all@20 | any@20 | cat1 all@10 | cat1 any@10 | cat1 all@20 | cat1 any@20 | +ms/q |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 58.7 | 72.7 | 68.4 | 82.9 | 13.1 | 70.2 | 19.9 | 80.9 | 0.0 |
| A prf-b m3 t5 w0.5 | 62.6 | 76.4 | 69.3 | 82.7 | 13.1 | 68.4 | 21.6 | 77.7 | 1.7 |
| A prf-bs m3 t5 w0.5 | 60.0 | 73.4 | 70.4 | 83.8 | 14.5 | 68.4 | 24.1 | 80.5 | 7.6 |
| A prf-b m3 t5 w1 | 63.3 | 77.3 | 69.2 | 82.7 | 12.4 | 68.8 | 21.3 | 77.7 | 1.7 |
| A prf-bs m3 t5 w1 | 59.5 | 73.4 | 70.8 | 83.8 | 13.8 | 69.5 | 25.9 | 81.2 | 7.6 |
| A prf-b m3 t10 w0.5 | 62.6 | 77.0 | 69.7 | 83.0 | 12.1 | 69.9 | 23.0 | 78.0 | 2.0 |
| A prf-bs m3 t10 w0.5 | 60.6 | 74.0 | 71.4 | 84.6 | 16.0 | 70.6 | 25.5 | 83.0 | 8.6 |
| A prf-b m3 t10 w1 | 63.3 | 77.1 | 69.7 | 83.1 | 12.8 | 69.1 | 22.7 | 78.0 | 2.0 |
| A prf-bs m3 t10 w1 | 59.6 | 73.1 | 71.4 | 84.8 | 16.3 | 71.6 | 26.6 | 83.7 | 8.6 |
| A prf-b m5 t5 w0.5 | 62.7 | 76.8 | 69.2 | 81.9 | 13.5 | 69.9 | 22.7 | 75.5 | 1.7 |
| A prf-bs m5 t5 w0.5 | 60.0 | 73.6 | 70.4 | 83.7 | 14.2 | 68.8 | 25.2 | 82.3 | 7.3 |
| A prf-b m5 t5 w1 | 63.5 | 77.2 | 69.5 | 82.2 | 14.2 | 69.1 | 23.4 | 77.0 | 1.7 |
| A prf-bs m5 t5 w1 | 59.6 | 73.1 | 70.6 | 83.6 | 13.8 | 68.1 | 25.2 | 81.9 | 7.3 |
| A prf-b m5 t10 w0.5 | 62.8 | 77.0 | 70.4 | 83.7 | 13.5 | 70.2 | 22.7 | 80.1 | 2.0 |
| A prf-bs m5 t10 w0.5 | 61.4 | 74.9 | 70.9 | 84.2 | 15.2 | 70.9 | 26.2 | 83.0 | 8.9 |
| A prf-b m5 t10 w1 | 63.7 | 77.1 | 70.3 | 83.5 | 13.1 | 67.7 | 23.4 | 80.1 | 2.0 |
| A prf-bs m5 t10 w1 | 61.1 | 74.4 | 71.7 | 85.0 | 16.0 | 70.9 | 27.0 | 83.7 | 8.8 |
| A prf-vec m3 w0.5 | 56.0 | 69.4 | 63.0 | 76.9 | 13.1 | 68.8 | 19.9 | 78.0 | 4.6 |
| A prf-vec m3 w1 | 54.7 | 67.9 | 62.6 | 76.7 | 12.4 | 67.0 | 18.4 | 77.7 | 4.6 |
| A prf-vec m5 w0.5 | 56.7 | 70.3 | 63.4 | 77.3 | 13.1 | 69.1 | 19.1 | 77.7 | 4.6 |
| A prf-vec m5 w1 | 55.7 | 69.1 | 62.6 | 76.8 | 11.7 | 67.4 | 18.1 | 77.0 | 4.6 |
| B split w0.5 | 58.5 | 72.3 | 68.6 | 83.1 | 13.1 | 69.1 | 19.9 | 81.2 | 0.9 |
| B split w1 | 58.3 | 72.1 | 68.5 | 83.1 | 13.1 | 69.1 | 19.5 | 81.2 | 0.9 |
| C cap3 | 56.9 | 70.9 | 65.8 | 80.6 | 12.8 | 69.9 | 19.5 | 80.5 | -0.0 |
| C cap5 | 58.7 | 72.7 | 68.2 | 82.7 | 13.1 | 70.2 | 19.9 | 80.9 | -0.0 |
| D nbr-next j3 | 61.5 | 73.8 | 70.6 | 84.7 | 12.4 | 66.3 | 20.2 | 80.5 | -0.0 |
| D nbr-both j3 | 62.4 | 73.8 | 71.4 | 85.0 | 13.1 | 65.2 | 20.6 | 81.2 | -0.0 |
| D nbr-next j5 | 60.5 | 72.6 | 70.0 | 83.7 | 12.1 | 63.5 | 19.5 | 79.1 | -0.0 |
| D nbr-both j5 | 61.8 | 73.2 | 71.2 | 84.0 | 13.1 | 63.8 | 23.0 | 79.8 | -0.0 |
| E prf-vec m3 w1 + cap5 | 54.6 | 67.8 | 62.0 | 76.3 | 12.4 | 67.0 | 17.7 | 77.7 | 4.6 |
| E prf-vec m3 w1 + split w0.5 | 55.1 | 68.4 | 62.8 | 77.1 | 12.4 | 67.0 | 18.4 | 78.0 | 5.6 |
| E prf-vec m3 w1 + nbr-next j3 | 58.3 | 70.2 | 65.7 | 78.8 | 13.1 | 64.2 | 19.9 | 77.0 | 4.6 |
| X prf-bs m3 t15 w1 | 60.3 | 73.8 | 71.3 | 84.2 | 17.4 | 73.0 | 27.0 | 84.0 | 10.2 |
| X prf-bs m3 t20 w1 | 60.9 | 74.3 | 71.7 | 84.4 | 17.7 | 72.3 | 28.7 | 83.7 | 11.5 |
| X prf-bs m5 t20 w1 | 60.9 | 74.7 | 71.3 | 84.9 | 16.0 | 73.0 | 28.7 | 86.9 | 12.2 |
| X prf-bs m3 t10 w2 | 58.8 | 72.3 | 70.4 | 83.5 | 15.6 | 69.9 | 26.2 | 82.3 | 8.6 |
| X prf-bs m5 t10 w2 | 60.4 | 73.5 | 70.1 | 83.1 | 16.0 | 69.5 | 26.6 | 82.6 | 8.8 |
| X prf-bs m5 t15 w1 | 61.3 | 74.6 | 71.5 | 84.5 | 16.7 | 72.0 | 27.0 | 84.4 | 10.5 |
| X prf-s m3 t10 w1 | 56.2 | 69.6 | 65.0 | 78.6 | 14.9 | 70.6 | 23.4 | 79.8 | 6.6 |
| X prf-s m5 t10 w0.5 | 58.1 | 71.6 | 65.0 | 79.0 | 13.5 | 69.5 | 20.9 | 79.8 | 6.9 |
| X prf-s m5 t10 w1 | 56.8 | 70.7 | 64.5 | 78.6 | 14.2 | 72.0 | 20.9 | 80.5 | 6.8 |
| X prf-s m3 t5 w1 | 55.0 | 68.6 | 64.1 | 77.8 | 13.1 | 68.4 | 22.0 | 78.4 | 6.0 |
| X prf-bs m3 t10 w1 + nbr-both j1 | 62.5 | 75.5 | 73.2 | 86.2 | 16.0 | 70.2 | 27.3 | 83.7 | 8.6 |
| X prf-bs m3 t10 w1 + nbr-both j2 | 62.8 | 75.5 | 73.8 | 86.6 | 14.5 | 68.4 | 27.7 | 84.0 | 8.5 |
| X prf-bs m3 t10 w1 + nbr-both j3 | 62.5 | 74.2 | 74.2 | 86.5 | 14.9 | 66.0 | 28.0 | 82.3 | 8.5 |
| X prf-bs m3 t10 w1 + nbr-next j2 | 62.7 | 75.8 | 73.2 | 86.5 | 15.2 | 69.9 | 26.6 | 84.4 | 8.5 |
| X prf-bs m3 t10 w1 + nbr-next j3 | 62.3 | 75.3 | 73.4 | 86.1 | 14.2 | 68.8 | 27.3 | 83.0 | 8.6 |
| X prf-bs m5 t10 w1 + nbr-both j2 | 62.9 | 74.9 | 73.7 | 86.5 | 14.9 | 66.0 | 26.2 | 83.0 | 8.8 |
| X prf-bs m5 t10 w1 + nbr-both j3 | 61.8 | 73.4 | 73.8 | 86.4 | 15.6 | 65.6 | 26.6 | 81.9 | 8.8 |
| X prf-bs m3 t10 w1 + cap5 | 59.6 | 73.2 | 71.1 | 84.4 | 16.7 | 72.0 | 26.6 | 83.7 | 8.5 |
| X prf-bs m3 t10 w1 + split w0.5 | 59.4 | 73.0 | 71.6 | 85.0 | 16.3 | 70.9 | 26.6 | 83.3 | 9.5 |

#### LoCoMo per-category deltas vs baseline (all@20 / any@20)

| variant | cat1 | cat2 | cat3 | cat4 |
|---|---|---|---|---|
| A prf-b m3 t5 w0.5 | +1.7 / -3.2 | +1.3 / +0.6 | -2.1 / -2.2 | +0.8 / +0.7 |
| A prf-bs m3 t5 w0.5 | +4.2 / -0.4 | +0.7 / +0.3 | +2.2 / +3.3 | +1.9 / +1.3 |
| A prf-b m3 t5 w1 | +1.4 / -3.2 | +1.0 / +0.6 | -1.0 / -2.2 | +0.8 / +0.7 |
| A prf-bs m3 t5 w1 | +6.0 / +0.3 | +0.4 / -0.3 | +4.4 / +4.4 | +1.7 / +1.2 |
| A prf-b m3 t10 w0.5 | +3.1 / -2.9 | +1.6 / +1.5 | -3.2 / -2.2 | +1.0 / +0.9 |
| A prf-bs m3 t10 w0.5 | +5.6 / +2.1 | +1.9 / +0.9 | +3.3 / +2.2 | +2.6 / +1.9 |
| A prf-b m3 t10 w1 | +2.8 / -2.9 | +1.6 / +1.5 | -4.3 / -3.3 | +1.3 / +1.1 |
| A prf-bs m3 t10 w1 | +6.7 / +2.8 | +1.9 / +0.3 | +5.5 / +7.6 | +2.0 / +1.6 |
| A prf-b m5 t5 w0.5 | +2.8 / -5.4 | +1.6 / +1.2 | -4.3 / -5.4 | +0.4 / +0.1 |
| A prf-bs m5 t5 w0.5 | +5.3 / +1.4 | +1.3 / +0.6 | +1.1 / +2.2 | +1.4 / +0.5 |
| A prf-b m5 t5 w1 | +3.5 / -3.9 | +1.6 / +0.9 | -4.3 / -4.3 | +0.7 / +0.1 |
| A prf-bs m5 t5 w1 | +5.3 / +1.0 | +1.6 / +0.3 | +1.1 / 0.0 | +1.6 / +0.9 |
| A prf-b m5 t10 w0.5 | +2.8 / -0.8 | +1.9 / +1.5 | 0.0 / -2.2 | +2.0 / +1.3 |
| A prf-bs m5 t10 w0.5 | +6.3 / +2.1 | +1.6 / +0.9 | 0.0 / +1.1 | +1.9 / +1.3 |
| A prf-b m5 t10 w1 | +3.5 / -0.8 | +2.2 / +1.5 | -1.0 / -2.2 | +1.6 / +1.1 |
| A prf-bs m5 t10 w1 | +7.1 / +2.8 | +2.2 / +1.2 | +4.4 / +6.5 | +2.3 / +1.8 |
| A prf-vec m3 w0.5 | 0.0 / -2.9 | -5.2 / -5.3 | -1.0 / +1.1 | -7.6 / -8.1 |
| A prf-vec m3 w1 | -1.5 / -3.2 | -5.9 / -6.0 | -1.0 / +1.1 | -7.8 / -8.1 |
| A prf-vec m5 w0.5 | -0.8 / -3.2 | -4.0 / -4.4 | -1.0 / +2.2 | -7.2 / -7.6 |
| A prf-vec m5 w1 | -1.8 / -3.9 | -5.2 / -5.6 | -2.1 / +2.2 | -7.6 / -7.9 |
| B split w0.5 | 0.0 / +0.3 | 0.0 / -0.3 | 0.0 / 0.0 | +0.4 / +0.5 |
| B split w1 | -0.4 / +0.3 | 0.0 / -0.3 | 0.0 / 0.0 | +0.3 / +0.4 |
| C cap3 | -0.4 / -0.4 | -1.8 / -1.9 | -3.2 / -1.1 | -3.6 / -3.2 |
| C cap5 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | -0.3 / -0.2 |
| D nbr-next j3 | +0.3 / -0.4 | +1.0 / +0.6 | +1.1 / +2.2 | +3.5 / +3.0 |
| D nbr-both j3 | +0.7 / +0.3 | +3.5 / +1.5 | +3.3 / +2.2 | +3.6 / +2.9 |
| D nbr-next j5 | -0.4 / -1.8 | -0.3 / -0.7 | -1.0 / +1.1 | +3.3 / +2.2 |
| D nbr-both j5 | +3.1 / -1.1 | +3.2 / +1.2 | +2.2 / +3.3 | +2.7 / +1.6 |
| E prf-vec m3 w1 + cap5 | -2.2 / -3.2 | -6.5 / -6.6 | -2.1 / +1.1 | -8.2 / -8.5 |
| E prf-vec m3 w1 + split w0.5 | -1.5 / -2.9 | -6.2 / -6.0 | -1.0 / +2.2 | -7.2 / -7.6 |
| E prf-vec m3 w1 + nbr-next j3 | 0.0 / -3.9 | -5.2 / -6.3 | -1.0 / 0.0 | -2.8 / -3.8 |
| X prf-bs m3 t15 w1 | +7.1 / +3.1 | +1.9 / +0.6 | +3.3 / +2.2 | +1.9 / +1.0 |
| X prf-bs m3 t20 w1 | +8.8 / +2.8 | +2.2 / +0.9 | +5.5 / +6.5 | +1.7 / +0.9 |
| X prf-bs m5 t20 w1 | +8.8 / +6.0 | +1.0 / -0.3 | +2.2 / +3.3 | +1.7 / +1.5 |
| X prf-bs m3 t10 w2 | +6.3 / +1.4 | +1.9 / +0.3 | +4.4 / +5.4 | +0.3 / -0.1 |
| X prf-bs m5 t10 w2 | +6.7 / +1.7 | +1.0 / -1.0 | +3.3 / +5.4 | +0.1 / -0.4 |
| X prf-bs m5 t15 w1 | +7.1 / +3.5 | +2.5 / +0.6 | +3.3 / +3.3 | +2.0 / +1.2 |
| X prf-s m3 t10 w1 | +3.5 / -1.1 | -3.7 / -4.1 | 0.0 / +2.2 | -5.9 / -6.2 |
| X prf-s m5 t10 w0.5 | +1.0 / -1.1 | -3.4 / -3.8 | 0.0 / +3.3 | -5.2 / -5.6 |
| X prf-s m5 t10 w1 | +1.0 / -0.4 | -4.3 / -4.4 | -1.0 / +2.2 | -5.6 / -6.3 |
| X prf-s m3 t5 w1 | +2.1 / -2.5 | -3.4 / -4.1 | 0.0 / +2.2 | -7.2 / -7.1 |
| X prf-bs m3 t10 w1 + nbr-both j1 | +7.4 / +2.8 | +3.8 / +1.5 | +6.6 / +6.5 | +4.2 / +3.8 |
| X prf-bs m3 t10 w1 + nbr-both j2 | +7.8 / +3.1 | +5.3 / +2.1 | +5.5 / +5.4 | +4.7 / +4.3 |
| X prf-bs m3 t10 w1 + nbr-both j3 | +8.1 / +1.4 | +6.3 / +3.1 | +6.6 / +7.6 | +4.7 / +4.2 |
| X prf-bs m3 t10 w1 + nbr-next j2 | +6.7 / +3.5 | +3.2 / +0.6 | +4.4 / +5.4 | +5.0 / +4.5 |
| X prf-bs m3 t10 w1 + nbr-next j3 | +7.4 / +2.1 | +3.8 / +0.9 | +4.4 / +5.4 | +4.7 / +4.2 |
| X prf-bs m5 t10 w1 + nbr-both j2 | +6.3 / +2.1 | +4.7 / +2.8 | +5.5 / +5.4 | +5.2 / +4.3 |
| X prf-bs m5 t10 w1 + nbr-both j3 | +6.7 / +1.0 | +5.7 / +3.4 | +4.4 / +4.4 | +5.1 / +4.3 |
| X prf-bs m3 t10 w1 + cap5 | +6.7 / +2.8 | +1.9 / +0.3 | +5.5 / +7.6 | +1.4 / +1.0 |
| X prf-bs m3 t10 w1 + split w0.5 | +6.7 / +2.4 | +1.3 / +0.3 | +5.5 / +5.4 | +2.6 / +2.3 |

#### LongMemEval-S (round units, 470 questions)

| variant | any@1 | any@5 | any@10 | all@5 | all@10 | ndcg@10 | multi-session all@10 | +ms/q | LME min delta | LoCoMo worst any / all delta | guard |
|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 87.7 | 98.3 | 98.9 | 84.9 | 91.7 | 90.6 | 80.2 | 0.0 | 0.0 | 0.0 / 0.0 | - |
| A prf-b m3 t5 w0.5 | 86.8 | 97.9 | 98.9 | 85.7 | 91.7 | 90.7 | 81.0 | 2.8 | -0.9 | -3.2 / -2.1 | fail |
| A prf-bs m3 t5 w0.5 | 86.4 | 97.9 | 98.9 | 87.4 | 92.3 | 91.0 | 81.8 | 7.8 | -1.3 | -1.8 / 0.0 | fail |
| A prf-b m3 t5 w1 | 87.0 | 97.7 | 98.9 | 86.0 | 92.3 | 91.0 | 83.5 | 2.7 | -0.7 | -3.2 / -1.0 | fail |
| A prf-bs m3 t5 w1 | 86.2 | 97.9 | 98.9 | 87.9 | 93.2 | 91.2 | 84.3 | 7.7 | -1.5 | -0.7 / 0.0 | fail |
| A prf-b m3 t10 w0.5 | 86.4 | 97.9 | 98.9 | 86.6 | 91.9 | 90.6 | 81.0 | 3.1 | -1.3 | -2.9 / -3.2 | fail |
| A prf-bs m3 t10 w0.5 | 85.3 | 97.9 | 98.9 | 87.7 | 92.6 | 91.0 | 81.8 | 8.3 | -2.4 | 0.0 / 0.0 | fail |
| A prf-b m3 t10 w1 | 85.1 | 97.7 | 98.9 | 87.0 | 92.8 | 90.5 | 83.5 | 3.0 | -2.6 | -3.3 / -4.3 | fail |
| A prf-bs m3 t10 w1 | 84.5 | 97.9 | 98.9 | 89.1 | 93.6 | 90.9 | 86.0 | 8.2 | -3.2 | 0.0 / -0.3 | fail |
| A prf-b m5 t5 w0.5 | 87.0 | 97.9 | 98.9 | 85.5 | 91.7 | 91.0 | 81.0 | 2.8 | -0.7 | -5.4 / -4.3 | fail |
| A prf-bs m5 t5 w0.5 | 86.4 | 98.1 | 98.9 | 86.8 | 92.3 | 91.0 | 81.8 | 7.8 | -1.3 | -1.4 / 0.0 | fail |
| A prf-b m5 t5 w1 | 86.4 | 97.9 | 98.9 | 85.7 | 92.1 | 90.9 | 82.6 | 2.8 | -1.3 | -4.3 / -4.3 | fail |
| A prf-bs m5 t5 w1 | 85.1 | 97.9 | 98.9 | 87.2 | 93.0 | 90.8 | 84.3 | 7.7 | -2.6 | -2.1 / 0.0 | fail |
| A prf-b m5 t10 w0.5 | 87.4 | 97.9 | 98.9 | 86.4 | 92.1 | 91.1 | 81.0 | 3.0 | -0.4 | -2.2 / 0.0 | fail |
| A prf-bs m5 t10 w0.5 | 86.0 | 97.9 | 98.9 | 87.2 | 92.8 | 91.0 | 81.8 | 8.8 | -1.7 | 0.0 / 0.0 | fail |
| A prf-b m5 t10 w1 | 86.0 | 97.9 | 98.9 | 86.0 | 93.2 | 90.8 | 85.1 | 3.1 | -1.7 | -2.5 / -1.0 | fail |
| A prf-bs m5 t10 w1 | 85.1 | 97.9 | 98.9 | 87.2 | 93.8 | 91.0 | 86.0 | 8.7 | -2.6 | 0.0 / 0.0 | fail |
| A prf-vec m3 w0.5 | 87.0 | 98.1 | 99.4 | 88.7 | 93.2 | 91.3 | 83.5 | 4.1 | -0.7 | -8.1 / -7.6 | fail |
| A prf-vec m3 w1 | 87.2 | 98.1 | 99.6 | 88.7 | 94.7 | 91.8 | 89.3 | 4.1 | -0.5 | -8.1 / -7.8 | fail |
| A prf-vec m5 w0.5 | 87.7 | 98.5 | 99.1 | 89.4 | 93.2 | 91.7 | 84.3 | 4.0 | 0.0 | -7.6 / -7.2 | fail |
| A prf-vec m5 w1 | 86.6 | 98.5 | 99.6 | 89.6 | 94.5 | 91.6 | 89.3 | 4.0 | -1.1 | -7.9 / -7.6 | fail |
| B split w0.5 | 84.0 | 97.0 | 98.7 | 81.1 | 91.3 | 88.2 | 80.2 | 3.0 | -3.8 | -1.1 / -0.4 | fail |
| B split w1 | 84.0 | 97.0 | 98.5 | 80.4 | 90.2 | 87.7 | 79.3 | 3.0 | -4.5 | -1.1 / -0.6 | fail |
| C cap3 | 87.7 | 98.3 | 98.9 | 84.9 | 91.7 | 90.6 | 80.2 | -0.0 | 0.0 | -3.2 / -3.6 | fail |
| C cap5 | 87.7 | 98.3 | 98.9 | 84.9 | 91.7 | 90.6 | 80.2 | -0.0 | 0.0 | -0.2 / -0.3 | fail |
| D nbr-next j3 | 87.7 | 98.3 | 98.9 | 84.9 | 91.7 | 90.6 | 80.2 | -0.0 | 0.0 | -3.9 / -1.2 | fail |
| D nbr-both j3 | 87.7 | 98.3 | 98.9 | 84.9 | 91.7 | 90.6 | 80.2 | -0.0 | 0.0 | -5.0 / 0.0 | fail |
| D nbr-next j5 | 87.7 | 98.3 | 98.9 | 84.9 | 91.7 | 90.6 | 80.2 | -0.0 | 0.0 | -6.7 / -4.0 | fail |
| D nbr-both j5 | 87.7 | 98.3 | 98.9 | 84.9 | 91.7 | 90.6 | 80.2 | -0.0 | 0.0 | -6.4 / 0.0 | fail |
| E prf-vec m3 w1 + cap5 | 87.2 | 98.1 | 99.6 | 88.7 | 94.7 | 91.8 | 89.3 | 4.1 | -0.5 | -8.5 / -8.2 | fail |
| E prf-vec m3 w1 + split w0.5 | 85.1 | 97.4 | 99.6 | 85.5 | 94.0 | 89.9 | 87.6 | 7.1 | -2.6 | -7.6 / -7.2 | fail |
| E prf-vec m3 w1 + nbr-next j3 | 87.2 | 98.1 | 99.6 | 88.7 | 94.7 | 91.8 | 89.3 | 4.1 | -0.5 | -6.3 / -5.2 | fail |
| X prf-bs m3 t15 w1 | 85.3 | 97.7 | 98.7 | 88.9 | 94.9 | 91.3 | 89.3 | 11.0 | -2.4 | 0.0 / 0.0 | fail |
| X prf-bs m3 t20 w1 | 85.1 | 98.3 | 98.5 | 89.8 | 94.0 | 91.1 | 87.6 | 11.2 | -2.6 | 0.0 / 0.0 | fail |
| X prf-bs m5 t20 w1 | 83.6 | 98.3 | 98.9 | 88.5 | 94.0 | 90.6 | 86.0 | 11.7 | -4.1 | -0.3 / 0.0 | fail |
| X prf-bs m3 t10 w2 | 84.0 | 97.7 | 98.9 | 89.1 | 94.3 | 90.8 | 88.4 | 8.3 | -3.7 | -0.6 / -1.2 | fail |
| X prf-bs m5 t10 w2 | 83.4 | 97.9 | 98.9 | 88.3 | 93.6 | 90.4 | 86.0 | 8.8 | -4.3 | -1.0 / -1.2 | fail |
| X prf-bs m5 t15 w1 | 84.3 | 97.9 | 98.9 | 87.4 | 94.3 | 90.7 | 86.0 | 10.9 | -3.4 | 0.0 / 0.0 | fail |
| X prf-s m3 t10 w1 | 85.3 | 97.9 | 99.1 | 86.8 | 93.0 | 90.9 | 84.3 | 5.5 | -2.4 | -6.2 / -5.9 | fail |
| X prf-s m5 t10 w0.5 | 87.7 | 98.3 | 98.9 | 87.2 | 92.3 | 91.3 | 81.0 | 6.0 | 0.0 | -5.6 / -5.2 | fail |
| X prf-s m5 t10 w1 | 85.7 | 97.9 | 98.9 | 86.8 | 92.3 | 90.7 | 81.8 | 5.9 | -2.0 | -6.3 / -5.6 | fail |
| X prf-s m3 t5 w1 | 86.0 | 98.3 | 99.1 | 87.2 | 92.6 | 90.8 | 82.6 | 5.2 | -1.7 | -7.1 / -7.2 | fail |
| X prf-bs m3 t10 w1 + nbr-both j1 | 84.5 | 97.9 | 98.9 | 89.1 | 93.6 | 90.9 | 86.0 | 8.2 | -3.2 | 0.0 / 0.0 | fail |
| X prf-bs m3 t10 w1 + nbr-both j2 | 84.5 | 97.9 | 98.9 | 89.1 | 93.6 | 90.9 | 86.0 | 8.2 | -3.2 | -1.8 / 0.0 | fail |
| X prf-bs m3 t10 w1 + nbr-both j3 | 84.5 | 97.9 | 98.9 | 89.1 | 93.6 | 90.9 | 86.0 | 8.2 | -3.2 | -4.2 / 0.0 | fail |
| X prf-bs m3 t10 w1 + nbr-next j2 | 84.5 | 97.9 | 98.9 | 89.1 | 93.6 | 90.9 | 86.0 | 8.2 | -3.2 | -0.3 / 0.0 | fail |
| X prf-bs m3 t10 w1 + nbr-next j3 | 84.5 | 97.9 | 98.9 | 89.1 | 93.6 | 90.9 | 86.0 | 8.2 | -3.2 | -1.4 / 0.0 | fail |
| X prf-bs m5 t10 w1 + nbr-both j2 | 85.1 | 97.9 | 98.9 | 87.2 | 93.8 | 91.0 | 86.0 | 8.7 | -2.6 | -4.2 / 0.0 | fail |
| X prf-bs m5 t10 w1 + nbr-both j3 | 85.1 | 97.9 | 98.9 | 87.2 | 93.8 | 91.0 | 86.0 | 8.7 | -2.6 | -4.6 / -0.3 | fail |
| X prf-bs m3 t10 w1 + cap5 | 84.5 | 97.9 | 98.9 | 89.1 | 93.6 | 90.9 | 86.0 | 8.2 | -3.2 | 0.0 / -0.3 | fail |
| X prf-bs m3 t10 w1 + split w0.5 | 81.7 | 97.0 | 98.9 | 85.3 | 93.2 | 88.8 | 85.1 | 11.3 | -6.0 | 0.0 / -1.5 | fail |

### Round 4 (pinned PRF)

#### LoCoMo (round units, 1536 questions, cat 1-4)

| variant | all@10 | any@10 | all@20 | any@20 | cat1 all@10 | cat1 any@10 | cat1 all@20 | cat1 any@20 | +ms/q |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 58.7 | 72.7 | 68.4 | 82.9 | 13.1 | 70.2 | 19.9 | 80.9 | 0.0 |
| R prf-bs m8 t10 w1 pin3 | 60.2 | 73.5 | 71.1 | 83.9 | 15.6 | 70.9 | 26.2 | 81.6 | 6.3 |
| R prf-bs m8 t10 w1 pin4 | 60.2 | 73.6 | 71.1 | 83.9 | 15.2 | 71.3 | 26.2 | 81.6 | 6.3 |
| R prf-bs m8 t10 w1 pin5 | 60.4 | 73.7 | 71.1 | 83.9 | 15.6 | 71.3 | 26.2 | 81.6 | 6.2 |
| R prf-bs m8 t15 w1 pin3 | 60.4 | 73.8 | 70.8 | 84.5 | 14.9 | 70.9 | 25.2 | 85.1 | 7.2 |
| R prf-bs m8 t15 w1 pin4 | 60.3 | 74.0 | 70.7 | 84.4 | 13.8 | 71.3 | 25.2 | 85.1 | 7.2 |
| R prf-bs m8 t15 w1 pin5 | 60.4 | 74.0 | 70.8 | 84.5 | 14.2 | 70.9 | 25.2 | 85.1 | 7.2 |
| R prf-bs m10 t10 w1 pin3 | 60.1 | 73.9 | 70.6 | 84.0 | 14.5 | 70.6 | 25.9 | 83.0 | 6.5 |
| R prf-bs m10 t10 w1 pin4 | 60.2 | 74.1 | 70.5 | 84.0 | 14.5 | 70.9 | 25.5 | 83.3 | 6.5 |
| R prf-bs m10 t10 w1 pin5 | 60.3 | 74.3 | 70.5 | 84.0 | 14.5 | 70.9 | 25.5 | 83.3 | 6.5 |
| R prf-bs m10 t15 w1 pin3 | 59.6 | 73.7 | 70.6 | 84.2 | 13.8 | 72.0 | 25.5 | 84.0 | 7.1 |
| R prf-bs m10 t15 w1 pin4 | 59.8 | 73.8 | 70.6 | 84.2 | 13.8 | 72.0 | 25.5 | 84.4 | 7.1 |
| R prf-bs m10 t15 w1 pin5 | 60.0 | 73.9 | 70.6 | 84.2 | 14.2 | 71.3 | 25.5 | 84.4 | 7.1 |
| R prf-bs m8 t10 w1 pin5 + nbr-both j2 | 62.8 | 75.0 | 72.9 | 85.7 | 14.5 | 69.1 | 25.5 | 83.7 | 6.3 |
| R prf-bs m8 t10 w1 pin5 + nbr-next j1 | 62.5 | 75.6 | 72.5 | 85.2 | 15.2 | 71.3 | 25.9 | 81.6 | 6.2 |
| R prf-bs m8 t10 w1 pin5 + nbr-next j2 | 62.4 | 75.2 | 72.2 | 85.0 | 15.2 | 69.9 | 24.1 | 81.9 | 6.2 |
| R prf-bs m8 t10 w1 pin5 + cap5 | 60.4 | 73.6 | 70.7 | 83.6 | 16.0 | 70.9 | 25.9 | 81.2 | 6.2 |

#### LoCoMo per-category deltas vs baseline (all@20 / any@20)

| variant | cat1 | cat2 | cat3 | cat4 |
|---|---|---|---|---|
| R prf-bs m8 t10 w1 pin3 | +6.3 / +0.7 | +1.9 / 0.0 | +6.6 / +6.5 | +1.4 / +1.0 |
| R prf-bs m8 t10 w1 pin4 | +6.3 / +0.7 | +1.9 / 0.0 | +6.6 / +6.5 | +1.4 / +1.0 |
| R prf-bs m8 t10 w1 pin5 | +6.3 / +0.7 | +1.9 / 0.0 | +6.6 / +6.5 | +1.4 / +1.0 |
| R prf-bs m8 t15 w1 pin3 | +5.3 / +4.2 | +1.3 / -0.3 | +7.7 / +7.6 | +1.3 / +0.9 |
| R prf-bs m8 t15 w1 pin4 | +5.3 / +4.2 | +1.3 / -0.3 | +7.7 / +7.6 | +1.2 / +0.7 |
| R prf-bs m8 t15 w1 pin5 | +5.3 / +4.2 | +1.3 / -0.3 | +7.7 / +7.6 | +1.3 / +0.9 |
| R prf-bs m10 t10 w1 pin3 | +6.0 / +2.1 | +0.7 / -0.3 | +4.4 / +4.4 | +1.4 / +1.0 |
| R prf-bs m10 t10 w1 pin4 | +5.6 / +2.4 | +0.7 / -0.3 | +4.4 / +4.4 | +1.3 / +0.9 |
| R prf-bs m10 t10 w1 pin5 | +5.6 / +2.4 | +0.7 / -0.3 | +4.4 / +4.4 | +1.3 / +0.9 |
| R prf-bs m10 t15 w1 pin3 | +5.6 / +3.1 | +1.9 / 0.0 | +4.4 / +5.4 | +0.9 / +0.7 |
| R prf-bs m10 t15 w1 pin4 | +5.6 / +3.5 | +1.9 / 0.0 | +4.4 / +5.4 | +0.9 / +0.7 |
| R prf-bs m10 t15 w1 pin5 | +5.6 / +3.5 | +1.9 / 0.0 | +4.4 / +5.4 | +0.9 / +0.7 |
| R prf-bs m8 t10 w1 pin5 + nbr-both j2 | +5.6 / +2.8 | +4.4 / +1.5 | +6.6 / +6.5 | +3.9 / +2.9 |
| R prf-bs m8 t10 w1 pin5 + nbr-next j1 | +6.0 / +0.7 | +2.2 / 0.0 | +5.5 / +5.4 | +4.1 / +3.5 |
| R prf-bs m8 t10 w1 pin5 + nbr-next j2 | +4.2 / +1.0 | +1.3 / -1.0 | +5.5 / +5.4 | +4.5 / +3.4 |
| R prf-bs m8 t10 w1 pin5 + cap5 | +6.0 / +0.3 | +2.2 / +0.3 | +5.5 / +6.5 | +0.8 / +0.4 |

#### LongMemEval-S (round units, 470 questions)

| variant | any@1 | any@5 | any@10 | all@5 | all@10 | ndcg@10 | multi-session all@10 | +ms/q | LME min delta | LoCoMo worst any / all delta | guard |
|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 87.7 | 98.3 | 98.9 | 84.9 | 91.7 | 90.6 | 80.2 | 0.0 | 0.0 | 0.0 / 0.0 | - |
| R prf-bs m8 t10 w1 pin3 | 87.7 | 98.1 | 98.9 | 88.7 | 94.0 | 91.5 | 86.8 | 8.4 | -0.2 | 0.0 / 0.0 | PASS |
| R prf-bs m8 t10 w1 pin4 | 87.7 | 98.1 | 98.9 | 88.3 | 94.0 | 91.4 | 86.8 | 8.3 | -0.2 | 0.0 / 0.0 | PASS |
| R prf-bs m8 t10 w1 pin5 | 87.7 | 98.3 | 98.9 | 87.7 | 94.0 | 91.2 | 86.8 | 8.2 | 0.0 | 0.0 / 0.0 | PASS |
| R prf-bs m8 t15 w1 pin3 | 87.7 | 97.7 | 98.9 | 88.9 | 94.9 | 91.5 | 88.4 | 9.1 | -0.6 | -0.3 / 0.0 | fail |
| R prf-bs m8 t15 w1 pin4 | 87.7 | 97.9 | 98.9 | 88.3 | 94.9 | 91.5 | 88.4 | 9.2 | -0.4 | -0.3 / 0.0 | fail |
| R prf-bs m8 t15 w1 pin5 | 87.7 | 98.3 | 98.9 | 87.4 | 94.9 | 91.3 | 88.4 | 9.2 | 0.0 | -0.3 / 0.0 | fail |
| R prf-bs m10 t10 w1 pin3 | 87.7 | 98.3 | 98.9 | 88.7 | 95.1 | 91.8 | 88.4 | 8.4 | 0.0 | -0.3 / 0.0 | fail |
| R prf-bs m10 t10 w1 pin4 | 87.7 | 98.3 | 98.9 | 88.3 | 95.1 | 91.6 | 88.4 | 8.5 | 0.0 | -0.3 / 0.0 | fail |
| R prf-bs m10 t10 w1 pin5 | 87.7 | 98.5 | 98.9 | 87.2 | 95.1 | 91.4 | 88.4 | 8.4 | 0.0 | -0.3 / 0.0 | fail |
| R prf-bs m10 t15 w1 pin3 | 87.7 | 97.9 | 98.9 | 88.9 | 95.1 | 91.8 | 87.6 | 9.8 | -0.4 | -0.4 / -0.3 | fail |
| R prf-bs m10 t15 w1 pin4 | 87.7 | 97.7 | 98.9 | 88.7 | 95.1 | 91.6 | 87.6 | 10.0 | -0.6 | -0.4 / -1.1 | fail |
| R prf-bs m10 t15 w1 pin5 | 87.7 | 98.3 | 98.9 | 87.7 | 95.1 | 91.5 | 87.6 | 9.8 | 0.0 | 0.0 / -1.1 | fail |
| R prf-bs m8 t10 w1 pin5 + nbr-both j2 | 87.7 | 98.3 | 98.9 | 87.7 | 94.0 | 91.2 | 86.8 | 8.2 | 0.0 | -1.1 / 0.0 | fail |
| R prf-bs m8 t10 w1 pin5 + nbr-next j1 | 87.7 | 98.3 | 98.9 | 87.7 | 94.0 | 91.2 | 86.8 | 8.2 | 0.0 | -0.4 / 0.0 | fail |
| R prf-bs m8 t10 w1 pin5 + nbr-next j2 | 87.7 | 98.3 | 98.9 | 87.7 | 94.0 | 91.2 | 86.8 | 8.2 | 0.0 | -1.9 / -0.9 | fail |
| R prf-bs m8 t10 w1 pin5 + cap5 | 87.7 | 98.3 | 98.9 | 87.7 | 94.0 | 91.2 | 86.8 | 8.2 | 0.0 | 0.0 / 0.0 | PASS |
