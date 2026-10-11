#!/usr/bin/env node
// Tests that keychain.mjs setSecret never puts the secret on argv (where any
// local process can read it with `ps`): it runs `security -i` and sends the
// add-generic-password command on stdin. Checks the stored value round-trips
// byte-for-byte — spaces, quotes, backslashes, $, tabs, UTF-8.
//
//   node evals/keychain-test.mjs
//
// Writes go to the sandbox's fake file-backed `security` (evals/sandbox/shims
// and core/) behind an argv-logging wrapper, in a temp HOME — the real Keychain
// is never written. On macOS one extra check feeds the REAL /usr/bin/security
// a read-only `show-keychain-info "<quoted>"` for a keychain path that does not
// exist, proving the real line parser un-quotes our encoding exactly (its error
// message echoes the parsed argument). That touches no keychain and no prefs.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SB = mkdtempSync(join(tmpdir(), 'brain-keychain-'));
const HOME = join(SB, 'home'), BIN = join(SB, 'bin'), KC = join(SB, 'keychain');
const ARGV_LOG = join(SB, 'argv.log'), SB_LOG = join(SB, 'calls.log');
for (const d of [HOME, BIN, KC]) mkdirSync(d, { recursive: true });

// `security` = argv logger in front of a fake; SHIM_DIR picks shims/ or core/.
let SHIM_DIR = join(HERE, 'sandbox', 'shims');
const wrapper = join(BIN, 'security');
writeFileSync(wrapper, `#!/bin/bash\nprintf '%s\\0' "security" "$@" >> "${ARGV_LOG}"; printf '\\n' >> "${ARGV_LOG}"\nexec /bin/bash "$SHIM_DIR/security" "$@"\n`);
chmodSync(wrapper, 0o755);

process.env.HOME = HOME;
process.env.PATH = `${BIN}:${dirname(process.execPath)}:/usr/bin:/bin`;
process.env.SB_KEYCHAIN = KC;
process.env.SB_LOG = SB_LOG;
process.env.BRAIN_PLATFORM_OVERRIDE = 'darwin';
delete process.env.SB_KEYCHAIN_DENY;

const K = await import('../bin/lib/keychain.mjs');

let pass = 0, fail = 0, skip = 0;
const results = [];
async function t(name, fn) {
  try { const r = await fn(); if (r === 'skip') { skip++; results.push(['SKIP', name, '']); } else { pass++; results.push(['PASS', name, '']); } }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
const argvCalls = () => (existsSync(ARGV_LOG) ? readFileSync(ARGV_LOG, 'utf8') : '');
const stored = (account) => {
  const f = readdirSync(KC).find((n) => n.endsWith('__' + account));
  return f ? readFileSync(join(KC, f), 'utf8').replace(/\n$/, '') : null;
};

// A full-length age key built at runtime: a literal one in this file would be
// flagged by `brain audit`'s key-in-git-history check (and stay in history).
const AGE_LIKE = 'AGE-SECRET-KEY-1' + 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L'.repeat(2).slice(0, 58);
const TRICKY = [
  AGE_LIKE,
  'ghp' + '_plainToken0123456789abcdefABCDEF',
  '  leading and trailing spaces  ',
  'double "quoted" value',
  "single 'quoted' value",
  'back\\slash \\" and \\\\ trail\\',
  '$HOME `id` $(whoami) ; | & > < * ? ~ # !',
  'tab\there and\rcarriage',
  'ünïcødé € 😀',
  '"',
  '\\',
  '-w -U --leading-dash',
];

for (const dir of ['shims', 'core']) {
  await t(`${dir}/security: every tricky value round-trips exactly and never touches argv`, () => {
    SHIM_DIR = join(HERE, 'sandbox', dir);
    writeFileSync(wrapper, readFileSync(wrapper, 'utf8').replace(/exec \/bin\/bash "[^"]*"/, `exec /bin/bash "${SHIM_DIR}/security"`));
    writeFileSync(ARGV_LOG, '');
    for (const [i, v] of TRICKY.entries()) {
      const acct = `test-${dir}-${i}`;
      eq(K.setSecret(acct, v), true, `set #${i}`);
      eq(stored(acct), v, `stored bytes #${i}`);
      eq(K.getSecret(acct), v, `getSecret #${i}`);
    }
    const argv = argvCalls();
    for (const v of TRICKY) assert(!argv.includes(v), `value on argv: ${JSON.stringify(v)}\n${argv}`);
    assert(!/add-generic-password/.test(argv), 'add-generic-password ran from argv:\n' + argv);
    assert(argv.split('\n').some((l) => l === 'security\0-i\0'), 'security -i not used:\n' + argv);
  });
}

await t('update (-U) replaces an existing value', () => {
  K.setSecret('test-update', 'first value');
  K.setSecret('test-update', 'second "value"');
  eq(K.getSecret('test-update'), 'second "value"', 'updated');
});

await t('fake log redacts the value and marks it as stdin-delivered', () => {
  const log = readFileSync(SB_LOG, 'utf8');
  assert(/^security add-generic-password -U -s \S+ -a test-update -w <redacted:stdin>$/m.test(log), log);
  assert(!/<redacted:argv>/.test(log), 'argv write logged:\n' + log);
  for (const v of TRICKY.slice(0, 2)) assert(!log.includes(v), 'secret in log');
});

await t('a Keychain that silently refuses the write is an error, not success', () => {
  process.env.SB_KEYCHAIN_DENY = '1';
  let err = null;
  try { K.setSecret('test-denied', 'never-stored'); } catch (e) { err = e; }
  delete process.env.SB_KEYCHAIN_DENY;
  assert(err && /did not store/.test(err.message), 'no throw: ' + err);
  assert(!err.message.includes('never-stored'), 'error message leaks the value');
});

await t('newline / NUL in a value, and over-long values, are refused before `security` runs', () => {
  writeFileSync(ARGV_LOG, '');
  for (const bad of ['two\nlines', 'nul\0byte', 'x'.repeat(5000)]) {
    let err = null;
    try { K.setSecret('test-bad', bad); } catch (e) { err = e; }
    assert(err, `accepted ${JSON.stringify(bad.slice(0, 12))}`);
    assert(!err.message.includes(bad), 'error message leaks the value');
  }
  eq(argvCalls(), '', 'security was invoked');
  eq(K.getSecret('test-bad'), null, 'something was stored');
});

await t('empty value / service / account is refused before `security` runs', () => {
  // `-w` with nothing usable after it is how the real tool is told to prompt.
  writeFileSync(ARGV_LOG, '');
  for (const [acct, v] of [['test-empty', ''], ['', 'value']]) {
    let err = null;
    try { K.setSecret(acct, v); } catch (e) { err = e; }
    assert(err && /cannot be empty/.test(err.message), `accepted ${JSON.stringify([acct, v])}: ${err}`);
  }
  let err = null;
  try { K.securityAddCommand('svc', 'acct', ''); } catch (e) { err = e; }
  assert(err && /cannot be empty/.test(err.message), 'securityAddCommand accepted an empty value');
  eq(argvCalls(), '', 'security was invoked');
  eq(K.getSecret('test-empty'), null, 'something was stored');
});

await t('fake: an add ending in a bare -w fails (the real tool would prompt), never stores', () => {
  const r = spawnSync(wrapper, ['-i'], { input: 'add-generic-password -U -s "svc" -a "bare" -w\n', encoding: 'utf8', env: process.env });
  assert(r.status !== 0, 'bare -w succeeded');
  assert(/would prompt/.test(r.stderr), r.stderr);
  assert(!readdirSync(KC).some((n) => n.endsWith('__bare')), 'stored something');
});

// How `security -i` splits a line. Each case was probed on the real tool (read-only,
// show-keychain-info on a missing path); the fakes must split the same way.
const SPLIT = [
  ['"a b"', ['a b']],
  ['a\\ b', ['a b']],             // backslash escapes outside quotes too
  ['"a\\qb"', ['aqb']],           // ...and any character inside them
  ['a\\"b', ['a"b']],
  ['a""b', ['a""b']],               // a quote opens only at the start of a token
  ['"a"b', ['a', 'b']],             // the closing quote ends the token
  ['"" x', ['', 'x']],              // "" is an empty token, not dropped
  ['x ""', ['x', '']],
];
for (const dir of ['shims', 'core']) {
  await t(`${dir}/security splits -i lines like the real tool (quotes, escapes, empty "")`, () => {
    for (const [raw, want] of SPLIT) {
      const r = spawnSync('/bin/bash', [join(HERE, 'sandbox', dir, 'security'), '-i'], {
        input: `sb-args ${raw}\n`, encoding: 'utf8', env: { ...process.env, SB_LOG: join(SB, 'split.log') },
      });
      const got = r.stdout.split('\0').slice(0, -1);
      eq(JSON.stringify(got), JSON.stringify(want), `split of ${raw}`);
    }
  });
}

await t('real macOS `security -i` splits lines the same way (read-only probe)', () => {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/security')) return 'skip';
  const base = join(SB, 'no-such-dir', 'kc-');
  for (const [raw, want] of SPLIT) {
    // Prefix the first token with the missing path (a token can start with it
    // only when the raw text does not start with a quote; else prefix outside).
    const line = raw.startsWith('"') ? `show-keychain-info ${raw}` : `show-keychain-info ${base}${raw}`;
    const toks = raw.startsWith('"') ? want : [base + want[0], ...want.slice(1)];
    const r = spawnSync('/usr/bin/security', ['-i'], { input: line + '\n', encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME, BRAIN_TEST: '1' } });
    if (toks.length === 1 && toks[0] !== '') {
      const m = r.stderr.match(/SecKeychainCopySettings ([\s\S]*): The specified keychain could not be found/);
      assert(m, `unexpected output for ${raw}: ${r.stderr}`);
      eq(m[1], toks[0], `parsed ${raw}`);
    } else {
      // Two arguments: show-keychain-info takes at most one, so it prints usage.
      assert(/Usage: show-keychain-info/.test(r.stderr), `expected 2 args for ${raw}: ${r.stderr}`);
    }
  }
  assert(!existsSync(join(SB, 'no-such-dir')), 'probe created a keychain path');
});

await t('securityAddCommand: one line, values double-quoted with \\ escapes', () => {
  eq(K.securityAddCommand('svc', 'acct', 'a "b" \\c'),
    'add-generic-password -U -s "svc" -a "acct" -w "a \\"b\\" \\\\c"\n', 'encoding');
});

await t('real macOS `security -i` un-quotes our encoding exactly (read-only probe)', () => {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/security')) return 'skip';
  const base = join(SB, 'no-such-dir', 'kc-');
  for (const v of TRICKY) {
    const path = base + v;
    // Same quoting setSecret uses: take the -w token from the add command.
    const line = K.securityAddCommand('s', 'a', path);
    const token = line.slice(line.indexOf(' -w ') + 4, -1);
    const r = spawnSync('/usr/bin/security', ['-i'], {
      input: `show-keychain-info ${token}\n`, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME, BRAIN_TEST: '1' },
    });
    const m = r.stderr.match(/SecKeychainCopySettings ([\s\S]*): The specified keychain could not be found/);
    assert(m, `unexpected output for ${JSON.stringify(v)}: ${r.stderr}`);
    eq(m[1], path, `parsed argument for ${JSON.stringify(v)}`);
  }
  assert(!existsSync(join(SB, 'no-such-dir')), 'probe created a keychain path');
});

await t('Linux branch is unchanged: secret-tool gets the value on stdin', () => {
  const src = readFileSync(join(HERE, '..', 'bin', 'lib', 'secrets-linux.mjs'), 'utf8');
  assert(/execFileSync\('secret-tool', \['store'[^\n]*\n\s*\{ input: value/.test(src), 'secret-tool store no longer uses stdin');
});

rmSync(SB, { recursive: true, force: true });
for (const [s, n, m] of results) console.log(`${s}  ${n}${m ? '\n    ' + m : ''}`);
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
