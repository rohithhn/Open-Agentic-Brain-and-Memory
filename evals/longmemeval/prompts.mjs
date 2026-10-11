// LongMemEval QA prompts, shared by qa.mjs and the cross-vendor re-judge
// (evals/rejudge-gpt.mjs). Pure functions; importing this runs nothing.
// ── prompts ─────────────────────────────────────────────────────────────────
// Reader: LongMemEval's "answer step by step" reading prompt, with dates.
export function readerPrompt(q, rounds) {
  const hist = rounds.map((u, i) => `### Memory ${i + 1} (session date: ${u.date})\n${u.text}`).join('\n\n');
  return `I will give you several history chats between you and a user, retrieved from your memory. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer. If the history does not contain the information needed, say that you do not know.\n\nHistory Chats:\n\n${hist}\n\nCurrent Date: ${q.question_date}\nQuestion: ${q.question}\nAnswer (step by step):`;
}

// Judge: LongMemEval evaluate_qa.py get_anscheck_prompt, per task type.
export function judgePrompt(q, response) {
  const abs = String(q.question_id).endsWith('_abs');
  if (abs) return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${q.question}\n\nExplanation: ${q.answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  const base = 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.';
  const tail = `\n\nQuestion: ${q.question}\n\nCorrect Answer: ${q.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  switch (q.question_type) {
    case 'temporal-reasoning':
      return `${base} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.${tail}`;
    case 'knowledge-update':
      return `${base.replace(' If the response only contains', ' If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer. If the response only contains')}${tail}`;
    case 'single-session-preference':
      return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${q.question}\n\nRubric: ${q.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    default:
      return base + tail;
  }
}

