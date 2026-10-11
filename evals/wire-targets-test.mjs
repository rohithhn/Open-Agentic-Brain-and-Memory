#!/usr/bin/env node
// Tests for bin/lib/wire-targets.mjs — the declarative per-tool registry that
// wireMcp() (bin/lib/wire.mjs, consumed by brain.mjs) and brain doctor both
// read from. Data-only + pure functions, so these tests are pure assertions:
// no fs writes, no real tool config is ever touched.
//
//   node evals/wire-targets-test.mjs
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import {
  TARGETS, detectedTargets, serverDef, binOnPath,
  brainServerDef, supersedeSpec, SERVER_NAME, LEGACY_SERVER_NAME,
} from '../bin/lib/wire-targets.mjs';
import { bridgePath, serverPath } from '../bin/lib/bridgehome.mjs';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { wireMcp } from '../bin/lib/wire.mjs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

const REQUIRED_FIELDS = ['id', 'name', 'format', 'configPath', 'serversKey', 'capture', 'push', 'restart', 'notes'];
const VALID_FORMAT = new Set(['json', 'toml']);
const VALID_CAPTURE = new Set(['native', 'watcher', 'ingest', 'none']);
const VALID_RESTART = new Set(['none', 'restart-app', 'next-launch']);

t('TARGETS is a non-empty array', () => {
  assert(Array.isArray(TARGETS), 'TARGETS must be an array');
  assert(TARGETS.length > 0, 'TARGETS must not be empty');
});

t('every entry has all required fields', () => {
  for (const entry of TARGETS) {
    for (const f of REQUIRED_FIELDS) {
      assert(f in entry, `entry ${entry.id || '?'} missing field "${f}"`);
    }
  }
});

t('every entry has a valid format', () => {
  for (const entry of TARGETS) {
    assert(VALID_FORMAT.has(entry.format), `entry ${entry.id}: invalid format ${JSON.stringify(entry.format)}`);
  }
});

t('every entry has a valid capture', () => {
  for (const entry of TARGETS) {
    assert(VALID_CAPTURE.has(entry.capture), `entry ${entry.id}: invalid capture ${JSON.stringify(entry.capture)}`);
  }
});

t('every entry has a valid restart', () => {
  for (const entry of TARGETS) {
    assert(VALID_RESTART.has(entry.restart), `entry ${entry.id}: invalid restart ${JSON.stringify(entry.restart)}`);
  }
});

t('configPath is a function returning an absolute path', () => {
  for (const entry of TARGETS) {
    assert(typeof entry.configPath === 'function', `entry ${entry.id}: configPath must be a function, not a frozen literal`);
    const p = entry.configPath();
    assert(typeof p === 'string' && p.startsWith('/'), `entry ${entry.id}: configPath() must return an absolute path, got ${JSON.stringify(p)}`);
  }
});

t('push is null or { file: fn returning absolute path }', () => {
  for (const entry of TARGETS) {
    if (entry.push === null) continue;
    assert(typeof entry.push === 'object', `entry ${entry.id}: push must be null or an object`);
    assert(typeof entry.push.file === 'function', `entry ${entry.id}: push.file must be a function`);
    const p = entry.push.file();
    assert(typeof p === 'string' && p.startsWith('/'), `entry ${entry.id}: push.file() must return an absolute path, got ${JSON.stringify(p)}`);
  }
});

t('ids are unique', () => {
  const ids = TARGETS.map((e) => e.id);
  const seen = new Set();
  for (const id of ids) {
    assert(!seen.has(id), `duplicate id: ${id}`);
    seen.add(id);
  }
});

t('ids are non-empty strings and name/notes are non-empty strings', () => {
  for (const entry of TARGETS) {
    assert(typeof entry.id === 'string' && entry.id.length > 0, `entry has bad id ${JSON.stringify(entry.id)}`);
    assert(typeof entry.name === 'string' && entry.name.length > 0, `entry ${entry.id}: bad name`);
    assert(typeof entry.notes === 'string' && entry.notes.length > 0, `entry ${entry.id}: bad notes`);
    assert(typeof entry.serversKey === 'string' && entry.serversKey.length > 0, `entry ${entry.id}: bad serversKey`);
  }
});

t('detectedTargets() is a subset of TARGETS', () => {
  const all = new Set(TARGETS.map((e) => e.id));
  const detected = detectedTargets();
  assert(Array.isArray(detected), 'detectedTargets() must return an array');
  for (const entry of detected) {
    assert(all.has(entry.id), `detectedTargets() returned an id not in TARGETS: ${entry.id}`);
    assert(TARGETS.includes(entry), `detectedTargets() entry ${entry.id} is not reference-equal to its TARGETS entry`);
  }
  assert(detected.length <= TARGETS.length, 'detectedTargets() cannot be larger than TARGETS');
});

t('the expected tool families are present (11 rows: 3 Claude Code profiles + 5 + 3 Kilo hosts)', () => {
  const ids = new Set(TARGETS.map((e) => e.id));
  for (const id of ['claude_code', 'claude_work', 'claude_personal', 'codex', 'antigravity', 'gemini_cli', 'cursor', 'kilo_vscode', 'kilo_cursor', 'kilo_cli', 'claude_desktop']) {
    assert(ids.has(id), `missing expected target id: ${id}`);
  }
  eq(TARGETS.length, 11, 'expected exactly 11 registry rows');
});

t('serverDef() uses T2\'s bridgePath(), not a repo-relative path', () => {
  const def = serverDef();
  eq(def.command, 'node', 'serverDef().command should be "node"');
  eq(def.args[0], bridgePath(), 'serverDef().args[0] must equal bridgehome.mjs bridgePath()');
  assert(def.args[0].startsWith('/'), 'bridge arg must be absolute');
  assert(!def.args[0].includes('Brain-claude-mem/bin/mcp-bridge.cjs'), 'serverDef() must not embed a repo-relative bridge path');
});

// ── the agentic-brain memory server (docs/specs/mcp-memory-server.md §8) ────

t('brainServerDef() points at bridgehome.mjs serverPath(), absolute, not repo-relative', () => {
  const def = brainServerDef();
  eq(def.command, 'node', 'brainServerDef().command should be "node"');
  eq(def.args[0], serverPath(), 'brainServerDef().args[0] must equal serverPath()');
  assert(def.args[0].startsWith('/'), 'server arg must be absolute');
  assert(def.args[0].endsWith('/server.cjs'), 'must name the stable server shim');
  assert(!def.args[0].includes('Brain-claude-mem/bin/'), 'must not embed a repo-relative path');
});

t('brainServerDef() honours AGENTIC_BRAIN_HOME (relocatable, no real home touched)', () => {
  const home = join(tmpdir(), `ab-${randomUUID()}`);
  const def = brainServerDef({ AGENTIC_BRAIN_HOME: home });
  eq(def.args[0], join(home, 'server.cjs'), 'env override ignored');
  assert(!existsSync(home), 'brainServerDef must not create anything on disk');
});

t('serverDef() still returns the BRIDGE def — the change is additive (doctor contract)', () => {
  eq(serverDef().args[0], bridgePath(), 'serverDef() must keep returning bridgePath()');
  assert(serverDef().args[0] !== brainServerDef().args[0], 'the two defs must be distinct files');
});

t('SERVER_NAME / LEGACY_SERVER_NAME are the two managed names', () => {
  eq(SERVER_NAME, 'agentic-brain', 'server name');
  eq(LEGACY_SERVER_NAME, 'claude-mem', 'legacy name');
  assert(SERVER_NAME !== LEGACY_SERVER_NAME, 'names must differ or supersede would self-delete');
});

t('supersedeSpec() targets claude-mem and only paths that are provably OURS', () => {
  const home = join(tmpdir(), `ab-${randomUUID()}`);
  const spec = supersedeSpec({ AGENTIC_BRAIN_HOME: home });
  eq(spec.name, LEGACY_SERVER_NAME, 'supersede target name');
  assert(Array.isArray(spec.paths) && spec.paths.length >= 2, 'paths must be a non-empty array');
  assert(spec.paths.includes(join(home, 'bridge.cjs')), 'must include the stable bridge shim');
  assert(spec.paths.some((p) => p.endsWith('/bin/mcp-bridge.cjs')), 'must include an engine-relative bin/mcp-bridge.cjs');
  for (const p of spec.paths) assert(p.startsWith('/'), `supersede path must be absolute: ${p}`);
  eq(new Set(spec.paths).size, spec.paths.length, 'paths must be de-duplicated');
  // The set is closed: nothing generic ever matches a user's own entry.
  for (const p of spec.paths) {
    assert(p.endsWith('bridge.cjs') || p.endsWith('mcp-bridge.cjs'), `unexpectedly broad supersede path: ${p}`);
  }
  assert(!existsSync(home), 'supersedeSpec must not create anything on disk');
});

t('supersedeSpec() never names the server shim (we would delete ourselves)', () => {
  const home = join(tmpdir(), `ab-${randomUUID()}`);
  const spec = supersedeSpec({ AGENTIC_BRAIN_HOME: home });
  assert(!spec.paths.includes(join(home, 'server.cjs')), 'server.cjs must never be a supersede path');
});

t('every target, including the Claude Code profiles, is a wiring target for agentic-brain', () => {
  // Regression: Claude Code rows used to be skipped as "native — verify only",
  // so no Claude Code session ever had brain_recall/brain_context.
  const r = wireMcp({ write: false });
  assert(r.ok, 'wireMcp dry-run must succeed');
  for (const row of r.results.filter((x) => x.installed)) {
    assert(!/verify only|never written/.test(row.action), `${row.id} must be a real wiring row, got: ${row.action}`);
  }
  for (const t of TARGETS.filter((t) => t.capture === 'native')) {
    assert(t.id.startsWith('claude_'), `unexpected native row ${t.id}`);
  }
});

t('Claude Code profiles wire <config dir>/.claude.json (what `claude mcp add --scope user` writes) and gate on the profile dir', () => {
  const byId = Object.fromEntries(TARGETS.map((e) => [e.id, e]));
  eq(byId.claude_code.configPath(), join(homedir(), '.claude.json'), 'claude_code config');
  eq(byId.claude_work.configPath(), join(homedir(), '.claude-work', '.claude.json'), 'claude_work config');
  eq(byId.claude_personal.configPath(), join(homedir(), '.claude-personal', '.claude.json'), 'claude_personal config');
  for (const id of ['claude_code', 'claude_work', 'claude_personal']) {
    assert(typeof byId[id].detect === 'function', `${id}.detect must exist — dirname(.claude.json) is $HOME, not a truthful gate`);
    assert(typeof byId[id].detect() === 'boolean', `${id}.detect() must return a boolean`);
    eq(byId[id].restart, 'next-launch', `${id} picks the server up in the next session`);
  }
});

t('claude_code capture is native, codex/antigravity are watcher, cursor/gemini_cli are ingest, claude_desktop is none', () => {
  const byId = Object.fromEntries(TARGETS.map((e) => [e.id, e]));
  eq(byId.claude_code.capture, 'native', 'claude_code capture');
  eq(byId.claude_work.capture, 'native', 'claude_work capture');
  eq(byId.claude_personal.capture, 'native', 'claude_personal capture');
  eq(byId.codex.capture, 'watcher', 'codex capture');
  eq(byId.antigravity.capture, 'watcher', 'antigravity capture');
  eq(byId.cursor.capture, 'ingest', 'cursor capture');
  // gemini_cli was 'none' pre-split; now 'ingest' — parseGemini runs on sync
  // for linked tools (gemini-antigravity-split.md §5).
  eq(byId.gemini_cli.capture, 'ingest', 'gemini_cli capture');
  eq(byId.claude_desktop.capture, 'none', 'claude_desktop capture');
});

t('Kilo rows: named per host, ingest capture, `mcp` servers key via the kilo shape, beta-marked, pushable', () => {
  const byId = Object.fromEntries(TARGETS.map((e) => [e.id, e]));
  eq(byId.kilo_vscode.name, 'Kilo Code (VS Code)', 'name'); eq(byId.kilo_cursor.name, 'Kilo Code (Cursor)', 'name'); eq(byId.kilo_cli.name, 'Kilo CLI', 'name');
  for (const id of ['kilo_vscode', 'kilo_cursor', 'kilo_cli']) {
    eq(byId[id].capture, 'ingest', `${id} capture`); eq(byId[id].mcpShape, 'kilo', `${id} mcp shape`); eq(byId[id].serversKey, 'mcp', `${id} servers key`);
    assert(typeof byId[id].detect === 'function' && typeof byId[id].detect() === 'boolean', `${id}.detect() must be a boolean-returning function`);
    assert(/BETA/.test(byId[id].notes), `${id} must be marked beta`); assert(byId[id].push !== null, `${id} has a push target`);
  }
});

t('display names updated per gemini-antigravity-split.md §5', () => {
  const byId = Object.fromEntries(TARGETS.map((e) => [e.id, e]));
  eq(byId.antigravity.name, 'Antigravity CLI (agy)', 'antigravity display name');
  eq(byId.gemini_cli.name, 'Gemini CLI (gemini)', 'gemini_cli display name');
});

t('gemini_cli and antigravity have a detect() override that is callable and boolean (value not asserted — machine-dependent)', () => {
  const byId = Object.fromEntries(TARGETS.map((e) => [e.id, e]));
  assert(typeof byId.gemini_cli.detect === 'function', 'gemini_cli.detect must be a function');
  assert(typeof byId.antigravity.detect === 'function', 'antigravity.detect must be a function');
  assert(typeof byId.gemini_cli.detect() === 'boolean', 'gemini_cli.detect() must return a boolean');
  assert(typeof byId.antigravity.detect() === 'boolean', 'antigravity.detect() must return a boolean');
});

t('cursor and claude_desktop have no global push; everyone else does', () => {
  const byId = Object.fromEntries(TARGETS.map((e) => [e.id, e]));
  eq(byId.cursor.push, null, 'cursor push must be null (per-repo AGENTS.md only)');
  eq(byId.claude_desktop.push, null, 'claude_desktop push must be null (no auto-loaded global file)');
  for (const id of ['claude_code', 'claude_work', 'claude_personal', 'codex', 'antigravity', 'gemini_cli']) {
    assert(byId[id].push !== null, `${id} should have a push target`);
  }
});

t('module import has no side effects (no fs writes occurred)', () => {
  // If wire-targets.mjs performed a write at import time, TARGETS/detectedTargets
  // would not be safely re-evaluable read-only; this just re-invokes the pure
  // surface a second time and expects identical structural results.
  const a = detectedTargets().map((e) => e.id);
  const b = detectedTargets().map((e) => e.id);
  eq(JSON.stringify(a), JSON.stringify(b), 'detectedTargets() must be deterministic / side-effect-free');
});

// ---------------------------------------------------------------------------
// binOnPath() edge cases + four-scenario gemini_cli/antigravity detection.
//
// MACHINE-INDEPENDENCE — read before touching this section.
//
// wire-targets.mjs's gemini_cli.detect() and antigravity.detect() are NOT
// injectable: they close over the real homedir() and, for gemini_cli, over
// binOnPath's default `env = process.env`. binOnPath() ALSO always scans
// /opt/homebrew/bin and /usr/local/bin *in addition* to whatever PATH is
// passed in — that EXTRA_BIN_DIRS scan is unconditional by design (see
// bin/lib/wire-targets.mjs). This machine genuinely has a `gemini` binary at
// /opt/homebrew/bin/gemini (confirmed in
// docs/specs/gemini-antigravity-split.md §1.1). That means a test which only
// fabricates a temp $HOME and then calls the real detectedTargets() would see
// gemini_cli detected in ALL FOUR scenarios below on this laptop — while the
// exact same test would see it detected only when creds are present on a CI
// box with no `gemini` binary anywhere. Same test, two different verdicts:
// that is false confidence, not coverage. We were explicitly warned off it.
//
// Instead we test the *documented formula* from gemini-antigravity-split.md
// §2 — `existsSync(oauth_creds.json) || existsSync(google_accounts.json) ||
// binOnPath('gemini')` — directly and deterministically:
//   - the creds half uses existsSync() against our own throwaway temp paths
//     (never touches ~/.gemini, so it is trivially machine-independent);
//   - the binary half uses the REAL exported binOnPath(name, env), called
//     with an injected `env` AND a synthetic, randomly-generated binary name
//     that cannot exist in /opt/homebrew/bin or /usr/local/bin on ANY
//     machine — this sidesteps the EXTRA_BIN_DIRS collision entirely,
//     because that scan only ever matches a file literally named `name`.
// This exercises the real binOnPath() code path and the real OR-shaped
// formula, and gives an identical PASS/FAIL result whether run on a laptop
// with Gemini CLI installed or on a CI box without it. Separately, a plain
// smoke test above calls the REAL (non-injectable) gemini_cli.detect() /
// antigravity.detect() and asserts only that they return a boolean —
// exercising the real closures without depending on their machine-specific
// value.

const FAKE_BIN = `wt_fixture_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wtt-'));
  try {
    return fn(dir);
  } finally {
    try { chmodSync(dir, 0o755); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeExecutable(dir, name) {
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\necho fixture\n');
  chmodSync(p, 0o755);
  return p;
}

t('binOnPath: a real executable file on an injected PATH is found', () => {
  withTempDir((base) => {
    const dir = join(base, 'bin');
    mkdirSync(dir);
    makeExecutable(dir, FAKE_BIN);
    assert(binOnPath(FAKE_BIN, { PATH: dir }) === true, 'executable on PATH should be found');
  });
});

t('binOnPath: a directory named after the binary does not count as found', () => {
  withTempDir((base) => {
    const dir = join(base, 'bin');
    mkdirSync(dir);
    mkdirSync(join(dir, FAKE_BIN)); // a directory, not an executable file
    assert(binOnPath(FAKE_BIN, { PATH: dir }) === false, 'a directory must not satisfy binOnPath');
  });
});

t('binOnPath: a dangling symlink does not count as found', () => {
  withTempDir((base) => {
    const dir = join(base, 'bin');
    mkdirSync(dir);
    symlinkSync(join(dir, 'nonexistent-target'), join(dir, FAKE_BIN));
    assert(binOnPath(FAKE_BIN, { PATH: dir }) === false, 'existsSync follows symlinks, so a dangling one reads as absent');
  });
});

t('binOnPath: a relative PATH entry is ignored, never resolved against cwd', () => {
  assert(binOnPath(FAKE_BIN, { PATH: '.' }) === false, 'relative PATH entries must be skipped by isAbsolute() guard');
});

t('binOnPath: empty PATH returns false for an uninstalled binary', () => {
  assert(binOnPath(FAKE_BIN, { PATH: '' }) === false, 'empty PATH plus no EXTRA_BIN_DIRS match should be false');
});

t('binOnPath: an unreadable directory does not throw', () => {
  withTempDir((base) => {
    const secretDir = join(base, 'secret');
    mkdirSync(secretDir);
    makeExecutable(secretDir, FAKE_BIN);
    chmodSync(secretDir, 0o000);
    let threw = false;
    try {
      binOnPath(FAKE_BIN, { PATH: secretDir });
    } catch {
      threw = true;
    } finally {
      chmodSync(secretDir, 0o755); // restore so withTempDir's rmSync can recurse
    }
    // Not asserting the return value: running as root bypasses the chmod
    // 0o000 restriction entirely, so the file would legitimately be found.
    // The only universally true claim is "never throws".
    assert(!threw, 'binOnPath must not throw on an unreadable directory entry');
  });
});

// Mirrors the §2 formula exactly, with the creds half backed by throwaway
// temp paths and the binary half backed by the real binOnPath() + FAKE_BIN.
function scenario({ creds, binary, config }) {
  return withTempDir((home) => {
    const geminiHome = join(home, '.gemini');
    mkdirSync(geminiHome, { recursive: true });
    if (creds) writeFileSync(join(geminiHome, 'oauth_creds.json'), ''); // empty marker, never real creds
    if (config) mkdirSync(join(geminiHome, 'config'), { recursive: true });
    const binDir = join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    if (binary) makeExecutable(binDir, FAKE_BIN);

    const credsPresent =
      existsSync(join(geminiHome, 'oauth_creds.json')) || existsSync(join(geminiHome, 'google_accounts.json'));
    const binaryPresent = binOnPath(FAKE_BIN, { PATH: binDir });
    return {
      gemini_cli: credsPresent || binaryPresent,
      antigravity: existsSync(join(geminiHome, 'config')),
    };
  });
}

t('scenario: both Gemini CLI and Antigravity installed => both detected', () => {
  const r = scenario({ creds: true, binary: true, config: true });
  assert(r.gemini_cli === true, 'gemini_cli should be detected (creds + binary present)');
  assert(r.antigravity === true, 'antigravity should be detected (config/ present)');
});

t('scenario: only Gemini CLI installed => gemini_cli detected, antigravity not', () => {
  const r = scenario({ creds: true, binary: false, config: false });
  assert(r.gemini_cli === true, 'gemini_cli should be detected (creds present)');
  assert(r.antigravity === false, 'antigravity should NOT be detected (no config/)');
});

t('scenario: only Antigravity installed => antigravity detected, gemini_cli not', () => {
  const r = scenario({ creds: false, binary: false, config: true });
  assert(r.antigravity === true, 'antigravity should be detected (config/ present)');
  assert(r.gemini_cli === false, 'gemini_cli should NOT be detected (no creds, no matching binary)');
});

t('scenario: neither installed => neither detected', () => {
  const r = scenario({ creds: false, binary: false, config: false });
  assert(r.gemini_cli === false, 'gemini_cli should NOT be detected');
  assert(r.antigravity === false, 'antigravity should NOT be detected');
});

// ── Regression: background services launch CLIs by absolute path ────────────
// launchd/GUI processes run with PATH=/usr/bin:/bin:/usr/sbin:/sbin; Claude Code's
// standard install puts `claude` in ~/.local/bin. The "is it installed?" check
// looked there but the launch used the bare name → `spawnSync claude ENOENT`.
t('binPath finds a CLI in ~/.local/bin under a launchd-style PATH (new-user install)', () => {
  const home = mkdtempSync(join(tmpdir(), 'binpath-'));
  try {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const stub = join(home, '.local', 'bin', 'claude');
    writeFileSync(stub, '#!/bin/sh\necho ok\n'); chmodSync(stub, 0o755);
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import('${new URL('../bin/lib/wire-targets.mjs', import.meta.url).href}').then(m => process.stdout.write(String(m.binPath('claude'))))`],
      { env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', BRAIN_TEST: '1' }, encoding: 'utf8' });
    assert(out === stub, `expected ${stub}, got ${out}`);
    // and the resolved path actually launches under that same PATH
    const ran = execFileSync(out, [], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).trim();
    assert(ran === 'ok', 'resolved CLI must run');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
t('no code launches an AI CLI by bare name (must go through binPath)', () => {
  const bad = [];
  for (const f of ['bin/lib/agent.mjs', 'bin/lib/distill.mjs', 'ui/server.mjs']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    for (const m of src.matchAll(/(execFile|spawn)(Sync)?\(\s*(c|cli|tool|t)\.bin\b/g)) bad.push(`${f}: ${m[0]}`);
    for (const m of src.matchAll(/(execFile|spawn)(Sync)?\(\s*['"](claude|codex|gemini|agy)['"]/g)) bad.push(`${f}: ${m[0]}`);
  }
  assert(!bad.length, 'bare-name launches: ' + bad.join(' | '));
});

console.log(`\nwire-targets-test: ${pass} passed, ${fail} failed\n`);
for (const [status, name, msg] of results) {
  console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}${msg ? `\n      ${msg}` : ''}`);
}
if (fail > 0) process.exit(1);
