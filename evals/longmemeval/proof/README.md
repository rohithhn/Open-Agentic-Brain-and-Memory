# Per-question proof

Every answer and every grading verdict behind the numbers in `../*.json`, one JSON object per
question, gzip-compressed (`gunzip -c qa-deep-k40.jsonl.gz | head`).

- `qa-<run>.jsonl.gz` — the run's answers: question id, type/category, the reader's answer, the gold
  answer, the Claude judge's verdict (`correct`), whether the evidence was retrieved, retrieval time.
- `qa-<run>.gpt.jsonl.gz` — the same answers re-graded by an OpenAI model via `evals/rejudge-gpt.mjs`
  (`correctGpt`), next to the Claude verdict (`correctClaude`).

Recompute any headline number from these files alone, e.g. the share of rows with `"correct":true`.
Questions and gold answers come from the public LongMemEval dataset and stay under that
dataset's own license; see its repository.
