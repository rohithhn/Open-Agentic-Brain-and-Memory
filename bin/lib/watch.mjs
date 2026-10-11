// Near-live agy capture. Antigravity has no capture hook, so instead of waiting
// for `brain sync`, we WATCH what it writes and ingest on change (debounced) —
// work done in agy lands in the shared brain within seconds. As close to live as
// agy allows without a hook API.
import { watch, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ingest } from './ingest.mjs';
import { REPO_ROOT } from './paths.mjs';
import { stableNodePath } from './bridgehome.mjs';
import { isLinux, installUserUnit, uninstallUserUnit } from './platform.mjs';

const AGY_DIR = join(homedir(), '.gemini', 'antigravity-cli');
const LABEL = 'com.claudebrain.watch-agy';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), '.claude-mem', 'watch-agy.log');

// Which changes under AGY_DIR are a conversation changing (path relative to it):
// agy < 1.3 appends to history.jsonl; agy >= 1.3 writes conversations/<uuid>.db
// (+ its -wal/-journal) and updates conversation_summaries.db. Logs, caches and
// the rest of the dir churn constantly and are ignored.
export function isAgyCaptureChange(fn) {
  if (!fn) return true; // platform did not say which file: re-check
  const p = String(fn).replace(/\\/g, '/');
  return p === 'history.jsonl' || p === 'conversations' || /^conversations\/[^/]+\.db(-wal|-journal)?$/.test(p)
    || /^conversation_summaries\.db(-wal|-journal)?$/.test(p);
}

// Long-lived watcher (foreground). Never resolves; runs until killed.
export function watchAgy({ log = console.log, debounceMs = 2500 } = {}) {
  log(`👀 watch-agy: watching ${AGY_DIR} (history.jsonl, conversations/)`);
  let timer = null;
  let running = false, again = false;
  const run = async () => {
    // A change that lands mid-pass (agy writes each step as it goes) is not
    // dropped: one more pass runs once this one finishes.
    if (running) { again = true; return; }
    running = true;
    try {
      const r = await ingest({ only: ['antigravity'] });
      const a = r.antigravity;
      if (a && (a.observations || a.sessions)) log(`  captured +${a.sessions} agy session(s)`);
    } catch (e) {
      log('  ingest error: ' + e.message);
    }
    running = false;
    if (again) { again = false; trigger(); }
  };
  const trigger = () => { clearTimeout(timer); timer = setTimeout(run, debounceMs); };
  try {
    // Watch the DIR recursively (files are replaced/rotated, and conversations/
    // may not exist until agy's first run), filtered to conversation files.
    if (!existsSync(AGY_DIR)) log(`  (agy dir not present yet: ${AGY_DIR} — will pick up once agy runs)`);
    else watch(AGY_DIR, { recursive: true }, (_ev, fn) => { if (isAgyCaptureChange(fn)) trigger(); });
  } catch (e) {
    log('  watch failed: ' + e.message);
  }
  run(); // initial catch-up
  return new Promise(() => {}); // stay alive
}

// Install as an always-on launchd agent (RunAtLoad + KeepAlive → auto-start at
// login, auto-restart if it dies). Returns {installed, plist}.
export function installWatchAgy({ log = console.log } = {}) {
  const node = stableNodePath();
  const brain = join(REPO_ROOT, 'bin', 'brain.mjs');
  if (isLinux()) {
    const u = installUserUnit({ label: LABEL, description: 'Agentic Brain Antigravity watcher', mode: 'daemon',
      args: [node, brain, 'watch-agy'], logPath: LOG });
    log(`✅ installed always-on agy watcher (systemd --user: ${u.unit})`);
    log(`   unit:  ${u.unitPath}`);
    log(`   log:   ${LOG}`);
    return { installed: true, unit: u.unitPath, log: LOG };
  }
  mkdirSync(dirname(PLIST), { recursive: true });
  mkdirSync(dirname(LOG), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${brain}</string>
    <string>watch-agy</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;
  writeFileSync(PLIST, plist);
  try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
  execFileSync('launchctl', ['load', '-w', PLIST]);
  log(`✅ installed always-on agy watcher (launchd: ${LABEL})`);
  log(`   plist: ${PLIST}`);
  log(`   log:   ${LOG}`);
  return { installed: true, plist: PLIST, log: LOG };
}

export function uninstallWatchAgy({ log = console.log } = {}) {
  if (isLinux()) {
    const u = uninstallUserUnit(LABEL, 'daemon');
    log(`stopped systemd unit ${u.unit} (unit left at ${u.unitPath})`);
    return { stopped: true };
  }
  try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
  log(`stopped launchd agent ${LABEL} (plist left at ${PLIST})`);
  return { stopped: true };
}

// ── Codex near-live capture ────────────────────────────────────────────────
// Codex has no capture hook (so it can't be per-turn live like Claude Code), but
// it writes rollout-*.jsonl session files under ~/.codex/sessions. We watch that
// tree and ingest on change → Codex work lands in the brain within seconds,
// instead of waiting for the periodic ingest timer.
const CODEX_DIR = join(homedir(), '.codex', 'sessions');
const CODEX_LABEL = 'com.claudebrain.watch-codex';
const CODEX_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${CODEX_LABEL}.plist`);
const CODEX_LOG = join(homedir(), '.claude-mem', 'watch-codex.log');

export function watchCodex({ log = console.log, debounceMs = 2500 } = {}) {
  log(`👀 watch-codex: watching ${CODEX_DIR}`);
  let timer = null, running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await ingest({ only: ['codex'] });
      const c = r.codex;
      if (c && (c.observations || c.sessions)) log(`  captured +${c.sessions} codex session(s), +${c.observations} obs`);
    } catch (e) {
      log('  ingest error: ' + e.message);
    }
    running = false;
  };
  const trigger = () => { clearTimeout(timer); timer = setTimeout(run, debounceMs); };
  try {
    if (!existsSync(CODEX_DIR)) log(`  (codex sessions dir not present yet: ${CODEX_DIR} — will pick up once codex runs)`);
    else watch(CODEX_DIR, { recursive: true }, (_ev, fn) => { if (!fn || fn.includes('rollout-')) trigger(); });
  } catch (e) {
    log('  watch failed: ' + e.message);
  }
  run(); // initial catch-up
  return new Promise(() => {}); // stay alive
}

export function installWatchCodex({ log = console.log } = {}) {
  const node = stableNodePath();
  const brain = join(REPO_ROOT, 'bin', 'brain.mjs');
  if (isLinux()) {
    const u = installUserUnit({ label: CODEX_LABEL, description: 'Agentic Brain Codex watcher', mode: 'daemon',
      args: [node, brain, 'watch-codex'], logPath: CODEX_LOG });
    log(`✅ installed near-live Codex watcher (systemd --user: ${u.unit})`);
    log(`   unit:  ${u.unitPath}`);
    log(`   log:   ${CODEX_LOG}`);
    return { installed: true, unit: u.unitPath, log: CODEX_LOG };
  }
  mkdirSync(dirname(CODEX_PLIST), { recursive: true });
  mkdirSync(dirname(CODEX_LOG), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${CODEX_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${brain}</string>
    <string>watch-codex</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${CODEX_LOG}</string>
  <key>StandardErrorPath</key><string>${CODEX_LOG}</string>
</dict>
</plist>
`;
  writeFileSync(CODEX_PLIST, plist);
  try { execFileSync('launchctl', ['unload', CODEX_PLIST], { stdio: 'ignore' }); } catch {}
  execFileSync('launchctl', ['load', '-w', CODEX_PLIST]);
  log(`✅ installed near-live Codex watcher (launchd: ${CODEX_LABEL})`);
  log(`   plist: ${CODEX_PLIST}`);
  log(`   log:   ${CODEX_LOG}`);
  return { installed: true, plist: CODEX_PLIST, log: CODEX_LOG };
}

export function uninstallWatchCodex({ log = console.log } = {}) {
  if (isLinux()) {
    const u = uninstallUserUnit(CODEX_LABEL, 'daemon');
    log(`stopped systemd unit ${u.unit} (unit left at ${u.unitPath})`);
    return { stopped: true };
  }
  try { execFileSync('launchctl', ['unload', CODEX_PLIST], { stdio: 'ignore' }); } catch {}
  log(`stopped launchd agent ${CODEX_LABEL} (plist left at ${CODEX_PLIST})`);
  return { stopped: true };
}
