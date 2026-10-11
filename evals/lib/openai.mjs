// OpenAI chat models for the QA harnesses (evals/longmemeval/qa.mjs, evals/locomo/qa.mjs).
//
// Key source: OPENAI_API_KEY, else the macOS Keychain item "openai-api-key". Store it once
// from the clipboard (the interactive `security ... -w` prompt truncates at 128 chars, and
// project keys are ~164):  security add-generic-password -U -a "$USER" -s openai-api-key -w "$(pbpaste)"
// The key is read once, kept only in memory, never logged or written anywhere.
import { execFileSync } from 'node:child_process';

// USD per 1M input / output tokens (published third-party rates; used only to report cost).
export const OPENAI_PRICE = { 'gpt-4o-mini': [0.15, 0.60], 'gpt-6-luna': [0.10, 0.50] };

let cachedKey;
export function openaiKey() {
  if (cachedKey !== undefined) return cachedKey;
  cachedKey = process.env.OPENAI_API_KEY || null;
  if (!cachedKey && process.platform === 'darwin') {
    try {
      cachedKey = execFileSync('security', ['find-generic-password', '-s', 'openai-api-key', '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch { cachedKey = null; }
  }
  return cachedKey;
}

export const isOpenAIModel = (model) => /^gpt-|^o\d/.test(String(model));

/** One chat completion. Returns { text, usage: { input_tokens }, cost }. */
export async function openai(prompt, model, { timeoutMs = 120000 } = {}) {
  const key = openaiKey();
  if (!key) throw new Error('no OpenAI key: set OPENAI_API_KEY, or store it in the macOS Keychain (see evals/lib/openai.mjs)');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    // Older chat models take temperature 0; newer reasoning models reject the parameter.
    body: JSON.stringify({ model, ...(/^gpt-4/.test(model) ? { temperature: 0 } : {}), messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`openai ${res.status}: ${String(j.error?.message || '').slice(0, 200)}`);
  const u = j.usage || {};
  const [pin, pout] = OPENAI_PRICE[model] || [0, 0];
  return {
    text: String(j.choices?.[0]?.message?.content || ''),
    usage: { input_tokens: u.prompt_tokens || 0 },
    cost: ((u.prompt_tokens || 0) * pin + (u.completion_tokens || 0) * pout) / 1e6,
  };
}
