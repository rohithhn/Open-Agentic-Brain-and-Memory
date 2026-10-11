// Kilo Code locations — pure path/detection helpers (no writes, no side effects
// at import). Shared by wire-targets.mjs (MCP + push rows), detect.mjs (the
// "linked tool" that ingest keys on) and ingest.mjs (parseKilo).
//
// BETA: every path below was read out of Kilo's own open-source code, not off a
// live install (Kilo Code is not installed on the machine this was written on).
// Sources — Kilo-Org/kilocode @ 974723450caa (main, 2026-10-08; tags v7.8.8 ext,
// @kilocode/cli). Repo paths:
//   packages/core/src/global.ts                 app="kilo"; xdg-basedir ⇒ data=$XDG_DATA_HOME|~/.local/share + /kilo,
//                                                config=$XDG_CONFIG_HOME|~/.config + /kilo (same on macOS — xdg-basedir
//                                                does NOT use ~/Library)
//   packages/core/src/database/database.ts      path(): <data>/kilo.db (or $KILO_DB; dev channels kilo-<channel>.db)
//   packages/kilo-vscode/src/services/cli-backend/server-manager.ts
//                                                the extension spawns its bundled `kilo serve` with KILO_DISABLE_CHANNEL_DB=true
//                                                and the SAME env/XDG dirs ⇒ extension + CLI share ONE kilo.db and ONE config
//   packages/opencode/src/config/config.ts      globalConfigFile(): first existing of kilo.jsonc, kilo.json, opencode.jsonc,
//                                                opencode.json, config.json in <config> (default: kilo.jsonc)
//   packages/opencode/src/session/instruction.ts globalFiles(): <config>/AGENTS.md, then ~/.claude/CLAUDE.md fallback
//                                                (first existing wins — `break`)
//   packages/opencode/src/kilocode/paths.ts     legacy extension globalStorage .../Code/User/globalStorage/kilocode.kilo-code
//   packages/kilo-vscode/src/legacy-migration/  legacy (pre-v7) per-task folders <globalStorage>/tasks/<id>/
// Docs: packages/kilo-docs/pages/{customize/custom-instructions.md,
//   automate/mcp/using-in-cli.md, code-with-ai/agents/session-history.md}.
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { appSupportDir } from './platform.mjs';

const home = () => homedir();
const abs = (p) => (p && isAbsolute(p) ? p : null);

/** xdg-basedir semantics: the env var when set, else the XDG default under $HOME. */
export const kiloDataDir = () => join(abs(process.env.XDG_DATA_HOME) || join(home(), '.local', 'share'), 'kilo');
export const kiloConfigDir = () => join(abs(process.env.XDG_CONFIG_HOME) || join(home(), '.config'), 'kilo');

/** <data>/kilo.db — or $KILO_DB (absolute, or relative to the data dir). Stable/prod
 *  channels and every VS Code-hosted server use this name; dev channels differ. */
export function kiloDbPath(env = process.env) {
  const o = env.KILO_DB;
  if (o && o !== ':memory:') return isAbsolute(o) ? o : join(kiloDataDir(), o);
  return join(kiloDataDir(), 'kilo.db');
}

export const KILO_CONFIG_CANDIDATES = ['kilo.jsonc', 'kilo.json', 'opencode.jsonc', 'opencode.json', 'config.json'];

/** The file Kilo itself reads AND writes as its global config (globalConfigFile()). */
export function kiloGlobalConfigFile() {
  const dir = kiloConfigDir();
  for (const f of KILO_CONFIG_CANDIDATES) if (existsSync(join(dir, f))) return join(dir, f);
  return join(dir, KILO_CONFIG_CANDIDATES[0]);
}

/**
 * The global instructions file Kilo actually loads. Documented: ~/.config/kilo/AGENTS.md.
 * Kilo reads the FIRST existing of [<config>/AGENTS.md, ~/.claude/CLAUDE.md], so creating
 * an AGENTS.md next to an existing CLAUDE.md would silently replace the user's Claude
 * global instructions for Kilo. When AGENTS.md is absent and CLAUDE.md exists, the
 * file Kilo is reading IS CLAUDE.md (which the Claude Code push already keeps current),
 * so that is what we report. Never creates anything.
 */
export function kiloPushFile() {
  const agents = join(kiloConfigDir(), 'AGENTS.md');
  const claude = join(home(), '.claude', 'CLAUDE.md');
  return existsSync(agents) || !existsSync(claude) ? agents : claude;
}

export const KILO_EXTENSION_ID = 'kilocode.kilo-code';

// VS Code-family hosts: Electron userData dir name + the dir the host keeps extensions in.
export const KILO_HOSTS = {
  cursor:   [{ name: 'Cursor', ext: ['.cursor', 'extensions'] }],
  vscode:   [
    { name: 'Code', ext: ['.vscode', 'extensions'] },
    { name: 'Code - Insiders', ext: ['.vscode-insiders', 'extensions'] },
    { name: 'VSCodium', ext: ['.vscode-oss', 'extensions'] },
    { name: 'Windsurf', ext: ['.windsurf', 'extensions'] },
  ],
};

/** <User>/globalStorage/kilocode.kilo-code for one host (legacy tasks/ live under it). */
export const kiloGlobalStorage = (h) => appSupportDir(h.name, 'User', 'globalStorage', KILO_EXTENSION_ID);

const extensionInstalled = (h) => {
  try {
    return readdirSync(join(home(), ...h.ext)).some((n) => n.toLowerCase().startsWith(KILO_EXTENSION_ID + '-'));
  } catch { return false; }
};

/** Is the Kilo Code extension present in this host (extension dir or its globalStorage)? */
export const kiloHostInstalled = (h) => existsSync(kiloGlobalStorage(h)) || extensionInstalled(h);
export const kiloHostGroupInstalled = (group) => KILO_HOSTS[group].some(kiloHostInstalled);

/** Every host's legacy tasks dir that exists: <globalStorage>/tasks. */
export function kiloLegacyTaskDirs() {
  return Object.values(KILO_HOSTS).flat()
    .map((h) => join(kiloGlobalStorage(h), 'tasks'))
    .filter((d) => existsSync(d));
}
