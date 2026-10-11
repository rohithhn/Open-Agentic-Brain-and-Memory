#!/usr/bin/env node
// Tests for bin/lib/import-claude-mem.mjs — the importer that copies a
// claude-mem memory into this project's native store.
//
// The thing under test moves somebody's irreplaceable memory, so these tests are
// the contract: nothing is written in a dry run, a re-run inserts zero, an
// interrupted run resumes, duplicate prompt keys all survive, content_hash is
// byte-identical, and the SOURCE DATABASE IS NEVER MODIFIED (checked by sha256
// + mtime around every run).
//
// Everything runs on synthetic fixture DBs built in a throwaway directory. No
// real claude-mem DB, no ~/.claude-brain, no real conversation content is ever
// read or written here. Set SCRATCHPAD to pick the sandbox location.
//
//   node evals/import-claude-mem-test.mjs
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  importClaudeMem,
  verifyImport,
  openSourceReadOnly,
  NOT_CARRIED,
  TABLES,
} from '../bin/lib/import-claude-mem.mjs';

const SCRATCH = process.env.SCRATCHPAD || tmpdir();
mkdirSync(SCRATCH, { recursive: true });
const ROOT = mkdtempSync(join(SCRATCH, 'import-claude-mem-test-'));

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try {
    fn();
    pass++;
    results.push(['PASS', name, '']);
  } catch (e) {
    fail++;
    results.push(['FAIL', name, e.message]);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg} (expected ${b}, got ${a})`);
}

// ── fixture builder ─────────────────────────────────────────────────────────
// Mirrors claude-mem's real column layout (including the sync_* columns and
// worker_port/session_db_id that the native schema drops) so the importer's
// column-intersection is genuinely exercised. All content is invented.

const CLAUDE_MEM_SCHEMA = `
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT, memory_session_id TEXT UNIQUE,
  project TEXT, platform_source TEXT, user_prompt TEXT, started_at TEXT, started_at_epoch INTEGER,
  completed_at TEXT, completed_at_epoch INTEGER, status TEXT, worker_port INTEGER,
  prompt_counter INTEGER, custom_title TEXT);
CREATE UNIQUE INDEX ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id);
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT, text TEXT, type TEXT,
  title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT, files_read TEXT,
  files_modified TEXT, prompt_number INTEGER, discovery_tokens INTEGER, created_at TEXT,
  created_at_epoch INTEGER, content_hash TEXT, generated_by_model TEXT, relevance_count INTEGER,
  merged_into_project TEXT, agent_type TEXT, agent_id TEXT, metadata TEXT, synced_at INTEGER,
  origin_device_id TEXT, origin_local_id TEXT, sync_rev TEXT);
CREATE UNIQUE INDEX ux_observations_session_hash ON observations(memory_session_id, content_hash);
CREATE TABLE user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_db_id INTEGER, content_session_id TEXT,
  prompt_number INTEGER, prompt_text TEXT, created_at TEXT, created_at_epoch INTEGER,
  synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT, sync_rev TEXT);
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT, request TEXT,
  investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, files_read TEXT,
  files_edited TEXT, notes TEXT, prompt_number INTEGER, created_at TEXT, created_at_epoch INTEGER,
  merged_into_project TEXT, synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT,
  sync_rev TEXT);
-- claude-mem machinery that must NOT come across:
CREATE TABLE pending_messages (id INTEGER PRIMARY KEY, session_db_id INTEGER, status TEXT);
CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY, payload TEXT);
`;

let fixtureN = 0;
// Deliberately odd content_hash values: mixed case, unicode, leading zeros —
// anything that a "helpful" re-hash or normalisation would change.
const HASHES = ['0000abc', 'MiXeDCase99', 'héllo-ünïcode-hash', 'aaaa1111bbbb2222', '  padded  '];

function buildSource({ sessions = 3, obsPerSession = 4, dupPrompts = true, dropTable = null } = {}) {
  const path = join(ROOT, `source-${++fixtureN}.db`);
  const db = new DatabaseSync(path);
  db.exec(CLAUDE_MEM_SCHEMA);
  if (dropTable) db.exec(`DROP TABLE ${dropTable}`);

  const ins = (sql) => db.prepare(sql);
  const sIns = ins(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project,
    platform_source, user_prompt, started_at, started_at_epoch, status, worker_port, prompt_counter)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const oIns = ins(`INSERT INTO observations (memory_session_id, project, text, type, title, subtitle,
    facts, narrative, concepts, prompt_number, created_at, created_at_epoch, content_hash,
    generated_by_model, relevance_count, sync_rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const pIns = ins(`INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number,
    prompt_text, created_at, created_at_epoch, sync_rev) VALUES (?,?,?,?,?,?,?)`);
  const smIns = dropTable === 'session_summaries' ? null : ins(`INSERT INTO session_summaries
    (memory_session_id, project, request, investigated, learned, completed, next_steps,
     prompt_number, created_at, created_at_epoch) VALUES (?,?,?,?,?,?,?,?,?,?)`);

  let epoch = 1_700_000_000_000;
  for (let s = 1; s <= sessions; s++) {
    sIns.run(`content-${s}`, `mem-${s}`, `proj-${s % 2}`, 'claude-code', `synthetic prompt ${s}`,
      `2026-01-0${s}T00:00:00Z`, epoch + s * 1000, 'completed', 51230 + s, s);
    for (let o = 0; o < obsPerSession; o++) {
      oIns.run(`mem-${s}`, `proj-${s % 2}`, `synthetic observation text ${s}.${o}`, 'discovery',
        `title ${s}.${o}`, `subtitle ${s}.${o}`, '["fact a"]', `narrative ${s}.${o}`,
        '["synthetic"]', o, `2026-01-0${s}T00:0${o}:00Z`, epoch + s * 1000 + o,
        `${HASHES[o % HASHES.length]}-s${s}`, 'claude-haiku-4-5', 0, 'rev-should-not-copy');
      pIns.run(s, `content-${s}`, o, `synthetic prompt text ${s}.${o}`,
        `2026-01-0${s}T00:0${o}:00Z`, epoch + s * 1000 + o, 'rev-should-not-copy');
    }
    if (smIns) {
      smIns.run(`mem-${s}`, `proj-${s % 2}`, 'req', 'inv', 'learned', 'done', 'next', 1,
        `2026-01-0${s}T01:00:00Z`, epoch + s * 1000 + 500);
    }
  }

  // The measured live-data hazard: duplicate (content_session_id, prompt_number)
  // pairs. A 2-part key would silently drop these. Three rows share (dup-sess, 7)
  // and differ only in created_at_epoch — all three must survive. A fourth row is
  // an exact 3-part duplicate and is legitimately deduped.
  if (dupPrompts) {
    for (const e of [epoch + 10, epoch + 20, epoch + 30, epoch + 30]) {
      pIns.run(99, 'dup-sess', 7, `synthetic duplicate prompt @${e}`, '2026-02-01T00:00:00Z', e, null);
    }
  }
  db.close();
  return path;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function fingerprint(path) {
  const st = statSync(path);
  return { sha: sha256(path), mtime: st.mtimeMs, size: st.size };
}
function assertUntouched(path, before, label) {
  const after = fingerprint(path);
  eq(after.sha, before.sha, `${label}: source sha256 changed`);
  eq(after.mtime, before.mtime, `${label}: source mtime changed`);
  eq(after.size, before.size, `${label}: source size changed`);
  // Nor may a rollback journal / WAL be left behind next to it.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    assert(!existsSync(path + suffix), `${label}: ${suffix} sidecar created next to the source`);
  }
}

function openRo(path) {
  return new DatabaseSync(`file:${path}?mode=ro`, { readOnly: true });
}
function counts(path) {
  const db = openRo(path);
  const out = {};
  for (const t of TABLES) {
    try {
      out[t.name] = db.prepare(`SELECT COUNT(*) n FROM ${t.name}`).get().n;
    } catch {
      out[t.name] = null;
    }
  }
  db.close();
  return out;
}
const destPath = (n) => join(ROOT, `dest-${n}.db`);

// ── 1. dry run writes nothing ───────────────────────────────────────────────
test('dry run is the default and creates no destination file', () => {
  const src = buildSource();
  const before = fingerprint(src);
  const dest = destPath('dryrun');
  const r = importClaudeMem({ source: src, dest });
  assert(r.dryRun === true, 'result should be flagged dryRun');
  assert(!existsSync(dest), 'dry run created the destination DB');
  assertUntouched(src, before, 'dry run');
  const obs = r.tables.find((t) => t.table === 'observations');
  eq(obs.sourceRows, 12, 'dry run should see 12 source observations');
  eq(obs.projectedInserts, 12, 'dry run should project 12 inserts');
  eq(obs.destRowsBefore, 0, 'no destination rows yet');
});

test('dry run against a populated destination projects zero new inserts', () => {
  const src = buildSource();
  const dest = destPath('dryrun2');
  importClaudeMem({ source: src, dest, apply: true });
  const before = fingerprint(src);
  const r = importClaudeMem({ source: src, dest });
  for (const t of r.tables) {
    if (t.skipped) continue;
    eq(t.projectedInserts, 0, `${t.table}: projected inserts after a full import`);
    assert(t.alreadyPresent > 0 || t.sourceRows === 0, `${t.table}: rows should read as already present`);
  }
  assertUntouched(src, before, 'second dry run');
});

// ── 2. apply, then re-apply inserts zero ────────────────────────────────────
test('apply imports every row; re-apply inserts exactly zero', () => {
  const src = buildSource();
  const before = fingerprint(src);
  const dest = destPath('idem');

  const r1 = importClaudeMem({ source: src, dest, apply: true });
  assert(r1.ok, `first import failed verification: ${JSON.stringify(r1.verification?.checks.filter((c) => !c.ok))}`);
  const c1 = counts(dest);
  eq(c1.sdk_sessions, 3, 'sessions imported');
  eq(c1.observations, 12, 'observations imported');
  eq(c1.session_summaries, 3, 'summaries imported');
  eq(c1.user_prompts, 15, 'prompts imported (12 + 3 surviving duplicates)');

  const r2 = importClaudeMem({ source: src, dest, apply: true });
  assert(r2.ok, 're-import failed verification');
  for (const t of r2.tables) eq(t.inserted, 0, `${t.table}: re-apply must insert zero`);
  const c2 = counts(dest);
  for (const k of Object.keys(c1)) eq(c2[k], c1[k], `${k}: row count changed on re-apply`);
  assertUntouched(src, before, 'apply + re-apply');
});

// ── 3. resume after an interrupted run ──────────────────────────────────────
test('an interrupted run resumes instead of restarting, and loses nothing', () => {
  const src = buildSource({ sessions: 5, obsPerSession: 4 });
  const before = fingerprint(src);
  const dest = destPath('resume');

  // Create the destination schema with a no-op import (--since past everything).
  importClaudeMem({ source: src, dest, apply: true, since: 9_999_999_999_999 });
  eq(counts(dest).observations, 0, 'no-op import should insert nothing');

  // Simulate a crash mid-copy: abort once 6 observations are in. Batches already
  // committed survive; the in-flight batch rolls back with its cursor.
  {
    const d = new DatabaseSync(dest);
    d.exec(`CREATE TRIGGER boom BEFORE INSERT ON observations
            WHEN (SELECT COUNT(*) FROM observations) >= 6
            BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
    d.close();
  }
  let threw = false;
  try {
    importClaudeMem({ source: src, dest, apply: true, batchSize: 2 });
  } catch (e) {
    threw = true;
    assert(/resumes from import_state/.test(e.message), 'crash message should tell the user it resumes');
  }
  assert(threw, 'the simulated crash should have propagated');

  const mid = counts(dest);
  assert(mid.observations >= 6 && mid.observations < 20, `partial import expected, got ${mid.observations}`);
  assert(mid.sdk_sessions === 5, 'earlier tables should already be committed');

  // A cursor must have been persisted for the interrupted table.
  {
    const d = openRo(dest);
    const st = d.prepare('SELECT * FROM import_state WHERE source_path = ?').get(src);
    assert(st, 'import_state row should exist after the crash');
    const parsed = JSON.parse(st.counts_json);
    assert(parsed.tables.observations.lastId > 0, 'observations cursor should be recorded');
    d.close();
  }

  { const d = new DatabaseSync(dest); d.exec('DROP TRIGGER boom'); d.close(); }

  const logs = [];
  const r = importClaudeMem({ source: src, dest, apply: true, batchSize: 2, log: (m) => logs.push(m) });
  assert(logs.some((l) => /resuming after source id/.test(l)), 'resume should be announced');
  const obsResult = r.tables.find((t) => t.table === 'observations');
  assert(obsResult.sourceRows < 20, `resume should not rescan every row (rescanned ${obsResult.sourceRows})`);
  assert(r.ok, 'resumed import must verify');
  eq(counts(dest).observations, 20, 'all observations present after resume');
  assertUntouched(src, before, 'interrupted + resumed run');
});

// ── 4. the 3-part user_prompts key ──────────────────────────────────────────
test('duplicate (content_session_id, prompt_number) prompts all survive', () => {
  const src = buildSource();
  const dest = destPath('dupkeys');
  const r = importClaudeMem({ source: src, dest, apply: true });
  const d = openRo(dest);
  const rows = d.prepare(
    `SELECT created_at_epoch FROM user_prompts WHERE content_session_id = 'dup-sess' AND prompt_number = 7
     ORDER BY created_at_epoch`
  ).all();
  eq(rows.length, 3, 'all three same-(session,prompt_number) rows must be kept');
  eq(new Set(rows.map((x) => x.created_at_epoch)).size, 3, 'the three rows must be distinct');
  d.close();
  const up = r.tables.find((t) => t.table === 'user_prompts');
  eq(up.intraSourceDuplicates, 1, 'the one exact 3-part duplicate should be reported, not hidden');
  assert(r.ok, 'import must verify with duplicate prompt keys present');
});

// ── 5. content_hash preserved byte for byte ─────────────────────────────────
test('content_hash is copied verbatim, never recomputed', () => {
  const src = buildSource({ obsPerSession: HASHES.length });
  const dest = destPath('hash');
  importClaudeMem({ source: src, dest, apply: true });
  const s = openRo(src), d = openRo(dest);
  const sh = s.prepare('SELECT memory_session_id, content_hash FROM observations ORDER BY content_hash').all();
  const dh = d.prepare('SELECT memory_session_id, content_hash FROM observations ORDER BY content_hash').all();
  eq(dh.length, sh.length, 'observation count');
  for (let i = 0; i < sh.length; i++) {
    eq(dh[i].content_hash, sh[i].content_hash, `content_hash mismatch at row ${i}`);
    eq(dh[i].memory_session_id, sh[i].memory_session_id, `memory_session_id mismatch at row ${i}`);
  }
  // Unicode / padded / mixed-case hashes survived untransformed.
  assert(sh.some((x) => /héllo/.test(x.content_hash)), 'fixture should include a unicode hash');
  assert(dh.some((x) => /héllo/.test(x.content_hash)), 'unicode hash must survive the copy');
  assert(dh.some((x) => /^ {2}padded {2}-/.test(x.content_hash)), 'whitespace-padded hash must not be trimmed');
  s.close(); d.close();
});

test('sync-only columns are dropped, payload columns are carried', () => {
  const src = buildSource();
  const dest = destPath('cols');
  importClaudeMem({ source: src, dest, apply: true });
  const d = openRo(dest);
  const cols = d.prepare('PRAGMA table_info(observations)').all().map((c) => c.name);
  for (const gone of ['sync_rev', 'synced_at', 'origin_device_id', 'origin_local_id']) {
    assert(!cols.includes(gone), `native observations should not carry ${gone}`);
  }
  for (const kept of ['content_hash', 'facts', 'concepts', 'narrative', 'generated_by_model']) {
    assert(cols.includes(kept), `native observations must carry ${kept}`);
  }
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  assert(!tables.includes('pending_messages'), 'pending_messages must not be imported');
  assert(!tables.includes('sync_outbox'), 'sync_outbox must not be imported');
  d.close();
});

// ── 6. source is never touched, ever ────────────────────────────────────────
test('the source DB is byte-identical after dry run + apply + re-apply + verify', () => {
  const src = buildSource({ sessions: 4 });
  const before = fingerprint(src);
  const dest = destPath('untouched');
  importClaudeMem({ source: src, dest });
  importClaudeMem({ source: src, dest, apply: true });
  importClaudeMem({ source: src, dest, apply: true });
  importClaudeMem({ source: src, dest, apply: true, since: 1 });
  assertUntouched(src, before, 'full lifecycle');
});

test('the read-only source handle refuses writes at the SQLite layer', () => {
  const src = buildSource({ sessions: 1, obsPerSession: 1 });
  const before = fingerprint(src);
  const db = openSourceReadOnly(src);
  let blocked = false;
  try {
    db.exec("INSERT INTO observations (memory_session_id, content_hash) VALUES ('x','y')");
  } catch (e) {
    blocked = /readonly/i.test(e.message);
  }
  db.close();
  assert(blocked, 'a write through the source handle must be refused');
  assertUntouched(src, before, 'read-only handle');
});

// ── 7. partial / older sources degrade, never crash ─────────────────────────
test('a source missing a table degrades with a message and imports the rest', () => {
  const src = buildSource({ dropTable: 'session_summaries' });
  const dest = destPath('missingtable');
  const r = importClaudeMem({ source: src, dest, apply: true });
  const sm = r.tables.find((t) => t.table === 'session_summaries');
  assert(sm.skipped && /no session_summaries table/.test(sm.skipped), `expected a skip message, got ${sm.skipped}`);
  assert(r.warnings.some((w) => /session_summaries/.test(w)), 'the skip must be surfaced as a warning');
  eq(counts(dest).observations, 12, 'the other tables still import');
  assert(r.ok, 'a missing source table must not fail verification');
});

test('a source missing a key column degrades rather than throwing', () => {
  const path = join(ROOT, 'oldschema.db');
  const db = new DatabaseSync(path);
  // An ancient layout: observations without content_hash.
  db.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT,
           type TEXT, text TEXT, created_at TEXT, created_at_epoch INTEGER);
           CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, content_session_id TEXT, project TEXT,
           memory_session_id TEXT, platform_source TEXT, started_at TEXT, started_at_epoch INTEGER,
           status TEXT);`);
  db.prepare('INSERT INTO observations (memory_session_id, project, type, text, created_at, created_at_epoch) VALUES (?,?,?,?,?,?)')
    .run('m1', 'p', 'discovery', 'synthetic', '2026-01-01T00:00:00Z', 1);
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, project, memory_session_id, platform_source,
              started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,?)`)
    .run('c1', 'p', 'm1', 'claude-code', '2026-01-01T00:00:00Z', 1, 'completed');
  db.close();
  const dest = destPath('oldschema');
  const r = importClaudeMem({ source: path, dest, apply: true });
  const obs = r.tables.find((t) => t.table === 'observations');
  assert(obs.skipped && /key column/.test(obs.skipped), `expected a key-column skip, got ${obs.skipped}`);
  eq(counts(dest).sdk_sessions, 1, 'the intact table still imports');
});

test('a source with none of the core tables is refused, not half-imported', () => {
  const path = join(ROOT, 'notclaudemem.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE something_else (a TEXT)');
  db.close();
  let msg = '';
  try {
    importClaudeMem({ source: path, dest: destPath('refused'), apply: true });
  } catch (e) {
    msg = e.message;
  }
  assert(/none of claude-mem's core tables/.test(msg), `expected a refusal, got: ${msg}`);
  assert(!existsSync(destPath('refused')), 'a refused run must not create a destination');
});

test('a missing source path fails clearly', () => {
  let msg = '';
  try {
    importClaudeMem({ source: join(ROOT, 'nope.db'), dest: destPath('nope') });
  } catch (e) { msg = e.message; }
  assert(/not found/.test(msg), `expected a not-found error, got: ${msg}`);
});

test('rows the native schema rejects are counted and reported, never silently dropped', () => {
  // The native schema is stricter than claude-mem's (NOT NULL / CHECK). Under
  // INSERT OR IGNORE such a row vanishes without a word — this is the guard.
  const src = buildSource({ sessions: 2, obsPerSession: 2, dupPrompts: false });
  {
    const d = new DatabaseSync(src);
    d.prepare(`INSERT INTO observations (memory_session_id, project, text, type, created_at,
               created_at_epoch, content_hash) VALUES (?,?,?,?,?,?,?)`)
      .run('mem-1', null, 'synthetic row with no project', 'discovery', '2026-05-01T00:00:00Z', 1, 'hash-noproject');
    d.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source,
               started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,?)`)
      .run('content-bad', 'mem-bad', 'p', 'claude-code', '2026-05-01T00:00:00Z', 1, 'zombie');
    d.close();
  }
  const dest = destPath('rejects');

  const plan = importClaudeMem({ source: src, dest });
  assert(!plan.ok, 'a dry run that would lose rows must not report ok');
  const planObs = plan.tables.find((t) => t.table === 'observations');
  assert(planObs.constraintRejects.some((r) => /NULL project/.test(r.reason)),
    `dry run should predict the NOT NULL reject, got ${JSON.stringify(planObs.constraintRejects)}`);
  const planSess = plan.tables.find((t) => t.table === 'sdk_sessions');
  assert(planSess.constraintRejects.some((r) => /CHECK/.test(r.reason)),
    `dry run should predict the CHECK reject, got ${JSON.stringify(planSess.constraintRejects)}`);

  const r = importClaudeMem({ source: src, dest, apply: true });
  eq(r.rejected, 2, 'both rejected rows must be counted exactly');
  assert(!r.ok, 'an import that dropped rows must not report success');
  assert(r.warnings.some((w) => /rejected by the native schema/.test(w)), 'rejections must surface as warnings');
  // The good rows still made it.
  eq(counts(dest).observations, 4, 'the valid observations still import');
});

test('user_prompts.session_db_id is remapped to the destination session, not copied', () => {
  const src = buildSource({ sessions: 2, obsPerSession: 1, dupPrompts: false });
  const dest = destPath('remap');
  // Pre-seed the destination so its sdk_sessions ids differ from the source's.
  {
    const d = new DatabaseSync(dest);
    d.exec(`CREATE TABLE IF NOT EXISTS placeholder (a)`);
    d.close();
  }
  importClaudeMem({ source: src, dest, apply: true });
  const d = openRo(dest);
  const rows = d.prepare(`SELECT p.session_db_id, p.content_session_id, s.content_session_id AS s_csid
                          FROM user_prompts p LEFT JOIN sdk_sessions s ON s.id = p.session_db_id`).all();
  assert(rows.length > 0, 'prompts should have imported');
  for (const r of rows) {
    eq(r.s_csid, r.content_session_id, 'session_db_id must point at the same session in the destination');
  }
  d.close();
});

// ── 8. verification actually fails when data is missing ─────────────────────
test('verification reports FAILURE when destination rows are missing', () => {
  const src = buildSource();
  const dest = destPath('verifyfail');
  const good = importClaudeMem({ source: src, dest, apply: true });
  assert(good.ok, 'baseline import should pass');

  const d = new DatabaseSync(dest);
  d.exec('DELETE FROM observations WHERE prompt_number = 0');
  d.close();

  const s = openSourceReadOnly(src);
  const d2 = new DatabaseSync(dest);
  const v = verifyImport(s, d2, {});
  s.close(); d2.close();
  assert(!v.ok, 'verification must fail when rows are missing');
  const failed = v.checks.filter((c) => !c.ok).map((c) => c.name);
  assert(failed.some((n) => /observations: every source row/.test(n)), `reconciliation check should fail, got: ${failed.join(' | ')}`);
  assert(failed.some((n) => /content_hash carried over/.test(n)), 'distinct content_hash check should fail');
});

test('verification reports FAILURE when the FTS index drifts from its table', () => {
  const src = buildSource();
  const dest = destPath('ftsfail');
  assert(importClaudeMem({ source: src, dest, apply: true }).ok, 'baseline import should pass');

  const d = new DatabaseSync(dest);
  // Insert a row with the FTS triggers disabled — index and table now disagree.
  d.exec('DROP TRIGGER observations_ai');
  d.prepare(`INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch,
             content_hash, text) VALUES (?,?,?,?,?,?,?)`)
    .run('mem-untracked', 'proj-x', 'discovery', '2026-03-01T00:00:00Z', 1, 'hash-untracked', 'synthetic untracked row');
  d.close();

  const s = openSourceReadOnly(src);
  const d2 = new DatabaseSync(dest);
  const v = verifyImport(s, d2, {});
  s.close(); d2.close();
  assert(!v.ok, 'verification must fail on FTS drift');
  assert(v.checks.some((c) => !c.ok && /observations_fts/.test(c.name)), 'the FTS check should be the failing one');
});

test('verification catches a destination that is behind on max epoch', () => {
  const src = buildSource();
  const dest = destPath('epochfail');
  importClaudeMem({ source: src, dest, apply: true });
  const d = new DatabaseSync(dest);
  const maxE = d.prepare('SELECT MAX(created_at_epoch) m FROM observations').get().m;
  d.prepare('DELETE FROM observations WHERE created_at_epoch = ?').run(maxE);
  d.close();
  const s = openSourceReadOnly(src);
  const d2 = new DatabaseSync(dest);
  const v = verifyImport(s, d2, {});
  s.close(); d2.close();
  assert(!v.ok, 'verification must fail');
  assert(v.checks.some((c) => !c.ok && /MAX\(created_at_epoch\)/.test(c.name)), 'the max-epoch check should fail');
});

test('rows written by a live claude-mem during the run are reported, not called a failure', () => {
  const src = buildSource({ sessions: 2, obsPerSession: 2, dupPrompts: false });
  const dest = destPath('livesource');
  const r = importClaudeMem({ source: src, dest, apply: true });
  assert(r.ok, 'baseline import should pass');

  // claude-mem keeps working: a newer observation lands after the copy pass.
  {
    const d = new DatabaseSync(src);
    d.prepare(`INSERT INTO observations (memory_session_id, project, text, type, created_at,
               created_at_epoch, content_hash) VALUES (?,?,?,?,?,?,?)`)
      .run('mem-1', 'proj-1', 'synthetic later row', 'discovery', '2026-06-01T00:00:00Z',
           9_000_000_000_000, 'hash-arrived-late');
    d.close();
  }

  // The bound comes from what the copy actually recorded in import_state.
  const upto = {};
  {
    const d = openRo(dest);
    const st = JSON.parse(d.prepare('SELECT counts_json FROM import_state WHERE source_path = ?').get(src).counts_json);
    for (const [name, t] of Object.entries(st.tables)) if (t.maxEpoch != null) upto[name] = t.maxEpoch;
    d.close();
  }
  assert(upto.observations > 0, 'import_state should carry a per-table max epoch');

  const s = openSourceReadOnly(src);
  const d2 = new DatabaseSync(dest);
  const bounded = verifyImport(s, d2, { upto });
  const unbounded = verifyImport(s, d2, {});
  s.close(); d2.close();
  assert(!unbounded.ok, 'without a bound the late row would read as a failure');
  assert(bounded.ok, `a bounded verification must pass: ${JSON.stringify(bounded.checks.filter((c) => !c.ok))}`);
  assert(bounded.checks.some((c) => /arrived while the import ran/.test(c.name)), 'the late row must be reported');
});

// ── 9. incremental (--since) and bookkeeping ────────────────────────────────
test('--since imports only newer rows and records a high-water epoch', () => {
  const src = buildSource({ sessions: 3, obsPerSession: 2, dupPrompts: false });
  const dest = destPath('since');
  const s = openRo(src);
  const cut = s.prepare('SELECT MAX(created_at_epoch) m FROM observations').get().m;
  s.close();
  const r = importClaudeMem({ source: src, dest, apply: true, since: cut });
  const obs = r.tables.find((t) => t.table === 'observations');
  eq(obs.sourceRows, 1, 'only the newest observation is in the --since window');
  eq(obs.inserted, 1, 'and it is inserted');
  eq(r.lastEpoch, cut, 'import_state high-water epoch');
  const d = openRo(dest);
  const st = d.prepare('SELECT last_epoch FROM import_state WHERE source_path = ?').get(src);
  eq(st.last_epoch, cut, 'last_epoch persisted for the next incremental');
  d.close();
});

test('import_state is keyed per source, so two sources coexist', () => {
  const a = buildSource({ sessions: 1, obsPerSession: 1, dupPrompts: false });
  const b = buildSource({ sessions: 2, obsPerSession: 1, dupPrompts: false });
  const dest = destPath('twosources');
  importClaudeMem({ source: a, dest, apply: true });
  importClaudeMem({ source: b, dest, apply: true });
  const d = openRo(dest);
  eq(d.prepare('SELECT COUNT(*) n FROM import_state').get().n, 2, 'one import_state row per source');
  d.close();
});

// ── 10. the honest not-carried disclosure ───────────────────────────────────
test('every run discloses what is not carried over', () => {
  const src = buildSource({ sessions: 1, obsPerSession: 1, dupPrompts: false });
  const r = importClaudeMem({ source: src, dest: destPath('notcarried') });
  eq(r.notCarried, NOT_CARRIED, 'the not-carried list must ride on the result');
  for (const needle of ['Chroma', 'sync', 'pending_messages', 'corpora']) {
    assert(NOT_CARRIED.some((n) => n.toLowerCase().includes(needle.toLowerCase())),
      `not-carried list should mention ${needle}`);
  }
});

// ==========================================================================
const w = Math.max(...results.map((r) => r[1].length));
for (const [st, name, msg] of results) {
  console.log(`${st === 'PASS' ? '✅' : '❌'} ${name.padEnd(w)}${msg ? '\n    ' + msg : ''}`);
}
console.log(`\n${pass} passed, ${fail} failed  ·  sandbox: ${ROOT}`);
if (!fail && !process.env.BRAIN_IMPORT_TEST_KEEP) rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
