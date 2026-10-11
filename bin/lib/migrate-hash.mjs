// `brain migrate-hash` — rewrite old native rows' content_hash from the v1
// 32-bit FNV-1a to the strong v2 hash (hash.mjs). Opt-in: nothing needs it to
// keep working (every dedupe path already recognises both versions), it only
// retires the collision-prone hashes.
//
// Dry-run is the default and opens the store read-only. --apply makes a
// verified VACUUM INTO backup first and aborts, changing nothing, if that backup
// does not verify. Never prints row content — ids, counts and hashes only.
//
// Every machine that shares this brain must run a build with this module (one
// that knows both hash versions) BEFORE any of them runs --apply. An older build
// dedupes by the stored hash alone, so after the next sync it would take every
// rewritten row for a new memory and keep both copies.
//
// What is rewritten, and what is not:
//   - only rows whose CURRENT content reproduces their stored v1 hash (hash.mjs
//     reproduce(): the raw transcript, or the canonical title/subtitle/facts/
//     narrative string). The new hash is then exactly what a fresh capture of
//     the same content gets on any machine, which is what keeps two machines'
//     copies of one memory equal after either (or both) migrate;
//   - never claude-mem's own rows (their hashes are claude-mem's; the importer
//     copies them verbatim), never a row curated or near-dup-merged after capture
//     in a way that changed the hashed content (an edit keeps content_hash, so
//     its content no longer reproduces it — its v1 hash stays its identity),
//     never a row already on v2;
//   - the old hash is ADDED to metadata as legacy_content_hash (json_set: every
//     other key — edited_at, distiller provenance — stays exactly as it is), so a
//     machine that has not migrated still matches the row; a row whose metadata
//     is not a JSON object is left as it is;
//   - a rewrite that would collide on the unique (memory_session_id,
//     content_hash) index is skipped and reported, never forced.
//
// Concurrency: the plan is only a list of candidates. Each row is re-read and
// re-checked inside the BEGIN IMMEDIATE write transaction that rewrites it —
// nobody else can write between that read and the UPDATE — so an edit made
// while the backup ran (the panel, ingest, the distiller) is either still
// compatible (the content still reproduces the hash: the row is rewritten and
// the edit's metadata kept) or makes the row skip, never lost. Each rewrite is
// read back under a SAVEPOINT and rolled back alone if it does not check out.
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDb, tableExists } from './db.mjs';
import { reproduce, strongHash, isStrongHash, isLegacyShaped, legacyFromMetadata, LEGACY_META_KEY } from './hash.mjs';

const SEP = '\u0000';
const SAMPLE = 20;
const CONTENT = ['memory_session_id', 'project', 'text', 'title', 'subtitle', 'facts', 'narrative'];

function columns(db) {
  return new Set(db.prepare('PRAGMA table_info(observations)').all().map((c) => c.name));
}

function metadataObject(cell) {
  if (cell == null || cell === '') return {};
  try {
    const v = JSON.parse(cell);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

const rowSelect = (cols) =>
  ['id', 'memory_session_id', 'project', 'content_hash', 'text', 'title', 'subtitle', 'facts', 'narrative', 'metadata']
    .map((c) => (cols.has(c) ? c : `NULL AS ${c}`)).join(', ');

// The verdict for one row as it is now: { to, input, recipe } to rewrite, or
// { skip: <reason> }.
function judge(r, hasMeta) {
  const h = r.content_hash;
  if (typeof h !== 'string' || !h) return { skip: 'noHash' };
  if (isStrongHash(h)) return { skip: 'alreadyStrong' };
  const rep = reproduce(r);
  if (!rep || rep.version !== 'legacy') {
    return { skip: isLegacyShaped(h) && h.length !== 16 ? 'unreproducible' : 'foreign' };
  }
  if (!hasMeta || !metadataObject(r.metadata)) return { skip: 'badMetadata' };
  return { to: strongHash(rep.input), recipe: rep.recipe };
}

// Read-only. The candidate list, plus counts.
function planMigration(db) {
  const out = {
    total: 0, alreadyStrong: 0, toMigrate: 0, byRecipe: { text: 0, canonical: 0 },
    unreproducible: 0, foreign: 0, noHash: 0, conflicts: 0, badMetadata: 0,
    sample: [], conflictIds: [], rows: [],
  };
  if (!tableExists(db, 'observations')) return out;
  const cols = columns(db);
  if (!cols.has('content_hash')) return out;
  const hasMeta = cols.has('metadata');
  // Every (session, hash) the store already holds — the unique index's view.
  const taken = new Set();
  for (const r of db.prepare('SELECT memory_session_id, content_hash FROM observations WHERE content_hash IS NOT NULL').iterate()) {
    taken.add(`${r.memory_session_id ?? ''}${SEP}${r.content_hash}`);
  }
  for (const r of db.prepare(`SELECT ${rowSelect(cols)} FROM observations ORDER BY id`).iterate()) {
    out.total++;
    const v = judge(r, hasMeta);
    if (v.skip) { out[v.skip]++; continue; }
    const key = `${r.memory_session_id ?? ''}${SEP}${v.to}`;
    if (taken.has(key)) {
      out.conflicts++;
      if (out.conflictIds.length < SAMPLE) out.conflictIds.push(r.id);
      continue;
    }
    taken.add(key);
    out.rows.push({ id: r.id, from: r.content_hash, to: v.to });
    out.toMigrate++;
    out.byRecipe[v.recipe]++;
    if (out.sample.length < SAMPLE) out.sample.push({ id: r.id, from: r.content_hash, to: v.to, recipe: v.recipe });
  }
  return out;
}

// One digest over every observation row, every column — what the backup must
// match before anything is rewritten.
function cell(v) {
  if (v == null) return '\u0001';
  if (v instanceof Uint8Array) return `b${Buffer.from(v).toString('hex')}`;
  return `${typeof v}:${String(v)}`;
}
function storeDigest(db) {
  const h = createHash('sha256');
  let n = 0;
  if (tableExists(db, 'observations')) {
    for (const r of db.prepare('SELECT * FROM observations ORDER BY id').iterate()) {
      for (const k of Object.keys(r)) h.update(`${k}${SEP}${cell(r[k])}${SEP}`);
      h.update('\n');
      n++;
    }
  }
  return { n, digest: h.digest('hex') };
}

function integrityOk(db) {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    return rows.length === 1 && Object.values(rows[0])[0] === 'ok';
  } catch { return false; }
}

function ftsCheck(db) {
  if (!tableExists(db, 'observations_fts')) return true;
  try { db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('integrity-check')`); return true; }
  catch { return false; }
}

const without = (o, k) => { const c = { ...o }; delete c[k]; return JSON.stringify(c); };

/**
 * @param {object}  opts
 * @param {string}  opts.dbPath     the store (required)
 * @param {boolean} [opts.apply]    false (default) = read-only report
 * @param {string}  [opts.backupDir] default: <db dir>/backups
 * @param {number}  [opts.batchSize] rows per transaction (default 500)
 * @param {Function} [opts.onBackedUp] called after the verified backup, before
 *                  any row is rewritten (tests use it to play a concurrent writer)
 */
export function migrateHash({ dbPath, apply = false, backupDir, batchSize = 500, onBackedUp } = {}) {
  if (!dbPath || !existsSync(dbPath)) throw new Error(`No DB at ${dbPath}`);
  const strip = ({ rows, ...rest }) => rest;
  if (!apply) {
    const db = openDb(dbPath, { readonly: true });
    try { return { applied: false, dbPath, ...strip(planMigration(db)) }; }
    finally { db.close(); }
  }

  const db = openDb(dbPath);
  try {
    const plan = planMigration(db);
    if (!plan.toMigrate) return { applied: true, dbPath, ...strip(plan), migrated: 0, raced: 0, backupPath: null, verified: true };

    // Backup first, verified, or nothing changes (same contract as `brain clean`):
    // a sound file whose observations equal, row for row and column for column,
    // what the store held just before it was taken.
    const dir = backupDir || join(dirname(dbPath), 'backups');
    mkdirSync(dir, { recursive: true });
    const backupPath = join(dir, `pre-migrate-hash-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    const ftsBefore = ftsCheck(db);
    const before = storeDigest(db);
    let why = 'not written';
    try {
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      try { chmodSync(backupPath, 0o600); } catch {}
      if (existsSync(backupPath)) {
        const v = openDb(backupPath, { readonly: true });
        try {
          if (!integrityOk(v)) why = 'integrity_check failed';
          else {
            const b = storeDigest(v);
            why = b.n === before.n && b.digest === before.digest
              ? null
              : 'it differs from the store (another writer changed it while it was copied — re-run)';
          }
        } finally { v.close(); }
      }
    } catch (e) { why = e.message; }
    if (why) throw new Error(`Backup verification failed (${backupPath}: ${why}) — aborting, nothing changed.`);
    if (typeof onBackedUp === 'function') onBackedUp({ backupPath });

    const cols = columns(db);
    const hasMeta = cols.has('metadata');
    const get = db.prepare(`SELECT ${rowSelect(cols)} FROM observations WHERE id = ?`);
    const clash = db.prepare('SELECT 1 AS x FROM observations WHERE memory_session_id IS ? AND content_hash = ? AND id <> ? LIMIT 1');
    // json_set, not a whole-column write: keys another writer added since the
    // plan (edited_at, …) are kept. The CAS on content_hash is belt and braces —
    // the row was just re-read inside this same write transaction.
    const upd = db.prepare(
      `UPDATE observations SET content_hash = ?,
         metadata = json_set(CASE WHEN metadata IS NULL OR metadata = '' THEN '{}' ELSE metadata END, '$.${LEGACY_META_KEY}', ?)
       WHERE id = ? AND content_hash = ?`
    );
    let migrated = 0, raced = 0, verifyFailures = 0, conflicts = plan.conflicts;
    const failedIds = [];
    try {
      for (let i = 0; i < plan.rows.length; i += batchSize) {
        const chunk = plan.rows.slice(i, i + batchSize);
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const p of chunk) {
            const cur = get.get(p.id);
            if (!cur || cur.content_hash !== p.from) { raced++; continue; }
            const v = judge(cur, hasMeta);
            if (v.skip) { raced++; continue; }
            if (clash.get(cur.memory_session_id ?? null, v.to, cur.id)) { conflicts++; continue; }
            db.exec('SAVEPOINT mh_row');
            let res;
            try { res = upd.run(v.to, p.from, cur.id, p.from); }
            catch (e) {
              db.exec('ROLLBACK TO mh_row'); db.exec('RELEASE mh_row');
              // ux_observations_session_hash: the key is taken.
              if (/UNIQUE/i.test(String(e.message))) { conflicts++; continue; }
              throw e;
            }
            // Read it back before it is kept: the new hash its content
            // reproduces, the old one remembered, every other column and
            // metadata key exactly as they were.
            const after = res.changes === 1 ? get.get(cur.id) : null;
            const was = metadataObject(cur.metadata), now = after && metadataObject(after.metadata);
            const rep = after && reproduce(after);
            const good = after && now && rep && rep.version === 'strong' && after.content_hash === v.to &&
              now[LEGACY_META_KEY] === p.from && legacyFromMetadata(after.metadata) === p.from &&
              without(now, LEGACY_META_KEY) === without(was, LEGACY_META_KEY) &&
              CONTENT.every((c) => after[c] === cur[c]);
            if (good) { db.exec('RELEASE mh_row'); migrated++; continue; }
            db.exec('ROLLBACK TO mh_row'); db.exec('RELEASE mh_row');
            verifyFailures++;
            if (failedIds.length < SAMPLE) failedIds.push(cur.id);
          }
          db.exec('COMMIT');
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
          throw e;
        }
      }
    } catch (e) {
      throw new Error(`${e.message} (backup intact at ${backupPath}; rows rewritten before this point were each verified)`);
    }

    // Every kept rewrite was verified inside its transaction; what is left to
    // check is the full-text index the UPDATE triggers maintain.
    const ftsOk = ftsCheck(db);
    const rowsAfter = tableExists(db, 'observations') ? db.prepare('SELECT COUNT(*) AS n FROM observations').get().n : 0;
    return {
      applied: true, dbPath, ...strip(plan), conflicts, migrated, raced, backupPath,
      verified: ftsOk || !ftsBefore, verifyFailures, failedIds, ftsOk, ftsBefore,
      rowsBefore: before.n, rowsAfter,
    };
  } finally {
    try { db.close(); } catch {}
  }
}

// Shown on every run, dry or applied: the one thing --apply cannot check itself.
export const ALL_MACHINES_NOTE =
  'Before --apply: every Mac that syncs this brain must already run this build (or newer).\n' +
  '    An older build matches rows by their stored hash only, so after the next sync it would\n' +
  '    keep a second copy of every rewritten row. Update them all first, then migrate.';

export function formatMigrateHashReport(r) {
  const L = [];
  L.push(`brain migrate-hash — ${r.applied ? 'applied' : 'dry run (nothing changed)'} · ${r.dbPath}`);
  L.push(`  observations: ${r.total}`);
  L.push(`  already on the strong hash:            ${r.alreadyStrong}`);
  L.push(`  ${r.applied ? 'rewritten' : 'would rewrite'} (v1 FNV → v2 SHA-256/128): ${r.applied ? r.migrated : r.toMigrate}` +
    ` (transcript ${r.byRecipe.text}, canonical ${r.byRecipe.canonical})`);
  L.push(`  kept as is — content no longer matches its v1 hash (edited, merged or rewritten since capture): ${r.unreproducible}`);
  L.push(`  kept as is — not a native v1 hash (claude-mem's own, etc.): ${r.foreign}`);
  if (r.noHash) L.push(`  no content_hash: ${r.noHash}`);
  if (r.badMetadata) L.push(`  skipped — metadata is not a JSON object: ${r.badMetadata}`);
  if (r.conflicts) L.push(`  skipped — the new hash is already taken in the same session: ${r.conflicts}${r.conflictIds?.length ? ` (ids ${r.conflictIds.join(', ')})` : ''}`);
  if (r.raced) L.push(`  changed by another writer mid-run, left as it now is (re-run to pick them up): ${r.raced}`);
  if (r.verifyFailures) L.push(`  rewrite did not check out, rolled back (row unchanged): ${r.verifyFailures}${r.failedIds?.length ? ` (ids ${r.failedIds.join(', ')})` : ''}`);
  if (r.applied) {
    if (r.backupPath) L.push(`  backup: ${r.backupPath}`);
    if (r.backupPath) {
      L.push(`  verification: ${r.ftsOk ? 'passed (every rewrite read back in its transaction; full-text index ok)'
        : `full-text index integrity check FAILED${r.ftsBefore === false ? ' (it already failed before this run)' : ''}` +
          ' — run `brain doctor`; the backup holds the store as it was before this run, but restoring it also drops anything written since'}`);
    }
  } else if (r.toMigrate) {
    L.push('  Re-run with --apply to rewrite them (a verified backup is made first).');
  }
  if (r.applied && r.migrated) {
    L.push('  Every Mac that syncs this brain must run this build (or newer) before its next sync: an older');
    L.push('    build matches rows by their stored hash only and would keep a second copy of each rewritten row.');
  } else if (!r.applied && r.toMigrate) L.push(`  ${ALL_MACHINES_NOTE}`);
  return L.join('\n');
}
