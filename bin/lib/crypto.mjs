// age-based encryption for the memory blob. The age identity (private key) and
// recipient (public key) live in the Keychain; we materialize the identity to a
// locked-down temp file only for the moment of decryption, then shred it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSecret, setSecret, SECRET_KEYS } from './keychain.mjs';

// Generate a fresh age identity and store both halves in the Keychain.
// Returns the recipient (public key) so the UI can display it.
//
// DATA-LOSS GUARD: the Keychain's `security add-generic-password -U` overwrites
// silently. Generating a new key on a machine that already has one makes every
// existing encrypted brain backup permanently unreadable — there is no way to
// recover a blob encrypted to a recipient whose identity was just replaced. So
// this refuses to run unless there is no key yet, or the caller explicitly
// passes `{ force: true }` (never reachable from a bare CLI flag — see
// bin/brain.mjs's `key generate --force` handling, which requires a typed
// confirmation before setting it).
export function generateAndStoreKey({ force = false } = {}) {
  if (!force && hasKey()) {
    throw new Error(
      'An age key already exists on this machine. Generating a new one would make every ' +
        'existing encrypted brain backup permanently unreadable — the old backups were ' +
        'encrypted to the old key, and there is no way to recover them once it is replaced.\n' +
        '  Back it up first:  brain key show\n' +
        '  Moving to a NEW machine? Paste the EXISTING key instead:  brain key import AGE-SECRET-KEY-...\n' +
        '  Only if you are certain the old key and its backups are unrecoverable/unwanted, ' +
        'force a fresh one:  brain key generate --force (requires typed confirmation).'
    );
  }
  const raw = execFileSync('age-keygen', [], { encoding: 'utf8' });
  const secretMatch = raw.match(/AGE-SECRET-KEY-[A-Z0-9]+/);
  const pubMatch = raw.match(/public key:\s*(age1[a-z0-9]+)/i);
  if (!secretMatch || !pubMatch) throw new Error('age-keygen output not understood');
  const identity = secretMatch[0];
  const recipient = pubMatch[1];
  setSecret(SECRET_KEYS.AGE_KEY, identity);
  setSecret(SECRET_KEYS.AGE_RECIPIENT, recipient);
  return recipient;
}

// Store an identity the user pasted from another machine; derive recipient from it.
export function importIdentity(identity) {
  identity = identity.trim();
  if (!/^AGE-SECRET-KEY-/.test(identity)) {
    throw new Error('That does not look like an age identity (expected AGE-SECRET-KEY-...)');
  }
  // Catch the two common paste mistakes before age-keygen's cryptic
  // "unknown identity type": a doc placeholder, and a truncated/garbled key.
  if (/[…]|\.\.\.|<|>/.test(identity)) {
    throw new Error(
      'That is a placeholder, not your key — replace AGE-SECRET-KEY-… with the full key\n' +
        '  (AGE-SECRET-KEY-1 followed by 58 letters/digits, from your old Mac or password manager).'
    );
  }
  if (!/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(identity)) {
    throw new Error(
      `That key is ${identity.length} characters; a real one is 74 (AGE-SECRET-KEY-1 + 58 letters/digits).\n` +
        '  It was probably cut off or has a stray character — copy it again in full. Nothing was changed.'
    );
  }
  const recipient = recipientFromIdentity(identity);
  setSecret(SECRET_KEYS.AGE_KEY, identity);
  setSecret(SECRET_KEYS.AGE_RECIPIENT, recipient);
  return recipient;
}

function recipientFromIdentity(identity) {
  // `age-keygen -y` reads an identity file and prints its recipient.
  return withIdentityFile(identity, (file) =>
    execFileSync('age-keygen', ['-y', file], { encoding: 'utf8' }).trim()
  );
}

function withIdentityFile(identity, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-age-'));
  const file = join(dir, 'id.txt');
  try {
    writeFileSync(file, identity + '\n', { mode: 0o600 });
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function encryptFile(inPath, outPath) {
  const recipient = getSecret(SECRET_KEYS.AGE_RECIPIENT);
  if (!recipient) throw new Error('No age recipient in Keychain — set up your key first.');
  execFileSync('age', ['-r', recipient, '-o', outPath, inPath], { stdio: 'inherit' });
}

export function decryptFile(inPath, outPath) {
  const identity = getSecret(SECRET_KEYS.AGE_KEY);
  if (!identity) throw new Error('No age identity in Keychain — paste your key in the OS UI first.');
  withIdentityFile(identity, (file) => {
    execFileSync('age', ['-d', '-i', file, '-o', outPath, inPath], { stdio: 'inherit' });
  });
}

export function hasKey() {
  return !!getSecret(SECRET_KEYS.AGE_KEY);
}
