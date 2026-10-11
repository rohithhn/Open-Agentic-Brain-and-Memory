#!/usr/bin/env node
// firstrun.mjs: what a fresh install reports (sessions found per tool, memories
// built, time left, claude-mem waiting) and that it never writes anything.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../bin/lib/store.mjs';
import { firstRunStatus, formatFirstRun, formatEta, DISTILL_CALLS_PER_HOUR } from '../bin/lib/firstrun.mjs';

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const dir = mkdtempSync(join(tmpdir(), 'firstrun-test-'));
try {
  const dbPath = join(dir, 'brain.db');
  const db = openStore({ path: dbPath });
  const ins = db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,?)`);
  const rows = [['claude', 5], ['claude_code', 1], ['codex', 2], ['cursor', 3], ['claude_desktop_agent', 4], ['mcp_local_agent_mode_x', 2]];
  let n = 0;
  for (const [p, k] of rows) for (let i = 0; i < k; i++) ins.run(`c-${n}`, `m-${n++}`, 'proj', p, '2026-01-01T00:00:00Z', 1, 'completed');
  db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch, content_hash) VALUES ('m-0','proj','discovery','t','n','2026-01-01',1,'h1')`).run();
  db.close();
  const cmDb = join(dir, 'claude-mem.db');
  const cm = new DatabaseSync(cmDb); cm.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY)'); for (let i = 0; i < 7; i++) cm.exec('INSERT INTO observations DEFAULT VALUES'); cm.close();
  const plan = { calls: 96, freshSessions: 10, waitingForIdle: 1, byPlatform: { claude: 60, codex: 36 } };

  await t('counts captured sessions per tool, merging Claude Code profiles; MCP saves and chat apps are not back-fill', async () => {
    const s = await firstRunStatus({ dbPath, claudeMemDb: cmDb, plan });
    eq(s.sessions.total, 11, 'total');
    eq(s.sessions.byTool, { 'Claude Code': 6, Codex: 2, Cursor: 3 }, 'by tool');
    eq(s.memories, 1, 'memories');
  });
  await t('time left comes from the distiller plan at 48 calls/hour', async () => {
    const s = await firstRunStatus({ dbPath, claudeMemDb: cmDb, plan });
    eq(DISTILL_CALLS_PER_HOUR, 48, 'rate');
    eq(s.etaHours, 2, '96 calls -> 2 h');
    eq(s.done, false, 'not done');
    eq((await firstRunStatus({ dbPath, claudeMemDb: cmDb, plan: { ...plan, calls: 0, byPlatform: {} } })).done, true, 'done at 0');
  });
  await t('claude-mem: counted and reported as waiting until an import of that exact file is recorded', async () => {
    let s = await firstRunStatus({ dbPath, claudeMemDb: cmDb, plan });
    eq(s.claudeMem, { observations: 7, imported: false }, 'waiting');
    assert(/claude-mem found with 7 memories/.test(formatFirstRun(s)), 'summary offers the import');
    const w = new DatabaseSync(dbPath);
    w.exec('CREATE TABLE IF NOT EXISTS import_state (source_path TEXT PRIMARY KEY, last_epoch INTEGER, last_run_at TEXT, counts_json TEXT)');
    w.prepare('INSERT INTO import_state (source_path) VALUES (?)').run(cmDb); w.close();
    s = await firstRunStatus({ dbPath, claudeMemDb: cmDb, plan });
    eq(s.claudeMem.imported, true, 'imported');
    assert(!/claude-mem found/.test(formatFirstRun(s)), 'no offer once imported');
  });
  await t('summary reads like the install message', async () => {
    const s = await firstRunStatus({ dbPath, claudeMemDb: join(dir, 'none.db'), plan });
    const txt = formatFirstRun(s);
    assert(txt.includes('Found 11 past sessions across Claude Code, Cursor and Codex.'), txt);
    assert(txt.includes('about 2 hours'), txt);
    assert(txt.includes('http://127.0.0.1:37800'), txt);
    eq(s.claudeMem, null, 'no claude-mem');
  });
  await t('empty machine: says so instead of implying something is broken', async () => {
    const e = join(dir, 'empty.db'); openStore({ path: e }).close();
    const s = await firstRunStatus({ dbPath: e, claudeMemDb: join(dir, 'none.db'), plan: { calls: 0, byPlatform: {} } });
    assert(/No past AI sessions found/.test(formatFirstRun(s)), formatFirstRun(s));
  });
  await t('a little pending work is minutes away, never "done"', async () => {
    const s = await firstRunStatus({ dbPath, claudeMemDb: cmDb, plan: { calls: 2, byPlatform: { kilo: 2 } } });
    eq(s.etaHours, 0.1, '2 calls'); eq(s.done, false, 'not done');
    assert(formatFirstRun(s).includes('(about 5 minutes)'), formatFirstRun(s));
  });
  await t('start fresh: reported as a choice, with the way back', async () => {
    const e = join(dir, 'fresh.db'); openStore({ path: e }).close();
    const cf = join(dir, 'past-sessions.json');
    writeFileSync(cf, JSON.stringify({ mode: 'fresh', since: '2026-10-10T00:00:00.000Z' }));
    const s = await firstRunStatus({ dbPath: e, claudeMemDb: join(dir, 'none.db'), plan: { calls: 0, byPlatform: {} }, pastChoiceFile: cf });
    eq(s.pastSessions, 'fresh', 'mode'); eq(s.freshSince, '2026-10-10T00:00:00.000Z', 'since');
    const txt = formatFirstRun(s);
    assert(/Starting fresh/.test(txt) && /brain past-sessions on/.test(txt), txt);
    eq((await firstRunStatus({ dbPath: e, claudeMemDb: join(dir, 'none.db'), plan: { calls: 0, byPlatform: {} }, pastChoiceFile: join(dir, 'unset.json') })).pastSessions, 'all', 'default is all');
  });
  await t('time-left wording', async () => {
    eq(formatEta(0), 'done', '0'); eq(formatEta(0.1), 'about 5 minutes', 'mins'); eq(formatEta(5.6), 'about 6 hours', 'hours'); eq(formatEta(50), 'about 2 days', 'days');
  });
  await t('read-only: the store and claude-mem are byte-identical afterwards', async () => {
    const a = sha(dbPath), b = sha(cmDb);
    await firstRunStatus({ dbPath, claudeMemDb: cmDb });
    eq(sha(dbPath), a, 'store'); eq(sha(cmDb), b, 'claude-mem');
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
