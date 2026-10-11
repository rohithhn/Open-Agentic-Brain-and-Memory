// Import an existing claude-mem memory into this project's native store.
//
// SAFETY CONTRACT — the source DB is opened READ-ONLY, ALWAYS.
// The source connection is opened with a `file:<path>?mode=ro` URI *and*
// node:sqlite's `readOnly: true`. There is no flag, no option and no code path
// in this module that writes to, migrates, VACUUMs, copies-and-swaps or
// otherwise mutates the source. Every statement issued against `src` below is a
// SELECT / PRAGMA table_info. The source is never ATTACHed to the writable
// destination connection either, so no destination transaction can reach it.
// (One SQLite fact, stated plainly: opening a WAL-mode database — which
// claude-mem's is — makes SQLite touch the standard `-shm`/`-wal` sidecars next
// to it, exactly as every other reader does, including claude-mem itself and
// this repo's existing export.mjs. The database file's bytes are not changed;
// nothing is written *into* the memory.)
//
// DRY-RUN IS THE DEFAULT. `apply: true` (CLI `--apply`) is required before a
// single row is written, matching the `scrub --apply` convention in this repo.
//
// content_hash is COPIED VERBATIM, NEVER RECOMPUTED — hashes tie rows to the
// existing dedupe indexes and to every other tool in this project; rehashing
// would silently desync dedupe and duplicate rows (scrub spec §5.4.7).
// During the v1 → v2 content-hash transition (hash.mjs, `brain migrate-hash`)
// an observation is additionally recognised under the other version of its
// hash — computed only to ask "is this already here?", never stored.
//
// Spec: docs/specs/native-capture.md §3.
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, tableExists } from './db.mjs';
import { markStoreReady, clearStoreReady } from './store.mjs';
import { findSelfCapture, findTestData, testDataSkipMatcher } from './clean.mjs';
import { hashAliasIndex } from './hash.mjs';

// ── store.mjs interop ────────────────────────────────────────────────────────
// T1 owns bin/lib/store.mjs (`openStore`, `ensureSchema`, `storePath`,
// `storeExists`). It may not exist yet; when it does we use *its* schema so the
// native DB is defined in exactly one place. The fallback below is a literal
// transcription of spec §2 and is dead code the moment store.mjs lands.
let store = null;
try {
  if (existsSync(join(dirname(fileURLToPath(import.meta.url)), 'store.mjs'))) {
    store = await import('./store.mjs');
  }
} catch {
  store = null;
}

// True when two source rows carry identical values in every copied column.
function sameRowContent(a, b, cols) {
  for (const c of cols) {
    const x = a[c] === undefined ? null : a[c];
    const y = b[c] === undefined ? null : b[c];
    if (x !== y) return false;
  }
  return true;
}

export function defaultStorePath() {
  if (store && typeof store.storePath === 'function') {
    try {
      return store.storePath();
    } catch {
      /* fall through */
    }
  }
  return join(homedir(), '.claude-brain', 'brain.db');
}

// ── table contract ───────────────────────────────────────────────────────────
// Natural keys mirror the destination's UNIQUE indexes (spec §2). user_prompts
// is deliberately a 3-part key: the live source has duplicate
// (content_session_id, prompt_number) pairs, and a 2-part key would silently
// drop those rows.
export const TABLES = [
  // Copy order is dependency order (spec §3.3).
  { name: 'sdk_sessions', key: ['platform_source', 'content_session_id'], epoch: 'started_at_epoch' },
  { name: 'user_prompts', key: ['content_session_id', 'prompt_number', 'created_at_epoch'], epoch: 'created_at_epoch' },
  { name: 'observations', key: ['memory_session_id', 'content_hash'], epoch: 'created_at_epoch' },
  { name: 'session_summaries', key: ['memory_session_id', 'prompt_number', 'created_at_epoch'], epoch: 'created_at_epoch' },
];

// What an import does NOT bring across. Printed on every run — the user should
// never have to discover this later (spec §3.6).
export const NOT_CARRIED = [
  "claude-mem's Chroma / semantic index (~/.claude-mem/chroma/) — semantic search stays with claude-mem; native search is FTS only",
  'built corpora and its mcp-search tooling state',
  'its cloud-sync machinery (sync_outbox, sync_entity_heads, sync_dead_letter, sync_state, sync_content_outbox, sync_launch_exclusions) — this project has its own sync',
  'pending_messages — claude-mem\'s in-flight worker queue (rows not yet distilled into observations at import time)',
  'per-row sync bookkeeping columns (synced_at, origin_device_id, origin_local_id, sync_rev) and worker_port / prompt_counter',
  'future relevance_count increments made inside claude-mem\'s own UI',
];

const FALLBACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT, memory_session_id TEXT UNIQUE, project TEXT,
  platform_source TEXT, user_prompt TEXT,
  started_at TEXT, started_at_epoch INTEGER,
  completed_at TEXT, completed_at_epoch INTEGER,
  status TEXT, custom_title TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content
  ON sdk_sessions(platform_source, content_session_id);
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT, project TEXT, text TEXT, type TEXT, title TEXT, subtitle TEXT,
  facts TEXT, narrative TEXT, concepts TEXT, files_read TEXT, files_modified TEXT,
  prompt_number INTEGER, created_at TEXT, created_at_epoch INTEGER,
  content_hash TEXT, generated_by_model TEXT, relevance_count INTEGER DEFAULT 0, metadata TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_session_hash
  ON observations(memory_session_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch);

CREATE TABLE IF NOT EXISTS user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT, prompt_number INTEGER, prompt_text TEXT,
  created_at TEXT, created_at_epoch INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_prompts_session_prompt_epoch
  ON user_prompts(content_session_id, prompt_number, created_at_epoch);
CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC);

CREATE TABLE IF NOT EXISTS session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT, project TEXT, request TEXT, investigated TEXT, learned TEXT,
  completed TEXT, next_steps TEXT, files_read TEXT, files_edited TEXT, notes TEXT,
  prompt_number INTEGER, created_at TEXT, created_at_epoch INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_summaries_session_prompt_epoch
  ON session_summaries(memory_session_id, prompt_number, created_at_epoch);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, subtitle, narrative, text, facts, concepts,
  content='observations', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
END;
CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
  VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
END;
CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
  VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS user_prompts_fts USING fts5(
  prompt_text, content='user_prompts', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS user_prompts_ai AFTER INSERT ON user_prompts BEGIN
  INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
END;
CREATE TRIGGER IF NOT EXISTS user_prompts_ad AFTER DELETE ON user_prompts BEGIN
  INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text) VALUES ('delete', old.id, old.prompt_text);
END;
CREATE TRIGGER IF NOT EXISTS user_prompts_au AFTER UPDATE ON user_prompts BEGIN
  INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text) VALUES ('delete', old.id, old.prompt_text);
  INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
  request, investigated, learned, completed, next_steps, notes,
  content='session_summaries', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES ('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
END;
CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES ('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
  INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
END;

CREATE TABLE IF NOT EXISTS import_state (
  source_path TEXT PRIMARY KEY, last_epoch INTEGER, last_run_at TEXT, counts_json TEXT
);
CREATE TABLE IF NOT EXISTS capture_state (
  transcript_path TEXT PRIMARY KEY, mtime INTEGER, bytes INTEGER, session_id TEXT, status TEXT
);
`;

function ensureDestSchema(db) {
  if (store && typeof store.ensureSchema === 'function') {
    store.ensureSchema(db);
    return 'store.mjs';
  }
  db.exec(FALLBACK_SCHEMA);
  return 'fallback (store.mjs not present)';
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Open the claude-mem DB read-only. Two independent locks on the door: the
// `mode=ro` URI (SQLite refuses the write at the VFS layer) and readOnly:true.
export function openSourceReadOnly(path) {
  if (!existsSync(path)) throw new Error(`claude-mem DB not found: ${path}`);
  // encodeURI leaves '?' and '#' alone, which would truncate the URI's path part.
  const uriPath = encodeURI(path).replace(/\?/g, '%3f').replace(/#/g, '%23');
  return new DatabaseSync(`file:${uriPath}?mode=ro`, { readOnly: true, open: true });
}

function columnsOf(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

// Source observation columns hash.mjs reads to recognise a row under the other
// hash version (content recipes + metadata.legacy_content_hash).
const ALIAS_COLS = ['memory_session_id', 'project', 'content_hash', 'text', 'title', 'subtitle', 'facts', 'narrative', 'metadata'];
const aliasSelect = (srcCols) => ALIAS_COLS.filter((c) => srcCols.includes(c));
// A destination alias index, or null when the table cannot carry one.
function aliasIndexFor(dest, table) {
  if (table !== 'observations' || !dest) return null;
  try { return hashAliasIndex(dest); } catch { return null; }
}

const KEY_SEP = '\u0000'; // NUL: cannot appear inside a SQLite TEXT key value
// Natural-key string for a row. Returns null when any key component is NULL:
// SQLite's UNIQUE indexes treat NULLs as distinct, so such rows are never
// deduped against each other and must never be counted as duplicates here.
function keyOf(row, keyCols) {
  const parts = [];
  for (const c of keyCols) {
    const v = row[c];
    if (v === null || v === undefined) return null;
    parts.push(String(v));
  }
  return parts.join(KEY_SEP);
}

// Columns never copied. `id` because the destination assigns its own rowids
// (source ids are meaningless here and would collide across imports).
// `session_db_id` because it is a source rowid pointing at source sdk_sessions —
// carrying it verbatim would silently point at a DIFFERENT session in the
// destination. It is remapped from content_session_id instead (see copyTable).
const NEVER_COPY = new Set(['id', 'session_db_id']);

// ── self-capture skip ────────────────────────────────────────────────────────
// Every row this importer copies comes from somewhere the brain does not
// control: claude-mem's DB (pulled on every sync), another Mac's cloud blob, a
// restore. Any of them can still hold the brain's own headless runs — the
// distiller, claude-mem's observer — which `brain clean --self-capture` removed
// here. Without this skip the next sync INSERT-OR-IGNOREs them straight back.
// Source ids per table, from the same detector `brain clean` uses (read-only:
// findSelfCapture only SELECTs).
const SELF_KEYS = { sdk_sessions: 'sessions', user_prompts: 'prompts', observations: 'observations', session_summaries: 'summaries' };
function selfCaptureIds(src, warnings) {
  try {
    const found = findSelfCapture(src);
    const out = {};
    for (const [table, key] of Object.entries(SELF_KEYS)) out[table] = new Set(found[key].map((r) => r.id));
    return out;
  } catch (e) {
    warnings.push(`self-capture detection failed on the source (${e.message}) — its rows were not filtered`);
    return {};
  }
}

// ── test-data skip ───────────────────────────────────────────────────────────
// Same failure, same fix, for test-fixture projects (testdata.mjs): `brain clean
// --test-data --apply` removes them here, and without this skip the next sync's
// claude-mem pull / cloud merge (resume:false — a full re-read) INSERT-OR-IGNOREs
// every one of them straight back. Skipped: the auto patterns, plus any project
// name already removed from the destination (or recorded as removed in the
// source — another machine's cleaned blob). Read-only on both.
function testDataIds(src, destPath, warnings) {
  let dest = null;
  try {
    if (destPath && existsSync(destPath)) {
      try { dest = openDb(destPath, { readonly: true }); } catch { dest = null; }
    }
    const found = findTestData(src, { match: testDataSkipMatcher(dest, src) });
    const out = {};
    for (const [table, key] of Object.entries(SELF_KEYS)) out[table] = new Set(found[key].map((r) => r.id));
    return out;
  } catch (e) {
    warnings.push(`test-data detection failed on the source (${e.message}) — its rows were not filtered`);
    return {};
  } finally {
    try { dest?.close(); } catch {}
  }
}

// Per table: source id -> why it is left out ('self' | 'test').
function mergeSkips(self, test) {
  const out = {};
  for (const table of Object.keys(SELF_KEYS)) {
    const m = new Map();
    for (const id of test[table] || []) m.set(id, 'test');
    for (const id of self[table] || []) m.set(id, 'self');
    if (m.size) out[table] = m;
  }
  return out;
}

// ── constraint preflight ─────────────────────────────────────────────────────
// The native schema is stricter than claude-mem's (NOT NULL, CHECK). Under
// INSERT OR IGNORE a violating row is SILENTLY DROPPED — exactly the failure
// mode this importer must never have. So: count would-be rejects up front (and
// count real ones exactly during the copy, see copyTable).
function checkExprs(ddl) {
  // Pull top-level CHECK(...) expressions out of a CREATE TABLE statement.
  const out = [];
  const re = /\bCHECK\s*\(/gi;
  let m;
  while ((m = re.exec(ddl))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < ddl.length && depth > 0; i++) {
      if (ddl[i] === '(') depth++;
      else if (ddl[i] === ')') depth--;
    }
    if (depth === 0) out.push(ddl.slice(re.lastIndex, i - 1));
  }
  return out;
}

function preflightConstraints(src, dest, table, cols) {
  const rejects = [];
  if (!dest || !tableExists(dest, table) || !tableExists(src, table)) return rejects;
  let info = [];
  try { info = dest.prepare(`PRAGMA table_info(${table})`).all(); } catch { return rejects; }
  const srcCols = new Set(columnsOf(src, table));
  for (const c of info) {
    if (!c.notnull || c.dflt_value !== null || c.name === 'id') continue;
    if (!cols.includes(c.name)) {
      if (!srcCols.has(c.name)) rejects.push({ reason: `column ${c.name} is NOT NULL in the native schema but absent from the source`, rows: safeCount(src, table) });
      continue;
    }
    try {
      const n = src.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${c.name} IS NULL`).get().n;
      if (n > 0) rejects.push({ reason: `${n} source row(s) have NULL ${c.name}, which is NOT NULL natively`, rows: n });
    } catch { /* ignore */ }
  }
  let ddl = '';
  try {
    ddl = dest.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql || '';
  } catch { /* ignore */ }
  for (const expr of checkExprs(ddl)) {
    try {
      const n = src.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE NOT (${expr})`).get().n;
      if (n > 0) rejects.push({ reason: `${n} source row(s) fail the native CHECK constraint (${expr.trim().slice(0, 80)})`, rows: n });
    } catch { /* expression not evaluable against the source — skip */ }
  }
  return rejects;
}

function safeCount(db, table) {
  if (!tableExists(db, table)) return 0;
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch {
    return 0;
  }
}

function maxEpoch(db, table, col) {
  if (!tableExists(db, table)) return null;
  if (!columnsOf(db, table).includes(col)) return null;
  try {
    const r = db.prepare(`SELECT MAX(${col}) AS m FROM ${table}`).get();
    return r && r.m !== null && r.m !== undefined ? Number(r.m) : null;
  } catch {
    return null;
  }
}

// ── import_state (resumability) ──────────────────────────────────────────────
// Progress lives in import_state, keyed by source path. counts_json carries a
// per-table cursor over the SOURCE's rowid (`lastId`) plus running tallies; it
// is written inside the same transaction as the batch it describes, so a crash
// can never leave the cursor ahead of the rows. `last_epoch` is the high-water
// mark for the steady-state `--since` incremental (spec §3.4/§5).

function readState(db, sourcePath) {
  if (!tableExists(db, 'import_state')) return null;
  let row;
  try {
    row = db.prepare('SELECT * FROM import_state WHERE source_path = ?').get(sourcePath);
  } catch {
    return null;
  }
  if (!row) return null;
  let counts = {};
  try {
    counts = row.counts_json ? JSON.parse(row.counts_json) : {};
  } catch {
    counts = {};
  }
  return { lastEpoch: row.last_epoch ?? null, lastRunAt: row.last_run_at ?? null, counts };
}

// The watermark for the next `--since` run. It is the MINIMUM of the per-table
// maxima, not the global maximum: a `--since` above any table's max would skip
// rows in that table. Conservative by construction — re-importing a few rows is
// free (INSERT OR IGNORE), missing one is not.
export function highWaterEpoch(counts) {
  const vals = Object.values(counts?.tables || {})
    .map((t) => t.maxEpoch)
    .filter((v) => v !== null && v !== undefined);
  return vals.length ? Math.min(...vals) : null;
}

function writeState(db, sourcePath, { counts }) {
  if (!tableExists(db, 'import_state')) return;
  const lastEpoch = highWaterEpoch(counts);
  const json = JSON.stringify(counts);
  const now = new Date().toISOString();
  // No assumption about a PK/unique index on source_path: delete-then-insert is
  // correct either way, and runs inside the caller's transaction.
  db.prepare('DELETE FROM import_state WHERE source_path = ?').run(sourcePath);
  db.prepare(
    'INSERT INTO import_state (source_path, last_epoch, last_run_at, counts_json) VALUES (?, ?, ?, ?)'
  ).run(sourcePath, lastEpoch ?? null, now, json);
}

// ── planning (dry-run) ───────────────────────────────────────────────────────

function planTable(src, dest, spec, { since, skip }) {
  const out = {
    table: spec.name,
    sourceRows: 0,
    destRowsBefore: 0,
    projectedInserts: 0,
    intraSourceDuplicates: 0,
    alreadyPresent: 0,
    hashAliased: 0,
    filteredBySince: 0,
    selfCaptureSkipped: 0,
    testDataSkipped: 0,
    columns: [],
    constraintRejects: [],
    skipped: null,
  };
  if (!tableExists(src, spec.name)) {
    out.skipped = `source has no ${spec.name} table — skipping (older claude-mem layout)`;
    return out;
  }
  const srcCols = columnsOf(src, spec.name);
  const destCols = dest ? columnsOf(dest, spec.name) : null;
  if (dest && (!destCols || !destCols.length)) {
    out.skipped = `destination has no ${spec.name} table — schema incomplete`;
    return out;
  }
  const keyCols = spec.key.filter((c) => srcCols.includes(c));
  if (keyCols.length !== spec.key.length) {
    out.skipped =
      `source ${spec.name} is missing key column(s) ` +
      `[${spec.key.filter((c) => !srcCols.includes(c)).join(', ')}] — skipping (older claude-mem layout)`;
    return out;
  }
  const shared = (destCols || srcCols).filter((c) => !NEVER_COPY.has(c) && srcCols.includes(c));
  out.columns = shared;
  out.destRowsBefore = dest ? safeCount(dest, spec.name) : 0;
  out.constraintRejects = preflightConstraints(src, dest, spec.name, shared);

  const total = safeCount(src, spec.name);
  const hasEpoch = srcCols.includes(spec.epoch);
  const where = since != null && hasEpoch ? `WHERE ${spec.epoch} >= ${Number(since)}` : '';
  const scanned = where
    ? src.prepare(`SELECT COUNT(*) AS n FROM ${spec.name} ${where}`).get().n
    : total;
  out.sourceRows = scanned;
  out.filteredBySince = total - scanned;

  // Anti-join on the natural key, streamed so we never hold rows in memory.
  const destKeys = new Set();
  if (dest && out.destRowsBefore > 0) {
    for (const r of dest.prepare(`SELECT ${keyCols.join(', ')} FROM ${spec.name}`).iterate()) {
      const k = keyOf(r, keyCols);
      if (k !== null) destKeys.add(k);
    }
  }
  const seen = new Set();
  const idCol = srcCols.includes('id') ? 'id' : 'rowid';
  // Observations already held under the other content-hash version (hash.mjs).
  const alias = out.destRowsBefore > 0 ? aliasIndexFor(dest, spec.name) : null;
  const selCols = alias ? [...new Set([...keyCols, ...aliasSelect(srcCols)])] : keyCols;
  for (const r of src.prepare(`SELECT ${idCol} AS __src_id, ${selCols.join(', ')} FROM ${spec.name} ${where}`).iterate()) {
    const why = skip && skip.get(r.__src_id);
    if (why) { if (why === 'test') out.testDataSkipped++; else out.selfCaptureSkipped++; continue; }
    const k = keyOf(r, keyCols);
    if (k === null) {
      out.projectedInserts++; // NULL key component => never conflicts
      continue;
    }
    if (destKeys.has(k)) {
      out.alreadyPresent++;
      continue;
    }
    if (alias && !seen.has(k) && alias.has(r)) {
      out.alreadyPresent++;
      out.hashAliased++;
      continue;
    }
    if (seen.has(k)) {
      out.intraSourceDuplicates++;
      continue;
    }
    seen.add(k);
    out.projectedInserts++;
  }
  return out;
}

// ── copy ─────────────────────────────────────────────────────────────────────

function copyTable(src, dest, spec, { since, batchSize, sourcePath, state, log, skip }) {
  const plan = {
    table: spec.name, sourceRows: 0, inserted: 0, alreadyPresent: 0, selfCaptureSkipped: 0, testDataSkipped: 0,
    intraSourceDuplicates: 0, distinctLost: 0, lostKeys: [], rejected: 0, rejectReasons: [], skipped: null, resumedFrom: 0, hashAliased: 0,
  };
  if (!tableExists(src, spec.name)) {
    plan.skipped = `source has no ${spec.name} table — skipping`;
    return plan;
  }
  const srcCols = columnsOf(src, spec.name);
  const destCols = columnsOf(dest, spec.name);
  if (!destCols.length) {
    plan.skipped = `destination has no ${spec.name} table — skipping`;
    return plan;
  }
  const keyCols = spec.key.filter((c) => srcCols.includes(c));
  if (keyCols.length !== spec.key.length) {
    plan.skipped = `source ${spec.name} missing key column(s) — skipping`;
    return plan;
  }
  // Intersecting columns only, minus NEVER_COPY.
  // content_hash rides along untouched — copied, never recomputed.
  const cols = destCols.filter((c) => !NEVER_COPY.has(c) && srcCols.includes(c));
  if (!cols.length) {
    plan.skipped = `no shared columns for ${spec.name} — skipping`;
    return plan;
  }

  const hasEpoch = srcCols.includes(spec.epoch);
  const sinceClause = since != null && hasEpoch ? ` AND ${spec.epoch} >= ${Number(since)}` : '';
  // Batching/resume rides on the source's rowid. Every claude-mem layout has one;
  // if a stripped-down source somehow lacks `id`, fall back to rowid so the copy
  // still runs (degrade, never throw).
  const idCol = srcCols.includes('id') ? 'id' : 'rowid';
  const selectSql =
    `SELECT ${idCol} AS __src_id, ${cols.join(', ')} FROM ${spec.name} ` +
    `WHERE ${idCol} > ?${sinceClause} ORDER BY ${idCol} LIMIT ${Number(batchSize)}`;
  let selectStmt;
  try {
    selectStmt = src.prepare(selectSql);
  } catch (e) {
    plan.skipped = `cannot read source ${spec.name} (${e.message}) — skipping`;
    return plan;
  }
  // session_db_id is remapped, never copied: it is a source rowid. The
  // destination's own sdk_sessions.id for the same content_session_id is looked
  // up (and cached); when there is no match the column is left NULL rather than
  // pointing at an unrelated session.
  const remapSessionDbId =
    destCols.includes('session_db_id') && cols.includes('content_session_id') && spec.name !== 'sdk_sessions';
  const insertCols = remapSessionDbId ? [...cols, 'session_db_id'] : cols;
  const sessionIdCache = new Map();
  const lookupSession = remapSessionDbId
    ? dest.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ? ORDER BY id LIMIT 1')
    : null;
  const destSessionDbId = (contentSessionId) => {
    if (contentSessionId == null) return null;
    if (sessionIdCache.has(contentSessionId)) return sessionIdCache.get(contentSessionId);
    let id = null;
    try { id = lookupSession.get(contentSessionId)?.id ?? null; } catch { id = null; }
    sessionIdCache.set(contentSessionId, id);
    return id;
  };

  const insertStmt = dest.prepare(
    `INSERT OR IGNORE INTO ${spec.name} (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(',')})`
  );
  // Only consulted when a row was NOT inserted, to tell "already there" from
  // "silently rejected by a constraint" — the difference between a no-op and
  // data loss.
  const existsStmt = dest.prepare(
    `SELECT 1 AS x FROM ${spec.name} WHERE ${keyCols.map((c) => `${c} IS ?`).join(' AND ')} LIMIT 1`
  );

  // CONTENT-LEVEL DEDUPE — the natural key is not enough for observations.
  // Measured: claude-mem reassigns memory_session_id when it re-distils a
  // session, keeping only the newest generation. Because our key is
  // (memory_session_id, content_hash), every regeneration arrived looking brand
  // new and accumulated: 99% of the session-ids inside our duplicate groups no
  // longer exist upstream, and the store reached 21% redundancy against their 2%.
  // Identical content in the same project is the same observation regardless of
  // which session-id claude-mem currently files it under — the same rule
  // remember.mjs already applies on the MCP write path.
  const contentDupStmt = (spec.name === 'observations' && cols.includes('content_hash') && cols.includes('project'))
    ? dest.prepare('SELECT 1 AS x FROM observations WHERE project IS ? AND content_hash IS ? LIMIT 1')
    : null;
  // The same observation under the other content-hash version (hash.mjs): a
  // machine that ran `brain migrate-hash` and one that did not hold identical
  // memories under different hashes. Consulted only after every stored-hash
  // lookup missed, so it can only turn a would-be duplicate into "present".
  const alias = aliasIndexFor(dest, spec.name);
  plan.rejectReasons = preflightConstraints(src, dest, spec.name, cols).map((r) => r.reason);

  const tState = state.counts.tables[spec.name] ||
    { lastId: 0, inserted: 0, alreadyPresent: 0, intraSourceDuplicates: 0, rejected: 0, sourceRows: 0, maxEpoch: null, done: false };
  state.counts.tables[spec.name] = tState;
  plan.resumedFrom = tState.lastId || 0;
  if (plan.resumedFrom > 0) log(`  ${spec.name}: resuming after source id ${plan.resumedFrom}`);

  const seen = new Set(); // keys inserted in this run — distinguishes intra-source dupes
  // The row we actually kept per key, so a later collision on the same key can be
  // compared: identical => harmless duplicate, different => real content lost.
  const keptRowByKey = new Map();
  let cursor = tState.lastId || 0;
  for (;;) {
    const rows = selectStmt.all(cursor);
    if (!rows.length) break;
    dest.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        // The brain's own runs (selfCaptureIds) and test-fixture projects
        // (testDataIds): never copied in.
        const why = skip && skip.get(r.__src_id);
        if (why) {
          const k = why === 'test' ? 'testDataSkipped' : 'selfCaptureSkipped';
          plan[k]++;
          tState[k] = (tState[k] || 0) + 1;
          cursor = r.__src_id;
          continue;
        }
        const vals = cols.map((c) => (r[c] === undefined ? null : r[c]));
        if (remapSessionDbId) vals.push(destSessionDbId(r.content_session_id));
        // Skip content we already hold for this project, whatever session-id
        // claude-mem currently attaches to it.
        if (contentDupStmt && r.content_hash != null && r.content_hash !== ''
            && contentDupStmt.get(r.project ?? null, r.content_hash)) {
          tState.sourceRows++; plan.sourceRows++;
          tState.alreadyPresent++; plan.alreadyPresent++;
          cursor = r.__src_id;
          continue;
        }
        const k = keyOf(r, keyCols);
        if (alias && !(k !== null && seen.has(k))
            && !existsStmt.get(...keyCols.map((c) => (r[c] === undefined ? null : r[c])))
            && alias.has(r)) {
          tState.sourceRows++; plan.sourceRows++;
          tState.alreadyPresent++; plan.alreadyPresent++;
          tState.hashAliased = (tState.hashAliased || 0) + 1;
          plan.hashAliased = (plan.hashAliased || 0) + 1;
          cursor = r.__src_id;
          if (hasEpoch && r[spec.epoch] != null) {
            const e = Number(r[spec.epoch]);
            if (tState.maxEpoch == null || e > tState.maxEpoch) tState.maxEpoch = e;
          }
          continue;
        }
        const info = insertStmt.run(...vals);
        tState.sourceRows++;
        plan.sourceRows++;
        if (info.changes > 0) {
          tState.inserted++;
          plan.inserted++;
          if (alias) alias.note(r);
          if (k !== null) { seen.add(k); keptRowByKey.set(k, r); }
        } else if (k !== null && seen.has(k)) {
          tState.intraSourceDuplicates++;
          plan.intraSourceDuplicates++;
          // Two source rows share a natural key. If they are byte-identical the
          // drop costs nothing. If they DIFFER, the destination cannot represent
          // both and real content is being lost — that must never pass as a
          // successful import, so it is counted separately and fails the run.
          // (Measured: the live source has 0 such collisions, but another
          // machine's may, and the loss would otherwise be silent.)
          const kept = keptRowByKey.get(k);
          if (kept !== undefined && !sameRowContent(kept, r, cols)) {
            tState.distinctLost = (tState.distinctLost || 0) + 1;
            plan.distinctLost = (plan.distinctLost || 0) + 1;
            if (plan.lostKeys.length < 20) plan.lostKeys.push(`${spec.name} key=${k}`);
          }
        } else if (existsStmt.get(...keyCols.map((c) => (r[c] === undefined ? null : r[c])))) {
          tState.alreadyPresent++;
          plan.alreadyPresent++;
        } else {
          // Not inserted and not present: the destination schema rejected it.
          // Never silent — counted here, reported, and it fails verification.
          tState.rejected = (tState.rejected || 0) + 1;
          plan.rejected++;
        }
        cursor = r.__src_id;
        if (hasEpoch && r[spec.epoch] != null) {
          const e = Number(r[spec.epoch]);
          if (tState.maxEpoch == null || e > tState.maxEpoch) tState.maxEpoch = e;
        }
      }
      tState.lastId = cursor;
      // Cursor is committed with the rows it describes — never ahead of them.
      writeState(dest, sourcePath, state);
      dest.exec('COMMIT');
    } catch (e) {
      try { dest.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }
  tState.done = true;
  return plan;
}

// ── verification ─────────────────────────────────────────────────────────────

/**
 * Reconcile a destination against the source.
 *
 * `upto` (per-table max epoch seen during the copy) matters against a LIVE
 * claude-mem: it keeps writing while we read, and rows that arrive after the
 * copy pass are legitimately not in the destination yet. Without this bound,
 * verification would cry failure over a healthy import. Those rows are counted
 * and reported instead — the next `--since` run picks them up.
 */
export function verifyImport(src, dest, { since = null, upto = {}, skipIds = {} } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  for (const spec of TABLES) {
    if (!tableExists(src, spec.name)) {
      add(`${spec.name}: source table absent`, true, 'skipped (nothing to verify)');
      continue;
    }
    if (!tableExists(dest, spec.name)) {
      add(`${spec.name}: destination table present`, false, 'destination is missing this table');
      continue;
    }
    const srcCols = columnsOf(src, spec.name);
    const keyCols = spec.key.filter((c) => srcCols.includes(c));
    if (keyCols.length !== spec.key.length) {
      add(`${spec.name}: key columns present in source`, true, 'skipped (older claude-mem layout)');
      continue;
    }
    const hasEpoch = srcCols.includes(spec.epoch);
    const bound = hasEpoch && upto[spec.name] != null ? Number(upto[spec.name]) : null;
    const clauses = [];
    if (since != null && hasEpoch) clauses.push(`${spec.epoch} >= ${Number(since)}`);
    if (bound !== null) clauses.push(`(${spec.epoch} IS NULL OR ${spec.epoch} <= ${bound})`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const arrivedDuringRun =
      bound === null ? 0 : src.prepare(`SELECT COUNT(*) AS n FROM ${spec.name} WHERE ${spec.epoch} > ${bound}`).get().n;
    if (arrivedDuringRun) {
      add(
        `${spec.name}: rows that arrived while the import ran`,
        true,
        `${arrivedDuringRun} newer row(s) in the live source — not a failure; the next run picks them up`
      );
    }

    // (a) reconciliation: every source natural key must exist in the destination
    //     — except self-capture / test-data rows, which the copy deliberately left out.
    const skip = skipIds[spec.name];
    const idCol = srcCols.includes('id') ? 'id' : 'rowid';
    const destKeys = new Set();
    for (const r of dest.prepare(`SELECT ${keyCols.join(', ')} FROM ${spec.name}`).iterate()) {
      const k = keyOf(r, keyCols);
      if (k !== null) destKeys.add(k);
    }
    let scanned = 0, missing = 0, aliased = 0, nullKeyed = 0, selfSkipped = 0, keptMax = null, distinctSrcKeys = new Set();
    const epochSel = hasEpoch ? `, ${spec.epoch} AS __epoch` : '';
    // An observation the destination holds under the other content-hash
    // version (hash.mjs) is present, not missing — the copy skipped it as such.
    const alias = aliasIndexFor(dest, spec.name);
    // The copy's content-level dedupe (see "CONTENT-LEVEL DEDUPE" above): an
    // observation whose text already exists in the same project under another
    // memory_session_id was carried as that row, not lost. Reconcile with the
    // same rule, or every real claude-mem store fails verification on its own
    // re-distilled duplicates (measured: 117 of 28,283 on a live store).
    const contentDedupe = spec.name === 'observations' && srcCols.includes('content_hash') && srcCols.includes('project')
      && columnsOf(dest, 'observations').includes('project');
    const destContent = new Set();
    if (contentDedupe) for (const r of dest.prepare('SELECT project, content_hash FROM observations').iterate()) destContent.add(`${r.project}\u0000${r.content_hash}`);
    let contentDeduped = 0;
    const selCols0 = contentDedupe ? [...new Set([...keyCols, 'project'])] : keyCols;
    const selCols = alias ? [...new Set([...selCols0, ...aliasSelect(srcCols)])] : selCols0;
    for (const r of src.prepare(`SELECT ${idCol} AS __src_id${epochSel}, ${selCols.join(', ')} FROM ${spec.name} ${where}`).iterate()) {
      if (skip && skip.has(r.__src_id)) { selfSkipped++; continue; }
      scanned++;
      if (r.__epoch != null && (keptMax === null || Number(r.__epoch) > keptMax)) keptMax = Number(r.__epoch);
      const k = keyOf(r, keyCols);
      if (k === null) { nullKeyed++; continue; }
      distinctSrcKeys.add(k);
      if (!destKeys.has(k)) {
        if (alias && alias.has(r)) aliased++;
        else if (contentDedupe && destContent.has(`${r.project}\u0000${r.content_hash}`)) contentDeduped++;
        else missing++;
      }
    }
    add(
      `${spec.name}: every source row's natural key present in destination`,
      missing === 0,
      `source rows ${scanned} (distinct keys ${distinctSrcKeys.size}${nullKeyed ? `, null-keyed ${nullKeyed}` : ''}` +
        `${selfSkipped ? `, ${selfSkipped} self-capture / test-data row(s) excluded` : ''}), missing in destination ${missing}` +
        `${aliased ? `, ${aliased} present under the other content-hash version` : ''}` +
        `${contentDeduped ? `, ${contentDeduped} duplicate(s) of a memory already in the same project (kept once)` : ''}`
    );

    // (b) destination must hold at least as many rows as distinct source keys
    //     (less the ones it holds under the other content-hash version).
    const destRows = safeCount(dest, spec.name);
    add(
      `${spec.name}: destination row count >= distinct source keys`,
      destRows >= distinctSrcKeys.size - aliased - contentDeduped,
      `destination ${destRows} rows vs ${distinctSrcKeys.size} distinct source keys` +
        `${aliased ? ` (${aliased} held under the other content-hash version)` : ''}` +
        `${contentDeduped ? ` (${contentDeduped} kept once as same-project duplicates)` : ''}`
    );

    // (c) max epoch: destination must be at least as fresh as the source.
    if (hasEpoch && columnsOf(dest, spec.name).includes(spec.epoch)) {
      // Bounded by what the copy actually saw, so a live source writing during
      // the run cannot manufacture a false failure.
      // With self-capture / test-data rows left out, the newest row the copy KEPT is the bar.
      const sm = skip && skip.size ? keptMax : bound !== null ? bound : maxEpoch(src, spec.name, spec.epoch);
      const dm = maxEpoch(dest, spec.name, spec.epoch);
      const ok = sm === null || (dm !== null && dm >= sm);
      add(
        `${spec.name}: MAX(${spec.epoch}) reconciles`,
        ok,
        sm === dm ? `equal (${sm})` : `source ${sm} vs destination ${dm}${ok ? ' (destination newer — native rows)' : ' — DESTINATION IS BEHIND'}`
      );
    }
  }

  // (d) distinct content_hash equality for observations — the dedupe surface.
  if (tableExists(src, 'observations') && tableExists(dest, 'observations') &&
      columnsOf(src, 'observations').includes('content_hash')) {
    const obsBound = upto.observations != null ? Number(upto.observations) : null;
    const hashWhere = obsBound === null ? '' : ` WHERE created_at_epoch IS NULL OR created_at_epoch <= ${obsBound}`;
    const srcHashes = new Set();
    const skipObs = skipIds.observations;
    const srcObsCols = columnsOf(src, 'observations');
    const obsIdCol = srcObsCols.includes('id') ? 'id' : 'rowid';
    const destHashes = new Set();
    for (const r of dest.prepare('SELECT content_hash FROM observations').iterate()) {
      if (r.content_hash != null) destHashes.add(String(r.content_hash));
    }
    // A hash the destination lacks verbatim but holds the same row under the
    // other content-hash version (hash.mjs) — counted apart, not missing.
    const alias = aliasIndexFor(dest, 'observations');
    const selCols = [...new Set(['content_hash', ...(alias ? aliasSelect(srcObsCols) : [])])];
    const absent = new Set(), aliasedHashes = new Set();
    for (const r of src.prepare(`SELECT ${obsIdCol} AS __src_id, ${selCols.join(', ')} FROM observations${hashWhere}`).iterate()) {
      if (skipObs && skipObs.has(r.__src_id)) continue;
      if (r.content_hash == null) continue;
      const h = String(r.content_hash);
      srcHashes.add(h);
      if (destHashes.has(h)) continue;
      if (alias && alias.has(r)) aliasedHashes.add(h); else absent.add(h);
    }
    let missing = 0;
    for (const h of absent) if (!aliasedHashes.has(h)) missing++;
    add(
      'observations: distinct content_hash carried over verbatim',
      missing === 0,
      `source ${srcHashes.size} distinct, destination ${destHashes.size} distinct, missing ${missing}` +
        `${aliasedHashes.size ? `, ${aliasedHashes.size} held under the other content-hash version` : ''}`
    );
  }

  // (e) FTS integrity + row parity.
  for (const t of ['observations', 'user_prompts', 'session_summaries']) {
    const fts = `${t}_fts`;
    if (!tableExists(dest, fts)) continue;
    let ok = true, detail = '';
    try {
      dest.exec(`INSERT INTO ${fts}(${fts}) VALUES('integrity-check')`);
    } catch (e) {
      ok = false;
      detail = 'integrity-check failed';
    }
    if (ok) {
      const rows = safeCount(dest, t);
      // External-content FTS: the docsize shadow table is the real index size.
      let indexed = null;
      if (tableExists(dest, `${fts}_docsize`)) indexed = safeCount(dest, `${fts}_docsize`);
      if (indexed !== null && indexed !== rows) {
        ok = false;
        detail = `FTS index holds ${indexed} rows, table holds ${rows}`;
      } else {
        detail = indexed === null ? 'integrity-check passed' : `integrity-check passed, ${indexed} rows indexed`;
      }
    }
    add(`${fts}: FTS integrity`, ok, detail);
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// ── main entry point ─────────────────────────────────────────────────────────

/**
 * Import a claude-mem DB into the native store.
 *
 * @param {object}   opts
 * @param {string}   [opts.source]  claude-mem DB path (default: paths.CLAUDE_MEM_DB, resolved by the caller)
 * @param {string}   [opts.dest]    native store path (default: store.storePath())
 * @param {boolean}  [opts.apply]   false (default) = dry-run, writes nothing at all
 * @param {number}   [opts.since]   only rows with epoch >= this (use import_state.last_epoch for incrementals)
 * @param {boolean}  [opts.resume]  continue from import_state's cursor (default true)
 * @param {boolean}  [opts.verify]  run verification after apply (default true)
 * @param {number}   [opts.batchSize] rows per transaction (default 1000)
 * @param {Function} [opts.log]
 * @returns {{ok:boolean, dryRun:boolean, source:string, dest:string, tables:Array, verification:object|null, notCarried:string[], lastEpoch:number|null, warnings:string[]}}
 */
export function importClaudeMem({
  source,
  dest,
  apply = false,
  since = null,
  resume = true,
  verify = true,
  batchSize = 1000,
  log = () => {},
  // false = merge rows only; leave the READY marker exactly as it is. Used by
  // sync/restore merging another device's snapshot into an already-live store,
  // where a marker flip would demote a healthy brain over a merge detail.
  touchReady = true,
  // Leave the brain's own headless runs behind (selfCaptureIds). Every caller
  // wants this; false exists for tests that need a byte-faithful copy.
  skipSelfCapture = true,
  // Leave test-fixture projects behind (testDataIds) — same reasoning.
  skipTestData = true,
} = {}) {
  const sourcePath = source;
  if (!sourcePath) throw new Error('importClaudeMem: source path is required');
  const destPath = dest || defaultStorePath();
  const warnings = [];

  const src = openSourceReadOnly(sourcePath);

  const present = TABLES.filter((t) => tableExists(src, t.name)).map((t) => t.name);
  const absent = TABLES.filter((t) => !tableExists(src, t.name)).map((t) => t.name);
  if (absent.length) {
    warnings.push(`source is missing table(s): ${absent.join(', ')} — those are skipped, the rest still import`);
  }
  if (!present.length) {
    src.close();
    throw new Error(
      `${sourcePath} has none of claude-mem's core tables (${TABLES.map((t) => t.name).join(', ')}). ` +
        `Refusing to run — point --source at a claude-mem database.`
    );
  }

  const skipIds = mergeSkips(
    skipSelfCapture ? selfCaptureIds(src, warnings) : {},
    skipTestData ? testDataIds(src, destPath, warnings) : {},
  );

  // ── dry run: touch nothing, not even to create the destination ─────────────
  if (!apply) {
    let destDb = null;
    if (existsSync(destPath)) {
      try {
        destDb = openDb(destPath, { readonly: true });
      } catch {
        warnings.push(`destination exists but could not be opened read-only for planning: ${destPath}`);
      }
    } else {
      warnings.push(`destination does not exist yet — it will be created on --apply: ${destPath}`);
      // Plan against an in-memory copy of the native schema so the dry run can
      // still report column intersection and constraint rejects. Nothing is
      // written to disk; the real destination is not created.
      destDb = new DatabaseSync(':memory:');
      ensureDestSchema(destDb);
    }
    const tables = TABLES.map((spec) => planTable(src, destDb, spec, { since, skip: skipIds[spec.name] }));
    if (destDb) destDb.close();
    src.close();
    const rejected = tables.reduce((n, t) => n + t.constraintRejects.reduce((m, r) => m + r.rows, 0), 0);
    if (rejected) {
      warnings.push(
        `${rejected} source row(s) would be REJECTED by the native schema's constraints — see the plan; ` +
          `they would not be imported. Report this before applying.`
      );
    }
    return {
      ok: rejected === 0,
      dryRun: true,
      source: sourcePath,
      dest: destPath,
      schemaFrom: null,
      tables,
      verification: null,
      notCarried: NOT_CARRIED,
      lastEpoch: null,
      warnings,
    };
  }

  // ── apply ─────────────────────────────────────────────────────────────────
  const destDir = dirname(destPath);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const destDb = openDb(destPath, { create: true });
  destDb.exec('PRAGMA foreign_keys = OFF');
  try { destDb.exec('PRAGMA journal_mode = WAL'); } catch { /* non-fatal */ }
  const schemaFrom = ensureDestSchema(destDb);

  const prior = resume ? readState(destDb, sourcePath) : null;
  const state = { counts: { version: 1, since: since ?? null, tables: {} } };
  // Only reuse cursors from a run with the same --since window; a different
  // window means a different row set, so restart (still idempotent, just slower).
  if (prior && prior.counts && prior.counts.tables && (prior.counts.since ?? null) === (since ?? null)) {
    state.counts.tables = prior.counts.tables;
  }

  const tables = [];
  try {
    for (const spec of TABLES) {
      const r = copyTable(src, destDb, spec, { since, batchSize, sourcePath, state, log, skip: skipIds[spec.name] });
      tables.push(r);
      if (r.skipped) {
        log(`  ⚠️  ${r.skipped}`);
        warnings.push(r.skipped);
      } else {
        log(`  ${spec.name}: +${r.inserted} inserted, ${r.alreadyPresent} already present, ${r.intraSourceDuplicates} duplicate key(s) in source` +
          (r.hashAliased ? ` (${r.hashAliased} matched under the other content-hash version)` : '') +
          (r.selfCaptureSkipped ? `, ${r.selfCaptureSkipped} self-capture row(s) left out` : '') +
          (r.testDataSkipped ? `, ${r.testDataSkipped} test-fixture row(s) left out` : ''));
        if (r.rejected) {
          const why = r.rejectReasons.length ? ` (${r.rejectReasons.join('; ')})` : '';
          log(`  ❌ ${spec.name}: ${r.rejected} row(s) REJECTED by the native schema and NOT imported${why}`);
          warnings.push(`${spec.name}: ${r.rejected} source row(s) were rejected by the native schema and NOT imported${why}`);
        }
      }
    }
    // Final state flush (marks every table done, records the high-water epoch).
    destDb.exec('BEGIN IMMEDIATE');
    writeState(destDb, sourcePath, state);
    destDb.exec('COMMIT');
  } catch (e) {
    src.close();
    destDb.close();
    throw new Error(
      `Import failed part-way: ${e.message}\n` +
        `  Nothing was lost — committed batches stay, and re-running resumes from import_state.`
    );
  }

  const upto = {};
  for (const [name, t] of Object.entries(state.counts.tables)) {
    if (t && t.maxEpoch != null) upto[name] = t.maxEpoch;
  }
  const verification = verify ? verifyImport(src, destDb, { since, upto, skipIds }) : null;

  src.close();
  destDb.close();

  const rejected = tables.reduce((n, t) => n + (t.rejected || 0), 0);
  // Distinct source rows that collided on a natural key and could not both be
  // represented. Verification reconciles on the natural key, so it structurally
  // cannot see this — it must be surfaced here or the loss is silent.
  const distinctLost = tables.reduce((n, t) => n + (t.distinctLost || 0), 0);
  const lostKeys = tables.flatMap((t) => t.lostKeys || []);
  const selfCaptureSkipped = tables.reduce((n, t) => n + (t.selfCaptureSkipped || 0), 0);
  const testDataSkipped = tables.reduce((n, t) => n + (t.testDataSkipped || 0), 0);
  const ok = (verification ? verification.ok : true) && rejected === 0 && distinctLost === 0;

  // Flip readers over to the native store ONLY once this import verified. Until
  // the marker exists, paths.mjs keeps MEMORY_DB pointed at claude-mem — so a
  // crashed or unverified import leaves the user on their working brain rather
  // than silently switching them to a partial one. A failed run also clears any
  // stale marker from a previous attempt.
  if (touchReady) {
    try {
      if (ok) markStoreReady(destPath, `imported from ${sourcePath}`);
      else clearStoreReady(destPath);
    } catch { /* never let marker bookkeeping fail an otherwise good import */ }
  }

  return {
    ok,
    dryRun: false,
    source: sourcePath,
    dest: destPath,
    schemaFrom,
    tables,
    rejected,
    distinctLost,
    lostKeys,
    selfCaptureSkipped,
    testDataSkipped,
    verification,
    notCarried: NOT_CARRIED,
    lastEpoch: highWaterEpoch(state.counts),
    warnings,
  };
}

// ── report ───────────────────────────────────────────────────────────────────
// Counts, table names and column names only — never row content (spec handoff rule).

export function formatReport(result) {
  const L = [];
  L.push(result.dryRun ? '🧠 import-claude-mem — DRY RUN (nothing written)' : '🧠 import-claude-mem — applied');
  L.push(`  source (read-only): ${result.source}`);
  L.push(`  destination:        ${result.dest}`);
  if (result.schemaFrom) L.push(`  schema from:        ${result.schemaFrom}`);
  L.push('');
  if (result.dryRun) {
    L.push('  Plan');
    L.push('  table              source  in dest  would insert  already present  dup keys');
    for (const t of result.tables) {
      if (t.skipped) { L.push(`  ${t.table.padEnd(18)} — ${t.skipped}`); continue; }
      L.push(
        `  ${t.table.padEnd(18)}${String(t.sourceRows).padStart(6)}${String(t.destRowsBefore).padStart(9)}` +
          `${String(t.projectedInserts).padStart(14)}${String(t.alreadyPresent).padStart(17)}${String(t.intraSourceDuplicates).padStart(10)}`
      );
      if (t.filteredBySince) L.push(`  ${''.padEnd(18)}(${t.filteredBySince} row(s) excluded by --since)`);
      if (t.selfCaptureSkipped) L.push(`  ${''.padEnd(18)}(${t.selfCaptureSkipped} self-capture row(s) left out — the brain's own runs)`);
      if (t.testDataSkipped) L.push(`  ${''.padEnd(18)}(${t.testDataSkipped} test-fixture row(s) left out — see brain clean --test-data)`);
      for (const r of t.constraintRejects) L.push(`  ❌ ${t.table}: ${r.reason} — those rows would NOT be imported`);
    }
    L.push('');
    L.push('  Re-run with --apply to write. Nothing has been changed.');
  } else {
    L.push('  Result');
    L.push('  table              scanned  inserted  already present  dup keys  rejected');
    for (const t of result.tables) {
      if (t.skipped) { L.push(`  ${t.table.padEnd(18)} — ${t.skipped}`); continue; }
      L.push(
        `  ${t.table.padEnd(18)}${String(t.sourceRows).padStart(7)}${String(t.inserted).padStart(10)}` +
          `${String(t.alreadyPresent).padStart(17)}${String(t.intraSourceDuplicates).padStart(10)}` +
          `${String(t.rejected || 0).padStart(10)}`
      );
      if (t.selfCaptureSkipped) L.push(`  ${''.padEnd(18)}(${t.selfCaptureSkipped} self-capture row(s) left out — the brain's own runs)`);
      if (t.testDataSkipped) L.push(`  ${''.padEnd(18)}(${t.testDataSkipped} test-fixture row(s) left out — see brain clean --test-data)`);
      for (const why of t.rejectReasons || []) L.push(`  ❌ ${t.table}: ${why}`);
    }
    if (result.rejected) {
      L.push('');
      L.push(`  ❌ ${result.rejected} SOURCE ROW(S) WERE NOT IMPORTED — the native schema rejected them.`);
      L.push('     Your claude-mem DB still holds them and is untouched. Report this rather than');
      L.push('     treating the import as complete.');
    }
  }
  if (result.distinctLost) {
    L.push('');
    L.push(`  ❌ ${result.distinctLost} source row(s) collided on a natural key with DIFFERENT content —`);
    L.push('     the destination cannot represent both, so content was lost. This import is NOT complete.');
    for (const k of (result.lostKeys || []).slice(0, 10)) L.push(`       ${k}`);
  }
  if (result.verification) {
    L.push('');
    L.push(result.verification.ok ? '  Verification: PASSED' : '  ❌ Verification: FAILED');
    for (const c of result.verification.checks) {
      L.push(`    ${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
    }
    if (!result.verification.ok) {
      L.push('');
      L.push('  ❌ THE IMPORT DID NOT VERIFY. Do not delete or stop using claude-mem.');
      L.push('     What to do:');
      L.push('       1. Re-run `brain import-claude-mem --apply` — it is idempotent and resumes; a');
      L.push('          transient failure usually clears on the second pass.');
      L.push('       2. If it still fails, re-run the dry run to see which table is short.');
      L.push('       3. Your claude-mem DB was opened read-only and is untouched — it remains the');
      L.push('          system of record until this verifies.');
    }
  }
  if (result.warnings.length) {
    L.push('');
    L.push('  Notes');
    for (const w of result.warnings) L.push(`    • ${w}`);
  }
  L.push('');
  L.push('  Not carried over by this import:');
  for (const n of result.notCarried) L.push(`    • ${n}`);
  L.push('');
  L.push('  claude-mem stays installed and untouched. After a successful import,');
  L.push('  run `brain scrub --audit` against the native store.');
  return L.join('\n');
}
