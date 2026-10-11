// Self-capture guard.
//
// The brain runs AI CLIs headlessly for its OWN purposes: the session distiller
// (distiller.mjs), the learning drafter (distill.mjs), the panel's "explain"
// button (ui/server.mjs → agent.mjs) and the distiller-parity judge (evals/).
// Every one of those CLIs writes a transcript like any other session, and ingest
// then captured them as if they were the user's work — measured on the live
// store (2026-09-30): 9,230 of 43,800 observations (21%) came from those runs,
// nearly all the distiller's own prompt stored as a "session" and filed under
// whatever dir the run started in ($HOME, so the project was the home-dir
// name). The distiller then distilled those rows too, and the loop fed itself.
//
// Two independent signals; either one alone marks a session as ours:
//   1. WHERE it ran. Every internal run starts in selfRunDir(), and every CLI
//      records its cwd in the transcript (Claude Code on each line, Codex in
//      session_meta, agy as `workspace`, Gemini via projects.json).
//   2. WHAT it was asked. A session whose FIRST user prompt is one of our
//      internal prompts is ours wherever it ran — this is what catches the
//      historical rows, which predate the dedicated cwd.
// Node built-ins only; imported by ingest, the distiller and `brain clean`.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

// Dedicated cwd for every headless run the brain starts itself.
export function selfRunDir(home = homedir()) {
  return join(home, '.claude-brain', 'self-runs');
}

// Created on demand: a spawn with a missing cwd fails with ENOENT. Falls back to
// HOME rather than failing the run — the prompt signal still catches it.
export function ensureSelfRunDir(home = homedir()) {
  const dir = selfRunDir(home);
  try { mkdirSync(dir, { recursive: true }); return dir; } catch { return home; }
}

// Matches the path SUFFIX, not this machine's absolute path: transcripts from
// another Mac (or from the old home dir) carry that machine's home.
const SELF_CWD_RE = /(^|[\\/])\.claude-brain[\\/]self-runs([\\/]|$)/;
export const isSelfRunCwd = (cwd) => typeof cwd === 'string' && SELF_CWD_RE.test(cwd);

// Claude Code names a project's transcript dir after its cwd with every
// non-alphanumeric char turned into '-': …/.claude-brain/self-runs → …--claude-brain-self-runs.
// Lets parseClaude skip the whole dir before its newest-N window, so a busy
// distiller can never crowd real sessions out of that window.
export const isSelfRunProjectDir = (name) => /-claude-brain-self-runs(-|$)/.test(String(name || ''));

// First-prompt openers of every internal prompt. Kept as literals (not imported
// from distiller.mjs) so ingest stays light; evals/selfcapture-test.mjs asserts
// each one still matches the real constant, so a prompt edit cannot silently
// reopen the loop.
export const SELF_PROMPT_PREFIXES = [
  'You are a memory distiller.',                          // distiller.mjs DISTILL_PROMPT
  'You are checking one distilled observation',           // distiller.mjs CRITIQUE_PROMPT
  'You are distilling a reusable engineering',            // distill.mjs learning drafts (lesson + DECISION)
  "You are comparing two memory systems' distillations",  // evals/distiller-parity.mjs judge
  // claude-mem's own worker agents (filed under its 'observer-sessions' project).
  'You are a Claude-Mem, a specialized observer tool',    // observer, first turn
  'Hello memory agent, you are continuing to observe',    // observer, resumed session
  'Condense the tool payload below to under',             // tool-payload condenser
];

// claude-mem wraps what it sends its own agents in this banner; strip it before
// matching (measured: 211 of 341 observer sessions open with it).
const NON_USER_BANNER = '[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]';

// sdk_sessions.user_prompt is often clipped to ~80 chars plus '…' — a clipped
// opener still counts when it is a long enough prefix of one of ours.
const CLIP_MIN = 24;

// The panel's explain call goes through runAgent's generic engineer role, so
// its opener is shared with real agent runs — match the task line too.
export const EXPLAIN_TASK_PREFIX = 'Explain the following in plain, concise English for a smart non-expert.';
const SELF_PROMPT_RES = [
  /^You are a senior software engineer\.[^\n]*\n+# Task\nExplain the following in plain, concise English for a smart non-expert\./,
];

export function isSelfPrompt(text) {
  if (typeof text !== 'string' || !text) return false;
  let t = text.trimStart();
  if (t.startsWith(NON_USER_BANNER)) t = t.slice(NON_USER_BANNER.length).trimStart();
  if (SELF_PROMPT_PREFIXES.some((p) => t.startsWith(p)) || SELF_PROMPT_RES.some((re) => re.test(t))) return true;
  if (t.endsWith('…')) {
    const head = t.slice(0, -1).trimEnd();
    if (head.length >= CLIP_MIN && SELF_PROMPT_PREFIXES.some((p) => p.startsWith(head))) return true;
  }
  return false;
}

// One parsed ingest item ({ cwd?, prompts[], transcript }) → is it our own run?
// The transcript fallback covers parsers whose prompt list filtered the opener.
export function isSelfCaptureItem(it) {
  if (!it || typeof it !== 'object') return false;
  if (isSelfRunCwd(it.cwd)) return true;
  if (Array.isArray(it.prompts) && isSelfPrompt(it.prompts[0])) return true;
  const tr = typeof it.transcript === 'string' ? it.transcript : '';
  return tr.startsWith('user:') && isSelfPrompt(tr.slice(5));
}

// SQL guard for readers that pick sessions in SQL (the distiller's pending
// queue): `<col>` does NOT start with any internal prompt, with or without
// claude-mem's banner. Prefix-only — the regex and clipped forms are rare
// enough to leave to the JS check.
const likeLit = (s) => "'" + s.replace(/'/g, "''").replace(/[\\%_]/g, (c) => '\\' + c) + "%'";
const WS = "' '||char(9)||char(10)||char(13)";
export function notSelfPromptSql(col) {
  const trimmed = `LTRIM(COALESCE(${col}, ''), ${WS})`;
  const body = `(CASE WHEN ${trimmed} LIKE ${likeLit(NON_USER_BANNER)} ESCAPE '\\' ` +
    `THEN LTRIM(substr(${trimmed}, ${NON_USER_BANNER.length + 1}), ${WS}) ELSE ${trimmed} END)`;
  return '(' + SELF_PROMPT_PREFIXES
    .map((p) => `${body} NOT LIKE ${likeLit(p)} ESCAPE '\\'`)
    .join(' AND ') + ')';
}

// ── Row-level predicates (stored rows, not parsed items) ─────────────────────
// Shared by `brain clean --self-capture` and every path that copies rows in
// from elsewhere — `brain merge` (import.mjs, via dropSelfCaptureRows), and the
// sync's claude-mem pull, cloud merge and restore (import-claude-mem.mjs and
// bundle.mjs, via clean.mjs findSelfCapture) — so a cleaned row stays gone.

// sdk_sessions.user_prompt holds the session's first prompt (ingest: its title).
export const isSelfSessionRow = (r) => !!r && isSelfPrompt(r.user_prompt);

// An observation that IS a captured run: its title is the prompt, or its raw
// transcript opens with it. (Rows DERIVED from such a session — e.g. a distilled
// one — are caught by session id, not by text.)
export function isSelfObservationRow(r) {
  if (!r) return false;
  if (isSelfPrompt(r.title)) return true;
  for (const t of [r.text, r.narrative]) {
    if (typeof t === 'string' && t.startsWith('user:') && isSelfPrompt(t.slice(5))) return true;
  }
  return false;
}

// Content-session ids whose FIRST prompt (lowest prompt_number) is ours.
export function selfPromptSessionIds(promptRows) {
  const first = new Map();
  for (const r of promptRows || []) {
    if (!r || r.content_session_id == null) continue;
    const cur = first.get(r.content_session_id);
    if (!cur || Number(r.prompt_number) < Number(cur.prompt_number)) first.set(r.content_session_id, r);
  }
  const out = new Set();
  for (const [csid, r] of first) if (isSelfPrompt(r.prompt_text)) out.add(csid);
  return out;
}

// Drop every self-capture row from one batch of exported rows. Returns the kept
// arrays plus how many were dropped.
export function dropSelfCaptureRows({ sessions = [], observations = [], summaries = [], prompts = [] } = {}) {
  const csids = selfPromptSessionIds(prompts);
  const msids = new Set();
  for (const s of sessions) {
    if (isSelfSessionRow(s) || csids.has(s.content_session_id)) {
      csids.add(s.content_session_id);
      if (s.memory_session_id) msids.add(s.memory_session_id);
    }
  }
  const keep = {
    sessions: sessions.filter((s) => !csids.has(s.content_session_id)),
    observations: observations.filter((o) => !msids.has(o.memory_session_id) && !isSelfObservationRow(o)),
    summaries: summaries.filter((s) => !msids.has(s.memory_session_id)),
    prompts: prompts.filter((p) => !csids.has(p.content_session_id)),
  };
  const dropped = (sessions.length - keep.sessions.length) + (observations.length - keep.observations.length) +
    (summaries.length - keep.summaries.length) + (prompts.length - keep.prompts.length);
  return { ...keep, dropped };
}
