#!/usr/bin/env node
// LongMemEval-S end-to-end QA accuracy: the brain retrieves, an LLM answers from
// what was retrieved, a second LLM call grades the answer with LongMemEval's own
// judge prompts (adapted from the official evaluate_qa.py). This is the metric
// memory products put on leaderboards; run.mjs measures retrieval only.
//
//   node evals/longmemeval/qa.mjs --stride 8                # pilot (~63 questions)
//   node evals/longmemeval/qa.mjs                           # all 500 (incl. 30 abstention)
//   node evals/longmemeval/qa.mjs --k 20 --reader sonnet --judge sonnet --jobs 6 --tag main
//
// Retrieval is the product's brain_recall hybrid ranking (rankUnits 'recall'/'hybrid',
// round units, exactly what run.mjs scores). The top --k rounds go to the reader in
// chronological order with their session dates and the question date — the brain
// stores dates on every memory, so this is what a client would see.
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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
process.env.BRAIN_MODEL_DIR ||= join(DATA, 'models');
process.env.BRAIN_NO_ECONOMICS = '1';

const { unitsFor, unitEmbedText, vecKey, buildStore, rankUnits } = await import('./lib.mjs');
const { getEmbedder, quantize } = await import('../../bin/lib/embed.mjs');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
const log = (...a) => console.error(...a);

const K = Number(arg('--k', 20));
const VARIANT = arg('--variant', 's'); // 's' (~115k-token histories) | 'm' (~1.5M tokens; streamed, see stream.mjs)
const READER = arg('--reader', 'sonnet');
const JUDGE = arg('--judge', 'sonnet');
const DEEP = flag('--deep'); // deep recall: cross-encoder rerank over a wide pool (bin/lib/rerank.mjs)
const JOBS = Number(arg('--jobs', 6));
const STRIDE = Number(arg('--stride', 1));
const LIMIT = Number(arg('--limit', Infinity));
const TAG = arg('--tag', `${VARIANT === 'm' ? 'm-' : ''}k${K}-${READER}-${JUDGE}${DEEP ? '-deep' : ''}${STRIDE > 1 ? `-s${STRIDE}` : ''}`);
const OUT_JSONL = join(DATA, `qa-${TAG}.jsonl`);
const OUT_SUMMARY = join(HERE, `qa-${TAG}.json`);

import { readerPrompt, judgePrompt } from './prompts.mjs';
import { openai, isOpenAIModel } from '../lib/openai.mjs';

// ── isolated LLM call ───────────────────────────────────────────────────────
const SCRATCH = mkdtempSync(join(tmpdir(), 'lme-qa-cwd-'));
const llm = (prompt, model) => (isOpenAIModel(model) ? openai(prompt, model) : claude(prompt, model));
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
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 4000 * (i + 1))); }
  }
  throw last;
}

// ── main ────────────────────────────────────────────────────────────────────
const dataPath = join(DATA, VARIANT === 'm' ? 'longmemeval_m_cleaned.json' : 'longmemeval_s_cleaned.json');
if (!existsSync(dataPath)) { log(`dataset missing: ${dataPath}`); process.exit(2); }
// S is parsed whole (277 MB). M (~2.7 GB) is streamed twice: a first pass keeps only ids
// for the selection, the second hands one question at a time to retrieval, so memory
// stays at one question's history however large the file is.
const STREAM = VARIANT === 'm';
const { streamJsonArray } = await import('./stream.mjs');
let qs;
if (STREAM) {
  const lite = [];
  for await (const o of streamJsonArray(dataPath)) lite.push({ question_id: o.question_id, question_type: o.question_type });
  qs = lite.sort((a, b) => (a.question_id < b.question_id ? -1 : 1)).filter((_, i) => i % STRIDE === 0).slice(0, LIMIT);
} else {
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  qs = data.slice().sort((a, b) => (a.question_id < b.question_id ? -1 : 1)).filter((_, i) => i % STRIDE === 0).slice(0, LIMIT);
}
const hayChars = new Map(); // question_id -> characters of its history (for the token-saving figure)

mkdirSync(DATA, { recursive: true });
const done = new Map();
if (existsSync(OUT_JSONL)) for (const l of readFileSync(OUT_JSONL, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); done.set(r.id, r); }
const todo = qs.filter((q) => !done.has(q.question_id));
log(`${qs.length} questions selected (stride ${STRIDE}), ${done.size} already done, ${todo.length} to run · k=${K} reader=${READER} judge=${JUDGE} jobs=${JOBS}`);

// Embeddings: the shared cache from run.mjs; anything missing (abstention
// haystacks were never embedded there) is embedded now and cached.
const cache = new DatabaseSync(join(DATA, 'embed-cache.db'), { timeout: 60000 }); // other harnesses share this cache
cache.exec('CREATE TABLE IF NOT EXISTS vec (h TEXT PRIMARY KEY, v BLOB NOT NULL)');
const getVec = cache.prepare('SELECT v FROM vec WHERE h = ?');
const putVec = cache.prepare('INSERT OR REPLACE INTO vec (h, v) VALUES (?, ?)');
let embedder = null;
async function ensureVecs(units) {
  const missing = [...new Map(units.map((u) => [vecKey(unitEmbedText(u)), unitEmbedText(u)])).entries()].filter(([h]) => !getVec.get(h));
  if (!missing.length) return;
  embedder ||= await getEmbedder({ allowRemote: true });
  if (!embedder) throw new Error('embedding model unavailable');
  for (let i = 0; i < missing.length; i += 8) {
    const chunk = missing.slice(i, i + 8);
    const vecs = await embedder(chunk.map((c) => c[1]));
    chunk.forEach(([h], j) => putVec.run(h, quantize(vecs[j])));
  }
}
const vecOf = (u) => { const r = getVec.get(vecKey(unitEmbedText(u))); return r ? new Int8Array(r.v.buffer, r.v.byteOffset, r.v.byteLength) : null; };

const work = mkdtempSync(join(tmpdir(), 'lme-qa-'));
async function retrieve(q) {
  const units = unitsFor(q, 'round');
  await ensureVecs(units);
  const dbPath = join(work, `${q.question_id}.db`);
  const byRow = buildStore(dbPath, units, { vecOf });
  try {
    const t0 = performance.now();
    const { units: ranked } = await rankUnits({ dbPath, byRow, question: q.question, query: 'recall', mode: 'hybrid', deep: DEEP });
    const ms = performance.now() - t0;
    const top = ranked.slice(0, K);
    const order = new Map(units.map((u, i) => [u.id, i]));
    top.sort((a, b) => order.get(a.id) - order.get(b.id)); // chronological, as the haystack is
    return { top, ms, evidenceRetrieved: top.some((u) => (q.answer_session_ids || []).includes(u.session)) };
  } finally {
    for (const ext of ['', '-wal', '-shm']) rmSync(dbPath + ext, { force: true });
  }
}

// Retrieval is CPU-bound and sequential; LLM calls run JOBS-wide.
let active = 0, finished = 0;
const t0 = Date.now();
const queue = [];
const runOne = async (q, top, ms, evidenceRetrieved) => {
  try {
    const prompt = readerPrompt(q, top);
    const reader = await withRetry(() => llm(prompt, READER));
    const judge = await withRetry(() => llm(judgePrompt(q, reader.text), JUDGE));
    const correct = /^\W*yes/i.test(judge.text.trim());
    const row = { id: q.question_id, type: q.question_type, abstention: String(q.question_id).endsWith('_abs'), correct,
      evidenceRetrieved, retrievalMs: Math.round(ms * 10) / 10, contextChars: prompt.length,
      readerTokens: (reader.usage.input_tokens || 0) + (reader.usage.cache_read_input_tokens || 0) + (reader.usage.cache_creation_input_tokens || 0),
      cost: reader.cost + judge.cost, answer: reader.text, judge: judge.text.slice(0, 20), gold: String(q.answer).slice(0, 300) };
    appendFileSync(OUT_JSONL, JSON.stringify(row) + '\n');
    done.set(row.id, row);
  } catch (e) {
    log(`  ✗ ${q.question_id}: ${e.message}`);
  } finally {
    active--; finished++;
    if (finished % 10 === 0 || finished === todo.length) {
      const rows = [...done.values()];
      log(`  ${finished}/${todo.length} · running acc ${(100 * rows.filter((r) => r.correct).length / rows.length).toFixed(1)}% over ${rows.length} · ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
};
try {
  const want = new Set(todo.map((q) => q.question_id));
  const source = STREAM ? streamJsonArray(dataPath) : todo;
  for await (const full of source) {
    if (!want.has(full.question_id)) continue;
    hayChars.set(full.question_id, JSON.stringify(full.haystack_sessions).length);
    const { top, ms, evidenceRetrieved } = await retrieve(full);
    // Keep only what the reader and judge need; the history itself is released here.
    const q = { question_id: full.question_id, question_type: full.question_type, question: full.question,
      question_date: full.question_date, answer: full.answer, answer_session_ids: full.answer_session_ids };
    while (active >= JOBS) await new Promise((r) => setTimeout(r, 200));
    active++;
    queue.push(runOne(q, top, ms, evidenceRetrieved));
  }
  await Promise.all(queue);
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(SCRATCH, { recursive: true, force: true });
}

// ── summary ─────────────────────────────────────────────────────────────────
const ids = new Set(qs.map((q) => q.question_id));
const rows = [...done.values()].filter((r) => ids.has(r.id));
const pct = (rs) => (rs.length ? Math.round((1000 * rs.filter((r) => r.correct).length) / rs.length) / 10 : null);
const byType = {};
for (const t of [...new Set(rows.map((r) => r.type))].sort()) byType[t] = { n: rows.filter((r) => r.type === t).length, accuracy: pct(rows.filter((r) => r.type === t)) };
const lat = rows.map((r) => r.retrievalMs).sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
const summary = {
  benchmark: `LongMemEval-${VARIANT.toUpperCase()} (cleaned), end-to-end QA accuracy`,
  config: { retrieval: `brain_recall hybrid (BM25 + all-MiniLM-L6-v2, RRF k=60, PRF)${DEEP ? ' + deep rerank (ms-marco-MiniLM-L-6-v2 over a ~150-row pool)' : ''}, round units`, k: K, reader: READER, judge: JUDGE, judgePrompts: 'LongMemEval evaluate_qa.py, per type' },
  selection: { stride: STRIDE, questions: qs.length, answered: rows.length, missing: qs.length - rows.length },
  accuracy: pct(rows),
  accuracyNonAbstention: pct(rows.filter((r) => !r.abstention)),
  abstention: { n: rows.filter((r) => r.abstention).length, accuracy: pct(rows.filter((r) => r.abstention)) },
  taskAveragedAccuracy: Math.round(10 * Object.values(byType).reduce((s, t) => s + t.accuracy, 0) / Object.keys(byType).length) / 10,
  byType,
  evidenceInContext: pct(rows.filter((r) => !r.abstention).map((r) => ({ correct: r.evidenceRetrieved }))),
  retrievalLatencyMs: { p50: q(0.5), p95: q(0.95), max: lat.at(-1) },
  avgReaderTokens: Math.round(rows.reduce((s, r) => s + r.readerTokens, 0) / (rows.length || 1)),
  avgHaystackTokensEstimate: hayChars.size ? Math.round([...hayChars.values()].reduce((a, b) => a + b, 0) / hayChars.size / 4) : null,
  totalCostUsdEquivalent: Math.round(rows.reduce((s, r) => s + r.cost, 0) * 100) / 100,
};
writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
