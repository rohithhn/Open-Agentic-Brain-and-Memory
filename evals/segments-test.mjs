#!/usr/bin/env node
// Tests for SEGMENTED distillation of long sessions
// (bin/lib/segments.mjs + the SEGMENTS section of bin/lib/distiller.mjs +
// the full-transcript store in bin/lib/ingest.mjs).
//
//   node evals/segments-test.mjs
//
// The bug these cover: ingest kept the first 8000 chars of a session, the
// distiller sent the first 6000 and kept ONE observation per session (rewriting
// it as the session grew) — so a multi-day session became one memory about its
// opening topic. Now: ingest stores the full scrubbed transcript beside the row,
// the distiller cuts it into ~6000-char segments and distils one observation per
// segment; growth only adds new segments.
//
// NO TEST EVER CALLS A REAL MODEL. Provider CLIs are stub executables; every
// $HOME and DB is synthetic under the scratchpad. The real store is never opened.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync, appendFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../bin/lib/store.mjs';
import { scrubText } from '../bin/lib/scrub.mjs';
import { strongHash } from '../bin/lib/hash.mjs';
import { SELF_PROMPT_PREFIXES } from '../bin/lib/selfcapture.mjs';
import {
  segmentTranscript, splitMessages, segmentId, saveTranscript, loadTranscript, transcriptMeta, isSelfSegment,
} from '../bin/lib/segments.mjs';
import {
  DEFAULTS, pendingSessions, distillPending, planBatch, resetBinaryCache, buildPrompt, segmentStateKey,
} from '../bin/lib/distiller.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `segments-test-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.stack ? e.message : String(e)]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
let seq = 0;

// ── stub provider CLI: records every prompt it is sent ───────────────────────
function makeStub() {
  const id = `stub-${++seq}`;
  const dir = join(ROOT, 'stubs');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${id}.log`);
  const bin = join(dir, id);
  const out = JSON.stringify({
    title: 'Reworked the pagination cursor handling',
    subtitle: 'The cursor is now opaque and signed.',
    type: 'change',
    facts: [
      'The cursor encoding moved from raw offsets to an opaque token.',
      'The orders endpoint now rejects tampered cursors with a 400.',
      'Pagination tests cover the empty page and the last page.',
      'The page size is capped at 100 rows.',
    ],
    narrative: 'The session reworked how pagination cursors are produced and validated. The opaque token replaced raw offsets. Tests were extended to cover boundary pages.',
    concepts: ['pagination', 'api-design'],
  });
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
let data = '', done = false;
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', go);
process.stdin.on('error', go);
setTimeout(go, 1500).unref();
function go() {
  if (done) return; done = true;
  try { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ stdin: data }) + '\\n'); } catch {}
  process.stdout.write(${JSON.stringify(out)});
  process.exit(0);
}
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).stdin) : []),
  };
}
function stubEnv(stub) {
  resetBinaryCache();
  const e = { ...process.env };
  e.BRAIN_DISTILL_CLAUDE_BIN = stub ? stub.bin : join(ROOT, 'missing-claude');
  e.BRAIN_DISTILL_CODEX_BIN = join(ROOT, 'missing-codex');
  e.BRAIN_DISTILL_AGY_BIN = join(ROOT, 'missing-agy');
  e.PATH = join(ROOT, 'empty-path');
  e.HOME = join(ROOT, 'home');
  return e;
}

// ── transcript fixtures ──────────────────────────────────────────────────────
const filler = (tag, n) => (`${tag} lorem ipsum dolor sit amet consectetur `).repeat(Math.ceil(n / 40)).slice(0, n);
// i-th user/assistant pair, each message ~w chars, each carrying a unique marker.
const userTurn = (i, w = 500) => `user: SEGMARK-U${i} ${filler('q' + i, w)}`;
const asstTurn = (i, w = 500) => `assistant: SEGMARK-A${i} ${filler('a' + i, w)}`;
const pairs = (from, to, w) => Array.from({ length: to - from }, (_, k) => `${userTurn(from + k, w)}\n\n${asstTurn(from + k, w)}`).join('\n\n');
const T0 = Date.parse('2026-08-01T09:00:00.000Z');
// marks: [offset, epochMs] per message, one hour apart
function marksOf(text) {
  return splitMessages(text).map((r, i) => [r.start, T0 + i * 3600_000]);
}

// ── synthetic store ──────────────────────────────────────────────────────────
function newStore() {
  const dir = join(ROOT, `db-${++seq}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'brain.db');
  openStore({ path: dbPath }).close();
  return dbPath;
}
const clip8000 = (s) => (s.length > 8000 ? s.slice(0, 8000) + '…' : s);
// A captured session as ingest leaves it: sdk_sessions + one raw row (clipped to 8000)
// + the full transcript beside it. `legacyDistilled` makes the row an old whole-session
// brain distillation (no metadata.segment).
function addSession(dbPath, { sid, full, platform = 'claude', project = 'proj-seg', firstPrompt = 'rework pagination', withFull = true, legacyDistilled = false, savedAt = Date.now(), epoch = 1_700_000_000_000 } = {}) {
  const mem = `${platform}:${sid}`;
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status)
                VALUES (?,?,?,?,?,?,?, 'completed')`).run(sid, mem, project, platform, firstPrompt, new Date(epoch).toISOString(), epoch);
    const text = clip8000(full);
    if (legacyDistilled) {
      db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts, prompt_number, created_at, created_at_epoch, content_hash, generated_by_model, metadata)
                  VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`).run(
        mem, project, text, 'discovery', 'OLD whole-session distillation', 'old', '["old fact"]', 'old narrative', '["brain-distilled"]',
        new Date(epoch).toISOString(), epoch, 'legacyhash-' + sid, 'brain/claude:haiku', JSON.stringify({ distiller: 'brain', distilled_at: '2026-07-01T00:00:00.000Z' }));
      db.prepare(`INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status) VALUES (?,?,1,?,'done')`).run('distill:' + mem, 1, mem);
    } else {
      db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts, prompt_number, created_at, created_at_epoch, content_hash, generated_by_model)
                  VALUES (?,?,?,'session',?,?,?,?,?,0,?,?,?,?)`).run(
        mem, project, text, 'raw title', `via ${platform}`, '[]', text, JSON.stringify(['imported', platform]),
        new Date(epoch).toISOString(), epoch, strongHash(text), platform);
    }
    db.prepare(`INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch) VALUES (?,?,?,?,?)`)
      .run(sid, 0, firstPrompt, new Date(epoch).toISOString(), epoch);
    if (withFull) saveTranscript(db, mem, { text: full, marks: marksOf(full), size: full.length, now: savedAt });
  } finally { db.close(); }
  return mem;
}
function growSession(dbPath, mem, full, savedAt) {
  const db = new DatabaseSync(dbPath);
  try { saveTranscript(db, mem, { text: full, marks: marksOf(full), size: full.length, now: savedAt }); } finally { db.close(); }
}
function q(dbPath, sql, ...args) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
const rowsOf = (dbPath, mem) => q(dbPath, 'SELECT * FROM observations WHERE memory_session_id = ? ORDER BY id', mem);
const segRows = (dbPath, mem) => rowsOf(dbPath, mem).filter((r) => { try { return JSON.parse(r.metadata || '{}').segment; } catch { return false; } });
const segOf = (r) => JSON.parse(r.metadata).segment;
const FAR = () => Date.now() + 24 * 3600_000; // "a day later": every session is quiet

// Run distillPending repeatedly until it distils nothing; returns total model calls.
async function drain(dbPath, stub, opts = {}) {
  let total = 0;
  for (let i = 0; i < 40; i++) {
    const rep = await distillPending(dbPath, { env: stubEnv(stub), limit: 12, concurrency: 1, now: FAR(), ...opts });
    total += rep.distilled;
    if (!rep.distilled) break;
  }
  return total;
}

// ── 1. segmentation (pure) ───────────────────────────────────────────────────
const LONG = pairs(0, 40, 500); // ~40k chars
await t('segmentation: deterministic — same transcript, same segments, same ids', () => {
  const a = segmentTranscript(LONG, { budget: 6000, marks: marksOf(LONG) });
  const b = segmentTranscript(LONG, { budget: 6000, marks: marksOf(LONG) });
  assert(a.length >= 6, `expected a long session to yield several segments, got ${a.length}`);
  eq(JSON.stringify(a), JSON.stringify(b), 'two runs differ');
  eq(a[0].id, segmentId(0, a[0].text), 'id = index + hash of the first bytes');
});
await t('segmentation: every segment fits the budget, tiles the text, and starts on a user turn', () => {
  const segs = segmentTranscript(LONG, { budget: 6000 });
  for (const s of segs) {
    assert(s.text.length <= 6000, `segment ${s.index} is ${s.text.length} chars`);
    eq(s.text, LONG.slice(s.start, s.end), `segment ${s.index} text is its range`);
    assert(s.text.startsWith('user: '), `segment ${s.index} starts mid-turn: ${s.text.slice(0, 20)}`);
  }
  // gaps between consecutive segments are exactly the blank-line separator
  for (let i = 1; i < segs.length; i++) eq(segs[i].start - segs[i - 1].end, 2, `gap before segment ${i}`);
  eq(segs[0].start, 0, 'first starts at 0'); eq(segs.at(-1).end, LONG.length, 'last ends at the end');
  eq(segs.filter((s) => !s.closed).length, 1, 'only the last segment is open');
});
await t('segmentation: prefix-stable — appending never moves an existing boundary', () => {
  const head = pairs(0, 25, 500);
  const a = segmentTranscript(head, { budget: 6000 });
  const b = segmentTranscript(head + '\n\n' + pairs(25, 40, 500), { budget: 6000 });
  for (let i = 0; i < a.length - 1; i++) {
    eq(a[i].id, b[i].id, `closed segment ${i} id`); eq(a[i].start, b[i].start, `closed segment ${i} start`); eq(a[i].text, b[i].text, `closed segment ${i} text`);
  }
});
await t('segmentation: a compact boundary starts a new segment', () => {
  const pre = pairs(0, 3, 500); // ~3k chars: well under the budget
  const compact = 'user: This session is being continued from a previous conversation that ran out of context. SEGMARK-COMPACT summary';
  const text = `${pre}\n\n${compact}\n\n${asstTurn(99, 400)}\n\n${pairs(4, 6, 500)}`;
  const segs = segmentTranscript(text, { budget: 6000 });
  const at = segs.find((s) => s.text.startsWith('user: This session is being continued'));
  assert(at, 'a segment must begin at the compact summary');
  assert(at.index > 0, 'and it is not the first');
  assert(!segs[at.index - 1].text.includes('SEGMARK-COMPACT'), 'the previous segment does not swallow it');
});
await t('segmentation: one message over the budget is split (and only then); pieces tile it exactly', () => {
  const big = 'user: SEGMARK-BIG ' + Array.from({ length: 400 }, (_, i) => `line ${i} ${filler('b', 40)}`).join('\n'); // ~20k, one message
  const text = `${userTurn(0, 200)}\n\n${asstTurn(0, 200)}\n\n${big}\n\n${asstTurn(1, 200)}`;
  const segs = segmentTranscript(text, { budget: 6000 });
  for (const s of segs) assert(s.text.length <= 6000, `segment ${s.index} ${s.text.length}`);
  const bigSegs = segs.filter((s) => s.text.includes('line '));
  assert(bigSegs.length >= 3, `the big message spans several segments (${bigSegs.length})`);
  assert(segs.some((s) => s.text.startsWith('user: SEGMARK-BIG')), 'the big message starts its own segment');
  // a short message is never split
  const small = segmentTranscript(pairs(0, 2, 300), { budget: 6000 });
  eq(small.length, 1, 'short transcript = one segment');
});
await t('segmentation: segment ts is the first message time of the segment (marks)', () => {
  const marks = marksOf(LONG);
  const segs = segmentTranscript(LONG, { budget: 6000, marks });
  eq(segs[0].ts, new Date(T0).toISOString(), 'segment 0 starts at the first message time');
  assert(Date.parse(segs[2].ts) > Date.parse(segs[1].ts), 'later segments are later');
  const idx = splitMessages(LONG).findIndex((r) => r.start === segs[2].start);
  eq(segs[2].ts, new Date(T0 + idx * 3600_000).toISOString(), 'ts of the message the segment starts at');
  eq(segmentTranscript(LONG, { budget: 6000 })[1].ts, null, 'no marks → null (caller falls back to session start)');
});

// ── 2. ingest stores the FULL transcript (scrubbed) beside the clipped row ──
const SECRET = 'ghp_' + 'Zq7Xw2Lr9Tb4Nm6Kp1Vc8Hd3Js5Fg0Ay7Ue2';
const CL_SID = 'cccccccc-3333-4333-8333-000000000003';
const CL_MEM = `claude:${CL_SID}`;
function makeHome(name) {
  const home = join(ROOT, name);
  mkdirSync(join(home, '.claude', 'projects', '-Users-x-code-webapp'), { recursive: true });
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const store = join(home, '.claude-brain', 'brain.db');
  openStore({ path: store }).close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'test\n');
  return { home, store };
}
function runIngest(home) {
  const child = `
    const { MEMORY_DB } = await import(${JSON.stringify(join(REPO, 'bin/lib/paths.mjs'))});
    if (!MEMORY_DB.startsWith(${JSON.stringify(home)})) { console.log('UNSAFE ' + MEMORY_DB); process.exit(3); }
    const { ingest } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
    console.log(JSON.stringify(await ingest({ only: ['claude'] })));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ingest child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const cline = (type, text, ts) => JSON.stringify({
  type, cwd: '/Users/x/code/webapp', sessionId: CL_SID, timestamp: ts,
  message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
}) + '\n';
const H = makeHome('h-ingest');
const claudeFile = join(H.home, '.claude', 'projects', '-Users-x-code-webapp', `${CL_SID}.jsonl`);
const stamp = (i) => new Date(T0 + i * 60_000).toISOString();

await t('ingest: a long session stores its full scrubbed transcript; the row stays clipped; short sessions store none', () => {
  let body = '';
  for (let i = 0; i < 30; i++) {
    body += cline('user', `SEGMARK-U${i} ${filler('q', 450)}${i === 20 ? ' my token is ' + SECRET : ''}`, stamp(2 * i));
    body += cline('assistant', `SEGMARK-A${i} ${filler('a', 450)}`, stamp(2 * i + 1));
  }
  writeFileSync(claudeFile, body);
  const r = runIngest(H.home).claude;
  eq(r.sessions, 1, 'sessions'); eq(r.fullStored, 1, 'one full transcript stored');
  const row = q(H.store, 'SELECT text FROM observations WHERE memory_session_id = ?', CL_MEM)[0];
  assert(row.text.length <= 8001, `row stays clipped (${row.text.length})`);
  const db = new DatabaseSync(H.store, { readOnly: true });
  let tr;
  try { tr = loadTranscript(db, CL_MEM); } finally { db.close(); }
  assert(tr && tr.text.length > 25_000, `full transcript stored (${tr && tr.text.length})`);
  assert(tr.text.includes('SEGMARK-U29') && tr.text.includes('SEGMARK-A29'), 'the END of the session is there, not just the head');
  assert(!tr.text.includes(SECRET), 'secret scrubbed from everything stored');
  eq(tr.marks.length, 60, 'one timestamp mark per message');
  eq(new Date(tr.marks[1][1]).toISOString(), stamp(1), 'marks carry the message timestamps');
  // the segmentation of what was stored keys off real message times
  const segs = segmentTranscript(tr.text, { budget: 6000, marks: tr.marks });
  eq(segs[0].ts, stamp(0), 'segment 0 ts');
  assert(segs.length >= 6, 'several segments');
});
await t('ingest: unchanged session rewrites nothing; growth replaces the stored text; short sessions store none', () => {
  const db0 = new DatabaseSync(H.store, { readOnly: true });
  const m0 = transcriptMeta(db0, CL_MEM); db0.close();
  const r = runIngest(H.home).claude;
  eq(r.fullStored, 0, 'unchanged → not rewritten');
  const db1 = new DatabaseSync(H.store, { readOnly: true });
  const m1 = transcriptMeta(db1, CL_MEM); db1.close();
  eq(m1.updated_at, m0.updated_at, 'updated_at untouched');
  appendFileSync(claudeFile, cline('user', 'SEGMARK-LATE ' + filler('z', 300), stamp(100)));
  const r2 = runIngest(H.home).claude;
  eq(r2.fullStored, 1, 'grown → restored');
  const db2 = new DatabaseSync(H.store, { readOnly: true });
  const tr = loadTranscript(db2, CL_MEM); db2.close();
  assert(tr.text.includes('SEGMARK-LATE'), 'new tail stored');
  // a short session gets no full row
  const sid2 = 'dddddddd-4444-4444-8444-000000000004';
  writeFileSync(join(H.home, '.claude', 'projects', '-Users-x-code-webapp', `${sid2}.jsonl`),
    JSON.stringify({ type: 'user', cwd: '/Users/x/code/webapp', sessionId: sid2, timestamp: stamp(0), message: { role: 'user', content: 'short one' } }) + '\n');
  runIngest(H.home);
  eq(q(H.store, 'SELECT COUNT(*) n FROM session_transcripts WHERE memory_session_id = ?', 'claude:' + sid2)[0].n, 0, 'no full row for a short session');
});

// ── 3. long session → many observations ──────────────────────────────────────
await t('long session: every segment becomes its own observation; the whole session is covered, not just its opening', async () => {
  const db = newStore();
  const mem = addSession(db, { sid: 'long-1', full: LONG });
  const expected = segmentTranscript(LONG, { budget: DEFAULTS.transcriptChars }).filter((s) => !isSelfSegment(s.text)).length;
  assert(expected >= 6, 'fixture is multi-segment');
  const stub = makeStub();
  const calls = await drain(db, stub);
  eq(calls, expected, 'one model call per segment');
  eq(stub.calls().length, expected, 'stub saw exactly that many prompts');
  const rows = rowsOf(db, mem);
  eq(rows.length, expected, 'one row per segment (segment 0 is the upgraded capture row)');
  eq(rows.filter((r) => String(r.generated_by_model).startsWith('brain/')).length, expected, 'all brain-provenanced');
  // each segment's own text was sent — including the last turns of the session
  const sent = stub.calls().join('\n');
  assert(sent.includes('SEGMARK-U0 ') && sent.includes('SEGMARK-U39 ') && sent.includes('SEGMARK-A39 '), 'first AND last turns reached a model');
  // prompts differ per segment: no prompt repeats the session-start digest
  const mids = stub.calls().filter((c) => c.includes('part 3 of a long session'));
  eq(mids.length, 1, 'continuation prompts say which part they are');
  assert(!mids[0].includes('SEGMARK-U0 '), 'a later part does not carry the session opening');
  // a second drain is idempotent
  eq(await drain(db, stub), 0, 'nothing left to do');
  eq(pendingSessions(db, { now: FAR() }).length, 0, 'queue empty');
});
await t('segment rows: session id, project, platform, created_at (first message time), segment identity, distinct hash', async () => {
  const db = newStore();
  const mem = addSession(db, { sid: 'meta-1', full: LONG, project: 'proj-meta' });
  await drain(db, makeStub());
  const segs = segmentTranscript(LONG, { budget: DEFAULTS.transcriptChars, marks: marksOf(LONG) });
  const rows = segRows(db, mem);
  eq(rows.length, segs.length, 'every row records its segment');
  const hashes = new Set();
  for (const r of rows) {
    const m = segOf(r);
    const s = segs[m.index];
    eq(r.memory_session_id, mem, 'memory_session_id kept');
    eq(r.project, 'proj-meta', 'project kept');
    eq(m.id, s.id, `segment id ${m.index}`);
    eq(m.start, s.start, 'start offset recorded'); eq(m.chars, s.text.length, 'chars recorded');
    if (m.index > 0) {
      eq(r.created_at, s.ts, `created_at of segment ${m.index} = its first message time`);
      eq(r.created_at_epoch, Date.parse(s.ts), 'epoch too');
      eq(r.text, s.text, 'the segment text is stored (searchable, auditable)');
      eq(r.prompt_number, m.index, 'prompt_number = segment index');
    }
    assert(r.concepts.includes('brain-distilled'), 'distilled marker');
    hashes.add(r.content_hash);
  }
  eq(hashes.size, rows.length, 'content_hash differs per segment even when the model words two alike');
  const st = q(db, `SELECT * FROM capture_state WHERE transcript_path = ?`, segmentStateKey(mem, segs[3].id))[0];
  eq(st.status, 'done', 'per-segment state');
  eq(st.session_id, mem, 'state records the session');
  // the row of segment 0 is the ORIGINAL capture row (lowest id), upgraded in place
  eq(rowsOf(db, mem)[0].id, rows[0].id, 'segment 0 is the first row');
});
await t('prompts: the model is told it sees a part, and shown that part\'s own user prompts', () => {
  const segs = segmentTranscript(LONG, { budget: 6000 });
  const p = buildPrompt({ project: 'p', platformSource: 'claude', title: 'T', prompts: ['own prompt'], segment: { ...segs[2], count: segs.length } });
  assert(p.startsWith('You are a memory distiller.'), 'still opens with the internal prompt (self-capture signal)');
  assert(p.includes('part 3 of a long session'), 'part note');
  assert(!p.includes('Session title (heuristic'), 'no misleading session-start title for a later part');
  assert(p.includes(segs[2].text.slice(0, 80)), 'segment text sent');
  assert(!p.includes(segs[3].text.slice(0, 80)), 'and only that segment');
  const single = buildPrompt({ project: 'p', platformSource: 'claude', title: 'T', transcript: 'user: hi' });
  assert(!single.includes('NOTE:') && single.includes('Session title (heuristic'), 'a plain session prompt is unchanged');
});

// ── 4. growth: only NEW segments are distilled ───────────────────────────────
await t('growth: only new segments are sent; closed segments are never re-sent or overwritten', async () => {
  const db = newStore();
  const head = pairs(0, 25, 500);
  const mem = addSession(db, { sid: 'grow-1', full: head });
  const stub1 = makeStub();
  await drain(db, stub1);
  const before = new Map(rowsOf(db, mem).map((r) => [r.id, JSON.stringify(r)]));
  const segsBefore = segmentTranscript(head, { budget: DEFAULTS.transcriptChars });
  eq(before.size, segsBefore.length, 'all segments distilled');

  const grown = head + '\n\n' + pairs(25, 40, 500);
  growSession(db, mem, grown, Date.now());
  const segsAfter = segmentTranscript(grown, { budget: DEFAULTS.transcriptChars });
  // brand-new segments, plus the old tail when its text changed (it grew, or the cut moved back)
  const tailChanged = segsAfter[segsBefore.length - 1].text !== segsBefore.at(-1).text;
  const newOnes = segsAfter.length - segsBefore.length + (tailChanged ? 1 : 0);
  const stub2 = makeStub();
  const n = await drain(db, stub2);
  eq(n, newOnes, 'calls = the new segments (+ the old tail once, only if its text changed)');
  const sent = stub2.calls().join('\n');
  for (let i = 0; i < 20; i++) assert(!sent.includes(`SEGMARK-U${i} `), `old turn ${i} was re-sent`);
  // closed (non-tail) rows byte-identical
  const closedIds = new Set(segRows(db, mem).filter((r) => segOf(r).index < segsBefore.length - 1).map((r) => r.id));
  const row0 = rowsOf(db, mem)[0];
  closedIds.add(row0.id);
  for (const id of closedIds) eq(JSON.stringify(rowsOf(db, mem).find((r) => r.id === id)), before.get(id), `row ${id} untouched`);
  eq(rowsOf(db, mem).length, segsAfter.length, 'one row per segment, no duplicates');
});
await t('growth: the still-growing last segment waits for the session to go quiet, then is distilled; when it grows again only IT is updated in place', async () => {
  const db = newStore();
  const head = pairs(0, 12, 500);
  const mem = addSession(db, { sid: 'tail-1', full: head, savedAt: 1_000_000 });
  const segs = segmentTranscript(head, { budget: DEFAULTS.transcriptChars });
  assert(segs.length >= 3, 'fixture has a few segments');
  const stub = makeStub();
  // session saved "just now" (now = saved + 1 minute): closed segments only; the open tail waits
  let calls = 0;
  for (let i = 0; i < 20; i++) {
    const rep = await distillPending(db, { env: stubEnv(stub), limit: 12, concurrency: 1, now: 1_000_000 + 60_000 });
    calls += rep.distilled; if (!rep.distilled) break;
  }
  eq(calls, segs.length - 1, 'every closed segment, not the live tail');
  assert(!rowsOf(db, mem).some((r) => r.text && r.text.includes(`SEGMARK-A11 `) && String(r.generated_by_model).startsWith('brain/')), 'tail not distilled yet');
  // hours later: the tail is distilled
  const rep2 = await distillPending(db, { env: stubEnv(stub), limit: 12, concurrency: 1, now: 1_000_000 + 4 * 3600_000 });
  eq(rep2.distilled, 1, 'tail distilled once the session was quiet');
  const rowsA = rowsOf(db, mem);
  eq(rowsA.length, segs.length, 'one row per segment');
  // the session grows into the tail, then goes quiet again
  const grown = head + '\n\n' + pairs(12, 14, 500);
  const segs2 = segmentTranscript(grown, { budget: DEFAULTS.transcriptChars });
  growSession(db, mem, grown, 9_000_000);
  const snap = new Map(rowsA.map((r) => [r.id, JSON.stringify(r)]));
  const tailRow = rowsA.find((r) => segOf2(r)?.index === segs.length - 1);
  const stub3 = makeStub();
  let n3 = 0;
  for (let i = 0; i < 10; i++) { const rep = await distillPending(db, { env: stubEnv(stub3), limit: 12, concurrency: 1, now: 9_000_000 + 4 * 3600_000 }); n3 += rep.distilled; if (!rep.distilled) break; }
  const rowsB = rowsOf(db, mem);
  eq(rowsB.length, segs2.length, 'grew only by the genuinely new segments');
  eq(n3, 1 + (segs2.length - segs.length), 'the old tail (once) + the new segments');
  for (const r of rowsA) {
    if (tailRow && r.id === tailRow.id) continue;
    eq(JSON.stringify(rowsB.find((x) => x.id === r.id)), snap.get(r.id), `row ${r.id} untouched`);
  }
  const tailAfter = rowsB.find((r) => tailRow && r.id === tailRow.id);
  if (tailRow) assert(tailAfter.text.length > tailRow.text.length, 'the tail row itself was updated in place with the longer text');
});
function segOf2(r) { try { return JSON.parse(r.metadata || '{}').segment || null; } catch { return null; } }

// ── 5. old single-row compatibility ──────────────────────────────────────────
await t('legacy: an old whole-session brain row is segment 0 — kept untouched, never re-sent; later segments are added after it', async () => {
  const db = newStore();
  const mem = addSession(db, { sid: 'legacy-1', full: LONG, legacyDistilled: true });
  const old = JSON.stringify(rowsOf(db, mem)[0]);
  const stub = makeStub();
  const segs = segmentTranscript(LONG, { budget: DEFAULTS.transcriptChars });
  const calls = await drain(db, stub);
  eq(calls, segs.length - 1, 'every segment except segment 0');
  const rows = rowsOf(db, mem);
  eq(rows.length, segs.length, 'old row + one per further segment (no duplicate of segment 0)');
  eq(JSON.stringify(rows[0]), old, 'the old row is byte-identical');
  assert(!stub.calls().join('\n').includes('SEGMARK-U0 '), 'segment 0 content was never re-sent');
  assert(rows.slice(1).every((r) => segOf2(r) && segOf2(r).index >= 1), 'new rows are segments 1..');
});
await t('legacy: a session with NO stored full transcript behaves exactly as before — one row, one call, no segments invented', async () => {
  const db = newStore();
  const mem = addSession(db, { sid: 'short-1', full: LONG, withFull: false });
  const stub = makeStub();
  eq(await drain(db, stub), 1, 'one call');
  const rows = rowsOf(db, mem);
  eq(rows.length, 1, 'one row (the clipped capture row, upgraded)');
  eq(rows[0].type, 'change', 'upgraded in place');
  eq(rows[0].text.length, 8001, 'text still the clipped transcript');
});
await t('legacy: a legacy distilled row with no full transcript is never re-queued', async () => {
  const db = newStore();
  addSession(db, { sid: 'legacy-2', full: LONG, legacyDistilled: true, withFull: false });
  eq(pendingSessions(db, { now: FAR() }).length, 0, 'nothing pending');
});

// ── 6. --limit counts segments; queue order ─────────────────────────────────
await t('limit: --limit bounds MODEL CALLS (segments), not sessions; the rest waits for the next run', async () => {
  const db = newStore();
  addSession(db, { sid: 'lim-1', full: LONG });
  const stub = makeStub();
  const r1 = await distillPending(db, { env: stubEnv(stub), limit: 1, concurrency: 1, now: FAR() });
  eq(r1.distilled, 1, 'run 1 = segment 0 only'); eq(stub.calls().length, 1, '1 call');
  const r2 = await distillPending(db, { env: stubEnv(stub), limit: 3, concurrency: 1, now: FAR() });
  eq(r2.scanned, 3, 'run 2 scans exactly 3 segments'); eq(r2.distilled, 3, 'and distils exactly 3'); eq(stub.calls().length, 4, '4 calls in total');
  eq(r2.segments, 3, 'all three were continuation segments');
  const remaining = segmentTranscript(LONG, { budget: DEFAULTS.transcriptChars }).length - 4;
  eq(pendingSessions(db, { limit: 100, now: FAR() }).length, remaining, 'the rest is still queued, per segment');
  eq(pendingSessions(db, { limit: 2, now: FAR() }).length, 2, 'pendingSessions is bounded by limit too');
});
await t('queue order: older started sessions first, per-session cap, fresh sessions are not starved', async () => {
  const db = newStore();
  const olderMem = addSession(db, { sid: 'old-1', full: LONG, epoch: 1_600_000_000_000 });
  const newerMem = addSession(db, { sid: 'new-1', full: LONG, epoch: 1_700_000_000_000 });
  // finish segment 0 of both (these are the only fresh rows)
  await distillPending(db, { env: stubEnv(makeStub()), limit: 2, concurrency: 1, now: FAR() });
  const fresh = addSession(db, { sid: 'fresh-1', full: pairs(0, 2, 300), epoch: 1_710_000_000_000 });
  const q12 = pendingSessions(db, { limit: 12, now: FAR() });
  eq(q12.length, 12, 'bounded at the limit');
  eq(q12[0].memorySessionId, olderMem, 'the OLDER started session finishes first');
  eq(q12.slice(0, 4).every((i) => i.memorySessionId === olderMem), true, 'its first ceil(limit/3) segments lead the queue');
  eq(q12.slice(4, 8).every((i) => i.memorySessionId === newerMem), true, 'then the next session gets its share (no monopoly)');
  assert(q12.slice(8).some((i) => i.memorySessionId === olderMem), 'free slots are then filled from the backlog');
  assert(q12.some((i) => i.memorySessionId === fresh && i.kind === 'row'), 'a fresh session\'s segment 0 is not starved behind the backlog');
});

// ── 7. self-capture + test-data guards, per segment ──────────────────────────
await t('self-capture: a session whose first prompt is ours is never queued, whole or by segment', async () => {
  const db = newStore();
  addSession(db, { sid: 'self-1', full: LONG, firstPrompt: SELF_PROMPT_PREFIXES[0] + ' You are given...' });
  eq(pendingSessions(db, { now: FAR() }).length, 0, 'not pending');
  // even once segment 0 exists (as if distilled before the guard): continuation is not queued either
  const db2 = newStore();
  addSession(db2, { sid: 'self-2', full: LONG, firstPrompt: SELF_PROMPT_PREFIXES[0] + ' You are given...', legacyDistilled: true });
  eq(pendingSessions(db2, { now: FAR() }).length, 0, 'continuation of a self session is not queued');
});
await t('self-capture: a segment that opens with an internal prompt is skipped; its neighbours are distilled', async () => {
  // every message alone fills a segment, so a self prompt at the start of a user turn starts a segment
  const big = (tag, role) => `${role}: ${tag} ${filler(tag, 5600)}`;
  const text = [big('SEGMARK-ONE', 'user'), big('SEGMARK-TWO', 'assistant'),
    `user: ${SELF_PROMPT_PREFIXES[0]} SEGMARK-SELF ${filler('s', 5500)}`, big('SEGMARK-FOUR', 'assistant'), big('SEGMARK-FIVE', 'user')].join('\n\n');
  const segs = segmentTranscript(text, { budget: 6000 });
  eq(segs.length, 5, 'five one-message segments');
  assert(isSelfSegment(segs[2].text), 'the third is an internal prompt');
  const db = newStore();
  const mem = addSession(db, { sid: 'self-3', full: text });
  const stub = makeStub();
  eq(await drain(db, stub), 4, 'four calls, not five');
  const sent = stub.calls().join('\n');
  assert(!sent.includes('SEGMARK-SELF'), 'the internal-prompt segment never reached a model');
  assert(sent.includes('SEGMARK-FOUR') && sent.includes('SEGMARK-FIVE'), 'later segments still distilled');
  eq(segRows(db, mem).filter((r) => segOf(r).index === 2).length, 0, 'and no row exists for it');
});
await t('guards: a hidden/deleted session row stops its continuation; an exhausted segment stops burning attempts', async () => {
  const db = newStore();
  const mem = addSession(db, { sid: 'del-1', full: LONG });
  await distillPending(db, { env: stubEnv(makeStub()), limit: 1, concurrency: 1, now: FAR() }); // segment 0
  const w = new DatabaseSync(db);
  try { w.prepare(`UPDATE observations SET status = 'deleted' WHERE memory_session_id = ?`).run(mem); } finally { w.close(); }
  eq(pendingSessions(db, { now: FAR() }).length, 0, 'deleted row: no further segments');
  const db2 = newStore();
  const mem2 = addSession(db2, { sid: 'exh-1', full: LONG });
  await distillPending(db2, { env: stubEnv(makeStub()), limit: 1, concurrency: 1, now: FAR() });
  const segs = segmentTranscript(LONG, { budget: DEFAULTS.transcriptChars });
  const w2 = new DatabaseSync(db2);
  try { w2.prepare(`INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status) VALUES (?,?,?,?,'pending')`).run(segmentStateKey(mem2, segs[1].id), 1, DEFAULTS.maxAttempts, mem2); } finally { w2.close(); }
  const ids = pendingSessions(db2, { limit: 100, now: FAR() }).map((i) => i.segment.id);
  assert(!ids.includes(segs[1].id), 'segment at maxAttempts is not retried');
  eq(ids.length, segs.length - 2, 'every other segment still is');
});
await t('failures: a failed segment burns attempts on ITS key only and stays pending', async () => {
  const db = newStore();
  const mem = addSession(db, { sid: 'fail-1', full: LONG });
  await distillPending(db, { env: stubEnv(makeStub()), limit: 1, concurrency: 1, now: FAR() });
  const rep = await distillPending(db, { env: stubEnv(null), limit: 2, concurrency: 1, now: FAR() }); // no CLI at all
  eq(rep.unavailable, 2, 'unavailable, not failed'); eq(rep.distilled, 0, 'nothing written');
  eq(q(db, `SELECT COUNT(*) n FROM capture_state WHERE transcript_path LIKE ?`, `distill:${mem}#%`)[0].n, 0, 'no attempt burned when no CLI ran');
});

// ── 8. --plan is read-only ───────────────────────────────────────────────────
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
// Content of every file in a store dir. A read-only handle on a WAL database may create the (empty)
// -wal/-shm companions — that is not a write to the database, so they are excluded; brain.db itself is not.
const snap = (dir) => readdirSync(dir).filter((f) => !/-(wal|shm)$/.test(f)).sort().map((f) => `${f}:${sha(join(dir, f))}`).join('|');
await t('plan: planBatch counts sessions/segments/calls and writes nothing (store opened read-only)', async () => {
  const db = newStore();
  addSession(db, { sid: 'plan-1', full: LONG });
  addSession(db, { sid: 'plan-2', full: LONG, legacyDistilled: true });
  addSession(db, { sid: 'plan-3', full: pairs(0, 2, 300), withFull: false });
  const files = () => snap(dirname(db));
  const before = files();
  const p = planBatch(db, { limit: 12, now: FAR() });
  eq(files(), before, 'no file in the store directory changed');
  const nSeg = segmentTranscript(LONG, { budget: DEFAULTS.transcriptChars }).length;
  eq(p.freshSessions, 2, 'plan-1 and plan-3 await segment 0');
  eq(p.laterSegmentsOfFreshSessions, nSeg - 1, 'plan-1\'s later segments');
  eq(p.continuationSegments, nSeg - 1, 'plan-2 (legacy row = segment 0) needs the rest');
  eq(p.calls, 2 + (nSeg - 1) * 2, 'total model calls');
  eq(p.runsAtLimit, Math.ceil(p.calls / 12), 'runs at the limit');
  assert(p.estimatedTokens.total > 0, 'token estimate');
  eq(p.sessionsWithFullTranscript, 2, 'full transcripts counted');
});
await t('plan: `brain distill-sessions --plan` prints the plan, calls no model, writes nothing', () => {
  const home = join(ROOT, `clihome-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const store = join(home, '.claude-brain', 'brain.db');
  openStore({ path: store }).close();
  addSessionAt(store);
  writeFileSync(join(home, '.claude-brain', 'READY'), 'ok\n');
  const stub = makeStub();
  const env = { ...stubEnv(stub), HOME: home, BRAIN_TEST: '1' };
  const files = () => snap(dirname(store));
  const before = files();
  const r = spawnSync(process.execPath, [join(REPO, 'bin/brain.mjs'), 'distill-sessions', '--plan'], { env, encoding: 'utf8', timeout: 60_000 });
  eq(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert(/model calls: \d+/.test(r.stdout), `plan output: ${r.stdout}`);
  assert(/read-only/.test(r.stdout), 'says it is read-only');
  eq(stub.calls().length, 0, 'no model was called');
  eq(files(), before, 'the store directory is byte-identical');
  const j = spawnSync(process.execPath, [join(REPO, 'bin/brain.mjs'), 'distill-sessions', '--plan', '--json'], { env, encoding: 'utf8', timeout: 60_000 });
  const plan = JSON.parse(j.stdout);
  assert(plan.calls >= 6, `json plan: ${j.stdout.slice(0, 200)}`);
  eq(files(), before, 'still byte-identical after --json');
});
function addSessionAt(store) { addSession(store, { sid: 'cli-plan', full: LONG }); }

// ── 9. clean: segment state + orphaned transcripts go with their session ────
await t('clean: stripping a self-capture session also removes its segment rows, segment state and stored transcript', async () => {
  const { stripSelfCaptureCopy } = await import('../bin/lib/clean.mjs');
  const db = newStore();
  const mem = addSession(db, { sid: 'selfclean-1', full: LONG, firstPrompt: SELF_PROMPT_PREFIXES[0] + ' x', legacyDistilled: true });
  const keep = addSession(db, { sid: 'keep-1', full: LONG });
  const segs = segmentTranscript(LONG, { budget: DEFAULTS.transcriptChars });
  const w = new DatabaseSync(db);
  try {
    w.prepare(`INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status) VALUES (?,?,0,?,'done')`).run(segmentStateKey(mem, segs[1].id), 1, mem);
    w.prepare(`INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status) VALUES (?,?,0,?,'done')`).run(segmentStateKey(keep, segs[1].id), 1, keep);
  } finally { w.close(); }
  stripSelfCaptureCopy(db);
  eq(q(db, 'SELECT COUNT(*) n FROM capture_state WHERE transcript_path LIKE ?', `distill:${mem}#%`)[0].n, 0, 'segment state gone');
  eq(q(db, 'SELECT COUNT(*) n FROM session_transcripts WHERE memory_session_id = ?', mem)[0].n, 0, 'stored transcript gone');
  eq(q(db, 'SELECT COUNT(*) n FROM observations WHERE memory_session_id = ?', mem)[0].n, 0, 'rows gone');
  eq(q(db, 'SELECT COUNT(*) n FROM session_transcripts WHERE memory_session_id = ?', keep)[0].n, 1, 'the real session keeps its transcript');
  eq(q(db, 'SELECT COUNT(*) n FROM capture_state WHERE transcript_path LIKE ?', `distill:${keep}#%`)[0].n, 1, 'and its state');
});

// ── report ───────────────────────────────────────────────────────────────────
await t('sync snapshot: full transcripts never leave the machine (stripTranscripts)', async () => {
  const { stripTranscripts } = await import('../bin/lib/bundle.mjs');
  mkdirSync(ROOT, { recursive: true });
  const p = join(ROOT, 'snap-strip.db');
  const db = new DatabaseSync(p);
  db.exec("CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO observations (title) VALUES ('kept');");
  db.exec("CREATE TABLE session_transcripts (memory_session_id TEXT PRIMARY KEY, body BLOB); INSERT INTO session_transcripts VALUES ('s1', x'00');");
  db.close();
  if (stripTranscripts(p) !== true) throw new Error('should report a strip');
  const after = new DatabaseSync(p, { readOnly: true });
  const t = after.prepare("SELECT name FROM sqlite_master WHERE name='session_transcripts'").get();
  const n = after.prepare('SELECT count(*) n FROM observations').get().n;
  after.close();
  if (t) throw new Error('session_transcripts still in snapshot');
  if (n !== 1) throw new Error('memories must stay');
  if (stripTranscripts(p) !== false) throw new Error('second call is a no-op');
});

for (const [s, name, err] of results) console.log(`${s === 'PASS' ? '✓' : '✗'} ${name}${err ? `\n    ${err}` : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
