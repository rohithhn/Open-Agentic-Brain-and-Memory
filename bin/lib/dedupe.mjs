// Duplicate memories — bin/lib/dedupe.mjs
//
// One definition of "the same memory", shared by every writer and reader:
//
//   same project + effectively identical content, where content is the title,
//   subtitle, facts (as a set) and narrative — and, for a row with no facts and
//   no narrative, its raw `text`. "Effectively identical" folds only case,
//   Unicode compatibility forms, runs of whitespace and trailing punctuation.
//   Wording, numbers, operators and symbols inside the text all count, so
//   'timeout < 30s' and 'timeout > 30s', or a daily "tracker refreshed" row with
//   new numbers, are never the same memory. A row with nothing to compare
//   (no title, facts, narrative or text) has no key and is never merged.
//
// How duplicates are kept out (no marker rows — the rolled-back attempt's blank
// "(untitled)" markers leaked into the startup block; see
// evals/overnight-rollbacks.md):
//
//   write   brain_remember answers 'duplicate' (and bumps the held row's
//           relevance) instead of inserting; ingest skips a new session whose
//           transcript a live row of the project already holds; the distiller,
//           when a distillation comes out identical to a held memory, still
//           upgrades its own row in place (so the session is done everywhere)
//           and then hides that row as a duplicate.
//   store   `brain clean --dupes` hides every copy but one. A hidden copy keeps
//           every column exactly as it was: lifecycle status 'duplicate'
//           (lifecycle.mjs DUPLICATE, hidden by liveOnly() exactly like a
//           panel delete), superseded_by = the row it copies, status_prev =
//           what --undo restores. Nothing is deleted or blanked, so nothing can
//           surface as an empty row and the next sync cannot re-insert it (the
//           row is still there under its own key).
//   read    recall, brain_context, the startup block and the folder digest
//           collapse what they are about to show to one row per memory
//           (collapseDuplicates) — the guard on a store that was never cleaned
//           or migrated, and for copies another Mac sends (statuses are local).
//           A collapse only ever drops a row whose twin is already shown.
import { hasLifecycle, hasPins, liveOnly, DUPLICATE, isHiddenStatus } from './lifecycle.mjs';
import { normText, memoryKey, KEY_COLS, fromKeyCols, keyed } from './memkey.mjs';

// The key and the read-side collapse live in memkey.mjs (no imports, so the
// SessionStart hook can use them without loading config); re-exported here.
export { normText, factSet, memoryKey, KEY_COLS, collapseDuplicates } from './memkey.mjs';
export { DUPLICATE };

// status_reason prefixes. Not 'manual…': a duplicate is not a user override,
// and lifecycle passes leave hidden rows alone regardless (lifecycle.mjs).
export const REASON_CLEAN = 'dedupe: same memory as #';
export const REASON_DISTILL = 'dedupe: distilled to the same memory as #';

// ── write side ──────────────────────────────────────────────────────────────

const escLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The oldest live row of `project` holding the same memory as `obs`
 * ({title, subtitle, facts, narrative, text}), or null. `excludeId` leaves the
 * caller's own row out. Candidates come from an indexed project scan narrowed
 * by a LIKE on the title's words (case-insensitive, a superset of the folded
 * title); memoryKey decides.
 */
export function findHeldDuplicate(db, obs, { project, excludeId = null } = {}) {
  const key = memoryKey(obs);
  if (!key) return null;
  const words = normText(obs.title).split(' ').filter(Boolean);
  const titleSql = words.length
    ? " AND o.title LIKE ? ESCAPE '\\'"
    : " AND TRIM(COALESCE(o.title, '')) = ''";
  const params = [project];
  if (words.length) params.push(`%${words.map(escLike).join('%')}%`);
  const rows = db
    .prepare(
      `SELECT o.id, ${KEY_COLS('o')} FROM observations o
        WHERE o.project = ?${titleSql}${excludeId != null ? ' AND o.id != ?' : ''}${liveOnly(db)}
        ORDER BY o.id LIMIT 500`
    )
    .all(...params, ...(excludeId != null ? [excludeId] : []));
  const hit = rows.find((r) => memoryKey(fromKeyCols(r)) === key);
  return hit ? { id: hit.id } : null;
}

/** +1 relevance on the row a duplicate was folded into (a re-capture is a signal). */
export function bumpRelevance(db, id, n = 1) {
  db.prepare('UPDATE observations SET relevance_count = COALESCE(relevance_count, 0) + ? WHERE id = ?').run(n, id);
}

/**
 * Hide `id` as a duplicate of `ofId`. Needs the lifecycle columns (false
 * without them). Never hides a pinned row or one whose status the user set by
 * hand. Compare-and-set on the status it read. status_prev keeps what --undo
 * (unmarkDuplicate) restores, plus the relevance the copy added to `ofId`.
 */
export function markDuplicate(db, id, ofId, { reason = REASON_CLEAN, now = Date.now(), relevanceAdded = 0 } = {}) {
  if (!hasLifecycle(db)) return false;
  const r = db
    .prepare(`SELECT id, status, superseded_by, status_reason, status_at, ${hasPins(db) ? 'pinned_at' : 'NULL AS pinned_at'} FROM observations WHERE id = ?`)
    .get(id);
  if (!r || r.pinned_at != null || isHiddenStatus(r.status) || String(r.status_reason || '').startsWith('manual')) return false;
  const prev = JSON.stringify({
    status: r.status || 'active', reason: r.status_reason ?? null, at: r.status_at ?? null,
    by: r.superseded_by ?? null, relevance_added: relevanceAdded,
  });
  const res = db
    .prepare(
      `UPDATE observations SET status = ?, superseded_by = ?, status_reason = ?, status_at = ?, status_prev = ?
        WHERE id = ? AND COALESCE(status,'active') = ?`
    )
    .run(DUPLICATE, ofId, `${reason}${ofId}`, now, prev, id, r.status || 'active');
  return res.changes === 1;
}

/** Bring a hidden duplicate back with the status it had; take back the
 *  relevance it added to the row it was folded into. */
export function unmarkDuplicate(db, id, { now = Date.now() } = {}) {
  if (!hasLifecycle(db)) return false;
  const r = db.prepare('SELECT id, status, superseded_by, status_prev FROM observations WHERE id = ?').get(id);
  if (!r || r.status !== DUPLICATE) return false;
  let prev = null;
  try { prev = JSON.parse(r.status_prev || 'null'); } catch { prev = null; }
  const to = prev && ['active', 'superseded', 'contested', 'stale'].includes(prev.status) ? prev.status : 'active';
  const reason = prev && to !== 'active' && typeof prev.reason === 'string' ? prev.reason : null;
  const at = prev && Number.isFinite(prev.at) ? prev.at : now;
  // superseded_by is the newer row only for a superseded row; a duplicate's
  // pointer goes away with the status.
  const by = to === 'superseded' && Number.isInteger(prev?.by) ? prev.by : null;
  const res = db
    .prepare('UPDATE observations SET status = ?, superseded_by = ?, status_reason = ?, status_at = ?, status_prev = NULL WHERE id = ? AND status = ?')
    .run(to, by, reason, at, id, DUPLICATE);
  const n = prev && Number(prev.relevance_added) > 0 ? Number(prev.relevance_added) : 0;
  if (res.changes === 1 && n && r.superseded_by) {
    db.prepare('UPDATE observations SET relevance_count = MAX(0, COALESCE(relevance_count, 0) - ?) WHERE id = ?').run(n, r.superseded_by);
  }
  return res.changes === 1;
}

/**
 * After row `id`'s content changed (re-distilled, refreshed by ingest, edited
 * in the panel, moved to another project), the rows hidden as copies of it may
 * no longer be copies. A copy stays hidden while it still holds the same
 * memory as `id` — the same content key, or, for a raw capture copy (type
 * 'session', not distilled yet), the same source transcript: `id` is that
 * transcript distilled, and the copy would distil to the same thing. Any
 * other copy comes back with the status it had; if it now matches another
 * live row of its project it is folded into that one instead
 * (and the relevance it gave `id` moves there). Only rows a dedupe pass hid
 * are touched. Best effort: never throws.
 *
 * @returns {{unhidden:number, repointed:number}}
 */
export function recheckCopiesOf(db, id, { now = Date.now() } = {}) {
  const out = { unhidden: 0, repointed: 0 };
  try {
    if (!hasLifecycle(db) || id == null) return out;
    const copies = db
      .prepare(
        `SELECT o.id, o.project, o.type, o.text AS src, o.status_reason, o.status_prev, ${KEY_COLS('o')}
           FROM observations o WHERE o.superseded_by = ? AND o.status = ? ORDER BY o.id`
      )
      .all(id, DUPLICATE)
      .filter((c) => isDedupeReason(c.status_reason));
    if (!copies.length) return out;
    const kept = db.prepare(`SELECT o.id, o.project, o.text AS src, ${KEY_COLS('o')} FROM observations o WHERE o.id = ?`).get(id);
    const keptKey = kept ? keyed(kept.project, memoryKey(fromKeyCols(kept))) : null;
    const keptSrc = kept ? normText(kept.src) : '';
    for (const c of copies) {
      if (kept) {
        const key = keyed(c.project, memoryKey(fromKeyCols(c)));
        if (key && key === keptKey) continue;
        if (c.type === 'session' && keptSrc && c.project === kept.project && normText(c.src) === keptSrc) continue;
      }
      let added = 0;
      try { added = Math.max(0, Number(JSON.parse(c.status_prev || 'null')?.relevance_added) || 0); } catch { added = 0; }
      const reason = String(c.status_reason).startsWith(REASON_DISTILL) ? REASON_DISTILL : REASON_CLEAN;
      if (!unmarkDuplicate(db, c.id, { now })) continue;
      const held = findHeldDuplicate(db, fromKeyCols(c), { project: c.project, excludeId: c.id });
      if (held && markDuplicate(db, c.id, held.id, { reason, now, relevanceAdded: added })) {
        if (added) bumpRelevance(db, held.id, added);
        out.repointed++;
      } else out.unhidden++;
    }
  } catch { /* the copies stay as they were */ }
  return out;
}

/** True for a status_reason a dedupe pass wrote (never a user's own). */
export const isDedupeReason = (reason) =>
  String(reason || '').startsWith(REASON_CLEAN) || String(reason || '').startsWith(REASON_DISTILL);

// ── store-wide plan (brain clean --dupes) ───────────────────────────────────

const STATUS_RANK = { active: 0, contested: 1, stale: 2, superseded: 3 };

/**
 * Read-only: every group of live rows holding the same memory in one project.
 * The survivor is a pinned row if there is one, then the best lifecycle status,
 * then the oldest (the original capture). Copies that are pinned, or carry a
 * status the user set by hand, are left visible (`kept`), never hidden.
 * Streams the table, so a 40k-row store never holds its transcripts in memory.
 *
 * @returns {{groups: Array<{project, survivor, copies:number[], kept:number[], title}>,
 *            scanned:number, keyless:number, sameTitleDifferent:number}}
 */
export function planDuplicates(db) {
  const lc = hasLifecycle(db);
  const extra = lc
    ? `COALESCE(o.status,'active') AS status, o.status_reason, ${hasPins(db) ? 'o.pinned_at' : 'NULL AS pinned_at'}`
    : "'active' AS status, NULL AS status_reason, NULL AS pinned_at";
  const stmt = db.prepare(
    `SELECT o.id, o.project, o.title, o.subtitle, o.facts, o.narrative,
            CASE WHEN TRIM(COALESCE(o.narrative, '')) = '' THEN o.text END AS text, ${extra}
       FROM observations o WHERE 1=1${liveOnly(db)} ORDER BY o.id`
  );
  const byKey = new Map();
  const titleKeys = new Map(); // project+title -> Set(content key)
  let scanned = 0, keyless = 0;
  const iter = typeof stmt.iterate === 'function' ? stmt.iterate() : stmt.all();
  for (const r of iter) {
    scanned++;
    const key = memoryKey(r);
    if (!key) { keyless++; continue; }
    const k = keyed(r.project, key);
    const slim = {
      id: r.id, project: r.project, status: r.status, pinned: r.pinned_at != null,
      manual: String(r.status_reason || '').startsWith('manual'), title: r.title || '',
    };
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(slim);
    const tk = `${r.project ?? ''}\u0000${normText(r.title)}`;
    if (!titleKeys.has(tk)) titleKeys.set(tk, new Set());
    titleKeys.get(tk).add(k);
  }
  const groups = [];
  for (const rows of byKey.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) =>
      (b.pinned - a.pinned) || ((STATUS_RANK[a.status] ?? 0) - (STATUS_RANK[b.status] ?? 0)) || (a.id - b.id));
    const survivor = sorted[0];
    const copies = [], kept = [];
    for (const r of sorted.slice(1)) (r.pinned || r.manual ? kept : copies).push(r.id);
    if (!copies.length) continue;
    groups.push({ project: survivor.project, survivor: survivor.id, copies, kept, title: survivor.title });
  }
  let sameTitleDifferent = 0;
  for (const set of titleKeys.values()) if (set.size > 1) sameTitleDifferent++;
  groups.sort((a, b) => b.copies.length - a.copies.length || a.survivor - b.survivor);
  return { groups, scanned, keyless, sameTitleDifferent };
}
