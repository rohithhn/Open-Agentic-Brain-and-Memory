// Opt-in bulk changes to EXISTING rows that ingest used to make on its own.
//
// Automatic ingest only affects new data (ingest.mjs). Two things it once did to
// rows already in the store now live here, behind a command the operator runs:
//
//   brain recapture            sessions that GREW after they were captured: the
//                              capture row's raw `text` follows the transcript and
//                              the session is queued for (re-)distillation.
//   brain clean --cursor-projects
//                              Cursor sessions captured under the placeholder
//                              project 'cursor' whose folder is now known are
//                              filed under that project.
//
// Same contract as the other `brain clean` modes: dry-run by default (read-only
// open, numbers and ids only — never row content); --apply makes a verified
// VACUUM INTO backup first and aborts, changing nothing, if it does not verify.
//
// Unlike a delete, these are undoable without the backup: every value --apply
// overwrites is written to the `bulk_change_log` table (old and new, per row, with
// the run id) in the same transaction as the change, and --undo puts the old
// values back. For recapture that includes the earlier DISTILLATION — the
// distiller rewrites a re-queued row in place, so its title/facts/narrative/
// provenance are journalled before that can happen — and the distill/ingest
// bookkeeping rows. A row changed again since (hand-edited in the panel) is not
// restored over the person's edit.
//
// A raw capture row `brain clean --dupes` hid as a copy of another capture comes
// back into view when its transcript grew (it is its own transcript again), and
// the rows hidden as copies of a row that grew are re-checked (dedupe.mjs
// unmarkDuplicate / recheckCopiesOf — what ingest used to do on its own). Every
// status / superseded_by / relevance change that makes is journalled too
// (target 'observation_status') and --undo reverses it.
//
// --undo is compare-and-set: a row is put back only if it still holds exactly the
// values this run wrote. A row changed since (hand-edited, scrubbed, re-distilled
// from the raw state, deleted) is left as it is. --run <id> undoes one run.
// The journal is covered by `brain scrub` and pruned with the rows it describes
// (bulklog.mjs), so it never keeps content the store has removed or redacted.
//
// Rows that are not safe to change in bulk are skipped and counted: hand-edited
// rows, deleted rows, rows claude-mem wrote.
import { openDb, tableExists } from './db.mjs';
import { existsSync } from 'node:fs';
import { verifiedBackup } from './clean.mjs';
import { isForeignStore } from './lifecycle.mjs';
import { parsedItems, CURSOR_PROJECT, ingestStateKey, regrownStateKey } from './ingest.mjs';
import { stateKey as distillStateKey, PROVENANCE_PREFIX } from './distiller.mjs';
import { isEdited } from './curate.mjs';
import { contentHash } from './hash.mjs';
import { isAutoTestDataProject } from './testdata.mjs';
import { unmarkDuplicate, recheckCopiesOf, isDedupeReason, normText, DUPLICATE } from './dedupe.mjs';
import { LOG_TABLE, ensureLog } from './bulklog.mjs';

export { LOG_TABLE };
export const KIND_RECAPTURE = 'recapture';
export const KIND_CURSOR = 'cursor-projects';
const RECAPTURE_TOOLS = ['claude', 'codex', 'gemini', 'antigravity', 'cursor', 'kilo'];

const total = (db) => (tableExists(db, 'observations') ? db.prepare('SELECT COUNT(*) n FROM observations').get().n : 0);
const colsOf = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

const newRunId = (now) => `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;

// Hidden rows: a row `status` hides (deleted / duplicate), and a row other rows
// were hidden as copies of. (Used by the cursor relabel, which leaves them be.)
function hiddenProbe(db) {
  const cols = colsOf(db, 'observations');
  const hasStatus = cols.has('status');
  const copies = hasStatus && cols.has('superseded_by')
    ? db.prepare(`SELECT 1 FROM observations WHERE superseded_by = ? AND status = 'duplicate' LIMIT 1`)
    : null;
  return (id, status) => (hasStatus && (status === 'deleted' || status === 'duplicate')) || !!(copies && copies.get(id));
}

// ── brain recapture ──────────────────────────────────────────────────────────

// The session's capture row: the distiller's upgrade of it first (at most one,
// it upgrades in place), else the raw row ingest wrote. Same as ingest.mjs.
function captureRowFinder(db) {
  const cols = colsOf(db, 'observations');
  return db.prepare(
    `SELECT id, text, project, generated_by_model AS gbm${cols.has('superseded_by') ? ', superseded_by' : ', NULL AS superseded_by'}${cols.has('status_reason') ? ', status_reason' : ', NULL AS status_reason'}${cols.has('status') ? ', status' : ', NULL AS status'}${cols.has('metadata') ? ', metadata' : ', NULL AS metadata'}
       FROM observations
      WHERE memory_session_id = ?
        AND ((type = 'session' AND COALESCE(generated_by_model, ?) = ?)
             OR generated_by_model LIKE '${PROVENANCE_PREFIX}%')
      ORDER BY (generated_by_model LIKE '${PROVENANCE_PREFIX}%') DESC, id
      LIMIT 1`
  );
}

/**
 * Read-only plan: the sessions whose transcript has grown (pure append: the
 * stored text is a strict prefix of the new one) since their capture row was
 * written, and what is left alone. `items` are parsed sessions (ingest.parsedItems).
 */
export function planRecapture(db, items) {
  const find = captureRowFinder(db);
  const cols = colsOf(db, 'observations');
  const lifecycle = cols.has('superseded_by') && cols.has('status');
  const copiesOf = lifecycle
    ? db.prepare(`SELECT COUNT(*) n FROM observations WHERE superseded_by = ? AND status = '${DUPLICATE}'`)
    : null;
  const copyTexts = lifecycle
    ? db.prepare(`SELECT text FROM observations WHERE superseded_by = ? AND status = '${DUPLICATE}'`)
    : null;
  const survivor = lifecycle ? db.prepare('SELECT text, project, status FROM observations WHERE id = ?') : null;
  const hasState = tableExists(db, 'capture_state');
  const stateMtime = hasState ? db.prepare('SELECT mtime FROM capture_state WHERE transcript_path = ?') : null;
  const plan = { candidates: [], skipped: { edited: 0, deleted: 0, notAppend: 0 }, scanned: 0, unchanged: 0, noRow: 0 };
  for (const { tool, it } of items) {
    plan.scanned++;
    const mem = `${tool}:${it.sid}`;
    const row = find.get(mem, tool, tool);
    if (!row) { plan.noRow++; continue; }
    const text = row.text || '';
    const kind = String(row.gbm || '').startsWith(PROVENANCE_PREFIX) ? 'distilled' : 'raw';
    const copies = copiesOf ? copiesOf.get(row.id).n : 0;
    const base = { id: row.id, mem, tool, it, project: row.project, kind, copies };
    if (text === it.transcript) {
      // The text is already current — ingest followed it (raw text only, see
      // ingest.mjs). What is still open is what ingest never does itself:
      if (row.status === 'deleted' || isEdited(row.metadata)) { plan.unchanged++; continue; }
      // a distillation older than the grown text: a fresh one is on offer.
      if (kind === 'distilled' && hasState) {
        const re = stateMtime.get(regrownStateKey(mem)), ds = stateMtime.get(distillStateKey(mem));
        if (re && ds && Number(re.mtime) > Number(ds.mtime)) {
          plan.candidates.push({ ...base, oldLen: text.length, newLen: text.length, unhide: false, textSame: true });
          continue;
        }
      }
      if (kind === 'raw' && lifecycle) {
        // a copy that grew into its own memory comes back into view…
        let unhide = false, driftCopies = 0;
        if (row.status === DUPLICATE && isDedupeReason(row.status_reason)) {
          const surv = row.superseded_by != null ? survivor.get(row.superseded_by) : null;
          unhide = !!surv && surv.status !== 'deleted' && normText(surv.text) !== normText(text);
        }
        // …and copies of a row that grew are re-checked.
        if (copies) driftCopies = copyTexts.all(row.id).some((c) => normText(c.text) !== normText(text)) ? copies : 0;
        if (unhide || driftCopies) {
          plan.candidates.push({ ...base, oldLen: text.length, newLen: text.length, unhide, copies: driftCopies, textSame: true });
          continue;
        }
      }
      plan.unchanged++;
      continue;
    }
    if (!(it.transcript.length > text.length && it.transcript.startsWith(text))) { plan.skipped.notAppend++; continue; }
    if (isEdited(row.metadata)) { plan.skipped.edited++; continue; }
    if (row.status === 'deleted') { plan.skipped.deleted++; continue; }
    plan.candidates.push({
      ...base,
      oldLen: text.length, newLen: it.transcript.length,
      // A raw capture hidden as a duplicate is its own transcript again: shown.
      unhide: kind === 'raw' && row.status === DUPLICATE,
    });
  }
  return plan;
}

const OBS_COLS = ['type', 'title', 'subtitle', 'facts', 'narrative', 'concepts', 'content_hash', 'generated_by_model', 'metadata', 'text'];

function summarizeRecapture(plan, observationsTotal) {
  const byTool = {};
  for (const c of plan.candidates) {
    const t = (byTool[c.tool] ||= { raw: 0, distilled: 0 });
    t[c.kind]++;
  }
  return {
    observationsTotal,
    scanned: plan.scanned, unchanged: plan.unchanged, noRow: plan.noRow,
    grown: plan.candidates.length,
    raw: plan.candidates.filter((c) => c.kind === 'raw').length,
    distilled: plan.candidates.filter((c) => c.kind === 'distilled').length,
    // Text already current (ingest followed the growth): only the distillation /
    // visibility side is left to do.
    textCurrent: plan.candidates.filter((c) => c.textSame).length,
    unhide: plan.candidates.filter((c) => c.unhide).length,
    withCopies: plan.candidates.filter((c) => c.copies).length,
    copiesRechecked: plan.candidates.reduce((a, c) => a + c.copies, 0),
    byTool,
    skipped: plan.skipped,
    sample: plan.candidates.slice(0, 8).map((c) => ({ id: c.id, session: c.mem, kind: c.kind, from: c.oldLen, to: c.newLen, project: c.project })),
  };
}

function gatherItems(tools, itemsOverride) {
  if (itemsOverride) return itemsOverride;
  const out = [];
  for (const tool of tools) {
    try {
      for (const it of parsedItems(tool)) out.push({ tool, it });
    } catch { /* an unreadable tool never stops the plan */ }
  }
  return out;
}

function logRows(db, kind, runId, rows, now) {
  const ins = db.prepare(`INSERT INTO ${LOG_TABLE} (run_id, kind, target, target_key, old_values, new_values, applied_at) VALUES (?,?,?,?,?,?,?)`);
  for (const r of rows) ins.run(runId, kind, r.target, String(r.key), r.old == null ? null : JSON.stringify(r.old), r.new == null ? null : JSON.stringify(r.new), now);
}

const stateRow = (db, key) => db.prepare('SELECT transcript_path, mtime, bytes, session_id, status FROM capture_state WHERE transcript_path = ?').get(key) || null;

// Lifecycle columns unmarkDuplicate / recheckCopiesOf write (status, the pointer
// to the survivor, why/when, and the relevance a copy added to its survivor).
const LIFECYCLE_COLS = ['status', 'superseded_by', 'status_reason', 'status_at', 'status_prev', 'relevance_count'];

// A TEMP trigger records the first-seen old values of every observation whose
// lifecycle columns change while it is installed, so the changes the dedupe
// helpers make (to this row, to its copies, and to the rows the copies are
// folded into) are all journalled without re-implementing them. TEMP objects
// live in the connection only: nothing is added to the store.
function lifecycleRecorder(db) {
  const cols = LIFECYCLE_COLS.filter((c) => colsOf(db, 'observations').has(c));
  if (!cols.length) return null;
  db.exec(`DROP TRIGGER IF EXISTS temp._recapture_lc_t; DROP TABLE IF EXISTS temp._recapture_lc;
    CREATE TEMP TABLE _recapture_lc (id INTEGER PRIMARY KEY, ${cols.join(', ')});
    CREATE TEMP TRIGGER _recapture_lc_t BEFORE UPDATE OF ${cols.join(', ')} ON main.observations
    BEGIN INSERT OR IGNORE INTO _recapture_lc (id, ${cols.join(', ')}) VALUES (OLD.id, ${cols.map((c) => 'OLD.' + c).join(', ')}); END`);
  const cur = db.prepare(`SELECT ${cols.join(', ')} FROM observations WHERE id = ?`);
  return {
    cols,
    // Journal rows for what changed since the last call; `obs` ties them to the
    // recaptured row (undo restores them only together).
    drain(obs) {
      const out = [];
      for (const old of db.prepare('SELECT * FROM _recapture_lc ORDER BY id').all()) {
        const { id, ...oldVals } = old;
        const now = cur.get(id);
        if (!now || cols.every((c) => (now[c] ?? null) === (oldVals[c] ?? null))) continue;
        out.push({ target: 'observation_status', key: id, old: { ...oldVals }, new: { ...now, _obs: obs } });
      }
      db.exec('DELETE FROM _recapture_lc');
      return out;
    },
    close() { try { db.exec('DROP TRIGGER IF EXISTS temp._recapture_lc_t; DROP TABLE IF EXISTS temp._recapture_lc'); } catch {} },
  };
}

function applyRecapture(db, plan, { now, batchSize }) {
  ensureLog(db);
  const runId = newRunId(now);
  const get = db.prepare(`SELECT ${OBS_COLS.join(', ')} FROM observations WHERE id = ?`);
  const updRaw = db.prepare(`UPDATE observations SET text = ?, narrative = ?, title = ?, content_hash = ? WHERE id = ? AND COALESCE(text, '') = ?`);
  const updText = db.prepare(`UPDATE observations SET text = ? WHERE id = ? AND COALESCE(text, '') = ?`);
  const setState = db.prepare(
    `INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status) VALUES (?,?,?,?,?)
     ON CONFLICT(transcript_path) DO UPDATE SET mtime = excluded.mtime, bytes = excluded.bytes, status = excluded.status`
  );
  const applied = { raw: 0, distilled: 0, lost: 0, unhidden: 0, copiesChanged: 0 };
  const lc = lifecycleRecorder(db);
  try {
    for (let i = 0; i < plan.candidates.length; i += batchSize) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const c of plan.candidates.slice(i, i + batchSize)) {
          const old = get.get(c.id);
          if (!old) { applied.lost++; continue; }
          const text = c.it.transcript;
          const fresh = { text };
          let res;
          if (c.kind === 'raw' && !c.textSame) {
            const h = contentHash(text);
            Object.assign(fresh, { narrative: text, title: c.it.title, content_hash: h });
            try { res = updRaw.run(text, text, c.it.title, h, c.id, old.text || ''); }
            catch { applied.lost++; continue; } // ux_observations_session_hash: leave the row as it is
          } else {
            res = updText.run(text, c.id, old.text || '');
          }
          if (res.changes !== 1) { applied.lost++; continue; } // changed under us: leave it
          const dKey = distillStateKey(c.mem), iKey = ingestStateKey(c.mem);
          const oldD = stateRow(db, dKey), oldI = stateRow(db, iKey);
          const size = Number.isFinite(c.it.size) ? c.it.size : text.length;
          setState.run(dKey, now, 0, c.mem, 'pending');
          setState.run(iKey, now, size, c.mem, 'captured');
          // The lifecycle side (see the header): a raw copy hidden as a duplicate
          // is shown again; the copies of this row are re-checked.
          let status = [];
          if (lc) {
            if (c.unhide && unmarkDuplicate(db, c.id, { now })) applied.unhidden++;
            if (c.copies || c.unhide) recheckCopiesOf(db, c.id, { now });
            status = lc.drain(c.id);
            applied.copiesChanged += status.filter((r) => r.key !== c.id).length;
          }
          logRows(db, KIND_RECAPTURE, runId, [
            { target: 'observations', key: c.id, old: { ...old }, new: fresh },
            { target: 'capture_state', key: dKey, old: oldD, new: { ...stateRow(db, dKey), _obs: c.id } },
            { target: 'capture_state', key: iKey, old: oldI, new: { ...stateRow(db, iKey), _obs: c.id } },
            ...status,
          ], now);
          applied[c.kind]++;
        }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    }
  } finally { if (lc) lc.close(); }
  return { runId, applied };
}

// ── brain clean --cursor-projects ────────────────────────────────────────────

/**
 * Read-only plan: existing sessions filed under the placeholder 'cursor' whose
 * folder (hence project) the Cursor parser now resolves. Rows moved: the session
 * row, its observations and its summaries still carrying the placeholder.
 * Skipped: hand-edited observations, hidden ones, and rows that carry any other
 * project (set by hand).
 */
export function planCursorProjects(db, items) {
  const hidden = hiddenProbe(db);
  const sess = db.prepare('SELECT 1 FROM sdk_sessions WHERE memory_session_id = ? AND project = ?');
  const ocols = colsOf(db, 'observations');
  const obs = db.prepare(`SELECT id, ${ocols.has('metadata') ? 'metadata' : 'NULL AS metadata'}, ${ocols.has('status') ? 'status' : 'NULL AS status'} FROM observations WHERE memory_session_id = ? AND project = ?`);
  const sums = tableExists(db, 'session_summaries') ? db.prepare('SELECT id FROM session_summaries WHERE memory_session_id = ? AND project = ?') : null;
  const plan = { moves: [], skipped: { edited: 0, hidden: 0 }, scanned: 0 };
  for (const { tool, it } of items) {
    if (tool !== 'cursor') continue;
    plan.scanned++;
    const project = it.project;
    if (!project || project === CURSOR_PROJECT || isAutoTestDataProject(project)) continue;
    const mem = `cursor:${it.sid}`;
    const hasSession = !!sess.get(mem, CURSOR_PROJECT);
    const obsRows = [];
    for (const r of obs.all(mem, CURSOR_PROJECT)) {
      if (isEdited(r.metadata)) { plan.skipped.edited++; continue; }
      if (hidden(r.id, r.status)) { plan.skipped.hidden++; continue; }
      obsRows.push(r.id);
    }
    const sumRows = sums ? sums.all(mem, CURSOR_PROJECT).map((r) => r.id) : [];
    if (!hasSession && !obsRows.length && !sumRows.length) continue;
    plan.moves.push({ mem, project, session: hasSession, obs: obsRows, summaries: sumRows });
  }
  return plan;
}

function summarizeCursor(plan, observationsTotal) {
  const byProject = new Map();
  let sessions = 0, observations = 0, summaries = 0;
  for (const m of plan.moves) {
    sessions += m.session ? 1 : 0; observations += m.obs.length; summaries += m.summaries.length;
    const p = byProject.get(m.project) || { project: m.project, sessions: 0, observations: 0 };
    p.sessions += m.session ? 1 : 0; p.observations += m.obs.length;
    byProject.set(m.project, p);
  }
  return {
    observationsTotal, scanned: plan.scanned, sessions, observations, summaries,
    byProject: [...byProject.values()].sort((a, b) => b.sessions - a.sessions),
    skipped: plan.skipped,
  };
}

function applyCursorProjects(db, plan, { now, batchSize }) {
  ensureLog(db);
  const runId = newRunId(now);
  const updSession = db.prepare('UPDATE sdk_sessions SET project = ? WHERE memory_session_id = ? AND project = ?');
  const updObs = db.prepare('UPDATE observations SET project = ? WHERE id = ? AND project = ?');
  const updSum = db.prepare('UPDATE session_summaries SET project = ? WHERE id = ? AND project = ?');
  const applied = { sessions: 0, observations: 0, summaries: 0 };
  for (let i = 0; i < plan.moves.length; i += batchSize) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of plan.moves.slice(i, i + batchSize)) {
        const rows = [];
        if (m.session && updSession.run(m.project, m.mem, CURSOR_PROJECT).changes) {
          rows.push({ target: 'sdk_sessions', key: m.mem, old: { project: CURSOR_PROJECT }, new: { project: m.project } });
          applied.sessions++;
        }
        for (const id of m.obs) {
          if (updObs.run(m.project, id, CURSOR_PROJECT).changes) {
            rows.push({ target: 'observations', key: id, old: { project: CURSOR_PROJECT }, new: { project: m.project } });
            applied.observations++;
          }
        }
        for (const id of m.summaries) {
          if (updSum.run(m.project, id, CURSOR_PROJECT).changes) {
            rows.push({ target: 'session_summaries', key: id, old: { project: CURSOR_PROJECT }, new: { project: m.project } });
            applied.summaries++;
          }
        }
        logRows(db, KIND_CURSOR, runId, rows, now);
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  }
  return { runId, applied };
}

// ── undo (both kinds) ────────────────────────────────────────────────────────

function pendingLog(db, kind, runId = null) {
  if (!tableExists(db, LOG_TABLE)) return [];
  return runId
    ? db.prepare(`SELECT * FROM ${LOG_TABLE} WHERE kind = ? AND run_id = ? AND undone_at IS NULL ORDER BY id DESC`).all(kind, runId)
    : db.prepare(`SELECT * FROM ${LOG_TABLE} WHERE kind = ? AND undone_at IS NULL ORDER BY id DESC`).all(kind);
}

function undoSummary(rows) {
  const runs = [...new Set(rows.map((r) => r.run_id))];
  const by = {};
  for (const r of rows) by[r.target] = (by[r.target] || 0) + 1;
  return { runs: runs.length, runIds: runs, entries: rows.length, byTarget: by };
}

const same = (a, b) => (a ?? null) === (b ?? null);

// Undo order: the observation rows first (each is compare-and-set), then the
// bookkeeping and lifecycle rows that belong to a recaptured row — those are put
// back only if that row was.
const UNDO_ORDER = { observations: 0, observation_status: 1, capture_state: 1 };

function applyUndo(db, kind, rows, { now, batchSize }) {
  const done = { restored: 0, skippedEdited: 0, skippedChanged: 0 };
  // An undone entry is consumed: its copies of row content go with it.
  const markUndone = db.prepare(`UPDATE ${LOG_TABLE} SET undone_at = ?, old_values = NULL, new_values = NULL WHERE id = ?`);
  const ocols = colsOf(db, 'observations');
  const getObs = db.prepare(`SELECT * FROM observations WHERE id = ?`);
  const restoredObs = new Set(); // `${run_id}:${observation id}`
  const ordered = [...rows].sort((a, b) => (UNDO_ORDER[a.target] ?? 2) - (UNDO_ORDER[b.target] ?? 2) || b.id - a.id);
  for (let i = 0; i < ordered.length; i += batchSize) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of ordered.slice(i, i + batchSize)) {
        const old = r.old_values ? JSON.parse(r.old_values) : null;
        const nw = r.new_values ? JSON.parse(r.new_values) : null;
        let ok = false;
        if (r.target === 'capture_state') {
          // Tied to its recaptured row: if that row was left as it is, so is its bookkeeping.
          if (nw && nw._obs != null && !restoredObs.has(`${r.run_id}:${nw._obs}`)) done.skippedChanged++;
          else {
            if (old) {
              db.prepare(`INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status) VALUES (?,?,?,?,?)
                ON CONFLICT(transcript_path) DO UPDATE SET mtime = excluded.mtime, bytes = excluded.bytes, session_id = excluded.session_id, status = excluded.status`)
                .run(old.transcript_path, old.mtime, old.bytes, old.session_id, old.status);
            } else db.prepare('DELETE FROM capture_state WHERE transcript_path = ?').run(r.target_key);
            ok = true;
          }
        } else if (r.target === 'observations' && kind === KIND_RECAPTURE) {
          const cur = getObs.get(Number(r.target_key));
          if (!cur || cur.status === 'deleted') done.skippedChanged++;
          else if (isEdited(cur.metadata) && !isEdited(old.metadata)) done.skippedEdited++;
          // Compare-and-set: only if the row still holds exactly what this run
          // wrote — not hand-edited, scrubbed, or re-distilled from the raw state since.
          else if (!Object.keys(nw).every((c) => same(cur[c], nw[c]))) done.skippedChanged++;
          else {
            const cols = Object.keys(old).filter((c) => ocols.has(c));
            db.prepare(`UPDATE observations SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => old[c]), Number(r.target_key));
            ok = true;
            restoredObs.add(`${r.run_id}:${r.target_key}`);
          }
        } else if (r.target === 'observation_status' && kind === KIND_RECAPTURE) {
          const cur = getObs.get(Number(r.target_key));
          const cols = Object.keys(old).filter((c) => ocols.has(c));
          if (!restoredObs.has(`${r.run_id}:${nw._obs}`) || !cur) done.skippedChanged++;
          else if (!cols.every((c) => same(cur[c], nw[c]))) done.skippedChanged++; // changed again since
          else {
            db.prepare(`UPDATE observations SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => old[c]), Number(r.target_key));
            ok = true;
          }
        } else if (kind === KIND_CURSOR) {
          // Only where the project is still the one this run set.
          const sql = r.target === 'sdk_sessions'
            ? 'UPDATE sdk_sessions SET project = ? WHERE memory_session_id = ? AND project = ?'
            : `UPDATE ${r.target} SET project = ? WHERE id = ? AND project = ?`;
          const key = r.target === 'sdk_sessions' ? r.target_key : Number(r.target_key);
          if (db.prepare(sql).run(old.project, key, nw.project).changes) ok = true; else done.skippedChanged++;
        }
        if (ok) done.restored++;
        markUndone.run(now, r.id);
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  }
  return done;
}

// ── shared dry-run / apply / undo runner ─────────────────────────────────────

function run({ kind, label, dbPath, apply, undo, runId, backupDir, batchSize, now, plan, summarize, doApply }) {
  if (!dbPath || !existsSync(dbPath)) throw new Error(`No DB at ${dbPath}`);
  if (apply && isForeignStore(dbPath)) throw new Error(`refusing to change claude-mem's own DB (${dbPath})`);
  if (!apply) {
    const db = openDb(dbPath, { readonly: true });
    try {
      const base = { kind, applied: false, undo, observationsTotal: total(db) };
      if (undo) return { ...base, ...undoSummary(pendingLog(db, kind, runId)) };
      return { ...base, ...summarize(plan(db), base.observationsTotal) };
    } finally { db.close(); }
  }
  const db = openDb(dbPath);
  try {
    const observationsTotal = total(db);
    if (undo) {
      const rows = pendingLog(db, kind, runId);
      if (!rows.length) return { kind, applied: true, undo, observationsTotal, runs: 0, runIds: [], entries: 0, byTarget: {}, restored: 0, backupPath: null };
      const backupPath = verifiedBackup(db, dbPath, { backupDir, label: `${label}-undo`, observationsTotal });
      let done;
      try { done = applyUndo(db, kind, rows, { now, batchSize }); }
      catch (e) { throw new Error(`undo failed: ${e.message} (backup intact at ${backupPath})`); }
      return { kind, applied: true, undo, observationsTotal, ...undoSummary(rows), ...done, backupPath, observationsAfter: total(db) };
    }
    const p = plan(db);
    const summary = summarize(p, observationsTotal);
    const n = p.candidates ? p.candidates.length : p.moves.length;
    if (!n) return { kind, applied: true, undo, ...summary, backupPath: null, changed: 0 };
    const backupPath = verifiedBackup(db, dbPath, { backupDir, label, observationsTotal });
    let res;
    try { res = doApply(db, p, { now, batchSize }); }
    catch (e) { throw new Error(`${label} failed: ${e.message} (backup intact at ${backupPath})`); }
    return { kind, applied: true, undo, ...summary, backupPath, runId: res.runId, changed: res.applied, observationsAfter: total(db) };
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * `brain recapture`. `items` (tests) overrides the parsers: [{tool, it}].
 */
export function recapture({ dbPath, apply = false, undo = false, runId = null, tools = RECAPTURE_TOOLS, backupDir, batchSize = 200, now = Date.now(), items = null } = {}) {
  let cache = null;
  return run({
    kind: KIND_RECAPTURE, label: 'recapture', dbPath, apply, undo, runId, backupDir, batchSize, now,
    plan: (db) => planRecapture(db, (cache ||= gatherItems(tools, items))),
    summarize: summarizeRecapture,
    doApply: applyRecapture,
  });
}

/** `brain clean --cursor-projects`. */
export function cleanCursorProjects({ dbPath, apply = false, undo = false, runId = null, backupDir, batchSize = 200, now = Date.now(), items = null } = {}) {
  let cache = null;
  return run({
    kind: KIND_CURSOR, label: 'cursor-projects', dbPath, apply, undo, runId, backupDir, batchSize, now,
    plan: (db) => planCursorProjects(db, (cache ||= gatherItems(['cursor'], items))),
    summarize: summarizeCursor,
    doApply: applyCursorProjects,
  });
}

// ── reports ──────────────────────────────────────────────────────────────────

function undoLines(r, what) {
  const L = [];
  if (r.applied) {
    L.push(`↺ Put back ${r.restored ?? 0} of ${r.entries} journalled value(s) (${r.runs} run(s))`);
    if (r.skippedEdited) L.push(`  ${r.skippedEdited} row(s) hand-edited since — left as edited`);
    if (r.skippedChanged) L.push(`  ${r.skippedChanged} row(s) changed again since — left as they are`);
    if (r.backupPath) L.push(`  backup: ${r.backupPath}`);
  } else {
    L.push(`🔎 Would put back ${r.entries} journalled value(s) from ${r.runs} ${what} run(s) (dry run)`);
    for (const id of (r.runIds || []).slice(0, 8)) L.push(`    run ${id}`);
    if (r.entries) L.push('  Re-run with --apply to undo (a verified backup is made first); add --run <id> to undo just one run.');
    L.push('  A row is put back only if it still holds what that run wrote.');
  }
  return L;
}

export function formatRecaptureReport(r) {
  if (r.undo) return undoLines(r, 'recapture').join('\n');
  const L = [];
  L.push(r.applied ? '♻  Re-captured grown sessions (old values journalled):' : '🔎 Would re-capture grown sessions (dry run — nothing written):');
  L.push(`  ${r.scanned} sessions read from the tools · ${r.grown} grown since captured (${r.raw} raw rows, ${r.distilled} already distilled) · ${r.unchanged} unchanged · ${r.noRow} with no capture row`);
  if (r.textCurrent) L.push(`  ${r.textCurrent} of them already have the grown text (ingest keeps the raw text current): only the distillation or visibility is left to do`);
  if (r.unhide) L.push(`  ${r.unhide} raw row(s) hidden as duplicates by 'brain clean --dupes' come back into view (their transcript is no longer a copy)`);
  if (r.withCopies) L.push(`  ${r.withCopies} row(s) that others were hidden as copies of: those ${r.copiesRechecked} copies are re-checked against the new text (a copy that is no longer the same memory comes back)`);
  if (r.distilled) L.push(`  ${r.distilled} distilled row(s) will be re-queued: the distiller re-distills them (spends tokens) and overwrites the distillation in place — the old one is journalled and --undo restores it`);
  for (const [t, v] of Object.entries(r.byTool || {})) L.push(`    ${t.padEnd(12)} ${String(v.raw).padStart(5)} raw ${String(v.distilled).padStart(5)} distilled`);
  L.push(`  left alone: ${r.skipped.edited} hand-edited · ${r.skipped.deleted} deleted · ${r.skipped.notAppend} not a pure append`);
  for (const s of r.sample || []) L.push(`    #${s.id} ${s.kind} ${s.from} → ${s.to} chars [${String(s.project).slice(0, 30)}]`);
  if (r.applied) {
    if (r.backupPath) L.push(`  backup: ${r.backupPath}`);
    L.push(`  re-captured: ${r.changed?.raw ?? 0} raw, ${r.changed?.distilled ?? 0} distilled${r.changed?.unhidden ? ` · ${r.changed.unhidden} un-hidden` : ''}${r.changed?.copiesChanged ? ` · ${r.changed.copiesChanged} copy row(s) re-checked and changed` : ''}${r.changed?.lost ? ` · ${r.changed.lost} changed under us, left` : ''} · rows in store: ${r.observationsAfter ?? r.observationsTotal} (nothing deleted)`);
    if (r.runId) L.push(`  run ${r.runId} · undo: 'brain recapture --undo --apply'`);
  } else if (r.grown) {
    L.push('  Re-run with --apply to re-capture them (a verified backup is made first; --undo puts the old values back).');
  }
  return L.join('\n');
}

export function formatCursorProjectsReport(r) {
  if (r.undo) return undoLines(r, 'cursor-projects').join('\n');
  const L = [];
  L.push(r.applied ? "🗂  Filed 'cursor' sessions under their project (old project journalled):" : "🔎 Would file 'cursor' sessions under their project (dry run — nothing written):");
  const pct = r.observationsTotal ? ((r.observations / r.observationsTotal) * 100).toFixed(2) : '0.00';
  L.push(`  ${r.sessions} sessions · ${r.observations} observations (${pct}% of ${r.observationsTotal} rows) · ${r.summaries} summaries · ${r.scanned} Cursor sessions read`);
  L.push(`  left alone: ${r.skipped.edited} hand-edited observations · ${r.skipped.hidden} hidden/deleted/copied observations`);
  for (const p of (r.byProject || []).slice(0, 12)) L.push(`    ${String(p.project).slice(0, 48).padEnd(48)} ${String(p.sessions).padStart(6)} sessions ${String(p.observations).padStart(6)} observations`);
  if ((r.byProject || []).length > 12) L.push(`    … ${r.byProject.length - 12} more project(s)`);
  if (r.applied) {
    if (r.backupPath) L.push(`  backup: ${r.backupPath}`);
    if (r.changed) L.push(`  moved: ${r.changed.sessions} sessions, ${r.changed.observations} observations, ${r.changed.summaries} summaries · rows in store: ${r.observationsAfter ?? r.observationsTotal} (nothing deleted)`);
    if (r.runId) L.push(`  run ${r.runId} · undo: 'brain clean --cursor-projects --undo --apply'`);
  } else if (r.sessions) {
    L.push('  Re-run with --apply to move them (a verified backup is made first; --undo puts the old project back).');
  }
  return L.join('\n');
}
