#!/usr/bin/env node
// Tests for parseAntigravity() in bin/lib/ingest.mjs — Antigravity CLI (agy)
// capture, both on-disk formats:
//   • agy >= 1.3: ~/.gemini/antigravity-cli/conversations/<uuid>.db, one SQLite
//     DB per conversation, the trajectory as protobuf blobs (layout documented
//     above readAgyConversation; reverse-engineered from agy 1.3.0 by running
//     known throwaway conversations).
//   • agy < 1.3: ~/.gemini/antigravity-cli/history.jsonl (prompt log).
// Plus the protobuf wire reader (bin/lib/protowire.mjs) and the watcher's
// file filter.
//
//   node evals/ingest-antigravity-test.mjs
//
// SAFETY: every $HOME, agy DB and brain store is synthetic, under the scratchpad
// (or $TMPDIR); the protobuf blobs are encoded here from invented strings. No
// real agy file is read. ingest() runs in a child with HOME=<fake> that refuses
// to run unless its resolved store lives under that fake home.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../bin/lib/store.mjs';
import { scrubText } from '../bin/lib/scrub.mjs';
import { pbEncode, pbFields, pbTry, pbStr, pbSub, pbTimeMs } from '../bin/lib/protowire.mjs';
import { isAgyCaptureChange } from '../bin/lib/watch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `ingest-agy-test-${process.pid}`);
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

const SECRET = 'ghp_' + 'Zq7Xw2Lr9Tb4Nm6Kp1Vc8Hd3Js5Fg0Ay7Ue2'; // invented, token-shaped
assert(scrubText(SECRET).text !== SECRET, 'fixture secret is no longer caught by the scrubber — pick another');

// ── fixture builders (layout from agy 1.3.0; content invented) ───────────────
const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const agy = (home) => join(home, '.gemini', 'antigravity-cli');
const ts = (ms) => [[1, Math.floor(ms / 1000)], [2, (ms % 1000) * 1e6]]; // google.protobuf.Timestamp
const uri = (p) => pathToFileURL(p).href;

// Step builders → [step_type, payload pairs]. Only the fields the parser reads
// plus some realistic noise (ids, a config block, thinking, tool args).
const user = (text, at, ws) => [14, [[19, [[2, text], [3, [[1, text]]], [4, new Uint8Array(0)], ...(ws ? [[12, [[1, [[1, 1318]]], [12, uri(ws)]]]] : [])]]], at];
const reply = (text, at, { thinking = '', tools = [] } = {}) => [15, [[20, [
  ...(text ? [[1, text]] : []),
  ...(thinking ? [[3, thinking]] : []),
  [6, 'bot-00000000-0000-4000-8000-000000000000'],
  ...tools.map((name, i) => [7, [[1, `call_${i}`], [2, name], [3, JSON.stringify({ CommandLine: 'TOOL-ARGS-NEVER-CAPTURED' })]]]),
  ...(text ? [[8, text]] : []),
  [12, 2],
]]], at];
const system = (text, at) => [101, [[114, [[1, text], [2, [[1, 'System Message']]]]]], at];
const toolRun = (at) => [132, [[140, [[1, [[1, 'CommandLine'], [2, 'TOOL-RUN-NEVER-CAPTURED']]]]]], at];

function createConversation(home, id, { workspace = '/Users/x/code/orchard', created = T0, parent = '', root = id, steps = [], wal = false } = {}) {
  const dir = join(agy(home), 'conversations');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, `${id}.db`));
  if (wal) db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE \`trajectory_meta\` (\`trajectory_id\` text,\`cascade_id\` text,\`trajectory_type\` integer,\`source\` integer,PRIMARY KEY (\`trajectory_id\`));
    CREATE TABLE \`steps\` (\`idx\` integer,\`step_type\` integer NOT NULL DEFAULT 0,\`status\` integer NOT NULL DEFAULT 0,\`has_subtrajectory\` numeric NOT NULL DEFAULT false,\`metadata\` blob,\`error_details\` blob,\`permissions\` blob,\`task_details\` blob,\`render_info\` blob,\`step_payload\` blob,\`step_format\` integer NOT NULL DEFAULT 0,PRIMARY KEY (\`idx\`));
    CREATE TABLE \`gen_metadata\` (\`idx\` integer,\`data\` blob,\`size\` integer NOT NULL DEFAULT 0,PRIMARY KEY (\`idx\`));
    CREATE TABLE \`executor_metadata\` (\`idx\` integer,\`data\` blob,PRIMARY KEY (\`idx\`));
    CREATE TABLE \`parent_references\` (\`idx\` integer,\`data\` blob,PRIMARY KEY (\`idx\`));
    CREATE TABLE \`trajectory_metadata_blob\` (\`id\` text DEFAULT "main",\`data\` blob,PRIMARY KEY (\`id\`));
    CREATE TABLE \`battle_mode_infos\` (\`idx\` integer,\`data\` blob,PRIMARY KEY (\`idx\`));
  `);
  db.prepare('INSERT INTO trajectory_meta VALUES (?,?,4,17)').run(`traj-${id}`, id);
  const meta = [
    ...(workspace ? [[1, [[1, uri(workspace)], [3, new Uint8Array(0)]]]] : []),
    [2, ts(created)], [3, `t-${id}`],
    ...(parent ? [[5, parent]] : []),
    ...(root ? [[6, root]] : []),
    ...(workspace ? [[7, uri(workspace)]] : []),
    [18, 'default-cli-project'],
  ];
  db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(pbEncode(meta));
  addSteps(db, steps);
  return db; // caller closes (lets a test keep a writer open)
}
function addSteps(db, steps) {
  let idx = db.prepare('SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM steps').get().n;
  for (const s of steps) {
    if (s instanceof Uint8Array) { // a raw (possibly corrupt) payload
      db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, 15, 3, ?)').run(idx++, s);
      continue;
    }
    const [type, body, at] = s;
    const md = [[1, ts(at)], [3, 2], [12, 'exec-id']];
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?,?,3,?,?)')
      .run(idx++, type, pbEncode(md), pbEncode([[1, type], [4, 3], [5, md], ...body]));
  }
}
function writeSummaries(home, rows) {
  mkdirSync(agy(home), { recursive: true });
  const db = new DatabaseSync(join(agy(home), 'conversation_summaries.db'));
  db.exec("CREATE TABLE IF NOT EXISTS `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT \"\",`preview` text NOT NULL DEFAULT \"\",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`parent_conversation_id` text NOT NULL DEFAULT \"\",PRIMARY KEY (`conversation_id`))");
  for (const r of rows) db.prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?,?,?,0,?,?,?)').run(r.id, r.title || '', r.title || '', '2026-09-20 10:00:00+00:00', '[]', r.parent || '');
  db.close();
}

function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const st = statSync(p); out[p.slice(root.length)] = `${createHash('sha256').update(readFileSync(p)).digest('hex')}:${st.size}:${st.mtimeMs}`; }
    }
  };
  walk(root);
  return out;
}
const cleanEnv = (home, extra = {}) => ({ ...process.env, HOME: home, ...extra });
function runParse(home) {
  const child = `
    const { parseAntigravity } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
    console.log(JSON.stringify(parseAntigravity().map((i) => ({ sid: i.sid, project: i.project, cwd: i.cwd, title: i.title, ts: i.ts, prompts: i.prompts, transcript: i.transcript, size: i.size, hasFull: typeof i.loadFull === 'function' }))));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: cleanEnv(home), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`parse child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const bySid = (items) => Object.fromEntries(items.map((i) => [i.sid, i]));
const fresh = (name) => { const home = join(ROOT, name); mkdirSync(home, { recursive: true }); return home; };
const ID = (n) => `0a0a0a0a-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── 0. protobuf wire reader ──────────────────────────────────────────────────
await t('protowire: round-trips varints (incl. > 2^53), strings, nested messages, fixed fields', () => {
  const big = 2n ** 60n + 7n;
  const buf = pbEncode([[1, 150], [2, 'héllo'], [3, [[1, 'inner'], [2, 1791726056]]], [4, big]]);
  const f = pbFields(buf);
  eq(f[0].v, 150, 'varint'); eq(pbStr(f, 2), 'héllo', 'utf-8 string');
  eq(pbStr(pbSub(f, 3), 1), 'inner', 'nested'); eq(f[3].v, big, 'big varint stays exact (BigInt)');
  const fixed = pbFields(Uint8Array.from([0x0d, 1, 0, 0, 0, 0x11, 1, 2, 3, 4, 5, 6, 7, 8]));
  eq(fixed.length, 2, 'fixed32 + fixed64'); eq(fixed[0].w, 5, 'fixed32'); eq(fixed[1].v.length, 8, 'fixed64 bytes');
  eq(pbTimeMs(pbFields(pbEncode([[1, ts(T0 + 123)]])), 1), T0 + 123, 'Timestamp → ms');
});
await t('protowire: malformed input throws (pbFields) / is null (pbTry), never hangs', () => {
  const bad = [Uint8Array.from([0x0a, 0x05, 0x61]), Uint8Array.from([0x08, 0xff]), Uint8Array.from([0x0b]), Uint8Array.from([0x00, 0x01]), Uint8Array.from(Array(11).fill(0xff))];
  for (const b of bad) {
    let threw = false;
    try { pbFields(b); } catch { threw = true; }
    assert(threw, `should throw on ${Buffer.from(b).toString('hex')}`);
    eq(pbTry(b), null, 'pbTry → null');
  }
  eq(pbTry(null), null, 'null input'); eq(pbFields(new Uint8Array(0)).length, 0, 'empty message');
});

// ── 1. conversation DBs → items ──────────────────────────────────────────────
const H1 = fresh('h-conv');
{
  createConversation(H1, ID(1), { workspace: '/Users/x/code/orchard', steps: [
    user('How do I paginate the orchard API?', T0 + 1000, '/Users/x/code/orchard'),
    reply('', T0 + 2000, { thinking: 'HIDDEN-THINKING', tools: ['view_file', 'grep_search', 'view_file'] }),
    toolRun(T0 + 2500),
    reply('Use a cursor, not an offset.', T0 + 3000, { thinking: 'MORE-HIDDEN-THINKING' }),
    system('[Notice] SYSTEM-NOTICE-NEVER-CAPTURED', T0 + 3500),
    user('And what about sorting?', T0 + 4000),
    reply('Sort server-side by created_at.', T0 + 5000),
  ] }).close();
  // a subagent run: parent cascade in field 5, root != own id, no user step
  createConversation(H1, ID(2), { parent: ID(1), root: ID(1), steps: [user('SUBAGENT-BRIEF', T0 + 6000), reply('sub ok', T0 + 7000)] }).close();
  // a child only the summaries DB marks as such
  createConversation(H1, ID(3), { steps: [user('SUMMARY-MARKED-CHILD', T0 + 8000), reply('x', T0 + 9000)] }).close();
  // assistant-only (no user input) and empty conversations
  createConversation(H1, ID(4), { steps: [reply('nobody asked', T0 + 1000)] }).close();
  createConversation(H1, ID(5)).close();
  // no workspace recorded in the trajectory blob, only on the user step
  createConversation(H1, ID(6), { workspace: '', steps: [user('where am I?', T0 + 1000, '/Users/x/code/pear')] }).close();
  // no workspace anywhere
  createConversation(H1, ID(7), { workspace: '', steps: [user('homeless prompt', T0 + 1000)] }).close();
  writeSummaries(H1, [{ id: ID(1), title: 'Orchard pagination' }, { id: ID(3), parent: ID(1) }, { id: ID(6), title: '' }]);
}
await t('conversations: each top-level DB becomes an item (sid = uuid, project/cwd from the workspace, title, ts, prompts)', () => {
  const m = bySid(runParse(H1));
  eq(Object.keys(m).sort().join(','), [ID(1), ID(6), ID(7)].join(','), 'only top-level conversations with a user prompt');
  const s = m[ID(1)];
  eq(s.project, 'orchard', 'project = workspace basename'); eq(s.cwd, '/Users/x/code/orchard', 'cwd = workspace path');
  eq(s.title, 'Orchard pagination', 'agy-written title from conversation_summaries.db');
  eq(s.ts, new Date(T0).toISOString(), 'created time from the trajectory blob');
  eq(JSON.stringify(s.prompts), JSON.stringify(['How do I paginate the orchard API?', 'And what about sorting?']), 'user turns, in order');
  eq(m[ID(6)].project, 'pear', 'workspace falls back to the user step'); eq(m[ID(6)].title, 'where am I?', 'empty summary title → first prompt');
  eq(m[ID(7)].project, 'antigravity', 'no workspace at all → the tool name'); eq(m[ID(7)].cwd, null, 'cwd null');
});
await t('conversations: transcript keeps user + assistant text and tool NAMES; never thinking, tool args/output or system notices', () => {
  const s = bySid(runParse(H1))[ID(1)];
  eq(s.transcript, [
    'user: How do I paginate the orchard API?',
    'tool: view_file, grep_search',
    'assistant: Use a cursor, not an offset.',
    'user: And what about sorting?',
    'assistant: Sort server-side by created_at.',
  ].join('\n\n'), 'exact multi-turn transcript');
  eq(s.size, s.transcript.length, 'size = full length');
  for (const bad of ['HIDDEN-THINKING', 'TOOL-ARGS-NEVER-CAPTURED', 'TOOL-RUN-NEVER-CAPTURED', 'SYSTEM-NOTICE-NEVER-CAPTURED']) assert(!s.transcript.includes(bad), `${bad} leaked`);
});
await t('conversations: subagent runs (trajectory parent, or parent in conversation_summaries.db) are skipped', () => {
  const m = bySid(runParse(H1));
  assert(!m[ID(2)], 'blob-marked subagent'); assert(!m[ID(3)], 'summary-marked child');
  assert(!JSON.stringify(m).includes('SUBAGENT-BRIEF'), 'no subagent text anywhere');
});
await t('conversations: a conversation over the 8000-char cap exposes loadFull', () => {
  const H = fresh('h-long');
  createConversation(H, ID(10), { steps: Array.from({ length: 30 }, (_, i) => (i % 2 ? reply(`answer ${i} ` + 'y'.repeat(400), T0 + i) : user(`question ${i} ` + 'x'.repeat(400), T0 + i))) }).close();
  const s = runParse(H)[0];
  assert(s.size > 8000, 'fixture is long'); assert(s.transcript.length <= 8001, 'clipped'); assert(s.hasFull, 'loadFull present');
});

// ── 2. garbage in, nothing out, nothing thrown ───────────────────────────────
await t('corrupt / zero-byte / table-less DBs and corrupt blobs are skipped; good conversations beside them still parse', () => {
  const H = fresh('h-bad');
  createConversation(H, ID(20), { steps: [user('the good one', T0)] }).close();
  const dir = join(agy(H), 'conversations');
  writeFileSync(join(dir, `${ID(21)}.db`), 'this is not a sqlite database at all\n'.repeat(50));
  writeFileSync(join(dir, `${ID(22)}.db`), '');
  const x = new DatabaseSync(join(dir, `${ID(23)}.db`)); x.exec('CREATE TABLE unrelated (x)'); x.close();
  // valid DB, garbage trajectory blob and one garbage step: the readable steps survive
  const db = createConversation(H, ID(24), { steps: [user('survives a bad neighbour', T0)] });
  db.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = 'main'").run(Uint8Array.from([0x0a, 0x7f, 0x01]));
  addSteps(db, [Uint8Array.from([0xa2, 0x01, 0x7f, 0x00]), reply('still here', T0 + 10)]);
  db.close();
  writeFileSync(join(agy(H), 'conversation_summaries.db'), 'garbage summaries');
  const m = bySid(runParse(H));
  eq(Object.keys(m).sort().join(','), [ID(20), ID(24)].join(','), 'only the readable conversations');
  eq(m[ID(24)].transcript, 'user: survives a bad neighbour\n\nassistant: still here', 'corrupt step dropped, rest kept');
  eq(m[ID(24)].project, 'antigravity', 'unreadable trajectory blob → no workspace');
  eq(runParse(fresh('h-none')).length, 0, 'no agy data at all');
});

// ── 3. legacy history.jsonl, and both formats together ───────────────────────
await t('legacy history.jsonl still parses (agy < 1.3), grouped by conversationId', () => {
  const H = fresh('h-legacy');
  mkdirSync(agy(H), { recursive: true });
  writeFileSync(join(agy(H), 'history.jsonl'), [
    { display: 'Write tests for the guava parser', timestamp: String(T0), workspace: '/Users/x/code/guava', conversationId: 'old-1' },
    { display: 'and the fixtures', timestamp: String(T0 + 5000), workspace: '/Users/x/code/guava', conversationId: 'old-1' },
    'not json',
  ].map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n');
  const s = runParse(H);
  eq(s.length, 1, 'one conversation'); eq(s[0].sid, 'old-1', 'sid'); eq(s[0].project, 'guava', 'project');
  eq(JSON.stringify(s[0].prompts), JSON.stringify(['Write tests for the guava parser', 'and the fixtures']), 'prompts');
});
await t('both formats: history.jsonl + conversation DBs are merged; a conversation in both is the DB item, once', () => {
  const H = fresh('h-both');
  createConversation(H, ID(30), { workspace: '/Users/x/code/fig', steps: [user('fig prompt', T0), reply('fig answer', T0 + 1)] }).close();
  writeFileSync(join(agy(H), 'history.jsonl'), [
    { display: 'fig prompt', timestamp: String(T0), workspace: '/Users/x/code/fig', conversationId: ID(30) },
    { display: 'an older lime prompt', timestamp: String(T0 - 86400000), workspace: '/Users/x/code/lime', conversationId: 'old-lime' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const items = runParse(H);
  eq(items.map((i) => i.sid).sort().join(','), [ID(30), 'old-lime'].sort().join(','), 'one item each');
  assert(bySid(items)[ID(30)].transcript.includes('assistant: fig answer'), 'the DB (richer) version wins');
});

// ── 4. the watcher notices the new layout ────────────────────────────────────
await t('watch-agy: conversation DBs, their WAL, the summaries DB and history.jsonl trigger; logs/caches do not', () => {
  for (const f of ['history.jsonl', 'conversations', `conversations/${ID(1)}.db`, `conversations/${ID(1)}.db-wal`, 'conversation_summaries.db', 'conversation_summaries.db-wal', null]) assert(isAgyCaptureChange(f), `should trigger: ${f}`);
  for (const f of ['cli.log', 'log/cli-20261006_225206.log', 'cache/x', 'brain/abc/notes.md', 'presence/p', 'conversations/readme.txt']) assert(!isAgyCaptureChange(f), `should not trigger: ${f}`);
});

// ── 5. the full ingest(): backfill, scrub, guards, segments, read-only, idempotence ──
function makeHome(name) {
  const home = fresh(name);
  mkdirSync(agy(home), { recursive: true }); // detect.mjs: ~/.gemini/antigravity-cli → `antigravity` is linked
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const store = join(home, '.claude-brain', 'brain.db');
  openStore({ path: store }).close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'test\n');
  return { home, store };
}
function runIngest(home, only = ['antigravity']) {
  const child = `
    const { MEMORY_DB } = await import(${JSON.stringify(join(REPO, 'bin/lib/paths.mjs'))});
    if (!MEMORY_DB.startsWith(${JSON.stringify(home)})) { console.log('UNSAFE ' + MEMORY_DB); process.exit(3); }
    const { ingest } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
    console.log(JSON.stringify(await ingest({ only: ${JSON.stringify(only)}, cutoff: 0 })));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: cleanEnv(home), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ingest child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
function q(store, sql, ...args) {
  const db = new DatabaseSync(store, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

const I = makeHome('h-ingest');
{
  createConversation(I.home, ID(40), { steps: [user('Where is the orchard cache invalidated?', T0 + 1), reply('In cache.ts, on write.', T0 + 2)] }).close();
  createConversation(I.home, ID(41), { steps: [user(`Use this token ${SECRET} for the deploy`, T0 + 1), reply(`I will not echo ${SECRET} back`, T0 + 2)] }).close();
  createConversation(I.home, ID(42), { workspace: join(I.home, '.claude-brain', 'self-runs'), steps: [user('anything at all', T0 + 1)] }).close();
  createConversation(I.home, ID(43), { workspace: '/Users/x/tmp/e2e-probe-001', steps: [user('a harness probe', T0 + 1), reply('ok', T0 + 2)] }).close();
  createConversation(I.home, ID(44), { steps: Array.from({ length: 30 }, (_, i) => (i % 2 ? reply(`longanswer${i} ` + 'y'.repeat(400), T0 + i) : user(`longquestion${i} ` + 'x'.repeat(400), T0 + i))) }).close();
  createConversation(I.home, ID(45), { parent: ID(40), root: ID(40), steps: [user('SUBAGENT-BRIEF', T0 + 1)] }).close();
  writeFileSync(join(agy(I.home), 'history.jsonl'), JSON.stringify({ display: 'An old guava prompt', timestamp: String(T0 - 1000), workspace: '/Users/x/code/guava', conversationId: 'old-guava' }) + '\n');
}
const AGY_BEFORE = snapshot(agy(I.home));
let first;
await t('ingest: first run back-fills conversation DBs + history.jsonl under source "antigravity"', () => {
  first = runIngest(I.home).antigravity;
  assert(first, 'antigravity was linked and ingested');
  eq(first.sessions, 4, 'cache, secret, long + the legacy prompt'); eq(first.observations, 4, 'one raw observation each');
  eq(first.selfSkipped, 1, 'self-runs workspace'); eq(first.testSkipped, 1, 'e2e probe project');
  const rows = q(I.store, `SELECT memory_session_id m, project FROM sdk_sessions WHERE platform_source = 'antigravity' ORDER BY m`);
  eq(rows.map((r) => r.m).join(','), [ID(40), ID(41), ID(44), 'old-guava'].map((s) => 'antigravity:' + s).join(','), 'session ids');
  eq(rows.find((r) => r.m === 'antigravity:' + ID(40)).project, 'orchard', 'conversation project');
  eq(rows.find((r) => r.m === 'antigravity:old-guava').project, 'guava', 'legacy project');
  eq(q(I.store, `SELECT COUNT(*) n FROM sdk_sessions WHERE memory_session_id = ?`, 'antigravity:' + ID(45))[0].n, 0, 'subagent not stored');
});
await t('ingest: secrets are scrubbed from the observation, its prompts and the session row', () => {
  const sid = 'antigravity:' + ID(41);
  const rows = q(I.store, `SELECT text, title, narrative FROM observations WHERE memory_session_id = ?`, sid);
  eq(rows.length, 1, 'captured');
  assert(!JSON.stringify(rows).includes(SECRET), 'raw token in an observation');
  assert(!JSON.stringify(q(I.store, `SELECT prompt_text FROM user_prompts WHERE content_session_id = ?`, ID(41))).includes(SECRET), 'raw token in user_prompts');
  assert(!JSON.stringify(q(I.store, `SELECT user_prompt FROM sdk_sessions WHERE memory_session_id = ?`, sid)).includes(SECRET), 'raw token in sdk_sessions');
});
await t('ingest: a long conversation also stores its FULL transcript for segmented distillation', () => {
  eq(first.fullStored, 1, 'one full transcript stored');
  const r = q(I.store, `SELECT size FROM session_transcripts WHERE memory_session_id = ?`, 'antigravity:' + ID(44));
  eq(r.length, 1, 'session_transcripts row'); assert(r[0].size > 8000, 'full size recorded');
});
await t("ingest: agy's own files are only read — every DB byte-identical, no -wal/-shm/-journal created", () => {
  const after = snapshot(agy(I.home));
  for (const k of Object.keys(AGY_BEFORE)) eq(after[k], AGY_BEFORE[k], `unchanged: ${k}`);
  eq(Object.keys(after).sort().join(','), Object.keys(AGY_BEFORE).sort().join(','), 'no new files under the agy dir');
});
await t('ingest: a second run is idempotent; a conversation that grows is refreshed, a new one is picked up alone', () => {
  const again = runIngest(I.home).antigravity;
  eq(again.sessions, 0, 'no new sessions'); eq(again.observations, 0, 'no new observations'); eq(again.fullStored, 0, 'no new full transcripts');
  const db = new DatabaseSync(join(agy(I.home), 'conversations', `${ID(40)}.db`));
  addSteps(db, [user('one more follow-up about the cache', T0 + 10), reply('Also on delete.', T0 + 11)]);
  db.close();
  createConversation(I.home, ID(46), { steps: [user('a brand new agy question', T0 + 3600000)] }).close();
  const third = runIngest(I.home).antigravity;
  eq(third.sessions, 1, 'only the new one'); eq(third.refreshed, 1, 'the grown one refreshed');
  const rows = q(I.store, `SELECT text FROM observations WHERE memory_session_id = ?`, 'antigravity:' + ID(40));
  eq(rows.length, 1, 'still one observation'); assert(rows[0].text.includes('one more follow-up about the cache'), 'new turn captured');
  const fourth = runIngest(I.home).antigravity;
  eq(fourth.sessions + fourth.observations + (fourth.refreshed || 0), 0, 'and quiet again');
});

// ── report ───────────────────────────────────────────────────────────────────
for (const [s, n, m] of results) console.log(`${s === 'PASS' ? '  ✓' : '  ✗'} ${n}${m ? '\n    ' + m.replace(/\n/g, '\n    ') : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
