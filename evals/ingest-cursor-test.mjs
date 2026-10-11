#!/usr/bin/env node
// Tests for parseCursor() / cursorWorkspaces() in bin/lib/ingest.mjs — Cursor
// conversations attributed to the folder they ran in, not to "cursor".
//
// Why this exists: every Cursor conversation used to land under project
// "cursor", so a folder's Cursor work never showed up in that folder's memory.
// Cursor's workspaceStorage maps conversations (composers) to workspaces; these
// tests pin every mapping source Cursor builds have used, the fallback, that
// Cursor's own files are only ever read, and that rows captured under the old
// placeholder move to their project on the next sync.
//
//   node evals/ingest-cursor-test.mjs
//
// SAFETY: every $HOME, Cursor DB and brain store is synthetic, under the
// scratchpad (or $TMPDIR). ingest() runs in a child with HOME=<fake> that
// refuses to run unless its resolved store lives under that fake home. No real
// Cursor file is read; every fixture string is invented.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../bin/lib/store.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `ingest-cursor-test-${process.pid}`);
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

// ── fixture builders (layout copied from Cursor's; content invented) ─────────
// Default = this platform's real layout: macOS ~/Library/Application Support/Cursor/User,
// Linux ~/.config/Cursor/User (Electron userData; what real Cursor uses on Linux).
const cursorUser = (home, linux = process.platform === 'linux') => linux
  ? join(home, '.config', 'Cursor', 'User')
  : join(home, 'Library', 'Application Support', 'Cursor', 'User');

// globalStorage/state.vscdb: composerData:<id> + bubbleId:<id>:<b> rows, and
// optionally the composerHeaders table current builds keep.
function writeGlobal(user, composers, headers = null) {
  const dir = join(user, 'globalStorage');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'state.vscdb'));
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const put = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
  let ms = Date.parse('2026-09-01T10:00:00.000Z');
  for (const c of composers) {
    const data = { composerId: c.id, name: c.name || `Conversation ${c.id}`, createdAt: (ms += 60000), fullConversationHeadersOnly: [{ bubbleId: 'u' }, { bubbleId: 'a' }] };
    if (c.workspaceIdentifier) data.workspaceIdentifier = c.workspaceIdentifier;
    put.run(`composerData:${c.id}`, JSON.stringify(data));
    put.run(`bubbleId:${c.id}:u`, JSON.stringify({ type: 1, text: `question about ${c.id}` }));
    put.run(`bubbleId:${c.id}:a`, JSON.stringify({ type: 2, text: `answer about ${c.id}` }));
  }
  if (headers) {
    db.exec('CREATE TABLE IF NOT EXISTS composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, value TEXT)');
    const h = db.prepare('INSERT OR REPLACE INTO composerHeaders (composerId, workspaceId, createdAt, value) VALUES (?, ?, 0, ?)');
    for (const [cid, wid] of Object.entries(headers)) h.run(cid, wid, '{}');
  }
  db.close();
}

// workspaceStorage/<id>/: workspace.json (raw string or object) + state.vscdb
// whose ItemTable carries composer.composerData (object, raw string, or absent).
function writeWorkspace(user, id, { json, composerData, vscdbRaw } = {}) {
  const dir = join(user, 'workspaceStorage', id);
  mkdirSync(dir, { recursive: true });
  if (json !== undefined) writeFileSync(join(dir, 'workspace.json'), typeof json === 'string' ? json : JSON.stringify(json));
  if (vscdbRaw !== undefined) { writeFileSync(join(dir, 'state.vscdb'), vscdbRaw); return; }
  const db = new DatabaseSync(join(dir, 'state.vscdb'));
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  if (composerData !== undefined) {
    db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('composer.composerData',
      typeof composerData === 'string' ? composerData : JSON.stringify(composerData));
  }
  db.close();
}

// Every file under a tree → sha256 + size + mtime. Read-only proof.
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        out[p.slice(root.length)] = `${createHash('sha256').update(readFileSync(p)).digest('hex')}:${st.size}:${st.mtimeMs}`;
      }
    }
  };
  walk(root);
  return out;
}

// parseCursor() against a synthetic $HOME, in a child so homedir() and the
// platform override are fresh. Returns [{ sid, project, cwd }].
function runParse(home, env = {}) {
  const child = `
    const { parseCursor } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
    console.log(JSON.stringify(parseCursor().map((i) => ({ sid: i.sid, project: i.project, cwd: i.cwd }))));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child],
    { env: { ...process.env, HOME: home, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`parse child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const bySid = (items) => Object.fromEntries(items.map((i) => [i.sid, i]));

// ── 1. every mapping source, the fallback, and read-only ─────────────────────
const H1 = join(ROOT, 'h-sources');
const U1 = cursorUser(H1);
const WS = {
  alpha: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  beta: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
  delta: 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4',
  suite: 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5',
  remote: 'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6',
  hdr: '0707070707070707070707070707070a',
  badjson: '0808080808080808080808080808080b',
  baddb: '0909090909090909090909090909090c',
  empty: '1790000000001', // empty window: no workspace.json
};
writeGlobal(U1, [
  { id: 'c-all' },                                   // allComposers in alpha (also "selected" in beta)
  { id: 'c-sel' },                                   // only selectedComposerIds in beta
  { id: 'c-focus' },                                 // only lastFocusedComposerIds in beta
  { id: 'c-uri', workspaceIdentifier: { id: 'gone', uri: { $mid: 1, fsPath: '/Users/x/code/gamma', external: 'file:///Users/x/code/gamma', path: '/Users/x/code/gamma', scheme: 'file' } } },
  { id: 'c-wsid', workspaceIdentifier: { id: WS.delta } },  // id only → delta's workspace.json
  { id: 'c-multi' },                                 // allComposers in a multi-root workspace
  { id: 'c-remote' },                                // allComposers in an ssh-remote workspace
  { id: 'c-hdr' },                                   // composerHeaders.workspaceId only
  { id: 'c-hdr-empty' },                             // composerHeaders → empty window → fallback
  { id: 'c-empty' },                                 // listed only by an empty window → fallback
  { id: 'c-badjson' },                               // listed only by a workspace with broken workspace.json
  { id: 'c-orphan' },                                // listed nowhere → fallback
], { 'c-hdr': WS.hdr, 'c-hdr-empty': WS.empty });
writeWorkspace(U1, WS.alpha, { json: { folder: 'file:///Users/x/code/alpha' }, composerData: { allComposers: [{ composerId: 'c-all', name: 'x' }], selectedComposerIds: [] } });
writeWorkspace(U1, WS.beta, { json: { folder: 'file:///Users/x/code/beta%20app' }, composerData: { selectedComposerIds: ['c-sel', 'c-all'], lastFocusedComposerIds: ['c-focus'], hasMigratedComposerData: true } });
writeWorkspace(U1, WS.delta, { json: { folder: 'file:///Users/x/code/delta/' } });
writeWorkspace(U1, WS.suite, { json: { workspace: 'file:///Users/x/code/suite.code-workspace' }, composerData: { allComposers: [{ composerId: 'c-multi' }] } });
writeWorkspace(U1, WS.remote, { json: { folder: 'vscode-remote://ssh-remote%2Bbox/home/u/epsilon' }, composerData: { allComposers: [{ composerId: 'c-remote' }] } });
writeWorkspace(U1, WS.hdr, { json: { folder: 'file:///Users/x/code/zeta' }, composerData: { selectedComposerIds: [] } });
writeWorkspace(U1, WS.badjson, { json: '{ not json', composerData: { allComposers: [{ composerId: 'c-badjson' }] } });
writeWorkspace(U1, WS.baddb, { json: { folder: 'file:///Users/x/code/eta' }, vscdbRaw: 'this is not a sqlite database' });
writeWorkspace(U1, WS.empty, { composerData: { allComposers: [{ composerId: 'c-empty' }] } });

const before1 = snapshot(U1);
let items1 = [];
await t('parse: runs over a workspaceStorage with broken entries without throwing', () => {
  items1 = runParse(H1);
  eq(items1.length, 12, 'every composer with a user turn is still captured');
});
const P = bySid(items1);
await t('allComposers (older builds) → the workspace folder basename', () => {
  eq(P['c-all']?.project, 'alpha', 'c-all project');
  eq(P['c-all']?.cwd, '/Users/x/code/alpha', 'c-all cwd');
});
await t('allComposers wins over another workspace merely having it selected', () => eq(P['c-all']?.project, 'alpha', 'c-all'));
await t('selectedComposerIds / lastFocusedComposerIds (current builds) map too; %-escapes decoded', () => {
  eq(P['c-sel']?.project, 'beta app', 'c-sel');
  eq(P['c-focus']?.project, 'beta app', 'c-focus');
});
await t('composerData.workspaceIdentifier.uri is used directly', () => {
  eq(P['c-uri']?.project, 'gamma', 'c-uri project');
  eq(P['c-uri']?.cwd, '/Users/x/code/gamma', 'c-uri cwd');
});
await t('workspaceIdentifier.id resolves through workspace.json (trailing slash ok)', () => eq(P['c-wsid']?.project, 'delta', 'c-wsid'));
await t('composerHeaders.workspaceId resolves through workspace.json', () => eq(P['c-hdr']?.project, 'zeta', 'c-hdr'));
await t('multi-root .code-workspace → its name without the extension', () => eq(P['c-multi']?.project, 'suite', 'c-multi'));
await t('ssh-remote folder URI → the remote folder basename', () => eq(P['c-remote']?.project, 'epsilon', 'c-remote'));
await t('no folder known → falls back to "cursor" (orphan, empty window, broken workspace.json)', () => {
  for (const sid of ['c-orphan', 'c-empty', 'c-hdr-empty', 'c-badjson']) {
    eq(P[sid]?.project, 'cursor', `${sid} project`);
    eq(P[sid]?.cwd, null, `${sid} cwd`);
  }
});
await t('read-only: no Cursor file is changed, added or removed', () => {
  const after = snapshot(U1);
  eq(JSON.stringify(Object.keys(after).sort()), JSON.stringify(Object.keys(before1).sort()), 'same file set');
  for (const k of Object.keys(before1)) eq(after[k], before1[k], `unchanged: ${k}`);
});

// ── 2. no workspaceStorage at all → everything "cursor", as before ───────────
await t('no workspaceStorage dir → every conversation stays under "cursor"', () => {
  const H = join(ROOT, 'h-noworkspaces');
  writeGlobal(cursorUser(H), [{ id: 'n1' }, { id: 'n2' }]);
  const items = runParse(H);
  eq(items.length, 2, 'both captured');
  assert(items.every((i) => i.project === 'cursor'), 'all cursor: ' + JSON.stringify(items));
});

// ── 3. Linux layout ($XDG_CONFIG_HOME/Cursor) ─────────────────────────────────
await t('linux: workspaceStorage under ~/.config/Cursor maps the same way', () => {
  const H = join(ROOT, 'h-linux');
  const U = cursorUser(H, true);
  writeGlobal(U, [{ id: 'l1' }]);
  writeWorkspace(U, WS.alpha, { json: { folder: 'file:///home/x/code/linuxproj' }, composerData: { allComposers: [{ composerId: 'l1' }] } });
  const items = runParse(H, { BRAIN_PLATFORM_OVERRIDE: 'linux', XDG_CONFIG_HOME: '' });
  eq(items[0]?.project, 'linuxproj', 'l1 project');
});

// ── 4. ingest(): new sessions land in their project; old placeholder rows move ─
function makeHome(name) {
  const home = join(ROOT, name);
  mkdirSync(join(home, '.cursor'), { recursive: true }); // detect.mjs: Cursor is linked
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
    console.log(JSON.stringify(await ingest({ only: ['cursor'] })));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ingest child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
function q(store, sql, ...args) {
  const db = new DatabaseSync(store, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
function rw(store, fn) {
  const db = new DatabaseSync(store);
  try { return fn(db); } finally { db.close(); }
}
const sessProject = (store, sid) => q(store, `SELECT project FROM sdk_sessions WHERE memory_session_id = ?`, `cursor:${sid}`)[0]?.project;
const obsProjects = (store, sid) => q(store, `SELECT project FROM observations WHERE memory_session_id = ? ORDER BY id`, `cursor:${sid}`).map((r) => r.project);

const I = makeHome('h-ingest');
const IU = cursorUser(I.home);
await t('ingest: first sync without workspaceStorage stores the placeholder "cursor"', () => {
  writeGlobal(IU, [{ id: 'g-move' }, { id: 'g-edited' }, { id: 'g-manual' }, { id: 'g-orphan' }]);
  const r = runIngest(I.home).cursor;
  eq(r.sessions, 4, 'sessions'); eq(r.observations, 4, 'observations'); eq(r.unfiled, 0, 'unfiled');
  for (const sid of ['g-move', 'g-edited', 'g-manual', 'g-orphan']) eq(sessProject(I.store, sid), 'cursor', `${sid} session`);
});
// The opt-in path: `brain clean --cursor-projects` against the fake home's store.
function runClean(home, store, ...args) {
  const r = spawnSync(process.execPath, [join(REPO, 'bin/brain.mjs'), 'clean', '--cursor-projects', '--db', store, '--json', ...args],
    { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`clean child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const allRows = (store) => JSON.stringify({
  s: q(store, 'SELECT * FROM sdk_sessions ORDER BY id'),
  o: q(store, 'SELECT * FROM observations ORDER BY id'),
});

await t('ingest: a later sync that knows the folder does NOT relabel existing rows; it only counts them', () => {
  // A distilled row for the same session, as the distiller would leave it.
  rw(I.store, (db) => db.prepare(
    `INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch, content_hash, generated_by_model)
     VALUES ('cursor:g-move', 'cursor', 'distilled', 'discovery', 'distilled row', '2026-09-01', 0, 'h-distilled', 'brain-distiller:test')`).run());
  // The operator hand-edited one row, and moved another session to a project of their own.
  rw(I.store, (db) => {
    db.prepare(`UPDATE observations SET metadata = '{"edited_at":1}' WHERE memory_session_id = 'cursor:g-edited'`).run();
    db.prepare(`UPDATE sdk_sessions SET project = 'mine' WHERE memory_session_id = 'cursor:g-manual'`).run();
    db.prepare(`UPDATE observations SET project = 'mine' WHERE memory_session_id = 'cursor:g-manual'`).run();
  });
  writeWorkspace(IU, WS.alpha, { json: { folder: 'file:///Users/x/code/orchard' }, composerData: { allComposers: ['g-move', 'g-edited', 'g-manual'].map((composerId) => ({ composerId })) } });
  const before = snapshot(IU);
  const rowsBefore = allRows(I.store);
  const r = runIngest(I.home).cursor;
  eq(r.sessions, 0, 'no new sessions'); eq(r.observations, 0, 'no new observations');
  eq(r.reattributed, undefined, 'ingest no longer reports relabelling');
  eq(r.unfiled, 2, 'g-move + g-edited sessions are on offer');
  eq(allRows(I.store), rowsBefore, 'every existing session/observation row is byte-identical');
  eq(sessProject(I.store, 'g-move'), 'cursor', 'g-move session still the placeholder');
  eq(q(I.store, `SELECT COUNT(*) AS n FROM observations WHERE memory_session_id LIKE 'cursor:%'`)[0].n, 5, 'nothing deleted or duplicated');
  const after = snapshot(IU);
  for (const k of Object.keys(before)) eq(after[k], before[k], `Cursor file unchanged: ${k}`);
});
await t('clean --cursor-projects: dry run reports the numbers and writes nothing', () => {
  const rowsBefore = allRows(I.store);
  const r = runClean(I.home, I.store);
  eq(r.applied, false, 'dry run'); eq(r.sessions, 2, 'sessions'); eq(r.observations, 2, 'observations (g-move raw + distilled; g-edited skipped)');
  eq(r.skipped.edited, 1, 'hand-edited observation counted as skipped');
  eq(r.byProject[0].project, 'orchard', 'by project');
  eq(allRows(I.store), rowsBefore, 'nothing written');
  eq(q(I.store, "SELECT COUNT(*) n FROM sqlite_master WHERE name = 'bulk_change_log'")[0].n, 0, 'no journal table created by a dry run');
});
let cursorBackup;
await t('clean --cursor-projects --apply: verified backup, moves the placeholder rows, journals the old project', () => {
  const r = runClean(I.home, I.store, '--apply');
  eq(r.applied, true, 'applied'); eq(r.changed.sessions, 2, 'sessions moved'); eq(r.changed.observations, 2, 'observations moved');
  assert(r.backupPath && existsSync(r.backupPath), 'backup exists');
  cursorBackup = r.backupPath;
  const bk = new DatabaseSync(r.backupPath, { readOnly: true });
  try {
    eq(bk.prepare('PRAGMA quick_check').get().quick_check, 'ok', 'backup integrity');
    eq(bk.prepare("SELECT project FROM sdk_sessions WHERE memory_session_id = 'cursor:g-move'").get().project, 'cursor', 'backup has the old project');
  } finally { bk.close(); }
  eq(sessProject(I.store, 'g-move'), 'orchard', 'g-move session');
  eq(JSON.stringify(obsProjects(I.store, 'g-move')), JSON.stringify(['orchard', 'orchard']), 'g-move raw + distilled rows');
  eq(sessProject(I.store, 'g-edited'), 'orchard', 'g-edited session');
  eq(JSON.stringify(obsProjects(I.store, 'g-edited')), JSON.stringify(['cursor']), 'hand-edited observation left alone');
  eq(sessProject(I.store, 'g-manual'), 'mine', 'operator-set project untouched');
  eq(JSON.stringify(obsProjects(I.store, 'g-manual')), JSON.stringify(['mine']), 'operator-set observation untouched');
  eq(sessProject(I.store, 'g-orphan'), 'cursor', 'unmapped session stays');
  const log = q(I.store, "SELECT target, old_values, new_values, undone_at FROM bulk_change_log WHERE kind = 'cursor-projects'");
  eq(log.length, 4, 'one journal entry per changed row');
  assert(log.every((l) => JSON.parse(l.old_values).project === 'cursor' && JSON.parse(l.new_values).project === 'orchard' && l.undone_at == null), 'old project recorded');
  eq(runClean(I.home, I.store).sessions, 0, 'a second dry run has nothing to do');
});
await t('clean --cursor-projects --undo: dry run counts, --apply puts the old project back exactly', () => {
  const dry = runClean(I.home, I.store, '--undo');
  eq(dry.applied, false, 'dry'); eq(dry.entries, 4, 'entries on offer'); eq(sessProject(I.store, 'g-move'), 'orchard', 'dry run changed nothing');
  // A session the operator re-filed by hand after the move is not put back over their choice.
  rw(I.store, (db) => db.prepare("UPDATE sdk_sessions SET project = 'chosen' WHERE memory_session_id = 'cursor:g-edited'").run());
  const r = runClean(I.home, I.store, '--undo', '--apply');
  eq(r.applied, true, 'applied'); eq(r.restored, 3, 'three restored'); eq(r.skippedChanged, 1, 'one changed since, left');
  assert(r.backupPath && existsSync(r.backupPath), 'undo made its own backup');
  eq(sessProject(I.store, 'g-move'), 'cursor', 'g-move session back');
  eq(JSON.stringify(obsProjects(I.store, 'g-move')), JSON.stringify(['cursor', 'cursor']), 'g-move rows back');
  eq(sessProject(I.store, 'g-edited'), 'chosen', 'hand-set project kept');
  eq(runClean(I.home, I.store, '--undo').entries, 0, 'journal fully consumed');
  // Redo, so the next tests start from the moved state.
  rw(I.store, (db) => db.prepare("UPDATE sdk_sessions SET project = 'cursor' WHERE memory_session_id = 'cursor:g-edited'").run());
  eq(runClean(I.home, I.store, '--apply').changed.sessions, 2, 'moved again');
});
await t('ingest: re-running is a no-op (idempotent)', () => {
  const r = runIngest(I.home).cursor;
  eq(r.sessions, 0, 'sessions'); eq(r.unfiled, 0, 'nothing left on offer');
  eq(sessProject(I.store, 'g-move'), 'orchard', 'still moved');
});
await t('ingest: a brand-new session is stored under its project from the start', () => {
  writeGlobal(IU, [{ id: 'g-new' }]);
  rw(join(IU, 'workspaceStorage', WS.alpha, 'state.vscdb'), (db) => db.prepare(`UPDATE ItemTable SET value = ? WHERE key = 'composer.composerData'`)
    .run(JSON.stringify({ allComposers: ['g-move', 'g-edited', 'g-manual', 'g-new'].map((composerId) => ({ composerId })) })));
  const r = runIngest(I.home).cursor;
  eq(r.sessions, 1, 'one new session'); eq(r.unfiled, 0, 'nothing to move');
  eq(sessProject(I.store, 'g-new'), 'orchard', 'g-new session');
  eq(JSON.stringify(obsProjects(I.store, 'g-new')), JSON.stringify(['orchard']), 'g-new observation');
});

// ── report ───────────────────────────────────────────────────────────────────
for (const [s, n, m] of results) console.log(`${s === 'PASS' ? '  ✓' : '  ✗'} ${n}${m ? '\n    ' + m.replace(/\n/g, '\n    ') : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
