// Merge exported memory (memory/exports/**) into a local claude-mem.db.
// Used for multi-machine convergence: append rows that this machine is missing,
// deduped by each table's natural key. Requires an existing DB (schema present) —
// a brand-new machine gets its DB from the encrypted blob during `restore`, then
// this can merge in anything newer from the exports.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, tableExists } from './db.mjs';
import { MEMORY_DB, REPO_EXPORTS } from './paths.mjs';
import { scrubText } from './scrub.mjs';
import { dropSelfCaptureRows } from './selfcapture.mjs';
import { captureSkipper, readCleanedProjects } from './testdata.mjs';
import { LIFECYCLE_COLUMN_NAMES } from './store.mjs';
import { hashAliasIndex } from './hash.mjs';

// P5 (docs/specs/secret-scrubber.md §5.3): columns scrubbed on the way IN during a
// multi-machine merge. A machine running an older build (or, in a future
// shared-brain scenario, another user's export) must not reintroduce secrets that
// this machine already scrubbed out.
const SCRUB_COLUMNS = {
  observations: ['text', 'narrative', 'facts', 'title', 'subtitle', 'metadata'],
  user_prompts: ['prompt_text'],
  session_summaries: ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'],
  sdk_sessions: ['user_prompt'],
};

function scrubRow(table, row) {
  const cols = SCRUB_COLUMNS[table];
  if (!cols || !row) return row;
  let out = row;
  for (const c of cols) {
    if (typeof out[c] !== 'string' || !out[c]) continue;
    const { text } = scrubText(out[c]);
    if (text !== out[c]) { if (out === row) out = { ...row }; out[c] = text; }
  }
  return out;
}
function scrubRows(table, rows) {
  return rows.map((r) => scrubRow(table, r));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const txt = readFileSync(path, 'utf8').trim();
  if (!txt) return [];
  return txt.split('\n').map((l) => JSON.parse(l));
}

// Local-only lifecycle columns are never copied in: their ids belong to the
// exporting machine. Left out of the INSERT, they take this store's defaults
// (active) and this machine's own lifecycle pass decides.
const LOCAL_ONLY = new Set(LIFECYCLE_COLUMN_NAMES);
function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    .filter((c) => table !== 'observations' || !LOCAL_ONLY.has(c));
}

// Insert rows with INSERT OR IGNORE, letting the DB's unique indexes dedup.
function insertOrIgnore(db, table, rows) {
  if (!rows.length || !tableExists(db, table)) return 0;
  const cols = tableColumns(db, table).filter((c) => c !== 'id');
  const placeholders = cols.map(() => '?').join(',');
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`
  );
  let n = 0;
  for (const r of rows) {
    const vals = cols.map((c) => (r[c] === undefined ? null : r[c]));
    const info = stmt.run(...vals);
    n += info.changes;
  }
  return n;
}

// For tables without a unique index, dedup by an explicit natural key.
function insertIfAbsent(db, table, rows, keyCols) {
  if (!rows.length || !tableExists(db, table)) return 0;
  const cols = tableColumns(db, table).filter((c) => c !== 'id');
  const placeholders = cols.map(() => '?').join(',');
  const insert = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
  const where = keyCols.map((c) => `${c} IS ?`).join(' AND ');
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`);
  let n = 0;
  for (const r of rows) {
    if (exists.get(...keyCols.map((c) => r[c] ?? null))) continue;
    insert.run(...cols.map((c) => (r[c] === undefined ? null : r[c])));
    n++;
  }
  return n;
}

export function runImport({ dbPath = MEMORY_DB, exportsDir = REPO_EXPORTS, log = () => {} } = {}) {
  if (!existsSync(dbPath)) {
    throw new Error(`No local DB at ${dbPath}. Run "brain restore" first to seed it.`);
  }
  if (!existsSync(exportsDir)) {
    log('No exports directory — nothing to merge.');
    return { sessions: 0, observations: 0, summaries: 0, prompts: 0 };
  }
  const db = openDb(dbPath);
  db.exec('PRAGMA foreign_keys = OFF');

  const added = { sessions: 0, observations: 0, summaries: 0, prompts: 0 };
  // Test-fixture projects (testdata.mjs: auto patterns + names `brain clean
  // --test-data --apply` removed here) are never merged back in from exports.
  const isFixture = captureSkipper(readCleanedProjects(db));
  const projects = readdirSync(exportsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !isFixture(d.name));
  // An observation this store already holds under the other content-hash
  // version (hash.mjs: one machine ran `brain migrate-hash`, the other did not)
  // is the same memory — left out before the unique index ever sees it. Judged
  // on the row as exported, before the scrub below can change its text.
  const alias = tableExists(db, 'observations') ? hashAliasIndex(db, { byProject: false }) : null;
  const sessionHash = tableExists(db, 'observations')
    ? db.prepare('SELECT 1 AS x FROM observations WHERE memory_session_id IS ? AND content_hash IS ? LIMIT 1')
    : null;
  const notAliased = (rows) => (alias
    ? rows.filter((r) => sessionHash.get(r.memory_session_id ?? null, r.content_hash ?? null) || !alias.has(r))
    : rows);

  db.exec('BEGIN');
  try {
    for (const p of projects) {
      const dir = join(exportsDir, p.name);
      // The brain's own headless runs, captured on a machine without the
      // self-capture guard, must not come back here after `brain clean
      // --self-capture` removed them (selfcapture.mjs).
      const rows = dropSelfCaptureRows({
        sessions: readJsonl(join(dir, 'sessions.jsonl')),
        observations: readJsonl(join(dir, 'observations.jsonl')),
        summaries: readJsonl(join(dir, 'summaries.jsonl')),
        prompts: readJsonl(join(dir, 'prompts.jsonl')),
      });
      added.sessions += insertOrIgnore(db, 'sdk_sessions', scrubRows('sdk_sessions', rows.sessions));
      const obs = notAliased(rows.observations);
      added.observations += insertOrIgnore(db, 'observations', scrubRows('observations', obs));
      if (alias) for (const r of obs) alias.note(r);
      added.summaries += insertIfAbsent(
        db,
        'session_summaries',
        scrubRows('session_summaries', rows.summaries),
        ['memory_session_id', 'prompt_number', 'created_at_epoch']
      );
      added.prompts += insertIfAbsent(
        db,
        'user_prompts',
        scrubRows('user_prompts', rows.prompts),
        ['content_session_id', 'prompt_number']
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.close();
    throw e;
  }
  db.close();
  log(
    `Merged: +${added.observations} observations, +${added.summaries} summaries, ` +
      `+${added.prompts} prompts, +${added.sessions} sessions`
  );
  return added;
}
