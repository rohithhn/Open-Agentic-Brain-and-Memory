#!/usr/bin/env node
// V6: copies of the real store are private and cleaned up.
//   node evals/private-copy-test.mjs
// Everything runs on a SYNTHETIC "real" store under the scratchpad/tmpdir. The real
// ~/.claude-brain is touched only with BRAIN_PRIVATE_COPY_REAL=1 (read through an
// immutable snapshot into a private, self-deleting copy; asserts nothing is left).
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { makePrivateCopy, withPrivateCopy, sweepStale, exposedTo, REAL_STORE } from './lib/private-copy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const ROOT = mkdtempSync(join(process.env.SCRATCHPAD || tmpdir(), 'private-copy-test-'));
const BASE = join(ROOT, 'base'); mkdirSync(BASE, { mode: 0o700 });
process.env.BRAIN_PRIVATE_COPY_BASE = BASE;

let pass = 0, fail = 0; const results = [];
const t = async (name, fn) => { try { await fn(); pass++; results.push(['PASS', name]); } catch (e) { fail++; results.push(['FAIL', name, e.message]); } };
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const left = () => readdirSync(BASE).filter((n) => n.startsWith('brain-private-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A synthetic stand-in for the real store: WAL mode like a live brain.db, checkpointed
// (the three rows are in the main file), world-readable like the leaked copies were.
// A fourth row is added later, only in the -wal, to pin the immutable-read caveat.
const SRC_DIR = join(ROOT, 'real'); mkdirSync(SRC_DIR, { recursive: true });
const SRC = join(SRC_DIR, 'brain.db');
const live = new DatabaseSync(SRC);
live.exec("PRAGMA journal_mode=WAL; CREATE TABLE observations(id INTEGER PRIMARY KEY, title TEXT); INSERT INTO observations(title) VALUES ('alpha'),('beta'),('gamma');");
live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
chmodSync(SRC, 0o644);
const count = (p) => { const d = new DatabaseSync(p, { readOnly: true }); try { return d.prepare('SELECT COUNT(*) n FROM observations').get().n; } finally { d.close(); } };

// ── node helper ──────────────────────────────────────────────────────────────
await t('makePrivateCopy: 0700 dir, 0600 file, a consistent snapshot, nothing else readable by others', () => {
  const c = makePrivateCopy({ label: 'unit', src: SRC });
  try {
    eq(mode(c.dir), '700', 'dir mode');
    eq(mode(c.db), '600', 'file mode');
    eq(readdirSync(c.dir), ['brain.db'], 'only the db, no journal side files copied');
    eq(count(c.db), 3, 'rows copied');
    eq(exposedTo(c.db, c.dir), [], 'no group/other bits on the copy or its dir');
    assert(c.dir.startsWith(BASE), 'created under the configured base');
  } finally { c.cleanup(); }
  assert(!existsSync(c.dir), 'cleanup removed it');
});

await t('immutable read caveat: rows still only in the source -wal are NOT in the copy, and walBytes says so', () => {
  live.exec("INSERT INTO observations(title) VALUES ('wal-only')");
  try {
    assert(statSync(SRC + '-wal').size > 0, 'fixture has a pending -wal');
    const c = makePrivateCopy({ label: 'wal', src: SRC });
    try {
      eq(count(c.db), 3, 'the copy is the last checkpointed state, never a torn mix');
      assert(c.walBytes > 0, `walBytes reported (${c.walBytes})`);
    } finally { c.cleanup(); }
  } finally { live.exec("DELETE FROM observations WHERE title='wal-only'; PRAGMA wal_checkpoint(TRUNCATE)"); }
});

await t('makePrivateCopy: the source is never modified (immutable read) and may be world-readable', () => {
  const before = [hash(SRC), mode(SRC), existsSync(SRC + '-wal') ? hash(SRC + '-wal') : null];
  const c = makePrivateCopy({ label: 'ro', src: SRC });
  c.cleanup();
  eq([hash(SRC), mode(SRC), existsSync(SRC + '-wal') ? hash(SRC + '-wal') : null], before, 'source bytes and mode unchanged');
});

await t('makePrivateCopy { home: true }: fake HOME with .claude-brain/brain.db + READY, all private', () => {
  const c = makePrivateCopy({ label: 'home', src: SRC, home: true });
  try {
    eq(c.db, join(c.home, '.claude-brain', 'brain.db'), 'db path');
    assert(existsSync(join(c.home, '.claude-brain', 'READY')), 'READY marker');
    for (const p of [c.dir, c.home, join(c.home, '.claude-brain')]) eq(mode(p), '700', p);
    for (const p of [c.db, join(c.home, '.claude-brain', 'READY')]) eq(mode(p), '600', p);
    eq(count(c.db), 3, 'rows');
  } finally { c.cleanup(); }
});

await t('withPrivateCopy removes the copy on success, on a thrown error, and returns the callback value', async () => {
  const seen = [];
  eq(await withPrivateCopy({ src: SRC }, ({ dir, db }) => { seen.push(dir); return count(db); }), 3, 'return value');
  let msg = '';
  try { await withPrivateCopy({ src: SRC }, ({ dir }) => { seen.push(dir); throw new Error('boom'); }); } catch (e) { msg = e.message; }
  eq(msg, 'boom', 'error propagates');
  eq(seen.length, 2, 'both ran');
  assert(seen.every((d) => !existsSync(d)), 'both removed');
  eq(left(), [], 'nothing left in the base');
});

await t('a missing source or a failed snapshot leaves nothing behind and throws', () => {
  let e1 = ''; try { makePrivateCopy({ src: join(SRC_DIR, 'nope.db') }); } catch (e) { e1 = e.message; }
  assert(/no store at/.test(e1), `missing: ${e1}`);
  const junk = join(SRC_DIR, 'junk.db'); writeFileSync(junk, 'this is not a sqlite database'.repeat(50));
  let e2 = ''; try { makePrivateCopy({ src: junk }); } catch (e) { e2 = e.message; }
  assert(e2, 'junk source throws');
  eq(left(), [], 'no half-made copy');
});

await t('labels are sanitised (no path traversal out of the base)', () => {
  const c = makePrivateCopy({ label: '../../evil/ x', src: SRC });
  try { assert(dirname(c.dir) === BASE, `dir ${c.dir}`); } finally { c.cleanup(); }
});

// A child that makes a copy, announces its dir, then waits to be killed.
const CHILD = `
  import { writeSync } from 'node:fs';
  import { makePrivateCopy } from ${JSON.stringify(join(HERE, 'lib/private-copy.mjs'))};
  const c = makePrivateCopy({ label: 'child', src: ${JSON.stringify(SRC)} });
  writeSync(1, c.dir + String.fromCharCode(10));
  if (process.env.MODE === 'throw') throw new Error('crash');
  if (process.env.MODE === 'exit') process.exit(7);
  setInterval(() => {}, 1000);
`;
async function runChild(mode, signal) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', CHILD], { env: { ...process.env, MODE: mode }, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  const done = new Promise((r) => p.on('exit', (code, sig) => r({ code, sig })));
  for (let i = 0; i < 100 && !out.includes('\n'); i++) await sleep(50);
  const dir = out.trim();
  assert(dir, 'child announced a copy');
  if (signal) assert(existsSync(dir), `child made a copy (${dir})`);
  if (signal) p.kill(signal);
  const r = await done;
  return { dir, ...r };
}
for (const [mode, sig, expect] of [['throw', null, 1], ['exit', null, 7], ['wait', 'SIGTERM', 143], ['wait', 'SIGINT', 130], ['wait', 'SIGHUP', 129]]) {
  await t(`bare makePrivateCopy: the copy is gone after ${sig || (mode === 'throw' ? 'an uncaught error' : 'process.exit(7)')}`, async () => {
    const r = await runChild(mode, sig);
    eq(r.code, expect, 'exit code');
    assert(!existsSync(r.dir), `still there: ${r.dir}`);
  });
}

await t('a SIGKILLed run (no hook can run) is mopped up by the next run via sweepStale; a live owner is never swept', async () => {
  const r = await runChild('wait', 'SIGKILL');
  assert(existsSync(r.dir), 'SIGKILL left it (that is the case being covered)');
  const dead = join(BASE, 'brain-private-fab-999999-AbCdEf'); mkdirSync(dead, { mode: 0o700 });
  const mine = join(BASE, `brain-private-fab-${process.pid}-ZzZzZz`); mkdirSync(mine, { mode: 0o700 });
  const other = join(BASE, 'unrelated-dir'); mkdirSync(other);
  const removed = sweepStale(BASE);
  assert(removed.includes(dead) && removed.includes(r.dir), `dead owners swept: ${removed}`);
  assert(!existsSync(dead) && !existsSync(r.dir), 'gone');
  assert(existsSync(mine), 'live owner kept'); assert(existsSync(other), 'unrelated dirs untouched');
  rmSync(mine, { recursive: true }); rmSync(other, { recursive: true });
});

await t('the next makePrivateCopy sweeps a dead run on its own', async () => {
  const r = await runChild('wait', 'SIGKILL');
  assert(existsSync(r.dir), 'left by SIGKILL');
  const c = makePrivateCopy({ src: SRC }); c.cleanup();
  assert(!existsSync(r.dir), 'swept');
});

await t('CLI: runs the command with the copy in env (and HOME with --home), returns its exit code, removes the copy', () => {
  const cli = join(HERE, 'lib/private-copy.mjs');
  const probe = `const fs=require('fs');const p=process.env.BRAIN_REAL_COPY_DB;console.log(JSON.stringify({p,exists:fs.existsSync(p),mode:(fs.statSync(p).mode&511).toString(8),home:process.env.HOME,h:process.env.BRAIN_REAL_COPY_HOME||null}));process.exit(5)`;
  const r = spawnSync(process.execPath, [cli, '--src', SRC, '--home', '--', process.execPath, '-e', probe], { encoding: 'utf8', env: process.env });
  eq(r.status, 5, 'exit code passes through');
  const o = JSON.parse(r.stdout.trim());
  assert(o.exists && o.mode === '600', 'db visible to the command, 0600');
  eq(o.home, o.h, 'HOME is the private home');
  assert(!existsSync(o.p), 'copy removed after the command');
  eq(left(), [], 'nothing left');
});

await t('exposedTo reports group/other-readable paths and nothing for private ones', () => {
  const d = join(ROOT, 'exp'); mkdirSync(d, { mode: 0o755 }); const f = join(d, 'x'); writeFileSync(f, 'x', { mode: 0o644 });
  assert(exposedTo(f, d).length === 2, `exposed: ${exposedTo(f, d)}`);
  chmodSync(d, 0o700); chmodSync(f, 0o600);
  eq(exposedTo(f, d), [], 'private');
});

// ── shell helper ─────────────────────────────────────────────────────────────
const SH = join(HERE, 'sandbox/private-copy.sh');
const bash = (script, opts = {}) => spawnSync('bash', ['-c', `. ${JSON.stringify(SH)}\n${script}`], { encoding: 'utf8', env: { ...process.env, BRAIN_PRIVATE_COPY_BASE: BASE }, ...opts });

await t('sb_private_copy: 0700 dir, 0600 file, source untouched, removed on a normal exit', () => {
  const before = hash(SRC);
  const r = bash(`sb_private_copy sh ${JSON.stringify(SRC)} || exit 9
    echo "$PRIV|$PRIV_DB|$(sb_mode "$PRIV")|$(sb_mode "$PRIV_DB")|$(sqlite3 "$PRIV_DB" 'select count(*) from observations')"`);
  eq(r.status, 0, r.stderr);
  const [dir, db, dm, fm, n] = r.stdout.trim().split('|');
  eq([dm, fm, n], ['700', '600', '3'], 'modes + rows');
  assert(dir.startsWith(realpathSync(BASE)) && db.startsWith(dir), `paths ${dir} ${db}`);
  assert(!existsSync(dir), 'removed at exit');
  eq(hash(SRC), before, 'source unchanged');
});

await t('sb_private_copy_home: fake HOME with READY, private; removed at exit', () => {
  const r = bash(`sb_private_copy_home h ${JSON.stringify(SRC)} || exit 9
    echo "$PRIV|$PRIV_HOME|$(sb_mode "$PRIV_HOME/.claude-brain")|$(sb_mode "$PRIV_DB")|$(test -f "$PRIV_HOME/.claude-brain/READY" && echo ready)"`);
  eq(r.status, 0, r.stderr);
  const [dir, home, dm, fm, ready] = r.stdout.trim().split('|');
  eq([dm, fm, ready], ['700', '600', 'ready'], 'modes + READY');
  assert(home === join(dir, 'home') && !existsSync(dir), 'layout, removed');
});

await t('sb_private_copy: removed when the script fails (set -e), and on `exit N`; a bad source makes nothing', () => {
  let r = bash(`set -e; sb_private_copy a ${JSON.stringify(SRC)}; echo "$PRIV" > ${JSON.stringify(join(ROOT, 'p1'))}; false`);
  assert(r.status !== 0 && !existsSync(readFileSync(join(ROOT, 'p1'), 'utf8').trim()), 'removed after failure');
  r = bash(`sb_private_copy a ${JSON.stringify(SRC)}; echo "$PRIV" > ${JSON.stringify(join(ROOT, 'p2'))}; exit 3`);
  eq(r.status, 3, 'exit code kept');
  assert(!existsSync(readFileSync(join(ROOT, 'p2'), 'utf8').trim()), 'removed after exit 3');
  r = bash(`sb_private_copy a ${JSON.stringify(join(SRC_DIR, 'nope.db'))}; echo rc=$?`);
  assert(/rc=1/.test(r.stdout) && /no store/.test(r.stderr), 'bad source fails');
  eq(left(), [], 'nothing left');
});

for (const [sig, code] of [['TERM', 143], ['INT', 130], ['HUP', 129]]) {
  await t(`sb_private_copy: removed when the script is sent SIG${sig}`, async () => {
    const mark = join(ROOT, `sig-${sig}`);
    const p = spawn('bash', ['-c', `. ${JSON.stringify(SH)}\nsb_private_copy s ${JSON.stringify(SRC)}; echo "$PRIV" > ${JSON.stringify(mark)}; while :; do sleep 0.1; done`], { env: { ...process.env, BRAIN_PRIVATE_COPY_BASE: BASE }, stdio: 'ignore' });
    const done = new Promise((r) => p.on('exit', (c) => r(c)));
    for (let i = 0; i < 100 && !existsSync(mark); i++) await sleep(50);
    for (let i = 0; i < 20 && !readFileSync(mark, 'utf8').trim(); i++) await sleep(50);
    const dir = readFileSync(mark, 'utf8').trim();
    assert(dir && existsSync(dir), 'copy made');
    p.kill(`SIG${sig}`);
    eq(await done, code, 'exit code');
    assert(!existsSync(dir), 'removed');
  });
}

await t('sb_private_sweep: removes copies whose owner pid is dead, keeps live and unrelated ones', () => {
  const dead = join(BASE, 'brain-private-old-999999-AbCdEf'); mkdirSync(dead, { mode: 0o700 });
  const alive = join(BASE, `brain-private-me-${process.pid}-ZzZzZz`); mkdirSync(alive, { mode: 0o700 });
  const other = join(BASE, 'keepme'); mkdirSync(other);
  const r = bash('sb_private_sweep');
  eq(r.status, 0, r.stderr);
  assert(!existsSync(dead), 'dead swept'); assert(existsSync(alive) && existsSync(other), 'live + unrelated kept');
  rmSync(alive, { recursive: true }); rmSync(other, { recursive: true });
});

await t('lib.sh wires it in: sb_cleanup also removes private copies (sandbox scripts get the guarantee for free)', () => {
  const lib = readFileSync(join(HERE, 'sandbox/lib.sh'), 'utf8');
  assert(/private-copy\.sh/.test(lib), 'lib.sh sources private-copy.sh');
  assert(/sb_cleanup\(\) \{\s*\n\s*sb_private_cleanup/.test(lib), 'sb_cleanup calls sb_private_cleanup');
});

// ── the rule itself: no hand-rolled copies of the real store anywhere in evals/ or scripts/ ──
await t('guard: nothing under evals/ or scripts/ copies the real store by hand', () => {
  const allowed = new Set(['evals/lib/private-copy.mjs', 'evals/sandbox/private-copy.sh', 'evals/private-copy-test.mjs', 'evals/sandbox/README.md', 'evals/longmemeval/RESULTS.md', 'evals/report-2026-09-30.md', 'evals/overnight-rollbacks.md']);
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) {
    if (n.name === 'node_modules' || n.name === 'data' || n.name.startsWith('.')) continue;
    const p = join(d, n.name); if (n.isDirectory()) walk(p); else if (/\.(mjs|js|cjs|sh)$/.test(n.name)) files.push(p);
  } };
  for (const d of ['evals', 'scripts']) if (existsSync(join(REPO, d))) walk(join(REPO, d));
  const copyVerb = /(\bcp\b|copyFileSync|cpSync|\.backup\b|VACUUM INTO|rsync|\bditto\b)/;
  const realStore = /(\$HOME|\$\{HOME\}|~|homedir\(\)|REAL_STORE|MEMORY_DB)[^\n]*\.claude-(brain|mem)|\.claude-(brain|mem)[^\n]*(\$HOME|homedir\(\))/;
  const bad = [];
  for (const f of files) {
    const rel = relative(REPO, f);
    if (allowed.has(rel)) continue;
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/immutable=1/.test(line)) bad.push(`${rel}:${i + 1}: immutable-snapshot of a store outside the helper`);
      else if (copyVerb.test(line) && realStore.test(line)) bad.push(`${rel}:${i + 1}: copies the real store by hand`);
      else if (/\/(private\/)?tmp\/[^\n]*brain\.db/.test(line)) bad.push(`${rel}:${i + 1}: brain.db under /tmp`);
    });
  }
  eq(bad, [], 'hand-rolled copies of the real store (use evals/lib/private-copy.mjs or sb_private_copy)');
});

await t('guard: the scan itself catches the leaks reviewers left (so it cannot rot into a no-op)', () => {
  const copyVerb = /(\bcp\b|copyFileSync|cpSync|\.backup\b|VACUUM INTO|rsync|\bditto\b)/;
  const realStore = /(\$HOME|\$\{HOME\}|~|homedir\(\)|REAL_STORE|MEMORY_DB)[^\n]*\.claude-(brain|mem)|\.claude-(brain|mem)[^\n]*(\$HOME|homedir\(\))/;
  for (const l of ['cp ~/.claude-brain/brain.db /private/tmp/b1rev/brain.db', 'sqlite3 "$HOME/.claude-brain/brain.db" ".backup /tmp/x.db"', "copyFileSync(join(homedir(), '.claude-brain', 'brain.db'), p)"]) assert(copyVerb.test(l) && realStore.test(l), l);
  assert(/\/(private\/)?tmp\/[^\n]*brain\.db/.test('node x --db /private/tmp/s4rev/brain.db'), 'tmp path');
});

// ── opt-in: the real store (read-only through the helper; the copy never survives) ──
if (process.env.BRAIN_PRIVATE_COPY_REAL === '1') {
  await t(`real store: private snapshot of ${REAL_STORE} is 0700/0600, readable, and removed`, async () => {
    const before = left();
    let dir;
    await withPrivateCopy({ label: 'real-check' }, ({ dir: d, db }) => {
      dir = d; eq(mode(d), '700', 'dir'); eq(mode(db), '600', 'file');
      const x = new DatabaseSync(db, { readOnly: true });
      try { assert(x.prepare('SELECT COUNT(*) n FROM observations').get().n > 0, 'has rows'); } finally { x.close(); }
    });
    assert(!existsSync(dir), 'removed'); eq(left(), before, 'base unchanged');
  });
}

live.close();
for (const [s, n, m] of results) console.log(`${s === 'PASS' ? '  ✓' : '  ✗'} ${n}${m ? `\n      ${m.replace(/\n/g, '\n      ')}` : ''}`);
console.log(`\nprivate-copy-test: ${pass} passed, ${fail} failed`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
