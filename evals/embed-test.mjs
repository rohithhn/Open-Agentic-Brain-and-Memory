#!/usr/bin/env node
// Tests for bin/lib/embed.mjs — local hybrid search (embeddings + BM25, RRF).
//
//   node evals/embed-test.mjs
//
// Everything runs on synthetic stores under the scratchpad/tmpdir with a tiny
// deterministic "concept" embedder injected via setEmbedderForTest(), so the
// suite needs neither the optional @huggingface/transformers library nor a
// model download. One test checks the real library's no-network guarantee and
// is skipped when the library isn't installed. The real brain.db is never
// opened.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Count every fetch this process makes (before anything can capture fetch):
// query-time semantic search must make none.
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { fetchCalls++; return realFetch(...a); };

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { openStore } = await import('../bin/lib/store.mjs');
const { openDb } = await import('../bin/lib/db.mjs');
const E = await import('../bin/lib/embed.mjs');
const { recallSearch } = await import('../bin/lib/recall.mjs');
const { runLifecycle } = await import('../bin/lib/lifecycle.mjs');

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
}

const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `embed-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
let seq = 0;

// ── toy embedder ─────────────────────────────────────────────────────────────
// Words in the same concept group share a dimension, so "car" and "automobile"
// are near-identical by meaning while sharing no letters BM25 could match.
const CONCEPTS = [
  ['car', 'cars', 'automobile', 'vehicle', 'sedan'],
  ['database', 'sqlite', 'storage', 'datastore'],
  ['deploy', 'release', 'ship', 'rollout'],
  ['wombat'],
  ['login', 'signin', 'authentication', 'auth'],
  ['colour', 'color', 'palette'],
];
const DIM = CONCEPTS.length + 2;
let embedCalls = 0;
function toyEmbed(texts) {
  embedCalls += texts.length;
  return Promise.resolve(texts.map((t) => {
    const v = new Float32Array(DIM);
    for (const w of String(t).toLowerCase().match(/[a-z]+/g) || []) {
      const g = CONCEPTS.findIndex((c) => c.includes(w));
      if (g !== -1) v[g] += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  }));
}
E.setEmbedderForTest(toyEmbed);

// ── fixtures ─────────────────────────────────────────────────────────────────
function buildDb(rows, path = join(ROOT, `db-${++seq}.db`)) {
  mkdirSync(dirname(path), { recursive: true });
  const db = openStore({ path });
  const insSession = db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,'completed')`);
  const insObs = db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, narrative, facts, created_at, created_at_epoch, content_hash) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const ids = [];
  rows.forEach((r, i) => {
    const mem = `emb:${path}:${i}`;
    insSession.run(mem, mem, r.project || 'p', 'test', '2026-01-01T00:00:00Z', 1_700_000_000_000 + i);
    ids.push(Number(insObs.run(mem, r.project || 'p', r.text || '', r.type || 'discovery', r.title, r.narrative || '', '[]',
      '2026-01-01T00:00:00Z', r.epoch ?? 1_700_000_000_000 + i, `h-${seq}-${i}`).lastInsertRowid));
  });
  db.close();
  return { path, ids };
}
const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');
const vectorCount = (p) => { const db = openDb(p, { readonly: true }); try { return E.hasVectors(db) ? db.prepare('SELECT COUNT(*) n FROM observation_vectors').get().n : 0; } finally { db.close(); } };

// ── pure helpers ─────────────────────────────────────────────────────────────
await t('rrfFuse: a memory both lists rank beats one only a single list ranks first', () => {
  const fused = E.rrfFuse([10, 20, 30], [{ id: 20, sim: 0.9 }, { id: 40, sim: 0.8 }]);
  eq(fused.map((f) => f.id), [20, 10, 40, 30], 'fused order');
  assert(Math.abs(fused[0].rrf - (1 / 62 + 1 / 61)) < 1e-12, 'standard RRF score, k=60');
});

await t('quantize: unit vectors map into int8 without overflow', () => {
  eq([...E.quantize(Float32Array.from([1, -1, 0.5, 0, 1.2]))], [127, -127, 64, 0, 127], 'int8 values');
});

await t('embedText: title + narrative, never the raw transcript column, capped', () => {
  const s = E.embedText({ title: 'T', narrative: 'n '.repeat(2000), text: 'SECRET TRANSCRIPT' });
  assert(!s.includes('SECRET'), 'raw text column excluded');
  assert(s.startsWith('T. n n') && s.length <= E.MAX_EMBED_CHARS, 'shape + cap');
});

// ── backfill ─────────────────────────────────────────────────────────────────
await t('brain embed: default is a read-only status report (store byte-identical, no table)', async () => {
  const { path } = buildDb([{ title: 'car notes' }, { title: 'database notes' }]);
  const before = md5(path);
  const r = await E.runEmbed({ dbPath: path });
  eq([r.apply, r.total, r.embedded, r.pending], [false, 2, 0, 2], 'status counts');
  eq(md5(path), before, 'store unchanged');
  eq(vectorCount(path), 0, 'no vectors table created');
});

await t('brain embed --apply: incremental, resumable, re-embeds edited rows, drops orphans', async () => {
  const { path, ids } = buildDb([
    { title: 'car one' }, { title: 'car two' }, { title: 'database three' }, { title: 'deploy four' }, { title: 'wombat five' },
  ]);
  const a = await E.runEmbed({ dbPath: path, apply: true, limit: 3, batch: 2 });
  eq([a.written, a.embedded, a.pending], [3, 3, 2], 'first (interrupted) run');
  const b = await E.runEmbed({ dbPath: path, apply: true });
  eq([b.written, b.embedded, b.pending], [2, 5, 0], 'resume picks up only the rest');
  embedCalls = 0;
  const c = await E.runEmbed({ dbPath: path, apply: true });
  eq([c.written, embedCalls], [0, 0], 'nothing pending → nothing embedded');

  const db = openDb(path);
  db.prepare('UPDATE observations SET narrative = ? WHERE id = ?').run('now about release rollout', ids[0]);
  db.prepare('DELETE FROM observations WHERE id = ?').run(ids[4]);
  db.close();
  const d = await E.runEmbed({ dbPath: path });
  eq([d.pending, d.stale, d.orphans], [1, 1, 1], 'status sees the edit and the orphan');
  const e = await E.runEmbed({ dbPath: path, apply: true });
  eq([e.written, e.embedded, e.pending, vectorCount(path)], [1, 4, 0, 4], 'edit re-embedded, orphan vector gone');
  const obs = openDb(path, { readonly: true });
  eq(obs.prepare('SELECT COUNT(*) n FROM observations').get().n, 4, 'observations untouched by embed');
  obs.close();
});

await t('brain embed --clear: dry-run by default, --apply drops only the vectors table', async () => {
  const { path } = buildDb([{ title: 'car' }, { title: 'sqlite' }]);
  await E.runEmbed({ dbPath: path, apply: true });
  const dry = await E.runEmbed({ dbPath: path, clear: true });
  eq([dry.vectors, vectorCount(path)], [2, 2], 'dry-run keeps vectors');
  const r = await E.runEmbed({ dbPath: path, clear: true, apply: true });
  eq([r.cleared, vectorCount(path)], [2, 0], 'cleared');
  const out = await recallSearch({ query: 'car', dbPath: path });
  eq(out.results.length, 1, 'recall still works (BM25)');
});

// ── search ───────────────────────────────────────────────────────────────────
await t('hybrid recall: finds a memory by meaning when no keyword matches', async () => {
  const { path, ids } = buildDb([
    { title: 'Automobile inventory sync', narrative: 'nightly job for the sedan catalogue' },
    { title: 'Unrelated wombat note', narrative: 'wombat' },
  ]);
  const bm25Only = await recallSearch({ query: 'car', dbPath: path });
  eq(bm25Only.results.length, 0, 'no vectors yet → BM25 alone, which cannot match');
  await E.runEmbed({ dbPath: path, apply: true });
  const hybrid = await recallSearch({ query: 'car', dbPath: path });
  eq(hybrid.results.map((r) => r.id), [ids[0]], 'semantic-only hit returned, noise below MIN_SIM excluded');
});

await t('hybrid recall: agreement wins — a row both BM25 and meaning like ranks first', async () => {
  const { path, ids } = buildDb([
    { title: 'car wash schedule', narrative: 'car car car car car' },      // BM25 top, vector = car
    { title: 'sedan fleet database', narrative: 'automobile storage' },  // meaning only (mixed)
    { title: 'car and automobile vehicle registry', narrative: 'car' },  // both
  ]);
  await E.runEmbed({ dbPath: path, apply: true });
  const out = await recallSearch({ query: 'car', dbPath: path });
  eq(out.results.length, 3, 'all three found');
  assert(out.results[0].id === ids[0] || out.results[0].id === ids[2], 'a row both lists rank leads');
  eq(out.results[2].id, ids[1], 'the meaning-only mixed row trails');
});

await t('hybrid recall: project filter applies to the semantic side too', async () => {
  const { path, ids } = buildDb([
    { title: 'automobile a', project: 'alpha' },
    { title: 'automobile b', project: 'beta' },
  ]);
  await E.runEmbed({ dbPath: path, apply: true });
  const out = await recallSearch({ query: 'vehicle', dbPath: path, project: 'beta' });
  eq(out.results.map((r) => r.id), [ids[1]], 'only beta');
});

await t('hybrid recall: lifecycle still down-ranks a superseded memory', async () => {
  const { path, ids } = buildDb([
    { type: 'decision', title: 'Deploy release train every Tuesday for the car app', epoch: 1_700_000_000_000 },
    { type: 'decision', title: 'Deploy release train every Tuesday for the car app extended', epoch: 1_700_100_000_000 },
  ]);
  runLifecycle({ dbPath: path, apply: true });
  await E.runEmbed({ dbPath: path, apply: true });
  const out = await recallSearch({ query: 'deploy release train tuesday car', dbPath: path });
  eq(out.results.map((r) => r.id), [ids[1], ids[0]], 'active first');
  eq(out.results[1].status, 'superseded', 'label kept');
});

await t('fallback: no embedder (library/model missing or BRAIN_EMBED=0) → exactly BM25', async () => {
  const { path } = buildDb([
    { title: 'car wash', narrative: 'car' }, { title: 'automobile registry', narrative: 'sedan' }, { title: 'car park', narrative: 'car car' },
  ]);
  const before = await recallSearch({ query: 'car', dbPath: path });
  await E.runEmbed({ dbPath: path, apply: true });
  process.env.BRAIN_EMBED = '0';
  try {
    const off = await recallSearch({ query: 'car', dbPath: path });
    eq(off.results.map((r) => r.id), before.results.map((r) => r.id), 'BRAIN_EMBED=0 → BM25 order, semantic-only row absent');
    eq(await E.semanticSearch({ dbPath: path, query: 'car' }), null, 'semanticSearch reports unavailable');
  } finally { delete process.env.BRAIN_EMBED; }
  E.setEmbedderForTest(() => Promise.reject(new Error('model exploded')));
  try {
    const broken = await recallSearch({ query: 'car', dbPath: path });
    eq(broken.results.map((r) => r.id), before.results.map((r) => r.id), 'a failing model degrades silently to BM25');
  } finally { E.setEmbedderForTest(toyEmbed); }
});

await t('context: retrieveContextHybrid fuses meaning into the injected block (subprocess, temp HOME)', async () => {
  const home = join(ROOT, `home-${++seq}`);
  const dbPath = join(home, '.claude-brain', 'brain.db');
  buildDb([{ title: 'Automobile inventory sync', narrative: 'sedan catalogue refresh' }, { title: 'wombat', narrative: 'wombat' }], dbPath);
  writeFileSync(join(home, '.claude-brain', 'READY'), 'test fixture\n');
  await E.runEmbed({ dbPath, apply: true });
  const script = join(ROOT, `ctx-${seq}.mjs`);
  writeFileSync(script, `
const E = await import(${JSON.stringify(join(REPO, 'bin/lib/embed.mjs'))});
const { retrieveContextHybrid } = await import(${JSON.stringify(join(REPO, 'bin/lib/agent.mjs'))});
const C = ${JSON.stringify(CONCEPTS)};
E.setEmbedderForTest(async (ts) => ts.map((t) => { const v = new Float32Array(${DIM});
  for (const w of t.toLowerCase().match(/[a-z]+/g) || []) { const g = C.findIndex((c) => c.includes(w)); if (g !== -1) v[g] += 1; }
  const n = Math.hypot(...v) || 1; return v.map((x) => x / n); }));
const opts = { wiki: false, learnings: false, workflows: false };
const h = await retrieveContextHybrid('which vehicle records get refreshed', opts);
const b = await retrieveContextHybrid('which vehicle records get refreshed', { ...opts, bm25Only: true });
process.stdout.write(JSON.stringify({ h, b }));`);
  const out = JSON.parse(execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  assert(out.h.hybrid && out.h.block.includes('Automobile inventory sync'), `hybrid block missing the meaning hit: ${out.h.block.slice(0, 300)}`);
  assert(!out.b.hybrid && !out.b.block.includes('Automobile'), 'bm25Only keeps the old keyword-only path');
});

// ── cold start (S10) ─────────────────────────────────────────────────────────
await t('cold start: a model load past the budget answers with BM25 now, hybrid once loaded', async () => {
  const { path, ids } = buildDb([
    { title: 'Automobile inventory sync', narrative: 'nightly job for the sedan catalogue' },
    { title: 'car wash schedule', narrative: 'car' },
  ]);
  await E.runEmbed({ dbPath: path, apply: true });
  E.setEmbedderForTest(toyEmbed, { loadMs: 800 }); // the model is "cold" again
  try {
    const t0 = Date.now();
    const first = await recallSearch({ query: 'car', dbPath: path, semanticBudgetMs: 150 });
    const took = Date.now() - t0;
    assert(took >= 140 && took < 500, `first query waits the budget, not the load (took ${took} ms)`);
    eq(first.results.map((r) => r.id), [ids[1]], 'BM25 alone: the meaning-only row is absent');
    eq(E.embedderState(), { loadsStarted: 1, loaded: false }, 'load started by the query, still running');
    const t1 = Date.now();
    const during = await recallSearch({ query: 'car', dbPath: path, semanticBudgetMs: 150 });
    const took2 = Date.now() - t1;
    assert(took2 < 100, `the budget is per cold start: a query during an over-budget load does not wait again (took ${took2} ms)`);
    eq(during.results.map((r) => r.id), [ids[1]], 'still BM25 while loading');
    await E.getEmbedder(); // the background load finishes
    eq(E.embedderState().loaded, true, 'loaded');
    const second = await recallSearch({ query: 'car', dbPath: path, semanticBudgetMs: 150 });
    assert(second.results.some((r) => r.id === ids[0]), 'next query is hybrid (meaning hit present)');
    eq(E.embedderState().loadsStarted, 1, 'the model loaded once, not per query');
  } finally { E.setEmbedderForTest(toyEmbed); }
});

await t('cold start: no budget (CLI) waits for the load and returns hybrid', async () => {
  const { path, ids } = buildDb([{ title: 'Automobile inventory sync', narrative: 'sedan catalogue' }, { title: 'wombat' }]);
  await E.runEmbed({ dbPath: path, apply: true });
  E.setEmbedderForTest(toyEmbed, { loadMs: 150 });
  try {
    const out = await recallSearch({ query: 'car', dbPath: path });
    eq(out.results.map((r) => r.id), [ids[0]], 'waited for the model');
  } finally { E.setEmbedderForTest(toyEmbed); }
});

await t('cold start: no model load for a store without vectors, or with BRAIN_EMBED=0', async () => {
  const plain = buildDb([{ title: 'car wash' }]).path;
  const withVec = buildDb([{ title: 'car wash' }]).path;
  await E.runEmbed({ dbPath: withVec, apply: true });
  E.setEmbedderForTest(toyEmbed, { loadMs: 20 });
  try {
    eq(E.storeHasVectors(plain), false, 'plain store: no vectors');
    eq(await E.warmSemantic({ dbPath: plain }), false, 'warm-up is a no-op');
    await recallSearch({ query: 'car', dbPath: plain, semanticBudgetMs: 50 });
    eq(E.embedderState().loadsStarted, 0, 'searching a store without vectors loads no model');
    process.env.BRAIN_EMBED = '0';
    try {
      eq(await E.warmSemantic({ dbPath: withVec }), false, 'BRAIN_EMBED=0: no warm-up');
      await recallSearch({ query: 'car', dbPath: withVec, semanticBudgetMs: 50 });
      eq(E.embedderState().loadsStarted, 0, 'BRAIN_EMBED=0: no model load');
    } finally { delete process.env.BRAIN_EMBED; }
    eq(E.storeHasVectors(withVec), true, 'store with vectors');
    eq(await E.warmSemantic({ dbPath: withVec }), true, 'vectors present: warmed');
    eq(E.embedderState(), { loadsStarted: 1, loaded: true }, 'one load, finished');
    const out = await E.semanticSearch({ dbPath: withVec, query: 'car', budgetMs: 0 });
    assert(out && out.length === 1, 'a warmed model answers even with a zero budget');
  } finally { E.setEmbedderForTest(toyEmbed); }
});

await t('matrix: read in chunks, every vector exactly once (rows across chunk boundaries)', async () => {
  const rows = Array.from({ length: 4500 }, (_, i) => ({ title: `wombat note ${i}` }));
  rows.push({ title: 'Automobile registry', narrative: 'sedan' });
  const { path, ids } = buildDb(rows);
  await E.runEmbed({ dbPath: path, apply: true, batch: 500 });
  const all = await E.semanticSearch({ dbPath: path, query: 'wombat car', k: 10_000, minSim: -1 });
  eq(all.length, 4501, 'every vector scored');
  eq(new Set(all.map((h) => h.id)).size, 4501, 'no vector read twice');
  const out = await recallSearch({ query: 'vehicle', dbPath: path });
  eq(out.results.map((r) => r.id), [ids[4500]], 'the last row (third chunk) is found by meaning');
});

// ── on by default: the background backfill job ───────────────────────────────
await t('BRAIN_EMBED=0: `embed --apply` is a no-op (skipped, no vectors, no table) — resumable job stays quiet', async () => {
  const { path } = buildDb([{ title: 'car' }, { title: 'sqlite' }]);
  process.env.BRAIN_EMBED = '0';
  try {
    const r = await E.runEmbed({ dbPath: path, apply: true });
    eq(r.skipped, 'BRAIN_EMBED=0', 'skipped');
    assert(!r.error, 'not an error');
    eq(vectorCount(path), 0, 'nothing written');
    const db = openDb(path, { readonly: true });
    eq(E.hasVectors(db), false, 'no vectors table created'); db.close();
    // the CLI form the scheduled job runs: exit 0, says why
    const out = execFileSync(process.execPath, [join(REPO, 'bin', 'brain.mjs'), 'embed', '--apply', '--scheduled', '--limit', '5', '--db', path],
      { encoding: 'utf8', env: { ...process.env, BRAIN_EMBED: '0' } });
    assert(/BRAIN_EMBED=0/.test(out), 'CLI explains the skip: ' + out);
  } finally { delete process.env.BRAIN_EMBED; }
  eq((await E.runEmbed({ dbPath: path, apply: true })).written, 2, 'embeds again once the opt-out is gone');
});

await t('--limit + batch: a bounded pass embeds only that many, the next pass resumes', async () => {
  const { path } = buildDb(Array.from({ length: 20 }, (_, i) => ({ title: `wombat ${i}` })));
  const a = await E.runEmbed({ dbPath: path, apply: true, limit: 7, batch: 3 });
  eq([a.written, a.pending], [7, 13], 'first pass');
  const b = await E.runEmbed({ dbPath: path, apply: true, limit: 7, batch: 3 });
  eq([b.written, b.embedded], [7, 14], 'second pass resumes');
  const c = await E.runEmbed({ dbPath: path, apply: true });
  eq([c.written, c.pending], [6, 0], 'third pass finishes');
});

await t('embed-schedule: the job runs a bounded, small-batch, --scheduled pass (and not under BRAIN_EMBED=0)', async () => {
  const S = await import('../bin/lib/embed-schedule.mjs');
  const a = S.embedArgs();
  eq(a.slice(0, 3), ['embed', '--apply', '--scheduled'], 'subcommand');
  eq(a[a.indexOf('--limit') + 1], String(S.DEFAULT_LIMIT), 'per-run limit');
  eq(a[a.indexOf('--batch') + 1], '8', 'batch 8');
  assert(S.DEFAULT_LIMIT > 0 && Number.isFinite(S.DEFAULT_LIMIT), 'bounded');
  process.env.BRAIN_EMBED = '0';
  const lines = [];
  try { eq(S.installEmbed({ log: (m) => lines.push(m) }), { installed: false, skipped: 'BRAIN_EMBED=0' }, 'nothing installed'); }
  finally { delete process.env.BRAIN_EMBED; }
  assert(/BRAIN_EMBED=0/.test(lines.join('\n')), 'says why');
});

// ── sync snapshot ────────────────────────────────────────────────────────────
await t('stripVectors: removes vectors from a snapshot copy, keeps every observation', async () => {
  const { path } = buildDb([{ title: 'car' }, { title: 'sqlite' }, { title: 'deploy' }]);
  await E.runEmbed({ dbPath: path, apply: true });
  const snap = join(ROOT, `snap-${++seq}.db`);
  const src = openDb(path, { readonly: true });
  src.exec(`VACUUM INTO '${snap}'`);
  src.close();
  eq(E.stripVectors(snap), true, 'stripped');
  eq(vectorCount(snap), 0, 'no vectors in snapshot');
  const s = openDb(snap, { readonly: true });
  eq(s.prepare('SELECT COUNT(*) n FROM observations').get().n, 3, 'observations intact');
  s.close();
  eq(vectorCount(path), 3, 'live store keeps its vectors');
  eq(E.stripVectors(snap), false, 'idempotent');
});

// ── no network ───────────────────────────────────────────────────────────────
await t('no network at query time: the real loader never downloads a missing model', async () => {
  let lib = null;
  try { lib = await import('@huggingface/transformers'); } catch {}
  if (!lib) { console.log('  (skipped — @huggingface/transformers not installed)'); return; }
  const empty = join(ROOT, `models-${++seq}`);
  mkdirSync(empty, { recursive: true });
  const { path } = buildDb([{ title: 'car' }]);
  await E.runEmbed({ dbPath: path, apply: true }); // toy vectors so search reaches the model load
  E.setEmbedderForTest(null);
  process.env.BRAIN_MODEL_DIR = empty;
  process.env.BRAIN_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
  fetchCalls = 0;
  try {
    eq(await E.semanticSearch({ dbPath: path, query: 'car' }), null, 'unavailable without a cached model');
    const out = await recallSearch({ query: 'car', dbPath: path });
    eq(out.results.length, 1, 'recall falls back to BM25');
    eq(fetchCalls, 0, 'no fetch made');
    eq(readdirSync(empty).length, 0, 'nothing downloaded');
  } finally {
    delete process.env.BRAIN_MODEL_DIR; delete process.env.BRAIN_EMBED_MODEL;
    E.setEmbedderForTest(toyEmbed);
  }
});

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\nembed-test: ${pass} passed, ${fail} failed\n`);
for (const [status, name, msg] of results) console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}${msg ? `\n      ${msg}` : ''}`);
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
