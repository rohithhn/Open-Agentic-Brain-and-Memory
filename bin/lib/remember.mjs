// MCP write path — `brain_remember`.
//
// Implements docs/specs/mcp-memory-server.md §2 (write path, exactly in order),
// §3 (provenance) and §5 (two-level dedupe). This module owns the *semantics* of
// a model-authored memory write; bin/mcp-server.mjs (T3) owns the JSON-RPC
// protocol around it and calls the async API at the bottom of this file.
//
// Five non-negotiables, all encoded here:
//
//   1. VALIDATE → SCRUB → HASH, in that order. scrubObservation() runs after
//      schema validation and strictly BEFORE canonicalHash(), so content_hash is
//      always the hash of the text we actually store. Hash-then-scrub desyncs the
//      two and silently corrupts dedup (secret-scrubber.md §5.3 P1 / §5.4.7).
//   2. Dedupe cannot inflate counts. The exact key is (project, content_hash)
//      across ALL sessions — the session-scoped unique index cannot help, because
//      every app launch is a fresh server process with a fresh session id.
//      The same memory in different bytes (case, spacing, trailing
//      punctuation, fact order — dedupe.mjs memoryKey) is a duplicate too, at
//      any age. A near-duplicate (same title within 72h) merges into the existing row and
//      APPENDS the incoming facts it lacks (<= 12 facts, <= 500 chars each). The
//      row's content_hash is deliberately left as first written: it is the row's
//      dedupe/sync identity (same policy as curation edits and scrub rewrites),
//      not a live digest of the merged text.
//   3. Provenance is permanently distinguishable: generated_by_model is always
//      'mcp/'-prefixed, disjoint from every value claude-mem/ingest ever writes.
//   4. Never throw at the caller. This runs inside someone's live chat: every
//      failure path returns a structured { ok: false, ... } result.
//   5. Never write to stdout. Diagnostics go to stderr only — the caller is a
//      stdio MCP server where stdout is the JSON-RPC channel.
//
// Zero runtime dependencies (node:crypto + node:sqlite via db.mjs).
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { openDb, tableExists } from './db.mjs';
import { MEMORY_DB, sanitizeName } from './paths.mjs';
import { scrubObservationWithHits } from './scrub.mjs';
import { supersedeOlder, liveOnly, hasLifecycle, isHiddenStatus } from './lifecycle.mjs';
import { findHeldDuplicate, bumpRelevance } from './dedupe.mjs';
import { strongHash, legacyHash, canonicalString, normWs, legacyInputsFor } from './hash.mjs';

// ─────────────────────────── Tool surface (spec §1.1) ────────────────────────

// The `type` vocabulary measured against the live store — discovery, change,
// bugfix, feature, refactor, decision. Keeping the enum equal to what the corpus
// already contains is what lets MCP rows rank and filter alongside every other row.
export const OBSERVATION_TYPES = ['discovery', 'change', 'bugfix', 'feature', 'refactor', 'decision'];

// Verbatim from spec §1.1 — the description IS the trigger, so it is data, not prose.
export const REMEMBER_TOOL_DESCRIPTION =
  "Save one distilled observation to the user's cross-tool memory. Call it as soon as the " +
  'conversation settles something worth keeping — a decision, bugfix, discovery, or stated ' +
  "preference — without waiting to be asked, and whenever the user says 'remember this'. In chat " +
  'apps nothing is saved unless you call this. One call per distinct outcome; do not capture ' +
  'small talk or restate what you already saved.';

export const LIMITS = {
  title: { min: 8, max: 200 },
  subtitle: { max: 300 },
  project: { max: 120 },
  fact: { max: 500 },
  facts: { min: 1, max: 12 },
  narrative: { max: 2000 },
  concept: { max: 40 },
  concepts: { max: 10 },
  model: { max: 80 },
};

export const REMEMBER_INPUT_SCHEMA = {
  type: 'object',
  required: ['title', 'project', 'type', 'facts'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: LIMITS.title.min, maxLength: LIMITS.title.max },
    subtitle: { type: 'string', maxLength: LIMITS.subtitle.max },
    project: { type: 'string', maxLength: LIMITS.project.max },
    type: { enum: OBSERVATION_TYPES },
    facts: {
      type: 'array',
      minItems: LIMITS.facts.min,
      maxItems: LIMITS.facts.max,
      items: { type: 'string', maxLength: LIMITS.fact.max },
    },
    narrative: { type: 'string', maxLength: LIMITS.narrative.max },
    concepts: { type: 'array', maxItems: LIMITS.concepts.max, items: { type: 'string', maxLength: LIMITS.concept.max } },
    model: { type: 'string', maxLength: LIMITS.model.max },
  },
};

export const REMEMBER_TOOL = {
  name: 'brain_remember',
  description: REMEMBER_TOOL_DESCRIPTION,
  inputSchema: REMEMBER_INPUT_SCHEMA,
};

// Marker concept appended to every MCP-captured row — one greppable token for
// eval and for the documented purge escape hatch (spec §3, §4).
export const MCP_CAPTURE_CONCEPT = 'mcp-capture';
export const MODEL_PREFIX = 'mcp/';
export const NEAR_DUP_WINDOW_MS = 72 * 60 * 60 * 1000;

// ─────────────────────────── Validation (spec §2.1) ──────────────────────────

const isStr = (v) => typeof v === 'string';

// Hand-rolled, zero-dep JSON Schema check over REMEMBER_INPUT_SCHEMA. Returns
// every violation at once (a model fixes more per retry that way) and NEVER
// echoes a field's value back — the value may be the credential we are about to
// scrub. Field names and limits only.
export function validateObservation(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['input must be a JSON object'], value: null };
  }

  const allowed = new Set(Object.keys(REMEMBER_INPUT_SCHEMA.properties));
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) errors.push(`unknown property "${k}" (allowed: ${[...allowed].join(', ')})`);
  }

  const str = (name, { required = false, min = 0, max = Infinity }) => {
    const raw = input[name];
    if (raw === undefined || raw === null) {
      if (required) errors.push(`"${name}" is required`);
      return undefined;
    }
    if (!isStr(raw)) { errors.push(`"${name}" must be a string`); return undefined; }
    const v = raw.trim();
    if (required && !v) { errors.push(`"${name}" must not be empty`); return undefined; }
    if (v.length < min) errors.push(`"${name}" must be at least ${min} characters`);
    if (v.length > max) errors.push(`"${name}" must be at most ${max} characters`);
    return v;
  };

  const title = str('title', { required: true, min: LIMITS.title.min, max: LIMITS.title.max });
  const subtitle = str('subtitle', { max: LIMITS.subtitle.max });
  const project = str('project', { required: true, min: 1, max: LIMITS.project.max });
  const narrative = str('narrative', { max: LIMITS.narrative.max });
  const model = str('model', { max: LIMITS.model.max });

  const type = input.type;
  if (type === undefined || type === null) errors.push('"type" is required');
  else if (!isStr(type) || !OBSERVATION_TYPES.includes(type)) {
    errors.push(`"type" must be one of: ${OBSERVATION_TYPES.join(', ')}`);
  }

  let facts;
  if (!Array.isArray(input.facts)) {
    errors.push('"facts" must be an array of strings');
  } else {
    facts = input.facts.map((f) => (isStr(f) ? f.trim() : f)).filter((f) => !(isStr(f) && f === ''));
    if (input.facts.some((f) => !isStr(f))) errors.push('"facts" items must be strings');
    if (facts.length < LIMITS.facts.min) errors.push(`"facts" must contain at least ${LIMITS.facts.min} non-empty item`);
    if (facts.length > LIMITS.facts.max) errors.push(`"facts" must contain at most ${LIMITS.facts.max} items`);
    if (facts.some((f) => isStr(f) && f.length > LIMITS.fact.max)) {
      errors.push(`each "facts" item must be at most ${LIMITS.fact.max} characters`);
    }
  }

  let concepts = [];
  if (input.concepts !== undefined && input.concepts !== null) {
    if (!Array.isArray(input.concepts)) {
      errors.push('"concepts" must be an array of strings');
    } else {
      concepts = input.concepts.map((c) => (isStr(c) ? c.trim() : c)).filter((c) => !(isStr(c) && c === ''));
      if (input.concepts.some((c) => !isStr(c))) errors.push('"concepts" items must be strings');
      if (concepts.length > LIMITS.concepts.max) errors.push(`"concepts" must contain at most ${LIMITS.concepts.max} items`);
      if (concepts.some((c) => isStr(c) && c.length > LIMITS.concept.max)) {
        errors.push(`each "concepts" item must be at most ${LIMITS.concept.max} characters`);
      }
    }
  }

  if (errors.length) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: [],
    value: { title, subtitle, project, type, facts, narrative, concepts, model },
  };
}

// ─────────────────────────── Canonical hash (spec §2.3) ──────────────────────

// The hash itself lives in hash.mjs (shared with ingest.mjs, the merge paths and
// `brain migrate-hash`). New rows get the strong v2 hash (SHA-256/128); fnvHash
// is the v1 FNV-1a every row was hashed with before, kept so a dedupe can still
// recognise a memory captured by an older build.
export { legacyHash as fnvHash, canonicalString } from './hash.mjs';

// The canonical string (title, subtitle, facts, narrative — whitespace-normalized,
// concepts/model excluded) is defined in hash.mjs. MUST be called on an
// ALREADY-SCRUBBED observation.
export function canonicalHash(obs) {
  return strongHash(canonicalString(obs));
}
// The same content under the v1 hash — what an older build stored for it.
export function legacyCanonicalHash(obs) {
  return legacyHash(canonicalString(obs));
}

// Near-dup key (spec §5.2): lowercased, whitespace-collapsed title.
export function normalizeTitle(t) {
  return normWs(t).toLowerCase();
}

// Near-dup merge of `facts` (spec §5.2): append the incoming facts that the
// existing row does not already carry. Comparison is whitespace-collapsed and
// case-insensitive, the same normalization as the title key, so a re-worded
// capital letter does not re-add a fact. Existing facts are never reordered,
// edited or dropped; new ones are capped at LIMITS.fact.max chars each and the
// list at LIMITS.facts.max items (anything beyond the cap is dropped, not
// queued — the row stays inside the same schema a fresh write is held to).
// Pure: returns { facts, added, dropped } and mutates nothing.
export function mergeFacts(existing, incoming) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(out.map((f) => normWs(f).toLowerCase()));
  let added = 0;
  let dropped = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (typeof raw !== 'string') continue;
    const f = raw.trim().slice(0, LIMITS.fact.max);
    const key = normWs(f).toLowerCase();
    if (!key || seen.has(key)) continue;
    if (out.length >= LIMITS.facts.max) { dropped++; continue; }
    seen.add(key);
    out.push(f);
    added++;
  }
  return { facts: out, added, dropped };
}

// Parse an observations.facts cell. Returns an array of strings, or null when the
// cell is not a JSON array of strings (older / foreign rows) — the merge then
// leaves the facts alone rather than guess at a format.
function parseFactsCell(cell) {
  if (cell == null || cell === '') return [];
  try {
    const v = JSON.parse(String(cell));
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
  } catch { return null; }
}

// ─────────────────────────── Provenance (spec §3) ────────────────────────────

// clientInfo.name from the MCP `initialize` request → platform_source. Exact,
// observed names are resolved first; substring matching is only the fallback for
// names we have not seen. The order matters because "claude" is a substring of
// BOTH Claude clients, and they need opposite instructions (Claude Code is
// captured from its transcripts, Claude Desktop is not):
//   claude-ai                        Claude Desktop / claude.ai chat (observed in
//                                    ~/Library/Logs/Claude/mcp-server-*.log)
//   claude-code                      Claude Code CLI and IDE extension (observed in
//                                    ~/Library/Caches/claude-cli-nodejs/*/mcp-logs-*)
//   local-agent-mode-<server>        Claude Desktop's own agent mode (Cowork). The
//                                    desktop main.log shows it is driven by its
//                                    LocalAgentModeSessionManager, NOT by Claude
//                                    Code, and no ingest parser reads its sessions,
//                                    so it is claude_desktop_agent: desktop-style
//                                    save instructions, distilled by claude.
//   codex-mcp-client                 Codex CLI / app
// Anything unrecognised becomes mcp_<sanitized> rather than being folded into an
// existing bucket — a wrong attribution is worse than an unfamiliar one, and this
// column is what `brain doctor`'s per-source freshness reads.
const PLATFORM_EXACT = new Map([
  ['claude-ai', 'claude_desktop'],
  ['claude desktop', 'claude_desktop'],
  ['claude-desktop', 'claude_desktop'],
  ['claude-code', 'claude_code'],
  ['claude code', 'claude_code'],
  ['codex-mcp-client', 'codex'],
  ['codex-cli', 'codex'],
  // Kilo's MCP client (packages/opencode/src/mcp/index.ts) announces itself as plain "kilo".
  ['kilo', 'kilo'],
]);

// Substring fallback, first match wins: more specific signals before the bare
// 'claude' (an unknown claude* name still falls to the desktop bucket, which
// gets the more insistent save instructions — the safe default).
const PLATFORM_MATCHERS = [
  ['chatgpt', 'chatgpt_desktop'],
  ['local-agent-mode', 'claude_desktop_agent'],
  ['claude-code', 'claude_code'],
  ['claude code', 'claude_code'],
  ['claude', 'claude_desktop'],
  ['codex', 'codex'],
  ['cursor', 'cursor'],
  ['antigravity', 'antigravity'],
  ['kilo', 'kilo'],
];

export function platformSourceFor(clientName) {
  const raw = normWs(clientName);
  if (!raw) return 'mcp_unknown';
  const lower = raw.toLowerCase();
  const exact = PLATFORM_EXACT.get(lower);
  if (exact) return exact;
  if (lower.startsWith('local-agent-mode')) return 'claude_desktop_agent';
  for (const [needle, source] of PLATFORM_MATCHERS) {
    if (lower.includes(needle)) return source;
  }
  const slug = sanitizeName(lower).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return 'mcp_' + (slug || 'unknown');
}

// generated_by_model is ALWAYS mcp/-prefixed. The live store's six existing
// values (claude-haiku-4-5-20251001, haiku, gemini, cursor, codex, antigravity,
// plus 'claude') contain no '/', so `LIKE 'mcp/%'` selects exactly the
// model-authored rows, forever — that is the documented purge/eval handle.
export function modelProvenance({ model, clientName } = {}) {
  let id = normWs(model) || normWs(clientName) || 'unknown';
  if (id.startsWith(MODEL_PREFIX)) id = id.slice(MODEL_PREFIX.length);
  // Strip control characters only — hyphens/dots are part of real model ids
  // (mcp/claude-opus-4-6) and must survive verbatim.
  id = id.replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'unknown';
  return MODEL_PREFIX + id.slice(0, LIMITS.model.max);
}

// ─────────────────────────── Session identity (spec §2.5) ────────────────────

// One sdk_sessions row per server process, minted at `initialize`. T3 calls this
// once and passes the result to every rememberObservation() call; a caller that
// passes nothing gets the lazily-minted per-process session below, so writes
// from one process still group into one session instead of 20 orphan ones.
export function newMcpSession(platformSource = 'mcp_unknown', now = Date.now()) {
  const contentSessionId = `mcp-${now}-${randomBytes(3).toString('hex')}`;
  return {
    contentSessionId,
    memorySessionId: `mcp:${platformSource}:${contentSessionId}`,
    platformSource,
    startedAtEpoch: now,
  };
}

// Deterministic sibling of a process session, scoped to one project. Only used
// on the rare path where the store's session-scoped unique index
// (memory_session_id, content_hash) blocks byte-identical content that legitimately
// belongs to a second project — our dedupe key is (project, content_hash), and
// the canonical hash is content-only by design (spec §2.3), so the two disagree
// exactly there. Being deterministic means repeat writes reuse this row rather
// than growing a session per call.
export function projectScopedSession(session, project) {
  const slug =
    sanitizeName(String(project || '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'p';
  const contentSessionId = `${session.contentSessionId}-${slug}`;
  return {
    contentSessionId,
    memorySessionId: `mcp:${session.platformSource}:${contentSessionId}`,
    platformSource: session.platformSource,
    startedAtEpoch: session.startedAtEpoch,
  };
}

// Deterministic sibling of a process session for re-saying a memory the user
// deleted (writeOnce case c). '~' never appears in a projectScopedSession slug,
// so the two kinds of sibling cannot collide.
export function resaidSession(session, n) {
  const contentSessionId = `${session.contentSessionId}~r${n}`;
  return {
    contentSessionId,
    memorySessionId: `mcp:${session.platformSource}:${contentSessionId}`,
    platformSource: session.platformSource,
    startedAtEpoch: session.startedAtEpoch,
  };
}

let processSessionCache = null;
export function processSession(platformSource = 'mcp_unknown', now = Date.now()) {
  if (!processSessionCache || processSessionCache.platformSource !== platformSource) {
    processSessionCache = newMcpSession(platformSource, now);
  }
  return processSessionCache;
}
export function resetProcessSession() { processSessionCache = null; } // tests only

// ─────────────────────────── Error shaping (spec §7) ─────────────────────────

// Every result — success or failure — is a plain object. Nothing here throws.
const err = (code, message, extra = {}) => ({ ok: false, saved: false, status: 'error', code, error: message, ...extra });

const BUSY_RE = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked|database schema is locked/i;
function isBusyError(e) {
  if (!e) return false;
  if (e.errcode === 5 || e.errcode === 6) return true; // SQLITE_BUSY / SQLITE_LOCKED
  return BUSY_RE.test(String(e.message || '')) || BUSY_RE.test(String(e.code || ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// stderr only. Never stdout (it is the JSON-RPC channel), never a value.
function defaultLog(msg) {
  try { process.stderr.write(`[brain_remember] ${msg}\n`); } catch {}
}

// ─────────────────────────── The write (spec §2 / §5) ────────────────────────

// The whole DB interaction for one call, on one freshly-opened connection.
// Synchronous by nature (node:sqlite is sync); the async wrapper around it owns
// retry/backoff so the lock is held for the minimum possible time.
function writeOnce(scrubbed, ctx) {
  const { dbPath, session, generatedByModel, now, nowIso, busyTimeoutMs } = ctx;
  const db = openDb(dbPath);
  try {
    // A busy_timeout lets SQLite itself absorb short contention from claude-mem's
    // concurrent writer before we fall back to our own retry loop.
    try { db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) || 0}`); } catch {}
    if (!tableExists(db, 'observations') || !tableExists(db, 'sdk_sessions')) {
      return err('not_initialized', 'brain not initialized — run: brain onboard');
    }

    const project = scrubbed.project;
    const contentHash = ctx.contentHash;
    // A row the user deleted in the control panel is not a memory any more:
    // it must not swallow a fresh write as its "duplicate" (the new memory
    // would be lost behind a hidden row). Dedupe against live rows only.
    const live = liveOnly(db, 'observations');

    // §5.1 Exact duplicate — same project, same canonical hash, ANY session, any
    // age. Re-capture becomes a relevance signal, never a second row. A row an
    // older build captured carries the v1 hash of the same canonical string
    // (hash.mjs) until `brain migrate-hash` rewrites it, so that is matched too —
    // but v1 is only 32 bits, so a v1 hit counts only when that row's content
    // still hashes to it from this very canonical string. A v1 collision with a
    // different memory must not swallow this one as its "duplicate" (nor a v1
    // row curated since capture: its content is no longer this memory's).
    let exact = db
      .prepare(`SELECT id FROM observations WHERE project = ? AND content_hash = ?${live} ORDER BY id LIMIT 1`)
      .get(project, contentHash);
    if (!exact && ctx.legacyHash && typeof ctx.canonical === 'string') {
      exact = db
        .prepare(
          'SELECT id, content_hash, text, title, subtitle, facts, narrative FROM observations ' +
            `WHERE project = ? AND content_hash = ?${live} ORDER BY id LIMIT 50`
        )
        .all(project, ctx.legacyHash)
        .find((r) => legacyInputsFor(r, ctx.legacyHash).includes(ctx.canonical));
    }
    if (exact) {
      bumpRelevance(db, exact.id);
      return { ok: true, saved: false, status: 'duplicate', reason: 'duplicate', id: exact.id, project };
    }

    // §5.1b Same memory, different bytes — any age. The canonical hash is exact,
    // so a re-save that differs only in case, spacing, trailing punctuation or
    // fact order (dedupe.mjs memoryKey) would otherwise become a second row the
    // reader sees twice. Wording, numbers and symbols still make it new.
    const same = findHeldDuplicate(db, scrubbed, { project });
    if (same) {
      bumpRelevance(db, same.id);
      return { ok: true, saved: false, status: 'duplicate', reason: 'duplicate', id: same.id, project };
    }

    // §5.2 Near-duplicate — same project + identical normalized title within 72h.
    // Deterministic and cheap: no similarity scoring, no model calls. The window
    // is queried in SQL (indexed on created_at_epoch) and the title comparison
    // done in JS, because SQL's lower()/trim() cannot collapse inner whitespace.
    const nt = normalizeTitle(scrubbed.title);
    if (nt) {
      const cands = db
        .prepare(
          'SELECT id, title, text, facts, narrative FROM observations WHERE project = ? AND created_at_epoch >= ? AND created_at_epoch <= ? ' +
            `AND title IS NOT NULL${live} ORDER BY created_at_epoch DESC LIMIT 500`
        )
        .all(project, now - NEAR_DUP_WINDOW_MS, now + NEAR_DUP_WINDOW_MS);
      const near = cands.find((r) => normalizeTitle(r.title) === nt);
      if (near) {
        // The merge keeps what the incoming call said: facts it carries that the
        // row lacks are appended (capped, see mergeFacts). content_hash is NOT
        // recomputed — it stays the row's dedupe/sync identity, exactly as for a
        // curation edit (curate.mjs) and a scrub rewrite (scrub.mjs): re-sending
        // the original capture still hits the exact-duplicate path, and the
        // session-scoped unique index keeps seeing the key it was written with.
        // Title / subtitle / narrative / concepts of the existing row win.
        const had = parseFactsCell(near.facts);
        const m = had ? mergeFacts(had, scrubbed.facts) : null;
        if (m && m.added) {
          // `text` mirrors narrative-or-facts on rows this module wrote; keep it
          // in step only when it still has that shape (never clobber a foreign row).
          const mirrorsFacts = !near.narrative && near.text === had.join('\n');
          db.prepare(
            'UPDATE observations SET relevance_count = COALESCE(relevance_count, 0) + 1, facts = ?' +
              (mirrorsFacts ? ', text = ?' : '') + ' WHERE id = ?'
          ).run(...[JSON.stringify(m.facts), ...(mirrorsFacts ? [m.facts.join('\n')] : []), near.id]);
        } else {
          bumpRelevance(db, near.id);
        }
        return {
          ok: true, saved: true, merged: true, status: 'merged', id: near.id, project,
          factsAdded: m ? m.added : 0, ...(m && m.dropped ? { factsDropped: m.dropped } : {}),
        };
      }
    }

    // §2.5 Insert. One sdk_sessions row per process (INSERT OR IGNORE — the
    // unique indexes on memory_session_id and (platform_source,
    // content_session_id) make repeat calls a no-op). No user_prompts rows: we
    // never see the user's prompts and must not fake them.
    const text = scrubbed.narrative || scrubbed.facts.join('\n');
    const concepts = JSON.stringify([...new Set([...scrubbed.concepts, MCP_CAPTURE_CONCEPT])]);

    const insSession = db.prepare(
      `INSERT OR IGNORE INTO sdk_sessions
       (content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status)
       VALUES (?,?,?,?,?,?,?,?,?,'completed')`
    );
    const insObs = db.prepare(
      `INSERT OR IGNORE INTO observations
       (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
        prompt_number, created_at, created_at_epoch, content_hash, generated_by_model, relevance_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
    );
    const attempt = (sess) => {
      insSession.run(
        sess.contentSessionId, sess.memorySessionId, project, sess.platformSource, null,
        nowIso, sess.startedAtEpoch ?? now, nowIso, now
      );
      return insObs.run(
        sess.memorySessionId, project, text, scrubbed.type, scrubbed.title,
        scrubbed.subtitle || null, JSON.stringify(scrubbed.facts), scrubbed.narrative || null,
        concepts, 0, nowIso, now, contentHash, generatedByModel
      );
    };

    db.exec('BEGIN IMMEDIATE');
    try {
      let ins = attempt(session);

      if (!ins.changes) {
        // ux_observations_session_hash (memory_session_id, content_hash) fired.
        // Two very different situations look identical here, so disambiguate by
        // the blocking row's project before deciding:
        const blocking = db
          .prepare(`SELECT id, project, ${hasLifecycle(db) ? 'status' : 'NULL AS status'} FROM observations
                     WHERE memory_session_id = ? AND content_hash = ? LIMIT 1`)
          .get(session.memorySessionId, contentHash);

        if (blocking && blocking.project === project && isHiddenStatus(blocking.status)) {
          // (c) This process wrote the same memory before and the user has
          // since deleted it in the control panel — or hidden it as a merged
          // duplicate whose kept row is no longer live (else the checks above
          // would have answered). Saying it again is a new memory, not a
          // duplicate of the hidden row: retry in a sibling
          // session (the deleted row keeps its Undo). Bounded — each further
          // delete-and-repeat in one process takes the next sibling.
          for (let n = 1; n <= 3 && !ins.changes; n++) ins = attempt(resaidSession(session, n));
        } else if (blocking && blocking.project === project) {
          // (a) A concurrent identical write landed first — the duplicate it is.
          bumpRelevance(db, blocking.id);
          db.exec('COMMIT');
          return { ok: true, saved: false, status: 'duplicate', reason: 'duplicate', id: blocking.id, project };
        } else if (blocking) {
          // (b) The SAME content genuinely belongs to a DIFFERENT project (the
          // canonical hash is content-only by design, spec §2.3). Our dedupe key
          // is per-project, so this is a legitimate new row that the session-
          // scoped index is wrongly blocking. Mint a project-scoped sibling
          // session and retry once, rather than silently dropping the write.
          ins = attempt(projectScopedSession(session, project));
        }
        if (!ins.changes) {
          db.exec('ROLLBACK');
          return err('write_failed', 'observation was not saved — please retry once');
        }
      }
      db.exec('COMMIT');
      const id = Number(ins.lastInsertRowid);
      // Lifecycle: a new decision/fix retires the older same-topic ones. Best
      // effort, after COMMIT — it can never cost the write itself.
      let supersedes = [];
      try { supersedes = supersedeOlder(db, id, { now }); } catch {}
      return { ok: true, saved: true, status: 'saved', id, project, ...(supersedes.length ? { supersedes } : {}) };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * Store one model-authored observation. Never throws; always resolves to a
 * structured result.
 *
 * @param {object} input  the raw tool arguments (REMEMBER_INPUT_SCHEMA shape)
 * @param {object} [opts]
 *   dbPath        {string}  target store (default: MEMORY_DB from paths.mjs)
 *   session       {object}  from newMcpSession(); default = per-process session
 *   clientName    {string}  MCP initialize clientInfo.name (provenance)
 *   platformSource{string}  explicit override for the mapped clientName
 *   now           {number}  epoch ms (tests / deterministic dedupe windows)
 *   retries       {number}  busy retries after the first attempt (default 3)
 *   retryDelayMs  {number}  base backoff, jittered (default 250)
 *   busyTimeoutMs {number}  SQLite busy_timeout for the connection (default 3000)
 *   deadlineMs    {number}  hard internal deadline for the whole call (default 5000)
 *   log           {fn}      stderr sink; receives counts/ids only, never content
 *
 * @returns {Promise<
 *   | {ok:true, saved:true,  status:'saved',     id:number, project:string}
 *   | {ok:true, saved:false, status:'duplicate', reason:'duplicate', id:number, project:string}
 *   | {ok:true, saved:true,  merged:true, status:'merged', id:number, project:string,
 *        factsAdded:number, factsDropped?:number}
 *   | {ok:false, saved:false, status:'error', code:string, error:string, errors?:string[]}
 * >}
 */
export async function rememberObservation(input, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : defaultLog;
  try {
    // ── 1. Validate (spec §2.1) ──
    const v = validateObservation(input);
    if (!v.ok) {
      return err('invalid_input', `invalid observation: ${v.errors.join('; ')}`, { errors: v.errors });
    }

    // ── 2. Scrub — after validation, BEFORE the hash (spec §2.2) ──
    const { obs: scrubbed, hits, review } = scrubObservationWithHits(v.value);
    if (hits.length) {
      // Detector ids only. Never the value, never the field content.
      log(`scrubbed ${hits.length} secret(s) before hashing: ${[...new Set(hits.map((h) => h.detector))].join(', ')}`);
    }
    if (review.length) {
      // Tier 5 (generic high entropy) is review-only at capture: reported, left in
      // the text. Counts only — and field names are not logged either.
      log(`${review.length} high-entropy candidate(s) kept for review (not redacted)`);
    }

    // ── 3. Canonical hash over the SCRUBBED fields (spec §2.3) ──
    const contentHash = canonicalHash(scrubbed);

    // ── target store ──
    const dbPath = opts.dbPath || MEMORY_DB;
    if (!dbPath || !existsSync(dbPath)) {
      return err('not_initialized', 'brain not initialized — run: brain onboard');
    }

    const platformSource = opts.platformSource || platformSourceFor(opts.clientName);
    const session = opts.session || processSession(platformSource);
    const generatedByModel = modelProvenance({ model: scrubbed.model, clientName: opts.clientName });
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const ctx = {
      dbPath,
      session,
      generatedByModel,
      contentHash,
      legacyHash: legacyCanonicalHash(scrubbed),
      canonical: canonicalString(scrubbed),
      now,
      nowIso: new Date(now).toISOString(),
      busyTimeoutMs: opts.busyTimeoutMs ?? 3000,
    };

    // ── 4/5. Dedupe + insert, with busy retry (spec §7 "Locked DB") ──
    const retries = Number.isFinite(opts.retries) ? opts.retries : 3;
    const baseDelay = Number.isFinite(opts.retryDelayMs) ? opts.retryDelayMs : 250;
    // Wall clock, deliberately NOT `now` — `now` is the observation's timestamp
    // (injectable by tests / clock-skewed clients) and must never gate real time.
    const deadline = Date.now() + (Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : 5000);

    let lastBusy = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return writeOnce(scrubbed, ctx);
      } catch (e) {
        if (!isBusyError(e)) {
          log(`write failed (${e && e.name}) — not retrying`);
          return err('write_failed', 'could not save the observation to the memory store');
        }
        lastBusy = e;
        if (attempt === retries || Date.now() >= deadline) break;
        await sleep(Math.round(baseDelay * (attempt + 1) * (0.5 + Math.random())));
      }
    }
    log(`memory store busy after ${retries + 1} attempt(s)`);
    return err(
      'busy',
      'memory store is busy (another writer) — the observation was NOT saved; retry once',
      { retriable: true }
    );
  } catch (e) {
    // Absolute backstop: nothing reaches the caller as an exception.
    try { log(`unexpected failure (${e && e.name})`); } catch {}
    return err('internal', 'the memory store could not be reached — the observation was NOT saved');
  }
}

export default rememberObservation;
