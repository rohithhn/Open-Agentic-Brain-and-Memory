#!/usr/bin/env node
// Corpus-driven acceptance test for bin/lib/scrub.mjs.
// Run: node evals/scrub-test.mjs
// Exits 0 on pass, 1 on any failure. Prints a clear pass/fail summary; never
// prints secret values from the corpus beyond what's already public in it (the
// corpus is fake/structurally-valid data, safe to print — see its header).
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scrubText, findSecrets, scrubItem, scrubObservation } from '../bin/lib/scrub.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, 'scrubber-corpus');

function readLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'));
}

// positives.txt payloads (everything after the tab) are base64-encoded — see
// the file's header comment for why. Decode back to the original plaintext
// observation line before handing it to the scrubber.
function decodeBase64(b64) {
  return Buffer.from(b64, 'base64').toString('utf8');
}

let failures = 0;
const fail = (msg) => { failures++; console.log('  ✗ ' + msg); };

// ── A1/A2/A4 — positives: recall + detector attribution + no leakage ──
const posLines = readLines(join(CORPUS_DIR, 'positives.txt'));
let posPass = 0;
let capReviewOnly = 0; // tier-5 lines that capture-time scrub reported but did not redact
let capRedacted = 0;   // tier 1-4 lines the capture-time scrub redacted without leaking
for (const line of posLines) {
  const tab = line.indexOf('\t');
  if (tab === -1) { fail(`positives.txt: malformed line (no tab): ${line.slice(0, 60)}`); continue; }
  const expectedDetector = line.slice(0, tab).trim();
  const text = decodeBase64(line.slice(tab + 1));
  const hits = findSecrets(text, { tiers: [1, 2, 3, 4, 5], entropyMode: 'redact' });
  if (hits.length === 0) {
    fail(`[${expectedDetector}] 0 hits on: ${text.slice(0, 70)}...`);
    continue;
  }
  const ids = hits.map((h) => h.detector);
  if (!ids.includes(expectedDetector)) {
    fail(`[${expectedDetector}] detector mismatch — got [${ids.join(',')}] on: ${text.slice(0, 70)}...`);
    continue;
  }
  // A4: no 12+ char substring of any redacted secret leaks through.
  const { text: scrubbed } = scrubText(text, { tiers: [1, 2, 3, 4, 5], entropyMode: 'redact' });
  let leaked = false;
  for (const h of hits) {
    const secret = text.slice(h.start, h.end);
    for (let i = 0; i + 12 <= secret.length; i += 4) {
      const sub = secret.slice(i, i + 12);
      if (sub.trim().length === 12 && scrubbed.includes(sub)) { leaked = true; break; }
    }
    if (leaked) break;
  }
  if (leaked) { fail(`[${expectedDetector}] secret substring leaked after scrub: ${text.slice(0, 70)}...`); continue; }
  posPass++;

  // Capture-time default (no opts): tier 1-4 positives are still redacted with no
  // 12-char leak; the tier-5 line is REVIEW-ONLY — reported, text untouched.
  const cap = scrubText(text);
  if (expectedDetector === 'high-entropy-secret') {
    if (cap.text !== text) { fail(`[${expectedDetector}] default (capture) scrub must NOT redact tier 5: ${text.slice(0, 70)}...`); continue; }
    if (cap.hits.length !== 0) { fail(`[${expectedDetector}] tier 5 must not appear in redacted hits at capture`); continue; }
    if (!cap.review.some((r) => r.detector === expectedDetector)) { fail(`[${expectedDetector}] tier 5 must be reported under review at capture: ${text.slice(0, 70)}...`); continue; }
    capReviewOnly++;
  } else {
    let capLeak = false;
    for (const h of hits.filter((x) => x.tier <= 4)) {
      const secret = text.slice(h.start, h.end);
      for (let i = 0; i + 12 <= secret.length; i += 4) {
        const sub = secret.slice(i, i + 12);
        if (sub.trim().length === 12 && cap.text.includes(sub)) { capLeak = true; break; }
      }
      if (capLeak) break;
    }
    if (capLeak) { fail(`[${expectedDetector}] secret leaked through the DEFAULT capture scrub: ${text.slice(0, 70)}...`); continue; }
    if (cap.hits.length === 0) { fail(`[${expectedDetector}] default capture scrub redacted nothing: ${text.slice(0, 70)}...`); continue; }
    capRedacted++;
  }
}

// ── A3 — negatives: zero false positives (tiers 1-4, entropy in redact mode) ──
const negLines = readLines(join(CORPUS_DIR, 'negatives.txt'));
let negPass = 0;
for (const line of negLines) {
  const hits = findSecrets(line, { tiers: [1, 2, 3, 4], entropyMode: 'redact' });
  if (hits.length === 0) { negPass++; continue; }
  fail(`false positive [${hits.map((h) => h.detector).join(',')}] on: ${line.slice(0, 80)}...`);
}
// Also check with tier 5 included, since a genuinely 0-FP scrubber should hold there too
// (informational — not part of the strict A3 gate per spec, but worth surfacing).
let neg5Fires = 0;
for (const line of negLines) {
  const hits = findSecrets(line, { tiers: [1, 2, 3, 4, 5], entropyMode: 'redact' });
  if (hits.length) neg5Fires++;
}

// ── C — tier-5 policy knobs (capture review-only; opt-in redact; off) ──
{
  const t5 = decodeBase64(posLines.find((l) => l.startsWith('high-entropy-secret\t')).split('\t')[1]);
  const red = scrubText(t5, { entropyMode: 'redact' });
  if (red.text === t5 || !red.hits.some((h) => h.detector === 'high-entropy-secret') || red.review.length) fail("entropyMode 'redact' must redact tier 5 (opt-in)");
  const aud = scrubText(t5, { entropyMode: 'audit' });
  if (aud.text !== t5 || !aud.review.length) fail("entropyMode 'audit' must report tier 5 without redacting");
  const off = scrubText(t5, { entropyMode: 'off' });
  if (off.text !== t5 || off.review.length || off.hits.length) fail("entropyMode 'off' must not scan tier 5");
  // A mixed line: tier 1 is redacted even while a tier-5 token on the same line is only reported.
  const mixed = `${decodeBase64(posLines.find((l) => l.startsWith('github-token\t')).split('\t')[1])}\n${t5}`;
  const mx = scrubText(mixed);
  if (!mx.hits.some((h) => h.detector === 'github-token') || !mx.review.some((r) => r.detector === 'high-entropy-secret') || !mx.text.includes(t5)) {
    fail('mixed line: tier 1 must redact while tier 5 stays review-only');
  }
  // Every capture entry point shares the default: ingest (scrubItem) and the MCP/distill
  // path (scrubObservation) leave tier 5 alone.
  const it = scrubItem({ title: t5, transcript: t5, prompts: [t5] });
  if (it.title !== t5 || it.transcript !== t5 || it.prompts[0] !== t5) fail('scrubItem (ingest) must not redact tier 5');
  const ob = scrubObservation({ title: t5, facts: [t5], narrative: t5 });
  if (ob.title !== t5 || ob.facts[0] !== t5 || ob.narrative !== t5) fail('scrubObservation must not redact tier 5');
  // Export / audit paths: tiers 1-4 with entropyMode off never surface tier 5.
  if (findSecrets(t5, { tiers: [1, 2, 3, 4], entropyMode: 'off' }).some((h) => h.tier === 5)) fail('tiers 1-4 + off must never return tier 5');
}

// ── B1 — idempotence ──
let idemFail = 0;
for (const line of [...posLines, ...negLines]) {
  const text = line.includes('\t') ? decodeBase64(line.slice(line.indexOf('\t') + 1)) : line;
  const once = scrubText(text, { tiers: [1, 2, 3, 4, 5], entropyMode: 'redact' });
  const twice = scrubText(once.text, { tiers: [1, 2, 3, 4, 5], entropyMode: 'redact' });
  if (twice.hits.length !== 0) {
    idemFail++;
    fail(`not idempotent — rescrub of scrubbed text produced ${twice.hits.length} new hit(s): ${once.text.slice(0, 70)}...`);
  }
}

console.log('');
console.log('── secret-scrubber corpus results ──────────────────────────────');
console.log(`A. Positives  (recall + attribution + no-leak): ${posPass}/${posLines.length}`);
console.log(`A5. Capture default (tier 1-4 redacted: ${capRedacted}, tier 5 review-only: ${capReviewOnly})`);
console.log(`A3. Negatives (false positives, tiers 1-4):      ${negPass}/${negLines.length} clean` + (negPass === negLines.length ? '' : `  (${negLines.length - negPass} FP)`));
console.log(`    (info) negatives with tier 5 also enabled:    ${negLines.length - neg5Fires}/${negLines.length} clean`);
console.log(`B1. Idempotence over full corpus:                ${(posLines.length + negLines.length) - idemFail}/${posLines.length + negLines.length}`);
console.log('─────────────────────────────────────────────────────────────────');

if (failures > 0) {
  console.log(`\nFAIL — ${failures} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('\nPASS — all corpus acceptance criteria met (A1, A2, A3, A4, A5, B1, C).');
  process.exit(0);
}
