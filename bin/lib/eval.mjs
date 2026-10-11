import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, MEMORY_DB } from './paths.mjs';
import { retrieveContextHybrid } from './agent.mjs';
import { openDb } from './db.mjs';
import { liveOnly } from './lifecycle.mjs';

const EVAL_DIR = join(REPO_ROOT, 'evals');
const QUESTIONS = join(EVAL_DIR, 'questions.jsonl');

export function loadQuestions() {
  if (!existsSync(QUESTIONS)) return [];
  // Tolerate blank/whitespace/CRLF lines and skip a malformed line rather than
  // crashing the whole run.
  return readFileSync(QUESTIONS, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
// provenance:false — the eval scores content retrieval; a path or tool name in the
// provenance tag must not be able to satisfy an `expect` substring.
const hit = (text, expect) => { const t = (text || '').toLowerCase(); return expect.every((e) => t.includes(e.toLowerCase())); };

// modes: baseline = obs FTS ONLY (all other sources off, incl. workflows — else workflow hits
// pollute the baseline). full = obs + wiki + learnings + workflows. `noWiki` forces wiki off in
// the full mode (for the deliberate-regression acceptance test). Obs retrieval is hybrid
// (BM25 + local embeddings, RRF) when embeddings are available; `bm25Only` forces keyword-only
// so the two can be compared on the same store. summary.retrieval says which one ran.
export async function runEval({ noWiki = false, bm25Only = false, log = () => {} } = {}) {
  const qs = loadQuestions();
  const rows = [];
  let hybrid = false;
  for (const q of qs) {
    const base = await retrieveContextHybrid(q.q, { bm25Only, obs: true, wiki: false, learnings: false, workflows: false, provenance: false });
    const full = await retrieveContextHybrid(q.q, { bm25Only, obs: true, wiki: !noWiki, learnings: true, workflows: true, provenance: false });
    hybrid = hybrid || base.hybrid;
    rows.push({ ...q, base: hit(base.block, q.expect), full: hit(full.block, q.expect) });
  }
  const n = rows.length || 1;
  const baseHits = rows.filter((r) => r.base).length;
  const fullHits = rows.filter((r) => r.full).length;
  const summary = { total: rows.length, baseHits, fullHits,
    basePct: Math.round((baseHits / n) * 100), fullPct: Math.round((fullHits / n) * 100), noWiki,
    retrieval: hybrid ? 'hybrid' : 'bm25' };
  return { summary, rows };
}

// Answerability: a question only measures retrieval if some live memory, rendered
// the way the eval sees it (retrieveContext's "[project] title: first 240 chars of
// narrative||facts"), holds every `expect` substring — otherwise no retriever could
// ever score it and the miss would be blamed on search. Read-only. Returns the
// questions no row can answer ([] = all verifiable), each with its closest row
// count per term so a typo is easy to spot.
export function verifyQuestions({ dbPath = MEMORY_DB, questions = loadQuestions() } = {}) {
  const db = openDb(dbPath, { readonly: true });
  try {
    const shown = `lower('[' || COALESCE(o.project,'') || '] ' || COALESCE(o.title,'') || ': ' ||
      substr(COALESCE(NULLIF(o.narrative,''), NULLIF(o.facts,''), ''), 1, 240))`;
    const live = liveOnly(db);
    const bad = [];
    for (const q of questions) {
      const terms = (q.expect || []).map((e) => String(e).toLowerCase()).filter(Boolean);
      if (!terms.length) { bad.push({ id: q.id, reason: 'no expect terms' }); continue; }
      const n = db.prepare(`SELECT COUNT(*) n FROM observations o WHERE ${terms.map(() => `instr(${shown}, ?) > 0`).join(' AND ')}${live}`)
        .get(...terms).n;
      if (n) continue;
      const perTerm = Object.fromEntries(terms.map((t) => [t,
        db.prepare(`SELECT COUNT(*) n FROM observations o WHERE instr(${shown}, ?) > 0${live}`).get(t).n]));
      bad.push({ id: q.id, reason: 'no memory shows every expect term', perTerm });
    }
    return bad;
  } finally {
    db.close();
  }
}

// Writes evals/report-<isoDate>.md + evals/.last.json (for the UI). isoDate passed in (no Date in some ctxs).
export function writeReport({ summary, rows }, isoNow, { log = () => {} } = {}) {
  mkdirSync(EVAL_DIR, { recursive: true });
  const date = isoNow.slice(0, 10);
  const L = [];
  L.push('# Brain eval — ' + date);
  L.push('');
  L.push(`Full brain: **${summary.fullPct}%** (${summary.fullHits}/${summary.total}) · ` +
         `raw-obs baseline: ${summary.basePct}% (${summary.baseHits}/${summary.total})` +
         (summary.noWiki ? ' · _wiki DISABLED (regression run)_' : '') +
         ` · retrieval: ${summary.retrieval || 'bm25'}`);
  L.push('');
  L.push('| # | question | baseline | full |');
  L.push('| --- | --- | :---: | :---: |');
  for (const r of rows) L.push(`| ${r.id} | ${r.q.replace(/\|/g, '\\|')} | ${r.base ? '✓' : '·'} | ${r.full ? '✓' : '·'} |`);
  L.push('');
  writeFileSync(join(EVAL_DIR, `report-${date}.md`), L.join('\n') + '\n');
  writeFileSync(join(EVAL_DIR, '.last.json'), JSON.stringify({ date: isoNow, ...summary }, null, 2) + '\n');
  return { report: `evals/report-${date}.md`, ...summary };
}

export function lastEval() {
  const p = join(EVAL_DIR, '.last.json');
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
