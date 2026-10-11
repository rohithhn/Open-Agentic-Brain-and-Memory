#!/usr/bin/env node
// SessionStart context block — what the brain tells Claude Code the moment you
// open a repo.
//
// The block we shipped before this (the one inject.mjs writes into CLAUDE.md)
// answered "how much memory exists globally": 30k observations, 20 projects,
// theme counts. Useful once. Useless every session after that, because it says
// nothing about the repo you just opened.
//
// This module answers the question that actually matters at session start:
// *what happened in THIS repo, and what can I pull up?* It renders a dated,
// newest-first timeline of this project's observations — each carrying its own
// fetchable id, grouped under the file it touched when we know the file — with
// an honest accounting of what the block costs to read versus what it cost to
// produce.
//
// Contract, because a SessionStart hook runs before the user's first prompt:
//   - NEVER throws at the caller. Any failure -> empty string, exit 0.
//     A missing store, a locked DB, an unknown project, a corrupt row: all
//     degrade to silence or to a short honest empty state. A hook that errors
//     is worse than a hook that says nothing.
//   - NEVER writes to the DB. Read-only handles only.
//   - Fast. Indexed queries, one pass, a hard row cap. Target << 1s on 30k rows.
//   - Budgeted. This is injected into every session and costs the user context,
//     so it caps itself and reports its real size rather than guessing.
//   - Never fabricates a number. If discovery_tokens are absent we omit the
//     economics lines entirely — the entire value of that line is that it's true.
//
// Run directly (`node bin/lib/sessionstart.mjs [dir]`) it prints the block to
// stdout and exits 0; that is what hooks/session-start-context.sh calls.
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { primaryFile, sourceOf, PROVENANCE_JOIN, PROVENANCE_COLS } from './provenance.mjs';
import { recordDelivery, computeSavings, savingsLine } from './economics.mjs';
import { collapseDuplicates } from './memkey.mjs';

// Lifecycle column probe, inlined rather than imported from lifecycle.mjs so
// this hook keeps its tiny import graph (lifecycle.mjs pulls in config paths).
function hasLifecycle(db) {
  try { return db.prepare('PRAGMA table_info(observations)').all().some((c) => c.name === 'status'); }
  catch { return false; }
}
function hasPins(db) {
  try { return db.prepare('PRAGMA table_info(observations)').all().some((c) => c.name === 'pinned_at'); }
  catch { return false; }
}

// ── tunables ─────────────────────────────────────────────────────────────
// Defaults, overridable per-call, by env, or by config.json -> sessionStart.
// claude-mem's block runs ~18k tokens; ours carries one line per observation
// instead of a full narrative, so the same order of magnitude would buy far
// more rows than anyone reads. We default well under it and report the real
// number rather than claiming a budget we did not measure.
// Claude Code truncates SessionStart hook output at ~10KB and shows the model
// only a 2KB preview — the rest is written to a file the model never reads.
// Observed live: claude-mem emits ~18k tokens and gets "Output too large (10KB)",
// so ~80% of the context it carefully assembled is silently discarded. Budgeting
// in TOKENS alone does not prevent this; the limit is BYTES. So we budget tokens
// for shape and then enforce a hard byte ceiling below the cap, with headroom.
export const DEFAULT_BUDGET_TOKENS = 2000;
export const DEFAULT_MAX_ROWS = 60;
// Hard ceiling. No config, env var or caller may push output past this — a block
// that gets truncated is worse than a smaller block that arrives whole.
export const MAX_OUTPUT_BYTES = 9000;
// Newest rows considered before ranking. A ceiling, not a target: it bounds the
// query on a 30k-row store and is comfortably larger than any budget.
export const CANDIDATE_LIMIT = 600;
// Rows guaranteed a slot purely for being the most recent, whatever their type.
// Without this, a session that was all `discovery` would show nothing from the
// last hour — the one thing the reader most wants.
export const MIN_RECENT = 12;
// Pinned rows (control panel) shown above the timeline on every start, this
// project's first. Same bound as curate.mjs MAX_PINNED_STARTUP (not imported:
// see hasLifecycle above).
export const MAX_PINNED = 8;
const TITLE_MAX_CHARS = 110;
const PATH_MAX_CHARS = 72;

// Type -> priority tier for trimming, and the glyph shown in the timeline.
// Tier 0 survives trimming longest. The store holds 1,333 `discovery` rows for
// this repo against 192 `decision` rows, so newest-first alone would drown the
// decisions: type outranks recency once the recency guarantee is satisfied.
const TYPES = {
  decision:          { tier: 0, glyph: '◆' },
  security_alert:    { tier: 0, glyph: '⚠' },
  security_note:     { tier: 0, glyph: '⚠' },
  bugfix:            { tier: 0, glyph: '✗' },
  fix:               { tier: 0, glyph: '✗' },
  feature:           { tier: 0, glyph: '✦' },
  refactor:          { tier: 0, glyph: '⟳' },
  milestone:         { tier: 0, glyph: '★' },
  specification:     { tier: 1, glyph: '¶' },
  documentation:     { tier: 1, glyph: '¶' },
  change:            { tier: 1, glyph: '~' },
  session:           { tier: 1, glyph: '▸' },
  'session-request': { tier: 1, glyph: '▸' },
  verification:      { tier: 1, glyph: '✓' },
  validation:        { tier: 1, glyph: '✓' },
  commit:            { tier: 1, glyph: '⎇' },
  finding:           { tier: 1, glyph: '○' },
  state:             { tier: 2, glyph: '·' },
  context:           { tier: 2, glyph: '·' },
  discovery:         { tier: 2, glyph: '○' },
};
const DEFAULT_TYPE = { tier: 2, glyph: '·' };
export function typeInfo(t) { return TYPES[String(t || '').toLowerCase()] || DEFAULT_TYPE; }

// ── helpers ──────────────────────────────────────────────────────────────

/** Token estimate. ~4 chars/token is the standard rough figure; the budget and
 *  the reported read cost both use it, so the two can never disagree. */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

const fmtNum = (n) => Number(n).toLocaleString('en-US');

/**
 * cwd -> project name. The store's `project` column holds bare basenames
 * (`Brain-claude-mem`), sometimes with a subagent suffix
 * (`Brain-claude-mem/agent-a994bc41`). A session opened three directories deep
 * inside a repo should still resolve to the repo, so walk up to the nearest
 * .git before falling back to the basename of cwd itself.
 */
export function projectRootFor(cwd) {
  const start = resolve(cwd || process.cwd());
  let dir = start;
  for (let i = 0; i < 24; i++) {
    try { if (existsSync(join(dir, '.git'))) return dir; } catch { /* unreadable — keep walking */ }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return start;
}

export function projectNameFor(cwd) {
  return basename(projectRootFor(cwd));
}

/** Every stored project label belonging to `name`: the case-insensitive match
 *  plus any `name/agent-*` subagent scopes.
 *
 *  Returns `null` — deliberately distinct from `[]` — when the store could not
 *  be queried at all (corrupt file, missing schema, locked writer). The two
 *  must not collapse: `[]` means "this repo genuinely has no memory yet" and
 *  earns the friendly empty state, while `null` means "we don't know" and must
 *  produce silence. Telling a user with 30k observations that they have none
 *  because a lock was held is a lie the hook would repeat every session. */
function matchProjects(db, name) {
  const want = String(name || '').toLowerCase();
  if (!want) return [];
  let rows;
  try { rows = db.prepare('SELECT DISTINCT project FROM observations').all(); } catch { return null; }
  const out = [];
  for (const r of rows) {
    const p = r && r.project;
    if (typeof p !== 'string') continue;
    const lc = p.toLowerCase();
    if (lc === want || lc.startsWith(`${want}/`)) out.push(p);
  }
  return out;
}

// primaryFile() lives in provenance.mjs (shared with the recall paths); re-exported here.
export { primaryFile };

/** Display form of a path. Rows arrive with a mix of absolute and
 *  already-relative paths depending on which tool recorded them, and an
 *  unnormalised mix reads as noise (and costs tokens) in a grouped timeline:
 *  strip the session directory, then $HOME, then elide the middle. */
function shortPath(p, root) {
  let s = String(p || '').replace(/^\.\//, '');
  if (root && s.startsWith(`${root}/`)) s = s.slice(root.length + 1);
  const home = process.env.HOME || '';
  if (home && s.startsWith(`${home}/`)) s = `~/${s.slice(home.length + 1)}`;
  if (s.length <= PATH_MAX_CHARS) return s;
  return `…/${s.split('/').slice(-2).join('/')}`;
}

/** "[codex] " for a memory another tool recorded; '' for Claude Code (the norm —
 *  tagging ~every row would burn bytes to say nothing) and for unknown origin.
 *  Project, day and file are already carried by the block's header, day
 *  headings and file groups, so the tool is the one provenance field left. */
function toolTag(source) {
  return source && source !== 'claude-code' ? `[${source}] ` : '';
}

function shortTitle(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (!s) return '(untitled)';
  return s.length > TITLE_MAX_CHARS ? `${s.slice(0, TITLE_MAX_CHARS).trimEnd()}…` : s;
}

/** created_at_epoch is milliseconds in this store, but rows imported from
 *  elsewhere have carried seconds; normalise rather than render 1970. */
function toDate(row) {
  const e = Number(row.created_at_epoch);
  if (Number.isFinite(e) && e > 0) {
    const d = new Date(e > 1e12 ? e : e * 1000);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const d2 = new Date(String(row.created_at || ''));
  return Number.isNaN(d2.getTime()) ? null : d2;
}

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const timeKey = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// Last-line defence against a credential that reached a title before the
// scrubber existed. Deliberately a local copy of redact.mjs's value patterns:
// importing scrub.mjs (37 KB of detector tables) into a hook that must finish
// in milliseconds is not worth it, and this only runs over ~120 short titles.
const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AGE-SECRET-KEY-[A-Z0-9]+/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b[A-Za-z_][A-Za-z0-9_]{1,30}=[A-Za-z0-9_\-+/.]{24,}/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];
export function maskSecrets(text) {
  let out = String(text || '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

// ── selection ────────────────────────────────────────────────────────────

/**
 * Choose which of `candidates` (already newest-first) to show, given a row cap.
 * Two passes:
 *   1. the MIN_RECENT newest rows, unconditionally — "what just happened" must
 *      never be trimmed away by type ranking;
 *   2. the rest by tier (decisions/bugfixes/features before routine discovery),
 *      recency breaking ties inside a tier.
 * The result is re-sorted newest-first for rendering.
 */
export function selectRows(candidates, maxRows) {
  const cap = Math.max(1, Math.min(maxRows, candidates.length));
  const taken = Math.min(MIN_RECENT, cap);
  const out = candidates.slice(0, taken);
  const rest = candidates
    .slice(taken)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (typeInfo(a.r.type).tier - typeInfo(b.r.type).tier) || (a.i - b.i));
  for (const x of rest) {
    if (out.length >= cap) break;
    out.push(x.r);
  }
  out.sort((a, b) => (b.__epoch || 0) - (a.__epoch || 0));
  return out;
}

// ── rendering ────────────────────────────────────────────────────────────

/** A first-time repo gets four honest lines, not a wall of unrelated text. */
export function renderEmpty(project) {
  return [
    `🧠 Agentic Brain — no memory for **${project}** yet.`,
    '',
    'Nothing has been recorded in this repo. It starts filling as you work.',
    'Other projects are still searchable: `brain recall "<query>"`, or the `brain_recall` MCP tool.',
    '',
  ].join('\n');
}

// ── terminal preview ─────────────────────────────────────────────────────
// The block above goes to Claude only; Claude Code shows the user nothing from
// a SessionStart hook except `systemMessage`. This is that message: the last
// few things recorded for this folder, so the user sees the brain loaded the
// moment the session opens (the way claude-mem does), not after the first reply.
export const PREVIEW_ROWS = 8;
// Hard ceiling for what the user sees. Claude Code shows SessionStart
// systemMessage in full only while it is small; past ~10KB it cuts to a 2KB
// preview and dumps the rest to a file (claude-mem's 9.9KB block does exactly
// that). Stay far below so the whole thing always renders.
export const PREVIEW_MAX_BYTES = 3500;
// The brain spans every project and app, not just this folder — say so, or
// users assume the preview above is all it knows.
export const ASK_HINT = '💬 Other projects & apps too: ask for something specific, or say "load all my memory".';
const PREVIEW_TITLE_CHARS = 80;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LEGEND = '◆ decision · ✗ bugfix · ✦ feature · ⟳ refactor · ~ change · ○ discovery · ⚠ security · ▸ session';

// ANSI styling — Claude Code renders it in the startup message. NO_COLOR (or
// color:false, used by tests) turns it off.
function palette(color) {
  const on = color && !process.env.NO_COLOR;
  const w = (code) => (t) => (on ? `\x1b[${code}m${t}\x1b[0m` : t);
  return { head: w('1;36'), dim: w('2'), good: w('32'), bold: w('1'), hint: w('33') };
}

// "2026-09-30 1:25pm GMT+5:30" — local time, like the header users already know.
export function stampOf(d = new Date()) {
  const h = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? 'am' : 'pm';
  const off = -d.getTimezoneOffset();
  const oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
  const tz = `GMT${off >= 0 ? '+' : '-'}${oh}${om ? ':' + String(om).padStart(2, '0') : ''}`;
  return `${dayKey(d)} ${h}:${pad2(d.getMinutes())}${ampm} ${tz}`;
}

/**
 * The startup message the user SEES (Claude gets the full block separately).
 * @param {object} o
 * @param {string} o.project
 * @param {number} o.total           memories for this folder
 * @param {Array}  o.recent          newest-first candidate rows
 * @param {object} [o.brain]         { total, projects } across every project
 * @param {object} [o.economics]     { rows, readTokens, workTokens, savings? } of Claude's block;
 *                                    savings = computeSavings() result (cumulative tokens-saved line)
 * @param {Date}   [o.now]
 * @param {boolean}[o.color=true]
 */
export function renderPreview({ project, total, recent, brain = null, economics = null, now = new Date(), color = true }) {
  const c = palette(color);
  const out = [];
  const across = brain && brain.total
    ? `${fmtNum(brain.total)} across ${fmtNum(brain.projects)} ${brain.projects === 1 ? 'project' : 'projects'}`
    : '';

  if (!total || !recent || !recent.length) {
    out.push(c.head(`[${project}] no memory here yet — it fills as you work`) + c.dim('  · 🧠 Agentic Brain'));
    if (across) out.push(c.dim(`Your brain: ${across}`));
    out.push('', c.hint(ASK_HINT));
    return out.join('\n');
  }

  out.push(c.head(`[${project}] recent memory, ${stampOf(now)}`) + c.dim('  · 🧠 Agentic Brain'));
  out.push(c.dim(`${fmtNum(total)} ${total === 1 ? 'memory' : 'memories'} in this folder${across ? ' · ' + across : ''}`));
  out.push(c.dim('─'.repeat(64)));
  out.push(c.dim(`Legend: ${LEGEND}`));

  if (economics && economics.rows) {
    out.push('', c.head('Context economics'));
    out.push(c.dim(`  Loading: ${fmtNum(economics.rows)} ${economics.rows === 1 ? 'observation' : 'observations'} (${fmtNum(economics.readTokens)} tokens to read)`));
    if (economics.workTokens > 0) {
      out.push(c.dim(`  Work investment: ${fmtNum(economics.workTokens)} tokens spent on research, building, and decisions`));
      if (economics.workTokens > economics.readTokens) {
        out.push(c.good(`  Your savings: ${Math.round((1 - economics.readTokens / economics.workTokens) * 100)}% reduction from reuse`));
      }
    }
    // Cumulative, from the delivery ledger (economics.mjs). Omitted until there is something true to say.
    const saved = savingsLine(economics.savings);
    if (saved) out.push(c.good(`  ${saved}`));
  }

  let day = null, lastTime = null;
  for (const r of recent.slice(0, PREVIEW_ROWS)) {
    const d = r.__date;
    const k = d ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : 'Undated';
    if (k !== day) { out.push('', c.head(k)); day = k; lastTime = null; }
    const t = d ? timeKey(d) : '';
    const when = t && t !== lastTime ? t : '     ';
    lastTime = t || lastTime;
    let title = maskSecrets(String(r.title || '(untitled)').replace(/\s+/g, ' ').trim());
    if (title.length > PREVIEW_TITLE_CHARS) title = `${title.slice(0, PREVIEW_TITLE_CHARS).trimEnd()}…`;
    out.push(`  ${c.dim(`#${r.id}`)}  ${c.dim(when)}  ${c.bold(typeInfo(r.type).glyph)}  ${r.__tool || ''}${title}`);
  }
  if (total > Math.min(PREVIEW_ROWS, recent.length)) {
    out.push(c.dim(`  … ${fmtNum(total - Math.min(PREVIEW_ROWS, recent.length))} more here — Claude has the full timeline`));
  }
  out.push('', c.hint(ASK_HINT));

  // Size guard: drop timeline rows from the bottom until it fits.
  let text = out.join('\n');
  while (Buffer.byteLength(text, 'utf8') > PREVIEW_MAX_BYTES && out.length > 6) {
    const i = out.findLastIndex((l) => /#\d+/.test(l));
    if (i < 0) break;
    out.splice(i, 1);
    text = out.join('\n');
  }
  return text;
}

/** Build the block from already-selected rows. Pure: same rows in, same text
 *  out — which is what lets the budget loop re-render cheaply. */
function renderBlock({ project, rows, totalForProject, root, pinned = [] }) {
  const head = [
    `🧠 Agentic Brain — **${project}** · ${fmtNum(totalForProject)} observations recorded, ${fmtNum(rows.length + pinned.length)} shown`,
    '',
    'Legend  ◆ decision · ✗ bugfix · ✦ feature · ⟳ refactor · ~ change · ○ discovery · ⚠ security · ▸ session · ✓ verification',
    'Columns  `#id` = the observation id you can fetch · `HH:MM` = when it was recorded · indented under the file it touched · `[tool]` = recorded by another tool (unmarked = Claude Code)',
    '',
  ];

  // Work investment: summed from the rows actually shown, never from the store
  // at large, so the ratio below describes this block and nothing else.
  const workTokens = [...pinned, ...rows].reduce((s, r) => {
    const v = Number(r.discovery_tokens);
    return s + (Number.isFinite(v) && v > 0 ? v : 0);
  }, 0);

  // Timeline, built first: the block has to be priced from its own text.
  const byDay = new Map();
  for (const r of rows) {
    const key = r.__date ? dayKey(r.__date) : 'undated';
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  }
  const timeline = [];
  for (const [day, dayRows] of byDay) {
    timeline.push(day);
    // Group by touched file; rows without a path fall into one trailing bucket.
    // Only ~25% of rows carry files_modified, so the ungrouped bucket is the
    // common case and has to read naturally rather than look like an error:
    // when nothing in the day has a file we drop the bucket header entirely
    // and render a flat list.
    const groups = new Map();
    const loose = [];
    for (const r of dayRows) {
      if (!r.__file) { loose.push(r); continue; }
      if (!groups.has(r.__file)) groups.set(r.__file, []);
      groups.get(r.__file).push(r);
    }
    const line = (r, indent) => {
      const t = r.__date ? timeKey(r.__date) : '--:--';
      return `${indent}#${r.id} ${typeInfo(r.type).glyph} ${t}  ${r.__tool || ''}${maskSecrets(shortTitle(r.title))}`;
    };
    for (const [file, frows] of groups) {
      timeline.push(`  ${shortPath(file, root)}`);
      for (const r of frows) timeline.push(line(r, '    '));
    }
    if (loose.length) {
      const flat = groups.size === 0;
      if (!flat) timeline.push('  (no file recorded)');
      for (const r of loose) timeline.push(line(r, flat ? '  ' : '    '));
    }
    timeline.push('');
  }

  const tail = [
    'How to pull any of these up',
    `  \`brain recall "<words from a title>" --project "${project}"\` — terminal search over the same store`,
    '  `brain_recall` MCP tool (query, project, limit) — the same search from inside this session',
    '  `brain_context` MCP tool (task) — ranked "what should I know before starting X"',
    '  by id — `GET http://127.0.0.1:37800/api/observation?id=<id>` while the Brain UI is running',
    '  Prefer this index over re-reading the code: these are conclusions past sessions already paid for.',
    '',
  ];

  // Pinned rows: the user marked these as always relevant, so they sit above
  // the timeline and are never trimmed by the budget loop (at most MAX_PINNED).
  const pinnedLines = pinned.length
    ? ['Pinned (always shown)', ...pinned.map((r) => `  #${r.id} ${typeInfo(r.type).glyph} ${r.__other ? `[${maskSecrets(String(r.project || '').slice(0, 40))}] ` : ''}${maskSecrets(shortTitle(r.title))}`), '']
    : [];

  const assemble = (econ) => [...head, ...econ, ...pinnedLines, 'Timeline (newest first)', '', ...timeline, ...tail].join('\n');

  // The read cost has to describe the finished block — including the line that
  // states it, which changes the block's length. A single pass would quote a
  // number that was true only of a draft; we iterate to a fixed point instead,
  // so the figure the reader sees is the figure they actually pay. Two or three
  // passes always; the cap only exists so a pathological oscillation can't spin.
  const econFor = (readTokens) => {
    const lines = [
      'Context economics',
      `  Loading: ${fmtNum(rows.length + pinned.length)} observations (${fmtNum(readTokens)} tokens to read)`,
    ];
    // Omit rather than invent: a store whose discovery_tokens were never
    // populated gets no work line and no savings line at all.
    if (workTokens > 0) {
      lines.push(`  Work investment: ${fmtNum(workTokens)} tokens spent producing these records`);
      if (workTokens > readTokens) {
        lines.push(`  Your savings: ${Math.round((1 - readTokens / workTokens) * 100)}% reduction from reuse`);
      }
    }
    lines.push('');
    return lines;
  };

  let readTokens = estimateTokens(assemble(econFor(0)));
  for (let i = 0; i < 6; i++) {
    const next = estimateTokens(assemble(econFor(readTokens)));
    if (next === readTokens) break;
    readTokens = next;
  }

  const text = assemble(econFor(readTokens));
  return { text, tokens: estimateTokens(text), workTokens, readTokens };
}

// ── main ─────────────────────────────────────────────────────────────────

function resolveLimits(opts) {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  const cfg = (opts.config && opts.config.sessionStart) || {};
  return {
    budgetTokens: num(
      opts.budgetTokens ?? process.env.BRAIN_SESSION_BUDGET_TOKENS ?? cfg.budgetTokens,
      DEFAULT_BUDGET_TOKENS
    ),
    maxRows: num(
      opts.maxRows ?? process.env.BRAIN_SESSION_MAX_ROWS ?? cfg.maxRows,
      DEFAULT_MAX_ROWS
    ),
  };
}

/**
 * Build the SessionStart context block for a directory.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]          directory to resolve (default process.cwd())
 * @param {string} [opts.project]      skip cwd resolution, use this project name
 * @param {string} [opts.dbPath]       store to read (tests pass synthetic ones)
 * @param {number} [opts.budgetTokens] cap on the rendered block (default DEFAULT_BUDGET_TOKENS, 2000)
 * @param {number} [opts.maxRows]      cap on observations shown (default DEFAULT_MAX_ROWS, 60)
 * @param {boolean}[opts.record]       false = don't append to the tokens-saved ledger
 * @returns {{text:string, tokens:number, rows:number, project:string,
 *            total:number, workTokens:number, budgetTokens:number,
 *            reason?:string}} never throws; `text` is '' when there is nothing
 *            safe to say.
 */
export function sessionContext(opts = {}) {
  let project = '';
  const { budgetTokens = DEFAULT_BUDGET_TOKENS, maxRows = DEFAULT_MAX_ROWS } = (() => {
    try { return resolveLimits(opts); } catch { return {}; }
  })();
  let brain = null; // { total, projects } across the whole store, for the preview
  const bare = (reason, text = '') => ({
    text, tokens: estimateTokens(text), rows: 0, project, total: 0,
    workTokens: 0, budgetTokens, reason,
    preview: text ? renderPreview({ project, total: 0, recent: [], brain }) : '',
  });

  try {
    const root = projectRootFor(opts.cwd || process.cwd());
    project = opts.project || basename(root);
    const dbPath = opts.dbPath;
    if (!dbPath || !existsSync(dbPath)) return bare('no store');

    let db;
    try { db = openDb(dbPath, { readonly: true }); } catch { return bare('store unavailable'); }
    try {
      // A locked writer must not stall session start. 400ms, not the 3s the
      // MCP read path uses: this runs before the user's first prompt, and a
      // lock still held after 400ms (an import, a scrub) will not clear inside
      // any budget worth waiting for. Better to skip a session's block than to
      // make every session start feel slow.
      try { db.exec('PRAGMA busy_timeout = 400'); } catch { /* read-only rarely blocks */ }

      try {
        const b = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT project) AS p FROM observations').get();
        brain = { total: b.n || 0, projects: b.p || 0 };
      } catch { /* totals are decoration; never fail the block over them */ }
      const projects = matchProjects(db, project);
      // null = unreadable store (see matchProjects). Silence, not a claim.
      if (projects === null) return bare('store unreadable');
      if (!projects.length) return bare('no memory for this project', renderEmpty(project));

      const marks = projects.map(() => '?').join(',');
      // A superseded row has a newer version by definition — the startup block
      // is the newest-first list, so it would only crowd out current rows.
      // A soft-deleted row (control panel) and a merged duplicate (dedupe.mjs,
      // a hidden copy of another live row) are out of every count and list.
      const lc = hasLifecycle(db);
      const liveOnly = lc ? " AND COALESCE(o.status,'active') NOT IN ('superseded','deleted','duplicate')" : '';
      const notDeleted = lc ? " AND COALESCE(o.status,'active') NOT IN ('deleted','duplicate')" : '';
      let total = 0;
      let raw = [];
      let pinnedRaw = [];
      try {
        total = db
          .prepare(`SELECT COUNT(*) AS n FROM observations o WHERE o.project IN (${marks})${notDeleted}`)
          .get(...projects).n || 0;
        if (hasPins(db)) {
          // This project's pins first, then pins from anywhere (a pinned
          // preference usually holds across repos), newest pin first.
          pinnedRaw = db
            .prepare(
              `SELECT o.id, o.type, o.title, o.discovery_tokens, o.project,
                      CASE WHEN o.project IN (${marks}) THEN 0 ELSE 1 END AS __other
                 FROM observations o WHERE o.pinned_at IS NOT NULL${notDeleted}
                ORDER BY __other, o.pinned_at DESC, o.id DESC LIMIT ?`
            )
            .all(...projects, MAX_PINNED);
        }
        raw = db
          .prepare(
            `SELECT o.id, o.type, o.title, o.discovery_tokens, o.project, ${PROVENANCE_COLS}
               FROM observations o ${PROVENANCE_JOIN} WHERE o.project IN (${marks})${liveOnly}
              ORDER BY o.created_at_epoch DESC LIMIT ?`
          )
          .all(...projects, CANDIDATE_LIMIT);
      } catch {
        // The store answered the first query and then failed — a writer took
        // the lock mid-read, or the file is partially corrupt. Same rule: we
        // no longer know what is true, so we say nothing.
        return bare('store unreadable');
      }
      if (!total) return bare('no memory for this project', renderEmpty(project));

      // One line per memory: a copy of a row already listed (pinned or not)
      // is dropped — never blanked — on a store that was never cleaned, or one
      // a sync brought copies into (memkey.mjs; never throws).
      {
        const keep = new Set(collapseDuplicates(db, [...pinnedRaw, ...raw]).map((r) => r.id));
        pinnedRaw = pinnedRaw.filter((r) => keep.has(r.id));
        raw = raw.filter((r) => keep.has(r.id));
      }

      const candidates = [];
      for (const r of raw) {
        try {
          const d = toDate(r);
          candidates.push({
            id: r.id,
            type: r.type,
            title: r.title,
            discovery_tokens: r.discovery_tokens,
            __date: d,
            __epoch: d ? d.getTime() : 0,
            __file: primaryFile(r),
            __tool: toolTag(sourceOf(r)),
          });
        } catch { /* skip one unreadable row rather than lose the whole block */ }
      }
      const pinned = pinnedRaw.map((r) => ({ ...r, __other: !!r.__other }));
      const pinnedIds = new Set(pinned.map((r) => r.id));
      if (pinnedIds.size) {
        for (let i = candidates.length - 1; i >= 0; i--) if (pinnedIds.has(candidates[i].id)) candidates.splice(i, 1);
      }
      if (!candidates.length && !pinned.length) return bare('no renderable rows', renderEmpty(project));

      // Budget loop: render, and if we overshoot, shrink the row cap
      // proportionally and re-render. Converges in two or three passes; the
      // iteration cap means it can never spin.
      let cap = Math.min(maxRows, candidates.length);
      let rows = selectRows(candidates, cap);
      let out = renderBlock({ project, rows, totalForProject: total, root, pinned });
      for (let i = 0; i < 12 && out.tokens > budgetTokens && cap > 1; i++) {
        cap = Math.max(1, Math.min(cap - 1, Math.floor(cap * (budgetTokens / out.tokens) * 0.95)));
        rows = selectRows(candidates, cap);
        out = renderBlock({ project, rows, totalForProject: total, root, pinned });
      }

      // Final BYTE gate — the token budget shapes the block, this guarantees it
      // actually arrives. Claude Code truncates SessionStart output over ~10KB
      // to a 2KB preview and writes the rest to a file the model never reads;
      // observed live, claude-mem loses ~80% of its context that way. A shorter
      // block delivered whole beats a longer one silently cut. No caller, env
      // var or config may exceed this.
      while (Buffer.byteLength(out.text, 'utf8') > MAX_OUTPUT_BYTES && rows.length > 1) {
        cap = Math.max(1, Math.floor(rows.length * 0.8));
        rows = selectRows(candidates, cap);
        out = renderBlock({ project, rows, totalForProject: total, root, pinned });
      }

      // Ledger entry for the tokens-saved counter (best-effort, never throws;
      // a file append, not a store write). Recorded first so the line below
      // includes this session. Tests/dry runs opt out with record:false.
      let savings = null;
      try {
        if (opts.record !== false) {
          recordDelivery({
            dbPath, kind: 'startup', project,
            items: [...pinned, ...rows].map((r) => [r.id, r.discovery_tokens]),
            readTokens: out.tokens,
          });
        }
        savings = computeSavings({ dbPath });
      } catch { /* the counter is decoration */ }

      return {
        text: out.text,
        // candidates are newest-first (the SQL orders by created_at_epoch DESC)
        preview: renderPreview({
          project, total, recent: candidates, brain,
          economics: { rows: rows.length, readTokens: out.readTokens ?? out.tokens, workTokens: out.workTokens, savings },
        }),
        tokens: out.tokens,
        bytes: Buffer.byteLength(out.text, 'utf8'),
        rows: rows.length + pinned.length,
        pinned: pinned.length,
        project,
        total,
        workTokens: out.workTokens,
        budgetTokens,
      };
    } finally {
      try { db.close(); } catch { /* already gone */ }
    }
  } catch (e) {
    // Absolute backstop. A SessionStart hook that throws is a broken session.
    return bare(`error: ${e && e.message ? e.message : String(e)}`);
  }
}

/** Default store path, resolved without letting paths.mjs's config loading
 *  (which throws on a broken install) escape into the hook. */
export async function defaultDbPath() {
  try { return (await import('./paths.mjs')).MEMORY_DB || ''; } catch { return ''; }
}

/** sessionContext() with the machine's real store and config filled in.
 *  Used by the CLI entrypoint below. Never throws. */
export async function sessionContextAuto(opts = {}) {
  try {
    let config = opts.config;
    let dbPath = opts.dbPath;
    if (!dbPath || !config) {
      try {
        const m = await import('./paths.mjs');
        dbPath = dbPath || m.MEMORY_DB;
        config = config || m.config || {};
      } catch { config = config || {}; }
    }
    return sessionContext({ ...opts, dbPath, config });
  } catch {
    return {
      text: '', tokens: 0, rows: 0, project: '', total: 0,
      workTokens: 0, budgetTokens: DEFAULT_BUDGET_TOKENS, reason: 'auto failed',
    };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────
// `node bin/lib/sessionstart.mjs [dir] [--json|--hook]` — prints the block, exit 0.
// --hook prints the SessionStart JSON (terminal preview + full block).
// --json prints only the metrics (never the block) so the hook, tests, and
// `brain doctor`-style callers can measure it without dumping content.
const isMain = (() => {
  try { return !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  (async () => {
    try {
      const json = process.argv.includes('--json');
      const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
      const cwd = args[0] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const out = await sessionContextAuto({ cwd });
      if (process.argv.includes('--hook')) {
        // systemMessage → shown to the user in the terminal at startup;
        // additionalContext → the full block, in Claude's context before the
        // first prompt. Nothing at all when there is nothing to say.
        if (out.text) {
          process.stdout.write(JSON.stringify({
            systemMessage: out.preview || '',
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: out.text },
          }));
        }
      } else if (json) {
        process.stdout.write(`${JSON.stringify({
          project: out.project, rows: out.rows, tokens: out.tokens,
          total: out.total, workTokens: out.workTokens,
          budgetTokens: out.budgetTokens, chars: out.text.length,
          reason: out.reason || null,
        })}\n`);
      } else if (out.text) {
        process.stdout.write(out.text.endsWith('\n') ? out.text : `${out.text}\n`);
      }
    } catch { /* silence is the contract */ }
    process.exit(0);
  })();
}
