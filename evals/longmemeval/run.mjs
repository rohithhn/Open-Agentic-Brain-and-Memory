#!/usr/bin/env node
// LongMemEval-S retrieval benchmark — method, dataset version and numbers in RESULTS.md.
//
//   node evals/longmemeval/run.mjs                 # full set (470 non-abstention questions)
//   node evals/longmemeval/run.mjs --stride 5      # deterministic subset: every 5th question by id
//   node evals/longmemeval/run.mjs --limit 20 --bm25-only
//
// Options: --data <json> · --stride N · --limit N · --granularity round,session
//          --bm25-only (skip embeddings) · --out <results.json> · --no-check
//
// Everything lives under evals/longmemeval/data/ (gitignored): the dataset
// (downloaded once from Hugging Face at a pinned revision, sha256-checked),
// the embedding model (BRAIN_MODEL_DIR defaults here, never ~/.claude-brain)
// and a text-hash → vector cache so a re-run embeds nothing twice. Stores are
// temp files, one per question, deleted as it goes. The real brain is never
// opened. Progress goes to stderr; the summary is written to --out.
import '../test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, renameSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
process.env.BRAIN_MODEL_DIR ||= join(DATA, 'models');
process.env.BRAIN_NO_ECONOMICS = '1'; // recallSearch() in --check must not write a tokens-saved ledger

const { unitsFor, unitEmbedText, vecKey, buildStore, rankUnits, scoreRanking, aggregate, selectQuestions, KS } = await import('./lib.mjs');
const { getEmbedder, quantize, embedModel } = await import('../../bin/lib/embed.mjs');
const { recallSearch } = await import('../../bin/lib/recall.mjs');

// Pinned: longmemeval-cleaned (the maintainers' Sept 2025 replacement for the
// original release, with noisy history sessions removed).
export const DATASET = {
  repo: 'xiaowu0162/longmemeval-cleaned',
  revision: '98d7416c24c778c2fee6e6f3006e7a073259d48f',
  file: 'longmemeval_s_cleaned.json',
  sha256: 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442',
};
const DATASET_URL = `https://huggingface.co/datasets/${DATASET.repo}/resolve/${DATASET.revision}/${DATASET.file}`;

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(name);
const log = (...a) => console.error('[lme]', ...a);

async function ensureDataset(path) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    log(`downloading ${DATASET_URL}`);
    const res = await fetch(DATASET_URL);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    // Stream to a .part file (pipeline surfaces write errors and backpressure),
    // then rename, so an interrupted download never looks like the dataset.
    const tmp = path + '.part';
    try {
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new Error(`download failed: ${e.message}`);
    }
    renameSync(tmp, path);
  }
  const buf = readFileSync(path);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (path.endsWith(DATASET.file) && sha !== DATASET.sha256) throw new Error(`${path}: sha256 ${sha} is not the pinned ${DATASET.sha256}`);
  return { data: JSON.parse(buf.toString('utf8')), sha };
}

// ── embedding cache (resumable: every batch commits) ────────────────────────
function openCache() {
  mkdirSync(DATA, { recursive: true });
  const db = new DatabaseSync(join(DATA, 'embed-cache.db'));
  db.exec('CREATE TABLE IF NOT EXISTS vec (h TEXT PRIMARY KEY, v BLOB NOT NULL)');
  return db;
}

async function fillCache(cache, texts) {
  const have = cache.prepare('SELECT 1 FROM vec WHERE h = ?');
  const todo = [];
  const seen = new Set();
  for (const t of texts) {
    const h = vecKey(t);
    if (seen.has(h)) continue;
    seen.add(h);
    if (!have.get(h)) todo.push({ h, t });
  }
  log(`embeddings: ${seen.size} unique texts, ${todo.length} to embed (model ${embedModel()})`);
  if (!todo.length) return;
  const embed = await getEmbedder({ allowRemote: true });
  if (!embed) throw new Error('embedding model unavailable (npm install @huggingface/transformers)');
  // Same batching as `brain embed --apply`: length-sorted, 8 at a time.
  todo.sort((a, b) => a.t.length - b.t.length);
  const put = cache.prepare('INSERT OR REPLACE INTO vec (h, v) VALUES (?, ?)');
  const t0 = Date.now();
  for (let i = 0; i < todo.length; i += 8) {
    const chunk = todo.slice(i, i + 8);
    const vecs = await embed(chunk.map((c) => c.t));
    cache.exec('BEGIN');
    chunk.forEach((c, j) => put.run(c.h, quantize(vecs[j])));
    cache.exec('COMMIT');
    const done = i + chunk.length;
    if (done % 2000 < 8 || done === todo.length) {
      const rate = done / ((Date.now() - t0) / 1000 || 1);
      log(`  embedded ${done}/${todo.length} (${rate.toFixed(1)}/s, ~${Math.round((todo.length - done) / rate / 60)} min left)`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const dataPath = arg('--data', join(DATA, DATASET.file));
  const stride = Number(arg('--stride', 1));
  const limit = Number(arg('--limit', Infinity));
  const grans = String(arg('--granularity', 'round,session')).split(',').filter(Boolean);
  const bm25Only = flag('--bm25-only');
  const outPath = arg('--out', join(HERE, 'results.json'));
  const modes = bm25Only ? ['bm25'] : ['bm25', 'hybrid'];
  const queries = ['recall', 'context'];

  const { data, sha } = await ensureDataset(dataPath);
  const qs = selectQuestions(data, { stride, limit });
  log(`${data.length} questions in file, ${qs.length} selected (stride ${stride}${Number.isFinite(limit) ? `, limit ${limit}` : ''}, abstention excluded)`);

  const cache = bm25Only ? null : openCache();
  if (cache) {
    const texts = [];
    for (const q of qs) for (const g of grans) for (const u of unitsFor(q, g)) texts.push(unitEmbedText(u));
    await fillCache(cache, texts);
  }
  const getVec = cache?.prepare('SELECT v FROM vec WHERE h = ?');
  const vecOf = cache ? (u) => { const r = getVec.get(vecKey(unitEmbedText(u))); return r ? new Int8Array(r.v.buffer, r.v.byteOffset, r.v.byteLength) : null; } : null;

  const work = mkdtempSync(join(tmpdir(), 'lme-'));
  const perQ = []; // { id, type, gran, query, mode, metrics }
  const check = { compared: 0, identical: 0 };
  const t0 = Date.now();
  try {
    for (const [n, q] of qs.entries()) {
      for (const g of grans) {
        const units = unitsFor(q, g);
        const dbPath = join(work, `${q.question_id}-${g}.db`);
        const byRow = buildStore(dbPath, units, { vecOf });
        const unitEvidence = g === 'round' && units.some((u) => u.hasAnswer);
        for (const query of queries) for (const mode of modes) {
          const { units: ranked } = await rankUnits({ dbPath, byRow, question: q.question, query, mode });
          perQ.push({ id: q.question_id, type: q.question_type, gran: g, query, mode,
            metrics: scoreRanking(ranked, { answerSessions: q.answer_session_ids, unitEvidence }) });
          // Faithfulness check: our top 20 must be brain_recall's top 20.
          if (query === 'recall' && !flag('--no-check') && n < 5) {
            const prev = process.env.BRAIN_EMBED;
            if (mode === 'bm25') process.env.BRAIN_EMBED = '0';
            const r = await recallSearch({ query: q.question, limit: 20, dbPath });
            if (prev === undefined) delete process.env.BRAIN_EMBED; else process.env.BRAIN_EMBED = prev;
            const theirs = r.results.map((x) => byRow.get(x.id)?.id).join('|');
            check.compared++;
            if (theirs === ranked.slice(0, 20).map((u) => u.id).join('|')) check.identical++;
            else log(`  CHECK MISMATCH ${q.question_id} ${g} ${mode}`);
          }
        }
        rmSync(dbPath, { force: true });
        for (const ext of ['-wal', '-shm']) rmSync(dbPath + ext, { force: true });
      }
      if ((n + 1) % 25 === 0 || n + 1 === qs.length) log(`  ${n + 1}/${qs.length} questions (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // Aggregate: overall and by question type, per (granularity, query, mode).
  const results = {};
  for (const g of grans) for (const query of queries) for (const mode of modes) {
    const rows = perQ.filter((r) => r.gran === g && r.query === query && r.mode === mode);
    const byType = {};
    for (const t of [...new Set(rows.map((r) => r.type))].sort()) {
      const tr = rows.filter((r) => r.type === t);
      byType[t] = { n: tr.length, ...aggregate(tr.map((r) => r.metrics)) };
    }
    results[`${g}/${query}/${mode}`] = { n: rows.length, overall: aggregate(rows.map((r) => r.metrics)), byType };
  }
  const summary = {
    dataset: { ...DATASET, sha256: sha, questionsInFile: data.length },
    selection: { stride, limit: Number.isFinite(limit) ? limit : null, abstentionExcluded: true, questions: qs.length },
    config: { model: bm25Only ? null : embedModel(), ks: KS, granularities: grans, queries, modes },
    faithfulnessCheck: check,
    seconds: Math.round((Date.now() - t0) / 1000),
    results,
  };
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(DATA, 'per-question.jsonl'), perQ.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // A compact table on stdout.
  for (const [key, r] of Object.entries(results)) {
    const o = r.overall;
    console.log(`${key.padEnd(24)} n=${r.n}  any@1 ${o['recall_any@1']}  any@5 ${o['recall_any@5']}  any@10 ${o['recall_any@10']}  all@5 ${o['recall_all@5']}  all@10 ${o['recall_all@10']}  ndcg@10 ${o['ndcg_any@10']}`);
  }
  console.log(`check: ${check.identical}/${check.compared} identical to recallSearch() top-20 · ${summary.seconds}s → ${outPath}`);
  cache?.close();
  if (check.compared && check.identical !== check.compared) process.exitCode = 1;
}

main().catch((e) => { console.error('[lme] failed:', e.message); process.exit(1); });
