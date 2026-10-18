// Continuous distillation. `brain ingest` captures raw sessions; this turns them
// into observations with our own multi-provider distiller. Together they replace
// the whole claude-mem pipeline, which is what lets the plugin be switched off.
//
// StartInterval, not KeepAlive: a batch pass, not a daemon. Nice/LowPriority so a
// backlog burn never competes with an interactive session for CPU, and a modest
// per-run --limit so each wake-up is bounded rather than a multi-hour job.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './paths.mjs';
import { stableNodePath } from './bridgehome.mjs';
import { isLinux, installUserUnit, uninstallUserUnit, userUnitStatus } from './platform.mjs';

const LABEL = 'com.claudebrain.distill';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), '.claude-brain', 'distill.log');
const DEFAULT_INTERVAL = 900;  // 15 min
const DEFAULT_LIMIT = 12;      // segments (model calls) per wake-up

export function installDistill({ interval = DEFAULT_INTERVAL, limit = DEFAULT_LIMIT, log = console.log } = {}) {
  const node = stableNodePath();
  const brain = join(REPO_ROOT, 'bin', 'brain.mjs');
  if (isLinux()) {
    // Nice=5 + IOSchedulingClass=idle ≈ launchd's Nice/Background/LowPriorityIO.
    const u = installUserUnit({ label: LABEL, description: 'Open Agentic Brain and Memory distillation', mode: 'interval',
      interval, runAtLoad: true, nice: 5, lowPriority: true, logPath: LOG,
      args: [node, brain, 'distill-sessions', '--limit', String(limit), '--concurrency', '2'] });
    log(`✅ distillation on (systemd --user: ${u.unit}, every ${Math.round(interval / 60)} min, ${limit} segments/pass)`);
    log(`   log: ${LOG}`);
    return { installed: true, unit: u.unitPath, log: LOG, interval, limit };
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
    <string>distill-sessions</string>
    <string>--limit</string><string>${limit}</string>
    <string>--concurrency</string><string>2</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>Nice</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;
  writeFileSync(PLIST, plist);
  try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
  execFileSync('launchctl', ['load', '-w', PLIST]);
  log(`✅ distillation on (launchd: ${LABEL}, every ${Math.round(interval / 60)} min, ${limit} segments/pass)`);
  log(`   log: ${LOG}`);
  return { installed: true, plist: PLIST, log: LOG, interval, limit };
}

export function uninstallDistill({ log = console.log } = {}) {
  if (isLinux()) {
    const u = uninstallUserUnit(LABEL, 'interval');
    log(`stopped periodic distillation ${u.unit} (unit left at ${u.unitPath})`);
    return { stopped: true };
  }
  try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
  log(`stopped periodic distillation ${LABEL} (plist left at ${PLIST})`);
  return { stopped: true };
}

export function distillStatus() {
  if (isLinux()) { const s = userUnitStatus(LABEL, 'interval'); return { installed: s.installed, loaded: s.loaded, label: LABEL }; }
  let loaded = false;
  try { loaded = execFileSync('launchctl', ['list'], { encoding: 'utf8' }).includes(LABEL); } catch {}
  return { installed: existsSync(PLIST), loaded, label: LABEL };
}
