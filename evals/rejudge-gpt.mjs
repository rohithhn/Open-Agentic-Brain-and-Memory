#!/usr/bin/env node
// Cross-vendor re-judge: re-grade a finished QA run's answers with an OpenAI
// model (via `codex exec`) using the benchmark's own judge prompt, so a
// headline number is not "Claude grading Claude". The answers are not
// regenerated — only the verdicts.
//
//   node evals/rejudge-gpt.mjs --bench longmemeval --tag main
//   node evals/rejudge-gpt.mjs --bench locomo --tag main --jobs 6 [--model gpt-...] [--effort low]
//
// Reads  evals/<bench>/data/qa-<tag>.jsonl   (rows written by <bench>/qa.mjs)
// Writes evals/<bench>/data/qa-<tag>.gpt.jsonl (resumable) and
//        evals/<bench>/rejudge-gpt-<tag>.json  (accuracy under both judges + agreement)
//
// Isolation: `codex exec --ephemeral` (no session files, so nothing reaches
// ~/.codex/sessions and no brain ever ingests it), read-only sandbox, a temp
// cwd, BRAIN_DISTILLER=1 so the brain's own hooks stand down.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const log = (...a) => console.error(...a);

const BENCH = arg('--bench', 'longmemeval');
const TAG = arg('--tag', 'main');
const JOBS = Number(arg('--jobs', 6));
const MODEL = arg('--model', null); // null = codex's configured default
const EFFORT = arg('--effort', 'low');
if (!['longmemeval', 'locomo'].includes(BENCH)) { log('--bench longmemeval|locomo'); process.exit(2); }

const DIR = join(HERE, BENCH);
const IN = join(DIR, 'data', `qa-${TAG}.jsonl`);
const OUT = join(DIR, 'data', `qa-${TAG}.gpt.jsonl`);
const SUMMARY = join(DIR, `rejudge-gpt-${TAG}.json`);
if (!existsSync(IN)) { log(`missing ${IN}`); process.exit(2); }

// One prompt + verdict parser per benchmark, imported from the benchmark itself.
let promptFor, verdict;
if (BENCH === 'longmemeval') {
  const { judgePrompt } = await import('./longmemeval/prompts.mjs');
  const data = JSON.parse(readFileSync(join(DIR, 'data', 'longmemeval_s_cleaned.json'), 'utf8'));
  const byId = new Map(data.map((q) => [q.question_id, q]));
  promptFor = (row) => judgePrompt(byId.get(row.id), row.answer);
  verdict = (text) => /^\W*yes/i.test(String(text).trim());
} else {
  const { judgePrompt, parseLabel } = await import('./locomo/prompts.mjs');
  promptFor = (row) => judgePrompt({ question: row.question, answer: row.gold }, row.answer);
  verdict = parseLabel;
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'rejudge-gpt-cwd-'));
let modelSeen = MODEL;
function codex(prompt, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const outFile = join(SCRATCH, `o-${process.hrtime.bigint()}.txt`);
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-c', `model_reasoning_effort="${EFFORT}"`, '-o', outFile];
    if (MODEL) args.push('-m', MODEL);
    args.push('-');
    const p = spawn('codex', args, { cwd: SCRATCH, env: { ...process.env, BRAIN_DISTILLER: '1' }, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(t);
      if (!modelSeen) modelSeen = err.match(/^model:\s*(\S+)/m)?.[1] || null;
      try {
        const text = readFileSync(outFile, 'utf8');
        rmSync(outFile, { force: true });
        if (code !== 0 || !text.trim()) throw new Error('empty');
        resolve(text);
      } catch { reject(new Error(`codex exit ${code}: ${err.split('\n').filter((l) => !/failed to load skill/.test(l)).slice(-3).join(' | ').slice(0, 300)}`)); }
    });
    p.stdin.end(prompt);
  });
}
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 5000 * (i + 1))); }
  }
  throw last;
}

const rows = readFileSync(IN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const done = new Map();
if (existsSync(OUT)) for (const l of readFileSync(OUT, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); done.set(r.id, r); }
const todo = rows.filter((r) => !done.has(r.id));
log(`${BENCH}/${TAG}: ${rows.length} answers, ${done.size} already re-judged, ${todo.length} to go · codex ${MODEL || '(default model)'} effort=${EFFORT} jobs=${JOBS}`);

let next = 0, finished = 0;
const t0 = Date.now();
async function worker() {
  while (next < todo.length) {
    const row = todo[next++];
    try {
      const text = await withRetry(() => codex(promptFor(row)));
      const r = { id: row.id, correctGpt: verdict(text), correctClaude: row.correct, judgeGpt: text.trim().slice(0, 200), model: modelSeen };
      appendFileSync(OUT, JSON.stringify(r) + '\n');
      done.set(r.id, r);
    } catch (e) {
      log(`  ✗ ${row.id}: ${e.message}`);
    }
    if (++finished % 25 === 0 || finished === todo.length) {
      const d = [...done.values()];
      log(`  ${finished}/${todo.length} · GPT-judged acc ${(100 * d.filter((x) => x.correctGpt).length / d.length).toFixed(1)}% over ${d.length} · ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
}
try {
  await Promise.all(Array.from({ length: JOBS }, worker));
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}

// ── summary ─────────────────────────────────────────────────────────────────
const ids = new Set(rows.map((r) => r.id));
const judged = [...done.values()].filter((r) => ids.has(r.id));
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const groupKey = BENCH === 'longmemeval' ? 'type' : 'category';
const byGroup = {};
const rowById = new Map(rows.map((r) => [r.id, r]));
for (const r of judged) {
  const g = String(rowById.get(r.id)[groupKey]);
  (byGroup[g] ||= { n: 0, claude: 0, gpt: 0 });
  byGroup[g].n++; byGroup[g].claude += r.correctClaude ? 1 : 0; byGroup[g].gpt += r.correctGpt ? 1 : 0;
}
for (const g of Object.values(byGroup)) { g.claude = pct(g.claude, g.n); g.gpt = pct(g.gpt, g.n); }
const summary = {
  bench: BENCH, tag: TAG, judge: { vendor: 'OpenAI via codex exec', model: judged.find((r) => r.model)?.model || MODEL || 'codex default', reasoningEffort: EFFORT },
  answers: rows.length, rejudged: judged.length, missing: rows.length - judged.length,
  accuracyClaudeJudge: pct(judged.filter((r) => r.correctClaude).length, judged.length),
  accuracyGptJudge: pct(judged.filter((r) => r.correctGpt).length, judged.length),
  agreement: pct(judged.filter((r) => r.correctGpt === r.correctClaude).length, judged.length),
  claudeYesGptNo: judged.filter((r) => r.correctClaude && !r.correctGpt).length,
  claudeNoGptYes: judged.filter((r) => !r.correctClaude && r.correctGpt).length,
  [`by_${groupKey}`]: byGroup,
};
writeFileSync(SUMMARY, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
