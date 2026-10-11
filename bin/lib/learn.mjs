// Self-improving loop: distill completed agent runs into reusable "learnings"
// (a growing skill library in the brain), and surface matching past learnings so
// future runs get smarter. This is the closed loop — run → distill → store →
// reuse — inspired by Nous Hermes' skill-learning, minus the RL fine-tuning.
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, sanitizeName } from './paths.mjs';

const DIR = join(REPO_ROOT, 'learnings');
const SCORES = join(DIR, '.scores.json');
const DRAFTS = join(DIR, '_drafts');

// Learning files only: real .md files directly in DIR — never _drafts/ (a directory,
// so readdirSync already excludes it as a "file" match) or dotfiles like .scores.json.
function learningFiles() {
  return readdirSync(DIR).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
}

function readScores() {
  if (!existsSync(SCORES)) return {};
  try {
    return JSON.parse(readFileSync(SCORES, 'utf8'));
  } catch {
    // Corrupt (e.g. truncated by a crash mid-write). Don't silently return {} — that would
    // let the next write erase all history. Preserve the bad file for recovery, then start fresh.
    try { renameSync(SCORES, SCORES + '.corrupt'); } catch {}
    return {};
  }
}
function writeScores(s) {
  mkdirSync(DIR, { recursive: true });
  // Atomic: write to a temp file then rename, so a crash can't leave truncated JSON.
  const tmp = SCORES + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  renameSync(tmp, SCORES);
}

function slug(s) {
  return sanitizeName((s || 'learning').toLowerCase().replace(/\s+/g, '-')).slice(0, 60);
}

// Save an agent run (or any lesson) as a reusable learning note.
export function saveLearning({ role, tool, task, output, tags = [] }) {
  mkdirSync(DIR, { recursive: true });
  const now = new Date().toISOString();
  const stamp = now.replace(/[:.]/g, '-');
  const file = `${stamp}__${slug(task)}.md`;
  const body = [
    `# ${task.slice(0, 100)}`,
    '',
    `- when: ${now}`,
    `- role: ${role || ''}`,
    `- via: ${tool || ''}`,
    tags.length ? `- tags: ${tags.join(', ')}` : '',
    '',
    '## Task',
    task,
    '',
    '## What worked / result',
    output || '',
    '',
  ].join('\n');
  writeFileSync(join(DIR, file), body);
  return { file, when: now };
}

export function listLearnings() {
  if (!existsSync(DIR)) return [];
  return learningFiles()
    .sort()
    .reverse()
    .map((f) => {
      const txt = readFileSync(join(DIR, f), 'utf8');
      const title = (txt.match(/^#\s*(.+)/m) || [, f])[1];
      const when = (txt.match(/when:\s*(.+)/) || [, ''])[1];
      const role = (txt.match(/role:\s*(.+)/) || [, ''])[1];
      return { file: f, title: title.trim(), when: when.trim(), role: role.trim() };
    });
}

export function readLearning(file) {
  const p = join(DIR, sanitizeName(file));
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

export function readDraft(file) {
  const p = join(DRAFTS, sanitizeName(file));
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// Find past learnings relevant to a task (for injection into new runs). Ranks by
// keyword match weighted by proven usefulness: score = kw * (1 + helped/max(used,1)).
export function searchLearnings(task, limit = 3) {
  if (!existsSync(DIR)) return [];
  const words = task.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const scores = readScores();
  const scored = [];
  for (const f of learningFiles()) {
    const txt = readFileSync(join(DIR, f), 'utf8').toLowerCase();
    const kw = words.reduce((n, w) => n + (txt.includes(w) ? 1 : 0), 0);
    if (kw > 0) {
      const sc = scores[f] || {};
      const rank = kw * (1 + (sc.helped || 0) / Math.max(sc.used || 0, 1));
      scored.push({ f, rank, lastUsed: sc.lastUsed || '', txt: readFileSync(join(DIR, f), 'utf8') });
    }
  }
  return scored
    .sort((a, b) => b.rank - a.rank || b.lastUsed.localeCompare(a.lastUsed) || b.f.localeCompare(a.f))
    .slice(0, limit)
    .map((x) => {
      const title = (x.txt.match(/^#\s*(.+)/m) || [, x.f])[1].trim();
      // Prefer the "What worked / result" section (saved learnings); fall back to the body
      // after the title + `- key:` metadata block (auto-distilled drafts use ## Problem/Fix/…).
      const body = x.txt.replace(/^#[^\n]*\n?/, '').replace(/^(?:\s*-\s[^\n]*\n?)+/m, '').trim();
      const result = (x.txt.split('## What worked / result')[1] || body).trim().slice(0, 400);
      return { file: x.f, title, result };
    });
}

// Called at injection time for each learning folded into a prompt.
export function recordUsage(files = []) {
  if (!files.length) return;
  const s = readScores();
  const now = new Date().toISOString();
  for (const f of files) {
    const e = s[f] || { used: 0, helped: 0, lastUsed: '' };
    e.used += 1; e.lastUsed = now; s[f] = e;
  }
  writeScores(s);
}
// Ground-truth feedback from the UI. direction: 'up' | 'down'.
export function recordFeedback(file, direction) {
  const f = sanitizeName(file);
  const s = readScores();
  const e = s[f] || { used: 0, helped: 0, lastUsed: '' };
  e.helped += direction === 'down' ? -1 : 1;
  s[f] = e; writeScores(s);
  return { file: f, ...e };
}
export function readScoresPublic() { return readScores(); } // for lint

export function learningsCount() {
  return existsSync(DIR) ? learningFiles().length : 0;
}

// ── Drafts (auto-distilled, pending approval — never counted as learnings above) ──
export function listDrafts() {
  if (!existsSync(DRAFTS)) return [];
  return readdirSync(DRAFTS)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .map((f) => {
      const txt = readFileSync(join(DRAFTS, f), 'utf8');
      const title = (txt.match(/^#\s*(.+)/m) || [, f])[1];
      const when = (txt.match(/when:\s*(.+)/) || [, ''])[1];
      const source = (txt.match(/source:\s*(.+)/) || [, ''])[1];
      const project = (txt.match(/project:\s*(.+)/) || [, ''])[1];
      const file2 = (txt.match(/^-\s*file:\s*(.+)/m) || [, ''])[1];
      return { file: f, title: title.trim(), when: when.trim(), source: source.trim(), project: project.trim(), draftFile: file2.trim() };
    });
}

export function approveDraft(file) {
  const name = sanitizeName(file);
  const from = join(DRAFTS, name);
  if (!existsSync(from)) return { ok: false, error: 'draft not found' };
  mkdirSync(DIR, { recursive: true });
  const to = join(DIR, name);
  writeFileSync(to, readFileSync(from, 'utf8'));
  rmSync(from);
  return { ok: true, file: name };
}

export function dismissDraft(file) {
  const name = sanitizeName(file);
  const p = join(DRAFTS, name);
  if (!existsSync(p)) return { ok: false, error: 'draft not found' };
  rmSync(p);
  return { ok: true };
}
