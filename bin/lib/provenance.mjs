// Provenance for recalled memories: where did this memory come from?
//
// One compact answer — tool, date, project, primary file — shared by every read
// path (brain_recall, brain_context, `brain recall`, the startup block) so they
// can never disagree about what a memory's origin is.
//
// Pure helpers only (no DB handle, no stdout): callers do the SELECT using
// PROVENANCE_JOIN / PROVENANCE_COLS and hand the row to provenanceOf().

/** files_modified is a JSON array of path strings (very often `[]`). Tolerate a
 *  bare string, and never let a malformed row throw. Returns '' when the row
 *  records no file — the common case, ~75% of rows. files_read is checked only
 *  after files_modified and is never merged with it. */
export function primaryFile(row) {
  for (const raw of [row.files_modified, row.files_read]) {
    if (!raw || typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!s || s === '[]') continue;
    let list;
    if (s.startsWith('[')) {
      try { list = JSON.parse(s); } catch { continue; }
    } else {
      list = [s];
    }
    if (!Array.isArray(list)) continue;
    const first = list.find((x) => typeof x === 'string' && x.trim());
    if (first) return first.trim();
  }
  return '';
}

// Observations carry no platform of their own; it lives on the owning session.
// LEFT JOIN: ~24% of the live store's rows (claude-mem-native) have no
// sdk_sessions row, and must still be returned.
export const PROVENANCE_JOIN = 'LEFT JOIN sdk_sessions ps ON ps.memory_session_id = o.memory_session_id';
export const PROVENANCE_COLS = 'ps.platform_source AS platform_source, o.memory_session_id, o.files_modified, o.files_read, o.created_at, o.created_at_epoch';

// Display names for the tool that produced the memory.
const TOOL_NAMES = {
  claude: 'claude-code',
  claude_code: 'claude-code',
  claude_desktop: 'claude-desktop',
  claude_desktop_agent: 'claude-desktop-agent',
  mcp_local_agent_mode_agentic_brain: 'mcp-agent',
};
const toolName = (p) => TOOL_NAMES[p] || p;

/** Which tool recorded this row. Session platform first; else the `tool:` prefix
 *  the importers put on memory_session_id; else a bare uuid, which is what
 *  claude-mem itself writes, so Claude Code. */
export function sourceOf(row) {
  const p = String((row && row.platform_source) || '').trim();
  if (p) return toolName(p);
  const m = /^([a-z][a-z0-9_-]{1,30}):/i.exec(String((row && row.memory_session_id) || ''));
  if (m) return toolName(m[1].toLowerCase());
  return row && row.memory_session_id ? 'claude-code' : '';
}

/** YYYY-MM-DD of the row. Epoch is ms here but seconds on some imports. */
export function dayOf(row) {
  const e = Number(row && row.created_at_epoch);
  if (Number.isFinite(e) && e > 0) {
    const d = new Date(e > 1e12 ? e : e * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String((row && row.created_at) || ''));
  return m ? m[0] : '';
}

function shortFile(p, max = 48) {
  let s = String(p || '').replace(/^\.\//, '');
  const home = process.env.HOME || '';
  if (home && s.startsWith(`${home}/`)) s = `~/${s.slice(home.length + 1)}`;
  return s.length <= max ? s : `…/${s.split('/').slice(-2).join('/')}`;
}

/** { source, day, project, file } — every field '' when unknown. */
export function provenanceOf(row) {
  return {
    source: sourceOf(row),
    day: dayOf(row),
    project: (row && row.project) || '',
    file: row ? shortFile(primaryFile(row)) : '',
  };
}

/** "claude-code · 2026-09-27 · my-app · bin/brain.mjs" — unknown parts
 *  are dropped, never printed as placeholders. */
export function formatProvenance(p, { project = true } = {}) {
  return [p.source, p.day, project ? p.project : '', p.file].filter(Boolean).join(' · ');
}
