#!/usr/bin/env node
// Tests for bin/lib/audit.mjs — `brain audit`, the read-only "what leaves this
// machine" report.
//
//   node evals/audit-test.mjs
//
// Everything runs against temp git repos and synthetic stores. The OS secret
// store and GitHub are stubbed through runAudit()'s injection points, and the
// one end-to-end CLI run gets a PATH holding fake `security` / `gh`, so neither
// the real Keychain nor the network is ever touched. The real `age` binary is
// used (when installed) only to produce genuine ciphertext to classify.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const A = await import('../bin/lib/audit.mjs');
const { ageScryptEncrypt } = await import('../bin/lib/recovery.mjs');

const ROOT = join(tmpdir(), `brain-audit-test-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

let pass = 0, fail = 0, skip = 0;
const results = [];
async function t(name, fn) {
  try {
    const r = await fn();
    if (r === 'skip') { skip++; results.push(['SKIP', name, '']); }
    else { pass++; results.push(['PASS', name, '']); }
  } catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const has = (bin) => spawnSync('/usr/bin/which', [bin]).status === 0;

// Synthetic credentials, built at runtime so this committed file holds no key-shaped literal.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rnd = (n, set = ALNUM) => Array.from(randomBytes(n), (b) => set[b % set.length]).join('');
const FAKE_ANTHROPIC = 'sk-ant-' + 'api03-' + rnd(90);
const FAKE_AGE = 'AGE-SECRET-KEY-' + '1' + rnd(58, 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L');
const FAKE_TOKEN = 'gh' + 'p_' + rnd(36);

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (root, rel, body) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); return p; };

// A small but realistic brain repo: clean settings, a skill, an agent.
let n = 0;
function mkRepo({ commit = true } = {}) {
  const root = join(ROOT, `repo${++n}`);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  write(root, 'settings/settings.json', JSON.stringify({ theme: 'dark', env: { ANTHROPIC_API_KEY: 'REDACTED-BY-CLAUDE-BRAIN' } }, null, 2) + '\n');
  write(root, 'skills/demo/SKILL.md', '---\nname: demo\ndescription: a demo skill\n---\nNothing secret here.\n');
  write(root, 'agents/reviewer.md', '# reviewer\nReviews code.\n');
  write(root, 'MANIFEST.json', '{"files":[]}\n');
  write(root, 'bin/tool.mjs', '// engine\n');
  if (commit) { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init'); }
  return root;
}
const CFG = { repo: { owner: 'o', name: 'r', private: true }, encryption: { enabled: true }, keychainService: 'claude-brain' };
const noGh = () => { throw new Error('gh must not be called'); };
// Options that keep every run hermetic.
const base = (root, extra = {}) => ({
  repoRoot: root, dbPath: join(root, 'no-such.db'), blobPath: join(root, 'memory', 'brain.age'),
  recoveryPath: join(root, 'memory', 'key-recovery.age'), cfg: CFG, network: false, scrub: false,
  secretProbe: () => true, gh: noGh, ...extra,
});
const find = (r, id) => Object.values(r.sections).flatMap((s) => s.checks).filter((c) => c.id === id);
const one = (r, id) => { const c = find(r, id); assert(c.length >= 1, `no check "${id}"`); return c[0]; };
const dump = (r) => JSON.stringify(r) + '\n' + A.formatAudit(r);

// ── inspectAge: is it really age ciphertext? ─────────────────────────────
const hasAge = has('age') && has('age-keygen');
let realBlob = null, armorBlob = null;
if (hasAge) {
  const id = join(ROOT, 'id.txt');
  execFileSync('age-keygen', ['-o', id], { stdio: 'ignore' });
  const recip = execFileSync('age-keygen', ['-y', id], { encoding: 'utf8' }).trim();
  const plain = join(ROOT, 'payload.tgz');
  // 1 MiB of text-like data: compressible as plaintext, but ciphertext must look random.
  writeFileSync(plain, Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(25000)));
  realBlob = join(ROOT, 'real.age');
  armorBlob = join(ROOT, 'armor.age');
  execFileSync('age', ['-r', recip, '-o', realBlob, plain]);
  execFileSync('age', ['-a', '-r', recip, '-o', armorBlob, plain]);
}

await t('inspectAge: real age ciphertext is accepted (X25519 recipient, high entropy)', () => {
  if (!hasAge) return 'skip';
  const r = A.inspectAge(realBlob);
  assert(r.ok && r.format === 'age' && r.recipients[0] === 'X25519', JSON.stringify(r));
  assert(r.entropy > 7.9, `entropy ${r.entropy}`);
  assert(r.scrypt === false, 'an X25519 file is not a passphrase file');
});
await t('inspectAge: ASCII-armored age ciphertext is accepted', () => {
  if (!hasAge) return 'skip';
  const r = A.inspectAge(armorBlob);
  assert(r.ok && r.format === 'age-armor', JSON.stringify(r));
});
await t('inspectAge: a gzip/tar payload (an UNencrypted blob) is rejected, named as such', () => {
  const p = join(ROOT, 'plain.tgz');
  const tar = join(ROOT, 't.txt'); writeFileSync(tar, 'hello'.repeat(1000));
  execFileSync('tar', ['-czf', p, '-C', ROOT, 't.txt']);
  const r = A.inspectAge(p);
  assert(!r.ok && r.format === 'not-age' && /gzip/.test(r.problems.join()), JSON.stringify(r));
});
await t('inspectAge: SQLite, JSON, empty, missing and truncated-header files are rejected', () => {
  const sq = join(ROOT, 's.db'); const d = new DatabaseSync(sq); d.exec('CREATE TABLE x(a)'); d.close();
  assert(!A.inspectAge(sq).ok && /SQLite/.test(A.inspectAge(sq).problems.join()), 'sqlite');
  const js = write(ROOT, 'j.json', '{"a":1}'); assert(!A.inspectAge(js).ok && /JSON/.test(A.inspectAge(js).problems.join()), 'json');
  const em = write(ROOT, 'e.age', ''); assert(!A.inspectAge(em).ok, 'empty');
  assert(!A.inspectAge(join(ROOT, 'nope.age')).ok && A.inspectAge(join(ROOT, 'nope.age')).exists === false, 'missing');
  const tr = write(ROOT, 'tr.age', 'age-encryption.org/v1\n-> X25519 abc\nxyz'); assert(!A.inspectAge(tr).ok, 'truncated header');
});
await t('inspectAge: a valid age header wrapped around a PLAINTEXT body fails the entropy check', () => {
  const hdr = 'age-encryption.org/v1\n-> X25519 ' + rnd(43) + '\n' + rnd(43) + '\n--- ' + rnd(43) + '\n';
  const p = write(ROOT, 'fake.age', hdr + 'this is plainly readable text. '.repeat(6000));
  const r = A.inspectAge(p);
  assert(!r.ok && r.entropy < 7.9 && /plaintext|compressible/.test(r.problems.join()), JSON.stringify(r));
});
await t('inspectAge: a passphrase (scrypt) file from recovery.mjs is recognised as scrypt-only', () => {
  const p = join(ROOT, 'rec.age');
  writeFileSync(p, ageScryptEncrypt(Buffer.from(FAKE_AGE + '\n'), 'correct horse battery', { logN: 10 }));
  const r = A.inspectAge(p, { sampleBytes: 4096 });
  assert(r.ok && r.scrypt && r.recipients.join() === 'scrypt', JSON.stringify(r));
});

// ── section 1: the upload ────────────────────────────────────────────────
await t('upload: valid local blob -> ok; plaintext blob -> FAIL + exit 1; absent -> info', () => {
  const root = mkRepo();
  const none = A.runAudit(base(root));
  assert(one(none, 'blob-present').level === 'info', 'absent blob should be info');
  write(root, 'memory/brain.age', 'plain text pretending to be a blob');
  const bad = A.runAudit(base(root));
  assert(one(bad, 'blob-ciphertext').level === 'fail' && bad.exitCode === 1 && bad.verdict === 'fail', 'plaintext blob must fail');
  if (!hasAge) return 'skip';
  writeFileSync(join(root, 'memory/brain.age'), readFileSync(realBlob));
  const good = A.runAudit(base(root));
  assert(one(good, 'blob-ciphertext').level === 'ok', 'real blob should pass');
});
await t('upload: encryption disabled in config is a FAIL', () => {
  const r = A.runAudit(base(mkRepo(), { cfg: { ...CFG, encryption: { enabled: false } } }));
  assert(one(r, 'encryption-enabled').level === 'fail' && r.exitCode === 1, 'disabled encryption must fail');
});

// ── section 2: committed plaintext ───────────────────────────────────────
await t('committed: a clean repo is clean and lists the categories', () => {
  const r = A.runAudit(base(mkRepo()));
  const c = r.sections.committed;
  assert(c.inGit && c.categories.settings.files === 1 && c.categories.skills.files === 1 && c.categories.agents.files === 1, JSON.stringify(c.categories));
  assert(one(r, 'forbidden-path').level === 'ok' && one(r, 'settings-redacted').level === 'ok', 'expected ok rows');
  assert(r.failCount === 0, `unexpected fail: ${dump(r)}`);
});
await t('committed: pending (uncommitted, not ignored) files are counted; ignored ones are not', () => {
  const root = mkRepo();
  write(root, '.gitignore', 'memory/exports/\n');
  write(root, 'skills/new/SKILL.md', 'new\n');
  write(root, 'memory/exports/p/day.jsonl', '{"a":1}\n');
  const r = A.runAudit(base(root));
  assert(r.sections.committed.categories.skills.pending === 1, 'pending skill');
  assert(one(r, 'forbidden-path').level === 'ok', 'ignored exports must not count');
  assert(find(r, 'pending').length === 1, 'pending info row');
});
await t('committed: tracked memory exports / DBs / .env / identities / ledgers are FAILs', () => {
  const root = mkRepo();
  for (const p of ['memory/exports/p/day.jsonl', 'memory/index.md', 'context/x.md', 'wiki/a.md', 'data/brain.db', 'k.identity', '.env', 'scrub-ledger-1.jsonl']) write(root, p, 'x\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'oops');
  const r = A.runAudit(base(root));
  const f = find(r, 'forbidden-path');
  assert(f.length === 8 && f.every((x) => x.level === 'fail'), `expected 8 fails, got ${f.length}: ${f.map((x) => x.detail)}`);
  assert(r.exitCode === 1, 'exit code');
});
await t('committed: unredacted settings are a FAIL; the secret VALUE is never printed', () => {
  const root = mkRepo();
  write(root, 'settings/settings.json', JSON.stringify({ env: { ANTHROPIC_API_KEY: FAKE_ANTHROPIC, note: FAKE_TOKEN } }, null, 2) + '\n');
  const r = A.runAudit(base(root));
  assert(one(r, 'settings-redacted').level === 'fail', 'unredacted settings must fail');
  const out = dump(r);
  assert(!out.includes(FAKE_ANTHROPIC) && !out.includes(FAKE_TOKEN), 'secret value leaked into the report');
});
await t('committed: skills/agents are copied verbatim, so a real-looking token there is a WARN (not redacted), value hidden', () => {
  const root = mkRepo();
  write(root, 'skills/leaky/SKILL.md', `# leaky\nexport ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}\n`);
  write(root, 'agents/leaky.md', `token ${FAKE_TOKEN}\n`);
  const r = A.runAudit(base(root));
  const s = one(r, 'skills-secrets'), a = one(r, 'agents-secrets');
  assert(s.level === 'warn' && /leaky/.test(s.detail) && /not redacted/.test(s.detail), s.detail);
  assert(a.level === 'warn', a.detail);
  assert(r.exitCode === 0, 'warnings must not fail the run');
  const out = dump(r);
  assert(!out.includes(FAKE_ANTHROPIC) && !out.includes(FAKE_TOKEN), 'secret value leaked into the report');
});
await t('committed: node_modules and binary files are not scanned', () => {
  const root = mkRepo();
  write(root, 'skills/demo/node_modules/pkg/index.js', `const k="${FAKE_ANTHROPIC}"\n`);
  write(root, 'skills/demo/logo.png', `${FAKE_ANTHROPIC}`);
  const r = A.runAudit(base(root));
  assert(one(r, 'skills-secrets').level === 'ok', one(r, 'skills-secrets').detail);
});
await t('committed: an age private key in committed text is a FAIL', () => {
  const root = mkRepo();
  write(root, 'skills/demo/notes.md', `my key: ${FAKE_AGE}\n`);
  const r = A.runAudit(base(root));
  assert(one(r, 'age-key-in-git').level === 'fail' && r.exitCode === 1, 'age key in git must fail');
  assert(!dump(r).includes(FAKE_AGE), 'age key leaked into the report');
});
await t('committed: plaintext memory committed once and later deleted is flagged from HISTORY', () => {
  const root = mkRepo();
  write(root, 'memory/exports/p/day.jsonl', '{"a":1}\n');
  git(root, 'add', '-A', '-f'); git(root, 'commit', '-q', '-m', 'add exports');
  git(root, 'rm', '-q', '-r', 'memory/exports'); git(root, 'commit', '-q', '-m', 'remove exports');
  const r = A.runAudit(base(root));
  assert(one(r, 'forbidden-path').level === 'ok', 'gone from the tree');
  assert(one(r, 'history-plaintext').level === 'warn' && /memory\/exports\/p\/day\.jsonl/.test(one(r, 'history-plaintext').detail), one(r, 'history-plaintext').detail);
  assert(r.exitCode === 0, 'history is a warning');
});
await t('committed: an age key in history -> FAIL, but only in the synthetic scrubber corpus -> info', () => {
  const root = mkRepo();
  write(root, 'evals/scrubber-corpus/positives.txt', FAKE_AGE + '\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'corpus');
  assert(one(A.runAudit(base(root)), 'history-age-key').level === 'info', 'fixture should be info');
  write(root, 'notes/real.txt', FAKE_AGE + '\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'oops');
  git(root, 'rm', '-q', 'notes/real.txt'); git(root, 'commit', '-q', '-m', 'remove');
  const r = A.runAudit(base(root));
  assert(one(r, 'history-age-key').level === 'fail' && r.exitCode === 1, 'age key in history must fail');
  assert(!dump(r).includes(FAKE_AGE), 'age key leaked into the report');
});
await t('committed: a folder that is not a git repo reports info, not a crash', () => {
  const root = join(ROOT, 'nogit'); mkdirSync(root, { recursive: true });
  const r = A.runAudit(base(root));
  assert(r.sections.committed.inGit === false && r.exitCode === 0, 'expected a quiet report');
});

// ── section 3: scrubber (counts only) ────────────────────────────────────
function synthDb(path, rows) {
  const d = new DatabaseSync(path);
  d.exec('CREATE TABLE observations(id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, created_at TEXT, created_at_epoch INTEGER)');
  const ins = d.prepare('INSERT INTO observations(project,title,text,created_at,created_at_epoch) VALUES(?,?,?,?,?)');
  rows.forEach((r, i) => ins.run('p', r.title, r.text, '2026-01-01', 1700000000 + i));
  d.close();
}
await t('scrubber: reports hit COUNTS by detector and never the value', () => {
  const db = join(ROOT, 'store1.db');
  synthDb(db, [
    { title: 'a', text: `deploy used ${FAKE_TOKEN} today` },
    { title: 'b', text: `also ${FAKE_TOKEN} and ${FAKE_ANTHROPIC}` },
    { title: 'c', text: 'nothing to see here' },
  ]);
  const before = readFileSync(db);
  const r = A.runAudit(base(mkRepo(), { dbPath: db, scrub: true }));
  const s = r.sections.scrubber;
  assert(!s.skipped && s.certain >= 3, `certain=${s.certain}`);
  assert(s.detectors.some((d) => d.detector === 'github-token' && d.hits === 2), JSON.stringify(s.detectors));
  assert(one(r, 'scrub-certain').level === 'warn', 'hits should warn');
  const out = dump(r);
  assert(!out.includes(FAKE_TOKEN) && !out.includes(FAKE_ANTHROPIC), 'secret value leaked into the report');
  assert(readFileSync(db).equals(before), 'the store must not be modified');
});
await t('scrubber: a clean store is ok; --no-scrub and a missing store are skipped cleanly', () => {
  const db = join(ROOT, 'store2.db');
  synthDb(db, [{ title: 'a', text: 'plain prose about a migration' }]);
  assert(one(A.runAudit(base(mkRepo(), { dbPath: db, scrub: true })), 'scrub-certain').level === 'ok', 'clean store');
  assert(A.runAudit(base(mkRepo(), { dbPath: db, scrub: false })).sections.scrubber.skipped === true, '--no-scrub');
  assert(A.runAudit(base(mkRepo(), { scrub: true })).sections.scrubber.skipped === true, 'missing store');
});
await t('scrubber: an age key inside the memory text is a FAIL', () => {
  const db = join(ROOT, 'store3.db');
  synthDb(db, [{ title: 'a', text: `pasted by mistake: ${FAKE_AGE}` }]);
  const r = A.runAudit(base(mkRepo(), { dbPath: db, scrub: true }));
  assert(one(r, 'scrub-age-key').level === 'fail' && r.exitCode === 1, 'age key in memory must fail');
  assert(!dump(r).includes(FAKE_AGE), 'age key leaked into the report');
});
await t('scrubber: an unreadable store degrades to a warning, not a crash', () => {
  const r = A.runAudit(base(mkRepo(), { dbPath: join(ROOT, 'store1.db'), scrub: true, scrubFn: () => { throw new Error('boom'); } }));
  assert(one(r, 'scrubber').level === 'warn' && r.exitCode === 0, 'expected a warning');
});

// ── section 4: where the key lives ───────────────────────────────────────
await t('key: reports service/account and presence, only ever asks "is it there"', () => {
  const asked = [];
  const r = A.runAudit(base(mkRepo(), { secretProbe: (svc, acct) => { asked.push([svc, acct]); return true; } }));
  assert(one(r, 'key-present').level === 'ok' && /claude-brain/.test(one(r, 'key-present').detail) && /age-identity/.test(one(r, 'key-present').detail), one(r, 'key-present').detail);
  assert(asked.length === 2 && asked.every(([s]) => s === 'claude-brain'), JSON.stringify(asked));
  assert(r.sections.key.identityPresent === true && r.sections.key.backend, 'section data');
});
await t('key: a missing key is a warning with a fix', () => {
  const r = A.runAudit(base(mkRepo(), { secretProbe: () => false }));
  const c = one(r, 'key-present');
  assert(c.level === 'warn' && /brain key/.test(c.fix) && r.exitCode === 0, JSON.stringify(c));
});
await t('key: honours a custom keychain service name from config', () => {
  const r = A.runAudit(base(mkRepo(), { cfg: { ...CFG, keychainService: 'my-brain' }, secretProbe: () => true }));
  assert(/my-brain/.test(one(r, 'key-present').detail), one(r, 'key-present').detail);
});

// ── section 5: recovery backup ───────────────────────────────────────────
await t('recovery: no file -> warn with `brain key backup`', () => {
  const r = A.runAudit(base(mkRepo()));
  const c = one(r, 'recovery-file');
  assert(c.level === 'warn' && /brain key backup/.test(c.fix) && r.sections.recovery.exists === false, JSON.stringify(c));
});
await t('recovery: a committed scrypt file is ok; an untracked one warns it is local-only', () => {
  const root = mkRepo();
  write(root, 'memory/.keep', '');
  writeFileSync(join(root, 'memory', 'key-recovery.age'), ageScryptEncrypt(Buffer.from(FAKE_AGE + '\n'), 'correct horse battery', { logN: 10 }));
  const local = A.runAudit(base(root));
  assert(one(local, 'recovery-file').level === 'ok' && one(local, 'recovery-committed').level === 'warn', 'untracked');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'recovery');
  const done = A.runAudit(base(root));
  assert(one(done, 'recovery-committed').level === 'ok' && done.sections.recovery.tracked === true, 'tracked');
  assert(!dump(done).includes(FAKE_AGE), 'identity leaked');
});
await t('recovery: a file that is NOT a passphrase file (or not age at all) is a FAIL', () => {
  const root = mkRepo();
  write(root, 'memory/key-recovery.age', 'AGE-SECRET-KEY-looks-plain');
  const r = A.runAudit(base(root));
  assert(one(r, 'recovery-file').level === 'fail' && r.exitCode === 1, 'plaintext recovery file must fail');
  if (!hasAge) return 'skip';
  writeFileSync(join(root, 'memory/key-recovery.age'), readFileSync(realBlob)); // X25519, not scrypt
  assert(one(A.runAudit(base(root)), 'recovery-file').level === 'fail', 'a non-passphrase file must fail');
});

// ── section 6: remote + visibility ───────────────────────────────────────
const ghStub = ({ vis = { isPrivate: true, visibility: 'PRIVATE' }, assets = [{ name: 'brain.age', size: 1234, updatedAt: '2026-01-01T00:00:00Z' }], download } = {}) => (args) => {
  const a = args.join(' ');
  if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify(vis);
  if (args[0] === 'release' && args[1] === 'view') { if (assets === null) throw Object.assign(new Error('x'), { stderr: 'release not found' }); return JSON.stringify({ assets }); }
  if (args[0] === 'release' && args[1] === 'download') { const o = args[args.indexOf('-O') + 1]; download(o); return ''; }
  throw new Error('unexpected gh ' + a);
};
function withOrigin(root, url) { git(root, 'remote', 'add', 'origin', url); return root; }
await t('remote: no origin -> nothing is pushed or uploaded (info)', () => {
  const r = A.runAudit(base(mkRepo()));
  assert(one(r, 'remote').level === 'info' && /no git remote/.test(one(r, 'remote').detail), one(r, 'remote').detail);
});
await t('remote: private repo ok; public repo FAIL (config says private); public with private:false only warns', () => {
  const root = withOrigin(mkRepo(), 'https://github.com/o/r.git');
  const priv = A.runAudit(base(root, { network: true, gh: ghStub() }));
  assert(find(priv, 'visibility').every((c) => c.level === 'ok') && priv.exitCode === 0, dump(priv));
  const pub = A.runAudit(base(root, { network: true, gh: ghStub({ vis: { isPrivate: false, visibility: 'PUBLIC' } }) }));
  assert(one(pub, 'visibility').level === 'fail' && pub.exitCode === 1 && /PUBLIC/.test(one(pub, 'visibility').detail), 'public must fail');
  const cfgPub = A.runAudit(base(root, { network: true, cfg: { ...CFG, repo: { ...CFG.repo, private: false } }, gh: ghStub({ vis: { isPrivate: false, visibility: 'PUBLIC' } }) }));
  assert(one(cfgPub, 'visibility').level === 'warn' && cfgPub.exitCode === 0, 'declared-public only warns');
});
await t('remote: visibility also derives from isPrivate when gh gives no `visibility`', () => {
  const root = withOrigin(mkRepo(), 'https://github.com/o/r.git');
  const r = A.runAudit(base(root, { network: true, gh: ghStub({ vis: { isPrivate: false } }) }));
  assert(one(r, 'visibility').level === 'fail', 'isPrivate:false means public');
});
await t('remote: a credential embedded in the origin URL is a FAIL and is stripped from the output', () => {
  const root = withOrigin(mkRepo(), `https://${FAKE_TOKEN}@github.com/o/r.git`);
  const r = A.runAudit(base(root));
  assert(one(r, 'remote-credentials').level === 'fail' && r.exitCode === 1, 'credential in URL must fail');
  assert(!dump(r).includes(FAKE_TOKEN), 'credential leaked into the report');
  assert(r.sections.remote.remotes[0].credentialsInUrl === true && r.sections.remote.remotes[0].url === 'https://github.com/o/r.git', 'url should be stripped');
});
await t('remote: origin != config repo is flagged (blob goes to config.repo)', () => {
  const root = withOrigin(mkRepo(), 'https://github.com/someone/else.git');
  const r = A.runAudit(base(root));
  assert(one(r, 'slug-mismatch').level === 'warn' && /someone\/else/.test(one(r, 'slug-mismatch').detail) && /o\/r/.test(one(r, 'slug-mismatch').detail), 'mismatch row');
});
await t('remote: ssh-style URLs parse; other remotes (engine, push disabled) are listed but not used', () => {
  const root = withOrigin(mkRepo(), 'git@github.com:o/r.git');
  git(root, 'remote', 'add', 'engine', 'https://github.com/pub/engine.git'); git(root, 'remote', 'set-url', '--push', 'engine', 'no_push');
  const r = A.runAudit(base(root));
  assert(r.sections.remote.remotes.find((x) => x.name === 'origin').slug === 'o/r', 'ssh slug');
  assert(/engine \(push disabled\)/.test(one(r, 'other-remotes').detail), one(r, 'other-remotes').detail);
  assert(find(r, 'slug-mismatch').length === 0, 'no false mismatch');
});
await t('remote: parseRemote handles https/ssh/file/credentials/garbage', () => {
  assert(A.parseRemote('https://github.com/a/b.git').slug === 'a/b', 'https');
  assert(A.parseRemote('git@github.com:a/b.git').host === 'github.com', 'ssh');
  assert(A.parseRemote('file:///tmp/x/a/b.git').host === 'local', 'file');
  const c = A.parseRemote('https://user:pw@github.com/a/b'); assert(c.credentials && !c.url.includes('pw'), 'cred');
  assert(A.parseRemote('') === null && A.parseRemote('weird').slug === null, 'garbage');
});
await t('remote: --offline never calls gh', () => {
  const root = withOrigin(mkRepo(), 'https://github.com/o/r.git');
  const r = A.runAudit(base(root, { network: false, gh: noGh }));
  assert(one(r, 'visibility').level === 'info' && /offline/.test(one(r, 'visibility').detail), 'offline row');
});
await t('remote: cloud release metadata, extra assets warn, missing release is info, gh errors degrade to a warning', () => {
  const root = withOrigin(mkRepo(), 'https://github.com/o/r.git');
  const ok = A.runAudit(base(root, { network: true, gh: ghStub() }));
  assert(/1\.2 KB/.test(one(ok, 'cloud-blob').detail), one(ok, 'cloud-blob').detail);
  const extra = A.runAudit(base(root, { network: true, gh: ghStub({ assets: [{ name: 'brain.age', size: 5 }, { name: 'dump.sqlite', size: 9 }] }) }));
  assert(one(extra, 'cloud-extra-assets').level === 'warn' && /dump\.sqlite/.test(one(extra, 'cloud-extra-assets').detail), 'extra asset');
  const none = A.runAudit(base(root, { network: true, gh: ghStub({ assets: null }) }));
  assert(one(none, 'cloud-blob').level === 'info', 'no release');
  const down = A.runAudit(base(root, { network: true, gh: () => { throw new Error('dial tcp: no such host'); } }));
  assert(find(down, 'visibility')[0].level === 'warn' && down.exitCode === 0, 'gh down must not fail the audit');
});
await t('remote --deep: downloads the cloud blob to a temp file and verifies it (ciphertext ok, plaintext FAIL)', () => {
  if (!hasAge) return 'skip';
  const root = withOrigin(mkRepo(), 'https://github.com/o/r.git');
  let dest = null;
  const good = A.runAudit(base(root, { network: true, deep: true, gh: ghStub({ download: (o) => { dest = o; writeFileSync(o, readFileSync(realBlob)); } }) }));
  assert(one(good, 'cloud-ciphertext').level === 'ok' && good.deep === true, dump(good));
  assert(dest && !existsSync(dest), 'temp download must be cleaned up');
  const bad = A.runAudit(base(root, { network: true, deep: true, gh: ghStub({ download: (o) => writeFileSync(o, 'plain readable text '.repeat(5000)) }) }));
  assert(one(bad, 'cloud-ciphertext').level === 'fail' && bad.exitCode === 1, 'plaintext cloud blob must fail');
  const shallow = A.runAudit(base(root, { network: true, deep: false, gh: ghStub({ download: () => { throw new Error('must not download'); } }) }));
  assert(find(shallow, 'cloud-ciphertext').length === 0, 'no download without --deep');
});

// ── the whole report ─────────────────────────────────────────────────────
await t('report: JSON shape is stable and the text report has every section', () => {
  const r = A.runAudit(base(mkRepo()));
  for (const k of ['generatedAt', 'verdict', 'failCount', 'warnCount', 'exitCode', 'sections']) assert(k in r, `missing ${k}`);
  for (const s of ['upload', 'committed', 'scrubber', 'key', 'recovery', 'remote']) assert(Array.isArray(r.sections[s].checks), `section ${s}`);
  assert(JSON.parse(JSON.stringify(r)).verdict === r.verdict, 'serialisable');
  const text = A.formatAudit(r);
  for (const h of ['1. Encrypted upload', '2. Plaintext committed', '3. Secret scrubber', '4. Where the key lives', '5. Recovery passphrase', '6. Remote']) assert(text.includes(h), `text missing "${h}"`);
});
await t('report: verdict is clean / review / fail and exit code follows fail only', () => {
  const root = mkRepo();
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'key-recovery.age'), ageScryptEncrypt(Buffer.from(FAKE_AGE + '\n'), 'correct horse battery', { logN: 10 }));
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'rec');
  withOrigin(root, 'https://github.com/o/r.git');
  const clean = A.runAudit(base(root, { network: true, gh: ghStub() }));
  assert(clean.verdict === 'clean' && clean.exitCode === 0 && clean.failCount === 0 && clean.warnCount === 0, `${clean.verdict}: ${dump(clean)}`);
  const review = A.runAudit(base(root, { network: true, gh: ghStub(), secretProbe: () => false }));
  assert(review.verdict === 'review' && review.exitCode === 0, review.verdict);
  const failing = A.runAudit(base(root, { network: true, gh: ghStub({ vis: { visibility: 'PUBLIC' } }) }));
  assert(failing.verdict === 'fail' && failing.exitCode === 1, failing.verdict);
});
await t('report: the audit is read-only — repo files and git state are unchanged by a run', () => {
  const root = mkRepo();
  write(root, 'skills/new/SKILL.md', 'pending\n');
  const snap = () => git(root, 'status', '--porcelain') + git(root, 'rev-parse', 'HEAD') + readFileSync(join(root, 'settings/settings.json'), 'utf8');
  const before = snap();
  A.runAudit(base(root));
  assert(snap() === before, 'repo changed during audit');
  assert(!existsSync(join(root, '.brain-tmp')) && !existsSync(join(root, 'memory')), 'audit created files');
});

// ── the CLI, end to end, in a hermetic environment ───────────────────────
const BRAIN = join(import.meta.dirname, '..', 'bin', 'brain.mjs');
function cliEnv() {
  const bin = join(ROOT, 'fakebin'); mkdirSync(bin, { recursive: true });
  // fake `security`: keychain item not found; fake `gh`: fail loudly if ever called
  writeFileSync(join(bin, 'security'), '#!/bin/sh\necho "security called: $*" >> "$AUDIT_TEST_LOG"\nexit 44\n'); chmodSync(join(bin, 'security'), 0o755);
  // Linux: the same role is played by libsecret's `secret-tool` (item not found → exit 1).
  writeFileSync(join(bin, 'secret-tool'), '#!/bin/sh\necho "secret-tool called: $*" >> "$AUDIT_TEST_LOG"\nexit 1\n'); chmodSync(join(bin, 'secret-tool'), 0o755);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh called: $*" >> "$AUDIT_TEST_LOG"\nexit 1\n'); chmodSync(join(bin, 'gh'), 0o755);
  const home = join(ROOT, 'home'); mkdirSync(home, { recursive: true });
  const log = join(ROOT, 'cli-calls.log'); writeFileSync(log, '');
  return { log, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, AUDIT_TEST_LOG: log, BRAIN_NO_AUTOMATION: '1', BRAIN_TEST: '1' } };
}
await t('cli: `brain audit --json --offline --no-scrub` prints valid JSON, asks the (fake) keychain only for presence, never calls gh', () => {
  const { log, env } = cliEnv();
  const r = spawnSync(process.execPath, [BRAIN, 'audit', '--json', '--offline', '--no-scrub'], { env, encoding: 'utf8' });
  assert(r.stdout.trim().startsWith('{'), `stdout not JSON: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}`);
  const j = JSON.parse(r.stdout);
  assert(j.network === false && j.sections.key.identityPresent === false, 'offline + fake keychain');
  assert(r.status === j.exitCode, `exit ${r.status} vs ${j.exitCode}`);
  const calls = readFileSync(log, 'utf8');
  assert(!/gh called/.test(calls), 'gh was called with --offline');
  if (process.platform === 'linux') {
    // libsecret has no presence-only query; the probe is a `lookup`, and it must hit the keyring, never a file/argv leak
    assert(/secret-tool called: lookup .*account age-identity/.test(calls), `keychain probe missing: ${calls}`);
  } else {
    assert(/security called: find-generic-password/.test(calls) && !/ -w( |$)/.test(calls) && !/ -g( |$)/.test(calls), `keychain probe must not request the secret: ${calls}`);
  }
});
await t('cli: text mode prints the sections; --help lists audit and does not run it', () => {
  const { env } = cliEnv();
  const r = spawnSync(process.execPath, [BRAIN, 'audit', '--offline', '--no-scrub'], { env, encoding: 'utf8' });
  assert(/brain audit — what leaves this machine/.test(r.stdout) && /6\. Remote/.test(r.stdout), r.stdout.slice(0, 300));
  const h = spawnSync(process.execPath, [BRAIN, '--help'], { env, encoding: 'utf8' });
  assert(/audit \[--json\]/.test(h.stdout), 'help should list audit');
  const h2 = spawnSync(process.execPath, [BRAIN, 'audit', '--help'], { env, encoding: 'utf8' });
  assert(h2.status === 0 && !/read-only · counts/.test(h2.stdout) && !/1\. Encrypted upload/.test(h2.stdout), '`audit --help` must not run the audit');
});

rmSync(ROOT, { recursive: true, force: true });
for (const [s, name, why] of results) console.log(`${s === 'PASS' ? '  ✓' : s === 'SKIP' ? '  -' : '  ✗'} ${name}${why ? ` — ${why}` : ''}`);
console.log(`\naudit: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
