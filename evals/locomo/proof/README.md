# Per-question proof

Every answer and every grading verdict behind the numbers in `../*.json`, one JSON object per
question, gzip-compressed (`gunzip -c qa-luna-deep-k40.jsonl.gz | head`).

- `qa-<run>.jsonl.gz` — the run's answers: question id, type/category, the reader's answer, the gold
  answer, the Claude judge's verdict (`correct`), whether the evidence was retrieved, retrieval time.
- `qa-<run>.gpt.jsonl.gz` — the same answers re-graded by an OpenAI model via `evals/rejudge-gpt.mjs`
  (`correctGpt`), next to the Claude verdict (`correctClaude`).

Recompute any headline number from these files alone, e.g. the share of rows with `"correct":true`.
Questions (full text) and gold answers (first 300 characters) come from LoCoMo (Maharana et al.,
ACL 2024, arXiv:2402.17753), file `data/locomo10.json` from https://github.com/snap-research/locomo.
That repository is licensed under Creative Commons Attribution-NonCommercial 4.0 (CC BY-NC 4.0).
The dataset-derived fields in these files stay under CC BY-NC 4.0, not this project's Apache 2.0
license: attribute the LoCoMo authors and use them for non-commercial purposes only.
