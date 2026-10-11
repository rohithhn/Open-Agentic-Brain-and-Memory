// Test-run guard: a test must never write the operator's real memory store.
//
// Every eval/sandbox/acceptance harness points HOME (or an explicit dbPath) at a
// temp dir, so paths.mjs resolves a throwaway store. The failure mode this
// closes is a harness that forgets to: MEMORY_DB / NATIVE_DB_PATH then resolve
// under the real home and the test's fixture rows land in the operator's brain
// (where they pollute dream lint and the digest until `brain clean --test-data`).
//
// When a test env var is set (BRAIN_TEST=1, which every harness exports, or
// NODE_TEST_CONTEXT, which `node --test` sets for its children), any write-mode
// open of a DB inside the REAL user's ~/.claude-brain or ~/.claude-mem throws.
// "Real" comes from the passwd entry (os.userInfo), not $HOME — a fake HOME is
// exactly what a test is supposed to use, so it is never what we compare to.
// Read-only opens are untouched (the recall/sessionstart sanity checks read the
// real store on purpose). Outside a test env this module does nothing.
import { userInfo } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { realpathSync, statSync, readdirSync } from 'node:fs';

export const TEST_ENV_VAR = 'BRAIN_TEST';

export function inTestEnv(env = process.env) {
  return env[TEST_ENV_VAR] === '1' || !!env.NODE_TEST_CONTEXT;
}

function realHome() {
  try { return userInfo().homedir || null; } catch { return null; }
}

// Resolve symlinks on the deepest existing ancestor, so /tmp vs /private/tmp or
// a symlinked home cannot slip a path past the prefix check.
function canonical(p) {
  const abs = resolve(p);
  let head = abs, tail = '';
  for (;;) {
    try { return join(realpathSync.native(head), tail); } catch {}
    const up = dirname(head);
    if (up === head) return abs;
    tail = tail ? join(basename(head), tail) : basename(head);
    head = up;
  }
}

// The real stores' directories (whether or not they exist yet).
// BRAIN_TEST_PROTECT_HOME adds one more home to protect (the guard's own tests
// use it to prove the refusal on a fake "real" home). It can only add
// protection: the passwd home is always in the list.
export function protectedStoreDirs(home = realHome(), env = process.env) {
  const homes = [home, env.BRAIN_TEST_PROTECT_HOME].filter(Boolean);
  return homes.flatMap((h) => ['.claude-brain', '.claude-mem'].map((d) => canonical(join(h, d))));
}

// SQLite accepts "file:" URIs wherever it accepts a filename (when the open is
// URI-enabled, as node:sqlite's and better-sqlite3's are for a "file:" name):
// file:/abs, file:///abs, file://localhost/abs, file:rel, each with an optional
// ?query / #fragment, and percent-escapes in the path. Return the filesystem
// path such a URI names, or null when it names none (a non-local authority,
// which SQLite refuses to open, or an empty path).
export function fileUriToPath(uri) {
  if (typeof uri !== 'string' || !/^file:/i.test(uri)) return uri;
  let rest = uri.slice(5);
  const cut = rest.search(/[?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  if (rest.startsWith('//')) {
    const slash = rest.indexOf('/', 2);
    const authority = slash < 0 ? rest.slice(2) : rest.slice(2, slash);
    if (authority !== '' && authority.toLowerCase() !== 'localhost') return null;
    rest = slash < 0 ? '' : rest.slice(slash);
  }
  // %HH escapes are bytes (decode the whole name as UTF-8 afterwards); a
  // decoded NUL ends the name (SQLite's C string).
  const bytes = [];
  for (const part of rest.split(/(%[0-9a-fA-F]{2})/)) {
    if (/^%[0-9a-fA-F]{2}$/.test(part)) bytes.push(Buffer.from([parseInt(part.slice(1), 16)]));
    else bytes.push(Buffer.from(part, 'utf8'));
  }
  rest = Buffer.concat(bytes).toString('utf8');
  const nul = rest.indexOf('\0');
  if (nul >= 0) rest = rest.slice(0, nul);
  if (!rest) return null;
  return rest;
}

// Filesystem identity ("dev:ino") of a path, or null when it does not exist.
// This is what survives every spelling of a path: case variants and the
// /System/Volumes/Data firmlink on case-insensitive APFS, symlinks, ./.. —
// none of which a string comparison of realpath output reliably normalises.
function idOf(p) {
  try { const st = statSync(p); return `${st.dev}:${st.ino}`; } catch { return null; }
}

// Identities to protect: each protected dir, and every entry directly inside it
// (so a hard link to brain.db made elsewhere is still the store file).
function protectedIds(home, env) {
  const dirs = new Set(), files = new Set();
  for (const d of protectedStoreDirs(home, env)) {
    const id = idOf(d);
    if (!id) continue;
    dirs.add(id);
    let names = [];
    try { names = readdirSync(d); } catch {}
    for (const n of names) { const f = idOf(join(d, n)); if (f) files.add(f); }
  }
  return { dirs, files };
}

const DATA_VOLUME = '/System/Volumes/Data';
function foldedString(p) {
  let x = p;
  if (x === DATA_VOLUME || x.startsWith(DATA_VOLUME + '/')) x = x.slice(DATA_VOLUME.length) || '/';
  return x.toLowerCase();
}

export function isRealStorePath(p, home = realHome(), env = process.env) {
  if (!p || typeof p !== 'string' || p === ':memory:') return false;
  if (/^file:/i.test(p)) {
    const real = fileUriToPath(p);
    if (!real || real === ':memory:') return false;
    p = real;
  }
  const c = canonical(p);
  const dirs = protectedStoreDirs(home, env);
  if (dirs.some((d) => c === d || c.startsWith(d + sep))) return true;
  // Case-folded / firmlink-folded string comparison (conservative: also covers
  // a protected dir that does not exist yet).
  const fc = foldedString(c);
  if (dirs.some((d) => { const fd = foldedString(d); return fc === fd || fc.startsWith(fd + sep); })) return true;
  // Identity comparison: the target itself, or its nearest existing ancestors,
  // being the protected dir (or the target being a protected file).
  const { dirs: dirIds, files: fileIds } = protectedIds(home, env);
  if (!dirIds.size) return false;
  const self = idOf(resolve(p));
  if (self && (fileIds.has(self) || dirIds.has(self))) return true;
  let cur = resolve(p);
  for (;;) {
    const id = idOf(cur);
    if (id && dirIds.has(id)) return true;
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

// Throws when a test run is about to open the real store for writing.
export function assertWritableInThisEnv(p, { env = process.env, home } = {}) {
  if (!inTestEnv(env)) return;
  if (!isRealStorePath(p, home === undefined ? realHome() : home, env)) return;
  throw new Error(
    `Refusing to open ${p} for write: ${TEST_ENV_VAR}=1 (test run) and this is the real memory store. ` +
    'Point the test at a temp store (HOME=<tmp dir> or an explicit dbPath).');
}
