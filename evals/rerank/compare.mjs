#!/usr/bin/env node
// Cross-encoder rerank experiment on LongMemEval-S (retrieval only, no LLM).
// Candidates: the product ranking (rankUnits recall/hybrid, PRF on) plus a
// wider pool (BM25 top POOL + semantic top POOL). A local cross-encoder scores
// (question, unit) pairs; variants reorder the pool. Scored on a DEV half
// (even positions by question_id) and a TEST half (odd) so a variant chosen on
// dev is confirmed on unseen questions.
//
//   node evals/rerank/compare.mjs [--model Xenova/ms-marco-MiniLM-L-6-v2] [--pool 100] [--stride 1] [--limit N]
import '../test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const LME = join(HERE, '..', 'longmemeval', 'data');
process.env.BRAIN_MODEL_DIR ||= join(LME, 'models');
process.env.BRAIN_NO_ECONOMICS = '1';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const MODEL = arg('--model', 'Xenova/ms-marco-MiniLM-L-6-v2');
const POOL = Number(arg('--pool', 100));
const STRIDE = Number(arg('--stride', 1));
const LIMIT = Number(arg('--limit', Infinity));
const MAXLEN = Number(arg('--maxlen', 384));
const log = (...a) => console.error(...a);

const { unitsFor, unitEmbedText, vecKey, buildStore, rankUnits, scoreRanking, aggregate, selectQuestions } = await import('../longmemeval/lib.mjs');
const { semanticSearch } = await import('../../bin/lib/embed.mjs');
const { ftsMatchExpr, MAX_QUERY_CHARS } = await import('../../bin/lib/recall.mjs');
const { pruneCommonTerms } = await import('../../bin/lib/fts.mjs');

const lib = await import('@huggingface/transformers');
lib.env.cacheDir = process.env.BRAIN_MODEL_DIR; lib.env.allowRemoteModels = true;
const tok = await lib.AutoTokenizer.from_pretrained(MODEL);
const ce = await lib.AutoModelForSequenceClassification.from_pretrained(MODEL, { dtype: 'q8' });
async function ceScores(q, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 16) {
    const chunk = texts.slice(i, i + 16);
    const inp = tok(new Array(chunk.length).fill(q), { text_pair: chunk, padding: true, truncation: true, max_length: MAXLEN });
    const { logits } = await ce(inp);
    const d = logits.data, w = logits.dims.at(-1);
    for (let j = 0; j < chunk.length; j++) out.push(w === 1 ? d[j] : d[j * w + w - 1]);
  }
  return out;
}

const data = JSON.parse(readFileSync(join(LME, 'longmemeval_s_cleaned.json'), 'utf8'));
const qs = selectQuestions(data, { stride: STRIDE, limit: LIMIT });
const cache = new DatabaseSync(join(LME, 'embed-cache.db'), { readOnly: true, timeout: 60000 });
const gv = cache.prepare('SELECT v FROM vec WHERE h = ?');
const vecOf = (u) => { const r = gv.get(vecKey(unitEmbedText(u))); return r ? new Int8Array(r.v.buffer, r.v.byteOffset, r.v.byteLength) : null; };

const RRF = 60;
const rrf = (lists) => { const s = new Map(); for (const { ids, w = 1 } of lists) ids.forEach((id, i) => s.set(id, (s.get(id) || 0) + w / (RRF + i + 1))); return [...s.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id); };
const VARIANTS = {
  base: (c) => c.base,
  'ce-base50': (c) => c.ceOrder(c.base),
  'ce-pool': (c) => c.ceOrder(c.pool),
  'rrf(base,ce-pool)': (c) => rrf([{ ids: c.base }, { ids: c.ceOrder(c.pool) }]),
  'rrf(base,ce-pool w2)': (c) => rrf([{ ids: c.base }, { ids: c.ceOrder(c.pool), w: 2 }]),
  'pin3+ce-pool': (c) => { const h = c.base.slice(0, 3); const hs = new Set(h); return [...h, ...c.ceOrder(c.pool).filter((i) => !hs.has(i))]; },
  'pin5+rrf(base,ce-pool)': (c) => { const h = c.base.slice(0, 5); const hs = new Set(h); return [...h, ...rrf([{ ids: c.base }, { ids: c.ceOrder(c.pool) }]).filter((i) => !hs.has(i))]; },
};
const KS_U = [10, 20, 40];

const per = []; // { id, type, split, variant, metrics }
const work = mkdtempSync(join(tmpdir(), 'rerank-'));
const t0 = Date.now();
let ceMs = 0, cePairs = 0;
try {
  for (const [n, q] of qs.entries()) {
    const units = unitsFor(q, 'round');
    const dbPath = join(work, `${q.question_id}.db`);
    const byRow = buildStore(dbPath, units, { vecOf });
    const idOf = new Map([...byRow.entries()].map(([row, u]) => [u.id, row]));
    const { units: ranked } = await rankUnits({ dbPath, byRow, question: q.question, query: 'recall', mode: 'hybrid' });
    const base = ranked.map((u) => u.id);
    // wider pool: BM25 top POOL + semantic top POOL, after the base list
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let bm = [];
    try { const m = ftsMatchExpr(q.question.slice(0, MAX_QUERY_CHARS)); if (m) bm = db.prepare('SELECT rowid AS id FROM observations_fts WHERE observations_fts MATCH ? ORDER BY rank LIMIT ?').all(pruneCommonTerms(db, m), POOL).map((r) => byRow.get(Number(r.id)).id); } catch {}
    db.close();
    const sem = ((await semanticSearch({ dbPath, query: q.question, k: POOL, minSim: 0 })) || []).map((s) => byRow.get(Number(s.id)).id);
    const pool = [...new Set([...base, ...bm, ...sem])];
    const textOf = new Map(units.map((u) => [u.id, u.text]));
    const t1 = performance.now();
    const sc = await ceScores(q.question, pool.map((id) => textOf.get(id)));
    ceMs += performance.now() - t1; cePairs += pool.length;
    const score = new Map(pool.map((id, i) => [id, sc[i]]));
    const ceOrder = (ids) => ids.slice().sort((a, b) => score.get(b) - score.get(a));
    const ctx = { base, pool, ceOrder };
    const unitById = new Map(units.map((u) => [u.id, u]));
    const ev = units.filter((u) => u.hasAnswer).map((u) => u.id);
    for (const [name, fn] of Object.entries(VARIANTS)) {
      const order = fn(ctx).slice(0, 50);
      const m = scoreRanking(order.map((id) => unitById.get(id)), { answerSessions: q.answer_session_ids, unitEvidence: ev.length > 0 });
      for (const k of KS_U) { const top = new Set(order.slice(0, k)); m[`allEvidenceRounds@${k}`] = ev.length && ev.every((id) => top.has(id)) ? 1 : 0; }
      per.push({ id: q.question_id, type: q.question_type, split: n % 2 === 0 ? 'dev' : 'test', variant: name, m });
    }
    rmSync(dbPath, { force: true });
    if ((n + 1) % 50 === 0 || n + 1 === qs.length) log(`  ${n + 1}/${qs.length} · ${Math.round((Date.now() - t0) / 1000)}s · ce ${(ceMs / cePairs).toFixed(2)} ms/pair, avg pool ${Math.round(cePairs / (n + 1))}`);
  }
} finally { rmSync(work, { recursive: true, force: true }); }

const COLS = ['recall_any@1', 'recall_any@5', 'recall_all@5', 'recall_all@10', 'ndcg_any@10', 'allEvidenceRounds@10', 'allEvidenceRounds@20', 'allEvidenceRounds@40'];
const out = { model: MODEL, pool: POOL, maxlen: MAXLEN, questions: qs.length, msPerPair: +(ceMs / cePairs).toFixed(2), avgPool: Math.round(cePairs / qs.length), splits: {} };
for (const split of ['dev', 'test', 'all']) {
  out.splits[split] = {};
  for (const v of Object.keys(VARIANTS)) {
    const rows = per.filter((r) => r.variant === v && (split === 'all' || r.split === split));
    const a = aggregate(rows.map((r) => r.m));
    const ms = per.filter((r) => r.variant === v && r.type === 'multi-session' && (split === 'all' || r.split === split));
    out.splits[split][v] = { ...Object.fromEntries(COLS.map((c) => [c, a[c]])), 'multi-session allEvidenceRounds@40': aggregate(ms.map((r) => r.m))['allEvidenceRounds@40'] };
  }
}
const file = join(HERE, `results-${MODEL.split("/").pop()}-p${POOL}-L${MAXLEN}${STRIDE > 1 ? `-s${STRIDE}` : ""}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
for (const split of ['dev', 'test']) {
  console.log(`\n${split} (${per.filter((r) => r.variant === 'base' && r.split === split).length} q) — ${COLS.join(' | ')} | ms@40`);
  for (const [v, r] of Object.entries(out.splits[split])) console.log(`${v.padEnd(24)} ${COLS.map((c) => String(r[c]).padStart(5)).join(' ')}  ${r['multi-session allEvidenceRounds@40']}`);
}
