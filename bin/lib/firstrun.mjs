// First-run visibility: what the brain found on this machine and how far it is
// with turning that history into memories.
//
// A new install back-fills from history already on disk (Claude Code, Codex,
// Cursor, Gemini, Antigravity, Kilo, ...): ingest finds the sessions at once,
// the distiller turns them into memories over the following hours. Without a
// report of that, a new user opens a near-empty panel and assumes it's broken.
// Read-only: everything here opens the store read-only and writes nothing.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MEMORY_DB, CLAUDE_MEM_DB } from './paths.mjs';
import { readChoice, choiceFile } from './pastsessions.mjs';

// What the distill timer gets through: --limit 12 calls every 15 minutes
// (distill-schedule.mjs DEFAULT_LIMIT / DEFAULT_INTERVAL).
export const DISTILL_CALLS_PER_HOUR = 12 * 4;

// platform_source -> the name a user recognises.
const TOOL_NAMES = {
  claude: 'Claude Code', claude_code: 'Claude Code', claude_work: 'Claude Code', claude_personal: 'Claude Code',
  codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini CLI', antigravity: 'Antigravity',
  kilo: 'Kilo Code', kilo_cli: 'Kilo CLI',
  claude_desktop: 'Claude Desktop', claude_desktop_agent: 'Claude Desktop',
};
// Rows written by the MCP save tool, not by capture: not "past sessions found".
const NOT_CAPTURED = /^mcp_|^claude_desktop/; // MCP saves and chat-app sessions: not back-filled history

const openRO = (p) => new DatabaseSync(`file:${p}?mode=ro`, { readOnly: true });
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

/** Sessions found per tool, memories built, and the distiller's remaining work. */
export async function firstRunStatus({ dbPath = MEMORY_DB, claudeMemDb = CLAUDE_MEM_DB, plan = null, pastChoiceFile = choiceFile() } = {}) {
  const c = readChoice(pastChoiceFile);
  // 'all' (or not asked yet: past sessions are the default) | 'fresh' (user chose to start from install)
  const out = { sessions: { total: 0, byTool: {} }, memories: 0, pending: null, etaHours: 0, claudeMem: null,
    pastSessions: c?.mode === 'fresh' ? 'fresh' : 'all', freshSince: c?.mode === 'fresh' ? c.since : null };
  if (dbPath && existsSync(dbPath)) {
    let db;
    try {
      db = openRO(dbPath);
      if (hasTable(db, 'sdk_sessions')) {
        for (const r of db.prepare('SELECT platform_source AS p, count(*) AS n FROM sdk_sessions GROUP BY 1').all()) {
          if (!r.p || NOT_CAPTURED.test(r.p)) continue;
          const name = TOOL_NAMES[r.p] || r.p;
          out.sessions.byTool[name] = (out.sessions.byTool[name] || 0) + r.n;
          out.sessions.total += r.n;
        }
      }
      if (hasTable(db, 'observations')) out.memories = db.prepare('SELECT count(*) AS n FROM observations').get().n;
    } catch { /* unreadable store: report what we have */ } finally { try { db?.close(); } catch {} }
    try {
      const p = plan || (await import('./distiller.mjs')).planBatch(dbPath, { limit: 12 });
      out.pending = { calls: p.calls, freshSessions: p.freshSessions, waitingForIdle: p.waitingForIdle, byTool: {} };
      for (const [k, v] of Object.entries(p.byPlatform || {})) { const name = TOOL_NAMES[k] || k; out.pending.byTool[name] = (out.pending.byTool[name] || 0) + v; }
      // Never round pending work down to 0 ("done"): a few calls is still minutes away.
      out.etaHours = p.calls ? Math.max(0.1, Math.round((p.calls / DISTILL_CALLS_PER_HOUR) * 10) / 10) : 0;
    } catch { out.pending = null; }
  }
  // claude-mem: its history can come over instantly (switch-from-claude-mem).
  if (claudeMemDb && existsSync(claudeMemDb)) {
    let n = null, imported = false, db;
    try { db = openRO(claudeMemDb); n = db.prepare('SELECT count(*) AS n FROM observations').get().n; } catch {} finally { try { db?.close(); } catch {} }
    if (dbPath && existsSync(dbPath)) {
      let s;
      try { s = openRO(dbPath); imported = hasTable(s, 'import_state') && !!s.prepare('SELECT 1 FROM import_state WHERE source_path = ?').get(claudeMemDb); } catch {} finally { try { s?.close(); } catch {} }
    }
    out.claudeMem = { observations: n, imported };
  }
  out.done = !!out.pending && out.pending.calls === 0;
  return out;
}

const plural = (n, w, many = `${w}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? w : many}`;
function listTools(byTool) {
  const names = Object.entries(byTool).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
export function formatEta(hours) {
  if (hours <= 0) return 'done';
  if (hours < 1) return `about ${Math.max(5, Math.round((hours * 60) / 5) * 5)} minutes`;
  if (hours < 36) return `about ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  return `about ${Math.round(hours / 24)} days`;
}

/** The plain-language summary printed at the end of install / onboard. */
export function formatFirstRun(s) {
  const L = [];
  if (s.pastSessions === 'fresh' && !s.sessions.total) {
    L.push('🌱 Starting fresh: your memory begins with your next session in any connected tool.');
    L.push('   Change your mind any time: brain past-sessions on');
  } else if (!s.sessions.total) {
    L.push('🧠 No past AI sessions found on this machine yet. Memories start with your next session in any connected tool.');
  } else {
    L.push(`🧠 Found ${plural(s.sessions.total, 'past session')} across ${listTools(s.sessions.byTool)}.`);
    if (s.pending && s.pending.calls > 0) {
      L.push(`   Building your memory now in the background (${formatEta(s.etaHours)}). You can keep working; it fills in as it goes.`);
    } else {
      L.push(`   Your memory is built: ${plural(s.memories, 'memory', 'memories')} ready.`);
    }
  }
  if (s.claudeMem && s.claudeMem.observations && !s.claudeMem.imported) {
    L.push(`   claude-mem found with ${plural(s.claudeMem.observations, 'memory', 'memories')}. Bring them over instantly: brain switch-from-claude-mem --apply`);
  }
  L.push('   Watch progress in the control panel: http://127.0.0.1:37800');
  return L.join('\n');
}
