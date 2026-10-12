#!/usr/bin/env node
// Cross-tool self-capture check: no distiller run from ANY provider is ever
// captured, while normal work sessions from every tool still are.
//
//   node evals/selfcapture-crosstool-test.mjs
//
// The distiller (distiller.mjs) shells out to `claude -p`, `codex exec` or
// `agy --print`, and each of those writes a session file that ingest
// (parseClaude / parseCodex / parseAntigravity) reads. This
// test runs the REAL runProvider() for all three providers against stub CLIs
// that behave like the real ones: they take the prompt the way that CLI takes
// it (stdin / argv), then record the session in that tool's own on-disk format
// under the $HOME they were given, from the cwd they were started in. So the
// distiller fixtures are exactly what runProvider makes each CLI record — the
// first user message is buildPrompt()'s output, the cwd is whatever
// runProvider chose. Normal sessions come from the same stubs started by "the
// user" in a project dir. Then the real ingest() runs over that $HOME.
//
// Two distiller runs per provider:
//   • current — runProvider's own cwd (the self-run dir);
//   • legacy  — cwd = $HOME, as every run was before the self-run dir existed
//     (and as ensureSelfRunDir() falls back to) — only the prompt signal can
//     catch these, so each parser must surface the distiller prompt as the
//     session's first prompt, not whatever context the CLI injected before it.
//
// SAFETY: $HOME, the store and every CLI are synthetic, under the scratchpad
// (or $TMPDIR). The ingest child asserts its resolved store lives under the
// fake $HOME before writing. No real CLI is ever spawned (per-provider
// BRAIN_DISTILL_*_BIN overrides point at the stubs; a missing stub is a hard miss).
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PROVIDERS, SOURCE_PROVIDER, FALLBACK_CHAIN, buildPrompt, runProvider, resetBinaryCache } from '../bin/lib/distiller.mjs';
import { selfRunDir, isSelfRunCwd, isSelfPrompt } from '../bin/lib/selfcapture.mjs';
import { openStore } from '../bin/lib/store.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `selfcapture-crosstool-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const HOME = join(ROOT, 'home');
mkdirSync(HOME, { recursive: true });

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

// provider id (distiller) ↔ ingest tool id (platform_source)
const TOOLS = { claude: 'claude', codex: 'codex', agy: 'antigravity' };

// ── The stub CLIs ─────────────────────────────────────────────────────────────
// One body, three entry points. Each stub checks it was invoked the way the real
// CLI is (so argument drift in PROVIDERS fails here), reads the prompt from
// where that CLI reads it, logs {cwd, marker} to $STUB_PROBE, writes the
// session file, and answers on stdout like a headless run does.
const STUB_BODY = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const home = process.env.HOME, cwd = process.cwd();
const argv = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
const uuid = () => crypto.randomUUID();
const now = new Date(Date.parse(process.env.STUB_TIME || '2026-09-29T10:00:00.000Z'));
const iso = now.toISOString();
const reply = '{"type":"discovery","title":"stub"}';
function bad(msg) { process.stderr.write('stub ' + TOOL + ': ' + msg + '\n'); process.exit(2); }

let prompt;
if (TOOL === 'claude' || TOOL === 'agy') {
  if (!argv.includes(TOOL === 'claude' ? '-p' : '--print')) bad('not headless: ' + argv.join(' '));
  prompt = stdin;
} else if (TOOL === 'codex') {
  if (argv[0] !== 'exec' || argv[argv.length - 1] !== '-') bad('expected codex exec … -: ' + argv.join(' '));
  prompt = stdin;
}
if (!prompt) bad('empty prompt');
if (process.env.STUB_PROBE) {
  fs.appendFileSync(process.env.STUB_PROBE, JSON.stringify({ tool: TOOL, cwd: fs.realpathSync(cwd), marker: process.env.BRAIN_DISTILLER || null, head: prompt.slice(0, 60) }) + '\n');
}
const w = (file, lines) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); };

if (TOOL === 'claude') {
  // ~/.claude/projects/<cwd with every non-alphanumeric char → '-'>/<uuid>.jsonl
  // Line shapes as a real 'claude -p' run records them (entrypoint sdk-cli).
  const sid = uuid(), slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const base = { isSidechain: false, userType: 'external', entrypoint: 'sdk-cli', cwd, sessionId: sid, version: '2.1.251', gitBranch: 'HEAD' };
  const a = uuid(), u = uuid(), r = uuid();
  w(path.join(home, '.claude', 'projects', slug, sid + '.jsonl'), [
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso, sessionId: sid, content: prompt },
    { type: 'queue-operation', operation: 'dequeue', timestamp: iso, sessionId: sid },
    { parentUuid: null, ...base, type: 'attachment', uuid: a, timestamp: iso, attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: '', stdout: '', stderr: '', exitCode: 0 } },
    { parentUuid: a, ...base, promptId: uuid(), type: 'user', message: { role: 'user', content: prompt }, uuid: u, timestamp: iso, permissionMode: 'default', promptSource: 'sdk' },
    { type: 'atis-latch', atis: '', sessionId: sid },
    { parentUuid: u, ...base, type: 'assistant', uuid: r, timestamp: iso, message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: reply }] } },
    { type: 'last-prompt', lastPrompt: prompt.slice(0, 200), leafUuid: r, sessionId: sid },
  ]);
} else if (TOOL === 'codex') {
  // ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl. Codex replays the
  // global ~/.codex/AGENTS.md (the brain writes its digest there) and the
  // environment context as user messages BEFORE the prompt. A real
  // 'codex exec --ephemeral' writes no rollout at all; the stub writes one
  // anyway — the worst case (an older codex, or a flag that stops being honoured).
  const sid = uuid(), p2 = (n) => String(n).padStart(2, '0');
  const d = [String(now.getUTCFullYear()), p2(now.getUTCMonth() + 1), p2(now.getUTCDate())];
  const file = path.join(home, '.codex', 'sessions', ...d, 'rollout-' + iso.slice(0, 19).replace(/:/g, '-') + '-' + sid + '.jsonl');
  const msg = (role, text) => ({ timestamp: iso, type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });
  const lines = [
    { timestamp: iso, type: 'session_meta', payload: { id: sid, timestamp: iso, cwd, originator: argv[0] === 'exec' ? 'codex_exec' : 'codex_cli_rs', cli_version: '0.63.0', source: 'exec', model_provider: 'openai' } },
    msg('developer', '<permissions instructions>\nFilesystem sandboxing: read-only.\n</permissions instructions>'),
  ];
  const agents = path.join(home, '.codex', 'AGENTS.md');
  // Both header forms seen in real rollouts: '… for <dir>' and the bare one.
  const head = process.env.STUB_AGENTS_BARE ? '# AGENTS.md instructions' : '# AGENTS.md instructions for ' + cwd;
  if (fs.existsSync(agents)) lines.push(msg('user', head + '\n\n<INSTRUCTIONS>\n' + fs.readFileSync(agents, 'utf8') + '\n</INSTRUCTIONS>'));
  lines.push(
    msg('user', '<environment_context>\n  <cwd>' + cwd + '</cwd>\n  <approval_policy>never</approval_policy>\n  <sandbox_mode>read-only</sandbox_mode>\n  <shell>zsh</shell>\n</environment_context>'),
    { timestamp: iso, type: 'turn_context', payload: { cwd, approval_policy: 'never', sandbox_policy: { mode: 'read-only' }, model: 'gpt-5-codex' } },
    msg('user', prompt),
    { timestamp: iso, type: 'event_msg', payload: { type: 'user_message', message: prompt } },
    msg('assistant', reply),
  );
  w(file, lines);
} else if (TOOL === 'agy') {
  // ~/.gemini/antigravity-cli/history.jsonl — one line per prompt.
  w(path.join(home, '.gemini', 'antigravity-cli', 'history.jsonl'), [
    { display: prompt, timestamp: String(now.getTime()), workspace: cwd, conversationId: uuid() },
  ]);
}
process.stdout.write(reply + '\n');
`;
const STUB = {};
for (const id of Object.keys(TOOLS)) {
  STUB[id] = join(ROOT, 'bin', `stub-${id}.cjs`);
  mkdirSync(dirname(STUB[id]), { recursive: true });
  writeFileSync(STUB[id], `#!${process.execPath}\nconst TOOL = ${JSON.stringify(id)};\n${STUB_BODY}`);
  chmodSync(STUB[id], 0o755);
}
const PROBE = join(ROOT, 'probe.jsonl');
const stubEnv = (extra = {}) => ({
  ...process.env, HOME: HOME, STUB_PROBE: PROBE,
  ...Object.fromEntries(Object.keys(TOOLS).map((id) => [PROVIDERS[id].envBin, STUB[id]])),
  ...extra,
});
delete process.env.BRAIN_DISTILLER; // the test process itself is not a self-run

// Detection markers so ingest links all three tools in the fake $HOME, and the
// brain's digest in ~/.codex/AGENTS.md exactly where inject.mjs puts it.
mkdirSync(join(HOME, '.claude', 'projects'), { recursive: true });
mkdirSync(join(HOME, '.codex', 'sessions'), { recursive: true });
writeFileSync(join(HOME, '.codex', 'AGENTS.md'),
  '<!-- BRAIN:START (auto-generated by claude-brain) -->\n# Operator brain — cross-project memory\n\n> 🧠 **Agentic Brain loaded** — 120 observations across 3 projects.\n<!-- BRAIN:END -->\n');
mkdirSync(join(HOME, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });

// ── 1. Distiller runs: the real runProvider() for every provider ─────────────
const SESSION = {
  memorySessionId: 'claude:real-session-for-distilling', project: 'webapp', platformSource: 'claude',
  title: 'fix the flaky retry test in the sync worker',
  prompts: ['fix the flaky retry test in the sync worker', 'now add a regression test'],
  transcript: 'user: fix the flaky retry test in the sync worker\n\nassistant: The retry loop reused a stale timer; fixed in sync/worker.ts.',
  filesModified: ['sync/worker.ts'],
};
const DISTILL = buildPrompt(SESSION);
const RUNS = []; // { id, kind, run }
await t('coverage: the stubbed providers are every provider the distiller can pick', () => {
  const all = new Set([...Object.keys(PROVIDERS), ...FALLBACK_CHAIN, ...Object.values(SOURCE_PROVIDER).filter(Boolean)]);
  eq([...all].sort().join(','), Object.keys(TOOLS).sort().join(','), 'provider set changed — add the new CLI to this test and to ingest');
});
await t('distiller prompt: buildPrompt() output is recognised as ours', () => {
  assert(isSelfPrompt(DISTILL), 'buildPrompt() no longer opens with a guarded prefix');
});
for (const id of Object.keys(TOOLS)) {
  for (const kind of ['current', 'legacy']) {
    await t(`runProvider(${id}, ${kind}): runs the stub CLI and it records a session`, async () => {
      resetBinaryCache();
      const opts = kind === 'current'
        ? { env: stubEnv({ STUB_TIME: '2026-09-29T12:00:00.000Z' }), timeoutMs: 15000 }
        : { env: stubEnv({ STUB_TIME: '2026-09-29T11:00:00.000Z', STUB_AGENTS_BARE: '1' }), timeoutMs: 15000 };
      if (kind === 'legacy') opts.cwd = HOME; // pre-self-run-dir behaviour / ensureSelfRunDir() fallback
      const run = await runProvider(id, DISTILL, opts);
      RUNS.push({ id, kind, run });
      assert(run.ok, `${id} run failed: ${run.error} ${run.stdout}`);
    });
  }
}

// ── 2. runProvider applies the marker for every provider ─────────────────────
const probes = existsSync(PROBE) ? readFileSync(PROBE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
for (const id of Object.keys(TOOLS)) {
  await t(`marker(${id}): self-run cwd + BRAIN_DISTILLER=1 + the distiller prompt reach the CLI`, () => {
    const mine = probes.filter((p) => p.tool === id);
    eq(mine.length, 2, 'stub invocations');
    for (const p of mine) {
      eq(p.marker, '1', 'BRAIN_DISTILLER in the CLI env');
      assert(isSelfPrompt(p.head), `prompt head reaching ${id}: ${p.head}`);
    }
    const cur = mine.find((p) => isSelfRunCwd(p.cwd));
    assert(cur, `no ${id} run started in the self-run dir (cwds: ${mine.map((p) => p.cwd).join(', ')})`);
    // realpath: the scratchpad may sit behind /tmp → /private/tmp.
    const want = spawnSync('realpath', [selfRunDir(HOME)], { encoding: 'utf8' }).stdout.trim() || selfRunDir(HOME);
    eq(cur.cwd, want, 'default cwd is the self-run dir under the HOME the CLI is given');
  });
}

// ── 3. Normal work sessions: the same CLIs, started by the user in a project ──
const USER = {
  claude: { dir: 'webapp', prompt: 'fix the flaky retry test in the sync worker' },
  codex: { dir: 'billing-api', prompt: 'add idempotency keys to the refund endpoint' },
  agy: { dir: 'ml-pipeline', prompt: 'speed up the feature extraction step' },
};
for (const [id, u] of Object.entries(USER)) {
  const cwd = join(HOME, 'code', u.dir);
  mkdirSync(cwd, { recursive: true });
  const args = { claude: ['-p'], codex: ['exec', '-'], agy: ['--print'] }[id];
  const env = stubEnv({ STUB_PROBE: '', STUB_TIME: '2026-09-29T09:00:00.000Z' });
  delete env.BRAIN_DISTILLER;
  const r = spawnSync(STUB[id], args, { cwd, env, input: u.prompt, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`user ${id} stub failed: ${r.stderr}`);
}

// ── 4. The real ingest() over that $HOME, in a child ─────────────────────────
const STORE = join(HOME, '.claude-brain', 'brain.db');
openStore({ path: STORE }).close();
writeFileSync(join(HOME, '.claude-brain', 'READY'), 'test\n');
const child = `
  const { MEMORY_DB } = await import(${JSON.stringify(join(REPO, 'bin/lib/paths.mjs'))});
  if (!MEMORY_DB.startsWith(${JSON.stringify(HOME)})) { console.log('UNSAFE ' + MEMORY_DB); process.exit(3); }
  const { ingest } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
  console.log(JSON.stringify(await ingest({ only: ${JSON.stringify(Object.values(TOOLS))} })));`;
const ing = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, HOME, BRAIN_DISTILLER: '' }, encoding: 'utf8' });
let RES = {};
await t('ingest(): child ran against the sandbox store', () => {
  assert(ing.status === 0, `child exited ${ing.status}: ${ing.stdout} ${ing.stderr}`);
  RES = JSON.parse(ing.stdout.trim().split('\n').pop());
});

const db = new DatabaseSync(STORE, { readOnly: true });
const sessionsOf = (tool) => db.prepare('SELECT content_session_id, project, user_prompt FROM sdk_sessions WHERE platform_source = ?').all(tool);
for (const [id, tool] of Object.entries(TOOLS)) {
  await t(`${tool}: 0 distiller runs captured, the normal session captured`, () => {
    const r = RES[tool];
    assert(r, `${tool} not ingested at all (linked tools: ${Object.keys(RES).join(', ')})`);
    const rows = sessionsOf(tool);
    const selfRows = rows.filter((s) => isSelfPrompt(s.user_prompt) || /^# AGENTS\.md|^<environment_context>/.test(s.user_prompt || ''));
    // parseClaude never even reads the self-run project dir (isSelfRunProjectDir),
    // so its current-cwd run is not "found"; every other parser reads all three.
    const selfSeen = tool === 'claude' ? 1 : 2;
    eq(r.found, 1 + selfSeen, 'sessions found on disk');
    eq(r.selfSkipped, selfSeen, 'distiller runs skipped');
    eq(rows.length, 1, 'session rows stored');
    eq(selfRows.length, 0, 'no distiller session row');
    eq(rows[0].project, USER[id].dir, 'normal session project');
    eq(rows[0].user_prompt, USER[id].prompt, 'normal session title is the user prompt, not injected context');
    const csid = rows[0].content_session_id;
    eq(db.prepare('SELECT COUNT(*) n FROM observations WHERE memory_session_id = ?').get(`${tool}:${csid}`).n, 1, 'normal session observation');
    eq(db.prepare('SELECT prompt_text p FROM user_prompts WHERE content_session_id = ? AND prompt_number = 0').get(csid)?.p, USER[id].prompt, 'first stored prompt');
  });
}
await t('store: no distiller prompt text anywhere (sessions, prompts, observations)', () => {
  const like = "'You are a memory distiller.%'";
  eq(db.prepare(`SELECT COUNT(*) n FROM sdk_sessions WHERE user_prompt LIKE ${like}`).get().n, 0, 'sdk_sessions');
  eq(db.prepare(`SELECT COUNT(*) n FROM user_prompts WHERE prompt_text LIKE ${like}`).get().n, 0, 'user_prompts');
  eq(db.prepare(`SELECT COUNT(*) n FROM observations WHERE title LIKE ${like} OR text LIKE '%You are a memory distiller.%'`).get().n, 0, 'observations');
  eq(db.prepare(`SELECT COUNT(*) n FROM observations WHERE text LIKE '%Operator brain — cross-project memory%'`).get().n, 0, "the brain's own digest (AGENTS.md) captured back");
});
db.close();

rmSync(ROOT, { recursive: true, force: true });
console.log(`\nselfcapture-crosstool-test: ${pass} passed, ${fail} failed\n`);
for (const [status, name, msg] of results) console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}${msg ? `\n      ${msg}` : ''}`);
if (fail > 0) process.exit(1);
