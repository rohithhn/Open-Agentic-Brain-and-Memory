// Auto-distill: detect resolved-struggle episodes in the observation stream and
// draft candidate learnings into learnings/_drafts/ (never auto-approved — a human
// must approve in the UI). Stage 1 is a deterministic per-file detector; Stage 2
// hands each candidate to the user's own CLI to judge + write the draft, or SKIP.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.mjs';
import { MEMORY_DB, REPO_ROOT, sanitizeName } from './paths.mjs';
import { CLIS, availableTools } from './agent.mjs';
import { binPath, childPath } from './wire-targets.mjs';
import { ensureSelfRunDir } from './selfcapture.mjs';
import { liveOnly } from './lifecycle.mjs';

const DRAFTS = join(REPO_ROOT, 'learnings', '_drafts');

// "Resolved" is a text signal over title+subtitle+facts — no dedicated type exists.
const RESOLVE = /\b(fixed|resolv|verif|succeed|passe|passing|works|working|no errors|green|now finds)\b/i;

// Group obs by session (within window), find files hit by >=3 bugfix obs, then the
// first resolution-signal obs at/after the last bugfix in that same session.
export function findStruggles({ sinceMs, maxCandidates = 8 } = {}) {
  const db = openDb(MEMORY_DB, { readonly: true });
  let rows;
  try {
    // Drafts become wiki learnings that reach prompts: a deleted row is no source.
    rows = db.prepare(`SELECT id, memory_session_id sess, project, type, title, subtitle, facts,
      narrative, files_modified, created_at_epoch ep FROM observations o
      WHERE created_at_epoch > ?${liveOnly(db)} ORDER BY created_at_epoch ASC`).all(sinceMs);
  } finally { db.close(); }
  const parseFiles = (s) => { try { const a = JSON.parse(s||'[]'); return Array.isArray(a)?a:[]; } catch { return []; } };
  const bySess = new Map();
  for (const r of rows) { if (!bySess.has(r.sess)) bySess.set(r.sess, []); bySess.get(r.sess).push(r); }
  const out = [];
  // A) Resolved-struggle: a file hit by >=2 bug fixes in a session, then resolved.
  for (const [, obs] of bySess) {
    const fileBugs = new Map();
    for (const o of obs) if (o.type === 'bugfix') for (const f of parseFiles(o.files_modified)) {
      if (!fileBugs.has(f)) fileBugs.set(f, []); fileBugs.get(f).push(o);
    }
    for (const [file, bugs] of fileBugs) {
      if (bugs.length < 2) continue;
      const lastBugEp = Math.max(...bugs.map(b => b.ep));
      const resolver = obs.find(o => o.ep >= lastBugEp && RESOLVE.test(`${o.title||''} ${o.subtitle||''} ${o.facts||''}`));
      if (!resolver) continue;
      out.push({ kind: 'struggle', project: obs[0].project, file, attempts: bugs.length, session: obs[0].sess,
        struggle: bugs.map(b => ({ title: b.title, facts: b.facts })),
        resolution: { title: resolver.title, facts: resolver.facts, narrative: resolver.narrative } });
    }
  }
  // B) Explicit decisions: each `decision` observation is a reusable rationale.
  for (const r of rows) {
    if (r.type !== 'decision') continue;
    if (!(r.title || '').trim()) continue;
    out.push({ kind: 'decision', project: r.project, file: '(decision)', attempts: 1, session: r.sess,
      struggle: [], resolution: { title: r.title, facts: r.facts, narrative: r.narrative } });
  }
  // Dedupe by project+file+resolution.title; struggles (most attempts) first, then decisions; cap.
  const seen = new Set();
  return out.sort((a,b)=> (b.kind==='struggle'?b.attempts:0) - (a.kind==='struggle'?a.attempts:0)).filter(c => {
    const k = `${c.project}|${c.file}|${c.resolution.title}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  }).slice(0, maxCandidates);
}

function pickCli() {
  const avail = availableTools();
  for (const id of ['claude', 'codex', 'antigravity']) {
    const t = avail.find((x) => x.id === id);
    if (t && t.available) return CLIS[id];
  }
  return null;
}

function buildPrompt(c) {
  if (c.kind === 'decision') {
    const detail = (c.resolution.facts || c.resolution.narrative || '').slice(0, 400);
    return `You are distilling a reusable engineering DECISION into a durable note.
PROJECT: ${c.project}
DECISION: ${c.resolution.title}
DETAILS: ${detail}

If this is NOT a generalizable, reusable decision (one-off, trivial, or too little signal), reply with
exactly: SKIP
Otherwise write a concise reusable note in this markdown shape and nothing else:
## Decision
## Why
## Applies when`;
  }
  const struggleLines = c.struggle.map((s) => `- ${s.title}: ${(s.facts || '').slice(0, 200)}`).join('\n');
  const resFacts = (c.resolution.facts || c.resolution.narrative || '').slice(0, 300);
  return `You are distilling a reusable engineering lesson from a real debugging episode.
A developer hit the same file repeatedly with bug fixes, then resolved it.

FILE: ${c.file}  (PROJECT: ${c.project}, ${c.attempts} fix attempts)
STRUGGLE (chronological bug fixes):
${struggleLines}
RESOLUTION:
- ${c.resolution.title}: ${resFacts}

If this is NOT a generalizable lesson (one-off typo, noise, or too little signal), reply with
exactly: SKIP
Otherwise write a concise reusable learning in this markdown shape and nothing else:
## Problem
## Root cause
## Fix
## Applies when`;
}

function slug(s) {
  return sanitizeName((s || 'draft').toLowerCase().replace(/\s+/g, '-')).slice(0, 60);
}

function draftPath(c) {
  const key = c.kind === 'decision'
    ? `${c.project}__decision__${c.resolution.title}`
    : `${c.project}__${c.file}__${c.resolution.title}`;
  return slug(key);
}

function writeDraft(c, body) {
  mkdirSync(DRAFTS, { recursive: true });
  const now = new Date().toISOString();
  const stamp = now.replace(/[:.]/g, '-');
  const file = `${stamp}__${draftPath(c)}.md`;
  const meta = c.kind === 'decision'
    ? ['- source: auto-distill', `- project: ${c.project}`, '- kind: decision', '- status: draft']
    : ['- source: auto-distill', `- project: ${c.project}`, `- file: ${c.file}`, `- attempts: ${c.attempts}`, '- status: draft'];
  const md = [
    `# ${(c.resolution.title || 'Untitled').slice(0, 100)}`,
    '',
    `- when: ${now}`,
    ...meta,
    '',
    body,
    '',
  ].join('\n');
  writeFileSync(join(DRAFTS, file), md);
  return file;
}

// Idempotent-ish: skip if a draft for the same project+file+resolution already exists.
function draftAlreadyExists(c) {
  if (!existsSync(DRAFTS)) return false;
  const key = draftPath(c);
  return readdirSync(DRAFTS).some((f) => f.includes(key));
}

// Stage 2: judge/draft each candidate via the user's own CLI. Returns
// { candidates, drafted, skipped }. Never writes into the live learnings/ library.
export function doDistill({ sinceHours = 24, dry = false, maxCandidates = 8, log = console.log } = {}) {
  const sinceMs = Date.now() - sinceHours * 3600e3;
  const candidates = findStruggles({ sinceMs, maxCandidates });
  if (dry) return { candidates, drafted: 0, skipped: 0 };

  const cli = pickCli();
  if (!cli) {
    log('  ⚠ no CLI on PATH (claude/codex/agy) — drafts require one, skipping Stage 2');
    return { candidates, drafted: 0, skipped: candidates.length };
  }

  let drafted = 0, skipped = 0;
  const env = { ...process.env, BRAIN_DISTILLER: '1', PATH: childPath() };
  // Run in the brain's own cwd so ingest never captures these runs as user work.
  const cwd = ensureSelfRunDir();
  for (const c of candidates) {
    if (draftAlreadyExists(c)) { log(`  ⏭  ${c.file}: draft already exists, skipping`); skipped++; continue; }
    const prompt = buildPrompt(c);
    let output = '';
    try {
      output = execFileSync(binPath(cli.bin) || cli.bin, cli.args(prompt), {
        encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, env, cwd,
      });
    } catch (e) {
      output = e.stdout || '';
    }
    const trimmed = (output || '').trim();
    if (!trimmed || trimmed === 'SKIP') { log(`  ⏭  ${c.file}: SKIP`); skipped++; continue; }
    const file = writeDraft(c, trimmed);
    log(`  ✍  ${c.file}: drafted → learnings/_drafts/${file}`);
    drafted++;
  }
  return { candidates, drafted, skipped };
}
