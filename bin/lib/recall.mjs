// Read path for the Agentic Brain MCP server (docs/specs/mcp-memory-server.md §1.2/§1.3).
//
// Two exports for T3 (bin/mcp-server.mjs) to call:
//   - recallSearch(): targeted search -> compact rows: FTS5/BM25, fused with
//     local semantic search when embeddings exist (embed.mjs). Never returns
//     raw `text` (transcripts can run ~8k chars — that would flood the caller's
//     context for one hit).
//   - taskContext(): the ranked, budgeted "what should I know" assembly. Per
//     spec this delegates to agent.mjs's already-eval-scored retrieveContext()
//     rather than forking ranking logic.
//
// Both hold to the same contract: read-only DB handles, never write to stdout
// (the caller is a stdio MCP server — stdout is the JSON-RPC channel; all
// diagnostics go to stderr), and never throw at the caller — a missing DB, a
// locked DB, or a malformed query degrade to an empty-but-valid result with a
// `reason`, not an exception.
import { existsSync } from 'node:fs';
import { openDb } from './db.mjs';
import { MEMORY_DB } from './paths.mjs';
import { retrieveContextHybrid } from './agent.mjs';
import { PROVENANCE_JOIN, PROVENANCE_COLS, provenanceOf, formatProvenance } from './provenance.mjs';
import { lifecycleCols, rerankByLifecycle, statusOf, lifecycleLabel, liveOnly, isPinned, hasPins } from './lifecycle.mjs';
import { MAX_PINNED_CONTEXT } from './curate.mjs';
import { semanticSearch, fuseRows, CANDIDATES } from './embed.mjs';
import { recordDelivery, workFor, estimateTokens } from './economics.mjs';
import { ftsMatchExpr, pruneCommonTerms, MAX_TASK_CHARS } from './fts.mjs';
import { collapseDuplicates } from './dedupe.mjs';
import { prfRerank } from './prf.mjs';
import { deepRerank, DEEP_POOL } from './rerank.mjs';

// The query builder and the brain_context input cap live in fts.mjs (agent.mjs,
// which this module imports, needs them too); re-exported so callers are unchanged.
export { ftsMatchExpr, MAX_TASK_CHARS };

// Caps — cheap on purpose, every byte costs tokens in the caller's session.
export const MAX_RESULT_LIMIT = 20; // brain_recall: hard ceiling on rows returned
export const DEFAULT_RESULT_LIMIT = 8; // brain_recall: spec default
export const SNIPPET_MAX_CHARS = 240; // brain_recall: snippet cap (spec §1.2)
// The facts are where a memory's specifics live (a long conversation's later
// decisions, numbers, names); the 240-char snippet only covers the narrative's
// opening. Without them a tool finds the right memory but not the answer in it.
export const MAX_FACTS = 10;
export const FACT_MAX_CHARS = 300;
export const MAX_QUERY_CHARS = 200; // brain_recall: input cap (spec §1.2)

function warn(...args) {
  // stderr only — never console.log/process.stdout from this module.
  console.error('[recall]', ...args);
}

// First N chars of narrative||facts, whitespace-collapsed, ellipsised —
// never the full field, and never the raw `text` column (that's where
// multi-thousand-char transcripts live).
function shapeFacts(raw) {
  let a;
  try { a = JSON.parse(raw || '[]'); } catch { return []; }
  if (!Array.isArray(a)) return [];
  return a.filter((f) => typeof f === 'string' && f.trim()).slice(0, MAX_FACTS)
    .map((f) => shapeSnippet(f, FACT_MAX_CHARS));
}

function shapeSnippet(raw, max = SNIPPET_MAX_CHARS) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

/**
 * brain_recall — targeted FTS5/BM25 search over observations.
 *
 * @param {object} opts
 * @param {string} opts.query - required, search text (capped at MAX_QUERY_CHARS)
 * @param {string} [opts.project] - optional exact-project filter
 * @param {number} [opts.limit] - 1..MAX_RESULT_LIMIT, default DEFAULT_RESULT_LIMIT
 * @param {string} [opts.dbPath] - override MEMORY_DB (tests: synthetic DB path)
 * @param {number} [opts.semanticBudgetMs] - longest a cold model load may hold this
 *   query up before it answers with BM25 alone (embed.mjs "cold start"); default: wait
 * @returns {Promise<{results: Array<{id,project,title,type,date,snippet,facts,source,file,provenance,status?,lifecycle?}>, count: number, reason?: string}>}
 */
export async function recallSearch({ query, project, limit = DEFAULT_RESULT_LIMIT, dbPath = MEMORY_DB, semanticBudgetMs, deep = false, allowRemoteModel = false } = {}) {
  const cappedLimit = Math.min(MAX_RESULT_LIMIT, Math.max(1, Number(limit) || DEFAULT_RESULT_LIMIT));
  const q = typeof query === 'string' ? query.slice(0, MAX_QUERY_CHARS) : '';

  if (!q.trim()) {
    return { results: [], count: 0, reason: 'empty query' };
  }
  if (!dbPath || !existsSync(dbPath)) {
    return { results: [], count: 0, reason: 'brain not initialized' };
  }

  const match = ftsMatchExpr(q);
  if (!match) {
    return { results: [], count: 0, reason: 'no searchable terms' };
  }

  let db;
  try {
    db = openDb(dbPath, { readonly: true });
  } catch (e) {
    warn('open failed:', e.message);
    return { results: [], count: 0, reason: 'database unavailable' };
  }

  try {
    try {
      db.exec('PRAGMA busy_timeout = 3000');
    } catch { /* best-effort; a readonly handle should not lock anyway */ }

    const projectClause = project ? ' AND o.project = ?' : '';
    // Hybrid: nearest memories by meaning (local model, no network), fused
    // with BM25 by reciprocal rank. null = unavailable → BM25 alone, as before.
    const semantic = await semanticSearch({ dbPath, query: q, project, budgetMs: semanticBudgetMs });
    const params = [pruneCommonTerms(db, match)];
    if (project) params.push(String(project).slice(0, 120));
    // Over-fetch so lifecycle re-ranking has room: a superseded/stale hit sinks
    // below active ones instead of taking a slot (lifecycle.mjs). With every
    // row active the order — and so the top `limit` — is unchanged.
    params.push(semantic ? Math.max(cappedLimit * 3, CANDIDATES) : cappedLimit * 3);

    const cols = `o.id, o.project, o.title, o.type, o.narrative, o.facts, ${lifecycleCols(db)}, ${PROVENANCE_COLS}`;
    // Soft-deleted rows (control panel) never come back from recall.
    const live = liveOnly(db);
    const bm25 = db
      .prepare(
        `SELECT ${cols}, rank AS score
         FROM observations_fts f JOIN observations o ON o.id = f.rowid ${PROVENANCE_JOIN}
         WHERE observations_fts MATCH ?${projectClause}${live}
         ORDER BY rank LIMIT ?`
      )
      .all(...params);
    // Pinned rows that match always make the candidate list, however weakly
    // they match; rerankByLifecycle then puts them first.
    let pinned = [];
    if (hasPins(db)) {
      pinned = db
        .prepare(
          `SELECT ${cols}, rank AS score
           FROM observations_fts f JOIN observations o ON o.id = f.rowid ${PROVENANCE_JOIN}
           WHERE observations_fts MATCH ?${projectClause}${live} AND o.pinned_at IS NOT NULL
           ORDER BY rank LIMIT ?`
        )
        .all(...params.slice(0, -1), MAX_PINNED_CONTEXT * 4);
    }
    const fetchRows = (ids) => db
      .prepare(`SELECT ${cols} FROM observations o ${PROVENANCE_JOIN} WHERE o.id IN (${ids.map(() => '?').join(',')})${live}`)
      .all(...ids);
    let fused = fuseRows(bm25, semantic, fetchRows);
    // Pseudo-relevance feedback (prf.mjs): a second search seeded by the top
    // hits, same filters and depth, so scattered pieces of one answer surface.
    if (semantic) {
      fused = await prfRerank(fused, {
        db, query: q, fetchRows,
        bm25: (expr) => db.prepare(
          `SELECT ${cols}, rank AS score
           FROM observations_fts f JOIN observations o ON o.id = f.rowid ${PROVENANCE_JOIN}
           WHERE observations_fts MATCH ?${projectClause}${live}
           ORDER BY rank LIMIT ?`
        ).all(pruneCommonTerms(db, expr), ...params.slice(1)),
        semantic: (text) => semanticSearch({ dbPath, query: text, project, budgetMs: semanticBudgetMs }),
      });
    }
    // Deep recall (rerank.mjs): widen the pool, let a local cross-encoder read
    // question + memory together and order it. Opt-in (~2 s); unavailable →
    // the normal ranking, flagged in `deep`.
    let deepStatus = null;
    if (deep && semantic) {
      const pool = new Map(fused.map((r) => [r.id, r]));
      try {
        for (const r of db.prepare(
          `SELECT ${cols}, rank AS score
           FROM observations_fts f JOIN observations o ON o.id = f.rowid ${PROVENANCE_JOIN}
           WHERE observations_fts MATCH ?${projectClause}${live}
           ORDER BY rank LIMIT ?`
        ).all(...params.slice(0, -1), DEEP_POOL)) if (!pool.has(r.id)) pool.set(r.id, r);
      } catch { /* keyword pool is a bonus */ }
      const more = ((await semanticSearch({ dbPath, query: q, project, k: DEEP_POOL, minSim: 0, budgetMs: semanticBudgetMs })) || [])
        .map((x) => x.id).filter((id) => !pool.has(id));
      if (more.length) for (const r of fetchRows(more)) pool.set(r.id, r);
      const re = await deepRerank(q, [...pool.values()], { allowRemote: allowRemoteModel });
      if (re) { fused = re.slice(0, Math.max(cappedLimit * 3, CANDIDATES)); deepStatus = 'reranked'; } else deepStatus = 'unavailable';
    } else if (deep) deepStatus = 'unavailable';
    const have = new Set(fused.map((r) => r.id));
    // (after fusion scores are -rrf; an FTS rank would not compare, so a
    // pinned row fusion did not keep falls back to its list position)
    for (const r of pinned) if (!have.has(r.id)) fused.push(semantic ? { ...r, score: null } : r);
    // One row per memory (dedupe.mjs): a copy of a row already in the list
    // never takes a slot — on a store never cleaned, or copies a sync brought.
    const rows = collapseDuplicates(db, rerankByLifecycle(fused), { limit: cappedLimit });

    const results = rows.map((r) => {
      const p = provenanceOf({ ...r, project: r.project || 'general' });
      const out = {
        id: r.id,
        project: r.project || 'general',
        title: r.title || '',
        type: r.type || '',
        date: r.created_at || '',
        snippet: shapeSnippet(r.narrative || r.facts),
        facts: shapeFacts(r.facts),
        // Where it came from, compactly: tool, file, and a ready-to-print line.
        source: p.source,
        file: p.file,
        provenance: formatProvenance(p),
      };
      // Only non-active rows carry these, so an all-active result is unchanged.
      if (statusOf(r) !== 'active') {
        out.status = statusOf(r);
        out.lifecycle = lifecycleLabel(r);
      }
      if (isPinned(r)) out.pinned = true;
      return out;
    });
    // Tokens-saved ledger: what was handed over, what it cost to read, what it
    // cost to produce. Best-effort; never affects the result.
    if (results.length) {
      const w = workFor(db, results.map((r) => r.id));
      recordDelivery({
        dbPath, kind: 'recall', project: project || '',
        items: results.map((r) => [r.id, w.get(r.id) || 0]),
        readTokens: estimateTokens(JSON.stringify(results)),
      });
    }
    return { results, count: results.length, ...(deepStatus ? { deep: deepStatus } : {}) };
  } catch (e) {
    // Malformed FTS query, missing table on a partial DB, whatever — degrade,
    // never throw at the caller.
    warn('query failed:', e.message);
    return { results: [], count: 0, reason: 'search failed' };
  } finally {
    try { db.close(); } catch { /* already closed / never opened */ }
  }
}

/**
 * brain_context — ranked, budgeted "what should I know before starting this
 * task" assembly. Delegates to agent.mjs's retrieveContext(), which is
 * already eval-scored (3.1: raw-obs BM25 = 65% hit rate); this function does
 * not fork or reimplement its ranking.
 *
 * Note on dbPath: retrieveContext() reads the module-level MEMORY_DB constant
 * from paths.mjs internally and has no path-override parameter, so `dbPath`
 * here cannot redirect its query the way it does for recallSearch(). It is
 * accepted (and returned in `reason` when it disagrees with the live
 * MEMORY_DB) purely so callers/tests can detect that mismatch rather than
 * silently querying the wrong store — see the recall-test.mjs comment for how
 * the test suite exercises the real delegation path via a subprocess with an
 * overridden HOME instead.
 *
 * @param {object} opts
 * @param {string} opts.task - required, task description (capped at MAX_TASK_CHARS)
 * @param {string} [opts.dbPath] - see note above
 * @param {number} [opts.semanticBudgetMs] - as for recallSearch()
 * @returns {Promise<{block: string, used: number, learningFiles: Array, reason?: string}>}
 */
export async function taskContext({ task, dbPath = MEMORY_DB, semanticBudgetMs } = {}) {
  const t = typeof task === 'string' ? task.slice(0, MAX_TASK_CHARS) : '';
  if (!t.trim()) {
    return { block: '', used: 0, learningFiles: [], reason: 'empty task' };
  }
  if (!dbPath || !existsSync(dbPath)) {
    return { block: '', used: 0, learningFiles: [], reason: 'brain not initialized' };
  }
  try {
    const { block, used, learningFiles, obsIds } = await retrieveContextHybrid(t, { semanticBudgetMs });
    const out = { block: block || '', used: used || 0, learningFiles: learningFiles || [] };
    // Tokens-saved ledger: only the observations that made it into the block
    // carry measured work; wiki/learning text still counts toward the read cost.
    if (obsIds && obsIds.length) {
      recordDelivery({ dbPath: MEMORY_DB, kind: 'context', items: obsIds, readTokens: estimateTokens(out.block) });
    }
    if (!out.block && !out.used) out.reason = 'no relevant context found';
    return out;
  } catch (e) {
    warn('taskContext failed:', e.message);
    return { block: '', used: 0, learningFiles: [], reason: 'context assembly failed' };
  }
}

// "load all my memory", "everything", "overview of all my projects", "whole brain"…
export function isOverviewRequest(task) {
  const t = String(task || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t || /^(all|everything|overview|load all|load everything|whole brain|entire brain)$/.test(t)) return true;
  // Only unambiguous "everything" phrasings — "all tests failing in agentic-brain"
  // or "all context for checkout" are ordinary searches and must stay that way.
  return /\b(all|entire|whole) (of )?my (memory|memories|brain|projects)\b/.test(t) ||
    /\boverview of (all|everything|my)\b/.test(t) ||
    /\b(load|show)( me)? everything\b/.test(t);
}
