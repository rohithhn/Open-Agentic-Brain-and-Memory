#!/usr/bin/env node
// Tests for the self-capture guard (bin/lib/selfcapture.mjs) and every path it
// is wired into: ingest (parseClaude + the ingest() filter), the distiller's
// cwd and pending queue, the multi-machine merge filter, the MCP write guard,
// the SessionStart hooks, and `brain clean --self-capture` (clean.mjs).
//
//   node evals/selfcapture-test.mjs
//
// SAFETY: every DB and $HOME here is synthetic, under the scratchpad (or
// $TMPDIR). Child processes get HOME=<fake> and assert their resolved store
// lives under it before writing. Nothing opens ~/.claude-brain or ~/.claude*.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, chmodSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  isSelfPrompt, isSelfRunCwd, isSelfRunProjectDir, isSelfCaptureItem, selfRunDir, ensureSelfRunDir,
  notSelfPromptSql, dropSelfCaptureRows, SELF_PROMPT_PREFIXES, EXPLAIN_TASK_PREFIX,
} from '../bin/lib/selfcapture.mjs';
import { DISTILL_PROMPT, CRITIQUE_PROMPT } from '../bin/lib/distiller.mjs';
import { openStore } from '../bin/lib/store.mjs';
import { cleanSelfCapture, formatSelfCaptureReport, stripSelfCaptureCopy, stripCopy } from '../bin/lib/clean.mjs';
import { importClaudeMem } from '../bin/lib/import-claude-mem.mjs';
import { copyFileSync } from 'node:fs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `selfcapture-test-${process.pid}`);
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
const src = (rel) => readFileSync(join(REPO, rel), 'utf8');

const DISTILLER_OPENER = DISTILL_PROMPT.slice(0, 400);
const REAL_PROMPT = 'fix the flaky retry test in the sync worker';

// ── 1. prompt + cwd predicates ───────────────────────────────────────────────
await t('prompt: every internal prompt constant still starts with a guarded prefix (drift check)', () => {
  assert(isSelfPrompt(DISTILL_PROMPT), 'DISTILL_PROMPT no longer matches — the loop would reopen');
  assert(isSelfPrompt(CRITIQUE_PROMPT), 'CRITIQUE_PROMPT no longer matches');
  const distill = src('bin/lib/distill.mjs');
  for (const m of distill.matchAll(/return `(You are [^\n]*)/g)) assert(isSelfPrompt(m[1]), `distill.mjs prompt not guarded: ${m[1].slice(0, 60)}`);
  assert(/return `You are distilling/.test(distill), 'distill.mjs prompts not found');
  // Private-repo-only harness; a public clone does not ship it.
  if (existsSync(join(REPO, 'evals/distiller-parity.mjs'))) {
    const parity = src('evals/distiller-parity.mjs').match(/const RUBRIC = `([^\n]*)/);
    assert(parity && isSelfPrompt(parity[1]), 'distiller-parity RUBRIC not guarded');
  }
});
await t('prompt: explain goes through runAgent with selfRun and its prompt is recognised', () => {
  const server = src('ui/server.mjs');
  assert(server.includes(EXPLAIN_TASK_PREFIX), 'ui/server.mjs explain task text changed — update EXPLAIN_TASK_PREFIX');
  assert(/injectMemory: false, selfRun: true/.test(server), 'explainAI no longer passes selfRun: true');
  const sys = src('bin/lib/agent.mjs').match(/engineer: \{ name: 'Engineer', sys: '([^']+)'/)[1];
  assert(isSelfPrompt(`${sys}\n\n# Task\n${EXPLAIN_TASK_PREFIX} 2–4 short paragraphs.\n\nSUBJECT: x`), 'explain prompt not matched');
  assert(!isSelfPrompt(`${sys}\n\n# Task\nrefactor the auth module`), 'a real engineer-agent task must NOT match');
});
await t('prompt: real prompts, other apps\' prompts and mid-text mentions do not match', () => {
  assert(!isSelfPrompt(REAL_PROMPT), 'real prompt matched');
  assert(!isSelfPrompt('You are a content writer for a brand. Write a post.'), 'other app prompt matched');
  assert(!isSelfPrompt(`can you look at this prompt: ${DISTILLER_OPENER}`), 'mid-text mention matched');
  assert(!isSelfPrompt(''), 'empty'); assert(!isSelfPrompt(null), 'null');
  assert(isSelfPrompt(`\n  ${DISTILLER_OPENER}`), 'leading whitespace should still match');
  // Every opener is a specific full sentence start, never a short/generic word.
  for (const p of SELF_PROMPT_PREFIXES) assert(p.length >= 25 && /^[A-Z]/.test(p), `prefix shape: ${p}`);
});
await t('cwd: self-run dir matched by suffix on any home; project-dir slug matched', () => {
  assert(isSelfRunCwd('/Users/a/.claude-brain/self-runs'), 'exact');
  assert(isSelfRunCwd('/Users/old-home/.claude-brain/self-runs/x'), 'other home + subdir');
  assert(isSelfRunCwd(selfRunDir('/home/z')), 'selfRunDir()');
  assert(!isSelfRunCwd('/Users/a/.claude-brain'), 'parent');
  assert(!isSelfRunCwd('/Users/a/code/self-runs'), 'lookalike');
  assert(!isSelfRunCwd(undefined), 'undefined');
  assert(isSelfRunProjectDir('-Users-a--claude-brain-self-runs'), 'slug');
  assert(!isSelfRunProjectDir('-Users-a-Documents-Brain-claude-mem'), 'real slug');
  const d = ensureSelfRunDir(join(ROOT, 'h-ensure'));
  assert(existsSync(d) && statSync(d).isDirectory(), 'ensureSelfRunDir creates it');
});
await t('item: cwd, first prompt, or transcript opener marks an ingest item', () => {
  assert(isSelfCaptureItem({ cwd: '/Users/a/.claude-brain/self-runs', prompts: [REAL_PROMPT] }), 'cwd');
  assert(isSelfCaptureItem({ cwd: '/Users/a', prompts: [DISTILLER_OPENER] }), 'first prompt');
  assert(isSelfCaptureItem({ prompts: [], transcript: `user: ${DISTILLER_OPENER}` }), 'transcript opener');
  assert(!isSelfCaptureItem({ cwd: '/Users/a/p', prompts: [REAL_PROMPT, DISTILLER_OPENER], transcript: `user: ${REAL_PROMPT}` }), 'later prompt must not');
});
await t("prompt: claude-mem's observer agents — bannered, resumed, condenser, clipped", () => {
  const banner = '[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]';
  assert(isSelfPrompt(`${banner}\nYou are a Claude-Mem, a specialized observer tool for creating searchable memory`), 'bannered observer');
  assert(isSelfPrompt(`${banner}\nHello memory agent, you are continuing to observe the primary Claude session.`), 'bannered resume');
  assert(isSelfPrompt('Hello memory agent, you are continuing to observe the primary Claude session. <o…'), 'clipped resume');
  assert(isSelfPrompt('Condense the tool payload below to under 12800 characters.\n\nIt is going into an observation record'), 'condenser');
  // sdk_sessions.user_prompt is clipped to ~80 chars + '…'
  assert(isSelfPrompt(`${banner} You are a Claude-Mem, a speciali…`), 'bannered + clipped');
  assert(!isSelfPrompt('You are a…'), 'too-short clip must not match');
  assert(!isSelfPrompt(`${banner}\nfix the login bug`), 'banner alone is not enough');
  assert(!isSelfPrompt('please condense the tool payload below to under 100 chars'), 'lowercase/mid mention');
});
await t('sql: notSelfPromptSql excludes exactly the internal openers (quotes + LIKE wildcards escaped)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE s (id INTEGER, p TEXT)');
  const ins = db.prepare('INSERT INTO s VALUES (?,?)');
  ins.run(1, DISTILLER_OPENER); ins.run(2, REAL_PROMPT); ins.run(3, null);
  ins.run(4, "You are comparing two memory systems' distillations of the SAME session");
  ins.run(5, 'You are a memory distillerX not ours'); // '.' in the prefix is literal
  ins.run(6, '  ' + CRITIQUE_PROMPT.slice(0, 80));
  ins.run(7, '[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\nHello memory agent, you are continuing to observe the primary session');
  ins.run(8, '\n[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT] You are a Claude-Mem, a specialized observer tool');
  ins.run(9, '[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\nfix the login bug');
  const ids = db.prepare(`SELECT id FROM s WHERE ${notSelfPromptSql('p')} ORDER BY id`).all().map((r) => r.id);
  eq(ids.join(','), '2,3,5,9', 'kept ids');
  db.close();
});

// ── 2. parseClaude against a synthetic $HOME ─────────────────────────────────
const line = (o) => JSON.stringify(o);
function transcript(cwd, sid, firstPrompt) {
  return [
    line({ type: 'user', cwd, sessionId: sid, timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: firstPrompt } }),
    line({ type: 'assistant', cwd, sessionId: sid, timestamp: '2026-09-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok done' }] } }),
  ].join('\n') + '\n';
}
function buildClaudeHome(home) {
  const projects = join(home, '.claude', 'projects');
  const selfDir = join(projects, '-Users-x--claude-brain-self-runs');
  const homeDir = join(projects, '-Users-x');
  const realDir = join(projects, '-Users-x-code-app');
  for (const d of [selfDir, homeDir, realDir]) mkdirSync(d, { recursive: true });
  // New-style run: dedicated cwd, real-looking prompt — the cwd alone must catch it.
  writeFileSync(join(selfDir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'),
    transcript('/Users/x/.claude-brain/self-runs', 'aaaaaaaa-0000-4000-8000-000000000001', 'summarise this'));
  // Historical run: started in $HOME, caught by its first prompt.
  writeFileSync(join(homeDir, 'bbbbbbbb-0000-4000-8000-000000000002.jsonl'),
    transcript('/Users/x', 'bbbbbbbb-0000-4000-8000-000000000002', DISTILLER_OPENER));
  // A real session that DISCUSSES the distiller prompt later on — must be kept.
  writeFileSync(join(realDir, 'cccccccc-0000-4000-8000-000000000003.jsonl'),
    transcript('/Users/x/code/app', 'cccccccc-0000-4000-8000-000000000003', REAL_PROMPT) +
    line({ type: 'user', cwd: '/Users/x/code/app', message: { role: 'user', content: `why does this start with: ${DISTILLER_OPENER}` } }) + '\n');
}
await t('parseClaude: skips the self-run project dir before its window; carries cwd; marks $HOME runs', async () => {
  const home = join(ROOT, 'h-parse');
  buildClaudeHome(home);
  const prev = process.env.HOME;
  process.env.HOME = home;
  let items;
  try { items = (await import(`../bin/lib/ingest.mjs?case=parse`)).parseClaude(); }
  finally { process.env.HOME = prev; }
  const sids = items.map((i) => i.sid).sort();
  eq(sids.join(','), 'bbbbbbbb-0000-4000-8000-000000000002,cccccccc-0000-4000-8000-000000000003', 'self-run dir must not be read');
  const b = items.find((i) => i.sid.startsWith('bbbb'));
  const c = items.find((i) => i.sid.startsWith('cccc'));
  eq(c.cwd, '/Users/x/code/app', 'cwd carried on the item');
  assert(isSelfCaptureItem(b), 'historical $HOME distiller run must be flagged');
  assert(!isSelfCaptureItem(c), 'real session must not be flagged');
});

// ── 3. ingest() end to end, in a child with HOME=<fake> ──────────────────────
await t('ingest(): stores only the real session; reports selfSkipped', () => {
  const home = join(ROOT, 'h-ingest');
  buildClaudeHome(home);
  const store = join(home, '.claude-brain', 'brain.db');
  openStore({ path: store }).close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'test\n');
  const child = `
    const { MEMORY_DB } = await import(${JSON.stringify(join(REPO, 'bin/lib/paths.mjs'))});
    if (!MEMORY_DB.startsWith(${JSON.stringify(home)})) { console.log('UNSAFE ' + MEMORY_DB); process.exit(3); }
    const { ingest } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
    console.log(JSON.stringify(await ingest({ only: ['claude'] })));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert(r.status === 0, `child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  const res = JSON.parse(r.stdout.trim().split('\n').pop()).claude;
  eq(res.found, 2, 'found (self-run dir never read)');
  eq(res.selfSkipped, 1, 'selfSkipped');
  eq(res.sessions, 1, 'sessions inserted');
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    eq(db.prepare('SELECT COUNT(*) n FROM sdk_sessions').get().n, 1, 'one session row');
    eq(db.prepare("SELECT content_session_id c FROM sdk_sessions").get().c, 'cccccccc-0000-4000-8000-000000000003', 'the real one');
    eq(db.prepare("SELECT COUNT(*) n FROM user_prompts WHERE content_session_id LIKE 'bbbb%'").get().n, 0, 'no prompts from the distiller run');
  } finally { db.close(); }
});

// ── 4. distiller: dedicated cwd + marker env; pending queue skips old self rows ─
await t('runProvider: spawns the CLI in the self-run dir with BRAIN_DISTILLER=1', async () => {
  const home = join(ROOT, 'h-run');
  mkdirSync(home, { recursive: true });
  const stub = join(ROOT, 'stub-claude.sh');
  writeFileSync(stub, '#!/bin/sh\ncat >/dev/null\necho "cwd=$(pwd -P)"\necho "marker=$BRAIN_DISTILLER"\n');
  chmodSync(stub, 0o755);
  const prev = process.env.HOME;
  process.env.HOME = home;
  let run;
  try {
    const { runProvider } = await import('../bin/lib/distiller.mjs?case=run');
    run = await runProvider('claude', 'hello', { env: { ...process.env, HOME: home, BRAIN_DISTILL_CLAUDE_BIN: stub }, timeoutMs: 10000 });
  } finally { process.env.HOME = prev; }
  assert(run.ok, `stub failed: ${run.error}`);
  const { realpathSync } = await import('node:fs');
  assert(run.stdout.includes(`cwd=${realpathSync(join(home, '.claude-brain', 'self-runs'))}`), `wrong cwd: ${run.stdout}`);
  assert(run.stdout.includes('marker=1'), 'BRAIN_DISTILLER not set');
});
await t('pendingSessions: never queues a session whose first prompt is ours', async () => {
  const store = join(ROOT, 'pending.db');
  const db = openStore({ path: store });
  const sess = db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,?,'completed')`);
  const obs = db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch, content_hash, generated_by_model) VALUES (?,?,?,?,?,?,?,?,?)`);
  sess.run('real-1', 'claude:real-1', 'app', 'claude', REAL_PROMPT, '2026-09-01', 1);
  obs.run('claude:real-1', 'app', `user: ${REAL_PROMPT}`, 'session', REAL_PROMPT, '2026-09-01', 1, 'h1', 'claude');
  sess.run('self-1', 'claude:self-1', 'x', 'claude', DISTILLER_OPENER.slice(0, 200), '2026-09-01', 2);
  obs.run('claude:self-1', 'x', `user: ${DISTILLER_OPENER}`, 'session', DISTILLER_OPENER.slice(0, 80), '2026-09-01', 2, 'h2', 'claude');
  db.close();
  const { pendingSessions } = await import('../bin/lib/distiller.mjs');
  const ids = pendingSessions(store).map((s) => s.memorySessionId);
  eq(ids.join(','), 'claude:real-1', 'pending');
});

// ── 5. merge filter ──────────────────────────────────────────────────────────
await t('merge: dropSelfCaptureRows drops a self session and everything filed under it', () => {
  const r = dropSelfCaptureRows({
    sessions: [
      { content_session_id: 's1', memory_session_id: 'claude:s1', user_prompt: DISTILLER_OPENER },
      { content_session_id: 's2', memory_session_id: 'claude:s2', user_prompt: REAL_PROMPT },
      { content_session_id: 's3', memory_session_id: 'mem-s3', user_prompt: '' }, // claude-mem row, prompt only in user_prompts
    ],
    observations: [
      { memory_session_id: 'claude:s1', title: 'raw' }, { memory_session_id: 'claude:s1', title: 'Distilled row' },
      { memory_session_id: 'claude:s2', title: REAL_PROMPT, text: `user: ${REAL_PROMPT}\n\nuser: ${DISTILLER_OPENER}` },
      { memory_session_id: 'mem-s3', title: 'observer row' },
      { memory_session_id: 'orphan', title: DISTILLER_OPENER.slice(0, 80) },
    ],
    summaries: [{ memory_session_id: 'mem-s3' }, { memory_session_id: 'claude:s2' }],
    prompts: [
      { content_session_id: 's1', prompt_number: 0, prompt_text: DISTILLER_OPENER },
      { content_session_id: 's2', prompt_number: 0, prompt_text: REAL_PROMPT },
      { content_session_id: 's2', prompt_number: 1, prompt_text: DISTILLER_OPENER }, // later prompt: keep
      { content_session_id: 's3', prompt_number: 1, prompt_text: DISTILLER_OPENER },
    ],
  });
  eq(r.sessions.map((s) => s.content_session_id).join(','), 's2', 'sessions kept');
  eq(r.observations.length, 1, 'observations kept');
  eq(r.summaries.length, 1, 'summaries kept');
  eq(r.prompts.length, 2, 'prompts kept (both of s2)');
  eq(r.dropped, 2 + 4 + 1 + 2, 'dropped');
  assert(/dropSelfCaptureRows\(\{[\s\S]*sessions\.jsonl/.test(src('bin/lib/import.mjs')), 'runImport no longer filters exports');
});

// ── 6. MCP write guard + hooks ───────────────────────────────────────────────
await t('mcp: brain_remember is a no-op inside an internal run (BRAIN_DISTILLER=1)', async () => {
  const home = join(ROOT, 'h-mcp');
  mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [join(REPO, 'bin/mcp-server.mjs')], { env: { ...process.env, HOME: home, BRAIN_DISTILLER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  const got = new Promise((resolve) => {
    child.stdout.on('data', (d) => { out += d; if (out.includes('"id":2')) resolve(); });
    setTimeout(resolve, 8000);
  });
  const send = (o) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'brain_remember', arguments: { title: 'should not be saved anywhere', type: 'discovery', project: 'p' } } });
  await got;
  child.kill();
  const resp = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
  assert(resp && resp.result, `no tools/call result: ${out.slice(0, 300)}`);
  const body = JSON.parse(resp.result.content[0].text);
  eq(body.saved, false, 'saved');
  assert(/internal brain run/.test(body.reason), 'reason');
  assert(!existsSync(join(home, '.claude-brain', 'brain.db')), 'no store created');
});
await t('hooks: both SessionStart hooks exit 0 silently inside an internal run', () => {
  // A fake brain repo whose renderer / CLI only leave a trace, so the test can
  // tell "guard fired" from "nothing to run".
  const home = join(ROOT, 'h-hooks');
  const repo = join(ROOT, 'fake-repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'bin', 'lib'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const trace = join(ROOT, 'hook-trace');
  writeFileSync(join(repo, 'bin', 'lib', 'sessionstart.mjs'), 'console.log("RENDERED");\n');
  writeFileSync(join(repo, 'bin', 'brain.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(trace)}, 'pulled');\n`);
  const run = (h, extra) => spawnSync('bash', [join(REPO, 'hooks', h)], { env: { ...process.env, HOME: home, CLAUDE_BRAIN_DIR: repo, ...extra }, encoding: 'utf8' });
  // Control: without the marker the fake renderer does run.
  eq(run('session-start-context.sh', {}).stdout.trim(), 'RENDERED', 'control render');
  for (const h of ['session-start-context.sh', 'session-start-pull.sh']) {
    const r = run(h, { BRAIN_DISTILLER: '1' });
    eq(r.status, 0, `${h} exit`);
    eq(r.stdout, '', `${h} stdout`);
  }
  spawnSync('sleep', ['1.5']);
  assert(!existsSync(trace), 'pull hook ran brain merge inside an internal run');
});

// ── 7. brain clean --self-capture ────────────────────────────────────────────
function buildCleanStore(path) {
  const db = openStore({ path });
  const sess = db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,?,'completed')`);
  const obs = db.prepare(`INSERT INTO observations (memory_session_id, project, text, narrative, type, title, created_at, created_at_epoch, content_hash, generated_by_model) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const pr = db.prepare(`INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch) VALUES (?,?,?,?,?)`);
  const sum = db.prepare(`INSERT INTO session_summaries (memory_session_id, project, request, prompt_number, created_at, created_at_epoch) VALUES (?,?,?,?,?,?)`);
  const st = db.prepare(`INSERT INTO capture_state (transcript_path, status) VALUES (?,?)`);
  // Real work — all of it must survive.
  sess.run('real-1', 'claude:real-1', 'app', 'claude', REAL_PROMPT, 'd', 1);
  obs.run('claude:real-1', 'app', `user: ${REAL_PROMPT}\n\nuser: ${DISTILLER_OPENER}`, null, 'session', REAL_PROMPT, 'd', 1, 'r1', 'claude');
  obs.run('claude:real-1', 'app', null, 'Tuned the retry backoff', 'bugfix', 'Tuned retry backoff cap', 'd', 1, 'r2', 'brain/claude:haiku');
  pr.run('real-1', 0, REAL_PROMPT, 'd', 1);
  pr.run('real-1', 1, DISTILLER_OPENER, 'd', 2); // a later prompt quoting ours
  sum.run('claude:real-1', 'app', 'retry work', 1, 'd', 1);
  st.run('distill:claude:real-1', 'done');
  // Distiller run captured by ingest (historical, $HOME project) + its distilled echo.
  sess.run('self-1', 'claude:self-1', 'home-dir', 'claude', DISTILLER_OPENER.slice(0, 200), 'd', 2);
  obs.run('claude:self-1', 'home-dir', `user: ${DISTILLER_OPENER}`, `user: ${DISTILLER_OPENER}`, 'session', DISTILLER_OPENER.slice(0, 80), 'd', 2, 's1', 'claude');
  obs.run('claude:self-1', 'home-dir', null, 'An empty transcript was distilled', 'discovery', 'Empty session transcript provided to memory distiller', 'd', 2, 's2', 'brain/claude:haiku');
  pr.run('self-1', 0, DISTILLER_OPENER, 'd', 2);
  st.run('distill:claude:self-1', 'done');
  // claude-mem-captured learning-draft run: empty user_prompt, prompt only in user_prompts, has a summary.
  sess.run('self-2', 'mem-self-2', 'repo', 'claude', null, 'd', 3);
  obs.run('mem-self-2', 'repo', null, 'x', 'decision', 'Re-derived decision', 'd', 3, 's3', 'claude-haiku-4-5');
  pr.run('self-2', 1, 'You are distilling a reusable engineering DECISION into a durable note.', 'd', 3);
  sum.run('mem-self-2', 'repo', 'draft', 1, 'd', 3);
  // Orphan raw row with no session.
  obs.run('claude:gone', 'home-dir', `user: ${DISTILLER_OPENER}`, null, 'session', DISTILLER_OPENER.slice(0, 80), 'd', 4, 's4', 'claude');
  db.close();
}
const counts = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const n = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    return { obs: n('observations'), sess: n('sdk_sessions'), prompts: n('user_prompts'), sums: n('session_summaries'), state: n('capture_state') };
  } finally { db.close(); }
};
await t('clean: dry run reports by project and changes nothing', () => {
  const store = join(ROOT, 'clean-dry', 'brain.db');
  mkdirSync(dirname(store), { recursive: true });
  buildCleanStore(store);
  const before = counts(store);
  const r = cleanSelfCapture({ dbPath: store });
  eq(r.applied, false, 'applied');
  eq(JSON.stringify(r.totals), JSON.stringify({ observations: 4, sessions: 2, prompts: 2, summaries: 1, state: 1 }), 'totals');
  eq(r.byProject[0].project, 'home-dir', 'largest project first');
  eq(r.byProject[0].observations, 3, 'home-dir obs');
  assert(!r.byProject.some((p) => p.project === 'app'), 'real project must not appear');
  eq(JSON.stringify(counts(store)), JSON.stringify(before), 'dry run changed the DB');
  assert(!existsSync(join(dirname(store), 'backups')), 'dry run made a backup dir');
  assert(/dry run/.test(formatSelfCaptureReport(r)) && /--apply/.test(formatSelfCaptureReport(r)), 'report text');
});
await t('clean --apply: verified backup first, removes only self rows, FTS clean, idempotent', () => {
  const store = join(ROOT, 'clean-apply', 'brain.db');
  mkdirSync(dirname(store), { recursive: true });
  buildCleanStore(store);
  const before = counts(store);
  const r = cleanSelfCapture({ dbPath: store, apply: true });
  eq(r.applied, true, 'applied');
  assert(r.backupPath && existsSync(r.backupPath), 'backup file');
  eq(JSON.stringify(counts(r.backupPath)), JSON.stringify(before), 'backup holds the pre-clean store');
  eq(JSON.stringify(counts(store)), JSON.stringify({ obs: 2, sess: 1, prompts: 2, sums: 1, state: 1 }), 'after');
  eq(r.remaining, 0, 'remaining');
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    eq(db.prepare("SELECT COUNT(*) n FROM observations_fts WHERE observations_fts MATCH 'Empty'").get().n, 0, 'deleted text still searchable');
    eq(db.prepare("SELECT COUNT(*) n FROM observations_fts WHERE observations_fts MATCH 'backoff'").get().n, 1, 'real text lost from FTS');
    eq(db.prepare("SELECT transcript_path p FROM capture_state").get().p, 'distill:claude:real-1', 'state kept for real session');
  } finally { db.close(); }
  const again = cleanSelfCapture({ dbPath: store, apply: true });
  eq(again.backupPath, null, 'second apply makes no backup');
  eq(Object.values(again.totals).reduce((a, b) => a + b, 0), 0, 'nothing left to clean');
  eq(readdirSync(join(dirname(store), 'backups')).length, 1, 'one backup only');
});
await t('cli: `brain clean` needs --self-capture; dry run via --db prints the report', () => {
  const home = join(ROOT, 'h-cli');
  mkdirSync(home, { recursive: true });
  const store = join(ROOT, 'clean-cli', 'brain.db');
  mkdirSync(dirname(store), { recursive: true });
  buildCleanStore(store);
  const env = { ...process.env, HOME: home };
  const bare = spawnSync(process.execPath, [join(REPO, 'bin/brain.mjs'), 'clean'], { env, encoding: 'utf8' });
  eq(bare.status, 1, 'bare clean exit');
  const r = spawnSync(process.execPath, [join(REPO, 'bin/brain.mjs'), 'clean', '--self-capture', '--db', store], { env, encoding: 'utf8' });
  eq(r.status, 0, `exit (${r.stderr})`);
  assert(/Would remove \(dry run\)/.test(r.stdout) && /home-dir/.test(r.stdout), `output: ${r.stdout}`);
  eq(counts(store).obs, 6, 'CLI dry run changed nothing');
  const j = spawnSync(process.execPath, [join(REPO, 'bin/brain.mjs'), 'clean', '--self-capture', '--json', '--db', store], { env, encoding: 'utf8' });
  eq(JSON.parse(j.stdout).totals.observations, 4, 'json totals');
});

// ── 8. cleaned rows stay gone: every path sync copies rows through ───────────
// The reviewer's repro: `clean --apply`, then the next sync pulls claude-mem.db
// and merges the (pre-clean) cloud blob — both through importClaudeMem.
await t('import: sync pull / cloud merge never bring cleaned self rows back; real rows still copy', () => {
  const dir = join(ROOT, 'reimport');
  mkdirSync(dir, { recursive: true });
  const local = join(dir, 'local.db'), cloud = join(dir, 'cloud.db');
  buildCleanStore(local);
  // A new real session that only the cloud copy has.
  const c = openStore({ path: cloud }); c.close();
  copyFileSync(local, cloud);
  const cdb = new DatabaseSync(cloud);
  cdb.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status) VALUES ('real-2','claude:real-2','app','claude','add a cache','d',9,'completed')`).run();
  cdb.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch, content_hash) VALUES ('claude:real-2','app','user: add a cache','session','add a cache','d',9,'r9')`).run();
  cdb.close();
  const cleaned = cleanSelfCapture({ dbPath: local, apply: true, backupDir: join(dir, 'bk') });
  eq(cleaned.remaining, 0, 'clean');
  const dry = importClaudeMem({ source: cloud, dest: local });
  eq(dry.tables.find((t) => t.table === 'observations').selfCaptureSkipped, 4, 'dry run reports what it would leave out');
  const m = importClaudeMem({ source: cloud, dest: local, apply: true, resume: false, verify: true, touchReady: false });
  eq(m.selfCaptureSkipped, 4 + 2 + 2 + 1, 'rows left out');
  assert(m.verification && m.verification.ok, `verification must still pass: ${JSON.stringify(m.verification?.checks.filter((x) => !x.ok))}`);
  const back = cleanSelfCapture({ dbPath: local }).totals;
  eq(back.observations + back.sessions + back.prompts + back.summaries, 0, 'self rows came back');
  const db = new DatabaseSync(local, { readOnly: true });
  try { eq(db.prepare("SELECT COUNT(*) n FROM sdk_sessions WHERE content_session_id='real-2'").get().n, 1, 'real cloud session imported'); }
  finally { db.close(); }
  // The opt-out copies everything (byte-faithful path for tests / forensics).
  const raw = importClaudeMem({ source: cloud, dest: join(dir, 'raw.db'), apply: true, verify: false, touchReady: false, skipSelfCapture: false });
  eq(raw.selfCaptureSkipped, 0, 'opt-out');
  // The whole-file restore path (no local store yet) strips the extracted copy.
  const fresh = join(dir, 'fresh.db');
  copyFileSync(cloud, fresh);
  eq(stripSelfCaptureCopy(fresh), 4 + 2 + 2 + 1 + 1, 'strip removed self rows incl. distill state');
  eq(counts(fresh).sess, 2, 'real sessions kept');
  // bundle.mjs uses stripCopy (self-capture + test data; see testdata-test.mjs).
  assert(/stripCopy\(db\)[\s\S]*copyFileSync\(db, MEMORY_DB\)/.test(src('bin/lib/bundle.mjs')), 'cloud first-pull no longer strips');
  assert(/stripCopy\(join\(out, 'claude-mem.db'\)\)/.test(src('bin/lib/bundle.mjs')), 'restore no longer strips');
  eq(stripCopy(cloud).selfCapture, 4 + 2 + 2 + 1 + 1, 'stripCopy covers the self-capture strip');
});
await t('ingest window: 500 newer self runs outside the self-run dir do not crowd out a real session', async () => {
  const home = join(ROOT, 'h-window');
  const projects = join(home, '.claude', 'projects', '-Users-x');
  mkdirSync(projects, { recursive: true });
  const real = join(projects, 'dddddddd-0000-4000-8000-000000000004.jsonl');
  writeFileSync(real, transcript('/Users/x/code/app', 'dddddddd-0000-4000-8000-000000000004', REAL_PROMPT));
  const { utimesSync } = await import('node:fs');
  utimesSync(real, new Date('2026-01-01'), new Date('2026-01-01')); // oldest
  for (let i = 0; i < 500; i++) {
    const sid = `eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}`;
    writeFileSync(join(projects, `${sid}.jsonl`), transcript('/Users/x', sid, DISTILLER_OPENER));
  }
  const prev = process.env.HOME;
  process.env.HOME = home;
  let items;
  try { items = (await import(`../bin/lib/ingest.mjs?case=window`)).parseClaude(); }
  finally { process.env.HOME = prev; }
  assert(items.some((i) => i.sid.startsWith('dddd')), 'real session pushed out of the newest-500 window');
  eq(items.filter((i) => !isSelfCaptureItem(i)).length, 1, 'one real item');
});
await t('codex: agent runs pass --skip-git-repo-check (self-runs cwd is not a git repo)', async () => {
  const { CLIS } = await import('../bin/lib/agent.mjs');
  const args = CLIS.codex.args('hi');
  eq(args[0], 'exec', 'subcommand');
  assert(args.includes('--skip-git-repo-check'), `codex args: ${args.join(' ')}`);
  eq(args[args.length - 1], 'hi', 'prompt last');
});

rmSync(ROOT, { recursive: true, force: true });
console.log(`\nselfcapture-test: ${pass} passed, ${fail} failed\n`);
for (const [status, name, msg] of results) console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}${msg ? `\n      ${msg}` : ''}`);
if (fail > 0) process.exit(1);
