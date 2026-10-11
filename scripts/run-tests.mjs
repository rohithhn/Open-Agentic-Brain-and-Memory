#!/usr/bin/env node
// Test runner behind `npm test` / `npm run test:sandbox`.
//
//   node scripts/run-tests.mjs            every evals/*-test.mjs   (node)
//   node scripts/run-tests.mjs --sandbox  every evals/sandbox/*-test.sh   (bash; macOS)
//   node scripts/run-tests.mjs <substr>   only files whose name contains <substr>
//   node scripts/run-tests.mjs --list     print what would run, run nothing
//
// Each file runs in its own process, in sequence, with its output streamed
// through. Exits 1 if ANY file fails (non-zero status, or killed by a signal /
// timeout), 0 only when every file passes. A failing file never stops the rest:
// you get the full picture and a summary at the end.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const sandbox = args.includes('--sandbox');
const listOnly = args.includes('--list');
const filters = args.filter((a) => !a.startsWith('--'));
const TIMEOUT_MS = Number(process.env.BRAIN_TEST_TIMEOUT_MS) || 15 * 60 * 1000;

const dir = join(ROOT, 'evals', sandbox ? 'sandbox' : '');
const suffix = sandbox ? '-test.sh' : '-test.mjs';
const files = readdirSync(dir)
  .filter((f) => f.endsWith(suffix))
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)))
  .sort();

if (!files.length) {
  console.error(`no ${suffix} files matched in ${dir}`);
  process.exit(1);
}
if (listOnly) {
  for (const f of files) console.log(join(dir, f));
  process.exit(0);
}

const results = [];
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const t0 = Date.now();
  const r = spawnSync(sandbox ? 'bash' : process.execPath, [join(dir, f)], {
    cwd: ROOT, stdio: 'inherit', timeout: TIMEOUT_MS,
  });
  const ok = r.status === 0;
  const why = ok ? '' : r.error ? r.error.message : r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
  results.push({ f, ok, why, secs: ((Date.now() - t0) / 1000).toFixed(1) });
}

console.log('\n── summary ──');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.f}  (${r.secs}s)${r.why ? '  ' + r.why : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
