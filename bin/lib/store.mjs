// Native memory store schema + accessor — bin/lib/store.mjs
//
// This is the schema module for `~/.claude-brain/brain.db`, the native store
// that lets this project stop depending on claude-mem owning the database.
// It defines the four core tables (column-compatible with what the rest of
// this repo already reads from claude-mem's DB — see docs/specs/native-capture.md
// §2), FTS5 shadow tables with full insert/update/delete triggers on all
// three text tables (closing claude-mem's known session_summaries_fts
// no-trigger gap), and two small native bookkeeping tables.
//
// Zero dependencies beyond node:sqlite (matches bin/lib/db.mjs's style).
// Importing this module has NO side effects: it never touches the
// filesystem or creates a database until openStore()/ensureSchema() are
// called explicitly.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NATIVE_DB_PATH } from './paths.mjs';
import { assertWritableInThisEnv } from './testguard.mjs';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

// Resolve the store path: explicit argument > BRAIN_NATIVE_DB_PATH env
// override (used by evals/scratchpad verification, never the real dir) >
// the configured default (~/.claude-brain/brain.db, or config.sources.memoryDb
// if set — see paths.mjs).
export function storePath(overridePath) {
  return overridePath || process.env.BRAIN_NATIVE_DB_PATH || NATIVE_DB_PATH;
}

export function storeExists(overridePath) {
  return existsSync(storePath(overridePath));
}

// ── readiness ───────────────────────────────────────────────────────────────
// The store file existing is NOT the same as the store being usable: a zero-byte
// file, or one left half-populated by a crashed import, both pass existsSync.
// paths.mjs gates MEMORY_DB on this marker instead, so readers keep using
// claude-mem until an import has actually verified. Only mark ready after
// verification passes — never on a partial or unverified write.

export function readyMarkerPath(overridePath) {
  return join(dirname(storePath(overridePath)), 'READY');
}

export function storeReady(overridePath) {
  return storeExists(overridePath) && existsSync(readyMarkerPath(overridePath));
}

export function markStoreReady(overridePath, note = '') {
  const p = readyMarkerPath(overridePath);
  assertWritableInThisEnv(p);
  writeFileSync(p, `${new Date().toISOString()}\n${note}\n`, { mode: 0o600 });
  return p;
}

export function clearStoreReady(overridePath) {
  const p = readyMarkerPath(overridePath);
  if (existsSync(p)) { rmSync(p); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

// Open (creating on first write-mode call) the native store and ensure its
// schema exists. Read-only opens never create the file or its parent dir —
// they throw if absent, matching openDb()'s contract in db.mjs.
export function openStore({ readonly = false, path } = {}) {
  const p = storePath(path);
  if (!readonly) {
    assertWritableInThisEnv(p); // a test run never writes the real store
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else if (!existsSync(p)) {
    throw new Error(`Native store not found: ${p}`);
  }
  const db = new DatabaseSync(p, { readOnly: readonly, open: true });
  if (!readonly) {
    db.exec('PRAGMA journal_mode = WAL');
    ensureSchema(db);
  }
  return db;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// All statements use IF NOT EXISTS, so calling this repeatedly (every
// openStore() write-mode call, every importer run) is a no-op past the
// first call. Safe to call on an already-populated store.
export function ensureSchema(db) {
  db.exec(`
    -- sdk_sessions --------------------------------------------------------
    CREATE TABLE IF NOT EXISTS sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT 'claude',
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed')),
      custom_title TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
    CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
    CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
    CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content
      ON sdk_sessions(platform_source, content_session_id);

    -- observations ---------------------------------------------------------
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      content_hash TEXT,
      generated_by_model TEXT,
      relevance_count INTEGER DEFAULT 0,
      merged_into_project TEXT,
      agent_type TEXT,
      agent_id TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
    CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
    CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
    CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_session_hash
      ON observations(memory_session_id, content_hash);

    -- user_prompts -----------------------------------------------------------
    CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER,
      content_session_id TEXT NOT NULL,
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id);
    CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id);
    CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number);
    CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number);
    CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number);
    -- 3-part key: the live claude-mem DB has 10 duplicate (content_session_id,
    -- prompt_number) pairs (measured, see spec §2/§3.4) — a 2-part key would
    -- silently drop real rows on import. created_at_epoch disambiguates them.
    CREATE UNIQUE INDEX IF NOT EXISTS ux_user_prompts_session_prompt_created
      ON user_prompts(content_session_id, prompt_number, created_at_epoch);

    -- session_summaries -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      files_read TEXT,
      files_edited TEXT,
      notes TEXT,
      prompt_number INTEGER,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
    CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
    CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_session_summaries_session_prompt_created
      ON session_summaries(memory_session_id, prompt_number, created_at_epoch);

    -- Native bookkeeping (not present in claude-mem) --------------------------
    CREATE TABLE IF NOT EXISTS import_state (
      source_path TEXT PRIMARY KEY,
      last_epoch INTEGER,
      last_run_at TEXT,
      counts_json TEXT
    );

    CREATE TABLE IF NOT EXISTS capture_state (
      transcript_path TEXT PRIMARY KEY,
      mtime INTEGER,
      bytes INTEGER,
      session_id TEXT,
      status TEXT
    );

    -- FTS5 shadow tables, all three with full triggers -----------------------
    -- (claude-mem's session_summaries_fts ships with NO triggers — a real bug
    -- that leaves scrubbed plaintext searchable in the shadow table. Fixed
    -- here: every one of the three text tables gets insert/update/delete
    -- triggers.)
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title, subtitle, narrative, text, facts, concepts,
      content='observations', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
      VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
    END;
    CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
      VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
    END;
    CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
      VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
      VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS user_prompts_fts USING fts5(
      prompt_text,
      content='user_prompts', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS user_prompts_ai AFTER INSERT ON user_prompts BEGIN
      INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
    END;
    CREATE TRIGGER IF NOT EXISTS user_prompts_ad AFTER DELETE ON user_prompts BEGIN
      INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text) VALUES('delete', old.id, old.prompt_text);
    END;
    CREATE TRIGGER IF NOT EXISTS user_prompts_au AFTER UPDATE ON user_prompts BEGIN
      INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text) VALUES('delete', old.id, old.prompt_text);
      INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
      request, investigated, learned, completed, next_steps, notes,
      content='session_summaries', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
      VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
    END;
    CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
      VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
    END;
    CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
      VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
      INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
      VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
    END;
  `);
  // Lifecycle columns are added here only where that costs nothing: a new,
  // empty store, or one already (partly) migrated, where this just fills gaps.
  // A populated store that was never migrated is left alone — every sync and
  // import runs ensureSchema, and silently ALTERing a 40k-row brain with no
  // backup is exactly what must not happen. lifecycle.mjs openForLifecycle()
  // migrates it, after a verified backup, on `brain lifecycle --apply` or the
  // first edit in the control panel.
  const populated = db.prepare('SELECT 1 FROM observations LIMIT 1').get();
  const migrated = db.prepare('PRAGMA table_info(observations)').all()
    .some((c) => LIFECYCLE_COLUMN_NAMES.includes(c.name));
  if (!populated || migrated) ensureLifecycleSchema(db);
}

// ---------------------------------------------------------------------------
// Lifecycle migration (additive)
// ---------------------------------------------------------------------------

// Memory lifecycle columns on observations (see lifecycle.mjs for the rules).
// Local-only bookkeeping: superseded_by holds a LOCAL row id, which means
// nothing on another machine, so export.mjs strips these and import.mjs never
// copies them — each machine recomputes its own lifecycle from the rows.
// NULL status reads as 'active' everywhere (an INSERT that names every column,
// like the multi-machine merge, can write NULL over the DEFAULT).
// The control panel's curation (curate.mjs) rides on the same columns: a
// soft delete is status 'deleted' (a manual status, so no automatic pass ever
// revives it), status_prev remembers what Undo restores, and pinned_at marks
// rows that recall/context/startup always rank. All local, like the rest.
// Dedupe (dedupe.mjs) does too: an effectively-identical copy of another live
// memory gets status 'duplicate' (hidden like 'deleted', content untouched),
// superseded_by = the row it duplicates, status_prev = what --undo restores.
export const LIFECYCLE_COLUMNS = [
  ['status', "TEXT DEFAULT 'active'"],   // active | superseded | contested | stale | deleted | duplicate
  ['superseded_by', 'INTEGER'],          // observations.id of the newer row (duplicate: the row it copies)
  ['status_reason', 'TEXT'],             // why; 'manual…' = user override, never auto-changed
  ['status_at', 'INTEGER'],              // epoch ms of the last status change
  ['status_prev', 'TEXT'],               // JSON {status, reason, at} before a soft delete (for Undo)
  ['pinned_at', 'INTEGER'],              // epoch ms the user pinned it; NULL = not pinned
];
export const LIFECYCLE_COLUMN_NAMES = LIFECYCLE_COLUMNS.map(([c]) => c);

// Idempotent and data-preserving: only ADD COLUMN for what is missing (no
// table rebuild, no rewrite of existing rows), plus one IF NOT EXISTS index.
// Safe on a live store, on a store created by an older build, and on repeat
// calls. Returns the columns it added (empty past the first run).
export function ensureLifecycleSchema(db) {
  const have = new Set(db.prepare('PRAGMA table_info(observations)').all().map((c) => c.name));
  if (!have.size) return [];
  const added = [];
  for (const [col, decl] of LIFECYCLE_COLUMNS) {
    if (have.has(col)) continue;
    db.exec(`ALTER TABLE observations ADD COLUMN ${col} ${decl}`);
    added.push(col);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_observations_status ON observations(status)');
  return added;
}
