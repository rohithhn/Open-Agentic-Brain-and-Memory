// Private, self-cleaning copies of the operator's REAL brain store, for the evals
// and harnesses that need real-shaped data (opt-in dry runs, cold-start timing).
//
// THE RULE: a copy of the real brain.db is the operator's whole memory. It never
// goes in a shared or world-readable place (/tmp, /private/tmp, the repo) and it
// never outlives the run that needs it. This module is the only way a harness
// makes one:
//
//   - the directory is created by mkdtemp, chmod 0700 (the copy inside is 0600),
//   - the real file is read with `sqlite3 "file:<path>?immutable=1" .backup`
//     (a consistent snapshot; never opened for write, never locked),
//   - removal is guaranteed: try/finally for `withPrivateCopy`, plus an `exit`
//     hook and SIGINT/SIGTERM/SIGHUP handlers for a bare `makePrivateCopy`, so a
//     crash or Ctrl-C does not leave the copy behind,
//   - a run that was SIGKILLed (no hook can run) is mopped up by the next one:
//     the directory name carries the owner pid, and `sweepStale` removes
//     brain-private-* directories whose pid is gone.
//
//   import { withPrivateCopy } from './lib/private-copy.mjs';
//   await withPrivateCopy({ label: 'dedupe' }, async ({ db }) => { ...read db... });
//
// CLI (any command, copy exposed through env, removed afterwards):
//   node evals/lib/private-copy.mjs [--home] [--src <db>] -- <cmd> [args...]
//   exposes BRAIN_REAL_COPY_DB (and, with --home, BRAIN_REAL_COPY_HOME, a fake
//   HOME holding .claude-brain/brain.db + READY, which the cmd gets as HOME).
//
// Scratch location: $BRAIN_PRIVATE_COPY_BASE, else $SCRATCHPAD, else os.tmpdir() —
// os.tmpdir() is fine because the directory itself is 0700 (mode, not path, is
// what keeps the copy private).
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REAL_STORE = join(homedir(), '.claude-brain', 'brain.db');

const live = new Set(); // copies not yet removed
let hooked = false;

function removeAll() {
  for (const dir of live) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort; exists() below reports */ }
    live.delete(dir);
  }
}

function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', removeAll);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.on(sig, () => { removeAll(); process.exit(code); });
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Remove brain-private-* directories left behind by a run that died without cleaning up
 *  (SIGKILL, power loss). Only directories we own whose embedded pid is no longer alive.
 *  Returns the removed paths. */
export function sweepStale(base) {
  const root = resolve(base || process.env.BRAIN_PRIVATE_COPY_BASE || process.env.SCRATCHPAD || tmpdir());
  const removed = [];
  let names = [];
  try { names = readdirSync(root); } catch { return removed; }
  for (const n of names) {
    const m = /^brain-private-.*?-(\d+)-[A-Za-z0-9]{6}$/.exec(n);
    if (!m || pidAlive(Number(m[1]))) continue;
    const p = join(root, n);
    try {
      const st = statSync(p);
      if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) continue;
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch { /* not ours / already gone */ }
  }
  return removed;
}

/** Snapshot the real store into a fresh 0700 directory. Returns { dir, db, home, walBytes, cleanup }.
 *  opts: label, src (default REAL_STORE), home (also build <dir>/home/.claude-brain/{brain.db,READY}). */
export function makePrivateCopy({ label = 'real', src = REAL_STORE, home = false, base } = {}) {
  const from = resolve(src);
  if (!existsSync(from)) throw new Error(`private-copy: no store at ${from}`);
  const root = resolve(base || process.env.BRAIN_PRIVATE_COPY_BASE || process.env.SCRATCHPAD || tmpdir());
  const safeLabel = String(label).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40) || 'real';
  sweepStale(root);
  const dir = mkdtempSync(join(root, `brain-private-${safeLabel}-${process.pid}-`));
  live.add(dir);
  hook();
  try {
    chmodSync(dir, 0o700);
    let homeDir = null;
    let target = join(dir, 'brain.db');
    if (home) {
      homeDir = join(dir, 'home');
      const store = join(homeDir, '.claude-brain');
      mkdirSync(store, { recursive: true, mode: 0o700 });
      chmodSync(homeDir, 0o700); chmodSync(store, 0o700);
      target = join(store, 'brain.db');
    }
    // Snapshot through SQLite (consistent even if the live DB is mid-WAL); the URI form
    // keeps the real file strictly read-only. Arguments are an argv array: no shell.
    const uri = `${pathToFileURL(from).href}?immutable=1`;
    execFileSync('sqlite3', [uri, `.backup '${target.replace(/'/g, "''")}'`], { stdio: ['ignore', 'ignore', 'pipe'] });
    chmodSync(target, 0o600);
    if (homeDir) writeFileSync(join(homeDir, '.claude-brain', 'READY'), 'private copy\n', { mode: 0o600 });
    // immutable=1 never reads the source's -wal: the copy is its last CHECKPOINTED state
    // (consistent, never torn). walBytes tells a caller how much was left out.
    let walBytes = 0; try { walBytes = statSync(`${from}-wal`).size; } catch { /* no -wal */ }
    const cleanup = () => { rmSync(dir, { recursive: true, force: true }); live.delete(dir); };
    return { dir, db: target, home: homeDir, walBytes, cleanup };
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    live.delete(dir);
    throw e;
  }
}

/** Run fn with a private copy and ALWAYS remove it, however fn ends. */
export async function withPrivateCopy(opts, fn) {
  const c = makePrivateCopy(opts);
  try { return await fn(c); } finally { c.cleanup(); }
}

/** Is a path readable by anyone but its owner (group/other bits on it or a parent up to `stopAt`)? */
export function exposedTo(path, stopAt = homedir()) {
  let p = resolve(path);
  const bad = [];
  for (let guard = 0; guard < 40; guard++) {
    let st; try { st = statSync(p); } catch { break; }
    if (st.mode & 0o077) bad.push(`${p} (${(st.mode & 0o777).toString(8)})`);
    const up = resolve(p, '..');
    if (up === p || p === stopAt) break;
    p = up;
  }
  return bad;
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const sep2 = argv.indexOf('--');
  const flags = sep2 === -1 ? argv : argv.slice(0, sep2);
  const cmd = sep2 === -1 ? [] : argv.slice(sep2 + 1);
  if (!cmd.length) { console.error('usage: private-copy.mjs [--home] [--src <brain.db>] -- <cmd> [args...]'); process.exit(2); }
  const si = flags.indexOf('--src');
  const c = makePrivateCopy({ label: 'cli', home: flags.includes('--home'), src: si === -1 ? REAL_STORE : flags[si + 1] });
  const env = { ...process.env, BRAIN_TEST: '1', BRAIN_REAL_COPY_DB: c.db };
  if (c.home) { env.BRAIN_REAL_COPY_HOME = c.home; env.HOME = c.home; }
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env });
  c.cleanup();
  process.exit(r.status ?? (r.signal ? 128 : 1));
}
