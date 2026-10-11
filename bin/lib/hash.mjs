// content_hash — the identity every native observation is deduped and synced by.
//
// Two versions live side by side:
//
//   legacy (v1)  32-bit FNV-1a over the UTF-16 code units, as 8 hex digits, then
//                the input's length in hex: '4f9f2cab' + '5'. What ingest.mjs and
//                remember.mjs wrote before this module existed. 32 bits is a
//                birthday collision at ~65k distinct inputs per bucket — within
//                reach of one busy brain — and a collision under the unique
//                (memory_session_id, content_hash) index or the (project,
//                content_hash) dedupe silently drops the second memory.
//   strong (v2)  SHA-256 over the UTF-8 bytes, truncated to 128 bits: 32 lowercase
//                hex digits. Every NEW row gets this (contentHash()).
//
// The two never look alike: a legacy hash is 9..16 hex digits (8 + the length in
// hex), a strong one exactly 32, and claude-mem's own hashes (copied verbatim by
// import-claude-mem.mjs, never recomputed) are 16. Old rows keep their legacy
// hash until `brain migrate-hash --apply` rewrites them (migrate-hash.mjs); a
// migrated row remembers what it was in metadata.legacy_content_hash.
//
// Dedupe across the transition (sync / merge / restore — import-claude-mem.mjs
// and import.mjs — and brain_remember) compares a row under EVERY hash it is
// known by, not just the stored one (equivalentHashes / hashAliasIndex):
//   - the stored hash;
//   - when the row's content reproduces its stored hash (the recipe below), the
//     same content under the other version — so a migrated machine and one that
//     never migrated agree on the same memory;
//   - metadata.legacy_content_hash, for a migrated row whose content no longer
//     reproduces anything (curated after capture: an edit keeps content_hash).
// A match on a strong (128-bit) hash is taken as is. A match on a v1 (32-bit)
// hash is confirmed (sameUnderLegacy): when both rows' content reproduces it,
// that content must be identical, so a v1 collision never makes a NEW row look
// like an old, different one.
//
// "Reproduces" is checked, never assumed: the two inputs a native writer hashes
// are the row's raw transcript (`text`, ingest.mjs) and the canonical string of
// title/subtitle/facts/narrative (remember.mjs, distiller.mjs). A row whose
// content matches neither (claude-mem rows, edited rows, near-dup merges) is
// identified by its stored hash alone, exactly as before.
import { createHash } from 'node:crypto';

export const STRONG_HASH_RE = /^[0-9a-f]{32}$/;
const LEGACY_HASH_RE = /^[0-9a-f]{9,16}$/;
export const LEGACY_META_KEY = 'legacy_content_hash';

// v1 — byte-for-byte the FNV-1a ingest.mjs and remember.mjs always used. Kept
// only to recognise and translate old rows; nothing new is written with it.
export function legacyHash(str) {
  str = String(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8) + str.length.toString(16);
}

// v2 — the hash for every new row.
export function strongHash(str) {
  return createHash('sha256').update(String(str), 'utf8').digest('hex').slice(0, 32);
}
export const contentHash = strongHash;

export const isStrongHash = (h) => typeof h === 'string' && STRONG_HASH_RE.test(h);
// Shaped like a v1 hash. Shape alone proves nothing (claude-mem's 16-hex hashes
// fit it); reproduce() is what decides.
export const isLegacyShaped = (h) => typeof h === 'string' && LEGACY_HASH_RE.test(h) && !isStrongHash(h);
// The input length a v1 hash declares in its tail — a free pre-filter before
// running FNV over a candidate input.
const legacyLen = (h) => parseInt(h.slice(8), 16);

// ── canonical string (remember.mjs spec §2.3) ───────────────────────────────
export const normWs = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Fixed and positional: title, subtitle, facts (in order), narrative — each
// whitespace-normalized, newline-joined. `concepts` and `model` are excluded:
// they are metadata, and including them would let a re-capture with one extra
// tag masquerade as new content. MUST be called on an ALREADY-SCRUBBED observation.
export function canonicalString(obs) {
  const facts = Array.isArray(obs.facts) ? obs.facts.map(normWs).filter(Boolean) : [];
  return [normWs(obs.title), normWs(obs.subtitle), facts.join('\n'), normWs(obs.narrative)].join('\n');
}

function factsOf(cell) {
  if (Array.isArray(cell)) return cell;
  if (typeof cell !== 'string' || !cell) return [];
  try { const v = JSON.parse(cell); return Array.isArray(v) ? v : []; } catch { return []; }
}

// The inputs a native writer could have hashed for this stored row, cheapest first.
function* inputsOf(row) {
  if (typeof row.text === 'string') yield { recipe: 'text', input: row.text };
  yield {
    recipe: 'canonical',
    input: canonicalString({ title: row.title, subtitle: row.subtitle, facts: factsOf(row.facts), narrative: row.narrative }),
  };
}

/**
 * Which version and input the row's stored content_hash was computed from, or
 * null when its current content reproduces neither (foreign / edited / merged).
 * @returns {{version:'legacy'|'strong', recipe:'text'|'canonical', input:string}|null}
 */
export function reproduce(row) {
  const h = row?.content_hash;
  if (typeof h !== 'string' || !h) return null;
  if (isStrongHash(h)) {
    for (const c of inputsOf(row)) if (strongHash(c.input) === h) return { version: 'strong', ...c };
    return null;
  }
  if (!isLegacyShaped(h)) return null;
  const len = legacyLen(h);
  for (const c of inputsOf(row)) {
    if (c.input.length === len && legacyHash(c.input) === h) return { version: 'legacy', ...c };
  }
  return null;
}

// metadata.legacy_content_hash of a migrated row, or null.
export function legacyFromMetadata(metadata) {
  if (typeof metadata !== 'string' || !metadata.includes(LEGACY_META_KEY)) return null;
  try {
    const v = JSON.parse(metadata)?.[LEGACY_META_KEY];
    return isLegacyShaped(v) ? v : null;
  } catch { return null; }
}

// Every OTHER hash this row is known under (its stored hash excluded).
export function equivalentHashes(row) {
  const out = new Set();
  const r = reproduce(row);
  if (r?.version === 'legacy') out.add(strongHash(r.input));
  else if (r?.version === 'strong') out.add(legacyHash(r.input));
  const meta = legacyFromMetadata(row?.metadata);
  if (meta) out.add(meta);
  out.delete(row?.content_hash);
  return [...out];
}

// The inputs of `row` whose v1 hash is `h` — normally none or one.
export function legacyInputsFor(row, h) {
  if (!row || !isLegacyShaped(h)) return [];
  const len = legacyLen(h);
  const out = [];
  for (const c of inputsOf(row)) if (c.input.length === len && legacyHash(c.input) === h) out.push(c.input);
  return out;
}

// Does `row` itself carry v1 hash `h` — stored, or as metadata.legacy_content_hash?
const claimsLegacy = (row, h) => row?.content_hash === h || legacyFromMetadata(row?.metadata) === h;

/**
 * Are rows `a` and `b`, which meet on the v1 hash `h`, the same memory?
 *
 * v1 is 32 bits, so meeting on it proves little. When both rows' current
 * content still hashes to `h`, that content must be identical — a v1 collision
 * between two different memories is told apart here. When either row's content
 * no longer reproduces `h` (curated or merged after capture), there is nothing
 * to compare, and the match stands only if BOTH rows carry `h` themselves
 * (stored, or remembered by `brain migrate-hash`): that is the identity two old
 * rows always had. A v1 hash merely COMPUTED from a new row's content is never
 * enough on its own — otherwise every new row would inherit v1's collisions.
 */
export function sameUnderLegacy(a, b, h) {
  const ia = legacyInputsFor(a, h), ib = legacyInputsFor(b, h);
  if (ia.length && ib.length) return ia.some((x) => ib.includes(x));
  return claimsLegacy(a, h) && claimsLegacy(b, h);
}

const SEP = '\u0000';
const CAND_LIMIT = 50;
/**
 * "Does `db` already hold this incoming observation under another version of
 * its hash?" — the merge paths ask this after the stored-hash lookups miss.
 * Matches by (memory_session_id, hash) and, with byProject, (project, hash) —
 * the same two keys the merge already dedupes on. A strong (128-bit) key match
 * is trusted; a v1 (32-bit) key match is confirmed row by row with
 * sameUnderLegacy(). Rows that only a migrated row's metadata still names are
 * indexed once up front (one scan per merge).
 */
export function hashAliasIndex(db, { byProject = true } = {}) {
  const cols = new Set(db.prepare('PRAGMA table_info(observations)').all().map((c) => c.name));
  if (!cols.has('content_hash')) return { has: () => false, note: () => {} };
  const sel = ['id', 'memory_session_id', 'project', 'content_hash', 'text', 'title', 'subtitle', 'facts', 'narrative', 'metadata']
    .map((c) => (cols.has(c) ? c : `NULL AS ${c}`)).join(', ');
  const bySession = db.prepare(`SELECT ${sel} FROM observations WHERE memory_session_id IS ? AND content_hash = ? LIMIT ${CAND_LIMIT}`);
  const byProj = byProject ? db.prepare(`SELECT ${sel} FROM observations WHERE project IS ? AND content_hash = ? LIMIT ${CAND_LIMIT}`) : null;
  const byId = db.prepare(`SELECT ${sel} FROM observations WHERE id = ?`);
  // key → rows naming that v1 hash in metadata: {destId} for rows scanned here
  // (fetched when needed), the row itself for rows noted during this merge.
  const aliases = new Map();
  const add = (k, e) => { const l = aliases.get(k); if (l) l.push(e); else aliases.set(k, [e]); };
  const index = (row, entry) => {
    const l = legacyFromMetadata(row?.metadata);
    if (!l) return;
    add(`s${SEP}${row.memory_session_id ?? ''}${SEP}${l}`, entry);
    if (byProject) add(`p${SEP}${row.project ?? ''}${SEP}${l}`, entry);
  };
  if (cols.has('metadata')) {
    for (const r of db.prepare(`SELECT id, memory_session_id, project, metadata FROM observations WHERE metadata LIKE '%${LEGACY_META_KEY}%'`).iterate()) {
      index(r, { destId: r.id });
    }
  }
  const resolve = (e) => (e.destId != null ? byId.get(e.destId) : e);
  const aliasedRows = (row, h) => [
    ...(aliases.get(`s${SEP}${row.memory_session_id ?? ''}${SEP}${h}`) || []),
    ...(byProject ? aliases.get(`p${SEP}${row.project ?? ''}${SEP}${h}`) || [] : []),
  ];
  const legacyHit = (row, h, stored) => {
    for (const e of aliasedRows(row, h)) {
      const d = resolve(e);
      if (d && sameUnderLegacy(row, d, h)) return true;
    }
    if (!stored) return false;
    for (const d of bySession.all(row.memory_session_id ?? null, h)) if (sameUnderLegacy(row, d, h)) return true;
    if (byProj) for (const d of byProj.all(row.project ?? null, h)) if (sameUnderLegacy(row, d, h)) return true;
    return false;
  };
  const has = (row) => {
    if (!row) return false;
    const own = row.content_hash;
    const rep = reproduce(row);
    // The same content under the strong hash: 128 bits, a key match is the row.
    if (rep?.version === 'legacy') {
      const s = strongHash(rep.input);
      if (bySession.get(row.memory_session_id ?? null, s)) return true;
      if (byProj && byProj.get(row.project ?? null, s)) return true;
    }
    // v1 keys: the row's own (stored rows with it were already looked up by the
    // caller — only metadata aliases are left), its metadata alias, and the v1
    // hash of a strong row's content. Each candidate is confirmed.
    if (isLegacyShaped(own) && legacyHit(row, own, false)) return true;
    const keys = new Set();
    const meta = legacyFromMetadata(row.metadata);
    if (meta) keys.add(meta);
    if (rep?.version === 'strong') keys.add(legacyHash(rep.input));
    keys.delete(own);
    for (const h of keys) if (legacyHit(row, h, true)) return true;
    return false;
  };
  // A row just inserted by the merge: index its metadata alias, if any.
  const note = (row) => index(row, row);
  return { has, note };
}
