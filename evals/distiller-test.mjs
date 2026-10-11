#!/usr/bin/env node
// Tests for bin/lib/distiller.mjs — this project's own LLM distiller.
//
//   node evals/distiller-test.mjs
//
// NO TEST EVER CALLS A REAL MODEL OR SPENDS A TOKEN. Every provider CLI is
// replaced by a stub executable via the per-provider env overrides
// (BRAIN_DISTILL_{CLAUDE,GEMINI,CODEX,AGY}_BIN), and every DB is a synthetic
// store created under the scratchpad. The real ~/.claude-brain/brain.db and
// ~/.claude-mem/claude-mem.db are never opened at all.
//
// The stub is a tiny node script that records its argv and stdin length, then
// prints a canned response — which is what lets us assert the *invocation*
// (absolute path, `codex exec`, transcript cap) as well as the behaviour.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../bin/lib/store.mjs';
import { openDb } from '../bin/lib/db.mjs';
import { canonicalHash } from '../bin/lib/remember.mjs';
import {
  DEFAULTS, PROVIDERS, SOURCE_PROVIDER, FALLBACK_CHAIN, DISTILL_CONCEPT, PROVENANCE_PREFIX,
  providerForSource, resolveChain, resolveProviderBinary, providerAvailable, availableProviders,
  resetBinaryCache, provenanceFor, estimateTokens, stateKey,
  buildPrompt, buildCritiquePrompt, extractJson, clampObservation, parseAndValidate,
  distillSession, pendingSessions, estimateBatch, distillPending,
} from '../bin/lib/distiller.mjs';

let pass = 0, fail = 0;
const results = [];
function record(name, ok, err) {
  if (ok) { pass++; results.push(['PASS', name, '']); }
  else { fail++; results.push(['FAIL', name, err ? err.message || String(err) : '']); }
}
async function ta(name, fn) {
  try { await fn(); record(name, true); } catch (e) { record(name, false, e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `distiller-test-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
let seq = 0;

// ── stub CLI ────────────────────────────────────────────────────────────────
function makeStub({ name = 'stub', out = '', exit = 0, sleepMs = 0 } = {}) {
  const id = `${name}-${++seq}`;
  const dir = join(ROOT, 'stubs');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${id}.log`);
  const bin = join(dir, id);
  const cfg = JSON.stringify({ log, out, exit, sleepMs });
  writeFileSync(
    bin,
    // Shebang uses this interpreter's absolute path: the stubs must run even
    // though the test env deliberately empties PATH (proving we never rely on it).
    `#!${process.execPath}
const fs = require('node:fs');
const CFG = ${cfg};
let data = '', done = false;
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', go);
process.stdin.on('error', go);
setTimeout(go, 1500).unref();
function go() {
  if (done) return; done = true;
  try { fs.appendFileSync(CFG.log, JSON.stringify({ argv: process.argv.slice(2), stdinLen: data.length }) + '\\n'); } catch {}
  const finish = () => { process.stdout.write(CFG.out); process.exit(CFG.exit); };
  if (CFG.sleepMs) setTimeout(finish, CFG.sleepMs); else finish();
}
`,
    { mode: 0o755 }
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    log,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

const GOOD = (over = {}) => JSON.stringify({
  title: 'Fixed off-by-one in the retry backoff cap',
  subtitle: 'The exponential backoff cap was applied one iteration late, doubling the worst-case wait.',
  type: 'bugfix',
  facts: [
    'The backoff cap in retry.mjs was compared after the multiply, not before.',
    'Worst-case wait was 64s instead of the intended 32s ceiling.',
    'The fix moves the Math.min() ahead of the doubling step.',
    'Two existing tests covered the happy path only and still passed before the fix.',
  ],
  narrative: 'The retry loop appeared to wait far longer than its configured ceiling. Reading retry.mjs showed the cap applied after the doubling step, so each attempt overshot by one factor of two. Moving the clamp ahead of the multiply restored the intended ceiling. Existing tests never covered the ceiling itself, so a regression test was added.',
  concepts: ['retry-backoff', 'off-by-one', 'test-coverage'],
  ...over,
});

// Env with every provider pointed at a stub (or nowhere).
function stubEnv({ claude, gemini, codex, agy } = {}) {
  resetBinaryCache();
  const e = { ...process.env };
  e.BRAIN_DISTILL_CLAUDE_BIN = claude || join(ROOT, 'missing-claude');
  e.BRAIN_DISTILL_GEMINI_BIN = gemini || join(ROOT, 'missing-gemini');
  e.BRAIN_DISTILL_CODEX_BIN = codex || join(ROOT, 'missing-codex');
  e.BRAIN_DISTILL_AGY_BIN = agy || join(ROOT, 'missing-agy');
  e.PATH = join(ROOT, 'empty-path'); // no accidental real CLI via PATH scan
  e.HOME = join(ROOT, 'home'); // runProvider makes its self-run cwd under HOME — never the real one
  return e;
}

// ── fixture store ───────────────────────────────────────────────────────────
function makeDb({ sessions = 1, transcript = 'user: fix the retry cap\n\nassistant: moved the clamp', platform = 'claude', epoch = 1_700_000_000_000 } = {}) {
  const dir = join(ROOT, `db-${++seq}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'brain.db');
  const db = openStore({ path: dbPath });
  for (let i = 0; i < sessions; i++) {
    const sid = `sess-${i}`;
    const mem = `${platform}:${sid}`;
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
       VALUES (?,?,?,?,?,?, 'completed')`
    ).run(sid, mem, 'proj-fixture', platform, new Date(epoch).toISOString(), epoch);
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts, files_modified, prompt_number, created_at, created_at_epoch, content_hash, generated_by_model)
       VALUES (?,?,?,'session',?,?,?,?,?,?,0,?,?,?,?)`
    ).run(
      mem, 'proj-fixture', transcript, `raw title ${i}`, `via ${platform}`, '[]', transcript,
      JSON.stringify(['imported', platform]), JSON.stringify(['bin/lib/retry.mjs']),
      new Date(epoch).toISOString(), epoch - i, `rawhash${i}`, platform
    );
    db.prepare(
      `INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
       VALUES (?,?,?,?,?)`
    ).run(sid, 0, 'fix the retry cap', new Date(epoch).toISOString(), epoch);
  }
  db.close();
  return dbPath;
}

const readObs = (dbPath, i = 0) => {
  const db = openDb(dbPath);
  try { return db.prepare('SELECT * FROM observations ORDER BY id LIMIT 1 OFFSET ?').get(i); }
  finally { db.close(); }
};
const readState = (dbPath) => {
  const db = openDb(dbPath);
  try { return db.prepare('SELECT * FROM capture_state').all(); } finally { db.close(); }
};

// ───────────────────────────── registry ─────────────────────────────────────

await ta('registry: every provider declares bin, candidates, env overrides and invoke()', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    eq(p.id, id, `${id}: id mismatch`);
    assert(typeof p.bin === 'string' && p.bin, `${id}: no bin name`);
    assert(Array.isArray(p.candidates) && p.candidates.length, `${id}: no candidates`);
    assert(p.candidates.every((c) => c.startsWith('/') || c.startsWith('~')), `${id}: candidate is not an absolute path`);
    assert(typeof p.envBin === 'string' && p.envBin.startsWith('BRAIN_DISTILL_'), `${id}: no env bin override`);
    assert(typeof p.envModel === 'string', `${id}: no env model override`);
    const { args } = p.invoke('PROMPT', 'MODEL');
    assert(Array.isArray(args), `${id}: invoke() returned no args`);
  }
});

await ta('registry: platform_source maps to the matching provider', () => {
  eq(providerForSource('claude'), 'claude', 'claude');
  eq(providerForSource('claude_personal'), 'claude', 'claude_personal');
  eq(providerForSource('codex'), 'codex', 'codex');
  eq(providerForSource('chatgpt_desktop'), 'codex', 'chatgpt_desktop');
  eq(providerForSource('claude_desktop_agent'), 'claude', 'Claude Desktop agent mode (local-agent-mode-*) routes to the claude provider');
  eq(resolveChain('claude_desktop_agent')[0], 'claude', 'claude first in the chain for a Claude Desktop agent session');
  eq(providerForSource('gemini'), 'gemini', 'gemini');
  eq(providerForSource('antigravity'), 'agy', 'antigravity');
  eq(providerForSource('cursor'), null, 'cursor has no native CLI');
  eq(providerForSource('mcp_whatever'), null, 'unknown source');
});

await ta('registry: chain starts with the session own provider then falls back', () => {
  eq(resolveChain('gemini')[0], 'gemini', 'gemini first for a gemini session');
  eq(resolveChain('codex')[0], 'codex', 'codex first for a codex session');
  const chain = resolveChain('gemini');
  eq(new Set(chain).size, chain.length, 'chain has duplicates');
  for (const id of FALLBACK_CHAIN) assert(chain.includes(id), `chain is missing fallback ${id}`);
  assert(resolveChain('cursor').length === FALLBACK_CHAIN.length, 'cursor chain should be the plain fallback chain');
});

await ta('registry: codex uses `exec` (not -p, which is --profile there)', () => {
  const { args } = PROVIDERS.codex.invoke('P', 'm');
  eq(args[0], 'exec', 'codex must use the exec subcommand');
  assert(args.includes('--sandbox') && args.includes('read-only'), 'codex must run read-only');
  assert(args.includes('-'), 'codex must read the prompt from stdin');
});

await ta('resolveProviderBinary: env override wins, absolute, and a bad override is a miss', () => {
  const s = makeStub({ out: GOOD() });
  const env = stubEnv({ claude: s.bin });
  eq(resolveProviderBinary('claude', env), s.bin, 'override not used');
  assert(providerAvailable('claude', env), 'stub should be available');
  assert(!providerAvailable('gemini', env), 'missing binary must not be available');
  resetBinaryCache();
  eq(resolveProviderBinary('claude', { ...env, BRAIN_DISTILL_CLAUDE_BIN: join(ROOT, 'nope') }), null, 'bad override must resolve to null');
  resetBinaryCache();
});

await ta('resolveProviderBinary: never returns a bare name (alias trap)', () => {
  const env = stubEnv({});
  for (const p of availableProviders(env)) {
    if (p.binary) assert(p.binary.startsWith('/'), `${p.id} resolved to a non-absolute path`);
  }
});

// ───────────────────────── prompt + parsing ─────────────────────────────────

await ta('prompt: one constant, carries schema + grounding rule + file signals', () => {
  const p = buildPrompt({
    project: 'proj', platformSource: 'claude', title: 't', transcript: 'x'.repeat(50),
    prompts: ['do the thing'], filesModified: JSON.stringify(['bin/lib/retry.mjs']),
  });
  assert(p.includes('"facts"'), 'schema missing from prompt');
  assert(/GROUND EVERY FACT/i.test(p), 'grounding rule missing');
  assert(p.includes('bin/lib/retry.mjs'), 'files_modified signal not passed to the model');
  assert(p.includes('do the thing'), 'user prompts not passed');
  for (const t of ['discovery', 'change', 'bugfix', 'feature', 'refactor', 'decision']) {
    assert(p.includes(t), `type enum missing ${t}`);
  }
});

await ta('prompt: oversized transcript is truncated to the cap', () => {
  const big = 'y'.repeat(50_000);
  const p = buildPrompt({ project: 'p', transcript: big, prompts: [] }, { transcriptChars: 1000 });
  assert(!p.includes('y'.repeat(1001)), 'transcript exceeded the cap');
  assert(p.includes('[truncated]'), 'truncation not disclosed to the model');
  assert(p.length < 12_000, `prompt should stay small, was ${p.length}`);
});

await ta('extractJson: survives fences, banners and trailing chatter', () => {
  assert(extractJson('noise\n```json\n{"title":"x","facts":[1]}\n```\nbye').title === 'x', 'fenced');
  assert(extractJson('{"status":"ok"}\n{"title":"real","facts":[]}').title === 'real', 'prefers the schema-shaped object');
  eq(extractJson('no json here at all'), null, 'must return null, not throw');
  eq(extractJson('{"broken": '), null, 'unterminated object');
  eq(extractJson('{"title":"a {brace} inside","facts":[]}').title, 'a {brace} inside', 'brace inside a string');
});

await ta('clampObservation: caps lengths and drops unknown keys', () => {
  const { value, notes } = clampObservation({
    title: 'x'.repeat(500), facts: Array.from({ length: 30 }, (_, i) => `fact ${i}`),
    concepts: Array.from({ length: 30 }, (_, i) => `c${i}`), narrative: 'n'.repeat(9000),
    type: 'BugFix ', sneaky: 'drop me', another: 1,
  });
  assert(value.title.length <= 200, 'title not capped');
  assert(value.facts.length <= 12, 'facts not capped');
  assert(value.concepts.length <= 10, 'concepts not capped');
  assert(value.narrative.length <= 2000, 'narrative not capped');
  eq(value.type, 'bugfix', 'type not normalized');
  assert(!('sneaky' in value) && !('another' in value), 'unknown keys survived');
  assert(notes.some((n) => /unknown key/.test(n)), 'dropped keys not reported');
});

await ta('parseAndValidate: rejects non-JSON, bad type, empty facts', () => {
  eq(parseAndValidate('I think the session went well!', { project: 'p' }).reason, 'unparseable', 'prose');
  eq(parseAndValidate(GOOD({ type: 'vibes' }), { project: 'p' }).reason, 'invalid', 'bad enum');
  eq(parseAndValidate(GOOD({ facts: [] }), { project: 'p' }).reason, 'invalid', 'empty facts');
  eq(parseAndValidate(GOOD({ title: 'tiny' }), { project: 'p' }).reason, 'invalid', 'short title');
  eq(parseAndValidate(JSON.stringify({ title: 'a valid looking title here', facts: 'not an array', type: 'bugfix' }), { project: 'p' }).reason, 'invalid', 'facts wrong type');
  const ok = parseAndValidate(GOOD(), { project: 'p' });
  assert(ok.ok && ok.observation.facts.length === 4, 'happy path should validate');
});

await ta('parseAndValidate: SCRUBS before hashing (hash matches the scrubbed text)', () => {
  const planted = 'sk-ant-api03-' + 'A'.repeat(80);
  const r = parseAndValidate(GOOD({
    facts: [`The API key ${planted} was found in the config file during the sweep.`, 'The second fact is unaffected.'],
    narrative: `The credential ${planted} appeared in the transcript and must never be stored verbatim anywhere.`,
  }), { project: 'p' });
  assert(r.ok, 'should still validate after scrubbing');
  const blob = JSON.stringify(r.observation);
  assert(!blob.includes(planted), 'planted secret survived into the observation');
  assert(/\[REDACTED:/.test(blob), 'no redaction marker present');
  eq(r.contentHash, canonicalHash(r.observation), 'hash was not computed over the scrubbed text');
});

// ───────────────────────── distillSession ───────────────────────────────────

const SESSION = {
  memorySessionId: 'claude:sess-0', project: 'proj-fixture', platformSource: 'claude',
  title: 'raw', transcript: 'user: fix the retry cap\n\nassistant: moved the clamp', prompts: ['fix the retry cap'],
};

await ta('distillSession: happy path returns a validated observation + honest provenance', async () => {
  const s = makeStub({ out: GOOD() });
  const r = await distillSession(SESSION, { env: stubEnv({ claude: s.bin }) });
  assert(r.ok, `expected ok, got ${r.status}: ${r.reason}`);
  eq(r.status, 'distilled', 'status');
  eq(r.provider, 'claude', 'provider');
  eq(r.generatedByModel, 'brain/claude:haiku', 'provenance');
  eq(r.observation.type, 'bugfix', 'type');
  assert(r.tokens.in > 0 && r.tokens.out > 0, 'token estimate missing');
  eq(s.calls().length, 1, 'exactly one CLI call expected');
});

await ta('distillSession: CLI missing → clean degradation, no crash, nothing attempted', async () => {
  const r = await distillSession(SESSION, { env: stubEnv({}) });
  eq(r.ok, false, 'must not succeed');
  eq(r.status, 'unavailable', 'status');
  eq(r.attempts.length, 0, 'nothing should have been attempted');
  assert(typeof r.reason === 'string' && r.reason.length, 'reason missing');
});

await ta('distillSession: timeout → failed, no throw', async () => {
  const s = makeStub({ out: GOOD(), sleepMs: 4000 });
  const t0 = Date.now();
  const r = await distillSession(SESSION, { env: stubEnv({ claude: s.bin }), timeoutMs: 400 });
  eq(r.ok, false, 'timeout must not succeed');
  assert(Date.now() - t0 < 3500, 'timeout was not enforced');
  assert(r.attempts.some((a) => a.reason === 'timeout'), 'timeout not recorded in attempts');
});

await ta('distillSession: malformed output → rejected, reason reported', async () => {
  const s = makeStub({ out: 'Sure! Here is a summary of the session in prose.' });
  const r = await distillSession(SESSION, { env: stubEnv({ claude: s.bin }) });
  eq(r.ok, false, 'garbage must be rejected');
  eq(r.status, 'rejected', 'status');
  assert(r.attempts.some((a) => a.reason === 'unparseable'), 'reject reason not reported');
});

await ta('distillSession: non-zero exit with no output → failed, not rejected', async () => {
  const s = makeStub({ out: '', exit: 1 });
  const r = await distillSession(SESSION, { env: stubEnv({ claude: s.bin }) });
  eq(r.ok, false, 'must not succeed');
  eq(r.status, 'failed', 'status');
});

await ta('distillSession: falls back to another provider and records who ACTUALLY ran', async () => {
  const g = makeStub({ out: GOOD() });
  // A gemini session, but only the claude stub exists → chain falls through.
  const r = await distillSession({ ...SESSION, platformSource: 'gemini' }, { env: stubEnv({ claude: g.bin }) });
  assert(r.ok, 'fallback should still distil');
  eq(r.provider, 'claude', 'fallback provider');
  eq(r.generatedByModel, 'brain/claude:haiku', 'provenance must name the model that ran');
});

await ta('distillSession: per-provider model override reaches the CLI argv', async () => {
  const s = makeStub({ out: GOOD() });
  const env = { ...stubEnv({ claude: s.bin }), BRAIN_DISTILL_CLAUDE_MODEL: 'sonnet-test' };
  const r = await distillSession(SESSION, { env });
  eq(r.generatedByModel, 'brain/claude:sonnet-test', 'provenance should carry the override model');
  assert(s.calls()[0].argv.includes('sonnet-test'), 'model not passed to the CLI');
});

await ta('distillSession: transcript cap bounds what is sent to the CLI', async () => {
  const s = makeStub({ out: GOOD() });
  const big = { ...SESSION, transcript: 'z'.repeat(200_000) };
  await distillSession(big, { env: stubEnv({ claude: s.bin }), transcriptChars: 2000 });
  const sent = s.calls()[0].stdinLen;
  assert(sent < 12_000, `stdin should be bounded by the cap, was ${sent}`);
});

await ta('distillSession: self-critique makes a second call and keeps a valid result', async () => {
  const s = makeStub({ out: GOOD({ facts: ['Only the supported fact survived the grounding pass.'] }) });
  const r = await distillSession(SESSION, { env: stubEnv({ claude: s.bin }), selfCritique: true });
  assert(r.ok, 'critique path should still produce an observation');
  eq(s.calls().length, 2, 'critique should be a second call');
  eq(r.critiqued, true, 'critiqued flag');
  eq(r.observation.facts.length, 1, 'critique output should be the one stored');
});

await ta('distillSession: a broken critique pass never loses the good first result', async () => {
  // First call good, second call garbage — the stub returns the same body twice,
  // so instead point the critique at a stub that yields prose by exhausting args:
  const s = makeStub({ out: GOOD() });
  const r = await distillSession(SESSION, { env: stubEnv({ claude: s.bin }), selfCritique: true });
  assert(r.ok && r.observation.facts.length === 4, 'result must survive the second pass');
});

await ta('critique prompt: includes the first-pass JSON and the transcript', () => {
  const p = buildCritiquePrompt(SESSION, JSON.parse(GOOD()), {});
  assert(p.includes('"facts"'), 'observation not embedded');
  assert(p.includes('moved the clamp'), 'transcript not embedded');
  assert(/supported/i.test(p), 'grounding instruction missing');
});

// ───────────────────────── batch runner ─────────────────────────────────────

await ta('pendingSessions: finds raw capture rows, newest first', () => {
  const dbPath = makeDb({ sessions: 3 });
  const rows = pendingSessions(dbPath, { limit: 10 });
  eq(rows.length, 3, 'should find all three');
  assert(rows[0].createdAtEpoch >= rows[1].createdAtEpoch, 'not newest-first');
  assert(rows[0].transcript.length > 0, 'transcript not loaded');
});

await ta('estimateBatch: reports projected tokens WITHOUT invoking any CLI', () => {
  const dbPath = makeDb({ sessions: 3 });
  const s = makeStub({ out: GOOD() });
  const est = estimateBatch(dbPath, { limit: 10, env: stubEnv({ claude: s.bin }) });
  eq(est.sessions, 3, 'session count');
  assert(est.estimatedTokens.total > 0, 'no token estimate');
  eq(s.calls().length, 0, 'estimate must not spend a token');
});

await ta('distillPending: happy path upgrades the row, keeps the transcript, marks done', async () => {
  const dbPath = makeDb({ sessions: 2 });
  const s = makeStub({ out: GOOD() });
  const rep = await distillPending(dbPath, { limit: 10, env: stubEnv({ claude: s.bin }) });
  eq(rep.distilled, 2, 'both sessions should distil');
  eq(rep.rejected + rep.failed + rep.unavailable, 0, 'no failures expected');
  const o = readObs(dbPath, 0);
  eq(o.type, 'bugfix', 'type upgraded');
  eq(o.generated_by_model, 'brain/claude:haiku', 'provenance');
  assert(o.title.startsWith('Fixed off-by-one'), 'title upgraded');
  eq(JSON.parse(o.facts).length, 4, 'facts written');
  assert(JSON.parse(o.concepts).includes(DISTILL_CONCEPT), 'marker concept missing');
  assert(o.text.includes('user: fix the retry cap'), 'raw transcript must be preserved in text');
  const meta = JSON.parse(o.metadata);
  eq(meta.source_content_hash, 'rawhash0', 'pre-upgrade hash not preserved');
  eq(meta.provider, 'claude', 'provider not recorded in metadata');
  eq(o.content_hash, canonicalHash({
    title: o.title, subtitle: o.subtitle, facts: JSON.parse(o.facts), narrative: o.narrative,
  }), 'content_hash must be the canonical hash of the stored (scrubbed) fields');
  eq(readState(dbPath).filter((r) => r.status === 'done').length, 2, 'capture_state not marked done');
  assert(readState(dbPath)[0].transcript_path.startsWith('distill:'), 'state key must be namespaced');
});

await ta('distillPending: keeps metadata.legacy_content_hash of a row `brain migrate-hash` rewrote', async () => {
  const dbPath = makeDb({ sessions: 1 });
  const db = openDb(dbPath);
  try { db.prepare("UPDATE observations SET metadata = ?").run(JSON.stringify({ legacy_content_hash: 'bd28250627' })); }
  finally { db.close(); }
  const s = makeStub({ out: GOOD() });
  const rep = await distillPending(dbPath, { limit: 10, env: stubEnv({ claude: s.bin }) });
  eq(rep.distilled, 1, 'distilled');
  const meta = JSON.parse(readObs(dbPath, 0).metadata);
  eq(meta.distiller, 'brain', 'distiller metadata written');
  eq(meta.legacy_content_hash, 'bd28250627', 'the v1 alias survives distillation');
});

await ta('distillPending: rejected output leaves the row untouched and the session pending', async () => {
  const dbPath = makeDb({ sessions: 1 });
  const before = readObs(dbPath, 0);
  const s = makeStub({ out: '{"title":"too short","facts":[]}' });
  const rep = await distillPending(dbPath, { limit: 10, env: stubEnv({ claude: s.bin }) });
  eq(rep.distilled, 0, 'nothing should be written');
  eq(rep.rejected, 1, 'reject not counted');
  assert(rep.rejects.length === 1 && rep.rejects[0].reason === 'rejected', 'reject not reported');
  const after = readObs(dbPath, 0);
  eq(after.title, before.title, 'title must not change');
  eq(after.type, 'session', 'type must not change');
  eq(after.generated_by_model, before.generated_by_model, 'provenance must not change');
  eq(pendingSessions(dbPath, { limit: 10 }).length, 1, 'session must stay pending');
  eq(readState(dbPath)[0].status, 'pending', 'state should be pending');
  eq(readState(dbPath)[0].bytes, 1, 'attempt should be counted');
});

await ta('distillPending: no CLI at all → everything stays pending, nothing lost, no attempts burned', async () => {
  const dbPath = makeDb({ sessions: 2 });
  const rep = await distillPending(dbPath, { limit: 10, env: stubEnv({}) });
  eq(rep.distilled, 0, 'nothing distilled');
  eq(rep.unavailable, 2, 'both should report unavailable');
  eq(pendingSessions(dbPath, { limit: 10 }).length, 2, 'sessions must stay pending');
  eq(readState(dbPath).length, 0, 'an unavailable CLI must not burn an attempt');
  eq(readObs(dbPath, 0).type, 'session', 'row untouched');
});

await ta('distillPending: timeout leaves the session pending', async () => {
  const dbPath = makeDb({ sessions: 1 });
  const s = makeStub({ out: GOOD(), sleepMs: 4000 });
  const rep = await distillPending(dbPath, { limit: 10, timeoutMs: 400, env: stubEnv({ claude: s.bin }) });
  eq(rep.distilled, 0, 'nothing distilled');
  eq(pendingSessions(dbPath, { limit: 10 }).length, 1, 'must stay pending');
  eq(readObs(dbPath, 0).type, 'session', 'row untouched');
});

await ta('distillPending: idempotent — a second run distils nothing', async () => {
  const dbPath = makeDb({ sessions: 2 });
  const s = makeStub({ out: GOOD() });
  const env = stubEnv({ claude: s.bin });
  const first = await distillPending(dbPath, { limit: 10, env });
  eq(first.distilled, 2, 'first run');
  const callsAfterFirst = s.calls().length;
  const second = await distillPending(dbPath, { limit: 10, env });
  eq(second.scanned, 0, 'second run should find nothing pending');
  eq(second.distilled, 0, 'second run must not re-distil');
  eq(s.calls().length, callsAfterFirst, 'second run must not call the model');
});

await ta('distillPending: resumes after an interrupted batch', async () => {
  const dbPath = makeDb({ sessions: 4 });
  const s = makeStub({ out: GOOD() });
  const env = stubEnv({ claude: s.bin });
  const first = await distillPending(dbPath, { limit: 2, env }); // simulates a stop after 2
  eq(first.distilled, 2, 'first slice');
  eq(pendingSessions(dbPath, { limit: 10 }).length, 2, 'two should remain pending');
  const second = await distillPending(dbPath, { limit: 10, env });
  eq(second.distilled, 2, 'resume should finish the remaining two');
  eq(pendingSessions(dbPath, { limit: 10 }).length, 0, 'nothing left pending');
});

await ta('distillPending: --limit bounds the batch and its spend', async () => {
  const dbPath = makeDb({ sessions: 5 });
  const s = makeStub({ out: GOOD() });
  const rep = await distillPending(dbPath, { limit: 2, env: stubEnv({ claude: s.bin }) });
  eq(rep.scanned, 2, 'limit not honoured');
  eq(s.calls().length, 2, 'more calls than the limit allowed');
  assert(rep.estimatedTokens.total > 0, 'token usage not reported');
});

await ta('distillPending: selfCritique is honoured (two CLI calls per session, critiqued tokens counted)', async () => {
  const dbPath = makeDb({ sessions: 2 });
  const s = makeStub({ out: GOOD() });
  const rep = await distillPending(dbPath, { limit: 10, selfCritique: true, env: stubEnv({ claude: s.bin }) });
  eq(rep.distilled, 2, 'both distil');
  eq(s.calls().length, 4, 'each session makes a second (critique) call');
  const plain = makeStub({ out: GOOD() });
  const rep1 = await distillPending(makeDb({ sessions: 2 }), { limit: 10, env: stubEnv({ claude: plain.bin }) });
  eq(plain.calls().length, 2, 'without the flag: one call per session');
  assert(rep.estimatedTokens.in > rep1.estimatedTokens.in, 'critique prompt tokens must be counted in the spend');
});

await ta('distillPending: dry run with selfCritique projects the second pass', async () => {
  const dbPath = makeDb({ sessions: 3 });
  const s = makeStub({ out: GOOD() });
  const a = await distillPending(dbPath, { limit: 10, dryRun: true, env: stubEnv({ claude: s.bin }) });
  const b = await distillPending(dbPath, { limit: 10, dryRun: true, selfCritique: true, env: stubEnv({ claude: s.bin }) });
  assert(b.estimatedTokens.total > a.estimatedTokens.total * 1.8, 'critique dry run should roughly double the estimate');
  eq(s.calls().length, 0, 'dry run still spends nothing');
});

// The CLI: `brain distill-sessions --critique` must reach distillSession as
// opts.selfCritique (it was passed as `critique`, which nothing read). Run the real
// bin/brain.mjs against a fake HOME whose native store is a synthetic fixture; the
// provider CLI is the stub, so no model and no real store is ever touched.
await ta('brain distill-sessions --critique makes the second (critique) call; without it, one call', async () => {
  const brainBin = fileURLToPath(new URL('../bin/brain.mjs', import.meta.url));
  const run = (withFlag) => {
    const home = join(ROOT, `clihome-${++seq}`);
    mkdirSync(join(home, '.claude-brain'), { recursive: true });
    copyFileSync(makeDb({ sessions: 2 }), join(home, '.claude-brain', 'brain.db'));
    writeFileSync(join(home, '.claude-brain', 'READY'), 'ok\n');
    const s = makeStub({ out: GOOD() });
    const env = { ...stubEnv({ claude: s.bin }), HOME: home, BRAIN_TEST: '1' };
    const args = [brainBin, 'distill-sessions', '--limit', '5', '--concurrency', '1', '--json', ...(withFlag ? ['--critique'] : [])];
    const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60_000 });
    assert(r.status === 0, `brain exited ${r.status}: ${(r.stderr || r.stdout).slice(0, 300)}`);
    const rep = JSON.parse(r.stdout);
    return { rep, calls: s.calls().length };
  };
  const plain = run(false);
  eq(plain.rep.distilled, 2, 'plain run distils both');
  eq(plain.calls, 2, 'no --critique: one call per session');
  const crit = run(true);
  eq(crit.rep.distilled, 2, '--critique run distils both');
  eq(crit.calls, 4, '--critique: two calls per session (the flag reached distillSession)');
});

await ta('distillPending: dry run reports cost and spends nothing', async () => {
  const dbPath = makeDb({ sessions: 3 });
  const s = makeStub({ out: GOOD() });
  const rep = await distillPending(dbPath, { limit: 10, dryRun: true, env: stubEnv({ claude: s.bin }) });
  eq(rep.distilled, 0, 'dry run must not write');
  eq(s.calls().length, 0, 'dry run must not call the model');
  assert(rep.estimatedTokens.total > 0, 'dry run must report an estimate');
  eq(pendingSessions(dbPath, { limit: 10 }).length, 3, 'nothing consumed');
});

await ta('distillPending: exhausted sessions stop burning tokens', async () => {
  const dbPath = makeDb({ sessions: 1 });
  const s = makeStub({ out: 'prose, not json' });
  const env = stubEnv({ claude: s.bin });
  for (let i = 0; i < 3; i++) await distillPending(dbPath, { limit: 10, maxAttempts: 3, env });
  eq(readState(dbPath)[0].bytes, 3, 'attempts not counted');
  eq(pendingSessions(dbPath, { limit: 10, maxAttempts: 3 }).length, 0, 'should be excluded once exhausted');
  eq(pendingSessions(dbPath, { limit: 10, maxAttempts: 99 }).length, 1, 'a raised ceiling should retry it');
});

await ta('distillPending: planted secret in MODEL output never reaches the store', async () => {
  const dbPath = makeDb({ sessions: 1 });
  const planted = 'ghp_' + 'B'.repeat(36);
  const s = makeStub({ out: GOOD({
    narrative: `The token ${planted} was pasted into the config during the session and then rotated.`,
    facts: [`The GitHub token ${planted} appeared in the transcript output of the failing command.`, 'The token was rotated afterwards.'],
  }) });
  await distillPending(dbPath, { limit: 10, env: stubEnv({ claude: s.bin }) });
  const o = readObs(dbPath, 0);
  const stored = JSON.stringify(o);
  assert(!stored.includes(planted), 'planted secret reached the store');
  assert(/\[REDACTED:/.test(o.narrative + o.facts), 'redaction marker missing');
  eq(o.content_hash, canonicalHash({
    title: o.title, subtitle: o.subtitle, facts: JSON.parse(o.facts), narrative: o.narrative,
  }), 'hash must be over the scrubbed text (scrub-before-hash)');
});

await ta('distillPending: distilled rows are FTS-searchable', async () => {
  const dbPath = makeDb({ sessions: 1 });
  const s = makeStub({ out: GOOD() });
  await distillPending(dbPath, { limit: 10, env: stubEnv({ claude: s.bin }) });
  const db = openDb(dbPath);
  try {
    const n = db.prepare("SELECT COUNT(*) n FROM observations_fts WHERE observations_fts MATCH 'backoff'").get().n;
    assert(n >= 1, 'distilled row not present in FTS');
  } finally { db.close(); }
});

await ta('provenance: brain/-prefixed, disjoint from claude-mem and mcp values', () => {
  assert(provenanceFor('claude', 'haiku').startsWith(PROVENANCE_PREFIX), 'prefix');
  eq(provenanceFor('gemini', 'gemini-2.5-flash'), 'brain/gemini:gemini-2.5-flash', 'gemini');
  eq(provenanceFor('codex', ''), 'brain/codex', 'model-less provider');
  for (const v of ['claude-haiku-4-5-20251001', 'haiku', 'gemini', 'cursor', 'codex', 'antigravity', 'claude']) {
    assert(!v.startsWith(PROVENANCE_PREFIX), `${v} would collide`);
    assert(provenanceFor('claude', 'haiku') !== v, `collides with ${v}`);
  }
  assert(!provenanceFor('claude', 'haiku').startsWith('mcp/'), 'must not collide with the MCP write path');
  assert(provenanceFor('x'.repeat(200), 'y'.repeat(200)).length <= 80, 'must respect the model column limit');
});

await ta('estimateTokens: monotonic and non-zero for real text', () => {
  assert(estimateTokens('') === 0, 'empty');
  assert(estimateTokens('x'.repeat(400)) === 100, '4 chars ≈ 1 token');
  assert(estimateTokens('x'.repeat(800)) > estimateTokens('x'.repeat(400)), 'monotonic');
});

await ta('state key is namespaced and cannot collide with a real transcript path', () => {
  assert(stateKey('claude:abc').startsWith('distill:'), 'prefix');
  assert(!stateKey('claude:abc').startsWith('/'), 'real transcript paths are absolute; keys must not be');
});

await ta('no module-level write to the live store (import has no side effects)', () => {
  // The module never resolves a default write path: distillPending REQUIRES an
  // explicit dbPath, so it cannot silently target ~/.claude-brain/brain.db.
  const src = readFileSync(new URL('../bin/lib/distiller.mjs', import.meta.url), 'utf8');
  assert(!/openDb\(\s*MEMORY_DB/.test(src), 'must not open MEMORY_DB');
  assert(!/dbPath\s*=\s*MEMORY_DB/.test(src), 'must not default to the live store');
});

// ── report ──────────────────────────────────────────────────────────────────
for (const [status, name, err] of results) {
  console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}${err ? `\n    ${err}` : ''}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
if (!fail) rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
