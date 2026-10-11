// macOS Keychain-backed secret storage. Secrets NEVER touch the repo or disk in
// plaintext — they live only in the login keychain of each machine.
// On Linux the same API routes to secrets-linux.mjs (libsecret `secret-tool`,
// else an encrypted file); the macOS branch below is unchanged.
import { execFileSync } from 'node:child_process';
import { config } from './paths.mjs';
import { isLinux } from './platform.mjs';
import { linuxGetSecret, linuxSetSecret, linuxDeleteSecret, linuxBackend } from './secrets-linux.mjs';

const SERVICE = config.keychainService || 'claude-brain';

// Known secret keys the OS manages.
export const SECRET_KEYS = {
  AGE_KEY: 'age-identity',        // the age private key (x25519 identity)
  AGE_RECIPIENT: 'age-recipient', // the age public key (recipient)
  GITHUB_TOKEN: 'github-token',   // optional PAT if not using gh
  OPENROUTER: 'openrouter-key',   // for API-backed agents (e.g. Nous Hermes)
};

// Where secrets live on this machine: 'keychain' | 'libsecret' | 'file'.
export function secretBackend() {
  return isLinux() ? linuxBackend() : 'keychain';
}

export function getSecret(account) {
  if (isLinux()) return linuxGetSecret(SERVICE, account);
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out.replace(/\n$/, '');
  } catch {
    return null;
  }
}

// `security -i` reads commands from stdin, so the value never appears on argv
// (where any local process can read it via `ps`). Its line parser splits on
// whitespace and honours "double quotes" with backslash escapes (\" and \\);
// everything else — spaces, single quotes, $, tabs, UTF-8 — is literal. It reads
// each line into a ~4 KB buffer and cuts the rest, so longer lines are refused
// rather than letting the overflow run as a second command.
// Empty values are refused too: `-w` with nothing usable after it is how the
// tool is told to prompt for a password, so an empty value must never reach it
// (clear a secret with deleteSecret instead).
const SECURITY_LINE_MAX = 4000;
const kcQuote = (s) => '"' + String(s).replace(/[\\"]/g, '\\$&') + '"';

export function securityAddCommand(service, account, value) {
  for (const [what, v] of [['service', service], ['account', account], ['value', value]]) {
    if (String(v ?? '') === '') throw new Error(`Keychain ${what} cannot be empty`);
    if (/[\n\0]/.test(String(v))) throw new Error(`Keychain ${what} cannot contain a newline or NUL byte`);
  }
  // -U updates if present.
  const line = ['add-generic-password', '-U', '-s', kcQuote(service), '-a', kcQuote(account), '-w', kcQuote(value)].join(' ') + '\n';
  if (Buffer.byteLength(line) > SECURITY_LINE_MAX) throw new Error('Secret is too long for the Keychain (over ~4 KB)');
  return line;
}

// `find-generic-password -w` prints hex instead of text for a value with
// non-printable bytes; accept either form when checking what was stored.
const sameStored = (out, value) =>
  out === value || (/^[0-9a-f]+$/i.test(out || '') && out.length % 2 === 0 && Buffer.from(out, 'hex').toString('utf8') === value);

export function setSecret(account, value) {
  if (isLinux()) return linuxSetSecret(SERVICE, account, value);
  value = String(value);
  execFileSync('security', ['-i'], {
    input: securityAddCommand(SERVICE, account, value),
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  // `security -i` exits with the last command's status, but a Keychain that
  // silently refuses would leave the old value (or nothing): read it back.
  if (!sameStored(getSecret(account), value)) {
    throw new Error(`Keychain did not store ${account} (read-back did not match)`);
  }
  return true;
}

export function deleteSecret(account) {
  if (isLinux()) return linuxDeleteSecret(SERVICE, account);
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function hasSecret(account) {
  return getSecret(account) !== null;
}

export function secretStatus() {
  return {
    ageKey: hasSecret(SECRET_KEYS.AGE_KEY),
    ageRecipient: hasSecret(SECRET_KEYS.AGE_RECIPIENT),
    githubToken: hasSecret(SECRET_KEYS.GITHUB_TOKEN),
  };
}
