// Pseudo-relevance feedback: a second search seeded by the first one's best
// hits, so a question whose answer is spread over several memories ("how many
// bikes did I service", "total raised across the charity events") pulls in the
// pieces the question's own words never mention.
//
// After BM25 + semantic fusion, take the top FEEDBACK rows, pick the EXPANSION
// terms that best characterise them (tf-idf, minus the query's own words,
// stopwords, and terms that are rare or common), and run BM25 and semantic
// search again with those terms added. The three lists — original fused, PRF
// BM25, PRF semantic — are fused by RRF, and the original top PIN rows keep
// their places, so the best direct hits never move.
//
// Measured (evals/multihop/RESULTS.md, same pools, same k): LoCoMo multi-hop
// evidence-all@20 19.9 → 26.2, overall 68.4 → 71.1; LongMemEval all@5
// 84.9 → 87.7, all@10 91.7 → 94.0; no category or headline metric lower.
// Off switch: BRAIN_PRF=0. Fails open: any error returns the fused list as is.
import { RRF_K, CANDIDATES } from './embed.mjs';
import { ftsMatchExpr } from './fts.mjs';

export const PRF = { feedback: 8, terms: 10, pin: 5, minRows: 50, maxDfFrac: 0.1 };

const STOP = new Set(`a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves
s t d ll m o re ve y ain don didn doesn isn wasn weren won wouldn couldn shouldn hasn haven hadn aren let like get got go going gone one two yes yeah ok okay oh hey hi hello thanks thank please really much many lot way thing things know think want see
user assistant`.split(/\s+/));
const toks = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
const rowText = (r) => [r.title, r.subtitle, r.narrative, r.text, r.facts].filter(Boolean).join(' ');

export const prfEnabled = () => process.env.BRAIN_PRF !== '0';

/** The `t` terms that best characterise the feedback rows (tf-idf, document frequency from FTS5). */
export function expansionTerms(db, feedbackRows, query, { t = PRF.terms, maxDfFrac = PRF.maxDfFrac, table = 'observations_fts' } = {}) {
  const n = db.prepare('SELECT count(*) AS c FROM observations').get().c;
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${table}_vocab USING fts5vocab(main, ${table}, 'row')`);
  const dfStmt = db.prepare(`SELECT doc FROM temp.${table}_vocab WHERE term = ?`);
  const dfCache = new Map();
  const df = (term) => { if (!dfCache.has(term)) dfCache.set(term, dfStmt.get(term)?.doc ?? 0); return dfCache.get(term); };
  const qt = new Set(toks(query));
  const score = new Map();
  for (const row of feedbackRows) {
    const tf = new Map();
    for (const term of toks(rowText(row))) tf.set(term, (tf.get(term) || 0) + 1);
    for (const [term, c] of tf) {
      if (qt.has(term) || STOP.has(term) || term.length < 3) continue;
      const d = df(term);
      if (d < 2 || d > maxDfFrac * n) continue;
      score.set(term, (score.get(term) || 0) + (1 + Math.log(c)) * Math.log(n / d));
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, t).map(([term]) => term);
}

/**
 * Re-rank a fused row list with PRF. Callers supply the two searches so the
 * same function serves brain_recall, brain_context and the eval harnesses:
 *   bm25(matchExpr)      → rows (same columns as `fused`), best first
 *   semantic(text)       → [{ id }] best first, or null when unavailable
 *   fetchRows(ids)       → rows for ids neither list carried
 * Returns rows best first, at most `depth`. Each row's score is rank-based
 * (-1/(position+1)) so rerankByLifecycle, which sorts by score, keeps this
 * order — including the pinned head — and only demotes stale/superseded rows.
 */
export async function prfRerank(fused, { db, query, bm25, semantic, fetchRows, depth = CANDIDATES } = {}) {
  if (!prfEnabled() || !Array.isArray(fused) || fused.length < PRF.feedback) return fused;
  try {
    const n = db.prepare('SELECT count(*) AS c FROM observations').get().c;
    if (n < PRF.minRows) return fused;
    const terms = expansionTerms(db, fused.slice(0, PRF.feedback), query);
    if (!terms.length) return fused;
    const base = ftsMatchExpr(query);
    const expr = (base ? base + ' OR ' : '') + terms.map((t) => `"${t}"`).join(' OR ');
    const sem = await semantic(`${query} ${terms.join(' ')}`);
    if (!sem) return fused; // measured only with both lists; never half-apply
    const b2 = bm25(expr) || [];
    const score = new Map();
    const add = (ids) => ids.slice(0, depth).forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (RRF_K + i + 1)));
    add(fused.map((r) => r.id));
    add(b2.map((r) => r.id));
    add(sem.map((s) => s.id));
    const order = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const head = fused.slice(0, PRF.pin).map((r) => r.id);
    const hs = new Set(head);
    const ids = [...head, ...order.filter((id) => !hs.has(id))].slice(0, depth);
    const byId = new Map([...b2, ...fused].map((r) => [r.id, r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) for (const r of fetchRows(missing)) byId.set(r.id, r);
    return ids.filter((id) => byId.has(id)).map((id, i) => ({ ...byId.get(id), score: -1 / (i + 1) }));
  } catch {
    return fused;
  }
}
