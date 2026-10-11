#!/usr/bin/env node
// Tests for parseKilo() in bin/lib/ingest.mjs — Kilo Code (VS Code / Cursor
// extension + Kilo CLI) session capture. BETA: the fixtures reproduce the
// on-disk shapes read out of Kilo-Org/kilocode's source (see the header of
// parseKilo and bin/lib/kilo.mjs); they were not taken from a live install.
//
//   node evals/ingest-kilo-test.mjs
//
// Pins: kilo.db (session/message/part tables) → items, text-part filtering
// (synthetic/ignored/reasoning/tool output dropped, tool NAMES kept), child
// sessions skipped, project from project.worktree, legacy pre-v7 task folders
// (api_conversation_history.json + history_item.json + _index.json) on both the
// macOS and Linux globalStorage layouts, dedupe against sessions the v7
// migration already imported (slug), empty/corrupt/garbage inputs, then the full
// ingest(): scrub, self-capture skip, test-data skip, long-session segment
// storage, back-fill + idempotence, and that Kilo's own files are only read.
//
// SAFETY: every $HOME, Kilo DB and brain store is synthetic, under the
// scratchpad (or $TMPDIR). ingest() runs in a child with HOME=<fake> that
// refuses to run unless its resolved store lives under that fake home. No real
// Kilo file is read; every fixture string is invented.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../bin/lib/store.mjs';
import { scrubText } from '../bin/lib/scrub.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `ingest-kilo-test-${process.pid}`);
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

// ── fixture builders (layout from Kilo's source; content invented) ───────────
const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const kiloData = (home) => join(home, '.local', 'share', 'kilo');
const gsRoot = (home, host = 'Code', linux = process.platform === 'linux') =>
  (linux ? join(home, '.config', host, 'User') : join(home, 'Library', 'Application Support', host, 'User'));
const globalStorage = (home, host = 'Code', linux) => join(gsRoot(home, host, linux), 'globalStorage', 'kilocode.kilo-code');

// packages/core/src/session/sql.ts (+ project/sql.ts): only the columns the parser reads
// and the NOT NULL ones Kilo declares.
function createKiloDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
      title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  return db;
}
let seq = 0;
const nid = (p) => `${p}_${String(++seq).padStart(6, '0')}`;
function addProject(db, id, worktree) {
  db.prepare('INSERT OR IGNORE INTO project VALUES (?,?,?,?,?)').run(id, worktree, T0, T0, JSON.stringify([worktree]));
}
// turns: [{ role, parts: [string | {type, ...}] }]
function addSession(db, { id, project = 'prj_a', directory, title = 'New session - 2026-09-20T10:00:00.000Z', parent = null, slug, at = T0, turns }) {
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,NULL)').run(id, project, parent, slug || `slug-${id}`, directory, title, '7.8.8', at, at + 60000);
  let t = at;
  for (const turn of turns) {
    const mid = nid('msg');
    t += 1000;
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(mid, id, t, t, JSON.stringify({ role: turn.role, time: { created: t } }));
    for (const p of turn.parts) {
      const data = typeof p === 'string' ? { type: 'text', text: p } : p;
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(nid('prt'), mid, id, t, t, JSON.stringify(data));
    }
  }
}
const u = (...parts) => ({ role: 'user', parts });
const a = (...parts) => ({ role: 'assistant', parts });
const tool = (name) => ({ type: 'tool', callID: nid('c'), tool: name, state: { status: 'completed', input: { secretish: 'TOOL-INPUT-NEVER-CAPTURED' }, output: 'TOOL-OUTPUT-NEVER-CAPTURED' } });

// pre-v7 task folder: <globalStorage>/tasks/<id>/…
function writeLegacyTask(gs, id, { api, item, ui } = {}) {
  const dir = join(gs, 'tasks', id);
  mkdirSync(dir, { recursive: true });
  if (api !== undefined) writeFileSync(join(dir, 'api_conversation_history.json'), typeof api === 'string' ? api : JSON.stringify(api));
  if (item !== undefined) writeFileSync(join(dir, 'history_item.json'), JSON.stringify(item));
  if (ui !== undefined) writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify(ui));
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

// A child process env that cannot see the operator's XDG / Kilo overrides.
const cleanEnv = (home, extra = {}) => {
  const env = { ...process.env, HOME: home, ...extra };
  for (const k of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'KILO_DB', 'KILO_CONFIG_DIR']) if (!(k in extra)) delete env[k];
  return env;
};
function runParse(home, env = {}) {
  const child = `
    const { parseKilo } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
    console.log(JSON.stringify(parseKilo().map((i) => ({ sid: i.sid, project: i.project, cwd: i.cwd, title: i.title, ts: i.ts, prompts: i.prompts, transcript: i.transcript, size: i.size, hasFull: typeof i.loadFull === 'function' }))));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: cleanEnv(home, env), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`parse child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const bySid = (items) => Object.fromEntries(items.map((i) => [i.sid, i]));
const fresh = (name) => { const home = join(ROOT, name); mkdirSync(home, { recursive: true }); return home; };

// ── 1. kilo.db → items ───────────────────────────────────────────────────────
const H1 = fresh('h-db');
{
  const db = createKiloDb(join(kiloData(H1), 'kilo.db'));
  addProject(db, 'prj_a', '/Users/x/code/orchard');
  addProject(db, 'prj_g', '/'); // the "global" non-git project
  addSession(db, {
    id: 'ses_main', directory: '/Users/x/code/orchard/packages/web', turns: [
      u('How do I paginate the orchard API?'),
      a({ type: 'reasoning', text: 'HIDDEN-REASONING' }, tool('read'), tool('grep'), tool('read'), 'Use a cursor, not an offset.'),
      u({ type: 'text', text: 'SYNTHETIC-CONTEXT-BLOCK', synthetic: true }, { type: 'text', text: 'IGNORED-ATTACHMENT-TEXT', ignored: true }, 'And what about sorting?'),
      a('Sort server-side by created_at.'),
    ],
  });
  addSession(db, { id: 'ses_title', project: 'prj_a', directory: '/Users/x/code/orchard', title: 'Pagination design', turns: [u('Ship it'), a('Done')] });
  addSession(db, { id: 'ses_global', project: 'prj_g', directory: '/Users/x/scratch/notes', turns: [u('Quick question about notes'), a('Sure')] });
  addSession(db, { id: 'ses_child', parent: 'ses_main', directory: '/Users/x/code/orchard', turns: [u('SUBAGENT-GENERATED-PROMPT'), a('ok')] });
  addSession(db, { id: 'ses_noprompt', directory: '/Users/x/code/orchard', turns: [a('assistant only, nothing from the user')] });
  addSession(db, { id: 'ses_empty', directory: '/Users/x/code/orchard', turns: [] });
  db.close();
}
await t('kilo.db: sessions become items (sid, project from project.worktree, cwd, title, prompts, ts)', () => {
  const m = bySid(runParse(H1));
  eq(Object.keys(m).sort().join(','), 'ses_global,ses_main,ses_title', 'only real top-level sessions with a user prompt');
  const s = m.ses_main;
  eq(s.project, 'orchard', 'project is the repo (worktree) basename, not the sub-folder');
  eq(s.cwd, '/Users/x/code/orchard/packages/web', 'cwd is the session directory');
  eq(JSON.stringify(s.prompts), JSON.stringify(['How do I paginate the orchard API?', 'And what about sorting?']), 'user text only');
  eq(s.title, 'How do I paginate the orchard API?', 'generic "New session" title replaced by the first prompt');
  eq(s.ts, new Date(T0).toISOString(), 'session start as ISO');
  eq(m.ses_title.title, 'Pagination design', 'a real title is kept');
  eq(m.ses_global.project, 'notes', 'project "/" falls back to the session directory');
});
await t('kilo.db: transcript has user + assistant prose and tool NAMES; never reasoning, synthetic/ignored text, or tool input/output', () => {
  const s = bySid(runParse(H1)).ses_main;
  assert(s.transcript.startsWith('user: How do I paginate'), 'starts with the first user turn');
  assert(s.transcript.includes('assistant: Use a cursor, not an offset.'), 'assistant prose kept');
  assert(s.transcript.includes('tool: read, grep'), 'tool names kept once each');
  for (const bad of ['HIDDEN-REASONING', 'SYNTHETIC-CONTEXT-BLOCK', 'IGNORED-ATTACHMENT-TEXT', 'TOOL-INPUT-NEVER-CAPTURED', 'TOOL-OUTPUT-NEVER-CAPTURED']) {
    assert(!s.transcript.includes(bad), `${bad} must not be captured`);
  }
  assert(!JSON.stringify(s.prompts).includes('SYNTHETIC'), 'synthetic text is not a prompt');
});
await t('kilo.db: child (sub-agent) sessions, assistant-only and empty sessions are not captured', () => {
  const m = bySid(runParse(H1));
  for (const id of ['ses_child', 'ses_noprompt', 'ses_empty']) assert(!m[id], `${id} must be skipped`);
});
await t('kilo.db: XDG_DATA_HOME and KILO_DB are honoured (like xdg-basedir / database.ts), HOME default otherwise', () => {
  const H = fresh('h-xdg');
  const xdg = join(H, 'custom-data');
  const db = createKiloDb(join(xdg, 'kilo', 'kilo.db'));
  addProject(db, 'prj_a', '/w/xdgproj'); addSession(db, { id: 'ses_x', directory: '/w/xdgproj', turns: [u('hello from xdg')] }); db.close();
  eq(runParse(H).length, 0, 'default location is empty');
  eq(runParse(H, { XDG_DATA_HOME: xdg })[0].sid, 'ses_x', 'XDG_DATA_HOME');
  const db2 = createKiloDb(join(H, 'elsewhere.db'));
  addProject(db2, 'prj_a', '/w/over'); addSession(db2, { id: 'ses_k', directory: '/w/over', turns: [u('via KILO_DB')] }); db2.close();
  eq(runParse(H, { KILO_DB: join(H, 'elsewhere.db') })[0].sid, 'ses_k', 'KILO_DB absolute path');
});
await t('kilo.db: a session over the 8000-char cap exposes loadFull (stored whole by ingest, see below)', () => {
  const H = fresh('h-long');
  const db = createKiloDb(join(kiloData(H), 'kilo.db'));
  addProject(db, 'prj_a', '/w/long');
  addSession(db, { id: 'ses_long', directory: '/w/long', turns: Array.from({ length: 30 }, (_, i) => (i % 2 ? a(`answer ${i} ` + 'y'.repeat(400)) : u(`question ${i} ` + 'x'.repeat(400)))) });
  db.close();
  const s = runParse(H)[0];
  assert(s.size > 8000, 'fixture is long'); assert(s.transcript.length <= 8001, 'row transcript clipped'); assert(s.hasFull, 'loadFull present');
});

// ── 2. garbage in, nothing out, nothing thrown ───────────────────────────────
await t('corrupt / empty / table-less / locked-schema kilo.db yields [] (never throws)', () => {
  const H = fresh('h-bad');
  mkdirSync(kiloData(H), { recursive: true });
  writeFileSync(join(kiloData(H), 'kilo.db'), 'this is not a sqlite database at all\n'.repeat(50));
  eq(runParse(H).length, 0, 'garbage file');
  writeFileSync(join(kiloData(H), 'kilo.db'), '');
  eq(runParse(H).length, 0, 'zero-byte file');
  rmSync(join(kiloData(H), 'kilo.db'));
  const db = new DatabaseSync(join(kiloData(H), 'kilo.db')); db.exec('CREATE TABLE unrelated (x)'); db.close();
  eq(runParse(H).length, 0, 'a database without session/message/part tables');
  const H2 = fresh('h-nodb'); eq(runParse(H2).length, 0, 'no Kilo data at all');
});
await t('a message/part with invalid JSON is skipped, the rest of the session still captured', () => {
  const H = fresh('h-badjson');
  const db = createKiloDb(join(kiloData(H), 'kilo.db'));
  addProject(db, 'prj_a', '/w/bj');
  addSession(db, { id: 'ses_bj', directory: '/w/bj', turns: [u('first real prompt'), a('reply')] });
  db.prepare("INSERT INTO message VALUES ('msg_zz', 'ses_bj', ?, ?, '{not json')").run(T0 + 90000, T0 + 90000);
  db.prepare("INSERT INTO part VALUES ('prt_zz', 'msg_zz', 'ses_bj', ?, ?, 'also {not json')").run(T0 + 90000, T0 + 90000);
  db.close();
  const s = runParse(H)[0];
  eq(s.sid, 'ses_bj', 'session survives'); eq(JSON.stringify(s.prompts), JSON.stringify(['first real prompt']), 'prompts');
});

await t('a live WAL-mode kilo.db (Kilo running, writer connection open) is readable, including rows still in the -wal file', () => {
  const H = fresh('h-wal');
  const db = createKiloDb(join(kiloData(H), 'kilo.db'));
  db.exec('PRAGMA journal_mode=WAL');
  addProject(db, 'prj_a', '/w/wal');
  addSession(db, { id: 'ses_wal', directory: '/w/wal', turns: [u('written while kilo is running'), a('ok')] }); // not checkpointed: lives in kilo.db-wal
  try {
    assert(existsSync(join(kiloData(H), 'kilo.db-wal')), 'fixture is really in WAL mode');
    const s = runParse(H);
    eq(s.length, 1, 'session visible'); eq(s[0].sid, 'ses_wal', 'sid');
  } finally { db.close(); }
});

// ── 3. legacy pre-v7 task folders (both host layouts) ────────────────────────
const H3 = fresh('h-legacy');
const legacyApi = [
  { role: 'user', ts: T0 + 1000, content: [
    { type: 'text', text: '<task>\nAdd dark mode to the settings page\n</task>' },
    { type: 'text', text: '<environment_details>\n# VSCode Visible Files\nsrc/a.ts\n</environment_details>' },
  ] },
  { role: 'assistant', ts: T0 + 2000, content: [{ type: 'text', text: 'I will start by reading the theme file.' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/theme.ts' } }] },
  { role: 'user', ts: T0 + 3000, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'LEGACY-TOOL-RESULT' }, { type: 'text', text: "[read_file for 'src/theme.ts'] Result:" }, { type: 'text', text: '<environment_details>\nx\n</environment_details>' }] },
  { role: 'assistant', ts: T0 + 4000, content: 'Dark mode wired through the theme provider.' },
  { role: 'user', ts: T0 + 5000, content: 'Looks good, thanks' },
];
{
  const gs = globalStorage(H3, 'Code');
  writeLegacyTask(gs, '0f1e2d3c-0000-4000-8000-000000000001', { api: legacyApi, item: { id: '0f1e2d3c-0000-4000-8000-000000000001', task: 'Dark mode task', workspace: '/Users/x/code/orchard', ts: T0 } });
  writeLegacyTask(gs, '0f1e2d3c-0000-4000-8000-000000000002', { api: legacyApi }); // no history_item → _index.json
  mkdirSync(join(gs, 'tasks'), { recursive: true });
  writeFileSync(join(gs, 'tasks', '_index.json'), JSON.stringify({ entries: [{ id: '0f1e2d3c-0000-4000-8000-000000000002', task: 'Indexed task', workspace: '/Users/x/code/pear', ts: T0 + 10 }] }));
  writeLegacyTask(gs, '0f1e2d3c-0000-4000-8000-000000000003', { ui: [{ type: 'say', say: 'text', text: 'ui only' }] }); // ui-only folder
  writeLegacyTask(gs, '0f1e2d3c-0000-4000-8000-000000000004', { api: '{ this is truncated' }); // corrupt
  writeLegacyTask(gs, '0f1e2d3c-0000-4000-8000-000000000005', { api: [] }); // empty history
  writeLegacyTask(gs, '0f1e2d3c-0000-4000-8000-000000000006', { api: { not: 'an array' } }); // wrong shape
  writeLegacyTask(gs, '0f1e2d3c-0000-4000-8000-000000000007', { api: [{ role: 'assistant', content: 'no user turn' }] });
  writeLegacyTask(globalStorage(H3, 'Cursor'), '0f1e2d3c-0000-4000-8000-000000000008', { api: [{ role: 'user', content: 'cursor-hosted legacy prompt' }], item: { id: 'x', task: 'In Cursor', workspace: '/Users/x/code/plum', ts: T0 + 20 } });
}
await t('legacy tasks: <task> unwrapped, environment_details / tool results stripped, project from history_item then _index', () => {
  const m = bySid(runParse(H3));
  const one = m['0f1e2d3c-0000-4000-8000-000000000001'];
  eq(one.project, 'orchard', 'history_item workspace'); eq(one.cwd, '/Users/x/code/orchard', 'cwd'); eq(one.title, 'Dark mode task', 'history_item task as title');
  eq(JSON.stringify(one.prompts), JSON.stringify(['Add dark mode to the settings page', 'Looks good, thanks']), 'real prompts only');
  assert(one.transcript.includes('assistant: Dark mode wired through the theme provider.'), 'assistant string content');
  assert(one.transcript.includes('tool: read_file'), 'tool_use name kept');
  for (const bad of ['LEGACY-TOOL-RESULT', 'VSCode Visible Files', 'environment_details', 'Result:']) assert(!one.transcript.includes(bad), `${bad} must be stripped`);
  const two = m['0f1e2d3c-0000-4000-8000-000000000002'];
  eq(two.project, 'pear', '_index.json workspace when history_item.json is absent'); eq(two.title, 'Indexed task', '_index task');
});
await t('legacy tasks: Cursor-hosted tasks are found; ui-only, corrupt, empty, wrong-shape and prompt-less folders are skipped', () => {
  const m = bySid(runParse(H3));
  eq(m['0f1e2d3c-0000-4000-8000-000000000008']?.project, 'plum', 'Cursor globalStorage tasks');
  for (const n of [3, 4, 5, 6, 7]) assert(!m[`0f1e2d3c-0000-4000-8000-00000000000${n}`], `task ${n} must be skipped`);
  eq(Object.keys(m).length, 3, 'exactly the three good tasks');
});
await t('legacy tasks: the Linux layout (~/.config/<Host>/User/globalStorage) is read too', () => {
  const H = fresh('h-legacy-linux');
  writeLegacyTask(globalStorage(H, 'Code', true), 'lin-1', { api: [{ role: 'user', content: 'linux legacy prompt' }], item: { id: 'lin-1', task: 'T', workspace: '/home/u/proj', ts: T0 } });
  const s = runParse(H, { BRAIN_PLATFORM_OVERRIDE: 'linux' });
  eq(s.length, 1, 'one task'); eq(s[0].project, 'proj', 'project');
});
await t('legacy tasks already imported into kilo.db by the v7 migration (session.slug = task id) are not captured twice', () => {
  const H = fresh('h-dedupe');
  const id = '0f1e2d3c-0000-4000-8000-0000000000aa';
  writeLegacyTask(globalStorage(H, 'Code'), id, { api: [{ role: 'user', content: 'migrated prompt' }], item: { id, task: 'Migrated', workspace: '/w/mig', ts: T0 } });
  writeLegacyTask(globalStorage(H, 'Code'), 'still-legacy', { api: [{ role: 'user', content: 'unmigrated prompt' }], item: { id: 'still-legacy', task: 'Not yet', workspace: '/w/mig', ts: T0 } });
  const db = createKiloDb(join(kiloData(H), 'kilo.db'));
  addProject(db, 'prj_a', '/w/mig'); addSession(db, { id: 'ses_migrated', slug: id, directory: '/w/mig', turns: [u('migrated prompt'), a('answer')] }); db.close();
  const m = bySid(runParse(H));
  eq(Object.keys(m).sort().join(','), 'ses_migrated,still-legacy', 'migrated once (from the DB), the other still from disk');
});

// ── 4. the full ingest(): backfill, scrub, guards, segments, idempotence ──────
function makeHome(name, { host = true } = {}) {
  const home = fresh(name);
  if (host) mkdirSync(globalStorage(home, 'Code'), { recursive: true }); // detect.mjs: Kilo Code (VS Code) is installed → `kilo` is linked
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const store = join(home, '.claude-brain', 'brain.db');
  openStore({ path: store }).close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'test\n');
  return { home, store };
}
function runIngest(home, only = ['kilo']) {
  const child = `
    const { MEMORY_DB } = await import(${JSON.stringify(join(REPO, 'bin/lib/paths.mjs'))});
    if (!MEMORY_DB.startsWith(${JSON.stringify(home)})) { console.log('UNSAFE ' + MEMORY_DB); process.exit(3); }
    const { ingest } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
    console.log(JSON.stringify(await ingest({ only: ${JSON.stringify(only)} })));`;
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
  const db = createKiloDb(join(kiloData(I.home), 'kilo.db'));
  addProject(db, 'prj_a', '/Users/x/code/orchard');
  addSession(db, { id: 'ses_ok', directory: '/Users/x/code/orchard', turns: [u('Where is the orchard cache invalidated?'), a('In cache.ts, on write.')] });
  addSession(db, { id: 'ses_secret', directory: '/Users/x/code/orchard', turns: [u(`Use this token ${SECRET} for the deploy`), a(`I will not echo ${SECRET} back`)] });
  addSession(db, { id: 'ses_self', directory: '/Users/x/code/orchard', turns: [u('You are a memory distiller. Read the session below and write memories.'), a('{"memories": []}')] });
  addProject(db, 'prj_selfdir', join(I.home, '.claude-brain', 'self-runs'));
  addSession(db, { id: 'ses_selfcwd', project: 'prj_selfdir', directory: join(I.home, '.claude-brain', 'self-runs'), turns: [u('anything at all'), a('x')] });
  addProject(db, 'prj_e2e', '/Users/x/tmp/e2e-probe-001');
  addSession(db, { id: 'ses_fixture', project: 'prj_e2e', directory: '/Users/x/tmp/e2e-probe-001', turns: [u('a harness probe'), a('ok')] });
  addSession(db, { id: 'ses_long', directory: '/Users/x/code/orchard', turns: Array.from({ length: 30 }, (_, i) => (i % 2 ? a(`longanswer${i} ` + 'y'.repeat(400)) : u(`longquestion${i} ` + 'x'.repeat(400)))) });
  db.close();
  writeLegacyTask(globalStorage(I.home, 'Code'), 'legacy-orchard', { api: [{ role: 'user', content: '<task>Port the legacy pear widget</task>' }, { role: 'assistant', content: 'Ported.' }], item: { id: 'legacy-orchard', task: 'Pear widget', workspace: '/Users/x/code/pear', ts: T0 } });
}
const KILO_FILES_BEFORE = snapshot(kiloData(I.home));
const GS_BEFORE = snapshot(globalStorage(I.home, 'Code'));
let first;
await t('ingest: first run back-fills every existing session (DB + legacy) under source "kilo"', () => {
  first = runIngest(I.home).kilo;
  assert(first, 'kilo was linked and ingested');
  eq(first.sessions, 4, 'ses_ok, ses_secret, ses_long + the legacy task'); eq(first.observations, 4, 'one raw observation each');
  eq(first.selfSkipped, 2, 'distiller-prompt session and self-runs cwd session'); eq(first.testSkipped, 1, 'e2e probe project');
  const rows = q(I.store, `SELECT memory_session_id m, project, platform_source p FROM sdk_sessions WHERE platform_source = 'kilo' ORDER BY m`);
  eq(rows.map((r) => r.m).join(','), 'kilo:legacy-orchard,kilo:ses_long,kilo:ses_ok,kilo:ses_secret', 'session ids');
  eq(rows.find((r) => r.m === 'kilo:legacy-orchard').project, 'pear', 'legacy project'); eq(rows.find((r) => r.m === 'kilo:ses_ok').project, 'orchard', 'db project');
  eq(q(I.store, `SELECT DISTINCT generated_by_model g FROM observations WHERE memory_session_id LIKE 'kilo:%'`).map((r) => r.g).join(','), 'kilo', 'provenance');
  eq(q(I.store, `SELECT COUNT(*) n FROM user_prompts WHERE content_session_id = 'ses_ok'`)[0].n, 1, 'prompt rows');
});
await t('ingest: secrets are scrubbed from the observation, its prompts and the title', () => {
  const rows = q(I.store, `SELECT text, title, narrative FROM observations WHERE memory_session_id = 'kilo:ses_secret'`);
  eq(rows.length, 1, 'captured');
  assert(!JSON.stringify(rows).includes(SECRET), 'raw token stored in an observation');
  assert(!JSON.stringify(q(I.store, `SELECT prompt_text FROM user_prompts WHERE content_session_id = 'ses_secret'`)).includes(SECRET), 'raw token stored in user_prompts');
  assert(!JSON.stringify(q(I.store, `SELECT user_prompt FROM sdk_sessions WHERE memory_session_id = 'kilo:ses_secret'`)).includes(SECRET), 'raw token stored in sdk_sessions');
});
await t('ingest: brain-run (self-capture) and test-fixture sessions are never stored', () => {
  for (const sid of ['ses_self', 'ses_selfcwd', 'ses_fixture']) {
    eq(q(I.store, `SELECT COUNT(*) n FROM sdk_sessions WHERE memory_session_id = ?`, `kilo:${sid}`)[0].n, 0, `${sid} not stored`);
  }
});
await t('ingest: a long session also stores its FULL transcript for segmented distillation', () => {
  eq(first.fullStored, 1, 'one full transcript stored');
  const r = q(I.store, `SELECT size FROM session_transcripts WHERE memory_session_id = 'kilo:ses_long'`);
  eq(r.length, 1, 'session_transcripts row'); assert(r[0].size > 8000, 'full size recorded');
  eq(q(I.store, `SELECT COUNT(*) n FROM session_transcripts WHERE memory_session_id <> 'kilo:ses_long'`)[0].n, 0, 'short sessions have no segment row');
  assert(q(I.store, `SELECT LENGTH(text) n FROM observations WHERE memory_session_id = 'kilo:ses_long'`)[0].n <= 8001, 'the observation row stays clipped');
});
await t('ingest: Kilo\'s own files are only read — kilo.db and the legacy tasks are byte-identical afterwards', () => {
  const after = snapshot(kiloData(I.home));
  for (const k of Object.keys(KILO_FILES_BEFORE)) eq(after[k], KILO_FILES_BEFORE[k], `unchanged: ${k}`);
  eq(Object.keys(after).join(','), Object.keys(KILO_FILES_BEFORE).join(','), 'no new files under the Kilo data dir');
  const gsAfter = snapshot(globalStorage(I.home, 'Code'));
  for (const k of Object.keys(GS_BEFORE)) eq(gsAfter[k], GS_BEFORE[k], `unchanged: ${k}`);
  eq(Object.keys(gsAfter).length, Object.keys(GS_BEFORE).length, 'no new files under globalStorage');
});
await t('ingest: a second run is idempotent; a new session is picked up alone', () => {
  const again = runIngest(I.home).kilo;
  eq(again.sessions, 0, 'no new sessions'); eq(again.observations, 0, 'no new observations'); eq(again.fullStored, 0, 'no new full transcripts');
  const db = new DatabaseSync(join(kiloData(I.home), 'kilo.db'));
  addSession(db, { id: 'ses_new', directory: '/Users/x/code/orchard', turns: [u('a brand new kilo question'), a('answer')], at: T0 + 3600000 });
  db.close();
  const third = runIngest(I.home).kilo;
  eq(third.sessions, 1, 'only the new one'); eq(third.observations, 1, 'its observation');
});
await t('ingest: a session that grows after capture is refreshed (append-only), not duplicated', () => {
  const db = new DatabaseSync(join(kiloData(I.home), 'kilo.db'));
  const t1 = T0 + 3600000 + 5000;
  db.prepare("INSERT INTO message VALUES ('msg_grow', 'ses_new', ?, ?, ?)").run(t1, t1, JSON.stringify({ role: 'user' }));
  db.prepare("INSERT INTO part VALUES ('prt_grow', 'msg_grow', 'ses_new', ?, ?, ?)").run(t1, t1, JSON.stringify({ type: 'text', text: 'one more follow-up about kilo' }));
  db.close();
  const r = runIngest(I.home).kilo;
  eq(r.sessions, 0, 'same session'); eq(r.refreshed, 1, 'raw row refreshed');
  const rows = q(I.store, `SELECT text FROM observations WHERE memory_session_id = 'kilo:ses_new'`);
  eq(rows.length, 1, 'still one observation'); assert(rows[0].text.includes('one more follow-up about kilo'), 'new turn captured');
});
await t('ingest: Kilo not installed (no host extension, no binary) → not linked, nothing parsed even if ~/.local/share/kilo exists', () => {
  const N = makeHome('h-notinstalled', { host: false });
  const db = createKiloDb(join(kiloData(N.home), 'kilo.db')); addProject(db, 'prj_a', '/w/n'); addSession(db, { id: 'ses_n', directory: '/w/n', turns: [u('hi')] }); db.close();
  const child = `
    const { effectiveLinked } = await import(${JSON.stringify(join(REPO, 'bin/lib/detect.mjs'))});
    console.log(JSON.stringify(effectiveLinked({})));`;
  // a PATH with no `kilo`; /opt/homebrew/bin and /usr/local/bin are still scanned by binOnPath — only assert when those lack it
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: cleanEnv(N.home, { PATH: '/usr/bin:/bin' }), encoding: 'utf8' });
  const linked = JSON.parse(r.stdout.trim().split('\n').pop());
  const machineHasKilo = existsSync('/opt/homebrew/bin/kilo') || existsSync('/usr/local/bin/kilo') || existsSync('/opt/homebrew/bin/kilocode') || existsSync('/usr/local/bin/kilocode');
  if (!machineHasKilo) assert(!linked.includes('kilo'), `kilo must not be linked on a machine without Kilo: ${linked}`);
  eq(runIngest(N.home, ['kilo']).kilo?.sessions ?? 0, 0, 'no sessions ingested');
});

// ── report ───────────────────────────────────────────────────────────────────
for (const [s, n, m] of results) console.log(`${s === 'PASS' ? '  ✓' : '  ✗'} ${n}${m ? '\n    ' + m.replace(/\n/g, '\n    ') : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
