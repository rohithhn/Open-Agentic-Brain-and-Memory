#!/usr/bin/env node
// Tests for memory curation — bin/lib/curate.mjs (edit / soft delete / undo /
// pin), its wiring into recall, brain_context and the startup block, and the
// control panel endpoints in ui/server.mjs (/api/memory/*, /api/search views).
//
//   node evals/curate-test.mjs
//
// Synthetic stores under a scratch dir only. The panel is started as a real
// server against a fake HOME, so the real ~/.claude-brain is never opened.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openStore, LIFECYCLE_COLUMN_NAMES } from '../bin/lib/store.mjs';
import { CLAUDE_MEM_DB } from '../bin/lib/paths.mjs';
import {
  validateEdit, openForCuration, getMemory, editMemory, deleteMemory, restoreMemory, pinMemory, pinnedRows,
  editLogPath, rowId, MAX_PINNED_STARTUP,
} from '../bin/lib/curate.mjs';
import { rerankByLifecycle, planLifecycle, markStatus, lifecycleCounts, DELETED } from '../bin/lib/lifecycle.mjs';
import { recallSearch } from '../bin/lib/recall.mjs';
import { sessionContext } from '../bin/lib/sessionstart.mjs';
import { rememberObservation, newMcpSession } from '../bin/lib/remember.mjs';
import { ensureVectorSchema } from '../bin/lib/embed.mjs';
import { importClaudeMem } from '../bin/lib/import-claude-mem.mjs';

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m}\n    expected: ${B}\n    actual:   ${A}`);
}

const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `curate-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
let seq = 0;
process.env.BRAIN_NO_ECONOMICS = '1'; // no ledger noise; economics has its own suite
process.env.BRAIN_EMBED = '0'; // BM25 only: no model load (the recall assertions do not depend on it)

/** Synthetic native store. rows: {project,title,type?,narrative?,facts?,epoch?} → { dbPath, ids } */
function buildDb(rows, { dir = ROOT, path } = {}) {
  mkdirSync(dir, { recursive: true });
  const dbPath = path || join(dir, `db-${++seq}.db`);
  const db = openStore({ path: dbPath });
  const mem = `curate:test:${seq}`;
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
              VALUES (?,?,?,?,?,?,'completed')`).run(mem, mem, 'p', 'claude', '2026-01-01T00:00:00Z', 1);
  const ins = db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, facts, narrative, concepts,
      prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash, generated_by_model)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids = rows.map((r, i) => {
    const epoch = r.epoch ?? Date.UTC(2026, 8, 1, 9, i);
    return Number(ins.run(mem, r.project || 'proj-a', '', r.type || 'discovery', r.title, JSON.stringify(r.facts || []),
      r.narrative || `narrative for ${r.title}`, '[]', 0, 100, new Date(epoch).toISOString(), epoch, `h-${seq}-${i}`, 'test').lastInsertRowid);
  });
  db.close();
  return { dbPath, ids };
}
const rw = (p) => new DatabaseSync(p);
const ro = (p) => new DatabaseSync(p, { readOnly: true });
/** Every row except `skip`, as a comparable string (untouched-rows check). */
function snapshot(dbPath, skip = []) {
  const db = ro(dbPath);
  try {
    return JSON.stringify(db.prepare('SELECT * FROM observations ORDER BY id').all().filter((r) => !skip.includes(r.id)));
  } finally { db.close(); }
}

// ── validation ─────────────────────────────────────────────────────────────
await t('validateEdit: accepts title/facts/narrative, trims, drops blank facts', () => {
  const v = validateEdit({ title: '  New   title\n', facts: ['one', '  ', ' two '], narrative: ' n ' });
  assert(v.ok, v.error);
  eq(v.patch, { title: 'New title', facts: ['one', 'two'], narrative: 'n' }, 'normalised patch');
});

await t('validateEdit: refuses bad shapes, unknown keys, empty and oversized values', () => {
  const bad = [
    null, [], 'x', {}, { id: 3 }, { title: 5 }, { title: '   ' }, { title: 'x'.repeat(201) }, { facts: 'a' },
    { facts: [1] }, { facts: Array(25).fill('f') }, { facts: ['x'.repeat(501)] }, { narrative: 7 },
    { narrative: 'x'.repeat(4001) }, { title: 'ok', project: 'other' }, { title: 'ok', status: 'active' },
  ];
  for (const b of bad) assert(!validateEdit(b).ok, `should refuse ${JSON.stringify(b)?.slice(0, 60)}`);
});

await t('rowId: positive integers only', () => {
  eq([1, '7', 42].map(rowId), [1, 7, 42], 'valid');
  eq([0, -1, 1.5, '1e3', '3; DROP', true, null, undefined, 'abc', 2 ** 60].map(rowId).filter((x) => x !== null), [], 'invalid');
});

// ── store opening ──────────────────────────────────────────────────────────
await t("openForCuration: refuses claude-mem's own DB without opening it", () => {
  let err = '';
  try { openForCuration(CLAUDE_MEM_DB); } catch (e) { err = e.message; }
  assert(/claude-mem/.test(err), `expected a refusal, got "${err}"`);
});

await t('openForCuration: migrates an un-migrated store (verified backup first) and adds pin columns to an older one', () => {
  const { dbPath } = buildDb([{ title: 'Legacy row one' }]);
  const db = rw(dbPath);
  db.exec('DROP INDEX IF EXISTS idx_observations_status');
  for (const c of [...LIFECYCLE_COLUMN_NAMES].reverse()) db.exec(`ALTER TABLE observations DROP COLUMN ${c}`);
  db.close();
  const h = openForCuration(dbPath);
  const cols = h.db.prepare('PRAGMA table_info(observations)').all().map((c) => c.name);
  h.db.close();
  assert(h.backupPath && existsSync(h.backupPath), 'backup written before the migration');
  for (const c of ['status', 'status_prev', 'pinned_at']) assert(cols.includes(c), `column ${c} added`);

  // A store migrated by the previous build: lifecycle columns, no pin/undo columns.
  const { dbPath: p2 } = buildDb([{ title: 'Older migrated row' }]);
  const d2 = rw(p2);
  d2.exec('ALTER TABLE observations DROP COLUMN pinned_at');
  d2.exec('ALTER TABLE observations DROP COLUMN status_prev');
  d2.close();
  const h2 = openForCuration(p2);
  const cols2 = h2.db.prepare('PRAGMA table_info(observations)').all().map((c) => c.name);
  h2.db.close();
  assert(!h2.backupPath, 'no backup needed for an additive column on a migrated store');
  assert(cols2.includes('pinned_at') && cols2.includes('status_prev'), 'pin/undo columns added');
});

// ── edit ───────────────────────────────────────────────────────────────────
await t('edit: rewrites one row, FTS follows, content_hash kept, old text logged, secrets redacted', () => {
  const { dbPath, ids } = buildDb([
    { title: 'Quokka cache warmup order', facts: ['warm the quokka cache first'], narrative: 'cache ordering note' },
    { title: 'Unrelated neighbour row' },
  ]);
  const before = snapshot(dbPath, [ids[0]]);
  const { db } = openForCuration(dbPath);
  const hashBefore = db.prepare('SELECT content_hash FROM observations WHERE id = ?').get(ids[0]).content_hash;
  const key = 'AKIA' + 'Z7QX3LMNP4RT2VWY'; // split: a contiguous literal trips public secret scanners (fake key)
  const r = editMemory(db, ids[0], { title: 'Pangolin cache warmup order', facts: ['warm it first', `key ${key}`] }, { dbPath });
  assert(r.ok, r.error);
  eq(r.changed.sort(), ['facts', 'title'], 'changed fields');
  eq(r.redacted, 1, 'one secret redacted');
  const row = db.prepare('SELECT title, facts, content_hash FROM observations WHERE id = ?').get(ids[0]);
  eq(row.title, 'Pangolin cache warmup order', 'title stored');
  assert(!row.facts.includes(key) && row.facts.includes('[REDACTED:aws-access-key-id]'), 'secret never stored');
  eq(row.content_hash, hashBefore, 'content_hash (sync identity) unchanged');
  const fts = (w) => db.prepare('SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?').all(w).map((x) => x.rowid);
  eq(fts('pangolin'), [ids[0]], 'FTS finds the new title');
  eq(fts('quokka'), [], 'FTS no longer finds the old title/fact');
  const noop = editMemory(db, ids[0], { title: 'Pangolin cache warmup order' }, { dbPath });
  eq(noop.changed, [], 'same text is a no-op');
  db.close();
  eq(snapshot(dbPath, [ids[0]]), before, 'no other row touched');
  const log = readFileSync(editLogPath(dbPath), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq(log.length, 1, 'one log entry (the no-op is not logged)');
  eq(log[0].before.title, 'Quokka cache warmup order', 'old title kept in the edit log');
  assert(!JSON.stringify(log[0].after).includes(key), 'log holds the redacted text, not the secret');
  eq(statSync(editLogPath(dbPath)).mode & 0o777, 0o600, 'edit log is 0600');
});

await t('edit: unknown id → 404, deleted row → 409, bad input → 400', () => {
  const { dbPath, ids } = buildDb([{ title: 'Edit guard row' }]);
  const { db } = openForCuration(dbPath);
  eq(editMemory(db, 999999, { title: 'x' }).code, 404, 'missing row');
  eq(editMemory(db, 'nope', { title: 'x' }).code, 400, 'bad id');
  eq(editMemory(db, ids[0], { title: '' }).code, 400, 'empty title');
  assert(deleteMemory(db, ids[0]).ok, 'delete');
  eq(editMemory(db, ids[0], { title: 'Changed' }).code, 409, 'deleted rows are not editable');
  db.close();
});

// ── delete / undo ─────────────────────────────────────────────────────────
await t('delete: soft (row kept, status deleted, manual); undo restores the previous status and reason', () => {
  const { dbPath, ids } = buildDb([{ title: 'Soft delete target' }, { title: 'Bystander row' }]);
  const { db } = openForCuration(dbPath);
  markStatus(db, ids[0], 'stale', { note: 'hand-marked' });
  const r = deleteMemory(db, ids[0], { now: 1234 });
  assert(r.ok && r.from === 'stale', JSON.stringify(r));
  let row = db.prepare('SELECT status, status_reason, status_prev FROM observations WHERE id = ?').get(ids[0]);
  eq(row.status, DELETED, 'status deleted');
  assert(row.status_reason.startsWith('manual'), 'manual reason, so automatic passes leave it');
  eq(JSON.parse(row.status_prev).status, 'stale', 'previous status remembered');
  assert(deleteMemory(db, ids[0]).already, 'second delete is a no-op');
  eq(db.prepare('SELECT COUNT(*) n FROM observations').get().n, 2, 'nothing removed');
  eq(lifecycleCounts(db).deleted, 1, 'lifecycleCounts reports deleted');
  const plan = planLifecycle(db, { contradictions: [], staleConcepts: [], liveConcepts: [] });
  assert(!plan.changes.some((c) => c.id === ids[0]), 'lifecycle pass never revives a deleted row');
  const u = restoreMemory(db, ids[0]);
  eq(u.to, 'stale', 'undo → stale again');
  row = db.prepare('SELECT status, status_reason, status_prev FROM observations WHERE id = ?').get(ids[0]);
  eq([row.status, row.status_reason, row.status_prev], ['stale', 'manual: hand-marked', null], 'exact previous state');
  assert(restoreMemory(db, ids[1]).already, 'restoring a live row is a no-op');
  db.close();
});

// ── pin ───────────────────────────────────────────────────────────────────
await t('pin: set/clear pinned_at, validated, a deleted row cannot be pinned, pinnedRows orders this project first', () => {
  const { dbPath, ids } = buildDb([
    { title: 'Pinned elsewhere', project: 'proj-b' },
    { title: 'Pinned here', project: 'proj-a' },
    { title: 'Deleted then pinned', project: 'proj-a' },
  ]);
  const { db } = openForCuration(dbPath);
  eq(pinMemory(db, ids[0], 'yes').code, 400, 'pinned must be boolean');
  assert(pinMemory(db, ids[0], true, { now: 200 }).ok, 'pin b');
  assert(pinMemory(db, ids[1], true, { now: 100 }).ok, 'pin a');
  deleteMemory(db, ids[2]);
  eq(pinMemory(db, ids[2], true).code, 409, 'deleted row refuses a pin');
  eq(pinnedRows(db, { projects: ['proj-a'] }).map((r) => r.id), [ids[1], ids[0]], 'this project first, then others');
  eq(pinnedRows(db).map((r) => r.id), [ids[0], ids[1]], 'newest pin first without a project');
  assert(getMemory(db, ids[0]).pinned, 'getMemory shows pinned');
  assert(pinMemory(db, ids[0], false).ok && !getMemory(db, ids[0]).pinned, 'unpin');
  eq(lifecycleCounts(db).pinned, 1, 'lifecycleCounts reports pinned');
  db.close();
});

// ── readers ───────────────────────────────────────────────────────────────
await t('rerank: pinned rows first, deleted rows dropped, otherwise unchanged', () => {
  const rows = [{ id: 1, score: -9 }, { id: 2, score: -8, lc_status: 'deleted' }, { id: 3, score: -1, lc_pinned_at: 5 }, { id: 4, score: -7 }];
  eq(rerankByLifecycle(rows).map((r) => r.id), [3, 1, 4], 'order');
  eq(rerankByLifecycle([{ id: 1, score: -9 }, { id: 4, score: -7 }]).map((r) => r.id), [1, 4], 'no pins, no deletes → input order');
});

await t('recall: deleted rows never come back; a pinned match ranks first even when it matches weakly', async () => {
  const filler = Array.from({ length: 30 }, (_, i) => ({ title: `Axolotl axolotl tank note ${i}`, narrative: 'axolotl axolotl axolotl water' }));
  const { dbPath, ids } = buildDb([
    { title: 'Axolotl water change schedule', narrative: 'axolotl axolotl axolotl axolotl water' },
    { title: 'Weak pinned mention', narrative: 'a long note that mentions an axolotl only once among many other words about filters and pumps and gravel' },
    ...filler,
  ]);
  const { db } = openForCuration(dbPath);
  deleteMemory(db, ids[0]);
  pinMemory(db, ids[1], true);
  db.close();
  const r = await recallSearch({ query: 'axolotl water', dbPath, limit: 5 });
  assert(!r.results.some((x) => x.id === ids[0]), 'deleted row absent');
  eq(r.results[0].id, ids[1], 'pinned row first');
  eq(r.results[0].pinned, true, 'marked pinned');
  assert(r.results.slice(1).every((x) => !('pinned' in x)), 'unpinned rows carry no pinned key');
});

await t('startup block: pinned rows above the timeline (never trimmed), deleted rows out of rows and totals', () => {
  const { dbPath, ids } = buildDb([
    { title: 'Very old pinned rule about releases', project: 'proj-s', epoch: Date.UTC(2020, 0, 1) },
    { title: 'Global pinned preference', project: 'proj-other', epoch: Date.UTC(2020, 0, 2) },
    { title: 'Deleted startup row', project: 'proj-s' },
    ...Array.from({ length: 40 }, (_, i) => ({ title: `Recent startup row ${i}`, project: 'proj-s' })),
  ]);
  const { db } = openForCuration(dbPath);
  pinMemory(db, ids[0], true, { now: 1 });
  pinMemory(db, ids[1], true, { now: 2 });
  deleteMemory(db, ids[2]);
  db.close();
  const out = sessionContext({ project: 'proj-s', dbPath, record: false, maxRows: 5 });
  assert(out.text.includes('Pinned (always shown)'), 'pinned section present');
  const pinBlock = out.text.split('Pinned (always shown)')[1].split('Timeline')[0];
  assert(pinBlock.includes(`#${ids[0]} `) && pinBlock.includes(`#${ids[1]} `), 'both pins shown');
  assert(pinBlock.indexOf(`#${ids[0]} `) < pinBlock.indexOf(`#${ids[1]} `), "this project's pin before the global one");
  assert(pinBlock.includes('[proj-other]'), 'a pin from another project is labelled');
  const timeline = out.text.split('Timeline (newest first)')[1];
  assert(!timeline.includes(`#${ids[0]} `), 'a pinned row is not repeated in the timeline');
  assert(!out.text.includes('Deleted startup row'), 'deleted row absent');
  eq(out.total, 41, 'total excludes the deleted row');
  eq(out.pinned, 2, 'pinned count reported');
  assert(MAX_PINNED_STARTUP >= 2, 'bound sanity');
});

await t('brain_context (temp HOME subprocess): pinned section always included, deleted rows never', () => {
  const home = join(ROOT, `home-ctx-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const brainDb = join(home, '.claude-brain', 'brain.db');
  const { ids } = buildDb([
    { title: 'Always use pnpm not npm', narrative: 'package manager preference' },
    { title: 'Wombat compaction lock stall', narrative: 'wombat compaction stalls when the lock is held' },
    { title: 'Wombat compaction deleted note', narrative: 'wombat compaction lock stall deleted' },
  ], { path: brainDb });
  const { db } = openForCuration(brainDb);
  pinMemory(db, ids[0], true);
  deleteMemory(db, ids[2]);
  db.close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'ok\n');
  const script = join(ROOT, `ctx-${seq}.mjs`);
  writeFileSync(script, `import { taskContext } from ${JSON.stringify(fileURLToPath(new URL('../bin/lib/recall.mjs', import.meta.url)))};
    const o = await taskContext({ task: 'wombat compaction lock stall' }); process.stdout.write(JSON.stringify(o));`);
  const o = JSON.parse(execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  assert(o.block.startsWith('## Pinned (always included)'), `pinned section first:\n${o.block.slice(0, 200)}`);
  assert(o.block.includes('Always use pnpm'), 'pinned row present though unrelated to the task');
  assert(o.block.includes('Wombat compaction lock stall'), 'the task match is still there');
  assert(!o.block.includes('deleted note'), 'deleted row absent');
  eq(o.block.split('Always use pnpm').length - 1, 1, 'pinned row appears once');
});

// ── edits of long captured rows (a fifth of the real store) ─────────────────
await t("validateEdit with the current row: unchanged fields dropped, limits capped at the row's own size", () => {
  const facts30 = Array.from({ length: 30 }, (_, i) => `captured fact number ${i}`);
  const cur = { title: 'T'.repeat(250), narrative: 'n'.repeat(5000), facts: JSON.stringify(facts30) };
  let v = validateEdit({ title: cur.title, narrative: cur.narrative, facts: facts30 }, cur);
  assert(v.ok, v.error);
  eq(v.patch, {}, 'everything sent back unchanged → empty patch, not an error');
  v = validateEdit({ title: '  Short   new title ', narrative: cur.narrative, facts: facts30 }, cur);
  assert(v.ok, v.error);
  eq(v.patch, { title: 'Short new title' }, 'only the changed field is in the patch');
  // Unchanged after the same cleaning (CRLF from a textarea, stray whitespace).
  const cr = { title: 'A  title', narrative: 'line one\r\nline two', facts: JSON.stringify(['  x  ']) };
  eq(validateEdit({ title: 'A title', narrative: 'line one\nline two', facts: ['x'] }, cr).patch, {}, 'normalised equal = unchanged');
  // A long row may keep or shrink, never grow past its own size.
  assert(validateEdit({ narrative: 'n'.repeat(4500) }, cur).ok, 'shrinking a long narrative is fine');
  v = validateEdit({ narrative: 'n'.repeat(5001) }, cur);
  assert(!v.ok && /5000/.test(v.error), `growing past the row's size refused: ${v.error}`);
  assert(validateEdit({ facts: facts30.slice(1) }, cur).ok, 'dropping a fact from 30 is fine');
  v = validateEdit({ facts: [...facts30, 'one more'] }, cur);
  assert(!v.ok && /30/.test(v.error), `a 31st fact refused: ${v.error}`);
  assert(validateEdit({ title: 'U'.repeat(240) }, cur).ok, 'a new title within the long title length is fine');
  // A normal-size row keeps the absolute limits.
  const small = { title: 'a', narrative: 'short', facts: '[]' };
  assert(!validateEdit({ narrative: 'x'.repeat(4001) }, small).ok, '4000 still applies to a short row');
  assert(!validateEdit({ title: 'x'.repeat(201) }, small).ok, '200 still applies to a short title');
  assert(!validateEdit({ facts: Array.from({ length: 25 }, (_, i) => `f${i}`) }, small).ok, '24 facts still applies');
  assert(!validateEdit({ title: '' }, cur).ok, 'an empty title is still refused');
});

await t('edit: a row over every limit can be retitled (the panel sends back the unchanged fields too)', () => {
  const longNarr = 'Captured narrative sentence. '.repeat(280); // ~8.1k, like the real maximum
  const facts30 = Array.from({ length: 30 }, (_, i) => `long row fact ${i}`);
  const { dbPath, ids } = buildDb([{ title: 'L'.repeat(230), narrative: longNarr, facts: facts30 }, { title: 'Neighbour' }]);
  const { db } = openForCuration(dbPath);
  try {
    const untouched = snapshot(dbPath, [ids[0]]);
    const cur = getMemory(db, ids[0]);
    let r = editMemory(db, ids[0], { title: 'Retitled long row', narrative: cur.narrative, facts: JSON.parse(cur.facts) }, {});
    assert(r.ok, `retitle with every field sent: ${r.error}`);
    eq(r.changed, ['title'], 'only the title changed');
    eq([r.memory.title, r.memory.narrative], ['Retitled long row', longNarr], 'narrative left exactly as stored (byte for byte)');
    eq(JSON.parse(r.memory.facts), facts30, 'facts left as stored');
    r = editMemory(db, ids[0], { narrative: longNarr + ' and more' }, {});
    eq([r.ok, r.code], [false, 400], 'growing the long narrative refused');
    eq(snapshot(dbPath, [ids[0]]), untouched, 'no other row touched');
  } finally { db.close(); }
});

await t("edit: drops that row's stale semantic vector (others kept); a no-op edit keeps it", () => {
  const { dbPath, ids } = buildDb([{ title: 'Vector row one' }, { title: 'Vector row two' }]);
  const { db } = openForCuration(dbPath);
  try {
    ensureVectorSchema(db);
    const ins = db.prepare('INSERT INTO observation_vectors (obs_id, model, text_hash, dim, vec, embedded_at) VALUES (?,?,?,?,?,?)');
    for (const id of ids) ins.run(id, 'test-model', 'hash', 2, new Uint8Array([1, 2]), 1);
    let r = editMemory(db, ids[0], { title: 'Vector row one, reworded' }, {});
    assert(r.ok && r.unembedded === true, `edit reports the vector dropped: ${JSON.stringify(r)}`);
    eq(db.prepare('SELECT obs_id FROM observation_vectors ORDER BY obs_id').all().map((x) => x.obs_id), [ids[1]], 'only the edited row lost its vector');
    r = editMemory(db, ids[1], { title: 'Vector row two' }, {});
    eq([r.ok, r.changed, r.unembedded], [true, [], undefined], 'unchanged edit is a no-op');
    eq(db.prepare('SELECT COUNT(*) n FROM observation_vectors').get().n, 1, 'its vector kept');
  } finally { db.close(); }
});

// ── delete vs. the writers and derived readers ────────────────────────────
await t('brain_remember after a panel delete saves a new live memory (not a "duplicate" of the hidden row)', async () => {
  const { dbPath } = buildDb([{ title: 'Unrelated seed row' }]);
  openForCuration(dbPath).db.close();
  const input = {
    title: 'Gnu parser needs the strict flag', project: 'proj-rem', type: 'discovery',
    facts: ['the gnu parser rejects input without the strict flag'], narrative: 'gnu parser strict flag requirement',
  };
  const opts = (session) => ({ dbPath, session, clientName: 'test', log: () => {} });
  // Same process session (the unique (session, hash) index path) and a new one.
  const s1 = newMcpSession('test', Date.now());
  const first = await rememberObservation(input, opts(s1));
  eq([first.ok, first.status], [true, 'saved'], `first save: ${JSON.stringify(first)}`);
  const del = (id) => { const h = openForCuration(dbPath); try { return deleteMemory(h.db, id); } finally { h.db.close(); } };
  assert(del(first.id).ok, 'deleted in the panel');
  const again = await rememberObservation(input, opts(s1));
  eq([again.ok, again.status, again.saved], [true, 'saved', true], `same session, re-said: ${JSON.stringify(again)}`);
  assert(again.id !== first.id, 'a new row, not the deleted one');
  let hits = await recallSearch({ query: 'gnu parser strict flag', dbPath, limit: 5 });
  eq(hits.results.map((x) => x.id), [again.id], 'recall finds the new memory, not the deleted one');
  // near-dup (same title within 72h) must not merge into a deleted row either
  assert(del(again.id).ok, 'deleted again');
  const third = await rememberObservation({ ...input, facts: ['reworded: strict flag is mandatory for gnu parser'] }, opts(newMcpSession('test', Date.now())));
  eq([third.ok, third.status], [true, 'saved'], `near-dup of a deleted row is a new save: ${JSON.stringify(third)}`);
  hits = await recallSearch({ query: 'gnu parser strict flag', dbPath, limit: 5 });
  eq(hits.results.map((x) => x.id), [third.id], 'only the live one is found');
  // a live duplicate is still a duplicate
  const dup = await rememberObservation({ ...input, facts: ['reworded: strict flag is mandatory for gnu parser'] }, opts(newMcpSession('test', Date.now())));
  eq([dup.status, dup.id], ['duplicate', third.id], 'live duplicates still dedupe');
  const d = ro(dbPath);
  eq(d.prepare("SELECT COUNT(*) n FROM observations WHERE status = 'deleted'").get().n, 2, 'both deleted rows kept (Undo) and still deleted');
  d.close();
});

await t('derived readers (temp HOME subprocess): dashboard, digests, workflows, distill drafts leave deleted rows out', () => {
  const home = join(ROOT, `home-derived-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const brainDb = join(home, '.claude-brain', 'brain.db');
  const t0 = Date.UTC(2026, 8, 2, 9, 0);
  const { ids } = buildDb([
    { title: 'Live keeper memory', project: 'proj-live', epoch: t0 },
    { title: 'Zebra rollout decision to forget', project: 'proj-gone', type: 'decision', epoch: t0 + 60000 },
  ], { path: brainDb });
  const db = rw(brainDb);
  db.prepare("UPDATE observations SET concepts = ? WHERE id = ?").run(JSON.stringify(['keeper-concept']), ids[0]);
  db.prepare("UPDATE observations SET concepts = ? WHERE id = ?").run(JSON.stringify(['zebra-forgotten']), ids[1]);
  // A verify → commit ritual in three sessions, all rows in proj-gone.
  const ritual = [];
  for (let s = 0; s < 3; s++) {
    const sess = `curate:ritual:${s}`;
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
                VALUES (?,?,?,?,?,?,'completed')`).run(sess, sess, 'proj-gone', 'claude', '2026-01-01T00:00:00Z', 1);
    for (const [k, title] of [[0, 'Verify zebra build'], [1, 'Commit zebra build']]) {
      const ep = t0 - 3600000 + s * 1000 + k; // older than the two rows above: the feed shows those
      ritual.push(Number(db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, facts, narrative, concepts,
          prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash, generated_by_model)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sess, 'proj-gone', '', 'change', title, '[]', 'n', '[]', 0, 1,
          new Date(ep).toISOString(), ep, `ritual-${s}-${k}`, 'test').lastInsertRowid));
    }
  }
  db.close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'ok\n');
  const lib = (m) => JSON.stringify(fileURLToPath(new URL(`../bin/lib/${m}.mjs`, import.meta.url)));
  const script = join(ROOT, `derived-${seq}.mjs`);
  writeFileSync(script, `import { memorySignals } from ${lib('home')};
    import { buildDigest, buildFolderDigest } from ${lib('inject')};
    import { mineWorkflows } from ${lib('workflows')};
    import { findStruggles } from ${lib('distill')};
    const sig = memorySignals();
    process.stdout.write(JSON.stringify({
      memories: sig.memories, projects: sig.projects, latest: sig.latest.map((r) => r.title),
      digest: buildDigest() || '', folder: buildFolderDigest('proj-gone').count,
      workflows: mineWorkflows({ minFreq: 3, minSessions: 2 }).length,
      drafts: findStruggles({ sinceMs: 0 }).map((c) => c.resolution.title),
    }));`);
  const run = () => JSON.parse(execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  const before = run();
  assert(before.latest.includes('Zebra rollout decision to forget') && before.digest.includes('zebra-forgotten'), `fixture visible before: ${JSON.stringify(before).slice(0, 300)}`);
  eq([before.memories, before.folder, before.workflows], [8, 7, 1], 'counts before');
  assert(before.drafts.includes('Zebra rollout decision to forget'), 'distill sees the decision before');

  const { db: cdb } = openForCuration(brainDb);
  for (const id of [ids[1], ...ritual]) assert(deleteMemory(cdb, id).ok, `delete #${id}`);
  cdb.close();
  const after = run();
  eq([after.memories, after.projects, after.folder, after.workflows], [1, 1, 0, 0], 'deleted rows out of every count, the ritual gone');
  eq(after.latest, ['Live keeper memory'], 'dashboard feed shows live rows only');
  assert(!after.digest.includes('zebra-forgotten') && !after.digest.includes('proj-gone'), 'global digest: no deleted concept or project');
  assert(after.digest.includes('keeper-concept'), 'global digest keeps the live row');
  eq(after.drafts, [], 'distill drafts nothing from a deleted row');
});

await t('restore on the same Mac (merge of an older cloud snapshot) keeps a delete and an edit', () => {
  const { dbPath, ids } = buildDb([{ title: 'Restore keeper' }, { title: 'Restore deleted' }]);
  openForCuration(dbPath).db.close();
  const cloud = join(ROOT, `cloud-${seq}.db`);
  const d0 = rw(dbPath);
  d0.exec(`VACUUM INTO '${cloud.replace(/'/g, "''")}'`); // the snapshot sync uploaded before the curation
  d0.close();
  const { db } = openForCuration(dbPath);
  assert(deleteMemory(db, ids[1]).ok && editMemory(db, ids[0], { title: 'Restore keeper, edited' }, {}).ok, 'curated');
  db.close();
  const r = importClaudeMem({ source: cloud, dest: dbPath, apply: true, resume: false, verify: false, touchReady: false, log: () => {} });
  eq((r.tables || []).reduce((n, x) => n + (x.inserted || 0), 0), 0, 'nothing re-inserted');
  const d = ro(dbPath);
  eq(d.prepare('SELECT id, title, status FROM observations ORDER BY id').all().map((x) => [x.id, x.title, x.status]),
    [[ids[0], 'Restore keeper, edited', 'active'], [ids[1], 'Restore deleted', 'deleted']], 'delete and edit survive the merge');
  d.close();
});

// ── control panel API ─────────────────────────────────────────────────────
function httpReq(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data !== null && h['content-length'] === undefined) h['content-length'] = Buffer.byteLength(data);
    const req = request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: j, text: buf });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

async function startPanel(home, port) {
  const env = { ...process.env, HOME: home, BRAIN_UI_PORT: String(port) };
  const srv = spawn(process.execPath, [fileURLToPath(new URL('../ui/server.mjs', import.meta.url))], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { const r = await httpReq(port, { path: '/api/memory/stats' }); if (r.status === 200) return srv; } catch { /* not up yet */ }
  }
  srv.kill('SIGKILL');
  throw new Error('panel did not start');
}

const JSONH = { 'content-type': 'application/json' };

await t('panel API (temp store): edit / delete / undo / pin end to end, views, localhost + input guards', async () => {
  const home = join(ROOT, `home-ui-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const brainDb = join(home, '.claude-brain', 'brain.db');
  const { ids } = buildDb([
    { title: 'Panel target memory', facts: ['first fact'] },
    { title: 'Panel neighbour memory' },
    { title: 'Panel third memory' },
  ], { path: brainDb });
  writeFileSync(join(home, '.claude-brain', 'READY'), 'ok\n');
  const port = 39000 + ((process.pid + 7) % 900);
  const srv = await startPanel(home, port);
  const P = (path, body, headers = JSONH) => httpReq(port, { method: 'POST', path, headers, body });
  try {
    const untouched = snapshot(brainDb, [ids[0]]);

    // page + script load, carrying the curation UI
    const page = await httpReq(port, { path: '/' });
    assert(page.status === 200 && page.text.includes('id="memViews"') && page.text.includes('id="toast"'), 'page has the views bar + toast');
    const js = await httpReq(port, { path: '/app.js' });
    for (const fn of ['function obsEdit', 'function obsDelete', 'function obsRestore', 'function obsPin', "'/api/memory/edit'"])
      assert(js.text.includes(fn), `app.js has ${fn}`);

    const o = (await httpReq(port, { path: `/api/observation?id=${ids[0]}` })).body.observation;
    eq([o.status, o.pinned, o.editable], ['active', false, true], 'observation carries curation state');

    // edit
    let r = await P('/api/memory/edit', { id: ids[0], title: 'Panel target — edited', facts: ['one', 'two'] });
    eq(r.status, 200, `edit ok: ${r.text}`);
    eq(r.body.changed.sort(), ['facts', 'title'], 'fields changed');
    eq(r.body.memory.title, 'Panel target — edited', 'returns the new row');

    // input validation
    eq((await P('/api/memory/edit', { id: ids[0], title: '' })).status, 400, 'empty title');
    eq((await P('/api/memory/edit', { id: ids[0], project: 'elsewhere' })).status, 400, 'unknown field');
    eq((await P('/api/memory/edit', { id: 'x', title: 'y' })).status, 400, 'bad id');
    eq((await P('/api/memory/edit', { id: 424242, title: 'y' })).status, 404, 'unknown id');
    eq((await P('/api/memory/edit', '{not json')).status, 400, 'invalid JSON');
    eq((await P('/api/memory/edit', '[1,2]')).status, 400, 'array body');
    eq((await P('/api/memory/edit', JSON.stringify({ id: ids[0], narrative: 'x'.repeat(70 * 1024) }))).status, 413, 'body cap');
    eq((await P('/api/memory/pin', { id: ids[0], pinned: 'yes' })).status, 400, 'pinned must be boolean');
    eq((await P('/api/memory/constructor', { id: ids[0] })).status, 404, 'no prototype routes');
    eq((await httpReq(port, { path: '/api/memory/delete' })).status, 404, 'GET is not a write');

    // localhost / CSRF guards
    eq((await P('/api/memory/delete', { id: ids[1] }, { 'content-type': 'text/plain' })).status, 403, 'non-JSON content type (form post)');
    eq((await P('/api/memory/delete', { id: ids[1] }, { ...JSONH, origin: 'https://evil.example' })).status, 403, 'foreign Origin');
    eq((await P('/api/memory/delete', { id: ids[1] }, { ...JSONH, origin: 'null' })).status, 403, 'opaque Origin');
    eq((await P('/api/memory/delete', { id: ids[1] }, { ...JSONH, origin: `http://127.0.0.1:${port + 1}` })).status, 403, 'other local port');
    eq((await P('/api/memory/delete', { id: ids[1] }, { ...JSONH, host: `evil.example:${port}` })).status, 403, 'DNS-rebinding Host');
    eq((await P('/api/memory/delete', { id: ids[1] }, { ...JSONH, 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site fetch');
    eq(snapshot(brainDb, [ids[0]]), untouched, 'refused/invalid requests changed nothing');
    // the panel's own same-origin browser request passes
    r = await P('/api/memory/pin', { id: ids[0], pinned: true }, { ...JSONH, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', host: `localhost:${port}` });
    eq(r.status, 200, `same-origin pin ok: ${r.text}`);

    // pinned view
    let s = (await httpReq(port, { path: '/api/search?view=pinned' })).body;
    eq(s.results.map((x) => x.id), [ids[0]], 'pinned view');
    eq(s.results[0].pinned, true, 'row flagged pinned');

    // delete → hidden from the default list and search, shown in the deleted view
    r = await P('/api/memory/delete', { id: ids[0] });
    eq(r.status, 200, `delete ok: ${r.text}`);
    s = (await httpReq(port, { path: '/api/search' })).body;
    assert(!s.results.some((x) => x.id === ids[0]) && s.total === 2, 'hidden from browse');
    s = (await httpReq(port, { path: '/api/search?q=edited' })).body;
    eq(s.total, 0, 'hidden from panel search');
    eq((await httpReq(port, { path: '/api/search?view=pinned' })).body.total, 0, 'a deleted pin leaves the pinned view');
    s = (await httpReq(port, { path: '/api/search?view=deleted' })).body;
    eq(s.results.map((x) => [x.id, x.status]), [[ids[0], 'deleted']], 'deleted view lists it');
    eq((await httpReq(port, { path: '/api/memory/stats' })).body.total, 2, 'stats leave the deleted row out');
    eq((await P('/api/memory/edit', { id: ids[0], title: 'nope' })).status, 409, 'deleted rows are not editable');

    // undo
    r = await P('/api/memory/restore', { id: ids[0] });
    eq([r.status, r.body.to], [200, 'active'], 'undo');
    s = (await httpReq(port, { path: '/api/search' })).body;
    eq(s.total, 3, 'back in the list');
    const back = (await httpReq(port, { path: `/api/observation?id=${ids[0]}` })).body.observation;
    eq([back.status, back.pinned, back.title], ['active', true, 'Panel target — edited'], 'state after undo (pin and edit kept)');

    eq(snapshot(brainDb, [ids[0]]), untouched, 'only the target row ever changed');
    const db = ro(brainDb);
    eq(db.prepare('SELECT COUNT(*) n FROM observations').get().n, 3, 'row count unchanged');
    db.close();
  } finally { srv.kill('SIGKILL'); }
});

await t("panel API (claude-mem-only HOME): read-only, writes refused, claude-mem's DB untouched", async () => {
  const home = join(ROOT, `home-cm-${++seq}`);
  mkdirSync(join(home, '.claude-mem'), { recursive: true });
  const cmDb = join(home, '.claude-mem', 'claude-mem.db');
  const { ids } = buildDb([{ title: 'Row in claude-mem DB' }], { path: cmDb });
  const before = readFileSync(cmDb);
  const port = 39000 + ((process.pid + 13) % 900);
  const srv = await startPanel(home, port);
  try {
    const o = (await httpReq(port, { path: `/api/observation?id=${ids[0]}` })).body.observation;
    eq(o.editable, false, 'not editable');
    for (const [path, body] of [['/api/memory/edit', { id: ids[0], title: 'x y z' }], ['/api/memory/delete', { id: ids[0] }], ['/api/memory/pin', { id: ids[0], pinned: true }]]) {
      const r = await httpReq(port, { method: 'POST', path, headers: JSONH, body });
      eq(r.status, 409, `${path} refused`);
    }
  } finally { srv.kill('SIGKILL'); }
  assert(Buffer.compare(before, readFileSync(cmDb)) === 0, 'claude-mem DB byte-identical');
});

await t('panel API: long captured row retitled with only the title sent; first write on an un-migrated store announces its backup', async () => {
  const home = join(ROOT, `home-long-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const brainDb = join(home, '.claude-brain', 'brain.db');
  const longNarr = 'A long captured narrative. '.repeat(250);
  const { ids } = buildDb([
    { title: 'Long captured row', narrative: longNarr, facts: Array.from({ length: 26 }, (_, i) => `fact ${i}`) },
    { title: 'Short neighbour row' },
  ], { path: brainDb });
  // Un-migrated, like the real store: no lifecycle / pin columns yet.
  const db = rw(brainDb);
  db.exec('DROP INDEX IF EXISTS idx_observations_status');
  for (const c of [...LIFECYCLE_COLUMN_NAMES].reverse()) db.exec(`ALTER TABLE observations DROP COLUMN ${c}`);
  db.close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'ok\n');
  const port = 39000 + ((process.pid + 19) % 900);
  const srv = await startPanel(home, port);
  const P = (path, body) => httpReq(port, { method: 'POST', path, headers: JSONH, body });
  try {
    let o = (await httpReq(port, { path: `/api/observation?id=${ids[0]}` })).body.observation;
    eq([o.editable, o.prep], [true, true], 'observation says the first write prepares the store');
    // What the panel now sends for a retitle: the title alone.
    let r = await P('/api/memory/edit', { id: ids[0], title: 'Long row, retitled' });
    eq(r.status, 200, `retitle ok: ${r.text}`);
    eq(r.body.changed, ['title'], 'title only');
    assert(r.body.prepared && existsSync(r.body.prepared), `backup path reported and on disk: ${r.body.prepared}`);
    o = (await httpReq(port, { path: `/api/observation?id=${ids[0]}` })).body.observation;
    eq([o.prep, o.title, o.narrative], [false, 'Long row, retitled', longNarr], 'migrated now; narrative intact');
    // An older client that sends every field back unchanged also works.
    r = await P('/api/memory/edit', { id: ids[0], title: 'Long row, retitled twice', narrative: o.narrative, facts: JSON.parse(o.facts) });
    eq([r.status, r.body.changed, r.body.prepared], [200, ['title'], undefined], `all-fields retitle ok, no second backup: ${r.text}`);
    eq((await P('/api/memory/edit', { id: ids[0], narrative: longNarr + 'more' })).status, 400, 'growing it is still refused');
    // The page's edit form sends only changed fields and scales its maxlength to the row.
    const js = (await httpReq(port, { path: '/app.js' })).text;
    for (const bit of ['ED0=', 'function curatePost', 'OBS.prep', 'Math.max(ED_MAX.narrative'])
      assert(js.includes(bit), `app.js has ${bit} (changed-fields-only save, row-sized limits, prep notice)`);
  } finally { srv.kill('SIGKILL'); }
});

rmSync(ROOT, { recursive: true, force: true });
for (const [s, n, m] of results) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${m ? `\n      ${m}` : ''}`);
console.log(`\ncurate-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
