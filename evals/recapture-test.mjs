#!/usr/bin/env node
// Tests for `brain recapture` (bin/lib/recapture.mjs): the opt-in way an EXISTING
// capture row follows a transcript that grew after capture. Ingest itself never
// does this to a distilled / edited / hidden row (evals/ingest-growth-test.mjs).
//
//   node evals/recapture-test.mjs
//
// Contract under test: dry-run by default (read-only, no journal table), --apply
// only behind a verified backup, every old value journalled, --undo puts the old
// values back — including the earlier DISTILLATION after the distiller has
// overwritten it — and rows that are not safe to change in bulk are skipped.
//
// SAFETY: every $HOME and DB is synthetic under the scratchpad / $TMPDIR; the
// commands run in children with HOME=<fake>. No real transcript or store is touched.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, writeFileSync, appendFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../bin/lib/store.mjs';
import { pendingSessions, distillPending, resetBinaryCache } from '../bin/lib/distiller.mjs';
import { editMemory, deleteMemory } from '../bin/lib/curate.mjs';
import { applyScrub, auditScrub } from '../bin/lib/scrub.mjs';
import { cleanTestData } from '../bin/lib/clean.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `recapture-test-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

function makeHome(name) {
  const home = join(ROOT, name);
  mkdirSync(join(home, '.claude', 'projects', '-Users-x-code-webapp'), { recursive: true });
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const store = join(home, '.claude-brain', 'brain.db');
  openStore({ path: store }).close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'test\n');
  return { home, store, backups: join(home, '.claude-brain', 'backups') };
}
function child(home, code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const runIngest = (home) => child(home, `
  const { ingest } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
  console.log(JSON.stringify(await ingest({ only: ['claude'] })));`).claude;
function recap(h, ...args) {
  const r = spawnSync(process.execPath, [join(REPO, 'bin/brain.mjs'), 'recapture', '--db', h.store, '--json', ...args],
    { env: { ...process.env, HOME: h.home }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`recapture exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const q = (store, sql, ...a) => { const db = new DatabaseSync(store, { readOnly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
const rw = (store, fn) => { const db = new DatabaseSync(store); try { return fn(db); } finally { db.close(); } };
const obsOf = (store, mem) => q(store, 'SELECT * FROM observations WHERE memory_session_id = ? ORDER BY id', mem);
const stateOf = (store, key) => q(store, 'SELECT * FROM capture_state WHERE transcript_path = ?', key)[0] || null;
const snap = (store) => JSON.stringify({
  o: q(store, 'SELECT * FROM observations ORDER BY id'), c: q(store, 'SELECT * FROM capture_state ORDER BY transcript_path'),
});

const SID = 'aaaaaaaa-1111-4111-8111-000000000001';
const MEM = `claude:${SID}`;
const cline = (type, text, ts) => JSON.stringify({
  type, cwd: '/Users/x/code/webapp', sessionId: SID, timestamp: ts,
  message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
}) + '\n';
const file = (home, sid = SID) => join(home, '.claude', 'projects', '-Users-x-code-webapp', `${sid}.jsonl`);

function makeStub(out) {
  const bin = join(ROOT, `stub-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(bin, `#!${process.execPath}
let d = ''; process.stdin.on('data', (c) => { d += c; }); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(out)}); });
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}
const distilledJson = (title) => JSON.stringify({
  title, subtitle: 'Cursor pagination with a hard page-size cap was added to the orders list endpoint.', type: 'feature',
  facts: ['orders/list.ts now pages by an opaque cursor.', 'Page size is capped at 100 rows.'],
  narrative: 'The orders endpoint returned every row. Cursor pagination was added with a page-size cap.', concepts: ['pagination'],
});
function stubEnv(bin) {
  resetBinaryCache();
  return { ...process.env, BRAIN_DISTILL_CLAUDE_BIN: bin, BRAIN_DISTILL_CODEX_BIN: join(ROOT, 'missing'),
    BRAIN_DISTILL_AGY_BIN: join(ROOT, 'missing'), PATH: join(ROOT, 'empty-path'), HOME: join(ROOT, 'distill-home') };
}

// ── A store with one distilled session that then grew ────────────────────────
const A = makeHome('h-a');
let distilled;
await t('setup: a session distilled by the brain, then grown on disk (ingest has not run since)', async () => {
  writeFileSync(file(A.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z') +
    cline('assistant', 'Starting on orders/list.ts.', '2026-09-01T10:01:00.000Z'));
  runIngest(A.home);
  eq((await distillPending(A.store, { env: stubEnv(makeStub(distilledJson('Original distillation'))), limit: 10 })).distilled, 1, 'distilled');
  distilled = obsOf(A.store, MEM)[0];
  assert(distilled.generated_by_model.startsWith('brain/'), 'brain provenance');
  appendFileSync(file(A.home), cline('user', 'also cap the page size at 100', '2026-09-01T10:10:00.000Z') +
    cline('assistant', 'Capped the page size at 100.', '2026-09-01T10:11:00.000Z'));
  // (no ingest run here: this part of the file is about recapture. What ingest does with the
  // same growth is tested below and in ingest-growth-test.mjs.)
});

await t('dry run: reports the grown session, writes nothing, creates no journal table', () => {
  const before = snap(A.store);
  const r = recap(A, '--tool', 'claude');
  eq(r.applied, false, 'dry run'); eq(r.grown, 1, 'grown'); eq(r.distilled, 1, 'distilled'); eq(r.raw, 0, 'raw');
  eq(r.sample[0].session, MEM, 'sample names the session, not its content');
  eq(snap(A.store), before, 'store byte-identical');
  eq(q(A.store, "SELECT COUNT(*) n FROM sqlite_master WHERE name = 'bulk_change_log'")[0].n, 0, 'no journal table');
  eq(existsSync(A.backups), false, 'no backup made for a dry run');
  const u = recap(A, '--undo');
  eq(u.entries, 0, 'nothing to undo yet');
});

let backupPath;
await t('--apply: verified backup first, raw text refreshed, distillation kept, queued, journalled', () => {
  const r = recap(A, '--tool', 'claude', '--apply');
  eq(r.applied, true, 'applied'); eq(r.changed.distilled, 1, 'one distilled row recaptured');
  assert(r.backupPath && existsSync(r.backupPath), 'backup exists'); backupPath = r.backupPath;
  const bk = new DatabaseSync(backupPath, { readOnly: true });
  try {
    eq(bk.prepare('PRAGMA quick_check').get().quick_check, 'ok', 'backup integrity');
    eq(JSON.stringify(bk.prepare('SELECT * FROM observations WHERE id = ?').get(distilled.id)), JSON.stringify(distilled), 'backup holds the pre-change row');
  } finally { bk.close(); }
  const row = obsOf(A.store, MEM)[0];
  eq(row.id, distilled.id, 'same row'); eq(row.title, 'Original distillation', 'distillation kept until re-distilled');
  assert(row.text.includes('Capped the page size at 100'), 'raw text follows the transcript');
  eq(stateOf(A.store, 'distill:' + MEM).status, 'pending', 'queued for re-distillation');
  eq(pendingSessions(A.store).length, 1, 'distiller sees it');
  const log = q(A.store, "SELECT target, old_values FROM bulk_change_log WHERE kind = 'recapture' ORDER BY id");
  eq(log.map((l) => l.target).join(','), 'observations,capture_state,capture_state', 'journal: row + both bookkeeping rows');
  const old = JSON.parse(log[0].old_values);
  eq(old.title, 'Original distillation', 'the old distillation is in the journal');
  eq(old.generated_by_model, distilled.generated_by_model, 'old provenance journalled');
  eq(recap(A, '--tool', 'claude').grown, 0, 'a second dry run has nothing left');
});

await t('--undo after the distiller overwrote the distillation: the old one comes back', async () => {
  eq((await distillPending(A.store, { env: stubEnv(makeStub(distilledJson('Replacement distillation'))), limit: 10 })).distilled, 1, 're-distilled');
  eq(obsOf(A.store, MEM)[0].title, 'Replacement distillation', 'overwritten in place');
  const dry = recap(A, '--undo');
  eq(dry.applied, false, 'dry'); eq(dry.entries, 3, '3 journalled values on offer');
  const u = recap(A, '--undo', '--apply');
  eq(u.applied, true, 'applied'); eq(u.restored, 3, 'restored'); assert(u.backupPath && existsSync(u.backupPath), 'own backup');
  const row = obsOf(A.store, MEM)[0];
  eq(JSON.stringify({ ...row }), JSON.stringify(distilled), 'row exactly as before recapture, old distillation included');
  eq(stateOf(A.store, 'distill:' + MEM).status, 'done', 'distill state back to done');
  eq(pendingSessions(A.store).length, 0, 'nothing pending');
  eq(recap(A, '--undo').entries, 0, 'journal consumed');
  eq(recap(A, '--tool', 'claude').grown, 1, 'the growth is on offer again');
});

// ── raw rows ─────────────────────────────────────────────────────────────────
// Rows `brain clean --dupes` hid (or that other rows were hidden as copies of):
// ingest leaves them alone; recapture --apply handles them and journals every
// status change, so --undo reverses it.
const lifecycle = (store, id) => q(store, 'SELECT status, superseded_by, status_reason, status_at, status_prev, relevance_count FROM observations WHERE id = ?', id)[0];
const insertSurvivor = (store, text, over = {}) => rw(store, (db) => Number(db.prepare(
  "INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch, content_hash, generated_by_model, status, relevance_count) VALUES (?,?,?,'session',?,'2026-09-01',0,?,'claude',?,?)")
  .run(over.mem || 'x:survivor', 'webapp', text, 'survivor', over.hash || 'hsurv', 'active', over.rel ?? 0).lastInsertRowid));
const hideAsCopy = (store, id, survivorId) => rw(store, (db) => {
  db.prepare("UPDATE observations SET status='duplicate', superseded_by=?, status_reason=?, status_at=5, status_prev=? WHERE id=?")
    .run(survivorId, `dedupe: same memory as #${survivorId}`, JSON.stringify({ status: 'active', reason: null, at: null, relevance_added: 1 }), id);
  db.prepare('UPDATE observations SET relevance_count = COALESCE(relevance_count,0) + 1 WHERE id = ?').run(survivorId);
});

let hiddenHome;
await t('a raw capture hidden as a duplicate: ingest leaves it; recapture --apply shows it again, journalled, and --undo hides it again', () => {
  const B = hiddenHome = makeHome('h-b');
  writeFileSync(file(B.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  runIngest(B.home);
  const before = obsOf(B.store, MEM)[0];
  const surv = insertSurvivor(B.store, before.text);
  hideAsCopy(B.store, before.id, surv);
  const hiddenState = lifecycle(B.store, before.id), survState = lifecycle(B.store, surv);
  eq(survState.relevance_count, 1, 'fixture: survivor carries the copy\'s relevance');
  appendFileSync(file(B.home), cline('assistant', 'Added cursor pagination in orders/list.ts.', '2026-09-01T10:05:00.000Z'));
  const r = runIngest(B.home);
  eq(r.refreshed, 0, 'ingest does not re-queue a hidden row'); eq(r.refreshedKept, 1, 'its raw text follows the transcript (growth captured)');
  const grownText = obsOf(B.store, MEM)[0].text;
  assert(grownText.includes('Added cursor pagination'), 'growth captured on the hidden row');
  eq(JSON.stringify(lifecycle(B.store, before.id)), JSON.stringify(hiddenState), 'ingest left it hidden, status columns untouched');
  eq(JSON.stringify(lifecycle(B.store, surv)), JSON.stringify(survState), 'and the survivor untouched');
  eq(stateOf(B.store, 'distill:' + MEM), null, 'not queued for distillation while hidden');
  const dry = recap(B, '--tool', 'claude');
  eq(dry.grown, 1, 'recapture offers it'); eq(dry.textCurrent, 1, 'text already current'); eq(dry.unhide, 1, 'it would come back into view'); eq(dry.skipped.deleted, 0, 'not skipped');
  const ap = recap(B, '--tool', 'claude', '--apply');
  eq(ap.changed.raw, 1, 'recaptured'); eq(ap.changed.unhidden, 1, 'un-hidden');
  const row = obsOf(B.store, MEM)[0];
  assert(row.text.includes('Added cursor pagination'), 'text follows the transcript');
  eq(lifecycle(B.store, before.id).status, 'active', 'visible again');
  eq(lifecycle(B.store, surv).relevance_count, 0, 'the relevance it added to the survivor is taken back');
  const log = q(B.store, "SELECT target, target_key FROM bulk_change_log WHERE kind = 'recapture' AND target = 'observation_status' ORDER BY id");
  eq(log.map((l) => l.target_key).sort().join(','), [before.id, surv].sort().join(','), 'status changes of the row and of the survivor are journalled');
  eq(recap(B, '--undo', '--apply').applied, true, 'undo');
  eq(JSON.stringify(lifecycle(B.store, before.id)), JSON.stringify(hiddenState), 'hidden again, exactly as before');
  eq(JSON.stringify(lifecycle(B.store, surv)), JSON.stringify(survState), 'survivor exactly as before');
  eq(obsOf(B.store, MEM)[0].text, grownText, 'the text ingest captured stays (undo only reverses what recapture wrote)');
  eq(recap(B, '--tool', 'claude').unhide, 1, 'on offer again');
});
await t('a raw row other rows were hidden as copies of: its copies are re-checked, journalled, and --undo hides them again', () => {
  const G = makeHome('h-g');
  writeFileSync(file(G.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  runIngest(G.home);
  const before = obsOf(G.store, MEM)[0];
  const copy = insertSurvivor(G.store, before.text, { mem: 'x:copy', hash: 'hcopy' });
  hideAsCopy(G.store, copy, before.id);
  const copyState = lifecycle(G.store, copy), keptState = lifecycle(G.store, before.id);
  appendFileSync(file(G.home), cline('assistant', 'Added cursor pagination in orders/list.ts.', '2026-09-01T10:05:00.000Z'));
  const r = runIngest(G.home);
  eq(r.refreshed, 1, 'ingest follows the growth of a row other rows were hidden as copies of');
  const grownText = obsOf(G.store, MEM)[0].text;
  assert(grownText.includes('Added cursor pagination'), 'text grown');
  eq(JSON.stringify(lifecycle(G.store, copy)), JSON.stringify(copyState), 'the copy is still hidden: ingest never changes visibility');
  eq(JSON.stringify(lifecycle(G.store, before.id)), JSON.stringify(keptState), 'and the survivor\'s status columns are untouched');
  const dry = recap(G, '--tool', 'claude');
  eq(dry.grown, 1, 'recapture offers the re-check'); eq(dry.textCurrent, 1, 'text already current'); eq(dry.withCopies, 1, 'one row with hidden copies'); eq(dry.copiesRechecked, 1, 'one copy re-checked');
  const ap = recap(G, '--tool', 'claude', '--apply');
  eq(ap.changed.raw, 1, 'recaptured'); eq(ap.changed.copiesChanged, 1, 'the copy was re-checked and changed');
  eq(lifecycle(G.store, copy).status, 'active', 'the copy is no longer a copy of the longer transcript: visible');
  assert(q(G.store, "SELECT 1 FROM bulk_change_log WHERE target = 'observation_status' AND target_key = ?", String(copy)).length === 1, 'the copy\'s change is journalled');
  recap(G, '--undo', '--apply');
  eq(JSON.stringify(lifecycle(G.store, copy)), JSON.stringify(copyState), 'copy hidden again');
  eq(JSON.stringify(lifecycle(G.store, before.id)), JSON.stringify(keptState), 'survivor untouched');
  eq(obsOf(G.store, MEM)[0].text, grownText, 'the text ingest captured stays');
});
await t('a raw row nothing blocks is refreshed by ingest itself (in-flight capture of new data); recapture then has nothing', () => {
  const C = makeHome('h-c');
  writeFileSync(file(C.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  runIngest(C.home);
  appendFileSync(file(C.home), cline('assistant', 'Added cursor pagination in orders/list.ts.', '2026-09-01T10:05:00.000Z'));
  eq(runIngest(C.home).refreshed, 1, 'raw row followed the transcript');
  assert(obsOf(C.store, MEM)[0].text.includes('Added cursor pagination'), 'text grown');
  eq(recap(C, '--tool', 'claude').grown, 0, 'nothing left for recapture');
});
await t('recapture of a raw row (rewritten by an older ingest run): journalled and undoable', () => {
  const D = makeHome('h-d');
  writeFileSync(file(D.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  runIngest(D.home);
  const before = obsOf(D.store, MEM)[0];
  // Simulate a store whose bookmark says "seen the long version" (older ingest build) but whose row is still short.
  appendFileSync(file(D.home), cline('assistant', 'Added cursor pagination in orders/list.ts.', '2026-09-01T10:05:00.000Z'));
  rw(D.store, (db) => db.prepare("UPDATE capture_state SET bytes = 100000 WHERE transcript_path = ?").run('ingest:' + MEM));
  eq(runIngest(D.home).refreshed, 0, 'bookmark ahead: ingest does not look again');
  const dry = recap(D, '--tool', 'claude');
  eq(dry.grown, 1, 'recapture finds it from the stored text, not the bookmark'); eq(dry.raw, 1, 'raw');
  const ap = recap(D, '--tool', 'claude', '--apply');
  eq(ap.changed.raw, 1, 'recaptured');
  const row = obsOf(D.store, MEM)[0];
  assert(row.text.includes('Added cursor pagination') && row.narrative.includes('Added cursor pagination'), 'text and narrative follow');
  assert(row.content_hash !== before.content_hash, 'rehashed');
  eq(stateOf(D.store, 'distill:' + MEM).status, 'pending', 'queued');
  eq(recap(D, '--undo', '--apply').restored, 3, 'undo');
  eq(JSON.stringify(obsOf(D.store, MEM)[0]), JSON.stringify(before), 'raw row back exactly');
  eq(stateOf(D.store, 'distill:' + MEM), null, 'distill state removed again (it did not exist before)');
});

// ── rows that are never changed in bulk ──────────────────────────────────────
await t('hand-edited, deleted and claude-mem rows are skipped; an edit made after --apply survives --undo', async () => {
  const E = makeHome('h-e');
  writeFileSync(file(E.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z') +
    cline('assistant', 'Starting.', '2026-09-01T10:01:00.000Z'));
  runIngest(E.home);
  await distillPending(E.store, { env: stubEnv(makeStub(distilledJson('Distilled'))), limit: 10 });
  appendFileSync(file(E.home), cline('assistant', 'More work was done here.', '2026-09-01T10:20:00.000Z'));
  eq(recap(E, '--tool', 'claude', '--apply').changed.distilled, 1, 'applied');
  const id = obsOf(E.store, MEM)[0].id;
  assert(rw(E.store, (db) => editMemory(db, id, { title: 'My own title' })).ok, 'edit ok');
  const u = recap(E, '--undo', '--apply');
  eq(u.skippedEdited, 1, 'the later hand edit is not restored over');
  eq(obsOf(E.store, MEM)[0].title, 'My own title', 'edit kept');
  // deleted
  rw(E.store, (db) => db.prepare("UPDATE observations SET status = 'deleted' WHERE id = ?").run(id));
  eq(recap(E, '--tool', 'claude').grown, 0, 'a deleted row is not offered');
});
await t('claude-mem rows are never touched (a session claude-mem covers has no capture row)', () => {
  const F = makeHome('h-f');
  rw(F.store, (db) => {
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,?,?)`)
      .run(SID, 'cm-mem-0001', 'webapp', 'claude', 'add pagination', '2026-09-01T10:00:00.000Z', 1788256800000, 'completed');
    db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch, content_hash, generated_by_model) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('cm-mem-0001', 'webapp', 'user: add pagination', 'feature', 'claude-mem title', '2026-09-01T10:02:00.000Z', 1788256920000, 'cmhash01', 'claude-haiku-4-5-20251001');
  });
  writeFileSync(file(F.home), cline('user', 'add pagination', '2026-09-01T10:00:00.000Z') + cline('assistant', 'done', '2026-09-01T10:05:00.000Z'));
  const before = snap(F.store);
  const r = recap(F, '--tool', 'claude', '--apply');
  eq(r.grown, 0, 'nothing grown'); eq(r.backupPath, null, 'no backup when there is nothing to do');
  eq(snap(F.store), before, 'byte-identical');
});

// ── the journal and its content ──────────────────────────────────────────────
const SECRET = 'ghp_' + 'Zq7Xw2Lr9Tb4Nm6Kp1Vc8Hd3Js5Fg0Ay7Ue2';
await t('scrub covers the journal: after recapture --apply + scrub --apply no secret is left in it, and --undo cannot write one back', async () => {
  const H = makeHome('h-h');
  writeFileSync(file(H.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z') + cline('assistant', 'Starting.', '2026-09-01T10:01:00.000Z'));
  runIngest(H.home);
  await distillPending(H.store, { env: stubEnv(makeStub(distilledJson('Distilled'))), limit: 10 });
  // The earlier distillation carries a secret (an older scrubber missed it).
  rw(H.store, (db) => db.prepare('UPDATE observations SET narrative = ?, facts = ? WHERE memory_session_id = ?')
    .run(`wire the token ${SECRET} into CI`, JSON.stringify([`token ${SECRET}`]), MEM));
  appendFileSync(file(H.home), cline('assistant', 'More work was done here.', '2026-09-01T10:20:00.000Z'));
  eq(recap(H, '--tool', 'claude', '--apply').changed.distilled, 1, 'recaptured');
  assert(q(H.store, "SELECT old_values FROM bulk_change_log WHERE target = 'observations'")[0].old_values.includes(SECRET), 'fixture: the journal holds the old narrative');
  const audit = auditScrub({ dbPath: H.store });
  assert(audit.rowsScanned.bulk_change_log > 0, 'the audit scans the journal'); assert(audit.certain > 0, 'and finds the secret there');
  applyScrub({ dbPath: H.store, force: true });
  const journal = q(H.store, 'SELECT old_values, new_values FROM bulk_change_log');
  assert(journal.length && journal.every((j) => !(j.old_values || '').includes(SECRET) && !(j.new_values || '').includes(SECRET)), 'journal holds no secret after scrub');
  for (const j of journal) for (const v of [j.old_values, j.new_values]) if (v) JSON.parse(v); // still valid JSON
  assert(!JSON.stringify(q(H.store, 'SELECT * FROM observations')).includes(SECRET), 'rows scrubbed too');
  recap(H, '--undo', '--apply');
  const all = JSON.stringify(q(H.store, 'SELECT * FROM observations')) + JSON.stringify(q(H.store, 'SELECT * FROM bulk_change_log'));
  assert(!all.includes(SECRET), 'after --undo the secret is nowhere in the store');
  assert(obsOf(H.store, MEM)[0].title === 'Distilled', 'the rest of the old distillation is back');
});
await t('--undo is compare-and-set: a row rewritten since (scrubbed to something else) or re-distilled from raw is left as it is', async () => {
  const I = makeHome('h-i');
  writeFileSync(file(I.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  runIngest(I.home);
  appendFileSync(file(I.home), cline('assistant', 'Added cursor pagination in orders/list.ts.', '2026-09-01T10:05:00.000Z'));
  rw(I.store, (db) => db.prepare("UPDATE capture_state SET bytes = 100000 WHERE transcript_path = ?").run('ingest:' + MEM)); // a raw row an older ingest left behind
  eq(recap(I, '--tool', 'claude', '--apply').changed.raw, 1, 'recaptured');
  // The distiller then upgrades the raw row to a distillation.
  eq((await distillPending(I.store, { env: stubEnv(makeStub(distilledJson('Fresh distillation'))), limit: 10 })).distilled, 1, 'distilled');
  const distilledRow = JSON.stringify(obsOf(I.store, MEM)[0]);
  const u = recap(I, '--undo', '--apply');
  eq(u.restored, 0, 'nothing restored'); assert(u.skippedChanged >= 1, 'counted as changed since');
  eq(JSON.stringify(obsOf(I.store, MEM)[0]), distilledRow, 'the new distillation survives');
  eq(stateOf(I.store, 'distill:' + MEM).status, 'done', 'and its bookkeeping is not reverted under it');
  eq(recap(I, '--undo').entries, 0, 'journal consumed');
  eq(q(I.store, 'SELECT COUNT(*) n FROM bulk_change_log WHERE old_values IS NOT NULL OR new_values IS NOT NULL')[0].n, 0, 'an undone entry keeps no copy of row content');
});
await t('--undo --run <id> undoes one run; the other stays on offer', () => {
  const J = makeHome('h-j');
  const SID2 = 'bbbbbbbb-2222-4222-8222-000000000002', MEM2 = `claude:${SID2}`;
  const line2 = (type, text, ts) => cline(type, text, ts).replace(SID, SID2);
  writeFileSync(file(J.home, SID), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  writeFileSync(file(J.home, SID2), line2('user', 'rename the billing module to invoicing', '2026-09-01T10:00:00.000Z'));
  runIngest(J.home);
  const grow = (sid, ln) => { appendFileSync(file(J.home, sid), ln('assistant', 'Added cursor pagination in orders/list.ts.', '2026-09-01T10:05:00.000Z')); rw(J.store, (db) => db.prepare("UPDATE capture_state SET bytes = 100000 WHERE transcript_path LIKE 'ingest:%'").run()); };
  grow(SID, cline);
  const r1 = recap(J, '--tool', 'claude', '--apply');
  grow(SID2, line2);
  const r2 = recap(J, '--tool', 'claude', '--apply');
  assert(r1.runId && r2.runId && r1.runId !== r2.runId, 'two runs');
  const dry = recap(J, '--undo');
  eq(dry.runs, 2, 'two pending'); eq(dry.runIds.length, 2, 'ids listed');
  const u = recap(J, '--undo', '--apply', '--run', r1.runId);
  eq(u.restored, 3, 'only the first run restored');
  eq(recap(J, '--undo').runIds.join(','), r2.runId, 'the second is still on offer');
  assert(!obsOf(J.store, MEM)[0].text.includes('Added cursor'), 'run 1 undone'); assert(obsOf(J.store, MEM2)[0].text.includes('Added cursor'), 'run 2 kept');
});
await t('journal entries go with their rows: hard-deleted by clean --test-data, deleted in the panel', async () => {
  const K = makeHome('h-k');
  const UUIDPROJ = '11111111-2222-4333-8444-555555555555';
  mkdirSync(join(K.home, '.claude', 'projects', `-Users-x-code-${UUIDPROJ}`), { recursive: true });
  const SIDU = 'cccccccc-3333-4333-8333-000000000003', MEMU = `claude:${SIDU}`;
  const lineU = (type, text, ts) => JSON.stringify({ type, cwd: `/Users/x/code/${UUIDPROJ}`, sessionId: SIDU, timestamp: ts,
    message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
  const fileU = join(K.home, '.claude', 'projects', `-Users-x-code-${UUIDPROJ}`, `${SIDU}.jsonl`);
  writeFileSync(file(K.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z') + cline('assistant', 'Starting.', '2026-09-01T10:01:00.000Z'));
  writeFileSync(fileU, lineU('user', 'fixture run', '2026-09-01T10:00:00.000Z') + lineU('assistant', 'Starting.', '2026-09-01T10:01:00.000Z'));
  runIngest(K.home);
  await distillPending(K.store, { env: stubEnv(makeStub(distilledJson('Distilled'))), limit: 10 });
  appendFileSync(file(K.home), cline('assistant', 'More work was done here.', '2026-09-01T10:20:00.000Z'));
  appendFileSync(fileU, lineU('assistant', 'More work was done here.', '2026-09-01T10:20:00.000Z'));
  eq(recap(K, '--tool', 'claude', '--apply').changed.distilled, 2, 'both recaptured');
  const idsOf = (mem) => q(K.store, "SELECT target_key FROM bulk_change_log WHERE target = 'observations' AND target_key IN (SELECT CAST(id AS TEXT) FROM observations WHERE memory_session_id = ?)", mem).length;
  eq(idsOf(MEMU), 1, 'fixture row journalled');
  const c = cleanTestData({ dbPath: K.store, apply: true, backupDir: join(K.home, 'bk') });
  assert(c.changed !== undefined || c.applied, 'clean --test-data applied');
  eq(obsOf(K.store, MEMU).length, 0, 'fixture rows removed');
  eq(q(K.store, "SELECT COUNT(*) n FROM bulk_change_log WHERE target_key NOT IN (SELECT CAST(id AS TEXT) FROM observations) AND target IN ('observations','observation_status')")[0].n, 0, 'no journal entry of a removed row');
  eq(q(K.store, "SELECT COUNT(*) n FROM bulk_change_log WHERE target = 'capture_state' AND target_key LIKE ?", `%${MEMU}`)[0].n, 0, 'nor its bookkeeping entries');
  eq(recap(K, '--undo').entries, 3, 'the other run\'s entries remain');
  // panel delete
  const id = obsOf(K.store, MEM)[0].id;
  assert(rw(K.store, (db) => deleteMemory(db, id)).ok, 'panel delete');
  eq(q(K.store, "SELECT COUNT(*) n FROM bulk_change_log WHERE target = 'observations' AND target_key = ?", String(id))[0].n, 0, 'journalled copy of a deleted memory is dropped with it');
});

// ── ingest keeps the text current; recapture offers the fresh distillation ──
await t('distilled row grown: ingest follows the raw text only (distillation live, not queued); recapture --apply re-queues; --undo restores the stale state', async () => {
  const M = makeHome('h-m');
  writeFileSync(file(M.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z') + cline('assistant', 'Starting.', '2026-09-01T10:01:00.000Z'));
  runIngest(M.home);
  eq((await distillPending(M.store, { env: stubEnv(makeStub(distilledJson('Original distillation'))), limit: 10 })).distilled, 1, 'distilled');
  const d0 = obsOf(M.store, MEM)[0];
  eq(recap(M, '--tool', 'claude').grown, 0, 'nothing on offer yet');
  appendFileSync(file(M.home), cline('assistant', 'Capped the page size at 100.', '2026-09-01T10:20:00.000Z'));
  const r = runIngest(M.home);
  eq(r.refreshedKept, 1, 'growth captured'); eq(r.refreshed, 0, 'not a raw refresh'); eq(r.grownHeld, 0, 'nothing left uncaptured');
  const d1 = obsOf(M.store, MEM)[0];
  assert(d1.text.includes('Capped the page size'), 'raw text follows the transcript');
  for (const c of ['title', 'subtitle', 'facts', 'narrative', 'concepts', 'content_hash', 'generated_by_model', 'metadata', 'status'])
    eq(d1[c], d0[c], `${c} (the distillation) untouched`);
  eq(stateOf(M.store, 'distill:' + MEM).status, 'done', 'not re-queued'); eq(pendingSessions(M.store).length, 0, 'nothing pending');
  assert(stateOf(M.store, 'regrown:' + MEM), 'marker: distillation older than text');
  // recapture sees a distillation that is out of date, not a text that is.
  const before = snap(M.store);
  const dry = recap(M, '--tool', 'claude');
  eq(dry.grown, 1, 'on offer'); eq(dry.distilled, 1, 'distilled row'); eq(dry.textCurrent, 1, 'text already current');
  eq(snap(M.store), before, 'dry run writes nothing');
  const ap = recap(M, '--tool', 'claude', '--apply');
  eq(ap.changed.distilled, 1, 're-queued'); assert(ap.backupPath && existsSync(ap.backupPath), 'verified backup');
  eq(stateOf(M.store, 'distill:' + MEM).status, 'pending', 'pending'); eq(obsOf(M.store, MEM)[0].title, 'Original distillation', 'old distillation live until replaced');
  eq(recap(M, '--tool', 'claude').grown, 0, 'no longer on offer');
  // undo puts the queue state back and the offer returns.
  eq(recap(M, '--undo', '--apply').applied, true, 'undo');
  eq(stateOf(M.store, 'distill:' + MEM).status, 'done', 'done again');
  eq(obsOf(M.store, MEM)[0].text, d1.text, 'ingest\'s text stays'); eq(recap(M, '--tool', 'claude').grown, 1, 'offered again');
  // …and a re-distillation (by any route) clears the offer.
  rw(M.store, (db) => db.prepare("UPDATE capture_state SET status='pending', mtime = mtime WHERE transcript_path = ?").run('distill:' + MEM));
  eq((await distillPending(M.store, { env: stubEnv(makeStub(distilledJson('Fresh distillation'))), limit: 10 })).distilled, 1, 're-distilled');
  eq(recap(M, '--tool', 'claude').grown, 0, 'a fresh distillation clears the offer');
});

// ── report ───────────────────────────────────────────────────────────────────
for (const [s, n, m] of results) console.log(`${s === 'PASS' ? '  ✓' : '  ✗'} ${n}${m ? '\n    ' + m.replace(/\n/g, '\n    ') : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
