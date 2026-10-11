// The journal behind the opt-in bulk commands (`brain recapture`, `brain clean
// --cursor-projects`; recapture.mjs): one row per value they overwrite, old and
// new, with the run id, so --undo can put it back.
//
// The journal holds copies of row content (a row's text, title, facts, narrative,
// metadata), so it is held to the same standards as the rows themselves:
//   - `brain scrub` covers it (scrub.mjs SCRUB_SCOPE): a secret scrubbed out of
//     the rows is scrubbed out of the journal, and --undo can never write the
//     unredacted value back;
//   - when a row is hard-deleted (clean --test-data / --self-capture) or deleted
//     in the panel, its journal entries go with it (pruneJournal).
import { tableExists } from './db.mjs';

export const LOG_TABLE = 'bulk_change_log';

export function ensureLog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    target_key TEXT NOT NULL,
    old_values TEXT,
    new_values TEXT,
    applied_at INTEGER NOT NULL,
    undone_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_${LOG_TABLE}_run ON ${LOG_TABLE}(kind, run_id)`);
}

// Journal targets that name a row of another table, and how to find it.
const ROW_TARGETS = [
  { target: 'observations', table: 'observations', col: 'id', num: true },
  { target: 'observation_status', table: 'observations', col: 'id', num: true },
  { target: 'sdk_sessions', table: 'sdk_sessions', col: 'memory_session_id', num: false },
  { target: 'session_summaries', table: 'session_summaries', col: 'id', num: true },
  { target: 'capture_state', table: 'capture_state', col: 'transcript_path', num: false },
];

/**
 * Drop the journal entries whose row no longer exists (hard-deleted). Never
 * throws and never touches a row that is still there. → entries removed.
 */
export function pruneJournal(db) {
  try {
    if (!tableExists(db, LOG_TABLE)) return 0;
    let n = 0;
    for (const { target, table, col, num } of ROW_TARGETS) {
      if (!tableExists(db, table)) continue;
      const key = num ? `CAST(l.target_key AS INTEGER)` : `l.target_key`;
      n += db.prepare(
        `DELETE FROM ${LOG_TABLE} WHERE id IN (
           SELECT l.id FROM ${LOG_TABLE} l WHERE l.target = ?
             AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.${col} = ${key}))`
      ).run(target).changes;
    }
    return n;
  } catch { return 0; }
}

/**
 * A row deleted in the panel (soft delete): its journalled content goes too —
 * the deleted memory must not stay readable through the journal. (--undo skips
 * deleted rows anyway.)
 */
export function dropJournalFor(db, observationId) {
  try {
    if (!tableExists(db, LOG_TABLE)) return 0;
    return db.prepare(
      `DELETE FROM ${LOG_TABLE} WHERE target IN ('observations','observation_status') AND target_key = ?`
    ).run(String(observationId)).changes;
  } catch { return 0; }
}
