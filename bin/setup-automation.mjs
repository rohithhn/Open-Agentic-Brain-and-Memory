#!/usr/bin/env node
// Install the launchd agent that runs `brain sync` once a day (and catches up
// after the Mac wakes from sleep). Idempotent.
//
// IMPORTANT: everything below is side-effecting (writes a plist, runs real
// `launchctl load`/`unload`). It must only happen when this file is run
// directly (`node bin/setup-automation.mjs`), never as a byproduct of another
// module importing it (e.g. `brain onboard` does `await import('./setup-automation.mjs')`
// — that import must not, by itself, mutate the live LaunchAgent).
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, config } from './lib/paths.mjs';
import { stableNodePath } from './lib/bridgehome.mjs';
import { isLinux, installUserUnit } from './lib/platform.mjs';

export function installDailySync({ log = console.log } = {}) {
  // Derived from config.json (repo.owner + repo.name), not hardcoded, so a forked/
  // renamed repo gets its own launchd label. For an existing install this resolves
  // to the exact same string as before (com.<owner>.<name>.sync), so `setup-automation`
  // stays idempotent against an already-installed job — no orphaned launchd agents.
  const LABEL = `com.${config.repo.owner}.${config.repo.name}.sync`;
  const nodeBin = stableNodePath();
  const script = join(REPO_ROOT, 'bin', 'brain.mjs');
  // launchd opens these log files itself, before node starts, and macOS privacy
  // protection can deny it anything under ~/Documents (where the clone usually
  // lives): the job then dies with EX_CONFIG and writes nothing, ever. Log to
  // ~/.claude-brain, next to the store, like the other jobs' ~/.claude-mem logs.
  const logOut = join(homedir(), '.claude-brain', 'logs');
  mkdirSync(logOut, { recursive: true });

  if (isLinux()) {
    // systemd --user timer, 09:30 daily; Persistent=true catches up a run missed
    // while the machine was off/suspended (launchd does the same after wake).
    // PATH: git/gh/age for sync — distro dirs, ~/.local/bin, Linuxbrew, node's own dir.
    const path = [dirname(nodeBin), join(homedir(), '.local', 'bin'), '/home/linuxbrew/.linuxbrew/bin',
      '/usr/local/bin', '/usr/bin', '/bin'].join(':');
    const u = installUserUnit({ label: LABEL, description: 'Agentic Brain daily sync', mode: 'calendar',
      calendar: { hour: 9, minute: 30 }, args: [nodeBin, script, 'sync'], env: { PATH: path },
      logPath: join(logOut, 'sync.out.log'), errPath: join(logOut, 'sync.err.log') });
    log(`✅ Daily sync scheduled (09:30) via systemd --user → ${u.unitPath}`);
    log('   Run now with:  systemctl --user start ' + LABEL + '.service');
    return { label: LABEL, unitPath: u.unitPath };
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${script}</string>
    <string>sync</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${join(logOut, 'sync.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(logOut, 'sync.err.log')}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
`;

  const agentsDir = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(agentsDir, { recursive: true });
  const plistPath = join(agentsDir, `${LABEL}.plist`);
  writeFileSync(plistPath, plist);

  try {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
  } catch {}
  execFileSync('launchctl', ['load', plistPath], { stdio: 'inherit' });
  log(`✅ Daily sync scheduled (09:30) via launchd → ${plistPath}`);
  log('   Run now with:  launchctl start ' + LABEL);
  return { label: LABEL, plistPath };
}

// Only run when invoked directly — importing this module must be side-effect-free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installDailySync();
}
