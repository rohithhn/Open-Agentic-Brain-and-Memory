#!/usr/bin/env node
// Tests for the stable bridge home (bin/lib/bridgehome.mjs) and the generated
// shim (bin/templates/bridge-shim.cjs).
//
// Hermetic by construction:
//   - AGENTIC_BRAIN_HOME points every call at a temp dir, so the real
//     ~/.agentic-brain is never created, read, or modified.
//   - The "engine" under test is a FAKE clone (a stub bin/mcp-bridge.cjs) so
//     no real claude-mem MCP server is ever launched. One case uses the real
//     repo root, but only to compare file contents — it never spawns it.
//
// Run:  node evals/bridge-test.mjs

import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

import {
  installBridgeHome,
  verifyBridgeHome,
  readPointer,
  resolveNodeBinary,
  bridgeHome,
  bridgePath,
  serverPath,
  pointerPath,
  TEMPLATE_PATH,
  SERVER_TEMPLATE_PATH,
  ENGINE_ROOT,
  HOME_ENV,
  NODE_ENV_VAR,
} from '../bin/lib/bridgehome.mjs';

const SCRATCH = process.env.SCRATCH_DIR || tmpdir();
mkdirSync(SCRATCH, { recursive: true });
const ROOT = mkdtempSync(join(SCRATCH, 'bridge-test-'));

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

// ---------------------------------------------------------------- fixtures

/** A stand-in clone: has bin/mcp-bridge.cjs, so the shim accepts it. */
function fakeEngine(name, body) {
  const root = join(ROOT, name);
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'mcp-bridge.cjs'), body);
  return root;
}

// Delegate that is silent on stdout (like the real bridge's own code), writes a
// marker to stderr, and exits with a distinctive code so we can prove the shim
// preserves it.
const SILENT_DELEGATE = `'use strict';
process.stderr.write('DELEGATE_RAN pid=' + process.pid + '\\n');
process.exit(7);
`;

// Delegate that writes on stdout — proves the shim does not swallow or reorder
// the protocol channel it is supposed to hand over untouched.
const SPEAKING_DELEGATE = `'use strict';
process.stdout.write('{"jsonrpc":"2.0","id":1}\\n');
process.exit(0);
`;

// Delegate that stays alive and forwards signals, mirroring the real bridge's
// spawn+forward shape, so we can test signal handling / exit-on-signal.
const LONG_DELEGATE = `'use strict';
const c = require('child_process');
const child = c.spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'inherit' });
for (const s of ['SIGTERM','SIGINT','SIGHUP']) process.on(s, () => { try { child.kill(s); } catch {} });
child.on('exit', (code, sig) => process.exit(sig ? 143 : (code == null ? 0 : code)));
process.stderr.write('LONG_READY\\n');
`;

function newHome(name) {
  const home = join(ROOT, name);
  return { [HOME_ENV]: home, home };
}

/** Spawn the installed shim with a clean env and capture stdio separately. */
function runShim(shim, env = {}) {
  return spawnSync(process.execPath, [shim], {
    encoding: 'utf8',
    timeout: 15000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, BRAIN_TEST: '1', ...env },
  });
}

// ------------------------------------------------------- 1. fresh create

section('1. fresh create');
{
  const engine = fakeEngine('engine-a', SILENT_DELEGATE);
  const env = { ...newHome('home-1') };
  const r = installBridgeHome({ engine, env, verifyNode: false });

  ok('home dir created', existsSync(r.home));
  ok('bridge.cjs written', existsSync(r.bridge) && r.actions.bridge === 'created');
  ok('engine-path written', existsSync(r.pointer) && r.actions.pointer === 'created');
  ok('changed=true on first install', r.changed === true);
  ok('shim is byte-identical to the template', readFileSync(r.bridge, 'utf8') === readFileSync(TEMPLATE_PATH, 'utf8'));
  ok('shim is executable', (statSync(r.bridge).mode & 0o111) !== 0);
  const ptrTxt = readFileSync(r.pointer, 'utf8');
  ok('pointer contains the absolute engine path', ptrTxt.includes(engine));
  ok('pointer is a single meaningful line', ptrTxt.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length === 1);
  ok('bridgePath()/pointerPath() agree with the install result', bridgePath(env) === r.bridge && pointerPath(env) === r.pointer);
  ok('bridgeHome honours the env override', bridgeHome(env) === env[HOME_ENV]);

  const v = verifyBridgeHome(env);
  ok('verify: ok', v.ok === true, JSON.stringify(v.problems));
  ok('verify: shim current', v.shim === 'current');
  ok('verify: engine resolved', v.engine === engine);
}

// ------------------------------------------------- 2. idempotent re-run

section('2. idempotent re-run (no rewrite)');
{
  const engine = fakeEngine('engine-b', SILENT_DELEGATE);
  const env = { ...newHome('home-2') };
  const first = installBridgeHome({ engine, env, verifyNode: false });
  const mt = [statSync(first.bridge).mtimeMs, statSync(first.pointer).mtimeMs];

  const again = installBridgeHome({ engine, env, verifyNode: false });
  ok('second run reports unchanged', again.actions.bridge === 'unchanged' && again.actions.pointer === 'unchanged');
  ok('changed=false', again.changed === false);
  const mt2 = [statSync(first.bridge).mtimeMs, statSync(first.pointer).mtimeMs];
  ok('no file was rewritten (mtimes identical)', mt[0] === mt2[0] && mt[1] === mt2[1]);

  const dry = installBridgeHome({ engine, env, dry: true, verifyNode: false });
  ok('dry run on a current home also reports unchanged', dry.changed === false);
}

// ------------------------------------------------------- 3. repo moved

section('3. simulated repo move');
{
  const oldEngine = fakeEngine('engine-old', SILENT_DELEGATE);
  const env = { ...newHome('home-3') };
  const r1 = installBridgeHome({ engine: oldEngine, env, verifyNode: false });
  const shimBefore = readFileSync(r1.bridge, 'utf8');

  // Move the clone: old path gone, new path real.
  const newEngine = fakeEngine('engine-new', SILENT_DELEGATE);
  rmSync(oldEngine, { recursive: true, force: true });

  const broken = verifyBridgeHome(env);
  ok('dangling pointer detected', broken.ok === false && /no longer exists/.test(broken.problems.join(' ')));
  ok('dangling diagnostic names the fix', /brain onboard/.test(broken.problems.join(' ')));

  // The repair: re-onboard from the new location.
  const r2 = installBridgeHome({ engine: newEngine, env, verifyNode: false });
  ok('only the pointer was rewritten', r2.actions.pointer === 'updated' && r2.actions.bridge === 'unchanged');
  ok('shim bytes untouched by the move', readFileSync(r1.bridge, 'utf8') === shimBefore);
  ok('pointer now names the new engine', readPointer(env).engine === newEngine);
  ok('verify healthy again', verifyBridgeHome(env).ok === true);
}

// ----------------------------------------- 4. missing pointer -> shim fails

section('4. shim with a missing pointer file');
{
  const engine = fakeEngine('engine-c', SILENT_DELEGATE);
  const env = { ...newHome('home-4') };
  const r = installBridgeHome({ engine, env, verifyNode: false });
  rmSync(r.pointer);

  const out = runShim(r.bridge);
  ok('exits non-zero', out.status !== 0 && out.status != null, `status=${out.status}`);
  ok('stdout is empty', out.stdout === '', JSON.stringify(out.stdout));
  ok('stderr explains the problem', /pointer file missing/.test(out.stderr), out.stderr);
  ok('stderr names the fix', /brain onboard/.test(out.stderr));
  ok('does not hang', out.signal !== 'SIGTERM');

  writeFileSync(r.pointer, '\n# only comments\n');
  const out2 = runShim(r.bridge);
  ok('empty pointer -> non-zero + clear stderr', out2.status !== 0 && /empty/.test(out2.stderr) && out2.stdout === '');
}

// --------------------------------------- 5. engine deleted -> shim fails

section('5. shim with a deleted / wrong engine');
{
  const engine = fakeEngine('engine-d', SILENT_DELEGATE);
  const env = { ...newHome('home-5') };
  const r = installBridgeHome({ engine, env, verifyNode: false });
  rmSync(engine, { recursive: true, force: true });

  const out = runShim(r.bridge);
  ok('exits non-zero', out.status !== 0);
  ok('stdout is empty', out.stdout === '', JSON.stringify(out.stdout));
  ok('stderr names the dead path', out.stderr.includes(engine), out.stderr);
  ok('stderr says the clone moved', /moved, renamed, or deleted/.test(out.stderr));
  ok('stderr names the fix', /brain onboard/.test(out.stderr));

  // Directory exists but is not a clone.
  const notAClone = join(ROOT, 'not-a-clone');
  mkdirSync(notAClone, { recursive: true });
  writeFileSync(r.pointer, `${notAClone}\n`);
  const out2 = runShim(r.bridge);
  ok('non-clone target -> non-zero', out2.status !== 0);
  ok('non-clone target -> stdout empty', out2.stdout === '');
  ok('non-clone diagnostic mentions bin/mcp-bridge.cjs', /mcp-bridge\.cjs/.test(out2.stderr), out2.stderr);
  ok('readPointer() agrees it is invalid', readPointer(env).valid === false);
}

// ------------------------------ 6. success path: stdout purity + delegation

section('6. success path — delegation, stdout purity, exit code');
{
  const engine = fakeEngine('engine-ok', SILENT_DELEGATE);
  const env = { ...newHome('home-6') };
  const r = installBridgeHome({ engine, env, verifyNode: false });

  const out = runShim(r.bridge);
  ok('SHIM WRITES NOTHING TO STDOUT on success', out.stdout === '', JSON.stringify(out.stdout));
  ok('delegate actually ran', /DELEGATE_RAN/.test(out.stderr), out.stderr);
  ok('delegate ran IN-PROCESS (no extra pid)', out.stderr.includes(`pid=`) === true);
  ok("delegate's exit code is preserved", out.status === 7, `status=${out.status}`);
  ok('shim added no stderr noise of its own', out.stderr.trim().split('\n').length === 1, out.stderr);

  // Delegate output on stdout passes through byte-for-byte (framing intact).
  const speaking = fakeEngine('engine-speak', SPEAKING_DELEGATE);
  const env2 = { ...newHome('home-6b') };
  const r2 = installBridgeHome({ engine: speaking, env: env2, verifyNode: false });
  const out2 = runShim(r2.bridge);
  ok('delegate stdout passes through unmodified', out2.stdout === '{"jsonrpc":"2.0","id":1}\n', JSON.stringify(out2.stdout));
  ok('zero exit preserved', out2.status === 0);

  // AGENTIC_BRAIN_ENGINE escape hatch.
  const out3 = runShim(r2.bridge, { AGENTIC_BRAIN_ENGINE: engine });
  ok('AGENTIC_BRAIN_ENGINE overrides the pointer', out3.status === 7 && /DELEGATE_RAN/.test(out3.stderr));
}

// ------------------------------------------------ 7. signals / no hanging

section('7. signal forwarding');
{
  const engine = fakeEngine('engine-long', LONG_DELEGATE);
  const env = { ...newHome('home-7') };
  const r = installBridgeHome({ engine, env, verifyNode: false });

  const code = await new Promise((res) => {
    const child = spawn(process.execPath, [r.bridge], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.once('data', () => setTimeout(() => child.kill('SIGTERM'), 50));
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      res({ code: 'TIMEOUT', stdout });
    }, 10000);
    child.on('exit', (c, s) => {
      clearTimeout(guard);
      res({ code: c, signal: s, stdout });
    });
  });
  ok('SIGTERM terminates the shim promptly (no hang)', code.code !== 'TIMEOUT', JSON.stringify(code));
  ok('nothing on stdout while running', code.stdout === '', JSON.stringify(code.stdout));
}

// ------------------------------------------------------ 8. node resolution

section('8. node binary resolution');
{
  const n = resolveNodeBinary({ env: {} });
  ok('returns an absolute path', n.path.startsWith('/'), n.path);
  ok('the path exists', existsSync(n.path));
  ok('never returns a bare "node"', n.path !== 'node');
  ok('reports where it came from', typeof n.source === 'string' && n.source.length > 0);

  // Forced override wins.
  const forced = resolveNodeBinary({ env: { [NODE_ENV_VAR]: process.execPath } });
  ok('AGENTIC_BRAIN_NODE override honoured', forced.path === process.execPath && forced.source === NODE_ENV_VAR);

  // A bogus forced path fails loudly rather than silently wiring a dead command.
  let threw = null;
  try {
    resolveNodeBinary({ env: { [NODE_ENV_VAR]: join(ROOT, 'no-such-node') } });
  } catch (e) {
    threw = e.message;
  }
  ok('missing node -> clear throw, not a silent fallback', !!threw && /No usable node binary/.test(threw), String(threw));
  ok('throw names the remedy', !!threw && threw.includes(NODE_ENV_VAR));

  // Non-node executable is rejected by the -v probe.
  const fakeNode = join(ROOT, 'fake-node');
  writeFileSync(fakeNode, '#!/bin/sh\necho nope\n');
  chmodSync(fakeNode, 0o755);
  let threw2 = null;
  try {
    resolveNodeBinary({ env: { [NODE_ENV_VAR]: fakeNode } });
  } catch (e) {
    threw2 = e.message;
  }
  ok('non-node executable rejected', !!threw2);

  // Version-manager paths get a warning, not a failure.
  const pinned = resolveNodeBinary({ env: {} });
  ok('version-pinned paths are flagged, stable ones are not', pinned.warning === null || /brain onboard/.test(pinned.warning));
}

// ------------------------------------- 9. guards + real-repo sanity check

section('9. guards and real-repo sanity');
{
  const env = { ...newHome('home-9') };
  let threw = null;
  try {
    installBridgeHome({ engine: join(ROOT, 'nope'), env, verifyNode: false });
  } catch (e) {
    threw = e.message;
  }
  ok('refuses to point at a non-clone', !!threw && /Refusing to point/.test(threw), String(threw));
  ok('nothing was written for the refused install', !existsSync(join(env[HOME_ENV], 'bridge.cjs')));

  // Default engine = this repo. Installed into a TEMP home, never ~/.agentic-brain.
  const env2 = { ...newHome('home-9b') };
  const r = installBridgeHome({ env: env2, verifyNode: false });
  ok('default engine is the real clone', r.engine === ENGINE_ROOT);
  ok('installed under the temp home only', r.bridge.startsWith(ROOT));
  ok('real ~/.agentic-brain untouched by this test', !r.home.includes('.agentic-brain') || r.home.startsWith(ROOT));

  const v = verifyBridgeHome(env2);
  ok('verify passes against the real clone', v.ok === true, JSON.stringify(v.problems));

  // Stale shim detection.
  writeFileSync(r.bridge, '// tampered\n');
  ok('stale shim detected', verifyBridgeHome(env2).shim === 'stale');
  // Missing shim detection.
  rmSync(r.bridge);
  const v3 = verifyBridgeHome(env2);
  ok('missing shim detected', v3.shim === 'missing' && v3.ok === false && /brain onboard/.test(v3.problems.join(' ')));
}

// =====================================================================
// server shim (~/.agentic-brain/server.cjs) — sibling of the bridge shim,
// same pointer file, delegates to <engine>/bin/mcp-server.mjs via dynamic
// import() instead of require() (the delegate is an ESM module).
// =====================================================================

/** Add an ESM delegate at bin/mcp-server.mjs inside an existing fake engine. */
function addServerDelegate(root, body) {
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'mcp-server.mjs'), body);
  return root;
}

// ESM delegate, silent on stdout, marker + distinctive exit code — mirrors
// SILENT_DELEGATE above but as an ES module (import-time side effects only;
// dynamic import() runs the module body exactly once).
const SILENT_SERVER_DELEGATE = `process.stderr.write('SERVER_RAN pid=' + process.pid + '\\n');
process.exit(9);
`;

// ESM delegate that speaks on stdout — proves the shim hands the JSON-RPC
// channel through untouched instead of swallowing or buffering it.
const SPEAKING_SERVER_DELEGATE = `process.stdout.write('{"jsonrpc":"2.0","id":2}\\n');
process.exit(0);
`;

// ------------------------------------------------- 10. server: fresh create
section('10. server shim: fresh create (installs both shims)');
{
  const engine = fakeEngine('engine-s1', SILENT_DELEGATE);
  addServerDelegate(engine, SILENT_SERVER_DELEGATE);
  const env = { ...newHome('home-s1') };
  const r = installBridgeHome({ engine, env, verifyNode: false });

  ok('bridge.cjs still installed (additive, not replaced)', existsSync(r.bridge) && r.actions.bridge === 'created');
  ok('server.cjs written', existsSync(r.server) && r.actions.server === 'created');
  ok('changed=true on first install', r.changed === true);
  ok('server shim is byte-identical to its template', readFileSync(r.server, 'utf8') === readFileSync(SERVER_TEMPLATE_PATH, 'utf8'));
  ok('server shim is executable', (statSync(r.server).mode & 0o111) !== 0);
  ok('serverPath() agrees with the install result', serverPath(env) === r.server);
  ok('both shims share one pointer file', readFileSync(r.pointer, 'utf8').includes(engine));

  const v = verifyBridgeHome(env);
  ok('verify: server field present', v.server === r.server);
  ok('verify: serverShim current', v.serverShim === 'current');
  ok('verify: original ok/shim fields unaffected by the new shim', v.ok === true && v.shim === 'current');
}

// -------------------------------------------- 11. server: idempotent re-run
section('11. server shim: idempotent re-run (no rewrite)');
{
  const engine = fakeEngine('engine-s2', SILENT_DELEGATE);
  addServerDelegate(engine, SILENT_SERVER_DELEGATE);
  const env = { ...newHome('home-s2') };
  const first = installBridgeHome({ engine, env, verifyNode: false });
  const mt = statSync(first.server).mtimeMs;

  const again = installBridgeHome({ engine, env, verifyNode: false });
  ok('second run: server reported unchanged', again.actions.server === 'unchanged');
  ok('second run: bridge and pointer also unchanged (untouched by server addition)', again.actions.bridge === 'unchanged' && again.actions.pointer === 'unchanged');
  ok('changed=false', again.changed === false);
  ok('server.cjs was not rewritten (mtime identical)', statSync(first.server).mtimeMs === mt);
}

// ------------------------------------------------- 12. server: repo moved
section('12. server shim: pointer rewrite after simulated repo move');
{
  const oldEngine = fakeEngine('engine-s-old', SILENT_DELEGATE);
  addServerDelegate(oldEngine, SILENT_SERVER_DELEGATE);
  const env = { ...newHome('home-s3') };
  const r1 = installBridgeHome({ engine: oldEngine, env, verifyNode: false });
  const serverBefore = readFileSync(r1.server, 'utf8');

  const newEngine = fakeEngine('engine-s-new', SILENT_DELEGATE);
  addServerDelegate(newEngine, SILENT_SERVER_DELEGATE);
  rmSync(oldEngine, { recursive: true, force: true });

  const broken = verifyBridgeHome(env);
  ok('move breaks both shims via the shared pointer', broken.shim !== 'current' || /no longer exists/.test(broken.problems.join(' ')));

  const r2 = installBridgeHome({ engine: newEngine, env, verifyNode: false });
  ok('only the pointer was rewritten, server bytes untouched', r2.actions.server === 'unchanged' && readFileSync(r1.server, 'utf8') === serverBefore);
  ok('one pointer rewrite repairs both shims', readPointer(env).engine === newEngine);

  const outAfter = runShim(r2.server);
  ok('server shim now runs against the moved engine', outAfter.status === 9 && /SERVER_RAN/.test(outAfter.stderr));
}

// -------------------------------------- 13. server: missing pointer -> fails
section('13. server shim: missing pointer file');
{
  const engine = fakeEngine('engine-s4', SILENT_DELEGATE);
  addServerDelegate(engine, SILENT_SERVER_DELEGATE);
  const env = { ...newHome('home-s4') };
  const r = installBridgeHome({ engine, env, verifyNode: false });
  rmSync(r.pointer);

  const out = runShim(r.server);
  ok('exits non-zero', out.status !== 0 && out.status != null, `status=${out.status}`);
  ok('SERVER STDOUT IS EMPTY on missing-pointer failure', out.stdout === '', JSON.stringify(out.stdout));
  ok('stderr explains the problem', /pointer file missing/.test(out.stderr), out.stderr);
  ok('stderr names the fix', /brain onboard/.test(out.stderr));
  ok('does not hang', out.signal !== 'SIGTERM');
}

// ---------------------------------- 14. server: delegate missing entirely
section('14. server shim: engine is a real clone but bin/mcp-server.mjs is absent');
{
  // bin/mcp-server.mjs may not exist yet (owned by a different task) — the
  // shim must fail cleanly, not throw an unhandled rejection or hang.
  const engine = fakeEngine('engine-s5', SILENT_DELEGATE); // no addServerDelegate() call
  const env = { ...newHome('home-s5') };
  const r = installBridgeHome({ engine, env, verifyNode: false });

  const out = runShim(r.server);
  ok('exits non-zero', out.status !== 0 && out.status != null, `status=${out.status}`);
  ok('stdout empty when the delegate file is absent', out.stdout === '', JSON.stringify(out.stdout));
  ok('stderr names the missing file', /mcp-server\.mjs/.test(out.stderr), out.stderr);
  ok('stderr names the fix', /brain onboard/.test(out.stderr));
  ok('does not hang', out.signal !== 'SIGTERM');
}

// ------------------------- 15. server: deleted engine / non-clone target
section('15. server shim: deleted / wrong engine');
{
  const engine = fakeEngine('engine-s6', SILENT_DELEGATE);
  addServerDelegate(engine, SILENT_SERVER_DELEGATE);
  const env = { ...newHome('home-s6') };
  const r = installBridgeHome({ engine, env, verifyNode: false });
  rmSync(engine, { recursive: true, force: true });

  const out = runShim(r.server);
  ok('exits non-zero', out.status !== 0);
  ok('stdout empty', out.stdout === '', JSON.stringify(out.stdout));
  ok('stderr names the dead path', out.stderr.includes(engine), out.stderr);
  ok('stderr says the clone moved', /moved, renamed, or deleted/.test(out.stderr));

  const notAClone = join(ROOT, 'not-a-clone-server');
  mkdirSync(notAClone, { recursive: true });
  writeFileSync(r.pointer, `${notAClone}\n`);
  const out2 = runShim(r.server);
  ok('non-clone target -> non-zero', out2.status !== 0);
  ok('non-clone target -> stdout empty', out2.stdout === '');
  ok('non-clone diagnostic mentions bin/mcp-bridge.cjs', /mcp-bridge\.cjs/.test(out2.stderr), out2.stderr);
}

// --------------------- 16. server: success path — stdout purity, exit code
section('16. server shim: success path — delegation, stdout purity, exit code');
{
  const engine = fakeEngine('engine-s7', SILENT_DELEGATE);
  addServerDelegate(engine, SILENT_SERVER_DELEGATE);
  const env = { ...newHome('home-s7') };
  const r = installBridgeHome({ engine, env, verifyNode: false });

  const out = runShim(r.server);
  ok('SERVER SHIM WRITES NOTHING TO STDOUT on success', out.stdout === '', JSON.stringify(out.stdout));
  ok('delegate actually ran', /SERVER_RAN/.test(out.stderr), out.stderr);
  ok("delegate's exit code is preserved", out.status === 9, `status=${out.status}`);

  // Delegate stdout passes through byte-for-byte (framing intact).
  const speaking = fakeEngine('engine-s-speak', SILENT_DELEGATE);
  addServerDelegate(speaking, SPEAKING_SERVER_DELEGATE);
  const env2 = { ...newHome('home-s7b') };
  const r2 = installBridgeHome({ engine: speaking, env: env2, verifyNode: false });
  const out2 = runShim(r2.server);
  ok('delegate stdout passes through unmodified', out2.stdout === '{"jsonrpc":"2.0","id":2}\n', JSON.stringify(out2.stdout));
  ok('zero exit preserved', out2.status === 0);

  // AGENTIC_BRAIN_ENGINE escape hatch, same as the bridge shim.
  const out3 = runShim(r2.server, { AGENTIC_BRAIN_ENGINE: engine });
  ok('AGENTIC_BRAIN_ENGINE overrides the pointer', out3.status === 9 && /SERVER_RAN/.test(out3.stderr));
}

// ------------------------------------------------------------------ report

console.log(`\n${fails.length ? 'FAILED' : 'PASSED'} — ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f}`);
  process.exitCode = 1;
}
console.log(`workdir: ${ROOT}`);
