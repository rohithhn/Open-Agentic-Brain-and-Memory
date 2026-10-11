// The one FTS5 query builder, shared by brain_recall (recall.mjs) and the
// brain_context path (agent.mjs bm25Query). A leaf module on purpose: recall.mjs
// imports agent.mjs, so agent.mjs cannot import recall.mjs without a cycle.

export const MAX_TASK_CHARS = 300; // brain_context: input cap (spec 1.3)

// Same tokenizer/sanitiser ui/server.mjs's browseMemory() already uses:
// lowercase, split into alnum tokens, quote each token so punctuation/FTS
// operators (", -, *, NOT, OR, ^ ...) in the raw query can never be read as
// FTS5 syntax, then OR them together for recall. Reused verbatim rather than
// inventing a second sanitiser (spec explicitly calls this out).
// Exported for the LongMemEval harness (evals/longmemeval/), which scores it.
export function ftsMatchExpr(text) {
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  if (!tokens.length) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

// Speed without changing the ranking. FTS5's BM25 gives a term in more than
// half of all rows an IDF of log((N-n+0.5)/(n+0.5)) <= 0, which it clamps to
// 1e-6 — such a term adds nothing to any score. It still makes FTS5 visit
// and score every row it occurs in, so on a large store "the", "how", "we"
// cost most of the query time (100k rows: 85ms → 27ms median, top-10 99.7%
// identical). Drop those terms; if every term is that common, keep the 3
// rarest so the query still matches what it matched before. Terms in no row
// at all match nothing either way and are left out. Below MIN_ROWS_TO_PRUNE
// nothing is pruned: a small store answers in a millisecond or two anyway,
// and there "more than half the rows" can be a young brain's main topic.
// `expr` is an ftsMatchExpr() string; any failure returns it unchanged.
const KEEP_WHEN_ALL_COMMON = 3;
export const MIN_ROWS_TO_PRUNE = 1000;
export function pruneCommonTerms(db, expr, { table = 'observations_fts', contentTable = 'observations', minRows = MIN_ROWS_TO_PRUNE } = {}) {
  if (!expr) return expr;
  try {
    const terms = [...expr.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (terms.length < 2) return expr;
    const n = db.prepare(`SELECT count(*) AS c FROM ${contentTable}`).get().c;
    if (n < minRows) return expr;
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${table}_vocab USING fts5vocab(main, ${table}, 'row')`);
    const df = db.prepare(`SELECT doc FROM temp.${table}_vocab WHERE term = ?`);
    const withDf = terms.map((t, i) => ({ t, i, df: df.get(t)?.doc ?? 0 })).filter((x) => x.df > 0);
    if (!withDf.length) return expr;
    let keep = withDf.filter((x) => x.df <= n / 2);
    if (!keep.length) keep = withDf.slice().sort((a, b) => a.df - b.df || a.i - b.i).slice(0, KEEP_WHEN_ALL_COMMON).sort((a, b) => a.i - b.i);
    return keep.length === terms.length ? expr : keep.map((x) => `"${x.t}"`).join(' OR ');
  } catch {
    return expr;
  }
}
