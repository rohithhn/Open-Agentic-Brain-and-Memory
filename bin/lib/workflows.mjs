// Workflow mining. Mine recurring "rituals" from observation title-verbs
// (e.g. verify/test → commit, verify → deploy) and emit checklist pages to
// wiki/workflows/ so the brain can inject "here's your ritual" at task time.
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.mjs';
import { MEMORY_DB, REPO_WIKI, sanitizeName } from './paths.mjs';
import { liveOnly } from './lifecycle.mjs';

const WF_DIR = join(REPO_WIKI, 'workflows');
const VALIDATION = ['typecheck', 'test', 'verify'];
const TERMINAL = ['commit', 'push', 'deploy'];

function verbOf(t) {
  t = (t || '').toLowerCase();
  if (/version.?bump|bump.?version/.test(t)) return 'version-bump';
  if (/typecheck|tsc|compilation/.test(t)) return 'typecheck';
  if (/\bcommit/.test(t)) return 'commit';
  if (/\bpush/.test(t)) return 'push';
  if (/\bdeploy/.test(t)) return 'deploy';
  if (/verif/.test(t)) return 'verify';
  if (/\btest/.test(t)) return 'test';
  return null;
}

// A ritual = the set of VALIDATION verbs seen (in a session) before a TERMINAL verb.
// Signature: sorted(validationSet) + '→' + terminal. Count signatures across sessions.
export function mineWorkflows({ minFreq = 3, minSessions = 2, cap = 6 } = {}) {
  if (!existsSync(MEMORY_DB)) return [];
  const db = openDb(MEMORY_DB, { readonly: true });
  let rows;
  // Deleted rows (control panel) are out: rituals feed brain_context.
  try { rows = db.prepare(`SELECT memory_session_id sess, project, title, created_at_epoch ep FROM observations o WHERE 1=1${liveOnly(db)} ORDER BY ep ASC`).all(); }
  finally { db.close(); }
  const bySess = new Map();
  for (const r of rows) { const v = verbOf(r.title); if (!v) continue; if (!bySess.has(r.sess)) bySess.set(r.sess, { p: r.project, seq: [] }); bySess.get(r.sess).seq.push(v); }
  const sig = new Map(); // signature -> { freq, sessions:Set, projects:Set, validation:[], terminal }
  for (const [sess, { p, seq }] of bySess) {
    const seen = new Set();
    for (const v of seq) {
      if (VALIDATION.includes(v)) seen.add(v);
      else if (TERMINAL.includes(v) && seen.size) {
        const validation = [...seen].sort();
        const key = validation.join('+') + '→' + v;
        if (!sig.has(key)) sig.set(key, { freq: 0, sessions: new Set(), projects: new Set(), validation, terminal: v });
        const e = sig.get(key); e.freq++; e.sessions.add(sess); e.projects.add(p);
        seen.clear(); // a terminal closes one ritual instance
      }
    }
  }
  return [...sig.values()]
    .filter((e) => e.freq >= minFreq && e.sessions.size >= minSessions)
    .sort((a, b) => b.freq - a.freq).slice(0, cap);
}

function wfName(w) { return w.validation.join('-') + '-then-' + w.terminal; }

export function writeWorkflows({ log = () => {} } = {}) {
  const mined = mineWorkflows();
  if (!mined.length) { log('  no recurring workflows mined'); return { written: 0 }; }
  mkdirSync(WF_DIR, { recursive: true });
  for (const w of mined) {
    const name = wfName(w);
    const file = join(WF_DIR, sanitizeName(name) + '.md');
    // Preserve any human ## Notes region if the page exists.
    let notes = '';
    if (existsSync(file)) { const cur = readFileSync(file, 'utf8'); const i = cur.indexOf('## Notes'); if (i >= 0) notes = cur.slice(i); }
    const steps = [...w.validation.map((v, i) => `${i + 1}. ${v}`), `${w.validation.length + 1}. ${w.terminal}`];
    const md = [
      `# Workflow: ${name}`,
      '<!-- brain:auto:start -->',
      `- triggers: ${[...w.validation, w.terminal].join(', ')}`,
      `- seen: ${w.freq}× across ${w.sessions.size} sessions, ${w.projects.size} projects`,
      '',
      '## Checklist', ...steps,
      '<!-- brain:auto:end -->', '',
      notes || '## Notes\n',
    ].join('\n');
    writeFileSync(file, md);
  }
  log(`  mined ${mined.length} workflow(s) → wiki/workflows/`);
  return { written: mined.length, names: mined.map(wfName) };
}

// Return workflows whose trigger keywords appear in the task (for injection).
export function searchWorkflows(task, limit = 2) {
  if (!existsSync(WF_DIR) || !task) return [];
  const t = task.toLowerCase();
  const out = [];
  for (const f of readdirSync(WF_DIR).filter((x) => x.endsWith('.md'))) {
    const txt = readFileSync(join(WF_DIR, f), 'utf8');
    const trig = (txt.match(/- triggers:\s*(.+)/) || [, ''])[1].split(',').map((s) => s.trim()).filter(Boolean);
    const hits = trig.filter((k) => t.includes(k)).length;
    if (hits >= 2) out.push({ topic: f.replace(/\.md$/, ''), content: txt, hits }); // >=2 trigger words = a real match
  }
  return out.sort((a, b) => b.hits - a.hits).slice(0, limit).map((x) => ({ topic: x.topic, content: x.content }));
}
