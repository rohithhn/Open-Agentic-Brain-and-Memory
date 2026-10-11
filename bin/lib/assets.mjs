// Sync skills, agents and settings between this machine and the repo.
// Skills/agents are ADDITIVE: existing entries in the repo are replaced with the
// local copy, but entries only present in the repo are NEVER deleted.
import {
  mkdirSync,
  cpSync,
  readdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  SHARED_DIR,
  CLAUDE_DIR,
  REPO_SKILLS,
  REPO_AGENTS,
  REPO_SETTINGS,
} from './paths.mjs';
import { redactJsonText } from './redact.mjs';

function resolveDir(p) {
  // Follow symlinks (skills/agents are symlinked into ~/.claude).
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Copy every child directory of src into dest, overwriting existing, never deleting.
function additiveCopyDirs(src, dest, log) {
  if (!existsSync(src)) return 0;
  mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = statSync(from).isDirectory();
      } catch {
        continue;
      }
    }
    if (!isDir) continue;
    cpSync(from, to, { recursive: true, force: true, dereference: true });
    n++;
  }
  log && log(`  synced ${n} entries → ${dest}`);
  return n;
}

// PUSH: local machine → repo
export function pushSkills({ log = () => {} } = {}) {
  const skillsSrc = resolveDir(join(SHARED_DIR, 'skills'));
  return additiveCopyDirs(skillsSrc, REPO_SKILLS, log);
}

export function pushAgents({ log = () => {} } = {}) {
  const agentsSrc = resolveDir(join(SHARED_DIR, 'agents'));
  if (!existsSync(agentsSrc)) return 0;
  mkdirSync(REPO_AGENTS, { recursive: true });
  cpSync(agentsSrc, REPO_AGENTS, { recursive: true, force: true, dereference: true });
  log(`  synced agents → ${REPO_AGENTS}`);
  return 1;
}

export function pushSettings({ log = () => {} } = {}) {
  mkdirSync(REPO_SETTINGS, { recursive: true });
  const files = [
    [join(CLAUDE_DIR, 'settings.json'), 'settings.json'],
    [join(SHARED_DIR, 'settings.json'), 'shared-settings.json'],
    [join(CLAUDE_DIR, '.mcp.json'), 'mcp.json'],
  ];
  let n = 0;
  for (const [src, name] of files) {
    if (!existsSync(src)) continue;
    const redacted = redactJsonText(readFileSync(src, 'utf8'));
    writeFileSync(join(REPO_SETTINGS, name), redacted);
    n++;
  }
  log(`  synced ${n} settings files (secrets redacted)`);
  return n;
}

// PULL: repo → local machine (used on install / restore). Additive as well.
export function restoreSkills({ log = () => {} } = {}) {
  const dest = join(SHARED_DIR, 'skills');
  return additiveCopyDirs(REPO_SKILLS, dest, log);
}

export function restoreAgents({ log = () => {} } = {}) {
  if (!existsSync(REPO_AGENTS)) return 0;
  const dest = join(SHARED_DIR, 'agents');
  mkdirSync(dest, { recursive: true });
  cpSync(REPO_AGENTS, dest, { recursive: true, force: true, dereference: true });
  log(`  restored agents → ${dest}`);
  return 1;
}

export function skillCounts() {
  const repo = existsSync(REPO_SKILLS)
    ? readdirSync(REPO_SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).length
    : 0;
  const localPath = resolveDir(join(SHARED_DIR, 'skills'));
  const local = existsSync(localPath)
    ? readdirSync(localPath, { withFileTypes: true }).filter(
        (d) => d.isDirectory() || d.isSymbolicLink()
      ).length
    : 0;
  return { repo, local };
}
