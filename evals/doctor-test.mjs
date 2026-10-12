#!/usr/bin/env node
// Tests for bin/lib/doctor.mjs — `brain doctor`, the read-only wiring
// diagnostic (docs/specs/auto-wiring.md §6, task T5).
//
// Doctor must NEVER write to a tool config, ~/.agentic-brain/, or run any
// repair action. These tests exercise the degrade-gracefully paths (registry
// missing, tool not installed, config malformed) with fabricated fixtures in
// the scratch dir, plus the spawn probe's timeout/kill path against a
// deliberately-hanging fake bridge — never a real tool config. Running
// runDoctor() read-only against the real machine at the end is expected and
// encouraged (the task spec says so); it only reads.
//
//   node evals/doctor-test.mjs
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  runDoctor,
  loadRegistry,
  toolRows,
  checkPull,
  checkPush,
  checkCapture,
  claudeMemRow,
  bridgeHomeSection,
  spawnProbe,
  serverProbe,
  distillerRows,
  shimHealthFor,
  configRunsFile,
} from '../bin/lib/doctor.mjs';
import { bridgePath, serverPath, BRIDGE_FILENAME, SERVER_FILENAME } from '../bin/lib/bridgehome.mjs';
import { healthSignals, captureSourceKey } from '../bin/lib/home.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'doctor-test-'));

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try {
    await fn();
    pass++; results.push(['PASS', name, '']);
  } catch (e) {
    fail++; results.push(['FAIL', name, e.stack || e.message]);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

let n = 0;
function scratchDir() {
  const d = join(ROOT, `case-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
}

// ==========================================================================
// 1. Registry missing / throwing → doctor degrades gracefully
// ==========================================================================

await t('distiller: job missing → FAIL naming the backlog and the install command', async () => {
  const [r] = distillerRows({ status: { installed: false, loaded: false }, providers: ['claude'], pending: 641 });
  eq(r.level, 'FAIL', 'level'); assert(/641 waiting/.test(r.detail), 'backlog shown'); assert(/distill-sessions --install/.test(r.fix), 'fix names the command');
});
await t('distiller: no AI CLI at all → FAIL telling the user what to install', async () => {
  const [r] = distillerRows({ status: { installed: true, loaded: true }, providers: [], pending: 3 });
  eq(r.level, 'FAIL', 'level'); assert(/no AI CLI/.test(r.detail), 'detail');
});
await t('distiller: installed + loaded + small backlog → PASS; big backlog → WARN with a drain hint', async () => {
  eq(distillerRows({ status: { installed: true, loaded: true }, providers: ['claude', 'codex'], pending: 4 })[0].level, 'PASS', 'pass');
  const [w] = distillerRows({ status: { installed: true, loaded: true }, providers: ['claude'], pending: 500 });
  eq(w.level, 'WARN', 'warn'); assert(/brain distill-sessions/.test(w.fix), 'drain hint');
});
await t('distiller: installed but not loaded → WARN', async () => {
  eq(distillerRows({ status: { installed: true, loaded: false }, providers: ['claude'], pending: 0 })[0].level, 'WARN', 'warn');
});

await t('onboard installs the distiller, and ingest self-heals a missing one (regression: a machine ran a week with no new memories)', async () => {
  const src = readFileSync(new URL('../bin/brain.mjs', import.meta.url), 'utf8');
  const onboard = src.slice(src.indexOf("case 'onboard'"), src.indexOf("launchd installs (watchers, daily sync, control panel) — skipped, --dry-run"));
  assert(/installDistill\(\{ log \}\)/.test(onboard), 'onboard must install the distill timer');
  const ingest = src.slice(src.indexOf("case 'ingest'"), src.indexOf("case 'ingest'") + 2500);
  assert(/distillStatus\(\)\.installed/.test(ingest) && /installDistill/.test(ingest), 'ingest must re-install a missing distiller');
});

await t('loadRegistry: import throws → ok:false, error captured, does not throw', async () => {
  const r = await loadRegistry(() => { throw new Error('module not found (simulated)'); });
  eq(r.ok, false, 'should report unavailable');
  eq(r.TARGETS.length, 0, 'no targets');
  assert(/simulated/.test(r.error), 'error message lost');
});

await t('loadRegistry: import rejects (async throw) → same graceful shape', async () => {
  const r = await loadRegistry(() => Promise.reject(new Error('boom')));
  eq(r.ok, false, 'should report unavailable');
  assert(/boom/.test(r.error), 'error message lost');
});

await t('loadRegistry: malformed module (no TARGETS export) → empty array, not a crash', async () => {
  const r = await loadRegistry(() => Promise.resolve({}));
  eq(r.ok, true, 'import itself succeeded');
  eq(r.TARGETS.length, 0, 'TARGETS should default to empty array');
});

await t('runDoctor: registry unavailable end-to-end still produces a full report (json)', async () => {
  const { exitCode, result } = await runDoctor({
    json: true,
    silent: true,
    timeoutMs: 500,
    importRegistry: () => { throw new Error('registry gone'); },
  });
  eq(result.registry.ok, false, 'registry section should say unavailable');
  eq(result.tools.length, 0, 'no tool rows when registry is unavailable');
  // Brain health + bridge home sections must still be fully populated.
  assert(result.brainHealth.rows.length > 0, 'brain health section missing');
  assert(result.bridgeHome.rows.length > 0, 'bridge home section missing');
  assert(typeof exitCode === 'number', 'exitCode must be a number even when registry is down');
});

// ==========================================================================
// 2. Tool not installed → reported as skipped, never a failure
// ==========================================================================

await t('toolRows: config dir absent → installed:false, level SKIP (not FAIL)', async () => {
  const dir = scratchDir();
  const missing = join(dir, 'does-not-exist', 'cfg.json');
  const registry = { ok: true, TARGETS: [
    { id: 'nope', name: 'Not Installed Tool', format: 'json', configPath: () => missing, capture: 'watcher', push: null, restart: 'none' },
  ] };
  const health = healthSignals();
  const rows = await toolRows(registry, health, 0, true);
  eq(rows.length, 1, 'one row expected');
  eq(rows[0].installed, false, 'should be reported not installed');
  eq(rows[0].level, 'SKIP', 'not-installed must not be FAIL');
  assert(!existsSync(missing), 'sanity: fixture really is absent');
});

// ==========================================================================
// 3. Config malformed → reported, never crashes, never written to
// ==========================================================================

await t('checkPull: malformed JSON config → FAIL with a fix hint, never throws', async () => {
  const dir = scratchDir();
  const file = join(dir, 'mcp.json');
  const bad = '{ "mcpServers": { , }';
  writeFileSync(file, bad);
  const target = { format: 'json', configPath: () => file };
  const r = checkPull(target, true);
  eq(r.level, 'FAIL', 'malformed config must FAIL, not crash');
  assert(/brain onboard/.test(r.fix), 'fix hint should point at brain onboard');
  eq(readFileSync(file, 'utf8'), bad, 'malformed file must be untouched (read-only)');
});

await t('checkPull: malformed TOML config → FAIL, file untouched', async () => {
  const dir = scratchDir();
  const file = join(dir, 'config.toml');
  const bad = '[mcp_servers\njs_repl = false\n';
  writeFileSync(file, bad);
  const target = { format: 'toml', configPath: () => file };
  const r = checkPull(target, true);
  eq(r.level, 'FAIL', 'malformed TOML must FAIL, not crash');
  const after = readFileSync(file, 'utf8');
  eq(after, bad, 'malformed TOML file must be untouched (read-only)');
});

await t('checkPull: configPath() itself throws → FAIL, not an uncaught exception', () => {
  const target = { format: 'json', configPath: () => { throw new Error('boom in configPath'); } };
  const r = checkPull(target, true);
  eq(r.level, 'FAIL', 'a throwing configPath() must degrade to FAIL');
  assert(/boom in configPath/.test(r.detail), 'original error should be surfaced');
});

await t('checkPull: well-formed but not-yet-registered config → WARN, not FAIL', () => {
  const dir = scratchDir();
  const file = join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  const target = { format: 'json', configPath: () => file };
  const r = checkPull(target, true);
  eq(r.level, 'WARN', 'unregistered-but-parseable config is a WARN, not a FAIL');
});

await t('checkPush: file exists without the managed block → FAIL naming the block', () => {
  const dir = scratchDir();
  const file = join(dir, 'CLAUDE.md');
  writeFileSync(file, '# my own notes\nnothing managed here\n');
  const target = { push: { file: () => file } };
  const r = checkPush(target);
  eq(r.level, 'FAIL', 'detected file with no managed block should FAIL');
});

await t('checkPush: no push channel (push:null) → PASS, plainly n/a', () => {
  const r = checkPush({ push: null });
  eq(r.level, 'PASS', 'push:null must not read as a failure');
  assert(/n\/a/.test(r.detail), 'should say plainly there is no push channel');
});

await t('checkCapture: capture:"none" → PASS, plainly n/a, not treated as a failure', () => {
  const r = checkCapture({ id: 'claude-desktop', capture: 'none' }, healthSignals(), 0);
  eq(r.level, 'PASS', 'capture:none must not read as a failure');
  assert(/n\/a/.test(r.detail), 'should say plainly there is no capture channel');
});

// ==========================================================================
// 4. Spawn probe: timeout path kills the child, no orphan left behind
// ==========================================================================

await t('spawnProbe: bridge missing → skipped, no spawn attempted', async () => {
  const dir = scratchDir();
  const env = { AGENTIC_BRAIN_HOME: dir, BRAIN_TEST: '1' };
  const r = await spawnProbe({ timeoutMs: 500, env });
  eq(r.skipped, true, 'missing bridge should be a skip, not a hard failure');
  eq(r.ok, false, 'ok must be false');
});

await t('spawnProbe: hanging bridge times out, is killed, and leaves no orphan process', async () => {
  const dir = scratchDir();
  const env = { AGENTIC_BRAIN_HOME: dir, BRAIN_TEST: '1' };
  const bridge = bridgePath(env);
  eq(basename(bridge), BRIDGE_FILENAME, 'sanity: bridgePath honors AGENTIC_BRAIN_HOME');
  // A fake "bridge" that never answers initialize: reads stdin, writes nothing,
  // and would run forever if not killed. Its own path is unique (mkdtemp), so
  // pgrep -f against that exact path can only match a process we spawned here.
  writeFileSync(bridge, "process.stdin.resume();\nsetInterval(() => {}, 1000);\n");
  const started = Date.now();
  const r = await spawnProbe({ timeoutMs: 700, env });
  const elapsed = Date.now() - started;
  eq(r.ok, false, 'a silent bridge must not report success');
  assert(/timeout/i.test(r.error), `expected a timeout error, got: ${r.error}`);
  assert(elapsed < 5000, `should resolve close to the timeout, not hang (took ${elapsed}ms)`);
  // Give the OS a beat to reap the killed process, then confirm nothing
  // matching this unique bridge path is still running.
  await new Promise((res) => setTimeout(res, 300));
  let orphan = true;
  try {
    execFileSync('pgrep', ['-f', bridge], { stdio: 'ignore' });
  } catch {
    orphan = false; // pgrep exits non-zero when nothing matches — the expected outcome
  }
  assert(!orphan, `orphaned process still running for ${bridge}`);
});

await t('spawnProbe: stray non-JSON-RPC stdout is treated as a failure, not silently ignored', async () => {
  const dir = scratchDir();
  const env = { AGENTIC_BRAIN_HOME: dir, BRAIN_TEST: '1' };
  const bridge = bridgePath(env);
  writeFileSync(bridge, "process.stdout.write('this is not json-rpc\\n');\nprocess.stdin.resume();\n");
  const r = await spawnProbe({ timeoutMs: 2000, env });
  eq(r.ok, false, 'stray stdout must fail the probe');
  assert(/stray|not JSON-RPC/i.test(r.error), `expected a framing-corruption error, got: ${r.error}`);
});

await t('spawnProbe: a well-formed initialize response is accepted (sanity, mirrors real shim shape)', async () => {
  const dir = scratchDir();
  const env = { AGENTIC_BRAIN_HOME: dir, BRAIN_TEST: '1' };
  const bridge = bridgePath(env);
  writeFileSync(bridge, [
    "let buf='';",
    "process.stdin.on('data', d => {",
    "  buf += d;",
    "  const nl = buf.indexOf('\\n');",
    "  if (nl === -1) return;",
    "  const req = JSON.parse(buf.slice(0, nl));",
    "  const res = { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'claude-mem', version: '13.13.1' }, capabilities: {} } };",
    "  process.stdout.write(JSON.stringify(res) + '\\n');",
    "});",
  ].join('\n'));
  const r = await spawnProbe({ timeoutMs: 3000, env });
  eq(r.ok, true, `expected success, got error: ${r.error}`);
  eq(r.serverInfo?.name, 'claude-mem', 'serverInfo.name should round-trip');
  eq(r.serverInfo?.version, '13.13.1', 'serverInfo.version should round-trip');
});

// ==========================================================================
// 4b. serverProbe (agentic-brain): same kill/skip guarantees as spawnProbe,
//     plus tools/list so doctor reports the live server's actual tool names
// ==========================================================================

await t('serverProbe: server shim missing → skipped, no spawn attempted', async () => {
  const dir = scratchDir();
  const env = { AGENTIC_BRAIN_HOME: dir, BRAIN_TEST: '1' };
  const r = await serverProbe({ timeoutMs: 500, env });
  eq(r.skipped, true, 'missing server shim should be a skip, not a hard failure');
  eq(r.ok, false, 'ok must be false');
  assert(/server shim not installed/.test(r.error), `skip message should name the server shim, got: ${r.error}`);
});

await t('serverProbe: hanging server times out, is killed, and leaves no orphan process', async () => {
  const dir = scratchDir();
  const env = { AGENTIC_BRAIN_HOME: dir, BRAIN_TEST: '1' };
  const server = serverPath(env);
  eq(basename(server), SERVER_FILENAME, 'sanity: serverPath honors AGENTIC_BRAIN_HOME');
  writeFileSync(server, "process.stdin.resume();\nsetInterval(() => {}, 1000);\n");
  const started = Date.now();
  const r = await serverProbe({ timeoutMs: 700, env });
  const elapsed = Date.now() - started;
  eq(r.ok, false, 'a silent server must not report success');
  assert(/timeout/i.test(r.error), `expected a timeout error, got: ${r.error}`);
  assert(elapsed < 5000, `should resolve close to the timeout, not hang (took ${elapsed}ms)`);
  await new Promise((res) => setTimeout(res, 300));
  let orphan = true;
  try {
    execFileSync('pgrep', ['-f', server], { stdio: 'ignore' });
  } catch {
    orphan = false; // pgrep exits non-zero when nothing matches — the expected outcome
  }
  assert(!orphan, `orphaned process still running for ${server}`);
});

await t('serverProbe: initialize OK but tools/list errors → probe fails (a wired server without tools is broken)', async () => {
  const dir = scratchDir();
  const env = { AGENTIC_BRAIN_HOME: dir, BRAIN_TEST: '1' };
  const server = serverPath(env);
  writeFileSync(server, [
    "let buf='';",
    "process.stdin.on('data', d => {",
    "  buf += d;",
    "  let nl;",
    "  while ((nl = buf.indexOf('\\n')) !== -1) {",
    "    const req = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);",
    "    if (req.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'agentic-brain', version: '0.0.0' }, capabilities: {} } }) + '\\n');",
    "    else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } }) + '\\n');",
    "  }",
    "});",
  ].join('\n'));
  const r = await serverProbe({ timeoutMs: 3000, env });
  eq(r.ok, false, 'tools/list failure must fail the probe');
  assert(/tools\/list/.test(r.error), `error should name tools/list, got: ${r.error}`);
});

await t('serverProbe: full initialize → tools/list round-trip returns the tool names', async () => {
  const dir = scratchDir();
  const env = { AGENTIC_BRAIN_HOME: dir, BRAIN_TEST: '1' };
  const server = serverPath(env);
  writeFileSync(server, [
    "let buf='';",
    "process.stdin.on('data', d => {",
    "  buf += d;",
    "  let nl;",
    "  while ((nl = buf.indexOf('\\n')) !== -1) {",
    "    const req = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);",
    "    if (req.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'agentic-brain', version: '1.2.3' }, capabilities: { tools: {} } } }) + '\\n');",
    "    if (req.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'brain_remember' }, { name: 'brain_recall' }, { name: 'brain_context' }] } }) + '\\n');",
    "  }",
    "});",
  ].join('\n'));
  const r = await serverProbe({ timeoutMs: 3000, env });
  eq(r.ok, true, `expected success, got error: ${r.error}`);
  eq(r.serverInfo?.name, 'agentic-brain', 'serverInfo.name should round-trip');
  eq(JSON.stringify(r.tools), JSON.stringify(['brain_remember', 'brain_recall', 'brain_context']), 'tool names should round-trip in order');
});

await t('serverProbe: the REAL bin/mcp-server.mjs answers via a real server-shim + pointer (read-only integration)', async () => {
  // Build a genuine bridge home in scratch: the real server-shim template plus
  // an engine-path pointing at this clone — exactly what `brain onboard`
  // installs. The probe speaks initialize + tools/list only; neither writes.
  const dir = scratchDir();
  const env = { ...process.env, AGENTIC_BRAIN_HOME: dir };
  const repoRoot = join(import.meta.dirname, '..');
  writeFileSync(serverPath(env), readFileSync(join(repoRoot, 'bin', 'templates', 'server-shim.cjs'), 'utf8'));
  writeFileSync(join(dir, 'engine-path'), repoRoot + '\n');
  const r = await serverProbe({ timeoutMs: 8000, env });
  eq(r.ok, true, `expected the real server to answer, got: ${r.error}`);
  eq(r.serverInfo?.name, 'agentic-brain', 'real server identity must be agentic-brain');
  eq(JSON.stringify(r.tools), JSON.stringify(['brain_remember', 'brain_recall', 'brain_context', 'brain_skills', 'brain_skill']), 'real server must expose exactly our five tools');
});

// ==========================================================================
// 4c. New rows: server shim (never a FAIL) and claude-mem (optional, honest)
// ==========================================================================

await t('bridgeHomeSection: empty home → legacy bridge WARN when unused (FAIL only if an entry runs it), server shim WARN', () => {
  const dir = scratchDir();
  const s = bridgeHomeSection({ AGENTIC_BRAIN_HOME: dir });
  const shim = s.rows.find((r) => r.label === 'shim');
  const srv = s.rows.find((r) => r.label === 'server shim');
  assert(shim && srv, 'both shim rows must exist');
  eq(shim.level, 'WARN', 'missing legacy bridge nobody uses is informational');
  assert(/brain onboard/.test(shim.fix), 'fix hint should be brain onboard');
  eq(srv.level, 'WARN', 'missing server shim row is WARN (tool pulls carry the FAIL)');
  assert(/agentic-brain/.test(srv.detail), 'server shim row should name the agentic-brain server');
  eq(s.ok, false, 'ok keeps its bridge-only meaning');
  const used = bridgeHomeSection({ AGENTIC_BRAIN_HOME: dir }, { legacyInUse: true });
  eq(used.rows.find((r) => r.label === 'shim').level, 'FAIL', 'missing legacy bridge that an entry runs is a FAIL');
});

// Builds a bridge home: real server shim + pointer, and a STALE legacy
// bridge.cjs that exits like bridge.cjs does when claude-mem is absent.
function staleLegacyHome() {
  const dir = scratchDir();
  const repoRoot = join(import.meta.dirname, '..');
  const env = { ...process.env, AGENTIC_BRAIN_HOME: dir };
  writeFileSync(bridgePath(env), "process.stderr.write('claude-mem: mcp server not found (is the claude-mem plugin installed?)\\n'); process.exit(1);\n");
  writeFileSync(serverPath(env), readFileSync(join(repoRoot, 'bin', 'templates', 'server-shim.cjs'), 'utf8'));
  writeFileSync(join(dir, 'engine-path'), repoRoot + '\n');
  const cfg = join(dir, 'tool', 'mcp.json');
  mkdirSync(join(dir, 'tool'), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ mcpServers: { 'agentic-brain': { command: 'node', args: [serverPath(env)] } } }, null, 2));
  const registry = {
    ok: true,
    SERVER_NAME: 'agentic-brain',
    brainServerDef: () => ({ command: 'node', args: [serverPath(env)] }),
    supersedeSpec: () => ({ name: 'claude-mem', paths: [bridgePath(env)] }),
    TARGETS: [{ id: 'fixture-tool', name: 'Fixture Tool', format: 'json', configPath: () => cfg, capture: 'none', push: null, restart: 'none' }],
  };
  return { dir, env, cfg, registry };
}

await t('toolRows: stale legacy bridge.cjs + current server.cjs → pull PASS (judged by the shim the entry runs)', async () => {
  const { env, registry } = staleLegacyHome();
  const bh = bridgeHomeSection(env);
  eq(bh.verify.shim, 'stale', 'fixture: legacy bridge is stale');
  eq(bh.verify.serverShim, 'current', 'fixture: server shim is current');
  eq(bh.rows.find((r) => r.label === 'shim').level, 'WARN', 'stale unused legacy bridge is WARN, not FAIL');
  const rows = await toolRows(registry, healthSignals(), 0, bh);
  eq(rows[0].checks.pull.level, 'PASS', `pull must PASS, got: ${rows[0].checks.pull.detail}`);
  eq(rows[0].usesLegacyBridge, false, 'no entry runs bridge.cjs');
  eq(rows[0].level, 'PASS', 'tool row PASS');
});

await t('shimHealthFor: entry on server.cjs → missing FAIL / stale WARN / current PASS; broken pointer FAIL', () => {
  const v = { server: '/h/server.cjs', bridge: '/h/bridge.cjs', serverShim: 'current', shim: 'stale', pointerOk: true, engine: '/e' };
  const def = { command: 'node', args: ['/h/server.cjs'] };
  eq(shimHealthFor(def, v).level, 'PASS', 'current server shim');
  eq(shimHealthFor(def, { ...v, serverShim: 'stale' }).level, 'WARN', 'stale server shim still runs');
  eq(shimHealthFor(def, { ...v, serverShim: 'missing' }).level, 'FAIL', 'missing server shim');
  eq(shimHealthFor(def, { ...v, pointerOk: false }).level, 'FAIL', 'broken pointer');
  eq(shimHealthFor({ command: 'node', args: ['/h/bridge.cjs'] }, v).level, 'WARN', 'entry on stale legacy bridge → WARN');
});

await t('configRunsFile: only MCP server command/args count, not stray mentions', () => {
  const dir = scratchDir();
  const f = join(dir, 'c.json');
  writeFileSync(f, JSON.stringify({ history: ['node /h/bridge.cjs'], projects: { '/p': { mcpServers: { x: { command: 'node', args: ['/h/server.cjs'] } } } } }));
  eq(configRunsFile({ format: 'json', configPath: () => f }, '/h/bridge.cjs'), false, 'history mention is not an entry');
  writeFileSync(f, JSON.stringify({ projects: { '/p': { mcpServers: { old: { command: 'node', args: ['/h/bridge.cjs'] } } } } }));
  eq(configRunsFile({ format: 'json', configPath: () => f }, '/h/bridge.cjs'), true, 'nested project entry counts');
  const tf = join(dir, 'c.toml');
  writeFileSync(tf, '[mcp_servers.claude-mem]\ncommand = "node"\nargs = ["/h/bridge.cjs"]\n');
  eq(configRunsFile({ format: 'toml', configPath: () => tf }, '/h/bridge.cjs'), true, 'toml args entry counts');
});

await t('runDoctor: claude-mem absent (legacy bridge exits 1, unused) → bridge probe informational, not counted as failing', async () => {
  const { env, registry } = staleLegacyHome();
  const { result } = await runDoctor({ json: true, silent: true, timeoutMs: 8000, env, importRegistry: () => Promise.resolve(registry) });
  eq(result.spawn.ok, false, 'fixture: legacy bridge probe fails like a claude-mem-less machine');
  eq(result.spawn.informational, true, 'unused legacy bridge probe is informational');
  eq(result.tools[0].checks.pull.level, 'PASS', 'tool pull PASS');
  eq(result.serverSpawn.ok, true, `agentic-brain probe should pass: ${result.serverSpawn.error}`);
  const rowFails = [...result.brainHealth.rows, ...result.bridgeHome.rows, ...Object.values(result.tools[0].checks)]
    .filter((r) => r.level === 'FAIL').length;
  eq(result.failCount, rowFails, 'failCount must not include the informational bridge probe');
});

await t('captureSourceKey: distilled/MCP Claude Code rows count as claude; desktop chat does not', () => {
  eq(captureSourceKey('brain/claude:haiku', 'claude:'), 'claude', 'distilled Claude Code session');
  eq(captureSourceKey('brain/codex', 'claude:'), 'claude', 'Claude Code session distilled by codex provider');
  eq(captureSourceKey('brain/claude:haiku', 'codex:'), 'codex', 'Codex session distilled by claude provider');
  eq(captureSourceKey('mcp/claude-opus-4-6', 'mcp:claude_code:'), 'claude', 'brain_remember from Claude Code');
  eq(captureSourceKey('mcp/local-agent-mode-agentic-brain', 'mcp:claude_desktop_agent:'), null, 'Claude Desktop agent mode has no capture row');
  eq(captureSourceKey('claude-haiku-4-5-20251001', ''), 'claude', 'legacy claude-mem label');
  eq(captureSourceKey('codex', 'codex:'), 'codex', 'raw codex label');
});

await t('bridgeHomeSection: real templates installed → both shim rows PASS, ok unchanged in meaning', () => {
  const dir = scratchDir();
  const repoRoot = join(import.meta.dirname, '..');
  const env = { AGENTIC_BRAIN_HOME: dir, BRAIN_TEST: '1' };
  writeFileSync(bridgePath(env), readFileSync(join(repoRoot, 'bin', 'templates', 'bridge-shim.cjs'), 'utf8'));
  writeFileSync(serverPath(env), readFileSync(join(repoRoot, 'bin', 'templates', 'server-shim.cjs'), 'utf8'));
  writeFileSync(join(dir, 'engine-path'), repoRoot + '\n');
  const s = bridgeHomeSection(env);
  eq(s.rows.find((r) => r.label === 'shim')?.level, 'PASS', 'bridge shim should be current');
  eq(s.rows.find((r) => r.label === 'server shim')?.level, 'PASS', 'server shim should be current');
  eq(s.ok, true, 'bridge home healthy');
});

await t('claudeMemRow: absent DB → PASS saying not installed (never FAIL); unreadable → WARN; present → PASS with count', () => {
  // Hermetic: every branch is driven by a fixture path we construct, never by
  // the machine-global CLAUDE_MEM_DB (which depends on the host's HOME).
  const dir = scratchDir();
  const absentPath = join(dir, 'no-such-claude-mem.db');
  const presentPath = join(dir, 'claude-mem.db');
  writeFileSync(presentPath, 'fixture');

  const absent = claudeMemRow(null, absentPath);
  eq(absent.label, 'claude-mem', 'row label');
  eq(absent.level, 'PASS', 'absent optional source must be PASS (never FAIL)');
  assert(/not installed/.test(absent.detail), 'absent detail should say not installed');
  assert(/nothing depends on it|native/i.test(absent.detail), 'absent detail should name the role');

  const unreadable = claudeMemRow(null, presentPath);
  eq(unreadable.label, 'claude-mem', 'row label');
  eq(unreadable.level, 'WARN', 'present-but-unreadable DB must WARN, not FAIL');
  assert(unreadable.detail.includes(presentPath), 'WARN detail should name the DB path');

  const present = claudeMemRow(1234, presentPath);
  eq(present.label, 'claude-mem', 'row label');
  eq(present.level, 'PASS', 'readable DB must PASS');
  assert(/1234/.test(present.detail), 'PASS detail should carry the count');
  assert(/optional/.test(present.detail), 'PASS detail should say it is optional');

  // None of the branches may ever FAIL.
  for (const r of [absent, unreadable, present]) assert(r.level !== 'FAIL', 'claude-mem row must never FAIL');
});

// ==========================================================================
// 5. Real machine, read-only: report what doctor actually says
// ==========================================================================

await t('runDoctor: real machine, read-only, does not throw, exitCode is a number', async () => {
  const { exitCode, result } = await runDoctor({ json: true, silent: true, timeoutMs: 8000 });
  assert(typeof exitCode === 'number', 'exitCode must be numeric');
  assert(result.brainHealth.rows.length > 0, 'brain health should report something on a real machine');
  console.log('\n--- real-machine runDoctor() summary (informational, read-only) ---');
  console.log(`  registry: ${result.registry.ok ? `ok (${result.tools.length} targets)` : `unavailable: ${result.registry.error}`}`);
  console.log(`  bridge home ok: ${result.bridgeHome.ok}`);
  console.log(`  spawn: ${result.spawn.skipped ? 'skipped: ' + result.spawn.error : result.spawn.ok ? `OK (${result.spawn.ms}ms)` : 'FAIL: ' + result.spawn.error}`);
  console.log(`  serverSpawn: ${result.serverSpawn.skipped ? 'skipped: ' + result.serverSpawn.error : result.serverSpawn.ok ? `OK (${result.serverSpawn.ms}ms, tools: ${(result.serverSpawn.tools || []).join(',')})` : 'FAIL: ' + result.serverSpawn.error}`);
  console.log(`  exitCode: ${exitCode}`);
  console.log('---------------------------------------------------------------------\n');
});

await t('runDoctor: result carries the new surfaces — serverSpawn, server-shim row, memory-store row, claude-mem row', async () => {
  const { result } = await runDoctor({ json: true, silent: true, timeoutMs: 8000 });
  assert(result.serverSpawn && typeof result.serverSpawn.ok === 'boolean', 'serverSpawn section missing');
  assert(result.bridgeHome.rows.some((r) => r.label === 'server shim'), 'server shim row missing');
  const store = result.brainHealth.rows.find((r) => r.label === 'memory store');
  assert(store, 'memory store row missing');
  assert(/native store|claude-mem/.test(store.detail), 'memory store row should say which DB MEMORY_DB resolves to');
  assert(result.brainHealth.rows.some((r) => r.label === 'claude-mem'), 'claude-mem row missing');
});

// ==========================================================================

const w = Math.max(...results.map((r) => r[1].length));
for (const [st, name, msg] of results) {
  console.log(`${st === 'PASS' ? '✅' : '❌'} ${name.padEnd(w)}${msg ? '\n    ' + msg : ''}`);
}
console.log(`\n${pass} passed, ${fail} failed  ·  sandbox: ${ROOT}`);
if (!fail && !process.env.BRAIN_DOCTOR_TEST_KEEP) rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
