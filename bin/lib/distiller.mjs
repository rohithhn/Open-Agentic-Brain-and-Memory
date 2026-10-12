// This project's OWN LLM distiller — bin/lib/distiller.mjs
//
// Why this exists
// ---------------
// 98% of the live store's observations were written by claude-mem's Haiku pass
// (`generated_by_model` = 'claude-haiku-4-5-20251001' / 'haiku'). Our own rows —
// the ones bin/lib/ingest.mjs captures natively — are raw transcript text with
// empty title/facts/narrative/concepts. That quality gap is the only reason
// claude-mem is still installed. This module closes it, with no dependency on
// claude-mem, no new credential, and no new npm package (node built-ins only).
//
// The token source is whichever agent CLI the user already has installed *for
// the tool that produced the session*: a Claude Code session is distilled by
// `claude`, a Codex session by `codex exec`, an Antigravity session by `agy`.
// (Google's separate `gemini` CLI is not a supported tool: it is neither
// ingested nor used as a distiller.) That reuses the auth they already have per
// tool, spreads cost across providers, and means no single vendor is a
// dependency — the whole objective. See PROVIDERS below.
//
// Six non-negotiables, all encoded here:
//
//   1. NEVER LOSE A SESSION. Capture (Stage A, ingest.mjs) already stored the
//      raw transcript. Distillation is a SEPARATE pass that upgrades that row.
//      Missing CLI, timeout, garbage output, offline machine → the session
//      simply stays pending and is retried later. Nothing throws at the caller;
//      every path returns a structured result. claude-mem coupled capture and
//      distillation, which is exactly why its worker breaking meant lost
//      sessions.
//   2. VALIDATE BEFORE WRITING. The model's reply is parsed strictly (JSON
//      only, whitelisted keys, shape+type checked through remember.mjs's
//      validateObservation) and rejected outright if it does not conform. A
//      reject is reported, never silently written as a degraded row.
//   3. SCRUB BEFORE HASH, ALWAYS. The model can echo a credential out of the
//      transcript, so scrubObservation() runs on its output BEFORE
//      canonicalHash(). Hash-then-scrub desyncs content_hash from the stored
//      text and corrupts dedup (secret-scrubber.md §5.3 P1).
//   4. PROVENANCE IS HONEST AND FOREVER DISTINGUISHABLE. Every row this module
//      writes gets `generated_by_model = 'brain/<provider>:<model>'`. No value
//      claude-mem ever wrote contains '/', and the MCP write path owns 'mcp/',
//      so `LIKE 'brain/%'` selects exactly this distiller's rows, permanently.
//      When the intended provider is unavailable and the fallback chain picks
//      another, the value records the provider that ACTUALLY ran — never the
//      one we meant to run.
//   5. IDEMPOTENT AND RESUMABLE. Per-session bookkeeping lives in the store's
//      existing `capture_state` table under a namespaced key ('distill:<memory
//      _session_id>'); real transcript paths are absolute and start with '/',
//      so the two uses can never collide and no new table is needed. 'done' is
//      written in the same transaction as the row upgrade, so an interrupted
//      batch resumes with zero double work and zero loss.
//   6. BOUNDED COST. Transcript bytes per session are capped, concurrency is
//      capped, `limit` bounds the batch, and estimateBatch() reports projected
//      token usage BEFORE any spend. A ~6,000-session backfill is meant to be
//      run incrementally and stopped at will.
//
// This module writes ONLY to the DB path it is given. It never resolves the
// live store implicitly for writes (callers pass dbPath); it never prints
// transcript or observation content — counts, ids, lengths and detector names
// only.
import { spawn } from 'node:child_process';
import { existsSync, accessSync, mkdirSync, writeFileSync, constants as FS } from 'node:fs';
import { join, isAbsolute, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { openDb, tableExists } from './db.mjs';
import { scrubObservationWithHits } from './scrub.mjs';
import { ensureSelfRunDir, notSelfPromptSql } from './selfcapture.mjs';
import { editedSql } from './curate.mjs';
import {
  LIMITS,
  OBSERVATION_TYPES,
  validateObservation,
  canonicalHash,
} from './remember.mjs';
import { legacyFromMetadata, LEGACY_META_KEY } from './hash.mjs';
import { findHeldDuplicate, bumpRelevance, markDuplicate, unmarkDuplicate, recheckCopiesOf, isDedupeReason, DUPLICATE, REASON_DISTILL } from './dedupe.mjs';
import { hasLifecycle, DELETED } from './lifecycle.mjs';
import { isEdited } from './curate.mjs';
import { scrubText } from './scrub.mjs';
import { strongHash, canonicalString } from './hash.mjs';
import {
  segmentTranscript, segmentId, segmentPrompts, isSelfSegment,
  loadTranscript, unpack as unpackTranscript, TRANSCRIPT_TABLE,
} from './segments.mjs';

const HOME = homedir();
const expand = (p) => (p && p.startsWith('~') ? join(HOME, p.slice(1)) : p);

// ───────────────────────────── Tunables ──────────────────────────────────────

export const DEFAULTS = {
  transcriptChars: 6000, // per SEGMENT sent to the model; also the segmentation budget (see SEGMENTS)
  promptsChars: 1200,    // the user-prompt digest we prepend
  timeoutMs: 120_000,
  concurrency: 2,
  limit: 25,
  maxAttempts: 5,        // a segment that keeps producing garbage stops burning tokens
  idleMs: 3 * 3600_000,  // the still-growing LAST segment is distilled once its session was quiet this long
};

// Marker concept appended to every distilled row: one greppable token for evals
// and for a documented purge path, mirroring remember.mjs's MCP_CAPTURE_CONCEPT.
export const DISTILL_CONCEPT = 'brain-distilled';
export const PROVENANCE_PREFIX = 'brain/';
export const STATE_KEY_PREFIX = 'distill:';

export const stateKey = (memorySessionId) => STATE_KEY_PREFIX + memorySessionId;

// chars→tokens. Deliberately crude and deliberately pessimistic-ish (~4 chars a
// token for English + code); this number exists so the user can SEE the cost
// shape before a backfill, not to bill anyone.
export const estimateTokens = (s) => Math.ceil(String(s ?? '').length / 4);

// ───────────────────────── Provider registry ─────────────────────────────────
//
// platform_source → which CLI distils it. Every entry resolves its binary by
// ABSOLUTE PATH with candidates, because this runs under launchd with a minimal
// PATH (the trap that already bit the `gh` and `node` lookups) and because
// `codex` is shell-aliased to `brain launch codex` on this machine — invoking
// the bare name would recurse into our own launcher.
//
// Each provider's `invoke(prompt, model)` returns { args, input }: `input` is
// written to the child's stdin and closed; `args` may embed the prompt instead.
// All providers get the SAME prompt and are
// held to the SAME strict JSON contract — no per-provider prompt forks.
export const PROVIDERS = {
  claude: {
    id: 'claude',
    bin: 'claude',
    envBin: 'BRAIN_DISTILL_CLAUDE_BIN',
    envModel: 'BRAIN_DISTILL_CLAUDE_MODEL',
    defaultModel: 'haiku',
    candidates: ['~/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
    invoke: (prompt, model) => ({
      args: ['-p', '--output-format', 'text', ...(model ? ['--model', model] : [])],
      input: prompt,
    }),
  },
  codex: {
    id: 'codex',
    bin: 'codex',
    envBin: 'BRAIN_DISTILL_CODEX_BIN',
    envModel: 'BRAIN_DISTILL_CODEX_MODEL',
    // Empty = whatever the user's own ~/.codex config already selects. Codex
    // model ids are account-specific; guessing one would fail for most users,
    // and the env override covers anyone who wants a specific cheap tier.
    defaultModel: '',
    candidates: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', '~/.local/bin/codex'],
    // `codex exec` is the non-interactive subcommand (NOT `-p`, which is
    // `--profile` here — checked, not assumed). '-' reads the prompt from stdin.
    // read-only sandbox + --ephemeral: distillation must never touch the disk.
    invoke: (prompt, model) => ({
      args: [
        'exec', '--skip-git-repo-check', '--sandbox', 'read-only',
        '--color', 'never', '--ephemeral',
        ...(model ? ['-m', model] : []),
        '-',
      ],
      input: prompt,
    }),
  },
  agy: {
    id: 'agy',
    bin: 'agy',
    envBin: 'BRAIN_DISTILL_AGY_BIN',
    envModel: 'BRAIN_DISTILL_AGY_MODEL',
    defaultModel: 'gemini-3.6-flash-low',
    candidates: ['~/.local/bin/agy', '/opt/homebrew/bin/agy', '/usr/local/bin/agy'],
    // Antigravity's CLI mirrors Claude Code's surface: `-p/--print` is a boolean
    // headless flag and the prompt arrives on stdin.
    invoke: (prompt, model) => ({
      args: ['--print', '--output-format', 'text', ...(model ? ['--model', model] : [])],
      input: prompt,
    }),
  },
};

// platform_source (as written by ingest.mjs / remember.mjs) → provider id.
export const SOURCE_PROVIDER = {
  claude: 'claude',
  claude_code: 'claude',
  claude_work: 'claude',
  claude_personal: 'claude',
  claude_desktop: 'claude',
  // Claude Desktop agent mode (Cowork, clientInfo local-agent-mode-*): not Claude
  // Code, but a Claude product, so it is distilled by the claude CLI.
  claude_desktop_agent: 'claude',
  claude_vscode: 'claude',
  codex: 'codex',
  chatgpt_desktop: 'codex',
  antigravity: 'agy',
  // Cursor ships no headless agent CLI of its own that we can rely on, so its
  // sessions take the default chain.
  cursor: null,
  // Kilo Code (extension + CLI, one backend) has no headless one-shot mode we rely on here:
  // default chain. kilo_cli is reserved should the CLI ever be ingested as its own source.
  kilo: null,
  kilo_cli: null,
};

// Order tried when a session's own CLI is unavailable. Cheapest/most likely
// installed first. A session is never left undistilled just because its own
// vendor's CLI is missing — but the row records who actually did the work.
export const FALLBACK_CHAIN = ['claude', 'agy', 'codex'];

export function providerForSource(platformSource) {
  const key = String(platformSource || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SOURCE_PROVIDER, key)) return SOURCE_PROVIDER[key];
  // mcp_* and anything unknown: no native pairing, use the chain.
  return null;
}

// Ordered, de-duplicated list of provider ids to try for one session.
export function resolveChain(platformSource) {
  const own = providerForSource(platformSource);
  const seen = new Set();
  const out = [];
  for (const id of [own, ...FALLBACK_CHAIN]) {
    if (!id || seen.has(id) || !PROVIDERS[id]) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isExecutable(p) {
  try {
    if (!p || !existsSync(p)) return false;
    accessSync(p, FS.X_OK);
    return true;
  } catch { return false; }
}

const binCache = new Map();

/**
 * Absolute path of a provider's binary, or null.
 *
 * Resolution order: per-provider env override (used by evals to point at a stub
 * so no test ever spends a token, and by users who keep the CLI somewhere odd)
 * → the absolute candidate list → a manual PATH scan. NEVER a bare-name spawn:
 * `codex` is shell-aliased to `brain launch codex` here, and launchd's PATH is
 * minimal.
 */
// NOTE ON ISOLATION: pointing the claude provider at a hook-free
// CLAUDE_CONFIG_DIR was tried and reverted — auth lives in the config dir, so a
// clean profile answers "Not logged in". A third-party hook that blocks the
// prompt therefore has to be fixed where it lives, not routed around here.

// launchd hands a job a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin) with no node
// on it, and codex shells out to node — so under the timer it exited 127 while
// the same command worked in a terminal. Guarantee the dirs the CLIs live in.
const EXTRA_PATH = [join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];

export function providerEnv(_id, env = process.env) {
  const parts = String(env.PATH || '').split(':').filter(Boolean);
  for (const p of EXTRA_PATH) if (!parts.includes(p)) parts.push(p);
  return { ...env, BRAIN_DISTILLER: '1', PATH: parts.join(':') };
}

export function resolveProviderBinary(id, env = process.env) {
  const p = PROVIDERS[id];
  if (!p) return null;
  const override = env[p.envBin];
  const cacheKey = `${id} ${override || ''} ${env.PATH || ''}`;
  if (binCache.has(cacheKey)) return binCache.get(cacheKey);

  let found = null;
  if (override) {
    const abs = expand(override);
    found = isExecutable(abs) ? abs : null; // an override that does not resolve is a hard miss
  } else {
    for (const c of p.candidates) {
      const abs = expand(c);
      if (isExecutable(abs)) { found = abs; break; }
    }
    if (!found) {
      for (const dir of String(env.PATH || '').split(delimiter)) {
        if (!dir || !isAbsolute(dir)) continue;
        const abs = join(dir, p.bin);
        if (isExecutable(abs)) { found = abs; break; }
      }
    }
  }
  binCache.set(cacheKey, found);
  return found;
}

export function resetBinaryCache() { binCache.clear(); } // tests only

export function providerAvailable(id, env = process.env) {
  return !!resolveProviderBinary(id, env);
}

export function providerModel(id, env = process.env) {
  const p = PROVIDERS[id];
  if (!p) return '';
  const override = env[p.envModel];
  return (override === undefined ? p.defaultModel : override) || '';
}

/** Every provider's availability + resolved model, for `brain status`/doctor. */
export function availableProviders(env = process.env) {
  return Object.keys(PROVIDERS).map((id) => ({
    id,
    binary: resolveProviderBinary(id, env),
    available: providerAvailable(id, env),
    model: providerModel(id, env),
  }));
}

// ───────────────────────────── The prompt ────────────────────────────────────
//
// ONE constant, provider-agnostic, so it can be iterated in one place. It was
// shaped against the live store's existing Haiku rows — structure only, never
// content: title ~70 chars / ~9 words, subtitle ~105 chars, 4–8 facts of ~90
// chars each, narrative 4–8 sentences (~640 chars), 2–3 lowercase single-token
// concepts. Those measured targets are stated to the model explicitly, which is
// what makes our rows rank and read alongside the 26,699 imported ones instead
// of looking like a different system's output.
//
// Every hard rule the validator enforces is also stated here, because a model
// that is told the schema fails it far less often than one that is corrected
// after the fact — and every correction costs another call.
export const DISTILL_PROMPT = `You are a memory distiller. You are given the COMPLETE transcript of one finished AI coding session — beginning to end, in order. Write ONE observation that captures what durably matters about it, for a developer searching their own memory months from now.

Because you can see the whole session at once, do what a turn-by-turn summariser cannot: state the ARC. What was attempted, what failed and why, what was ruled out, and what finally worked. A dead end that was proven dead is worth remembering; so is the reason the first approach did not work.

Return ONLY a single JSON object. No prose before or after it, no markdown fences, no explanation. If you are unsure, still return the object.

Schema (exact keys, no others):
{
  "title": string,      // aim for 60-90 chars (~9 words), hard limits 8-200, sentence case, specific. Name the real thing: the component, file, bug, or decision. Never "Session summary" or "Work on project".
  "subtitle": string,   // <=300 chars, ~1 line, the outcome or consequence in plain language
  "type": string,       // exactly one of: ${OBSERVATION_TYPES.join(' | ')}
  "facts": string[],    // 4-8 items, each a complete standalone sentence <=500 chars. Concrete and checkable: file paths, function names, numbers, commands, error text, versions. No pleasantries, no restating the task.
  "narrative": string,  // <=2000 chars, 4-8 sentences. What was attempted, what was found, what changed, and why it matters. Past tense, third person, no "the user" chit-chat.
  "concepts": string[]  // 2-4 items, lowercase, single hyphenated tokens (e.g. "auth-refactor", "sqlite", "test-coverage"). No spaces, no sentences.
}

Rules:
- GROUND EVERY FACT IN THE TRANSCRIPT. A confidently wrong fact is worse than no fact, because it will be fed to future sessions as if it were true. If you cannot point to the line that supports a fact, drop the fact. Fewer, solid facts beat more, shaky ones.
- Be specific where the transcript is specific: name the actual file paths, symbols, commands, error strings, numbers and versions that appear in it. Do not invent a path or a number that is not there.
- Prefer what would be non-obvious later: causes, constraints, decisions and their reasons, failed approaches, gotchas — over a play-by-play of tool calls.
- The title must name the actual thing that happened, not the topic area. "Fixed off-by-one in the retry backoff cap" — not "Worked on retry logic".
- Never copy credentials, tokens, keys, or secrets out of the transcript into any field.
- "type" describes the session's dominant outcome: discovery (learned how something works), change (modified behaviour), bugfix, feature, refactor, decision.`;

// Optional cheap second pass (opts.selfCritique). Given the transcript and our
// own first-pass JSON, the model deletes any fact it cannot support. Whether
// this is worth the extra call is an empirical question — evals/distiller-parity.mjs
// measures it rather than assuming it.
export const CRITIQUE_PROMPT = `You are checking one distilled observation against the session transcript it came from.

For EVERY item in "facts": does the transcript actually support it? Delete any fact that is not supported — a wrong fact in long-term memory is worse than a missing one. Do not add new facts. Do not soften or reword supported facts. Fix "title" only if it names something the transcript does not show.

Return ONLY the corrected JSON object, same keys, same schema, no prose and no markdown fences. Keep at least one fact. If everything checks out, return the object unchanged.`;

/**
 * Assemble the full prompt for one session. The transcript is hard-capped
 * (opts.transcriptChars) — the cap is the cost control, applied here so that
 * every provider and every caller shares it.
 */
export function buildPrompt(session, opts = {}) {
  const tChars = Number.isFinite(opts.transcriptChars) ? opts.transcriptChars : DEFAULTS.transcriptChars;
  const pChars = Number.isFinite(opts.promptsChars) ? opts.promptsChars : DEFAULTS.promptsChars;
  const cap = (s, n) => {
    const v = String(s ?? '');
    return v.length > n ? v.slice(0, n) + '\n…[truncated]' : v;
  };
  const prompts = Array.isArray(session.prompts) ? session.prompts.filter((p) => typeof p === 'string') : [];
  const promptBlock = prompts.length ? cap(prompts.map((p, i) => `${i + 1}. ${p}`).join('\n'), pChars) : '(none recorded)';
  // A segment (see SEGMENTS) carries its own text; a plain session row sends its
  // stored transcript exactly as before.
  const seg = session.segment || null;
  const body = seg && typeof seg.text === 'string' ? seg.text : String(session.transcript ?? '');
  const part = seg && seg.index > 0;
  const truncated = body.length > tChars;

  // Structured signals already sitting in the row. Handing the model the real
  // file lists is what lets facts cite real paths instead of gesturing at
  // "several files" — a cheap, purely local quality win.
  const fileList = (v) => {
    let arr = v;
    if (typeof v === 'string') { try { arr = JSON.parse(v); } catch { arr = v ? [v] : []; } }
    if (!Array.isArray(arr)) return '';
    return cap(arr.filter((x) => typeof x === 'string').slice(0, 40).join(', '), 800);
  };
  const filesRead = fileList(session.filesRead);
  const filesModified = fileList(session.filesModified);

  // Segment framing. The base prompt describes a COMPLETE session; a part of a
  // long one must be told it is only a part, or every part would be titled after
  // the session's opening topic (the bug segmentation exists to fix).
  const note = !seg ? []
    : part ? [
      '',
      `NOTE: this is part ${seg.index + 1} of a long session${seg.ts ? ` (it starts at ${seg.ts})` : ''}. The other parts are distilled separately. Describe ONLY what happens in this part: its own topic, decisions, findings and outcome. Do not describe how the session began and do not claim an overall result. The title must name what this part is about.`,
    ]
    : seg.closed ? [
      '',
      'NOTE: this is the FIRST part of a longer session; later parts are distilled separately. Describe only what happens in this part, not what the session eventually achieved.',
    ] : [];

  return [
    DISTILL_PROMPT,
    ...note,
    '',
    `Project: ${String(session.project ?? 'unknown').slice(0, LIMITS.project.max)}`,
    `Tool: ${String(session.platformSource ?? 'unknown').slice(0, 40)}`,
    ...(part ? [] : [`Session title (heuristic, may be poor): ${cap(session.title ?? '', 200)}`]),
    ...(!part && filesModified ? [`Files modified in this session: ${filesModified}`] : []),
    ...(!part && filesRead ? [`Files read in this session: ${filesRead}`] : []),
    '',
    part ? 'User prompts in this part:' : 'User prompts from the session:',
    promptBlock,
    '',
    `Transcript${part ? ' (this part only)' : ''}${truncated ? ' (truncated to the first ' + tChars + ' characters)' : ''}:`,
    '<<<TRANSCRIPT',
    cap(body, tChars),
    'TRANSCRIPT',
    '',
    'Now return the JSON object.',
  ].join('\n');
}

/** Prompt for the optional grounding pass (see CRITIQUE_PROMPT). */
export function buildCritiquePrompt(session, observation, opts = {}) {
  const tChars = Number.isFinite(opts.transcriptChars) ? opts.transcriptChars : DEFAULTS.transcriptChars;
  const t = session.segment && typeof session.segment.text === 'string' ? session.segment.text : String(session.transcript ?? '');
  return [
    CRITIQUE_PROMPT,
    '',
    'Transcript:',
    '<<<TRANSCRIPT',
    t.length > tChars ? t.slice(0, tChars) + '\n…[truncated]' : t,
    'TRANSCRIPT',
    '',
    'Observation to check:',
    JSON.stringify(observation, null, 2),
    '',
    'Now return the corrected JSON object.',
  ].join('\n');
}

// ─────────────────────── Response parsing + validation ───────────────────────

/**
 * Pull the first parseable top-level JSON object out of arbitrary CLI output.
 * Providers wrap replies in banners, log lines and markdown fences to different
 * degrees; this is brace-balanced and string-aware, so a '{' inside a quoted
 * value cannot fool it. Returns null when nothing parses — which is a reject,
 * not a crash.
 */
export function extractJson(raw) {
  const s = String(raw ?? '');
  const candidates = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const slice = s.slice(i, j + 1);
          try {
            const v = JSON.parse(slice);
            if (v && typeof v === 'object' && !Array.isArray(v)) candidates.push(v);
          } catch {}
          i = j; // do not re-scan the interior of an object we already consumed
          break;
        }
      }
    }
  }
  if (!candidates.length) return null;
  // Prefer an object that actually looks like our schema over an incidental one
  // (a provider status blob printed before the answer, say).
  return candidates.find((c) => typeof c.title === 'string' && Array.isArray(c.facts)) || candidates[0];
}

const KEYS = ['title', 'subtitle', 'type', 'facts', 'narrative', 'concepts'];

/**
 * Whitelist keys and CAP field lengths to remember.mjs's LIMITS, reporting what
 * was clamped. Capping is not the same as accepting garbage: shape and type
 * errors still fall through to validateObservation() below and are rejected.
 * Whitelisting rather than hard-failing on a stray extra key is a deliberate
 * cost decision — the extra key is dropped, never stored, and counted.
 */
export function clampObservation(input) {
  const notes = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { value: input, notes };
  const out = {};
  const extra = Object.keys(input).filter((k) => !KEYS.includes(k));
  if (extra.length) notes.push(`dropped ${extra.length} unknown key(s)`);

  const trunc = (v, max, name) => {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    if (t.length <= max) return t;
    notes.push(`${name} truncated to ${max}`);
    return t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  };

  if ('title' in input) out.title = trunc(input.title, LIMITS.title.max, 'title');
  if ('subtitle' in input) out.subtitle = trunc(input.subtitle, LIMITS.subtitle.max, 'subtitle');
  if ('narrative' in input) out.narrative = trunc(input.narrative, LIMITS.narrative.max, 'narrative');
  if ('type' in input) out.type = typeof input.type === 'string' ? input.type.trim().toLowerCase() : input.type;

  if (Array.isArray(input.facts)) {
    let f = input.facts.map((x) => (typeof x === 'string' ? trunc(x, LIMITS.fact.max, 'fact') : x));
    if (f.length > LIMITS.facts.max) { notes.push(`facts capped to ${LIMITS.facts.max}`); f = f.slice(0, LIMITS.facts.max); }
    out.facts = f;
  } else if ('facts' in input) out.facts = input.facts;

  if (Array.isArray(input.concepts)) {
    let c = input.concepts.map((x) => (typeof x === 'string' ? trunc(x, LIMITS.concept.max, 'concept') : x));
    if (c.length > LIMITS.concepts.max) { notes.push(`concepts capped to ${LIMITS.concepts.max}`); c = c.slice(0, LIMITS.concepts.max); }
    out.concepts = c;
  } else if ('concepts' in input) out.concepts = input.concepts;

  return { value: out, notes };
}

/**
 * Raw CLI stdout → a validated, SCRUBBED observation plus its canonical hash.
 * Order is fixed and load-bearing: parse → clamp → validate → SCRUB → HASH.
 * Never throws; a failure is `{ ok:false, reason, errors }`.
 */
export function parseAndValidate(raw, { project, scrubSalt = '' } = {}) {
  const obj = extractJson(raw);
  if (!obj) return { ok: false, reason: 'unparseable', errors: ['no JSON object in model output'] };

  const { value, notes } = clampObservation(obj);
  const v = validateObservation({ ...value, project: String(project ?? '').slice(0, LIMITS.project.max) });
  if (!v.ok) return { ok: false, reason: 'invalid', errors: v.errors, notes };

  // Scrub AFTER validation and strictly BEFORE the hash. The model can echo a
  // credential straight out of the transcript; hashing first would leave
  // content_hash describing text we do not store.
  const { obs: scrubbed, hits, review } = scrubObservationWithHits(v.value, { salt: scrubSalt });
  const contentHash = canonicalHash(scrubbed);
  return { ok: true, observation: scrubbed, contentHash, scrubHits: hits, scrubReview: review, notes };
}

// ───────────────────────────── CLI invocation ────────────────────────────────

/**
 * Run one provider CLI headlessly. Resolves — never rejects — with
 * { ok, stdout, code, signal, timedOut, ms, error }.
 */
export function runProvider(id, prompt, opts = {}) {
  const env = opts.env || process.env;
  const p = PROVIDERS[id];
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (r) => resolve({ ok: false, stdout: '', code: null, signal: null, timedOut: false, ms: Date.now() - started, ...r });
    if (!p) return done({ error: `unknown provider: ${id}` });
    const bin = resolveProviderBinary(id, env);
    if (!bin) return done({ error: `${id} CLI not found` });

    const model = opts.model === undefined ? providerModel(id, env) : opts.model;
    let args, input;
    try { ({ args, input } = p.invoke(prompt, model)); }
    catch (e) { return done({ error: `could not build ${id} invocation` }); }

    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // A clean, minimal-but-sufficient env: the CLIs need HOME (auth lives
        // there) and PATH (node shims). Nothing from this process leaks in that
        // could change their behaviour unpredictably.
        env: providerEnv(id, env),
        // A dedicated cwd, never $HOME: every CLI records its cwd in the
        // transcript it writes, and that is how ingest recognises this run as
        // the brain's own and does not capture it as user work (selfcapture.mjs).
        // Under the HOME the child is given, so it sits beside its own auth.
        cwd: opts.cwd || ensureSelfRunDir(env.HOME || HOME),
      });
    } catch (e) {
      return done({ error: `could not start ${id}` });
    }

    let out = '', errOut = '', settled = false;
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULTS.timeoutMs;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, stdout: out, code: null, signal: 'SIGKILL', timedOut: true, ms: Date.now() - started, error: 'timed out' });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (d) => {
      out += d;
      // Runaway output is a cost/memory hazard as real as runaway input.
      if (out.length > 400_000) { try { child.kill('SIGKILL'); } catch {} }
    });
    child.stderr.on('data', (d) => { if (errOut.length < 8000) errOut += d; });
    child.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: false, stdout: out, code: null, signal: null, timedOut: false, ms: Date.now() - started, error: `${id} failed to run` });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: out,
        code,
        signal,
        timedOut: false,
        ms: Date.now() - started,
        error: code === 0 ? null : `${id} exited ${code}`,
      });
    });

    try {
      if (input) child.stdin.write(input);
      child.stdin.end();
    } catch {}
    child.stdin.on('error', () => {}); // EPIPE if the CLI exits before reading
  });
}

// ─────────────────────────────── distillSession ──────────────────────────────

/**
 * Distil ONE session into a validated, scrubbed observation.
 *
 * @param {object} session  { memorySessionId, project, platformSource, title,
 *                            transcript, prompts[] }
 * @param {object} [opts]   provider (force one), providers (override the chain),
 *                          transcriptChars, promptsChars, timeoutMs, env,
 *                          model, scrubSalt, log
 * @returns {Promise<
 *   | { ok:true,  status:'distilled', observation, contentHash, provider, model,
 *       generatedByModel, tokens:{in,out}, ms, attempts:[…], scrubHits, notes }
 *   | { ok:false, status:'rejected'|'unavailable'|'failed',
 *       reason:string, attempts:[…], tokens:{in,out}, ms }
 * >}
 *
 * NEVER throws. Any failure means the caller leaves the session pending.
 */
export async function distillSession(session, opts = {}) {
  const env = opts.env || process.env;
  const t0 = Date.now();
  const prompt = buildPrompt(session, opts);
  let tokensIn = estimateTokens(prompt);
  const attempts = [];
  let tokensOut = 0;

  const chain = opts.provider
    ? [opts.provider]
    : (Array.isArray(opts.providers) && opts.providers.length ? opts.providers : resolveChain(session.platformSource));
  const usable = chain.filter((id) => PROVIDERS[id] && providerAvailable(id, env));

  if (!usable.length) {
    return {
      ok: false, status: 'unavailable',
      reason: `no distiller CLI available (tried: ${chain.join(', ') || 'none'})`,
      attempts, tokens: { in: 0, out: 0 }, ms: Date.now() - t0,
    };
  }

  let lastReason = 'no attempt made';
  for (const id of usable) {
    const model = opts.model !== undefined ? opts.model : providerModel(id, env);
    const run = await runProvider(id, prompt, { ...opts, env, model });
    tokensOut += estimateTokens(run.stdout);

    if (!run.ok && !run.stdout.trim()) {
      lastReason = run.timedOut ? `${id}: timed out` : `${id}: ${run.error || 'no output'}`;
      attempts.push({ provider: id, model, ok: false, reason: run.timedOut ? 'timeout' : 'no_output', ms: run.ms });
      continue; // fall through to the next provider rather than losing the session
    }

    const parsed = parseAndValidate(run.stdout, { project: session.project, scrubSalt: opts.scrubSalt });
    if (!parsed.ok) {
      // A provider that exited non-zero and produced nothing usable FAILED —
      // it did not judge the session unworthy. Distinguishing the two matters:
      // `rejected` is a verdict about content and shouldn't be retried, while
      // `failed` is infrastructure (not logged in, binary broken, rate limit)
      // and should be. Without this, a CLI that prints its error to stdout
      // instead of stderr gets its crash filed as a content rejection.
      const crashed = !run.ok;
      lastReason = crashed ? `${id}: ${run.error || 'exited non-zero'}` : `${id}: ${parsed.reason}`;
      attempts.push({
        provider: id, model, ok: false,
        reason: crashed ? 'provider_error' : parsed.reason,
        errors: parsed.errors, ms: run.ms,
      });
      continue;
    }

    // Optional grounding pass. It can only ever REPLACE the first result with
    // another fully-validated one; if it errors, times out, or returns garbage
    // we keep the first observation. A second pass must never cost us a session.
    let final = parsed;
    let critiqued = false;
    if (opts.selfCritique) {
      const cPrompt = buildCritiquePrompt(session, parsed.observation, opts);
      const cRun = await runProvider(id, cPrompt, { ...opts, env, model });
      tokensIn += estimateTokens(cPrompt);
      tokensOut += estimateTokens(cRun.stdout);
      const cParsed = parseAndValidate(cRun.stdout, { project: session.project, scrubSalt: opts.scrubSalt });
      if (cParsed.ok) { final = cParsed; critiqued = true; }
    }

    attempts.push({ provider: id, model, ok: true, ms: run.ms });
    return {
      ok: true,
      status: 'distilled',
      observation: final.observation,
      contentHash: final.contentHash,
      scrubHits: final.scrubHits,
      scrubReview: final.scrubReview, // tier-5 candidates kept for review (not redacted)
      notes: final.notes,
      critiqued,
      provider: id,
      model,
      // Provenance records who ACTUALLY ran, not who we intended to run.
      generatedByModel: provenanceFor(id, model),
      tokens: { in: tokensIn, out: tokensOut },
      ms: Date.now() - t0,
      attempts,
    };
  }

  const anyRejected = attempts.some((a) => a.reason === 'invalid' || a.reason === 'unparseable');
  return {
    ok: false,
    status: anyRejected ? 'rejected' : 'failed',
    reason: lastReason,
    attempts,
    tokens: { in: tokensIn, out: tokensOut },
    ms: Date.now() - t0,
  };
}

/** 'brain/<provider>:<model>' — see non-negotiable #4. */
export function provenanceFor(providerId, model) {
  const clean = (s) => String(s ?? '').replace(/[ -]/g, '').trim();
  const id = clean(providerId) || 'unknown';
  const m = clean(model);
  return (PROVENANCE_PREFIX + (m ? `${id}:${m}` : id)).slice(0, LIMITS.model.max);
}

// ───────────────────────────── Batch runner ──────────────────────────────────

// A session is pending when it has a raw capture observation (type 'session',
// which is what ingest.mjs writes) that no `brain/%` row has upgraded yet, and
// whose state row is not 'done' and has not exhausted its attempts. Sessions
// that are the brain's own headless runs (captured before the ingest guard
// existed) are never pending: distilling them spends tokens to launder the
// self-capture loop into rows that look real — `brain clean --self-capture`
// removes them instead.
//
// A session this distiller already upgraded is pending again only when its
// state row was explicitly set back to 'pending' — which ingest.mjs does when
// the session's transcript grew after it was distilled (it refreshes the row's
// raw `text` first). The upgraded row is then re-distilled in place: never a
// second row, and its current distillation stays until the new one is written.
//
// A row a person edited in the panel (curate.mjs stamps metadata.edited_at) is
// never pending: distilling it would overwrite the curated title/facts/
// narrative with machine output. Its raw `text` still follows the transcript.
//
// A hidden row (lifecycle.mjs HIDDEN_STATUSES) is never distilled for the
// first time: a panel delete is final, and a raw capture `brain clean --dupes`
// hid as a copy of another session holds a transcript a live row already
// holds — distilling it would spend tokens on a copy, and its (differently
// worded) distillation would bring the copy back into view. The one exception
// is a duplicate this distiller already upgraded whose session grew (the
// re-distillation branch): its own content changed, so it is re-checked.
// HIDDEN_PENDING_SQL is spliced in where the store has the lifecycle columns.
const HIDDEN_PENDING_SQL = `
     AND COALESCE(o.status, 'active') <> '${DELETED}'
     AND (COALESCE(o.status, 'active') <> '${DUPLICATE}'
          OR o.generated_by_model LIKE '${PROVENANCE_PREFIX}%')`;
const PENDING_SQL = (lifecycle) => `
  SELECT o.id AS obs_id, o.memory_session_id, o.project, o.text, o.title,
         o.files_read, o.files_modified,
         o.created_at, o.created_at_epoch, o.content_hash,
         s.platform_source, s.content_session_id,
         COALESCE(c.bytes, 0) AS attempts
    FROM observations o
    JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
    LEFT JOIN capture_state c ON c.transcript_path = ('${STATE_KEY_PREFIX}' || o.memory_session_id)
   WHERE ((o.type = 'session'
           AND (o.generated_by_model IS NULL OR o.generated_by_model NOT LIKE '${PROVENANCE_PREFIX}%')
           AND NOT EXISTS (
                 SELECT 1 FROM observations d
                  WHERE d.memory_session_id = o.memory_session_id
                    AND d.generated_by_model LIKE '${PROVENANCE_PREFIX}%'))
       OR (o.generated_by_model LIKE '${PROVENANCE_PREFIX}%'
           AND c.status = 'pending'
           AND o.id = (SELECT MIN(d.id) FROM observations d
                        WHERE d.memory_session_id = o.memory_session_id
                          AND d.generated_by_model LIKE '${PROVENANCE_PREFIX}%')))
     AND COALESCE(c.status, '') <> 'done'
     AND NOT ${editedSql('o.')}
     AND COALESCE(c.bytes, 0) < ?
     AND ${notSelfPromptSql('s.user_prompt')}${lifecycle ? HIDDEN_PENDING_SQL : ''}
   ORDER BY o.created_at_epoch DESC
   LIMIT ?`;

// ── SEGMENTS ─────────────────────────────────────────────────────────────────
// One observation per SEGMENT of a session, not per session.
//
// Source text. ingest keeps the row's `text` clipped at 8000 chars, but stores
// the full scrubbed transcript of any longer session in `session_transcripts`
// (segments.mjs). The distiller cuts that text into segments of at most
// `transcriptChars` (6000) at natural boundaries — a compact boundary, else a
// user turn, else a message; a single over-budget message is split — and
// distils each segment on its own. Segmentation is deterministic and
// prefix-stable: appending to a session never moves an existing boundary, so a
// segment is identified by `<index>-<sha1 of its first 256 chars>` for good.
// A session with no stored full transcript (short sessions; sessions ingest has
// not revisited since the upgrade) is exactly one segment: its row's text,
// distilled exactly as before.
//
// Segment 0 IS the session's existing capture row (raw → upgraded in place; or
// the old whole-session 'brain/…' row). Its bookkeeping stays 'distill:<mem>',
// so every pre-existing flow (growth refresh, recapture, dedupe, edits) is
// untouched. An old row with no `metadata.segment` is treated as covering
// segment 0 as it is (it was distilled from the first 6000 chars): it is never
// re-sent. Segments 1.. are NEW rows (same memory_session_id, project, platform;
// created_at = the segment's first message time; `metadata.segment` = {id,
// index, chars, start, end}; content_hash includes the segment id), with state
// 'distill:<mem>#<segmentId>' in capture_state (bytes = failed attempts).
// Nothing is ever deleted or overwritten except the one case below.
//
// Closed vs growing. A segment is CLOSED once a later segment exists: its text
// can never change, it is distilled once, and never again. The LAST segment can
// still grow; it is distilled only after its session has been quiet for
// `idleMs` (3h) — and if it grows afterwards, THAT segment's own row (and only
// that one) is re-distilled in place the same way, again only after a quiet
// period. A grown segment 0 of a segmented session follows the same rule, but
// only when its row records `metadata.segment` (rows this version wrote).
// Segments 1.. are only queued once segment 0 has been distilled (so the
// session's original row is always the lowest-id 'brain/' row, which is what
// ingest/recapture look up), and not at all for a deleted row or a session
// whose first prompt is one of the brain's own (the existing guards); a segment
// that itself opens with an internal prompt is skipped too (selfcapture.mjs).
// Segment rows are not run through the cross-session dedupe fold: each is
// anchored to its own transcript range.
//
// Queue + limit. `limit` counts SEGMENTS (= model calls). Order: older,
// already-started sessions finish first (oldest session first, at most
// ceil(limit/3) segments of one session per run so an 800-segment session cannot
// monopolise a run); a quarter of the slots is reserved for fresh sessions'
// segment 0 (newest first, as before) so new work never starves behind a backlog.
const segStateKey = (mem, segId) => `${STATE_KEY_PREFIX}${mem}#${segId}`;
export const segmentStateKey = segStateKey;

// Hash of a segment observation: the canonical hash input plus the segment id, so
// two segments of one session that come out worded alike are still distinct rows
// under ux_observations_session_hash.
export const segmentContentHash = (obs, segId) => strongHash(canonicalString(obs) + '\nsegment:' + segId);

const segMeta = (metadata) => {
  try { const o = metadata ? JSON.parse(metadata) : null; return o && o.segment && typeof o.segment === 'object' ? o.segment : null; } catch { return null; }
};
const budgetOf = (opts) => (Number.isFinite(opts.transcriptChars) ? opts.transcriptChars : DEFAULTS.transcriptChars);

// Segment 0 for a row-kind item: from the stored full transcript when there is
// one, else the row's own text (the legacy single segment).
function attachSegment0(db, item, rowText, budget) {
  const tr = loadTranscript(db, item.memorySessionId);
  if (tr) {
    const s0 = segmentTranscript(tr.text, { budget, marks: tr.marks, limit: 1 })[0];
    if (s0) {
      item.segment = { index: 0, id: s0.id, start: s0.start, end: s0.end, ts: s0.ts, closed: s0.closed, text: scrubText(s0.text).text, chars: s0.text.length };
      return;
    }
  }
  const t = String(rowText || '');
  item.segment = { index: 0, id: segmentId(0, t), start: 0, end: Math.min(t.length, budget), ts: null, closed: false, chars: Math.min(t.length, budget) };
}

function rowItem(r) {
  return {
    kind: 'row',
    obsId: r.obs_id,
    memorySessionId: r.memory_session_id,
    contentSessionId: r.content_session_id,
    project: r.project,
    platformSource: r.platform_source,
    title: r.title,
    transcript: r.text || '',
    filesRead: r.files_read,
    filesModified: r.files_modified,
    prompts: [],
    attempts: r.attempts,
    createdAt: r.created_at,
    createdAtEpoch: r.created_at_epoch,
    contentHash: r.content_hash,
  };
}

const CONT_SQL = (lifecycle) => `
  SELECT t.memory_session_id AS mem, t.size AS tsize, t.updated_at AS tupdated,
         s.project, s.platform_source, s.content_session_id, s.started_at, s.started_at_epoch,
         o.id AS o_id, o.text AS o_text, o.title AS o_title, o.content_hash AS o_hash,
         o.files_read, o.files_modified, o.created_at AS o_created, o.created_at_epoch AS o_epoch,
         o.metadata AS o_meta
    FROM ${TRANSCRIPT_TABLE} t
    JOIN sdk_sessions s ON s.memory_session_id = t.memory_session_id
    JOIN observations o ON o.id = (SELECT MIN(d.id) FROM observations d
                                    WHERE d.memory_session_id = t.memory_session_id
                                      AND d.generated_by_model LIKE '${PROVENANCE_PREFIX}%')
   WHERE COALESCE(t.done_size, -1) <> t.size
     AND ${notSelfPromptSql('s.user_prompt')}${lifecycle ? `
     AND COALESCE(o.status, 'active') <> '${DELETED}'` : ''}
   ORDER BY s.started_at_epoch ASC, t.memory_session_id`;

/**
 * Segment work for sessions that already have a stored full transcript and a
 * distilled segment 0: the segments that still need a model call.
 * Read-only. `maxItems` / `perSession` bound the result (Infinity = a plan).
 * → { items, settled:[{mem,size}], waiting, sessions, scanned }
 *   settled: sessions with nothing left to do at their current size;
 *   waiting: segments held back only because their session is not quiet yet.
 */
function continuationWork(db, { budget, maxAttempts, now, idleMs, maxItems = Infinity, perSession = Infinity }) {
  const out = { items: [], overflow: [], settled: [], waiting: 0, sessions: 0, scanned: 0 };
  if (!tableExists(db, TRANSCRIPT_TABLE) || !tableExists(db, 'sdk_sessions')) return out;
  const lifecycle = hasLifecycle(db);
  const sessions = db.prepare(CONT_SQL(lifecycle)).all();
  const st = db.prepare('SELECT bytes FROM capture_state WHERE transcript_path = ?');
  const segRows = db.prepare(
    `SELECT id, text, json_extract(metadata, '$.segment.id') AS sid, json_extract(metadata, '$.segment.chars') AS chars
       FROM observations
      WHERE memory_session_id = ? AND json_valid(metadata) AND json_extract(metadata, '$.segment.id') IS NOT NULL`
  );
  const blob = db.prepare(`SELECT size, updated_at, body, marks FROM ${TRANSCRIPT_TABLE} WHERE memory_session_id = ?`);
  for (const r of sessions) {
    if (out.items.length >= maxItems) break;
    out.scanned++;
    const b = blob.get(r.mem);
    const tr = b ? unpackTranscript(b) : null;
    if (!tr) continue;
    const segs = segmentTranscript(tr.text, { budget, marks: tr.marks });
    const quiet = now - (r.tupdated || 0) >= idleMs;
    const have = new Map(segRows.all(r.mem).map((x) => [x.sid, x]));
    let work = 0, waiting = 0, taken = 0;
    for (const seg of segs) {
      if (isSelfSegment(seg.text)) continue;
      let item = null;
      if (seg.index === 0) {
        // Grown after this version distilled it (legacy rows without metadata.segment are covered as they are).
        const m = segMeta(r.o_meta);
        if (!m || m.id !== seg.id || seg.text.length === (m.chars || 0) || isEdited(r.o_meta)) continue;
        const attempts = st.get(stateKey(r.mem))?.bytes || 0;
        if (attempts >= maxAttempts) continue;
        item = rowItem({
          obs_id: r.o_id, memory_session_id: r.mem, content_session_id: r.content_session_id, project: r.project,
          platform_source: r.platform_source, title: r.o_title, text: r.o_text, files_read: r.files_read,
          files_modified: r.files_modified, attempts, created_at: r.o_created,
          created_at_epoch: r.o_epoch, content_hash: r.o_hash,
        });
        item.redistill = true;
      } else {
        const existing = have.get(seg.id);
        // Distilled already and unchanged → done. Changed (the last segment grew — or a later
        // message moved the cut back, shrinking it) → this one row is re-distilled.
        if (existing && seg.text.length === (existing.chars || 0)) continue;
        const attempts = st.get(segStateKey(r.mem, seg.id))?.bytes || 0;
        if (attempts >= maxAttempts) continue;
        const ms = Date.parse(seg.ts || '');
        item = {
          kind: 'segment',
          obsId: existing ? existing.id : null,
          prevText: existing ? existing.text || '' : null,
          memorySessionId: r.mem,
          contentSessionId: r.content_session_id,
          project: r.project,
          platformSource: r.platform_source,
          title: '',
          transcript: '',
          filesRead: null,
          filesModified: null,
          prompts: segmentPrompts(seg.text),
          attempts,
          createdAt: seg.ts || r.started_at,
          createdAtEpoch: Number.isFinite(ms) ? ms : r.started_at_epoch,
          contentHash: null,
          redistill: !!existing,
        };
      }
      work++;
      if (!(seg.closed || quiet)) { waiting++; continue; } // still growing: wait until its session is quiet
      item.segment = {
        index: seg.index, id: seg.id, start: seg.start, end: seg.end, ts: seg.ts, closed: seg.closed,
        count: segs.length, text: scrubText(seg.text).text, chars: seg.text.length,
      };
      if (item.kind === 'segment') item.transcript = item.segment.text;
      if (taken < perSession && out.items.length < maxItems) { out.items.push(item); taken++; }
      else if (out.items.length + out.overflow.length < maxItems) out.overflow.push(item); // over the per-session cap: only used if slots stay free
      // else: over this run's reach — still pending, picked up by a later run
    }
    if (taken) out.sessions++;
    if (!work) out.settled.push({ mem: r.mem, size: r.tsize });
    out.waiting += waiting;
  }
  return out;
}

function buildQueue(db, { limit, maxAttempts, transcriptChars, now, idleMs }) {
  const lifecycle = hasLifecycle(db);
  const budget = budgetOf({ transcriptChars });
  const fresh = db.prepare(PENDING_SQL(lifecycle)).all(maxAttempts, limit).map(rowItem);
  for (const it of fresh) attachSegment0(db, it, it.transcript, budget);
  const freshTake = Math.min(fresh.length, Math.ceil(limit / 4));
  const cont = continuationWork(db, {
    budget, maxAttempts, now, idleMs,
    maxItems: limit - freshTake, perSession: Math.max(1, Math.ceil(limit / 3)),
  });
  cont.items.push(...cont.overflow);
  const contTake = Math.min(cont.items.length, limit - freshTake);
  const freshAll = freshTake + Math.min(fresh.length - freshTake, limit - freshTake - contTake);
  return { items: [...cont.items.slice(0, contTake), ...fresh.slice(0, freshAll)], settled: cont.settled };
}

const defaultsFor = (opts) => ({
  limit: Math.max(0, (opts.limit | 0)) || DEFAULTS.limit,
  maxAttempts: Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : DEFAULTS.maxAttempts,
  transcriptChars: opts.transcriptChars,
  now: Number.isFinite(opts.now) ? opts.now : Date.now(),
  idleMs: Number.isFinite(opts.idleMs) ? opts.idleMs : DEFAULTS.idleMs,
});

function queueFor(dbPath, opts = {}) {
  const db = openDb(dbPath, { readonly: !!opts.readonly });
  try {
    if (!tableExists(db, 'observations') || !tableExists(db, 'capture_state')) return { items: [], settled: [] };
    return buildQueue(db, defaultsFor(opts));
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * Segments awaiting distillation (each is one model call), in queue order —
 * see SEGMENTS. A session with no stored full transcript contributes exactly
 * one item, its row, as it always did. Read-only.
 */
export function pendingSessions(dbPath, opts = {}) {
  return queueFor(dbPath, opts).items;
}

/**
 * Dry-run preview of everything still to distil, over the WHOLE store (not one
 * run's limit). No model is called and nothing is written: the store is opened
 * read-only. → counts of sessions / segments / estimated calls and tokens.
 */
export function planBatch(dbPath, opts = {}) {
  const d = defaultsFor(opts);
  const limit = d.limit;
  const budget = budgetOf(opts);
  const db = openDb(dbPath, { readonly: true });
  const plan = {
    freshSessions: 0, laterSegmentsOfFreshSessions: 0,
    continuationSessions: 0, continuationSegments: 0, regrownSegments: 0, waitingForIdle: 0,
    calls: 0, runsAtLimit: 0, limit,
    sessionsWithFullTranscript: 0, longSessionsAwaitingFullTranscript: 0,
    estimatedTokens: { in: 0, out: 0, total: 0 }, byPlatform: {}, biggest: [],
  };
  const bump = (p, n = 1) => { plan.byPlatform[p] = (plan.byPlatform[p] || 0) + n; };
  try {
    if (!tableExists(db, 'observations') || !tableExists(db, 'capture_state')) return plan;
    const lifecycle = hasLifecycle(db);
    for (const f of db.prepare(`SELECT platform_source AS p, COUNT(*) AS n FROM (${PENDING_SQL(lifecycle)}) GROUP BY platform_source`).all(d.maxAttempts, 1_000_000_000)) {
      plan.freshSessions += f.n;
      bump(f.p, f.n);
    }
    const hasT = tableExists(db, TRANSCRIPT_TABLE);
    if (hasT) {
      plan.sessionsWithFullTranscript = db.prepare(`SELECT COUNT(*) AS n FROM ${TRANSCRIPT_TABLE}`).get().n;
      // Fresh sessions that already have a full transcript: their later segments follow once segment 0 is done.
      for (const r of db.prepare(
        `SELECT q.memory_session_id AS mem, q.platform_source AS p, t.size, t.updated_at, t.body, t.marks
           FROM (${PENDING_SQL(lifecycle)}) q JOIN ${TRANSCRIPT_TABLE} t ON t.memory_session_id = q.memory_session_id`
      ).all(d.maxAttempts, 1_000_000_000)) {
        const tr = unpackTranscript(r);
        if (!tr) continue;
        const segs = segmentTranscript(tr.text, { budget, marks: tr.marks });
        const quiet = d.now - (r.updated_at || 0) >= d.idleMs;
        const later = segs.slice(1).filter((s) => !isSelfSegment(s.text) && (s.closed || quiet)).length;
        plan.laterSegmentsOfFreshSessions += later;
        bump(r.p, later);
      }
      const cont = continuationWork(db, { budget, maxAttempts: d.maxAttempts, now: d.now, idleMs: d.idleMs });
      plan.continuationSessions = cont.sessions;
      plan.continuationSegments = cont.items.filter((i) => !i.redistill).length;
      plan.regrownSegments = cont.items.filter((i) => i.redistill).length;
      plan.waitingForIdle = cont.waiting;
      const per = new Map();
      for (const it of cont.items) {
        per.set(it.memorySessionId, (per.get(it.memorySessionId) || 0) + 1);
        bump(it.platformSource);
      }
      plan.biggest = [...per].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([session, segments]) => ({ session, segments }));
    }
    // A long session ingest captured before full transcripts were stored: its row's text hit the clip
    // (8000 chars + '…'). Its extra segments appear after the next `brain ingest` stores the full text.
    plan.longSessionsAwaitingFullTranscript = db.prepare(
      `SELECT COUNT(DISTINCT o.memory_session_id) AS n FROM observations o
        WHERE length(o.text) > 8000 AND (o.type = 'session' OR o.generated_by_model LIKE '${PROVENANCE_PREFIX}%')
          ${hasT ? `AND o.memory_session_id NOT IN (SELECT memory_session_id FROM ${TRANSCRIPT_TABLE})` : ''}
          AND o.memory_session_id LIKE '%:%'`
    ).get().n;
  } finally {
    try { db.close(); } catch {}
  }
  plan.calls = plan.freshSessions + plan.laterSegmentsOfFreshSessions + plan.continuationSegments + plan.regrownSegments;
  plan.runsAtLimit = Math.ceil(plan.calls / limit);
  const perCall = estimateTokens(buildPrompt({ transcript: 'x'.repeat(budget) }, { transcriptChars: budget }));
  plan.estimatedTokens.in = plan.calls * perCall;
  plan.estimatedTokens.out = plan.calls * 400;
  plan.estimatedTokens.total = plan.estimatedTokens.in + plan.estimatedTokens.out;
  return plan;
}

function loadPrompts(db, contentSessionId, max = 20) {
  if (!contentSessionId || !tableExists(db, 'user_prompts')) return [];
  try {
    return db
      .prepare('SELECT prompt_text FROM user_prompts WHERE content_session_id = ? ORDER BY prompt_number LIMIT ?')
      .all(contentSessionId, max)
      .map((r) => r.prompt_text)
      .filter((t) => typeof t === 'string' && t.trim());
  } catch { return []; }
}

/**
 * What a batch WOULD cost, without spending anything. Call this before a
 * backfill — cost must be visible before it is incurred (non-negotiable #6).
 */
export function estimateBatch(dbPath, opts = {}) {
  const env = opts.env || process.env;
  const sessions = pendingSessions(dbPath, opts);
  const db = openDb(dbPath);
  let tokensIn = 0;
  const byProvider = {};
  try {
    for (const s of sessions) {
      s.prompts = loadPrompts(db, s.contentSessionId);
      const pt = estimateTokens(buildPrompt(s, opts));
      tokensIn += opts.selfCritique ? pt * 2 + 400 : pt;
      const chain = resolveChain(s.platformSource).filter((id) => providerAvailable(id, env));
      const id = chain[0] || 'none';
      byProvider[id] = (byProvider[id] || 0) + 1;
    }
  } finally {
    try { db.close(); } catch {}
  }
  // Output is small and bounded by the schema (~1.5k chars worst case ≈ 400 tok).
  const tokensOut = sessions.length * (opts.selfCritique ? 800 : 400);
  return {
    sessions: sessions.length,
    byProvider,
    estimatedTokens: { in: tokensIn, out: tokensOut, total: tokensIn + tokensOut },
    providers: availableProviders(env).map(({ id, available, model }) => ({ id, available, model })),
  };
}

// Upgrade the raw capture row in place, inside one transaction with the state
// write, so 'done' and the upgraded row can never disagree.
//
// `text` deliberately KEEPS the raw transcript (it stays FTS-searchable and the
// distillation stays auditable against its source); title/subtitle/facts/
// narrative/concepts/type are filled in and content_hash is recomputed over the
// scrubbed fields, per remember.mjs's canonical-hash contract. The pre-upgrade
// hash is preserved in `metadata` so the original capture identity is never
// lost — an importer merging this store with another machine's can still tell
// that a distilled row and a raw row describe the same capture.
function writeDistilled(db, row, result, now) {
  const nowIso = new Date(now).toISOString();
  const obs = result.observation;
  const concepts = JSON.stringify([...new Set([...(obs.concepts || []), DISTILL_CONCEPT])]);
  // A re-distillation (the session grew, see PENDING_SQL) keeps the ORIGINAL
  // capture identity: row.contentHash is then the previous distillation's hash.
  // A row `brain migrate-hash` rewrote keeps its v1 hash in
  // metadata.legacy_content_hash (hash.mjs) — the alias a machine that never
  // migrated still matches it by once its content no longer reproduces that
  // hash, which distilling guarantees. Carried over, never dropped.
  let prior = null, legacy = null;
  try {
    const m = db.prepare('SELECT metadata FROM observations WHERE id = ?').get(row.obsId)?.metadata;
    legacy = legacyFromMetadata(m);
    const o = m ? JSON.parse(m) : null;
    if (o && o.distiller === 'brain') prior = o;
  } catch {}
  const metadata = JSON.stringify({
    distilled_at: nowIso,
    distiller: 'brain',
    provider: result.provider,
    model: result.model,
    source_content_hash: (prior ? prior.source_content_hash : row.contentHash) || null,
    source_type: 'session',
    tokens_estimated: result.tokens,
    ...(row.segment ? { segment: { id: row.segment.id, index: 0, chars: row.segment.chars, start: row.segment.start, end: row.segment.end } } : {}),
    ...(prior ? { redistilled_from: prior.distilled_at || null } : {}),
    ...(legacy ? { [LEGACY_META_KEY]: legacy } : {}),
  });

  db.exec('BEGIN IMMEDIATE');
  try {
    // Compare-and-set: the provider CLI can run for minutes, and meanwhile
    // ingest may refresh this row with a grown transcript (and set the session
    // back to 'pending'), or a person may edit it in the panel. Writing then
    // would pin a distillation of the OLD transcript to the new text and mark
    // the session done for good — or overwrite the edit. So the row is only
    // upgraded if its `text` is still the transcript this distillation read
    // and it carries no hand-edit marker; otherwise nothing is written and the
    // session stays as ingest/the edit left it.
    //
    // Likewise a row hidden while the CLI ran (a panel delete, or a raw copy
    // `brain clean --dupes` hid — see PENDING_SQL) is left as it is: nothing
    // is written, and the pending query no longer lists it.
    const lifecycle = hasLifecycle(db);
    const before = db
      .prepare(`SELECT generated_by_model AS gbm, ${lifecycle ? 'status, status_reason, superseded_by' : "'active' AS status, NULL AS status_reason, NULL AS superseded_by"} FROM observations WHERE id = ?`)
      .get(row.obsId);
    const wasDistilled = String(before?.gbm || '').startsWith(PROVENANCE_PREFIX);
    if (before && (before.status === DELETED || (before.status === DUPLICATE && !wasDistilled))) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'source_changed' };
    }
    const upd = db.prepare(
      `UPDATE observations
          SET type = ?, title = ?, subtitle = ?, facts = ?, narrative = ?, concepts = ?,
              content_hash = ?, generated_by_model = ?, metadata = ?
        WHERE id = ? AND COALESCE(text, '') = ? AND NOT ${editedSql()}`
    ).run(
      obs.type, obs.title, obs.subtitle || null, JSON.stringify(obs.facts),
      obs.narrative || null, concepts, result.contentHash, result.generatedByModel,
      metadata, row.obsId, row.transcript || ''
    );
    if (upd.changes !== 1) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'source_changed' };
    }
    // Dedupe (dedupe.mjs): a distillation that comes out as a memory this
    // project already holds — two sessions doing the same thing, a re-run —
    // is folded into the held row (+1 relevance, recorded in status_prev so
    // --undo takes it back). This row stays upgraded, so the session is done
    // here and on every Mac it syncs to, and keeps all of its content; it is
    // only hidden (status 'duplicate'). The relevance and the merge are
    // counted only when this write hides the row: a re-distillation of a row
    // already folded into the same memory changes nothing, and a pinned or
    // hand-set row markDuplicate refuses is not merged at all. Without the
    // lifecycle columns nothing can be hidden or recorded: the readers'
    // collapse folds the row, and only its first distillation adds relevance
    // (a re-distillation would add it again with nothing to take it back).
    //
    // A re-distillation that no longer matches brings the row back into view —
    // only a row hidden by its own distillation (REASON_DISTILL), or a copy
    // whose own session grew (it was already distilled; its content changed).
    // A raw copy `brain clean --dupes` hid never gets here (see above).
    //
    // Then the rows hidden as copies of THIS row are re-checked: its content
    // just changed, and a copy that no longer holds the same memory comes back.
    // Best effort: a failure here never costs the distillation itself.
    let mergedInto = null;
    try {
      const held = findHeldDuplicate(
        db,
        { title: obs.title, subtitle: obs.subtitle, facts: obs.facts, narrative: obs.narrative, text: row.transcript },
        { project: row.project, excludeId: row.obsId }
      );
      if (!lifecycle) {
        if (held) {
          if (!wasDistilled) bumpRelevance(db, held.id);
          mergedInto = held.id;
        }
      } else {
        const hiddenByDedupe = before.status === DUPLICATE && isDedupeReason(before.status_reason);
        if (held) {
          if (before.status === DUPLICATE && before.superseded_by === held.id) {
            // already folded into this very memory: nothing to add
          } else if (before.status !== DUPLICATE || (hiddenByDedupe && unmarkDuplicate(db, row.obsId, { now }))) {
            if (markDuplicate(db, row.obsId, held.id, { reason: REASON_DISTILL, now, relevanceAdded: 1 })) {
              bumpRelevance(db, held.id);
              mergedInto = held.id;
            }
          }
        } else if (hiddenByDedupe && (String(before.status_reason).startsWith(REASON_DISTILL) || wasDistilled)) {
          unmarkDuplicate(db, row.obsId, { now });
        }
        recheckCopiesOf(db, row.obsId, { now });
      }
    } catch { /* keep the upgrade; the readers' collapse still applies */ }
    db.prepare(
      `INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status)
       VALUES (?,?,?,?,'done')
       ON CONFLICT(transcript_path) DO UPDATE SET mtime = excluded.mtime, status = 'done'`
    ).run(stateKey(row.memorySessionId), now, row.attempts + 1, row.memorySessionId);
    // A grown segment 0 re-distilled by this version starts its attempt count over.
    if (row.redistill) db.prepare('UPDATE capture_state SET bytes = 0 WHERE transcript_path = ?').run(stateKey(row.memorySessionId));
    db.exec('COMMIT');
    return { ok: true, ...(mergedInto != null ? { mergedInto } : {}) };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    // The most likely cause is ux_observations_session_hash: another row in the
    // same session already carries this exact content hash. Leave the session
    // pending; nothing is lost.
    return { ok: false, reason: 'write_conflict' };
  }
}

function bumpAttempt(db, row, now, status) {
  try {
    db.prepare(
      `INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status)
       VALUES (?,?,?,?,?)
       ON CONFLICT(transcript_path) DO UPDATE
         SET mtime = excluded.mtime, bytes = capture_state.bytes + 1, status = excluded.status`
    ).run(stateKeyOf(row), now, row.attempts + 1, row.memorySessionId, status);
  } catch {}
}

// Bookkeeping key of one work item: the session's own key for its row (segment 0),
// a per-segment key for segments 1.. (see SEGMENTS).
const stateKeyOf = (row) => (row.kind === 'segment' ? segStateKey(row.memorySessionId, row.segment.id) : stateKey(row.memorySessionId));

// Write one segment's observation (segments 1..; segment 0 is writeDistilled's
// in-place upgrade of the capture row). A new segment is INSERTed as its own row;
// a grown LAST segment that was already distilled has its own row updated in
// place (compare-and-set on the text it was distilled from). Nothing else is
// ever touched. 'done' goes in the same transaction as the row.
function writeSegment(db, row, result, now) {
  const obs = result.observation;
  const seg = row.segment;
  const nowIso = new Date(now).toISOString();
  const concepts = JSON.stringify([...new Set([...(obs.concepts || []), DISTILL_CONCEPT])]);
  const hash = segmentContentHash(obs, seg.id);
  const metadata = JSON.stringify({
    distilled_at: nowIso,
    distiller: 'brain',
    provider: result.provider,
    model: result.model,
    source_type: 'session-segment',
    tokens_estimated: result.tokens,
    segment: { id: seg.id, index: seg.index, chars: seg.chars, start: seg.start, end: seg.end },
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    const lifecycle = hasLifecycle(db);
    const first = db.prepare(
      `SELECT ${lifecycle ? 'status' : "'active' AS status"} FROM observations
        WHERE memory_session_id = ? AND generated_by_model LIKE '${PROVENANCE_PREFIX}%' ORDER BY id LIMIT 1`
    ).get(row.memorySessionId);
    // The session's own row was deleted (or never distilled) while the CLI ran: write nothing.
    if (!first || first.status === DELETED) { db.exec('ROLLBACK'); return { ok: false, reason: 'source_changed' }; }
    if (row.obsId != null) {
      const upd = db.prepare(
        `UPDATE observations
            SET text = ?, type = ?, title = ?, subtitle = ?, facts = ?, narrative = ?, concepts = ?,
                content_hash = ?, generated_by_model = ?, metadata = ?
          WHERE id = ? AND COALESCE(text, '') = ? AND NOT ${editedSql()}`
      ).run(
        seg.text, obs.type, obs.title, obs.subtitle || null, JSON.stringify(obs.facts), obs.narrative || null,
        concepts, hash, result.generatedByModel, metadata, row.obsId, row.prevText || ''
      );
      if (upd.changes !== 1) { db.exec('ROLLBACK'); return { ok: false, reason: 'source_changed' }; }
    } else {
      // Another run may have written this very segment while ours ran.
      const dup = db.prepare(
        `SELECT 1 FROM observations WHERE memory_session_id = ? AND json_valid(metadata) AND json_extract(metadata, '$.segment.id') = ?`
      ).get(row.memorySessionId, seg.id);
      if (dup) { db.exec('ROLLBACK'); return { ok: false, reason: 'source_changed' }; }
      const epoch = Number.isFinite(row.createdAtEpoch) ? row.createdAtEpoch : now;
      db.prepare(
        `INSERT INTO observations
           (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
            prompt_number, created_at, created_at_epoch, content_hash, generated_by_model, metadata)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        row.memorySessionId, row.project, seg.text, obs.type, obs.title, obs.subtitle || null,
        JSON.stringify(obs.facts), obs.narrative || null, concepts, seg.index,
        row.createdAt || new Date(epoch).toISOString(), epoch, hash, result.generatedByModel, metadata
      );
    }
    db.prepare(
      `INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status)
       VALUES (?,?,0,?,'done')
       ON CONFLICT(transcript_path) DO UPDATE SET mtime = excluded.mtime, bytes = 0, status = 'done'`
    ).run(segStateKey(row.memorySessionId, seg.id), now, row.memorySessionId);
    db.exec('COMMIT');
    return { ok: true };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    return { ok: false, reason: 'write_conflict' };
  }
}

/**
 * Distil pending sessions in a bounded, resumable batch.
 *
 * @param {string} dbPath  target store. ALWAYS passed explicitly — this module
 *                         never implicitly writes to the live brain.
 * @param {object} [opts]  limit, concurrency, transcriptChars, timeoutMs,
 *                         maxAttempts, provider/providers, selfCritique (second
 *                         grounding pass per session; `brain distill-sessions
 *                         --critique`), dryRun, env, log, now
 * @returns {Promise<report>} counts, per-provider stats, estimated tokens and a
 *                            content-free list of rejects.
 * Never throws. Every failure leaves its session pending.
 */
export async function distillPending(dbPath, opts = {}) {
  const env = opts.env || process.env;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const limit = Number.isFinite(opts.limit) ? opts.limit : DEFAULTS.limit;
  const concurrency = Math.max(1, Number.isFinite(opts.concurrency) ? opts.concurrency : DEFAULTS.concurrency);
  const now = () => (Number.isFinite(opts.now) ? opts.now : Date.now());

  const report = {
    scanned: 0, distilled: 0, merged: 0, rejected: 0, failed: 0, unavailable: 0, conflicts: 0, stale: 0,
    byProvider: {}, rejects: [],
    estimatedTokens: { in: 0, out: 0, total: 0 },
    providers: availableProviders(env).map(({ id, available, model }) => ({ id, available, model })),
    ms: 0,
  };
  const t0 = Date.now();

  let rows = [], settled = [];
  try {
    ({ items: rows, settled } = queueFor(dbPath, {
      limit, maxAttempts: opts.maxAttempts, transcriptChars: opts.transcriptChars, now: opts.now, idleMs: opts.idleMs,
      readonly: !!opts.dryRun,
    }));
  } catch (e) { report.error = 'could not read pending sessions'; return report; }
  report.scanned = rows.length; // SEGMENTS (= model calls): --limit bounds exactly this
  report.segments = rows.filter((r) => r.kind === 'segment').length;
  // Sessions whose segments are all done at their current size: remembered so the next run
  // does not decompress and re-cut them (cleared by ingest the moment the transcript changes).
  if (settled.length && !opts.dryRun) {
    const db = openDb(dbPath);
    try {
      const mark = db.prepare(`UPDATE ${TRANSCRIPT_TABLE} SET done_size = ? WHERE memory_session_id = ? AND size = ?`);
      for (const x of settled) { try { mark.run(x.size, x.mem, x.size); } catch {} }
    } finally { try { db.close(); } catch {} }
  }
  if (!rows.length) { report.ms = Date.now() - t0; return report; }

  // Load prompts up front on one connection, then close it: the child processes
  // can take minutes and holding a handle open that long is asking for lock
  // contention with capture.
  {
    const db = openDb(dbPath);
    try { for (const r of rows) if (r.kind === 'row') r.prompts = loadPrompts(db, r.contentSessionId); }
    finally { try { db.close(); } catch {} }
  }

  if (opts.dryRun) {
    for (const r of rows) {
      const pt = estimateTokens(buildPrompt(r, opts));
      // The critique pass resends the transcript plus the first-pass JSON (~400 tok).
      report.estimatedTokens.in += opts.selfCritique ? pt * 2 + 400 : pt;
    }
    report.estimatedTokens.out = rows.length * (opts.selfCritique ? 800 : 400);
    report.estimatedTokens.total = report.estimatedTokens.in + report.estimatedTokens.out;
    report.ms = Date.now() - t0;
    return report;
  }

  const bump = (p, field, n = 1) => {
    report.byProvider[p] = report.byProvider[p] || { distilled: 0, rejected: 0, failed: 0, tokensIn: 0, tokensOut: 0, ms: 0 };
    report.byProvider[p][field] += n;
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      let res;
      try { res = await distillSession(row, { ...opts, env }); }
      catch (e) { res = { ok: false, status: 'failed', reason: 'internal', tokens: { in: 0, out: 0 }, attempts: [] }; }

      report.estimatedTokens.in += res.tokens?.in || 0;
      report.estimatedTokens.out += res.tokens?.out || 0;
      const used = res.provider || res.attempts?.[res.attempts.length - 1]?.provider || 'none';

      const db = openDb(dbPath);
      try {
        // openDb already sets a 30s busy timeout; nothing to lower it to here.
        if (res.ok) {
          const w = row.kind === 'segment' ? writeSegment(db, row, res, now()) : writeDistilled(db, row, res, now());
          if (w.ok) {
            report.distilled++;
            // Distilled to a memory the project already held: folded into it.
            if (w.mergedInto != null) report.merged++;
            bump(used, 'distilled');
            bump(used, 'tokensIn', res.tokens.in);
            bump(used, 'tokensOut', res.tokens.out);
            bump(used, 'ms', res.ms);
            log(`  distilled ${row.memorySessionId}${row.segment && (row.segment.index > 0 || row.kind === 'segment') ? ` segment ${row.segment.index}` : ''} via ${used} (${res.ms}ms)`);
          } else if (w.reason === 'source_changed') {
            // Not a failed attempt: the row moved on while the CLI ran (grown
            // transcript → already pending again; hand edit → never pending).
            // Nothing was written; the next run distils the current text.
            report.stale++;
            report.rejects.push({ session: row.memorySessionId, reason: w.reason });
          } else {
            report.conflicts++;
            report.rejects.push({ session: row.memorySessionId, reason: w.reason });
            bumpAttempt(db, row, now(), 'pending');
          }
        } else if (res.status === 'unavailable') {
          report.unavailable++;
          // NOT an attempt: no CLI ran, so nothing was tried. Burning an attempt
          // here would exhaust sessions on a machine that is merely offline.
          report.rejects.push({ session: row.memorySessionId, reason: 'unavailable' });
        } else {
          if (res.status === 'rejected') { report.rejected++; bump(used, 'rejected'); }
          else { report.failed++; bump(used, 'failed'); }
          report.rejects.push({ session: row.memorySessionId, reason: res.status, detail: res.reason });
          bumpAttempt(db, row, now(), 'pending');
        }
      } finally {
        try { db.close(); } catch {}
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  report.estimatedTokens.total = report.estimatedTokens.in + report.estimatedTokens.out;
  report.ms = Date.now() - t0;
  return report;
}

export default distillPending;
