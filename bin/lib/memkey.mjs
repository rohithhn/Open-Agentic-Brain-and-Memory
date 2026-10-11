// The memory key — bin/lib/memkey.mjs
//
// What "the same memory" means (dedupe.mjs has the whole story) and the
// read-side collapse every reader applies. Zero imports beyond node:crypto, so
// the SessionStart hook (sessionstart.mjs) can use it without pulling in
// config paths.
import { createHash } from 'node:crypto';

// ── normalization ───────────────────────────────────────────────────────────

const TRAILING_PUNCT = /[\s.,;:!?…。]+$/u;

/** Case, compatibility forms, whitespace runs and trailing punctuation folded.
 *  Nothing else: every word, digit and symbol inside stays significant. */
export function normText(s) {
  if (s == null) return '';
  return String(s).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase().replace(TRAILING_PUNCT, '');
}

/** A facts cell (JSON array of strings, or a plain string on foreign rows) as a
 *  sorted set of normalized facts. Order and repeats do not change a memory. */
export function factSet(cell) {
  if (cell == null || cell === '') return [];
  let list;
  if (Array.isArray(cell)) list = cell;
  else {
    try {
      const v = JSON.parse(String(cell));
      list = Array.isArray(v) ? v : [String(cell)];
    } catch { list = [String(cell)]; }
  }
  return [...new Set(list.map((f) => normText(typeof f === 'string' ? f : JSON.stringify(f))).filter(Boolean))].sort();
}

/**
 * The content identity of one row: a 32-hex digest, or null when the row has
 * nothing to compare on. Project is NOT part of it — callers pair it with the
 * project (keyed()).
 */
export function memoryKey(row) {
  if (!row) return null;
  const title = normText(row.title);
  const subtitle = normText(row.subtitle);
  const narrative = normText(row.narrative);
  const facts = factSet(row.facts);
  // Raw `text` is the content only of a row that has nothing distilled: a
  // distilled row keeps its source transcript in `text` for audit, and two
  // sessions distilled to the same memory are the same memory.
  const text = !narrative && !facts.length ? normText(row.text) : '';
  if (!title && !narrative && !facts.length && !text) return null;
  return createHash('sha256').update(JSON.stringify([title, subtitle, facts, narrative, text]), 'utf8').digest('hex').slice(0, 32);
}

export const keyed = (project, key) => (key ? `${project ?? ''}\u0000${key}` : null);

// The columns memoryKey reads. `text` only where it can count (no narrative):
// raw transcripts are large and a distilled row never needs its own.
export const KEY_COLS = (a = 'o') =>
  `${a}.title AS dd_title, ${a}.subtitle AS dd_subtitle, ${a}.facts AS dd_facts, ${a}.narrative AS dd_narrative, ` +
  `CASE WHEN TRIM(COALESCE(${a}.narrative, '')) = '' THEN ${a}.text END AS dd_text`;
export const fromKeyCols = (r) => ({ title: r.dd_title, subtitle: r.dd_subtitle, facts: r.dd_facts, narrative: r.dd_narrative, text: r.dd_text });

// ── read side ───────────────────────────────────────────────────────────────

/**
 * One row per memory, in the given order: a row whose project + content key
 * was already seen is dropped; everything else is kept as it is. Rows need
 * `id` and `project`; their content is read here (only for rows that share a
 * project and a normalized title with another row in the list — the cheap
 * necessary condition — so a list with no candidate twins costs no query).
 * Never drops a row it cannot read, and never throws: on any failure the
 * input comes back unchanged (capped at `limit`).
 */
export function collapseDuplicates(db, rows, { limit = Infinity } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const cap = (a) => (Number.isFinite(limit) ? a.slice(0, Math.max(0, limit)) : a);
  if (list.length < 2) return cap(list);
  try {
    const byTitle = new Map();
    for (const r of list) {
      const k = `${r.project ?? ''}\u0000${normText(r.title)}`;
      byTitle.set(k, (byTitle.get(k) || 0) + 1);
    }
    const need = [...new Set(list.filter((r) => byTitle.get(`${r.project ?? ''}\u0000${normText(r.title)}`) > 1).map((r) => r.id))]
      .filter((id) => Number.isInteger(Number(id)));
    if (!need.length) return cap(list);
    const content = new Map();
    for (let i = 0; i < need.length; i += 400) {
      const ids = need.slice(i, i + 400);
      for (const c of db.prepare(`SELECT o.id, o.project, ${KEY_COLS('o')} FROM observations o WHERE o.id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
        content.set(c.id, keyed(c.project, memoryKey(fromKeyCols(c))));
      }
    }
    const seen = new Set();
    const out = [];
    for (const r of list) {
      const k = content.get(r.id);
      if (k) {
        if (seen.has(k)) continue;
        seen.add(k);
      }
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return cap(list);
  }
}
