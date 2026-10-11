#!/usr/bin/env node
// Tests for bin/lib/economics.mjs — the tokens-saved counter — and its wiring
// into sessionstart.mjs (startup line), recall.mjs (recall/context ledger) and
// ui/server.mjs (/api/economics).
//
//   node evals/economics-test.mjs
//
// Synthetic stores under a scratch dir only. The real ~/.claude-brain is never
// written: every store, ledger and HOME here is a temp path.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../bin/lib/store.mjs';
import {
  recordDelivery, computeSavings, ledgerPathFor, compactTokens, savingsLine, estimateTokens, METHOD_SHORT,
} from '../bin/lib/economics.mjs';
import { sessionContext, renderPreview, PREVIEW_MAX_BYTES } from '../bin/lib/sessionstart.mjs';
import { recallSearch } from '../bin/lib/recall.mjs';

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `economics-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
let seq = 0;
// The suite needs recording ON; individual tests flip it off where they assert that.
delete process.env.BRAIN_NO_ECONOMICS;
delete process.env.BRAIN_DISTILLER;

/** Synthetic native store. rows: {project,title,type?,narrative?,work?,epoch?} */
function buildDb(rows, dir = ROOT) {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, `db-${++seq}.db`);
  const db = openStore({ path: dbPath });
  const mem = 'econ:test';
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
              VALUES (?,?,?,?,?,?,'completed')`).run(mem, mem, 'p', 'test', '2026-01-01T00:00:00Z', 1);
  const ins = db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, facts, narrative, concepts,
      prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash, generated_by_model)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  rows.forEach((r, i) => {
    const epoch = r.epoch ?? Date.UTC(2026, 8, 1, 9, i);
    ins.run(mem, r.project, '', r.type || 'decision', r.title, '[]', r.narrative || `narrative for ${r.title}`, '[]',
      0, r.work ?? 0, new Date(epoch).toISOString(), epoch, `h-${seq}-${i}`, 'test');
  });
  db.close();
  return dbPath;
}

// Local-time helper so day/week bucketing is asserted in the same zone the code uses.
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();
const rec = (dbPath, o) => recordDelivery({ dbPath, project: 'p', ...o });

// ── ledger + aggregation ─────────────────────────────────────────────────
await t('ledger path is keyed by the store, beside it', () => {
  eq(ledgerPathFor('/x/y/brain.db'), '/x/y/brain.economics.jsonl', 'brain.db');
  eq(ledgerPathFor('/x/y/other.db'), '/x/y/other.economics.jsonl', 'other.db');
  eq(ledgerPathFor(''), '', 'empty');
});

await t('saved = work - read, per delivery', () => {
  const db = join(ROOT, 'a.db');
  assert(rec(db, { kind: 'recall', items: [[1, 5000], [2, 3000]], readTokens: 500, now: at(2026, 9, 10) }), 'recorded');
  const s = computeSavings({ dbPath: db, now: at(2026, 9, 10) });
  eq(s.total.saved, 7500, 'saved');
  eq(s.total.work, 8000, 'work');
  eq(s.total.read, 500, 'read');
  eq(s.total.deliveries, 1, 'deliveries');
  eq(s.estimate, true, 'labelled estimate');
  assert(/Estimate/.test(s.method) && s.method === METHOD_SHORT, 'method text travels with the numbers');
});

await t('the same memory is credited once per day; again the next day', () => {
  const db = join(ROOT, 'b.db');
  rec(db, { kind: 'recall', items: [[1, 4000]], readTokens: 100, now: at(2026, 9, 10, 9) });
  rec(db, { kind: 'recall', items: [[1, 4000]], readTokens: 100, now: at(2026, 9, 10, 15) }); // repeat, same day
  let s = computeSavings({ dbPath: db, now: at(2026, 9, 10, 18) });
  eq(s.total.saved, 3900, 'repeat the same day earns nothing');
  rec(db, { kind: 'recall', items: [[1, 4000]], readTokens: 100, now: at(2026, 9, 11, 9) });
  s = computeSavings({ dbPath: db, now: at(2026, 9, 11, 18) });
  eq(s.total.saved, 7800, 'next day credits again');
});

await t('no measured work -> unmeasured, never a saving and never a loss', () => {
  const db = join(ROOT, 'c.db');
  rec(db, { kind: 'startup', items: [[1, 0], [2, 0]], readTokens: 900, now: at(2026, 9, 10) });
  const s = computeSavings({ dbPath: db, now: at(2026, 9, 10) });
  eq(s.total.saved, 0, 'saved');
  eq(s.total.read, 0, 'an unmeasured delivery is not netted as a loss');
  eq(s.total.unmeasured, 1, 'unmeasured counted');
  eq(savingsLine(s), '', 'nothing true to say -> no line');
});

await t('a delivery whose read cost exceeds its work counts 0, not negative', () => {
  const db = join(ROOT, 'd.db');
  rec(db, { kind: 'context', items: [[1, 200]], readTokens: 5000, now: at(2026, 9, 10) });
  rec(db, { kind: 'context', items: [[2, 9000]], readTokens: 1000, now: at(2026, 9, 10) });
  const s = computeSavings({ dbPath: db, now: at(2026, 9, 10) });
  eq(s.total.saved, 8000, 'only the profitable delivery adds');
});

await t('per-day and per-week buckets, today/week rollups, zero-filled, by kind', () => {
  const db = join(ROOT, 'e.db');
  // Wed 2026-09-09 and Mon 2026-09-14 are different Mon-start weeks; now = Tue 2026-09-15.
  rec(db, { kind: 'recall', items: [[1, 1000]], readTokens: 0, now: at(2026, 9, 9) });
  rec(db, { kind: 'startup', items: [[2, 2000]], readTokens: 0, now: at(2026, 9, 14) });
  rec(db, { kind: 'context', items: [[3, 4000]], readTokens: 0, now: at(2026, 9, 15) });
  const s = computeSavings({ dbPath: db, now: at(2026, 9, 15, 20) });
  eq(s.total.saved, 7000, 'total');
  eq(s.today.saved, 4000, 'today');
  eq(s.week.saved, 7000, 'last 7 days incl. today');
  eq(s.daily.length, 14, '14 daily buckets');
  eq(s.daily.at(-1).day, '2026-09-15', 'newest day last');
  eq(s.daily.at(-1).saved, 4000, 'day value');
  eq(s.daily.find((d) => d.day === '2026-09-12').saved, 0, 'gap days are zero-filled');
  eq(s.weekly.length, 8, '8 weekly buckets');
  eq(s.weekly.at(-1).week, '2026-09-14', 'Monday-start week key');
  eq(s.weekly.at(-1).saved, 6000, 'this week (Mon 14 + Tue 15)');
  eq(s.weekly.at(-2).saved, 1000, 'previous week');
  eq(s.byKind.recall.saved, 1000, 'recall');
  eq(s.byKind.startup.saved, 2000, 'startup');
  eq(s.byKind.context.saved, 4000, 'context');
  eq(s.since, '2026-09-09', 'since');
});

await t('a torn / hand-edited ledger line is skipped, the rest still counts', () => {
  const db = join(ROOT, 'f.db');
  rec(db, { kind: 'recall', items: [[1, 1000]], readTokens: 0, now: at(2026, 9, 10) });
  appendFileSync(ledgerPathFor(db), '{"t": 17, "k": "rec\nnot json at all\n{"t":"x"}\n');
  eq(computeSavings({ dbPath: db, now: at(2026, 9, 10) }).total.saved, 1000, 'still 1000');
});

await t('missing ledger / missing store -> zeros, no throw', () => {
  const s = computeSavings({ dbPath: join(ROOT, 'nope.db') });
  eq(s.total.saved, 0, 'zero');
  eq(s.since, null, 'no since');
  eq(computeSavings({}).total.saved, 0, 'no dbPath');
});

await t('recordDelivery never throws: bad dir, bad kind, empty items; opt-outs respected', () => {
  eq(recordDelivery({ dbPath: '/nonexistent-dir-xyz/brain.db', kind: 'recall', items: [[1, 5]], readTokens: 1 }), false, 'unwritable');
  eq(recordDelivery({ dbPath: join(ROOT, 'g.db'), kind: 'bogus', items: [[1, 5]], readTokens: 1 }), false, 'bad kind');
  eq(recordDelivery({ dbPath: join(ROOT, 'g.db'), kind: 'recall', items: [], readTokens: 1 }), false, 'empty');
  eq(recordDelivery(), false, 'no args');
  process.env.BRAIN_NO_ECONOMICS = '1';
  eq(rec(join(ROOT, 'g.db'), { kind: 'recall', items: [[1, 5]], readTokens: 1 }), false, 'BRAIN_NO_ECONOMICS');
  delete process.env.BRAIN_NO_ECONOMICS;
  process.env.BRAIN_DISTILLER = '1';
  eq(rec(join(ROOT, 'g.db'), { kind: 'recall', items: [[1, 5]], readTokens: 1 }), false, 'the brain\'s own runs are not user work');
  delete process.env.BRAIN_DISTILLER;
  assert(!existsSync(ledgerPathFor(join(ROOT, 'g.db'))), 'nothing written');
});

await t('bare ids get their work looked up from the store (read-only)', () => {
  const db = buildDb([{ project: 'p', title: 'one', work: 6000 }, { project: 'p', title: 'two', work: 0 }]);
  rec(db, { kind: 'context', items: [1, 2], readTokens: 1000, now: at(2026, 9, 10) });
  const s = computeSavings({ dbPath: db, now: at(2026, 9, 10) });
  eq(s.total.work, 6000, 'only the measured row carries work');
  eq(s.total.saved, 5000, 'saved');
});

await t('compactTokens / savingsLine formatting', () => {
  eq(compactTokens(950), '950', 'small');
  eq(compactTokens(1234), '1.2k', 'k');
  eq(compactTokens(45_600), '46k', 'k >=10');
  eq(compactTokens(3_400_000), '3.4M', 'M');
  eq(compactTokens(-5), '0', 'negative clamps');
  const line = savingsLine({ total: { saved: 3_400_000 }, today: { saved: 12_000 }, week: { saved: 150_000 } });
  eq(line, '~3.4M tokens saved so far · 12k today · 150k this week (estimate)', 'line');
  eq(savingsLine({ total: { saved: 900 }, today: { saved: 900 }, week: { saved: 900 } }), '~900 tokens saved so far · 900 today (estimate)', 'no duplicate week when equal to today');
  eq(savingsLine(null), '', 'null');
});

// ── startup preview ──────────────────────────────────────────────────────
await t('startup: records a delivery and the preview carries ONE estimate line, inside the 3.5KB cap', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ project: 'proj', title: `Decision number ${i}`, work: 4000, epoch: Date.UTC(2026, 8, 1, 9, i) }));
  const dbPath = buildDb(rows);
  const out = sessionContext({ project: 'proj', dbPath });
  assert(out.text, 'block rendered');
  const lines = out.preview.split('\n').filter((l) => /tokens saved so far/.test(l));
  eq(lines.length, 1, 'exactly one savings line');
  assert(/\(estimate\)/.test(lines[0]), 'labelled as an estimate');
  assert(Buffer.byteLength(out.preview, 'utf8') <= PREVIEW_MAX_BYTES, `preview ${Buffer.byteLength(out.preview)}B over ${PREVIEW_MAX_BYTES}`);
  const s = computeSavings({ dbPath });
  eq(s.byKind.startup.deliveries, 1, 'one startup delivery logged');
  assert(s.total.saved > 0, 'saved > 0');
  // honest: the credited work is the sum over the rows actually delivered
  eq(s.total.work, out.rows * 4000, 'work = delivered rows x discovery_tokens');
  eq(s.total.read, out.tokens, 'read = the block we actually handed over');
});

await t('startup: a second session the same day adds nothing (no inflation)', () => {
  const dbPath = buildDb([{ project: 'proj', title: 'Only decision', work: 4000 }]);
  sessionContext({ project: 'proj', dbPath });
  const first = computeSavings({ dbPath }).total.saved;
  sessionContext({ project: 'proj', dbPath });
  sessionContext({ project: 'proj', dbPath });
  eq(computeSavings({ dbPath }).total.saved, first, 'same memories, same day -> same total');
  eq(computeSavings({ dbPath }).byKind.startup.deliveries, 3, 'but every delivery is still counted');
});

await t('startup: no measured work -> no savings line at all (nothing fabricated)', () => {
  const dbPath = buildDb([{ project: 'proj', title: 'No work data', work: 0 }]);
  const out = sessionContext({ project: 'proj', dbPath });
  assert(!/tokens saved/.test(out.preview), 'no line');
});

await t('startup: record:false writes no ledger', () => {
  const dbPath = buildDb([{ project: 'proj', title: 'x', work: 4000 }]);
  sessionContext({ project: 'proj', dbPath, record: false });
  assert(!existsSync(ledgerPathFor(dbPath)), 'no ledger file');
});

await t('startup: an unwritable ledger location does not break the block', () => {
  const dir = join(ROOT, 'ro-dir');
  const dbPath = buildDb([{ project: 'proj', title: 'x', work: 4000 }], dir);
  // A directory squatting on the ledger path makes the append fail.
  mkdirSync(ledgerPathFor(dbPath), { recursive: true });
  const out = sessionContext({ project: 'proj', dbPath });
  assert(out.text && out.rows === 1, 'block still rendered');
});

await t('renderPreview: savings line appears under the economics heading only when given', () => {
  const base = { project: 'p', total: 1, recent: [{ id: 1, type: 'decision', title: 't', __date: new Date(), __tool: '' }], color: false };
  const withSav = renderPreview({ ...base, economics: { rows: 1, readTokens: 10, workTokens: 100,
    savings: { total: { saved: 90 }, today: { saved: 90 }, week: { saved: 90 } } } });
  assert(withSav.includes('~90 tokens saved so far'), 'line present');
  const without = renderPreview({ ...base, economics: { rows: 1, readTokens: 10, workTokens: 100 } });
  assert(!without.includes('saved so far'), 'absent without savings');
});

// ── recall / context ─────────────────────────────────────────────────────
await t('recallSearch logs a recall delivery with the returned ids and their work', async () => {
  const dbPath = buildDb([
    { project: 'proj', title: 'Quokka scheduler bug', narrative: 'the quokka scheduler drifts', work: 8000 },
    { project: 'proj', title: 'Quokka retry policy', narrative: 'quokka retries thrice', work: 2000 },
    { project: 'proj', title: 'Unrelated thing', narrative: 'nothing to see', work: 99999 },
  ]);
  const out = await recallSearch({ query: 'quokka', dbPath });
  eq(out.count, 2, 'two hits');
  const s = computeSavings({ dbPath });
  eq(s.byKind.recall.deliveries, 1, 'one recall logged');
  eq(s.byKind.recall.work, 10000, 'work of the two returned rows only (not the unrelated 99999)');
  const readTokens = estimateTokens(JSON.stringify(out.results));
  eq(s.byKind.recall.read, readTokens, 'read = the result payload actually returned');
  eq(s.byKind.recall.saved, 10000 - readTokens, 'saved');
});

await t('recallSearch: a miss logs nothing, and results are unchanged by logging', async () => {
  const dbPath = buildDb([{ project: 'proj', title: 'Axolotl', narrative: 'axolotl', work: 500 }]);
  const miss = await recallSearch({ query: 'zzzzqqqq', dbPath });
  eq(miss.count, 0, 'miss');
  assert(!existsSync(ledgerPathFor(dbPath)), 'no ledger for an empty result');
  process.env.BRAIN_NO_ECONOMICS = '1';
  const off = await recallSearch({ query: 'axolotl', dbPath });
  delete process.env.BRAIN_NO_ECONOMICS;
  const on = await recallSearch({ query: 'axolotl', dbPath });
  eq(JSON.stringify(on), JSON.stringify(off), 'identical output with logging on/off');
});

await t('taskContext (fake HOME subprocess) logs a context delivery for the observations in the block', () => {
  const home = join(ROOT, `home-ctx-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const brainDb = join(home, '.claude-brain', 'brain.db');
  const db = openStore({ path: brainDb });
  const mem = 'econ:ctx';
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,'completed')`)
    .run(mem, mem, 'proj-z', 'test', '2026-01-01T00:00:00Z', 1);
  db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, facts, narrative, concepts, prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash, generated_by_model)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mem, 'proj-z', '', 'discovery', 'Wombat compaction stall', '[]', 'The wombat compaction job stalls when the lock is held.', '[]', 0, 7000, '2026-01-01T00:00:00Z', 1, 'h-ctx-1', 'test');
  db.close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'ok\n');
  const script = join(ROOT, `ctx-${seq}.mjs`);
  writeFileSync(script, `import { taskContext } from ${JSON.stringify(fileURLToPath(new URL('../bin/lib/recall.mjs', import.meta.url)))};
    const o = await taskContext({ task: 'wombat compaction lock stall' }); process.stdout.write(JSON.stringify({ used: o.used }));`);
  const env = { ...process.env, HOME: home };
  delete env.BRAIN_NO_ECONOMICS; delete env.BRAIN_DISTILLER;
  const o = JSON.parse(execFileSync(process.execPath, [script], { env, encoding: 'utf8' }));
  assert(o.used >= 1, 'context found the row');
  const s = computeSavings({ dbPath: brainDb });
  eq(s.byKind.context.deliveries, 1, 'one context delivery');
  eq(s.byKind.context.work, 7000, 'work of the observation in the block');
});

// ── panel API ────────────────────────────────────────────────────────────
await t('ui: GET /api/economics serves computeSavings() for the store (fake HOME server)', async () => {
  const home = join(ROOT, `home-ui-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const brainDb = join(home, '.claude-brain', 'brain.db');
  openStore({ path: brainDb }).close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'ok\n');
  rec(brainDb, { kind: 'recall', items: [[1, 5000]], readTokens: 1000, now: Date.now() });
  const port = 39000 + (process.pid % 900);
  const env = { ...process.env, HOME: home, BRAIN_UI_PORT: String(port) };
  const srv = spawn(process.execPath, [fileURLToPath(new URL('../ui/server.mjs', import.meta.url))], { env, stdio: 'ignore' });
  try {
    let body = null;
    for (let i = 0; i < 40 && !body; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/economics`);
        if (r.ok) body = await r.json();
      } catch { /* not up yet */ }
    }
    assert(body, 'server answered /api/economics');
    eq(body.total.saved, 4000, 'saved over the wire');
    eq(body.estimate, true, 'estimate flag');
    assert(typeof body.method === 'string' && body.method.length > 40, 'method text present for the tooltip');
    assert(Array.isArray(body.daily) && Array.isArray(body.weekly), 'daily/weekly present');
  } finally { srv.kill('SIGKILL'); }
});

await t('ui: the dashboard wires the card to the count-up layer (plain comma integer in .big)', () => {
  const app = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8');
  assert(app.includes("api('/api/economics')") && app.includes('savedCard('), 'app.js fetches + renders the card');
  assert(/Tokens saved/.test(app) && /est\./.test(app), 'card is labelled as an estimate');
  assert(/title="\$\{esc\(tip\)/.test(app), 'tooltip carries the method');
  // count-up only animates /^\d[\d,]*$/ — the big value must be toLocaleString(), not "3.4M"
  assert(app.includes("(e.total.saved||0).toLocaleString()"), 'big value is a plain comma-formatted integer');
});

rmSync(ROOT, { recursive: true, force: true });
for (const [s, n, m] of results) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${m ? `\n      ${m}` : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
