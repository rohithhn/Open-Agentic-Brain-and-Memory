// LongMemEval-S retrieval harness — the pure parts (units, temp stores,
// ranking, metrics). run.mjs drives it; evals/longmemeval-test.mjs tests it.
//
// What is measured: given one question and that question's haystack of chat
// sessions, does the brain's OWN retrieval (the FTS5/BM25 query brain_recall
// runs, alone or fused with local embeddings by RRF exactly as recallSearch()
// fuses them) rank an evidence session near the top? Retrieval only — no LLM
// reads anything, nothing is judged, nothing leaves the Mac.
//
// Each question gets its own throwaway store (the product's schema, from
// store.mjs), so BM25's term statistics come from that question's haystack
// alone — the way a user's brain holds one history, not 500 of them.
import '../test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../../bin/lib/store.mjs';
import { ftsMatchExpr, MAX_QUERY_CHARS, MAX_TASK_CHARS } from '../../bin/lib/recall.mjs';
import { bm25Query } from '../../bin/lib/agent.mjs';
import { pruneCommonTerms } from '../../bin/lib/fts.mjs';
import { prfRerank } from '../../bin/lib/prf.mjs';
import { deepRerank, DEEP_POOL } from '../../bin/lib/rerank.mjs';
import { lifecycleCols, rerankByLifecycle } from '../../bin/lib/lifecycle.mjs';
import { semanticSearch, fuseRows, embedText, ensureVectorSchema, embedModel, CANDIDATES } from '../../bin/lib/embed.mjs';

export const KS = [1, 3, 5, 10];
// recallSearch() at its maximum page (limit 20) fetches max(20 * 3, CANDIDATES)
// BM25 rows; using the same depth makes our top 20 identical to brain_recall's.
export const BM25_DEPTH = Math.max(20 * 3, CANDIDATES);
// brain_context (retrieveContext, default limit 6) fuses max(6 * 3, CANDIDATES)
// BM25 rows with the semantic list, so its RRF input is 50 rows, not 60. In
// BM25-only mode it fetches 6 * 3 = 18 — a prefix of the same FTS5 order, so
// fetching CONTEXT_BM25_DEPTH instead changes no rank, only how far down we score.
export const CONTEXT_LIMIT = 6;
export const CONTEXT_BM25_DEPTH = Math.max(CONTEXT_LIMIT * 3, CANDIDATES);
export const RANK_DEPTH = CANDIDATES; // fusion keeps 50; we score the top 50 units

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const msgLine = (m) => `${m.role}: ${collapse(m.content)}`;

/**
 * Split one session into rounds: a user turn plus the assistant reply that
 * follows it. An assistant turn with no open round (a session that starts
 * with the assistant) is a round of its own. A round is evidence when any of
 * its turns carries the dataset's has_answer flag.
 */
export function roundsOf(sessionId, session) {
  const out = [];
  let cur = null;
  for (const m of session || []) {
    if (m.role === 'user' || !cur || cur.closed) {
      cur = { msgs: [], closed: false };
      out.push(cur);
    }
    cur.msgs.push(m);
    if (m.role !== 'user') cur.closed = true;
  }
  return out.map((r, i) => ({
    id: `${sessionId}#${i}`,
    session: sessionId,
    text: r.msgs.map(msgLine).join('\n'),
    hasAnswer: r.msgs.some((m) => m.has_answer),
  }));
}

/** A whole session as one unit (its embedding sees only the first MAX_EMBED_CHARS). */
export function sessionUnit(sessionId, session) {
  return {
    id: sessionId,
    session: sessionId,
    text: (session || []).map(msgLine).join('\n'),
    hasAnswer: (session || []).some((m) => m.has_answer),
  };
}

/** Every retrieval unit of one question's haystack, at 'round' or 'session' granularity. */
export function unitsFor(q, granularity = 'round') {
  const units = [];
  q.haystack_sessions.forEach((s, i) => {
    const sid = q.haystack_session_ids[i];
    const date = q.haystack_dates?.[i] || '';
    if (granularity === 'session') units.push({ ...sessionUnit(sid, s), date });
    else for (const u of roundsOf(sid, s)) units.push({ ...u, date });
  });
  return units;
}

/** The text the product embeds for a unit stored as an observation (embed.mjs embedText). */
export const unitEmbedText = (u) => embedText({ narrative: u.text });
export const vecKey = (text, model = embedModel()) => createHash('sha1').update(model + '\0' + text).digest('hex');

// "2023/05/20 (Sat) 02:21" → epoch ms (0 when unparseable). Ranking never
// uses dates; they are stored only so the rows look like real memories.
function epochOf(date) {
  const m = String(date).match(/(\d{4})\/(\d{2})\/(\d{2})\D+(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : 0;
}

/**
 * Write one question's units into a fresh store at `path` (the product's
 * schema). Each unit is an observation whose narrative is the unit's text —
 * no title, no facts, nothing distilled. `vecOf(unit)` → Int8Array | null
 * supplies the cached embedding; with it the store gets observation_vectors
 * rows exactly like `brain embed --apply` writes. Returns rowid → unit.
 */
export function buildStore(path, units, { vecOf = null, model = embedModel() } = {}) {
  const db = new DatabaseSync(path);
  try {
    ensureSchema(db);
    if (vecOf) ensureVectorSchema(db);
    const ins = db.prepare(`INSERT INTO observations (memory_session_id, project, type, narrative, created_at, created_at_epoch, content_hash)
      VALUES (?, 'longmemeval', 'conversation', ?, ?, ?, ?)`);
    const vin = vecOf ? db.prepare('INSERT INTO observation_vectors (obs_id, model, text_hash, dim, vec, embedded_at) VALUES (?,?,?,?,?,?)') : null;
    const byRow = new Map();
    const now = Date.now();
    db.exec('BEGIN');
    // content_hash carries the position too: 13 haystacks list one session id
    // twice, and the store's (session, content_hash) key is unique.
    for (const [i, u] of units.entries()) {
      const r = ins.run(u.session, u.text, u.date || '', epochOf(u.date), `${i}:${u.id}`);
      const id = Number(r.lastInsertRowid);
      byRow.set(id, u);
      const v = vecOf ? vecOf(u) : null;
      if (v) vin.run(id, model, 'lme', v.length, v, now);
    }
    db.exec('COMMIT');
    return byRow;
  } finally {
    db.close();
  }
}

/**
 * Rank a question's units the way the product would:
 *   query 'recall'  — brain_recall's query: every token OR'd (ftsMatchExpr), input capped at MAX_QUERY_CHARS
 *   query 'context' — brain_context's query: bm25Query = ftsMatchExpr over the first MAX_TASK_CHARS chars (was: first six words > 3 chars)
 *   mode 'bm25'     — FTS5 rank alone
 *   mode 'hybrid'   — BM25 fused with semanticSearch() by RRF (fuseRows), as recallSearch() does
 * with each tool's own BM25 depth (BM25_DEPTH for recall, CONTEXT_BM25_DEPTH for context). Then rerankByLifecycle (a no-op here: every row is active). Returns
 * { units (best first, ≤ RANK_DEPTH), semantic: count or null }. Throws when
 * hybrid was asked for but semantic search is unavailable — a silent BM25
 * fallback would report BM25 numbers under the hybrid label.
 */
export async function rankUnits({ dbPath, byRow, question, query = 'recall', mode = 'bm25', deep = false }) {
  const q = String(question || '').slice(0, query === 'recall' ? MAX_QUERY_CHARS : MAX_TASK_CHARS);
  const match = query === 'recall' ? ftsMatchExpr(q) : bm25Query(q);
  let semantic = null;
  if (mode === 'hybrid') {
    semantic = await semanticSearch({ dbPath, query: q });
    if (!semantic) throw new Error('hybrid requested but semantic search is unavailable (model or vectors missing)');
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = `o.id, o.narrative, ${lifecycleCols(db)}`;
    let bm25 = [];
    // A query the tokenizer turns into FTS syntax (e.g. a bare NEAR) fails like
    // retrieveContext's does: no BM25 rows, meaning alone still ranks.
    try {
      if (match) bm25 = db.prepare(`SELECT ${cols}, rank AS score FROM observations_fts f JOIN observations o ON o.id = f.rowid
        WHERE observations_fts MATCH ? ORDER BY rank LIMIT ?`).all(pruneCommonTerms(db, match), query === 'recall' ? BM25_DEPTH : CONTEXT_BM25_DEPTH);
    } catch { bm25 = []; }
    const fetchRows = (ids) => db.prepare(`SELECT ${cols} FROM observations o WHERE o.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    // PRF exactly as recallSearch/retrieveContext apply it (bin/lib/prf.mjs);
    // BRAIN_PRF=0 scores the pre-PRF ranking.
    let fused = fuseRows(bm25, semantic, fetchRows);
    if (semantic) {
      const depth = query === 'recall' ? BM25_DEPTH : CONTEXT_BM25_DEPTH;
      fused = await prfRerank(fused, {
        db, query: q, fetchRows,
        bm25: (expr) => db.prepare(`SELECT ${cols}, rank AS score FROM observations_fts f JOIN observations o ON o.id = f.rowid
          WHERE observations_fts MATCH ? ORDER BY rank LIMIT ?`).all(pruneCommonTerms(db, expr), depth),
        semantic: (text) => semanticSearch({ dbPath, query: text }),
      });
    }
    // Deep recall (bin/lib/rerank.mjs), as recallSearch({ deep: true }) does:
    // widen the pool with BM25 top DEEP_POOL + semantic top DEEP_POOL, then let
    // the cross-encoder order it. Throws if asked for and unavailable.
    if (deep) {
      const pool = new Map(fused.map((r) => [r.id, r]));
      try {
        if (match) for (const r of db.prepare(`SELECT ${cols}, rank AS score FROM observations_fts f JOIN observations o ON o.id = f.rowid
          WHERE observations_fts MATCH ? ORDER BY rank LIMIT ?`).all(pruneCommonTerms(db, match), DEEP_POOL)) if (!pool.has(r.id)) pool.set(r.id, r);
      } catch {}
      const more = ((await semanticSearch({ dbPath, query: q, k: DEEP_POOL, minSim: 0 })) || []).map((s) => s.id).filter((id) => !pool.has(id));
      if (more.length) for (const r of fetchRows(more)) pool.set(r.id, r);
      const re = await deepRerank(q, [...pool.values()], { allowRemote: true });
      if (!re) throw new Error('deep requested but the reranker is unavailable');
      fused = re;
    }
    const rows = rerankByLifecycle(fused, deep ? Infinity : RANK_DEPTH);
    return { units: rows.map((r) => byRow.get(Number(r.id))).filter(Boolean), semantic: semantic ? semantic.length : null };
  } finally {
    db.close();
  }
}

/**
 * Score one ranking. Session metrics dedupe the ranked units to sessions in
 * first-seen order (the paper's "retrieve rounds, report sessions"); unit
 * metrics count a hit when a has_answer unit is in the top k.
 *   recall_any@k — at least one evidence session in the top k sessions
 *   recall_all@k — every evidence session in the top k sessions
 *   ndcg_any@k   — binary-relevance NDCG over the top k sessions
 *   unit_any@k   — a has_answer unit (round) itself in the top k units
 * A ranking shorter than k (BM25 matched few rows) simply counts as a miss.
 */
export function scoreRanking(units, { answerSessions, unitEvidence = false, ks = KS } = {}) {
  const gold = new Set(answerSessions);
  const sessions = [];
  const seen = new Set();
  for (const u of units) if (!seen.has(u.session)) { seen.add(u.session); sessions.push(u.session); }
  const out = {};
  for (const k of ks) {
    const top = sessions.slice(0, k);
    out[`recall_any@${k}`] = top.some((s) => gold.has(s)) ? 1 : 0;
    out[`recall_all@${k}`] = [...gold].every((s) => top.includes(s)) ? 1 : 0;
    let dcg = 0;
    top.forEach((s, i) => { if (gold.has(s)) dcg += 1 / Math.log2(i + 2); });
    let idcg = 0;
    for (let i = 0; i < Math.min(k, gold.size); i++) idcg += 1 / Math.log2(i + 2);
    out[`ndcg_any@${k}`] = idcg ? dcg / idcg : 0;
  }
  // Only when the haystack marks evidence turns at all (a few questions mark none).
  if (unitEvidence) for (const k of ks) out[`unit_any@${k}`] = units.slice(0, k).some((u) => u.hasAnswer) ? 1 : 0;
  return out;
}

/** Mean of each metric over rows ([{ metrics }]), as percentages with one decimal. */
export function aggregate(rows) {
  const sums = {};
  const counts = {};
  for (const r of rows) for (const [k, v] of Object.entries(r)) { sums[k] = (sums[k] || 0) + v; counts[k] = (counts[k] || 0) + 1; }
  const out = {};
  for (const k of Object.keys(sums)) out[k] = Math.round((sums[k] / counts[k]) * 1000) / 10;
  return out;
}

/** Deterministic subset: sort by question_id, keep every `stride`-th, then the first `limit`. */
export function selectQuestions(data, { stride = 1, limit = Infinity, includeAbstention = false } = {}) {
  return data
    .filter((q) => includeAbstention || !String(q.question_id).endsWith('_abs'))
    .slice()
    .sort((a, b) => (a.question_id < b.question_id ? -1 : a.question_id > b.question_id ? 1 : 0))
    .filter((_, i) => i % stride === 0)
    .slice(0, limit);
}
