#!/usr/bin/env node
// Tests for bin/lib/eval.mjs — the answerability check behind `brain eval --verify`.
//
//   node evals/eval-test.mjs
//
// Synthetic store under the scratchpad/tmpdir; questions are passed in, so the
// real brain.db and evals/questions.jsonl are never read.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { openStore } = await import('../bin/lib/store.mjs');
const { verifyQuestions } = await import('../bin/lib/eval.mjs');

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
}

const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `eval-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
const dbPath = join(ROOT, 'brain.db');
const db = openStore({ path: dbPath });
const ins = db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, created_at, created_at_epoch, content_hash)
  VALUES (?,?,?,?,?,?,'2026-01-01',0,?)`);
let n = 0;
const row = (project, title, narrative, facts = null) => Number(ins.run(`s${n}`, project, 'discovery', title, narrative, facts, `h${n++}`).lastInsertRowid);
row('alpha', 'WAL checkpoint lost rows', 'Fixed by running VACUUM INTO before packing the blob.');
row('alpha', 'Unrelated', 'x'.repeat(250) + ' LATE_TOKEN beyond the 240 chars the eval shows');
row('beta', 'Only half', 'mentions FIRST_HALF');
row('beta', 'Other half', 'mentions SECOND_HALF');
row('gamma', 'Facts only', '', '["uses applyMerchantAutofill()"]');
const gone = row('gamma', 'Deleted memory', 'GHOST_TOKEN');
db.prepare(`UPDATE observations SET status = 'deleted' WHERE id = ?`).run(gone);
db.close();

const ids = (bad) => bad.map((b) => b.id);
const verify = (questions) => verifyQuestions({ dbPath, questions });

await t('answerable when one row shows every term (case-insensitive, title + narrative)', () => {
  eq(verify([{ id: 'ok', expect: ['wal', 'vacuum into'] }]), [], 'answerable');
});

await t('a term past the first 240 chars of the narrative does not count', () => {
  eq(ids(verify([{ id: 'late', expect: ['LATE_TOKEN'] }])), ['late'], 'unanswerable');
});

await t('terms split across two rows are unanswerable, with per-term counts', () => {
  const bad = verify([{ id: 'split', expect: ['FIRST_HALF', 'SECOND_HALF'] }]);
  eq(ids(bad), ['split'], 'unanswerable');
  eq(bad[0].perTerm, { first_half: 1, second_half: 1 }, 'each term found alone once');
});

await t('facts are shown when the narrative is empty; the project name is shown too', () => {
  eq(verify([{ id: 'facts', expect: ['applyMerchantAutofill()'] }, { id: 'proj', expect: ['[gamma]', 'facts only'] }]), [], 'answerable');
});

await t('soft-deleted rows cannot answer; empty expect is flagged', () => {
  eq(ids(verify([{ id: 'ghost', expect: ['GHOST_TOKEN'] }, { id: 'empty', expect: [] }])), ['ghost', 'empty'], 'both flagged');
});

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\neval-test: ${pass} passed, ${fail} failed\n`);
for (const [status, name, msg] of results) console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}${msg ? `\n      ${msg}` : ''}`);
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
