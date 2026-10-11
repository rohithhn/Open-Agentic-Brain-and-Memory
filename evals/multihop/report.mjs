// Renders evals/multihop/results-{locomo,lme}.json as markdown tables (stdout).
import '../test-env.mjs'; // BRAIN_TEST=1
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const H = dirname(fileURLToPath(import.meta.url));
const L = JSON.parse(readFileSync(join(H, `results${process.argv[2] || ''}-locomo.json`))).locomo;
const M = JSON.parse(readFileSync(join(H, `results${process.argv[2] || ''}-lme.json`))).lme;
const names = Object.keys(L.variants);
const d = (a, b) => { const x = Math.round((a - b) * 10) / 10; return (x > 0 ? '+' : '') + x.toFixed(1); };
const LK = ['all@10', 'any@10', 'all@20', 'any@20'];
const MK = ['recall_any@1', 'recall_any@5', 'recall_any@10', 'recall_all@5', 'recall_all@10', 'ndcg_any@10'];
const bl = L.variants.baseline, bm = M.variants.baseline;
function guard(n) {
  const lv = L.variants[n], mv = M.variants[n];
  const lme = Math.min(...MK.map((k) => mv.overall[k] - bm.overall[k]));
  let loAny = 0, loAll = 0;
  for (const c of [1, 2, 3, 4]) for (const k of LK) { const x = lv.byCat[c][k] - bl.byCat[c][k]; if (k.startsWith('any')) loAny = Math.min(loAny, x); else loAll = Math.min(loAll, x); }
  return { lme, loAny, loAll, ok: lme >= -0.3 && loAny >= -0.05 && loAll >= -0.05 };
}
console.log(`## LoCoMo (round units, ${L.questions} questions, cat 1-4)\n`);
console.log('| variant | all@10 | any@10 | all@20 | any@20 | cat1 all@10 | cat1 any@10 | cat1 all@20 | cat1 any@20 | +ms/q |\n|---|---|---|---|---|---|---|---|---|---|');
for (const n of names) { const v = L.variants[n]; console.log(`| ${n} | ${LK.map((k) => v.overall[k].toFixed(1)).join(' | ')} | ${LK.map((k) => v.byCat[1][k].toFixed(1)).join(' | ')} | ${v.extraMs.toFixed(1)} |`); }
console.log(`\n## LoCoMo per-category deltas vs baseline (all@20 / any@20)\n`);
console.log('| variant | cat1 | cat2 | cat3 | cat4 |\n|---|---|---|---|---|');
for (const n of names.slice(1)) { const v = L.variants[n]; console.log(`| ${n} | ${[1, 2, 3, 4].map((c) => `${d(v.byCat[c]['all@20'], bl.byCat[c]['all@20'])} / ${d(v.byCat[c]['any@20'], bl.byCat[c]['any@20'])}`).join(' | ')} |`); }
console.log(`\n## LongMemEval-S (round units, ${M.questions} questions)\n`);
console.log('| variant | any@1 | any@5 | any@10 | all@5 | all@10 | ndcg@10 | multi-session all@10 | +ms/q | LME min delta | LoCoMo worst any / all delta | guard |\n|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const n of names) { const v = M.variants[n], g = guard(n); console.log(`| ${n} | ${MK.map((k) => v.overall[k].toFixed(1)).join(' | ')} | ${v.multiSession['recall_all@10'].toFixed(1)} | ${v.extraMs.toFixed(1)} | ${g.lme.toFixed(1)} | ${g.loAny.toFixed(1)} / ${g.loAll.toFixed(1)} | ${n === 'baseline' ? '-' : g.ok ? 'PASS' : 'fail'} |`); }
