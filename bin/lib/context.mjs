// Capture "folder context": the global CLAUDE.md / AGENTS.md guidance files, plus
// a project map derived from the memory DB (project -> activity window). This is
// what lets a freshly-installed machine understand the shape of your work.
import { mkdirSync, existsSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.mjs';
import { CLAUDE_DIR, SHARED_DIR, MEMORY_DB, REPO_ROOT } from './paths.mjs';
import { liveOnly } from './lifecycle.mjs';

const REPO_CONTEXT = join(REPO_ROOT, 'context');

export function pushContext({ log = () => {} } = {}) {
  mkdirSync(REPO_CONTEXT, { recursive: true });
  const candidates = [
    [join(CLAUDE_DIR, 'CLAUDE.md'), 'claude-global.CLAUDE.md'],
    [join(SHARED_DIR, 'CLAUDE.md'), 'shared.CLAUDE.md'],
    [join(CLAUDE_DIR, 'AGENTS.md'), 'claude-global.AGENTS.md'],
  ];
  let files = 0;
  for (const [src, name] of candidates) {
    if (existsSync(src)) {
      copyFileSync(src, join(REPO_CONTEXT, name));
      files++;
    }
  }

  // Project map from the DB: activity window + volume per project.
  let projectMap = [];
  if (existsSync(MEMORY_DB)) {
    const db = openDb(MEMORY_DB, { readonly: true });
    projectMap = db
      .prepare(
        `SELECT project,
                COUNT(*) AS observations,
                MIN(created_at) AS first_seen,
                MAX(created_at) AS last_seen
         FROM observations o WHERE 1=1${liveOnly(db)} GROUP BY project ORDER BY observations DESC`
      )
      .all();
    db.close();
  }
  writeFileSync(join(REPO_CONTEXT, 'project-map.json'), JSON.stringify(projectMap, null, 2) + '\n');
  log(`  captured ${files} context files + ${projectMap.length} projects`);
  return { files, projects: projectMap.length };
}

export function restoreContext({ log = () => {} } = {}) {
  const src = join(REPO_CONTEXT, 'claude-global.CLAUDE.md');
  const dest = join(CLAUDE_DIR, 'CLAUDE.md');
  if (existsSync(src) && !existsSync(dest)) {
    // A fresh machine may never have run Claude Code, so CLAUDE_DIR won't exist yet.
    mkdirSync(CLAUDE_DIR, { recursive: true });
    copyFileSync(src, dest);
    log('  restored global CLAUDE.md');
    return 1;
  }
  return 0;
}

export function projectMap() {
  const p = join(REPO_CONTEXT, 'project-map.json');
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}
