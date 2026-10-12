// `brain doctor` — read-only verification that the brain is actually wired and
// actually working, per docs/specs/auto-wiring.md §6.
//
// This module NEVER writes anything: no tool config, no ~/.agentic-brain/*, no
// repair actions. Every check either reads a file/DB/process table, or spawns
// the bridge itself to prove the one thing a static file can't: that a host
// app can actually talk MCP to it.
//
// Sections:
//   1. Brain health       — healthSignals() (bin/lib/home.mjs) + config presence
//                            + which store MEMORY_DB resolves to + a claude-mem
//                            row (present/absent — optional accelerator, its
//                            absence is reported, never fatal)
//   2. Bridge home        — verifyBridgeHome() (bin/lib/bridgehome.mjs); both
//                            shims: bridge.cjs (claude-mem) and server.cjs
//                            (agentic-brain — WARN when missing, never FAIL)
//   3. Per-tool rows       — installed / capture / push / pull, from the
//                            registry (bin/lib/wire-targets.mjs, T4 — imported
//                            defensively: this file must still run if that
//                            module is missing, empty, or throws)
//   4. Live spawn probes   — start the bridge AND the agentic-brain server,
//                            speak MCP over stdio, kill them on every path
//
// Exit-code rule (documented, not just implemented): 0 iff no row/check is a
// FAIL. A tool that is simply not installed is reported `skipped` and never
// counts as a failure. WARN rows (e.g. "wired but no observations yet") also
// do not affect the exit code — only FAIL does.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { dirname, basename } from 'node:path';
import {
  CLAUDE_MEM_DB,
  CONFIG_PRESENT,
  CONFIG_IS_FALLBACK,
  MEMORY_DB,
  NATIVE_DB_PATH,
  REPO_ROOT,
} from './paths.mjs';
import { healthSignals } from './home.mjs';
import { distillStatus } from './distill-schedule.mjs';
import { availableProviders, pendingSessions } from './distiller.mjs';
import { isLinux } from './platform.mjs';
import {
  verifyBridgeHome,
  bridgePath,
  serverPath,
  pointerPath,
  resolveNodeBinary,
} from './bridgehome.mjs';
import { openDb } from './db.mjs';
import { wireTargetConfig, serverDef } from './wire.mjs';

const DAY = 86400000;

// ---------------------------------------------------------------- registry --
//
// bin/lib/wire-targets.mjs (T4) is being written concurrently and may not
// exist yet, may be syntactically broken mid-edit, or may throw on import
// (e.g. it does its own detection work at module scope). None of that may
// crash doctor — it must degrade to "registry unavailable" and keep running
// every other section.
// `importFn` is injectable so tests can simulate "module missing / throws"
// without needing bin/lib/wire-targets.mjs to actually be absent (T4 owns
// that file and it is expected to exist by the time this runs for real).
export async function loadRegistry(importFn = (spec) => import(spec)) {
  try {
    const mod = await importFn('./wire-targets.mjs');
    const TARGETS = Array.isArray(mod.TARGETS) ? mod.TARGETS : [];
    // Pass the wiring identity through too. Without these, checkPull() falls back
    // to the legacy `claude-mem` name and reports every correctly-wired tool as
    // "not registered" — the exact seam a vacuous test had been hiding.
    return {
      ok: true,
      TARGETS,
      detectedTargets: typeof mod.detectedTargets === 'function' ? mod.detectedTargets : null,
      brainServerDef: typeof mod.brainServerDef === 'function' ? mod.brainServerDef : null,
      supersedeSpec: typeof mod.supersedeSpec === 'function' ? mod.supersedeSpec : null,
      SERVER_NAME: mod.SERVER_NAME,
      error: null,
    };
  } catch (e) {
    return { ok: false, TARGETS: [], detectedTargets: null, error: e && e.message ? e.message : String(e) };
  }
}

// ------------------------------------------------------------ brain health --

function dbObservationCount() {
  if (!existsSync(CLAUDE_MEM_DB)) return null;
  let db;
  try {
    db = openDb(CLAUDE_MEM_DB, { readonly: true });
    return db.prepare('SELECT COUNT(*) n FROM observations').get().n;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function brainHealthSection() {
  const health = healthSignals();
  const dbCount = dbObservationCount();
  const rows = [];

  if (!CONFIG_PRESENT || CONFIG_IS_FALLBACK) {
    rows.push({
      level: 'WARN',
      label: 'config',
      detail: 'no config.json on this machine (running on config.example.json fallback) — this is an unconfigured install, not a broken one.',
      fix: "run 'brain init' (fresh machine) or 'brain restore' (returning machine)",
    });
  } else {
    rows.push({ level: 'PASS', label: 'config', detail: 'config.json present' });
  }

  const cap = health.capture;
  if (cap.state === 'off') {
    rows.push({ level: dbCount ? 'FAIL' : 'WARN', label: 'capture', detail: dbCount ? 'no observations ever captured despite a non-empty DB read path' : 'no observations captured yet — use a wired tool once', fix: dbCount ? 'run: brain doctor --json for detail, then brain onboard' : 'use it once — capture is automatic' });
  } else if (cap.state === 'red') {
    rows.push({ level: 'WARN', label: 'capture', detail: `stale — newest observation is ${Math.round(cap.ageMs / DAY)}d old`, fix: 'use a wired tool; if it stays stale, run: brain doctor --json and check the watcher/worker rows below' });
  } else {
    rows.push({ level: 'PASS', label: 'capture', detail: `fresh — newest observation ${Math.round(cap.ageMs / 3600000)}h ago (${dbCount ?? '?'} total)` });
  }

  if (health.watchAgy.installed) {
    rows.push({ level: health.watchAgy.state === 'ok' ? 'PASS' : 'FAIL', label: 'watcher (agy)', detail: `installed, ${health.watchAgy.alive ? 'alive' : 'not running'}`, fix: health.watchAgy.alive ? null : (isLinux() ? 'restart it: brain onboard (or: systemctl --user status com.claudebrain.watch-agy)' : "restart it: brain onboard (or check launchctl list | grep watch-agy)") });
  } else {
    rows.push({ level: 'PASS', label: 'watcher (agy)', detail: 'not installed (n/a on this machine)' });
  }

  rows.push({ level: health.worker.state === 'ok' ? 'PASS' : 'WARN', label: 'search worker', detail: health.worker.alive ? 'alive' : 'not running (search/index features degraded)', fix: health.worker.alive ? null : 'open the Agentic Brain UI once, or run a claude-mem search — the worker lazy-starts' });

  if (health.sync.installed) {
    rows.push({ level: health.sync.state === 'red' ? 'WARN' : 'PASS', label: 'daily sync', detail: health.sync.lastSync ? `last synced ${Math.round((health.sync.ageMs ?? 0) / DAY)}d ago` : 'installed, never run yet', fix: health.sync.state === 'red' ? 'run: brain sync' : null });
  } else {
    rows.push({ level: 'WARN', label: 'daily sync', detail: isLinux() ? 'systemd sync timer not installed' : 'launchd sync job not installed', fix: 'run: brain onboard' });
  }

  rows.push(...distillerRows());

  // Which store every reader/writer actually resolves to (paths.mjs MEMORY_DB:
  // the native store once its READY marker verifies, else claude-mem's DB).
  // Informational — a valid resolution is never a failure.
  rows.push({
    level: 'PASS',
    label: 'memory store',
    detail: `${MEMORY_DB === NATIVE_DB_PATH ? 'native store' : "claude-mem's DB (native store not READY yet)"} — ${MEMORY_DB}`,
  });

  // claude-mem. It used to be the source of every distilled observation; since
  // `brain distill-sessions` landed, distillation is ours and claude-mem is a
  // legacy data source only — worth reporting when present so its rows keep
  // getting imported, but its absence costs nothing.
  rows.push(claudeMemRow(dbCount));

  return { health, dbCount, rows };
}

// The distiller turns captured sessions into memories. Capture without it
// looks healthy (sessions arrive) while the brain silently stops growing —
// which is exactly how a machine set up before onboard installed this job
// ran for a week with no new Claude Code memories. So: is the job installed,
// is there an AI CLI to distil with, and is a backlog piling up?
export function distillerRows({ status, providers, pending } = {}) {
  const rows = [];
  try {
    status ??= distillStatus();
    providers ??= availableProviders().filter((p) => p.available).map((p) => p.id);
    if (pending === undefined) {
      try { pending = existsSync(MEMORY_DB) ? pendingSessions(MEMORY_DB, { limit: 1000 }).length : 0; } catch { pending = null; }
    }
  } catch (e) {
    return [{ level: 'WARN', label: 'distiller', detail: `could not check: ${e.message}` }];
  }
  const fixInstall = 'run: brain distill-sessions --install   (or: brain onboard)';
  if (!providers.length) {
    rows.push({ level: 'FAIL', label: 'distiller', detail: 'no AI CLI to distil with (needs one of: claude, codex, agy) — captured sessions cannot become memories', fix: 'install Claude Code, Codex CLI or Antigravity CLI, then run: brain distill-sessions --install' });
  } else if (!status.installed) {
    rows.push({ level: 'FAIL', label: 'distiller', detail: `background job not installed — sessions are captured but never turned into memories${pending ? ` (${pending} waiting)` : ''}`, fix: fixInstall });
  } else if (!status.loaded) {
    rows.push({ level: 'WARN', label: 'distiller', detail: 'installed but not loaded', fix: fixInstall });
  } else {
    rows.push({ level: pending > 200 ? 'WARN' : 'PASS', label: 'distiller', detail: `running (via ${providers.join(', ')})${pending != null ? ` · ${pending} session(s) waiting` : ''}`, fix: pending > 200 ? 'backlog is large — it drains 12 sessions every 15 min; run once now: brain distill-sessions' : null });
  }
  return rows;
}

// dbCount is dbObservationCount()'s result: null when claude-mem's DB is
// absent or unreadable, a number when it opened read-only and counted.
// dbPath defaults to the machine's claude-mem DB; tests inject fixtures so the
// result never depends on what is installed on the host.
export function claudeMemRow(dbCount, dbPath = CLAUDE_MEM_DB) {
  if (!existsSync(dbPath)) {
    return {
      // PASS, not a bespoke 'OK': levelIcon() renders any unknown level as a
      // failure cross, and absence of an optional legacy source is healthy.
      level: 'PASS',
      label: 'claude-mem',
      detail: 'not installed — nothing depends on it: capture and distillation are both native (`brain distill-sessions`)',
      fix: '',
    };
  }
  if (dbCount == null) {
    return {
      level: 'WARN',
      label: 'claude-mem',
      detail: `installed but its DB is unreadable: ${dbPath}`,
      fix: 'check file permissions / disk; claude-mem may be mid-write — re-run doctor',
    };
  }
  return {
    level: 'PASS',
    label: 'claude-mem',
    detail: `installed — ${dbCount} Haiku-distilled observations (optional accelerator; imported into the native store on sync)`,
  };
}

// ------------------------------------------------------------- bridge home --

export function bridgeHomeSection(env = process.env) {
  const v = verifyBridgeHome(env);
  const rows = [];
  rows.push({
    level: v.shim === 'current' ? 'PASS' : v.shim === 'missing' ? 'FAIL' : 'WARN',
    label: 'shim',
    detail: `${v.shim} (${v.bridge})`,
    fix: v.shim === 'current' ? null : "run: brain onboard",
  });
  // The agentic-brain memory-server shim (server.cjs), installed alongside
  // bridge.cjs since docs/specs/mcp-memory-server.md §8. Deliberately WARN —
  // never FAIL — when missing: verifyBridgeHome().ok keeps its bridge-only
  // meaning for the same reason (a machine onboarded before the server
  // existed is out of date, not broken), and folding this into the exit code
  // would flip every such machine from pass to fail overnight.
  rows.push({
    level: v.serverShim === 'current' ? 'PASS' : 'WARN',
    label: 'server shim',
    detail: `${v.serverShim} (${v.server}) — the agentic-brain MCP server`,
    fix: v.serverShim === 'current' ? null : 'run: brain onboard',
  });
  rows.push({
    level: v.engine ? 'PASS' : 'FAIL',
    label: 'pointer',
    detail: v.engine ? `engine-path → ${v.engine}` : `unreadable/invalid: ${pointerPath()}`,
    fix: v.engine ? null : "run: brain onboard",
  });
  if (v.node) {
    rows.push({ level: 'PASS', label: 'node binary', detail: `${v.node.path} (${v.node.source})${v.node.warning ? ' — ' + v.node.warning : ''}` });
  } else {
    rows.push({ level: 'FAIL', label: 'node binary', detail: 'no usable node binary resolved', fix: 'install Node 22+, then re-run: brain onboard' });
  }
  return { verify: v, rows, ok: v.ok };
}

// --------------------------------------------------------------- per-tool ---

// healthSignals() buckets capture freshness by source key derived from
// generated_by_model prefixes: 'codex' | 'antigravity' | 'claude' | 'kilo'.
// Registry target ids are free-form (T4's choice); match by substring so this
// keeps working across whatever exact ids land.
function sourceKeyFor(id) {
  const s = (id || '').toLowerCase();
  if (s.includes('codex') || s.includes('chatgpt')) return 'codex';
  if (s.includes('antigravity')) return 'antigravity';
  if (s.includes('kilo')) return 'kilo';
  if (s.includes('claude') && !s.includes('desktop')) return 'claude';
  return null;
}

// Same managed-block marker inject.mjs uses to delimit the pushed digest —
// duplicated here (not exported there) because bin/lib/inject.mjs is a
// finished file this task does not own. Must stay byte-identical to the
// START/END constants in bin/lib/inject.mjs.
const PUSH_START = '<!-- BRAIN:START (auto-generated by claude-brain — this block is overwritten on each sync; edit outside it) -->';
const PUSH_END = '<!-- BRAIN:END -->';

export function checkCapture(target, health, dbCount) {
  if (target.capture === 'none') {
    return { level: 'PASS', detail: 'no capture channel by design (n/a)', fix: null };
  }
  const key = sourceKeyFor(target.id);
  const src = key ? health.capture.sources[key] : null;
  if (src) {
    const ageMs = src.ageMs;
    if (ageMs > DAY) return { level: 'WARN', detail: `wired but stale — newest observation ${Math.round(ageMs / DAY)}d ago`, fix: 'use it once' };
    return { level: 'PASS', detail: `fresh — newest observation ${Math.round(ageMs / 3600000)}h ago` };
  }
  // No per-source breakdown available for this tool (e.g. Cursor's timer
  // capture isn't tagged by generated_by_model the same way) — fall back to
  // the overall capture signal and say so plainly.
  if (health.capture.state === 'off') {
    return { level: dbCount ? 'WARN' : 'WARN', detail: 'no per-source data; overall capture has no observations yet', fix: 'use it once' };
  }
  return { level: 'WARN', detail: `no per-source breakdown for this tool; overall brain capture is ${health.capture.state === 'ok' ? 'fresh' : 'stale'} (informational only)`, fix: null };
}

export function checkPush(target) {
  if (!target.push || typeof target.push.file !== 'function') {
    return { level: 'PASS', detail: 'no push channel by design (n/a)', fix: null };
  }
  let file;
  try {
    file = target.push.file();
  } catch (e) {
    return { level: 'FAIL', detail: `push.file() threw: ${e.message}`, fix: null };
  }
  if (!existsSync(file)) {
    return { level: 'WARN', detail: `not created yet: ${file}`, fix: 'run: brain onboard' };
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { level: 'FAIL', detail: `cannot read ${file}: ${e.message}`, fix: null };
  }
  const hasBlock = text.includes(PUSH_START) && text.includes(PUSH_END);
  if (!hasBlock) {
    return { level: 'FAIL', detail: `${file} exists but has no managed brain block`, fix: 'run: brain onboard' };
  }
  // inject.mjs's digest carries no explicit "generated at" field inside the
  // block itself; the best read-only freshness proxy without inventing a new
  // marker is the file's own mtime (spliceBlock() only rewrites the file when
  // the block content actually changes).
  let ageMs = null;
  try { ageMs = Date.now() - statSync(file).mtimeMs; } catch {}
  if (ageMs != null && ageMs > 7 * DAY) {
    return { level: 'WARN', detail: `block present but file mtime is ${Math.round(ageMs / DAY)}d old (no explicit freshness marker in block; using file mtime as proxy)`, fix: 'run: brain onboard' };
  }
  return { level: 'PASS', detail: `managed block present${ageMs != null ? ` (file touched ${Math.round(ageMs / 3600000)}h ago)` : ''}` };
}

// Dry-run only: wireJson/wireToml with write=false never touch the file.
// `def` MUST be the same server definition `wireMcp()` writes (the registry's
// serverDef → the ~/.agentic-brain shim). Omitting it falls back to wire.mjs's
// legacy repo-relative default, which makes a correctly-onboarded config look
// unwired and loops the user back to `brain onboard` forever.
export function checkPull(target, bridgeOk, def, registryName, registrySupersede) {
  let configPath;
  try {
    configPath = target.configPath();
  } catch (e) {
    return { level: 'FAIL', detail: `configPath() threw: ${e.message}`, fix: null };
  }
  // Probe for the entry wireMcp() actually writes. After supersede that is
  // `agentic-brain`, not the legacy `claude-mem` name — asking for the old name
  // would report every correctly-wired tool as "not registered".
  const probeOpts = { name: registryName, supersede: registrySupersede };
  const dry = wireTargetConfig(target, configPath, false, def, probeOpts);
  if (!dry.ok) {
    return { level: 'FAIL', detail: dry.action || dry.error || 'malformed config', fix: `fix or delete ${configPath}, then re-run brain onboard` };
  }
  const registered = dry.status === 'unchanged'; // "already wired" (incl. customized)
  if (!registered) {
    return { level: 'WARN', detail: `${registryName || 'claude-mem'} not registered in ${basename(configPath)} (${dry.action})`, fix: 'run: brain onboard' };
  }
  if (!bridgeOk) {
    return { level: 'FAIL', detail: 'entry present but the bridge home is not healthy (see Bridge home section)', fix: 'run: brain onboard' };
  }
  return { level: 'PASS', detail: `${registryName || 'claude-mem'} registered in ${basename(configPath)}` };
}

export async function toolRows(registry, health, dbCount, bridgeOk) {
  const rows = [];
  // Same definition wireMcp() writes, so "already wired" agrees between the two.
  // Registry is loaded defensively, so tolerate an older shape without serverDef.
  // Same definition + name wireMcp() writes, so "already wired" agrees between
  // the two. Registry is loaded defensively, so tolerate an older shape.
  let registryDef, registryName, registrySupersede;
  try { registryDef = typeof registry.brainServerDef === 'function' ? registry.brainServerDef()
        : (typeof registry.serverDef === 'function' ? registry.serverDef() : undefined); }
  catch { registryDef = undefined; }
  try { registryName = registry.SERVER_NAME; } catch { registryName = undefined; }
  try { registrySupersede = typeof registry.supersedeSpec === 'function' ? registry.supersedeSpec() : undefined; }
  catch { registrySupersede = undefined; }
  for (const target of registry.TARGETS) {
    let configDir, installed;
    try {
      configDir = dirname(target.configPath());
      // Same gate as wire-targets.detectedTargets(): a row's detect() wins over
      // the parent-dir rule (Claude Code's ~/.claude.json lives in $HOME).
      installed = typeof target.detect === 'function' ? !!target.detect() : existsSync(configDir);
    } catch (e) {
      rows.push({ id: target.id, name: target.name, installed: false, level: 'FAIL', detail: `configPath() threw: ${e.message}`, checks: {} });
      continue;
    }
    if (!installed) {
      rows.push({ id: target.id, name: target.name, installed: false, level: 'SKIP', detail: 'skipped (not installed)', checks: {} });
      continue;
    }
    const capture = checkCapture(target, health, dbCount);
    const push = checkPush(target);
    const pull = checkPull(target, bridgeOk, registryDef, registryName, registrySupersede);
    const levels = [capture.level, push.level, pull.level];
    const level = levels.includes('FAIL') ? 'FAIL' : levels.includes('WARN') ? 'WARN' : 'PASS';
    rows.push({ id: target.id, name: target.name, installed: true, level, checks: { capture, push, pull }, notes: target.notes || null, restart: target.restart || 'none' });
  }
  return rows;
}

// -------------------------------------------------------------- spawn probe --
//
// Proves the wiring actually works, not just that it looks right: spawn the
// shim exactly as a host app would, speak MCP over stdio, and require
// well-formed JSON-RPC responses. Hard timeout; the child is killed on every
// exit path (success, protocol failure, timeout, spawn error) so a hung probe
// can never leave an orphaned process running.
//
// One shared core, two probes:
//   spawnProbe()  — bridge.cjs (claude-mem's server): one `initialize`.
//   serverProbe() — server.cjs (our agentic-brain server): `initialize` then
//                   `tools/list`, so doctor reports the actual tool names the
//                   running server exposes — the only check anywhere that
//                   proves the MCP server *works* rather than merely looking
//                   wired. Read-only: initialize mints an in-memory session
//                   object (bin/lib/remember.mjs newMcpSession — pure) and
//                   tools/list is static; neither touches the DB.
//
// `steps` is an ordered list of { request, onResult(result, acc) } — each
// request is sent only after the previous one's response arrives; onResult
// accumulates fields into the final probe result.
async function probeJsonRpc({ file, kind, timeoutMs, env, steps }) {
  if (!existsSync(file)) {
    return { ok: false, skipped: true, ms: 0, error: `${kind} shim not installed at ${file} — run 'brain onboard'.` };
  }
  let node;
  try {
    node = resolveNodeBinary({ env, verify: false });
  } catch (e) {
    return { ok: false, skipped: true, ms: 0, error: e.message };
  }

  const started = Date.now();
  return await new Promise((resolvePromise) => {
    let settled = false;
    let child = null;
    let timer = null;
    let buf = '';
    let stderrBuf = '';
    let stepIdx = 0;
    const acc = {};

    const cleanupAndResolve = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child) {
        try { child.stdout?.removeAllListeners(); } catch {}
        try { child.stderr?.removeAllListeners(); } catch {}
        try { child.removeAllListeners('exit'); } catch {}
        try { child.removeAllListeners('error'); } catch {}
        // Kill on every path — success included: this is a probe, not a
        // real client, and must never leave the server running afterward.
        if (!child.killed) {
          try { child.kill('SIGKILL'); } catch {}
        }
      }
      resolvePromise({ ...result, ms: Date.now() - started });
    };

    const sendStep = () => {
      const line = JSON.stringify(steps[stepIdx].request) + '\n';
      try {
        child.stdin.write(line);
      } catch (e) {
        cleanupAndResolve({ ok: false, error: `failed writing to ${kind} stdin: ${e.message}` });
      }
    };

    try {
      child = spawn(node.path, [file], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      cleanupAndResolve({ ok: false, error: `failed to spawn ${kind}: ${e.message}` });
      return;
    }

    const methodOf = (step) => (step && step.request && step.request.method) || 'a';

    timer = setTimeout(() => {
      cleanupAndResolve({ ok: false, error: `timeout after ${timeoutMs}ms waiting for ${methodOf(steps[stepIdx])} response`, stderr: stderrBuf.slice(0, 2000) });
    }, timeoutMs);

    child.on('error', (e) => cleanupAndResolve({ ok: false, error: `spawn error: ${e.message}` }));

    child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      // Process only complete lines; partial lines wait for more data. Any
      // complete, non-empty line that is not valid JSON-RPC is treated as
      // stray stdout — this is exactly the failure mode that corrupts MCP
      // framing in a real host, so it must fail loudly, not be swallowed.
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          cleanupAndResolve({ ok: false, error: `stray non-JSON-RPC content on stdout (corrupts MCP framing): ${JSON.stringify(trimmed.slice(0, 200))}` });
          return;
        }
        if (!msg || msg.jsonrpc !== '2.0') {
          cleanupAndResolve({ ok: false, error: `stdout produced JSON that is not JSON-RPC 2.0: ${JSON.stringify(trimmed.slice(0, 200))}` });
          return;
        }
        if (msg.method) continue; // a notification from the server; keep waiting for our response
        const step = steps[stepIdx];
        if (msg.id !== step.request.id) continue; // not our request's response
        if (msg.error) {
          cleanupAndResolve({ ok: false, error: `${methodOf(step)} returned a JSON-RPC error: ${JSON.stringify(msg.error)}` });
          return;
        }
        if (!msg.result || typeof msg.result !== 'object') {
          cleanupAndResolve({ ok: false, error: `${methodOf(step)} response has no result object` });
          return;
        }
        try {
          step.onResult(msg.result, acc);
        } catch (e) {
          cleanupAndResolve({ ok: false, error: `${methodOf(step)} response was malformed: ${e.message}` });
          return;
        }
        stepIdx++;
        if (stepIdx >= steps.length) {
          cleanupAndResolve({ ok: true, ...acc });
          return;
        }
        sendStep();
      }
    });

    child.on('exit', (code, signal) => {
      cleanupAndResolve({ ok: false, error: `${kind} process exited before responding (code=${code}, signal=${signal})`, stderr: stderrBuf.slice(0, 2000) });
    });

    sendStep();
  });
}

const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'brain-doctor', version: '1.0.0' },
  },
};

/** Bridge probe (claude-mem's server via bridge.cjs): one `initialize`. */
export async function spawnProbe({ timeoutMs = 10000, env = process.env } = {}) {
  return probeJsonRpc({
    file: bridgePath(env),
    kind: 'bridge',
    timeoutMs,
    env,
    steps: [
      {
        request: INITIALIZE_REQUEST,
        onResult: (result, acc) => {
          acc.serverInfo = result.serverInfo || null;
          acc.protocolVersion = result.protocolVersion || null;
        },
      },
    ],
  });
}

/**
 * agentic-brain probe (our own MCP server via server.cjs): `initialize`, then
 * `tools/list`, reporting the tool names the live server actually exposes.
 * Same kill-on-every-path guarantees as spawnProbe. Strictly read-only.
 */
export async function serverProbe({ timeoutMs = 10000, env = process.env } = {}) {
  return probeJsonRpc({
    file: serverPath(env),
    kind: 'server',
    timeoutMs,
    env,
    steps: [
      {
        request: INITIALIZE_REQUEST,
        onResult: (result, acc) => {
          acc.serverInfo = result.serverInfo || null;
          acc.protocolVersion = result.protocolVersion || null;
        },
      },
      {
        request: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        onResult: (result, acc) => {
          if (!Array.isArray(result.tools)) throw new Error('tools/list result has no tools array');
          acc.tools = result.tools.map((t) => t && t.name).filter(Boolean);
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ report --

function levelIcon(level) {
  return level === 'PASS' ? '✅' : level === 'WARN' ? '⚠️' : level === 'SKIP' ? '➖' : '❌';
}

function printHuman(result) {
  const L = (s = '') => console.log(s);
  L('🧠 brain doctor — read-only wiring diagnostic');
  L('');

  L('Brain health');
  for (const r of result.brainHealth.rows) L(`  ${levelIcon(r.level)} ${r.label.padEnd(16)} ${r.detail}${r.fix ? `  → ${r.fix}` : ''}`);
  L('');

  L('Bridge home');
  for (const r of result.bridgeHome.rows) L(`  ${levelIcon(r.level)} ${r.label.padEnd(16)} ${r.detail}${r.fix ? `  → ${r.fix}` : ''}`);
  L('');

  if (!result.registry.ok) {
    L(`⚠️  Registry unavailable (bin/lib/wire-targets.mjs): ${result.registry.error}`);
    L('   Per-tool wiring rows are skipped this run — the checks above are unaffected.');
    L('');
  } else if (result.tools.length === 0) {
    L('No registry targets defined.');
    L('');
  } else {
    L('Per-tool wiring');
    for (const t of result.tools) {
      if (!t.installed) { L(`  ${levelIcon(t.level)} ${t.name.padEnd(22)} ${t.detail}`); continue; }
      L(`  ${levelIcon(t.level)} ${t.name}`);
      for (const [name, c] of Object.entries(t.checks)) {
        L(`      ${levelIcon(c.level)} ${name.padEnd(9)} ${c.detail}${c.fix ? `  → ${c.fix}` : ''}`);
      }
      if (t.level !== 'PASS' && t.restart && t.restart !== 'none') {
        L(`      note: takes effect on ${t.restart === 'restart-app' ? 'app restart' : 'next launch'}`);
      }
    }
    L('');
  }

  L('Live spawn probes');
  const probeLine = (label, p, extra = '') => {
    if (p.skipped) {
      L(`  ➖ ${label.padEnd(22)} SKIPPED — ${p.error}`);
    } else if (p.ok) {
      const info = p.serverInfo ? `${p.serverInfo.name || '?'} v${p.serverInfo.version || '?'}` : '(no serverInfo)';
      L(`  ✅ ${label.padEnd(22)} spawn OK (${(p.ms / 1000).toFixed(2)}s) — ${info}${extra}`);
    } else {
      L(`  ❌ ${label.padEnd(22)} FAIL (${(p.ms / 1000).toFixed(2)}s) — ${p.error}`);
      if (p.stderr) L(`      stderr: ${p.stderr.split('\n').slice(0, 5).join('\n              ')}`);
    }
  };
  const p = result.spawn;
  const sp = result.serverSpawn;
  probeLine('bridge (claude-mem)', p);
  probeLine('agentic-brain', sp, sp && sp.ok && Array.isArray(sp.tools) ? ` — tools: ${sp.tools.join(', ')}` : '');
  L('');

  // Count the NATIVE store — that is the brain. Falling back to claude-mem's
  // count made a machine without claude-mem report "db unreadable" while the
  // native store was healthy and answering queries three lines above.
  let dbLine = 'db unreadable';
  try {
    const db = new DatabaseSync(MEMORY_DB, { readOnly: true });
    dbLine = `${db.prepare('SELECT COUNT(*) c FROM observations').get().c} obs`;
    db.close();
  } catch {
    if (result.brainHealth.dbCount != null) dbLine = `${result.brainHealth.dbCount} obs (claude-mem)`;
    else if (!existsSync(MEMORY_DB)) dbLine = 'no store yet';
  }
  const keyLine = result.keyPresent ? 'present' : 'absent';
  const probeSummary = (x) => (x.skipped ? 'skipped' : x.ok ? `OK (${(x.ms / 1000).toFixed(2)}s)` : 'FAIL');
  L(`bridge: spawn ${probeSummary(p)} · agentic-brain: spawn ${probeSummary(sp)} · engine: ${result.bridgeHome.verify.engine || 'unresolved'} · key: ${keyLine} · db: ${dbLine}`);
  L('');
  L(result.exitCode === 0 ? '✅ nothing failing.' : `❌ ${result.failCount} check(s) failing — see fixes above.`);
}

// ---------------------------------------------------------------- runDoctor -

/**
 * Run every doctor check and print a report. Read-only end to end.
 * @param {object} opts
 * @param {boolean} [opts.json]        print machine-readable JSON instead of the human report
 * @param {number}  [opts.timeoutMs]   spawn-probe timeout (default 10000ms)
 * @param {boolean} [opts.silent]      compute the result without printing (for callers that want to print themselves)
 * @returns {Promise<{exitCode:number, result:object}>}
 *   exitCode is 0 iff no row/check anywhere is a FAIL. Callers (T6's CLI case)
 *   are expected to `process.exit(exitCode)`.
 */
export async function runDoctor({ json = false, timeoutMs = 10000, silent = false, importRegistry, env = process.env } = {}) {
  let keyPresent = false;
  try {
    const { hasKey } = await import('./crypto.mjs');
    keyPresent = hasKey();
  } catch {
    keyPresent = false;
  }

  const brainHealth = brainHealthSection();
  const bridgeHome = bridgeHomeSection(env);
  const registry = importRegistry ? await loadRegistry(importRegistry) : await loadRegistry();
  const tools = registry.ok
    ? await toolRows(registry, brainHealth.health, brainHealth.dbCount, bridgeHome.ok)
    : [];
  const spawn = await spawnProbe({ timeoutMs, env });
  const serverSpawn = await serverProbe({ timeoutMs, env });

  const allRows = [
    ...brainHealth.rows,
    ...bridgeHome.rows,
    ...tools.flatMap((t) => (t.installed ? Object.values(t.checks) : [{ level: t.level === 'FAIL' ? 'FAIL' : 'PASS' }])),
  ];
  const failCount =
    allRows.filter((r) => r.level === 'FAIL').length +
    (spawn.ok || spawn.skipped ? 0 : 1) +
    (serverSpawn.ok || serverSpawn.skipped ? 0 : 1);
  const exitCode = failCount > 0 ? 1 : 0;

  const result = { repoRoot: REPO_ROOT, keyPresent, brainHealth, bridgeHome, registry, tools, spawn, serverSpawn, failCount, exitCode };

  if (!silent) {
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHuman(result);
    }
  }

  return { exitCode, result };
}
