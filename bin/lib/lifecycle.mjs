// Memory lifecycle — bin/lib/lifecycle.mjs
//
// Every observation is in one of four states:
//
//   active      the default; what recall/context should lean on
//   superseded  a newer decision/fix on the same topic replaced it
//               (superseded_by = the newer row's id)
//   contested   dream's lint found the same content recorded under more than
//               one project — which one is canonical is unresolved
//   stale       every concept it belongs to has gone quiet (lint's stale claims)
//
// Nothing here deletes or rewrites memory content: a status is metadata on the
// row, reversible with `brain status-mark <id> active` (or `auto`). Readers
// down-rank and label non-active rows; they never hide them from recall. The
// two exceptions are the user's own soft delete from the control panel
// (DELETED, curate.mjs), which readers do hide — and which Undo reverses —
// and a merged duplicate (DUPLICATE, dedupe.mjs): a full, untouched copy of
// another live memory, hidden so no reader shows the same memory twice.
//
// Automatic passes only touch rows they own. A status whose status_reason
// starts with 'manual' is a user override and is never changed automatically;
// an auto status whose cause has gone away (the newer row was deleted, the
// concept came back to life) returns to active on the next pass.
//
// The columns only exist on the native store (store.mjs ensureLifecycleSchema).
// Every reader here checks for them first, so a claude-mem DB or an older
// store behaves exactly as before: everything reads as active.

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openDb, tableExists } from './db.mjs';
import { CLAUDE_MEM_DB } from './paths.mjs';
import { ensureLifecycleSchema } from './store.mjs';

export const STATUSES = ['active', 'superseded', 'contested', 'stale'];

// A fifth, user-only state: soft-deleted from the control panel (curate.mjs).
// Not in STATUSES — no automatic pass or `status-mark` sets it — and unlike
// the four above it IS hidden: every reader filters it out (liveOnly) and
// rerankByLifecycle drops it. Undo restores the status it had before.
export const DELETED = 'deleted';

// A sixth, hidden state: an effectively-identical copy of another live memory
// in the same project (dedupe.mjs). The row keeps every column it had — no
// content is cleared, nothing is deleted — and superseded_by names the copy it
// duplicates. Hidden exactly like DELETED, so no reader ever lists it, and
// reversible (`brain clean --dupes --undo`, or `brain status-mark <id> active`).
// Not in STATUSES: no automatic lifecycle pass sets or clears it.
export const DUPLICATE = 'duplicate';

// Every status a reader must never show.
export const HIDDEN_STATUSES = [DELETED, DUPLICATE];
const HIDDEN = new Set(HIDDEN_STATUSES);
export const isHiddenStatus = (s) => HIDDEN.has(s);
const HIDDEN_SQL = HIDDEN_STATUSES.map((s) => `'${s}'`).join(',');

// Types where "a newer one on the same topic replaces the older" holds. A
// discovery or a change is additive history; a decision or a fix is a claim
// about the current state, and only the latest one is true.
export const SUPERSEDABLE_TYPES = new Set(['decision', 'bugfix']);

// Same-topic test for supersession: title tokens (Jaccard) within one project
// and one type. Deliberately strict — a wrong "superseded" label on a live
// decision costs more than a missed one.
export const SUPERSEDE_MIN_SIMILARITY = 0.67; // 2/3: at 0.6 the live store had twice the distinct non-identical pairs, mostly one-word swaps
export const SUPERSEDE_MIN_SHARED = 3;

// Recall/context down-ranking: FTS5's rank (bm25) is negative, lower = better,
// so scaling it toward 0 pushes a row down without dropping it.
export const STATUS_WEIGHT = { active: 1, contested: 0.85, stale: 0.6, superseded: 0.35 };

const MANUAL = 'manual';
const PRECEDENCE = { active: 0, stale: 1, contested: 2, superseded: 3 };
const TOPIC_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'was', 'were', 'are', 'has',
  'have', 'had', 'not', 'now', 'all', 'via', 'use', 'uses', 'used', 'new', 'old', 'its', 'our',
  'fix', 'fixed', 'fixes', 'bug', 'decision', 'decided', 'after', 'before', 'when', 'then',
]);

// ── schema probes ───────────────────────────────────────────────────────────

// Automatic marking (dream's nightly pass) is opt-in. The user turns it on by
// running `brain lifecycle --apply` once — a deliberate act, after seeing the
// dry run — and off with `brain lifecycle --clear --apply`. Until then the
// nightly pass only reports what it would mark. The marker sits next to the
// store so it is per-machine, like the lifecycle columns themselves.
export function autoMarkerPath(dbPath) {
  return join(dirname(resolve(dbPath)), 'LIFECYCLE_AUTO');
}
export function autoLifecycleEnabled(dbPath) {
  try { return existsSync(autoMarkerPath(dbPath)); } catch { return false; }
}

/** True when this DB carries the lifecycle columns (native store, migrated). */
export function hasLifecycle(db) {
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(observations)').all().map((c) => c.name));
    return cols.has('status') && cols.has('superseded_by');
  } catch {
    return false;
  }
}

/** True when this DB carries pinned_at (a store migrated by this build; an
 *  older migrated store gains it on its next write-mode open). */
export function hasPins(db) {
  try { return db.prepare('PRAGMA table_info(observations)').all().some((c) => c.name === 'pinned_at'); }
  catch { return false; }
}

/** SELECT fragment giving lc_status / lc_superseded_by / lc_pinned_at, or
 *  NULLs on a DB without the columns — so one query text works on every store. */
export function lifecycleCols(db, alias = 'o') {
  const lc = hasLifecycle(db)
    ? `${alias}.status AS lc_status, ${alias}.superseded_by AS lc_superseded_by`
    : 'NULL AS lc_status, NULL AS lc_superseded_by';
  return `${lc}, ${hasPins(db) ? `${alias}.pinned_at` : 'NULL'} AS lc_pinned_at`;
}

/** WHERE fragment (leading " AND") that hides soft-deleted rows and merged
 *  duplicates, or '' on a DB without the lifecycle columns (nothing there can
 *  be either). */
export function liveOnly(db, alias = 'o') {
  return hasLifecycle(db) ? hiddenFilter(alias) : '';
}

/** liveOnly's fragment for a caller that already knows the columns exist. */
export function hiddenFilter(alias = 'o') {
  return ` AND COALESCE(${alias ? `${alias}.` : ''}status,'active') NOT IN (${HIDDEN_SQL})`;
}

// ── reading ─────────────────────────────────────────────────────────────────

/** Status of a row selected with lifecycleCols (or raw status); NULL/unknown → active. */
export function statusOf(row) {
  const s = row && (row.lc_status ?? row.status);
  if (HIDDEN.has(s)) return s;
  return STATUSES.includes(s) ? s : 'active';
}

/** True for a row the user pinned (selected with lifecycleCols, or raw pinned_at). */
export function isPinned(row) {
  return !!(row && (row.lc_pinned_at ?? row.pinned_at));
}

/** '' for active rows, else a short label: "superseded by #123", "contested", "stale". */
export function lifecycleLabel(row) {
  const s = statusOf(row);
  if (s === 'active') return '';
  const by = row && (row.lc_superseded_by ?? row.superseded_by);
  if (s === 'superseded' && by) return `superseded by #${by}`;
  return s;
}

/**
 * Stable re-rank of FTS candidates (each carrying `score` = FTS5 rank) so
 * active rows win ties and non-active rows sink by STATUS_WEIGHT. With every
 * row active the order is exactly the input order. Pinned rows go first (in
 * their own relevance order); soft-deleted rows and merged duplicates are
 * dropped outright.
 */
export function rerankByLifecycle(rows, limit) {
  const keyed = rows.filter((r) => !HIDDEN.has(statusOf(r))).map((r, i) => {
    const w = STATUS_WEIGHT[statusOf(r)] ?? 1;
    const s = Number(r.score);
    // A non-negative or missing score carries no ordering signal: fall back to
    // input position, still pushed down by status.
    const eff = Number.isFinite(s) && s < 0 ? s * w : -1 / (i + 1) * w;
    return { r, i, eff, pin: isPinned(r) ? 0 : 1 };
  });
  keyed.sort((a, b) => a.pin - b.pin || a.eff - b.eff || a.i - b.i);
  const out = keyed.map((k) => k.r);
  return limit == null ? out : out.slice(0, limit);
}

// ── supersession ────────────────────────────────────────────────────────────

// A title's topic: its content words, plus the concrete subjects it names —
// file names and code identifiers. Word overlap alone calls "safeParseJson
// import added to redditScout.js" and "… to trendDiscovery.js" the same topic
// (measured on the live store); they are parallel fixes, not one replacing
// the other, so differing subjects veto a match.
const FILE_RE = /[\w.-]+\.(?:m?[jt]sx?|cjs|py|rb|go|rs|java|kt|swift|sh|json|ya?ml|toml|md|css|scss|html|sql|c|cc|cpp|h|hpp)\b/gi;
const IDENT_RES = [
  /\b[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*\b/g, // camelCase / PascalCase
  /\b[A-Za-z_]\w*(?=\(\))/g,              // fn()
  /\b(?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{2,}\b/gi, // codes mixing letters+digits: fc7, v2, p3
  /\b[a-z0-9]+(?:-[a-z0-9]+)+\b/gi,         // kebab-names: seo-to-facebook
  /#\d+/g,                                   // #41
];
// "Task 34" / "Phase 2" / "Gate 3": numbered units are distinct subjects.
const NUMBERED_RE = /\b(task|phase|step|gate|item|issue|pr|ticket|milestone|part|round|stage|sprint|batch)\s*#?\s*(\d+)/gi;

export function topicOf(title) {
  const t = String(title || '');
  const files = new Set((t.match(FILE_RE) || []).map((f) => f.toLowerCase()));
  const rest = t.replace(FILE_RE, ' ');
  const idents = new Set(IDENT_RES.flatMap((re) => rest.match(re) || []).map((w) => w.toLowerCase()));
  for (const m of rest.matchAll(NUMBERED_RE)) idents.add(`${m[1].toLowerCase()}${m[2]}`);
  const words = t.toLowerCase().match(/[a-z0-9]+/g) || [];
  const tokens = new Set(words.filter((w) => w.length >= 3 && !TOPIC_STOP.has(w)));
  return { tokens, files, idents };
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

export function sameTopic(a, b) {
  if (!a.tokens.size || !b.tokens.size) return false;
  // Subjects: if either title names files, both must name the same files; if
  // both name identifiers, the same identifiers. Strict on purpose.
  if ((a.files.size || b.files.size) && !sameSet(a.files, b.files)) return false;
  if (a.idents.size && b.idents.size && !sameSet(a.idents, b.idents)) return false;
  let shared = 0;
  for (const t of a.tokens) if (b.tokens.has(t)) shared++;
  if (shared < SUPERSEDE_MIN_SHARED) return false;
  return shared / (a.tokens.size + b.tokens.size - shared) >= SUPERSEDE_MIN_SIMILARITY;
}

const isManual = (r) => String(r.status_reason || '').startsWith(MANUAL);
const newer = (a, b) => (a.created_at_epoch - b.created_at_epoch) || (a.id - b.id); // >0: a newer

/**
 * For each supersedable row, the newest same-project same-type same-topic row
 * that is newer than it. Returns Map(olderId → { by, title }).
 * A row a user manually retired (manual superseded/stale) never supersedes others.
 */
export function findSupersessions(db, { onlyIds = null } = {}) {
  const types = [...SUPERSEDABLE_TYPES];
  const rows = db
    .prepare(
      `SELECT id, project, type, title, created_at_epoch,
              ${hasLifecycle(db) ? 'status, status_reason' : 'NULL AS status, NULL AS status_reason'}
         FROM observations
        WHERE type IN (${types.map(() => '?').join(',')}) AND title IS NOT NULL AND title != ''${liveOnly(db, '')}`
    )
    .all(...types);
  const groups = new Map();
  for (const r of rows) {
    r.topic = topicOf(r.title);
    if (r.topic.tokens.size < SUPERSEDE_MIN_SHARED) continue;
    const k = `${r.project}\u0000${r.type}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const want = onlyIds ? new Set(onlyIds.map(Number)) : null;
  const out = new Map();
  for (const g of groups.values()) {
    if (want && !g.some((r) => want.has(r.id))) continue;
    g.sort(newer); // oldest → newest
    for (let i = 0; i < g.length; i++) {
      const older = g[i];
      // Scan from the newest down: the first same-topic hit is the current one.
      for (let j = g.length - 1; j > i; j--) {
        const cand = g[j];
        if (isManual(cand) && cand.status !== 'active') continue;
        if (sameTopic(older.topic, cand.topic)) {
          out.set(older.id, { by: cand.id, title: cand.title });
          break;
        }
      }
    }
  }
  return out;
}

// ── lint → contested / stale ────────────────────────────────────────────────

function parseConcepts(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  } catch {}
  return [];
}

/** Rows whose content_hash is in `hashes` (lint's contradictions). Map(id → reason). */
function findContested(db, hashes) {
  const out = new Map();
  if (!hashes || !hashes.length) return out;
  const q = db.prepare('SELECT id, project FROM observations WHERE content_hash = ?');
  for (const h of hashes) {
    const rows = q.all(h);
    const projects = [...new Set(rows.map((r) => r.project))];
    if (projects.length < 2) continue;
    for (const r of rows) out.set(r.id, `lint: same content in ${projects.slice(0, 4).join(', ')}`);
  }
  return out;
}

/** Rows that belong to at least one stale concept and to no live ranked one.
 *  A row also tagged with a live concept is still vouched for. Map(id → reason). */
function findStale(db, staleConcepts, liveConcepts) {
  const out = new Map();
  if (!staleConcepts || !staleConcepts.length) return out;
  const stale = new Set(staleConcepts);
  const live = new Set(liveConcepts || []);
  const rows = db
    .prepare("SELECT id, concepts FROM observations WHERE concepts IS NOT NULL AND concepts != ''")
    .all();
  for (const r of rows) {
    const cs = parseConcepts(r.concepts);
    const hit = cs.find((c) => stale.has(c));
    if (hit && !cs.some((c) => live.has(c))) out.set(r.id, `lint: concept "${hit}" is stale`);
  }
  return out;
}

// ── plan + apply ────────────────────────────────────────────────────────────

/**
 * Work out every automatic status change. Read-only.
 *
 * Each source manages only its own status and only when it was run: pass
 * `contradictions` (content hashes) to manage 'contested', `staleConcepts`
 * (+ `liveConcepts`) to manage 'stale'; supersession always runs. Precedence
 * when a row qualifies twice: superseded > contested > stale.
 *
 * @returns {{changes: Array<{id, from, to, by, reason}>, counts: object}}
 */
export function planLifecycle(db, { contradictions = null, staleConcepts = null, liveConcepts = null } = {}) {
  // Works on an un-migrated store too (every row reads as active, nothing is
  // manual), so a dry run can report what the first --apply would do.
  const lc = hasLifecycle(db);
  const managed = new Set(['superseded']);
  if (contradictions) managed.add('contested');
  if (staleConcepts) managed.add('stale');

  const desired = new Map(); // id → { status, by, reason }
  const put = (id, v) => { if (!desired.has(id)) desired.set(id, v); };
  for (const [id, s] of findSupersessions(db))
    put(id, { status: 'superseded', by: s.by, reason: `newer #${s.by}: ${String(s.title).slice(0, 80)}` });
  for (const [id, reason] of findContested(db, contradictions)) put(id, { status: 'contested', by: null, reason });
  for (const [id, reason] of findStale(db, staleConcepts, liveConcepts)) put(id, { status: 'stale', by: null, reason });

  const changes = [];
  // Rows to (re)mark.
  const cur = lc ? db.prepare('SELECT id, status, superseded_by, status_reason FROM observations WHERE id = ?') : null;
  for (const [id, d] of desired) {
    const r = cur ? cur.get(id) : { id, status: 'active', superseded_by: null, status_reason: null };
    // A hidden row (deleted, merged duplicate) is not re-labelled: that would
    // bring it back into every reader.
    if (!r || isManual(r) || HIDDEN.has(r.status)) continue;
    const from = r.status || 'active';
    // An auto status from a source not run this pass is kept unless the new one
    // outranks it (a supersede-only run still retires a contested row, but
    // never turns a contested row stale without the contradiction pass).
    if (from !== 'active' && !managed.has(from) && PRECEDENCE[d.status] <= PRECEDENCE[from]) continue;
    if (from === d.status && (r.superseded_by ?? null) === (d.by ?? null)) continue;
    changes.push({ id, from, to: d.status, by: d.by ?? null, reason: d.reason });
  }
  // Auto-marked rows whose cause is gone → back to active.
  if (lc) {
    const marks = [...managed].map(() => '?').join(',');
    const held = db
      .prepare(
        `SELECT id, status FROM observations
          WHERE status IN (${marks}) AND (status_reason IS NULL OR status_reason NOT LIKE '${MANUAL}%')`
      )
      .all(...managed);
    for (const r of held) {
      if (desired.has(r.id)) continue;
      changes.push({ id: r.id, from: r.status, to: 'active', by: null, reason: null });
    }
  }

  const counts = {};
  for (const c of changes) counts[c.to] = (counts[c.to] || 0) + 1;
  return { changes, counts, migrated: lc };
}

/** Undo every automatic mark (manual overrides stay). Read-only plan. */
export function planClear(db) {
  if (!hasLifecycle(db)) return { changes: [], counts: {}, migrated: false };
  const rows = db
    .prepare(
      `SELECT id, status FROM observations
        WHERE COALESCE(status,'active') NOT IN ('active', ${HIDDEN_SQL})
          AND (status_reason IS NULL OR status_reason NOT LIKE '${MANUAL}%')`
    )
    .all();
  const changes = rows.map((r) => ({ id: r.id, from: r.status, to: 'active', by: null, reason: null }));
  return { changes, counts: changes.length ? { active: changes.length } : {}, migrated: true };
}

/** Write a plan's changes in one transaction. Returns rows updated. */
export function applyLifecycle(db, plan, { now = Date.now() } = {}) {
  if (!plan || !plan.changes || !plan.changes.length) return 0;
  const up = db.prepare('UPDATE observations SET status = ?, superseded_by = ?, status_reason = ?, status_at = ? WHERE id = ?');
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const c of plan.changes) n += up.run(c.to, c.by, c.reason, now, c.id).changes;
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return n;
}

/** Status counts across the store (`active` includes NULL). */
export function lifecycleCounts(db) {
  if (!hasLifecycle(db)) return null;
  const out = { active: 0, superseded: 0, contested: 0, stale: 0, deleted: 0, duplicate: 0, manual: 0, pinned: 0 };
  for (const r of db.prepare("SELECT COALESCE(status,'active') s, COUNT(*) n FROM observations GROUP BY s").all())
    out[STATUSES.includes(r.s) || HIDDEN.has(r.s) ? r.s : 'active'] += r.n;
  out.manual = db.prepare(`SELECT COUNT(*) n FROM observations WHERE status_reason LIKE '${MANUAL}%'`).get().n;
  if (hasPins(db)) out.pinned = db.prepare('SELECT COUNT(*) n FROM observations WHERE pinned_at IS NOT NULL').get().n;
  return out;
}

// ── manual override ─────────────────────────────────────────────────────────

/**
 * Set one row's status by hand. The override sticks: automatic passes never
 * change a manual status. `status: 'auto'` drops the override (row goes back
 * to active and the next pass decides).
 *
 * @returns {{ok:boolean, id, from?, to?, error?}}
 */
export function markStatus(db, id, status, { by = null, note = '', now = Date.now() } = {}) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId) || rowId <= 0) return { ok: false, error: `not a row id: ${id}` };
  if (!hasLifecycle(db)) return { ok: false, error: 'this store has no lifecycle columns (not a migrated native store)' };
  const auto = status === 'auto';
  if (!auto && !STATUSES.includes(status)) return { ok: false, error: `status must be one of ${STATUSES.join(', ')} or auto` };
  const row = db.prepare('SELECT id, status FROM observations WHERE id = ?').get(rowId);
  if (!row) return { ok: false, error: `no observation #${rowId}` };
  let byId = null;
  if (status === 'superseded' && by != null) {
    byId = Number(by);
    if (!Number.isInteger(byId) || byId === rowId) return { ok: false, error: `bad --by id: ${by}` };
    if (!db.prepare('SELECT 1 FROM observations WHERE id = ?').get(byId)) return { ok: false, error: `no observation #${byId}` };
  }
  const reason = auto ? null : note ? `${MANUAL}: ${String(note).slice(0, 200)}` : MANUAL;
  db.prepare('UPDATE observations SET status = ?, superseded_by = ?, status_reason = ?, status_at = ? WHERE id = ?')
    .run(auto ? 'active' : status, byId, reason, now, rowId);
  return { ok: true, id: rowId, from: row.status || 'active', to: auto ? 'active (auto)' : status, by: byId };
}

/**
 * Write-time supersession: a freshly saved decision/fix retires the older
 * same-topic rows in its project (they point at it via superseded_by). Manual
 * statuses are left alone. Cheap: one indexed project query. Returns the ids
 * it retired. The full pass (planLifecycle) reaches the same end state.
 */
export function supersedeOlder(db, newId, { now = Date.now() } = {}) {
  if (!hasLifecycle(db)) return [];
  const row = db.prepare('SELECT id, project, type, title, created_at_epoch, status FROM observations WHERE id = ?').get(Number(newId));
  if (!row || !SUPERSEDABLE_TYPES.has(row.type) || HIDDEN.has(row.status)) return [];
  const topic = topicOf(row.title);
  if (topic.tokens.size < SUPERSEDE_MIN_SHARED) return [];
  const cands = db
    .prepare(
      `SELECT id, title, status, superseded_by, status_reason FROM observations
        WHERE project = ? AND type = ? AND id != ? AND title IS NOT NULL
          AND (created_at_epoch < ? OR (created_at_epoch = ? AND id < ?))`
    )
    .all(row.project, row.type, row.id, row.created_at_epoch, row.created_at_epoch, row.id);
  const up = db.prepare("UPDATE observations SET status = 'superseded', superseded_by = ?, status_reason = ?, status_at = ? WHERE id = ?");
  const reason = `newer #${row.id}: ${String(row.title).slice(0, 80)}`;
  const out = [];
  for (const c of cands) {
    if (isManual(c) || HIDDEN.has(c.status)) continue;
    if (c.status === 'superseded' && c.superseded_by === row.id) continue;
    if (!sameTopic(topic, topicOf(c.title))) continue;
    up.run(row.id, reason, now, c.id);
    out.push(c.id);
  }
  return out;
}

// ── store-level entry points (CLI, dream) ───────────────────────────────────

/** claude-mem owns its own schema: lifecycle never migrates or writes it. */
export function isForeignStore(dbPath) {
  try { return resolve(dbPath) === resolve(CLAUDE_MEM_DB); } catch { return false; }
}

/**
 * Open a store for lifecycle writes, migrating it if needed. The first
 * migration of a populated store is preceded by a verified VACUUM INTO backup
 * (the ALTERs are additive, but a 40k-row store gets a copy before its schema
 * changes). Returns { db, backupPath, added }.
 */
export function openForLifecycle(dbPath, { backupDir } = {}) {
  if (isForeignStore(dbPath)) throw new Error(`refusing to migrate claude-mem's own DB (${dbPath})`);
  const db = openDb(dbPath);
  try {
    if (!tableExists(db, 'observations')) throw new Error(`no observations table in ${dbPath}`);
    if (hasLifecycle(db)) return { db, backupPath: null, added: [] };
    let backupPath = null;
    const total = db.prepare('SELECT COUNT(*) n FROM observations').get().n;
    if (total > 0) {
      const dir = backupDir || join(dirname(dbPath), 'backups');
      mkdirSync(dir, { recursive: true });
      backupPath = join(dir, `pre-lifecycle-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      let ok = existsSync(backupPath);
      if (ok) {
        const v = openDb(backupPath, { readonly: true });
        try { ok = v.prepare('SELECT COUNT(*) n FROM observations').get().n === total; }
        catch { ok = false; }
        finally { v.close(); }
      }
      if (!ok) throw new Error(`backup verification failed (${backupPath}) — aborting, nothing changed`);
    }
    const added = ensureLifecycleSchema(db);
    return { db, backupPath, added };
  } catch (e) {
    try { db.close(); } catch {}
    throw e;
  }
}

/**
 * Plan (default) or apply the automatic lifecycle pass on one store.
 *
 * @param {object} opts
 * @param {string}  opts.dbPath    the store (required)
 * @param {boolean} [opts.apply]   false (default) = read-only report, even on an un-migrated store
 * @param {object}  [opts.findings] lint inputs: { contradictions, staleConcepts, liveConcepts }
 * @param {boolean} [opts.clear]   plan/undo every automatic mark instead
 */
export function runLifecycle(opts = {}) {
  const { dbPath, apply = false, findings = {}, clear = false, backupDir, now = Date.now() } = opts;
  if (!dbPath || !existsSync(dbPath)) throw new Error(`No DB at ${dbPath}`);
  const summarize = (plan) => ({
    counts: plan.counts,
    changes: plan.changes.length,
    sample: plan.changes.slice(0, 20),
  });
  if (!apply) {
    const db = openDb(dbPath, { readonly: true });
    try {
      const plan = clear ? planClear(db) : planLifecycle(db, findings);
      return { applied: false, migrated: hasLifecycle(db), current: lifecycleCounts(db), ...summarize(plan) };
    } finally { db.close(); }
  }
  const { db, backupPath, added } = openForLifecycle(dbPath, { backupDir });
  try {
    const plan = clear ? planClear(db) : planLifecycle(db, findings);
    const updated = applyLifecycle(db, plan, { now });
    // An explicit apply opts this machine in to the nightly pass; an explicit
    // clear opts it back out. Callers that only want one pass pass auto:false.
    if (opts.auto !== false) {
      try {
        if (clear) rmSync(autoMarkerPath(dbPath), { force: true });
        else writeFileSync(autoMarkerPath(dbPath), `${new Date(now).toISOString()}\n`, { mode: 0o600 });
      } catch { /* the marker is a preference; never fail an apply over it */ }
    }
    return { applied: true, migrated: true, added, backupPath, updated, current: lifecycleCounts(db), ...summarize(plan) };
  } finally {
    try { db.close(); } catch {}
  }
}

/** Human-readable report for `brain lifecycle`. */
export function formatLifecycleReport(r) {
  const L = [];
  const c = r.counts || {};
  const verb = r.applied ? 'marked' : 'would mark';
  L.push(r.applied ? 'Memory lifecycle — applied' : 'Memory lifecycle — dry run (nothing written; add --apply)');
  if (!r.migrated) L.push('  store not migrated yet: the first --apply adds the lifecycle columns (backup first)');
  if (r.backupPath) L.push(`  backup: ${r.backupPath}`);
  L.push(`  ${verb}: ${c.superseded || 0} superseded · ${c.contested || 0} contested · ${c.stale || 0} stale · ${c.active || 0} back to active`);
  if (r.current) {
    const k = r.current;
    const curated = [k.deleted ? `${k.deleted} deleted` : '', k.duplicate ? `${k.duplicate} merged duplicates` : '', k.pinned ? `${k.pinned} pinned` : ''].filter(Boolean).join(' · ');
    L.push(`  store now: ${k.active} active · ${k.superseded} superseded · ${k.contested} contested · ${k.stale} stale (${k.manual} manual)${curated ? ` · ${curated}` : ''}`);
  }
  for (const x of r.sample || []) L.push(`    #${x.id}: ${x.from} → ${x.to}${x.by ? ` (by #${x.by})` : ''}${x.reason ? ` — ${x.reason}` : ''}`);
  if (r.changes > (r.sample || []).length) L.push(`    … ${r.changes - r.sample.length} more`);
  return L.join('\n');
}
