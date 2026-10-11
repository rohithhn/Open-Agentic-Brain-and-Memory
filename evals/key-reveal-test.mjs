#!/usr/bin/env node
// Tests that the age PRIVATE key is never printed by `brain key rotate`, and
// that the only way to see it, `brain key reveal`, is typed-confirmation +
// terminal-only.
//
//   node evals/key-reveal-test.mjs
//
// Runs bin/brain.mjs in a fake HOME with the sandbox's fake `security`
// (evals/sandbox/shims) — the real Keychain and ~/.claude-brain are never
// touched. The tty cases need `script` (a pty) and are skipped without it. The
// full rotation story lives in evals/sandbox/sandbox-test.sh §7.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { ptyWrap } from './lib/pty.mjs';
import { mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN = join(HERE, '..', 'bin', 'brain.mjs');
const SHIMS = join(HERE, 'sandbox', 'shims');
const ROOT = mkdtempSync(join(tmpdir(), 'brain-keyreveal-'));
const HOME = join(ROOT, 'home'), KC = join(ROOT, 'keychain');
mkdirSync(HOME, { recursive: true }); mkdirSync(KC, { recursive: true });
const KEY = 'AGE-SECRET-KEY-1' + Array.from(randomBytes(58), (b) => 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L'[b % 32]).join('');
writeFileSync(join(KC, 'claude-brain__age-identity'), KEY + '\n');
const ENV = { HOME, PATH: `${SHIMS}:${dirname(process.execPath)}:/usr/bin:/bin`, USER: 'tester', TMPDIR: ROOT, SB_KEYCHAIN: KC, BRAIN_NO_AUTOMATION: '1', BRAIN_TEST: '1' };
// macOS reads the key through the fake `security` (SB_KEYCHAIN). Linux has no
// `security`: seed the same key through the product's own secret API into the
// encrypted-file backend under the fake HOME (never a real keyring).
if (process.platform === 'linux') {
  ENV.BRAIN_SECRET_BACKEND = 'file';
  const seed = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { setSecret, SECRET_KEYS } = await import(${JSON.stringify(join(HERE, '..', 'bin', 'lib', 'keychain.mjs'))}); setSecret(SECRET_KEYS.AGE_KEY, process.env.SEED_KEY);`],
    { env: { ...ENV, SEED_KEY: KEY }, encoding: 'utf8' });
  if (seed.status !== 0) throw new Error('could not seed the test key: ' + seed.stderr);
}

let pass = 0, fail = 0, skip = 0; const results = [];
async function t(name, fn) {
  try { const r = await fn(); if (r === 'skip') { skip++; results.push(['SKIP', name, '']); } else { pass++; results.push(['PASS', name, '']); } }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const hasScript = spawnSync('sh', ['-c', 'command -v script'], { env: ENV }).status === 0;

// ── source: the rotate path must not print the private key ───────────────
await t('key rotate prints no private key (source: no AGE_KEY read goes to console)', () => {
  const src = readFileSync(BRAIN, 'utf8');
  const a = src.indexOf("} else if (sub === 'rotate') {"), b = src.indexOf("} else if (sub === 'import') {");
  assert(a > 0 && b > a, 'rotate block not found');
  const block = src.slice(a, b);
  const reads = block.split('\n').filter((l) => /SECRET_KEYS\.AGE_KEY/.test(l));
  assert(reads.length === 1 && /oldIdentity\s*=/.test(reads[0]), `rotate reads the private key outside the rollback copy: ${reads.join(' | ')}`);
  assert(!/console\.log\([^)]*oldIdentity|console\.log\([^)]*AGE_KEY/.test(block), 'a console.log mentions the key');
  assert(/Public key \(safe to share\)/.test(block), 'public recipient no longer printed');
  assert(/doKeyBackup\(/.test(block), 'rotate no longer offers brain key backup');
});

// ── no terminal: refuse, show nothing ────────────────────────────────────
await t('reveal with no controlling terminal refuses and prints nothing secret', () => {
  // detached = setsid: no controlling tty, so /dev/tty cannot be opened
  const r = spawnSync('node', [BRAIN, 'key', 'reveal'], { env: ENV, encoding: 'utf8', input: 'reveal\n', detached: true });
  assert(r.status !== 0, `exit ${r.status}, expected failure`);
  assert(!(r.stdout + r.stderr).includes(KEY), 'key leaked to stdout/stderr without a tty');
  assert(/terminal/i.test(r.stderr), 'no explanation: ' + r.stderr);
});

await t('reveal with no key on this Mac fails cleanly', () => {
  const home2 = join(ROOT, 'home2'), kc2 = join(ROOT, 'kc2'); mkdirSync(home2, { recursive: true }); mkdirSync(kc2, { recursive: true });
  const r = spawnSync('node', [BRAIN, 'key', 'reveal'], { env: { ...ENV, HOME: home2, SB_KEYCHAIN: kc2 }, encoding: 'utf8', detached: true });
  assert(r.status !== 0 && /No key/.test(r.stderr), `got ${r.status} ${r.stderr}`);
});

// ── with a terminal (pty via script) ─────────────────────────────────────
// The pty carries the warning, the prompt and (on confirmation) the key; the
// command's own stdout is redirected to a file so we can prove nothing secret
// went there.
function runPty(typed) {
  const out = join(ROOT, 'stdout.txt'); rmSync(out, { force: true });
  const sh = `( sleep 1.5; printf '%s\\r' "$TYPED"; sleep 2 ) | ${ptyWrap(`node "$BRAIN" key reveal > "$OUT"`)}`;
  const r = spawnSync('bash', ['-c', sh], { env: { ...ENV, TYPED: typed, BRAIN, OUT: out }, encoding: 'utf8', timeout: 30000 });
  return { pty: r.stdout, stdout: existsSync(out) ? readFileSync(out, 'utf8') : '' };
}

await t('reveal: typing "reveal" shows a warning + the key on the tty only, never on stdout', () => {
  if (!hasScript) return 'skip';
  const { pty, stdout } = runPty('reveal');
  assert(/PRIVATE/.test(pty) && /password manager/.test(pty), 'no warning on the tty');
  assert(pty.includes(KEY), 'confirmed reveal did not show the key on the tty');
  assert(!stdout.includes(KEY), 'key reached stdout');
});

await t('reveal: any other answer shows nothing', () => {
  if (!hasScript) return 'skip';
  const { pty, stdout } = runPty('yes');
  assert(!pty.includes(KEY) && !stdout.includes(KEY), 'key shown without the typed word');
  assert(/Aborted/.test(stdout + pty), 'no abort message');
});

rmSync(ROOT, { recursive: true, force: true });
console.log(`\nkey-reveal-test: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}\n`);
for (const [s, n, m] of results) console.log(`  ${s === 'PASS' ? '✓' : s === 'SKIP' ? '-' : '✗'} ${n}${m ? `\n      ${m}` : ''}`);
process.exit(fail > 0 ? 1 : 0);
