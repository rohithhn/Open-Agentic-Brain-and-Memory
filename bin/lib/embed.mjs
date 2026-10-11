// Local semantic search — bin/lib/embed.mjs
//
// Recall was keyword-only (FTS5/BM25): "how does it publish to LinkedIn" never
// finds a memory that says "posts via the UGC API". This module adds on-device
// embeddings, fused with BM25 by reciprocal rank fusion (RRF), so a memory can
// be found by meaning as well as by its words.
//
// Hard rules this module keeps:
//   - Nothing leaves the Mac at query time. The model is loaded with remote
//     downloads OFF; only `brain embed --apply` (an explicit command) may fetch
//     it, once, into MODEL_DIR.
//   - Optional. The embedding library (@huggingface/transformers) is an
//     optionalDependency; when it, the cached model or the vectors table is
//     missing, every caller silently gets BM25 exactly as before.
//   - Derived, local-only data. Vectors live in their own table
//     (observation_vectors) keyed by the local row id — like the lifecycle
//     columns they mean nothing on another machine, so the synced snapshot
//     strips them (stripVectors) and each Mac backfills its own.
//   - Never writes to stdout (the MCP server's stdout is its JSON-RPC channel).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, tableExists } from './db.mjs';

// all-MiniLM-L6-v2 (384-d, ~23 MB quantized): small, fast, good enough for
// short technical notes. bge-small is the drop-in alternative (needs a query
// prefix — see QUERY_PREFIX). Changing the model re-embeds everything.
export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const QUERY_PREFIX = {
  'Xenova/bge-small-en-v1.5': 'Represent this sentence for searching relevant passages: ',
};
export const RRF_K = 60;           // standard RRF constant: 1 / (k + rank)
export const CANDIDATES = 50;      // depth of each list that goes into the fusion
// Noise floor for semantic-only candidates. Nearest neighbours always exist,
// even for a nonsense query; below this cosine they are noise, not meaning.
export const MIN_SIM = 0.3;
export const MAX_EMBED_CHARS = 1200; // the model reads ~256 tokens anyway
const RETRY_AFTER_MS = 5 * 60 * 1000; // re-try a failed model load after this long

export const embedModel = () => process.env.BRAIN_EMBED_MODEL || DEFAULT_MODEL;
export const modelDir = () => process.env.BRAIN_MODEL_DIR || join(homedir(), '.claude-brain', 'models');
// BRAIN_EMBED=0 turns semantic search off everywhere (BM25 only).
export const embeddingsDisabled = () => process.env.BRAIN_EMBED === '0';

function warn(...args) {
  if (process.env.BRAIN_DEBUG) console.error('[embed]', ...args);
}

// ── the model ───────────────────────────────────────────────────────────────

let testEmbedder = null; // tests inject a deterministic embedder here
let testLoadMs = 0;      // …and can make its "model load" take this long
/**
 * Tests only: replace the model with fn(texts, {query}) → Float32Array[] (null
 * restores). `loadMs` > 0 simulates a slow cold model load: the first
 * getEmbedder() resolves after that long, later ones join the same load.
 */
export function setEmbedderForTest(fn, { loadMs = 0 } = {}) {
  testEmbedder = fn; testLoadMs = loadMs; loaders.clear(); loadsStarted = 0;
}

const loaders = new Map(); // `${model}|${remote}` → { at, ok, promise<embedFn|null> }
let loadsStarted = 0;      // model loads this process has begun (memory: each is ~200 MB RSS)

/** Model-load bookkeeping for this process: { loadsStarted, loaded }. */
export function embedderState({ model = embedModel() } = {}) {
  const e = loaders.get(`${model}|false`);
  return { loadsStarted, loaded: !!(e && e.ok) };
}

async function loadLibrary() {
  try { return await import('@huggingface/transformers'); } catch { return null; }
}

/**
 * The embedding function, or null when semantic search is unavailable
 * (library not installed, model not cached and remote off, BRAIN_EMBED=0).
 * allowRemote=false guarantees no network: the model must already be on disk.
 * Loads once per process; a failure is remembered for RETRY_AFTER_MS so a
 * missing model does not cost every query a load attempt.
 */
export function getEmbedder({ allowRemote = false, model = embedModel() } = {}) {
  if (embeddingsDisabled()) return Promise.resolve(null);
  if (testEmbedder && !testLoadMs) return Promise.resolve(testEmbedder);
  const key = `${model}|${allowRemote}`;
  const hit = loaders.get(key);
  if (hit && (hit.ok !== false || Date.now() - hit.at < RETRY_AFTER_MS)) return hit.promise;
  const entry = { at: Date.now(), ok: undefined, promise: null };
  loadsStarted++;
  entry.promise = (testEmbedder ? new Promise((r) => setTimeout(() => r(testEmbedder), testLoadMs)) : (async () => {
    const lib = await loadLibrary();
    if (!lib) { warn('library not installed'); return null; }
    try {
      lib.env.cacheDir = modelDir();
      lib.env.allowRemoteModels = !!allowRemote;
      lib.env.allowLocalModels = true;
      const pipe = await lib.pipeline('feature-extraction', model, { dtype: 'q8' });
      const prefix = QUERY_PREFIX[model] || '';
      return async (texts, { query = false } = {}) => {
        const input = query ? texts.map((t) => prefix + t) : texts;
        const out = await pipe(input, { pooling: 'mean', normalize: true });
        const dim = out.dims[out.dims.length - 1];
        return input.map((_, i) => out.data.slice(i * dim, (i + 1) * dim));
      };
    } catch (e) {
      warn('model load failed:', e.message);
      return null;
    }
  })()).then((fn) => { entry.ok = !!fn; return fn; });
  loaders.set(key, entry);
  return entry.promise;
}

// ── vectors ─────────────────────────────────────────────────────────────────

// Unit vectors stored as int8 (x * 127): 384 bytes a row instead of 1.5 KB.
// Measured against float32 on a 3.4k-row sample of the real store: the top-10
// for the eval questions shares 9.7 of 10 rows (near-ties may swap places),
// which is all a rank-fusion input needs.
export function quantize(vec) {
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] * 127)));
  return q;
}

/** The text a row is embedded from: its title and what it says, not the raw transcript. */
export function embedText(r) {
  return [r.title, r.subtitle, r.narrative || r.facts]
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join('. ').slice(0, MAX_EMBED_CHARS);
}
const textHash = (text, model) => createHash('sha1').update(model + '\0' + text).digest('hex').slice(0, 16);

export function hasVectors(db) {
  try { return tableExists(db, 'observation_vectors'); } catch { return false; }
}

export function ensureVectorSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS observation_vectors (
    obs_id INTEGER PRIMARY KEY,   -- observations.id (local; never synced)
    model TEXT NOT NULL,
    text_hash TEXT NOT NULL,      -- what was embedded; a changed row re-embeds
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,            -- int8, unit vector * 127
    embedded_at INTEGER NOT NULL
  )`);
}

// Rows that need a (re-)embed: never embedded, embedded by another model, or
// whose text changed since (scrub, edit). Computed from scratch each run, so a
// killed backfill resumes exactly where it stopped.
function pendingRows(db, model) {
  const have = new Map();
  if (hasVectors(db)) {
    for (const v of db.prepare('SELECT obs_id, model, text_hash FROM observation_vectors').all()) have.set(v.obs_id, v);
  }
  const pending = [];
  const seen = new Set();
  let embedded = 0;
  for (const r of db.prepare('SELECT id, title, subtitle, narrative, facts FROM observations ORDER BY id').all()) {
    seen.add(r.id);
    const text = embedText(r);
    if (!text) continue;
    const h = textHash(text, model);
    const v = have.get(r.id);
    if (v && v.model === model && v.text_hash === h) { embedded++; continue; }
    pending.push({ id: r.id, text, hash: h, stale: !!v });
  }
  // Vectors whose observation is gone (deleted/cleaned); dropped on --apply.
  const orphans = [...have.keys()].filter((id) => !seen.has(id)).length;
  return { pending, embedded, orphans };
}

/**
 * brain embed — status (default, read-only) or incremental backfill (--apply).
 * Each batch commits on its own, so an interrupted run loses at most one
 * batch and the next run picks up the rest. Only observation_vectors is ever
 * written; observations are read, never changed.
 */
export async function runEmbed({ dbPath, apply = false, clear = false, limit = Infinity, batch = 8, log = () => {} } = {}) {
  const model = embedModel();
  const out = { dbPath, model, modelDir: modelDir(), apply, clear, library: !!(testEmbedder || await loadLibrary()) };
  if (!dbPath || !existsSync(dbPath)) return { ...out, error: 'brain not initialized' };
  // BRAIN_EMBED=0: no model, no download, no writes — a scheduled job that
  // outlives the opt-out must do nothing rather than fail every wake-up.
  if (apply && !clear && embeddingsDisabled()) return { ...out, skipped: 'BRAIN_EMBED=0' };

  if (clear) {
    const db = openDb(dbPath, { readonly: !apply });
    try {
      out.vectors = hasVectors(db) ? db.prepare('SELECT COUNT(*) n FROM observation_vectors').get().n : 0;
      if (apply && hasVectors(db)) { db.exec('DROP TABLE observation_vectors'); out.cleared = out.vectors; }
    } finally { db.close(); }
    return out;
  }

  const db = openDb(dbPath, { readonly: !apply });
  try {
    const { pending, embedded, orphans } = pendingRows(db, model);
    Object.assign(out, { total: embedded + pending.length, embedded, pending: pending.length, stale: pending.filter((p) => p.stale).length, orphans });
    if (!apply) return out;

    const embed = await getEmbedder({ allowRemote: true, model });
    if (!embed) return { ...out, unavailable: out.library ? 'model' : 'library', error: out.library ? 'model could not be loaded' : 'embedding library not installed (npm install @huggingface/transformers)' };
    ensureVectorSchema(db);
    // Vectors of deleted observations: nothing reads them (every query joins
    // back to observations), but don't keep dead weight.
    db.exec('DELETE FROM observation_vectors WHERE obs_id NOT IN (SELECT id FROM observations)');
    const up = db.prepare(`INSERT OR REPLACE INTO observation_vectors (obs_id, model, text_hash, dim, vec, embedded_at) VALUES (?,?,?,?,?,?)`);
    // Similar lengths batch together: the model pads every text in a batch to
    // the longest one, so length-sorted batches do far less wasted work.
    // Small batches keep memory flat: at 64 the ONNX runtime peaked at ~5 GB
    // RSS on long rows, at 8 ~1 GB, at the same throughput (measured).
    const todo = pending.slice(0, limit).sort((a, b) => a.text.length - b.text.length);
    const t0 = Date.now();
    let done = 0;
    for (let i = 0; i < todo.length; i += batch) {
      const chunk = todo.slice(i, i + batch);
      const vecs = await embed(chunk.map((p) => p.text));
      db.exec('BEGIN');
      try {
        chunk.forEach((p, j) => { const q = quantize(vecs[j]); up.run(p.id, model, p.hash, q.length, q, Date.now()); });
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      done += chunk.length;
      if (done % 2000 < batch || done === todo.length) log(`  embedded ${done}/${todo.length} (${Math.round(done / ((Date.now() - t0) / 1000 || 1))}/s)`);
    }
    Object.assign(out, { written: done, ms: Date.now() - t0, embedded: embedded + done, pending: pending.length - done });
    vectorCache.delete(dbPath);
    return out;
  } finally {
    db.close();
  }
}

// ── search ──────────────────────────────────────────────────────────────────

// Brute-force cosine over every vector: at ~50k rows x 384 int8 this is tens
// of milliseconds, so no ANN index. The matrix is cached per DB for the life of
// the process (the MCP server is long-lived) and reloaded when it changes.
const vectorCache = new Map(); // dbPath → { sig, model, dim, ids, projects, mat }
const matrixLoads = new Map(); // dbPath → in-flight load, so concurrent queries share one
const MATRIX_CHUNK = 2000;     // rows per read; the loader yields to the event loop between reads

const matrixSig = (db, model) =>
  JSON.stringify(db.prepare('SELECT COUNT(*) n, MAX(embedded_at) m FROM observation_vectors WHERE model = ?').get(model));

// Read in chunks, yielding between them: one SELECT of every vector is a single
// synchronous block (~0.1 s idle, measured 2+ s with two dozen servers starting
// at once), and nothing else in the process — not a budget timer, not another
// request — can run during it. One read transaction keeps the chunks a
// consistent snapshot.
async function loadMatrix(dbPath, model) {
  const db = openDb(dbPath, { readonly: true });
  let open = false;
  try {
    db.exec('BEGIN'); open = true;
    const sig = matrixSig(db, model);
    const hit = vectorCache.get(dbPath);
    if (hit && hit.sig === sig && hit.model === model) return hit;
    const stmt = db.prepare(`SELECT v.obs_id, v.dim, v.vec, o.project FROM observation_vectors v
      JOIN observations o ON o.id = v.obs_id WHERE v.model = ? AND v.obs_id > ? ORDER BY v.obs_id LIMIT ?`);
    const rows = [];
    for (let after = -1; ;) {
      const chunk = stmt.all(model, after, MATRIX_CHUNK);
      for (const r of chunk) rows.push(r);
      if (chunk.length < MATRIX_CHUNK) break;
      after = chunk[chunk.length - 1].obs_id;
      await new Promise((r) => setImmediate(r));
    }
    const dim = rows[0]?.dim || 0;
    const ids = new Int32Array(rows.length);
    const projects = new Array(rows.length);
    const mat = new Int8Array(rows.length * dim);
    rows.forEach((r, i) => {
      ids[i] = r.obs_id; projects[i] = r.project;
      mat.set(new Int8Array(r.vec.buffer, r.vec.byteOffset, dim), i * dim);
    });
    const entry = { sig, model, dim, ids, projects, mat };
    vectorCache.set(dbPath, entry);
    return entry;
  } finally {
    if (open) try { db.exec('COMMIT'); } catch {}
    db.close();
  }
}

function matrixFor(dbPath, model) {
  const inflight = matrixLoads.get(dbPath);
  if (inflight) return inflight;
  const p = loadMatrix(dbPath, model).finally(() => matrixLoads.delete(dbPath));
  matrixLoads.set(dbPath, p);
  return p;
}

// ── cold start ──────────────────────────────────────────────────────────────
// A fresh process pays for the model (ONNX session from disk) and the vector
// matrix on its first semantic query: ~0.25 s on an idle Mac, measured past
// 10 s with two dozen servers starting at once on a throttled CPU (copy of
// the real store, 43.8k vectors — evals/longmemeval/RESULTS.md "Cold start").
// A long-lived caller with a deadline (the MCP server: 10 s per call) passes a
// budget: the query waits at most that long for model + matrix, then answers
// with BM25 alone while the load carries on in the background, so a later
// query is hybrid. One-shot callers (the CLI) pass no budget and simply wait.
// The budget cannot pre-empt synchronous work already running (creating the
// ONNX session is one block), so under heavy contention a query can overrun
// it by that much — still far inside the deadline.

const LATE = Symbol('late');
function within(promise, deadline) {
  if (deadline === Infinity) return promise;
  let timer;
  const late = new Promise((r) => { timer = setTimeout(() => r(LATE), Math.max(0, deadline - Date.now())); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Does this store hold vectors for the current model? The only case worth loading a model for. */
export function storeHasVectors(dbPath, model = embedModel()) {
  if (!dbPath || !existsSync(dbPath)) return false;
  let db;
  try {
    db = openDb(dbPath, { readonly: true });
    return hasVectors(db) && !!db.prepare('SELECT 1 FROM observation_vectors WHERE model = ? LIMIT 1').get(model);
  } catch { return false; } finally { try { db?.close(); } catch {} }
}

// Model first, then the matrix: a store whose model will not load never pays
// for reading its vectors. Both are cached, so a warm call costs one COUNT(*).
// Concurrent callers share one attempt, and `since` says when it began.
const readying = new Map(); // `${dbPath}|${model}` → { since, promise<{ embed, m }> }
function searchReady(dbPath, model) {
  const key = `${dbPath}|${model}`;
  const inflight = readying.get(key);
  if (inflight) return inflight;
  const entry = { since: Date.now(), promise: null };
  entry.promise = (async () => {
    const embed = await getEmbedder({ model });
    if (!embed) return { embed: null, m: null };
    return { embed, m: await matrixFor(dbPath, model) };
  })().finally(() => readying.delete(key));
  readying.set(key, entry);
  return entry;
}

/**
 * Start loading the model and the vector matrix in the background, so a later
 * semanticSearch() finds both ready. A no-op (resolves false) when semantic
 * search is off or this store has no vectors — a model costs ~200 MB of RSS,
 * never worth paying for a store it cannot search. Never throws.
 */
export async function warmSemantic({ dbPath } = {}) {
  if (embeddingsDisabled() || !storeHasVectors(dbPath)) return false;
  try {
    const { embed } = await searchReady(dbPath, embedModel()).promise;
    return !!embed;
  } catch (e) {
    warn('warm-up failed:', e.message);
    return false;
  }
}

/**
 * Nearest memories to `query` by meaning: [{ id, sim }] best first, or null
 * when semantic search is unavailable (the caller then uses BM25 alone).
 * `budgetMs` caps how long a cold start (model + matrix load) may hold this
 * query up (see "cold start" above); past it the result is null and the load
 * continues in the background. Never throws, never touches the network.
 */
export async function semanticSearch({ dbPath, query, project, k = CANDIDATES, minSim = MIN_SIM, budgetMs = Infinity } = {}) {
  if (embeddingsDisabled() || !dbPath || !existsSync(dbPath) || !String(query || '').trim()) return null;
  const t0 = Date.now();
  const model = embedModel();
  try {
    if (!storeHasVectors(dbPath, model)) return null;
    const ready = searchReady(dbPath, model);
    // The budget is per cold start, not per query: a query that arrives while
    // a load has already outlasted it answers with BM25 at once.
    const deadline = Number.isFinite(budgetMs) && budgetMs >= 0 ? Math.min(t0, ready.since) + budgetMs : Infinity;
    const got = await within(ready.promise, deadline);
    if (got === LATE) { warn(`model/vectors still loading after ${Date.now() - t0} ms (budget ${budgetMs}) — BM25 for this query`); return null; }
    const { embed, m } = got;
    if (!embed || !m.ids.length) return null;
    const res = await within(embed([String(query)], { query: true }), deadline);
    if (res === LATE) { warn(`query embedding still running after ${Date.now() - t0} ms (budget ${budgetMs}) — BM25 for this query`); return null; }
    const [qv] = res;
    if (!qv || qv.length !== m.dim) return null;
    const q = quantize(qv);
    const { dim, mat, ids, projects } = m;
    const scale = 127 * 127;
    const top = []; // small sorted insert — k is 50
    for (let r = 0, off = 0; r < ids.length; r++, off += dim) {
      if (project && projects[r] !== project) continue;
      let dot = 0;
      for (let j = 0; j < dim; j++) dot += q[j] * mat[off + j];
      const sim = dot / scale;
      if (sim < minSim || (top.length === k && sim <= top[k - 1].sim)) continue;
      let at = top.length;
      while (at > 0 && top[at - 1].sim < sim) at--;
      top.splice(at, 0, { id: ids[r], sim });
      if (top.length > k) top.pop();
    }
    return top;
  } catch (e) {
    warn('semantic search failed:', e.message);
    return null;
  }
}

/**
 * Reciprocal rank fusion of BM25 rows (in rank order, each with .id) and
 * semantic hits. Returns [{ id, rrf }] best first. A memory both lists agree
 * on outranks one that only a single list likes.
 */
export function rrfFuse(bm25Ids, semantic, { k = RRF_K } = {}) {
  const score = new Map();
  const add = (id, rank) => score.set(id, (score.get(id) || 0) + 1 / (k + rank + 1));
  bm25Ids.forEach((id, i) => add(id, i));
  (semantic || []).forEach((s, i) => add(s.id, i));
  return [...score.entries()].map(([id, rrf]) => ({ id, rrf })).sort((a, b) => b.rrf - a.rrf);
}

/**
 * Fuse BM25 rows with semantic hits into one ranked row list. `fetchRows(ids)`
 * loads rows (same columns as bm25Rows) for semantic-only hits. Each row's
 * `score` becomes -rrf, so lower = better like FTS5's rank and
 * rerankByLifecycle() keeps working on the result unchanged.
 */
export function fuseRows(bm25Rows, semantic, fetchRows, { depth = CANDIDATES } = {}) {
  if (!semantic || !semantic.length) return bm25Rows;
  const fused = rrfFuse(bm25Rows.map((r) => r.id), semantic).slice(0, depth);
  const byId = new Map(bm25Rows.map((r) => [r.id, r]));
  const missing = fused.map((f) => f.id).filter((id) => !byId.has(id));
  if (missing.length) for (const r of fetchRows(missing)) byId.set(r.id, r);
  return fused.filter((f) => byId.has(f.id)).map((f) => ({ ...byId.get(f.id), score: -f.rrf }));
}

// ── sync snapshot ───────────────────────────────────────────────────────────

/**
 * Drop the vectors from a DB snapshot before it is encrypted and pushed: they
 * are derived, machine-local (row ids differ per Mac) and would add ~17 MB of
 * incompressible bytes to every blob. Only ever called on the temp snapshot,
 * never on the live store.
 */
export function stripVectors(snapshotPath) {
  let db;
  try {
    db = openDb(snapshotPath);
    if (!hasVectors(db)) return false;
    db.exec('DROP TABLE observation_vectors');
    db.exec('VACUUM');
    return true;
  } finally {
    try { db?.close(); } catch {}
  }
}
