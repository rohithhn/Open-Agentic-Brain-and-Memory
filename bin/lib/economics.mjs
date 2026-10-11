// Tokens-saved counter — the honest version.
//
// Every time the brain hands memories to a model (the SessionStart block, a
// brain_recall, a brain_context) we append ONE line to a ledger next to the
// store: which observations went out, what they cost to read, and what they
// cost to produce (their `discovery_tokens` — the work tokens the original
// session spent researching/building/deciding that, measured by the capturing
// tool, not guessed here). This module writes that ledger and turns it into
// the number shown in the control panel and the startup preview.
//
// METHOD (also the tooltip text, METHOD_SHORT below):
//   saved = work tokens of the memories delivered  -  tokens it cost to read them
// credited per delivery, with three guards so the figure cannot inflate:
//   1. A memory is credited at most once per local day, however many times it
//      is delivered — re-reading it the same day earns nothing new.
//   2. Memories with no measured work (discovery_tokens 0/NULL) earn nothing;
//      a delivery with no measured work at all is counted as "unmeasured",
//      never as a saving and never as a loss.
//   3. A delivery never counts below zero: if reading cost more than the
//      memories' work, the credit is 0 (we don't claim savings we can't show).
// It is an ESTIMATE: it assumes the delivered memory spared the model from
// re-deriving it, and read cost is chars/4. Both are stated wherever it's shown.
//
// Contract (same as the SessionStart hook that calls this): recording NEVER
// throws and never blocks — a read-only disk or a bad path just means no entry.
// Nothing here touches the store with a write handle.
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { openDb } from './db.mjs';

/** chars/4 — the same rule sessionstart.mjs uses for its read-cost figure. */
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

export const KINDS = ['startup', 'recall', 'context'];
const MAX_ITEMS = 120;            // ids kept per ledger line (keeps lines < ~3KB)
const MAX_LEDGER_BYTES = 16 * 1024 * 1024; // never parse more than this

export const METHOD_SHORT =
  'Estimate. For each memory the brain hands to a model: the work tokens its original session spent producing it ' +
  '(measured by the capturing tool) minus the tokens it costs to read (chars/4). A memory is credited once per day; ' +
  'memories with no measured work count for nothing.';

/** <dir>/brain.db -> <dir>/brain.economics.jsonl. Keyed by the store so a
 *  synthetic test store never shares a ledger with the real one. */
export function ledgerPathFor(dbPath) {
  if (!dbPath) return '';
  const base = basename(dbPath).replace(/\.db$/i, '');
  return join(dirname(dbPath), `${base}.economics.jsonl`);
}

/** id -> discovery_tokens for the given ids, on an already-open handle. */
export function workFor(db, ids) {
  const out = new Map();
  const want = [...new Set((ids || []).map(Number).filter(Number.isFinite))].slice(0, MAX_ITEMS);
  if (!want.length) return out;
  try {
    const rows = db.prepare(`SELECT id, discovery_tokens FROM observations WHERE id IN (${want.map(() => '?').join(',')})`).all(...want);
    for (const r of rows) out.set(r.id, Number(r.discovery_tokens) > 0 ? Math.floor(Number(r.discovery_tokens)) : 0);
  } catch { /* unreadable store: no work known -> nothing credited */ }
  return out;
}

/** workFor() on a fresh read-only handle for `dbPath`. */
export function lookupWork(dbPath, ids) {
  if (!dbPath || !existsSync(dbPath)) return new Map();
  let db;
  try { db = openDb(dbPath, { readonly: true }); return workFor(db, ids); }
  catch { return new Map(); }
  finally { try { db?.close(); } catch { /* */ } }
}

/**
 * Append one delivery to the ledger. Best-effort; returns true if written.
 * @param {object} o
 * @param {string} o.dbPath     the store the memories came from (locates the ledger)
 * @param {string} o.kind       'startup' | 'recall' | 'context'
 * @param {string} [o.project]
 * @param {Array<[number,number]>|Array<number>} o.items  [id, work] pairs, or bare ids (work is looked up)
 * @param {number} o.readTokens tokens the delivered text costs to read
 * @param {number} [o.now]      epoch ms (tests)
 */
export function recordDelivery({ dbPath, kind, project = '', items = [], readTokens = 0, now = Date.now() } = {}) {
  try {
    // The brain's own headless runs (distiller etc.) are not the user's work.
    if (process.env.BRAIN_DISTILLER === '1' || process.env.BRAIN_NO_ECONOMICS === '1') return false;
    const file = ledgerPathFor(dbPath);
    if (!file || !KINDS.includes(kind)) return false;
    let pairs;
    if (items.length && !Array.isArray(items[0])) {
      const w = lookupWork(dbPath, items);
      pairs = [...new Set(items.map(Number).filter(Number.isFinite))].map((id) => [id, w.get(id) || 0]);
    } else {
      pairs = items.map(([id, work]) => [Number(id), Number(work) > 0 ? Math.floor(Number(work)) : 0]).filter(([id]) => Number.isFinite(id));
    }
    pairs = pairs.slice(0, MAX_ITEMS);
    if (!pairs.length) return false;
    const read = Math.max(0, Math.floor(Number(readTokens) || 0));
    appendFileSync(file, `${JSON.stringify({ t: now, k: kind, p: String(project || '').slice(0, 80), r: read, i: pairs })}\n`);
    return true;
  } catch { return false; }
}

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** Monday of d's local week, as a day key. */
function weekKey(d) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return dayKey(m);
}

function readLedger(dbPath) {
  const file = ledgerPathFor(dbPath);
  try {
    if (!file || !existsSync(file) || statSync(file).size > MAX_LEDGER_BYTES) return [];
    const out = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e && Number.isFinite(e.t) && KINDS.includes(e.k) && Array.isArray(e.i)) out.push(e);
      } catch { /* a torn or hand-edited line is skipped, not fatal */ }
    }
    return out.sort((a, b) => a.t - b.t);
  } catch { return []; }
}

const zero = () => ({ saved: 0, work: 0, read: 0, deliveries: 0, unmeasured: 0 });

/**
 * Aggregate the ledger.
 * @returns {{estimate:true, method:string, since:string|null, deliveries:number,
 *   total:{saved,work,read,deliveries,unmeasured}, today, week, byKind, daily, weekly}}
 *   `today`/`week` are {saved,...}; `week` = the last 7 local days incl. today.
 *   `daily` = last 14 days, `weekly` = last 8 weeks (Mon-start), oldest first,
 *   zero-filled so a chart has no gaps.
 */
export function computeSavings({ dbPath, now = Date.now() } = {}) {
  const entries = readLedger(dbPath);
  const total = zero();
  const byKind = Object.fromEntries(KINDS.map((k) => [k, zero()]));
  const perDay = new Map();
  const perWeek = new Map();
  const credited = new Set(); // `${day}:${id}` — guard 1

  for (const e of entries) {
    const d = new Date(e.t);
    const day = dayKey(d);
    let work = 0, measured = false;
    for (const pair of e.i) {
      const id = pair[0], w = Number(pair[1]) > 0 ? Number(pair[1]) : 0;
      if (w > 0) measured = true;
      const key = `${day}:${id}`;
      if (w > 0 && !credited.has(key)) { credited.add(key); work += w; }
    }
    const read = Math.max(0, Number(e.r) || 0);
    const bucket = byKind[e.k];
    if (!measured) { total.unmeasured++; bucket.unmeasured++; continue; }
    const saved = Math.max(0, work - read); // guard 3
    for (const b of [total, bucket]) { b.saved += saved; b.work += work; b.read += read; b.deliveries++; }
    perDay.set(day, (perDay.get(day) || 0) + saved);
    const wk = weekKey(d);
    perWeek.set(wk, (perWeek.get(wk) || 0) + saved);
  }

  const nowD = new Date(now);
  const todayKey = dayKey(nowD);
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() - i);
    daily.push({ day: dayKey(d), saved: perDay.get(dayKey(d)) || 0 });
  }
  const weekly = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() - 7 * i);
    const k = weekKey(d);
    weekly.push({ week: k, saved: perWeek.get(k) || 0 });
  }
  const last7 = daily.slice(-7).reduce((s, x) => s + x.saved, 0);
  return {
    estimate: true,
    method: METHOD_SHORT,
    since: entries.length ? dayKey(new Date(entries[0].t)) : null,
    deliveries: entries.length,
    total, byKind,
    today: { saved: perDay.get(todayKey) || 0 },
    week: { saved: last7 },
    daily, weekly,
  };
}

/** 1,234 -> "1.2k", 3_400_000 -> "3.4M" — for the one-line startup message. */
export function compactTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(v);
}

/** The one startup line, or '' when there is nothing true to say yet. */
export function savingsLine(s) {
  if (!s || !s.total || !(s.total.saved > 0)) return '';
  const parts = [`~${compactTokens(s.total.saved)} tokens saved so far`];
  if (s.today.saved > 0) parts.push(`${compactTokens(s.today.saved)} today`);
  if (s.week.saved > s.today.saved) parts.push(`${compactTokens(s.week.saved)} this week`);
  return `${parts.join(' · ')} (estimate)`;
}
