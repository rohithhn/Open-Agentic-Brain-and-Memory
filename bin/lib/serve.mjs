// Always-on control panel. The Agentic Brain UI (localhost:37800) should be a
// persistent background service — it survives logout, reboot, and closing any
// terminal/CLI session, and auto-restarts if it dies. Same launchd pattern as
// watch-agy: RunAtLoad (start at login) + KeepAlive (restart on crash).
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, config } from './paths.mjs';
import { stableNodePath } from './bridgehome.mjs';
import { isLinux, installUserUnit, uninstallUserUnit, userUnitStatus } from './platform.mjs';

const LABEL = 'com.claudebrain.serve';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), '.claude-mem', 'serve.log');

function url() {
  const { host = '127.0.0.1', port = 37800 } = config.ui || {};
  return `http://${host}:${port}`;
}

// Install as an always-on launchd agent → the control panel is up at login and
// stays up. Idempotent: re-running just reloads the (unchanged) plist.
export function installServe({ log = console.log } = {}) {
  const node = stableNodePath();
  const brain = join(REPO_ROOT, 'bin', 'brain.mjs');
  if (isLinux()) {
    // systemd --user: Restart=always + WantedBy=default.target ≈ KeepAlive + RunAtLoad.
    const u = installUserUnit({ label: LABEL, description: 'Agentic Brain control panel', mode: 'daemon',
      args: [node, brain, 'serve'], logPath: LOG });
    log(`✅ control panel is now always-on (systemd --user: ${u.unit})`);
    log(`   → ${url()}  (auto-starts at login, auto-restarts if it dies)`);
    log(`   unit:  ${u.unitPath}`);
    log(`   log:   ${LOG}`);
    return { installed: true, unit: u.unitPath, log: LOG, url: url() };
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
    <string>serve</string>
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
  log(`✅ control panel is now always-on (launchd: ${LABEL})`);
  log(`   → ${url()}  (auto-starts at login, auto-restarts if it dies)`);
  log(`   plist: ${PLIST}`);
  log(`   log:   ${LOG}`);
  return { installed: true, plist: PLIST, log: LOG, url: url() };
}

export function uninstallServe({ log = console.log } = {}) {
  if (isLinux()) {
    const u = uninstallUserUnit(LABEL, 'daemon');
    log(`stopped always-on control panel ${u.unit} (unit left at ${u.unitPath})`);
    return { stopped: true };
  }
  try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
  log(`stopped always-on control panel ${LABEL} (plist left at ${PLIST})`);
  return { stopped: true };
}

export function serveStatus() {
  if (isLinux()) { const s = userUnitStatus(LABEL, 'daemon'); return { installed: s.installed, loaded: s.loaded, label: LABEL, url: url() }; }
  let loaded = false;
  try { loaded = execFileSync('launchctl', ['list'], { encoding: 'utf8' }).includes(LABEL); } catch {}
  return { installed: existsSync(PLIST), loaded, label: LABEL, url: url() };
}
