// `brain clean` — targeted cleanups of the memory store.
//
// --self-capture: rows that are the brain's own headless runs (the distiller,
// learning drafts, explain, the parity judge) captured as if they were the
// user's work, plus every row derived from those sessions (a distilled
// observation, a claude-mem summary, the prompts, the distiller's bookkeeping).
// Detection lives in selfcapture.mjs, shared with ingest and merge;
// findSelfCapture is also what the claude-mem pull / cloud merge skip on.
//
// --test-data: every row of a test-fixture project (testdata.mjs's explicit
// name patterns — e2e probes, run-context fixtures, bare-UUID run dirs) plus its
// sessions' prompts, summaries and distill/ingest state. Transcript-path bookmarks
// are kept, so the same fixture transcripts are not re-ingested. --apply also
// records each removed project name (testdata.mjs CLEANED_TABLE): every capture
// and merge path skips those names from then on, so a later sync cannot put
// them back from claude-mem, the cloud blob or the exports.
//
// --dupes: effectively-identical copies of one memory in one project
// (dedupe.mjs). Nothing is deleted: every copy but one is HIDDEN (lifecycle
// status 'duplicate', content untouched, superseded_by = the row kept), the
// kept row gets +1 relevance per copy, and --undo brings them all back. Pinned
// copies and copies whose status the user set by hand stay visible.
//
// Dry-run is the default and opens the DB read-only. --apply makes a verified
// VACUUM INTO backup first and aborts, changing nothing, if that backup does not
// verify. Never prints row content — ids, counts and project names only.
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, tableExists } from './db.mjs';
import {
  isSelfSessionRow, isSelfObservationRow, selfPromptSessionIds,
} from './selfcapture.mjs';
import {
  testDataPattern, TEST_DATA_PATTERNS, recordCleanedProjects, readCleanedProjects, captureSkipper,
} from './testdata.mjs';
import { planDuplicates, markDuplicate, unmarkDuplicate, bumpRelevance, DUPLICATE } from './dedupe.mjs';
import { hasLifecycle, isForeignStore, isHiddenStatus, lifecycleCounts, liveOnly } from './lifecycle.mjs';
import { ensureLifecycleSchema } from './store.mjs';
import { pruneJournal } from './bulklog.mjs';

// Enough of each text column to see an opener (the explain pattern sits ~120
// chars in); keeps a 40k-row scan cheap.
const HEAD = 600;
// Per-session bookkeeping in capture_state: distiller.mjs STATE_KEY_PREFIX and
// ingest.mjs INGEST_STATE_PREFIX (the growth bookmark) and REGROWN_STATE_PREFIX
// (a distillation older than its grown text).
const STATE_PREFIXES = ['distill:', 'ingest:', 'regrown:'];

// Read-only: the ids of every self-capture row, by table.
export function findSelfCapture(db) {
  const has = (t) => tableExists(db, t);
  const out = { sessions: [], observations: [], prompts: [], summaries: [], state: [] };

  // 1. Sessions whose first prompt is ours — from sdk_sessions.user_prompt, or
  //    from the lowest-numbered user_prompts row (catches sessions whose
  //    user_prompt is empty, and prompts whose session row is missing).
  const promptCsids = has('user_prompts')
    ? selfPromptSessionIds(db.prepare(
        `SELECT content_session_id, prompt_number, substr(prompt_text, 1, ${HEAD}) AS prompt_text
           FROM user_prompts u
          WHERE prompt_number = (SELECT MIN(prompt_number) FROM user_prompts v
                                  WHERE v.content_session_id = u.content_session_id)`).all())
    : new Set();
  const csids = new Set(promptCsids);
  const msids = new Set();
  const projectOfCsid = new Map();
  if (has('sdk_sessions')) {
    const rows = db.prepare(
      `SELECT id, content_session_id, memory_session_id, project,
              substr(user_prompt, 1, ${HEAD}) AS user_prompt FROM sdk_sessions`).all();
    for (const r of rows) {
      if (!isSelfSessionRow(r) && !promptCsids.has(r.content_session_id)) continue;
      out.sessions.push({ id: r.id, project: r.project });
      csids.add(r.content_session_id);
      projectOfCsid.set(r.content_session_id, r.project);
      if (r.memory_session_id) msids.add(r.memory_session_id);
    }
  }

  // 2. Observations: everything filed under one of those sessions, plus any
  //    orphan whose own text is a captured run.
  if (has('observations')) {
    const rows = db.prepare(
      `SELECT id, memory_session_id, project, substr(title, 1, ${HEAD}) AS title,
              substr(text, 1, ${HEAD}) AS text, substr(narrative, 1, ${HEAD}) AS narrative
         FROM observations`).all();
    for (const r of rows) {
      if (msids.has(r.memory_session_id) || isSelfObservationRow(r)) out.observations.push({ id: r.id, project: r.project });
    }
  }

  // 3. Prompts, summaries and the distiller's per-session state for the same sessions.
  if (has('user_prompts') && csids.size) {
    for (const r of db.prepare('SELECT id, content_session_id FROM user_prompts').all()) {
      if (csids.has(r.content_session_id)) {
        out.prompts.push({ id: r.id, project: projectOfCsid.get(r.content_session_id) || '(no session row)' });
      }
    }
  }
  if (has('session_summaries') && msids.size) {
    for (const r of db.prepare('SELECT id, memory_session_id, project FROM session_summaries').all()) {
      if (msids.has(r.memory_session_id)) out.summaries.push({ id: r.id, project: r.project });
    }
  }
  if (has('capture_state') && msids.size) {
    const q = db.prepare('SELECT transcript_path FROM capture_state WHERE transcript_path = ?');
    // Per-segment distiller state: 'distill:<mem>#<segmentId>' (distiller.mjs SEGMENTS).
    const qSeg = db.prepare(`SELECT transcript_path FROM capture_state WHERE transcript_path LIKE ? ESCAPE '\\'`);
    for (const m of msids) {
      for (const prefix of STATE_PREFIXES) {
        const r = q.get(prefix + m);
        if (r) out.state.push({ id: r.transcript_path });
      }
      const like = 'distill:' + m.replace(/[\\%_]/g, (c) => '\\' + c) + '#%';
      for (const r of qSeg.all(like)) out.state.push({ id: r.transcript_path });
    }
  }
  return out;
}

// Read-only: the ids of every test-fixture row, by table (findSelfCapture's
// shape; each row also carries the pattern id its project matched).
// `match(project)` returns a pattern id or null: the default is every pattern
// (what `brain clean` removes); the import / strip paths pass a narrower one
// (testDataSkipMatcher: auto patterns + names already removed).
export function findTestData(db, { match = testDataPattern } = {}) {
  const has = (t) => tableExists(db, t);
  const out = { sessions: [], observations: [], prompts: [], summaries: [], state: [] };
  const patternOf = new Map();
  for (const t of ['observations', 'sdk_sessions', 'session_summaries']) {
    if (!has(t)) continue;
    for (const { project } of db.prepare(`SELECT DISTINCT project FROM ${t}`).all()) {
      const id = match(project);
      if (id) patternOf.set(project, id);
    }
  }
  if (!patternOf.size) return out;

  const csids = new Map(); // content_session_id -> project
  const msids = new Set();
  if (has('sdk_sessions')) {
    const q = db.prepare('SELECT id, content_session_id, memory_session_id FROM sdk_sessions WHERE project = ?');
    for (const [project, pattern] of patternOf) {
      for (const r of q.all(project)) {
        out.sessions.push({ id: r.id, project, pattern });
        csids.set(r.content_session_id, project);
        if (r.memory_session_id) msids.add(r.memory_session_id);
      }
    }
  }
  if (has('observations')) {
    const q = db.prepare('SELECT id FROM observations WHERE project = ?');
    for (const [project, pattern] of patternOf) {
      for (const r of q.all(project)) out.observations.push({ id: r.id, project, pattern });
    }
  }
  if (has('user_prompts') && csids.size) {
    for (const r of db.prepare('SELECT id, content_session_id FROM user_prompts').all()) {
      const project = csids.get(r.content_session_id);
      if (project) out.prompts.push({ id: r.id, project, pattern: patternOf.get(project) });
    }
  }
  if (has('session_summaries')) {
    const q = db.prepare('SELECT id FROM session_summaries WHERE project = ?');
    for (const [project, pattern] of patternOf) {
      for (const r of q.all(project)) out.summaries.push({ id: r.id, project, pattern });
    }
  }
  if (has('capture_state') && msids.size) {
    const q = db.prepare('SELECT transcript_path FROM capture_state WHERE transcript_path = ?');
    // Per-segment distiller state: 'distill:<mem>#<segmentId>' (distiller.mjs SEGMENTS).
    const qSeg = db.prepare(`SELECT transcript_path FROM capture_state WHERE transcript_path LIKE ? ESCAPE '\\'`);
    for (const m of msids) {
      for (const prefix of STATE_PREFIXES) {
        const r = q.get(prefix + m);
        if (r) out.state.push({ id: r.transcript_path });
      }
      const like = 'distill:' + m.replace(/[\\%_]/g, (c) => '\\' + c) + '#%';
      for (const r of qSeg.all(like)) out.state.push({ id: r.transcript_path });
    }
  }
  return out;
}

// findTestData's `match` for every capture / merge path: the auto patterns plus
// any project name `clean --test-data --apply` already removed (from each of the
// given DBs' CLEANED_TABLE — typically the destination and the source).
export function testDataSkipMatcher(...dbs) {
  const skip = captureSkipper(...dbs.filter(Boolean).map(readCleanedProjects));
  return (project) => (skip(project) ? (testDataPattern(project) || 'cleaned') : null);
}

// Counts per table and per project (projects sorted by observation count).
export function summarize(found) {
  const totals = {};
  const by = new Map();
  for (const table of ['observations', 'sessions', 'prompts', 'summaries', 'state']) {
    totals[table] = found[table].length;
    if (table === 'state') continue;
    for (const r of found[table]) {
      const p = r.project || '(none)';
      if (!by.has(p)) by.set(p, { project: p, observations: 0, sessions: 0, prompts: 0, summaries: 0 });
      if (r.pattern) by.get(p).pattern = r.pattern;
      by.get(p)[table]++;
    }
  }
  const byProject = [...by.values()].sort((a, b) => b.observations - a.observations || b.sessions - a.sessions);
  return { totals, byProject };
}

export function formatSelfCaptureReport(r) {
  const L = [];
  const t = r.totals;
  L.push(`${r.applied ? '🧹 Removed' : '🔎 Would remove (dry run)'} self-capture rows — the brain's own headless runs:`);
  L.push(`  observations ${t.observations} · sessions ${t.sessions} · prompts ${t.prompts} · summaries ${t.summaries} · distill/ingest state ${t.state}`);
  if (r.observationsTotal != null) {
    const pct = r.observationsTotal ? ((t.observations / r.observationsTotal) * 100).toFixed(1) : '0.0';
    L.push(`  = ${pct}% of ${r.observationsTotal} observations`);
  }
  if (r.byProject.length) {
    L.push('  by project:');
    L.push(`    ${'project'.padEnd(28)} ${'obs'.padStart(7)} ${'sessions'.padStart(9)} ${'prompts'.padStart(8)} ${'summaries'.padStart(10)}`);
    for (const p of r.byProject) {
      L.push(`    ${String(p.project).slice(0, 28).padEnd(28)} ${String(p.observations).padStart(7)} ${String(p.sessions).padStart(9)} ${String(p.prompts).padStart(8)} ${String(p.summaries).padStart(10)}`);
    }
  }
  if (r.applied) {
    L.push(`  backup: ${r.backupPath}`);
    L.push(`  remaining after clean: ${r.remaining}`);
    for (const w of r.warnings || []) L.push(`  ⚠ ${w}`);
  } else if (t.observations + t.sessions + t.prompts + t.summaries + t.state > 0) {
    L.push('  Re-run with --apply to remove them (a verified backup is made first).');
  }
  return L.join('\n');
}

const TABLES = [
  // [found key, table, id column]
  ['observations', 'observations', 'id'],
  ['prompts', 'user_prompts', 'id'],
  ['summaries', 'session_summaries', 'id'],
  ['state', 'capture_state', 'transcript_path'],
  ['sessions', 'sdk_sessions', 'id'],
];

// An FTS shadow table with no AFTER DELETE trigger on its base table (claude-mem's
// session_summaries_fts ships without one) keeps deleted text searchable.
function ftsNeedsRebuild(db, table) {
  const fts = `${table}_fts`;
  if (!tableExists(db, fts)) return null;
  const trig = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND upper(sql) LIKE '%AFTER DELETE%' LIMIT 1`).get(table);
  return trig ? null : fts;
}

// Delete every row in `found` (findSelfCapture's shape). No backup here — the
// callers own that: cleanSelfCapture backs up first, and stripSelfCaptureCopy
// only ever runs on a throwaway copy. Returns warnings.
function deleteFound(db, found, { batchSize = 500 } = {}) {
  const warnings = [];
  // Chunked transactions: the ingest/distill timers share this store, and a
  // short write lock per chunk lets them interleave (busy_timeout covers the rest).
  for (const [key, table, idCol] of TABLES) {
    const ids = found[key].map((r) => r.id);
    if (!ids.length || !tableExists(db, table)) continue;
    const del = db.prepare(`DELETE FROM ${table} WHERE ${idCol} = ?`);
    for (let i = 0; i < ids.length; i += batchSize) {
      db.exec('BEGIN');
      try {
        for (const id of ids.slice(i, i + batchSize)) del.run(id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw new Error(`clean failed on ${table}: ${e.message}`);
      }
    }
    const fts = ftsNeedsRebuild(db, table);
    if (fts) {
      try { db.exec(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`); }
      catch (e) { warnings.push(`${fts} rebuild failed (${e.message}) — run 'brain doctor'`); }
    }
  }
  pruneJournal(db); // bulk-change journal entries (bulklog.mjs) of the deleted rows go too
  // Full transcripts (segments.mjs) of sessions that no longer exist.
  if (tableExists(db, 'session_transcripts') && tableExists(db, 'sdk_sessions')) {
    try { db.exec('DELETE FROM session_transcripts WHERE memory_session_id NOT IN (SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id IS NOT NULL)'); }
    catch (e) { warnings.push(`orphan transcripts not removed (${e.message})`); }
  }
  return warnings;
}

// Strip self-capture rows from a DB that is a THROWAWAY copy fetched from
// elsewhere (the cloud blob just extracted to a temp dir), before it is copied
// into place on a machine with no store yet. Never call it on a live store —
// cleanSelfCapture is that path, with its backup. Returns rows removed.
// (stripCopy below is what bundle.mjs uses: this plus test data.)
export function stripSelfCaptureCopy(dbPath) {
  const db = openDb(dbPath);
  try {
    const found = findSelfCapture(db);
    deleteFound(db, found);
    return Object.values(summarize(found).totals).reduce((a, b) => a + b, 0);
  } finally {
    try { db.close(); } catch {}
  }
}

// The whole-file copy paths (first pull onto a new machine, restore with no
// local store) bypass the importer and its skips, so the throwaway copy gets
// both strips first: the brain's own runs, and test-fixture projects (auto
// patterns + whatever the copy itself records as already removed). Returns rows
// removed per kind. Same "never on a live store" rule as above.
export function stripCopy(dbPath) {
  const db = openDb(dbPath);
  try {
    const count = (found) => Object.values(summarize(found).totals).reduce((a, b) => a + b, 0);
    const self = findSelfCapture(db);
    deleteFound(db, self);
    const test = findTestData(db, { match: testDataSkipMatcher(db) });
    deleteFound(db, test);
    return { selfCapture: count(self), testData: count(test) };
  } finally {
    try { db.close(); } catch {}
  }
}

// Backup first, verified, or nothing changes. VACUUM INTO writes a new file
// and never touches the source's WAL (same approach as scrub --apply). Throws
// (the caller has changed nothing yet) unless the copy passes quick_check and
// holds every observation. Returns the backup's path.
export function verifiedBackup(db, dbPath, { backupDir, label, observationsTotal }) {
  const dir = backupDir || join(dirname(dbPath), 'backups');
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, `pre-clean-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  // VACUUM INTO creates the file with the umask's mode (0644); it is a full
  // copy of a 0600 store, so give it the store's privacy.
  try { chmodSync(backupPath, 0o600); } catch {}
  let backupOk = existsSync(backupPath);
  if (backupOk) {
    const v = openDb(backupPath, { readonly: true });
    try {
      backupOk = v.prepare('PRAGMA quick_check').get()?.quick_check === 'ok' &&
        v.prepare('SELECT COUNT(*) n FROM observations').get().n === observationsTotal;
    } catch { backupOk = false; }
    finally { v.close(); }
  }
  if (!backupOk) throw new Error(`Backup verification failed (${backupPath}) — aborting, nothing changed.`);
  return backupPath;
}

// Shared dry-run / backup-then-delete runner for every `brain clean` mode.
// `find` is a read-only finder (findSelfCapture / findTestData); `label` names
// the backup file; `afterDelete(db, found)` runs on the write connection once
// the rows are gone (test-data records the removed names there).
function runClean({ dbPath, apply = false, backupDir, batchSize = 500, find, label, afterDelete = null }) {
  if (!dbPath || !existsSync(dbPath)) throw new Error(`No DB at ${dbPath}`);
  if (!apply) {
    const db = openDb(dbPath, { readonly: true });
    try {
      const found = find(db);
      const observationsTotal = tableExists(db, 'observations') ? db.prepare('SELECT COUNT(*) n FROM observations').get().n : 0;
      return { applied: false, observationsTotal, ...summarize(found) };
    } finally { db.close(); }
  }

  const db = openDb(dbPath);
  try {
    const observationsTotal = tableExists(db, 'observations') ? db.prepare('SELECT COUNT(*) n FROM observations').get().n : 0;
    const found = find(db);
    const summary = summarize(found);
    const n = Object.values(summary.totals).reduce((a, b) => a + b, 0);
    if (!n) return { applied: true, observationsTotal, ...summary, backupPath: null, remaining: 0 };

    const backupPath = verifiedBackup(db, dbPath, { backupDir, label, observationsTotal });

    let warnings;
    try {
      warnings = deleteFound(db, found, { batchSize });
      if (afterDelete) afterDelete(db, found);
    } catch (e) { throw new Error(`${e.message} (backup intact at ${backupPath})`); }
    const left = summarize(find(db));
    const remaining = Object.values(left.totals).reduce((a, b) => a + b, 0);
    return { applied: true, observationsTotal, ...summary, backupPath, remaining, warnings };
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * @param {object} opts
 * @param {string}  opts.dbPath   the store (required — never resolved implicitly here)
 * @param {boolean} [opts.apply]  false (default) = read-only report
 * @param {string}  [opts.backupDir] default: <db dir>/backups
 */
export function cleanSelfCapture({ dbPath, apply = false, backupDir, batchSize = 500 } = {}) {
  return runClean({ dbPath, apply, backupDir, batchSize, find: findSelfCapture, label: 'self-capture' });
}

// `brain clean --test-data`: same contract as cleanSelfCapture (dry run by
// default; --apply only behind a verified VACUUM INTO backup).
export function cleanTestData({ dbPath, apply = false, backupDir, batchSize = 500 } = {}) {
  return runClean({
    dbPath, apply, backupDir, batchSize, find: findTestData, label: 'test-data',
    // Remember every removed project name, so no capture / merge path brings it
    // back (testdata.mjs CLEANED_TABLE) — the clean has to stick past the next sync.
    afterDelete: (db, found) => {
      const seen = new Map();
      for (const k of ['observations', 'sessions', 'summaries', 'prompts']) {
        for (const r of found[k]) if (r.project && r.pattern && !seen.has(r.project)) seen.set(r.project, r.pattern);
      }
      recordCleanedProjects(db, [...seen].map(([project, pattern]) => ({ project, pattern })));
    },
  });
}

export function formatTestDataReport(r) {
  const L = [];
  const t = r.totals;
  L.push(`${r.applied ? '🧹 Removed' : '🔎 Would remove (dry run)'} test-fixture rows — projects named like a harness's throwaway run:`);
  L.push(`  observations ${t.observations} · sessions ${t.sessions} · prompts ${t.prompts} · summaries ${t.summaries} · distill/ingest state ${t.state}`);
  if (r.observationsTotal != null) {
    const pct = r.observationsTotal ? ((t.observations / r.observationsTotal) * 100).toFixed(2) : '0.00';
    L.push(`  = ${pct}% of ${r.observationsTotal} observations · ${r.byProject.length} project(s)`);
  }
  if (r.byProject.length) {
    const byPattern = new Map();
    for (const p of r.byProject) {
      const k = p.pattern || '?';
      if (!byPattern.has(k)) byPattern.set(k, []);
      byPattern.get(k).push(p);
    }
    for (const pat of TEST_DATA_PATTERNS) {
      const rows = byPattern.get(pat.id);
      if (!rows) continue;
      const obs = rows.reduce((a, p) => a + p.observations, 0);
      L.push(`  ${pat.id} — ${pat.why}: ${rows.length} project(s), ${obs} obs`);
      for (const p of rows) {
        L.push(`    ${String(p.project).slice(0, 48).padEnd(48)} obs ${String(p.observations).padStart(4)} · sessions ${String(p.sessions).padStart(3)} · prompts ${String(p.prompts).padStart(3)} · summaries ${String(p.summaries).padStart(3)}`);
      }
    }
  }
  if (r.applied) {
    L.push(`  backup: ${r.backupPath}`);
    L.push(`  remaining after clean: ${r.remaining}`);
    if (r.byProject.length) L.push('  removed project names are remembered — capture and sync skip them from now on');
    for (const w of r.warnings || []) L.push(`  ⚠ ${w}`);
  } else if (t.observations + t.sessions + t.prompts + t.summaries + t.state > 0) {
    L.push('  Re-run with --apply to remove them (a verified backup is made first).');
    L.push('  Removed names are remembered so the next sync cannot bring them back.');
  }
  return L.join('\n');
}

// ── --dupes ─────────────────────────────────────────────────────────────────

const blankVisible = (db) =>
  db.prepare(`SELECT COUNT(*) n FROM observations o WHERE TRIM(COALESCE(o.title, '')) = ''${liveOnly(db)}`).get().n;

// Counts per project, sorted by rows hidden.
function dupesByProject(groups) {
  const by = new Map();
  for (const g of groups) {
    const p = g.project || '(none)';
    if (!by.has(p)) by.set(p, { project: p, groups: 0, copies: 0 });
    by.get(p).groups++;
    by.get(p).copies += g.copies.length;
  }
  return [...by.values()].sort((a, b) => b.copies - a.copies);
}

function dupesSummary(db, plan) {
  const copies = plan.groups.reduce((a, g) => a + g.copies.length, 0);
  const kept = plan.groups.reduce((a, g) => a + g.kept.length, 0);
  // How much of it is the brain's own runs, which --self-capture removes
  // outright (that clean is the better fix for those rows).
  let selfCapture = 0;
  try {
    const self = new Set(findSelfCapture(db).observations.map((r) => r.id));
    for (const g of plan.groups) for (const id of g.copies) if (self.has(id)) selfCapture++;
  } catch {}
  return {
    scanned: plan.scanned, groups: plan.groups.length, copies, keptVisible: kept,
    selfCapture, sameTitleDifferent: plan.sameTitleDifferent, keyless: plan.keyless,
    byProject: dupesByProject(plan.groups),
    sample: plan.groups.slice(0, 10).map((g) => ({ project: g.project, keep: g.survivor, hide: g.copies.slice(0, 8), more: Math.max(0, g.copies.length - 8) })),
  };
}

/**
 * `brain clean --dupes`: hide every effectively-identical copy of a memory
 * but one (dedupe.mjs). Dry run by default (read-only open). --apply: verified
 * backup, then — if the store has no lifecycle columns yet — the additive
 * lifecycle migration, then the copies are marked in chunked transactions.
 * `undo` plans/brings back every hidden duplicate instead.
 */
export function cleanDupes({ dbPath, apply = false, undo = false, backupDir, batchSize = 500, now = Date.now() } = {}) {
  if (!dbPath || !existsSync(dbPath)) throw new Error(`No DB at ${dbPath}`);
  if (apply && isForeignStore(dbPath)) throw new Error(`refusing to change claude-mem's own DB (${dbPath})`);
  const total = (db) => (tableExists(db, 'observations') ? db.prepare('SELECT COUNT(*) n FROM observations').get().n : 0);
  const hiddenIds = (db) => (hasLifecycle(db)
    ? db.prepare('SELECT id FROM observations WHERE status = ?').all(DUPLICATE).map((r) => r.id)
    : []);

  if (!apply) {
    const db = openDb(dbPath, { readonly: true });
    try {
      const base = { applied: false, undo, migrated: hasLifecycle(db), observationsTotal: total(db), blankVisible: blankVisible(db) };
      if (undo) return { ...base, restore: hiddenIds(db).length };
      return { ...base, ...dupesSummary(db, planDuplicates(db)) };
    } finally { db.close(); }
  }

  const db = openDb(dbPath);
  try {
    const observationsTotal = total(db);
    if (undo) {
      const ids = hiddenIds(db);
      if (!ids.length) return { applied: true, undo, observationsTotal, restore: 0, restored: 0, backupPath: null };
      const backupPath = verifiedBackup(db, dbPath, { backupDir, label: 'dupes-undo', observationsTotal });
      let restored = 0;
      try {
        for (let i = 0; i < ids.length; i += batchSize) {
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const id of ids.slice(i, i + batchSize)) restored += unmarkDuplicate(db, id, { now }) ? 1 : 0;
            db.exec('COMMIT');
          } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
        }
      } catch (e) { throw new Error(`undo failed: ${e.message} (backup intact at ${backupPath})`); }
      return { applied: true, undo, observationsTotal, restore: ids.length, restored, backupPath, current: lifecycleCounts(db) };
    }

    const blankBefore = blankVisible(db);
    const first = planDuplicates(db);
    if (!first.groups.length) {
      return { applied: true, undo, migrated: hasLifecycle(db), observationsTotal, ...dupesSummary(db, first), hidden: 0, remaining: 0, backupPath: null, blankVisible: blankBefore, blankAfter: blankBefore };
    }
    const backupPath = verifiedBackup(db, dbPath, { backupDir, label: 'dupes', observationsTotal });
    let addedColumns = [];
    let hidden = 0;
    let plan;
    try {
      // The lifecycle columns are additive (ALTER TABLE ADD COLUMN); the backup
      // above is what lifecycle.mjs openForLifecycle would make first.
      if (!hasLifecycle(db)) addedColumns = ensureLifecycleSchema(db);
      plan = planDuplicates(db);
      const live = db.prepare('SELECT status FROM observations WHERE id = ?');
      for (let i = 0; i < plan.groups.length; i += batchSize) {
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const g of plan.groups.slice(i, i + batchSize)) {
            // The kept row must still be live when its copies go out of view.
            const s = live.get(g.survivor);
            if (!s || isHiddenStatus(s.status)) continue;
            for (const id of g.copies) {
              if (markDuplicate(db, id, g.survivor, { now, relevanceAdded: 1 })) {
                bumpRelevance(db, g.survivor);
                hidden++;
              }
            }
          }
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
      }
    } catch (e) { throw new Error(`clean failed: ${e.message} (backup intact at ${backupPath})`); }
    const after = planDuplicates(db);
    return {
      applied: true, undo, migrated: true, addedColumns, observationsTotal, ...dupesSummary(db, plan), hidden,
      remaining: after.groups.reduce((a, g) => a + g.copies.length, 0),
      blankVisible: blankBefore, blankAfter: blankVisible(db),
      observationsAfter: total(db), backupPath, current: lifecycleCounts(db),
    };
  } finally {
    try { db.close(); } catch {}
  }
}

export function formatDupesReport(r) {
  const L = [];
  if (r.undo) {
    L.push(r.applied ? `↺ Brought back ${r.restored ?? 0} hidden duplicate(s)` : `🔎 Would bring back ${r.restore} hidden duplicate(s) (dry run)`);
    if (r.backupPath) L.push(`  backup: ${r.backupPath}`);
    else if (!r.applied && r.restore) L.push('  Re-run with --apply to restore them (a verified backup is made first).');
    return L.join('\n');
  }
  L.push(r.applied ? '🧹 Merged duplicate memories (copies hidden, nothing deleted):' : '🔎 Would merge duplicate memories (dry run — nothing written):');
  const pct = r.observationsTotal ? ((r.copies / r.observationsTotal) * 100).toFixed(1) : '0.0';
  L.push(`  ${r.groups} memories held more than once · ${r.copies} copies to hide (${pct}% of ${r.observationsTotal} rows) · scanned ${r.scanned} live rows`);
  if (r.selfCapture) L.push(`  ${r.selfCapture} of those copies are the brain's own runs — 'brain clean --self-capture' removes them outright; ${r.copies - r.selfCapture} are copies of real work`);
  L.push(`  left alone: ${r.sameTitleDifferent} same-title groups whose content differs · ${r.keptVisible} pinned/hand-set copies · ${r.keyless} rows with nothing to compare`);
  if (r.byProject && r.byProject.length) {
    L.push('  by project:');
    for (const p of r.byProject.slice(0, 12)) L.push(`    ${String(p.project).slice(0, 48).padEnd(48)} ${String(p.groups).padStart(6)} memories ${String(p.copies).padStart(7)} copies`);
    if (r.byProject.length > 12) L.push(`    … ${r.byProject.length - 12} more project(s)`);
  }
  for (const g of r.sample || []) L.push(`    keep #${g.keep} · hide ${g.hide.map((i) => `#${i}`).join(' ')}${g.more ? ` (+${g.more})` : ''} [${String(g.project).slice(0, 30)}]`);
  if (!r.migrated && !r.applied) L.push('  store not migrated yet: --apply adds the lifecycle columns first (after the backup)');
  if (r.applied) {
    if (r.backupPath) L.push(`  backup: ${r.backupPath}`);
    L.push(`  hidden now: ${r.hidden} · copies still visible: ${r.remaining} · rows in store: ${r.observationsAfter ?? r.observationsTotal} (unchanged — nothing deleted)`);
    L.push(`  visible rows with no title: ${r.blankVisible} before → ${r.blankAfter} after`);
    L.push("  undo: 'brain clean --dupes --undo --apply'");
  } else if (r.copies) {
    L.push('  Re-run with --apply to hide the copies (a verified backup is made first; --undo brings them back).');
  }
  return L.join('\n');
}
