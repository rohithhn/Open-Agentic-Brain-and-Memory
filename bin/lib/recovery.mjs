// Recovery passphrase for the age key.
//
// Losing the age identity makes every encrypted backup unreadable, and a new
// Mac used to need the raw AGE-SECRET-KEY pasted in. `brain key backup` stores a
// second copy of the identity in the brain repo (memory/key-recovery.age),
// encrypted with a passphrase only the user knows; `brain key recover` (and
// `brain restore` on a Mac with no key) asks for that passphrase and imports it.
//
// The file is a standard age v1 file with a single scrypt recipient — exactly
// what `age -p` writes — so the user can always open it by hand with plain
// `age -d memory/key-recovery.age`, even without this tool. It is built here in
// node:crypto rather than by driving `age -p`, because age reads passphrases
// only from a terminal and a scripted pty dance would be fragile.
//
// Never prints, logs or returns the identity anywhere but to the caller.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_MEMORY } from './paths.mjs';

export const RECOVERY_FILE = join(REPO_MEMORY, 'key-recovery.age');
export const MIN_PASSPHRASE = 12;
const DEFAULT_LOG_N = 18;   // age's own default work factor (~0.5 s, 256 MiB)
const MAX_LOG_N = 20;       // refuse files that would make us burn >1 GiB
const INTRO = 'age-encryption.org/v1';
const SCRYPT_LABEL = 'age-encryption.org/v1/scrypt';
const CHUNK = 64 * 1024;

export class RecoveryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code; // WRONG_PASSPHRASE | BAD_FILE | WEAK_PASSPHRASE | NO_FILE | BAD_IDENTITY
  }
}

// ── age v1 / scrypt, just enough of the spec (age-encryption.org/v1) ──────
const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');
const unb64 = (s) => {
  if (!/^[A-Za-z0-9+/]*$/.test(s)) throw new RecoveryError('Recovery file is damaged (bad base64).', 'BAD_FILE');
  return Buffer.from(s, 'base64');
};
const hkdf = (ikm, salt, info) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));

function aead(key, nonce, data, decrypt) {
  if (decrypt) {
    if (data.length < 16) throw new Error('short');
    const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    d.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  }
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}

function scryptKey(passphrase, salt, logN) {
  const N = 2 ** logN;
  return scryptSync(Buffer.from(passphrase, 'utf8'), Buffer.concat([Buffer.from(SCRYPT_LABEL), salt]), 32, {
    N, r: 8, p: 1, maxmem: 128 * 8 * N + 32 * 1024 * 1024,
  });
}

function streamNonce(counter, last) {
  const n = Buffer.alloc(12);
  n.writeUIntBE(counter, 5, 6); // 11-byte big-endian counter; 6 bytes is plenty
  n[11] = last ? 1 : 0;
  return n;
}

export function ageScryptEncrypt(plaintext, passphrase, { logN = DEFAULT_LOG_N } = {}) {
  const fileKey = randomBytes(16);
  const salt = randomBytes(16);
  const body = aead(scryptKey(passphrase, salt, logN), Buffer.alloc(12), fileKey, false);
  // a stanza body is base64 wrapped at 64 columns; 32 bytes = one 43-char line
  const header = `${INTRO}\n-> scrypt ${b64(salt)} ${logN}\n${b64(body)}\n---`;
  const mac = createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(header).digest();
  const nonce = randomBytes(16);
  const payloadKey = hkdf(fileKey, nonce, 'payload');
  const chunks = [];
  const n = Math.max(1, Math.ceil(plaintext.length / CHUNK));
  for (let i = 0; i < n; i++) {
    chunks.push(aead(payloadKey, streamNonce(i, i === n - 1), plaintext.subarray(i * CHUNK, (i + 1) * CHUNK), false));
  }
  return Buffer.concat([Buffer.from(`${header} ${b64(mac)}\n`), nonce, ...chunks]);
}

export function ageScryptDecrypt(data, passphrase) {
  const bad = (why) => new RecoveryError(`Recovery file is damaged or not a passphrase file (${why}).`, 'BAD_FILE');
  // header = text lines up to and including the "--- <mac>" line
  const end = data.indexOf('\n---');
  if (end < 0) throw bad('no header');
  const macEol = data.indexOf('\n', end + 4);
  if (macEol < 0) throw bad('truncated header');
  const lines = data.subarray(0, end).toString('latin1').split('\n');
  if (lines[0] !== INTRO) throw bad('not an age v1 file');
  const m = /^-> scrypt ([A-Za-z0-9+/]{22}) ([1-9][0-9]?)$/.exec(lines[1] || '');
  if (!m || lines.length !== 3) throw bad('expected a single scrypt (passphrase) recipient');
  const logN = Number(m[2]);
  if (logN > MAX_LOG_N) throw bad(`work factor 2^${logN} is too high`);
  const salt = unb64(m[1]);
  const body = unb64(lines[2]);
  if (body.length !== 32) throw bad('wrapped key has the wrong size');
  let fileKey;
  try {
    fileKey = aead(scryptKey(passphrase, salt, logN), Buffer.alloc(12), body, true);
  } catch {
    throw new RecoveryError('Wrong recovery passphrase.', 'WRONG_PASSPHRASE');
  }
  const headerText = data.subarray(0, end + 4); // "…\n---"
  const macLine = data.subarray(end + 4, macEol).toString('latin1');
  if (!macLine.startsWith(' ')) throw bad('bad header MAC line');
  const want = createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(headerText).digest();
  const got = unb64(macLine.slice(1));
  if (got.length !== 32 || !timingSafeEqual(want, got)) throw bad('header was altered');
  const rest = data.subarray(macEol + 1);
  if (rest.length < 16 + 16) throw bad('truncated payload');
  const payloadKey = hkdf(fileKey, rest.subarray(0, 16), 'payload');
  const ct = rest.subarray(16);
  const out = [];
  for (let i = 0, off = 0; off < ct.length; i++, off += CHUNK + 16) {
    const piece = ct.subarray(off, off + CHUNK + 16);
    const last = off + CHUNK + 16 >= ct.length;
    try {
      out.push(aead(payloadKey, streamNonce(i, last), piece, true));
    } catch {
      throw bad('payload was altered or truncated');
    }
  }
  return Buffer.concat(out);
}

// ── the recovery file ─────────────────────────────────────────────────────

// Returns a reason string when the passphrase is too weak, else null.
export function passphraseProblem(p) {
  if (!p) return 'The passphrase is empty.';
  if (p.length < MIN_PASSPHRASE) {
    return `Use at least ${MIN_PASSPHRASE} characters — a few random words works well ` +
      '(anyone who can read your brain repo can try to guess it offline).';
  }
  if (/^(.)\1+$/.test(p)) return 'That passphrase is one repeated character.';
  return null;
}

export function hasRecoveryFile(path = RECOVERY_FILE) {
  return existsSync(path);
}

// Encrypt `identity` with `passphrase` into `path` (atomic). The plaintext is a
// normal age identity file, so `age -d key-recovery.age > id.txt` yields a
// file `age -i` accepts directly.
export function writeRecoveryFile(identity, passphrase, { path = RECOVERY_FILE, recipient = '', logN } = {}) {
  identity = String(identity || '').trim();
  if (!/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(identity)) {
    throw new RecoveryError('There is no valid age key to back up.', 'BAD_IDENTITY');
  }
  const weak = passphraseProblem(passphrase);
  if (weak) throw new RecoveryError(weak, 'WEAK_PASSPHRASE');
  const text =
    '# Open Agentic Brain and Memory encryption key (age identity), from: brain key backup\n' +
    `# created: ${new Date().toISOString()}\n` +
    (recipient ? `# public key: ${recipient}\n` : '') +
    identity + '\n';
  const out = ageScryptEncrypt(Buffer.from(text), passphrase, { logN });
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, out, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  return path;
}

// Decrypt the recovery file and return the AGE-SECRET-KEY line. Throws
// RecoveryError (WRONG_PASSPHRASE / BAD_FILE / NO_FILE); nothing is changed.
export function readRecoveryFile(passphrase, { path = RECOVERY_FILE } = {}) {
  if (!existsSync(path)) {
    throw new RecoveryError(`No recovery file at ${path}.`, 'NO_FILE');
  }
  const text = ageScryptDecrypt(readFileSync(path), passphrase).toString('utf8');
  const m = /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/m.exec(text);
  if (!m) throw new RecoveryError('Recovery file opened, but holds no age key.', 'BAD_FILE');
  return m[0];
}

// ── hidden prompt ─────────────────────────────────────────────────────────
// Reads one line with echo off from the controlling terminal. /dev/tty first,
// because under `curl | bash` stdin is the script itself; falls back to a TTY
// stdin. Returns null when there is no terminal at all.
export async function promptHidden(question) {
  const tty = await import('node:tty');
  let input = null, fd = null;
  try {
    fd = openSync('/dev/tty', 'r+');
    input = new tty.ReadStream(fd);
  } catch {
    if (fd !== null) try { closeSync(fd); } catch {}
    fd = null;
    if (process.stdin.isTTY) input = process.stdin;
  }
  if (!input) return null;
  const write = (s) => (fd !== null ? writeFileSync(fd, s) : process.stdout.write(s));
  write(question);
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  const answer = await new Promise((resolve) => {
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(buf);
        if (ch === '\u0003') return finish(null, true);
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    const finish = (value, interrupted) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      write('\n');
      if (interrupted) process.exit(130);
      resolve(value);
    };
    input.on('data', onData);
  });
  if (fd !== null) { input.destroy(); }
  return answer;
}

// For scripts: the passphrase as the first line of stdin (`--passphrase-stdin`).
export function readPassphraseStdin() {
  try {
    return readFileSync(0, 'utf8').split(/\r?\n/)[0];
  } catch {
    return '';
  }
}
