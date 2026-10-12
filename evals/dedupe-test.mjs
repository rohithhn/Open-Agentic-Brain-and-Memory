#!/usr/bin/env node
// Tests for duplicate memories — bin/lib/memkey.mjs + bin/lib/dedupe.mjs, and
// their wiring into brain_remember, ingest, the distiller, `brain clean
// --dupes`, recall, brain_context, the startup block (preview + block), the
// folder digest and the control panel.
//
//   node evals/dedupe-test.mjs
//
// The rolled-back first attempt (evals/overnight-rollbacks.md) cleared merged
// rows into marker rows that surfaced as blank "(untitled)" lines. Every check
// that touches a reader here also asserts: no "(untitled)" line, no blank row,
// and each memory shown once.
//
// SAFETY: synthetic stores and fake $HOMEs under the scratchpad / $TMPDIR only.
// ingest, brain_context and the panel run in children with HOME=<fake>.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, writeFileSync, appendFileSync, rmSync, chmodSync, statSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore, LIFECYCLE_COLUMN_NAMES } from '../bin/lib/store.mjs';
import { normText, memoryKey, collapseDuplicates } from '../bin/lib/memkey.mjs';
import { findHeldDuplicate, markDuplicate, unmarkDuplicate, planDuplicates, DUPLICATE } from '../bin/lib/dedupe.mjs';
import { hasLifecycle, liveOnly, planLifecycle, planClear, supersedeOlder, rerankByLifecycle, lifecycleCounts } from '../bin/lib/lifecycle.mjs';
import { cleanDupes, formatDupesReport } from '../bin/lib/clean.mjs';
import { rememberObservation, newMcpSession } from '../bin/lib/remember.mjs';
import { recallSearch } from '../bin/lib/recall.mjs';
import { sessionContext } from '../bin/lib/sessionstart.mjs';
import { distillPending, pendingSessions, resetBinaryCache } from '../bin/lib/distiller.mjs';
import { importClaudeMem } from '../bin/lib/import-claude-mem.mjs';
import { pinMemory, openForCuration, deleteMemory, editMemory } from '../bin/lib/curate.mjs';
import { INGEST_STATE_PREFIX } from '../bin/lib/ingest.mjs';
import { withPrivateCopy } from './lib/private-copy.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `dedupe-test-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
process.env.BRAIN_NO_ECONOMICS = '1';
process.env.BRAIN_EMBED = '0'; // BM25 only: no model load

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.stack && !e.message.includes('\n') ? e.message : e.message]); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m}\n    expected: ${B}\n    actual:   ${A}`);
}

const ro = (p) => new DatabaseSync(p, { readOnly: true });
const rw = (p) => new DatabaseSync(p);
function q(p, sql, ...a) { const db = ro(p); try { return db.prepare(sql).all(...a); } finally { db.close(); } }
const fileHash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const DAY = 86400000;
let seq = 0;

/**
 * Synthetic native store. rows: {project, title, subtitle?, facts?, narrative?,
 * text?, type?, epoch?, gbm?, mem?} → { dbPath, ids }. Each row gets its own
 * session (as separate captures do). migrated:false drops the lifecycle
 * columns, like the real, never-migrated store.
 */
function buildDb(rows, { path, migrated = true } = {}) {
  const dbPath = path || join(ROOT, `db-${++seq}.db`);
  mkdirSync(dirname(dbPath), { recursive: true });
  openStore({ path: dbPath }).close();
  const db = rw(dbPath);
  try {
    if (!migrated) {
      db.exec('DROP INDEX IF EXISTS idx_observations_status');
      for (const c of LIFECYCLE_COLUMN_NAMES) db.exec(`ALTER TABLE observations DROP COLUMN ${c}`);
    }
    const insS = db.prepare(`INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status)
                             VALUES (?,?,?,?,?,?,?,'completed')`);
    const insO = db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
        prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash, generated_by_model)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const ids = rows.map((r, i) => {
      const epoch = r.epoch ?? Date.UTC(2026, 8, 1, 9, i);
      const mem = r.mem || `dd:${seq}:${i}`;
      insS.run(mem, mem, r.project || 'proj', 'claude', 'a real task', new Date(epoch).toISOString(), epoch);
      const facts = r.facts === undefined ? '[]' : typeof r.facts === 'string' ? r.facts : JSON.stringify(r.facts);
      return Number(insO.run(mem, r.project || 'proj', r.text ?? (r.narrative || ''), r.type || 'discovery', r.title ?? null, r.subtitle ?? null,
        facts, r.narrative ?? null, '[]', 0, 100, new Date(epoch).toISOString(), epoch, `h-${seq}-${i}`, r.gbm || 'test').lastInsertRowid);
    });
    return { dbPath, ids };
  } finally { db.close(); }
}

const CONTENT_COLS = ['id', 'memory_session_id', 'project', 'text', 'type', 'title', 'subtitle', 'facts', 'narrative', 'concepts',
  'files_read', 'files_modified', 'created_at', 'created_at_epoch', 'content_hash', 'generated_by_model', 'metadata'];
const contentSnapshot = (p) => JSON.stringify(q(p, `SELECT ${CONTENT_COLS.join(', ')} FROM observations ORDER BY id`));

/** Reader checks shared by every scenario: no "(untitled)", no blank line,
 *  each title at most once in the startup block and preview. */
function assertStartupClean(dbPath, project, { expectTitles = [] } = {}) {
  const out = sessionContext({ project, dbPath, record: false });
  for (const [what, text] of [['block', out.text], ['preview', out.preview || '']]) {
    assert(!/\(untitled\)/.test(text), `${what} has an (untitled) row:\n${text}`);
    assert(!/#\d+ \S\s+\d{1,2}:\d{2}\s*$/m.test(text), `${what} has a row with an empty title:\n${text}`);
  }
  for (const title of expectTitles) {
    eq(out.text.split(title).length - 1, 1, `startup block lists "${title}" exactly once`);
  }
  return out;
}

// ── 1. the key ──────────────────────────────────────────────────────────────
await t('memoryKey: case, spacing, trailing punctuation, fact order and repeats do not make a new memory', () => {
  const a = { title: 'Fixed the login redirect loop', subtitle: 'Auth', facts: ['Cookie path was /api.', 'Now it is /'], narrative: 'The redirect looped.' };
  const b = { title: '  fixed the LOGIN   redirect loop. ', subtitle: 'auth', facts: JSON.stringify(['now it is /', 'cookie path was /api', 'Now it is /']), narrative: 'the redirect looped' };
  eq(memoryKey(a), memoryKey(b), 'same memory');
  eq(normText('Ｆｕｌｌ　width！'), 'full width', 'NFKC + trailing punctuation');
});
await t('memoryKey: wording, numbers, operators, signs and versions DO make a new memory', () => {
  const base = { title: 'Retry policy', facts: ['timeout < 30s'] };
  const pairs = [
    [['timeout < 30s'], ['timeout > 30s']], [['offset -1'], ['offset 1']], [['a == b'], ['a != b']],
    [['pinned v1.2.0'], ['pinned v1 2 0']], [['42 rows'], ['43 rows']], [['timeout < 30s'], ['timeout < 30s', 'and one more fact']],
  ];
  for (const [x, y] of pairs) assert(memoryKey({ ...base, facts: x }) !== memoryKey({ ...base, facts: y }), `${x} vs ${y} must differ`);
  assert(memoryKey({ ...base, subtitle: 'one' }) !== memoryKey({ ...base, subtitle: 'two' }), 'subtitle counts');
  assert(memoryKey({ ...base, narrative: 'n1' }) !== memoryKey({ ...base, narrative: 'n2' }), 'narrative counts');
});
await t('memoryKey: raw text counts only without facts/narrative; nothing to compare → no key', () => {
  eq(memoryKey({ title: 'S', facts: ['f'], text: 'transcript one' }), memoryKey({ title: 'S', facts: ['f'], text: 'transcript two' }), 'distilled rows: source transcript ignored');
  assert(memoryKey({ title: 'S', text: 'transcript one' }) !== memoryKey({ title: 'S', text: 'transcript two' }), 'raw rows: transcript is the content');
  eq(memoryKey({ title: '', subtitle: 'only a subtitle', facts: '[]', narrative: '', text: '' }), null, 'keyless');
  eq(memoryKey({ title: null, facts: null }), null, 'keyless (nulls)');
});

// ── 2. read-side collapse ───────────────────────────────────────────────────
await t('collapseDuplicates: drops only a twin of a row already listed; order, distinct same-title rows and keyless rows kept', () => {
  const { dbPath, ids } = buildDb([
    { title: 'Deploy notes', facts: ['uses blue/green'] },
    { title: 'deploy notes.', facts: ['Uses blue/green'] },    // twin of 0
    { title: 'Deploy notes', facts: ['uses canary'] },          // same title, different memory
    { title: 'Deploy notes', facts: ['uses blue/green'], project: 'other' }, // other project
    { title: '', subtitle: 'x' },
    { title: '', subtitle: 'x' },                               // keyless: never collapsed
  ]);
  const db = ro(dbPath);
  try {
    const rows = q(dbPath, 'SELECT id, project, title FROM observations ORDER BY id DESC');
    const out = collapseDuplicates(db, rows).map((r) => r.id);
    eq(out, [ids[5], ids[4], ids[3], ids[2], ids[1]], 'newest twin kept, older twin dropped, the rest untouched');
    eq(collapseDuplicates(db, rows, { limit: 2 }).map((r) => r.id), [ids[5], ids[4]], 'limit');
    const broken = { prepare() { throw new Error('boom'); } };
    eq(collapseDuplicates(broken, rows).length, rows.length, 'a failing read returns the input unchanged');
  } finally { db.close(); }
});

// ── 3. brain_remember ───────────────────────────────────────────────────────
await t('remember: the same memory in other bytes, at any age, is a duplicate (+1 relevance), a corrected fact is new', async () => {
  const { dbPath } = buildDb([]);
  const t0 = Date.UTC(2026, 6, 1);
  const s = newMcpSession('claude_code', t0);
  const first = await rememberObservation({ title: 'Cache TTL is fifteen minutes', project: 'api', type: 'decision', facts: ['TTL < 15m', 'set in cache.ts'] }, { dbPath, session: s, now: t0 });
  eq(first.status, 'saved', 'first saved');
  const later = newMcpSession('codex', t0 + 30 * DAY);
  const again = await rememberObservation({ title: 'cache ttl is  fifteen minutes.', project: 'api', type: 'decision', facts: ['Set in cache.ts', 'ttl < 15m'] }, { dbPath, session: later, now: t0 + 30 * DAY });
  eq([again.status, again.id], ['duplicate', first.id], 'same memory 30 days later → duplicate of the held row');
  eq(q(dbPath, 'SELECT relevance_count r FROM observations WHERE id = ?', first.id)[0].r, 1, 'held row +1 relevance');
  const corrected = await rememberObservation({ title: 'Cache TTL is fifteen minutes', project: 'api', type: 'decision', facts: ['TTL > 15m', 'set in cache.ts'] }, { dbPath, session: later, now: t0 + 30 * DAY });
  eq(corrected.status, 'saved', 'a changed operator is a new memory');
  eq(q(dbPath, 'SELECT COUNT(*) n FROM observations')[0].n, 2, 'two rows');
});
await t('remember: hidden rows (deleted / merged duplicate) never swallow a fresh save', async () => {
  const { dbPath, ids } = buildDb([
    { project: 'api', title: 'Queue drains nightly', facts: ['at 02:00'] },
    { project: 'api', title: 'Queue drains nightly', facts: ['at 02:00'] },
  ]);
  const db = rw(dbPath);
  try { markDuplicate(db, ids[1], ids[0]); deleteMemory(db, ids[0]); } finally { db.close(); }
  const r = await rememberObservation({ title: 'Queue drains nightly', project: 'api', type: 'discovery', facts: ['at 02:00'] }, { dbPath, now: Date.UTC(2026, 9, 1) });
  eq(r.status, 'saved', 'saved as a new memory');
});

// ── 4. distiller ────────────────────────────────────────────────────────────
function makeStub(out) {
  const bin = join(ROOT, `stub-claude-${++seq}`);
  writeFileSync(bin, `#!${process.execPath}
let d = ''; process.stdin.on('data', (c) => { d += c; }); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(out)}); });
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}
function stubEnv(bin) {
  resetBinaryCache();
  return {
    ...process.env,
    BRAIN_DISTILL_CLAUDE_BIN: bin,
    BRAIN_DISTILL_CODEX_BIN: join(ROOT, 'missing'),
    BRAIN_DISTILL_AGY_BIN: join(ROOT, 'missing'),
    PATH: join(ROOT, 'empty-path'), HOME: join(ROOT, 'distill-home'),
  };
}
const distilled = (title, facts = ['orders/list.ts pages by an opaque cursor.', 'Page size is capped at 100 rows.']) => JSON.stringify({
  title, subtitle: 'Cursor pagination with a hard page-size cap.', type: 'feature', facts,
  narrative: 'The orders endpoint returned every row; cursor pagination was added with a page-size cap.',
  concepts: ['pagination'],
});
const rawSessions = (n, project = 'webapp') => Array.from({ length: n }, (_, i) => ({
  project, type: 'session', gbm: 'claude', title: `add pagination (${i})`, subtitle: 'via claude', mem: `claude:sess-${seq}-${i}`,
  text: `user: add pagination to the orders endpoint, attempt ${i}\nassistant: working on orders/list.ts`,
  narrative: `user: add pagination to the orders endpoint, attempt ${i}\nassistant: working on orders/list.ts`,
}));

for (const migrated of [true, false]) {
  await t(`distiller (${migrated ? 'migrated' : 'never-migrated'} store): two sessions distilled to the same memory → one shown, nothing blank, nothing re-queued`, async () => {
    const { dbPath, ids } = buildDb(rawSessions(2), { migrated });
    const rep = await distillPending(dbPath, { env: stubEnv(makeStub(distilled('Added cursor pagination to the orders endpoint'))), limit: 10, concurrency: 1 });
    eq([rep.distilled, rep.merged], [2, 1], `both upgraded, one folded (report ${JSON.stringify({ ...rep, providers: undefined })})`);
    eq(pendingSessions(dbPath).length, 0, 'nothing pending: both sessions are done');
    const rows = q(dbPath, `SELECT id, title, generated_by_model g, relevance_count r${migrated ? ', status, superseded_by' : ''} FROM observations ORDER BY id`);
    assert(rows.every((r) => r.title && r.g.startsWith('brain/')), 'both rows are full distilled rows (no blank marker)');
    if (migrated) {
      const hidden = rows.filter((r) => r.status === DUPLICATE);
      eq(hidden.length, 1, 'one row hidden');
      const kept = rows.find((r) => r.status !== DUPLICATE);
      eq(hidden[0].superseded_by, kept.id, 'points at the kept row');
      eq(kept.r, 1, 'kept row +1 relevance');
    }
    assertStartupClean(dbPath, 'webapp', { expectTitles: ['Added cursor pagination to the orders endpoint'] });
    const rc = await recallSearch({ query: 'cursor pagination orders', dbPath, limit: 10 });
    eq(rc.results.length, 1, `recall returns the memory once (${JSON.stringify(rc.results.map((r) => r.id))})`);
    assert(ids.length === 2, 'fixture');
  });
}
await t('distiller: a re-distillation that no longer matches brings the hidden row back (and takes its relevance back)', async () => {
  const { dbPath } = buildDb(rawSessions(2));
  await distillPending(dbPath, { env: stubEnv(makeStub(distilled('Added cursor pagination to the orders endpoint'))), limit: 10, concurrency: 1 });
  const hidden = q(dbPath, 'SELECT id, memory_session_id m, superseded_by s FROM observations WHERE status = ?', DUPLICATE)[0];
  const db = rw(dbPath);
  try { db.prepare("UPDATE capture_state SET status = 'pending', bytes = 0 WHERE transcript_path = ?").run(`distill:${hidden.m}`); }
  finally { db.close(); }
  const rep = await distillPending(dbPath, { env: stubEnv(makeStub(distilled('Added keyset pagination to the orders endpoint'))), limit: 10 });
  eq([rep.distilled, rep.merged], [1, 0], 're-distilled, not merged');
  const r = q(dbPath, 'SELECT status, title FROM observations WHERE id = ?', hidden.id)[0];
  eq([r.status, r.title], ['active', 'Added keyset pagination to the orders endpoint'], 'back in view with its new content');
  eq(q(dbPath, 'SELECT relevance_count r FROM observations WHERE id = ?', hidden.s)[0].r, 0, 'relevance it added is taken back');
});

// A provider that words every answer differently, as a real model does.
function makeParaphraseStub() {
  const bin = join(ROOT, `stub-para-${++seq}`);
  const counter = join(ROOT, `stub-para-${seq}.n`);
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
let n = 0; try { n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) || 0; } catch {}
fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
const titles = ['Added cursor pagination to the orders endpoint', 'Orders endpoint now pages by cursor', 'Cursor-based paging for orders'];
const out = ${JSON.stringify(JSON.parse(distilled('X')))};
out.title = titles[n % titles.length];
let d = ''; process.stdin.on('data', (c) => { d += c; }); process.stdin.on('end', () => { process.stdout.write(JSON.stringify(out)); });
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}
const sameTranscript = (n, project = 'webapp') => Array.from({ length: n }, (_, i) => ({
  project, type: 'session', gbm: 'claude', title: 'add pagination', subtitle: 'via claude', mem: `claude:same-${seq}-${i}`,
  text: 'user: add pagination to the orders endpoint\nassistant: working on orders/list.ts',
  narrative: 'user: add pagination to the orders endpoint\nassistant: working on orders/list.ts',
}));

await t('distiller after clean --dupes: a hidden raw copy is never distilled (no tokens, no un-hide), a deleted row neither', async () => {
  const { dbPath, ids } = buildDb([...sameTranscript(2), { ...rawSessions(1)[0], mem: `claude:del-${seq}` }], { path: join(ROOT, `own-dir-${++seq}`, 'brain.db') });
  const c = cleanDupes({ dbPath, apply: true });
  eq(c.hidden, 1, 'clean hid the copy');
  const { db } = openForCuration(dbPath);
  try { deleteMemory(db, ids[2]); } finally { db.close(); }
  eq(pendingSessions(dbPath).map((r) => r.obsId), [ids[0]], 'only the kept capture is pending (not the hidden copy, not the deleted row)');
  const rep = await distillPending(dbPath, { env: stubEnv(makeParaphraseStub()), limit: 10, concurrency: 1 });
  eq([rep.distilled, rep.merged], [1, 0], `one distillation (${JSON.stringify({ ...rep, providers: undefined, byProvider: undefined })})`);
  const st = new Map(q(dbPath, 'SELECT id, status, superseded_by s FROM observations').map((x) => [x.id, x]));
  eq([st.get(ids[1]).status, st.get(ids[1]).s], [DUPLICATE, ids[0]], 'the copy stays hidden once the kept row is distilled (same source transcript)');
  eq(st.get(ids[2]).status, 'deleted', 'the deleted row stays deleted');
  eq(pendingSessions(dbPath).length, 0, 'nothing pending afterwards');
  const rc = await recallSearch({ query: 'pagination orders endpoint cursor', dbPath, limit: 10 });
  eq(rc.results.map((r) => r.id), [ids[0]], 'recall shows the session once');
  assertStartupClean(dbPath, 'webapp');
});

await t('distiller: re-distilling an already-merged row adds no relevance; a pinned row is not merged or counted', async () => {
  const { dbPath } = buildDb(rawSessions(2));
  const stub = makeStub(distilled('Added cursor pagination to the orders endpoint'));
  await distillPending(dbPath, { env: stubEnv(stub), limit: 10, concurrency: 1 });
  const hidden = q(dbPath, 'SELECT id, memory_session_id m, superseded_by s FROM observations WHERE status = ?', DUPLICATE)[0];
  for (let k = 0; k < 2; k++) {
    const db = rw(dbPath);
    try { db.prepare("UPDATE capture_state SET status = 'pending', bytes = 0 WHERE transcript_path = ?").run(`distill:${hidden.m}`); }
    finally { db.close(); }
    const rep = await distillPending(dbPath, { env: stubEnv(stub), limit: 10 });
    eq([rep.distilled, rep.merged], [1, 0], `re-distilled, not merged again (run ${k + 1})`);
  }
  eq(q(dbPath, 'SELECT relevance_count r FROM observations WHERE id = ?', hidden.s)[0].r, 1, 'kept row still +1 only');
  eq(q(dbPath, 'SELECT status, superseded_by s FROM observations WHERE id = ?', hidden.id)[0], { status: DUPLICATE, s: hidden.s }, 'still hidden');
  const db = rw(dbPath);
  try { eq(unmarkDuplicate(db, hidden.id), true, 'undo'); } finally { db.close(); }
  eq(q(dbPath, 'SELECT relevance_count r FROM observations WHERE id = ?', hidden.s)[0].r, 0, 'undo takes back all it added');

  const p = buildDb(rawSessions(2));
  const c = openForCuration(p.dbPath);
  try { pinMemory(c.db, p.ids[0], true); } finally { c.db.close(); }
  const rep = await distillPending(p.dbPath, { env: stubEnv(stub), limit: 10, concurrency: 1 });
  eq([rep.distilled, rep.merged], [2, 0], 'a pinned row is never folded, so nothing is counted');
  eq(q(p.dbPath, 'SELECT SUM(relevance_count) r, SUM(status = ?) d FROM observations', DUPLICATE)[0], { r: 0, d: 0 }, 'no relevance, nothing hidden');
});

await t('distiller: when the kept row is re-distilled to something else, its copies come back', async () => {
  const { dbPath } = buildDb(rawSessions(2));
  await distillPending(dbPath, { env: stubEnv(makeStub(distilled('Added cursor pagination to the orders endpoint'))), limit: 10, concurrency: 1 });
  const hidden = q(dbPath, 'SELECT id, superseded_by s FROM observations WHERE status = ?', DUPLICATE)[0];
  const keptM = q(dbPath, 'SELECT memory_session_id m FROM observations WHERE id = ?', hidden.s)[0].m;
  const db = rw(dbPath);
  try { db.prepare("UPDATE capture_state SET status = 'pending', bytes = 0 WHERE transcript_path = ?").run(`distill:${keptM}`); }
  finally { db.close(); }
  await distillPending(dbPath, { env: stubEnv(makeStub(distilled('Added keyset pagination to the orders endpoint'))), limit: 10 });
  eq(q(dbPath, 'SELECT status, superseded_by s FROM observations WHERE id = ?', hidden.id)[0], { status: 'active', s: null }, 'the copy holds content no live row has any more: back in view');
  eq(q(dbPath, 'SELECT relevance_count r FROM observations WHERE id = ?', hidden.s)[0].r, 0, 'its relevance taken back');
  assertStartupClean(dbPath, 'webapp', { expectTitles: ['Added cursor pagination to the orders endpoint', 'Added keyset pagination to the orders endpoint'] });
});

// ── 5. ingest ───────────────────────────────────────────────────────────────
function makeHome(name) {
  const home = join(ROOT, name);
  mkdirSync(join(home, '.claude', 'projects', '-Users-x-code-webapp'), { recursive: true });
  mkdirSync(join(home, '.claude', 'projects', '-Users-x-code-other'), { recursive: true });
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const store = join(home, '.claude-brain', 'brain.db');
  openStore({ path: store }).close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'test\n');
  return { home, store };
}
function runIngest(home) {
  const child = `
    const { MEMORY_DB } = await import(${JSON.stringify(join(REPO, 'bin/lib/paths.mjs'))});
    if (!MEMORY_DB.startsWith(${JSON.stringify(home)})) { console.log('UNSAFE ' + MEMORY_DB); process.exit(3); }
    const { ingest } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
    console.log(JSON.stringify(await ingest({ only: ['claude'] })));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ingest child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()).claude;
}
const cline = (sid, dir, type, text, ts) => JSON.stringify({
  type, cwd: `/Users/x/code/${dir}`, sessionId: sid, timestamp: ts,
  message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
}) + '\n';
const tfile = (home, dir, sid) => join(home, '.claude', 'projects', `-Users-x-code-${dir}`, `${sid}.jsonl`);

await t('ingest: a new session with a transcript the project already holds is not stored twice; it is captured once it grows', () => {
  const H = makeHome('h-ingest');
  const S1 = 'aaaaaaaa-1111-4111-8111-000000000001', S2 = 'aaaaaaaa-1111-4111-8111-000000000002', S3 = 'aaaaaaaa-1111-4111-8111-000000000003';
  const body = (sid, dir) => cline(sid, dir, 'user', 'run the release checklist', '2026-09-01T10:00:00.000Z') +
    cline(sid, dir, 'assistant', 'Checklist done.', '2026-09-01T10:01:00.000Z');
  writeFileSync(tfile(H.home, 'webapp', S1), body(S1, 'webapp'));
  writeFileSync(tfile(H.home, 'webapp', S2), body(S2, 'webapp'));
  writeFileSync(tfile(H.home, 'other', S3), body(S3, 'other')); // same words, another project: its own memory
  let r = runIngest(H.home);
  eq([r.sessions, r.observations, r.duplicates], [3, 2, 1], `first run (${JSON.stringify(r)})`);
  const rows = q(H.store, 'SELECT memory_session_id m, project, relevance_count rc FROM observations ORDER BY id');
  eq(rows.map((x) => x.project).sort(), ['other', 'webapp'], 'one row per project');
  eq(rows.find((x) => x.project === 'webapp').rc, 1, 'held row +1 relevance');
  const skipped = rows.some((x) => x.m === `claude:${S1}`) ? S2 : S1;
  eq(q(H.store, 'SELECT status FROM capture_state WHERE transcript_path = ?', `${INGEST_STATE_PREFIX}claude:${skipped}`)[0]?.status, 'duplicate', 'skipped session bookmarked as duplicate');
  r = runIngest(H.home);
  eq([r.sessions, r.observations, r.duplicates, r.refreshed], [0, 0, 0, 0], 'second run: no change, no relevance inflation');
  eq(q(H.store, "SELECT relevance_count rc FROM observations WHERE project = 'webapp'")[0].rc, 1, 'relevance not bumped again');
  appendFileSync(tfile(H.home, 'webapp', skipped), cline(skipped, 'webapp', 'user', 'now tag v2.4.0 and push', '2026-09-01T10:05:00.000Z'));
  r = runIngest(H.home);
  eq(r.observations, 1, `grown session is captured now (${JSON.stringify(r)})`);
  const mine = q(H.store, 'SELECT text, title FROM observations WHERE memory_session_id = ?', `claude:${skipped}`);
  eq(mine.length, 1, 'its own row');
  assert(mine[0].text.includes('v2.4.0') && mine[0].title, 'with its whole transcript and a title');
  eq(runIngest(H.home).observations, 0, 'then idempotent');
  assertStartupClean(H.store, 'webapp');
});

// ── 6. brain clean --dupes ──────────────────────────────────────────────────
const cleanFixture = (opts) => buildDb([
  { project: 'shop', title: 'Stripe webhook secret rotated', facts: ['rotated in vault', 'old key revoked'], narrative: 'Rotated after the leak.' },
  { project: 'shop', title: 'stripe webhook secret rotated.', facts: ['Old key revoked', 'rotated in vault'], narrative: 'rotated after the leak' },
  { project: 'shop', title: 'Stripe webhook secret rotated', facts: ['rotated in vault', 'old key revoked'], narrative: 'Rotated after the leak.' },
  { project: 'shop', title: 'Stripe webhook secret rotated', facts: ['rotated in vault', 'old key revoked', 'alerts added'], narrative: 'Rotated after the leak.' }, // differs
  { project: 'shop', title: 'Nightly tracker refreshed', facts: ['42 open'] },
  { project: 'shop', title: 'Nightly tracker refreshed', facts: ['43 open'] },  // differs: numbers count
  { project: 'shop', type: 'session', gbm: 'claude', title: 'deploy', subtitle: 'via claude', text: 'user: deploy\nassistant: done', narrative: 'user: deploy\nassistant: done' },
  { project: 'shop', type: 'session', gbm: 'claude', title: 'deploy', subtitle: 'via claude', text: 'user: deploy\nassistant: done', narrative: 'user: deploy\nassistant: done' },
  { project: 'blog', title: 'Stripe webhook secret rotated', facts: ['rotated in vault', 'old key revoked'], narrative: 'Rotated after the leak.' }, // other project
  { project: 'misc', title: '', subtitle: 'orphan' },
  { project: 'misc', title: '', subtitle: 'orphan' }, // keyless: left alone (and in their own project, so the
                                                      // startup check below sees only the dedupe fixture)
], opts);

await t('clean --dupes dry run: read-only (file bytes unchanged), counts only effectively-identical copies', () => {
  const { dbPath } = cleanFixture({ migrated: false });
  const before = fileHash(dbPath);
  const r = cleanDupes({ dbPath });
  eq(fileHash(dbPath), before, 'store file byte-identical');
  eq(existsSync(join(dirname(dbPath), 'backups')), false, 'no backup on a dry run');
  eq([r.applied, r.migrated, r.groups, r.copies, r.keyless], [false, false, 2, 3, 2], 'two memories held more than once, three copies');
  eq(r.sameTitleDifferent, 2, 'two same-title groups left alone (different content)');
  const text = formatDupesReport(r);
  assert(text.includes('dry run') && text.includes('--apply'), 'report says it is a dry run');
  assert(!text.includes('Rotated after the leak'), 'report never prints row content');
});

await t('clean --dupes --apply (never-migrated store): verified 0600 backup, migration, copies hidden — never deleted or blanked', async () => {
  const { dbPath, ids } = cleanFixture({ migrated: false });
  const content = contentSnapshot(dbPath);
  const r = cleanDupes({ dbPath, apply: true });
  assert(r.backupPath && existsSync(r.backupPath), 'backup written');
  eq(statSync(r.backupPath).mode & 0o777, 0o600, 'backup is 0600');
  const b = ro(r.backupPath);
  try {
    eq(b.prepare('PRAGMA quick_check').get().quick_check, 'ok', 'backup passes quick_check');
    eq(b.prepare('SELECT COUNT(*) n FROM observations').get().n, ids.length, 'backup holds every row');
    eq(b.prepare('PRAGMA table_info(observations)').all().some((c) => c.name === 'status'), false, 'backup taken before the migration');
  } finally { b.close(); }
  eq([r.hidden, r.remaining, r.observationsAfter], [3, 0, ids.length], 'three hidden, none left, no row deleted');
  eq(contentSnapshot(dbPath), content, 'every content column of every row is untouched');
  const st = q(dbPath, 'SELECT id, status, superseded_by s, relevance_count rc FROM observations ORDER BY id');
  const byId = new Map(st.map((x) => [x.id, x]));
  for (const id of [ids[1], ids[2]]) eq([byId.get(id).status, byId.get(id).s], [DUPLICATE, ids[0]], `#${id} hidden as a copy of the oldest`);
  eq([byId.get(ids[7]).status, byId.get(ids[7]).s], [DUPLICATE, ids[6]], 'raw transcript copy hidden');
  eq(byId.get(ids[0]).rc, 2, 'kept row +1 relevance per copy');
  for (const i of [3, 4, 5, 8, 9, 10]) eq(byId.get(ids[i]).status, 'active', `#${ids[i]} left alone`);
  eq([r.blankVisible, r.blankAfter], [2, 2], 'no new blank visible row (the two keyless fixture rows were already there)');
  // a second run finds nothing
  const again = cleanDupes({ dbPath, apply: true });
  eq([again.groups, again.backupPath], [0, null], 'idempotent, no needless backup');
  // readers
  const blk = assertStartupClean(dbPath, 'shop').text;
  for (const i of [0, 3, 4, 5, 6]) assert(blk.includes(`#${ids[i]} `), `startup lists #${ids[i]}`);
  for (const i of [1, 2, 7]) assert(!blk.includes(`#${ids[i]} `), `startup never lists hidden copy #${ids[i]}`);
  const rc = await recallSearch({ query: 'stripe webhook secret rotated vault', dbPath, limit: 20 });
  const shop = rc.results.filter((x) => x.project === 'shop').map((x) => x.id).sort((a, b) => a - b);
  eq(shop, [ids[0], ids[3]], 'recall: the memory once, plus the different same-title row');
  assert(rc.results.every((x) => x.title), 'recall: no blank row');
  // lifecycle passes leave hidden rows hidden
  const db = rw(dbPath);
  try {
    assert(!planLifecycle(db).changes.some((c) => [ids[1], ids[2], ids[7]].includes(c.id)), 'planLifecycle never relabels a duplicate');
    assert(!planClear(db).changes.some((c) => [ids[1], ids[2], ids[7]].includes(c.id)), 'lifecycle --clear never brings a duplicate back');
    eq(lifecycleCounts(db).duplicate, 3, 'lifecycle counts report them');
    eq(rerankByLifecycle([{ id: 1, lc_status: DUPLICATE, score: -1 }, { id: 2, score: -0.5 }]).map((x) => x.id), [2], 'rerank drops hidden rows');
  } finally { db.close(); }
});

await t('clean --dupes then a panel edit of the kept row: its copies are re-planned (one comes back, the other folds into it)', async () => {
  const { dbPath, ids } = cleanFixture({ migrated: true });
  cleanDupes({ dbPath, apply: true });
  eq(q(dbPath, 'SELECT relevance_count r FROM observations WHERE id = ?', ids[0])[0].r, 2, 'fixture: two copies folded in');
  const { db } = openForCuration(dbPath);
  try {
    const r = editMemory(db, ids[0], { narrative: 'Rotated after the leak; on-call is now paged on webhook failures.' }, {});
    assert(r.ok, JSON.stringify(r));
  } finally { db.close(); }
  const st = new Map(q(dbPath, 'SELECT id, status, superseded_by s, relevance_count rc FROM observations').map((x) => [x.id, x]));
  eq([st.get(ids[1]).status, st.get(ids[1]).s], ['active', null], 'the oldest copy holds the old wording: back in view');
  eq([st.get(ids[2]).status, st.get(ids[2]).s], [DUPLICATE, ids[1]], 'the other copy now folds into it');
  eq([st.get(ids[0]).rc, st.get(ids[1]).rc], [0, 1], 'relevance moved with it');
  eq([st.get(ids[7]).status, st.get(ids[7]).s], [DUPLICATE, ids[6]], 'other groups untouched');
  const rc = await recallSearch({ query: 'stripe webhook secret rotated vault', dbPath, limit: 20 });
  eq(rc.results.filter((x) => x.project === 'shop').map((x) => x.id).sort((a, b) => a - b), [ids[0], ids[1], ids[3]], 'recall: each distinct memory once');
  assertStartupClean(dbPath, 'shop');
});

await t('clean --dupes: a pinned copy is kept (and kept visible); hand-set statuses stay visible', () => {
  const { dbPath, ids } = buildDb([
    { project: 'p', title: 'Use pnpm', facts: ['not npm'] },
    { project: 'p', title: 'Use pnpm', facts: ['not npm'] },
    { project: 'p', title: 'Use pnpm', facts: ['not npm'] },
  ]);
  const { db } = openForCuration(dbPath);
  try {
    pinMemory(db, ids[2], true);
    db.prepare("UPDATE observations SET status = 'stale', status_reason = 'manual: keep' WHERE id = ?").run(ids[1]);
  } finally { db.close(); }
  const r = cleanDupes({ dbPath, apply: true });
  const st = new Map(q(dbPath, 'SELECT id, status FROM observations').map((x) => [x.id, x.status]));
  eq([st.get(ids[2]), st.get(ids[1]), st.get(ids[0])], ['active', 'stale', DUPLICATE], 'pinned row survives, manual row untouched, plain copy hidden');
  eq([r.hidden, r.keptVisible], [1, 1], 'counts');
});

await t('clean --dupes --undo: dry run, then everything back with its prior status, relevance taken back', () => {
  const { dbPath, ids } = cleanFixture({ migrated: true });
  const db0 = rw(dbPath);
  try { db0.prepare("UPDATE observations SET status = 'stale', status_reason = 'lint: concept x is stale' WHERE id = ?").run(ids[2]); } finally { db0.close(); }
  cleanDupes({ dbPath, apply: true });
  const before = fileHash(dbPath);
  const dry = cleanDupes({ dbPath, undo: true });
  eq([dry.applied, dry.restore], [false, 3], 'dry run counts them');
  eq(fileHash(dbPath), before, 'dry run is read-only');
  const r = cleanDupes({ dbPath, undo: true, apply: true });
  eq(r.restored, 3, 'restored');
  assert(r.backupPath && existsSync(r.backupPath), 'backup before undo');
  const st = new Map(q(dbPath, 'SELECT id, status, status_reason sr, relevance_count rc FROM observations').map((x) => [x.id, x]));
  eq([st.get(ids[1]).status, st.get(ids[2]).status, st.get(ids[2]).sr], ['active', 'stale', 'lint: concept x is stale'], 'prior statuses back');
  eq(st.get(ids[0]).rc, 0, 'relevance back');
});

await t('sync after clean: merging the pre-clean copy back re-inserts nothing and un-hides nothing', () => {
  const { dbPath, ids } = cleanFixture({ migrated: false });
  const src = join(ROOT, `pre-clean-${++seq}.db`);
  execFileSync('cp', [dbPath, src]);
  cleanDupes({ dbPath, apply: true });
  const r = importClaudeMem({ source: src, dest: dbPath, apply: true, resume: false, verify: true, touchReady: false, log: () => {} });
  assert(!r.error, `import ok: ${JSON.stringify(r).slice(0, 300)}`);
  eq(q(dbPath, 'SELECT COUNT(*) n FROM observations')[0].n, ids.length, 'no row re-inserted');
  eq(q(dbPath, 'SELECT COUNT(*) n FROM observations WHERE status = ?', DUPLICATE)[0].n, 3, 'copies still hidden');
});

await t('clean --dupes refuses a write to claude-mem\'s own DB path; the CLI wires --dupes / --undo', () => {
  const out = spawnSync(process.execPath, [join(REPO, 'bin/brain.mjs'), 'clean', '--dupes', '--db', cleanFixture({}).dbPath], { encoding: 'utf8' });
  eq(out.status, 0, `exit 0: ${out.stderr}`);
  assert(out.stdout.includes('Would merge duplicate memories'), out.stdout);
  const bad = spawnSync(process.execPath, [join(REPO, 'bin/brain.mjs'), 'clean', '--self-capture', '--undo'], { encoding: 'utf8' });
  eq(bad.status, 1, '--undo only with --dupes');
});

// ── 7. readers on a never-cleaned, never-migrated store ─────────────────────
await t('readers (never-cleaned store): startup block + preview, recall and the folder digest show each memory once, nothing blank', async () => {
  const home = join(ROOT, `home-readers-${++seq}`);
  const dbPath = join(home, '.claude-brain', 'brain.db');
  const titles = ['Rate limiter uses a token bucket', 'Retries back off exponentially', 'Health check moved to /livez'];
  const rows = [];
  titles.forEach((title, i) => { for (let k = 0; k < 4; k++) rows.push({ project: 'svc', title: k % 2 ? title.toLowerCase() : title, facts: [`fact ${i}`], epoch: Date.UTC(2026, 8, 2, 9, i * 10 + k) }); });
  const { ids } = buildDb(rows, { path: dbPath, migrated: false });
  assert(!hasLifecycle(ro(dbPath)), 'fixture is un-migrated');
  const out = assertStartupClean(dbPath, 'svc');
  eq(out.rows, 3, 'three memories, three lines');
  for (const title of titles) eq(out.text.toLowerCase().split(title.toLowerCase()).length - 1, 1, `"${title}" once in the block`);
  for (const title of titles) assert(out.preview.toLowerCase().split(title.toLowerCase()).length - 1 <= 1, `"${title}" at most once in the preview`);
  const rc = await recallSearch({ query: 'token bucket retries exponentially livez health', dbPath, limit: 20 });
  eq(rc.results.length, 3, `recall: three memories (${rc.results.map((r) => r.id)})`);
  // brain_context and the folder digest read MEMORY_DB: run them with HOME=<fake>
  writeFileSync(join(home, '.claude-brain', 'READY'), 'ok\n');
  const script = join(ROOT, `readers-${seq}.mjs`);
  writeFileSync(script, `
    const { taskContext } = await import(${JSON.stringify(join(REPO, 'bin/lib/recall.mjs'))});
    const { buildFolderDigest } = await import(${JSON.stringify(join(REPO, 'bin/lib/inject.mjs'))});
    const c = await taskContext({ task: 'token bucket rate limiter retries back off health check livez' });
    process.stdout.write(JSON.stringify({ block: c.block, digest: buildFolderDigest('svc').digest }));`);
  const o = JSON.parse(execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  for (const title of titles) {
    eq(o.block.toLowerCase().split(title.toLowerCase()).length - 1, 1, `brain_context: "${title}" once`);
    eq(o.digest.toLowerCase().split(title.toLowerCase()).length - 1, 1, `folder digest: "${title}" once`);
  }
  assert(ids.length === 12, 'fixture');
});

await t('brain_context: two pinned copies of one memory (clean keeps both visible) show once in the pinned section', async () => {
  const home = join(ROOT, `home-pins-${++seq}`);
  const dbPath = join(home, '.claude-brain', 'brain.db');
  const { ids } = buildDb([
    { project: 'svc', title: 'Deploys go through the canary ring', facts: ['canary first, then fleet'] },
    { project: 'svc', title: 'deploys go through the canary ring.', facts: ['Canary first, then fleet'] },
    { project: 'svc', title: 'Feature flags live in LaunchDarkly', facts: ['no env-var flags'] },
  ], { path: dbPath });
  const { db } = openForCuration(dbPath);
  try { for (const id of ids) pinMemory(db, id, true); } finally { db.close(); }
  eq(cleanDupes({ dbPath, apply: true }).hidden, 0, 'clean never hides a pinned copy');
  writeFileSync(join(home, '.claude-brain', 'READY'), 'ok\n');
  const script = join(ROOT, `pins-${seq}.mjs`);
  writeFileSync(script, `
    const { taskContext } = await import(${JSON.stringify(join(REPO, 'bin/lib/recall.mjs'))});
    const c = await taskContext({ task: 'unrelated question about the billing page layout' });
    process.stdout.write(JSON.stringify({ block: c.block }));`);
  const o = JSON.parse(execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  eq(o.block.toLowerCase().split('deploys go through the canary ring').length - 1, 1, `pinned memory once:\n${o.block}`);
  eq(o.block.split('Feature flags live in LaunchDarkly').length - 1, 1, 'the other pinned memory still shown');
  assert(!/\(untitled\)/.test(o.block), 'no (untitled) row');
});

// ── 8. control panel ────────────────────────────────────────────────────────
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject); req.end();
  });
}
await t('panel (temp HOME): after clean, list / search / stats never show a hidden copy or a blank row', async () => {
  const home = join(ROOT, `home-ui-${++seq}`);
  const dbPath = join(home, '.claude-brain', 'brain.db');
  const { ids } = cleanFixture({ path: dbPath, migrated: false });
  writeFileSync(join(home, '.claude-brain', 'READY'), 'ok\n');
  cleanDupes({ dbPath, apply: true });
  const port = 39000 + ((process.pid + 311) % 900);
  const srv = spawn(process.execPath, [join(REPO, 'ui/server.mjs')], { env: { ...process.env, HOME: home, BRAIN_UI_PORT: String(port) }, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { up = (await httpGet(port, '/api/memory/stats')).status === 200; } catch {}
    }
    assert(up, 'panel started');
    const hidden = new Set([ids[1], ids[2], ids[7]]);
    const all = (await httpGet(port, '/api/search?limit=100')).body;
    eq(all.total, ids.length - 3, 'browse total excludes hidden copies');
    assert(all.results.every((r) => !hidden.has(r.id)), 'browse never lists a hidden copy');
    const found = (await httpGet(port, '/api/search?q=stripe%20webhook&limit=100')).body;
    assert(found.results.length && found.results.every((r) => !hidden.has(r.id) && (r.title || r.subtitle)), 'search: no hidden copy, no blank row');
    const stats = (await httpGet(port, '/api/memory/stats')).body;
    eq(stats.total, ids.length - 3, 'stats exclude hidden copies');
  } finally { srv.kill('SIGKILL'); }
});

// ── 9. read-only dry run against the real store (private copy) — opt-in ────
// BRAIN_DEDUPE_REAL=1: the dry run runs on a PRIVATE copy of the real brain.db
// (evals/lib/private-copy.mjs: 0700 dir, 0600 file, read via immutable backup,
// removed when the test ends however it ends) and must leave that copy
// byte-identical. Skipped when unset. A hand-made copy path (the old
// BRAIN_DEDUPE_REAL_COPY, which invited world-readable copies in /tmp) is not accepted.
if (process.env.BRAIN_DEDUPE_REAL_COPY) console.log('  (BRAIN_DEDUPE_REAL_COPY is no longer read: set BRAIN_DEDUPE_REAL=1 and the test makes its own private, self-deleting copy)');
if (process.env.BRAIN_DEDUPE_REAL === '1') {
  await t('real-store copy: dry run is read-only and every planned copy is byte-identical in its compared fields', async () => {
    await withPrivateCopy({ label: 'dedupe' }, ({ db: p }) => {
      const before = fileHash(p);
      const r = cleanDupes({ dbPath: p });
      eq(fileHash(p), before, 'copy unchanged');
      const db = ro(p);
      try {
        const plan = planDuplicates(db);
        const get = db.prepare('SELECT title, subtitle, facts, narrative, text FROM observations WHERE id = ?');
        let checked = 0;
        for (const g of plan.groups.slice(0, 400)) {
          const s = get.get(g.survivor);
          for (const c of g.copies.slice(0, 5)) { eq(memoryKey(get.get(c)), memoryKey(s), `#${c} vs #${g.survivor}`); checked++; }
        }
        console.log(`    real copy: ${r.groups} groups · ${r.copies} copies · ${r.selfCapture} self-capture · ${r.sameTitleDifferent} same-title left alone · ${checked} pairs re-checked`);
      } finally { db.close(); }
    });
  });
}

// ── report ──────────────────────────────────────────────────────────────────
for (const [s, n, m] of results) console.log(`${s === 'PASS' ? '  ✓' : '  ✗'} ${n}${m ? `\n      ${m.replace(/\n/g, '\n      ')}` : ''}`);
console.log(`\ndedupe-test: ${pass} passed, ${fail} failed`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
