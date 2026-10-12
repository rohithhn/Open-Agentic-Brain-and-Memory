#!/usr/bin/env node
// Tests for re-capturing sessions that GREW after their first ingest
// (bin/lib/ingest.mjs growthTracker + distiller.mjs PENDING_SQL).
//
// Why this exists: ingest runs on a timer and routinely meets a session while
// it is still in flight. It used to insert the raw observation only when the
// session row was new, so a session first seen at its opening prompt stayed
// that way forever — and the distiller distilled that stub. Now a per-session
// bookmark in capture_state ('ingest:<memory_session_id>', bytes = full
// transcript length) notices growth. Automatic ingest only affects NEW data and
// never destroys an existing distillation or edit: a RAW in-flight row whose
// transcript grew by pure append is refreshed in place (scrubbed, rehashed,
// pending again); a distilled / edited / hidden row follows the transcript in its
// raw `text` only (distillation, edit and visibility kept, not re-queued:
// refreshedKept). Only a deleted row, or growth that is not a pure append, is
// left alone and counted (grownHeld). Re-distilling, un-hiding and re-checking
// copies change existing rows only through the opt-in `brain recapture`
// (evals/recapture-test.mjs).
//
//   node evals/ingest-growth-test.mjs
//
// SAFETY: every $HOME and DB is synthetic, under the scratchpad (or $TMPDIR).
// ingest() runs in a child with HOME=<fake> that refuses to run unless its
// resolved store lives under that fake home. The distiller runs against a stub
// CLI. No real transcript, store, Keychain or CLI is touched.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, writeFileSync, appendFileSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../bin/lib/store.mjs';
import { pendingSessions, distillPending, resetBinaryCache } from '../bin/lib/distiller.mjs';
import { scrubText } from '../bin/lib/scrub.mjs';
import { findTestData } from '../bin/lib/clean.mjs';
import { INGEST_STATE_PREFIX } from '../bin/lib/ingest.mjs';
import { strongHash } from '../bin/lib/hash.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `ingest-growth-test-${process.pid}`);
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

// A GitHub-token-shaped string the scrubber must catch (invented, not a real token).
const SECRET = 'ghp_' + 'Zq7Xw2Lr9Tb4Nm6Kp1Vc8Hd3Js5Fg0Ay7Ue2';
assert(scrubText(SECRET).text !== SECRET, 'fixture secret is no longer caught by the scrubber — pick another');

// ── fake $HOME + store ───────────────────────────────────────────────────────
function makeHome(name) {
  const home = join(ROOT, name);
  mkdirSync(join(home, '.claude', 'projects', '-Users-x-code-webapp'), { recursive: true });
  mkdirSync(join(home, '.codex', 'sessions', '2026', '09', '01'), { recursive: true });
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const store = join(home, '.claude-brain', 'brain.db');
  openStore({ path: store }).close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'test\n');
  return { home, store };
}

function runIngest(home, only) {
  const child = `
    const { MEMORY_DB } = await import(${JSON.stringify(join(REPO, 'bin/lib/paths.mjs'))});
    if (!MEMORY_DB.startsWith(${JSON.stringify(home)})) { console.log('UNSAFE ' + MEMORY_DB); process.exit(3); }
    const { ingest } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
    console.log(JSON.stringify(await ingest({ only: ${JSON.stringify(only)} })));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ingest child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// The opt-in path: `brain recapture --apply` against the fake home's store.
function runRecapture(home, store, ...args) {
  const r = spawnSync(process.execPath, [join(REPO, 'bin/brain.mjs'), 'recapture', '--db', store, '--json', ...args],
    { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`recapture child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const ro = (store) => new DatabaseSync(store, { readOnly: true });
function q(store, sql, ...args) {
  const db = ro(store);
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
function rw(store, fn) {
  const db = new DatabaseSync(store);
  try { return fn(db); } finally { db.close(); }
}
const obsOf = (store, mem) => q(store, 'SELECT * FROM observations WHERE memory_session_id = ? ORDER BY id', mem);
const stateOf = (store, key) => q(store, 'SELECT * FROM capture_state WHERE transcript_path = ?', key)[0] || null;

// ── Claude Code transcript fixture ───────────────────────────────────────────
const CL_SID = 'aaaaaaaa-1111-4111-8111-000000000001';
const CL_MEM = `claude:${CL_SID}`;
const cline = (type, text, ts) => JSON.stringify({
  type, cwd: '/Users/x/code/webapp', sessionId: CL_SID, timestamp: ts,
  message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
}) + '\n';
const claudeFile = (home) => join(home, '.claude', 'projects', '-Users-x-code-webapp', `${CL_SID}.jsonl`);

// ── Codex rollout fixture ────────────────────────────────────────────────────
const CX_SID = 'bbbbbbbb-2222-4222-8222-000000000002';
const CX_MEM = `codex:${CX_SID}`;
const codexFile = (home) => join(home, '.codex', 'sessions', '2026', '09', '01', `rollout-2026-09-01T10-00-00-${CX_SID}.jsonl`);
const xmeta = () => JSON.stringify({ type: 'session_meta', timestamp: '2026-09-01T10:00:00.000Z', payload: { id: CX_SID, cwd: '/Users/x/code/api', timestamp: '2026-09-01T10:00:00.000Z' } }) + '\n';
const xmsg = (role, text, ts) => JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }) + '\n';

// ── 1. Claude Code: in-flight capture, then growth ───────────────────────────
const A = makeHome('h-claude');
await t('claude: first capture inserts one raw row and records the growth bookmark', () => {
  writeFileSync(claudeFile(A.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  const r = runIngest(A.home, ['claude']).claude;
  eq(r.sessions, 1, 'sessions'); eq(r.observations, 1, 'observations'); eq(r.refreshed, 0, 'refreshed');
  const rows = obsOf(A.store, CL_MEM);
  eq(rows.length, 1, 'one capture row');
  eq(rows[0].type, 'session', 'raw type');
  eq(rows[0].content_hash, strongHash(rows[0].text), 'new raw row carries the strong v2 hash of its transcript');
  const st = stateOf(A.store, INGEST_STATE_PREFIX + CL_MEM);
  assert(st, 'ingest bookmark written');
  eq(st.bytes, 'user: add pagination to the orders endpoint'.length, 'bookmark = full transcript length');
  eq(st.session_id, CL_MEM, 'bookmark session id');
});
await t('claude: re-ingest of an unchanged transcript changes nothing (idempotent)', () => {
  const before = obsOf(A.store, CL_MEM)[0];
  const r = runIngest(A.home, ['claude']).claude;
  eq(r.sessions, 0, 'no new session'); eq(r.observations, 0, 'no new obs'); eq(r.refreshed, 0, 'not refreshed');
  const after = obsOf(A.store, CL_MEM);
  eq(after.length, 1, 'still one row');
  eq(after[0].content_hash, before.content_hash, 'hash unchanged');
  eq(stateOf(A.store, 'distill:' + CL_MEM), null, 'no distill state invented');
});
let grownHash;
await t('claude: a grown transcript refreshes the SAME row — scrubbed, rehashed, pending again', () => {
  const before = obsOf(A.store, CL_MEM)[0];
  appendFileSync(claudeFile(A.home),
    cline('assistant', 'Added cursor pagination in orders/list.ts with a limit cap of 100.', '2026-09-01T10:05:00.000Z') +
    cline('user', `now wire the token ${SECRET} into the CI secret`, '2026-09-01T10:06:00.000Z'));
  const r = runIngest(A.home, ['claude']).claude;
  eq(r.sessions, 0, 'no new session'); eq(r.observations, 0, 'no new obs'); eq(r.refreshed, 1, 'refreshed');
  eq(r.prompts, 1, 'the new prompt row is added');
  const rows = obsOf(A.store, CL_MEM);
  eq(rows.length, 1, 'no duplicate row');
  const row = rows[0];
  eq(row.id, before.id, 'same row id (updated in place)');
  eq(row.type, 'session', 'still raw');
  assert(row.text.includes('cursor pagination in orders/list.ts'), 'grown text stored');
  assert(!row.text.includes(SECRET) && !row.narrative.includes(SECRET), 'secret scrubbed before storing');
  assert(row.content_hash !== before.content_hash, 'content_hash recomputed');
  eq(row.content_hash, strongHash(row.text), 'recomputed with the strong v2 hash');
  grownHash = row.content_hash;
  eq(q(A.store, 'SELECT COUNT(*) n FROM observations_fts WHERE observations_fts MATCH ?', 'pagination')[0].n, 1, 'FTS sees the refreshed text');
  const ds = stateOf(A.store, 'distill:' + CL_MEM);
  eq(ds && ds.status, 'pending', 'distill state pending'); eq(ds.bytes, 0, 'attempts reset');
  const pend = pendingSessions(A.store, { limit: 50 }).filter((p) => p.memorySessionId === CL_MEM);
  eq(pend.length, 1, 'distiller sees it pending once');
  assert(pend[0].transcript.includes('cursor pagination'), 'distiller gets the grown transcript');
});
await t('claude: running ingest again after growth is a no-op', () => {
  const r = runIngest(A.home, ['claude']).claude;
  eq(r.refreshed, 0, 'not refreshed twice'); eq(r.prompts, 0, 'no new prompts');
  const rows = obsOf(A.store, CL_MEM);
  eq(rows.length, 1, 'one row'); eq(rows[0].content_hash, grownHash, 'hash stable');
});
await t('claude: a shorter transcript (rewrite/shrink) never rewrites the row', () => {
  writeFileSync(claudeFile(A.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  const r = runIngest(A.home, ['claude']).claude;
  eq(r.refreshed, 0, 'not refreshed');
  eq(obsOf(A.store, CL_MEM)[0].content_hash, grownHash, 'row kept');
  assert(stateOf(A.store, INGEST_STATE_PREFIX + CL_MEM).bytes > 100, 'bookmark stays at the high-water mark');
});

// ── 2. Codex rollout growth ──────────────────────────────────────────────────
const B = makeHome('h-codex');
await t('codex: growing rollout file refreshes its one raw row; idempotent after', () => {
  writeFileSync(codexFile(B.home), xmeta() + xmsg('user', 'profile the slow /search query', '2026-09-01T10:00:01.000Z'));
  let r = runIngest(B.home, ['codex']).codex;
  eq(r.sessions, 1, 'first: session'); eq(r.observations, 1, 'first: obs'); eq(r.refreshed, 0, 'first: refreshed');
  const first = obsOf(B.store, CX_MEM);
  eq(first.length, 1, 'one row');
  appendFileSync(codexFile(B.home),
    xmsg('assistant', 'The planner skipped the trigram index; added a GIN index on title.', '2026-09-01T10:03:00.000Z') +
    xmsg('user', 'add a regression benchmark', '2026-09-01T10:04:00.000Z'));
  r = runIngest(B.home, ['codex']).codex;
  eq(r.sessions, 0, 'grown: no new session'); eq(r.observations, 0, 'grown: no new obs'); eq(r.refreshed, 1, 'grown: refreshed');
  const rows = obsOf(B.store, CX_MEM);
  eq(rows.length, 1, 'no duplicate');
  eq(rows[0].id, first[0].id, 'same row');
  assert(rows[0].text.includes('GIN index on title'), 'grown text');
  assert(rows[0].content_hash !== first[0].content_hash, 'rehashed');
  eq(stateOf(B.store, 'distill:' + CX_MEM).status, 'pending', 'pending');
  r = runIngest(B.home, ['codex']).codex;
  eq(r.refreshed, 0, 'third run: no-op');
  eq(obsOf(B.store, CX_MEM)[0].content_hash, rows[0].content_hash, 'third run: hash stable');
});

// ── 3. Already distilled by the brain → re-distilled in place ────────────────
function makeStub(out) {
  const bin = join(ROOT, 'stub-claude');
  writeFileSync(bin, `#!${process.execPath}
let d = ''; process.stdin.on('data', (c) => { d += c; }); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(out)}); });
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}
const distilledJson = (title) => JSON.stringify({
  title,
  subtitle: 'Cursor pagination with a hard page-size cap was added to the orders list endpoint.',
  type: 'feature',
  facts: ['orders/list.ts now pages by an opaque cursor.', 'Page size is capped at 100 rows.'],
  narrative: 'The orders endpoint returned every row. Cursor pagination was added with a page-size cap so large accounts no longer time out.',
  concepts: ['pagination', 'api'],
});
function stubEnv(bin) {
  resetBinaryCache();
  return {
    ...process.env,
    BRAIN_DISTILL_CLAUDE_BIN: bin,
    BRAIN_DISTILL_CODEX_BIN: join(ROOT, 'missing'),
    BRAIN_DISTILL_AGY_BIN: join(ROOT, 'missing'),
    PATH: join(ROOT, 'empty-path'), HOME: join(ROOT, 'distill-home'),
  };
}
const C = makeHome('h-distilled');
let distilledRow;
await t('distilled: first distillation upgrades the raw row and marks it done', async () => {
  writeFileSync(claudeFile(C.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z') +
    cline('assistant', 'Starting on orders/list.ts.', '2026-09-01T10:01:00.000Z'));
  runIngest(C.home, ['claude']);
  const rep = await distillPending(C.store, { env: stubEnv(makeStub(distilledJson('Added cursor pagination to the orders list endpoint'))), limit: 10 });
  eq(rep.distilled, 1, `distilled (report ${JSON.stringify({ ...rep, providers: undefined })})`);
  const rows = obsOf(C.store, CL_MEM);
  eq(rows.length, 1, 'one row');
  assert(rows[0].generated_by_model.startsWith('brain/'), 'brain provenance');
  eq(stateOf(C.store, 'distill:' + CL_MEM).status, 'done', 'done');
  eq(pendingSessions(C.store).length, 0, 'nothing pending');
  distilledRow = rows[0];
});
await t('distilled: growth refreshes the raw text only — the distillation stays live and is not re-queued; recapture then offers a fresh one', () => {
  appendFileSync(claudeFile(C.home), cline('user', 'also cap the page size at 100', '2026-09-01T10:10:00.000Z') +
    cline('assistant', 'Capped the page size at 100 in orders/list.ts.', '2026-09-01T10:11:00.000Z'));
  const r = runIngest(C.home, ['claude']).claude;
  eq(r.refreshed, 0, 'not a raw refresh'); eq(r.refreshedKept, 1, 'growth captured, distillation kept'); eq(r.grownHeld, 0, 'nothing left uncaptured'); eq(r.observations, 0, 'no new obs');
  const rows = obsOf(C.store, CL_MEM);
  eq(rows.length, 1, 'no duplicate');
  assert(rows[0].text.includes('Capped the page size at 100'), 'raw text follows the transcript');
  eq(JSON.stringify({ ...rows[0], text: null }), JSON.stringify({ ...distilledRow, text: null }), 'every other column — the whole distillation — is byte-identical');
  eq(stateOf(C.store, 'distill:' + CL_MEM).status, 'done', 'not re-queued');
  eq(pendingSessions(C.store).length, 0, 'nothing pending');
  assert(stateOf(C.store, 'regrown:' + CL_MEM), 'marker: the distillation is older than the text');
  // Ingest again: nothing more to do.
  const r2 = runIngest(C.home, ['claude']).claude;
  eq(r2.refreshedKept, 0, 'idempotent'); eq(r2.grownHeld, 0, 'idempotent');
  // The opt-in command offers the fresh distillation: re-queued, old distillation kept until replaced.
  const dry = runRecapture(C.home, C.store);
  eq(dry.applied, false, 'dry run'); eq(dry.grown, 1, 'dry run sees the stale distillation'); eq(dry.distilled, 1, 'one distilled'); eq(dry.textCurrent, 1, 'text already current');
  eq(JSON.stringify(obsOf(C.store, CL_MEM)[0]), JSON.stringify(rows[0]), 'dry run changed nothing');
  const ap = runRecapture(C.home, C.store, '--apply');
  eq(ap.changed.distilled, 1, 'recaptured');
  const row = obsOf(C.store, CL_MEM)[0];
  eq(row.id, distilledRow.id, 'same row');
  eq(row.title, distilledRow.title, 'distilled title kept until re-distilled');
  eq(row.content_hash, distilledRow.content_hash, 'distilled hash kept');
  eq(row.generated_by_model, distilledRow.generated_by_model, 'provenance kept');
  assert(row.text.includes('Capped the page size at 100'), 'raw text current');
  const ds = stateOf(C.store, 'distill:' + CL_MEM);
  eq(ds.status, 'pending', 'pending again'); eq(ds.bytes, 0, 'attempts reset');
  const pend = pendingSessions(C.store);
  eq(pend.length, 1, 'one pending'); eq(pend[0].obsId, row.id, 'pending points at the upgraded row');
});
await t('distilled: re-distillation overwrites the same row, keeps the original capture hash, marks done', async () => {
  const rep = await distillPending(C.store, { env: stubEnv(makeStub(distilledJson('Added capped cursor pagination to the orders list endpoint'))), limit: 10 });
  eq(rep.distilled, 1, 'distilled');
  const rows = obsOf(C.store, CL_MEM);
  eq(rows.length, 1, 'still one row');
  eq(rows[0].id, distilledRow.id, 'same row');
  eq(rows[0].title, 'Added capped cursor pagination to the orders list endpoint', 'new distillation');
  const meta = JSON.parse(rows[0].metadata);
  const prevMeta = JSON.parse(distilledRow.metadata);
  eq(meta.source_content_hash, prevMeta.source_content_hash, 'original capture identity kept');
  eq(meta.redistilled_from, prevMeta.distilled_at, 'redistilled_from recorded');
  eq(stateOf(C.store, 'distill:' + CL_MEM).status, 'done', 'done');
  eq(pendingSessions(C.store).length, 0, 'nothing pending');
  const r = runIngest(C.home, ['claude']).claude;
  eq(r.refreshed, 0, 'ingest after re-distill is a no-op');
  eq(pendingSessions(C.store).length, 0, 'still nothing pending');
});

// ── 4. Rows claude-mem distilled are never touched ───────────────────────────
const D = makeHome('h-claudemem');
await t('claude-mem: a session claude-mem covers gets no raw row, before or after growth; its rows untouched', () => {
  rw(D.store, (db) => {
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt,
      started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,?,?)`)
      .run(CL_SID, 'cm-mem-0001', 'webapp', 'claude', 'add pagination', '2026-09-01T10:00:00.000Z', 1788256800000, 'completed');
    db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
      prompt_number, created_at, created_at_epoch, content_hash, generated_by_model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('cm-mem-0001', 'webapp', null, 'feature', 'claude-mem title', 'sub', '["f"]', 'claude-mem narrative', '["x"]',
        1, '2026-09-01T10:02:00.000Z', 1788256920000, 'cmhash01', 'claude-haiku-4-5-20251001');
  });
  const snap = () => JSON.stringify(q(D.store, 'SELECT * FROM observations ORDER BY id'));
  const before = snap();
  writeFileSync(claudeFile(D.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  let r = runIngest(D.home, ['claude']).claude;
  eq(r.sessions, 0, 'session already known (claude-mem)'); eq(r.observations, 0, 'no raw row');
  appendFileSync(claudeFile(D.home), cline('assistant', 'Added cursor pagination.', '2026-09-01T10:05:00.000Z'));
  r = runIngest(D.home, ['claude']).claude;
  eq(r.refreshed, 0, 'nothing refreshed');
  eq(snap(), before, 'observations byte-identical');
  eq(obsOf(D.store, CL_MEM).length, 0, 'no row under the ingest id');
  eq(q(D.store, "SELECT COUNT(*) n FROM capture_state WHERE transcript_path LIKE 'distill:%'")[0].n, 0, 'nothing queued for distilling');
});

// ── 5. Stores captured before this existed (no bookmark yet) ─────────────────
const E = makeHome('h-upgrade');
await t('upgrade: first sight only records a baseline — no existing row is rewritten; later growth is tracked', () => {
  // Three sessions captured in flight by an older ingest: same rows, no bookmark.
  const S1 = 'cccccccc-3333-4333-8333-000000000003', S2 = 'dddddddd-4444-4444-8444-000000000004', S3 = 'eeeeeeee-5555-4555-8555-000000000005';
  const dir = join(E.home, '.claude', 'projects', '-Users-x-code-webapp');
  const line = (sid, type, text, ts) => JSON.stringify({ type, cwd: '/Users/x/code/webapp', sessionId: sid, timestamp: ts,
    message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
  for (const s of [S1, S2, S3]) writeFileSync(join(dir, `${s}.jsonl`), line(s, 'user', `first prompt of ${s.slice(0, 4)}`, '2026-09-01T09:00:00.000Z'));
  runIngest(E.home, ['claude']);
  rw(E.store, (db) => {
    db.exec("DELETE FROM capture_state WHERE transcript_path LIKE 'ingest:%'"); // = an older ingest
    // S2 was distilled by the brain; S3's stored text drifted (e.g. older scrubber).
    db.prepare("UPDATE observations SET type='feature', title='Distilled S2', generated_by_model='brain/claude:haiku', content_hash='d2' WHERE memory_session_id=?").run(`claude:${S2}`);
    db.prepare("INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status) VALUES (?,?,?,?,'done')").run(`distill:claude:${S2}`, 1, 1, `claude:${S2}`);
    db.prepare("UPDATE observations SET text='user: [REDACTED] first prompt', content_hash='x3' WHERE memory_session_id=?").run(`claude:${S3}`);
  });
  for (const s of [S1, S2, S3]) appendFileSync(join(dir, `${s}.jsonl`), line(s, 'assistant', `worked on ${s.slice(0, 4)} for a while`, '2026-09-01T09:30:00.000Z'));
  const rowsBefore = JSON.stringify(q(E.store, "SELECT * FROM observations WHERE memory_session_id LIKE 'claude:%' ORDER BY id"));
  const stateBefore = JSON.stringify(q(E.store, "SELECT * FROM capture_state WHERE transcript_path LIKE 'distill:%' ORDER BY transcript_path"));
  const r = runIngest(E.home, ['claude']).claude;
  eq(r.refreshed, 0, 'the first ingest after an upgrade rewrites no existing row');
  eq(JSON.stringify(q(E.store, "SELECT * FROM observations WHERE memory_session_id LIKE 'claude:%' ORDER BY id")), rowsBefore, 'every row byte-identical');
  eq(JSON.stringify(q(E.store, "SELECT * FROM capture_state WHERE transcript_path LIKE 'distill:%' ORDER BY transcript_path")), stateBefore, 'nothing re-queued');
  for (const s of [S1, S2, S3]) assert(stateOf(E.store, `ingest:claude:${s}`), `baseline bookmark for ${s.slice(0, 4)}`);
  // The stale raw row (S1) is on offer to `brain recapture` instead.
  const rc = spawnSync(process.execPath, [join(REPO, 'bin/brain.mjs'), 'recapture', '--db', E.store, '--tool', 'claude', '--json'],
    { env: { ...process.env, HOME: E.home }, encoding: 'utf8' });
  const plan = JSON.parse(rc.stdout);
  eq(plan.applied, false, 'dry run'); eq(plan.raw, 1, 'S1 offered (raw)'); eq(plan.distilled, 1, 'S2 offered (distilled)');
  // From now on the sessions are tracked: S1 (raw, in flight) follows further growth, S2 (distilled) is only counted.
  appendFileSync(join(dir, `${S1}.jsonl`), line(S1, 'user', 'and one more thing', '2026-09-01T09:40:00.000Z'));
  appendFileSync(join(dir, `${S2}.jsonl`), line(S2, 'user', 'and one more thing', '2026-09-01T09:40:00.000Z'));
  const r2 = runIngest(E.home, ['claude']).claude;
  eq(r2.refreshed, 1, 'S1 (raw) refreshed'); eq(r2.refreshedKept, 1, 'S2 (distilled): raw text follows, distillation kept');
  assert(obsOf(E.store, `claude:${S1}`)[0].text.includes('one more thing') && obsOf(E.store, `claude:${S1}`)[0].text.includes('worked on cccc'), 'S1 caught up with the whole transcript');
  eq(stateOf(E.store, `distill:claude:${S2}`).status, 'done', 'S2 still not re-queued');
  eq(obsOf(E.store, `claude:${S2}`)[0].title, 'Distilled S2', 'S2 distillation kept');
  assert(obsOf(E.store, `claude:${S2}`)[0].text.includes('one more thing'), 'S2 raw text follows the transcript');
});

// ── 6. A row the user deleted in the panel stays deleted ─────────────────────
const F = makeHome('h-deleted');
await t('deleted: growth of a soft-deleted row neither rewrites nor re-queues it', () => {
  writeFileSync(claudeFile(F.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  runIngest(F.home, ['claude']);
  rw(F.store, (db) => db.prepare("UPDATE observations SET status='deleted' WHERE memory_session_id=?").run(CL_MEM));
  const before = obsOf(F.store, CL_MEM)[0];
  appendFileSync(claudeFile(F.home), cline('assistant', 'Added cursor pagination.', '2026-09-01T10:05:00.000Z'));
  const rf = runIngest(F.home, ['claude']).claude;
  eq(rf.refreshed, 0, 'not refreshed'); eq(rf.refreshedKept, 0, 'not captured'); eq(rf.grownHeld, 1, 'counted');
  const after = obsOf(F.store, CL_MEM)[0];
  eq(after.text, before.text, 'text kept'); eq(after.status, 'deleted', 'still deleted');
  eq(stateOf(F.store, 'distill:' + CL_MEM), null, 'not queued');
});

await t('not a pure append (the transcript changed rather than grew): row left alone and counted', () => {
  const N = makeHome('h-notappend');
  writeFileSync(claudeFile(N.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  runIngest(N.home, ['claude']);
  const before = obsOf(N.store, CL_MEM)[0];
  // the head differs from what is stored (e.g. a parser change) and the session grew
  writeFileSync(claudeFile(N.home), cline('user', 'add cursor pagination to the orders endpoint', '2026-09-01T10:00:00.000Z') +
    cline('assistant', 'Added it.', '2026-09-01T10:05:00.000Z'));
  const rn = runIngest(N.home, ['claude']).claude;
  eq(rn.refreshed, 0, 'not refreshed'); eq(rn.refreshedKept, 0, 'not captured'); eq(rn.grownHeld, 1, 'counted');
  eq(JSON.stringify(obsOf(N.store, CL_MEM)[0]), JSON.stringify(before), 'row byte-identical');
});

// ── 7. brain clean finds the bookmark with the session it belongs to ─────────
await t('clean: --test-data removes a fixture session\'s ingest bookmark with its distill state', () => {
  const G = makeHome('h-clean');
  const mem = 'claude:probe-1';
  rw(G.store, (db) => {
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt,
      started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,?,?)`).run('probe-1', mem, 'e2e-probe-007', 'claude', 'p', 'x', 1, 'completed');
    const st = db.prepare('INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status) VALUES (?,?,?,?,?)');
    st.run('distill:' + mem, 1, 0, mem, 'pending');
    st.run(INGEST_STATE_PREFIX + mem, 1, 10, mem, 'captured');
    st.run('regrown:' + mem, 1, 0, mem, 'regrown');
  });
  const db = ro(G.store);
  try {
    const ids = findTestData(db).state.map((s) => s.id).sort();
    eq(ids.join(','), `distill:${mem},ingest:${mem},regrown:${mem}`, 'all bookmarks found');
  } finally { db.close(); }
});

// ── 8. The session grows WHILE the distiller's CLI is running ────────────────
// watch-codex runs ingest within seconds of every rollout change and the
// distiller is a separate launchd job, so they overlap on exactly the in-flight
// sessions this feature is for. The stub CLI appends a turn and runs a real
// ingest (as watch/sync would) before it answers with a distillation of the OLD
// transcript. That answer must not be written over the grown row.
function makeRacingStub(home, file, appended, out) {
  const bin = join(ROOT, `stub-racing-${Math.random().toString(36).slice(2, 8)}`);
  const child = `
    const { MEMORY_DB } = await import(${JSON.stringify(join(REPO, 'bin/lib/paths.mjs'))});
    if (!MEMORY_DB.startsWith(${JSON.stringify(home)})) process.exit(3);
    const { ingest } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
    console.log(JSON.stringify(await ingest({ only: ['claude'] })));`;
  writeFileSync(bin, `#!${process.execPath}
const { appendFileSync } = require('node:fs'); const { spawnSync } = require('node:child_process');
let d = ''; process.stdin.on('data', (c) => { d += c; }); process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(appended)});
  const r = spawnSync(${JSON.stringify(process.execPath)}, ['--input-type=module', '-e', ${JSON.stringify(child)}],
    { env: { ...process.env, HOME: ${JSON.stringify(home)} }, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write('mid-distill ingest failed ' + r.status + r.stderr); process.exit(1); }
  process.stdout.write(${JSON.stringify(out)});
});
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}
const H = makeHome('h-race');
await t('race: growth during a first distillation is not overwritten, and the session stays pending', async () => {
  writeFileSync(claudeFile(H.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  runIngest(H.home, ['claude']);
  const late = cline('assistant', 'LATE-TURN: switched to keyset pagination with a 100 cap', '2026-09-01T10:30:00.000Z');
  const stub = makeRacingStub(H.home, claudeFile(H.home), late, distilledJson('Added offset pagination to the orders endpoint'));
  const rep = await distillPending(H.store, { env: stubEnv(stub), limit: 10 });
  eq(rep.distilled, 0, 'stale distillation not written');
  eq(rep.stale, 1, 'reported as stale'); eq(rep.conflicts, 0, 'not a conflict');
  const row = obsOf(H.store, CL_MEM)[0];
  eq(row.type, 'session', 'row still raw');
  assert(row.text.includes('LATE-TURN'), 'grown text kept');
  eq(row.title, 'add pagination to the orders endpoint', 'title not replaced by the stale distillation');
  const ds = stateOf(H.store, 'distill:' + CL_MEM);
  eq(ds.status, 'pending', 'still pending'); eq(ds.bytes, 0, 'no attempt burned');
  const pend = pendingSessions(H.store);
  eq(pend.length, 1, 'pending once'); assert(pend[0].transcript.includes('LATE-TURN'), 'next run reads the grown transcript');
  const rep2 = await distillPending(H.store, { env: stubEnv(makeStub(distilledJson('Added keyset pagination to the orders endpoint'))), limit: 10 });
  eq(rep2.distilled, 1, 'next run distils the current text');
  const done = obsOf(H.store, CL_MEM)[0];
  eq(done.title, 'Added keyset pagination to the orders endpoint', 'distillation of the grown transcript');
  assert(done.text.includes('LATE-TURN'), 'text still the grown transcript');
  eq(stateOf(H.store, 'distill:' + CL_MEM).status, 'done', 'done');
});
await t('race: growth during a RE-distillation: the raw text follows (ingest), the stale distillation is not written, the next run distils the current text', async () => {
  appendFileSync(claudeFile(H.home), cline('user', 'document the cursor format', '2026-09-01T11:00:00.000Z'));
  const g = runIngest(H.home, ['claude']).claude;
  eq(g.refreshed, 0, 'not a raw refresh'); eq(g.refreshedKept, 1, 'distilled row: text follows, distillation kept');
  eq(runRecapture(H.home, H.store, '--apply').changed.distilled, 1, 'recapture re-queues it (stale distillation)');
  const late = cline('assistant', 'LATE-TURN-2: documented the cursor as base64 of (created_at, id)', '2026-09-01T11:10:00.000Z');
  const rep = await distillPending(H.store, { env: stubEnv(makeRacingStub(H.home, claudeFile(H.home), late, distilledJson('Documented the cursor'))), limit: 10 });
  // The mid-run ingest moved the row's text, so a distillation of the old text is not pinned to the new one.
  eq(rep.distilled, 0, 'stale distillation not written'); eq(rep.stale, 1, 'reported as stale');
  const mid = obsOf(H.store, CL_MEM)[0];
  eq(mid.title, 'Added keyset pagination to the orders endpoint', 'the earlier distillation is still the live one');
  assert(mid.text.includes('LATE-TURN-2'), 'late turn captured by the mid-run ingest');
  eq(stateOf(H.store, 'distill:' + CL_MEM).status, 'pending', 'still pending');
  const rep2 = await distillPending(H.store, { env: stubEnv(makeStub(distilledJson('Documented the cursor'))), limit: 10 });
  eq(rep2.distilled, 1, 'next run distils the current text');
  eq(obsOf(H.store, CL_MEM)[0].title, 'Documented the cursor', 'new distillation');
  eq(stateOf(H.store, 'distill:' + CL_MEM).status, 'done', 'done');
  eq(runRecapture(H.home, H.store).grown, 0, 'nothing left on offer');
});

// ── 9. Hand edits made in the panel survive growth ───────────────────────────
const { editMemory } = await import('../bin/lib/curate.mjs');
const I = makeHome('h-edited');
await t('edited (distilled row): growth follows in the raw text only; the curated row is kept; recapture skips it', async () => {
  writeFileSync(claudeFile(I.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  runIngest(I.home, ['claude']);
  eq((await distillPending(I.store, { env: stubEnv(makeStub(distilledJson('Added cursor pagination'))), limit: 10 })).distilled, 1, 'distilled');
  const id = obsOf(I.store, CL_MEM)[0].id;
  const r = rw(I.store, (db) => editMemory(db, id, { title: 'My curated title', narrative: 'What I actually decided.', facts: ['curated fact'] }));
  assert(r.ok, `edit ok: ${JSON.stringify(r)}`);
  const edited = obsOf(I.store, CL_MEM)[0];
  assert(JSON.parse(edited.metadata).edited_at, 'edit marker stamped');
  eq(JSON.parse(edited.metadata).distiller, 'brain', 'distillation provenance kept in metadata');
  appendFileSync(claudeFile(I.home), cline('assistant', 'Added cursor pagination with a cap.', '2026-09-01T10:05:00.000Z'));
  const gi = runIngest(I.home, ['claude']).claude;
  eq(gi.refreshed, 0, 'not a raw refresh'); eq(gi.refreshedKept, 1, 'growth captured'); eq(gi.grownHeld, 0, 'nothing uncaptured');
  const row = obsOf(I.store, CL_MEM)[0];
  assert(row.text.includes('with a cap'), 'raw text follows the transcript');
  eq(JSON.stringify({ ...row, text: null }), JSON.stringify({ ...edited, text: null }), 'the curated row (title, facts, narrative, metadata) is untouched');
  eq(stateOf(I.store, 'regrown:' + CL_MEM), null, 'an edited row is never offered for re-distillation');
  const rc = runRecapture(I.home, I.store);
  eq(rc.grown, 0, 'recapture does not offer a hand-edited row');
  eq(stateOf(I.store, 'distill:' + CL_MEM).status, 'done', 'not re-queued');
  eq(pendingSessions(I.store).length, 0, 'nothing pending');
});
await t('edited (raw row): growth follows in the raw text only; the curated row is kept and the distiller never overwrites it', () => {
  const J = makeHome('h-edited-raw');
  writeFileSync(claudeFile(J.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  runIngest(J.home, ['claude']);
  const id = obsOf(J.store, CL_MEM)[0].id;
  assert(rw(J.store, (db) => editMemory(db, id, { title: 'Pagination plan', narrative: 'Keyset, not offset.' })).ok, 'edit ok');
  eq(pendingSessions(J.store).length, 0, 'an edited raw row is not distilled over');
  appendFileSync(claudeFile(J.home), cline('assistant', 'Added keyset pagination.', '2026-09-01T10:05:00.000Z'));
  const before = obsOf(J.store, CL_MEM)[0];
  const gj = runIngest(J.home, ['claude']).claude;
  eq(gj.refreshed, 0, 'not a raw refresh'); eq(gj.refreshedKept, 1, 'growth captured'); eq(gj.grownHeld, 0, 'nothing uncaptured');
  const row = obsOf(J.store, CL_MEM)[0];
  assert(row.text.includes('keyset pagination'), 'raw text follows the transcript');
  eq(JSON.stringify({ ...row, text: null }), JSON.stringify({ ...before, text: null }), 'curated raw row otherwise byte-identical (title, narrative, hash)');
  eq(stateOf(J.store, 'distill:' + CL_MEM), null, 'not queued');
  eq(pendingSessions(J.store).length, 0, 'still not pending');
});
await t('edited mid-distillation: the distiller does not overwrite the edit', async () => {
  const K = makeHome('h-edited-race');
  writeFileSync(claudeFile(K.home), cline('user', 'add pagination to the orders endpoint', '2026-09-01T10:00:00.000Z'));
  runIngest(K.home, ['claude']);
  const id = obsOf(K.store, CL_MEM)[0].id;
  const bin = join(ROOT, 'stub-editing');
  writeFileSync(bin, `#!${process.execPath}
let d = ''; process.stdin.on('data', (c) => { d += c; }); process.stdin.on('end', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { editMemory } = await import(${JSON.stringify(join(REPO, 'bin/lib/curate.mjs'))});
  const db = new DatabaseSync(${JSON.stringify(K.store)});
  const r = editMemory(db, ${id}, { title: 'Edited while distilling' }); db.close();
  if (!r.ok) process.exit(1);
  process.stdout.write(${JSON.stringify(distilledJson('Machine title'))});
});
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  const rep = await distillPending(K.store, { env: stubEnv(bin), limit: 10 });
  eq(rep.distilled, 0, 'not written'); eq(rep.stale, 1, 'stale');
  const row = obsOf(K.store, CL_MEM)[0];
  eq(row.title, 'Edited while distilling', 'edit kept'); eq(row.type, 'session', 'not upgraded');
  eq(pendingSessions(K.store).length, 0, 'edited row no longer pending');
});

// ── 10. Growth past the 8,000-char cap does not re-distil identical content ──
await t('cap: a distilled row whose stored head is clipped is not re-queued by growth past the cap', async () => {
  const L = makeHome('h-cap');
  const big = 'OLDSCRUB ' + 'refactor the orders module step by step. '.repeat(250); // > 8,000 chars
  writeFileSync(claudeFile(L.home), cline('user', big, '2026-09-01T10:00:00.000Z'));
  runIngest(L.home, ['claude']);
  const raw = obsOf(L.store, CL_MEM)[0];
  assert(raw.text.endsWith('…') && raw.text.length === 8001, 'stored text clipped at the cap');
  eq((await distillPending(L.store, { env: stubEnv(makeStub(distilledJson('Refactored the orders module'))), limit: 10 })).distilled, 1, 'distilled');
  // An older scrubber/parser stored a different head than today's would.
  rw(L.store, (db) => db.prepare("UPDATE observations SET text = replace(text, 'OLDSCRUB', 'XXXXXXXX') WHERE memory_session_id = ?").run(CL_MEM));
  const bm = stateOf(L.store, INGEST_STATE_PREFIX + CL_MEM).bytes;
  appendFileSync(claudeFile(L.home), cline('assistant', 'Split orders into three files.', '2026-09-01T10:05:00.000Z'));
  eq(runIngest(L.home, ['claude']).claude.refreshed, 0, 'not refreshed');
  eq(stateOf(L.store, 'distill:' + CL_MEM).status, 'done', 'not re-queued');
  eq(pendingSessions(L.store).length, 0, 'nothing pending');
  assert(stateOf(L.store, INGEST_STATE_PREFIX + CL_MEM).bytes > bm, 'bookmark still advances');
  assert(obsOf(L.store, CL_MEM)[0].text.includes('XXXXXXXX'), 'row not rewritten');
});

// ── report ───────────────────────────────────────────────────────────────────
for (const [s, n, m] of results) console.log(`${s === 'PASS' ? '✓' : '✗'} ${n}${m ? `\n    ${m}` : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
