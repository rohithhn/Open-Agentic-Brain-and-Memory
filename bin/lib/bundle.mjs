// Pack the sensitive brain payload (memory exports + DB + folder context) into a
// single encrypted blob for git, and unpack it locally. Skills/agents/settings
// live outside this boundary (plaintext, portable). When encryption is disabled,
// the payload is committed as plaintext files instead.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, cpSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { encryptFile, decryptFile } from './crypto.mjs';
import { openDb } from './db.mjs';
import { importClaudeMem } from './import-claude-mem.mjs';
import { stripCopy } from './clean.mjs';
import { downloadBlob, hasRemote, blobReleaseState } from './git.mjs';
import {
  REPO_MEMORY,
  REPO_EXPORTS,
  REPO_ROOT,
  CLAUDE_MEM_DB,
  MEMORY_DB,
  config,
} from './paths.mjs';
import { stripVectors } from './embed.mjs';

// Drop the machine-local full-transcript table from a SNAPSHOT (never the live store).
export function stripTranscripts(snapshotPath) {
  const db = openDb(snapshotPath);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_transcripts'").get()) return false;
    db.exec('DROP TABLE session_transcripts');
    db.exec('VACUUM');
    return true;
  } finally {
    try { db.close(); } catch {}
  }
}

// The blob no longer lives in git — it's a Release asset. brain.mjs uploads it
// after packMemory; unpackMemory downloads the freshest copy before reading it.
export const MEMORY_BLOB = join(REPO_MEMORY, 'brain.age');
const BLOB = MEMORY_BLOB;

// claude-mem runs the DB in WAL mode, so recently committed rows can still live in
// claude-mem.db-wal. Copying claude-mem.db alone silently drops them — the newest
// observations, exactly the ones another machine most needs. VACUUM INTO writes a
// consistent snapshot that folds in the WAL, without mutating the live DB (the
// claude-mem worker may be writing to it concurrently).
function snapshotDb(destDir, { log = () => {} } = {}) {
  const dest = join(destDir, 'claude-mem.db');
  let db;
  try {
    db = openDb(MEMORY_DB, { readonly: true });
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    db.close();
    db = null;
    // Embedding vectors are derived and machine-local: never ship them.
    try { stripVectors(dest); } catch (e) { log(`  ⚠️  could not strip local vectors from snapshot (${e.message})`); }
    // Full session transcripts (segments.mjs) stay on this Mac: they are only the
    // distiller's input, re-read from the tools' own files, and are the rawest
    // text the brain holds. The memories distilled from them do sync.
    try { stripTranscripts(dest); } catch (e) { log(`  ⚠️  could not strip local transcripts from snapshot (${e.message})`); }
    return dest;
  } catch (e) {
    log(`  ⚠️  DB snapshot failed (${e.message}); falling back to raw copy — WAL rows may be lost`);
    copyFileSync(MEMORY_DB, dest);
    try { stripVectors(dest); } catch {}
    try { stripTranscripts(dest); } catch {}
    return dest;
  } finally {
    try { db?.close(); } catch {}
  }
}
const REPO_CONTEXT = join(REPO_ROOT, 'context');

// Pack exports/, context/ and the DB into a tgz, then age-encrypt to memory/brain.age.
export function packMemory({ log = () => {} } = {}) {
  if (!config.encryption.enabled) {
    log('  encryption disabled — leaving memory as plaintext files');
    return { encrypted: false };
  }
  mkdirSync(REPO_MEMORY, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'brain-pack-'));
  const tgz = join(tmp, 'payload.tgz');
  try {
    const args = ['-czf', tgz, '-C', REPO_MEMORY, 'exports'];
    if (existsSync(REPO_CONTEXT)) args.push('-C', REPO_ROOT, 'context');
    if (existsSync(join(REPO_ROOT, 'wiki'))) args.push('-C', REPO_ROOT, 'wiki');
    if (existsSync(join(REPO_ROOT, 'learnings'))) args.push('-C', REPO_ROOT, 'learnings');
    if (existsSync(join(REPO_ROOT, 'evals'))) args.push('-C', REPO_ROOT, 'evals');
    if (existsSync(MEMORY_DB)) {
      snapshotDb(tmp, { log });
      args.push('-C', tmp, 'claude-mem.db');
    }
    execFileSync('tar', args, { stdio: 'ignore' });
    encryptFile(tgz, BLOB);
    log('  memory encrypted → memory/brain.age');
    return { encrypted: true, blob: BLOB };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// INSERT-OR-IGNORE every row of `sourceDb` into MEMORY_DB on the natural keys
// (the importer's verified copy path), minus self-capture and test-fixture rows
// (the importer's skips — what keeps a `brain clean` from being undone by the
// next sync). Returns rows added. Throws on failure.
function mergeDbInto(sourceDb, { log = () => {} } = {}) {
  const r = importClaudeMem({
    source: sourceDb, dest: MEMORY_DB, apply: true, resume: false, verify: false, touchReady: false, log: () => {},
  });
  if (r.rejected || r.distinctLost) {
    log(`  ⚠️  merge: ${r.rejected || 0} rejected, ${r.distinctLost || 0} conflicting row(s) kept as the local version`);
  }
  return (r.tables || []).reduce((n, t) => n + (t.inserted || 0), 0);
}

// Before a sync overwrites the cloud blob, fold in whatever other devices
// pushed since this machine last looked. Without this, sync is last-writer-wins:
// two machines that both capture and sync lose each other's memories.
// Returns rows merged. Throws (so the caller aborts the upload) when the cloud
// copy exists but can't be fetched or decrypted — overwriting it blind is how
// memories get lost.
export function mergeRemoteMemory({ log = () => {} } = {}) {
  if (!config.encryption.enabled || !hasRemote()) return 0;
  const state = blobReleaseState();
  if (state === 'absent') { log('  no cloud brain yet — nothing to merge'); return 0; }
  if (state === 'unknown') {
    throw new Error("couldn't check the cloud brain (network or GitHub auth) — not uploading, so nothing another device pushed gets overwritten. Re-run brain sync.");
  }
  // Stable path (gitignored .brain-tmp/) so the importer's import_state keeps
  // one row for "the cloud", not one per temp dir.
  const work = join(REPO_ROOT, '.brain-tmp', 'cloud-merge');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const blob = join(work, 'brain.age');
  const tgz = join(work, 'payload.tgz');
  try {
    if (!downloadBlob(blob, { log: () => {} })) {
      throw new Error("couldn't download the cloud brain — not uploading, so nothing another device pushed gets overwritten. Re-run brain sync.");
    }
    try { decryptFile(blob, tgz); } catch (e) {
      throw new Error(`the cloud brain doesn't decrypt with this machine's key — refusing to overwrite it. (${e.message.split('\n')[0]})`);
    }
    execFileSync('tar', ['-xzf', tgz, '-C', work, 'claude-mem.db'], { stdio: 'ignore' });
    const db = join(work, 'claude-mem.db');
    if (!existsSync(db)) return 0;
    if (!existsSync(MEMORY_DB)) {
      mkdirSync(dirname(MEMORY_DB), { recursive: true });
      // A whole-file copy bypasses the importer's self-capture and test-data
      // skips, so strip the (throwaway, extracted) copy first — see clean.mjs.
      stripCopy(db);
      copyFileSync(db, MEMORY_DB);
      log('  pulled cloud brain onto this machine');
      return 0;
    }
    const added = mergeDbInto(db, { log });
    log(`  merged cloud brain (+${added} row(s) from other devices)`);
    return added;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Decrypt memory/brain.age and restore exports/, context/ and the DB locally.
export function unpackMemory({ restoreDb = true, refresh = false, log = () => {} } = {}) {
  // Blob lives in the brain-latest Release, not git. Fetch it when explicitly refreshing
  // (restore) or when it's simply not present locally (fresh machine). Do NOT re-download
  // on every unpack — merge/launch run frequently and the blob is 33MB.
  if (hasRemote() && (refresh || !existsSync(BLOB))) downloadBlob(BLOB, { log });
  if (!existsSync(BLOB)) {
    log('  no encrypted memory blob (repo or release) — skipping');
    return { restored: false };
  }
  const tmp = mkdtempSync(join(tmpdir(), 'brain-unpack-'));
  const tgz = join(tmp, 'payload.tgz');
  const out = join(tmp, 'out');
  try {
    mkdirSync(out, { recursive: true });
    decryptFile(BLOB, tgz);
    execFileSync('tar', ['-xzf', tgz, '-C', out], { stdio: 'ignore' });

    // exports → repo (for local reading by any AI)
    if (existsSync(join(out, 'exports'))) {
      rmSync(REPO_EXPORTS, { recursive: true, force: true });
      cpSync(join(out, 'exports'), REPO_EXPORTS, { recursive: true });
    }
    if (existsSync(join(out, 'context'))) {
      cpSync(join(out, 'context'), REPO_CONTEXT, { recursive: true, force: true });
    }
    if (existsSync(join(out, 'wiki'))) {
      cpSync(join(out, 'wiki'), join(REPO_ROOT, 'wiki'), { recursive: true, force: true });
    }
    if (existsSync(join(out, 'learnings'))) {
      cpSync(join(out, 'learnings'), join(REPO_ROOT, 'learnings'), { recursive: true, force: true });
    }
    if (existsSync(join(out, 'evals'))) {
      cpSync(join(out, 'evals'), join(REPO_ROOT, 'evals'), { recursive: true, force: true });
    }
    // DB → ~/.claude-mem (backing up any existing one)
    if (restoreDb && existsSync(join(out, 'claude-mem.db'))) {
      // Create the directory the DB actually lands in. On a brand-new machine
      // MEMORY_DB is the native store (~/.claude-brain/brain.db), not a file in
      // CLAUDE_MEM_DIR — creating only the latter made first restore ENOENT.
      mkdirSync(dirname(MEMORY_DB), { recursive: true });
      if (existsSync(MEMORY_DB)) {
        // This machine already has memories. Replacing its DB with the cloud
        // copy would silently drop everything captured here since that copy was
        // made, so merge the cloud rows in instead (duplicates skipped).
        copyFileSync(MEMORY_DB, MEMORY_DB + '.pre-restore.bak');
        log('  backed up existing DB → ' + MEMORY_DB + '.pre-restore.bak');
        const added = mergeDbInto(join(out, 'claude-mem.db'), { log });
        log(`  merged cloud memory into this machine (+${added} row(s))`);
      } else {
        // Temp copy extracted above — strip the brain's own runs and
        // test-fixture projects before it lands.
        stripCopy(join(out, 'claude-mem.db'));
        copyFileSync(join(out, 'claude-mem.db'), MEMORY_DB);
        log('  restored claude-mem.db');
      }
    }
    return { restored: true };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
