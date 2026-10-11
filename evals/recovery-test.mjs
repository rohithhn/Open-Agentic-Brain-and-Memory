#!/usr/bin/env node
// Tests for bin/lib/recovery.mjs — the key recovery passphrase — and the
// recovery offer in `brain init` (bin/lib/init.mjs).
//
//   node evals/recovery-test.mjs
//
// Pure functions on temp files only: no Keychain (real or fake), no git, no
// network, and `brain init` runs against a fully stubbed world. Two interop
// checks drive the real `age` binary through a pty (`script`) and are skipped
// when either tool is missing. The end-to-end CLI story (Mac A backs up, Mac B
// restores with the passphrase only) lives in evals/sandbox/sandbox-test.sh §8.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { ptyWrap } from './lib/pty.mjs';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const R = await import('../bin/lib/recovery.mjs');
const { runInit, offerRecoveryPassphrase } = await import('../bin/lib/init.mjs');
const { CONFIG_EXAMPLE_PATH } = await import('../bin/lib/paths.mjs');

const ROOT = join(tmpdir(), `brain-recovery-test-${process.pid}`);
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
function throwsCode(fn, code, msg) {
  try { fn(); } catch (e) { if (e.code === code) return e; throw new Error(`${msg}: got ${e.code || e.message}`); }
  throw new Error(`${msg}: did not throw`);
}
const has = (bin) => spawnSync('/usr/bin/which', [bin]).status === 0;
// A syntactically valid identity; real crypto is not needed for format checks.
const FAKE_ID = 'AGE-SECRET-KEY-1' + Array.from(randomBytes(58), (b) => 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L'[b % 32]).join('');
const PASS = 'correct horse battery staple';
const FAST = { logN: 10 }; // tests only; the CLI uses age's default (18)

// ── the age scrypt format ────────────────────────────────────────────────
await t('round-trips a small payload', () => {
  const pt = Buffer.from('hello\n');
  assert(R.ageScryptDecrypt(R.ageScryptEncrypt(pt, PASS, FAST), PASS).equals(pt), 'plaintext differs');
});

await t('round-trips a multi-chunk payload (STREAM, 64 KiB chunks)', () => {
  for (const n of [0, 65536, 65537, 200000]) {
    const pt = randomBytes(n);
    assert(R.ageScryptDecrypt(R.ageScryptEncrypt(pt, PASS, FAST), PASS).equals(pt), `size ${n} differs`);
  }
});

await t('header looks like `age -p` output (single scrypt stanza, work factor 18 by default)', () => {
  const head = R.ageScryptEncrypt(Buffer.from('x'), PASS).subarray(0, 120).toString('latin1').split('\n');
  assert(head[0] === 'age-encryption.org/v1', 'intro line');
  assert(/^-> scrypt [A-Za-z0-9+/]{22} 18$/.test(head[1]), `stanza line: ${head[1]}`);
});

await t('wrong passphrase → WRONG_PASSPHRASE', () => {
  const enc = R.ageScryptEncrypt(Buffer.from('secret'), PASS, FAST);
  throwsCode(() => R.ageScryptDecrypt(enc, PASS + '!'), 'WRONG_PASSPHRASE', 'wrong passphrase');
  throwsCode(() => R.ageScryptDecrypt(enc, ''), 'WRONG_PASSPHRASE', 'empty passphrase');
});

await t('tampering is detected (header MAC, payload, truncation) → BAD_FILE', () => {
  const enc = R.ageScryptEncrypt(Buffer.from('secret payload'), PASS, FAST);
  const text = enc.toString('latin1');
  const hdr = Buffer.from(enc); hdr[text.indexOf('scrypt ') + 9] = text[text.indexOf('scrypt ') + 9] === 'A' ? 66 : 65; // change one salt char
  const pay = Buffer.from(enc); pay[pay.length - 5] ^= 1;
  throwsCode(() => R.ageScryptDecrypt(pay, PASS), 'BAD_FILE', 'payload flip');
  throwsCode(() => R.ageScryptDecrypt(enc.subarray(0, enc.length - 20), PASS), 'BAD_FILE', 'truncated');
  // altering the MAC itself
  const macAt = text.indexOf('\n--- ') + 5;
  const mac = Buffer.from(enc); mac[macAt] = mac[macAt] === 65 ? 66 : 65;
  throwsCode(() => R.ageScryptDecrypt(mac, PASS), 'BAD_FILE', 'mac flip');
  // a changed salt derives a different key: indistinguishable from a wrong passphrase, but never succeeds
  try { R.ageScryptDecrypt(hdr, PASS); throw new Error('salt flip decrypted'); }
  catch (e) { assert(['WRONG_PASSPHRASE', 'BAD_FILE'].includes(e.code), `salt flip: ${e.message}`); }
});

await t('refuses non-passphrase files and absurd work factors', () => {
  throwsCode(() => R.ageScryptDecrypt(Buffer.from('not age at all\n--- x\n'), PASS), 'BAD_FILE', 'garbage');
  const x25519 = Buffer.from('age-encryption.org/v1\n-> X25519 AAAA\nBBBB\n--- CCCC\n');
  throwsCode(() => R.ageScryptDecrypt(x25519, PASS), 'BAD_FILE', 'x25519 file');
  const enc = R.ageScryptEncrypt(Buffer.from('x'), PASS, FAST).toString('latin1').replace(/ 10\n/, ' 30\n');
  throwsCode(() => R.ageScryptDecrypt(Buffer.from(enc, 'latin1'), PASS), 'BAD_FILE', 'logN 30');
});

// ── the recovery file ───────────────────────────────────────────────────
await t('writeRecoveryFile → readRecoveryFile returns the identity; file holds no plaintext, mode 0600', () => {
  const path = join(ROOT, 'memory', 'key-recovery.age');
  R.writeRecoveryFile(FAKE_ID, PASS, { path, recipient: 'age1example', ...FAST });
  assert(R.hasRecoveryFile(path), 'file exists');
  const raw = readFileSync(path);
  assert(!raw.includes(FAKE_ID) && !raw.includes('AGE-SECRET-KEY'), 'plaintext key in file');
  assert(!raw.includes(PASS), 'passphrase in file');
  assert((statSync(path).mode & 0o777) === 0o600, 'mode 0600');
  assert(R.readRecoveryFile(PASS, { path }) === FAKE_ID, 'identity round-trip');
  throwsCode(() => R.readRecoveryFile('wrong passphrase!!', { path }), 'WRONG_PASSPHRASE', 'wrong passphrase');
  assert(R.readRecoveryFile(PASS, { path }) === FAKE_ID, 'file untouched by a failed attempt');
});

await t('refuses weak passphrases and non-keys; missing file → NO_FILE', () => {
  const path = join(ROOT, 'weak.age');
  throwsCode(() => R.writeRecoveryFile(FAKE_ID, 'short', { path, ...FAST }), 'WEAK_PASSPHRASE', 'short');
  throwsCode(() => R.writeRecoveryFile(FAKE_ID, 'aaaaaaaaaaaaaaaa', { path, ...FAST }), 'WEAK_PASSPHRASE', 'repeated');
  throwsCode(() => R.writeRecoveryFile('AGE-SECRET-KEY-…', PASS, { path, ...FAST }), 'BAD_IDENTITY', 'placeholder');
  assert(!existsSync(path), 'nothing written on refusal');
  throwsCode(() => R.readRecoveryFile(PASS, { path }), 'NO_FILE', 'missing file');
  assert(R.passphraseProblem(PASS) === null, 'a good passphrase passes');
});

// ── interop with the real age CLI (age reads passphrases from a tty only) ─
const canInterop = has('age') && has('script');
await t('real `age -d` opens our recovery file with the passphrase', () => {
  if (!canInterop) return 'skip';
  const path = join(ROOT, 'interop.age'), out = join(ROOT, 'interop.txt');
  R.writeRecoveryFile(FAKE_ID, PASS, { path, ...FAST });
  // the feeder stays open until age exits, so its pty never sees an early EOF
  spawnSync('bash', ['-c', `( sleep 1; printf '%s\\r' "$P"; sleep 4 ) | ${ptyWrap('age -d -o "$O" "$F"')}`],
    { env: { ...process.env, P: PASS, O: out, F: path }, stdio: 'ignore', timeout: 20000 });
  assert(existsSync(out), 'age -d produced no output');
  assert(readFileSync(out, 'utf8').includes(FAKE_ID), 'age -d output lacks the identity');
});

await t('a file made by real `age -p` opens with ours', () => {
  if (!canInterop) return 'skip';
  const src = join(ROOT, 'p.txt'), enc = join(ROOT, 'p.age');
  writeFileSync(src, 'made by age -p\n');
  spawnSync('bash', ['-c', `( sleep 1; printf '%s\\r' "$P"; sleep 1; printf '%s\\r' "$P"; sleep 4 ) | ${ptyWrap('age -p -o "$O" "$F"')}`],
    { env: { ...process.env, P: PASS, O: enc, F: src }, stdio: 'ignore', timeout: 20000 });
  assert(existsSync(enc), 'age -p produced no file');
  assert(R.ageScryptDecrypt(readFileSync(enc), PASS).toString() === 'made by age -p\n', 'plaintext differs');
});

// ── brain init: the offer ────────────────────────────────────────────────
// A stubbed world: gh says the repo does not exist, no key yet, config writes
// go nowhere, sync is recorded. Nothing real is touched.
function world({ answers = [], hidden = [], hasRecovery = false } = {}) {
  const calls = [];
  const w = {
    calls,
    written: null,
    log: () => {},
    nodeMajor: () => 22,
    which: () => true,
    hasKey: async () => false,
    generateAndStoreKey: async () => { calls.push('keygen'); return 'age1stub'; },
    getRecipient: async () => 'age1stub',
    getIdentity: async () => FAKE_ID,
    deleteKeyPair: async () => {},
    hasRecovery: async () => hasRecovery,
    promptHidden: async (q) => { calls.push('hidden'); return hidden.length ? hidden.shift() : null; },
    passphraseProblem: async (p) => R.passphraseProblem(p),
    writeRecovery: async (identity, passphrase, recipient) => { calls.push('writeRecovery'); w.written = { identity, passphrase, recipient }; },
    gh: (args) => {
      if (args[0] === 'auth' || args[0] === 'api') return { ok: true, code: 0, out: args.includes('.login') ? 'stub-user' : '', err: '' };
      if (args[0] === 'repo' && args[1] === 'view') return { ok: false, code: 1, out: '', err: 'Could not resolve to a Repository' };
      if (args[0] === 'repo' && args[1] === 'create') { calls.push('repo-create'); return { ok: true, code: 0, out: '', err: '' }; }
      return { ok: false, code: 1, out: '', err: 'release not found' };
    },
    git: (args) => (args[0] === 'remote' && args[1] === 'add' ? { ok: true, code: 0, out: '', err: '' } : { ok: false, code: 1, out: '', err: '' }),
    exists: (p) => p === CONFIG_EXAMPLE_PATH,
    readFile: () => '{}',
    writeFileAtomic: () => {},
    removeFile: () => {},
    sync: () => { calls.push('sync'); return { ok: true, code: 0, out: '', err: '' }; },
    onboard: () => ({ ok: true }),
    prompt: async (q) => { calls.push('prompt'); return answers.length ? answers.shift() : null; },
  };
  return w;
}

await t('init offers a recovery passphrase and writes it BEFORE the first sync', async () => {
  const w = world({ answers: ['y'], hidden: [PASS, PASS] });
  const r = await runInit({ repo: 'brain', noAutomation: true }, w);
  assert(r.recoverySet === true, 'recoverySet');
  assert(w.written && w.written.identity === FAKE_ID && w.written.passphrase === PASS && w.written.recipient === 'age1stub', 'wrote identity + passphrase + recipient');
  const i = w.calls.indexOf('writeRecovery'), s = w.calls.indexOf('sync'), k = w.calls.indexOf('keygen');
  assert(k >= 0 && k < i && i < s, `order keygen → recovery → sync: ${w.calls.join(',')}`);
  assert(!r.warnings.some((x) => /recovery passphrase/.test(x)), 'no "add one" warning');
});

await t('init: "n" skips it, --yes never asks, and both leave a `brain key backup` hint', async () => {
  const w1 = world({ answers: ['n'] });
  const r1 = await runInit({ repo: 'brain', noAutomation: true }, w1);
  assert(!r1.recoverySet && !w1.calls.includes('hidden') && !w1.written, 'declined → nothing asked or written');
  assert(r1.warnings.some((x) => /brain key backup/.test(x)), 'hint after decline');
  const w2 = world();
  const r2 = await runInit({ repo: 'brain', noAutomation: true, yes: true }, w2);
  assert(!w2.calls.includes('prompt') && !w2.written, '--yes asks nothing');
  assert(r2.ok && r2.warnings.some((x) => /brain key backup/.test(x)), 'hint with --yes, init still ok');
});

await t('init: an existing recovery file is not asked about again', async () => {
  const w = world({ hasRecovery: true });
  const r = await runInit({ repo: 'brain', noAutomation: true }, w);
  assert(r.recoverySet && !w.calls.includes('prompt') && !w.written, 'no prompt, no rewrite');
});

await t('offer: weak / mismatched entries are retried, then it gives up without failing init', async () => {
  const w = world({ hidden: ['short', PASS, PASS + 'x', PASS, PASS] });
  assert(await offerRecoveryPassphrase({ deps: w, recipient: 'age1stub' }) === true, 'third try succeeds');
  assert(w.written.passphrase === PASS, 'the confirmed passphrase is used');
  const w2 = world({ hidden: ['short', 'short', 'short'] });
  assert(await offerRecoveryPassphrase({ deps: w2, recipient: '' }) === false && !w2.written, 'gives up after 3');
  const w3 = world({ hidden: [''] });
  assert(await offerRecoveryPassphrase({ deps: w3, recipient: '' }) === false && !w3.written, 'Enter skips');
  const w4 = world({ answers: ['y'], hidden: [PASS, PASS] });
  w4.writeRecovery = async () => { throw new Error('disk full'); };
  const r4 = await runInit({ repo: 'brain', noAutomation: true }, w4);
  assert(r4.ok && !r4.recoverySet, 'a write failure never fails init');
});

// ── report ──────────────────────────────────────────────────────────────
console.log(`\nrecovery-test: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}\n`);
for (const [status, name, msg] of results) console.log(`  ${status === 'PASS' ? '✓' : status === 'SKIP' ? '-' : '✗'} ${name}${msg ? `\n      ${msg}` : ''}`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
