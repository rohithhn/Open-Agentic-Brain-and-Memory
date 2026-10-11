#!/usr/bin/env node
// Tests for the memory lifecycle (bin/lib/lifecycle.mjs + the store.mjs
// migration + the recall/context/remember/dream wiring).
//
//   node evals/lifecycle-test.mjs
//
// Synthetic DBs only, under the scratchpad/tmpdir. The one end-to-end dream
// run happens in a subprocess against a COPY of bin/ (so REPO_ROOT/wiki is a
// temp dir) with HOME pointed at a temp home — the real ~/.claude-brain and
// this checkout's wiki/ are never touched.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, cpSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore, ensureLifecycleSchema, LIFECYCLE_COLUMN_NAMES } from '../bin/lib/store.mjs';
import { openDb } from '../bin/lib/db.mjs';
import {
  hasLifecycle, topicOf, sameTopic, findSupersessions, planLifecycle, applyLifecycle, planClear,
  markStatus, supersedeOlder, lifecycleCounts, rerankByLifecycle, lifecycleLabel, runLifecycle,
  openForLifecycle, isForeignStore, autoMarkerPath, autoLifecycleEnabled,
} from '../bin/lib/lifecycle.mjs';
import { recallSearch } from '../bin/lib/recall.mjs';
import { rememberObservation } from '../bin/lib/remember.mjs';
import { lintFindings } from '../bin/lib/dream.mjs';
import { CLAUDE_MEM_DB } from '../bin/lib/paths.mjs';
import { sessionContext } from '../bin/lib/sessionstart.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.stack || e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `lifecycle-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
let seq = 0;
const DAY = 86400000;
const T0 = Date.UTC(2026, 8, 1);

// ── fixtures ────────────────────────────────────────────────────────────────
function insertRows(db, rows, tag) {
  const insS = db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,'completed')`);
  const insO = db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, facts, narrative, concepts, prompt_number, created_at, created_at_epoch, content_hash, generated_by_model)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids = [];
  rows.forEach((r, i) => {
    const mem = `test:${tag}:${i}`;
    const ep = r.epoch ?? T0 + i * 1000;
    insS.run(mem, mem, r.project || 'p', 'test', new Date(ep).toISOString(), ep);
    ids.push(Number(insO.run(mem, r.project || 'p', '', r.type || 'discovery', r.title || `row ${i}`, '[]', r.narrative || '',
      JSON.stringify(r.concepts || []), 0, new Date(ep).toISOString(), ep, r.hash || `h-${tag}-${i}`, 'test').lastInsertRowid));
  });
  return ids;
}
function buildStore(rows) {
  const path = join(ROOT, `store-${++seq}.db`);
  const db = openStore({ path });
  const ids = insertRows(db, rows, seq);
  db.close();
  return { path, ids };
}
// A store as an older build left it: same schema minus the lifecycle columns.
function buildLegacyStore(rows) {
  const path = join(ROOT, `legacy-${++seq}.db`);
  const db = openStore({ path });
  db.exec('DROP INDEX IF EXISTS idx_observations_status');
  for (const c of [...LIFECYCLE_COLUMN_NAMES].reverse()) db.exec(`ALTER TABLE observations DROP COLUMN ${c}`);
  const ids = insertRows(db, rows, seq);
  db.close();
  return { path, ids };
}
const snapshot = (path) => {
  const db = openDb(path, { readonly: true });
  try {
    return db.prepare('SELECT id, memory_session_id, project, type, title, narrative, concepts, created_at_epoch, content_hash FROM observations ORDER BY id').all();
  } finally { db.close(); }
};
const statusRow = (path, id) => {
  const db = openDb(path, { readonly: true });
  try { return db.prepare('SELECT status, superseded_by, status_reason FROM observations WHERE id = ?').get(id); }
  finally { db.close(); }
};

// ── migration ──────────────────────────────────────────────────────────────
await t('migration: adds the columns to a legacy store, idempotent, no data lost, FTS intact', async () => {
  const { path } = buildLegacyStore([
    { title: 'Quokka cache eviction policy', narrative: 'quokka narrative' },
    { title: 'Second row', narrative: 'plain' },
  ]);
  const before = snapshot(path);
  const db = openDb(path);
  assert(!hasLifecycle(db), 'legacy fixture must start without lifecycle columns');
  const added1 = ensureLifecycleSchema(db);
  const added2 = ensureLifecycleSchema(db);
  eq(added1, LIFECYCLE_COLUMN_NAMES, 'first call adds every lifecycle column');
  eq(added2, [], 'second call is a no-op');
  assert(hasLifecycle(db), 'columns present after migration');
  eq(db.prepare("SELECT COUNT(*) n FROM observations WHERE COALESCE(status,'active') = 'active'").get().n, 2, 'existing rows read as active');
  eq(db.prepare("SELECT COUNT(*) n FROM observations_fts WHERE observations_fts MATCH 'quokka'").get().n, 1, 'FTS still finds the row');
  db.close();
  eq(snapshot(path), before, 'every pre-existing column value unchanged');
});

await t('migration: openStore on an already-migrated store is a no-op (ensureSchema path)', async () => {
  const { path } = buildStore([{ title: 'x' }]);
  const db = openStore({ path });
  eq(ensureLifecycleSchema(db), [], 'nothing left to add');
  db.close();
});

await t('migration: openForLifecycle backs a populated legacy store up first (verified), once', async () => {
  const { path } = buildLegacyStore([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
  const backupDir = join(ROOT, `bk-${seq}`);
  const h1 = openForLifecycle(path, { backupDir });
  h1.db.close();
  assert(h1.backupPath && existsSync(h1.backupPath), 'backup written before the first migration');
  const b = new DatabaseSync(h1.backupPath, { readOnly: true });
  eq(b.prepare('SELECT COUNT(*) n FROM observations').get().n, 3, 'backup holds every row');
  assert(!b.prepare('PRAGMA table_info(observations)').all().some((c) => c.name === 'status'), 'backup is the pre-migration schema');
  b.close();
  const h2 = openForLifecycle(path, { backupDir });
  h2.db.close();
  eq(h2.backupPath, null, 'no second backup once migrated');
  eq(readdirSync(backupDir).length, 1, 'exactly one backup file');
});

await t('migration: refuses claude-mem\'s own DB', async () => {
  assert(isForeignStore(CLAUDE_MEM_DB), 'claude-mem path recognised');
  let threw = false;
  try { openForLifecycle(CLAUDE_MEM_DB); } catch (e) { threw = /refusing/.test(e.message); }
  assert(threw, 'openForLifecycle must refuse claude-mem.db');
});

// ── topic matching ───────────────────────────────────────────────────────────
await t('topic: same-topic rewordings match; different files / identifiers / numbered units do not', async () => {
  const same = (a, b) => sameTopic(topicOf(a), topicOf(b));
  assert(same('Memory distiller protocol established with JSON schema', 'Memory distiller schema and execution protocol established'), 'reworded decision should match');
  assert(!same('redditScout.js: safeParseJson import added', 'trendDiscovery.js: safeParseJson import added'), 'different files must not match');
  assert(!same('Fixed browserDevice incomplete call in tryBrowserBacktest', 'Fixed browserDevice incomplete call in tryPortfolioBrowserBacktest'), 'different identifiers must not match');
  assert(!same('Task 34: Phase 1 Backend Implementation Marked Complete', 'Task 35: Phase 2 Frontend Implementation Marked Complete'), 'numbered units must not match');
  assert(!same('Use SQLite', 'Use Postgres'), 'too few shared words');
});

// ── supersession ───────────────────────────────────────────────────────────────
await t('supersede: newer same-topic decision retires the older; other project/type/topic untouched', async () => {
  const { path, ids } = buildStore([
    { type: 'decision', title: 'Retry policy for webhook delivery uses exponential backoff', epoch: T0 },
    { type: 'decision', title: 'Retry policy for webhook delivery uses exponential backoff with jitter', epoch: T0 + DAY },
    { type: 'decision', title: 'Retry policy for webhook delivery uses exponential backoff', epoch: T0 + 2 * DAY, project: 'other' },
    { type: 'discovery', title: 'Retry policy for webhook delivery uses exponential backoff', epoch: T0 + 3 * DAY },
    { type: 'decision', title: 'Database migration runner ordering', epoch: T0 + 4 * DAY },
  ]);
  const db = openDb(path);
  const s = findSupersessions(db);
  eq([...s.keys()], [ids[0]], 'only the older decision in the same project is superseded');
  eq(s.get(ids[0]).by, ids[1], 'superseded by the newer decision');
  const plan = planLifecycle(db);
  eq(applyLifecycle(db, plan), 1, 'one row updated');
  db.close();
  const r = statusRow(path, ids[0]);
  eq([r.status, r.superseded_by], ['superseded', ids[1]], 'status + superseded_by recorded');
  eq(statusRow(path, ids[1]).status, 'active', 'newer stays active');
});

await t('supersede: a chain points every older row at the newest; re-running the pass changes nothing', async () => {
  const { path, ids } = buildStore([
    { type: 'bugfix', title: 'Fixed flaky login redirect loop in auth middleware', epoch: T0 },
    { type: 'bugfix', title: 'Fixed flaky login redirect loop in auth middleware again', epoch: T0 + DAY },
    { type: 'bugfix', title: 'Fixed flaky login redirect loop in the auth middleware', epoch: T0 + 2 * DAY },
  ]);
  const db = openDb(path);
  applyLifecycle(db, planLifecycle(db));
  eq(statusRow(path, ids[0]).superseded_by, ids[2], 'oldest → newest');
  eq(statusRow(path, ids[1]).superseded_by, ids[2], 'middle → newest');
  eq(planLifecycle(db).changes.length, 0, 'idempotent: second pass has nothing to do');
  db.close();
});

await t('supersede: deleting the newer row returns the older one to active on the next pass', async () => {
  const { path, ids } = buildStore([
    { type: 'decision', title: 'Cache layer keyed by tenant and region identifiers', epoch: T0 },
    { type: 'decision', title: 'Cache layer keyed by tenant and region identifiers only', epoch: T0 + DAY },
  ]);
  const db = openDb(path);
  applyLifecycle(db, planLifecycle(db));
  eq(statusRow(path, ids[0]).status, 'superseded', 'retired first');
  db.prepare('DELETE FROM observations WHERE id = ?').run(ids[1]);
  const plan = planLifecycle(db);
  eq(plan.changes.map((c) => [c.id, c.to]), [[ids[0], 'active']], 'reactivation planned');
  applyLifecycle(db, plan);
  db.close();
  const r = statusRow(path, ids[0]);
  eq([r.status, r.superseded_by], ['active', null], 'back to active, pointer cleared');
});

// ── lint → contested / stale, precedence, manual override ────────────────────
function lintFixture() {
  return buildStore([
    { title: 'Shared content A', hash: 'dup-1', project: 'alpha', concepts: ['fresh'], epoch: T0 + 100 * DAY },       // 0 contested
    { title: 'Shared content A', hash: 'dup-1', project: 'beta', concepts: ['fresh'], epoch: T0 + 100 * DAY + 1 },    // 1 contested
    { title: 'Old thing one', concepts: ['oldthing'], epoch: T0 },                                                     // 2 stale
    { title: 'Old thing two', concepts: ['oldthing'], epoch: T0 + 1 },                                                 // 3 stale
    { title: 'Old thing also fresh', concepts: ['oldthing', 'fresh'], epoch: T0 + 2 },                                 // 4 vouched → active
    { title: 'Fresh work', concepts: ['fresh'], epoch: T0 + 100 * DAY + 2 },                                           // 5 active
  ]);
}

await t('lint wiring: lintFindings → contested (same content, 2 projects) and stale (only stale concepts)', async () => {
  const { path, ids } = lintFixture();
  const ro = openDb(path, { readonly: true });
  const f = lintFindings(ro);
  ro.close();
  eq(f.contradictions, ['dup-1'], 'the cross-project hash is a contradiction');
  assert(f.staleConcepts.includes('oldthing') && !f.staleConcepts.includes('fresh'), `stale concepts wrong: ${JSON.stringify(f)}`);
  const r = runLifecycle({ dbPath: path, apply: true, findings: f });
  eq(r.counts, { contested: 2, stale: 2 }, 'two contested, two stale');
  eq(statusRow(path, ids[0]).status, 'contested', 'row 0 contested');
  eq(statusRow(path, ids[2]).status, 'stale', 'row 2 stale');
  eq(statusRow(path, ids[4]).status, 'active', 'a row that also carries a live concept stays active');
  eq(statusRow(path, ids[5]).status, 'active', 'fresh row active');
  // A supersede-only pass (no lint findings) must not undo contested/stale.
  const db = openDb(path);
  eq(planLifecycle(db).changes.length, 0, 'partial pass leaves other sources\' marks alone');
  // Contradiction resolved → contested rows come back.
  eq(planLifecycle(db, { contradictions: [], staleConcepts: f.staleConcepts, liveConcepts: f.liveConcepts }).counts, { active: 2 }, 'resolved contradiction reactivates');
  db.close();
});

await t('manual override: status-mark sticks through automatic passes; "auto" hands it back', async () => {
  const { path, ids } = lintFixture();
  const ro = openDb(path, { readonly: true });
  const f = lintFindings(ro);
  ro.close();
  const db = openDb(path);
  ensureLifecycleSchema(db);
  eq(markStatus(db, ids[2], 'active', { note: 'still true' }).ok, true, 'pin a would-be-stale row active');
  eq(markStatus(db, ids[5], 'superseded', { by: ids[4] }).ok, true, 'manually supersede with a pointer');
  eq(markStatus(db, ids[5], 'bogus').ok, false, 'unknown status refused');
  eq(markStatus(db, 999999, 'stale').ok, false, 'unknown id refused');
  eq(markStatus(db, ids[5], 'superseded', { by: ids[5] }).ok, false, 'self-supersede refused');
  applyLifecycle(db, planLifecycle(db, f));
  eq(statusRow(path, ids[2]).status, 'active', 'manual active not re-marked stale');
  eq([statusRow(path, ids[5]).status, statusRow(path, ids[5]).superseded_by], ['superseded', ids[4]], 'manual superseded not reactivated');
  eq(lifecycleCounts(db).manual, 2, 'two manual rows counted');
  markStatus(db, ids[2], 'auto');
  applyLifecycle(db, planLifecycle(db, f));
  eq(statusRow(path, ids[2]).status, 'stale', 'after auto, the pass decides again');
  // --clear undoes automatic marks only.
  applyLifecycle(db, planClear(db));
  eq(statusRow(path, ids[2]).status, 'active', 'clear resets auto marks');
  eq(statusRow(path, ids[5]).status, 'superseded', 'clear keeps manual marks');
  db.close();
});

await t('dry run: plans on an un-migrated store without writing anything', async () => {
  const { path } = buildLegacyStore([
    { type: 'decision', title: 'Queue consumer concurrency limit set to eight workers', epoch: T0 },
    { type: 'decision', title: 'Queue consumer concurrency limit set to eight workers now', epoch: T0 + DAY },
  ]);
  const mtime = statSync(path).mtimeMs;
  const r = runLifecycle({ dbPath: path, apply: false });
  eq([r.applied, r.migrated, r.counts], [false, false, { superseded: 1 }], 'reports what --apply would do');
  const db = openDb(path, { readonly: true });
  assert(!hasLifecycle(db), 'still un-migrated after a dry run');
  db.close();
  eq(statSync(path).mtimeMs, mtime, 'file untouched');
  assert(!existsSync(join(dirname(path), 'backups')), 'no backup on a dry run');
});

// ── readers ───────────────────────────────────────────────────────────────────
await t('rerank: all-active order is exactly the FTS order; superseded sinks, active wins', async () => {
  const rows = [{ id: 1, score: -9 }, { id: 2, score: -5 }, { id: 3, score: -4 }];
  eq(rerankByLifecycle(rows, 3).map((r) => r.id), [1, 2, 3], 'unchanged when all active');
  const mixed = [{ id: 1, score: -9, lc_status: 'superseded', lc_superseded_by: 2 }, { id: 2, score: -5 }, { id: 3, score: -4, lc_status: 'stale' }];
  eq(rerankByLifecycle(mixed, 3).map((r) => r.id), [2, 1, 3], 'superseded (-3.15) below active (-5), above stale (-2.4)');
  eq(lifecycleLabel(mixed[0]), 'superseded by #2', 'label names the replacement');
  eq(lifecycleLabel(mixed[1]), '', 'active rows carry no label');
});

await t('recall: the current decision outranks the superseded one, which is labelled', async () => {
  const { path, ids } = buildStore([
    // The older row repeats the query words more (better bm25) — only lifecycle puts it second.
    { type: 'decision', title: 'Wombat deploy target region selection', narrative: 'wombat wombat wombat deploy region us-east', epoch: T0 },
    { type: 'decision', title: 'Wombat deploy target region selection policy', narrative: 'wombat deploy region eu-west', epoch: T0 + DAY },
  ]);
  const before = await recallSearch({ query: 'wombat', dbPath: path });
  eq(before.results.map((r) => r.id), [ids[0], ids[1]], 'fixture: older row ranks first on bm25 alone');
  assert(before.results.every((r) => !('status' in r)), 'no lifecycle fields while everything is active');
  runLifecycle({ dbPath: path, apply: true });
  const after = await recallSearch({ query: 'wombat', dbPath: path });
  eq(after.results.map((r) => r.id), [ids[1], ids[0]], 'active decision first');
  eq([after.results[1].status, after.results[1].lifecycle], ['superseded', `superseded by #${ids[1]}`], 'superseded row labelled');
});

await t('recall: a store without lifecycle columns still answers (claude-mem-shaped)', async () => {
  const { path, ids } = buildLegacyStore([{ title: 'Narwhal index rebuild', narrative: 'narwhal' }]);
  const out = await recallSearch({ query: 'narwhal', dbPath: path });
  eq(out.results.map((r) => r.id), [ids[0]], 'row returned, no error');
});

await t('context: retrieveContext lines carry the lifecycle label (subprocess, temp HOME)', async () => {
  const home = join(ROOT, `home-ctx-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const dbPath = join(home, '.claude-brain', 'brain.db');
  const db = openStore({ path: dbPath });
  const ids = insertRows(db, [
    { type: 'decision', title: 'Pangolin queue retention window seven days', narrative: 'pangolin retention', epoch: T0 },
    { type: 'decision', title: 'Pangolin queue retention window seven days extended', narrative: 'pangolin retention', epoch: T0 + DAY },
  ], 'ctx');
  db.close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'test fixture\n');
  runLifecycle({ dbPath, apply: true });
  const script = join(ROOT, `ctx-${seq}.mjs`);
  writeFileSync(script, `import { retrieveContext } from ${JSON.stringify(join(REPO, 'bin/lib/agent.mjs'))};
process.stdout.write(JSON.stringify(retrieveContext('pangolin queue retention window', { wiki: false, learnings: false, workflows: false })));`);
  const out = JSON.parse(execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  assert(out.block.includes(`superseded by #${ids[1]}] Pangolin queue retention window seven days:`), `label missing: ${out.block.slice(0, 400)}`);
  const first = out.block.indexOf('Pangolin queue retention window seven days extended');
  const second = out.block.indexOf('Pangolin queue retention window seven days:');
  assert(first !== -1 && first < second, 'active decision listed before the superseded one');
});

// ── write path ───────────────────────────────────────────────────────────────
await t('remember: saving a newer decision supersedes the older same-topic one at write time', async () => {
  const { path, ids } = buildStore([
    { type: 'decision', title: 'Adopt trunk based development for the mobile app', project: 'mob', epoch: T0 },
  ]);
  const r = await rememberObservation(
    { title: 'Adopt trunk based development for the mobile app repo', project: 'mob', type: 'decision', facts: ['short-lived branches only'] },
    { dbPath: path, now: T0 + DAY, log: () => {} },
  );
  eq([r.ok, r.status, r.supersedes], [true, 'saved', [ids[0]]], 'write reports what it retired');
  eq([statusRow(path, ids[0]).status, statusRow(path, ids[0]).superseded_by], ['superseded', r.id], 'older row retired');
  const db = openDb(path);
  eq(supersedeOlder(db, r.id), [], 'write-time pass is idempotent');
  eq(planLifecycle(db).changes.length, 0, 'full pass agrees with the write-time result');
  db.close();
});

await t('remember: a legacy (un-migrated) store still saves normally', async () => {
  const { path } = buildLegacyStore([{ type: 'decision', title: 'Adopt trunk based development for the mobile app', project: 'mob' }]);
  const r = await rememberObservation(
    { title: 'Adopt trunk based development for the mobile app repo', project: 'mob', type: 'decision', facts: ['x'] },
    { dbPath: path, log: () => {} },
  );
  eq([r.ok, r.status, 'supersedes' in r], [true, 'saved', false], 'saved, no lifecycle side effect');
});

// ── dream end-to-end (copied engine, temp HOME, temp wiki) ────────────────────
await t('dream: report-only until opted in, then marks behind a backup (end to end)', async () => {
  const repo = join(ROOT, `repo-${++seq}`);
  cpSync(join(REPO, 'bin'), join(repo, 'bin'), { recursive: true });
  if (existsSync(join(REPO, 'config.example.json'))) cpSync(join(REPO, 'config.example.json'), join(repo, 'config.example.json'));
  const home = join(ROOT, `home-dream-${seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const dbPath = join(home, '.claude-brain', 'brain.db');
  const db = openStore({ path: dbPath });
  // Make it look like an older store so dream has to migrate (and back up).
  db.exec('DROP INDEX IF EXISTS idx_observations_status');
  for (const c of [...LIFECYCLE_COLUMN_NAMES].reverse()) db.exec(`ALTER TABLE observations DROP COLUMN ${c}`);
  const ids = insertRows(db, [
    { title: 'Shared content A', hash: 'dup-1', project: 'alpha', concepts: ['fresh'], epoch: T0 + 100 * DAY },
    { title: 'Shared content A', hash: 'dup-1', project: 'beta', concepts: ['fresh'], epoch: T0 + 100 * DAY + 1 },
    { title: 'Old thing one', concepts: ['oldthing'], epoch: T0 },
    { title: 'Old thing two', concepts: ['oldthing'], epoch: T0 + 1 },
    { type: 'decision', title: 'Release train cadence every two weeks on tuesday', concepts: ['fresh'], epoch: T0 + 100 * DAY + 2 },
    { type: 'decision', title: 'Release train cadence every two weeks on tuesday morning', concepts: ['fresh'], epoch: T0 + 100 * DAY + 3 },
  ], 'dream');
  db.close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'test fixture\n');
  const script = join(ROOT, `dream-${seq}.mjs`);
  writeFileSync(script, `import { dream } from ${JSON.stringify(join(repo, 'bin/lib/dream.mjs'))};
process.stdout.write(JSON.stringify(dream({ log: () => {} }).lifecycle));`);
  // Not opted in: the nightly pass only reports. No column added, no backup, rows unchanged.
  const before = snapshot(dbPath);
  const dry = JSON.parse(execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  assert(dry && dry.dryRun === true && dry.changes > 0, `first dream is a dry run that finds work: ${JSON.stringify(dry)}`);
  const dbDry = openDb(dbPath, { readonly: true });
  assert(!hasLifecycle(dbDry), 'dry-run dream did not migrate the store');
  dbDry.close();
  eq(snapshot(dbPath), before, 'dry-run dream left every row as it was');
  assert(!existsSync(join(home, '.claude-brain', 'backups')) || !readdirSync(join(home, '.claude-brain', 'backups')).length, 'no backup taken by a dry run');
  // Opt in (what `brain lifecycle --apply` records), then dream applies — behind a backup.
  writeFileSync(autoMarkerPath(dbPath), 'opted in by test\n');
  const out = JSON.parse(execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  assert(out && out.backupPath && existsSync(out.backupPath), `dream migrated behind a backup: ${JSON.stringify(out)}`);
  eq([out.current.superseded, out.current.contested, out.current.stale], [1, 2, 2], 'counts after dream');
  eq(statusRow(dbPath, ids[4]).superseded_by, ids[5], 'older decision superseded by the newer');
  assert(existsSync(join(repo, 'wiki', 'lint.md')), 'wiki written to the copied repo, not this checkout');
  // Second dream: nothing new to mark, no second backup.
  const again = JSON.parse(execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  eq([again.updated, again.backupPath], [0, null], 'second dream is a no-op for lifecycle');
});

await t('sync safety: ensureSchema never ALTERs a populated, un-migrated store; empty stores get the columns', async () => {
  const { path } = buildLegacyStore([{ title: 'Real memory kept as is' }]);
  const before = snapshot(path);
  openStore({ path }).close();                       // what every sync/import does
  const db = openDb(path, { readonly: true });
  assert(!hasLifecycle(db), 'populated legacy store left un-migrated by ensureSchema');
  db.close();
  eq(snapshot(path), before, 'rows untouched');
  assert(!existsSync(join(ROOT, 'backups')), 'no backup needed because nothing changed');
  const empty = join(ROOT, `empty-${++seq}.db`);
  const e = openStore({ path: empty });
  assert(hasLifecycle(e), 'a new empty store gets the lifecycle columns up front');
  e.close();
});

await t('opt-in: lifecycle --apply turns the nightly pass on, --clear --apply turns it off, auto:false leaves it', async () => {
  const legacy = buildLegacyStore([
    { type: 'decision', title: 'Kestrel queue retries three times', epoch: T0 },
    { type: 'decision', title: 'Kestrel queue retries three times with backoff', epoch: T0 + DAY },
  ]);
  // The opt-in marker is per store directory; give this store its own, as in real use.
  const own = join(ROOT, `optin-${seq}`);
  mkdirSync(own, { recursive: true });
  const path = join(own, 'brain.db');
  cpSync(legacy.path, path);
  const bdir = join(own, 'backups');
  assert(!autoLifecycleEnabled(path), 'off by default');
  const once = runLifecycle({ dbPath: path, apply: true, backupDir: bdir, auto: false });
  assert(once.backupPath && existsSync(once.backupPath), 'first apply backed up before migrating');
  assert(!autoLifecycleEnabled(path), 'auto:false applies once without opting in');
  runLifecycle({ dbPath: path, apply: true, backupDir: bdir });
  assert(autoLifecycleEnabled(path), 'an explicit apply opts in');
  runLifecycle({ dbPath: path, apply: true, clear: true, backupDir: bdir });
  assert(!autoLifecycleEnabled(path), 'clear --apply opts back out');
});

await t('startup block: superseded rows are left out of the newest-first list', async () => {
  const { path, ids } = buildStore([
    { type: 'decision', title: 'Ocelot build cache stored in shared bucket', project: 'proj', epoch: T0 },
    { type: 'decision', title: 'Ocelot build cache stored in shared bucket per branch', project: 'proj', epoch: T0 + DAY },
    { type: 'discovery', title: 'Unrelated ocelot note', project: 'proj', epoch: T0 + 2 * DAY },
  ]);
  const before = sessionContext({ project: 'proj', dbPath: path });
  assert(before.text.includes(`#${ids[0]}`), 'older decision listed while active');
  runLifecycle({ dbPath: path, apply: true });
  const after = sessionContext({ project: 'proj', dbPath: path });
  assert(!after.text.includes(`#${ids[0]} `) && after.text.includes(`#${ids[1]}`), `superseded row must drop out: ${after.text.slice(0, 400)}`);
});

await t('sync: exports carry no lifecycle columns and a merge never imports them', async () => {
  const repo = join(ROOT, `repo-sync-${++seq}`);
  cpSync(join(REPO, 'bin'), join(repo, 'bin'), { recursive: true });
  if (existsSync(join(REPO, 'config.example.json'))) cpSync(join(REPO, 'config.example.json'), join(repo, 'config.example.json'));
  const home = join(ROOT, `home-sync-${seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const a = join(home, '.claude-brain', 'brain.db');
  const db = openStore({ path: a });
  const ids = insertRows(db, [
    { type: 'decision', title: 'Monorepo tooling switched to workspace protocol links', project: 'mono', epoch: T0 },
    { type: 'decision', title: 'Monorepo tooling switched to workspace protocol links fully', project: 'mono', epoch: T0 + DAY },
  ], 'sync');
  db.close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'test fixture\n');
  runLifecycle({ dbPath: a, apply: true });
  eq(statusRow(a, ids[0]).status, 'superseded', 'machine A marked its row');
  // Machine B: an empty, migrated store that merges A's exports.
  const b = join(ROOT, `machine-b-${seq}.db`);
  openStore({ path: b }).close();
  const script = join(ROOT, `sync-${seq}.mjs`);
  writeFileSync(script, `import { runExport } from ${JSON.stringify(join(repo, 'bin/lib/export.mjs'))};
import { runImport } from ${JSON.stringify(join(repo, 'bin/lib/import.mjs'))};
import { readFileSync } from 'node:fs';
runExport({ skipScrubGate: true });
const lines = readFileSync(${JSON.stringify(join(repo, 'memory', 'exports', 'mono', 'observations.jsonl'))}, 'utf8').trim().split('\\n').map((l) => JSON.parse(l));
const merged = runImport({ dbPath: ${JSON.stringify(b)} });
process.stdout.write(JSON.stringify({ keys: Object.keys(lines[0]), merged }));`);
  const out = JSON.parse(execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  for (const c of LIFECYCLE_COLUMN_NAMES) assert(!out.keys.includes(c), `export leaked ${c}`);
  eq(out.merged.observations, 2, 'both rows merged into B');
  const bdb = openDb(b, { readonly: true });
  const rows = bdb.prepare("SELECT COALESCE(status,'active') s, superseded_by FROM observations").all();
  bdb.close();
  assert(rows.every((r) => r.s === 'active' && r.superseded_by == null), `B must not inherit A's local ids: ${JSON.stringify(rows)}`);
});

// ── CLI ─────────────────────────────────────────────────────────────────────
await t('CLI: brain lifecycle (dry run) / --apply / status-mark on a --db store', async () => {
  const { path, ids } = buildLegacyStore([
    { type: 'decision', title: 'Feature flags evaluated server side for every request', epoch: T0 },
    { type: 'decision', title: 'Feature flags evaluated server side for every request path', epoch: T0 + DAY },
  ]);
  const run = (...args) => execFileSync(process.execPath, [join(REPO, 'bin/brain.mjs'), ...args, '--db', path], { encoding: 'utf8', env: { ...process.env, HOME: join(ROOT, 'cli-home') } });
  assert(/dry run[\s\S]*would mark: 1 superseded/.test(run('lifecycle')), 'dry run reports the plan');
  const db0 = openDb(path, { readonly: true });
  assert(!hasLifecycle(db0), 'dry run did not migrate');
  db0.close();
  assert(/applied[\s\S]*marked: 1 superseded/.test(run('lifecycle', '--apply')), 'apply marks it');
  eq(statusRow(path, ids[0]).status, 'superseded', 'row marked');
  assert(/#\d+: superseded → active/.test(run('status-mark', String(ids[0]), 'active', '--note', 'still valid')), 'status-mark output');
  eq(statusRow(path, ids[0]).status_reason, 'manual: still valid', 'manual reason recorded');
  assert(/would mark: 0 superseded/.test(run('lifecycle')), 'manual override respected by the next pass');
});

// ── report ─────────────────────────────────────────────────────────────────
for (const [s, n, m] of results) console.log(`${s}  ${n}${m ? `\n      ${m.split('\n').join('\n      ')}` : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
