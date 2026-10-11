// The user's choice about history that was already on this computer before the
// brain was installed: start memory with it (recommended), or start fresh.
//
// install.sh asks once. "Start fresh" must hold for every later capture run,
// not just the install: ingest re-reads each tool's whole history on its timer,
// so without a recorded cutoff it would quietly back-fill what the user declined.
// Stored next to the store (never in config.json), as a small JSON file:
//   { "mode": "all" | "fresh", "since": "<ISO>", "decidedAt": "<ISO>" }
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NATIVE_DB_PATH } from './paths.mjs';

export const choiceFile = (dir = dirname(NATIVE_DB_PATH)) => join(dir, 'past-sessions.json');

/** The recorded choice, or null when the user hasn't been asked yet. */
export function readChoice(file = choiceFile()) {
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (c && (c.mode === 'all' || c.mode === 'fresh')) return c;
  } catch { /* unreadable: treat as never asked, which captures (the default) */ }
  return null;
}

/** Record "all" (include past sessions) or "fresh" (only sessions from now on). */
export function writeChoice(mode, { file = choiceFile(), now = new Date() } = {}) {
  if (mode !== 'all' && mode !== 'fresh') throw new Error(`past-sessions: mode must be "all" or "fresh", got ${mode}`);
  const prev = readChoice(file);
  // Turning "fresh" on again keeps the original cutoff: re-running the installer
  // must not silently move the line forward and drop sessions in between.
  const since = mode === 'fresh' ? (prev?.mode === 'fresh' && prev.since ? prev.since : now.toISOString()) : null;
  const c = { mode, since, decidedAt: now.toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
  return c;
}

export function clearChoice(file = choiceFile()) { rmSync(file, { force: true }); }

/** Epoch ms before which sessions are skipped, or 0 when everything is captured. */
export function captureCutoff(file = choiceFile()) {
  const c = readChoice(file);
  if (!c || c.mode !== 'fresh' || !c.since) return 0;
  const t = Date.parse(c.since);
  return Number.isFinite(t) ? t : 0;
}
