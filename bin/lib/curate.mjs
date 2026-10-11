// Hand curation of memories — bin/lib/curate.mjs
//
// What the control panel's edit / delete / pin buttons call (ui/server.mjs):
//
//   edit     rewrite a row's title / facts / narrative. Scrubbed like every
//            other write; the old text goes to an edit log beside the store
//            first, so no edit is unrecoverable. The row is stamped
//            metadata.edited_at so ingest/distiller never overwrite it.
//   delete   soft: status → 'deleted' (lifecycle.mjs DELETED), a manual status
//            no automatic pass touches. Hidden from recall/context/startup and
//            the panel's list. The status it had is kept in status_prev.
//   restore  Undo for delete: puts that previous status back.
//   pin      pinned_at = now. Pinned rows rank first in recall, are always in
//            brain_context's block and in the startup block (bounded).
//
// Every write names one existing row by id and touches only that row of
// `observations` (plus, on an edit, that row's now-stale semantic vector) —
// nothing else in the store, and never claude-mem's own DB (isForeignStore). The columns are local bookkeeping (store.mjs): exports
// strip them, so a delete or pin on this Mac does not travel to another one,
// and an edit keeps content_hash (the row's sync identity) unchanged.

import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureLifecycleSchema } from './store.mjs';
import { openForLifecycle, isForeignStore, hasLifecycle, hasPins, statusOf, liveOnly, DELETED } from './lifecycle.mjs';
import { scrubText } from './scrub.mjs';
import { hasVectors } from './embed.mjs';
import { recheckCopiesOf } from './dedupe.mjs';
import { dropJournalFor } from './bulklog.mjs';

export const EDIT_LIMITS = {
  title: { min: 1, max: 200 },
  facts: { max: 24 },
  fact: { max: 500 },
  narrative: { max: 4000 },
};
// Bounds on what "always included" may cost: pins are for a handful of
// standing facts, not a second copy of the store.
export const MAX_PINNED_CONTEXT = 5;
export const MAX_PINNED_STARTUP = 8;

const MANUAL_DELETE = 'manual: deleted in control panel';
// Control characters other than tab/newline have no business in a memory.
const CTRL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Positive integer row id, or null. */
export function rowId(id) {
  const n = typeof id === 'string' && /^\d+$/.test(id.trim()) ? Number(id) : id;
  return Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}

// Text a field compares by: control characters out, and the same whitespace
// folding validateEdit applies, so "unchanged" means unchanged after cleaning.
const cleanLine = (s) => String(s ?? '').replace(CTRL_RE, '').replace(/\s+/g, ' ').trim();
const cleanNarrative = (s) => String(s ?? '').replace(CTRL_RE, '').trim();
function storedFacts(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.map((f) => cleanLine(f)).filter(Boolean) : []; }
  catch { return []; }
}

/**
 * Validate an edit patch: { title?, facts?, narrative? }, at least one, no
 * other keys. Strings are trimmed and stripped of control characters; facts
 * is an array of strings (blank ones dropped). Returns { ok, patch } or
 * { ok: false, error }.
 *
 * `current` (the row being edited) makes the limits relative to it: a field
 * sent back unchanged is dropped from the patch instead of re-validated, and
 * a bound the row already exceeds (a captured narrative over 4000 characters,
 * 30 facts) caps at the row's own size — an edit may keep or shrink it, never
 * grow it. Without this a fifth of real memories (long narratives) could not
 * even be retitled. The patch may then be empty (nothing actually changed).
 */
export function validateEdit(input, current = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'edit must be an object' };
  const allowed = new Set(['title', 'facts', 'narrative']);
  const extra = Object.keys(input).filter((k) => !allowed.has(k));
  if (extra.length) return { ok: false, error: `unknown field(s): ${extra.join(', ')}` };
  if (!['title', 'facts', 'narrative'].some((k) => input[k] !== undefined)) {
    return { ok: false, error: 'nothing to change (title, facts or narrative)' };
  }
  const cur = current
    ? { title: cleanLine(current.title), facts: storedFacts(current.facts), narrative: cleanNarrative(current.narrative) }
    : null;
  const cap = (limit, have) => Math.max(limit, have || 0);
  const out = {};
  if (input.title !== undefined) {
    if (typeof input.title !== 'string') return { ok: false, error: 'title must be a string' };
    const t = cleanLine(input.title);
    if (t.length < EDIT_LIMITS.title.min) return { ok: false, error: 'title cannot be empty' };
    const max = cap(EDIT_LIMITS.title.max, cur?.title.length);
    if (!cur || t !== cur.title) { // unchanged: keep as is, whatever its length
      if (t.length > max) return { ok: false, error: `title is over ${max} characters` };
      out.title = t;
    }
  }
  if (input.facts !== undefined) {
    if (!Array.isArray(input.facts)) return { ok: false, error: 'facts must be an array of strings' };
    if (input.facts.some((f) => typeof f !== 'string')) return { ok: false, error: 'facts must be an array of strings' };
    const facts = input.facts.map((f) => cleanLine(f)).filter(Boolean);
    const maxN = cap(EDIT_LIMITS.facts.max, cur?.facts.length);
    const maxLen = cap(EDIT_LIMITS.fact.max, cur ? Math.max(0, ...cur.facts.map((f) => f.length)) : 0);
    if (!cur || JSON.stringify(facts) !== JSON.stringify(cur.facts)) {
      if (facts.length > maxN) return { ok: false, error: `at most ${maxN} facts` };
      if (facts.some((f) => f.length > maxLen)) return { ok: false, error: `a fact is over ${maxLen} characters` };
      out.facts = facts;
    }
  }
  if (input.narrative !== undefined) {
    if (typeof input.narrative !== 'string') return { ok: false, error: 'narrative must be a string' };
    const n = cleanNarrative(input.narrative);
    const max = cap(EDIT_LIMITS.narrative.max, cur?.narrative.length);
    if (!cur || n !== cur.narrative) {
      if (n.length > max) return { ok: false, error: `narrative is over ${max} characters` };
      out.narrative = n;
    }
  }
  return { ok: true, patch: out };
}

/**
 * Open the store for a curation write. Refuses claude-mem's DB; migrates an
 * un-migrated native store exactly as `brain lifecycle --apply` would (verified
 * backup first), and adds pinned_at/status_prev to a store migrated by an
 * older build (additive ADD COLUMN, no rewrite).
 */
export function openForCuration(dbPath) {
  if (!dbPath) throw new Error('no store path');
  if (isForeignStore(dbPath)) {
    throw new Error("memory is still read from claude-mem's own DB — editing needs the native store (run `brain import` first)");
  }
  const { db, backupPath } = openForLifecycle(dbPath);
  try { ensureLifecycleSchema(db); } catch (e) { try { db.close(); } catch {} throw e; }
  return { db, backupPath };
}

const ROW_COLS = `id, project, type, title, subtitle, narrative, facts, concepts, files_modified, created_at`;

/** One row as the panel shows it, with its curation state. null if absent. */
export function getMemory(db, id) {
  const rid = rowId(id);
  if (!rid) return null;
  const lc = hasLifecycle(db);
  const pins = hasPins(db);
  const r = db
    .prepare(`SELECT ${ROW_COLS}, ${lc ? 'status, status_reason, superseded_by' : "NULL AS status, NULL AS status_reason, NULL AS superseded_by"},
                     ${pins ? 'pinned_at' : 'NULL AS pinned_at'} FROM observations WHERE id = ?`)
    .get(rid);
  if (!r) return null;
  return { ...r, status: statusOf(r), pinned: !!r.pinned_at };
}

/** Path of the edit log that keeps every overwritten version (0600, beside the store). */
export function editLogPath(dbPath) {
  return join(dirname(dbPath), 'brain.edits.jsonl');
}

/**
 * Apply a validated edit to one row. Secrets in the new text are redacted
 * (scrub.mjs) before anything is stored; the previous title/facts/narrative
 * are appended to the edit log BEFORE the UPDATE, so a failed log write
 * aborts the edit. A deleted row must be restored first.
 *
 * @returns {{ok:true, id, changed:string[], redacted:number, memory}|{ok:false, error, code}}
 */
export function editMemory(db, id, input, { dbPath, now = Date.now() } = {}) {
  const rid = rowId(id);
  if (!rid) return { ok: false, code: 400, error: `not a row id: ${id}` };
  const cur = getMemory(db, rid);
  if (!cur) return { ok: false, code: 404, error: `no observation #${rid}` };
  const v = validateEdit(input, cur);
  if (!v.ok) return { ok: false, code: 400, error: v.error };
  if (cur.status === DELETED) return { ok: false, code: 409, error: `#${rid} is deleted — undo the delete before editing it` };

  let redacted = 0;
  const scrub = (s) => { const r = scrubText(s); redacted += r.hits.length; return r.text; };
  const next = {};
  if (v.patch.title !== undefined) next.title = scrub(v.patch.title);
  if (v.patch.narrative !== undefined) next.narrative = scrub(v.patch.narrative);
  if (v.patch.facts !== undefined) next.facts = JSON.stringify(v.patch.facts.map(scrub));

  const before = { title: cur.title, facts: cur.facts, narrative: cur.narrative };
  const changed = Object.keys(next).filter((k) => (next[k] ?? '') !== (before[k] ?? ''));
  if (!changed.length) return { ok: true, id: rid, changed: [], redacted, memory: cur };

  if (dbPath) {
    const entry = { at: new Date(now).toISOString(), id: rid, project: cur.project, before: {}, after: {} };
    for (const k of changed) { entry.before[k] = before[k]; entry.after[k] = next[k]; }
    appendFileSync(editLogPath(dbPath), JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
  const cols = changed.map((k) => `${k} = ?`);
  const vals = changed.map((k) => next[k]);
  // Stamp the row as hand-edited (metadata.edited_at) so the automatic writers
  // leave the curated fields alone: ingest's growth refresh then updates only
  // the raw `text`, and the distiller never (re-)distils over it. The marker
  // lives in `metadata`, so it travels with the edited text on export.
  const meta = editedMetadata(db, rid, now);
  if (meta !== null) { cols.push('metadata = ?'); vals.push(meta); }
  const res = db.prepare(`UPDATE observations SET ${cols.join(', ')} WHERE id = ?`).run(...vals, rid);
  if (res.changes !== 1) return { ok: false, code: 500, error: `update touched ${res.changes} rows` };
  // Rows hidden as copies of this one held its old wording: re-check them
  // (dedupe.mjs) so a copy that is no longer the same memory comes back.
  recheckCopiesOf(db, rid, { now });
  // The row's semantic vector describes the old wording: drop it so hybrid
  // recall stops matching on text that is gone. `brain embed --apply` sees the
  // row as never embedded and re-embeds it; until then BM25 finds the new text.
  let unembedded = false;
  if (hasVectors(db)) unembedded = db.prepare('DELETE FROM observation_vectors WHERE obs_id = ?').run(rid).changes > 0;
  return { ok: true, id: rid, changed, redacted, unembedded, memory: getMemory(db, rid) };
}

/**
 * metadata.edited_at — the "a person curated this row" marker. ingest.mjs and
 * distiller.mjs check it (EDITED_SQL) before rewriting title/facts/narrative.
 */
export const EDITED_KEY = 'edited_at';

/** SQL predicate: true when the row (alias `a`) carries the hand-edit marker. */
export const editedSql = (a = '') =>
  `(CASE WHEN json_valid(${a}metadata) THEN json_extract(${a}metadata, '$.${EDITED_KEY}') END) IS NOT NULL`;

/** True when a row's metadata JSON carries the hand-edit marker. */
export function isEdited(metadata) {
  try { const m = metadata ? JSON.parse(metadata) : null; return !!(m && typeof m === 'object' && m[EDITED_KEY]); }
  catch { return false; }
}

// The row's metadata with edited_at set, or null when the store has no
// metadata column. Existing keys (a distillation's provenance) are kept; a
// value that is not a JSON object is kept under `prior`.
function editedMetadata(db, rid, now) {
  const has = db.prepare('PRAGMA table_info(observations)').all().some((c) => c.name === 'metadata');
  if (!has) return null;
  const raw = db.prepare('SELECT metadata FROM observations WHERE id = ?').get(rid)?.metadata;
  let m = {};
  if (raw) {
    try {
      const o = JSON.parse(raw);
      m = o && typeof o === 'object' && !Array.isArray(o) ? o : { prior: raw };
    } catch { m = { prior: raw }; }
  }
  return JSON.stringify({ ...m, [EDITED_KEY]: new Date(now).toISOString() });
}

/** Soft delete: status → deleted, previous status kept for Undo. Idempotent. */
export function deleteMemory(db, id, { now = Date.now() } = {}) {
  const rid = rowId(id);
  if (!rid) return { ok: false, code: 400, error: `not a row id: ${id}` };
  if (!hasLifecycle(db)) return { ok: false, code: 409, error: 'store has no lifecycle columns' };
  const r = db.prepare('SELECT id, status, status_reason, status_at FROM observations WHERE id = ?').get(rid);
  if (!r) return { ok: false, code: 404, error: `no observation #${rid}` };
  if (r.status === DELETED) return { ok: true, id: rid, already: true };
  const prev = JSON.stringify({ status: r.status || 'active', reason: r.status_reason ?? null, at: r.status_at ?? null });
  const res = db
    .prepare('UPDATE observations SET status = ?, status_reason = ?, status_at = ?, status_prev = ? WHERE id = ?')
    .run(DELETED, MANUAL_DELETE, now, prev, rid);
  if (res.changes !== 1) return { ok: false, code: 500, error: `update touched ${res.changes} rows` };
  // The bulk-change journal (bulklog.mjs) keeps copies of row content: a deleted
  // memory does not stay readable through it.
  dropJournalFor(db, rid);
  return { ok: true, id: rid, from: r.status || 'active' };
}

/** Undo a soft delete: the status (and reason) it had before comes back. */
export function restoreMemory(db, id, { now = Date.now() } = {}) {
  const rid = rowId(id);
  if (!rid) return { ok: false, code: 400, error: `not a row id: ${id}` };
  if (!hasLifecycle(db)) return { ok: false, code: 409, error: 'store has no lifecycle columns' };
  const r = db.prepare('SELECT id, status, status_prev FROM observations WHERE id = ?').get(rid);
  if (!r) return { ok: false, code: 404, error: `no observation #${rid}` };
  if (r.status !== DELETED) return { ok: true, id: rid, already: true, to: r.status || 'active' };
  let prev = null;
  try { prev = JSON.parse(r.status_prev || 'null'); } catch { prev = null; }
  // Only a real lifecycle status comes back; anything odd restores as active
  // with no reason, and the next automatic pass decides from there.
  const to = prev && ['active', 'superseded', 'contested', 'stale'].includes(prev.status) ? prev.status : 'active';
  const reason = prev && to !== 'active' && typeof prev.reason === 'string' ? prev.reason : null;
  const at = prev && Number.isFinite(prev.at) ? prev.at : now;
  const res = db
    .prepare('UPDATE observations SET status = ?, status_reason = ?, status_at = ?, status_prev = NULL WHERE id = ?')
    .run(to, reason, at, rid);
  if (res.changes !== 1) return { ok: false, code: 500, error: `update touched ${res.changes} rows` };
  return { ok: true, id: rid, to };
}

/** Pin (pinned=true) or unpin one row. A deleted row cannot be pinned. */
export function pinMemory(db, id, pinned, { now = Date.now() } = {}) {
  const rid = rowId(id);
  if (!rid) return { ok: false, code: 400, error: `not a row id: ${id}` };
  if (typeof pinned !== 'boolean') return { ok: false, code: 400, error: 'pinned must be true or false' };
  if (!hasPins(db)) return { ok: false, code: 409, error: 'store has no pinned_at column' };
  const r = db.prepare(`SELECT id, pinned_at, ${hasLifecycle(db) ? 'status' : 'NULL AS status'} FROM observations WHERE id = ?`).get(rid);
  if (!r) return { ok: false, code: 404, error: `no observation #${rid}` };
  if (pinned && r.status === DELETED) return { ok: false, code: 409, error: `#${rid} is deleted — undo the delete before pinning it` };
  if (!!r.pinned_at === pinned) return { ok: true, id: rid, pinned, already: true };
  const res = db.prepare('UPDATE observations SET pinned_at = ? WHERE id = ?').run(pinned ? now : null, rid);
  if (res.changes !== 1) return { ok: false, code: 500, error: `update touched ${res.changes} rows` };
  return { ok: true, id: rid, pinned };
}

/**
 * Pinned, non-deleted rows: rows in `projects` first (when given), then the
 * rest, newest pin first within each. Read-only; [] on a store without pins.
 * `cols`/`join` let a caller select the columns its renderer needs.
 */
export function pinnedRows(db, { projects = null, limit = MAX_PINNED_STARTUP, cols = 'o.id, o.project, o.type, o.title, o.narrative, o.facts, o.created_at, o.created_at_epoch', join = '' } = {}) {
  if (!hasPins(db)) return [];
  const rows = db
    .prepare(`SELECT ${cols}, o.pinned_at AS pinned_at FROM observations o ${join}
               WHERE o.pinned_at IS NOT NULL${liveOnly(db)} ORDER BY o.pinned_at DESC, o.id DESC LIMIT 200`)
    .all();
  if (projects && projects.length) {
    const mine = new Set(projects);
    rows.sort((a, b) => (mine.has(a.project) ? 0 : 1) - (mine.has(b.project) ? 0 : 1));
  }
  return rows.slice(0, Math.max(0, limit));
}
