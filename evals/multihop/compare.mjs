#!/usr/bin/env node
// Multi-hop retrieval experiments (no LLM, local, deterministic). Compares
// variants of brain_recall's hybrid ranking on the SAME candidate pool and the
// SAME k, on LoCoMo (round units) and LongMemEval-S (round units).
//
//   node evals/multihop/compare.mjs [--only locomo|lme] [--lme-stride 1] [--lme-limit N]
//        [--locomo-stride 1] [--locomo-limit N] [--variants all|core|<name,name>] [--out evals/multihop/results.json]
//
// Read-only on the datasets and the embed caches (opened readOnly, nothing is
// embedded or written except the model's query embeddings, held in memory).
import '../test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const lm = await import('../locomo/lib.mjs');
lm.setupModelDir();
const lme = await import('../longmemeval/lib.mjs');
const { getEmbedder, quantize, CANDIDATES, RRF_K, MIN_SIM } = await import('../../bin/lib/embed.mjs');
const { ftsMatchExpr, MAX_QUERY_CHARS } = await import('../../bin/lib/recall.mjs');
const { pruneCommonTerms } = await import('../../bin/lib/fts.mjs');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ONLY = arg('--only', 'both');
const LME_STRIDE = Number(arg('--lme-stride', 1)), LME_LIMIT = Number(arg('--lme-limit', Infinity));
const LOC_STRIDE = Number(arg('--locomo-stride', 1)), LOC_LIMIT = Number(arg('--locomo-limit', Infinity));
const OUT = arg('--out', join(HERE, 'results.json'));
const VARSEL = arg('--variants', 'all');
const log = (...a) => console.error('[multihop]', ...a);

// ── text helpers ────────────────────────────────────────────────────────────
const STOP = new Set(`a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves
s t d ll m o re ve y ain don didn doesn isn wasn weren won wouldn couldn shouldn hasn haven hadn aren let like get got go going gone one two yes yeah ok okay oh hey hi hello thanks thank please really much many lot way thing things know think want see
user assistant`.split(/\s+/));
const toks = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
const content = (s) => toks(s).filter((t) => !STOP.has(t) && t.length > 1);

export function splitQuestion(q) {
  const parts = String(q).replace(/\?+\s*$/, '').split(/\s*[,;]\s*|\s+and\s+|\s+or\s+|\s+both\s+|\s+&\s+|\s+as well as\s+|\s+versus\s+|\s+vs\.?\s+|\s+then\s+/i)
    .map((p) => p.trim()).filter((p) => content(p).length >= 2);
  return parts.length >= 2 ? parts.slice(0, 4) : null;
}

// ── per-store context ───────────────────────────────────────────────────────
class Ctx {
  constructor({ units, dbPath, byRow, vecs, embed }) {
    this.units = units; this.embed = embed; this.dbPath = dbPath; this.byRow = byRow;
    this.n = units.length;
    const idxOf = new Map(units.map((u, i) => [u, i]));
    this.rowToIdx = new Map([...byRow].map(([r, u]) => [r, idxOf.get(u)]));
    this.dim = vecs.find(Boolean).length;
    this.mat = new Int8Array(this.n * this.dim);
    vecs.forEach((v, i) => { if (!v) throw new Error('missing cached vector'); this.mat.set(v, i * this.dim); });
    this.tf = units.map((u) => { const m = new Map(); for (const t of toks(u.text)) m.set(t, (m.get(t) || 0) + 1); return m; });
    this.df = new Map();
    for (const m of this.tf) for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.stmt = this.db.prepare(`SELECT o.id FROM observations_fts f JOIN observations o ON o.id = f.rowid WHERE observations_fts MATCH ? ORDER BY rank LIMIT ?`);
    this.cache = new Map(); // `${kind}|${text}` → { v, ms }
    this.computed = 0; this.meter = 0;
  }
  close() { try { this.db.close(); } catch {} }
  _get(key, fn) {
    let e = this.cache.get(key);
    if (!e) { const t0 = performance.now(); const v = fn(); const ms = performance.now() - t0; e = { v, ms }; this.cache.set(key, e); this.computed += ms; }
    this.meter += e.ms;
    return e.v;
  }
  // BM25 over a raw query text, exactly the product's: every token OR'd.
  bm25(text, extraTerms = []) {
    return this._get(`b|${text}|${extraTerms.join(' ')}`, () => {
      let match = ftsMatchExpr(String(text).slice(0, MAX_QUERY_CHARS));
      if (extraTerms.length) match += (match ? ' OR ' : '') + extraTerms.map((t) => `"${t}"`).join(' OR ');
      if (!match) return [];
      try { return this.stmt.all(pruneCommonTerms(this.db, match), lme.BM25_DEPTH).map((r) => this.rowToIdx.get(Number(r.id))); } catch { return []; }
    });
  }
  async qvec(text) {
    const key = `e|${text}`;
    let e = this.cache.get(key);
    if (!e) { const t0 = performance.now(); const [v] = await this.embed([text], { query: true }); e = { v: quantize(v), ms: performance.now() - t0 }; this.cache.set(key, e); this.computed += e.ms; }
    this.meter += e.ms;
    return e.v;
  }
  _scan(q, norm = 1) {
    const { dim, mat, n } = this;
    const scale = 127 * 127 * norm, k = CANDIDATES, top = [];
    for (let r = 0, off = 0; r < n; r++, off += dim) {
      let dot = 0;
      for (let j = 0; j < dim; j++) dot += q[j] * mat[off + j];
      const sim = dot / scale;
      if (sim < MIN_SIM || (top.length === k && sim <= top[k - 1].sim)) continue;
      let at = top.length;
      while (at > 0 && top[at - 1].sim < sim) at--;
      top.splice(at, 0, { id: r, sim });
      if (top.length > k) top.pop();
    }
    return top.map((t) => t.id);
  }
  // semantic list over a raw text (product's semanticSearch, in-process)
  async sem(text) {
    const q = await this.qvec(text);
    return this._get(`s|${text}`, () => this._scan(q));
  }
  // Rocchio: query vector + mean of the feedback units' vectors, renormalised
  async rocchio(text, fb, beta = 1) {
    const q = await this.qvec(text);
    return this._get(`r|${text}|${fb.join(',')}|${beta}`, () => {
      const { dim, mat } = this;
      const c = new Float64Array(dim);
      for (let j = 0; j < dim; j++) c[j] = q[j];
      for (const i of fb) for (let j = 0; j < dim; j++) c[j] += (beta * mat[i * dim + j]) / fb.length;
      let nn = 0; for (let j = 0; j < dim; j++) nn += c[j] * c[j];
      const norm = Math.sqrt(nn) / 127 || 1;
      return this._scan(c, norm);
    });
  }
}

// Weighted RRF over rank lists of unit indexes — rrfFuse/fuseRows generalised
// with a weight per list; with weights 1,1 it is the product's fuse exactly.
export function wrrf(lists, depth = CANDIDATES) {
  const score = new Map();
  for (const { ids, w } of lists) ids.forEach((id, i) => score.set(id, (score.get(id) || 0) + w / (RRF_K + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, depth);
}
const baseRank = async (ctx, q) => {
  const b = ctx.bm25(q), s = await ctx.sem(q);
  return s.length ? wrrf([{ ids: b, w: 1 }, { ids: s, w: 1 }]) : b.slice(0, CANDIDATES);
};

// PRF expansion terms: tf-idf over the feedback units, minus query terms, stopwords, very common and singleton terms
function expansionTerms(ctx, fb, q, t, maxDfFrac = 0.1) {
  const qt = new Set(toks(q));
  const sc = new Map();
  for (const i of fb) for (const [term, tf] of ctx.tf[i]) {
    if (qt.has(term) || STOP.has(term) || term.length < 3) continue;
    const df = ctx.df.get(term);
    if (df < 2 || df > maxDfFrac * ctx.n) continue;
    sc.set(term, (sc.get(term) || 0) + (1 + Math.log(tf)) * Math.log(ctx.n / df));
  }
  return [...sc.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, t).map(([term]) => term);
}

// ── stages: (ctx, q, cur ranking) → ranking ─────────────────────────────────
const STAGES = {
  async prf(ctx, q, cur, { m, t, w, mode, pin = 0 }) {
    const fb = cur.slice(0, m);
    const fin = (fused) => { // pin: the baseline's first `pin` hits keep their places, PRF reorders the rest
      if (!pin) return fused;
      const head = cur.slice(0, pin), hs = new Set(head);
      return [...head, ...fused.filter((i) => !hs.has(i))].slice(0, CANDIDATES);
    };
    if (mode === 'v') return fin(wrrf([{ ids: cur, w: 1 }, { ids: await ctx.rocchio(q, fb), w }]));
    const terms = expansionTerms(ctx, fb, q, t);
    const lists = [{ ids: cur, w: 1 }];
    if (mode !== 's') lists.push({ ids: ctx.bm25(q, terms), w });
    if (mode === 'bs' || mode === 's' || mode === 'bsv') lists.push({ ids: await ctx.sem(`${q} ${terms.join(' ')}`), w });
    if (mode === 'bsv') lists.push({ ids: await ctx.rocchio(q, fb), w });
    return fin(wrrf(lists));
  },
  async split(ctx, q, cur, { w }) {
    const parts = splitQuestion(q);
    if (!parts) return cur;
    const lists = [{ ids: cur, w: 1 }];
    for (const p of parts) {
      const b = ctx.bm25(p), s = await ctx.sem(p);
      lists.push({ ids: s.length ? wrrf([{ ids: b, w: 1 }, { ids: s, w: 1 }]) : b.slice(0, CANDIDATES), w });
    }
    return wrrf(lists);
  },
  async cap(ctx, q, cur, { n }) {
    const cnt = new Map(), keep = [], rest = [];
    for (const i of cur) { const s = ctx.units[i].session; const c = cnt.get(s) || 0; if (c < n) { keep.push(i); cnt.set(s, c + 1); } else rest.push(i); }
    return [...keep, ...rest];
  },
  async nbr(ctx, q, cur, { j, dir }) {
    const out = [], seen = new Set();
    const put = (i) => { if (!seen.has(i)) { seen.add(i); out.push(i); } };
    cur.forEach((i, r) => {
      put(i);
      if (r >= j) return;
      const s = ctx.units[i].session;
      const cand = dir === 'both' ? [i + 1, i - 1] : [i + 1];
      for (const c of cand) if (c >= 0 && c < ctx.n && ctx.units[c].session === s) put(c);
    });
    // anything displaced past the pool depth is dropped, same as the pool cap
    return out.slice(0, CANDIDATES);
  },
};

// ── variants ────────────────────────────────────────────────────────────────
const V = [{ name: 'baseline', stages: [] }];
const add = (name, stages) => V.push({ name, stages });
const f = (x) => String(x);
for (const m of [3, 5]) for (const t of [5, 10]) for (const w of [0.5, 1]) for (const mode of ['b', 'bs'])
  add(`A prf-${mode} m${m} t${t} w${f(w)}`, [['prf', { m, t, w, mode }]]);
for (const m of [3, 5]) for (const w of [0.5, 1]) add(`A prf-vec m${m} w${f(w)}`, [['prf', { m, t: 0, w, mode: 'v' }]]);
for (const w of [0.5, 1]) add(`B split w${f(w)}`, [['split', { w }]]);
for (const n of [3, 5]) add(`C cap${n}`, [['cap', { n }]]);
for (const j of [3, 5]) for (const dir of ['next', 'both']) add(`D nbr-${dir} j${j}`, [['nbr', { j, dir }]]);
// E: combinations, chosen after reading A-D (see RESULTS.md); extend with --variants names
for (const [name, st] of [
  ['E prf-vec m3 w1 + cap5', [['prf', { m: 3, t: 0, w: 1, mode: 'v' }], ['cap', { n: 5 }]]],
  ['E prf-vec m3 w1 + split w0.5', [['prf', { m: 3, t: 0, w: 1, mode: 'v' }], ['split', { w: 0.5 }]]],
  ['E prf-vec m3 w1 + nbr-next j3', [['prf', { m: 3, t: 0, w: 1, mode: 'v' }], ['nbr', { j: 3, dir: 'next' }]]],
]) add(name, st);
let VARIANTS = V;
if (VARSEL === 'core') VARIANTS = V.filter((v) => /^(baseline|A prf-bs m3 t5 w0\.5|A prf-vec m3 w1|B split w0\.5|C cap3|D nbr-next j3)/.test(v.name));
else if (VARSEL !== 'all') { const want = new Set(VARSEL.split(',').concat('baseline')); VARIANTS = V.filter((v) => want.has(v.name)); }
try { // user-defined extra variants: evals/multihop/extra-variants.json [{name,stages:[[stage,params]]}]
  for (const x of JSON.parse(readFileSync(join(HERE, 'extra-variants.json'), 'utf8'))) if (VARSEL === 'all' || VARSEL.split(',').includes(x.name)) VARIANTS.push(x);
} catch {}

async function runVariant(ctx, q, v) {
  const c0 = ctx.computed; ctx.meter = 0;
  const t0 = performance.now();
  let cur = await baseRank(ctx, q);
  for (const [st, p] of v.stages) cur = await STAGES[st](ctx, q, cur, p);
  const wall = performance.now() - t0;
  const own = wall - (ctx.computed - c0);
  return { rank: cur, ms: own + ctx.meter };
}

// ── drive ───────────────────────────────────────────────────────────────────
const embed = await getEmbedder({ allowRemote: false });
if (!embed) throw new Error('embedding model unavailable');
const openCacheRO = (p) => { const db = new DatabaseSync(p, { readOnly: true }); db.exec('PRAGMA busy_timeout = 60000'); const g = db.prepare('SELECT v FROM vec WHERE h = ?'); return (u) => { const r = g.get(lme.vecKey(lme.unitEmbedText(u))); return r ? new Int8Array(new Uint8Array(r.v).buffer) : null; }; };
const work = mkdtempSync(join(tmpdir(), 'multihop-'));
const out = { variants: VARIANTS.map((v) => v.name), notes: {} };

async function faithfulness(ctx, byRow, q, dbPath, units) {
  const base = await baseRank(ctx, q);
  const ref = (await lme.rankUnits({ dbPath, byRow, question: q, query: 'recall', mode: 'hybrid' })).units;
  const same = base.map((i) => units[i].id).join('|') === ref.map((u) => u.id).join('|');
  return same;
}

// LoCoMo
async function runLoCoMo() {
  const data = lm.loadLocomo();
  const qs = lm.allQuestions(data).filter((q) => q.evidence.length).filter((_, i) => i % LOC_STRIDE === 0).slice(0, LOC_LIMIT);
  const vecOf = openCacheRO(join(lm.DATA, 'embed-cache.db'));
  const KS = [10, 20];
  const acc = Object.fromEntries(VARIANTS.map((v) => [v.name, { ms: 0, n: 0, all: {}, any: {}, perQ: [] }]));
  let chk = { n: 0, same: 0 };
  for (let ci = 0; ci < data.length; ci++) {
    const cq = qs.filter((q) => q.conv === ci);
    if (!cq.length) continue;
    const units = lm.unitsFor(data[ci], 'round');
    const dbPath = join(work, `loc-${ci}.db`);
    const byRow = lm.buildStore(dbPath, units, { vecOf });
    const ctx = new Ctx({ units, dbPath, byRow, vecs: units.map(vecOf), embed });
    for (const [qi, q] of cq.entries()) {
      if (qi < 3) { chk.n++; chk.same += await faithfulness(ctx, byRow, q.question, dbPath, units); }
      let baseMs = 0;
      for (const v of VARIANTS) {
        const { rank, ms } = await runVariant(ctx, q.question, v);
        if (v.name === 'baseline') baseMs = ms;
        const a = acc[v.name]; a.n++; a.ms += ms - baseMs;
        const row = { cat: q.category };
        for (const k of KS) {
          const have = new Set(rank.slice(0, k).flatMap((i) => units[i].dias));
          row[`all@${k}`] = q.evidence.every((e) => have.has(e)) ? 1 : 0;
          row[`any@${k}`] = q.evidence.some((e) => have.has(e)) ? 1 : 0;
        }
        a.perQ.push(row);
      }
    }
    ctx.close(); rmSync(dbPath, { force: true });
    log(`locomo conv ${ci + 1}/${data.length} (${cq.length} q)`);
  }
  out.locomo = { questions: qs.length, stride: LOC_STRIDE, faithfulness: chk, variants: {} };
  for (const v of VARIANTS) {
    const a = acc[v.name], r = { extraMs: a.ms / a.n, overall: {}, byCat: {} };
    for (const k of KS) for (const m of ['all', 'any']) {
      const key = `${m}@${k}`;
      r.overall[key] = pct(a.perQ.reduce((s, x) => s + x[key], 0), a.n);
      for (const c of [1, 2, 3, 4]) { const rr = a.perQ.filter((x) => x.cat === c); (r.byCat[c] ||= {})[key] = pct(rr.reduce((s, x) => s + x[key], 0), rr.length); }
    }
    r.perQ = a.perQ.map((x) => `${x.cat}${x['all@10']}${x['all@20']}${x['any@10']}${x['any@20']}`);
    out.locomo.variants[v.name] = r;
  }
}
const pct = (x, n) => Math.round((1000 * x) / n) / 10;

// LongMemEval
async function runLME() {
  const raw = JSON.parse(readFileSync(join(dirname(HERE), 'longmemeval', 'data', 'longmemeval_s_cleaned.json'), 'utf8'));
  const qs = lme.selectQuestions(raw, { stride: LME_STRIDE, limit: LME_LIMIT });
  const vecOf = openCacheRO(join(dirname(HERE), 'longmemeval', 'data', 'embed-cache.db'));
  const acc = Object.fromEntries(VARIANTS.map((v) => [v.name, { ms: 0, n: 0, rows: [], perQ: [] }]));
  let chk = { n: 0, same: 0 };
  const t0 = Date.now();
  for (const [n, q] of qs.entries()) {
    const units = lme.unitsFor(q, 'round');
    const dbPath = join(work, `lme-${n}.db`);
    const byRow = lme.buildStore(dbPath, units, { vecOf });
    const ctx = new Ctx({ units, dbPath, byRow, vecs: units.map(vecOf), embed });
    if (n < 4) { chk.n++; chk.same += await faithfulness(ctx, byRow, q.question, dbPath, units); }
    let baseMs = 0;
    for (const v of VARIANTS) {
      const { rank, ms } = await runVariant(ctx, q.question, v);
      if (v.name === 'baseline') baseMs = ms;
      const a = acc[v.name]; a.n++; a.ms += ms - baseMs;
      const m = lme.scoreRanking(rank.map((i) => units[i]), { answerSessions: q.answer_session_ids });
      a.rows.push({ ...m, type: q.question_type });
    }
    ctx.close(); for (const e of ['', '-wal', '-shm']) rmSync(dbPath + e, { force: true });
    if ((n + 1) % 25 === 0) log(`lme ${n + 1}/${qs.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  out.lme = { questions: qs.length, stride: LME_STRIDE, faithfulness: chk, variants: {} };
  for (const v of VARIANTS) {
    const a = acc[v.name];
    const ov = lme.aggregate(a.rows.map(({ type, ...m }) => m));
    const ms = lme.aggregate(a.rows.filter((r) => r.type === 'multi-session').map(({ type, ...m }) => m));
    out.lme.variants[v.name] = { extraMs: a.ms / a.n, overall: ov, multiSession: ms,
      perQ: a.rows.map((r) => `${r['recall_any@1']}${r['recall_any@5']}${r['recall_any@10']}${r['recall_all@5']}${r['recall_all@10']}`) };
  }
}

try {
  if (ONLY !== 'lme') await runLoCoMo();
  if (ONLY !== 'locomo') await runLME();
} finally { rmSync(work, { recursive: true, force: true }); }
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
log('wrote', OUT);
process.exit(0);
