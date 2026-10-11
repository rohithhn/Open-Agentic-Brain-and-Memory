#!/usr/bin/env node
// Tests for scripts/run-tests.mjs — the runner behind `npm test`.
//   node evals/run-tests-test.mjs
// Checks the contract that matters: it lists the real suites, runs a passing
// file to exit 0, and exits non-zero (and still runs the rest) when one fails.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

t('package.json wires test and test:sandbox to the runner', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  eq(pkg.scripts.test, 'node scripts/run-tests.mjs', 'test script');
  eq(pkg.scripts['test:sandbox'], 'node scripts/run-tests.mjs --sandbox', 'test:sandbox script');
});

t('--list names every evals/*-test.mjs and nothing else', () => {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'run-tests.mjs'), '--list'], { encoding: 'utf8' });
  eq(r.status, 0, 'exit');
  const listed = r.stdout.trim().split('\n').map((l) => l.split('/').pop()).sort();
  const onDisk = readdirSync(join(REPO, 'evals')).filter((f) => f.endsWith('-test.mjs')).sort();
  eq(JSON.stringify(listed), JSON.stringify(onDisk), 'listed vs on-disk suites');
  assert(listed.includes('run-tests-test.mjs'), 'includes itself');
});

t('--sandbox --list names the .sh harnesses, not lib.sh', () => {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'run-tests.mjs'), '--sandbox', '--list'], { encoding: 'utf8' });
  eq(r.status, 0, 'exit');
  const listed = r.stdout.trim().split('\n').map((l) => l.split('/').pop()).sort();
  const onDisk = readdirSync(join(REPO, 'evals', 'sandbox')).filter((f) => f.endsWith('-test.sh')).sort();
  eq(JSON.stringify(listed), JSON.stringify(onDisk), 'listed vs on-disk harnesses');
  assert(!listed.includes('lib.sh'), 'lib.sh is a helper, not a test');
});

t('exits non-zero when any file fails, but still runs the others', () => {
  // Run the real runner against a throwaway tree with one passing and one failing eval.
  const tmp = mkdtempSync(join(tmpdir(), 'run-tests-'));
  try {
    mkdirSync(join(tmp, 'scripts')); mkdirSync(join(tmp, 'evals'));
    cpSync(join(REPO, 'scripts', 'run-tests.mjs'), join(tmp, 'scripts', 'run-tests.mjs'));
    writeFileSync(join(tmp, 'evals', 'a-test.mjs'), 'console.log("A RAN");\n');
    writeFileSync(join(tmp, 'evals', 'b-test.mjs'), 'console.log("B RAN");\nprocess.exit(3);\n');
    writeFileSync(join(tmp, 'evals', 'c-test.mjs'), 'console.log("C RAN");\n');
    const r = spawnSync(process.execPath, [join(tmp, 'scripts', 'run-tests.mjs')], { encoding: 'utf8' });
    eq(r.status, 1, 'exit status with a failing file');
    for (const x of ['A RAN', 'B RAN', 'C RAN']) assert(r.stdout.includes(x), `${x} missing — a failure must not stop the rest`);
    assert(/FAIL\s+b-test\.mjs/.test(r.stdout) && /PASS\s+a-test\.mjs/.test(r.stdout), 'summary marks pass/fail');
    // And a fully passing tree exits 0.
    rmSync(join(tmp, 'evals', 'b-test.mjs'));
    eq(spawnSync(process.execPath, [join(tmp, 'scripts', 'run-tests.mjs')], { encoding: 'utf8' }).status, 0, 'all-pass exit');
    // A name filter that matches nothing is an error, not a silent pass.
    eq(spawnSync(process.execPath, [join(tmp, 'scripts', 'run-tests.mjs'), 'nope'], { encoding: 'utf8' }).status, 1, 'no-match exit');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
