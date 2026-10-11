// The one registry `brain onboard`/`brain doctor` walk to wire every supported
// AI tool to the brain (docs/specs/auto-wiring.md §3). Data + pure functions
// only — no fs writes, no side effects at import time, no execFileSync, zero
// deps. Safe for `doctor` (read-only) and `wireMcp()` (writer) to both import.
//
// Every path here was verified read-only against a real machine on 2026-08-06
// (see the task report for the raw `ls`/`node -e` output). Where the spec's
// narrative table and disk reality disagreed, disk reality won:
//   - `~/.gemini/settings.json` exists but has NO `mcpServers` key today — the
//     "new" Gemini CLI row is confirmed absent, matching the spec.
//   - `~/.cursor/mcp.json` exists with 3rd-party servers (Figma x2,
//     local-storybook) and no claude-mem entry — confirmed "new" per spec.
//   - `~/.gemini/GEMINI.md` exists and IS the shared push target for both
//     Antigravity and Gemini CLI (confirmed against bin/lib/inject.mjs's own
//     TOOLS registry, which already encodes this sharing).
//   - Claude Code's "pull" is an ordinary user-scope MCP entry. Claude Code
//     reads user-scope servers from `mcpServers` in `<config dir>/.claude.json`
//     (~/.claude.json for the default profile; CLAUDE_CONFIG_DIR/.claude.json
//     for the work/personal profiles) — the file `claude mcp add --scope user`
//     writes. It does NOT read ~/.claude/.mcp.json (project .mcp.json files
//     are per-repo only). Verified 2026-09-28: the SessionStart hook printed
//     "search with brain_recall" for weeks while no brain_* tool existed in
//     any Claude Code session, because the old rows were verify-only and
//     pointed at a file Claude Code never loads. capture:'native' still means
//     capture arrives via the claude-mem plugin / hooks — it says nothing
//     about pull, which is wired like every other tool. Detection gates on
//     the profile dir (~/.claude etc.) because dirname(~/.claude.json) is $HOME.
//
// Two rows share the ~/.gemini home and MUST NOT be confused (see
// docs/specs/gemini-antigravity-split.md):
//   - `antigravity`  = Antigravity CLI, the Go binary ~/.local/bin/agy. Owns
//     ~/.gemini/config/ and ~/.gemini/antigravity-cli/. NOT ~/.antigravity/
//     (that dir is the Antigravity IDE, a stale VS Code fork — detect-only,
//     never a wiring target, so it has no row here).
//   - `gemini_cli`   = Google's `gemini` terminal CLI (npm @google/gemini-cli).
//     Owns the ~/.gemini root files: settings.json, oauth_creds.json, tmp/,
//     history/.
// Because Antigravity guarantees ~/.gemini/ exists, `gemini_cli` MUST NOT be
// detected by its config's parent dir — hence the per-row `detect()` below.
//
// SHARED PUSH FILE (normative for consumers): `antigravity` and `gemini_cli`
// both resolve push.file() to ~/.gemini/GEMINI.md, because both products read
// that one global instructions file. When two detected targets resolve
// push.file() to the same path, the writer must WRITE ONCE and REPORT BOTH —
// the second row reports `shared` rather than performing a second write.
// Read-only checkers (doctor's checkPush) may re-check the same path; that is
// idempotent and fine.
import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { ENGINE_ROOT, bridgePath, readPointer, serverPath } from './bridgehome.mjs';
import { appSupportDir } from './platform.mjs';
import { kiloGlobalConfigFile, kiloPushFile, kiloHostGroupInstalled } from './kilo.mjs';

const h = (...p) => join(homedir(), ...p);

// Pure-fs "is this executable on PATH?" — deliberately NOT `which`/execFileSync:
// this module is imported by read-only `doctor`, so it must stay side-effect
// free. Scans $PATH plus the two Homebrew/local bin dirs that GUI-spawned
// processes (thin PATH, no shell profile) routinely miss.
// ~/.local/bin is where agy (Antigravity CLI) and pipx-style installs live; it is
// usually added to PATH only by the user's shell profile, which GUI-launched
// processes and the panel never source.
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')];

// Where the CLI actually is (absolute path), or null. Launch with THIS, not the
// bare name: a launchd/GUI process's PATH is /usr/bin:/bin:… and does not hold
// ~/.local/bin, so binOnPath() said yes while execFileSync('claude') hit ENOENT.
export function binPath(name, env = process.env) {
  const fromEnv = String(env.PATH || '').split(delimiter);
  const names = process.platform === 'win32' ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  const seen = new Set();
  for (const dir of [...fromEnv, ...EXTRA_BIN_DIRS]) {
    if (!dir || !isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    for (const n of names) {
      const p = join(dir, n);
      try { if (existsSync(p) && !statSync(p).isDirectory()) return p; } catch {}
    }
  }
  return null;
}

// PATH for children we launch: theirs plus the usual install dirs, so the CLI's
// own subprocesses (node, git) resolve the same way they do in a terminal.
export const childPath = (env = process.env) => [...new Set([...EXTRA_BIN_DIRS, ...String(env.PATH || '').split(delimiter)].filter(Boolean))].join(delimiter);

export function binOnPath(name, env = process.env) {
  const fromEnv = String(env.PATH || '').split(delimiter);
  const names = process.platform === 'win32' ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  const seen = new Set();
  for (const dir of [...fromEnv, ...EXTRA_BIN_DIRS]) {
    // Skip empty/relative PATH entries: a relative entry would resolve against
    // the caller's cwd and could false-positive on an unrelated file.
    if (!dir || !isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    for (const n of names) {
      const p = join(dir, n);
      try {
        // existsSync follows symlinks, so a dangling link correctly reads as
        // absent (the usual install is a symlink into a node_modules bin).
        if (existsSync(p) && !statSync(p).isDirectory()) return true;
      } catch { /* unreadable dir entry — treat as absent */ }
    }
  }
  return false;
}

// Server def every target should converge on. Bridge path comes from T2's
// bridgePath() — the stable ~/.agentic-brain/bridge.cjs shim — never a
// repo-relative path (docs/specs/auto-wiring.md §2).
export function serverDef(env = process.env) {
  return { command: 'node', args: [bridgePath(env)] };
}

// ─────────────────────────── the agentic-brain memory server ────────────────
//
// docs/specs/mcp-memory-server.md §8. From T6 on, the entry `wireMcp()` writes
// into every non-native target is OUR OWN server (`agentic-brain`, read+write,
// five tools) rather than claude-mem's search-only bridge. The two are not
// allowed to coexist in one config: a client holding two "search my memory"
// toolsets picks between them unpredictably, which is a real usability failure.
//
// `serverDef()` above is deliberately left alone — bin/lib/doctor.mjs and the
// bridge probe still ask for the bridge definition, and this module is imported
// by read-only consumers. Everything below is additive.

/** MCP server name this project now manages in external tool configs. */
export const SERVER_NAME = 'agentic-brain';
/** The name we used to manage, and now supersede (never coexist with). */
export const LEGACY_SERVER_NAME = 'claude-mem';

/** The entry every target converges on: the stable server.cjs shim. */
export function brainServerDef(env = process.env) {
  return { command: 'node', args: [serverPath(env)] };
}

/**
 * The supersede gate handed to wireJson/wireToml.
 *
 * `paths` is the closed set of args[0] values that mean "this `claude-mem`
 * entry is one WE wrote" — the stable bridge shim, and the engine-relative
 * `bin/mcp-bridge.cjs` that older versions wired directly (both the clone this
 * process runs from and whatever clone `engine-path` currently names). An entry
 * whose command/args resolve to anything else is the user's own and is left
 * strictly alone — only reported.
 *
 * Pure/read-only: readPointer() only reads ~/.agentic-brain/engine-path and
 * never throws, so this stays safe for doctor to call.
 */
export function supersedeSpec(env = process.env) {
  const paths = [bridgePath(env), join(ENGINE_ROOT, 'bin', 'mcp-bridge.cjs')];
  try {
    const ptr = readPointer(env);
    if (ptr.engine) paths.push(join(ptr.engine, 'bin', 'mcp-bridge.cjs'));
  } catch { /* pointer is advisory here — the two paths above always apply */ }
  return { name: LEGACY_SERVER_NAME, paths: [...new Set(paths)] };
}

export const TARGETS = [
  {
    id: 'claude_code',
    name: 'Claude Code',
    format: 'json',
    configPath: () => h('.claude.json'),
    detect: () => existsSync(h('.claude')),
    serversKey: 'mcpServers',
    capture: 'native',
    push: { file: () => h('.claude', 'CLAUDE.md') },
    restart: 'next-launch',
    notes: 'user-scope MCP lives in ~/.claude.json `mcpServers` (what `claude mcp add --scope user` writes); brain_recall/brain_context appear in the next session.',
  },
  {
    id: 'claude_work',
    name: 'Claude Code (work)',
    format: 'json',
    configPath: () => h('.claude-work', '.claude.json'),
    detect: () => existsSync(h('.claude-work')),
    serversKey: 'mcpServers',
    capture: 'native',
    push: { file: () => h('.claude-work', 'CLAUDE.md') },
    restart: 'next-launch',
    notes: 'Same as Claude Code default profile (CLAUDE_CONFIG_DIR=~/.claude-work), separate CLAUDE.md.',
  },
  {
    id: 'claude_personal',
    name: 'Claude Code (personal)',
    format: 'json',
    configPath: () => h('.claude-personal', '.claude.json'),
    detect: () => existsSync(h('.claude-personal')),
    serversKey: 'mcpServers',
    capture: 'native',
    push: { file: () => h('.claude-personal', 'CLAUDE.md') },
    restart: 'next-launch',
    notes: 'Same as Claude Code default profile (CLAUDE_CONFIG_DIR=~/.claude-personal), separate CLAUDE.md.',
  },
  {
    id: 'codex',
    name: 'Codex CLI / Codex app / ChatGPT desktop',
    format: 'toml',
    configPath: () => h('.codex', 'config.toml'),
    serversKey: 'mcp_servers',
    capture: 'watcher',
    push: { file: () => h('.codex', 'AGENTS.md') },
    restart: 'restart-app',
    notes: 'One MCP entry serves Codex CLI + Codex desktop app + ChatGPT desktop — the three share this file. Push and capture are Codex-only: ChatGPT ignores AGENTS.md, and its local conversation store is encrypted, so the capture figure below reflects Codex sessions only. From ChatGPT, save explicitly with the save-to-brain MCP prompt.',
  },
  {
    id: 'antigravity',
    name: 'Antigravity CLI (agy)',
    format: 'json',
    configPath: () => h('.gemini', 'config', 'mcp_config.json'),
    serversKey: 'mcpServers',
    capture: 'watcher',
    // Default parent-dir gate, stated explicitly because it is load-bearing:
    // only agy creates ~/.gemini/config/ (Gemini CLI's storage layout has no
    // such subdir), so this cannot false-positive on a Gemini-CLI-only machine.
    detect: () => existsSync(h('.gemini', 'config')),
    push: { file: () => h('.gemini', 'GEMINI.md') },
    restart: 'restart-app',
    notes: "Google's agy agent CLI (Go binary, ~/.local/bin/agy). Owns ~/.gemini/config/ + ~/.gemini/antigravity-cli/ — NOT ~/.antigravity/ (that is the Antigravity IDE, a separate product and not a wiring target). Already wired today (mcpServers has figma, figma-dev-mode-mcp-server, claude-mem). Shares the ~/.gemini/GEMINI.md push file with Gemini CLI — write once, report both.",
  },
  {
    id: 'gemini_cli',
    name: 'Gemini CLI (gemini)',
    format: 'json',
    configPath: () => h('.gemini', 'settings.json'),
    serversKey: 'mcpServers',
    capture: 'ingest',
    // NEVER gate on ~/.gemini/ itself: Antigravity guarantees that dir exists,
    // which would wire claude-mem into settings.json on machines with no Gemini
    // CLI at all. Credential markers first (Antigravity writes neither, and
    // they survive a thin GUI PATH), then a pure-fs PATH scan for the binary.
    detect: () =>
      existsSync(h('.gemini', 'oauth_creds.json')) ||
      existsSync(h('.gemini', 'google_accounts.json')) ||
      binOnPath('gemini'),
    push: { file: () => h('.gemini', 'GEMINI.md') },
    restart: 'next-launch',
    notes: "Google's gemini terminal CLI (npm @google/gemini-cli). Owns the ~/.gemini root files (settings.json, oauth_creds.json, tmp/, history/); sessions are ingested from ~/.gemini/tmp. Detected by the gemini binary or oauth_creds.json/google_accounts.json — NEVER by ~/.gemini/ alone (Antigravity guarantees that dir exists). Shares the ~/.gemini/GEMINI.md push file with Antigravity CLI — write once, report both.",
  },
  {
    id: 'cursor',
    name: 'Cursor',
    format: 'json',
    configPath: () => h('.cursor', 'mcp.json'),
    serversKey: 'mcpServers',
    capture: 'ingest',
    push: null,
    restart: 'restart-app',
    notes: 'NEW — verified present with 3 servers (Figma, local-storybook, Framelink Figma MCP), no claude-mem. No global push: Cursor Rules-for-AI live in its own DB; only per-repo AGENTS.md via injectFolder() applies, out of scope for this global registry.',
  },
  // ── Kilo Code (BETA: verified against Kilo-Org/kilocode source, not a live install) ──
  // Kilo v7+ is one backend (@kilocode/cli, an OpenCode fork) with thin clients: the
  // VS Code extension (and its forks — Cursor, Insiders, VSCodium, Windsurf) spawns the
  // bundled `kilo serve`, and the CLI IS that backend. So all three rows below share ONE
  // global config (~/.config/kilo/kilo.jsonc, MCP under the `mcp` key — mcpShape 'kilo'),
  // ONE global instructions file, and ONE session DB (~/.local/share/kilo/kilo.db, ingested
  // once as source `kilo`). The rows exist so each host is detected, reported and SKIPped on
  // its own; the writers are idempotent, so the 2nd/3rd row on one file is a no-op.
  // Details + sources: bin/lib/kilo.mjs. capture:'ingest' = parseKilo() on sync.
  {
    id: 'kilo_vscode',
    name: 'Kilo Code (VS Code)',
    format: 'json',
    mcpShape: 'kilo',
    configPath: () => kiloGlobalConfigFile(),
    serversKey: 'mcp',
    capture: 'ingest',
    detect: () => kiloHostGroupInstalled('vscode'),
    push: { file: () => kiloPushFile() },
    restart: 'restart-app',
    notes: 'BETA — verified against source, not yet against a live install. Kilo Code extension in VS Code / Insiders / VSCodium / Windsurf (kilocode.kilo-code). MCP goes in the shared global Kilo config (~/.config/kilo/kilo.jsonc, `mcp` key — the extension runs the same backend as the CLI); reload the window / restart the Kilo server to pick it up. Sessions: ~/.local/share/kilo/kilo.db plus any pre-v7 tasks under globalStorage/kilocode.kilo-code/tasks. Push: ~/.config/kilo/AGENTS.md (Kilo reads ~/.claude/CLAUDE.md instead when that file is absent — we then report CLAUDE.md, never shadow it).',
  },
  {
    id: 'kilo_cursor',
    name: 'Kilo Code (Cursor)',
    format: 'json',
    mcpShape: 'kilo',
    configPath: () => kiloGlobalConfigFile(),
    serversKey: 'mcp',
    capture: 'ingest',
    detect: () => kiloHostGroupInstalled('cursor'),
    push: { file: () => kiloPushFile() },
    restart: 'restart-app',
    notes: 'BETA — verified against source, not yet against a live install. The same Kilo Code extension inside Cursor. Uses the same global Kilo config, DB and instructions file as the VS Code and CLI rows (one backend), so wiring one wires all; Cursor itself is wired separately by its own row. Legacy pre-v7 tasks live under Cursor/User/globalStorage/kilocode.kilo-code/tasks (ingested; Kilo only imports legacy MCP settings from VS Code, never Cursor, so the global config is the only live MCP path here).',
  },
  {
    id: 'kilo_cli',
    name: 'Kilo CLI',
    format: 'json',
    mcpShape: 'kilo',
    configPath: () => kiloGlobalConfigFile(),
    serversKey: 'mcp',
    capture: 'ingest',
    // Never gate on ~/.config/kilo or ~/.local/share/kilo: the extension's bundled server
    // creates both, so they prove nothing about the standalone CLI. The binaries are `kilo`
    // and `kilocode` (@kilocode/cli package.json bin).
    detect: () => binOnPath('kilo') || binOnPath('kilocode'),
    push: { file: () => kiloPushFile() },
    restart: 'next-launch',
    notes: 'BETA — verified against a live Kilo CLI 7.8.8 install on 2026-10-09: MCP entry connects (`kilo mcp list`), real kilo.db sessions ingest, and Kilo reads ~/.config/kilo/AGENTS.md first, ~/.claude/CLAUDE.md only when that is absent. @kilocode/cli (`kilo` / `kilocode`), an OpenCode fork. MCP: top-level `mcp` map in ~/.config/kilo/kilo.jsonc as {type:"local", command:[node, shim]}; picked up on the next launch. Sessions: SQLite ~/.local/share/kilo/kilo.db (the VS Code extension writes the same DB, so they are not told apart: all ingest as source `kilo`). Push: ~/.config/kilo/AGENTS.md.',
  },
  {
    id: 'claude_desktop',
    name: 'Claude Desktop',
    format: 'json',
    configPath: () => appSupportDir('Claude', 'claude_desktop_config.json'), // ~/.config/Claude on Linux
    serversKey: 'mcpServers',
    capture: 'none',
    push: null,
    restart: 'restart-app',
    notes: 'Wired manually today (verified: 11 pre-existing servers, no claude-mem — this is the "11→12" edit onboard should automate). No auto-loaded global instructions file exists to push into.',
  },
];

// Opt-out-free detection. Default rule: a target is "on this machine" when the
// PARENT DIR of its config path exists — never gate on the config file itself
// (an absent file in a present dir just means "create it"). This matches every
// row's "Detect gate" in docs/specs/auto-wiring.md §3 by construction, since
// each configPath lives directly inside that tool's home dir.
//
// A row may override that with an optional pure `detect(): boolean` when the
// parent dir is not a truthful signal — e.g. two products share one home dir
// (~/.gemini) so the dir's existence proves nothing about the second product.
// Rows without `detect` keep the default behaviour exactly.
export function detectedTargets() {
  return TARGETS.filter((t) =>
    typeof t.detect === 'function' ? !!t.detect() : existsSync(dirname(t.configPath()))
  );
}
