// Background semantic-search backfill. `brain embed --apply` is incremental and
// resumable; this runs it on a timer so meaning-based recall fills in by itself
// after install instead of waiting for someone to know the command exists.
//
// StartInterval, not KeepAlive: a bounded batch pass (--limit rows per wake-up),
// Nice 10 + Background + LowPriorityIO so a first backfill of a big store never
// competes with an interactive session. `--scheduled` makes the known "nothing
// to do yet" outcomes (library not installed, model not downloadable offline)
// exit 0 with one log line, so a missing optional dependency is not a failing job.
//
// BRAIN_EMBED=0 opts out: nothing is installed, and a job that already exists
// does no work when its environment carries it (otherwise: brain embed --uninstall).
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './paths.mjs';
import { stableNodePath } from './bridgehome.mjs';
import { isLinux, installUserUnit, uninstallUserUnit, userUnitStatus } from './platform.mjs';
import { embeddingsDisabled } from './embed.mjs';

const LABEL = 'com.claudebrain.embed';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), '.claude-brain', 'embed.log');
export const DEFAULT_INTERVAL = 1800; // 30 min
export const DEFAULT_LIMIT = 2000;    // memories per wake-up
const BATCH = 8;                      // kept small: flat memory (see runEmbed)

export const embedArgs = (limit = DEFAULT_LIMIT) =>
  ['embed', '--apply', '--scheduled', '--limit', String(limit), '--batch', String(BATCH)];

export function installEmbed({ interval = DEFAULT_INTERVAL, limit = DEFAULT_LIMIT, log = console.log } = {}) {
  if (embeddingsDisabled()) {
    log('⏭  BRAIN_EMBED=0 — meaning-based search is off, no background embedding job installed');
    return { installed: false, skipped: 'BRAIN_EMBED=0' };
  }
  // The job is harmless without the library (it logs and exits 0), but say so.
  try { createRequire(import.meta.url).resolve('@huggingface/transformers'); }
  catch { log(`ℹ️  embedding library not installed yet — recall stays keyword-only until: cd ${REPO_ROOT} && npm install --omit=dev`); }
  const node = stableNodePath();
  const brain = join(REPO_ROOT, 'bin', 'brain.mjs');
  const args = embedArgs(limit);
  if (isLinux()) {
    const u = installUserUnit({ label: LABEL, description: 'Open Agentic Brain and Memory semantic-search backfill', mode: 'interval',
      interval, runAtLoad: true, nice: 10, lowPriority: true, logPath: LOG, args: [node, brain, ...args] });
    log(`✅ meaning-based search backfill on (systemd --user: ${u.unit}, every ${Math.round(interval / 60)} min, ${limit} memories/pass)`);
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
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>Nice</key><integer>10</integer>
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
  log(`✅ meaning-based search backfill on (launchd: ${LABEL}, every ${Math.round(interval / 60)} min, ${limit} memories/pass)`);
  log(`   log: ${LOG}`);
  return { installed: true, plist: PLIST, log: LOG, interval, limit };
}

export function uninstallEmbed({ log = console.log } = {}) {
  if (isLinux()) {
    const u = uninstallUserUnit(LABEL, 'interval');
    log(`stopped background embedding ${u.unit} (unit left at ${u.unitPath})`);
    return { stopped: true };
  }
  try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
  log(`stopped background embedding ${LABEL} (plist left at ${PLIST})`);
  return { stopped: true };
}

export function embedStatus() {
  if (isLinux()) { const s = userUnitStatus(LABEL, 'interval'); return { installed: s.installed, loaded: s.loaded, label: LABEL }; }
  let loaded = false;
  try { loaded = execFileSync('launchctl', ['list'], { encoding: 'utf8' }).includes(LABEL); } catch {}
  return { installed: existsSync(PLIST), loaded, label: LABEL };
}
