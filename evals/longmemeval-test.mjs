#!/usr/bin/env node
// Tests for the LongMemEval-S retrieval harness (evals/longmemeval/lib.mjs).
//
//   node evals/longmemeval-test.mjs
//
// Synthetic haystacks only, in temp stores under the scratchpad/tmpdir, with a
// tiny deterministic "concept" embedder injected via setEmbedderForTest() — no
// dataset download, no model, no network. The real brain.db is never opened.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.BRAIN_NO_ECONOMICS = '1';
const L = await import('./longmemeval/lib.mjs');
const E = await import('../bin/lib/embed.mjs');
const { recallSearch } = await import('../bin/lib/recall.mjs');

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

const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `lme-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
let seq = 0;

// Words in one concept group share a dimension: "automobile" finds "car" by
// meaning while sharing no letters BM25 could match.
const CONCEPTS = [
  ['car', 'cars', 'automobile', 'vehicle', 'sedan'],
  ['degree', 'graduated', 'university', 'diploma'],
  ['recipe', 'cooking', 'bake', 'oven'],
  ['weather', 'rain', 'sunny'],
];
const DIM = CONCEPTS.length + 1;
function toyEmbed(texts) {
  return Promise.resolve(texts.map((s) => {
    const v = new Float32Array(DIM);
    for (const w of String(s).toLowerCase().match(/[a-z]+/g) || []) {
      const g = CONCEPTS.findIndex((c) => c.includes(w));
      if (g !== -1) v[g] += 1;
    }
    if (!v.some(Boolean)) v[DIM - 1] = 1; // no concept: a shared "nothing" direction
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  }));
}
E.setEmbedderForTest(toyEmbed);

// A small LongMemEval-shaped question: evidence in session "ans", filler around it.
function question({ id = 'q1', type = 'single-session-user', text, answer, sessions }) {
  return {
    question_id: id, question_type: type, question: text,
    answer_session_ids: answer,
    haystack_session_ids: sessions.map((s) => s.id),
    haystack_dates: sessions.map(() => '2023/05/20 (Sat) 02:21'),
    haystack_sessions: sessions.map((s) => s.turns),
  };
}
const turn = (role, content, has_answer) => (has_answer ? { role, content, has_answer } : { role, content });

async function store(q, gran = 'round') {
  const units = L.unitsFor(q, gran);
  const vecs = await toyEmbed(units.map(L.unitEmbedText));
  const byText = new Map(units.map((u, i) => [u.id, E.quantize(vecs[i])]));
  const dbPath = join(ROOT, `s-${++seq}.db`);
  const byRow = L.buildStore(dbPath, units, { vecOf: (u) => byText.get(u.id) });
  return { dbPath, byRow, units };
}

// ── units ───────────────────────────────────────────────────────────────────
await t('roundsOf pairs each user turn with the reply that follows', () => {
  const r = L.roundsOf('s1', [
    turn('assistant', 'hello, how can I help?'),
    turn('user', 'I graduated with a degree in Business', true),
    turn('assistant', 'congrats'),
    turn('user', 'thanks'),
  ]);
  eq(r.map((x) => x.id), ['s1#0', 's1#1', 's1#2'], 'a leading assistant turn is its own round');
  eq(r.map((x) => x.hasAnswer), [false, true, false], 'has_answer marks only its round');
  eq(r[1].text, 'user: I graduated with a degree in Business\nassistant: congrats', 'round text');
  assert(r.every((x) => x.session === 's1'), 'session id carried');
});

await t('session granularity is one unit per session; buildStore keeps duplicate session ids', () => {
  const q = question({ text: 'x', answer: ['a'], sessions: [
    { id: 'a', turns: [turn('user', 'one'), turn('assistant', 'two')] },
    { id: 'a', turns: [turn('user', 'one'), turn('assistant', 'two')] }, // 13 real haystacks repeat an id
  ] });
  const units = L.unitsFor(q, 'session');
  eq(units.length, 2, 'two units');
  const byRow = L.buildStore(join(ROOT, `dup-${++seq}.db`), units);
  eq(byRow.size, 2, 'both stored, no UNIQUE failure');
});

// ── metrics ─────────────────────────────────────────────────────────────────
await t('scoreRanking: any/all/ndcg over sessions, unit hits, short lists miss', () => {
  const u = (session, hasAnswer = false) => ({ session, hasAnswer });
  const ranked = [u('x'), u('x'), u('a', true), u('y'), u('b')];
  const m = L.scoreRanking(ranked, { answerSessions: ['a', 'b'], unitEvidence: true });
  eq(m['recall_any@1'], 0, 'x first');
  eq(m['recall_any@3'], 1, 'sessions dedupe: x, a, y');
  eq(m['recall_all@3'], 0, 'b is 4th session');
  eq(m['recall_all@5'], 1, 'both by 5');
  eq(m['unit_any@1'], 0, 'unit 1 is not evidence');
  eq(m['unit_any@3'], 1, 'unit 3 is');
  const ndcg = (1 / Math.log2(3) + 1 / Math.log2(5)) / (1 + 1 / Math.log2(3));
  assert(Math.abs(m['ndcg_any@10'] - ndcg) < 1e-9, `ndcg ${m['ndcg_any@10']} vs ${ndcg}`);
  const none = L.scoreRanking([], { answerSessions: ['a'] });
  eq([none['recall_any@10'], none['unit_any@1']], [0, undefined], 'empty ranking misses; no unit metric without evidence');
});

await t('aggregate averages into percentages; selectQuestions is deterministic and drops abstention', () => {
  eq(L.aggregate([{ a: 1 }, { a: 0 }, { a: 1 }]), { a: 66.7 }, 'mean %');
  const data = ['c', 'a_abs', 'b', 'a', 'd'].map((question_id) => ({ question_id }));
  eq(L.selectQuestions(data).map((q) => q.question_id), ['a', 'b', 'c', 'd'], 'sorted, _abs excluded');
  eq(L.selectQuestions(data, { stride: 2 }).map((q) => q.question_id), ['a', 'c'], 'every 2nd');
  eq(L.selectQuestions(data, { stride: 2, limit: 1 }).map((q) => q.question_id), ['a'], 'then limit');
});

// ── ranking with the product's retrieval ────────────────────────────────────
const filler = (id, n) => ({ id, turns: [turn('user', `tell me about the weather number ${n}`), turn('assistant', 'it is sunny')] });
const qKeyword = question({ text: 'What degree did I graduate with?', answer: ['ans'], sessions: [
  filler('f1', 1), filler('f2', 2),
  { id: 'ans', turns: [turn('user', 'I graduated with a degree in Business Administration', true), turn('assistant', 'nice')] },
  filler('f3', 3),
] });

await t('BM25 (brain_recall query) ranks the evidence round first', async () => {
  const { dbPath, byRow } = await store(qKeyword);
  const r = await L.rankUnits({ dbPath, byRow, question: qKeyword.question, query: 'recall', mode: 'bm25' });
  eq(r.units[0].id, 'ans#0', 'evidence first');
  eq(r.semantic, null, 'no semantic in bm25 mode');
  eq(L.scoreRanking(r.units, { answerSessions: qKeyword.answer_session_ids })['recall_any@1'], 1, 'hit@1');
});

await t('hybrid finds a paraphrase BM25 cannot', async () => {
  const q = question({ text: 'Which automobile did I buy?', answer: ['ans'], sessions: [
    filler('f1', 1),
    { id: 'ans', turns: [turn('user', 'picked up a used sedan yesterday', true), turn('assistant', 'enjoy it')] },
    filler('f2', 2),
  ] });
  const { dbPath, byRow } = await store(q);
  const bm = await L.rankUnits({ dbPath, byRow, question: q.question, query: 'recall', mode: 'bm25' });
  assert(!bm.units.some((u) => u.session === 'ans'), 'BM25 has no shared word to match');
  const hy = await L.rankUnits({ dbPath, byRow, question: q.question, query: 'recall', mode: 'hybrid' });
  eq(hy.units[0]?.session, 'ans', 'hybrid ranks it first');
});

await t('hybrid refuses to run without semantic search (no silent BM25 relabel)', async () => {
  const { dbPath, byRow } = await store(qKeyword);
  process.env.BRAIN_EMBED = '0';
  try {
    let threw = false;
    try { await L.rankUnits({ dbPath, byRow, question: qKeyword.question, mode: 'hybrid' }); } catch { threw = true; }
    assert(threw, 'must throw');
  } finally { delete process.env.BRAIN_EMBED; }
});

await t('context query (brain_context) is the recall query: every token, not the first six long words', async () => {
  const q = question({ text: 'Remind me: the recipe we discussed, which oven temperature?', answer: ['ans'], sessions: [
    filler('f1', 1),
    { id: 'ans', turns: [turn('user', 'for this recipe set the oven to 200C', true), turn('assistant', 'ok')] },
  ] });
  const { dbPath, byRow } = await store(q);
  const r = await L.rankUnits({ dbPath, byRow, question: q.question, query: 'context', mode: 'bm25' });
  eq(r.units[0]?.session, 'ans', 'found via recipe/oven');
});

await t('context query reaches a term past the sixth long word (the old builder could not)', async () => {
  const q = question({ text: 'Could you remind me about the thing where we discussed the quokka habitat', answer: ['ans'], sessions: [
    filler('f1', 1), filler('f2', 2),
    { id: 'ans', turns: [turn('user', 'the quokka habitat survey counted nests', true), turn('assistant', 'noted')] },
  ] });
  const { dbPath, byRow } = await store(q);
  const r = await L.rankUnits({ dbPath, byRow, question: q.question, query: 'context', mode: 'bm25' });
  eq(r.units[0]?.session, 'ans', 'quokka is the eighth long word');
  const rec = await L.rankUnits({ dbPath, byRow, question: q.question, query: 'recall', mode: 'bm25' });
  eq(rec.units[0]?.session, 'ans', 'and recall agrees');
});

await t('our top 20 is exactly recallSearch()\'s top 20, in both modes', async () => {
  const sessions = [];
  for (let i = 0; i < 30; i++) sessions.push({ id: `s${i}`, turns: [turn('user', `car note ${i} about the weather and a vehicle ${i % 3 ? 'sedan' : ''}`), turn('assistant', `reply ${i}`)] });
  const q = question({ text: 'what car or vehicle did I talk about', answer: ['s7'], sessions });
  const { dbPath, byRow } = await store(q);
  for (const mode of ['bm25', 'hybrid']) {
    const ours = await L.rankUnits({ dbPath, byRow, question: q.question, query: 'recall', mode });
    if (mode === 'bm25') process.env.BRAIN_EMBED = '0';
    let theirs;
    try { theirs = await recallSearch({ query: q.question, limit: 20, dbPath }); } finally { delete process.env.BRAIN_EMBED; }
    eq(theirs.results.map((x) => byRow.get(x.id).id), ours.units.slice(0, 20).map((u) => u.id), `${mode}: identical top 20`);
  }
});

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\nlongmemeval-test: ${pass} passed, ${fail} failed\n`);
for (const [status, name, msg] of results) console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}${msg ? `\n      ${msg}` : ''}`);
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
