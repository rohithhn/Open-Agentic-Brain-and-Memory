// Allowlist Mirror — moves files between this private repo and the engine repo
// (`engineRoot` in tools/engine-manifest.json) over a DEFAULT-DENY allowlist.
//
// Spec: docs/specs/engine-mirror.md (never mirrored). Contract: the `$schemaNotes`
// block of tools/engine-manifest.json. This module implements exactly that block.
//
// THIS IS THE CODE THAT DECIDES WHAT BECOMES PUBLIC. Every ambiguity is resolved
// by refusing. The three operations are dry-run by default (repo convention:
// `scrub --apply`), and `--apply` is all-or-nothing: the guard scan runs over the
// WHOLE plan before a single byte is written.
//
// Design rules honoured here:
//   * Zero dependencies — node builtins only.
//   * No import-time side effects (bin/lib/doctor.mjs must be able to import this).
//   * No process.exit() and no console output: every entry point returns
//     { code, lines, ... } so the caller (bin/brain.mjs, T6) prints and exits.
//   * The copy itself never shells out to git; only git *state* is read.
import {
  existsSync, readFileSync, readdirSync, lstatSync, mkdirSync, rmSync, copyFileSync,
} from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// ───────────────────────── constants ─────────────────────────

// Repo root = two levels up from bin/lib/. Pure computation, no side effect.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_MANIFEST = join(REPO_ROOT, 'tools', 'engine-manifest.json');

// BELT AND BRACES. The manifest carries this same list under `divergent.paths`;
// it is duplicated here on purpose so that a manifest edit ALONE can never cross
// one of these files (manifest `$schemaNotes.divergent`). The union of the two
// lists is refused — never the intersection.
export const DIVERGENT = Object.freeze([
  'README.md',
  'ROADMAP.md',
  'package.json',
  '.gitignore',
]);

// Mirrors the hook's `case "$f" in *.age|*.db|... ) fail` line. These are
// extension denials applied before any content scan, with no exemption list.
const ARTIFACT_EXT = Object.freeze(['.age', '.db', '.db-wal', '.db-shm', '.identity']);
const BINARY_CAP = 1048576;
const SUPPORTED_VERSION = 2;

// ───────────────────────── small utils ─────────────────────────

function expandTilde(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Escape a path segment for RegExp, turning `*` into "anything but a slash". */
function segToRegexSrc(seg) {
  let out = '';
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*';
    else if ('.+?^${}()|[]\\/'.includes(ch)) out += '\\' + ch;
    else out += ch;
  }
  return out;
}

/** Anchored matcher for a FILE pattern (no trailing slash). `*` never crosses `/`. */
function filePatternRe(p) {
  return new RegExp('^' + p.split('/').map(segToRegexSrc).join('/') + '$');
}

function isDirEntryPath(p) { return p.endsWith('/'); }

/** Every file under `root`, as root-relative POSIX paths. Never follows symlinks. */
function walkFiles(root, { skipDirs = [], skipNames = [], onSymlink = null } = {}) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? join(root, rel) : root;
    let ents;
    try { ents = readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { if (onSymlink) onSymlink(childRel); continue; }
      if (e.isDirectory()) {
        if (skipDirs.includes(e.name)) continue;
        stack.push(childRel);
      } else if (e.isFile()) {
        if (skipNames.includes(e.name)) continue;
        out.push(childRel);
      }
    }
  }
  out.sort();
  return out;
}

function readOrNull(p) { try { return readFileSync(p); } catch { return null; } }
function sameBytes(a, b) { return a !== null && b !== null && a.equals(b); }

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// ───────────────────────── manifest ─────────────────────────

/**
 * Load + parse the manifest. Returns { manifest } or { refusals } — never throws
 * for a bad manifest, so the caller can print every problem at once.
 */
export function loadManifest(manifestPath = DEFAULT_MANIFEST) {
  if (!existsSync(manifestPath)) {
    return { refusals: [`manifest not found: ${manifestPath}`] };
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { refusals: [`manifest is not valid JSON: ${e.message}`] }; }
  if (manifest.version !== SUPPORTED_VERSION) {
    return { refusals: [`unsupported manifest version: ${JSON.stringify(manifest.version)} (expected ${SUPPORTED_VERSION})`] };
  }
  return { manifest };
}

/**
 * Normalize `mirror` into validated entries.
 *
 * Refuses (contract §mirror/§globbing/§divergent/§neverMirror):
 *   - an object entry with neither `from` nor `$comment`
 *   - a `**` glob anywhere
 *   - absolute / `..`-escaping / empty paths
 *   - a directory `from` whose `to` is not also a directory (or vice versa)
 *   - a glob whose `from`/`to` shapes differ (breaks the import bijection)
 *   - a `from` resolving under any `neverMirror` prefix
 *   - any DIVERGENT path (hardcoded ∪ manifest) on either side
 *
 * @returns {{entries: Array, refusals: string[]}}
 */
export function normalizeEntries(manifest) {
  const refusals = [];
  const entries = [];
  const mirror = Array.isArray(manifest.mirror) ? manifest.mirror : null;
  if (!mirror) return { entries, refusals: ['manifest.mirror is missing or not an array'] };

  const divergent = new Set([...DIVERGENT, ...((manifest.divergent && manifest.divergent.paths) || [])]);
  const neverMirror = ((manifest.neverMirror && manifest.neverMirror.paths) || []);

  const underNeverMirror = (p) => neverMirror.find((n) => (
    isDirEntryPath(n) ? p === n || p.startsWith(n) : (n.includes('*') ? filePatternRe(n).test(p) : p === n)
  ));

  const badPath = (p, label, idx) => {
    if (typeof p !== 'string' || p.length === 0) { refusals.push(`mirror[${idx}]: ${label} must be a non-empty string`); return true; }
    if (p.includes('**')) { refusals.push(`mirror[${idx}]: '**' glob is not supported (${label}: ${p}) — use a directory entry`); return true; }
    if (isAbsolute(p) || p.startsWith('/')) { refusals.push(`mirror[${idx}]: ${label} must be repo-relative (${p})`); return true; }
    if (p.split('/').includes('..')) { refusals.push(`mirror[${idx}]: ${label} escapes the repo with '..' (${p})`); return true; }
    if (p.startsWith('./')) { refusals.push(`mirror[${idx}]: ${label} must not start with './' (${p})`); return true; }
    return false;
  };

  mirror.forEach((raw, idx) => {
    let from, to;
    if (typeof raw === 'string') {
      // A bare string is ALWAYS a path, never a comment, no matter what it looks like.
      from = raw; to = raw;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (raw.from === undefined) {
        if ('$comment' in raw) return;               // comment-only entry: skipped entirely
        refusals.push(`mirror[${idx}]: object entry has neither 'from' nor '$comment'`);
        return;
      }
      from = raw.from;
      to = raw.to === undefined ? raw.from : raw.to; // `to` defaults to `from`
      // every other key (`$comment`, `blockedBy`, `why`) is metadata and ignored.
      // `blockedBy` is explicitly NOT a skip: the guard scan is the only gate.
    } else {
      refusals.push(`mirror[${idx}]: entry must be a string or an object`);
      return;
    }

    const badFrom = badPath(from, 'from', idx);
    const badTo = badPath(to, 'to', idx);
    if (badFrom || badTo) return;

    const fromDir = isDirEntryPath(from), toDir = isDirEntryPath(to);
    if (fromDir !== toDir) {
      refusals.push(`mirror[${idx}]: directory/file mismatch — 'from' (${from}) and 'to' (${to}) must both end in '/' or neither`);
      return;
    }

    for (const [side, p] of [['from', from], ['to', to]]) {
      if (divergent.has(p)) {
        refusals.push(`mirror[${idx}]: divergent-by-design path may never be mirrored (${side}: ${p})`);
        return;
      }
    }

    const nm = underNeverMirror(from);
    if (nm) {
      refusals.push(`mirror[${idx}]: 'from' resolves under neverMirror prefix '${nm}' (${from})`);
      return;
    }

    if (!fromDir) {
      const fs_ = from.split('/'), ts_ = to.split('/');
      const fg = from.includes('*'), tg = to.includes('*');
      if (fg !== tg) {
        refusals.push(`mirror[${idx}]: glob on one side only — 'from' (${from}) and 'to' (${to}) must have the same glob shape`);
        return;
      }
      if (fg) {
        if (fs_.length !== ts_.length || fs_.some((s, i) => s.includes('*') !== ts_[i].includes('*')) ||
            fs_.some((s, i) => s.includes('*') && s !== ts_[i])) {
          refusals.push(`mirror[${idx}]: globbed segments must be identical on both sides for the import bijection ('${from}' vs '${to}')`);
          return;
        }
      }
    }

    entries.push({ index: idx, from, to, isDir: fromDir, hasGlob: from.includes('*') });
  });

  return { entries, refusals };
}

// ───────────────────────── expansion ─────────────────────────

/**
 * Expand one FILE entry (possibly globbed) against `root`, segment by segment.
 * `*` is applied per segment and therefore can never cross a `/`. Symlinks are
 * never followed and never expanded: a matched symlink is surfaced so the caller
 * can refuse (it could point anywhere outside the repo).
 * @returns {{files: string[], symlinks: string[]}}
 */
function expandGlob(root, pattern) {
  const segs = pattern.split('/');
  const symlinks = [];
  let cur = ['']; // relative directories discovered so far (never symlinks)
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i], last = i === segs.length - 1;
    const next = [];
    for (const d of cur) {
      const abs = d ? join(root, d) : root;
      if (!seg.includes('*')) {
        const rel = d ? `${d}/${seg}` : seg;
        let st; try { st = lstatSync(join(root, rel)); } catch { continue; }
        if (st.isSymbolicLink()) { symlinks.push(rel); continue; }
        if (last ? st.isFile() : st.isDirectory()) next.push(rel);
        continue;
      }
      const re = new RegExp('^' + segToRegexSrc(seg) + '$');
      let ents; try { ents = readdirSync(abs, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!re.test(e.name)) continue;
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.isSymbolicLink()) { symlinks.push(rel); continue; }
        if (last ? e.isFile() : e.isDirectory()) next.push(rel);
      }
    }
    cur = next;
  }
  return { files: cur.sort(), symlinks };
}

/**
 * Expand entries into concrete (src, dest) pairs in one direction.
 *
 * `dir` = 'export' reads sources from the PRIVATE side (`from`) and writes to the
 * ENGINE side (`to`); 'import' is the exact inverse (contract §reverse).
 *
 * @returns {{pairs, missing, symlinks}} pairs are {src, dest} relative paths.
 */
export function expandPairs(entries, srcRoot, { direction = 'export' } = {}) {
  const fwd = direction === 'export';
  const pairs = [];
  const missing = [];
  const symlinks = [];
  for (const e of entries) {
    const srcSide = fwd ? e.from : e.to;
    const dstSide = fwd ? e.to : e.from;
    if (e.isDir) {
      const base = join(srcRoot, srcSide);
      const found = walkFiles(base, { onSymlink: (r) => symlinks.push(`${srcSide}${r}`) });
      if (!found.length && !existsSync(base)) missing.push(srcSide);
      for (const rel of found) pairs.push({ src: `${srcSide}${rel}`, dest: `${dstSide}${rel}` });
      continue;
    }
    if (e.hasGlob) {
      const found = expandGlob(srcRoot, srcSide);
      symlinks.push(...found.symlinks);
      for (const f of found.files) {
        // Globbed segments are identical on both sides (enforced in normalizeEntries),
        // so the dest is the `to` pattern with its literal segments kept and the
        // globbed ones taken from the concrete source path.
        const fs_ = srcSide.split('/'), ts_ = dstSide.split('/'), as_ = f.split('/');
        const dest = ts_.map((s, i) => (fs_[i].includes('*') ? as_[i] : s)).join('/');
        pairs.push({ src: f, dest });
      }
      continue;
    }
    const abs = join(srcRoot, srcSide);
    let st; try { st = lstatSync(abs); } catch { missing.push(srcSide); continue; }
    if (st.isSymbolicLink()) { symlinks.push(srcSide); continue; }
    if (!st.isFile()) { missing.push(srcSide); continue; }
    pairs.push({ src: srcSide, dest: dstSide });
  }
  // Deterministic order, and a defence against a manifest that maps two sources
  // onto one destination.
  pairs.sort((a, b) => a.dest.localeCompare(b.dest) || a.src.localeCompare(b.src));
  return { pairs, missing, symlinks };
}

/**
 * The deletion scope: matchers built from `mirror[].to` ONLY (contract §deletion,
 * `scopeDerivedFrom`). An engine file matching none of these is never touched —
 * that, and only that, protects engine-authored files.
 */
export function destScope(entries) {
  const dirs = [], res = [];
  for (const e of entries) {
    if (e.isDir) dirs.push(e.to);
    else res.push(filePatternRe(e.to));
  }
  return (rel) => dirs.some((d) => rel.startsWith(d)) || res.some((r) => r.test(rel));
}

/** Same idea for the private side (used by engine-import's dirty check). */
function srcScope(entries) {
  const dirs = [], res = [];
  for (const e of entries) {
    if (e.isDir) dirs.push(e.from);
    else res.push(filePatternRe(e.from));
  }
  return (rel) => dirs.some((d) => rel.startsWith(d)) || res.some((r) => r.test(rel));
}

function orphanIgnore(manifest) {
  const list = (manifest.deletion && manifest.deletion.ignoreInOrphanScan) || ['.git/', 'node_modules/', '.DS_Store'];
  return {
    skipDirs: list.filter((x) => x.endsWith('/')).map((x) => x.slice(0, -1)),
    skipNames: list.filter((x) => !x.endsWith('/')),
  };
}

function engineOnlyMatcher(manifest) {
  const paths = (manifest.engineOnly && manifest.engineOnly.paths) || [];
  return (rel) => paths.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
}

// ───────────────────────── guard (hook is the single source of truth) ─────────────────────────

/**
 * Split an ERE alternation at TOP level only — `|` inside `(...)` or `[...]`
 * does not split. Used solely to name the pattern class of a violation; matching
 * itself always uses the full DENY regex semantics.
 */
function splitAlternation(src) {
  const out = [];
  let cur = '', depth = 0, cls = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { cur += ch + (src[i + 1] || ''); i++; continue; }
    if (cls) { if (ch === ']') cls = false; cur += ch; continue; }
    if (ch === '[') { cls = true; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (ch === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.filter((s) => s.length);
}

/**
 * Name a DENY alternative WITHOUT ever echoing matched text. The labels are a
 * cosmetic classifier over the *pattern* (never over the input), so they are not
 * a second copy of the patterns and cannot drift into a matching decision — if a
 * shape is unrecognised the label degrades to a stable index.
 */
function classifyAlternative(src, idx) {
  if (/PRIVATE KEY/.test(src)) return 'private-key-block';
  if (/^\/Users\//.test(src) || /^\/home\//.test(src)) return 'absolute-home-path';
  if (/AGE-/.test(src)) return 'age-secret-key';
  if (/^gh\[?[pousr]/.test(src)) return 'github-token';
  if (/^sk-/.test(src)) return 'api-key';
  if (/^xox/.test(src)) return 'slack-token';
  return `deny-alternative-${idx + 1}`;
}

/**
 * Parse DENY and DENY_PATHS out of the engine repo's own pre-commit hook.
 * SINGLE SOURCE OF TRUTH (contract §guard): there is no second copy of these
 * patterns here or in the manifest, and there is no unscanned fallback.
 *
 * @returns {{deny, denyPaths, denyRe, denyPathsRe, alts}} or {refusals}
 */
export function parseGuard(hookPath) {
  const GUARD_MISSING = 'guard not found — refusing to export unguarded';
  if (!hookPath || !existsSync(hookPath)) {
    return { refusals: [`${GUARD_MISSING} (${hookPath || '<no path>'})`] };
  }
  let text;
  try { text = readFileSync(hookPath, 'utf8'); }
  catch (e) { return { refusals: [`${GUARD_MISSING} (unreadable: ${e.message})`] }; }

  // Shell single-quoted strings contain no escapes: the value ends at the next `'`.
  let deny = (text.match(/^\s*DENY='([^']*)'/m) || [])[1];
  // Personal identifiers live outside the public hook, in the engine repo's untracked
  // .git/info/agentic-brain-deny (one alternative per line); the hook appends them, so must we.
  const localDeny = join(dirname(dirname(hookPath)), '.git', 'info', 'agentic-brain-deny');
  if (deny && existsSync(localDeny)) {
    const extra = readFileSync(localDeny, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (extra.length) deny = `${deny}|${extra.join('|')}`;
  }
  const denyPaths = (text.match(/^\s*DENY_PATHS='([^']*)'/m) || [])[1];
  // Optional ALLOW: exact reviewed strings the hook deletes before DENY runs.
  const allow = (text.match(/^\s*ALLOW='([^']*)'/m) || [])[1] || null;
  const missing = [];
  if (!deny) missing.push('DENY');
  if (!denyPaths) missing.push('DENY_PATHS');
  if (missing.length) {
    return { refusals: [`${GUARD_MISSING} (cannot extract ${missing.join(' and ')} from ${hookPath})`] };
  }
  let denyRe, denyPathsRe, alts, allowRe = null;
  try {
    if (allow) allowRe = new RegExp(allow, 'g');
    denyRe = new RegExp(deny);
    denyPathsRe = new RegExp(denyPaths);
    alts = splitAlternation(deny).map((src, i) => ({ re: new RegExp(src), cls: classifyAlternative(src, i) }));
  } catch (e) {
    return { refusals: [`${GUARD_MISSING} (pattern does not compile: ${e.message})`] };
  }
  return { deny, denyPaths, denyRe, denyPathsRe, alts, allowRe, hookPath };
}

/**
 * Run the hook's own checks over ONE planned file. Violations name the pattern
 * class only — never the matched text, which could be a live secret.
 */
export function scanPlannedFile(destRel, absSrc, guard) {
  const v = [];
  if (guard.denyPathsRe.test(destRel)) v.push({ dest: destRel, line: 0, cls: 'denied-path (DENY_PATHS)' });
  if (ARTIFACT_EXT.some((x) => destRel.endsWith(x))) v.push({ dest: destRel, line: 0, cls: 'denied-artifact-extension' });

  const buf = readOrNull(absSrc);
  if (buf === null) { v.push({ dest: destRel, line: 0, cls: 'unreadable-source' }); return v; }

  if (isBinary(buf)) {
    // Matches the hook: binaries skip the content scan but are size-capped.
    if (buf.length > BINARY_CAP) v.push({ dest: destRel, line: 0, cls: `binary-over-${BINARY_CAP}-bytes` });
    return v;
  }
  const body = guard.allowRe ? buf.toString('utf8').replace(guard.allowRe, '') : buf.toString('utf8');
  if (!guard.denyRe.test(body)) return v; // fast path
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const a of guard.alts) {
      if (a.re.test(lines[i])) v.push({ dest: destRel, line: i + 1, cls: a.cls });
    }
  }
  return v;
}

/** `<dest>:<line>: matches <pattern-class>` — pattern class only. */
function renderViolations(violations) {
  const sorted = [...violations].sort((a, b) => a.dest.localeCompare(b.dest) || a.line - b.line || a.cls.localeCompare(b.cls));
  return sorted.map((x) => `  ${x.dest}:${x.line}: matches ${x.cls}`);
}

// ───────────────────────── .gitignore swallow detection ─────────────────────────

/**
 * Would the engine `.gitignore` silently swallow this mirrored file? The engine
 * ignore file is default-deny; a swallowed file makes `git add -A` *look* like it
 * succeeded while the file is never tracked (manifest §notes.gitignoreInteraction).
 *
 * Two independent oracles, UNIONED so a miss in either still reports:
 *   1. `git check-ignore --no-index` in the repo that owns the .gitignore (authoritative).
 *   2. A built-in matcher (works for a scratch tree that is not a repo).
 */
export function gitignoreSwallowed(ignoreRoot, relPaths) {
  const hit = new Set();
  const ignoreFile = join(ignoreRoot, '.gitignore');
  if (!relPaths.length || !existsSync(ignoreFile)) return [];

  if (existsSync(join(ignoreRoot, '.git'))) {
    try {
      const r = execFileSync('git', ['-C', ignoreRoot, 'check-ignore', '--no-index', '--stdin'],
        { input: relPaths.join('\n') + '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      for (const l of r.split('\n')) if (l.trim()) hit.add(l.trim());
    } catch (e) {
      // exit 1 == "nothing ignored"; anything else we simply fall back to the matcher.
      const out = e && e.stdout ? String(e.stdout) : '';
      for (const l of out.split('\n')) if (l.trim()) hit.add(l.trim());
    }
  }
  for (const p of matchGitignore(readFileSync(ignoreFile, 'utf8'), relPaths)) hit.add(p);
  return [...hit].sort();
}

/** Minimal gitignore evaluator: last matching rule wins, `!` negates. */
export function matchGitignore(ignoreText, relPaths) {
  const rules = [];
  for (let raw of ignoreText.split('\n')) {
    let line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    let neg = false;
    if (line.startsWith('!')) { neg = true; line = line.slice(1); }
    line = line.trim();
    if (!line) continue;
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    let anchored = line.includes('/');
    if (line.startsWith('/')) { line = line.slice(1); anchored = true; }
    if (line.startsWith('**/')) { line = line.slice(3); anchored = false; }
    rules.push({ neg, dirOnly, anchored, re: filePatternRe(line) });
  }
  const out = [];
  for (const p of relPaths) {
    const segs = p.split('/');
    let ignored = false;
    for (const r of rules) {
      let m = false;
      if (r.anchored) {
        // Match the full path, or any ancestor directory of it.
        for (let i = 1; i <= segs.length; i++) {
          const prefix = segs.slice(0, i).join('/');
          if (r.dirOnly && i === segs.length) break; // a file can't match a dir-only rule
          if (r.re.test(prefix)) { m = true; break; }
        }
      } else {
        for (let i = 0; i < segs.length; i++) {
          if (r.dirOnly && i === segs.length - 1) break;
          if (r.re.test(segs[i])) { m = true; break; }
        }
      }
      if (m) ignored = !r.neg;
    }
    if (ignored) out.push(p);
  }
  return out;
}

// ───────────────────────── git state (read-only) ─────────────────────────

/** Working-tree paths that are not clean. `null` when `root` is not a git repo. */
export function dirtyPaths(root) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const parts = out.split('\0');
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2), p = rec.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') { paths.push(p); i++; if (parts[i]) paths.push(parts[i]); }
    else paths.push(p);
  }
  return [...new Set(paths)].sort();
}

// ───────────────────────── plan ─────────────────────────

/**
 * Compute the full outbound plan without touching anything.
 * @returns {{copies, unchanged, deletes, missing, symlinks, inScope}}
 */
export function buildExportPlan({ entries, manifest, privateRoot, targetRoot }) {
  const { pairs, missing, symlinks } = expandPairs(entries, privateRoot, { direction: 'export' });
  const inScope = destScope(entries);
  const copies = [], unchanged = [];
  const plannedDests = new Set();
  for (const { src, dest } of pairs) {
    plannedDests.add(dest);
    const s = readOrNull(join(privateRoot, src));
    const d = readOrNull(join(targetRoot, dest));
    (sameBytes(s, d) ? unchanged : copies).push({ src, dest });
  }
  const ign = orphanIgnore(manifest);
  const deletes = walkFiles(targetRoot, ign)
    .filter((rel) => inScope(rel) && !plannedDests.has(rel));
  return { copies, unchanged, deletes, missing, symlinks, pairs, plannedDests };
}

// ───────────────────────── engine-export ─────────────────────────

/**
 * Copy the manifest-allowlisted set private → engine. DRY-RUN BY DEFAULT.
 *
 * @param {object}  o
 * @param {boolean} o.apply        actually write (default false)
 * @param {string}  o.to           redirect output to a scratch tree (skips git checks)
 * @param {boolean} o.force        allow a dirty engine tree inside manifest scope
 * @param {string}  o.privateRoot  default: this repo
 * @param {string}  o.engineRoot   default: manifest.engineRoot (`~` expanded)
 * @param {string}  o.manifestPath default: tools/engine-manifest.json
 * @param {string}  o.hookPath     default: <engineRoot>/.githooks/pre-commit
 * @returns {{code:number, lines:string[], plan?:object, violations?:Array}}
 */
export function engineExport({
  apply = false, to = null, force = false,
  privateRoot = REPO_ROOT, engineRoot = null, manifestPath = DEFAULT_MANIFEST, hookPath = null,
} = {}) {
  const lines = [];
  const refuse = (msgs) => ({ code: 2, lines: [...lines, 'REFUSED:', ...msgs.map((m) => `  ${m}`)] });

  const { manifest, refusals: mr } = loadManifest(manifestPath);
  if (mr) return refuse(mr);
  const { entries, refusals } = normalizeEntries(manifest);
  if (refusals.length) return refuse(refusals);

  const realEngineRoot = resolve(expandTilde(engineRoot || manifest.engineRoot || ''));
  const targetRoot = to ? resolve(expandTilde(to)) : realEngineRoot;
  const scratch = Boolean(to) && targetRoot !== realEngineRoot;

  // The guard always comes from the REAL engine repo's hook, even for a scratch
  // rehearsal — a scratch tree has no hook, and the rehearsal must predict the
  // real repo's behaviour (contract §guard.scratchRuns).
  const guard = parseGuard(hookPath || join(realEngineRoot, '.githooks', 'pre-commit'));
  if (guard.refusals) return refuse(guard.refusals);

  const plan = buildExportPlan({ entries, manifest, privateRoot, targetRoot });

  if (plan.symlinks.length) {
    return refuse([
      'symlink in the mirror source set — refusing (a symlink can point anywhere outside the repo):',
      ...plan.symlinks.map((s) => `  ${s}`),
    ]);
  }

  // Dirty-tree protection for the real engine repo only (scratch runs skip git).
  if (!scratch && !force) {
    const dirty = dirtyPaths(targetRoot);
    if (dirty === null) {
      lines.push('note: engine root is not a git repo — skipping the uncommitted-changes check');
    } else {
      const inScope = destScope(entries);
      const conflict = dirty.filter(inScope);
      if (conflict.length) {
        return refuse([
          'engine repo has uncommitted changes inside manifest scope — these would be clobbered.',
          'Run `brain engine-import` or commit in the engine repo first, or pass --force.',
          ...conflict.map((p) => `  ${p}`),
        ]);
      }
    }
  }

  // ── guard scan over the WHOLE plan, before anything is written ────────────
  // Every file the mirror endorses for publication is scanned (COPY and
  // UNCHANGED alike): an already-mirrored violation is still a violation.
  const violations = [];
  for (const { src, dest } of [...plan.copies, ...plan.unchanged]) {
    violations.push(...scanPlannedFile(dest, join(privateRoot, src), guard));
  }
  if (violations.length) {
    return {
      code: 2,
      violations,
      lines: [
        ...lines,
        `guard: ${violations.length} violation(s) — nothing was written.`,
        ...renderViolations(violations),
        '',
        'A manifest-allowlisted file containing a denied pattern is a PRIVATE-REPO BUG:',
        'fix the file, or drop the entry, in the private repo. Export is all-or-nothing.',
      ],
    };
  }

  // ── render the plan ───────────────────────────────────────────────────────
  for (const { dest } of plan.copies) lines.push(`COPY      ${dest}`);
  for (const d of plan.deletes) lines.push(`DELETE    ${d}`);
  for (const { dest } of plan.unchanged) lines.push(`UNCHANGED ${dest}`);
  for (const m of plan.missing) lines.push(`MISSING-SOURCE ${m}   (allowlisted but absent in the private repo)`);
  lines.push(`plan: ${plan.copies.length} copy · ${plan.deletes.length} delete · ${plan.unchanged.length} unchanged · guard: 0 violations`);
  lines.push(`target: ${targetRoot}${scratch ? '  (scratch — git checks skipped, guard scan still ran)' : ''}`);

  // ── apply ─────────────────────────────────────────────────────────────────
  if (apply) {
    for (const { src, dest } of plan.copies) {
      const abs = join(targetRoot, dest);
      mkdirSync(dirname(abs), { recursive: true });
      copyFileSync(join(privateRoot, src), abs);
    }
    for (const d of plan.deletes) rmSync(join(targetRoot, d), { force: true });
    lines.push(`applied: ${plan.copies.length} copied, ${plan.deletes.length} deleted`);
  } else {
    lines.push('dry-run — nothing written. Re-run with --apply to execute this plan.');
  }

  // ── .gitignore swallow report (loud; runs in dry-run too) ─────────────────
  const ignoreRoot = existsSync(join(targetRoot, '.gitignore')) ? targetRoot : realEngineRoot;
  const allDests = [...plan.copies, ...plan.unchanged].map((p) => p.dest);
  const swallowed = gitignoreSwallowed(ignoreRoot, allDests);
  if (swallowed.length) {
    lines.push('');
    lines.push(`⚠️  GITIGNORE SWALLOW — ${swallowed.length} mirrored file(s) would be IGNORED by the engine .gitignore.`);
    lines.push('   `git add -A` there will appear to succeed while these files are never tracked.');
    lines.push('   Add a matching negation in the same commit, or the file silently vanishes:');
    for (const s of swallowed) lines.push(`     ${s}`);
  }

  return { code: 0, lines, plan, violations: [] };
}

// ───────────────────────── engine-diff ─────────────────────────

/**
 * Read-only drift report — the human review gate. Exit 1 on any drift.
 * `orphans` additionally lists engine files accounted for by neither
 * `mirror[].to` nor an `engineOnly.paths` prefix as UNACCOUNTED.
 */
export function engineDiff({
  orphans = false, privateRoot = REPO_ROOT, engineRoot = null, manifestPath = DEFAULT_MANIFEST,
} = {}) {
  const lines = [];
  const refuse = (msgs) => ({ code: 2, lines: ['REFUSED:', ...msgs.map((m) => `  ${m}`)] });

  const { manifest, refusals: mr } = loadManifest(manifestPath);
  if (mr) return refuse(mr);
  const { entries, refusals } = normalizeEntries(manifest);
  if (refusals.length) return refuse(refusals);

  const root = resolve(expandTilde(engineRoot || manifest.engineRoot || ''));
  const { pairs, missing, symlinks } = expandPairs(entries, privateRoot, { direction: 'export' });
  if (symlinks.length) return refuse(['symlink in the mirror source set:', ...symlinks.map((s) => `  ${s}`)]);

  const inScope = destScope(entries);
  const plannedDests = new Set(pairs.map((p) => p.dest));
  let drift = 0;

  for (const { src, dest } of pairs) {
    const s = readOrNull(join(privateRoot, src));
    const d = readOrNull(join(root, dest));
    if (d === null) { lines.push(`ONLY-PRIVATE ${dest}`); drift++; }
    else if (!sameBytes(s, d)) { lines.push(`DIFFERS      ${dest}`); drift++; }
  }
  const ign = orphanIgnore(manifest);
  const engineFiles = walkFiles(root, ign);
  for (const rel of engineFiles) {
    if (inScope(rel) && !plannedDests.has(rel)) { lines.push(`ONLY-ENGINE  ${rel}`); drift++; }
  }
  for (const m of missing) lines.push(`MISSING-SOURCE ${m}   (allowlisted but absent in the private repo)`);

  let unaccounted = [];
  if (orphans) {
    const isEngineOnly = engineOnlyMatcher(manifest);
    unaccounted = engineFiles.filter((rel) => !inScope(rel) && !isEngineOnly(rel));
    for (const u of unaccounted) lines.push(`UNACCOUNTED  ${u}`);
  }

  const total = drift + unaccounted.length;
  lines.push(total === 0
    ? `engine-diff: clean (${pairs.length} mirrored file(s) in sync)`
    : `engine-diff: ${drift} drift${orphans ? ` · ${unaccounted.length} unaccounted` : ''} — fix the manifest, not the files.`);
  return { code: total === 0 ? 0 : 1, lines, drift, unaccounted };
}

// ───────────────────────── engine-import ─────────────────────────

/**
 * Reverse direction: engine → private, for contributions that landed in the
 * engine repo after the flip. Dry-run by default. NO deny scan inbound (the
 * private repo may legitimately hold anything). Refuses on a dirty private tree
 * with no --force. Engine files outside manifest scope are reported, never copied.
 */
export function engineImport({
  apply = false, privateRoot = REPO_ROOT, engineRoot = null, manifestPath = DEFAULT_MANIFEST,
} = {}) {
  const lines = [];
  const refuse = (msgs) => ({ code: 2, lines: ['REFUSED:', ...msgs.map((m) => `  ${m}`)] });

  const { manifest, refusals: mr } = loadManifest(manifestPath);
  if (mr) return refuse(mr);
  const { entries, refusals } = normalizeEntries(manifest);
  if (refusals.length) return refuse(refusals);

  const root = resolve(expandTilde(engineRoot || manifest.engineRoot || ''));
  if (!existsSync(root)) return refuse([`engine root does not exist: ${root} (import never creates it)`]);

  // Dirty private tree => refuse. There is deliberately no --force for inbound:
  // review happens afterwards as an ordinary `git diff` in the private repo.
  const dirty = dirtyPaths(privateRoot);
  if (dirty === null) return refuse([`cannot verify the private tree is clean (${privateRoot} is not a git repo) — refusing`]);
  const inSrcScope = srcScope(entries);
  const conflict = dirty.filter(inSrcScope);
  if (conflict.length) {
    return refuse([
      'private repo has uncommitted changes in manifest scope — commit or stash first (no --force exists for inbound).',
      ...conflict.map((p) => `  ${p}`),
    ]);
  }

  const { pairs, missing, symlinks } = expandPairs(entries, root, { direction: 'import' });
  if (symlinks.length) return refuse(['symlink in the engine source set:', ...symlinks.map((s) => `  ${s}`)]);

  const copies = [], unchanged = [];
  for (const { src, dest } of pairs) {
    const s = readOrNull(join(root, src));
    const d = readOrNull(join(privateRoot, dest));
    (sameBytes(s, d) ? unchanged : copies).push({ src, dest });
  }

  // Unmanaged: present in the engine repo, matched by no dest pattern. REPORTED,
  // NEVER COPIED — the structural guarantee that nothing unwanted drags back.
  const inScope = destScope(entries);
  const isEngineOnly = engineOnlyMatcher(manifest);
  const ign = orphanIgnore(manifest);
  const unmanaged = walkFiles(root, ign).filter((rel) => !inScope(rel) && !isEngineOnly(rel));

  for (const { src, dest } of copies) lines.push(`COPY      ${src}  ->  ${dest}`);
  for (const { dest } of unchanged) lines.push(`UNCHANGED ${dest}`);
  for (const m of missing) lines.push(`MISSING-ENGINE ${m}   (in the manifest, absent in the engine repo — import never deletes)`);
  for (const u of unmanaged) lines.push(`unmanaged ${u} — add to the manifest first`);

  if (apply) {
    for (const { src, dest } of copies) {
      const abs = join(privateRoot, dest);
      mkdirSync(dirname(abs), { recursive: true });
      copyFileSync(join(root, src), abs);
    }
    lines.push(`applied: ${copies.length} copied into the private repo — review with \`git diff\`, then commit.`);
  } else {
    lines.push(copies.length === 0
      ? `engine-import: no changes (${unchanged.length} file(s) already identical)`
      : `plan: ${copies.length} copy · ${unchanged.length} unchanged · ${unmanaged.length} unmanaged (never copied)`);
    if (copies.length) lines.push('dry-run — nothing written. Re-run with --apply.');
  }
  return { code: 0, lines, copies, unchanged, unmanaged };
}
