// Long-session segmentation + the full-transcript side store.
//
// Why this exists
// ---------------
// ingest keeps only the first TRANSCRIPT_CAP (8000) chars of a session in the
// observation row, and the distiller used to send the first 6000 of those to the
// model and keep ONE observation per session. A multi-day Claude Code session
// (millions of chars) therefore became a single memory about its opening topic.
//
// The design (see also distiller.mjs "SEGMENTS"):
//   * ingest additionally stores the FULL scrubbed transcript of any session
//     longer than the cap in `session_transcripts` (gzip BLOB, one row per
//     session, only rewritten when the session grew). The observation row is
//     untouched — text stays clipped at 8000, so the growth/recapture/dedupe
//     machinery that depends on it is unchanged.
//   * the distiller cuts that text into segments of ~DEFAULTS.transcriptChars at
//     natural boundaries and distils one observation per segment.
//
// This module is pure (segmentation) plus a few DB helpers for the side table.
// Node built-ins only. It never opens a database by itself.
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tableExists } from './db.mjs';
import { isSelfObservationRow } from './selfcapture.mjs';

export const SEGMENT_BUDGET = 6000; // mirrors distiller DEFAULTS.transcriptChars (callers pass theirs)

// ── message / unit splitting ─────────────────────────────────────────────────
// A transcript is `role: text` messages joined by a blank line. A message
// starts at a blank line followed by `<role>: ` (user / assistant / gemini /
// tool / info …). A message body that itself contains such a line is split
// there too — harmless: the cut is still on a blank line.
const MSG_START_RE = /\n\n(?=[a-z]{3,10}: )/g;

// What Claude Code writes when the context was compacted: the summary replayed
// as a user turn, or the /compact command itself.
export const COMPACT_RE = /^user: (?:This session is being continued from a previous conversation|<command-name>\/compact<\/command-name>|<command-message>compact<\/command-message>)/;
export const isCompactBoundary = (messageText) => COMPACT_RE.test(messageText);

const isUserTurn = (text, start) => text.startsWith('user: ', start);

/** Message ranges [{start,end,user,compact}] — end exclusive, separators excluded. */
export function splitMessages(text) {
  const out = [];
  let start = 0;
  MSG_START_RE.lastIndex = 0;
  let m;
  while ((m = MSG_START_RE.exec(text))) {
    out.push({ start, end: m.index });
    start = m.index + 2;
  }
  out.push({ start, end: text.length });
  for (const r of out) {
    r.user = isUserTurn(text, r.start);
    r.compact = r.user && COMPACT_RE.test(text.slice(r.start, r.start + 160));
  }
  return out;
}

// One message longer than the budget is split into pieces of at most `budget`
// chars, each cut at the last newline (else space) in the back half of its
// window; a hard cut only when there is neither. Pieces after the first are
// continuations (not a turn start).
function pieces(text, r, budget) {
  const out = [];
  let s = r.start;
  let first = true;
  while (r.end - s > budget) {
    let cut = s + budget;
    const window = text.slice(s + Math.floor(budget / 2), cut);
    const nl = window.lastIndexOf('\n');
    const sp = window.lastIndexOf(' ');
    if (nl >= 0) cut = s + Math.floor(budget / 2) + nl + 1;
    else if (sp >= 0) cut = s + Math.floor(budget / 2) + sp + 1;
    out.push({ start: s, end: cut, user: first && r.user, compact: first && r.compact, cont: !first });
    s = cut;
    first = false;
  }
  out.push({ start: s, end: r.end, user: first && r.user, compact: first && r.compact, cont: !first });
  return out;
}

/** Stable id: `<index>-<sha1 of the segment's first 256 chars, 10 hex>`. */
export const segmentId = (index, segText) =>
  `${index}-${createHash('sha1').update(String(segText).slice(0, 256), 'utf8').digest('hex').slice(0, 10)}`;

// ts of the message a segment starts in: the last mark at or before `offset`.
function tsAt(marks, offset) {
  if (!Array.isArray(marks) || !marks.length) return null;
  let lo = 0, hi = marks.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid][0] <= offset) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const ms = marks[best >= 0 ? best : 0][1];
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/**
 * Cut a transcript into segments of at most `budget` chars. Deterministic and
 * prefix-stable: appending to the transcript never moves a boundary that was
 * already followed by more content, so every segment except the LAST keeps its
 * index, start offset and text forever (the last one — `closed:false` — is the
 * only one that can grow).
 *
 * Boundaries, in order of preference:
 *   1. a compact boundary (Claude Code's "session continued" summary / /compact)
 *      always starts a new segment once the current one holds >= 25% of budget;
 *   2. when the next message does not fit, the start of the last user turn in
 *      the second half of the segment (so a turn is not separated from its
 *      reply when avoidable);
 *   3. otherwise the start of the message that does not fit;
 *   4. a single message longer than the budget is split into budget-sized
 *      pieces at a newline/space.
 * @param {string} text
 * @param {{budget?:number, marks?:Array<[number,number]>|null, limit?:number}} [opts]
 *        limit: stop after this many segments (the rest of the text is not cut)
 * @returns {Array<{index:number,start:number,end:number,text:string,id:string,ts:string|null,closed:boolean}>}
 */
export function segmentTranscript(text, { budget = SEGMENT_BUDGET, marks = null, limit = Infinity } = {}) {
  text = String(text ?? '');
  budget = Math.max(200, budget | 0);
  if (!text) return [];
  const units = [];
  for (const r of splitMessages(text)) {
    if (r.end - r.start > budget) units.push(...pieces(text, r, budget));
    else units.push({ ...r, cont: false });
  }
  const segs = [];
  const emit = (a, b, closed) => {
    const t = text.slice(units[a].start, units[b].end);
    const index = segs.length;
    segs.push({
      index, start: units[a].start, end: units[b].end, text: t,
      id: segmentId(index, t), ts: tsAt(marks, units[a].start), closed,
    });
  };
  let a = 0; // first unit of the current segment
  let i = 0;
  while (i < units.length) {
    if (segs.length >= limit) return segs;
    const u = units[i];
    if (i > a) {
      const curLen = units[i - 1].end - units[a].start;
      const compactCut = u.compact && curLen >= budget * 0.25;
      if (compactCut || u.end - units[a].start > budget) {
        let cut = i; // first unit of the NEXT segment
        if (!compactCut) {
          for (let j = i - 1; j > a; j--) {
            if (units[j].user && units[j].start - units[a].start >= budget * 0.5) { cut = j; break; }
          }
        }
        emit(a, cut - 1, true);
        a = cut;
        i = cut; // re-evaluate the moved units against the new segment
        continue;
      }
    }
    i++;
  }
  if (segs.length < limit) emit(a, units.length - 1, false);
  return segs;
}

/** User prompts inside a segment (first 300 chars each) — the per-segment prompt digest. */
export function segmentPrompts(text, max = 20) {
  const out = [];
  for (const r of splitMessages(text)) {
    if (!r.user) continue;
    const t = text.slice(r.start + 6, r.end).replace(/\s+/g, ' ').trim();
    if (t && !/^<(command-|local-command|environment_context)/.test(t)) out.push(t.slice(0, 300));
    if (out.length >= max) break;
  }
  return out;
}

/** A segment that opens with one of the brain's own internal prompts (selfcapture.mjs). */
export const isSelfSegment = (segText) => isSelfObservationRow({ text: segText });

// ── side table ───────────────────────────────────────────────────────────────
export const TRANSCRIPT_TABLE = 'session_transcripts';
const DDL = `CREATE TABLE IF NOT EXISTS ${TRANSCRIPT_TABLE} (
  memory_session_id TEXT PRIMARY KEY,
  size INTEGER,        -- raw (pre-scrub) transcript length ingest last saw: the growth signal
  chars INTEGER,       -- scrubbed length actually stored
  updated_at INTEGER,  -- ms: when the stored text last changed (the idle clock)
  body BLOB,           -- gzip(utf8 scrubbed transcript)
  marks BLOB,          -- gzip(JSON [[charOffset, epochMs], ...]) one per message, or NULL
  done_size INTEGER    -- distiller: size at which it found nothing left to do (skip re-reading)
)`;

export const ensureTranscriptTable = (db) => { db.exec(DDL); };

/** The stored row's size/updated_at only (cheap), or null. */
export function transcriptMeta(db, mem) {
  if (!tableExists(db, TRANSCRIPT_TABLE)) return null;
  return db.prepare(`SELECT size, chars, updated_at, done_size FROM ${TRANSCRIPT_TABLE} WHERE memory_session_id = ?`).get(mem) || null;
}

/** Insert/replace a session's full transcript. `text` MUST already be scrubbed. */
export function saveTranscript(db, mem, { text, marks = null, size, now = Date.now() }) {
  ensureTranscriptTable(db);
  const body = gzipSync(Buffer.from(text, 'utf8'));
  const mk = marks && marks.length ? gzipSync(Buffer.from(JSON.stringify(marks), 'utf8')) : null;
  db.prepare(
    `INSERT INTO ${TRANSCRIPT_TABLE} (memory_session_id, size, chars, updated_at, body, marks, done_size)
     VALUES (?,?,?,?,?,?,NULL)
     ON CONFLICT(memory_session_id) DO UPDATE SET size = excluded.size, chars = excluded.chars,
       updated_at = excluded.updated_at, body = excluded.body, marks = excluded.marks, done_size = NULL`
  ).run(mem, size, text.length, now, body, mk);
}

/** {text, marks, size, updatedAt} or null (no table / no row / unreadable blob). */
export function loadTranscript(db, mem) {
  if (!tableExists(db, TRANSCRIPT_TABLE)) return null;
  const r = db.prepare(`SELECT size, updated_at, body, marks FROM ${TRANSCRIPT_TABLE} WHERE memory_session_id = ?`).get(mem);
  return r ? unpack(r) : null;
}

export function unpack(r) {
  try {
    const text = gunzipSync(Buffer.from(r.body)).toString('utf8');
    let marks = null;
    if (r.marks) { try { marks = JSON.parse(gunzipSync(Buffer.from(r.marks)).toString('utf8')); } catch { marks = null; } }
    return { text, marks, size: r.size, updatedAt: r.updated_at };
  } catch { return null; }
}
