// Central path + config resolution for Claude Brain.
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Repo root = two levels up from bin/lib
export const REPO_ROOT = resolve(__dirname, '..', '..');

export function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

// Canonical config locations. `brain init` writes CONFIG_PATH, seeding it from
// CONFIG_EXAMPLE_PATH; loadConfig() below falls back to the example so that a
// fresh clone (which has no config.json — it is gitignored) can still run every
// command, including `brain init` itself, instead of dying with a raw stack
// trace at import time.
export const CONFIG_PATH = join(REPO_ROOT, 'config.json');
export const CONFIG_EXAMPLE_PATH = join(REPO_ROOT, 'config.example.json');

// Is there a real config.json on this machine? Evaluated once at import, like
// every other constant here. `false` means "this install has never been
// configured" — the signal `brain init` and the UI use to offer setup.
export const CONFIG_PRESENT = existsSync(CONFIG_PATH);

// True once loadConfig() has run and determined config.json is absent, so
// callers (notably `brain init`) can tell "real config" from the
// config.example.json fallback used to keep every command runnable on a
// fresh clone. Set as a side effect of the loadConfig() call below.
export let CONFIG_IS_FALLBACK = false;

export function loadConfig() {
  const cfgPath = CONFIG_PATH;
  const examplePath = CONFIG_EXAMPLE_PATH;
  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`${path} is not valid JSON — fix it or delete it and re-run 'brain init'.`);
      }
      throw e;
    }
  };
  if (existsSync(cfgPath)) {
    CONFIG_IS_FALLBACK = false;
    return readJson(cfgPath);
  }
  if (existsSync(examplePath)) {
    CONFIG_IS_FALLBACK = true;
    return readJson(examplePath);
  }
  throw new Error(
    `No config.json (and no config.example.json to fall back to) at ${REPO_ROOT}.\n` +
      `  Create one:  cp config.example.json config.json   (then edit repo.owner/name)\n` +
      `  Or run:      brain init`
  );
}

const cfg = loadConfig();

// Source locations on this machine
export const CLAUDE_MEM_DIR = expandHome(cfg.sources.claudeMemDir);
export const SHARED_DIR = expandHome(cfg.sources.sharedDir);
export const CLAUDE_DIR = expandHome(cfg.sources.claudeDir);
export const CLAUDE_MEM_DB = join(CLAUDE_MEM_DIR, 'claude-mem.db');

// Native store (docs/specs/native-capture.md §2): this project's own DB,
// column-compatible with claude-mem's so every existing reader keeps working
// unchanged once it points here. `config.sources.memoryDb`, if set, overrides
// the default `~/.claude-brain/brain.db` location.
export const NATIVE_DB_PATH = cfg.sources?.memoryDb
  ? expandHome(cfg.sources.memoryDb)
  : join(homedir(), '.claude-brain', 'brain.db');

// MEMORY_DB is the path every module should eventually read from instead of
// CLAUDE_MEM_DB directly: the native store once it exists, else today's
// claude-mem DB (zero-risk default — this constant only ever *reads* which
// file exists, it never creates one). CLAUDE_MEM_DB stays exported and
// working for the importer/detector and any module not yet switched over.
// Readiness marker, written ONLY after an import verifies. Gating on this rather
// than on the DB file's existence is deliberate: existsSync() is true for a
// zero-byte file and for a store left half-populated by a crashed import, so a
// bare existence check would silently point every reader at a partial brain with
// no error anywhere. Absent marker => keep reading claude-mem, which is correct
// and safe. Delete the marker to force the fallback.
export const NATIVE_READY = join(dirname(NATIVE_DB_PATH), 'READY');
// Three cases, in order:
//   1. native store exists AND verified ready  → use it
//   2. otherwise, claude-mem's DB exists       → use that (the safe fallback:
//      it is the copy that definitely holds everything)
//   3. NEITHER exists — a brand-new user with no claude-mem installed → the
//      native store, which will be created on first write. Falling back to a
//      claude-mem path that does not exist would make capture throw and the
//      user would silently record nothing, forever.
export const MEMORY_DB = (existsSync(NATIVE_DB_PATH) && existsSync(NATIVE_READY))
  ? NATIVE_DB_PATH
  : (existsSync(CLAUDE_MEM_DB) ? CLAUDE_MEM_DB : NATIVE_DB_PATH);

// Destinations inside the repo
export const REPO_SKILLS = join(REPO_ROOT, 'skills');
export const REPO_AGENTS = join(REPO_ROOT, 'agents');
export const REPO_SETTINGS = join(REPO_ROOT, 'settings');
export const REPO_MEMORY = join(REPO_ROOT, 'memory');
export const REPO_EXPORTS = join(REPO_MEMORY, 'exports');
export const REPO_WIKI = join(REPO_ROOT, 'wiki');
export const REPO_MANIFEST = join(REPO_ROOT, 'MANIFEST.json');
export const ENC_DB = join(REPO_MEMORY, 'claude-mem.db.age');

export { cfg as config };

export function sanitizeName(name) {
  // Filesystem-safe project/topic folder name, stable across machines.
  const out = (name || '_unknown')
    .replace(/[\/\\]/g, '__')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .trim()
    .slice(0, 120) || '_unknown';
  // Neutralize traversal: a bare '.'/'..' would resolve to the parent dir when
  // joined, so callers using this as a path-safety guard could escape their dir.
  return /^\.+$/.test(out) ? '_' + out : out;
}

export function repoConfigured() {
  return existsSync(CLAUDE_MEM_DB);
}
