// Continuous cross-tool capture. Every tool's sessions — Claude Code included —
// are read by our own parsers (ingest.mjs) when `brain ingest` runs; Antigravity
// is also picked up near-live (watch-agy). This installs a launchd
// timer that runs `brain ingest` on a short interval so every tool's work flows
// into the shared brain automatically, instead of waiting for the daily sync.
// StartInterval (not KeepAlive) — ingest is a short batch pass, not a daemon.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './paths.mjs';
import { stableNodePath } from './bridgehome.mjs';
import { isLinux, installUserUnit, uninstallUserUnit, userUnitStatus } from './platform.mjs';

const LABEL = 'com.claudebrain.ingest';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), '.claude-mem', 'ingest.log');
const DEFAULT_INTERVAL = 600; // seconds (10 min)

// Install the periodic-ingest launchd timer. Idempotent: re-running reloads it.
export function installIngest({ interval = DEFAULT_INTERVAL, log = console.log } = {}) {
  const node = stableNodePath();
  const brain = join(REPO_ROOT, 'bin', 'brain.mjs');
  if (isLinux()) {
    const u = installUserUnit({ label: LABEL, description: 'Open Agentic Brain and Memory periodic ingest', mode: 'interval',
      interval, runAtLoad: true, args: [node, brain, 'ingest'], logPath: LOG });
    log(`✅ Codex/Cursor auto-capture on (systemd --user: ${u.unit}, every ${interval}s)`);
    log(`   runs \`brain ingest\` at login and every ${Math.round(interval / 60)} min`);
    log(`   unit:  ${u.unitPath}`);
    log(`   log:   ${LOG}`);
    return { installed: true, unit: u.unitPath, log: LOG, interval };
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
    <string>ingest</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;
  writeFileSync(PLIST, plist);
  try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
  execFileSync('launchctl', ['load', '-w', PLIST]);
  log(`✅ Codex/Cursor auto-capture on (launchd: ${LABEL}, every ${interval}s)`);
  log(`   runs \`brain ingest\` at login and every ${Math.round(interval / 60)} min`);
  log(`   plist: ${PLIST}`);
  log(`   log:   ${LOG}`);
  return { installed: true, plist: PLIST, log: LOG, interval };
}

export function uninstallIngest({ log = console.log } = {}) {
  if (isLinux()) {
    const u = uninstallUserUnit(LABEL, 'interval');
    log(`stopped periodic ingest ${u.unit} (unit left at ${u.unitPath})`);
    return { stopped: true };
  }
  try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
  log(`stopped periodic ingest ${LABEL} (plist left at ${PLIST})`);
  return { stopped: true };
}

export function ingestStatus() {
  if (isLinux()) { const s = userUnitStatus(LABEL, 'interval'); return { installed: s.installed, loaded: s.loaded, label: LABEL }; }
  let loaded = false;
  try { loaded = execFileSync('launchctl', ['list'], { encoding: 'utf8' }).includes(LABEL); } catch {}
  return { installed: existsSync(PLIST), loaded, label: LABEL };
}
