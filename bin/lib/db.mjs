// Thin wrapper around node:sqlite (built into Node 22+).
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { assertWritableInThisEnv } from './testguard.mjs';

// Several writers share this store on a schedule — ingest every 10 min,
// distillation every 15, the UI server, plus interactive commands. Without a
// busy timeout, any overlap surfaces as an immediate "database is locked" and
// the losing job drops its work. Setting it here rather than at call sites
// because the distiller had it on one of four opens and lost a distilled
// session to the other three.
export const BUSY_TIMEOUT_MS = 30_000;

export function openDb(path, { create = false, readonly = false, busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
  if (!create && !existsSync(path)) {
    throw new Error(`Database not found: ${path}`);
  }
  // A test run never writes the real store (testguard.mjs); no-op outside tests.
  if (!readonly) assertWritableInThisEnv(path);
  const db = new DatabaseSync(path, { readOnly: readonly, open: true });
  // Best-effort: a readonly handle or an exotic build can refuse the pragma,
  // and that must never stop the caller from reading.
  try { db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) || 0}`); } catch {}
  return db;
}

export function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return !!row;
}

export function count(db, table) {
  if (!tableExists(db, table)) return 0;
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}
