// Register the SessionStart hook (hooks/session-start-context.sh) in every
// detected Claude Code profile's settings.json, so a fresh clone + `brain
// onboard` shows the folder's latest memories the moment `claude` starts —
// no hand-editing settings. Additive and idempotent: other hooks and keys are
// untouched, an entry that already points at this script is left alone, and one
// that points at an old clone path is repointed. Every write is backed up first.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ENGINE_ROOT } from './bridgehome.mjs';
import { backupAndWrite } from './wire.mjs';

const SCRIPT_NAME = 'session-start-context.sh';
const PROFILES = ['.claude', '.claude-work', '.claude-personal'];

export function hookCommand(engine = ENGINE_ROOT) {
  return `bash "${join(engine, 'hooks', SCRIPT_NAME)}"`;
}

// The script path a hook command runs, quotes and the `bash` prefix stripped,
// so `bash /x/hooks/s.sh` and `bash "/x/hooks/s.sh"` compare equal.
const scriptOf = (cmd) => String(cmd).replace(/^\s*bash\s+/, '').replace(/^["']|["']$/g, '').trim();

export function wireSessionHook({ write = false, home = homedir(), engine = ENGINE_ROOT } = {}) {
  const want = hookCommand(engine);
  const results = [];
  for (const dir of PROFILES) {
    const profile = join(home, dir);
    if (!existsSync(profile)) continue;
    const file = join(profile, 'settings.json');
    let cfg = {};
    if (existsSync(file)) {
      try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch {
        results.push({ profile: dir, file, ok: false, action: `FAIL ${file} is not valid JSON — fix it, then re-run brain onboard` });
        continue;
      }
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        results.push({ profile: dir, file, ok: false, action: `FAIL ${file} is not a JSON object` });
        continue;
      }
    }
    const hooks = (cfg.hooks && typeof cfg.hooks === 'object') ? cfg.hooks : {};
    const groups = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
    // Find our entry by script name, wherever the clone lived when it was wired.
    let ours = null;
    for (const g of groups) for (const h of (Array.isArray(g?.hooks) ? g.hooks : [])) {
      if (typeof h?.command === 'string' && h.command.includes(SCRIPT_NAME)) ours = h;
    }
    let action;
    if (ours && scriptOf(ours.command) === scriptOf(want)) action = 'already wired';
    else if (ours) { ours.command = want; action = 'repointed to this clone'; }
    else {
      groups.push({ hooks: [{ type: 'command', command: want, timeout: 10 }] });
      action = 'added';
    }
    if (action !== 'already wired' && write) {
      cfg.hooks = { ...hooks, SessionStart: groups };
      backupAndWrite(file, JSON.stringify(cfg, null, 2) + '\n');
    }
    results.push({ profile: dir, file, ok: true, changed: write && action !== 'already wired',
      action: write || action === 'already wired' ? action : `would be ${action}` });
  }
  return results;
}
