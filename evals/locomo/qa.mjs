#!/usr/bin/env node
// LoCoMo end-to-end QA accuracy (LLM-judge "J", the metric mem0 publishes): the
// brain retrieves, an LLM answers briefly from what was retrieved, a second LLM
// call grades it with a judge prompt in the style of mem0's published J metric.
// Categories 1-4 are scored (as mem0 does); category 5 (adversarial) is excluded.
//
//   node evals/locomo/qa.mjs --limit 5 --jobs 3 --tag smoke   # smoke test
//   node evals/locomo/qa.mjs --stride 8                        # pilot (~190 questions)
//   node evals/locomo/qa.mjs --jobs 6 --tag main               # all 1,540
//
// Retrieval is the product's brain_recall hybrid ranking (rankUnits 'recall'/'hybrid').
// One fresh temp store per conversation (the way a user's brain holds one history).
// The top --k units go to the reader in chronological order with their session dates.
//
// LLM calls run through `claude -p` fully isolated: no hooks, no settings, no MCP,
// no tools, no session persistence, BRAIN_DISTILLER=1 and a temp cwd — so nothing
// here is ever captured into anyone's brain. Results append to
// data/qa-<tag>.jsonl (resumable: answered ids are skipped) and the summary goes
// to qa-<tag>.json next to this file.
import '../test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA, HERE, CATEGORIES, loadLocomo, allQuestions, unitsFor, turnsOf, setupModelDir, openVecCache, buildStore, rankUnits } from './lib.mjs';

setupModelDir();
const { getEmbedder, quantize } = await import('../../bin/lib/embed.mjs');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
const log = (...a) => console.error(...a);

const K = Number(arg('--k', 20));
const UNIT = arg('--unit', 'round'); // 'round' (turn + next turn) | 'turn'
const READER = arg('--reader', 'sonnet');
const JUDGE = arg('--judge', 'sonnet');
const JOBS = Number(arg('--jobs', 6));
const STRIDE = Number(arg('--stride', 1));
const LIMIT = Number(arg('--limit', Infinity));
const DEEP = flag('--deep'); // deep recall: cross-encoder rerank over a wide pool (bin/lib/rerank.mjs)
const FULL = flag('--full-context'); // baseline: the reader gets the WHOLE conversation, no retrieval
const ADV = flag('--adversarial'); // also run category 5 (reported separately, never in the headline)
const TAG = arg('--tag', `${FULL ? 'full' : `k${K}-${UNIT}${DEEP ? '-deep' : ''}`}-${READER}-${JUDGE}${STRIDE > 1 ? `-s${STRIDE}` : ''}`.replace(/[^A-Za-z0-9._-]+/g, '_'));
const OUT_JSONL = join(DATA, `qa-${TAG}.jsonl`);
const OUT_SUMMARY = join(HERE, `qa-${TAG}.json`);

// ── prompts ─────────────────────────────────────────────────────────────────
// Reader: short-answer prompt in the spirit of mem0's paper (answer from the
// memories, resolve relative times against the memory's date, keep it brief).
function readerPrompt(q, units) {
  const mem = units.map((u, i) => `[Memory ${i + 1} — conversation date: ${u.date}]\n${u.text}`).join('\n\n');
  return `You answer questions about a long conversation between two people, using only the memories retrieved below. Each memory is a snippet of that conversation with the date it took place.

Guidelines:
- Use only the memories. Think briefly about which ones are relevant, combine them if the question needs several, then answer.
- Relative time references ("yesterday", "last week", "next month") are relative to the memory's own date. Convert them to a concrete date, month or year when asked about time.
- Give a short answer: a few words or one short sentence, not an essay. If the question asks for a list, list the items.
- If the memories truly do not contain the answer, make your best-supported guess from them; only say "unknown" as a last resort.
- End your reply with a final line of the form "Answer: <short answer>".

Memories:

${mem}

Question: ${q.question}`;
}
// The reader may reason before the final line; the answer is what follows the last "Answer:".
export function parseAnswer(text) {
  const t = String(text || '').trim();
  const ms = [...t.matchAll(/answer\s*:\s*/gi)];
  if (!ms.length) return t.split('\n').filter(Boolean).at(-1) || t;
  const last = ms.at(-1);
  return t.slice(last.index + last[0].length).trim();
}

import { judgePrompt, parseLabel } from './prompts.mjs';
import { openai } from '../lib/openai.mjs';
export { parseLabel };

// ── isolated LLM call ───────────────────────────────────────────────────────
const SCRATCH = mkdtempSync(join(tmpdir(), 'locomo-qa-cwd-'));
function claude(prompt, model, { timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
      '--model', model, '--tools', '', '--output-format', 'json',
      '--system-prompt', 'You are a helpful assistant with long-term memory of past conversations with the user.'];
    const p = spawn('claude', args, { cwd: SCRATCH, env: { ...process.env, BRAIN_DISTILLER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(String(j.result || 'error').slice(0, 300)));
        resolve({ text: String(j.result || ''), usage: j.usage || {}, cost: j.total_cost_usd || 0 });
      } catch { reject(new Error(`claude exit ${code}: ${(err || out).slice(0, 300)}`)); }
    });
    p.stdin.end(prompt);
  });
}
// OpenAI models through the Codex CLI on the user's ChatGPT login: no API key,
// no per-token bill. `--ephemeral` (no session files, so no brain ever captures
// these calls), read-only sandbox, temp cwd, BRAIN_DISTILLER=1.
// Model spec: codex:<model>[@<effort>], e.g. codex:gpt-6-luna@low.
function codex(prompt, spec, { timeoutMs = 300000 } = {}) {
  const [model, effort] = spec.slice('codex:'.length).split('@');
  return new Promise((resolve, reject) => {
    const outFile = join(SCRATCH, `codex-${process.hrtime.bigint()}.txt`);
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-o', outFile];
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push('-');
    const p = spawn('codex', args, { cwd: SCRATCH, env: { ...process.env, BRAIN_DISTILLER: '1' }, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(t);
      let text = '';
      try { text = readFileSync(outFile, 'utf8'); rmSync(outFile, { force: true }); } catch {}
      if (code !== 0 || !text.trim()) return reject(new Error(`codex exit ${code}: ${err.split('\n').filter((l) => /error/i.test(l)).slice(-2).join(' | ').slice(0, 300)}`));
      const tok = Number((err.match(/tokens used[^\d]*([\d,]+)/i) || [])[1]?.replace(/,/g, '')) || 0;
      resolve({ text, usage: { input_tokens: tok }, cost: 0 });
    });
    p.stdin.end(prompt);
  });
}
const llm = (prompt, model) => (model.startsWith('codex:') ? codex(prompt, model)
  : /^gpt-|^o\d/.test(model) ? openai(prompt, model) : claude(prompt, model));

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 4000 * (i + 1))); }
  }
  throw last;
}

// ── main ────────────────────────────────────────────────────────────────────
const data = loadLocomo();
const qs = allQuestions(data, { includeAdversarial: ADV }).filter((_, i) => i % STRIDE === 0).slice(0, LIMIT);

mkdirSync(DATA, { recursive: true });
const done = new Map();
if (existsSync(OUT_JSONL)) for (const l of readFileSync(OUT_JSONL, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); done.set(r.id, r); }
const todo = qs.filter((q) => !done.has(q.id));
log(`${qs.length} questions selected (stride ${STRIDE}${ADV ? ', incl. category 5' : ', categories 1-4'}), ${done.size} already done, ${todo.length} to run · unit=${UNIT} k=${K} reader=${READER} judge=${JUDGE} jobs=${JOBS}`);

const vc = openVecCache(getEmbedder, quantize);
const work = mkdtempSync(join(tmpdir(), 'locomo-qa-'));
const convTokens = data.map((c) => Math.round(turnsOf(c).reduce((s, t) => s + t.text.length + t.date.length + 2, 0) / 4));

let active = 0, finished = 0;
const t0 = Date.now();
const queue = [];
const runOne = async (q, top, ms, evidenceRetrieved) => {
  try {
    const prompt = readerPrompt(q, top);
    const reader = await withRetry(() => llm(prompt, READER));
    const answer = parseAnswer(reader.text);
    const judge = await withRetry(() => llm(judgePrompt(q, answer), JUDGE));
    const correct = parseLabel(judge.text);
    const row = { id: q.id, conv: q.sample, category: q.category, correct, evidenceRetrieved,
      retrievalMs: Math.round(ms * 10) / 10, contextChars: prompt.length,
      readerTokens: (reader.usage.input_tokens || 0) + (reader.usage.cache_read_input_tokens || 0) + (reader.usage.cache_creation_input_tokens || 0),
      cost: reader.cost + judge.cost, question: q.question, answer: answer.slice(0, 400), gold: q.answer.slice(0, 300), judge: judge.text.slice(0, 200) };
    appendFileSync(OUT_JSONL, JSON.stringify(row) + '\n');
    done.set(row.id, row);
  } catch (e) {
    log(`  ✗ ${q.id}: ${e.message}`);
  } finally {
    active--; finished++;
    if (finished % 10 === 0 || finished === todo.length) {
      const rows = [...done.values()].filter((r) => r.category !== 5);
      log(`  ${finished}/${todo.length} · running J ${(100 * rows.filter((r) => r.correct).length / (rows.length || 1)).toFixed(1)}% over ${rows.length} · ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
};
try {
  // Retrieval is CPU-bound and sequential, conversation by conversation; LLM calls run JOBS-wide.
  for (const ci of [...new Set(todo.map((q) => q.conv))]) {
    if (FULL) {
      // Baseline: one block per session, in order, with its date — the whole conversation.
      const bySession = new Map();
      for (const t of turnsOf(data[ci])) { if (!bySession.has(t.session)) bySession.set(t.session, { date: t.date, lines: [] }); bySession.get(t.session).lines.push(t.text); }
      const top = [...bySession.values()].map((v) => ({ date: v.date, text: v.lines.join('\n') }));
      for (const q of todo.filter((x) => x.conv === ci)) {
        while (active >= JOBS) await new Promise((r) => setTimeout(r, 200));
        active++;
        queue.push(runOne(q, top, 0, q.evidence.length ? true : null));
      }
      continue;
    }
    const units = unitsFor(data[ci], UNIT);
    await vc.ensureVecs(units);
    const dbPath = join(work, `${data[ci].sample_id}.db`);
    const byRow = buildStore(dbPath, units, { vecOf: vc.vecOf });
    const order = new Map(units.map((u, i) => [u.id, i]));
    try {
      for (const q of todo.filter((x) => x.conv === ci)) {
        const t1 = performance.now();
        const { units: ranked } = await rankUnits({ dbPath, byRow, question: q.question, query: 'recall', mode: 'hybrid', deep: DEEP });
        const ms = performance.now() - t1;
        const top = ranked.slice(0, K).sort((a, b) => order.get(a.id) - order.get(b.id)); // chronological
        const have = new Set(top.flatMap((u) => u.dias));
        const evidenceRetrieved = q.evidence.length ? q.evidence.every((e) => have.has(e)) : null;
        while (active >= JOBS) await new Promise((r) => setTimeout(r, 200));
        active++;
        queue.push(runOne(q, top, ms, evidenceRetrieved));
      }
    } finally {
      for (const ext of ['', '-wal', '-shm']) rmSync(dbPath + ext, { force: true });
    }
  }
  await Promise.all(queue);
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(SCRATCH, { recursive: true, force: true });
}

// ── summary ─────────────────────────────────────────────────────────────────
const ids = new Set(qs.map((q) => q.id));
const rows = [...done.values()].filter((r) => ids.has(r.id));
const scored = rows.filter((r) => r.category !== 5);
const pct = (rs) => (rs.length ? Math.round((1000 * rs.filter((r) => r.correct).length) / rs.length) / 10 : null);
const byCategory = {};
for (const c of [1, 2, 3, 4]) { const rs = scored.filter((r) => r.category === c); byCategory[`${c}-${CATEGORIES[c]}`] = { n: rs.length, J: pct(rs) }; }
const lat = scored.map((r) => r.retrievalMs).sort((a, b) => a - b);
const pq = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
const evid = scored.filter((r) => r.evidenceRetrieved !== null && r.evidenceRetrieved !== undefined);
const convOf = new Map(data.map((c, i) => [c.sample_id, i]));
const summary = {
  benchmark: 'LoCoMo (locomo10), end-to-end QA, LLM-judge accuracy J, categories 1-4',
  config: { retrieval: `brain_recall hybrid (BM25 + all-MiniLM-L6-v2, RRF k=60, PRF)${DEEP ? ' + deep rerank' : ''}`, unit: UNIT, k: K, reader: READER, judge: JUDGE,
    judgePrompt: "mem0's published LLM-as-a-judge (J) style, CORRECT/WRONG", categoriesScored: [1, 2, 3, 4], category5: ADV ? 'run, reported separately' : 'excluded' },
  selection: { stride: STRIDE, questions: qs.length, answered: rows.length, missing: qs.length - rows.length },
  J: pct(scored),
  byCategory,
  categoryAveragedJ: Math.round(10 * Object.values(byCategory).filter((c) => c.J !== null).reduce((s, c, _, a) => s + c.J / a.length, 0)) / 10,
  ...(ADV ? { category5: { n: rows.length - scored.length, note: 'adversarial: gold is the adversarial_answer (the WRONG answer); a "correct" here means the model fell for it', fellFor: pct(rows.filter((r) => r.category === 5)) } } : {}),
  evidenceInContext: pct(evid.map((r) => ({ correct: r.evidenceRetrieved }))),
  retrievalLatencyMs: { p50: pq(0.5), p95: pq(0.95), max: lat.at(-1) },
  avgReaderTokens: Math.round(scored.reduce((s, r) => s + r.readerTokens, 0) / (scored.length || 1)),
  avgFullConversationTokensEstimate: Math.round(scored.reduce((s, r) => s + convTokens[convOf.get(r.conv)], 0) / (scored.length || 1)),
  totalCostUsdEquivalent: Math.round(rows.reduce((s, r) => s + r.cost, 0) * 100) / 100,
};
writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
