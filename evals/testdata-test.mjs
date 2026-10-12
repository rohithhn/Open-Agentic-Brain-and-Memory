#!/usr/bin/env node
// Tests for test-fixture hygiene:
//   - bin/lib/testguard.mjs: a test run (BRAIN_TEST=1) can never open the real
//     store for write — wired into db.mjs openDb and store.mjs openStore/READY;
//   - bin/lib/testdata.mjs: the explicit fixture-project patterns (and ingest
//     skipping the auto ones);
//   - `brain clean --test-data` (clean.mjs): dry run by default, --apply only
//     behind a verified VACUUM INTO backup — and the clean sticks: the importer
//     (claude-mem pull / cloud merge), the fresh-pull copy strip and ingest all
//     skip what it removed.
//
//   node evals/testdata-test.mjs
//
// SAFETY: every DB and $HOME here is synthetic, under $SCRATCHPAD or $TMPDIR.
// The guard's refusal is proven on a FAKE "real" home (BRAIN_TEST_PROTECT_HOME,
// which only ever adds protection) — the real ~/.claude-brain is never opened.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync, copyFileSync, statSync, linkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { inTestEnv, isRealStorePath, assertWritableInThisEnv, protectedStoreDirs, fileUriToPath } from '../bin/lib/testguard.mjs';
import {
  TEST_DATA_PATTERNS, testDataPattern, isTestDataProject, isAutoTestDataProject, readCleanedProjects,
} from '../bin/lib/testdata.mjs';
import { openDb } from '../bin/lib/db.mjs';
import { openStore, markStoreReady } from '../bin/lib/store.mjs';
import { cleanTestData, formatTestDataReport, findTestData, cleanSelfCapture, stripCopy } from '../bin/lib/clean.mjs';
import { importClaudeMem } from '../bin/lib/import-claude-mem.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAIN = join(REPO, 'bin', 'brain.mjs');
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `testdata-test-${process.pid}`);
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
function throwsLike(fn, re, msg) {
  try { fn(); } catch (e) { assert(re.test(e.message), `${msg}: wrong error: ${e.message}`); return; }
  throw new Error(`${msg}: did not throw`);
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ── 1. the guard ─────────────────────────────────────────────────────────────
await t('guard: this process is a test run (evals/test-env.mjs)', () => {
  eq(process.env.BRAIN_TEST, '1', 'BRAIN_TEST');
  assert(inTestEnv(), 'inTestEnv()');
  assert(!inTestEnv({}), 'empty env is not a test run');
  assert(inTestEnv({ NODE_TEST_CONTEXT: 'child-v8' }), 'node --test children count');
});
await t('guard: real-store paths are recognised under the passwd home, never a fake HOME', () => {
  const real = userInfo().homedir;
  assert(isRealStorePath(join(real, '.claude-brain', 'brain.db')), 'real brain.db');
  assert(isRealStorePath(join(real, '.claude-brain', 'READY')), 'real READY');
  assert(isRealStorePath(join(real, '.claude-mem', 'claude-mem.db')), 'real claude-mem.db');
  assert(isRealStorePath(join(real, '.claude-brain', 'sub', '..', 'brain.db')), 'dot-dot normalised');
  assert(!isRealStorePath(join(ROOT, 'h', '.claude-brain', 'brain.db')), 'fake HOME store must be allowed');
  assert(!isRealStorePath(join(real, '.claude-brain-backup', 'x.db')), 'sibling lookalike dir');
  assert(!isRealStorePath(':memory:') && !isRealStorePath('file:/x?mode=ro') && !isRealStorePath(''), 'specials');
  // A symlink into the protected dir is still the protected dir.
  const fake = join(ROOT, 'fake-real');
  mkdirSync(join(fake, '.claude-brain'), { recursive: true });
  symlinkSync(join(fake, '.claude-brain'), join(ROOT, 'link-to-store'));
  assert(isRealStorePath(join(ROOT, 'link-to-store', 'brain.db'), fake), 'symlinked path');
  // BRAIN_TEST_PROTECT_HOME only adds: the passwd home stays protected.
  const dirs = protectedStoreDirs(undefined, { BRAIN_TEST_PROTECT_HOME: fake });
  assert(dirs.some((d) => d.endsWith(join(fake.split('/').pop(), '.claude-brain'))), 'extra home added');
  assert(dirs.length === 4, `passwd home kept alongside (${dirs.length})`);
});
await t('guard: file: URIs are normalised before the comparison (every spelling of the real store is refused)', () => {
  const fake = join(ROOT, 'fake-real-uri');
  mkdirSync(join(fake, '.claude-brain'), { recursive: true });
  const abs = join(fake, '.claude-brain', 'brain.db');
  const env = { BRAIN_TEST: '1' };
  const real = [
    `file:${abs}`, `file://${abs}`, `file://localhost${abs}`, `FILE://LOCALHOST${abs}`,
    `file:${abs}?mode=rwc`, `file:${abs}?mode=ro`, `file:${abs}?vfs=unix&cache=shared#frag`,
    `file:${abs}?x=/../../elsewhere.db`,
    `file:${join(fake, '.claude-brain', 'sub', '..', 'brain.db')}`,
    `file:${join(fake, '.claude-brain').replace(/\/(?=[^/]*$)/, '/./')}/brain.db`,
    `file:${abs.replace('.claude-brain', '%2Eclaude-brain')}`,        // percent-escaped dot
    `file:${abs.replace('brain.db', 'brain%2Edb')}`,
    `file:${abs}%00ignored`,                                          // NUL ends the name
    `file:${join(fake, '.claude-brain') + '/../.claude-brain/brain.db'}`,
  ];
  for (const u of real) {
    assert(isRealStorePath(u, fake, env), `refused: ${u}`);
    throwsLike(() => assertWritableInThisEnv(u, { env, home: fake }), /Refusing to open/, u);
  }
  // Not the real store: other dirs, lookalikes, non-local authority, memory, junk.
  const other = join(ROOT, 'elsewhere', 'x.db');
  for (const u of [`file:${other}`, `file://${other}`, `file:${other}?mode=rwc`, `file:${join(fake, '.claude-brain-backup', 'x.db')}`,
    `file:${abs.replace('.claude-brain', '.claude-brain%2Fx').replace('%2Fx', 'x')}`, // ".claude-brainx" lookalike
    'file::memory:', 'file:', 'file://', 'file://evil.example' + abs, 'file:?mode=memory', ':memory:']) {
    assert(!isRealStorePath(u, fake, env), `allowed: ${u}`);
  }
  eq(fileUriToPath(`file://localhost${abs}?a=b#c`), abs, 'authority + query + fragment stripped');
  eq(fileUriToPath('file:/a%20b/c%C3%A9.db'), '/a b/cé.db', 'percent-decoded as UTF-8');
  eq(fileUriToPath('file://evil/x'), null, 'non-local authority names no file');
  eq(fileUriToPath('/plain/path'), '/plain/path', 'a plain path passes through');
  // A relative URI resolves against the cwd, like SQLite does.
  const cwd = process.cwd();
  try {
    process.chdir(join(fake, '.claude-brain'));
    assert(isRealStorePath('file:brain.db?mode=rwc', fake, env), 'relative file: URI inside the store dir');
  } finally { process.chdir(cwd); }
});
await t('guard: case-variant spellings and the /System/Volumes/Data firmlink of the protected store are refused (filesystem identity)', () => {
  const fake = join(ROOT, 'fake-real-case');
  mkdirSync(join(fake, '.claude-brain'), { recursive: true });
  const abs = join(fake, '.claude-brain', 'brain.db');
  writeFileSync(abs, 'x');
  const env = { BRAIN_TEST: '1' };
  // Does this volume ignore case? (APFS default does; Linux CI does not.)
  const insensitive = existsSync(join(fake, '.CLAUDE-BRAIN'));
  const variants = [
    join(fake, '.CLAUDE-BRAIN', 'brain.db'), join(fake, '.Claude-Brain', 'brain.db'),
    join(fake, '.CLAUDE-BRAIN', 'not-yet-created.db'),
    `file:${join(fake, '.Claude-Brain', 'brain.db')}?mode=rw`, `file:${join(fake, '.CLAUDE-BRAIN', 'brain.db')}`,
    join(fake, '.CLAUDE-BRAIN'),
  ];
  for (const v of variants) {
    // The folded-string comparison refuses these on every filesystem (safe side);
    // on a case-insensitive one the identity check would catch them too.
    assert(isRealStorePath(v, fake, env), `refused: ${v}`);
    throwsLike(() => assertWritableInThisEnv(v, { env, home: fake }), /Refusing to open/, v);
  }
  // A hard link to the store file, made outside the protected dir, is the same file.
  const hl = join(ROOT, 'hardlink-to-brain.db');
  linkSync(abs, hl);
  assert(isRealStorePath(hl, fake, env), 'hard link to the store file');
  // Firmlink spelling (macOS only: /System/Volumes/Data/<path> is the same tree).
  const firm = '/System/Volumes/Data' + realpathSync.native(abs);
  if (existsSync(firm)) {
    assert(isRealStorePath(firm, fake, env), `firmlink refused: ${firm}`);
    assert(isRealStorePath(`file:${firm}?mode=rw`, fake, env), 'firmlink file: URI');
    assert(isRealStorePath('/System/Volumes/Data' + realpathSync.native(join(fake, '.claude-brain')) + '/new.db', fake, env), 'firmlink, new file');
  }
  // Unrelated paths stay allowed (a case-variant of an unrelated dir, a sibling lookalike).
  assert(!isRealStorePath(join(ROOT, 'Elsewhere', 'x.db'), fake, env), 'unrelated path allowed');
  assert(!isRealStorePath(join(fake, '.claude-brain-backup', 'x.db'), fake, env), 'lookalike allowed');
  void insensitive;
});
await t('guard: openDb / openStore refuse a file: URI to the protected store', () => {
  const fake = join(ROOT, 'fake-real-uri-2');
  const store = join(fake, '.claude-brain', 'brain.db');
  openStore({ path: store }).close();
  const before = sha(store);
  process.env.BRAIN_TEST_PROTECT_HOME = fake;
  try {
    throwsLike(() => openStore({ path: `file:${store}?mode=rwc` }), /Refusing to open/, 'openStore file: URI');
    throwsLike(() => openDb(`file://localhost${store}`, { create: true }), /Refusing to open/, 'openDb file: URI');
  } finally { delete process.env.BRAIN_TEST_PROTECT_HOME; }
  eq(sha(store), before, 'protected store bytes changed');
});
await t('guard: assertWritableInThisEnv throws only in a test env', () => {
  const fake = join(ROOT, 'fake-real');
  const p = join(fake, '.claude-brain', 'brain.db');
  throwsLike(() => assertWritableInThisEnv(p, { env: { BRAIN_TEST: '1' }, home: fake }), /Refusing to open .* for write/, 'test env');
  assertWritableInThisEnv(p, { env: {}, home: fake }); // not a test run → allowed
  assertWritableInThisEnv(join(ROOT, 'elsewhere.db'), { env: { BRAIN_TEST: '1' }, home: fake });
});

// Wired into the real openers: prove it on a fake "real" home, in-process.
await t('guard: openDb / openStore / markStoreReady refuse the protected store; read-only still works', () => {
  const fake = join(ROOT, 'fake-real-2');
  const store = join(fake, '.claude-brain', 'brain.db');
  // Built while the extra protection is off (a fixture, not the guarded run).
  openStore({ path: store }).close();
  const before = sha(store);
  process.env.BRAIN_TEST_PROTECT_HOME = fake;
  try {
    throwsLike(() => openStore({ path: store }), /Refusing to open/, 'openStore write');
    throwsLike(() => openDb(store), /Refusing to open/, 'openDb write');
    throwsLike(() => openDb(join(fake, '.claude-brain', 'new.db'), { create: true }), /Refusing to open/, 'openDb create');
    throwsLike(() => markStoreReady(store), /Refusing to open/, 'READY marker');
    assert(!existsSync(join(fake, '.claude-brain', 'new.db')), 'refused create left a file');
    assert(!existsSync(join(fake, '.claude-brain', 'READY')), 'refused READY left a file');
    const ro = openDb(store, { readonly: true });
    ro.close();
    openStore({ path: store, readonly: true }).close();
  } finally { delete process.env.BRAIN_TEST_PROTECT_HOME; }
  eq(sha(store), before, 'protected store bytes changed');
});
await t('guard: a CLI write from a test run that forgot its temp HOME is refused (child, brain remember)', () => {
  // The child's HOME *is* the protected home — the exact "harness forgot to
  // fake HOME" shape: an initialised store is there, and the write must fail
  // loudly without changing a byte of it.
  const fake = join(ROOT, 'fake-real-3');
  const store = join(fake, '.claude-brain', 'brain.db');
  openStore({ path: store }).close();
  writeFileSync(join(fake, '.claude-brain', 'READY'), 'fixture\n');
  const before = sha(store);
  const r = spawnSync(process.execPath, [BRAIN, 'remember', '--title', 'fixture leak probe', '--type', 'discovery',
    '--project', 'e2e-probe-999', '--fact', 'must never land'], {
    env: { ...process.env, HOME: fake, BRAIN_TEST: '1', BRAIN_TEST_PROTECT_HOME: fake, BRAIN_NO_ECONOMICS: '1' },
    encoding: 'utf8', timeout: 30000,
  });
  assert(r.status !== 0, `remember should fail, exited ${r.status}: ${r.stdout}`);
  assert(/Refusing to open|could not save the observation/.test(r.stdout + r.stderr), `no failure message: ${r.stdout} ${r.stderr}`);
  eq(sha(store), before, 'protected store changed');
  const db = new DatabaseSync(store, { readOnly: true });
  try { eq(db.prepare('SELECT COUNT(*) n FROM observations').get().n, 0, 'row landed'); } finally { db.close(); }
  // Control: the identical command with only the extra protection removed
  // succeeds — so the refusal above was the guard, not some other failure.
  const ctl = spawnSync(process.execPath, [BRAIN, 'remember', '--title', 'fixture leak probe', '--type', 'discovery',
    '--project', 'e2e-probe-999', '--fact', 'must never land'], {
    env: { ...process.env, HOME: fake, BRAIN_TEST: '1', BRAIN_NO_ECONOMICS: '1' }, encoding: 'utf8', timeout: 30000,
  });
  eq(ctl.status, 0, `control remember failed: ${ctl.stdout} ${ctl.stderr}`);
});
await t('guard: every eval imports test-env.mjs first; harness scripts export BRAIN_TEST', () => {
  const evals = readdirSync(join(REPO, 'evals')).filter((f) => f.endsWith('.mjs') && f !== 'test-env.mjs');
  for (const f of evals) {
    const src = readFileSync(join(REPO, 'evals', f), 'utf8');
    const first = src.split('\n').find((l) => l.startsWith('import '));
    assert(first && first.includes('./test-env.mjs'), `${f}: first import must be ./test-env.mjs`);
  }
  // docs/specs/ harnesses are private-repo only; a public clone checks what it ships.
  for (const f of ['evals/sandbox/lib.sh', 'docs/specs/new-user-acceptance.sh', 'docs/specs/auto-wiring-acceptance.sh']) {
    if (!existsSync(join(REPO, f))) continue;
    assert(/^export BRAIN_TEST=1$/m.test(readFileSync(join(REPO, f), 'utf8')), `${f}: export BRAIN_TEST=1`);
  }
});
await t('guard: children spawned with a scratch env still carry BRAIN_TEST (env -i, or an env object that sets HOME)', () => {
  // An exported BRAIN_TEST does not survive `env -i` or a hand-built env
  // object, so each such spawn has to set it itself.
  const bad = [];
  const walk = (d) => readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.sh') ? [join(d, e.name)] : []));
  for (const f of [...walk(join(REPO, 'evals')), ...walk(join(REPO, 'docs', 'specs'))]) {
    // Logical lines: fold backslash continuations, so a multi-line env -i counts once.
    readFileSync(f, 'utf8').replace(/\\\n/g, ' ').split('\n').forEach((l) => {
      if (/\benv -i\b/.test(l) && !/\bBRAIN_TEST=1\b/.test(l)) bad.push(`${f.slice(REPO.length + 1)}: ${l.trim().slice(0, 90)}`);
    });
  }
  for (const f of readdirSync(join(REPO, 'evals')).filter((x) => x.endsWith('.mjs'))) {
    const src = readFileSync(join(REPO, 'evals', f), 'utf8');
    for (const m of src.matchAll(/\benv\s*[:=]\s*\{([^{}]*)\}/gi)) {
      // A HOME-setting env object must set BRAIN_TEST, or spread one that does
      // (process.env — test-env.mjs set it — or the file's own checked ENV).
      if (/\bHOME\b/.test(m[1]) && !/BRAIN_TEST|\.\.\.process\.env\b|\.\.\.ENV\b/.test(m[1])) bad.push(`evals/${f}: ${m[0].slice(0, 90)}`);
    }
  }
  eq(bad.join('\n'), '', 'spawns that drop BRAIN_TEST');
});

// ── 2. patterns ──────────────────────────────────────────────────────────────
await t('patterns: the fixture shapes seen in a real store match, by the expected pattern', () => {
  const cases = {
    'e2e-probe-001': 'e2e-probe', 'e2e-probe-004': 'e2e-probe',
    'proj-run-context-1787947600290': 'proj-run-context',
    'proj-run-context-inherited-1788095444753': 'proj-run-context',
    'proj-run-context-existing-1787989076757': 'proj-run-context',
    'proj-run-context-project-only-1788083801880': 'proj-run-context',
    'od-conn-test-YCHuUi': 'od-fixture', 'od-accept-code': 'od-fixture', 'od-code-fresh': 'od-fixture',
    'od-code-entry-demo': 'od-fixture', 'od-a11y-target': 'od-fixture',
    '1f2e3d4c-5b6a-4789-8abc-def012345678': 'uuid-dir',
  };
  for (const [name, id] of Object.entries(cases)) eq(testDataPattern(name), id, name);
  // Strength: the named fixture shapes are skipped at capture; a bare UUID is
  // clean-only (a real working dir could be named that way).
  for (const name of ['e2e-probe-001', 'proj-run-context-1787947600290', 'od-accept-code']) assert(isAutoTestDataProject(name), `${name} auto`);
  assert(!isAutoTestDataProject('1f2e3d4c-5b6a-4789-8abc-def012345678'), 'uuid-dir must not be auto-skipped');
  assert(!isAutoTestDataProject('app') && !isAutoTestDataProject(null), 'non-fixtures');
});
await t('patterns: real and merely test-ish project names never match (conservative)', () => {
  for (const name of ['Brain-claude-mem', 'alexmorgan', 'tmp', 'beta', 'components', 'home', 'scratchpad',
    'real-claude-test', 'claude-real-run', 'Opendesign', 'brand-product-b5f215', 'od-design-system', 'od-',
    'scratch-2026-01-15-c0ffee', 'Example Testing Platform/agent-a000bc41ae8559cc5',
    'e2e-probe', 'e2e-probe-x', 'my-e2e-probe-001', 'proj-run-context', 'proj-run-context-12345',
    '1F2E3D4C-5B6A-4789-8ABC-DEF012345678', '1f2e3d4c-5b6a-4789-8abc-def012345678-app', 'plugin-example-plugin-plugin-connector-2q',
    '', null, undefined, 42]) {
    assert(!isTestDataProject(name), `${JSON.stringify(name)} must not match`);
  }
  for (const p of TEST_DATA_PATTERNS) assert(p.re.source.startsWith('^') && p.re.source.endsWith('$'), `${p.id} anchored`);
});

// ── 3. ingest skips fixture runs (child with HOME=<fake>) ────────────────────
const line = (o) => JSON.stringify(o);
function transcript(cwd, sid, prompt) {
  return [
    line({ type: 'user', sessionId: sid, timestamp: '2026-08-29T10:00:00Z', cwd, message: { role: 'user', content: prompt } }),
    line({ type: 'assistant', sessionId: sid, timestamp: '2026-08-29T10:00:05Z', cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n') + '\n';
}
await t('ingest(): auto fixture projects skipped (testSkipped); a bare-UUID dir is kept until clean --apply removes it, then stays out', () => {
  const home = join(ROOT, 'h-ingest');
  const add = (slug, cwd, sid, prompt) => {
    const d = join(home, '.claude', 'projects', slug);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${sid}.jsonl`), transcript(cwd, sid, prompt));
  };
  add('-Users-x-code-app', '/Users/x/code/app', 'aaaaaaaa-0000-4000-8000-000000000001', 'tighten the retry budget in the sync worker');
  add('-private-tmp-e2e-probe-001', '/private/tmp/e2e-probe-001', 'aaaaaaaa-0000-4000-8000-000000000002', 'Reply with only: ok');
  add('-private-tmp-1f2e3d4c-5b6a-4789-8abc-def012345678', '/private/tmp/1f2e3d4c-5b6a-4789-8abc-def012345678',
    'aaaaaaaa-0000-4000-8000-000000000003', 'Reply with only: ok');
  const store = join(home, '.claude-brain', 'brain.db');
  openStore({ path: store }).close();
  writeFileSync(join(home, '.claude-brain', 'READY'), 'test\n');
  const child = `
    const { MEMORY_DB } = await import(${JSON.stringify(join(REPO, 'bin/lib/paths.mjs'))});
    if (!MEMORY_DB.startsWith(${JSON.stringify(home)})) { console.log('UNSAFE ' + MEMORY_DB); process.exit(3); }
    const { ingest } = await import(${JSON.stringify(join(REPO, 'bin/lib/ingest.mjs'))});
    console.log(JSON.stringify(await ingest({ only: ['claude'] })));`;
  const run = () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert(r.status === 0, `child exited ${r.status}: ${r.stdout} ${r.stderr}`);
    return JSON.parse(r.stdout.trim().split('\n').pop()).claude;
  };
  const projects = () => {
    const db = new DatabaseSync(store, { readOnly: true });
    try { return db.prepare('SELECT DISTINCT project p FROM observations ORDER BY 1').all().map((x) => x.p).join(','); }
    finally { db.close(); }
  };
  const res = run();
  eq(res.found, 3, 'found');
  eq(res.testSkipped, 1, 'testSkipped (e2e-probe only)');
  eq(res.sessions, 2, 'sessions inserted (app + the uuid dir)');
  eq(projects(), '1f2e3d4c-5b6a-4789-8abc-def012345678,app', 'uuid dir captured, probe not');
  // The operator removes it by name; the transcript is still on disk, but the
  // next ingest must not put it back.
  const c = cleanTestData({ dbPath: store, apply: true, backupDir: join(ROOT, 'h-ingest-bk') });
  eq(c.byProject.map((p) => p.project).join(','), '1f2e3d4c-5b6a-4789-8abc-def012345678', 'clean found the uuid dir');
  eq(projects(), 'app', 'after clean');
  const again = run();
  eq(again.testSkipped, 2, 'removed uuid dir now skipped too');
  eq(again.sessions, 0, 'nothing re-inserted');
  eq(projects(), 'app', 'clean stuck past the next ingest');
});

// ── 4. brain clean --test-data ───────────────────────────────────────────────
function buildStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = openStore({ path });
  const sess = db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,?,'completed')`);
  const obs = db.prepare(`INSERT INTO observations (memory_session_id, project, text, narrative, type, title, created_at, created_at_epoch, content_hash, generated_by_model) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const pr = db.prepare(`INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch) VALUES (?,?,?,?,?)`);
  const sum = db.prepare(`INSERT INTO session_summaries (memory_session_id, project, request, prompt_number, created_at, created_at_epoch) VALUES (?,?,?,?,?,?)`);
  const st = db.prepare(`INSERT INTO capture_state (transcript_path, status) VALUES (?,?)`);
  // Real work — must all survive.
  sess.run('real-1', 'claude:real-1', 'app', 'claude', 'retry budget', 'd', 1);
  obs.run('claude:real-1', 'app', 'user: retry budget', null, 'session', 'retry budget', 'd', 1, 'r1', 'claude');
  obs.run('claude:real-1', 'app', null, 'Capped the backoff', 'bugfix', 'Capped retry backoff', 'd', 1, 'r2', 'brain/claude:haiku');
  pr.run('real-1', 0, 'retry budget', 'd', 1);
  sum.run('claude:real-1', 'app', 'retry work', 1, 'd', 1);
  st.run('distill:claude:real-1', 'done');
  // Test-ish but NOT a fixture pattern — must survive.
  sess.run('tmp-1', 'claude:tmp-1', 'tmp', 'claude', 'Reply with exactly: OK', 'd', 2);
  obs.run('claude:tmp-1', 'tmp', 'user: Reply with exactly: OK', null, 'session', 'Reply with exactly: OK', 'd', 2, 't1', 'claude');
  // Fixtures.
  sess.run('probe-1', 'claude:probe-1', 'e2e-probe-001', 'claude', 'Reply with only: ok', 'd', 3);
  obs.run('claude:probe-1', 'e2e-probe-001', 'user: zebrafixture probe', null, 'session', 'Reply with only: ok', 'd', 3, 'p1', 'claude');
  obs.run('claude:probe-1', 'e2e-probe-001', null, 'zebrafixture distilled', 'discovery', 'Probe distilled', 'd', 3, 'p2', 'brain/claude:haiku');
  pr.run('probe-1', 0, 'Reply with only: ok', 'd', 3);
  sum.run('claude:probe-1', 'e2e-probe-001', 'probe', 1, 'd', 3);
  st.run('distill:claude:probe-1', 'done');
  st.run('/Users/x/.claude/projects/-private-tmp-e2e-probe-001/probe-1.jsonl', 'done'); // ingest bookmark: kept
  sess.run('01a049fb', 'codex:01a049fb', 'proj-run-context-inherited-1787947600796', 'codex', 'Codex session', 'd', 4);
  obs.run('codex:01a049fb', 'proj-run-context-inherited-1787947600796', 'user: zebrafixture codex', null, 'session', 'Codex session', 'd', 4, 'c1', 'codex');
  pr.run('01a049fb', 0, 'run context', 'd', 4);
  for (let i = 0; i < 2; i++) {
    sess.run(`uu-${i}`, `claude:uu-${i}`, '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'claude', 'charter', 'd', 5);
    obs.run(`claude:uu-${i}`, '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'user: zebrafixture charter', null, 'session', 'charter', 'd', 5, `u${i}`, 'claude');
  }
  // An orphan summary for a fixture project with no session row.
  sum.run('claude:gone', 'od-accept-code', 'orphan', 1, 'd', 6);
  db.close();
}
const counts = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const n = (tbl) => db.prepare(`SELECT COUNT(*) n FROM ${tbl}`).get().n;
    return { obs: n('observations'), sess: n('sdk_sessions'), prompts: n('user_prompts'), sums: n('session_summaries'), state: n('capture_state') };
  } finally { db.close(); }
};
const EXPECTED = { observations: 5, sessions: 4, prompts: 2, summaries: 2, state: 1 };

await t('clean --test-data: dry run is read-only, reports totals by project and pattern', () => {
  const store = join(ROOT, 'clean-dry', 'brain.db');
  buildStore(store);
  const before = sha(store);
  const r = cleanTestData({ dbPath: store });
  eq(r.applied, false, 'applied');
  eq(JSON.stringify(r.totals), JSON.stringify(EXPECTED), 'totals');
  const names = r.byProject.map((p) => p.project).sort();
  eq(names.join(','), ['0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'e2e-probe-001', 'od-accept-code', 'proj-run-context-inherited-1787947600796'].join(','), 'projects');
  eq(r.byProject.find((p) => p.project === 'od-accept-code').pattern, 'od-fixture', 'pattern carried');
  assert(!names.includes('app') && !names.includes('tmp'), 'real / test-ish projects must not appear');
  eq(sha(store), before, 'dry run changed the DB');
  assert(!existsSync(join(dirname(store), 'backups')), 'dry run made a backup dir');
  const txt = formatTestDataReport(r);
  assert(/dry run/.test(txt) && /--apply/.test(txt) && /e2e-probe — /.test(txt) && /uuid-dir — /.test(txt), `report text:\n${txt}`);
});
await t('clean --test-data --apply: verified backup, removes only fixtures, FTS clean, keeps ingest bookmarks, idempotent', () => {
  const store = join(ROOT, 'clean-apply', 'brain.db');
  buildStore(store);
  const before = counts(store);
  const r = cleanTestData({ dbPath: store, apply: true });
  eq(r.applied, true, 'applied');
  assert(r.backupPath && existsSync(r.backupPath) && /pre-clean-test-data-/.test(r.backupPath), `backup file ${r.backupPath}`);
  eq(JSON.stringify(counts(r.backupPath)), JSON.stringify(before), 'backup holds the pre-clean store');
  eq(JSON.stringify(r.totals), JSON.stringify(EXPECTED), 'totals');
  eq(JSON.stringify(counts(store)), JSON.stringify({ obs: 3, sess: 2, prompts: 1, sums: 1, state: 2 }), 'after');
  eq(r.remaining, 0, 'remaining');
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    eq(db.prepare("SELECT COUNT(*) n FROM observations_fts WHERE observations_fts MATCH 'zebrafixture'").get().n, 0, 'fixture text still searchable');
    eq(db.prepare("SELECT COUNT(*) n FROM observations_fts WHERE observations_fts MATCH 'backoff'").get().n, 1, 'real text lost from FTS');
    eq(db.prepare("SELECT COUNT(*) n FROM session_summaries_fts WHERE session_summaries_fts MATCH 'probe'").get().n, 0, 'summary FTS still has fixture');
    const state = db.prepare('SELECT transcript_path p FROM capture_state ORDER BY 1').all().map((x) => x.p);
    assert(state.includes('distill:claude:real-1'), 'real distill state kept');
    assert(state.some((p) => p.endsWith('probe-1.jsonl')), 'ingest bookmark must be kept (else re-ingested)');
    assert(!state.includes('distill:claude:probe-1'), 'fixture distill state removed');
    eq(db.prepare("SELECT group_concat(DISTINCT project) p FROM (SELECT project FROM observations ORDER BY project)").get().p, 'app,tmp', 'kept projects');
  } finally { db.close(); }
  const again = cleanTestData({ dbPath: store, apply: true });
  eq(again.backupPath, null, 'second apply makes no backup');
  eq(Object.values(again.totals).reduce((a, b) => a + b, 0), 0, 'nothing left to clean');
  // The shared runner did not change the self-capture mode's contract.
  eq(cleanSelfCapture({ dbPath: store }).applied, false, 'self-capture dry run still read-only');
});
await t('clean --test-data --apply: backup is private (0600) and removed names are recorded', () => {
  const store = join(ROOT, 'clean-mode', 'brain.db');
  buildStore(store);
  const r = cleanTestData({ dbPath: store, apply: true });
  eq((statSync(r.backupPath).mode & 0o777).toString(8), '600', 'backup mode');
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    eq([...readCleanedProjects(db)].sort().join(','), ['0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'e2e-probe-001', 'od-accept-code',
      'proj-run-context-inherited-1787947600796'].join(','), 'recorded names');
  } finally { db.close(); }
  assert(/remembered/.test(formatTestDataReport(r)), 'report says the names are remembered');
});
// The review's BLOCKER, end to end: `brain sync` re-reads the whole cloud blob
// (and claude-mem) with resume:false through importClaudeMem. The clean has to
// survive that.
await t('clean then merge (sync): the removed fixture rows stay gone; new real rows still merge', () => {
  const dir = join(ROOT, 'clean-merge');
  const local = join(dir, 'brain.db');
  buildStore(local);
  const cloud = join(dir, 'cloud.db'); // the other device's / pre-clean blob
  copyFileSync(local, cloud);
  const cdb = new DatabaseSync(cloud);
  cdb.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status) VALUES ('real-2','claude:real-2','app','claude','add a cache','d',9,'completed')`).run();
  cdb.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch, content_hash) VALUES ('claude:real-2','app','user: add a cache','session','add a cache','d',9,'r9')`).run();
  cdb.close();
  const cleaned = cleanTestData({ dbPath: local, apply: true, backupDir: join(dir, 'bk') });
  eq(cleaned.remaining, 0, 'clean');
  const after = counts(local);
  // Dry run reports what it would leave out (every pattern: the uuid dir is in
  // the destination's removed list).
  const dry = importClaudeMem({ source: cloud, dest: local });
  eq(dry.tables.find((x) => x.table === 'observations').testDataSkipped, EXPECTED.observations, 'dry run: obs left out');
  // Exactly the sync call (bundle.mjs mergeDbInto, brain.mjs claude-mem pull).
  const m = importClaudeMem({ source: cloud, dest: local, apply: true, resume: false, verify: true, touchReady: false });
  eq(m.testDataSkipped, EXPECTED.observations + EXPECTED.sessions + EXPECTED.prompts + EXPECTED.summaries, 'rows left out');
  assert(m.verification && m.verification.ok, `verification must still pass: ${JSON.stringify(m.verification?.checks.filter((x) => !x.ok))}`);
  const back = cleanTestData({ dbPath: local }).totals;
  eq(back.observations + back.sessions + back.prompts + back.summaries, 0, 'fixture rows came back');
  const now = counts(local);
  eq(now.obs, after.obs + 1, 'only the new real observation merged');
  eq(now.sess, after.sess + 1, 'only the new real session merged');
  // A second sync is still a no-op for fixtures.
  importClaudeMem({ source: cloud, dest: local, apply: true, resume: false, verify: false, touchReady: false });
  eq(Object.values(cleanTestData({ dbPath: local }).totals).reduce((a, b) => a + b, 0), 0, 'second merge');
  // Without a prior clean, an unremoved uuid dir is NOT skipped (clean-only),
  // while the auto patterns are.
  const other = join(dir, 'other.db');
  const o = importClaudeMem({ source: cloud, dest: other, apply: true, verify: false, touchReady: false });
  const odb = new DatabaseSync(other, { readOnly: true });
  try {
    const ps = odb.prepare('SELECT DISTINCT project p FROM observations ORDER BY 1').all().map((x) => x.p).join(',');
    eq(ps, '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d,app,tmp', 'fresh import keeps the uuid dir, drops auto fixtures');
  } finally { odb.close(); }
  assert(o.testDataSkipped > 0, 'auto fixtures left out of a fresh import');
  // The opt-out copies everything.
  const raw = importClaudeMem({ source: cloud, dest: join(dir, 'raw.db'), apply: true, verify: false, touchReady: false, skipTestData: false });
  eq(raw.testDataSkipped, 0, 'opt-out');
});
await t('stripCopy (first pull / restore onto a new machine): drops auto fixtures and the copy\'s own removed names', () => {
  const dir = join(ROOT, 'strip');
  const a = join(dir, 'a.db');
  buildStore(a);
  const r = stripCopy(a);
  eq(r.testData, 3 + 2 + 2 + 2 + 1, 'auto fixture rows: obs 3, sessions 2, prompts 2, summaries 2, distill state 1');
  let db = new DatabaseSync(a, { readOnly: true });
  try {
    eq(db.prepare('SELECT DISTINCT project p FROM observations ORDER BY 1').all().map((x) => x.p).join(','),
      '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d,app,tmp', 'uuid dir kept (never removed here)');
  } finally { db.close(); }
  // A blob from a machine that already removed the uuid dir carries that record.
  const b = join(dir, 'b.db');
  buildStore(b);
  cleanTestData({ dbPath: b, apply: true, backupDir: join(dir, 'bk') });
  db = new DatabaseSync(b);
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status) VALUES ('uu-9','claude:uu-9','0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d','claude','charter','d',7,'completed')`).run();
  db.close();
  eq(stripCopy(b).testData, 1, 'a late row for a removed name is stripped');
  eq(counts(b).sess, 2, 'real sessions kept');
});
await t('clean --test-data: no DB → clear error; findTestData on an empty store is empty', () => {
  throwsLike(() => cleanTestData({ dbPath: join(ROOT, 'nope.db') }), /No DB at/, 'missing db');
  const store = join(ROOT, 'empty', 'brain.db');
  mkdirSync(dirname(store), { recursive: true });
  openStore({ path: store }).close();
  const db = openDb(store, { readonly: true });
  try { eq(Object.values(findTestData(db)).flat().length, 0, 'empty'); } finally { db.close(); }
});
await t('CLI: brain clean --test-data --db <fixture> (dry run, --json) and mode validation', () => {
  const store = join(ROOT, 'clean-cli', 'brain.db');
  buildStore(store);
  const before = sha(store);
  const env = { ...process.env, HOME: join(ROOT, 'cli-home'), BRAIN_NO_ECONOMICS: '1' };
  mkdirSync(env.HOME, { recursive: true });
  const r = spawnSync(process.execPath, [BRAIN, 'clean', '--test-data', '--db', store], { env, encoding: 'utf8' });
  eq(r.status, 0, `exit (stderr: ${r.stderr})`);
  assert(/Would remove \(dry run\) test-fixture rows/.test(r.stdout) && /e2e-probe-001/.test(r.stdout), `stdout:\n${r.stdout}`);
  const j = spawnSync(process.execPath, [BRAIN, 'clean', '--test-data', '--json', '--db', store], { env, encoding: 'utf8' });
  eq(JSON.stringify(JSON.parse(j.stdout).totals), JSON.stringify(EXPECTED), '--json totals');
  eq(sha(store), before, 'CLI dry run changed the DB');
  const both = spawnSync(process.execPath, [BRAIN, 'clean', '--test-data', '--self-capture', '--db', store], { env, encoding: 'utf8' });
  eq(both.status, 1, 'two modes at once is a usage error');
  const none = spawnSync(process.execPath, [BRAIN, 'clean', '--db', store], { env, encoding: 'utf8' });
  eq(none.status, 1, 'no mode is a usage error');
  assert(/--test-data/.test(none.stdout), 'usage mentions --test-data');
});

// ── report ───────────────────────────────────────────────────────────────────
for (const [s, n, e] of results) console.log(`${s === 'PASS' ? '✓' : '✗'} ${n}${e ? `\n    ${e}` : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
if (!fail && !process.env.KEEP) rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
