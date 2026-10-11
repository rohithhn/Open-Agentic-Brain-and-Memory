// LoCoMo judge prompt + label parser, shared by qa.mjs and the cross-vendor
// re-judge (evals/rejudge-gpt.mjs). Pure functions; importing this runs nothing.
// Judge: follows mem0's published LLM-as-a-judge ("J") prompt from its LoCoMo
// evaluation — generous on wording, same topic / same date counts as CORRECT,
// label CORRECT or WRONG returned as JSON with key "label".
export function judgePrompt(q, response) {
  return `Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a 'gold' (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: ${q.question}
Gold answer: ${q.answer}
Generated answer: ${response}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will not be valid.
Return the label in JSON with key "label", e.g. {"reasoning": "...", "label": "CORRECT"}.`;
}
export function parseLabel(text) {
  const t = String(text || '');
  const j = t.match(/"label"\s*:\s*"?\s*(CORRECT|WRONG)/i);
  if (j) return j[1].toUpperCase() === 'CORRECT';
  const w = t.match(/\b(CORRECT|WRONG)\b/gi) || [];
  return w.length ? w.at(-1).toUpperCase() === 'CORRECT' : false;
}

