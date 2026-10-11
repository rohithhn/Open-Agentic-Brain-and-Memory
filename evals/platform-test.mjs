#!/usr/bin/env node
// Tests for the Linux platform layer (bin/lib/platform.mjs, secrets-linux.mjs)
// and the Linux branches of every module that used to assume macOS: keychain,
// serve/capture/distill-schedule/watch/setup-automation (systemd --user instead
// of launchd), home/doctor job listing, per-app config paths, install.sh hints.
//
// There is no real Linux here: BRAIN_PLATFORM_OVERRIDE=linux forces the branch,
// and fake `systemctl` / `secret-tool` (plus leak-detecting fake `launchctl` /
// `security`) sit first on PATH. HOME is a temp dir, so nothing real is touched —
// not the Keychain, not ~/Library/LaunchAgents, not ~/.config. These tests prove
// the Linux code does what it intends; they do NOT prove it on a real distro.
//
//   node evals/platform-test.mjs
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SB = mkdtempSync(join(tmpdir(), 'brain-platform-'));
const HOME = join(SB, 'home');
const BIN = join(SB, 'bin');
const LOG = join(SB, 'calls.log');
const ST_DIR = join(SB, 'secret-tool-store');
for (const d of [HOME, BIN, ST_DIR]) mkdirSync(d, { recursive: true });

const shim = (name, body) => { const p = join(BIN, name); writeFileSync(p, `#!/bin/bash\n${body}\n`); chmodSync(p, 0o755); };
shim('systemctl', `echo "systemctl $*" >> "${LOG}"
[ "\${FAKE_SYSTEMCTL_FAIL:-}" = 1 ] && { echo "Failed to connect to bus: No medium found" >&2; exit 1; }
if [ "$2" = show ]; then echo "LoadState=loaded"; echo "ActiveState=\${FAKE_ACTIVE:-active}"; echo "MainPID=\${FAKE_PID:-4242}"; fi
exit 0`);
// file-backed libsecret: one file per attribute set; the secret arrives on stdin
shim('secret-tool', `echo "secret-tool $*" >> "${LOG}"
[ "\${FAKE_ST_FAIL:-}" = 1 ] && exit 1
op="$1"; shift; key=""
while [ $# -gt 0 ]; do case "$1" in --label=*) ;; *) key="$key-$1";; esac; shift; done
f="${ST_DIR}/$(printf %s "$key" | tr -c 'A-Za-z0-9._-' '_')"
case "$op" in store) cat > "$f";; lookup) [ -f "$f" ] && cat "$f" || exit 1;; clear) rm -f "$f";; esac
exit 0`);
shim('launchctl', `echo "launchctl $*" >> "${LOG}"; exit 0`);
shim('security', `echo "security $*" >> "${LOG}"; [ "$1" = find-generic-password ] && printf 'mac-secret\\n'; exit 0`);

// Environment BEFORE importing anything: modules resolve HOME at import time.
process.env.HOME = HOME;
process.env.PATH = `${BIN}:${dirname(process.execPath)}:/usr/bin:/bin`;
delete process.env.XDG_CONFIG_HOME;
delete process.env.BRAIN_SECRET_BACKEND;
process.env.BRAIN_PLATFORM_OVERRIDE = 'linux';

const P = await import('../bin/lib/platform.mjs');
const K = await import('../bin/lib/keychain.mjs');
const SL = await import('../bin/lib/secrets-linux.mjs');
const serve = await import('../bin/lib/serve.mjs');
const capture = await import('../bin/lib/capture.mjs');
const distill = await import('../bin/lib/distill-schedule.mjs');
const embedSched = await import('../bin/lib/embed-schedule.mjs');
const watch = await import('../bin/lib/watch.mjs');
const automation = await import('../bin/setup-automation.mjs');
const home = await import('../bin/lib/home.mjs');
const { config } = await import('../bin/lib/paths.mjs');
const { TARGETS } = await import('../bin/lib/wire-targets.mjs');

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
const calls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '');
const resetCalls = () => writeFileSync(LOG, '');
const quiet = () => {};
const UNITS = join(HOME, '.config', 'systemd', 'user');
const unit = (f) => readFileSync(join(UNITS, f), 'utf8');
const noMacLeak = () => {
  assert(!/^launchctl /m.test(calls()), 'launchctl was called on Linux:\n' + calls());
  assert(!/^security /m.test(calls()), '`security` was called on Linux:\n' + calls());
  assert(!existsSync(join(HOME, 'Library')), '~/Library was created on Linux');
};

// ── platform basics ─────────────────────────────────────────────────────────
await t('override selects linux; unset follows process.platform', () => {
  eq(P.currentPlatform(), 'linux', 'override');
  eq(P.isLinux(), true, 'isLinux');
  eq(P.schedulerName(), 'systemd', 'scheduler');
  const saved = process.env.BRAIN_PLATFORM_OVERRIDE;
  delete process.env.BRAIN_PLATFORM_OVERRIDE;
  eq(P.currentPlatform(), process.platform, 'no override');
  process.env.BRAIN_PLATFORM_OVERRIDE = saved;
});

await t('appSupportDir: ~/.config/<App> on Linux, XDG_CONFIG_HOME honoured, Library on macOS', () => {
  eq(P.appSupportDir('Cursor', 'User'), join(HOME, '.config', 'Cursor', 'User'), 'linux default');
  process.env.XDG_CONFIG_HOME = join(SB, 'xdg');
  eq(P.appSupportDir('Claude'), join(SB, 'xdg', 'Claude'), 'xdg');
  process.env.XDG_CONFIG_HOME = 'relative/ignored';
  eq(P.appSupportDir('Claude'), join(HOME, '.config', 'Claude'), 'relative XDG ignored per spec');
  delete process.env.XDG_CONFIG_HOME;
  process.env.BRAIN_PLATFORM_OVERRIDE = 'darwin';
  eq(P.appSupportDir('Cursor', 'User'), join(HOME, 'Library', 'Application Support', 'Cursor', 'User'), 'mac');
  process.env.BRAIN_PLATFORM_OVERRIDE = 'linux';
});

await t('Claude Desktop wire target + Cursor/VS Code paths follow the platform', () => {
  const cd = TARGETS.find((x) => x.id === 'claude_desktop');
  eq(cd.configPath(), join(HOME, '.config', 'Claude', 'claude_desktop_config.json'), 'linux claude desktop');
  process.env.BRAIN_PLATFORM_OVERRIDE = 'darwin';
  eq(cd.configPath(), join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 'mac claude desktop');
  process.env.BRAIN_PLATFORM_OVERRIDE = 'linux';
  const src = readFileSync(join(REPO, 'bin/lib/ingest.mjs'), 'utf8');
  assert(src.includes("appSupportDir('Cursor', 'User', 'globalStorage', 'state.vscdb')"), 'ingest Cursor path goes through appSupportDir');
});

await t('systemdQuote escapes whitespace, quotes, % and $', () => {
  eq(P.systemdQuote('/usr/bin/node'), '/usr/bin/node', 'plain');
  eq(P.systemdQuote('/home/a b/brain.mjs'), '"/home/a b/brain.mjs"', 'space');
  eq(P.systemdQuote('50%'), '50%%', 'percent');
  eq(P.systemdQuote('$HOME'), '"$$HOME"', 'dollar');
  eq(P.systemdQuote('say "hi"'), '"say \\"hi\\""', 'quotes');
});

// ── schedulers: systemd --user instead of launchd ───────────────────────────
await t('installServe → daemon unit (Restart=always, default.target), enabled + started', () => {
  resetCalls();
  const r = serve.installServe({ log: quiet });
  const s = unit('com.claudebrain.serve.service');
  assert(/^Type=simple$/m.test(s) && /^Restart=always$/m.test(s), 'daemon semantics:\n' + s);
  assert(/^WantedBy=default\.target$/m.test(s), 'starts at login');
  assert(/^ExecStart=\S+ \S*bin\/brain\.mjs serve$/m.test(s), 'ExecStart:\n' + s);
  assert(s.includes(`StandardOutput=append:${join(HOME, '.claude-mem', 'serve.log')}`), 'log path');
  assert(!existsSync(join(UNITS, 'com.claudebrain.serve.timer')), 'no timer for a daemon');
  const c = calls();
  assert(c.includes('systemctl --user daemon-reload') && c.includes('systemctl --user enable com.claudebrain.serve.service')
    && c.includes('systemctl --user restart com.claudebrain.serve.service'), 'systemctl calls:\n' + c);
  eq(r.installed, true, 'result');
  noMacLeak();
});

await t('installIngest → oneshot + timer every 600s, fires at login', () => {
  resetCalls();
  capture.installIngest({ log: quiet });
  const s = unit('com.claudebrain.ingest.service');
  const tm = unit('com.claudebrain.ingest.timer');
  assert(/^Type=oneshot$/m.test(s) && !/Restart=/.test(s), 'oneshot:\n' + s);
  assert(/ingest$/m.test(s.match(/^ExecStart=.*$/m)[0]), 'runs ingest');
  assert(/^OnUnitActiveSec=600s$/m.test(tm) && /^OnActiveSec=/m.test(tm), 'interval + run-at-load:\n' + tm);
  assert(/^Unit=com\.claudebrain\.ingest\.service$/m.test(tm) && /^WantedBy=timers\.target$/m.test(tm), 'timer wiring');
  assert(calls().includes('enable com.claudebrain.ingest.timer'), 'enables the timer, not the service');
  noMacLeak();
});

await t('installDistill → low-priority oneshot (Nice=5, idle IO) with --limit', () => {
  resetCalls();
  distill.installDistill({ log: quiet });
  const s = unit('com.claudebrain.distill.service');
  assert(/^Nice=5$/m.test(s) && /^IOSchedulingClass=idle$/m.test(s), 'priority:\n' + s);
  assert(/distill-sessions --limit 12 --concurrency 2$/m.test(s), 'args:\n' + s);
  assert(/^OnUnitActiveSec=900s$/m.test(unit('com.claudebrain.distill.timer')), '15 min');
  noMacLeak();
});

await t('installEmbed → lowest-priority oneshot (Nice=10, idle IO), bounded --limit, every 30 min; none under BRAIN_EMBED=0', () => {
  resetCalls();
  process.env.BRAIN_EMBED = '0';
  try { eq(embedSched.installEmbed({ log: quiet }).installed, false, 'opt-out installs nothing'); } finally { delete process.env.BRAIN_EMBED; }
  assert(!calls().includes('com.claudebrain.embed'), 'no systemctl calls for the opted-out install');
  embedSched.installEmbed({ log: quiet });
  const s = unit('com.claudebrain.embed.service');
  assert(/^Nice=10$/m.test(s) && /^IOSchedulingClass=idle$/m.test(s), 'priority:\n' + s);
  assert(/embed --apply --scheduled --limit 2000 --batch 8$/m.test(s), 'args:\n' + s);
  assert(/^OnUnitActiveSec=1800s$/m.test(unit('com.claudebrain.embed.timer')), '30 min');
  assert(calls().includes('enable com.claudebrain.embed.timer'), 'enables the timer');
  eq(embedSched.embedStatus().installed, true, 'status installed');
  noMacLeak();
});

await t('watch-agy / watch-codex → always-on daemons', () => {
  resetCalls();
  watch.installWatchAgy({ log: quiet });
  watch.installWatchCodex({ log: quiet });
  assert(/watch-agy$/m.test(unit('com.claudebrain.watch-agy.service')), 'agy');
  assert(/^Restart=always$/m.test(unit('com.claudebrain.watch-codex.service')), 'codex restarts');
  noMacLeak();
});

const SYNC = `com.${config.repo.owner}.${config.repo.name}.sync`;
await t('daily sync → 09:30 calendar timer, Persistent, PATH + logs under ~/.claude-brain', () => {
  resetCalls();
  const r = automation.installDailySync({ log: quiet });
  const s = unit(`${SYNC}.service`);
  const tm = unit(`${SYNC}.timer`);
  assert(/^OnCalendar=\*-\*-\* 09:30:00$/m.test(tm) && /^Persistent=true$/m.test(tm), 'calendar:\n' + tm);
  assert(!/^OnActiveSec/m.test(tm), 'RunAtLoad=false → no run at enable');
  assert(/^Environment=PATH=\S*\/usr\/bin:\/bin$/m.test(s), 'PATH env:\n' + s);
  assert(s.includes(`StandardOutput=append:${join(HOME, '.claude-brain', 'logs', 'sync.out.log')}`)
    && s.includes(`StandardError=append:${join(HOME, '.claude-brain', 'logs', 'sync.err.log')}`), 'split logs');
  assert(/sync$/m.test(s.match(/^ExecStart=.*$/m)[0]), 'runs sync');
  eq(r.label, SYNC, 'label from config');
  noMacLeak();
});

await t('status + home health read systemd (pid → alive, sync installed)', () => {
  eq(serve.serveStatus().installed, true, 'serve installed');
  eq(serve.serveStatus().loaded, true, 'serve active');
  eq(capture.ingestStatus().installed, true, 'ingest installed');
  eq(distill.distillStatus().installed, true, 'distill installed');
  process.env.FAKE_ACTIVE = 'inactive';
  eq(serve.serveStatus().loaded, false, 'inactive → not loaded');
  delete process.env.FAKE_ACTIVE;
  const h = home.healthSignals();
  eq(h.watchAgy.installed, true, 'agy installed');
  eq(h.watchAgy.alive, true, 'agy alive (MainPID)');
  eq(h.sync.installed, true, 'sync timer counts as installed');
  process.env.FAKE_PID = '0';
  eq(home.healthSignals().watchAgy.state, 'red', 'MainPID=0 → not running');
  delete process.env.FAKE_PID;
});

await t('uninstall = disable --now, unit files left in place', () => {
  resetCalls();
  serve.uninstallServe({ log: quiet });
  capture.uninstallIngest({ log: quiet });
  assert(calls().includes('systemctl --user disable --now com.claudebrain.serve.service'), 'serve');
  assert(calls().includes('systemctl --user disable --now com.claudebrain.ingest.timer'), 'ingest timer');
  assert(existsSync(join(UNITS, 'com.claudebrain.serve.service')), 'file kept');
  noMacLeak();
});

await t('no systemd user session → clear error (onboard catches and logs "skipped")', () => {
  process.env.FAKE_SYSTEMCTL_FAIL = '1';
  let err = null;
  try { serve.installServe({ log: quiet }); } catch (e) { err = e; }
  delete process.env.FAKE_SYSTEMCTL_FAIL;
  assert(err && /systemctl --user could not start com\.claudebrain\.serve\.service/.test(err.message)
    && /No medium found/.test(err.message), 'error: ' + (err && err.message));
});

await t('doctor names systemd, not launchd, on Linux', () => {
  const src = readFileSync(join(REPO, 'bin/lib/doctor.mjs'), 'utf8');
  assert(src.includes("isLinux() ? 'systemd sync timer not installed' : 'launchd sync job not installed'"), 'sync row');
});

// ── secrets: libsecret, then encrypted file ─────────────────────────────────
await t('libsecret: set/get/has/delete via secret-tool, value on stdin not argv', () => {
  resetCalls();
  eq(K.secretBackend(), 'libsecret', 'backend');
  const v = 'AGE-SECRET-KEY-1TESTVALUE';
  eq(K.setSecret(K.SECRET_KEYS.AGE_KEY, v), true, 'set');
  eq(K.getSecret(K.SECRET_KEYS.AGE_KEY), v, 'get');
  eq(K.hasSecret(K.SECRET_KEYS.AGE_KEY), true, 'has');
  assert(!calls().includes(v), 'secret leaked into argv:\n' + calls());
  assert(/secret-tool store --label=\S+ age-identity service \S+ account age-identity/.test(calls()), 'store argv');
  assert(!existsSync(SL.secretsFile()), 'no fallback file when the keyring works');
  eq(K.deleteSecret(K.SECRET_KEYS.AGE_KEY), true, 'delete');
  eq(K.getSecret(K.SECRET_KEYS.AGE_KEY), null, 'gone');
  eq(K.deleteSecret(K.SECRET_KEYS.AGE_KEY), false, 'delete of a missing secret → false (Keychain parity)');
  noMacLeak();
});

await t('keyring refuses to store → encrypted-file fallback, still readable', () => {
  process.env.FAKE_ST_FAIL = '1';
  eq(K.setSecret(K.SECRET_KEYS.GITHUB_TOKEN, 'ghp_fallback'), true, 'set');
  eq(K.getSecret(K.SECRET_KEYS.GITHUB_TOKEN), 'ghp_fallback', 'get from file');
  delete process.env.FAKE_ST_FAIL;
  eq(K.getSecret(K.SECRET_KEYS.GITHUB_TOKEN), 'ghp_fallback', 'still found once the keyring answers');
  eq(K.setSecret(K.SECRET_KEYS.GITHUB_TOKEN, 'ghp_moved'), true, 're-set with working keyring');
  eq(K.getSecret(K.SECRET_KEYS.GITHUB_TOKEN), 'ghp_moved', 'new value');
  const left = Object.keys(JSON.parse(readFileSync(SL.secretsFile(), 'utf8')).entries);
  assert(!left.some((k) => k.endsWith('/github-token')), 'stale file copy removed: ' + left);
  K.deleteSecret(K.SECRET_KEYS.GITHUB_TOKEN);
});

await t('file backend (no secret-tool): 0600, ciphertext only, round-trips, detected automatically', () => {
  renameSync(join(BIN, 'secret-tool'), join(SB, 'secret-tool.off'));
  // Hide secret-tool everywhere: a real Linux box has one in /usr/bin. Detection reads
  // PATH per call, so a PATH without /usr/bin or /bin (node's dir is enough) hides it.
  const savedPath = process.env.PATH;
  process.env.PATH = `${BIN}:${dirname(process.execPath)}`;
  try {
    eq(K.secretBackend(), 'file', 'auto-detected');
    const v = 'AGE-SECRET-KEY-1FILEBACKEND';
    K.setSecret(K.SECRET_KEYS.AGE_KEY, v);
    K.setSecret(K.SECRET_KEYS.AGE_RECIPIENT, 'age1recipientxyz');
    const f = SL.secretsFile();
    eq(f, join(HOME, '.claude-brain', 'secrets.enc'), 'location');
    eq(statSync(f).mode & 0o777, 0o600, 'file mode');
    const raw = readFileSync(f, 'utf8');
    assert(!raw.includes(v) && !raw.includes('age1recipientxyz'), 'plaintext on disk');
    eq(K.getSecret(K.SECRET_KEYS.AGE_KEY), v, 'round-trip');
    eq(K.secretStatus().ageRecipient, true, 'secretStatus works');
    // swapping ciphertexts between accounts must not decrypt (AAD = service/account)
    const j = JSON.parse(raw);
    const ids = Object.keys(j.entries);
    [j.entries[ids[0]], j.entries[ids[1]]] = [j.entries[ids[1]], j.entries[ids[0]]];
    writeFileSync(f, JSON.stringify(j));
    eq(K.getSecret(K.SECRET_KEYS.AGE_KEY), null, 'swapped entry rejected');
    writeFileSync(f, raw);
    eq(K.deleteSecret(K.SECRET_KEYS.AGE_KEY), true, 'delete');
    eq(K.getSecret(K.SECRET_KEYS.AGE_KEY), null, 'deleted');
    eq(K.getSecret(K.SECRET_KEYS.AGE_RECIPIENT), 'age1recipientxyz', 'other entry intact');
  } finally {
    process.env.PATH = savedPath;
    renameSync(join(SB, 'secret-tool.off'), join(BIN, 'secret-tool'));
  }
  noMacLeak();
});

await t('BRAIN_SECRET_BACKEND=libsecret refuses to silently fall back', () => {
  process.env.BRAIN_SECRET_BACKEND = 'libsecret';
  process.env.FAKE_ST_FAIL = '1';
  let err = null;
  try { K.setSecret(K.SECRET_KEYS.OPENROUTER, 'x'); } catch (e) { err = e; }
  delete process.env.FAKE_ST_FAIL;
  delete process.env.BRAIN_SECRET_BACKEND;
  assert(err && /secret-tool could not store/.test(err.message), 'throws');
});

// ── macOS branch untouched ──────────────────────────────────────────────────
await t('darwin: keychain uses `security` exactly as before, scheduler writes a plist via launchctl', () => {
  resetCalls();
  process.env.BRAIN_PLATFORM_OVERRIDE = 'darwin';
  try {
    eq(K.secretBackend(), 'keychain', 'backend');
    eq(K.getSecret('age-identity'), 'mac-secret', 'get via security');
    assert(calls().includes('security find-generic-password -s claude-brain -a age-identity -w'), 'argv:\n' + calls());
    // serve.mjs resolved its plist path at import, under the fake HOME
    serve.installServe({ log: quiet });
    const plist = readFileSync(join(HOME, 'Library', 'LaunchAgents', 'com.claudebrain.serve.plist'), 'utf8');
    assert(plist.includes('<key>KeepAlive</key><true/>'), 'plist');
    assert(calls().includes('launchctl load -w'), 'launchctl load');
    assert(!/^systemctl /m.test(calls()), 'systemctl called on macOS');
  } finally {
    process.env.BRAIN_PLATFORM_OVERRIDE = 'linux';
  }
});

// ── install.sh ──────────────────────────────────────────────────────────────
await t('install.sh: apt/dnf hint on Linux, Homebrew hint on macOS, when git is missing', () => {
  const empty = join(SB, 'emptybin');
  mkdirSync(empty, { recursive: true });
  const run = (os) => spawnSync('/bin/bash', [join(REPO, 'install.sh')], {
    encoding: 'utf8', env: { HOME, PATH: empty, BRAIN_TEST: '1', BRAIN_PLATFORM_OVERRIDE: os, CLAUDE_BRAIN_DIR: join(SB, 'target') },
  });
  const lin = run('linux');
  const lo = lin.stdout + lin.stderr;
  assert(lin.status === 1 && /sudo apt install git\s+\(or: sudo dnf install git\)/.test(lo), 'linux output:\n' + lo);
  assert(!/Homebrew/.test(lo), 'linux mentions Homebrew:\n' + lo);
  const mac = run('darwin');
  const mo = mac.stdout + mac.stderr;
  assert(mac.status === 1 && /Homebrew isn't installed/.test(mo) && /brew reinstall git/.test(mo), 'mac output:\n' + mo);
  assert(!existsSync(join(SB, 'target')), 'installer went past the dependency check');
});

rmSync(SB, { recursive: true, force: true });
for (const [s, n, m] of results) console.log(`${s}  ${n}${m ? '\n    ' + m : ''}`);
console.log(`\n${pass} passed, ${fail} failed  (Linux branches via BRAIN_PLATFORM_OVERRIDE; also runs natively on real Linux)`);
process.exit(fail ? 1 : 0);
