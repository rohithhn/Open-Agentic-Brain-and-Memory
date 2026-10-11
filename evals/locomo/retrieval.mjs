#!/usr/bin/env node
// LoCoMo retrieval-only comparison of unit granularity (no LLM, nothing leaves
// the Mac): per conversation, build a fresh store of 'turn' units or 'round'
// units, run brain_recall's hybrid ranking for every category 1-4 question and
// score whether the evidence turns are in the top k. Used to pick qa.mjs's unit.
//
//   node evals/locomo/retrieval.mjs [--convs 10] [--stride 1]
import '../test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocomo, allQuestions, unitsFor, setupModelDir, openVecCache, buildStore, rankUnits } from './lib.mjs';
setupModelDir();
const { getEmbedder, quantize } = await import('../../bin/lib/embed.mjs');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const NCONV = Number(arg('--convs', 10)), STRIDE = Number(arg('--stride', 1));

const data = loadLocomo();
const qs = allQuestions(data).filter((q) => q.evidence.length && q.conv < NCONV).filter((_, i) => i % STRIDE === 0);
const vc = openVecCache(getEmbedder, quantize);
const work = mkdtempSync(join(tmpdir(), 'locomo-ret-'));
// configs: [granularity, k]; turn@40 and round@20 spend the same ~40-turn budget.
const configs = [['turn', 10], ['turn', 20], ['turn', 40], ['round', 10], ['round', 20]];
const acc = {};
try {
  for (const gran of ['turn', 'round']) {
    for (let ci = 0; ci < Math.min(NCONV, data.length); ci++) {
      const cq = qs.filter((q) => q.conv === ci);
      if (!cq.length) continue;
      const units = unitsFor(data[ci], gran);
      await vc.ensureVecs(units);
      const dbPath = join(work, `${gran}-${ci}.db`);
      const byRow = buildStore(dbPath, units, { vecOf: vc.vecOf });
      for (const q of cq) {
        const { units: ranked } = await rankUnits({ dbPath, byRow, question: q.question, query: 'recall', mode: 'hybrid' });
        for (const [g, k] of configs.filter((c) => c[0] === gran)) {
          const key = `${g}@${k}`;
          const top = ranked.slice(0, k);
          const have = new Set(top.flatMap((u) => u.dias));
          const a = (acc[key] ||= { n: 0, any: 0, all: 0, chars: 0, byCat: {} });
          const hitAll = q.evidence.every((e) => have.has(e)), hitAny = q.evidence.some((e) => have.has(e));
          a.n++; a.all += hitAll; a.any += hitAny; a.chars += top.reduce((s, u) => s + u.text.length, 0);
          const c = (a.byCat[q.category] ||= { n: 0, all: 0 }); c.n++; c.all += hitAll;
        }
      }
      rmSync(dbPath, { force: true });
    }
  }
} finally { rmSync(work, { recursive: true, force: true }); }
const pct = (x, n) => Math.round((1000 * x) / n) / 10;
const out = {};
for (const [k, a] of Object.entries(acc)) out[k] = { questions: a.n, evidenceAll: pct(a.all, a.n), evidenceAny: pct(a.any, a.n), avgContextTokens: Math.round(a.chars / a.n / 4),
  byCategoryEvidenceAll: Object.fromEntries(Object.entries(a.byCat).map(([c, v]) => [c, pct(v.all, v.n)])) };
console.log(JSON.stringify(out, null, 2));
