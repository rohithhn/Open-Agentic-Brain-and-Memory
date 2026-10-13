# Per-question proof

Every answer and every grading verdict behind the numbers in `../*.json`, one JSON object per
question, gzip-compressed (`gunzip -c qa-deep-k40.jsonl.gz | head`).

- `qa-<run>.jsonl.gz` — the run's answers: question id, type/category, the reader's answer, the gold
  answer, the Claude judge's verdict (`correct`), whether the evidence was retrieved, retrieval time.
- `qa-<run>.gpt.jsonl.gz` — the same answers re-graded by an OpenAI model via `evals/rejudge-gpt.mjs`
  (`correctGpt`), next to the Claude verdict (`correctClaude`).

Recompute any headline number from these files alone, e.g. the share of rows with `"correct":true`.
Gold answers (first 300 characters) come from LongMemEval (Wu et al., ICLR 2025,
arXiv:2410.10813), via the maintainers' `longmemeval-cleaned` release on Hugging Face
(https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned, revision `98d7416`). That release
and the LongMemEval repository (https://github.com/xiaowu0162/LongMemEval) are MIT-licensed; the
dataset-derived fields stay under that license and are attributed to its authors.
