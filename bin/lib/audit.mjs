// `brain audit` — a read-only answer to "what actually leaves this machine?".
//
// It never writes, deletes or uploads anything, and it never prints a secret
// VALUE: only counts, detector ids, file paths, sizes and yes/no facts. Network
// use is limited to read-only `gh` queries (repo visibility, release metadata)
// and is skipped entirely with --offline.
//
// Sections (each is a list of checks, level ok | warn | fail | info):
//   1. upload     — the one encrypted blob `brain sync` uploads: is it really age ciphertext?
//                   (+ with --deep, the copy GitHub actually holds, downloaded to a temp file)
//   2. committed  — the plaintext files `brain sync` commits/pushes (skills, agents, settings,
//                   engine code), scanned for secrets and for files that must never be plaintext
//   3. scrubber   — secret-scrubber hit counts over the local store (which ships inside the blob)
//   4. key        — where the age key lives (service/account names, presence only)
//   5. recovery   — is there a passphrase-encrypted backup of that key, and is it the right kind
//   6. remote     — git remote(s), repo visibility, where the blob is uploaded
//
// Exit-code rule (same as doctor): 0 iff nothing is a `fail`; warnings never fail the run.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readFileSync, openSync, readSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO_ROOT, REPO_MEMORY, MEMORY_DB, config } from './paths.mjs';
import { SECRET_KEYS, secretBackend, hasSecret } from './keychain.mjs';
import { isLinux } from './platform.mjs';
import { RECOVERY_FILE } from './recovery.mjs';
import { findSecrets, auditScrub } from './scrub.mjs';
import { redactJsonText } from './redact.mjs';
import { BLOB_RELEASE, BLOB_ASSET } from './git.mjs';

const MB = 1024 * 1024;
const SCAN_MAX_BYTES = 512 * 1024;      // bigger files are assets/bundles, not config or prose
const ENTROPY_MIN_SAMPLE = 64 * 1024;   // ciphertext over a sample this big sits at ~7.99 bits/byte
const ENTROPY_FLOOR = 7.9;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|svgz|woff2?|ttf|otf|eot|zip|gz|tgz|age|db|sqlite3?|pdf|mp[34]|mov|wasm|bin)$/i;

// Paths that must NEVER be plaintext in git: they are the memory itself, or key material.
// (memory/brain.age is ciphertext, but it travels as a Release asset — committing it bloats history.)
const FORBIDDEN_TRACKED = [
  [/^memory\/exports\//, 'memory exports (plaintext memory)'],
  [/^memory\/index\.md$/, 'memory index (plaintext memory)'],
  [/^memory\/brain\.age$/, 'encrypted blob (belongs in the Release, not git)'],
  [/^(context|wiki|learnings)\//, 'folder context / wiki / learnings (plaintext memory)'],
  [/(^|\/)[^/]+\.(db|sqlite3?)(-wal|-shm)?$/i, 'database file'],
  [/\.identity$/, 'age identity file'],
  [/(^|\/)\.env(\..+)?$/, '.env file'],
  [/(^|\/)scrub-ledger-[^/]*\.jsonl$/, 'scrub ledger (plaintext secrets)'],
  [/\.pre-restore\.bak$/, 'DB backup'],
];
// History check: same list, minus the ciphertext blob (old blobs in history are ciphertext).
const HISTORY_PATHSPECS = [
  'memory/exports', 'memory/index.md', 'context', 'wiki', 'learnings',
  ':(glob)**/*.db', ':(glob)**/*.sqlite', ':(glob)**/*.sqlite3', ':(glob)**/*.identity',
];
// Synthetic test fixtures that legitimately contain key-shaped strings.
const FIXTURE_PREFIXES = ['evals/scrubber-corpus/'];

const row = (id, level, detail, extra = {}) => ({ id, level, detail, ...extra });

// ── helpers ─────────────────────────────────────────────────────────────────

function gitOut(root, args, { timeout = 30000 } = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout, maxBuffer: 256 * MB,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}
const gitTry = (root, args, opts) => { try { return gitOut(root, args, opts); } catch { return null; } };

export function fmtBytes(n) {
  if (n == null) return '?';
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function shannon(buf) {
  if (!buf.length) return 0;
  const counts = new Uint32Array(256);
  for (let i = 0; i < buf.length; i++) counts[buf[i]]++;
  let h = 0;
  for (const c of counts) if (c) { const p = c / buf.length; h -= p * Math.log2(p); }
  return h;
}

function plaintextMagic(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip archive';
  if (buf.subarray(0, 15).toString('latin1') === 'SQLite format 3') return 'SQLite database';
  if (buf.length >= 262 && buf.subarray(257, 262).toString('latin1') === 'ustar') return 'tar archive';
  const head = buf.subarray(0, 64).toString('utf8');
  if (/^\s*[{[]/.test(head)) return 'JSON text';
  return null;
}

/**
 * Is this file an age-encrypted file? Looks only at the public framing (header
 * lines) and the byte statistics of the body — it never decrypts anything.
 * Works on a file path; returns a plain object (no secrets by construction).
 */
export function inspectAge(path, { sampleBytes = MB } = {}) {
  const out = { path, exists: false, bytes: 0, format: 'missing', recipients: [], scrypt: false, entropy: null, sample: 0, problems: [], ok: false };
  if (!existsSync(path)) { out.problems.push('file does not exist'); return out; }
  out.exists = true;
  let st;
  try { st = statSync(path); } catch (e) { out.problems.push(`cannot stat (${e.code || e.message})`); return out; }
  out.bytes = st.size;
  if (!st.isFile() || st.size === 0) { out.format = 'not-age'; out.problems.push(st.size === 0 ? 'file is empty' : 'not a regular file'); return out; }

  let buf;
  try {
    const fd = openSync(path, 'r');
    try {
      const want = Math.min(st.size, sampleBytes + 16 * 1024);
      buf = Buffer.alloc(want);
      const n = readSync(fd, buf, 0, want, 0);
      buf = buf.subarray(0, n);
    } finally { closeSync(fd); }
  } catch (e) { out.problems.push(`cannot read (${e.code || e.message})`); return out; }

  // ASCII-armored age files decode to the same binary framing.
  if (buf.subarray(0, 34).toString('latin1') === '-----BEGIN AGE ENCRYPTED FILE-----') {
    const b64 = buf.toString('latin1').split(/\r?\n/).slice(1).filter((l) => l && !l.startsWith('-----')).join('');
    buf = Buffer.from(b64, 'base64');
    out.format = 'age-armor';
  }

  const INTRO = 'age-encryption.org/v1\n';
  if (buf.subarray(0, INTRO.length).toString('latin1') !== INTRO) {
    out.format = 'not-age';
    const magic = plaintextMagic(buf);
    out.problems.push(magic ? `not an age file — looks like a ${magic}` : 'not an age file (no age header)');
    return out;
  }
  if (out.format === 'missing') out.format = 'age';

  // Header: stanza lines until the "--- <mac>" line. Plain ASCII, public by design.
  const endIdx = buf.indexOf('\n--- ');
  const macEol = endIdx < 0 ? -1 : buf.indexOf('\n', endIdx + 1);
  if (endIdx < 0 || macEol < 0) { out.problems.push('age header is truncated or malformed'); return out; }
  for (const line of buf.subarray(INTRO.length - 1, endIdx).toString('latin1').split('\n')) {
    const m = /^-> (\S+)/.exec(line);
    if (m) out.recipients.push(m[1]);
  }
  out.scrypt = out.recipients.length > 0 && out.recipients.every((r) => r === 'scrypt');
  if (!out.recipients.length) out.problems.push('age header has no recipient stanza');

  const body = buf.subarray(macEol + 1, macEol + 1 + sampleBytes);
  out.sample = body.length;
  if (body.length >= ENTROPY_MIN_SAMPLE) {
    out.entropy = Math.round(shannon(body) * 1000) / 1000;
    if (out.entropy < ENTROPY_FLOOR) out.problems.push(`payload looks compressible/plaintext (${out.entropy} bits/byte; ciphertext is ~8)`);
  }
  out.ok = out.problems.length === 0;
  return out;
}

// ── 1. what sync uploads ─────────────────────────────────────────────────────

function uploadSection({ blobPath, repoRoot, cfg, dbPath }) {
  const checks = [];
  const blob = inspectAge(blobPath);
  const encOn = cfg.encryption?.enabled !== false;
  if (!encOn) {
    checks.push(row('encryption-enabled', 'fail', 'config.encryption.enabled is false — sync would commit your memory as PLAINTEXT files', { fix: 'set "encryption": {"enabled": true} in config.json' }));
  } else {
    checks.push(row('encryption-enabled', 'ok', 'encryption is enabled (age)'));
  }
  if (!blob.exists) {
    checks.push(row('blob-present', 'info', `no local blob yet (${blobPath}) — nothing has been packed since the last clean; \`brain sync\` creates it`));
  } else if (blob.ok) {
    const kind = blob.recipients.join(', ');
    checks.push(row('blob-ciphertext', 'ok',
      `${basename(blobPath)} is age ciphertext (${fmtBytes(blob.bytes)}; recipient: ${kind}${blob.entropy != null ? `; payload entropy ${blob.entropy} bits/byte` : ''})`));
  } else {
    checks.push(row('blob-ciphertext', 'fail', `${basename(blobPath)} is NOT valid age ciphertext: ${blob.problems.join('; ')}`, { fix: 'do not sync; run `brain sync` again (it re-packs and re-encrypts)' }));
  }
  // What is inside the ciphertext — informational, it never leaves in the clear.
  const inside = ['memory/exports', 'context', 'wiki', 'learnings', 'evals']
    .filter((d) => existsSync(join(repoRoot, d))).map((d) => d.replace('memory/', ''));
  if (dbPath && existsSync(dbPath)) inside.push('store snapshot (claude-mem.db)');
  return { blob, inside, checks };
}

// ── 2. committed plaintext ───────────────────────────────────────────────────

function categorize(p) {
  if (p.startsWith('settings/')) return 'settings';
  if (p.startsWith('skills-external/')) return 'skills-external';
  if (p.startsWith('skills/')) return 'skills';
  if (p.startsWith('agents/')) return 'agents';
  if (p === 'memory/key-recovery.age') return 'recovery';
  if (p === 'MANIFEST.json') return 'manifest';
  if (p === 'config.json') return 'config';
  return 'engine';
}
const SCANNED = new Set(['settings', 'skills', 'skills-external', 'agents', 'manifest', 'config']);

function scanFile(root, rel) {
  if (rel.split('/').includes('node_modules') || BINARY_EXT.test(rel)) return null;
  let st;
  try { st = statSync(join(root, rel)); } catch { return null; }
  if (!st.isFile() || st.size > SCAN_MAX_BYTES) return null;
  let text;
  try {
    const b = readFileSync(join(root, rel));
    if (b.includes(0)) return null;
    text = b.toString('utf8');
  } catch { return null; }
  // Tiers 1-4 only (provider tokens, PEM, key=value assignments, credentialed URLs);
  // tier 5 (generic entropy) is far too noisy on prose/skills to be useful here.
  const hits = findSecrets(text, { tiers: [1, 2, 3, 4], entropyMode: 'off' });
  const unredacted = rel.startsWith('settings/') && rel.endsWith('.json') ? redactJsonText(text) !== text : false;
  return { hits, unredacted, scanned: true };
}

function committedSection({ repoRoot }) {
  const checks = [];
  const listing = gitTry(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeout: 60000 });
  if (listing == null) {
    checks.push(row('git-files', 'info', 'this folder is not a git repository yet — nothing has been committed'));
    return { inGit: false, categories: {}, total: 0, checks };
  }
  const files = listing.split('\0').filter(Boolean).filter((p) => existsSync(join(repoRoot, p)));
  const tracked = new Set((gitTry(repoRoot, ['ls-files', '-z']) || '').split('\0').filter(Boolean));

  const categories = {};
  const forbidden = [];
  const scan = {}; // category -> { files, scannedFiles, byDetector: {id:{tier,hits}}, hitFiles: [{path,hits}], unredacted: [] }
  for (const rel of files) {
    const cat = categorize(rel);
    (categories[cat] ||= { files: 0, pending: 0 });
    categories[cat].files++;
    if (!tracked.has(rel)) categories[cat].pending++;
    for (const [re, why] of FORBIDDEN_TRACKED) {
      if (re.test(rel)) { forbidden.push({ path: rel, why, tracked: tracked.has(rel) }); break; }
    }
    if (!SCANNED.has(cat)) continue;
    const s = scanFile(repoRoot, rel);
    if (!s) continue;
    const sc = (scan[cat] ||= { scannedFiles: 0, byDetector: {}, hitFiles: [], unredacted: [] });
    sc.scannedFiles++;
    if (s.unredacted) sc.unredacted.push(rel);
    if (s.hits.length) {
      sc.hitFiles.push({ path: rel, hits: s.hits.length, fixture: FIXTURE_PREFIXES.some((p) => rel.startsWith(p)) });
      for (const h of s.hits) {
        const e = (sc.byDetector[h.detector] ||= { tier: h.tier, hits: 0 });
        e.hits++;
      }
    }
  }

  const n = (c) => categories[c]?.files || 0;
  checks.push(row('what-is-committed', 'info',
    `${files.length} file(s) travel in git, all plaintext: ${['settings', 'skills', 'skills-external', 'agents', 'recovery', 'manifest', 'config', 'engine']
      .filter((c) => n(c)).map((c) => `${c} ${n(c)}`).join(' · ')}`));
  const pending = Object.values(categories).reduce((a, c) => a + c.pending, 0);
  if (pending) checks.push(row('pending', 'info', `${pending} of those are not committed yet — the next \`brain sync\` (git add -A) will commit them`));

  if (forbidden.length) {
    for (const f of forbidden.slice(0, 10)) {
      checks.push(row('forbidden-path', 'fail', `${f.path} would ${f.tracked ? 'be pushed' : 'be committed by the next sync'} — ${f.why}`, { path: f.path, fix: 'git rm --cached it and add it to .gitignore' }));
    }
    if (forbidden.length > 10) checks.push(row('forbidden-path', 'fail', `…and ${forbidden.length - 10} more`));
  } else {
    checks.push(row('forbidden-path', 'ok', 'no memory exports, databases, identities, .env files or scrub ledgers in git'));
  }

  // Settings: the only category sync actively redacts (assets.mjs pushSettings).
  const st = scan.settings;
  if (n('settings')) {
    const bad = st?.unredacted || [];
    const hits = st ? Object.values(st.byDetector).filter((d) => d.tier <= 2).reduce((a, d) => a + d.hits, 0) : 0;
    if (bad.length || hits) {
      checks.push(row('settings-redacted', 'fail', `settings/ still holds unredacted secrets (${bad.length} file(s) change when re-redacted, ${hits} provider-token hit(s))`, { fix: 'run `brain sync` with a current engine (it redacts on push); rotate any exposed token' }));
    } else {
      checks.push(row('settings-redacted', 'ok', `${n('settings')} settings file(s), secrets masked (re-redacting changes nothing)`));
    }
  }
  // Skills / agents are copied verbatim (no redaction) — so scan, don't claim.
  for (const cat of ['skills', 'skills-external', 'agents']) {
    if (!n(cat)) continue;
    const s = scan[cat];
    const hard = s ? Object.entries(s.byDetector).filter(([, d]) => d.tier <= 2) : [];
    const real = s ? s.hitFiles.filter((f) => !f.fixture) : [];
    const hardHits = hard.reduce((a, [, d]) => a + d.hits, 0);
    if (hardHits) {
      const fileList = real.slice(0, 5).map((f) => `${f.path} (${f.hits})`).join(', ');
      checks.push(row(`${cat}-secrets`, 'warn', `${cat}: ${hardHits} provider-token/private-key pattern hit(s) in ${real.length} file(s), copied verbatim (not redacted) — ${fileList}${real.length > 5 ? ', …' : ''}`, { fix: 'review these files; they are docs/examples or a real secret that should come out' }));
    } else {
      const soft = s ? Object.values(s.byDetector).reduce((a, d) => a + d.hits, 0) : 0;
      checks.push(row(`${cat}-secrets`, 'ok', `${cat}: ${s?.scannedFiles || 0} text file(s) scanned, no provider tokens or private keys${soft ? ` (${soft} low-confidence assignment-style match(es), e.g. "API_KEY=…" in examples)` : ''}; copied verbatim, not redacted`));
    }
  }
  // Anything key-shaped anywhere we scanned.
  const ageKeyHits = Object.values(scan).reduce((a, s) => a + (s.byDetector['age-secret-key']?.hits || 0), 0);
  if (ageKeyHits) checks.push(row('age-key-in-git', 'fail', `an AGE-SECRET-KEY (your private key) appears ${ageKeyHits} time(s) in committed plaintext`, { fix: 'rotate the key now: brain key rotate' }));

  // History: plaintext memory that was committed once is still downloadable.
  const hist = gitTry(repoRoot, ['log', '--all', '--diff-filter=AM', '--name-only', '--format=', '--', ...HISTORY_PATHSPECS], { timeout: 60000 });
  const histPaths = hist ? [...new Set(hist.split('\n').filter(Boolean))] : [];
  if (histPaths.length) {
    checks.push(row('history-plaintext', 'warn', `${histPaths.length} path(s) that must be ciphertext-only exist in git HISTORY (e.g. ${histPaths.slice(0, 3).join(', ')}) — deleting them now does not remove them from the repo's history`, { fix: 'rewrite history (git filter-repo) if they held real memory' }));
  } else if (hist != null) {
    checks.push(row('history-plaintext', 'ok', 'no memory exports, databases or identities ever committed (all branches)'));
  }
  const keyHist = gitTry(repoRoot, ['log', '--all', '-G', 'AGE-SECRET-KEY-1[0-9A-Z]{58}', '--name-only', '--format='], { timeout: 60000 });
  if (keyHist != null) {
    const paths = [...new Set(keyHist.split('\n').filter(Boolean))];
    const real = paths.filter((p) => !FIXTURE_PREFIXES.some((f) => p.startsWith(f)));
    if (real.length) checks.push(row('history-age-key', 'fail', `key-shaped AGE-SECRET-KEY string(s) in git history: ${real.slice(0, 5).join(', ')}`, { fix: 'if it is your real key: brain key rotate, then purge history' }));
    else if (paths.length) checks.push(row('history-age-key', 'info', `key-shaped strings in history only in synthetic test fixtures (${paths.join(', ')})`));
    else checks.push(row('history-age-key', 'ok', 'no age private key in git history'));
  }

  const scanSummary = Object.fromEntries(Object.entries(scan).map(([c, s]) => [c, {
    scannedFiles: s.scannedFiles,
    hits: Object.fromEntries(Object.entries(s.byDetector).map(([id, d]) => [id, d.hits])),
    hitFiles: s.hitFiles.length,
    unredacted: s.unredacted.length,
  }]));
  return { inGit: true, categories, total: files.length, forbidden, scan: scanSummary, historyPlaintextPaths: histPaths.length, checks };
}

// ── 3. scrubber ──────────────────────────────────────────────────────────────

function scrubberSection({ dbPath, doScrub, scrubFn }) {
  const checks = [];
  if (!doScrub) return { skipped: true, checks: [row('scrubber', 'info', 'skipped (--no-scrub)')] };
  if (!dbPath || !existsSync(dbPath)) return { skipped: true, checks: [row('scrubber', 'info', 'no memory store on this machine yet — nothing to scan')] };
  let r;
  try { r = scrubFn({ dbPath }); }
  catch (e) { return { skipped: true, checks: [row('scrubber', 'warn', `could not scan the store (${String(e.message).split('\n')[0]})`)] }; }
  const rows = Object.values(r.rowsScanned).reduce((a, b) => a + b, 0);
  // counts only — auditScrub never returns a value
  const detectors = r.detectors.map((d) => ({ detector: d.detector, tier: d.tier, hits: d.hits, rows: d.rows }));
  if (r.ageSecretKeyFired) {
    checks.push(row('scrub-age-key', 'fail', 'an age private key pattern is stored inside the memory itself (it ships in the encrypted blob, but anyone with the blob AND this text can decrypt it)', { fix: 'brain scrub --apply, then rotate the key: brain key rotate' }));
  }
  if (r.certain > 0) {
    const top = detectors.filter((d) => d.tier <= 4).slice(0, 4).map((d) => `${d.detector} ×${d.hits}`).join(', ');
    checks.push(row('scrub-certain', 'warn', `${r.certain} certain secret hit(s) in ${rows.toLocaleString('en-US')} scanned rows (${top}) — they sit in the store and ship inside the encrypted blob`, { fix: 'brain scrub --apply (backup-first, reversible); rotate anything real' }));
  } else {
    checks.push(row('scrub-certain', 'ok', `0 certain secret hits in ${rows.toLocaleString('en-US')} scanned rows`));
  }
  if (r.review > 0) checks.push(row('scrub-review', 'info', `${r.review} lower-confidence (entropy/tier 5) candidate(s) to review — these are not auto-redacted`));
  return { skipped: false, rowsScanned: r.rowsScanned, certain: r.certain, review: r.review, detectors, checks };
}

// ── 4. key location ──────────────────────────────────────────────────────────

// Presence check that does not read the secret where the OS lets us avoid it:
// `security find-generic-password` WITHOUT -w/-g prints attributes only.
function defaultSecretProbe(service, account) {
  if (isLinux()) return hasSecret(account);
  try {
    execFileSync('security', ['find-generic-password', '-s', service, '-a', account], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 10000 });
    return true;
  } catch { return false; }
}

function keySection({ cfg, secretProbe }) {
  const checks = [];
  const backend = secretBackend();
  const service = cfg.keychainService || 'claude-brain';
  const where = backend === 'keychain' ? 'macOS login Keychain' : backend === 'libsecret' ? 'libsecret (secret-tool)' : 'encrypted file';
  const identity = !!secretProbe(service, SECRET_KEYS.AGE_KEY);
  const recipient = !!secretProbe(service, SECRET_KEYS.AGE_RECIPIENT);
  if (identity) {
    checks.push(row('key-present', 'ok', `age private key: ${where}, service "${service}", account "${SECRET_KEYS.AGE_KEY}" (never written to disk or git)`));
  } else {
    checks.push(row('key-present', 'warn', `no age private key at ${where} service "${service}" account "${SECRET_KEYS.AGE_KEY}" — sync cannot encrypt or decrypt on this machine`, { fix: 'brain key import (or brain key recover if you made a passphrase backup)' }));
  }
  checks.push(row('recipient-present', recipient ? 'ok' : (identity ? 'warn' : 'info'),
    recipient ? `age public key (recipient): account "${SECRET_KEYS.AGE_RECIPIENT}" present` : `no public key at account "${SECRET_KEYS.AGE_RECIPIENT}"`));
  return { backend, service, accounts: { identity: SECRET_KEYS.AGE_KEY, recipient: SECRET_KEYS.AGE_RECIPIENT }, identityPresent: identity, recipientPresent: recipient, checks };
}

// ── 5. recovery passphrase backup ────────────────────────────────────────────

function recoverySection({ repoRoot, recoveryPath }) {
  const checks = [];
  const f = inspectAge(recoveryPath, { sampleBytes: 4096 });
  const rel = 'memory/key-recovery.age';
  if (!f.exists) {
    checks.push(row('recovery-file', 'warn', 'no recovery passphrase backup — if this Mac\'s key is lost, every backup is unreadable', { fix: 'brain key backup' }));
    return { exists: false, checks };
  }
  if (!f.ok || !f.scrypt) {
    checks.push(row('recovery-file', 'fail', `${rel} is not a passphrase-encrypted age file (${f.problems.join('; ') || `recipient: ${f.recipients.join(', ')}`})`, { fix: 'brain key backup (replaces it)' }));
  } else {
    checks.push(row('recovery-file', 'ok', `${rel} exists: age file with a single passphrase (scrypt) recipient, ${fmtBytes(f.bytes)}`));
  }
  let mode = null;
  try { mode = (statSync(recoveryPath).mode & 0o777).toString(8); } catch {}
  const tracked = gitTry(repoRoot, ['ls-files', '--error-unmatch', '--', rel]) != null;
  const branch = (gitTry(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main').trim();
  const pushed = gitTry(repoRoot, ['cat-file', '-e', `refs/remotes/origin/${branch}:${rel}`]) != null
    || gitTry(repoRoot, ['cat-file', '-e', `refs/remotes/origin/main:${rel}`]) != null;
  checks.push(row('recovery-committed', tracked ? 'ok' : 'warn',
    tracked ? `committed to the brain repo${pushed ? ' and present on origin (per last fetch)' : ' (not seen on origin yet — pushed by the next sync)'}`
      : 'present locally but not committed — a new Mac cannot get it from the repo yet', tracked ? {} : { fix: 'brain sync' }));
  return { exists: true, ok: f.ok && f.scrypt, recipients: f.recipients, bytes: f.bytes, mode, tracked, pushed, checks };
}

// ── 6. remote + visibility ───────────────────────────────────────────────────

export function parseRemote(raw) {
  if (!raw) return null;
  let url = String(raw).trim();
  let credentials = false;
  let host = 'local';
  let path = url;
  let m;
  if ((m = /^(https?|ssh|git):\/\/(?:([^@/]+)@)?([^/:]+)(?::\d+)?\/(.*)$/.exec(url))) {
    host = m[3].toLowerCase(); path = m[4];
    if (m[2] && m[1].startsWith('http')) { credentials = true; url = url.replace(`${m[2]}@`, ''); }
  } else if ((m = /^[^@\s]+@([^:\s]+):(.*)$/.exec(url))) {
    host = m[1].toLowerCase(); path = m[2];
  } else if (/^file:\/\//.test(url)) {
    path = url.replace(/^file:\/\//, '');
  }
  const segs = path.replace(/\.git$/, '').split('/').filter(Boolean);
  const slug = segs.length >= 2 ? `${segs[segs.length - 2]}/${segs[segs.length - 1]}` : null;
  return { url, host, slug, credentials };
}

function defaultGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * MB, stdio: ['ignore', 'pipe', 'pipe'] });
}

function visibilityOf(gh, slug) {
  try {
    const j = JSON.parse(gh(['repo', 'view', slug, '--json', 'isPrivate,visibility']));
    const v = j.visibility ? String(j.visibility).toUpperCase() : (j.isPrivate ? 'PRIVATE' : 'PUBLIC');
    return { visibility: v };
  } catch (e) {
    return { error: String((e.stderr || e.message || e)).split('\n')[0].slice(0, 160) };
  }
}

function remoteSection({ repoRoot, cfg, network, deep, gh, blob, blobPath }) {
  const checks = [];
  const cfgSlug = cfg.repo?.owner && cfg.repo?.name ? `${cfg.repo.owner}/${cfg.repo.name}` : null;

  // remotes: fetch / push URLs from git config (raw, before any insteadOf rewriting), credentials stripped.
  const remotes = [];
  const cfgList = gitTry(repoRoot, ['config', '--get-regexp', '^remote\\..+\\.(url|pushurl)$']);
  if (cfgList) {
    const by = {};
    for (const line of cfgList.split('\n').filter(Boolean)) {
      const m = /^remote\.(.+)\.(url|pushurl)\s+(.*)$/.exec(line);
      if (m) (by[m[1]] ||= {})[m[2]] = m[3];
    }
    for (const [name, v] of Object.entries(by)) {
      const p = parseRemote(v.url);
      remotes.push({ name, url: p?.url || null, host: p?.host || null, slug: p?.slug || null, credentialsInUrl: !!p?.credentials,
        pushDisabled: v.pushurl === 'no_push' || v.pushurl === 'DISABLED' });
    }
  }
  const origin = remotes.find((r) => r.name === 'origin') || null;

  if (!origin) {
    checks.push(row('remote', 'info', 'no git remote "origin" — `brain sync` commits locally and uploads nothing (no push, no blob upload)'));
  } else {
    checks.push(row('remote', 'info', `sync pushes to origin → ${origin.url} (${origin.host})`));
    if (origin.credentialsInUrl) checks.push(row('remote-credentials', 'fail', 'the origin URL has a credential embedded in it (stored in .git/config in plaintext)', { fix: 'git remote set-url origin https://github.com/<owner>/<repo>.git and use `gh auth login`' }));
  }
  const others = remotes.filter((r) => r.name !== 'origin');
  if (others.length) {
    checks.push(row('other-remotes', 'info', `other remote(s), not used by sync: ${others.map((r) => `${r.name}${r.pushDisabled ? ' (push disabled)' : ''}`).join(', ')}`));
  }

  // The blob goes to config.repo's release; git pushes to origin. Normally identical.
  if (origin?.slug && cfgSlug && origin.slug !== cfgSlug) {
    checks.push(row('slug-mismatch', 'warn', `git pushes to ${origin.slug} but the encrypted blob is uploaded to ${cfgSlug} (config.json repo.owner/name)`, { fix: 'make config.json match origin' }));
  }

  const out = { remotes, configSlug: cfgSlug, blobTarget: cfgSlug, visibility: {}, cloud: null, checks };
  if (!network) {
    checks.push(row('visibility', 'info', 'repo visibility not checked (--offline)'));
    return out;
  }
  if (!origin && !cfgSlug) return out;

  // visibility of every place something is sent to
  const targets = [...new Set([origin?.host === 'github.com' ? origin.slug : null, cfgSlug].filter(Boolean))];
  for (const slug of targets) {
    const v = visibilityOf(gh, slug);
    out.visibility[slug] = v;
    if (v.error) { checks.push(row('visibility', 'warn', `could not read visibility of ${slug} (${v.error})`)); continue; }
    if (v.visibility === 'PRIVATE') {
      checks.push(row('visibility', 'ok', `${slug} is PRIVATE`));
    } else if (cfg.repo?.private === false) {
      checks.push(row('visibility', 'warn', `${slug} is ${v.visibility} (config.json says private:false) — your plaintext skills/agents/settings and the ciphertext blob are world-readable`));
    } else {
      checks.push(row('visibility', 'fail', `${slug} is ${v.visibility} but config.json expects a private repo — anyone can read your plaintext skills/agents/settings and download the ciphertext blob`, { fix: 'gh repo edit ' + slug + ' --visibility private --accept-visibility-change-consequences' }));
    }
  }

  // what the cloud release actually holds
  if (cfgSlug) {
    try {
      const j = JSON.parse(gh(['release', 'view', BLOB_RELEASE, '-R', cfgSlug, '--json', 'assets']));
      const assets = (j.assets || []).map((a) => ({ name: a.name, size: a.size, updatedAt: a.updatedAt || null }));
      const a = assets.find((x) => x.name === BLOB_ASSET);
      const extra = assets.filter((x) => x.name !== BLOB_ASSET);
      out.cloud = { release: BLOB_RELEASE, asset: a || null, extraAssets: extra.map((x) => x.name) };
      if (!a) checks.push(row('cloud-blob', 'info', `release ${BLOB_RELEASE} exists but has no ${BLOB_ASSET} yet`));
      else {
        const same = blob.exists && a.size === blob.bytes;
        checks.push(row('cloud-blob', 'info', `cloud holds ${BLOB_ASSET} in release ${BLOB_RELEASE}: ${fmtBytes(a.size)}${a.updatedAt ? `, updated ${a.updatedAt}` : ''}${blob.exists ? (same ? ' (same size as the local blob)' : ' (differs from the local blob — another device or a pending sync)') : ''}`));
      }
      if (extra.length) checks.push(row('cloud-extra-assets', 'warn', `release ${BLOB_RELEASE} also holds other file(s): ${extra.map((x) => x.name).join(', ')} — sync only uploads ${BLOB_ASSET}`, { fix: 'check them on GitHub; delete if unexpected' }));
      if (deep && a) {
        const tmp = mkdtempSync(join(tmpdir(), 'brain-audit-'));
        try {
          const dest = join(tmp, BLOB_ASSET);
          gh(['release', 'download', BLOB_RELEASE, '-R', cfgSlug, '-p', BLOB_ASSET, '-O', dest, '--clobber']);
          const c = inspectAge(dest);
          out.cloud.verified = { ok: c.ok, bytes: c.bytes, recipients: c.recipients, entropy: c.entropy, problems: c.problems };
          checks.push(row('cloud-ciphertext', c.ok ? 'ok' : 'fail',
            c.ok ? `downloaded the cloud copy and verified it: age ciphertext (${fmtBytes(c.bytes)}, recipient ${c.recipients.join(', ')}${c.entropy != null ? `, entropy ${c.entropy}` : ''})`
              : `the cloud copy is NOT age ciphertext: ${c.problems.join('; ')}`, c.ok ? {} : { fix: 'delete the release asset and re-run brain sync' }));
        } catch (e) {
          checks.push(row('cloud-ciphertext', 'warn', `could not download the cloud copy to verify it (${String(e.stderr || e.message).split('\n')[0].slice(0, 120)})`));
        } finally { rmSync(tmp, { recursive: true, force: true }); }
      }
    } catch (e) {
      const msg = String(e.stderr || e.message || e);
      if (/release not found|no releases found/i.test(msg)) checks.push(row('cloud-blob', 'info', `no ${BLOB_RELEASE} release on ${cfgSlug} yet — nothing uploaded`));
      else checks.push(row('cloud-blob', 'warn', `could not read release ${BLOB_RELEASE} on ${cfgSlug} (${msg.split('\n')[0].slice(0, 140)})`));
    }
  }
  return out;
}

// ── run + format ─────────────────────────────────────────────────────────────

/**
 * Run every audit check. Read-only. Options are injectable so tests can point
 * it at a temp repo / store and stub the OS and GitHub:
 *   repoRoot, dbPath, blobPath, recoveryPath, cfg, secretProbe(service, account), gh(args), scrubFn({dbPath})
 *   network (default true)  deep (default false: download + verify the cloud blob)  scrub (default true)
 */
export function runAudit({
  repoRoot = REPO_ROOT,
  dbPath = MEMORY_DB,
  blobPath = join(REPO_MEMORY, 'brain.age'),
  recoveryPath = RECOVERY_FILE,
  cfg = config,
  network = true,
  deep = false,
  scrub = true,
  secretProbe = defaultSecretProbe,
  gh = defaultGh,
  scrubFn = auditScrub,
} = {}) {
  const upload = uploadSection({ blobPath, repoRoot, cfg, dbPath });
  const committed = committedSection({ repoRoot });
  const scrubber = scrubberSection({ dbPath, doScrub: scrub, scrubFn });
  const key = keySection({ cfg, secretProbe });
  const recovery = recoverySection({ repoRoot, recoveryPath });
  const remote = remoteSection({ repoRoot, cfg, network, deep, gh, blob: upload.blob, blobPath });

  const sections = { upload, committed, scrubber, key, recovery, remote };
  const all = Object.values(sections).flatMap((s) => s.checks);
  const count = (l) => all.filter((c) => c.level === l).length;
  const failCount = count('fail');
  const warnCount = count('warn');
  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    network,
    deep: !!(network && deep),
    verdict: failCount ? 'fail' : warnCount ? 'review' : 'clean',
    failCount,
    warnCount,
    exitCode: failCount ? 1 : 0,
    sections,
  };
}

const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌', info: '➖' };

export function formatAudit(r) {
  const L = [];
  const show = (checks) => {
    for (const c of checks) {
      L.push(`  ${ICON[c.level] || '•'} ${c.detail}`);
      if (c.fix && (c.level === 'fail' || c.level === 'warn')) L.push(`       → ${c.fix}`);
    }
  };
  const { upload, committed, scrubber, key, recovery, remote } = r.sections;
  L.push('brain audit — what leaves this machine');
  L.push('read-only · counts, paths and yes/no facts only; never a secret value');
  L.push('');
  L.push('1. Encrypted upload (brain sync → GitHub Release asset)');
  if (upload.inside.length) L.push(`     inside the ciphertext: ${upload.inside.join(', ')}`);
  show(upload.checks);
  L.push('');
  L.push('2. Plaintext committed to git (brain sync → git push)');
  show(committed.checks);
  L.push('');
  L.push('3. Secret scrubber (local memory store)');
  show(scrubber.checks);
  L.push('');
  L.push('4. Where the key lives');
  show(key.checks);
  L.push('');
  L.push('5. Recovery passphrase backup');
  show(recovery.checks);
  L.push('');
  L.push('6. Remote + visibility');
  show(remote.checks);
  L.push('');
  if (!r.network) L.push('(offline: GitHub visibility and the cloud copy were not checked)');
  else if (!r.deep) L.push('(tip: --deep downloads the cloud blob and verifies it is age ciphertext)');
  L.push(r.verdict === 'clean' ? '✅ nothing concerning leaves this machine.'
    : r.verdict === 'review' ? `⚠️  ${r.warnCount} item(s) to review, nothing failing.`
      : `❌ ${r.failCount} failing check(s)${r.warnCount ? `, ${r.warnCount} to review` : ''} — see the fixes above.`);
  return L.join('\n');
}
