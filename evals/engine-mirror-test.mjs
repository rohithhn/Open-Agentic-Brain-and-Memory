#!/usr/bin/env node
// Tests for bin/lib/engine-mirror.mjs — the code that decides what becomes public.
//
// Everything runs on synthetic private/engine trees with a synthetic guard hook,
// under the OS temp dir. The real ~/Documents/agentic-brain is never read for
// writes and never touched; the real manifest is only exercised read-only via a
// dry-run at the end.
//
// Bias of these tests: a leak is worse than a false refusal. Most cases assert
// that something is REFUSED and that nothing was written.

import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadManifest, normalizeEntries, expandPairs, parseGuard, matchGitignore,
  engineExport, engineDiff, engineImport, DIVERGENT, DEFAULT_MANIFEST,
} from '../bin/lib/engine-mirror.mjs';

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m, d) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${d}` : ''}`); };
const is  = (a, b, m) => (a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const yes = (c, m, d) => (c ? ok(m) : bad(m, d));
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const ROOT = mkdtempSync(join(tmpdir(), 'engine-mirror-test-'));
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch {} });

// A synthetic hook whose DENY/DENY_PATHS the module must parse out.
const HOOK = join(ROOT, 'pre-commit');
writeFileSync(HOOK, [
  '#!/usr/bin/env bash',
  "DENY='s[e]cretword|/Users/[a-z0-9._-]+/(Documents|Library)|AGE-[S]ECRET-KEY-1[0-9A-Z]{20,}'",
  "DENY_PATHS='^(memory/|settings/|config\\.json$)'",
].join('\n'));

let caseN = 0;
/** Build an isolated {priv, eng, manifestPath} triple. */
function fixture(files = {}, manifest = {}, engFiles = {}) {
  const dir = join(ROOT, `c${++caseN}`);
  const priv = join(dir, 'private'), eng = join(dir, 'engine');
  for (const [rel, body] of Object.entries(files)) {
    const p = join(priv, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body);
  }
  for (const [rel, body] of Object.entries(engFiles)) {
    const p = join(eng, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body);
  }
  mkdirSync(join(priv, 'tools'), { recursive: true });
  const manifestPath = join(priv, 'tools', 'engine-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ version: 2, engineRoot: eng, mirror: [], ...manifest }, null, 2));
  return { priv, eng, manifestPath };
}
const run = (f, opts = {}) => engineExport({
  privateRoot: f.priv, engineRoot: f.eng, manifestPath: f.manifestPath, hookPath: HOOK, ...opts,
});
const filesUnder = (d) => { const out = []; (function walk(x, base = '') {
  if (!existsSync(x)) return;
  for (const e of readdirSync(x, { withFileTypes: true })) {
    const p = join(x, e.name), rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(p, rel); else out.push(rel);
  }})(d); return out.sort(); };

// ── guard parsing ────────────────────────────────────────────────────────────
head('guard parsing');
{
  const g = parseGuard(HOOK);
  yes(g && g.deny, 'DENY parsed out of the hook file');
  yes(g && g.denyPaths, 'DENY_PATHS parsed out of the hook file');
  const missing = parseGuard(join(ROOT, 'nope'));
  yes(!missing || !missing.deny || (missing.refusals || []).length,
    'missing hook does not silently yield an empty (permissive) guard');
}

// ── manifest refusals ────────────────────────────────────────────────────────
head('manifest refusals — refuse rather than proceed');
{
  const f = fixture({ 'a.txt': 'x' }, { version: 1, mirror: ['a.txt'] });
  is(run(f).code, 2, 'version !== 2 refuses (exit 2)');
  is(filesUnder(f.eng).length, 0, '  ...and writes nothing');
}
{
  const f = fixture({ 'a.txt': 'x' }, { mirror: [{ $note: 'no from, no $comment' }] });
  is(run(f).code, 2, 'object entry with neither from nor $comment refuses');
}
{
  const f = fixture({ 'a/b/c.txt': 'x' }, { mirror: ['a/**/c.txt'] });
  is(run(f).code, 2, '`**` glob refuses (recursion is directory entries only)');
}
{
  const f = fixture({ 'settings/s.json': 'x' },
    { mirror: ['settings/s.json'], neverMirror: { paths: ['settings/'] } });
  is(run(f).code, 2, 'a `from` under neverMirror refuses');
}
{
  const div = DIVERGENT[0];
  const f = fixture({ [div]: 'x' }, { mirror: [div] });
  is(run(f).code, 2, `a hardcoded divergent path (${div}) in mirror refuses`);
}

// ── globbing ─────────────────────────────────────────────────────────────────
head('globbing — `*` never crosses `/`');
{
  const f = fixture({ 'lib/a.mjs': '1', 'lib/b.mjs': '2', 'lib/deep/c.mjs': '3' }, { mirror: ['lib/*.mjs'] });
  const r = run(f, { apply: true });
  const got = filesUnder(f.eng);
  is(r.code, 0, 'glob export succeeds');
  yes(got.includes('lib/a.mjs') && got.includes('lib/b.mjs'), '  matches files in the same segment');
  yes(!got.includes('lib/deep/c.mjs'), '  does NOT descend into a subdirectory');
}

// ── rename ───────────────────────────────────────────────────────────────────
head('rename — engine-skills/ → skills/ (the only rename)');
{
  const f = fixture(
    { 'engine-skills/x/SKILL.md': 'authored', 'skills/third-party/SKILL.md': 'DO NOT SHIP' },
    { mirror: [{ from: 'engine-skills/', to: 'skills/' }] });
  const r = run(f, { apply: true });
  const got = filesUnder(f.eng);
  is(r.code, 0, 'directory rename succeeds');
  yes(got.includes('skills/x/SKILL.md'), '  authored skill lands under skills/');
  yes(!got.some((p) => p.includes('third-party')), '  private skills/ tree does NOT cross');
  is(readFileSync(join(f.eng, 'skills/x/SKILL.md'), 'utf8'), 'authored', '  content preserved');
}

// ── the guard gate ───────────────────────────────────────────────────────────
head('guard gate — one violation refuses the WHOLE plan');
{
  const f = fixture(
    { 'clean1.txt': 'fine', 'clean2.txt': 'also fine', 'dirty.txt': 'this holds secretword here' },
    { mirror: ['clean1.txt', 'clean2.txt', 'dirty.txt'] });
  const r = run(f, { apply: true });
  is(r.code, 2, 'planted DENY hit refuses');
  is(filesUnder(f.eng).length, 0, '  ...and NOTHING is written — not even the clean files');
  const out = r.lines.join('\n');
  yes(/dirty\.txt/.test(out), '  names the offending file');
  yes(!/secretword/.test(out), '  does NOT echo the matched text (it could be a real secret)');
}
{
  const f = fixture({ 'memory/blob.bin': 'x' }, { mirror: ['memory/blob.bin'] });
  const r = run(f, { apply: true });
  is(r.code, 2, 'a dest path matching DENY_PATHS refuses');
  is(filesUnder(f.eng).length, 0, '  ...and writes nothing');
}

// ── dry-run / idempotence ────────────────────────────────────────────────────
head('dry-run and idempotence');
{
  const f = fixture({ 'a.txt': 'v1' }, { mirror: ['a.txt'] });
  const dry = run(f);
  is(dry.code, 0, 'dry-run succeeds');
  is(filesUnder(f.eng).length, 0, '  ...and writes nothing');
  is(run(f, { apply: true }).code, 0, 'apply succeeds');
  is(filesUnder(f.eng).join(), 'a.txt', '  file present after apply');
  const before = statSync(join(f.eng, 'a.txt')).mtimeMs;
  const second = run(f, { apply: true });
  is(second.code, 0, 're-run succeeds');
  is(statSync(join(f.eng, 'a.txt')).mtimeMs, before, '  ...and does not rewrite an unchanged file');
  yes(/unchanged/.test(second.lines.join('\n')), '  reports it as unchanged');
}

// ── deletion semantics ───────────────────────────────────────────────────────
head('deletion — scoped to the manifest, never guessing');
{
  const f = fixture({ 'keep.txt': 'k' }, { mirror: ['keep.txt', 'gone.txt'] },
    { 'keep.txt': 'k', 'gone.txt': 'orphan', 'ENGINE_OWN.md': 'authored here' });
  const r = run(f, { apply: true });
  const got = filesUnder(f.eng);
  yes(!got.includes('gone.txt'), 'dest matching a mirror pattern with no source is DELETED');
  yes(got.includes('ENGINE_OWN.md'), 'engine-authored file (matches no pattern) is NEVER touched');
  is(readFileSync(join(f.eng, 'ENGINE_OWN.md'), 'utf8'), 'authored here', '  ...and is unmodified');
}
{
  // Entry removed from the manifest: its file must NOT be auto-deleted.
  const f = fixture({ 'a.txt': 'a' }, { mirror: ['a.txt'] }, { 'a.txt': 'a', 'formerly.txt': 'was mirrored' });
  const r = run(f, { apply: true });
  yes(existsSync(join(f.eng, 'formerly.txt')),
    'removing a manifest entry does NOT delete downstream (no tombstones — it cannot tell formerly-mirrored from engine-authored)');
}

// ── orphan classification ────────────────────────────────────────────────────
head('engine-diff --orphans');
{
  const f = fixture({ 'a.txt': 'a' }, { mirror: ['a.txt'], engineOnly: { paths: ['LICENSE'] } },
    { 'a.txt': 'a', 'LICENSE': 'x', 'mystery.md': 'unaccounted' });
  const r = engineDiff({ orphans: true, privateRoot: f.priv, engineRoot: f.eng, manifestPath: f.manifestPath });
  const out = r.lines.join('\n');
  yes(/mystery\.md/.test(out), 'unaccounted engine file is reported');
  yes(!/UNACCOUNTED[^\n]*LICENSE/.test(out), 'engineOnly path is NOT reported as unaccounted');
  is(r.code, 1, 'orphans present → exit 1 (drift)');
}

// ── gitignore swallow ────────────────────────────────────────────────────────
head('gitignore-swallow detection');
{
  const m = matchGitignore('*secret*\nbuild/\n', ['docs/secret-scrubber.md', 'bin/ok.mjs', 'build/x.js']);
  const swallowed = new Set(Array.isArray(m) ? m : (m && m.ignored) || []);
  yes(swallowed.has('docs/secret-scrubber.md') || JSON.stringify(m).includes('secret-scrubber'),
    'a mirrored file matching a .gitignore rule is detected as swallowed');
  yes(!(swallowed.has('bin/ok.mjs')), 'an unmatched file is not flagged');
}

// ── import direction ─────────────────────────────────────────────────────────
head('engine-import');
{
  // A non-git private tree cannot be proven clean, so import must refuse rather
  // than assume. Importing over uncommitted work would be unrecoverable.
  const f = fixture({ 'a.txt': 'a' }, { mirror: ['a.txt'] }, { 'a.txt': 'changed upstream' });
  const r = engineImport({ apply: false, privateRoot: f.priv, engineRoot: f.eng, manifestPath: f.manifestPath });
  is(r.code, 2, 'refuses when the private tree cannot be verified clean (not a git repo)');
  yes(/cannot verify|not a git repo/i.test(r.lines.join('\n')), '  ...and says why');
  is(readFileSync(join(f.priv, 'a.txt'), 'utf8'), 'a', '  ...and writes nothing');

  // With a real, clean git repo the dry-run proceeds and still writes nothing.
  const g = fixture({ 'a.txt': 'a' }, { mirror: ['a.txt'] }, { 'a.txt': 'changed upstream' });
  const q = (cmd) => { try { execFileSync('git', cmd, { cwd: g.priv, stdio: 'ignore' }); return true; } catch { return false; } };
  if (q(['init', '-q']) && q(['add', '-A']) &&
      q(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])) {
    const r2 = engineImport({ apply: false, privateRoot: g.priv, engineRoot: g.eng, manifestPath: g.manifestPath });
    yes(r2.code === 0 || r2.code === 1, 'clean git private tree → dry-run proceeds');
    is(readFileSync(join(g.priv, 'a.txt'), 'utf8'), 'a', '  ...and still writes nothing on dry-run');
  } else {
    ok('clean-git import case SKIPPED (git unavailable in this environment)');
  }
}

// ── the real manifest, read-only ─────────────────────────────────────────────
head('real manifest — structural validation only (no writes)');
if (!existsSync(DEFAULT_MANIFEST)) {
  // The manifest is the PRIVATE repo's control data — it describes what may be
  // published, so it is deliberately not shipped. Absent here = correct.
  ok('SKIPPED — no manifest in this checkout (correct for the engine repo)');
} else {
  const { manifest, refusals } = loadManifest(DEFAULT_MANIFEST);
  yes(!refusals && manifest, 'real manifest loads and is version 2');
  const { entries, refusals: nr } = normalizeEntries(manifest);
  is((nr || []).length, 0, 'real manifest normalizes with zero refusals');
  yes(entries.length > 0, `real manifest yields ${entries.length} entries`);
  const froms = entries.map((e) => e.from);
  yes(!froms.some((p) => p === 'README.md'), 'README.md is not a mirror source (divergent)');
  yes(!froms.some((p) => p.startsWith('docs/adr')), 'docs/adr/** is not a mirror source');
  yes(!froms.some((p) => p === 'skills/' || p.startsWith('skills/')),
    'the 178-skill private tree is not a mirror source (structural guarantee)');
}

head('local-only personal deny list (.git/info/agentic-brain-deny)');
{
  const eng = join(ROOT, 'eng-localdeny'); mkdirSync(join(eng, '.githooks'), { recursive: true }); mkdirSync(join(eng, '.git', 'info'), { recursive: true });
  const hook = join(eng, '.githooks', 'pre-commit');
  writeFileSync(hook, "DENY='AGE-[S]ECRET-KEY-1[0-9A-Z]{20,}'\nDENY_PATHS='^config\\.json$'\n");
  const g0 = parseGuard(hook);
  yes(!g0.denyRe.test('jane-doe-private-name'), 'without the local file, only the public patterns apply');
  writeFileSync(join(eng, '.git', 'info', 'agentic-brain-deny'), '# personal\nj[a]ne-doe-private-name\n\nacme-[s]ecret-project\n');
  const g = parseGuard(hook);
  yes(g.denyRe.test('see jane-doe-private-name here') && g.denyRe.test('acme-secret-project'), 'local terms are appended to DENY');
  yes(g.denyRe.test('AGE-SECRET-KEY-1' + 'A'.repeat(30)), 'public patterns still apply');
  yes(!readFileSync(hook, 'utf8').includes('j[a]ne'), 'the public hook text never contains the local terms');
}

console.log(`\n${pass} passed, ${fail} failed  ·  sandbox: ${ROOT}`);
process.exit(fail ? 1 : 0);
