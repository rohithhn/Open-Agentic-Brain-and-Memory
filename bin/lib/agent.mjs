// Agents. Summon a role and dispatch it to a backend — either one of YOUR CLIs
// (Claude / Gemini / Codex) or a hosted model via API (e.g. Nous Research Hermes
// on OpenRouter). The prompt is prefixed with relevant memory from your brain, so
// this doubles as live memory injection into whatever model runs it.
import { execFileSync } from 'node:child_process';
import { binOnPath, binPath, childPath } from './wire-targets.mjs';
import { existsSync } from 'node:fs';
import { openDb } from './db.mjs';
import { MEMORY_DB } from './paths.mjs';
import { searchLearnings, recordUsage } from './learn.mjs';
import { searchWiki } from './dream.mjs';
import { searchWorkflows } from './workflows.mjs';
import { ensureSelfRunDir } from './selfcapture.mjs';
import { PROVENANCE_JOIN, PROVENANCE_COLS, provenanceOf, formatProvenance } from './provenance.mjs';
import { lifecycleCols, rerankByLifecycle, lifecycleLabel, liveOnly } from './lifecycle.mjs';
import { pinnedRows, MAX_PINNED_CONTEXT } from './curate.mjs';
import { semanticSearch, fuseRows, CANDIDATES } from './embed.mjs';
import { ftsMatchExpr, pruneCommonTerms, MAX_TASK_CHARS } from './fts.mjs';
import { collapseDuplicates } from './dedupe.mjs';
import { prfRerank, prfEnabled } from './prf.mjs';

const BUDGET = 8000; // ~2k tokens of injected context
const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// CLI backends: non-interactive invocation per tool. Route a role+task to any
// installed CLI; brain memory is injected into the prompt.
export const CLIS = {
  claude: { bin: 'claude', args: (p) => ['-p', p], label: 'Claude Code' },
  antigravity: { bin: 'agy', args: (p) => ['-p', p], label: 'Antigravity (agy)' },
  // --skip-git-repo-check: self-runs start in ~/.claude-brain/self-runs, which
  // is not a git repo, and codex exec refuses to run outside one without it.
  codex: { bin: 'codex', args: (p) => ['exec', '--skip-git-repo-check', p], label: 'OpenAI Codex' },
};

export const ROLES = {
  strategist: { name: 'Marketing Strategist', sys: 'You are a sharp marketing strategist. Give positioning, hooks, and audience cuts. Be concrete and concise.' },
  research: { name: 'Research Analyst', sys: 'You are a rigorous research analyst. Produce a structured, cited deep-dive. Separate facts from inference.' },
  ghostwriter: { name: 'Ghostwriter', sys: 'You are a ghostwriter. Draft long-form copy in a clear, human voice. Match the requested tone.' },
  comms: { name: 'Comms Lead', sys: 'You are a communications lead. Draft PR-safe statements, FAQs, and crisis responses. Careful and precise.' },
  brainstorm: { name: 'Creative Brainstormer', sys: 'You are a creative brainstormer. Generate a wide range of concepts and formats. Favor volume and variety.' },
  growth: { name: 'Growth Operator', sys: 'You are a growth operator. Propose funnels, experiments, and metrics. Be pragmatic and measurable.' },
  engineer: { name: 'Engineer', sys: 'You are a senior software engineer. Give precise, correct, minimal solutions. Reference concrete files/APIs.' },
};

// Pure-fs PATH scan: never spawns a shell, so the user's startup files
// (.zprofile/.zshrc) are not sourced just to answer "is the CLI installed?".
function onPath(bin) {
  return binOnPath(bin);
}

export function availableTools() {
  return Object.entries(CLIS).map(([id, c]) => ({ id, label: c.label, kind: 'cli', available: onPath(c.bin) }));
}

export function agentRoles() {
  return Object.entries(ROLES).map(([id, r]) => ({ id, name: r.name }));
}

// The FTS5 query for a task: every token of its first MAX_TASK_CHARS chars,
// quoted and OR'd — the same builder brain_recall uses (fts.mjs ftsMatchExpr).
// It used to keep only the first six words longer than 3 chars, which scored
// far below brain_recall on the same store (LongMemEval any@1 67.7 vs 85.3).
// Exported for the LongMemEval harness, which scores this query path too.
export function bm25Query(task) {
  return ftsMatchExpr(String(task || '').slice(0, MAX_TASK_CHARS));
}

/**
 * retrieveContext() with local semantic search fused in when it is available
 * (embeddings backfilled, model on disk). Falls back to BM25 silently.
 * `bm25Only` forces the old path (the eval uses it to compare);
 * `semanticBudgetMs` caps the wait on a cold model load (embed.mjs "cold start").
 */
export async function retrieveContextHybrid(task, { bm25Only = false, semanticBudgetMs, ...opts } = {}) {
  const semantic = !bm25Only && opts.obs !== false
    ? await semanticSearch({ dbPath: MEMORY_DB, query: String(task || '').slice(0, 1000), budgetMs: semanticBudgetMs })
    : null;
  // Pseudo-relevance feedback (prf.mjs) needs a second, async semantic search,
  // so the ranking it produces is computed here and handed to the synchronous
  // retrieveContext as `prfOrder` — the same BM25 query, filter and depth.
  let prfOrder = null;
  if (semantic && opts.obs !== false && prfEnabled() && existsSync(MEMORY_DB)) {
    let db;
    try {
      db = openDb(MEMORY_DB, { readonly: true });
      const depth = Math.max((opts.limit ?? 6) * 3, CANDIDATES);
      const live = liveOnly(db);
      const cols = `o.id, o.title, o.narrative, o.facts, ${lifecycleCols(db)}`;
      const run = (expr) => {
        if (!expr) return [];
        try {
          return db.prepare(`SELECT ${cols}, rank AS score FROM observations_fts f JOIN observations o ON o.id=f.rowid
            WHERE observations_fts MATCH ?${live} ORDER BY rank LIMIT ?`).all(pruneCommonTerms(db, expr), depth);
        } catch { return []; }
      };
      const fetchRows = (ids) => db.prepare(`SELECT ${cols} FROM observations o WHERE o.id IN (${ids.map(() => '?').join(',')})${live}`).all(...ids);
      const fused = fuseRows(run(bm25Query(task)), semantic, fetchRows);
      const ranked = await prfRerank(fused, {
        db, query: String(task || '').slice(0, MAX_TASK_CHARS), bm25: run, fetchRows,
        semantic: (text) => semanticSearch({ dbPath: MEMORY_DB, query: text, budgetMs: semanticBudgetMs }),
      });
      if (ranked !== fused) prfOrder = ranked.map((r) => r.id);
    } catch {
      prfOrder = null; // fail open: the plain fused ranking
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return { ...retrieveContext(task, { ...opts, semantic, prfOrder }), hybrid: !!semantic };
}

// The ranked rows minus every copy of a memory already in the block — a pinned
// row's twin included — capped at `limit` (dedupe.mjs). Pinned rows are not
// returned: they have their own section.
function oneRowPerMemory(db, pinned, ranked, limit) {
  const pinnedIds = new Set(pinned.map((r) => r.id));
  return collapseDuplicates(db, [...pinned, ...ranked.filter((r) => !pinnedIds.has(r.id))])
    .filter((r) => !pinnedIds.has(r.id))
    .slice(0, limit);
}

// Pull relevant memory from the brain for this task (the injected context).
// Sources are toggleable so the eval can reuse this exact retrieval path in
// raw-obs-baseline vs full-brain modes without duplicating the logic.
//
// PRIORITY (measurement-informed — deviates from the ROADMAP's stated order,
// on purpose): learnings → raw-obs → workflows → wiki. The 3.1 eval proved
// raw-obs BM25 is the workhorse (65% hit rate) and wiki adds zero incremental
// hits; the ROADMAP's "raw last" ordering would let the budget truncate the
// best source. So raw-obs goes early, wiki goes last.
//
// `semantic` = pre-computed nearest-by-meaning hits ([{id, sim}], from
// embed.mjs semanticSearch) to fuse with BM25; retrieveContextHybrid() below
// supplies it. Without it this is BM25 alone, exactly as before.
export function retrieveContext(task, { limit = 6, wiki = true, obs = true, learnings = true, workflows = true, provenance = true, semantic = null, prfOrder = null, pins = true } = {}) {
  if (!existsSync(MEMORY_DB)) return { block: '', used: 0, learningFiles: [] };
  let rows = [];
  // Pinned memories (control panel) are in every block, whatever the task —
  // a handful at most (MAX_PINNED_CONTEXT), priced by the same BUDGET.
  let pinned = [];
  if (obs && pins) {
    try {
      const db = openDb(MEMORY_DB, { readonly: true });
      try {
        // One row per memory here too: `brain clean --dupes` leaves pinned
        // copies visible, so two pinned twins would otherwise both show.
        // Over-fetch so a collapsed twin does not cost a pinned slot.
        pinned = collapseDuplicates(
          db,
          pinnedRows(db, { limit: MAX_PINNED_CONTEXT * 4, cols: `o.id, o.project, o.title, o.narrative, o.facts, o.content_hash, ${lifecycleCols(db)}, ${PROVENANCE_COLS}`, join: PROVENANCE_JOIN }),
          { limit: MAX_PINNED_CONTEXT }
        );
      } finally { db.close(); }
    } catch { pinned = []; }
  }
  if (obs && semantic?.length) {
    // Hybrid. Runs even when the task has no BM25-usable words: meaning alone
    // can still find the memory.
    const db = openDb(MEMORY_DB, { readonly: true });
    try {
      const cols = `o.id, o.project, o.title, o.narrative, o.facts, o.content_hash, ${lifecycleCols(db)}, ${PROVENANCE_COLS}`;
      const q = bm25Query(task);
      const live = liveOnly(db); // soft-deleted rows never reach a prompt
      let bm25 = [];
      try {
        if (q) bm25 = db.prepare(`SELECT ${cols}, rank AS score FROM observations_fts f
             JOIN observations o ON o.id=f.rowid ${PROVENANCE_JOIN} WHERE observations_fts MATCH ?${live}
             ORDER BY rank LIMIT ?`).all(pruneCommonTerms(db, q), Math.max(limit * 3, CANDIDATES));
      } catch {}
      const fetchRows = (ids) => db
        .prepare(`SELECT ${cols} FROM observations o ${PROVENANCE_JOIN} WHERE o.id IN (${ids.map(() => '?').join(',')})${live}`)
        .all(...ids);
      // prfOrder: the PRF ranking retrieveContextHybrid computed; rank-based
      // scores keep its order through the lifecycle re-rank.
      let ranked;
      if (prfOrder?.length) {
        const byId = new Map(fetchRows(prfOrder).map((r) => [r.id, r]));
        ranked = prfOrder.filter((id) => byId.has(id)).map((id, i) => ({ ...byId.get(id), score: -1 / (i + 1) }));
      } else ranked = fuseRows(bm25, semantic, fetchRows);
      rows = oneRowPerMemory(db, pinned, rerankByLifecycle(ranked), limit);
    } catch {
    } finally {
      db.close();
    }
  } else if (obs) {
    const q = bm25Query(task);
    if (q) {
      const db = openDb(MEMORY_DB, { readonly: true });
      try {
        rows = db
          .prepare(
            // Rank by BM25 relevance (FTS5 `rank`), NOT recency. Recency ordering buried
            // exact-term answers under newer noise — the brain eval (3.1) measured this as
            // the dominant miss cause. bm25 lifts the right observation to the top.
            `SELECT o.id, o.project, o.title, o.narrative, o.facts, o.content_hash, rank AS score, ${lifecycleCols(db)}, ${PROVENANCE_COLS} FROM observations_fts f
             JOIN observations o ON o.id=f.rowid ${PROVENANCE_JOIN} WHERE observations_fts MATCH ?${liveOnly(db)}
             ORDER BY rank LIMIT ?`
          )
          .all(pruneCommonTerms(db, q), limit * 3);
        // Lifecycle: over-fetch, then let active rows outrank superseded/stale
        // ones (identical order when every row is active).
        rows = oneRowPerMemory(db, pinned, rerankByLifecycle(rows), limit);
      } catch {
      } finally {
        db.close();
      }
    }
  }

  // Dedup raw-obs by content_hash first (same fact captured in multiple projects/sessions).
  // A pinned row is already in its own section, so it is not repeated below.
  const seenHash = new Set();
  const pinnedIds = new Set(pinned.map((r) => r.id));
  for (const r of pinned) if (r.content_hash) seenHash.add(r.content_hash);
  const dedupedRows = rows.filter((r) => {
    if (pinnedIds.has(r.id)) return false;
    if (!r.content_hash) return true;
    if (seenHash.has(r.content_hash)) return false;
    seenHash.add(r.content_hash);
    return true;
  });

  const learningHits = learnings ? searchLearnings(task) : [];
  const workflowHits = workflows ? searchWorkflows(task) : [];
  const wikiHits = wiki ? searchWiki(task) : [];

  // Candidate groups in priority order. Each item is fingerprinted + budgeted
  // independently so a long source can't starve everything after it.
  // item text -> observation id, so the kept items can be reported by id
  // (economics.mjs prices the tokens-saved ledger from these).
  const obsIdByItem = new Map();
  const obsItem = (r) => {
    const item = `- [${[provenance ? formatProvenance(provenanceOf(r)) || r.project : r.project, lifecycleLabel(r)].filter(Boolean).join(' · ')}] ${r.title || ''}: ${(r.narrative || r.facts || '').slice(0, 240)}`;
    if (r.id != null) obsIdByItem.set(item, r.id);
    return item;
  };
  const groups = [
    {
      header: '## Pinned (always included)',
      items: pinned.map(obsItem),
    },
    {
      header: '## Past learnings (reuse these)',
      items: learningHits.map((l) => `- ${l.title}: ${l.result.slice(0, 200)}`),
    },
    {
      header: '## Related raw observations',
      // Provenance rides inside the bracket — "[project · tool · date · file]" — so each
      // memory says where it came from for ~40 chars; it is priced by the same BUDGET.
      // A non-active row says so ("superseded by #123", "stale") so the reader
      // knows not to act on it as current.
      items: dedupedRows.map(obsItem),
    },
    {
      header: '## Workflows (your rituals)',
      items: workflowHits.map((w) => `### ${w.topic}\n${w.content}`),
    },
    {
      header: '## Distilled knowledge (wiki)',
      items: wikiHits.map((p) => `### ${p.topic}\n${p.content.slice(0, 1200)}`),
    },
  ];

  const seen = new Set();
  let len = 0;
  let used = 0;
  const sections = [];
  const obsIds = [];
  for (const g of groups) {
    const kept = [];
    for (const item of g.items) {
      // Full normalized text, NOT a 120-char prefix: a prefix collapses two distinct
      // observations that share a project + templated title, silently dropping a real fact.
      // Raw obs are already deduped by content_hash above; this catches exact cross-source dups.
      const fp = norm(item);
      if (seen.has(fp)) continue;
      if (len + item.length > BUDGET) break; // stop adding — budget exhausted
      seen.add(fp);
      kept.push(item);
      if (obsIdByItem.has(item)) obsIds.push(obsIdByItem.get(item));
      len += item.length;
      used++;
    }
    if (kept.length) sections.push(`${g.header}\n${kept.join('\n\n')}`);
  }
  const block = sections.join('\n\n');
  const learningFiles = learningHits.map((l) => ({ file: l.file, title: l.title }));
  return { block, used, learningFiles, obsIds };
}

// Thin wrapper: all sources on, semantic search fused in when available.
function brainContext(task, limit = 6) {
  return retrieveContextHybrid(task, { limit });
}

// selfRun: the brain's own internal call (e.g. the panel's explain button), not
// an agent the user summoned — run it in the self-run cwd with the
// BRAIN_DISTILLER marker so ingest never captures it as user work.
export async function runAgent({ role, tool, task, timeoutMs = 180000, injectMemory = true, selfRun = false }) {
  const r = ROLES[role] || ROLES.engineer;
  if (!task || !task.trim()) throw new Error('Empty task.');

  const ctx = injectMemory ? await brainContext(task) : { block: '', used: 0, learningFiles: [] };
  const memBlock = ctx.block ? `# Relevant memory from the operator's brain\n${ctx.block}\n\n` : '';
  const userMsg = `${memBlock}# Task\n${task}`;

  const c = CLIS[tool];
  if (!c) throw new Error(`Unknown tool: ${tool}`);
  if (!onPath(c.bin)) throw new Error(`${c.label} (${c.bin}) is not installed / not on PATH.`);
  const prompt = `${r.sys}\n\n${userMsg}`;
  const env = { ...process.env, PATH: childPath() };
  if (selfRun) env.BRAIN_DISTILLER = '1';
  let output = '';
  try {
    output = execFileSync(binPath(c.bin) || c.bin, c.args(prompt), {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env, stdio: ['ignore', 'pipe', 'pipe'],
      ...(selfRun ? { cwd: ensureSelfRunDir() } : {}),
    });
  } catch (e) {
    output = (e.stdout || '') + (e.stderr ? '\n[stderr] ' + e.stderr : '');
    if (!output) throw new Error(e.message);
  }
  const injected = ctx.learningFiles || [];
  if (injected.length) recordUsage(injected.map((l) => l.file));
  return { role: r.name, tool: c.label, injectedMemories: ctx.used, injectedLearnings: injected, output: output.trim() };
}
