// LoCoMo harness — the pure parts (data, units, embedding cache, retrieval).
// qa.mjs (end-to-end QA) and retrieval.mjs (retrieval-only unit comparison)
// drive it. Store building and ranking are REUSED from the LongMemEval harness
// (buildStore / rankUnits / unitEmbedText / vecKey), not duplicated.
import '../test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildStore, rankUnits, unitEmbedText, vecKey } from '../longmemeval/lib.mjs';

export { buildStore, rankUnits, unitEmbedText, vecKey };
export const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA = join(HERE, 'data');
export const DATA_FILE = join(DATA, 'locomo10.json');
export const DATA_URL = 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';

// Reuse the LongMemEval model download if it is already on disk.
export function setupModelDir() {
  const lme = join(HERE, '..', 'longmemeval', 'data', 'models');
  process.env.BRAIN_MODEL_DIR ||= existsSync(lme) ? lme : join(DATA, 'models');
  process.env.BRAIN_NO_ECONOMICS = '1';
}

// Category ids as they appear in locomo10.json. The repo does not document them;
// this mapping is verified against the question/answer shapes in the data (see README).
export const CATEGORIES = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' };

export function loadLocomo() {
  if (!existsSync(DATA_FILE)) throw new Error(`dataset missing: curl -L -o ${DATA_FILE} ${DATA_URL}`);
  return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
}

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** One dialogue turn as memory text: "Speaker: text [shares image: caption]". */
export function turnText(m) {
  const cap = m.blip_caption ? ` [shares image: ${collapse(m.blip_caption)}]` : '';
  return `${m.speaker}: ${collapse(m.text)}${cap}`;
}

/** All turns of a conversation in order, each with its session date_time. */
export function turnsOf(conv) {
  const c = conv.conversation;
  const keys = Object.keys(c).filter((k) => /^session_\d+$/.test(k)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  const out = [];
  for (const k of keys) {
    const date = c[`${k}_date_time`] || '';
    (c[k] || []).forEach((m, i) => out.push({ session: k, date, idx: i, dia: m.dia_id, text: turnText(m) }));
  }
  return out;
}

/**
 * Retrieval units. 'turn': one turn each. 'round': a turn plus the next turn in
 * the same session (non-overlapping pairs, like LongMemEval's user+assistant
 * round; a trailing odd turn stands alone). Every unit carries the dia_ids it
 * covers so evidence recall can be scored.
 */
export function unitsFor(conv, granularity = 'turn') {
  const turns = turnsOf(conv);
  if (granularity === 'turn') {
    return turns.map((t, i) => ({ id: t.dia || `t${i}`, session: t.session, date: t.date, text: t.text, dias: [t.dia] }));
  }
  const units = [];
  for (let i = 0; i < turns.length; ) {
    const a = turns[i], b = turns[i + 1];
    if (b && b.session === a.session) {
      units.push({ id: `${a.dia}+${b.dia}`, session: a.session, date: a.date, text: `${a.text}\n${b.text}`, dias: [a.dia, b.dia] });
      i += 2;
    } else {
      units.push({ id: a.dia, session: a.session, date: a.date, text: a.text, dias: [a.dia] });
      i += 1;
    }
  }
  return units;
}

/** Evidence dia_ids of a question. A few entries pack several ids ("D8:6; D9:17"); split them. */
export function evidenceIds(q) {
  return [...new Set((q.evidence || []).flatMap((e) => String(e).match(/D\d+:\d+/g) || []))];
}

/** All scored questions (categories 1-4 unless includeAdversarial), with stable ids. */
export function allQuestions(data, { includeAdversarial = false } = {}) {
  const out = [];
  data.forEach((conv, ci) => conv.qa.forEach((q, qi) => {
    if (q.category === 5 && !includeAdversarial) return;
    out.push({ id: `${conv.sample_id}#${qi}`, conv: ci, sample: conv.sample_id, category: q.category,
      question: q.question, answer: q.category === 5 ? String(q.adversarial_answer ?? '') : String(q.answer), evidence: evidenceIds(q) });
  }));
  return out;
}

/** Embedding cache (shared across runs): vec(h) → Int8Array; ensureVecs embeds + caches the rest. */
export function openVecCache(getEmbedder, quantize) {
  mkdirSync(DATA, { recursive: true });
  const cache = new DatabaseSync(join(DATA, 'embed-cache.db'));
  cache.exec('CREATE TABLE IF NOT EXISTS vec (h TEXT PRIMARY KEY, v BLOB NOT NULL)');
  const get = cache.prepare('SELECT v FROM vec WHERE h = ?');
  const put = cache.prepare('INSERT OR REPLACE INTO vec (h, v) VALUES (?, ?)');
  let embedder = null;
  return {
    async ensureVecs(units) {
      const missing = [...new Map(units.map((u) => [vecKey(unitEmbedText(u)), unitEmbedText(u)])).entries()].filter(([h]) => !get.get(h));
      if (!missing.length) return 0;
      embedder ||= await getEmbedder({ allowRemote: true });
      if (!embedder) throw new Error('embedding model unavailable');
      for (let i = 0; i < missing.length; i += 16) {
        const chunk = missing.slice(i, i + 16);
        const vecs = await embedder(chunk.map((c) => c[1]));
        chunk.forEach(([h], j) => put.run(h, quantize(vecs[j])));
      }
      return missing.length;
    },
    vecOf(u) { const r = get.get(vecKey(unitEmbedText(u))); return r ? new Int8Array(r.v.buffer, r.v.byteOffset, r.v.byteLength) : null; },
  };
}
