// Platform layer: the few places where macOS and Linux genuinely differ —
// per-app config dirs, and the per-user scheduler (launchd vs systemd --user).
// Secrets live in keychain.mjs / secrets-linux.mjs.
//
// macOS code paths stay in their original modules, byte-for-byte; callers only
// branch to this module's systemd helpers when isLinux(). Linux support is
// UNIT-TESTED ONLY (evals/platform-test.mjs, via BRAIN_PLATFORM_OVERRIDE=linux
// with fake systemctl/secret-tool) — it has not been run on a real Linux box.
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// Tests (and only tests) force a platform with BRAIN_PLATFORM_OVERRIDE. Read on
// every call so one process can exercise both branches.
export function currentPlatform() {
  return process.env.BRAIN_PLATFORM_OVERRIDE || process.platform;
}
export const isLinux = () => currentPlatform() === 'linux';

// Per-user scheduler name, for user-facing messages.
export const schedulerName = () => (isLinux() ? 'systemd' : 'launchd');

// Where desktop apps keep their per-user config: ~/Library/Application Support/<App>
// on macOS, $XDG_CONFIG_HOME/<App> (~/.config/<App>) on Linux — Electron apps
// (Cursor, VS Code "Code", Claude Desktop builds) use exactly that name there.
export function xdgConfigHome() {
  const x = process.env.XDG_CONFIG_HOME;
  return x && x.startsWith('/') ? x : join(homedir(), '.config');
}
export function appSupportDir(...parts) {
  return isLinux() ? join(xdgConfigHome(), ...parts) : join(homedir(), 'Library', 'Application Support', ...parts);
}

export function binOnPath(bin, pathVar = process.env.PATH || '') {
  for (const d of pathVar.split(delimiter)) {
    if (!d) continue;
    try { if (statSync(join(d, bin)).isFile()) return join(d, bin); } catch {}
  }
  return null;
}

// ── systemd --user (Linux counterpart of the LaunchAgents) ──────────────────
// Label → unit name unchanged (com.claudebrain.serve.service): dots are legal in
// unit names and keeping the label means one identity across both platforms.
export const systemdUnitDir = () => join(xdgConfigHome(), 'systemd', 'user');

// Quote one ExecStart argument. systemd splits on whitespace, honours "…" with
// C-style escapes, and expands % specifiers and $VARS — escape all of those.
export function systemdQuote(arg) {
  const s = String(arg).replace(/%/g, '%%').replace(/\$/g, '$$$$');
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// mode: 'daemon'   → long-running, restarted on exit   (launchd KeepAlive)
//       'interval' → oneshot + timer every N seconds    (launchd StartInterval)
//       'calendar' → oneshot + daily timer at HH:MM     (launchd StartCalendarInterval)
// runAtLoad → also fire right when the timer is started (at login / enable).
export function renderService({ label, description, args, mode, logPath, errPath, nice, lowPriority, env }) {
  const L = ['[Unit]', `Description=${description || label}`, '', '[Service]'];
  L.push(`Type=${mode === 'daemon' ? 'simple' : 'oneshot'}`);
  L.push(`ExecStart=${args.map(systemdQuote).join(' ')}`);
  if (mode === 'daemon') { L.push('Restart=always', 'RestartSec=5'); }
  if (nice != null) L.push(`Nice=${nice}`);
  if (lowPriority) L.push('IOSchedulingClass=idle');
  for (const [k, v] of Object.entries(env || {})) L.push(`Environment=${systemdQuote(`${k}=${v}`)}`);
  if (logPath) {
    L.push(`StandardOutput=append:${logPath}`);
    L.push(`StandardError=append:${errPath || logPath}`);
  }
  if (mode === 'daemon') L.push('', '[Install]', 'WantedBy=default.target');
  return L.join('\n') + '\n';
}

export function renderTimer({ label, description, mode, interval, calendar, runAtLoad }) {
  const L = ['[Unit]', `Description=${description || label} (timer)`, '', '[Timer]'];
  if (runAtLoad) L.push('OnActiveSec=10s');
  if (mode === 'interval') L.push(`OnUnitActiveSec=${interval}s`);
  if (mode === 'calendar') {
    const pad = (n) => String(n).padStart(2, '0');
    L.push(`OnCalendar=*-*-* ${pad(calendar.hour)}:${pad(calendar.minute)}:00`);
    L.push('Persistent=true'); // catch up a run missed while suspended/off
  }
  L.push(`Unit=${label}.service`, '', '[Install]', 'WantedBy=timers.target');
  return L.join('\n') + '\n';
}

function systemctl(args, opts = {}) {
  return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// The unit systemctl should enable/start/query for this job.
const primaryUnit = (label, mode) => `${label}.${mode === 'daemon' ? 'service' : 'timer'}`;

// Write the unit(s), reload, enable + start. Idempotent (restart picks up edits).
// Returns the paths written so callers can print them like they print plists.
export function installUserUnit(spec) {
  const dir = systemdUnitDir();
  mkdirSync(dir, { recursive: true });
  for (const p of [spec.logPath, spec.errPath]) if (p) mkdirSync(dirname(p), { recursive: true });
  const service = join(dir, `${spec.label}.service`);
  writeFileSync(service, renderService(spec));
  let timer = null;
  if (spec.mode !== 'daemon') {
    timer = join(dir, `${spec.label}.timer`);
    writeFileSync(timer, renderTimer(spec));
  }
  const unit = primaryUnit(spec.label, spec.mode);
  try {
    systemctl(['daemon-reload']);
    systemctl(['enable', unit]);
    systemctl(['restart', unit]);
  } catch (e) {
    const why = (e.stderr || e.message || '').toString().trim().split('\n')[0];
    throw new Error(`systemctl --user could not start ${unit} (${why}) — is a systemd user session running? unit files left in ${dir}`);
  }
  return { unit, service, timer, unitPath: timer || service };
}

// Stop + disable; unit files are left in place (as the macOS side leaves plists).
export function uninstallUserUnit(label, mode) {
  const unit = primaryUnit(label, mode);
  try { systemctl(['disable', '--now', unit]); } catch {}
  return { unit, unitPath: join(systemdUnitDir(), unit) };
}

function showProps(unit) {
  const out = {};
  try {
    for (const line of systemctl(['show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID']).split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
    }
  } catch {}
  return out;
}

export function userUnitStatus(label, mode) {
  const unit = primaryUnit(label, mode);
  const installed = existsSync(join(systemdUnitDir(), unit));
  const p = installed ? showProps(unit) : {};
  return { installed, loaded: p.ActiveState === 'active', unit };
}

// Linux counterpart of `launchctl list` parsing: { label: pid | '-' } for each
// label whose unit file exists (a service or a timer). Absent label = not installed.
export function userJobs(labels) {
  const m = {};
  const dir = systemdUnitDir();
  for (const label of labels) {
    const hasService = existsSync(join(dir, `${label}.service`));
    const hasTimer = existsSync(join(dir, `${label}.timer`));
    if (!hasService && !hasTimer) continue;
    const pid = showProps(`${label}.service`).MainPID;
    m[label] = pid && /^\d+$/.test(pid) && pid !== '0' ? pid : '-';
  }
  return m;
}
