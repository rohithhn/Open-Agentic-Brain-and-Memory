#!/usr/bin/env node
// Open Agentic Brain and Memory systems benchmark — latency, scale, cold start, footprint and
// token economics, measured on synthetic stores. See evals/perf/README.md.
//
//   node evals/perf/bench.mjs            full run (1k, 10k, 50k, 100k)  ~ a few minutes
//   node evals/perf/bench.mjs --quick    1k and 10k only
//   node evals/perf/bench.mjs --sizes=1000,5000   custom sizes
//   node evals/perf/bench.mjs --out=path/to/results.json
//
// SAFETY: BRAIN_TEST=1 (test-env.mjs, first import). Every store, and the HOME
// every child process sees, lives in an fs.mkdtemp dir that is removed at the
// end (also on SIGINT/SIGTERM and on a crash). Nothing under the operator's
// real ~/.claude-brain, ~/.claude*, ~/.codex, ~/.cursor or ~/.gemini is opened.
// The parent never imports bin/lib; each measurement runs in a child process
// (`--worker=<kind>`) whose HOME is the temp dir, so paths.mjs resolves the
// synthetic store — which is also the only way to time brain_context
// (retrieveContext reads the module-level MEMORY_DB, it has no path override).
import '../test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, platform, release, arch, cpus, totalmem } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SELF = fileURLToPath(import.meta.url);
const MODEL_DIR_DEFAULT = join(REPO, 'evals', 'longmemeval', 'data', 'models');
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;
const N_QUERIES = 200;
const PLANTED_QUERIES = 40; // queries that get planted semantic neighbours (see README)

// ═══════════════════════════ deterministic synthetic data ═════════════════════
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 20260101;

const PROJECTS = ['atlas-api', 'billing-service', 'checkout-web', 'data-pipeline', 'design-system', 'edge-gateway', 'feature-flags',
  'graph-engine', 'hermes-mobile', 'identity-provider', 'job-scheduler', 'kb-search', 'ledger-core', 'media-encoder', 'notify-hub',
  'orbit-dashboard', 'payments-sdk', 'queue-worker', 'recon-batch', 'search-indexer', 'telemetry-agent', 'upload-service',
  'vault-secrets', 'web-marketing', 'xform-etl', 'yield-optimizer', 'zone-router', 'general', 'infra-terraform', 'ml-ranker'];
const TYPES = ['discovery', 'change', 'feature', 'bugfix', 'refactor', 'decision', 'preference', 'conversation', 'insight'];
const VERBS = ['fixed', 'added', 'removed', 'refactored', 'investigated', 'documented', 'optimized', 'migrated', 'validated', 'reverted',
  'wired', 'renamed', 'extracted', 'benchmarked', 'hardened', 'deprecated', 'enabled', 'disabled', 'cached', 'batched'];
const NOUNS = ['retry logic', 'connection pool', 'rate limiter', 'cache layer', 'schema migration', 'webhook handler', 'auth middleware',
  'config loader', 'queue consumer', 'index builder', 'session store', 'feature flag', 'error boundary', 'health check', 'metrics exporter',
  'pagination cursor', 'upload pipeline', 'token refresh', 'search ranker', 'batch scheduler', 'cron trigger', 'log formatter',
  'permission check', 'retry budget', 'circuit breaker', 'dead letter queue', 'backfill job', 'snapshot writer', 'lock manager', 'event bus'];
const TECH = ['postgres', 'redis', 'sqlite', 'kafka', 'docker', 'kubernetes', 'terraform', 'react', 'typescript', 'node', 'python', 'rust',
  'golang', 'nginx', 'graphql', 'grpc', 'oauth', 'jwt', 'cloudflare', 'prometheus', 'grafana', 'elasticsearch', 'rabbitmq', 'webpack',
  'vite', 'eslint', 'jest', 'playwright', 'ffmpeg', 'protobuf'];
const PROBLEMS = ['timeout', 'deadlock', 'memory leak', 'race condition', 'null pointer', 'off-by-one', 'stale cache', 'flaky test',
  'slow query', 'duplicate event', 'dropped message', 'clock skew', 'unicode bug', 'rounding error', 'cold start', 'thundering herd',
  'cors failure', 'oom kill', 'tls handshake failure', 'schema drift'];
const OUTCOMES = ['latency dropped noticeably', 'the failure no longer reproduces', 'throughput doubled on the benchmark',
  'tests now pass on CI', 'rollback is a one-line revert', 'the on-call load went away', 'memory stays flat under load',
  'behaviour matches the spec', 'the migration is idempotent', 'no data was lost during the cutover'];
const FILLER = ['we', 'then', 'because', 'after', 'while', 'so', 'which', 'since', 'before', 'once', 'also', 'still', 'only', 'again',
  'instead', 'mostly', 'carefully', 'quickly', 'later', 'first'];
const ID_PRE = ['parse', 'load', 'build', 'flush', 'sync', 'merge', 'split', 'fetch', 'emit', 'drain', 'probe', 'seed', 'warm', 'scan', 'route',
  'bind', 'lease', 'shard', 'index', 'encode', 'decode', 'verify', 'rotate', 'resolve', 'compact', 'replay', 'snapshot', 'throttle', 'hydrate', 'prune'];
const ID_SUF = ['Config', 'Cache', 'Batch', 'Token', 'Queue', 'Index', 'Frame', 'Stream', 'Handler', 'Policy', 'Cursor', 'Payload', 'Registry',
  'Session', 'Bucket', 'Window', 'Manifest', 'Channel', 'Worker', 'Segment', 'Ledger', 'Gateway', 'Snapshot', 'Resolver', 'Planner', 'Router',
  'Decoder', 'Encoder', 'Scheduler', 'Tracker'];
const EXT = ['ts', 'tsx', 'mjs', 'py', 'rs', 'go', 'sql', 'yaml', 'md', 'json'];
const DIRS = ['src', 'lib', 'server', 'api', 'core', 'utils', 'services', 'components', 'tests', 'scripts', 'infra', 'workers'];

const zipf = (rnd, arr) => arr[Math.floor(arr.length * rnd() * rnd())]; // head-heavy pick
const uni = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const ident = (rnd) => `${zipf(rnd, ID_PRE)}${zipf(rnd, ID_SUF)}`;
const errcode = (rnd) => `E${1000 + Math.floor(rnd() * 4000)}`;
const filePath = (rnd) => `${uni(rnd, DIRS)}/${zipf(rnd, ID_SUF).toLowerCase()}_${uni(rnd, ID_PRE)}.${uni(rnd, EXT)}`;

function sentence(rnd) {
  switch (Math.floor(rnd() * 8)) {
    case 0: return `${cap(zipf(rnd, VERBS))} the ${zipf(rnd, NOUNS)} in ${ident(rnd)} after a ${zipf(rnd, PROBLEMS)} showed up under ${zipf(rnd, TECH)}.`;
    case 1: return `The ${zipf(rnd, PROBLEMS)} came from ${ident(rnd)} calling ${zipf(rnd, NOUNS)} twice, and ${uni(rnd, FILLER)} ${zipf(rnd, VERBS)} it.`;
    case 2: return `Root cause was a ${zipf(rnd, PROBLEMS)} between ${zipf(rnd, NOUNS)} and ${zipf(rnd, NOUNS)} (${errcode(rnd)}).`;
    case 3: return `${cap(uni(rnd, FILLER))} ${zipf(rnd, VERBS)} ${ident(rnd)} so that ${uni(rnd, OUTCOMES)}.`;
    case 4: return `Decision: keep ${zipf(rnd, TECH)} for the ${zipf(rnd, NOUNS)} instead of ${zipf(rnd, TECH)}; ${uni(rnd, OUTCOMES)}.`;
    case 5: return `Touched ${filePath(rnd)} and ${filePath(rnd)}; ${uni(rnd, OUTCOMES)}.`;
    case 6: return `Benchmarked ${zipf(rnd, NOUNS)} with ${zipf(rnd, TECH)}: p95 went from ${50 + Math.floor(rnd() * 900)}ms to ${5 + Math.floor(rnd() * 90)}ms.`;
    default: return `Preference: always run ${zipf(rnd, TECH)} ${zipf(rnd, NOUNS)} checks before ${zipf(rnd, VERBS)} ${ident(rnd)}; ${errcode(rnd)} otherwise.`;
  }
}
function cap(s) { return s[0].toUpperCase() + s.slice(1); }

const EPOCH_END = Date.UTC(2026, 8, 1);
const EPOCH_SPAN = 540 * 86400000; // ~18 months

/** Observation #i of the synthetic corpus — a pure function of (SEED, i). */
export function synthObservation(i) {
  const rnd = mulberry32(SEED ^ Math.imul(i + 1, 2654435761));
  const project = zipf(rnd, PROJECTS);
  const type = zipf(rnd, TYPES);
  const title = `${cap(zipf(rnd, VERBS))} ${zipf(rnd, NOUNS)} in ${ident(rnd)} (${zipf(rnd, TECH)} ${zipf(rnd, PROBLEMS)})`;
  const nSent = 3 + Math.floor(rnd() * 4);
  const narrative = Array.from({ length: nSent }, () => sentence(rnd)).join(' ');
  const facts = JSON.stringify(Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => sentence(rnd)));
  const concepts = JSON.stringify([zipf(rnd, TECH), zipf(rnd, PROBLEMS), type]);
  const files = JSON.stringify(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => filePath(rnd)));
  const epoch = EPOCH_END - Math.floor(rnd() * EPOCH_SPAN);
  return {
    session: `bench-sess-${Math.floor(i / 8)}`, project, type, title, narrative, facts, concepts, files,
    created_at: new Date(epoch).toISOString(), epoch, hash: `h${i.toString(36)}`,
    discovery_tokens: 200 + Math.floor(rnd() * 8000),
  };
}

/** The 200 benchmark queries — deterministic, varied in shape and length (2..12 tokens). */
export function synthQueries(n = N_QUERIES) {
  const rnd = mulberry32(SEED ^ 0x9e3779b9);
  const out = [];
  for (let i = 0; i < n; i++) {
    switch (i % 8) {
      case 0: out.push(`how did we fix the ${zipf(rnd, PROBLEMS)} in ${zipf(rnd, NOUNS)}`); break;
      case 1: out.push(`${ident(rnd)} ${zipf(rnd, TECH)}`); break;
      case 2: out.push(`${errcode(rnd)} ${zipf(rnd, NOUNS)} ${zipf(rnd, PROBLEMS)}`); break;
      case 3: out.push(`what did we decide about ${zipf(rnd, TECH)} versus ${zipf(rnd, TECH)} for the ${zipf(rnd, NOUNS)}`); break;
      case 4: out.push(`${zipf(rnd, VERBS)} ${ident(rnd)} ${zipf(rnd, NOUNS)}`); break;
      case 5: out.push(`${filePath(rnd)} ${zipf(rnd, PROBLEMS)}`); break;
      case 6: out.push(`${zipf(rnd, NOUNS)}`); break;
      default: out.push(`working on ${zipf(rnd, NOUNS)} with ${zipf(rnd, TECH)}: ${zipf(rnd, PROBLEMS)} after ${zipf(rnd, VERBS)} ${ident(rnd)}, ${errcode(rnd)}`);
    }
  }
  return out;
}

function randomUnitInt8(rnd, dim = DIM) {
  const v = new Float64Array(dim);
  let n = 0;
  for (let j = 0; j < dim; j += 2) {
    const u = Math.max(rnd(), 1e-12), w = rnd(), r = Math.sqrt(-2 * Math.log(u));
    v[j] = r * Math.cos(2 * Math.PI * w); if (j + 1 < dim) v[j + 1] = r * Math.sin(2 * Math.PI * w);
  }
  for (let j = 0; j < dim; j++) n += v[j] * v[j];
  n = Math.sqrt(n);
  const q = new Int8Array(dim);
  for (let j = 0; j < dim; j++) q[j] = Math.max(-127, Math.min(127, Math.round((v[j] / n) * 127)));
  return q;
}
// A unit vector at a chosen cosine to a (unit, float) target: mix target with a random direction.
function neighbourOf(target, rnd, cosine) {
  const r = randomUnitInt8(rnd).map((x) => x / 127);
  const a = cosine, b = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  const q = new Int8Array(target.length);
  let n = 0;
  const f = new Float64Array(target.length);
  for (let j = 0; j < target.length; j++) { f[j] = a * target[j] + b * r[j]; n += f[j] * f[j]; }
  n = Math.sqrt(n);
  for (let j = 0; j < target.length; j++) q[j] = Math.max(-127, Math.min(127, Math.round((f[j] / n) * 127)));
  return q;
}

// ═══════════════════════════ stats helpers ════════════════════════════════════
const r2 = (x) => Math.round(x * 100) / 100;
function pct(sorted, p) { // nearest-rank
  if (!sorted.length) return null;
  const k = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[k];
}
function summarize(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { n: s.length, p50: r2(pct(s, 50)), p95: r2(pct(s, 95)), p99: r2(pct(s, 99)), mean: r2(mean), min: r2(s[0]), max: r2(s[s.length - 1]) };
}
async function timed(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(i); out.push(performance.now() - t); }
  return out;
}
const mb = (bytes) => r2(bytes / 1048576);

// ═══════════════════════════ worker side (runs with HOME = temp) ═══════════════
function argOf(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

function assertSandboxed() {
  // Belt and braces: the store this process resolves must be under the temp HOME handed to it.
  const home = process.env.HOME || '';
  const ok = /brain-bench-/.test(home);
  if (!ok || !/brain-bench-/.test(home)) throw new Error(`refusing to run: HOME is not a bench temp dir (${home})`);
}

async function workerBuild() {
  assertSandboxed();
  const size = Number(argOf('size'));
  const withModel = argOf('model') === '1';
  const { openStore, markStoreReady } = await import('../../bin/lib/store.mjs');
  const { ensureVectorSchema } = await import('../../bin/lib/embed.mjs');
  const dbPath = join(process.env.HOME, '.claude-brain', 'brain.db');
  const db = openStore({ path: dbPath });
  const ins = db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, facts, narrative, concepts, files_modified,
      discovery_tokens, created_at, created_at_epoch, content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  let gen = 0, ins_ms = 0;
  const CH = 1000;
  for (let base = 0; base < size; base += CH) {
    const g0 = performance.now();
    const rows = [];
    for (let i = base; i < Math.min(size, base + CH); i++) rows.push(synthObservation(i));
    gen += performance.now() - g0;
    const t0 = performance.now();
    db.exec('BEGIN');
    for (const r of rows) ins.run(r.session, r.project, r.type, r.title, r.facts, r.narrative, r.concepts, r.files, r.discovery_tokens, r.created_at, r.epoch, r.hash);
    db.exec('COMMIT');
    ins_ms += performance.now() - t0;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const bytesNoVec = statSync(dbPath).size;
  const textBytes = db.prepare('SELECT SUM(COALESCE(length(title),0)+COALESCE(length(narrative),0)+COALESCE(length(facts),0)) AS b FROM observations').get().b;

  // vectors: random int8 unit vectors; with the model, a few queries get planted neighbours
  ensureVectorSchema(db);
  const rnd = mulberry32(SEED ^ 0xabcdef);
  const planted = new Map(); // obs_id -> Int8Array
  let plantedRows = 0, modelNote = null;
  if (withModel) {
    const { getEmbedder, quantize } = await import('../../bin/lib/embed.mjs');
    const embed = await getEmbedder();
    if (embed) {
      const qs = synthQueries().slice(0, PLANTED_QUERIES);
      const vecs = await embed(qs, { query: true });
      const per = Math.max(5, Math.min(50, Math.floor(size * 0.005)));
      qs.forEach((_, qi) => {
        for (let k = 0; k < per; k++) {
          const id = 1 + Math.floor(rnd() * size);
          planted.set(id, neighbourOf(vecs[qi], rnd, 0.42 + rnd() * 0.4));
        }
      });
      plantedRows = planted.size;
    } else modelNote = 'embedder unavailable; vectors are pure random';
  }
  const { embedModel } = await import('../../bin/lib/embed.mjs');
  const vins = db.prepare('INSERT INTO observation_vectors (obs_id, model, text_hash, dim, vec, embedded_at) VALUES (?,?,?,?,?,?)');
  const v0 = performance.now();
  const now = Date.now();
  for (let base = 1; base <= size; base += 5000) {
    db.exec('BEGIN');
    for (let id = base; id < Math.min(size + 1, base + 5000); id++) {
      const v = planted.get(id) || randomUnitInt8(rnd);
      vins.run(id, embedModel(), 'bench', DIM, new Uint8Array(v.buffer), now);
    }
    db.exec('COMMIT');
  }
  const vec_ms = performance.now() - v0;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const bytesWithVec = statSync(dbPath).size;
  markStoreReady(dbPath, 'perf bench synthetic store');
  return {
    size, db_bytes_text_fts: bytesNoVec, db_bytes_with_vectors: bytesWithVec,
    db_mb_text_fts: mb(bytesNoVec), db_mb_with_vectors: mb(bytesWithVec),
    bytes_per_obs_text_fts: Math.round(bytesNoVec / size), bytes_per_obs_with_vectors: Math.round(bytesWithVec / size),
    avg_text_chars_per_obs: Math.round(textBytes / size),
    ingest: { rows: size, insert_ms: r2(ins_ms), obs_per_s: Math.round(size / (ins_ms / 1000)), synth_gen_ms: r2(gen), note: 'batched 1000-row transactions, product schema incl. FTS5 triggers' },
    vectors: { rows: size, insert_ms: r2(vec_ms), vec_per_s: Math.round(size / (vec_ms / 1000)), planted_neighbour_rows: plantedRows, note: modelNote },
  };
}

async function workerQuery() {
  assertSandboxed();
  const mode = argOf('mode'); // bm25 | hybrid
  const size = Number(argOf('size'));
  const dbPath = join(process.env.HOME, '.claude-brain', 'brain.db');
  const imp0 = performance.now();
  const { recallSearch } = await import('../../bin/lib/recall.mjs');
  const { taskContext } = await import('../../bin/lib/recall.mjs');
  const { semanticSearch, embeddingsDisabled } = await import('../../bin/lib/embed.mjs');
  const { MEMORY_DB } = await import('../../bin/lib/paths.mjs');
  const import_ms = performance.now() - imp0;
  if (MEMORY_DB !== dbPath) throw new Error(`MEMORY_DB ${MEMORY_DB} != ${dbPath}`);
  if (mode === 'bm25' && !embeddingsDisabled()) throw new Error('bm25 mode needs BRAIN_EMBED=0');
  const Q = synthQueries();

  const cold0 = performance.now();
  const cold = await recallSearch({ query: Q[0], dbPath });
  const cold_ms = performance.now() - cold0;

  let hits = 0;
  const recall = await timed(Q.length, async (i) => { const r = await recallSearch({ query: Q[i], dbPath }); hits += r.count; });
  const context = await timed(Q.length, async (i) => { await taskContext({ task: Q[i], dbPath }); });
  const out = {
    mode, size, import_ms: r2(import_ms),
    cold_first_query_ms: r2(cold_ms), cold_first_query_results: cold.count,
    recall: summarize(recall), recall_avg_results: r2(hits / Q.length),
    context: summarize(context),
  };
  if (mode === 'hybrid') {
    let active = 0;
    const sem = await timed(Q.length, async (i) => { const s = await semanticSearch({ dbPath, query: Q[i] }); if (s && s.length) active++; });
    out.semantic_only = summarize(sem);
    out.queries_with_semantic_hits = active;
    out.note = 'semantic_only = query embed + int8 scan + top-50 selection (no BM25, no row fetch)';
  }
  out.rss_mb = mb(process.memoryUsage().rss);

  // token economics (every size; the report headlines 10k)
  const { openDb } = await import('../../bin/lib/db.mjs');
  const { retrieveContextHybrid } = await import('../../bin/lib/agent.mjs');
  const db = openDb(dbPath, { readonly: true });
  const dump = db.prepare(`SELECT COUNT(*) AS n, SUM(length(project)+length(COALESCE(title,''))+length(COALESCE(NULLIF(narrative,''),facts,''))+8) AS chars FROM observations`).get();
  db.close();
  const fullTokens = Math.ceil(dump.chars / 4);
  const obsOnly = [], full = [];
  const nq = 100;
  for (let i = 0; i < nq; i++) {
    const a = await retrieveContextHybrid(Q[i], { wiki: false, learnings: false, workflows: false });
    obsOnly.push(Math.ceil(a.block.length / 4));
    const b = await taskContext({ task: Q[i], dbPath });
    full.push(Math.ceil(b.block.length / 4));
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const tok = (a) => ({ mean: Math.round(avg(a)), p50: pct([...a].sort((x, y) => x - y), 50), p95: pct([...a].sort((x, y) => x - y), 95), max: Math.max(...a) });
  out.tokens = {
    queries: nq,
    full_dump_tokens: fullTokens, full_dump_chars: dump.chars,
    brain_context_obs_only: tok(obsOnly), brain_context_as_shipped: tok(full),
    reduction_pct_obs_only: r2((1 - avg(obsOnly) / fullTokens) * 100),
    reduction_pct_as_shipped: r2((1 - avg(full) / fullTokens) * 100),
    note: 'tokens = chars/4. full dump = every observation as "- [project] title: narrative" (no cap). obs_only = retrieveContext with wiki/learnings/workflows off; as_shipped = taskContext (also reads this repo\'s wiki/learnings/workflows, which are not synthetic).',
  };
  return out;
}

async function workerSession() {
  assertSandboxed();
  const dbPath = join(process.env.HOME, '.claude-brain', 'brain.db');
  const ss = await import('../../bin/lib/sessionstart.mjs');
  const project = argOf('project');
  const first0 = performance.now();
  const first = ss.sessionContext({ dbPath, project, record: false });
  const first_ms = performance.now() - first0;
  const per = [];
  const all = [];
  for (const p of PROJECTS) {
    const ms = [];
    let r;
    for (let k = 0; k < 7; k++) { const t = performance.now(); r = ss.sessionContext({ dbPath, project: p, record: false }); ms.push(performance.now() - t); }
    all.push(...ms);
    per.push({ project: p, total: r.total, rows: r.rows, tokens: r.tokens, bytes: r.bytes || 0, preview_chars: (r.preview || '').length, p50: r2(pct([...ms].sort((a, b) => a - b), 50)) });
  }
  const big = per.reduce((a, b) => (b.total > a.total ? b : a));
  const blocks = per.filter((p) => p.bytes);
  return {
    store_project_count: PROJECTS.length, first_call_ms: r2(first_ms), first_call_rows: first.rows,
    all_projects: summarize(all),
    largest_project: big,
    max_block_bytes: Math.max(...blocks.map((b) => b.bytes)), max_block_tokens: Math.max(...blocks.map((b) => b.tokens)),
    max_preview_chars: Math.max(...per.map((b) => b.preview_chars)),
    caps: { MAX_OUTPUT_BYTES: ss.MAX_OUTPUT_BYTES, DEFAULT_BUDGET_TOKENS: ss.DEFAULT_BUDGET_TOKENS, DEFAULT_MAX_ROWS: ss.DEFAULT_MAX_ROWS, PREVIEW_MAX_BYTES: ss.PREVIEW_MAX_BYTES },
    note: 'in-process render of the full hook payload (additionalContext block + terminal preview), record:false',
  };
}

async function workerEmbed() {
  assertSandboxed();
  const { getEmbedder, embedModel, modelDir } = await import('../../bin/lib/embed.mjs');
  const dir = modelDir();
  if (!existsSync(join(dir, ...MODEL_ID.split('/')))) return { available: false, reason: `model not found at ${dir}/${MODEL_ID}` };
  const l0 = performance.now();
  const embed = await getEmbedder();
  const load_ms = performance.now() - l0;
  if (!embed) return { available: false, reason: '@huggingface/transformers not installed or model failed to load' };
  const Q = synthQueries();
  await embed([Q[0]], { query: true }); // first inference warms ONNX
  const one = await timed(100, async (i) => { await embed([Q[i % Q.length]], { query: true }); });
  const docs = Array.from({ length: 64 }, (_, i) => { const o = synthObservation(i); return `${o.title}. ${o.narrative}`.slice(0, 1200); });
  const d0 = performance.now();
  for (let i = 0; i < docs.length; i += 8) await embed(docs.slice(i, i + 8));
  const doc_ms = performance.now() - d0;
  return {
    available: true, model: embedModel(), dim: DIM, model_load_ms: r2(load_ms),
    query_encode_warm: summarize(one),
    doc_embed_obs_per_s: r2(docs.length / (doc_ms / 1000)),
    doc_embed_note: 'batch of 8, real ~500-char synthetic memories (what `brain embed --apply` does per row)',
    rss_mb: mb(process.memoryUsage().rss),
  };
}

async function workerSingleInsert() {
  assertSandboxed();
  const { openStore } = await import('../../bin/lib/store.mjs');
  const db = openStore({ path: join(process.env.HOME, '.claude-brain', 'single.db') });
  const ins = db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, facts, narrative, concepts, files_modified,
      discovery_tokens, created_at, created_at_epoch, content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const n = 1000;
  const ms = await timed(n, async (i) => { const r = synthObservation(i); ins.run(r.session, r.project, r.type, r.title, r.facts, r.narrative, r.concepts, r.files, r.discovery_tokens, r.created_at, r.epoch, r.hash); });
  db.close();
  const total = ms.reduce((a, b) => a + b, 0);
  return { rows: n, obs_per_s: Math.round(n / (total / 1000)), per_insert: summarize(ms), note: 'one autocommit transaction per row (WAL), as a capture hook would write' };
}

if (argOf('worker')) {
  const kind = argOf('worker');
  const fns = { build: workerBuild, query: workerQuery, session: workerSession, embed: workerEmbed, single: workerSingleInsert };
  try {
    const out = await fns[kind]();
    process.stdout.write(`\n@@RESULT@@${JSON.stringify(out)}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`worker ${kind} failed: ${e.stack || e}\n`);
    process.exit(1);
  }
}

// ═══════════════════════════ parent / orchestrator ════════════════════════════
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const sizesArg = args.find((a) => a.startsWith('--sizes='));
const SIZES = sizesArg ? sizesArg.slice(8).split(',').map(Number).filter(Boolean) : QUICK ? [1000, 10000] : [1000, 10000, 50000, 100000];
const OUT = (args.find((a) => a.startsWith('--out=')) || '').slice(6) || join(HERE, 'results.json');
const MODEL_DIR = process.env.BRAIN_MODEL_DIR || MODEL_DIR_DEFAULT;
const MODEL_PRESENT = existsSync(join(MODEL_DIR, ...MODEL_ID.split('/'), 'onnx')) || existsSync(join(MODEL_DIR, ...MODEL_ID.split('/')));
const SESSION_SIZE = SIZES.includes(10000) ? 10000 : SIZES[SIZES.length - 1];

const ROOT = mkdtempSync(join(tmpdir(), 'brain-bench-'));
let cleaned = false;
function cleanup() { if (cleaned) return; cleaned = true; try { rmSync(ROOT, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });

function childEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('BRAIN_') && k !== 'BRAIN_TEST') delete env[k];
  for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) delete env[k];
  return { ...env, HOME: home, USERPROFILE: home, BRAIN_TEST: '1', BRAIN_MODEL_DIR: MODEL_DIR, ...extra };
}
function freshHome(label) {
  const h = mkdtempSync(join(ROOT, `${label}-`));
  const home = join(h, 'brain-bench-home'); // name carries the marker assertSandboxed() checks
  mkdirSync(home, { recursive: true });
  return home;
}
function runWorker(kind, home, workerArgs = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [SELF, `--worker=${kind}`, ...workerArgs], {
    env: childEnv(home, extraEnv), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 25 * 60 * 1000,
  });
  const m = (r.stdout || '').split('@@RESULT@@')[1];
  if (r.status !== 0 || !m) throw new Error(`worker ${kind} ${workerArgs.join(' ')} failed (status ${r.status}): ${(r.stderr || '').slice(-1500)}`);
  return JSON.parse(m);
}

// ── MCP server over stdio ──
function mcpSession(home, { calls = [] } = {}) {
  return new Promise((resolveP, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [join(REPO, 'bin', 'mcp-server.mjs')], { env: childEnv(home), stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', nextId = 1;
    const pending = new Map();
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve({ msg, at: performance.now() }); }
      }
    });
    child.on('error', reject);
    const send = (method, params, wantReply = true) => {
      const id = wantReply ? nextId++ : undefined;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...(wantReply ? { id } : {}), method, ...(params ? { params } : {}) })}\n`);
      if (!wantReply) return null;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res });
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`mcp ${method} timed out`)); } }, 60000);
      });
    };
    (async () => {
      try {
        const initP = send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'brain-perf-bench', version: '1' } });
        send('notifications/initialized', null, false);
        const listP = send('tools/list', {});
        const init = await initP, list = await listP;
        const res = {
          initialize_ms: r2(init.at - t0), tools_list_ms: r2(list.at - t0),
          tools: list.msg.result.tools.length, tool_names: list.msg.result.tools.map((t) => t.name),
        };
        const callTimes = [];
        for (const c of calls) {
          const s = performance.now();
          const rr = await send('tools/call', { name: c.name, arguments: c.arguments });
          callTimes.push({ name: c.name, ms: performance.now() - s, isError: !!rr.msg.result?.isError, bytes: JSON.stringify(rr.msg.result).length });
        }
        res.calls = callTimes;
        child.stdin.end();
        const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.on('exit', () => { clearTimeout(killer); resolveP(res); });
      } catch (e) { child.kill('SIGKILL'); reject(e); }
    })();
  });
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function countJsLines(dir) {
  let files = 0, lines = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|cjs|js)$/.test(e.name)) { files++; lines += readFileSync(p, 'utf8').split('\n').length - 1; }
    }
  };
  walk(dir);
  return { files, lines };
}
function dirBytes(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return n;
}
const log = (...a) => console.error(`[bench ${((performance.now() - T0) / 1000).toFixed(0)}s]`, ...a);
const T0 = performance.now();

const results = {
  generated_at: new Date().toISOString(), quick: QUICK, sizes: SIZES, seed: SEED,
  machine: {
    os: `${platform()} ${release()}`, arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length,
    ram_gb: r2(totalmem() / 1073741824), node: process.version,
  },
  method: {
    queries: N_QUERIES, percentile: 'nearest-rank over warm runs, in-process, wall-clock (performance.now)',
    vectors: `int8 unit vectors, dim ${DIM}; random (Box-Muller) for latency; ${PLANTED_QUERIES} queries get planted cosine 0.42-0.82 neighbours so the semantic/fusion path is exercised`,
    sandbox: 'every store and child HOME is a mkdtemp dir, removed at the end',
    caveat_cold: 'cold = first query in a fresh process; OS page cache is warm (file was just written), so true cold-disk numbers can be higher',
  },
  scale: [],
};

try {
  // embedder (store-independent)
  log('embedder');
  results.embedder = MODEL_PRESENT
    ? runWorker('embed', freshHome('embed'))
    : { available: false, reason: `model not found at ${MODEL_DIR}/${MODEL_ID}` };
  const hybridOk = !!results.embedder.available;
  results.model_dir_used = MODEL_PRESENT ? MODEL_DIR.replace(REPO + '/', '') : null;

  log('single-insert');
  results.ingest_single_txn = runWorker('single', freshHome('single'));

  let sessionHome = null, sessionProject = null;
  for (const size of SIZES) {
    log(`size ${size}: build`);
    const home = freshHome(`s${size}`);
    const build = runWorker('build', home, [`--size=${size}`, `--model=${hybridOk ? 1 : 0}`]);
    log(`size ${size}: bm25`);
    const bm25 = runWorker('query', home, [`--size=${size}`, '--mode=bm25'], { BRAIN_EMBED: '0' });
    let hybrid = null;
    if (hybridOk) { log(`size ${size}: hybrid`); hybrid = runWorker('query', home, [`--size=${size}`, '--mode=hybrid']); }
    const row = { size, store: build, bm25, hybrid: hybrid || { skipped: true, reason: results.embedder.reason } };
    if (size === SESSION_SIZE) { sessionHome = home; row.keep = true; }
    results.scale.push(row);
    if (size !== SESSION_SIZE) rmSync(dirname(home), { recursive: true, force: true });
  }

  // SessionStart + MCP on the session-size store
  if (sessionHome) {
    log('sessionstart');
    const ssw = runWorker('session', sessionHome, [`--project=${PROJECTS[0]}`]);
    // real hook process: node bin/lib/sessionstart.mjs --hook <dir> (node startup + imports + render)
    const projDir = join(sessionHome, 'work', ssw.largest_project.project);
    mkdirSync(projDir, { recursive: true });
    const cli = [];
    let cliBytes = 0, cliReason = null;
    for (let i = 0; i < 9; i++) {
      const t = performance.now();
      const r = spawnSync(process.execPath, [join(REPO, 'bin', 'lib', 'sessionstart.mjs'), '--hook', projDir], { env: childEnv(sessionHome, { CLAUDE_PROJECT_DIR: projDir }), encoding: 'utf8', cwd: projDir });
      cli.push(performance.now() - t);
      if (i === 0) { try { const j = JSON.parse(r.stdout); cliBytes = Buffer.byteLength(j.hookSpecificOutput.additionalContext, 'utf8'); } catch (e) { cliReason = `no hook output: ${(r.stderr || '').slice(0, 200)}`; } }
    }
    const bareStart = [];
    for (let i = 0; i < 9; i++) { const t = performance.now(); spawnSync(process.execPath, ['-e', '0'], { env: childEnv(sessionHome) }); bareStart.push(performance.now() - t); }
    results.sessionstart = {
      store_size: SESSION_SIZE, in_process: ssw,
      hook_process_wall_ms: { ...summarize(cli), runs: cli.length, first: r2(cli[0]), note: 'spawn `node bin/lib/sessionstart.mjs --hook` end to end, largest project; first run included in stats' },
      bare_node_startup_ms: { p50: r2(median(bareStart)) },
      hook_additionalContext_bytes: cliBytes, hook_reason: cliReason,
    };

    log('mcp');
    const coldHome = freshHome('mcpcold');
    const coldRuns = [];
    for (let i = 0; i < 7; i++) coldRuns.push(await mcpSession(coldHome));
    const qs = synthQueries();
    const e2eCalls = [];
    for (let i = 0; i < 60; i++) { e2eCalls.push({ name: 'brain_recall', arguments: { query: qs[i] } }); e2eCalls.push({ name: 'brain_context', arguments: { task: qs[i] } }); }
    const e2e = await mcpSession(sessionHome, { calls: e2eCalls });
    const sel = (n) => e2e.calls.filter((c) => c.name === n).map((c) => c.ms);
    results.mcp = {
      cold_start: {
        runs: coldRuns.length, empty_home: true,
        initialize_ms: { median: r2(median(coldRuns.map((r) => r.initialize_ms))), min: r2(Math.min(...coldRuns.map((r) => r.initialize_ms))), max: r2(Math.max(...coldRuns.map((r) => r.initialize_ms))) },
        tools_list_ms: { median: r2(median(coldRuns.map((r) => r.tools_list_ms))), min: r2(Math.min(...coldRuns.map((r) => r.tools_list_ms))), max: r2(Math.max(...coldRuns.map((r) => r.tools_list_ms))) },
        tools: coldRuns[0].tools, tool_names: coldRuns[0].tool_names,
        note: 'spawn -> first JSON-RPC response on stdout; includes node startup',
      },
      e2e_store_size: SESSION_SIZE,
      e2e_first_call: { name: e2e.calls[0].name, ms: r2(e2e.calls[0].ms), note: 'first call in a fresh server: loads model + vectors when the store has them (server answers BM25 past a 2.5 s budget)' },
      e2e_brain_recall_ms: summarize(sel('brain_recall')),
      e2e_brain_context_ms: summarize(sel('brain_context')),
      e2e_errors: e2e.calls.filter((c) => c.isError).length,
      e2e_avg_response_bytes: { brain_recall: Math.round(e2e.calls.filter((c) => c.name === 'brain_recall').reduce((a, c) => a + c.bytes, 0) / 60), brain_context: Math.round(e2e.calls.filter((c) => c.name === 'brain_context').reduce((a, c) => a + c.bytes, 0) / 60) },
      note: 'JSON-RPC over stdio on the synthetic store (hybrid when the model is present; vectors are synthetic so ranking quality is not measured)',
    };
    rmSync(dirname(sessionHome), { recursive: true, force: true });
  }

  // footprint
  log('footprint');
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const js = countJsLines(join(REPO, 'bin'));
  results.footprint = {
    runtime_dependencies: Object.keys(pkg.dependencies || {}).length,
    runtime_dependency_names: Object.keys(pkg.dependencies || {}),
    optional_dependencies: pkg.optionalDependencies || {},
    node_engine: pkg.engines?.node,
    bin_js_files: js.files, bin_js_lines: js.lines,
    model_on_disk_mb: MODEL_PRESENT ? mb(dirBytes(join(MODEL_DIR, ...MODEL_ID.split('/')))) : null,
    model_path: MODEL_PRESENT ? join(MODEL_DIR, ...MODEL_ID.split('/')).replace(REPO + '/', '') : null,
  };
} finally {
  cleanup();
}

writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
log(`wrote ${OUT}; temp dirs removed: ${!existsSync(ROOT)}`);

// compact table
const f = (x) => (x == null ? '-' : x);
console.log('\nsize     | store MB (B/obs) | ingest obs/s | recall p50/p95/p99 bm25 | recall p50/p95/p99 hybrid | context p50/p95 bm25 | context p50/p95 hybrid | cold bm25/hybrid ms');
for (const s of results.scale) {
  const b = s.bm25, h = s.hybrid;
  console.log(`${String(s.size).padEnd(8)} | ${s.store.db_mb_with_vectors} (${s.store.bytes_per_obs_with_vectors}) | ${s.store.ingest.obs_per_s} | ${b.recall.p50}/${b.recall.p95}/${b.recall.p99} | ${h.skipped ? '-' : `${h.recall.p50}/${h.recall.p95}/${h.recall.p99}`} | ${b.context.p50}/${b.context.p95} | ${h.skipped ? '-' : `${h.context.p50}/${h.context.p95}`} | ${b.cold_first_query_ms}/${f(h.cold_first_query_ms)}`);
}
