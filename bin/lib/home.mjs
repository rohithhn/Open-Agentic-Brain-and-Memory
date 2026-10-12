// Home data: memory "signals" (health of the brain) + integrations grid
// (detected AI tools + MCP servers wired into Claude). All from real local state.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from './db.mjs';
import { MEMORY_DB, CLAUDE_DIR, REPO_MANIFEST, config } from './paths.mjs';
import { detectAll } from './detect.mjs';
import { isLinux, userJobs } from './platform.mjs';
import { liveOnly } from './lifecycle.mjs';

const DAY = 86400000;

export function memorySignals() {
  if (!existsSync(MEMORY_DB)) return { memories: 0, types: 0, projects: 0, stale: 0, conflicts: 0, latest: [] };
  const db = openDb(MEMORY_DB, { readonly: true });
  try {
    // Rows deleted in the control panel are out of every figure and the feed,
    // exactly as in the Memory tab's stats (server.mjs memoryStats).
    const L = liveOnly(db);
    const now = db.prepare(`SELECT MAX(created_at_epoch) AS m FROM observations o WHERE 1=1${L}`).get().m || 0;
    const memories = db.prepare(`SELECT COUNT(*) n FROM observations o WHERE 1=1${L}`).get().n;
    const types = db.prepare(`SELECT COUNT(DISTINCT type) n FROM observations o WHERE 1=1${L}`).get().n;
    const projects = db.prepare(`SELECT COUNT(DISTINCT project) n FROM observations o WHERE 1=1${L}`).get().n;
    const stale = db
      .prepare(
        `SELECT COUNT(*) n FROM (SELECT project, MAX(created_at_epoch) t FROM observations o WHERE 1=1${L} GROUP BY project) WHERE ? - t > ?`
      )
      .get(now, 30 * DAY).n;
    const conflicts = db
      .prepare(
        `SELECT COUNT(*) n FROM (SELECT content_hash FROM observations o WHERE content_hash IS NOT NULL${L} GROUP BY content_hash HAVING COUNT(DISTINCT project)>1)`
      )
      .get().n;
    // Latest signals: newest observations as an activity feed.
    const latest = db
      .prepare(`SELECT project, type, title, subtitle, created_at FROM observations o WHERE 1=1${L} ORDER BY created_at_epoch DESC LIMIT 6`)
      .all();
    return { memories, types, projects, stale, conflicts, latest };
  } catch {
    return { memories: 0, types: 0, projects: 0, stale: 0, conflicts: 0, latest: [] };
  } finally {
    db.close();
  }
}

function mcpServers() {
  const files = [join(CLAUDE_DIR, 'settings.json'), join(CLAUDE_DIR, '.mcp.json'), join(CLAUDE_DIR, 'mcp.json')];
  const names = new Set();
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      for (const k of Object.keys(j.mcpServers || {})) names.add(k);
    } catch {}
  }
  return [...names].sort();
}

export function integrations() {
  const d = detectAll();
  const tools = d.tools
    .filter((t) => t.detected)
    .map((t) => ({ name: t.name, kind: t.kind, status: 'detected' }));
  const mcp = mcpServers().map((n) => ({ name: n, kind: 'mcp', status: 'connected' }));
  const keys = d.keys.filter((k) => k.present).map((k) => ({ name: k.name, kind: 'api', status: 'key set' }));
  return { tools, mcp, keys, mcpCount: mcp.length, toolCount: tools.length };
}

function launchdJobs() {
  // Linux: same { label: pid | '-' } shape, from systemd --user units.
  if (isLinux()) return userJobs([WATCH_AGY_LABEL, SYNC_LABEL]);
  try {
    const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
    const m = {};
    for (const line of out.split('\n')) {
      const parts = line.split('\t');
      if (parts.length >= 3) m[parts[2].trim()] = parts[0].trim(); // label -> pid ('-' if idle)
    }
    return m;
  } catch { return {}; }
}
function procAlive(pattern) {
  try { execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore' }); return true; } catch { return false; }
}

const WATCH_AGY_LABEL = 'com.claudebrain.watch-agy';
// Must match the label bin/setup-automation.mjs installs: com.<repo.owner>.<repo.name>.sync,
// derived from config.json so it stays in sync with the installed launchd job's identity.
const SYNC_LABEL = `com.${config.repo.owner}.${config.repo.name}.sync`;

export function healthSignals() {
  const now = Date.now();
  // capture freshness (overall + per source)
  let lastObs = 0; const sources = {};
  if (existsSync(MEMORY_DB)) {
    const db = openDb(MEMORY_DB, { readonly: true });
    try {
      lastObs = db.prepare('SELECT MAX(created_at_epoch) m FROM observations').get().m || 0;
      const rows = db.prepare(`SELECT generated_by_model g, MAX(created_at_epoch) t, COUNT(*) n
        FROM observations GROUP BY generated_by_model`).all();
      for (const r of rows) {
        const g = (r.g || '').toLowerCase();
        const key = g.startsWith('codex') ? 'codex' : g.startsWith('antigravity') ? 'antigravity'
          : (g.startsWith('claude') || g.startsWith('haiku')) ? 'claude' : g.startsWith('kilo') ? 'kilo' : null;
        if (!key) continue;
        if (!sources[key] || r.t > sources[key].last) sources[key] = { last: r.t, ageMs: now - r.t };
      }
    } catch {} finally { db.close(); }
  }
  const captureAgeMs = lastObs ? now - lastObs : null;

  // launchd + process liveness
  const jobs = launchdJobs();
  const agyPid = jobs[WATCH_AGY_LABEL];
  const watchAgy = agyPid === undefined
    ? { installed: false, alive: false, state: 'off' }
    : { installed: true, alive: /^\d+$/.test(agyPid), state: /^\d+$/.test(agyPid) ? 'ok' : 'red' };
  const workerAlive = procAlive('claude-mem/chroma');

  // sync recency
  let lastSync = null;
  try { lastSync = JSON.parse(readFileSync(REPO_MANIFEST, 'utf8')).lastSync || null; } catch {}
  const syncAgeMs = lastSync ? now - Date.parse(lastSync) : null;

  return {
    capture: { lastObs, ageMs: captureAgeMs, stale: captureAgeMs != null && captureAgeMs > DAY, sources,
               state: captureAgeMs == null ? 'off' : captureAgeMs > DAY ? 'red' : 'ok' },
    watchAgy,
    worker: { alive: workerAlive, state: workerAlive ? 'ok' : 'warn' },
    sync: { lastSync, ageMs: syncAgeMs, installed: jobs[SYNC_LABEL] !== undefined,
            stale: syncAgeMs != null && syncAgeMs > 2 * DAY,
            state: syncAgeMs == null ? 'off' : syncAgeMs > 2 * DAY ? 'red' : 'ok' },
  };
}

export function home() {
  return { signals: memorySignals(), health: healthSignals(), integrations: integrations() };
}
