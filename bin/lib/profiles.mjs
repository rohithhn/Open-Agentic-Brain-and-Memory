// Keep claude-mem (and therefore the brain) enabled across ALL Claude Code
// profiles: ~/.claude (default), ~/.claude-work, ~/.claude-personal.
//
// Why this is needed: skills/agents ride the shared ~/.claude-shared symlink, so
// they're the same everywhere. But `enabledPlugins` and `mcpServers` live in each
// profile's OWN settings.json and do NOT sync — so profiles drift and claude-mem
// silently fails to load in a profile that never enabled it (exactly what happened
// to ~/.claude-personal). This merges the enablement additively and SAFELY:
// preserves every other key, never touches mcpServers/keys, idempotent.
//
// OPT-IN, not automatic: `brain onboard` and `brain sync` used to call this with
// write:true on every run, which quietly turned a third-party plugin on in
// profiles where the user had never installed it (and fought a user who had
// switched it off). Now they only do it when asked — `brain onboard
// --with-claude-mem`, BRAIN_ENABLE_CLAUDE_MEM=1, or `"claudeMem":
// {"enableEverywhere": true}` in config.json. `brain sync-claude --write` stays
// the explicit, manual way to run it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { config } from './paths.mjs';

const h = (...p) => join(homedir(), ...p);
const PLUGIN = 'claude-mem@thedotmack';

export const CLAUDE_PROFILES = [
  { id: 'default', dir: h('.claude') },
  { id: 'work', dir: h('.claude-work') },
  { id: 'personal', dir: h('.claude-personal') },
];

// 'enabled' | 'disabled' | 'absent' for one parsed settings.json.
export function claudeMemState(obj) {
  const v = obj && obj.enabledPlugins && obj.enabledPlugins[PLUGIN];
  if (v === true) return 'enabled';
  if (v === false) return 'disabled';
  // Wired by hand via raw hooks (claude-mem's worker-service / thedotmack cache path).
  for (const groups of Object.values((obj && obj.hooks) || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (typeof h?.command === 'string' && /thedotmack|worker-service\.cjs/.test(h.command)) return 'enabled';
      }
    }
  }
  return 'absent';
}

// Has the user opted in to enabling claude-mem across every profile?
export function claudeMemOptIn({ flag = false, env = process.env, cfg = config } = {}) {
  return !!flag || env.BRAIN_ENABLE_CLAUDE_MEM === '1' || cfg?.claudeMem?.enableEverywhere === true;
}

export function enableClaudeMemEverywhere({ write = false, log = () => {} } = {}) {
  const results = [];
  for (const p of CLAUDE_PROFILES) {
    if (!existsSync(p.dir)) { results.push({ profile: p.id, action: 'skipped (no profile)' }); continue; }
    const file = join(p.dir, 'settings.json');
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : '{}';
    let obj;
    try { obj = JSON.parse(raw); } catch { obj = null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { results.push({ profile: p.id, file, action: 'skipped (unparseable settings.json)' }); continue; }
    // Decide from the parsed settings, not a substring: `raw.includes('claude-mem')`
    // also matched `"claude-mem@thedotmack": false` and any hook path containing
    // the text (e.g. this repo's own ~/Documents/Brain-claude-mem hook).
    const state = claudeMemState(obj);
    if (state === 'enabled') { results.push({ profile: p.id, file, action: 'already enabled' }); continue; }
    // The user switched it off on purpose — never override that.
    if (state === 'disabled') { results.push({ profile: p.id, file, action: 'left off (you disabled it)' }); continue; }
    if (write) {
      obj.enabledPlugins = obj.enabledPlugins || {};
      obj.enabledPlugins[PLUGIN] = true; // ONLY this key — mcpServers/keys untouched
      writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
      log(`  ${p.id}: enabled claude-mem → ${file}`);
    }
    results.push({ profile: p.id, file, action: write ? 'enabled claude-mem' : 'would enable claude-mem' });
  }
  return { ok: true, plugin: PLUGIN, results };
}
