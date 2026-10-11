// Linux secret storage — the counterpart of the macOS Keychain in keychain.mjs.
//
// 1. libsecret via `secret-tool` (GNOME Keyring / KWallet) when it is installed
//    and a keyring answers. The value goes over stdin, never argv.
// 2. Otherwise an encrypted file, ~/.claude-brain/secrets.enc (0600, dir 0700):
//    AES-256-GCM per entry, key = scrypt(machine-id + uid + user). HONEST LIMIT:
//    that key is derivable by anything running as this user on this machine, so
//    the file is as safe as an unencrypted ~/.ssh key — its encryption only stops
//    the plaintext leaking via backups/copies onto another machine. Install
//    libsecret-tools (apt) / libsecret (dnf) for real keyring protection.
//
// Verified against a real gnome-keyring (libsecret) on Debian 12; also unit-tested with a fake
// secret-tool (evals/platform-test.mjs). Without a reachable keyring `secret-tool store` fails fast and
// the value lands in the encrypted file (unless BRAIN_SECRET_BACKEND=libsecret forces a hard error).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { binOnPath } from './platform.mjs';

// BRAIN_SECRET_BACKEND=file|libsecret forces one (tests, headless boxes).
function useLibsecret() {
  const forced = process.env.BRAIN_SECRET_BACKEND;
  if (forced === 'file') return false;
  if (forced === 'libsecret') return true;
  return !!binOnPath('secret-tool');
}

export function linuxBackend() {
  return useLibsecret() ? 'libsecret' : 'file';
}

// ── libsecret ───────────────────────────────────────────────────────────────
const attrs = (service, account) => ['service', service, 'account', account];
const SECRET_TOOL_TIMEOUT = 15000; // a locked keyring can prompt; never hang forever

function stGet(service, account) {
  try {
    const out = execFileSync('secret-tool', ['lookup', ...attrs(service, account)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: SECRET_TOOL_TIMEOUT });
    return out ? out.replace(/\n$/, '') : null;
  } catch { return null; }
}
function stSet(service, account, value) {
  try {
    execFileSync('secret-tool', ['store', `--label=${service} ${account}`, ...attrs(service, account)],
      { input: value, stdio: ['pipe', 'ignore', 'ignore'], timeout: SECRET_TOOL_TIMEOUT });
    return stGet(service, account) === value; // a keyring that "stores" nothing is a failure
  } catch { return false; }
}
function stDelete(service, account) {
  try {
    execFileSync('secret-tool', ['clear', ...attrs(service, account)],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: SECRET_TOOL_TIMEOUT });
    return true;
  } catch { return false; }
}

// ── encrypted file fallback ─────────────────────────────────────────────────
export const secretsFile = () => join(homedir(), '.claude-brain', 'secrets.enc');

function machineMaterial() {
  let id = '';
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { id = readFileSync(f, 'utf8').trim(); if (id) break; } catch {}
  }
  let user = '';
  try { user = userInfo().username; } catch {}
  return `agentic-brain:${id || hostname()}:${process.getuid?.() ?? ''}:${user}`;
}

function readStore() {
  try {
    const j = JSON.parse(readFileSync(secretsFile(), 'utf8'));
    if (j && j.v === 1 && j.salt && j.entries) return j;
  } catch {}
  return { v: 1, kdf: 'scrypt', salt: randomBytes(16).toString('base64'), entries: {} };
}
function writeStore(store) {
  const f = secretsFile();
  const dir = join(f, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, f);
}
const keyFor = (store) => scryptSync(machineMaterial(), Buffer.from(store.salt, 'base64'), 32);
const entryId = (service, account) => `${service}/${account}`;

function fileGet(service, account) {
  if (!existsSync(secretsFile())) return null;
  const store = readStore();
  const e = store.entries[entryId(service, account)];
  if (!e) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', keyFor(store), Buffer.from(e.iv, 'base64'));
    d.setAAD(Buffer.from(entryId(service, account))); // entries can't be swapped between accounts
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]).toString('utf8');
  } catch { return null; } // wrong machine / tampered → treat as absent
}
function fileSet(service, account, value) {
  const store = readStore();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(store), iv);
  c.setAAD(Buffer.from(entryId(service, account)));
  const ct = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  store.entries[entryId(service, account)] = {
    iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64'),
  };
  writeStore(store);
  return true;
}
function fileDelete(service, account) {
  if (!existsSync(secretsFile())) return false;
  const store = readStore();
  const id = entryId(service, account);
  if (!(id in store.entries)) return false;
  delete store.entries[id];
  writeStore(store);
  return true;
}

// ── public API (same contract as the macOS functions in keychain.mjs) ────────
export function linuxGetSecret(service, account) {
  if (useLibsecret()) {
    const v = stGet(service, account);
    if (v !== null) return v;
  }
  return fileGet(service, account); // also finds values stored before libsecret was set up
}

export function linuxSetSecret(service, account, value) {
  if (useLibsecret() && stSet(service, account, value)) {
    fileDelete(service, account); // no stale second copy
    return true;
  }
  if (process.env.BRAIN_SECRET_BACKEND === 'libsecret') {
    throw new Error('secret-tool could not store the secret (is a keyring unlocked?)');
  }
  return fileSet(service, account, value);
}

export function linuxDeleteSecret(service, account) {
  // `secret-tool clear` exits 0 even when nothing matched; report "deleted" only
  // if something was there (the Keychain's delete fails on a missing item).
  let a = false;
  if (useLibsecret() && stGet(service, account) !== null) {
    a = stDelete(service, account) && stGet(service, account) === null;
  }
  const b = fileDelete(service, account);
  return a || b;
}
