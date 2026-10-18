// Open Agentic Brain and Memory — the stable bridge home (`~/.agentic-brain/`).
//
// Three files, one job: give every tool's MCP config an absolute path that
// never moves, even when the user relocates their clone.
//
//   ~/.agentic-brain/bridge.cjs    generated shim (copy of bin/templates/bridge-shim.cjs)
//                                  -> delegates to <engine>/bin/mcp-bridge.cjs (claude-mem)
//   ~/.agentic-brain/server.cjs    generated shim (copy of bin/templates/server-shim.cjs)
//                                  -> delegates to <engine>/bin/mcp-server.mjs (this project's
//                                     own memory server, docs/specs/mcp-memory-server.md §8)
//   ~/.agentic-brain/engine-path   one line: absolute path of the current clone, shared by
//                                  both shims above
//
// Tool configs name bridge.cjs / server.cjs forever. `brain onboard` refreshes
// all three files; a moved repo is repaired by rewriting engine-path alone —
// no tool config is ever touched (see docs/specs/auto-wiring.md §2).
//
// Deliberately standalone: no import of paths.mjs (which loads config.json as a
// side effect) so this module is usable from `brain init` before a config
// exists, and testable with nothing but an env var.

import { homedir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  accessSync,
  constants as FS,
} from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Env var that relocates the whole bridge home (tests, CI, alternate HOME). */
export const HOME_ENV = 'AGENTIC_BRAIN_HOME';
/** Env var read by the shim itself to bypass the pointer file (debugging). */
export const ENGINE_ENV = 'AGENTIC_BRAIN_ENGINE';
/** Env var forcing a specific node binary (tests, exotic installs). */
export const NODE_ENV_VAR = 'AGENTIC_BRAIN_NODE';

/** Repo root as seen from this file (bin/lib/…). */
export const ENGINE_ROOT = resolve(__dirname, '..', '..');
/** Source of truth for the bridge shim; copied verbatim into the bridge home. */
export const TEMPLATE_PATH = join(ENGINE_ROOT, 'bin', 'templates', 'bridge-shim.cjs');
/** Source of truth for the memory-server shim; copied verbatim into the bridge home. */
export const SERVER_TEMPLATE_PATH = join(ENGINE_ROOT, 'bin', 'templates', 'server-shim.cjs');

export const BRIDGE_FILENAME = 'bridge.cjs';
export const SERVER_FILENAME = 'server.cjs';
export const POINTER_FILENAME = 'engine-path';

// ---------------------------------------------------------------- locations

/** Absolute path of the bridge home. `AGENTIC_BRAIN_HOME` wins if set. */
export function bridgeHome(env = process.env) {
  const override = (env[HOME_ENV] || '').trim();
  return override ? resolve(expandHome(override)) : join(homedir(), '.agentic-brain');
}

/** The stable path every tool config points at, forever. */
export function bridgePath(env = process.env) {
  return join(bridgeHome(env), BRIDGE_FILENAME);
}

/** The stable path every tool config names for the memory server, forever. */
export function serverPath(env = process.env) {
  return join(bridgeHome(env), SERVER_FILENAME);
}

/** The one file `brain onboard` rewrites when the clone moves. */
export function pointerPath(env = process.env) {
  return join(bridgeHome(env), POINTER_FILENAME);
}

export function expandHome(p) {
  return p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

// ------------------------------------------------------------- node binary
//
// GUI apps (Claude Desktop, ChatGPT/Codex app, Cursor) are launched by the
// macOS window server, NOT by a login shell, so they inherit none of the PATH
// your terminal has. `"command": "node"` therefore works when you test it in a
// terminal and fails inside the app — the worst kind of bug. We always wire an
// absolute path.
//
// Order matters. `process.execPath` is guaranteed to exist *right now*, but it
// is whatever interpreter happens to be running `brain` — under nvm/fnm/asdf/
// volta that is a version-pinned directory (…/versions/node/v22.4.0/bin/node)
// which vanishes the day the user uninstalls that version, silently breaking
// every wired tool. A stable system symlink is the better long-term wire even
// though it may be a different minor version. So: stable paths first, execPath
// as the always-available fallback, and a loud `warning` on the row when the
// chosen path looks version-pinned. `brain doctor` re-checks existence, and
// re-running `brain onboard` re-resolves it.

const STABLE_NODE_CANDIDATES = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];

const VERSION_PINNED = /\/(?:\.nvm|\.fnm|\.asdf|\.volta|n\/versions|Cellar|node_versions)\//;

function isExecutable(p) {
  try {
    accessSync(p, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the absolute node binary to embed in tool configs.
 * @returns {{path:string, source:string, warning:string|null}}
 * @throws if nothing usable exists (never returns a bare "node").
 */
export function resolveNodeBinary({ env = process.env, verify = true } = {}) {
  const forced = (env[NODE_ENV_VAR] || '').trim();
  const candidates = forced
    ? [[resolve(expandHome(forced)), `${NODE_ENV_VAR}`]]
    : [
        ...STABLE_NODE_CANDIDATES.map((p) => [p, 'stable system path']),
        [process.execPath, 'process.execPath (running interpreter)'],
      ];

  const tried = [];
  for (const [p, source] of candidates) {
    tried.push(p);
    if (!existsSync(p) || !isExecutable(p)) continue;
    if (verify && !looksLikeNode(p)) continue;
    return {
      path: p,
      source,
      warning: VERSION_PINNED.test(p)
        ? `${p} is version-manager-owned; if that Node version is uninstalled every wired tool breaks — re-run 'brain onboard' after changing Node versions.`
        : null,
    };
  }
  throw new Error(
    `No usable node binary found (tried: ${tried.join(', ')}).\n` +
      `  Install Node 22+ or set ${NODE_ENV_VAR}=/abs/path/to/node, then re-run 'brain onboard'.`
  );
}

/**
 * The node a launchd job should run. process.execPath is Homebrew's versioned
 * Cellar path (…/Cellar/node/26.10.0_1/bin/node); `brew upgrade node` deletes it
 * and every background job then stops without a word. Prefer the stable path.
 */
export function stableNodePath() {
  try { return resolveNodeBinary({ verify: false }).path; } catch { return process.execPath; }
}

/** Cheap sanity check that a path really is a node interpreter (~30ms, wire-time only). */
export function looksLikeNode(p) {
  try {
    const r = spawnSync(p, ['-v'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 && /^v\d+\./.test((r.stdout || '').trim());
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ pointer

/**
 * Read `engine-path` and validate the target is still a real clone.
 * Never throws — this is the diagnostic path.
 * @returns {{exists:boolean, raw:string|null, engine:string|null, valid:boolean, error:string|null}}
 */
export function readPointer(env = process.env) {
  const file = pointerPath(env);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    return {
      exists: false,
      raw: null,
      engine: null,
      valid: false,
      error:
        e.code === 'ENOENT'
          ? `pointer file missing: ${file} — run 'brain onboard'.`
          : `cannot read ${file} (${e.code}) — run 'brain onboard'.`,
    };
  }
  const line =
    raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) || '';
  if (!line) {
    return { exists: true, raw, engine: null, valid: false, error: `pointer file is empty: ${file} — run 'brain onboard'.` };
  }
  const engine = resolve(expandHome(line));
  if (!existsSync(engine)) {
    return {
      exists: true,
      raw,
      engine,
      valid: false,
      error: `engine path no longer exists: ${engine} (clone moved, renamed, or deleted) — run 'brain onboard' from the new location.`,
    };
  }
  if (!existsSync(join(engine, 'bin', 'mcp-bridge.cjs'))) {
    return {
      exists: true,
      raw,
      engine,
      valid: false,
      error: `${engine} is not an Open Agentic Brain and Memory clone (no bin/mcp-bridge.cjs) — run 'brain onboard' from the real clone.`,
    };
  }
  return { exists: true, raw, engine, valid: true, error: null };
}

// ------------------------------------------------------------- install/refresh

function readIfExists(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Write only when content actually differs; atomic so a concurrently-spawning
 *  MCP host never reads a half-written shim. Returns 'created'|'updated'|'unchanged'. */
function writeIfChanged(file, content, { mode = 0o644, dry = false } = {}) {
  const current = readIfExists(file);
  if (current === content) return 'unchanged';
  const action = current === null ? 'created' : 'updated';
  if (dry) return action;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { mode });
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
  return action;
}

/**
 * Create/refresh `~/.agentic-brain/{bridge.cjs,server.cjs,engine-path}` idempotently.
 *
 * Installs BOTH shims (bridge.cjs for claude-mem, server.cjs for this
 * project's own MCP memory server — docs/specs/mcp-memory-server.md §8) off
 * one shared pointer file. The server shim's *template* is required to exist
 * (it ships in this repo, same as the bridge template); the *delegate* it
 * points at (`bin/mcp-server.mjs`) is not required to exist yet — that is a
 * runtime concern for server.cjs itself (it fails cleanly, stderr + exit 1,
 * if the delegate is missing), not an install-time one, so other tasks that
 * build the server can land independently of this file.
 *
 * @param {object}  opts
 * @param {string}  [opts.engine]  clone root to point at (default: this file's repo)
 * @param {object}  [opts.env]
 * @param {boolean} [opts.dry]     compute actions, write nothing
 * @returns {{home, bridge, server, pointer, engine, node, actions:{bridge:string, server:string, pointer:string}, changed:boolean, warnings:string[]}}
 */
export function installBridgeHome({ engine = ENGINE_ROOT, env = process.env, dry = false, verifyNode = true } = {}) {
  const engineRoot = resolve(expandHome(engine));
  if (!existsSync(join(engineRoot, 'bin', 'mcp-bridge.cjs'))) {
    throw new Error(`Refusing to point the bridge at ${engineRoot}: no bin/mcp-bridge.cjs there.`);
  }
  const template = readIfExists(TEMPLATE_PATH);
  if (template === null) {
    throw new Error(`Missing shim template ${TEMPLATE_PATH} — the clone is incomplete; re-clone or 'git checkout ${basename(TEMPLATE_PATH)}'.`);
  }
  const serverTemplate = readIfExists(SERVER_TEMPLATE_PATH);
  if (serverTemplate === null) {
    throw new Error(
      `Missing shim template ${SERVER_TEMPLATE_PATH} — the clone is incomplete; re-clone or 'git checkout ${basename(SERVER_TEMPLATE_PATH)}'.`
    );
  }

  const home = bridgeHome(env);
  if (!dry) mkdirSync(home, { recursive: true });

  const warnings = [];
  let node = null;
  try {
    node = resolveNodeBinary({ env, verify: verifyNode });
    if (node.warning) warnings.push(node.warning);
  } catch (e) {
    // Not fatal for the bridge home itself (the shim works via whatever node
    // spawns it); fatal only for wiring, which is T4's call to make.
    warnings.push(e.message);
  }

  const pointerBody = `# Written by 'brain onboard'. Absolute path of the Open Agentic Brain and Memory clone.\n# Tool MCP configs point at bridge.cjs/server.cjs beside this file, never at\n# the clone, so moving the clone is fixed by re-running 'brain onboard' —\n# nothing else.\n${engineRoot}\n`;

  const actions = {
    bridge: writeIfChanged(join(home, BRIDGE_FILENAME), template, { mode: 0o755, dry }),
    server: writeIfChanged(join(home, SERVER_FILENAME), serverTemplate, { mode: 0o755, dry }),
    pointer: writeIfChanged(join(home, POINTER_FILENAME), pointerBody, { mode: 0o644, dry }),
  };

  return {
    home,
    bridge: join(home, BRIDGE_FILENAME),
    server: join(home, SERVER_FILENAME),
    pointer: join(home, POINTER_FILENAME),
    engine: engineRoot,
    node,
    actions,
    changed: actions.bridge !== 'unchanged' || actions.server !== 'unchanged' || actions.pointer !== 'unchanged',
    warnings,
  };
}

/**
 * Read-only health check for `brain doctor`: is the bridge home installed,
 * current, and pointing somewhere real? Reports on BOTH shims (bridge.cjs and
 * server.cjs); `shim`/`ok` keep their original bridge-only meaning unchanged
 * — `serverShim` is an additive field callers can opt into without
 * disturbing anything reading the original shape or original `ok` value.
 * @returns {{ok:boolean, home, bridge, server, pointer, engine:string|null, shim:'missing'|'stale'|'current', serverShim:'missing'|'stale'|'current', node:object|null, problems:string[]}}
 */
export function verifyBridgeHome(env = process.env) {
  const home = bridgeHome(env);
  const bridge = bridgePath(env);
  const server = serverPath(env);
  const problems = [];

  const template = readIfExists(TEMPLATE_PATH);
  const installed = readIfExists(bridge);
  let shim;
  if (installed === null) {
    shim = 'missing';
    problems.push(`bridge shim missing: ${bridge} — run 'brain onboard'.`);
  } else if (template !== null && installed !== template) {
    shim = 'stale';
    problems.push(`bridge shim is out of date (differs from ${TEMPLATE_PATH}) — run 'brain onboard'.`);
  } else {
    shim = 'current';
  }

  const serverTemplate = readIfExists(SERVER_TEMPLATE_PATH);
  const serverInstalled = readIfExists(server);
  let serverShim;
  if (serverInstalled === null) {
    serverShim = 'missing';
    problems.push(`server shim missing: ${server} — run 'brain onboard'.`);
  } else if (serverTemplate !== null && serverInstalled !== serverTemplate) {
    serverShim = 'stale';
    problems.push(`server shim is out of date (differs from ${SERVER_TEMPLATE_PATH}) — run 'brain onboard'.`);
  } else {
    serverShim = 'current';
  }

  const ptr = readPointer(env);
  if (!ptr.valid) problems.push(ptr.error);

  let node = null;
  try {
    node = resolveNodeBinary({ env });
    if (node.warning) problems.push(`warning: ${node.warning}`);
  } catch (e) {
    problems.push(e.message);
  }

  return {
    // Unchanged definition — bridge shim + pointer only — so every existing
    // caller (doctor.mjs's PASS/FAIL gating, its eval fixtures) keeps seeing
    // exactly the value it saw before the server shim existed. Server-shim
    // health is reported via the additive `serverShim` field above and
    // `ok` does not fold it in; a caller that wants "both shims healthy" can
    // check `v.ok && v.serverShim === 'current'` itself.
    ok: shim === 'current' && ptr.valid,
    pointerOk: ptr.valid,
    home,
    bridge,
    server,
    pointer: pointerPath(env),
    engine: ptr.engine,
    shim,
    serverShim,
    node,
    problems,
  };
}
