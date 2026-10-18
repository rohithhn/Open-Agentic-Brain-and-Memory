#!/usr/bin/env node
// Tests for bin/lib/recall.mjs — the read path (recallSearch/taskContext) for
// the Open Agentic Brain and Memory MCP server (docs/specs/mcp-memory-server.md §1.2/§1.3).
//
//   node evals/recall-test.mjs
//
// Everything runs against synthetic SQLite DBs built under the scratchpad via
// bin/lib/store.mjs's ensureSchema() (same schema the real brain.db uses,
// FTS5 + triggers included) — no real ~/.claude-brain/brain.db or
// ~/.claude-mem/claude-mem.db is ever opened for write, and per the task
// brief we only run read-only sanity checks against the real store, printing
// counts only, never content.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../bin/lib/store.mjs';
import { openDb } from '../bin/lib/db.mjs';
import { recallSearch, taskContext, isOverviewRequest, SNIPPET_MAX_CHARS, MAX_FACTS, FACT_MAX_CHARS, MAX_RESULT_LIMIT, DEFAULT_RESULT_LIMIT } from '../bin/lib/recall.mjs';
import { MEMORY_DB } from '../bin/lib/paths.mjs';
import { bm25Query } from '../bin/lib/agent.mjs';
import { ftsMatchExpr } from '../bin/lib/fts.mjs';
import { ftsMatchExpr as ftsFromRecall, MAX_TASK_CHARS } from '../bin/lib/recall.mjs';

// Real-store sanity checks below must never append to the real tokens-saved ledger.
process.env.BRAIN_NO_ECONOMICS = '1';

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
async function ta(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `recall-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
let seq = 0;

// ── fixture builder ──────────────────────────────────────────────────────
// Builds a synthetic native-schema DB (same shape as brain.db) at a fresh
// scratchpad path and inserts the given observation rows.
function buildDb(rows) {
  const dbPath = join(ROOT, `db-${++seq}.db`);
  const db = openStore({ path: dbPath }); // write-mode: creates + ensureSchema()
  const insSession = db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
     VALUES (?,?,?,?,?,?,'completed')`
  );
  const insObs = db.prepare(
    `INSERT INTO observations
     (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
      prompt_number, created_at, created_at_epoch, content_hash, generated_by_model, files_modified)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let n = 0;
  for (const r of rows) {
    const mem = `test:${dbPath}:${++n}`;
    insSession.run(mem, mem, r.project || 'general', r.platform || 'test', r.created_at || '2026-01-01T00:00:00Z', r.epoch ?? n);
    insObs.run(
      mem, r.project || 'general', r.text || '', r.type || 'discovery', r.title || `title ${n}`,
      r.subtitle || null, r.facts || '[]', r.narrative || '', r.concepts || '[]',
      0, r.created_at || '2026-01-01T00:00:00Z', r.epoch ?? n, r.content_hash || `hash-${n}`, 'test', r.files_modified ?? '[]'
    );
  }
  db.close();
  return dbPath;
}

function emptyDb() {
  const dbPath = join(ROOT, `empty-${++seq}.db`);
  const db = openStore({ path: dbPath });
  db.close();
  return dbPath;
}

// =====================================================================
// recallSearch()
// =====================================================================

await ta('a term present in exactly one row returns exactly that row', async () => {
  const dbPath = buildDb([
    { title: 'Fixed the flux capacitor race condition', narrative: 'flux capacitor race condition needed a mutex', project: 'proj-a' },
    { title: 'Unrelated widget refactor', narrative: 'renamed some widgets for clarity', project: 'proj-b' },
  ]);
  const { results: rows, count } = await recallSearch({ query: 'flux capacitor', dbPath });
  eq(count, 1, 'expected exactly one hit');
  eq(rows.length, 1, 'results array length');
  assert(rows[0].title.includes('flux capacitor'), 'wrong row returned');
  assert('project' in rows[0] && 'title' in rows[0] && 'type' in rows[0] && 'date' in rows[0] && 'snippet' in rows[0], 'row missing compact shape fields');
});

await ta('deep: without semantic search it says "unavailable" and returns the normal results unchanged', async () => {
  const dbPath = buildDb([
    { title: 'Quokka cache eviction fix', narrative: 'quokka cache eviction used the wrong clock', project: 'proj-a' },
    { title: 'Quokka note', narrative: 'another quokka note', project: 'proj-b' },
  ]);
  const plain = await recallSearch({ query: 'quokka', dbPath });
  const deep = await recallSearch({ query: 'quokka', dbPath, deep: true });
  eq(deep.deep, 'unavailable', 'deep status');
  eq(deep.results.map((r) => r.id).join(), plain.results.map((r) => r.id).join(), 'same ranking as plain');
  assert(!('deep' in plain), 'plain results carry no deep field');
});

await ta('provenance: each result says tool, day, project and primary file', async () => {
  const dbPath = buildDb([
    { title: 'Quokka cache eviction fix', narrative: 'quokka cache eviction used the wrong clock', project: 'proj-a',
      platform: 'codex', created_at: '2026-09-27T10:00:00Z', epoch: Date.UTC(2026, 8, 27, 10), files_modified: '["src/cache/evict.mjs","src/x.mjs"]' },
    { title: 'Quokka note without any file', narrative: 'quokka note from a claude session', project: 'proj-b',
      platform: 'claude_desktop', created_at: '2026-09-28T10:00:00Z', epoch: Date.UTC(2026, 8, 28, 10) },
  ]);
  const { results } = await recallSearch({ query: 'quokka', dbPath });
  const a = results.find((r) => r.project === 'proj-a');
  const b = results.find((r) => r.project === 'proj-b');
  eq(a.source, 'codex', 'source tool');
  eq(a.file, 'src/cache/evict.mjs', 'primary file');
  eq(a.provenance, 'codex · 2026-09-27 · proj-a · src/cache/evict.mjs', 'compact provenance line');
  eq(b.source, 'claude-desktop', 'platform names are display-mapped');
  eq(b.file, '', 'no file recorded -> empty, not a placeholder');
  eq(b.provenance, 'claude-desktop · 2026-09-28 · proj-b', 'unknown parts are dropped');
  assert(!('text' in a), 'still never returns raw text');
});

await ta('provenance: rows with no session row still come back (claude-mem-native uuid ids -> claude-code)', async () => {
  const dbPath = buildDb([{ title: 'Orphan wombat row', narrative: 'wombat detail', project: 'p' }]);
  const db = openDb(dbPath);
  db.exec("DELETE FROM sdk_sessions");
  db.exec("UPDATE observations SET memory_session_id='0b7e1c52-6a43-4f0e-9d11-000000000001'");
  db.close();
  const { results } = await recallSearch({ query: 'wombat', dbPath });
  eq(results.length, 1, 'LEFT JOIN must not drop rows lacking a session');
  eq(results[0].source, 'claude-code', 'bare uuid session id is a claude-mem (Claude Code) row');
});

await ta('punctuation/quotes/FTS operators in the query do not throw and do not inject', async () => {
  const dbPath = buildDb([
    { title: 'Normal safe row about widgets', narrative: 'nothing sensitive here', project: 'proj-a' },
  ]);
  const nasty = [
    'foo" OR "1"="1',
    'title:* NOT bar',
    '"unterminated quote',
    'a)(b OR c',
    '\'; DROP TABLE observations; --',
    '***^^^',
  ];
  for (const query of nasty) {
    const out = await recallSearch({ query, dbPath });
    assert(Array.isArray(out.results), `results not an array for query: ${query}`);
    assert(typeof out.count === 'number', `count not a number for query: ${query}`);
  }
  // Confirm the DB is still intact — an injected DROP TABLE would break this.
  const check = await recallSearch({ query: 'widgets', dbPath });
  eq(check.count, 1, 'DB was corrupted by a malicious-looking query');
});

await ta('empty query -> empty valid result, no throw', async () => {
  const dbPath = buildDb([{ title: 'Something', narrative: 'x', project: 'p' }]);
  const out = await recallSearch({ query: '', dbPath });
  eq(out.count, 0, 'empty query should yield zero results');
  assert(Array.isArray(out.results) && out.results.length === 0, 'results must be an empty array');
  assert(typeof out.reason === 'string' && out.reason.length > 0, 'expected a reason for the empty result');
});

await ta('missing query field -> empty valid result, no throw', async () => {
  const dbPath = buildDb([{ title: 'Something', narrative: 'x', project: 'p' }]);
  const out = await recallSearch({ dbPath });
  eq(out.count, 0, 'missing query should yield zero results');
});

await ta('missing DB -> valid empty result with a reason', async () => {
  const out = await recallSearch({ query: 'anything', dbPath: join(ROOT, 'does-not-exist.db') });
  eq(out.count, 0, 'missing DB should yield zero results');
  assert(typeof out.reason === 'string' && /not initialized|unavailable/.test(out.reason), `expected an init/unavailable reason, got: ${out.reason}`);
});

await ta('snippets are capped and never a whole transcript', async () => {
  const longNarrative = 'A'.repeat(5000) + ' needle';
  const dbPath = buildDb([{ title: 'Long observation about a needle', narrative: longNarrative, project: 'p' }]);
  const out = await recallSearch({ query: 'needle', dbPath });
  eq(out.count, 1, 'expected the long row to match');
  assert(out.results[0].snippet.length <= SNIPPET_MAX_CHARS + 1, `snippet exceeded cap: ${out.results[0].snippet.length} chars`);
  assert(!out.results[0].snippet.includes('needle') || out.results[0].snippet.length < longNarrative.length, 'snippet must be shorter than the source narrative');
});

await ta('facts come back with each result, so details past the snippet are reachable (capped)', async () => {
  // Real case: a 4-turn Kilo chat became one memory whose narrative opens on the first
  // decision; the deploy day and a price were only in the facts, and a tool asking
  // for them got the right memory but not the answer.
  const facts = ['Order queue uses SQLite.', 'Deploys go out on Tuesdays only, never Fridays.', 'Old Faithful costs 650 cents.',
    ...Array.from({ length: 20 }, (_, i) => `Filler fact ${i} ` + 'x'.repeat(600))];
  const dbPath = buildDb([{ title: 'Bakery decisions', narrative: 'The user asked about the order queue. ' + 'B'.repeat(400), facts: JSON.stringify(facts), project: 'p' }]);
  const out = await recallSearch({ query: 'Tuesdays deploys', dbPath });
  eq(out.count, 1, 'expected the row');
  const f = out.results[0].facts;
  assert(Array.isArray(f) && f.includes('Deploys go out on Tuesdays only, never Fridays.'), 'deploy fact missing');
  assert(f.length <= MAX_FACTS && f.every((x) => x.length <= FACT_MAX_CHARS + 1), 'facts not capped');
  const bad = buildDb([{ title: 'Bad facts row', narrative: 'badfacts here', facts: 'not json', project: 'p' }]);
  eq((await recallSearch({ query: 'badfacts', dbPath: bad })).results[0].facts.length, 0, 'malformed facts -> []');
});

await ta('result count is capped at MAX_RESULT_LIMIT even when a larger limit is requested', async () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ title: `Widget observation ${i}`, narrative: 'widget widget widget', project: 'p', epoch: i });
  const dbPath = buildDb(rows);
  const out = await recallSearch({ query: 'widget', dbPath, limit: 999 });
  assert(out.results.length <= MAX_RESULT_LIMIT, `expected <= ${MAX_RESULT_LIMIT} rows, got ${out.results.length}`);
});

await ta('default limit is DEFAULT_RESULT_LIMIT when none is given', async () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ title: `Gadget observation ${i}`, narrative: 'gadget gadget gadget', project: 'p', epoch: i });
  const dbPath = buildDb(rows);
  const out = await recallSearch({ query: 'gadget', dbPath });
  eq(out.results.length, DEFAULT_RESULT_LIMIT, 'default limit not applied');
});

await ta('project filter narrows to the named project only', async () => {
  const dbPath = buildDb([
    { title: 'Shared term alpha', narrative: 'sharedterm here', project: 'proj-a' },
    { title: 'Shared term beta', narrative: 'sharedterm here too', project: 'proj-b' },
  ]);
  const out = await recallSearch({ query: 'sharedterm', dbPath, project: 'proj-a' });
  eq(out.count, 1, 'project filter should narrow to one row');
  eq(out.results[0].project, 'proj-a', 'wrong project returned');
});

await ta('never returns the raw `text` column', async () => {
  const dbPath = buildDb([{ title: 'Row with a big transcript', narrative: 'shortnarrative', text: 'RAWTRANSCRIPT'.repeat(1000), project: 'p' }]);
  const out = await recallSearch({ query: 'shortnarrative', dbPath });
  eq(out.count, 1, 'expected a hit');
  assert(!('text' in out.results[0]), 'raw text column leaked into the result row');
  assert(!out.results[0].snippet.includes('RAWTRANSCRIPT'), 'raw transcript leaked into the snippet');
});

// =====================================================================
// taskContext()
// =====================================================================

await ta('taskContext: empty task -> empty valid result, no throw', async () => {
  const out = await taskContext({ task: '' });
  eq(out.block, '', 'expected empty block');
  eq(out.used, 0, 'expected zero used');
  assert(typeof out.reason === 'string' && out.reason.length > 0, 'expected a reason');
});

await ta('taskContext: missing DB path -> valid empty result with a reason, no throw', async () => {
  const out = await taskContext({ task: 'anything at all', dbPath: join(ROOT, 'nope.db') });
  eq(out.block, '', 'expected empty block for a missing DB');
  eq(out.used, 0, 'expected zero used for a missing DB');
  assert(typeof out.reason === 'string', 'expected a reason');
});

// taskContext() delegates to agent.mjs's retrieveContext(), which reads the
// MEMORY_DB constant captured at paths.mjs's *module load time* — it has no
// per-call path-override parameter (documented in recall.mjs). So exercising
// the real delegation against a synthetic, populated/empty DB — rather than
// just the pre-check above — requires a fresh process with HOME pointed at a
// throwaway home directory containing ~/.claude-brain/{brain.db,READY}; that
// makes paths.mjs's own resolution (not a fork of it) pick up the fixture.
function runTaskContextInSubprocess({ home, task }) {
  const script = `
    import { taskContext } from ${JSON.stringify(fileURLToPath(new URL('../bin/lib/recall.mjs', import.meta.url)))};
    const out = await taskContext({ task: ${JSON.stringify(task)} });
    process.stdout.write(JSON.stringify(out));
  `;
  const scriptPath = join(ROOT, `subtask-${++seq}.mjs`);
  writeFileSync(scriptPath, script);
  const out = execFileSync(process.execPath, [scriptPath], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

await ta('taskContext: sensible result on a populated fixture (real retrieveContext delegation)', async () => {
  const home = join(ROOT, `home-populated-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const brainDb = join(home, '.claude-brain', 'brain.db');
  const db = openStore({ path: brainDb });
  const mem = 'test:populated:1';
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,'completed')`)
    .run(mem, mem, 'proj-x', 'test', '2026-01-01T00:00:00Z', 1);
  db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts, prompt_number, created_at, created_at_epoch, content_hash, generated_by_model)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mem, 'proj-x', '', 'discovery', 'Ptarmigan migration timing bug', null, '[]', 'The ptarmigan migration scheduler had an off-by-one in its epoch math.', '[]', 0, '2026-01-01T00:00:00Z', 1, 'hash-populated-1', 'test');
  db.close();
  writeFileSync(join(home, '.claude-brain', 'READY'), `${new Date().toISOString()}\ntest fixture\n`);
  const out = runTaskContextInSubprocess({ home, task: 'ptarmigan migration scheduler epoch bug' });
  assert(typeof out.block === 'string', 'block must be a string');
  assert(typeof out.used === 'number', 'used must be a number');
  assert(Array.isArray(out.learningFiles), 'learningFiles must be an array');
  assert(out.used >= 1, `expected at least one item pulled in for a matching populated fixture, got used=${out.used}`);
  assert(out.block.toLowerCase().includes('ptarmigan'), 'expected the matching observation to surface in the block');
});

await ta('taskContext: observation lines carry [project · tool · day · file] provenance within budget', async () => {
  const home = join(ROOT, `home-prov-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const db = openStore({ path: join(home, '.claude-brain', 'brain.db') });
  const mem = 'gemini:prov:1';
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,'completed')`)
    .run(mem, mem, 'proj-y', 'gemini', '2026-09-27T00:00:00Z', 1);
  db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, facts, narrative, concepts, files_modified, prompt_number, created_at, created_at_epoch, content_hash, generated_by_model)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mem, 'proj-y', '', 'discovery', 'Axolotl scheduler drift', '[]', 'The axolotl scheduler drifted by one tick.', '[]', '["lib/tick.mjs"]', 0, '2026-09-27T12:00:00Z', Date.UTC(2026, 8, 27, 12), 'hash-prov-1', 'test');
  db.close();
  writeFileSync(join(home, '.claude-brain', 'READY'), `${new Date().toISOString()}\ntest fixture\n`);
  const out = runTaskContextInSubprocess({ home, task: 'axolotl scheduler drift tick' });
  assert(out.block.includes('- [gemini · 2026-09-27 · proj-y · lib/tick.mjs] Axolotl scheduler drift:'), `provenance tag missing in: ${out.block.slice(0, 300)}`);
  assert(out.block.length <= 8000, 'block must stay inside the 8000-char budget');
});

t('brain_context query builder is brain_recall\'s: bm25Query === ftsMatchExpr (quoted tokens OR\'d, 300-char cap)', () => {
  eq(ftsFromRecall, ftsMatchExpr, 'recall.mjs re-exports the one builder');
  const task = 'Remind me: the recipe we discussed, which oven temperature?';
  eq(bm25Query(task), ftsMatchExpr(task), 'same expression as brain_recall for a short task');
  eq(bm25Query(task), '"remind" OR "me" OR "the" OR "recipe" OR "we" OR "discussed" OR "which" OR "oven" OR "temperature"', 'every token, short words included');
  // Past the old six-word cutoff: the seventh+ long words are still in the query.
  assert(bm25Query('alpha bravo charlie delta echo foxtrot golf hotel').endsWith('"golf" OR "hotel"'), 'words past the sixth are kept');
  // The 300-char cap: tokens that start after MAX_TASK_CHARS are dropped.
  eq(MAX_TASK_CHARS, 300, 'cap is the spec 1.3 task cap');
  const long = `${'a'.repeat(299)} tailtoken`;
  eq(bm25Query(long), `"${'a'.repeat(299)}"`, 'input beyond 300 chars is not searched');
  // Hostile input: FTS operators are only ever quoted tokens; nothing to match -> empty.
  eq(bm25Query('"""((( NEAR/2 -* ^'), '"near" OR "2"', 'operators are quoted, not interpreted');
  eq(bm25Query('"""((('), '', 'punctuation only -> empty query');
  eq(bm25Query(''), '', 'empty');
  eq(bm25Query(undefined), '', 'undefined');
});

await ta('taskContext: a term past the first six long words still finds its row (was invisible to brain_context)', async () => {
  const home = join(ROOT, `home-deep-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const db = openStore({ path: join(home, '.claude-brain', 'brain.db') });
  const mem = 'test:deep:1';
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,'completed')`)
    .run(mem, mem, 'proj-z', 'test', '2026-01-01T00:00:00Z', 1);
  db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, facts, narrative, concepts, prompt_number, created_at, created_at_epoch, content_hash, generated_by_model)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mem, 'proj-z', '', 'discovery', 'Quokka habitat survey', '[]', 'The quokka habitat survey counted nests along the northern shore.', '[]', 0, '2026-01-01T00:00:00Z', 1, 'hash-deep-1', 'test');
  db.close();
  writeFileSync(join(home, '.claude-brain', 'READY'), `${new Date().toISOString()}\ntest fixture\n`);
  // The old builder kept only: could, remind, about, thing, where, discussed — never "quokka".
  const out = runTaskContextInSubprocess({ home, task: 'Could you remind me about the thing where we discussed the quokka habitat' });
  assert(out.block.toLowerCase().includes('quokka'), `the quokka row must surface; block: ${out.block.slice(0, 300)}`);
});

await ta('taskContext: empty-but-valid result on an empty fixture', async () => {
  const home = join(ROOT, `home-empty-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const brainDb = join(home, '.claude-brain', 'brain.db');
  openStore({ path: brainDb }).close(); // schema only, zero rows
  writeFileSync(join(home, '.claude-brain', 'READY'), `${new Date().toISOString()}\ntest fixture\n`);
  const out = runTaskContextInSubprocess({ home, task: 'xyzzy_nonexistent_gribbleflotz_query_9182' });
  assert(typeof out.block === 'string', 'block must be a string');
  assert(typeof out.used === 'number', 'used must be a number');
  assert(Array.isArray(out.learningFiles), 'learningFiles must be an array');
  // Not necessarily zero (learnings/workflows/wiki are read from the real repo,
  // not from `home`) but must not throw and must be a well-formed result.
});

await ta('taskContext: never throws on a task that is only FTS-hostile punctuation', async () => {
  const dbPath = buildDb([{ title: 'x', narrative: 'y', project: 'p' }]);
  const out = await taskContext({ task: '"""(((', dbPath });
  assert(typeof out.block === 'string', 'block must be a string even for a hostile task string');
});

// =====================================================================
// Read-only sanity check against the REAL store (counts only, never content —
// per the task brief). This is best-effort: skipped cleanly if the real
// store isn't present/ready on this machine.
// =====================================================================
await ta('sanity: recallSearch against the real MEMORY_DB does not throw (counts only)', async () => {
  if (!existsSync(MEMORY_DB)) {
    console.log('  (skipped — MEMORY_DB not present on this machine)');
    return;
  }
  const out = await recallSearch({ query: 'observation memory brain', limit: 5 });
  assert(Array.isArray(out.results), 'results must be an array');
  console.log(`  real-store recallSearch: count=${out.count} reason=${out.reason || '(none)'}`);
});

await ta('sanity: taskContext against the real MEMORY_DB does not throw (counts only)', async () => {
  if (!existsSync(MEMORY_DB)) {
    console.log('  (skipped — MEMORY_DB not present on this machine)');
    return;
  }
  const out = await taskContext({ task: 'read path for the mcp memory server' });
  assert(typeof out.block === 'string', 'block must be a string');
  console.log(`  real-store taskContext: used=${out.used} learningFiles=${out.learningFiles.length} blockChars=${out.block.length}`);
});

t('"load all my memory"-style asks get the overview; everything else stays a search', () => {
  const cases = {
    'load all my memory': true, 'load everything': true, 'give me an overview of all my projects': true,
    'whole brain': true, '': true, 'show me all my memories': true,
    'how did we fix the sync bug': false, 'all tests failing in agentic-brain': false,
    'what did I decide about pricing': false, 'all context for the checkout flow': false,
    'brain_context for all endpoints': false,
  };
  for (const [q, want] of Object.entries(cases)) {
    assert(isOverviewRequest(q) === want, `${JSON.stringify(q)} → expected ${want ? 'overview' : 'search'}`);
  }
});

// ── report ──────────────────────────────────────────────────────────────
console.log(`\nrecall-test: ${pass} passed, ${fail} failed\n`);
for (const [status, name, msg] of results) {
  console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}${msg ? `\n      ${msg}` : ''}`);
}
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
if (fail > 0) process.exit(1);
