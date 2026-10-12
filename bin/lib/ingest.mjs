// Cross-tool session INGESTION. Reads the sessions/history of every LINKED AI
// tool — Claude Code, Codex, Antigravity, Cursor, Kilo Code (opt-out model) — and
// merges them into the brain's own store, so all of it is searchable together.
// Idempotent: INSERT OR IGNORE on the DB's natural unique indexes.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, tableExists } from './db.mjs';
import { effectiveLinked } from './detect.mjs';
import { config, MEMORY_DB } from './paths.mjs';
import { scrubItem, scrubText } from './scrub.mjs';
import { saveTranscript, transcriptMeta, ensureTranscriptTable } from './segments.mjs';
import { isSelfCaptureItem, isSelfRunProjectDir } from './selfcapture.mjs';
import { isAutoTestDataProject, captureSkipper, readCleanedProjects } from './testdata.mjs';
import { appSupportDir } from './platform.mjs';
import { stateKey as distillStateKey, PROVENANCE_PREFIX } from './distiller.mjs';
import { isEdited } from './curate.mjs';
import { contentHash } from './hash.mjs';
import { liveOnly } from './lifecycle.mjs';
import { bumpRelevance, DUPLICATE } from './dedupe.mjs';
import { kiloDbPath, kiloLegacyTaskDirs } from './kilo.mjs';
import { captureCutoff } from './pastsessions.mjs';
import { pbTry, pbSub, pbStr, pbAll, pbTimeMs } from './protowire.mjs';

const HOME = homedir();
const MAX_PER_TOOL = 500;

// content_hash of a raw transcript row: the strong v2 hash (hash.mjs). Rows an
// older build wrote keep their v1 FNV hash until `brain migrate-hash`.
const hash = contentHash;

const epochOf = (ts) => {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : 0;
};
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
// Every parser clips the stored transcript to this many chars (head kept).
const TRANSCRIPT_CAP = 8000;

// The FULL transcript of a long session (see segments.mjs). The row's `transcript`
// stays clipped at TRANSCRIPT_CAP — everything that tracks growth depends on it —
// so the complete text travels beside it, and only for sessions that exceed the cap:
//   it.loadFull() → { text, marks, size }   lazy (re-reads the source file; nothing
//                   is retained per session, so a 500-session sweep stays small)
//   it.fullText   → raw string (parsers whose source is not a re-readable file)
// Both are scrubbed when STORED (ingest below), never here: scrubbing millions of
// chars for every session on every run is only paid when a session changed.
// `msgs`: [{role, text, ts?}] → the same `role: text` / blank-line join the row
// uses, scrubbed PER MESSAGE so the per-message offsets in `marks` stay valid.
export function fullFromMessages(msgs) {
  const parts = [];
  const marks = [];
  let off = 0, size = 0;
  for (const m of msgs) {
    const raw = `${m.role}: ${m.text}`;
    size += raw.length + (parts.length ? 2 : 0);
    const t = `${m.role}: ${scrubText(m.text).text}`;
    const ms = Date.parse(m.ts);
    marks.push([off, Number.isFinite(ms) ? ms : 0]);
    parts.push(t);
    off += t.length + 2;
  }
  return { text: parts.join('\n\n'), marks: marks.some((k) => k[1]) ? marks : null, size };
}
// Test-fixture projects ingest leaves out (testdata.mjs): the auto patterns, plus
// — once ingest() has the store open — names `brain clean --test-data --apply`
// already removed. Module-level so the parsers' windows below can see it.
let isFixtureProject = isAutoTestDataProject;

// The newest-N window counts only the user's sessions: the brain's own runs
// (selfcapture.mjs) and test-fixture runs never take a slot, so a busy
// distiller or a harness looping fixture runs can never push real sessions out
// of the window. They are still returned — ingest() drops them in one place and
// reports how many (selfSkipped / testSkipped).
const takesNoSlot = (it) => isSelfCaptureItem(it) || isFixtureProject(it.project);
const newestReal = (items) => {
  let n = 0;
  return items.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    .filter((it) => takesNoSlot(it) || n++ < MAX_PER_TOOL);
};

// Context Codex replays as user messages ahead of the real prompt: the
// AGENTS.md instructions (`# AGENTS.md instructions [for <dir>]`, older builds
// `<user_instructions>`) — which include the global ~/.codex/AGENTS.md the brain
// writes its own digest into — and the environment/IDE context. None of it is a
// prompt. Left in, a distiller run started outside the self-run dir had the
// AGENTS.md block as its first "prompt", so the prompt signal missed it
// (selfcapture.mjs), and every session re-captured the brain's own digest.
const CODEX_INSTRUCTIONS_RE = /^# AGENTS\.md instructions\b|^<user_instructions>/;
const CODEX_CONTEXT_RE = /^<environment_context>|^# Context from my IDE/;

// ── Codex: ~/.codex/sessions/**/rollout-*.jsonl (+ archived_sessions) ──
function parseCodex() {
  const root = join(HOME, '.codex');
  const dirs = [join(root, 'sessions'), join(root, 'archived_sessions')];
  const files = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  dirs.forEach(walk);

  // Titles from session_index.jsonl (id -> thread_name)
  const titles = new Map();
  const idx = join(root, 'session_index.jsonl');
  if (existsSync(idx)) {
    for (const line of readFileSync(idx, 'utf8').trim().split('\n')) {
      try {
        const o = JSON.parse(line);
        if (o.id && o.thread_name) titles.set(o.id, o.thread_name);
      } catch {}
    }
  }

  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const out = [];
  let real = 0;
  for (const f of files) {
    if (real >= MAX_PER_TOOL) break; // counts real sessions only (see newestReal)
    try {
      const { meta, msgs } = readCodexFile(f);
      if (!meta) continue;
      const realUser = msgs.filter((m) => m.role === 'user' && !CODEX_CONTEXT_RE.test(m.text));
      const title = titles.get(meta.id) || clip((realUser[0]?.text || 'Codex session').replace(/\s+/g, ' '), 80);
      const transcript = msgs.map((m) => `${m.role}: ${m.text}`).join('\n\n');
      const ts = meta.timestamp || (msgs[0] && msgs[0].ts);
      const item = {
        sid: meta.id,
        project: meta.cwd ? basename(meta.cwd) : 'codex',
        cwd: meta.cwd || null,
        title,
        transcript: clip(transcript, TRANSCRIPT_CAP),
        size: transcript.length, // full, pre-clip — the growth signal (see ingest)
        ts,
        prompts: realUser.map((m) => m.text),
      };
      if (transcript.length > TRANSCRIPT_CAP) item.loadFull = () => fullFromMessages(readCodexFile(f).msgs);
      out.push(item);
      if (!takesNoSlot(item)) real++;
    } catch {}
  }
  return out;
}

function readCodexFile(f) {
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  let meta = null;
  const msgs = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'session_meta') meta = o.payload;
    else if (o.type === 'response_item' && o.payload?.type === 'message') {
      const role = o.payload.role;
      const text = (o.payload.content || []).map((c) => c.text || '').join(' ').trim();
      if (text && !(role === 'user' && CODEX_INSTRUCTIONS_RE.test(text))) msgs.push({ role, text, ts: o.timestamp });
    }
  }
  return { meta, msgs };
}

// ── Antigravity (agy) ────────────────────────────────────────────────────────
// agy has no capture hook, so we ingest post-hoc (on sync, and near-live via
// watch-agy). Two on-disk formats, both read:
//   • agy < 1.3: ~/.gemini/antigravity-cli/history.jsonl — the prompt log only.
//   • agy >= 1.3: one SQLite DB per conversation (conversations/<uuid>.db) with
//     the full trajectory as protobuf blobs; history.jsonl is no longer written.
// The same conversation id keys both, so a conversation present in both is the
// DB's (richer) item.
const agyDir = () => join(HOME, '.gemini', 'antigravity-cli');

// Legacy prompt log. Each line: { display (prompt), timestamp (ms epoch string),
// workspace, conversationId }. Grouped by conversationId; project from the workspace.
function agyHistoryItems() {
  const f = join(agyDir(), 'history.jsonl');
  if (!existsSync(f)) return [];
  let lines;
  try { lines = readFileSync(f, 'utf8').trim().split('\n'); } catch { return []; }
  const bySession = new Map();
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o.display) continue;
    const key = o.conversationId || 'ws:' + (o.workspace || 'unknown');
    if (!bySession.has(key)) bySession.set(key, { workspace: o.workspace, entries: [] });
    bySession.get(key).entries.push({ display: String(o.display), ms: Number(o.timestamp) || 0 });
  }
  const out = [];
  for (const [key, s] of bySession) {
    s.entries.sort((a, b) => a.ms - b.ms);
    const prompts = s.entries.map((e) => e.display);
    const ms = s.entries[0]?.ms || 0;
    out.push({
      sid: key,
      project: s.workspace ? basename(s.workspace) : 'antigravity',
      cwd: s.workspace || null,
      title: clip((prompts[0] || 'Antigravity session').replace(/\s+/g, ' '), 80),
      transcript: clip(prompts.map((p) => 'user: ' + p).join('\n\n'), TRANSCRIPT_CAP),
      size: prompts.map((p) => 'user: ' + p).join('\n\n').length,
      ts: ms ? new Date(ms).toISOString() : '',
      prompts,
    });
  }
  return out;
}

// agy >= 1.3 conversation DB layout (reverse-engineered from agy 1.3.0 by running
// known throwaway conversations and decoding them; field numbers, not names):
//   trajectory_meta(trajectory_id, cascade_id = the file's uuid, trajectory_type, source)
//   trajectory_metadata_blob('main') → { 1: {1: workspace file:// URI}, 2: created
//     Timestamp, 5: PARENT cascade id (subagent runs only), 6: root cascade id
//     (= own id for a top-level conversation), 7: workspace URI }
//   steps(idx, step_type, status, …, step_payload) — step_payload is the whole Step:
//     { 1: step_type, 4: status, 5: step metadata {1: created Timestamp, …}, <payload> }
//     14  USER_INPUT        payload 19 { 2: prompt text, 3: {1: prompt text}, 12: {12: workspace URI} }
//     15  PLANNER_RESPONSE  payload 20 { 1: reply text, 3: thinking (dropped), 7: tool calls
//                           [{1: call id, 2: tool name, 3: JSON args (dropped)}], 8: reply text }
//     101 system message, 132 tool execution: not conversation, skipped.
// conversation_summaries.db (sibling) has an agy-written title and
// parent_conversation_id per conversation; used when present, never required.
const AGY_USER = 14, AGY_REPLY = 15;
const agyUriToPath = (u) => {
  if (typeof u !== 'string' || !u) return null;
  if (!u.startsWith('file:')) return u.startsWith('/') ? u : null;
  try { return fileURLToPath(u); } catch { return null; }
};

// Read-only, and `immutable` so SQLite never creates -shm/-wal files or takes
// locks in agy's directory. (agy checkpoints on exit; a conversation still being
// written is re-read once its file changes again.)
function agyOpen(file) {
  return new DatabaseSync(pathToFileURL(file).href + '?mode=ro&immutable=1', { readOnly: true });
}

// conversation id → { title, parent } from conversation_summaries.db (empty Map if absent/unreadable).
function agySummaries() {
  const map = new Map();
  const f = join(agyDir(), 'conversation_summaries.db');
  if (!existsSync(f)) return map;
  let c;
  try {
    c = agyOpen(f);
    if (!tableExists(c, 'conversation_summaries')) return map;
    for (const r of c.prepare('SELECT conversation_id AS id, title, parent_conversation_id AS parent FROM conversation_summaries').all()) {
      map.set(String(r.id), { title: typeof r.title === 'string' ? r.title : '', parent: typeof r.parent === 'string' ? r.parent : '' });
    }
  } catch { /* unreadable summaries: titles fall back to the first prompt */ } finally { try { c?.close(); } catch {} }
  return map;
}

// One conversation DB → { id, cwd, startMs, parent, msgs } or null when unreadable.
export function readAgyConversation(file) {
  const id = basename(file, '.db');
  let c;
  try {
    c = agyOpen(file);
    if (!tableExists(c, 'steps')) return null;
    let cwd = null, startMs = 0, parent = '';
    if (tableExists(c, 'trajectory_metadata_blob')) {
      const row = c.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get()
        || c.prepare('SELECT data FROM trajectory_metadata_blob').get();
      const t = pbTry(row?.data);
      if (t) {
        cwd = agyUriToPath(pbStr(pbSub(t, 1), 1)) || agyUriToPath(pbStr(t, 7));
        startMs = pbTimeMs(t, 2);
        const root = pbStr(t, 6);
        parent = pbStr(t, 5) || (root && root !== id ? root : '');
      }
    }
    const msgs = [];
    for (const r of c.prepare('SELECT step_type AS type, step_payload AS p FROM steps ORDER BY idx').all()) {
      if (r.type !== AGY_USER && r.type !== AGY_REPLY) continue;
      const step = pbTry(r.p);
      if (!step) continue; // one corrupt step never loses the rest
      const ts = isoOf(pbTimeMs(pbSub(step, 5), 1));
      if (r.type === AGY_USER) {
        const u = pbSub(step, 19);
        const text = (pbStr(u, 2) || pbStr(pbSub(u, 3), 1)).trim();
        if (!cwd) cwd = agyUriToPath(pbStr(pbSub(u, 12), 12));
        if (text) msgs.push({ role: 'user', text, ts });
      } else {
        const a = pbSub(step, 20);
        const text = (pbStr(a, 1) || pbStr(a, 8)).trim();
        if (text) msgs.push({ role: 'assistant', text, ts });
        const tools = [...new Set(pbAll(a, 7).map((x) => pbStr(pbTry(x.v), 2)).filter(Boolean))];
        if (tools.length) msgs.push({ role: 'tool', text: tools.join(', '), ts });
      }
    }
    return { id, cwd, startMs, parent, msgs };
  } catch {
    return null; // corrupt / not a database / half-written: skip it this run
  } finally {
    try { c?.close(); } catch {}
  }
}

function agyConversationItems() {
  const dir = join(agyDir(), 'conversations');
  if (!existsSync(dir)) return [];
  let files;
  try {
    files = readdirSync(dir).filter((n) => n.endsWith('.db')).map((n) => {
      const f = join(dir, n);
      try { return { f, m: statSync(f).mtimeMs }; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
  files.sort((a, b) => b.m - a.m);
  const summaries = agySummaries();
  const out = [];
  let real = 0;
  for (const { f, m } of files) {
    if (real >= MAX_PER_TOOL) break; // counts real sessions only (see newestReal)
    const conv = readAgyConversation(f);
    if (!conv) continue;
    const sum = summaries.get(conv.id);
    // Subagent runs: their "prompts" are agy-written briefs, not the user's.
    if (conv.parent || sum?.parent) continue;
    const prompts = conv.msgs.filter((x) => x.role === 'user').map((x) => x.text);
    if (!prompts.length) continue;
    const full = conv.msgs.map((x) => `${x.role}: ${x.text}`).join('\n\n');
    const item = {
      sid: conv.id,
      project: conv.cwd ? basename(conv.cwd.replace(/\/+$/, '')) || 'antigravity' : 'antigravity',
      cwd: conv.cwd,
      title: clip(String(sum?.title || prompts[0]).replace(/\s+/g, ' '), 80),
      transcript: clip(full, TRANSCRIPT_CAP),
      size: full.length,
      ts: isoOf(conv.startMs) || conv.msgs.find((x) => x.ts)?.ts || isoOf(m),
      prompts,
    };
    if (full.length > TRANSCRIPT_CAP) item.loadFull = () => { const x = readAgyConversation(f); return x && fullFromMessages(x.msgs); };
    out.push(item);
    if (!takesNoSlot(item)) real++;
  }
  return out;
}

export function parseAntigravity() {
  let convs = [], legacy = [];
  try { convs = agyConversationItems(); } catch {}
  try { legacy = agyHistoryItems(); } catch {}
  const seen = new Set(convs.map((it) => it.sid));
  return newestReal(convs.concat(legacy.filter((it) => !seen.has(it.sid))));
}

// ── Cursor: ~/Library/Application Support/Cursor globalStorage state.vscdb ──
// (on Linux: ~/.config/Cursor/User/globalStorage/state.vscdb — same layout)
// Cursor stores AI chats in cursorDiskKV: composerData:<id> = a conversation,
// bubbleId:<id>:<bubbleId> = a message (type 1=user, 2=assistant). No capture hook,
// so we ingest post-hoc on sync — the user's prompts + a transcript, searchable.
//
// Project: globalStorage alone doesn't say which folder a conversation was in;
// cursorWorkspaces() recovers it from workspaceStorage (see there). A composer
// no workspace claims stays under 'cursor', the tool, as before.
export const CURSOR_PROJECT = 'cursor';

// A workspace URI / path → local-ish folder path, or null. Handles file:// URIs,
// remote URIs (vscode-remote://ssh-remote+host/home/u/proj → /home/u/proj) and
// plain paths. Never throws.
function cursorFolderPath(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    if (u.startsWith('file:')) return fileURLToPath(u);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return decodeURIComponent(new URL(u).pathname) || null;
  } catch { return null; }
  return u.startsWith('/') ? u : null;
}

// Folder path → project name: its basename, minus a multi-root workspace
// file's extension. null when nothing usable is left (e.g. "/").
function cursorProjectOf(folder) {
  if (!folder) return null;
  const name = basename(folder.replace(/\/+$/, '')).replace(/\.code-workspace$/i, '');
  return name || null;
}

// workspaceStorage/<id>/ holds one VS Code-style workspace: workspace.json
// ({ folder: "file:///…" } or, multi-root, { workspace: "file:///….code-workspace" })
// and its own state.vscdb, whose ItemTable row `composer.composerData` lists the
// composers that belong to it — `allComposers[].composerId` in older builds,
// `selectedComposerIds` / `lastFocusedComposerIds` after Cursor moved the full
// list to globalStorage. Read-only: every DB is opened readonly, nothing is
// written under Cursor's directories.
// Returns { byWorkspace: Map<workspaceId, folder>, byComposer: Map<composerId, folder> }.
export function cursorWorkspaces(root = appSupportDir('Cursor', 'User', 'workspaceStorage')) {
  const byWorkspace = new Map();
  const byComposer = new Map();
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return { byWorkspace, byComposer }; }
  const weak = new Map(); // from selected/lastFocused ids — only fill gaps allComposers leaves
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    let ws;
    try { ws = JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8')); } catch { continue; }
    const folder = cursorFolderPath(ws && (ws.folder || ws.workspace));
    if (!folder || !cursorProjectOf(folder)) continue;
    byWorkspace.set(d.name, folder);
    const vscdb = join(dir, 'state.vscdb');
    if (!existsSync(vscdb)) continue;
    let conn;
    try { conn = openDb(vscdb, { readonly: true }); } catch { continue; }
    try {
      if (!tableExists(conn, 'ItemTable')) continue;
      const row = conn.prepare(`SELECT value FROM ItemTable WHERE key = 'composer.composerData'`).get();
      const raw = row && (row.value instanceof Uint8Array ? Buffer.from(row.value).toString('utf8') : row.value);
      let cd; try { cd = JSON.parse(typeof raw === 'string' ? raw : 'null'); } catch { cd = null; }
      if (!cd || typeof cd !== 'object') continue;
      for (const c of Array.isArray(cd.allComposers) ? cd.allComposers : []) {
        const id = c && typeof c.composerId === 'string' ? c.composerId : null;
        if (id && !byComposer.has(id)) byComposer.set(id, folder);
      }
      for (const k of ['selectedComposerIds', 'lastFocusedComposerIds']) {
        for (const id of Array.isArray(cd[k]) ? cd[k] : []) {
          if (typeof id === 'string' && !weak.has(id)) weak.set(id, folder);
        }
      }
    } catch { /* unreadable workspace DB: its composers fall back */ } finally {
      try { conn.close(); } catch {}
    }
  }
  for (const [id, folder] of weak) if (!byComposer.has(id)) byComposer.set(id, folder);
  return { byWorkspace, byComposer };
}

// The folder a composer ran in, most direct evidence first:
//   1. composerData.workspaceIdentifier.uri — newer builds record the folder on
//      the conversation itself ({ id, uri: { fsPath, path, external } });
//   2. its workspaceIdentifier.id, or globalStorage's composerHeaders.workspaceId
//      (current builds) — a workspaceStorage dir name, resolved via workspace.json;
//   3. the workspace whose own state.vscdb lists the composer.
// Empty windows have a workspace id but no workspace.json → no folder → null.
function cursorComposerFolder(c, cid, ws, headerWorkspace) {
  const wi = c.workspaceIdentifier && typeof c.workspaceIdentifier === 'object' ? c.workspaceIdentifier : null;
  if (wi) {
    const uri = wi.uri;
    const own = typeof uri === 'string' ? cursorFolderPath(uri)
      : uri && typeof uri === 'object' ? cursorFolderPath(uri.fsPath) || cursorFolderPath(uri.path) || cursorFolderPath(uri.external)
      : null;
    if (own && cursorProjectOf(own)) return own;
  }
  for (const id of [wi && wi.id, headerWorkspace.get(cid)]) {
    if (typeof id === 'string' && ws.byWorkspace.has(id)) return ws.byWorkspace.get(id);
  }
  return ws.byComposer.get(cid) || null;
}

// globalStorage's composerHeaders table (current builds): composerId → workspaceId.
function cursorHeaderWorkspaces(conn) {
  const m = new Map();
  try {
    if (!tableExists(conn, 'composerHeaders')) return m;
    const cols = new Set(conn.prepare('PRAGMA table_info(composerHeaders)').all().map((c) => c.name));
    if (!cols.has('composerId') || !cols.has('workspaceId')) return m;
    for (const r of conn.prepare('SELECT composerId, workspaceId FROM composerHeaders WHERE workspaceId IS NOT NULL').all()) {
      if (typeof r.composerId === 'string' && typeof r.workspaceId === 'string') m.set(r.composerId, r.workspaceId);
    }
  } catch { /* older/odd build: no header mapping */ }
  return m;
}

export function parseCursor() {
  const db = appSupportDir('Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (!existsSync(db)) return [];
  let conn;
  try { conn = openDb(db, { readonly: true }); } catch { return []; }
  const out = [];
  let ws;
  try { ws = cursorWorkspaces(); } catch { ws = { byWorkspace: new Map(), byComposer: new Map() }; }
  const headerWorkspace = cursorHeaderWorkspaces(conn);
  try {
    const composers = conn.prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'`).all();
    const getBubbles = conn.prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE ?`);
    for (const row of composers) {
      let c; try { c = JSON.parse(row.value); } catch { continue; }
      if (!c || typeof c !== 'object') continue;
      const cid = c.composerId || row.key.slice('composerData:'.length);
      // Load this composer's bubbles into a map bubbleId -> {type,text}.
      const bubbleMap = new Map();
      for (const b of getBubbles.all(`bubbleId:${cid}:%`)) {
        let bj; try { bj = JSON.parse(b.value); } catch { continue; }
        if (!bj || typeof bj !== 'object') continue;
        const text = typeof bj.text === 'string' ? bj.text.trim() : '';
        if (text) bubbleMap.set(b.key, { type: bj.type, text });
      }
      // Order by the conversation headers if present, else by key order.
      const headers = Array.isArray(c.fullConversationHeadersOnly) ? c.fullConversationHeadersOnly : [];
      const ordered = headers.length
        ? headers.map((h) => bubbleMap.get(`bubbleId:${cid}:${h.bubbleId}`)).filter(Boolean)
        : [...bubbleMap.values()];
      if (!ordered.length) continue; // skip empty conversations
      const prompts = ordered.filter((b) => b.type === 1).map((b) => b.text);
      if (!prompts.length) continue; // no user turns → nothing searchable worth keeping
      const full = ordered.map((b) => (b.type === 1 ? 'user: ' : 'assistant: ') + b.text).join('\n\n');
      const transcript = clip(full, TRANSCRIPT_CAP);
      const ms = Number(c.createdAt) || 0;
      const folder = cursorComposerFolder(c, cid, ws, headerWorkspace);
      out.push({
        sid: cid,
        project: cursorProjectOf(folder) || CURSOR_PROJECT,
        cwd: folder,
        title: clip((c.name || prompts[0] || 'Cursor conversation').replace(/\s+/g, ' '), 80),
        transcript,
        size: full.length,
        ts: ms ? new Date(ms).toISOString() : '',
        prompts,
        ...(full.length > TRANSCRIPT_CAP ? { fullText: full } : {}),
      });
    }
  } finally {
    try { conn.close(); } catch {}
  }
  // Newest first, capped.
  return newestReal(out);
}

// ── Kilo Code (extension in VS Code / Cursor / forks, and the Kilo CLI) ─────────
// BETA: written from Kilo's open-source code, verified against NO live install.
// Sources (Kilo-Org/kilocode @ 974723450caa, main 2026-10-08; extension v7.8.8):
//   packages/core/src/global.ts, database/database.ts     <data>/kilo.db, data = $XDG_DATA_HOME|~/.local/share + /kilo
//   packages/core/src/session/sql.ts                      tables session / message / part (SQLite, drizzle)
//       session: id, project_id, parent_id, slug, directory, title, time_created/time_updated (epoch ms)
//       message: id, session_id, time_created, data JSON {role:'user'|'assistant', ...}
//       part:    id, message_id, session_id, data JSON {type:'text', text, synthetic?, ignored?} | {type:'tool', tool, state}
//       project: id, worktree
//   packages/schema/src/v1/session.ts                     TextPart / ToolPart / User / Assistant shapes
//   packages/kilo-docs/pages/code-with-ai/agents/session-history.md   documented DB path + the same
//       non-synthetic / non-ignored text-part query used below
//   packages/kilo-vscode/src/services/cli-backend/server-manager.ts   the extension runs the bundled `kilo serve` with the
//       same XDG dirs and KILO_DISABLE_CHANNEL_DB=true ⇒ extension and CLI share ONE kilo.db; a session row does not
//       record which client made it, so everything is source `kilo` (there is no separate `kilo_cli`).
//   packages/kilo-vscode/src/legacy-migration/{task-store.ts,sessions/*}   pre-v7 extension tasks:
//       <User>/globalStorage/kilocode.kilo-code/tasks/<id>/{api_conversation_history.json (Anthropic MessageParam[] + ts),
//       history_item.json {id,task,workspace,ts,mode}, ui_messages.json}, optional tasks/_index.json {entries:[history items]}.
//       The user-triggered v7 migration imports these INTO kilo.db with session.slug = the task id, so a legacy task whose
//       id is already a slug in kilo.db is skipped here (no double capture).
// Read-only: the DB is opened readonly and nothing under Kilo's directories is ever written.
// Not captured: child (sub-agent) sessions (parent_id set) — their prompts are Kilo-generated, not the user's;
// reasoning, synthetic/ignored text, tool inputs/outputs (tool NAMES only).
const KILO_SESSION_LIMIT = 2000; // newest sessions examined per run (the window below keeps MAX_PER_TOOL real ones)
const KILO_GENERIC_TITLE = /^(new session|child session)\b/i;

const isoOf = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : '');

function kiloOpen() {
  const f = kiloDbPath();
  if (!existsSync(f)) return null;
  try { return openDb(f, { readonly: true }); } catch { return null; }
}

// One kilo.db session → ordered messages [{role, text, ts}] (tool names as role 'tool').
function kiloSessionMsgs(conn, sid) {
  const rows = conn.prepare(
    `SELECT json_extract(m.data,'$.role') AS role, m.time_created AS mt, m.id AS mid,
            json_extract(p.data,'$.type') AS ptype, json_extract(p.data,'$.text') AS ptext,
            json_extract(p.data,'$.synthetic') AS syn, json_extract(p.data,'$.ignored') AS ign,
            json_extract(p.data,'$.tool') AS tool
       FROM message m JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ? AND json_valid(m.data) AND json_valid(p.data)
        AND json_extract(p.data,'$.type') IN ('text','tool')
      ORDER BY m.time_created, m.id, p.id`
  ).all(sid);
  const msgs = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const text = cur.texts.join('\n').trim();
    if (text && (cur.role === 'user' || cur.role === 'assistant')) msgs.push({ role: cur.role, text, ts: cur.ts });
    if (cur.role === 'assistant' && cur.tools.size) msgs.push({ role: 'tool', text: [...cur.tools].join(', '), ts: cur.ts });
  };
  for (const r of rows) {
    if (!cur || cur.mid !== r.mid) { flush(); cur = { mid: r.mid, role: r.role, ts: isoOf(r.mt), texts: [], tools: new Set() }; }
    if (r.ptype === 'text' && typeof r.ptext === 'string' && !r.syn && !r.ign && r.ptext.trim()) cur.texts.push(r.ptext.trim());
    else if (r.ptype === 'tool' && typeof r.tool === 'string' && r.tool) cur.tools.add(r.tool);
  }
  flush();
  return msgs;
}

function kiloItemFrom({ sid, project, cwd, title, ts, msgs, loadFull }) {
  const prompts = msgs.filter((m) => m.role === 'user').map((m) => m.text);
  if (!prompts.length) return null; // no user turns → nothing searchable worth keeping
  const full = msgs.map((m) => `${m.role}: ${m.text}`).join('\n\n');
  const t = title && !KILO_GENERIC_TITLE.test(title) ? title : prompts[0];
  const item = {
    sid,
    project: project || 'kilo',
    cwd: cwd || null,
    title: clip(String(t || 'Kilo session').replace(/\s+/g, ' '), 80),
    transcript: clip(full, TRANSCRIPT_CAP),
    size: full.length,
    ts: ts || msgs.find((m) => m.ts)?.ts || '',
    prompts,
  };
  if (full.length > TRANSCRIPT_CAP) item.loadFull = loadFull;
  return item;
}

// kilo.db → items (+ the set of session slugs, for legacy-task dedupe).
function kiloDbItems() {
  const out = [], slugs = new Set();
  const conn = kiloOpen();
  if (!conn) return { out, slugs };
  try {
    if (!tableExists(conn, 'session') || !tableExists(conn, 'message') || !tableExists(conn, 'part')) return { out, slugs };
    const cols = new Set(conn.prepare('PRAGMA table_info(session)').all().map((c) => c.name));
    const hasProject = tableExists(conn, 'project');
    if (cols.has('slug')) for (const r of conn.prepare('SELECT slug FROM session').all()) if (r.slug) slugs.add(String(r.slug));
    const sessions = conn.prepare(
      `SELECT s.id AS id, s.title AS title, s.directory AS directory, s.time_created AS tc${hasProject ? ', p.worktree AS worktree' : ", NULL AS worktree"}
         FROM session s ${hasProject ? 'LEFT JOIN project p ON p.id = s.project_id' : ''}
        ${cols.has('parent_id') ? 'WHERE s.parent_id IS NULL' : ''}
        ORDER BY s.time_updated DESC LIMIT ?`
    ).all(KILO_SESSION_LIMIT);
    let real = 0;
    for (const s of sessions) {
      if (real >= MAX_PER_TOOL) break; // counts real sessions only (see newestReal)
      try {
        const msgs = kiloSessionMsgs(conn, s.id);
        const root = typeof s.worktree === 'string' && s.worktree.startsWith('/') && s.worktree !== '/' ? s.worktree : s.directory;
        const item = kiloItemFrom({
          sid: s.id,
          project: root ? basename(String(root).replace(/\/+$/, '')) : null,
          cwd: s.directory || null,
          title: s.title,
          ts: isoOf(s.tc),
          msgs,
          loadFull: () => {
            const c = kiloOpen();
            if (!c) return null;
            try { return fullFromMessages(kiloSessionMsgs(c, s.id)); } finally { try { c.close(); } catch {} }
          },
        });
        if (!item) continue;
        out.push(item);
        if (!takesNoSlot(item)) real++;
      } catch { /* one unreadable session must never stop the sweep */ }
    }
  } catch { /* corrupt / not-a-database / mid-migration: capture nothing this run, never throw */ } finally {
    try { conn.close(); } catch {}
  }
  return { out, slugs };
}

// Pre-v7 tasks: Anthropic MessageParam[] with Roo/Cline prompt scaffolding around the real text.
const KILO_ENV_RE = /<environment_details>[\s\S]*?<\/environment_details>/gi;
const KILO_TOOL_RESULT_RE = /^\[[^\]\n]{1,200}\] Result:/;
function kiloLegacyMsgs(arr) {
  const msgs = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object' || (e.role !== 'user' && e.role !== 'assistant')) continue;
    const blocks = typeof e.content === 'string' ? [{ type: 'text', text: e.content }] : Array.isArray(e.content) ? e.content : [];
    const texts = [], tools = new Set();
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && typeof b.name === 'string') { if (e.role === 'assistant') tools.add(b.name); continue; }
      if (b.type !== 'text' || typeof b.text !== 'string') continue;
      let t = b.text;
      if (e.role === 'user') {
        t = t.replace(KILO_ENV_RE, '');
        const task = /<task>([\s\S]*?)<\/task>/i.exec(t);
        if (task) t = task[1];
        if (KILO_TOOL_RESULT_RE.test(t.trim())) continue; // a tool result echoed as a user turn, not a prompt
      }
      t = t.trim();
      if (t) texts.push(t);
    }
    const ts = isoOf(e.ts);
    const text = texts.join('\n').trim();
    if (text) msgs.push({ role: e.role, text, ts });
    if (tools.size) msgs.push({ role: 'tool', text: [...tools].join(', '), ts });
  }
  return msgs;
}

function kiloLegacyItems(slugs) {
  const files = [];
  for (const tasks of kiloLegacyTaskDirs()) {
    let idx = new Map();
    try {
      const j = JSON.parse(readFileSync(join(tasks, '_index.json'), 'utf8'));
      for (const h of Array.isArray(j?.entries) ? j.entries : []) if (h && typeof h.id === 'string') idx.set(h.id, h);
    } catch {}
    let ents;
    try { ents = readdirSync(tasks, { withFileTypes: true }); } catch { continue; }
    for (const d of ents) {
      if (!d.isDirectory() || slugs.has(d.name)) continue;
      const api = join(tasks, d.name, 'api_conversation_history.json');
      let mtime;
      try { mtime = statSync(api).mtimeMs; } catch { continue; } // ui-only / empty task folder
      files.push({ id: d.name, dir: join(tasks, d.name), api, mtime, hist: idx.get(d.name) });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out = [], seen = new Set();
  let real = 0;
  for (const f of files) {
    if (real >= MAX_PER_TOOL) break;
    if (seen.has(f.id)) continue;
    try {
      const read = () => { const j = JSON.parse(readFileSync(f.api, 'utf8')); return Array.isArray(j) ? kiloLegacyMsgs(j) : []; };
      const msgs = read();
      let hist = f.hist;
      try { const h = JSON.parse(readFileSync(join(f.dir, 'history_item.json'), 'utf8')); if (h && typeof h === 'object') hist = h; } catch {}
      const ws = typeof hist?.workspace === 'string' ? hist.workspace.trim() : '';
      const item = kiloItemFrom({
        sid: f.id,
        project: ws ? basename(ws.replace(/\/+$/, '')) : null,
        cwd: ws || null,
        title: typeof hist?.task === 'string' ? hist.task : '',
        ts: isoOf(hist?.ts) || msgs.find((m) => m.ts)?.ts || isoOf(f.mtime),
        msgs,
        loadFull: () => fullFromMessages(read()),
      });
      if (!item) continue; // empty / prompt-less / corrupt-as-array task
      seen.add(f.id);
      out.push(item);
      if (!takesNoSlot(item)) real++;
    } catch { /* corrupt JSON: skip this task folder */ }
  }
  return out;
}

export function parseKilo() {
  const { out, slugs } = kiloDbItems();
  let legacy = [];
  try { legacy = kiloLegacyItems(slugs); } catch {}
  return newestReal(out.concat(legacy));
}

// P4 (docs/specs/secret-scrubber.md §5.3): scrub title/transcript/prompts BEFORE
// they ever reach hash(it.transcript) below — scrubbing after hashing would change
// the text without changing content_hash and desync the dedup index. Wrapping the
// parser map here (rather than each parser individually) means all four ingest
// sources share one scrub choke point and can't regress independently.
// ── Claude Code: ~/.claude*/projects/<slug>/<sessionId>.jsonl ──
// Claude Code writes a complete transcript per session, one JSON object per line.
// Capturing from those files rather than from hooks means a capture failure can
// never break a live session — the worst case is that a transcript is read late.
//
// Runs alongside claude-mem without double-counting: the filename UUID IS
// claude-mem's `content_session_id` (verified), so the existing
// UNIQUE(platform_source, content_session_id) index makes re-ingest a no-op.
// claude-mem still produces the richer Haiku-distilled observations; this
// guarantees the raw session exists even when claude-mem is absent or broken.
//
// Record shapes (verified across real transcripts): every line has `type`;
// `user` and `assistant` lines carry `message.role` and `message.content`, which
// is a plain string for user turns and an array of typed parts for assistant
// turns. Non-conversational line types (mode, permission-mode, bridge-session,
// file-history-*, queue-operation, attachment, ai-title, last-prompt) are skipped.
export function parseClaude() {
  const roots = ['.claude', '.claude-work', '.claude-personal']
    .map((d) => join(HOME, d, 'projects'))
    .filter((d) => existsSync(d));
  const files = [];
  for (const root of roots) {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      // The brain's own headless runs (selfcapture.mjs) — skipped before the
      // newest-N window below so they can never crowd real sessions out of it.
      if (isSelfRunProjectDir(e.name)) continue;
      const dir = join(root, e.name);
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const f of entries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) files.push(join(dir, f.name));
      }
    }
  }
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  const out = [];
  let real = 0;
  for (const f of files) {
    // Counts real sessions only: a self-run started outside the self-run dir
    // (the HOME fallback) never takes a slot (see newestReal).
    if (real >= MAX_PER_TOOL) break;
    try {
      const r = readClaudeFile(f);
      if (!r) continue;
      const { msgs, sid, cwd, ts } = r;
      // Command output and IDE context are replayed as user turns; they are not prompts.
      const prompts = msgs
        .filter((m) => m.role === 'user' && !/^<(command-|environment_context|local-command)/.test(m.text))
        .map((m) => m.text);
      const title = clip((prompts[0] || 'Claude Code session').replace(/\s+/g, ' '), 80);
      const full = msgs.map((m) => `${m.role}: ${m.text}`).join('\n\n');
      const item = {
        sid,
        project: cwd ? basename(cwd) : 'claude',
        cwd,
        title,
        transcript: clip(full, TRANSCRIPT_CAP),
        size: full.length,
        ts,
        prompts,
      };
      if (full.length > TRANSCRIPT_CAP) item.loadFull = () => { const x = readClaudeFile(f); return x && fullFromMessages(x.msgs); };
      out.push(item);
      if (!takesNoSlot(item)) real++;
    } catch { /* a single unreadable transcript must never stop the sweep */ }
  }
  return out;
}

const claudeTextOf = (content) => {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  // Assistant content is typed parts; keep prose, drop thinking/tool traffic.
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join(' ')
    .trim();
};

// One Claude Code transcript → its conversational messages (with timestamps).
function readClaudeFile(f) {
  const raw = readFileSync(f, 'utf8').trim();
  if (!raw) return null;
  const msgs = [];
  let sid = basename(f, '.jsonl');
  let cwd = null, ts = null;
  for (const line of raw.split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; } // partial final line while Claude Code is writing
    if (o.cwd && !cwd) cwd = o.cwd;
    if (o.timestamp && !ts) ts = o.timestamp;
    if (o.sessionId) sid = o.sessionId;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const m = o.message;
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = claudeTextOf(m.content);
    if (text) msgs.push({ role: m.role, text, ts: o.timestamp });
  }
  return msgs.length ? { msgs, sid, cwd, ts } : null;
}

// ── Sessions that keep growing after their first capture ──────────────────────
// ingest runs on a timer, so it routinely meets a session while it is still in
// flight: the raw row then holds the first prompt or two. Each captured session
// gets a bookmark in capture_state under 'ingest:<memory_session_id>' (real
// transcript paths start with '/', the distiller's keys with 'distill:', so the
// namespaces never collide): bytes = the length of the FULL (pre-clip)
// transcript last seen.
//
// Automatic ingest only ever affects NEW data, and it never destroys what an
// existing row already holds. When a bookmarked session grows (pure append: the
// row's stored text is a strict prefix of the new transcript, so nothing is lost)
// the growth is captured by following the transcript with the row's RAW `text`
// (and, for a plain raw row, its title/narrative/hash):
//   - a plain raw row this module wrote: refreshed and handed back to the
//     distiller ('refreshed');
//   - a row the brain's distiller already upgraded ('brain/…'): only `text` (the
//     raw transcript it keeps for audit/search) follows the transcript. The
//     distillation — title, facts, narrative, provenance, hash — is not touched
//     and the row is NOT re-queued, so it is never overwritten behind the
//     operator's back. A 'regrown:<id>' marker in capture_state records that its
//     distillation is now older than its text, so `brain recapture` can offer a
//     fresh distillation ('refreshedKept');
//   - a row a person edited in the panel (curate.mjs stamps metadata.edited_at):
//     only `text` follows; the edit is kept, not re-queued ('refreshedKept');
//   - a raw row `brain clean --dupes` hid as a copy of another row: its text
//     follows, it stays hidden, not re-queued ('refreshedKept'); `brain
//     recapture` can bring it back into view now that it is no longer a copy;
//   - a raw row other rows were hidden as copies of: refreshed like any raw row;
//     its copies stay hidden until `brain recapture` re-checks them.
// Never changed: statuses, the hidden/visible state of any row, relevance counts.
//
// Only counted (`grownHeld`), nothing written: a row deleted in the panel, and
// growth that is not a pure append (a parser/scrubber change, or shrinking).
// The lifecycle side of growth (un-hiding a copy that grew into its own memory,
// re-checking copies, a fresh distillation) and the rewrite of the stored row
// itself change only through the opt-in `brain recapture` (recapture.mjs):
// dry-run by default, --apply behind a verified backup, every old value
// journalled so --undo puts it back.
//
// A session seen for the first time with no bookmark (captured before this
// existed) only gets its baseline recorded: the first ingest after an upgrade
// rewrites nothing. A row such a session left behind that has fallen behind its
// transcript is found by `brain recapture`.
//
// Rows claude-mem (or anything else) wrote are never touched: they live under
// claude-mem's own memory_session_id, and a session claude-mem already covered
// has no capture row here to refresh. The refresh is compare-and-set (the UPDATE
// matches the `text` and provenance just read; on a miss the bookmark does not
// move, so the next run retries), and the distiller re-checks `text` before it
// writes (distiller.mjs writeDistilled), so a distillation of the old transcript
// is never pinned to the new one.
export const INGEST_STATE_PREFIX = 'ingest:';
export const ingestStateKey = (memorySessionId) => INGEST_STATE_PREFIX + memorySessionId;
// 'regrown:<memory_session_id>': a distilled row whose text grew after it was
// distilled (mtime = when). Stale while it is newer than the 'distill:' state's
// mtime — which a re-distillation (or a recapture re-queue) always moves.
export const REGROWN_STATE_PREFIX = 'regrown:';
export const regrownStateKey = (memorySessionId) => REGROWN_STATE_PREFIX + memorySessionId;

// Dedupe at capture (dedupe.mjs): a NEW session whose transcript a live row of
// the same project already holds — the raw capture of another session, or the
// source a distilled row keeps in `text` — is the same memory captured twice.
// No second row is written; the held row gets +1 relevance. The session's
// bookmark is set to SKIPPED_DUPLICATE so a session that was only identical
// while in flight is still captured once it grows into something of its own.
export const SKIPPED_DUPLICATE = 'duplicate';

function rawDuplicateFinder(db) {
  const q = db.prepare(
    `SELECT o.id FROM observations o
      WHERE o.project = ? AND o.text = ?
        AND (o.type = 'session' OR o.generated_by_model LIKE '${PROVENANCE_PREFIX}%')${liveOnly(db)}
      ORDER BY o.id LIMIT 1`
  );
  return (project, transcript) => (transcript ? q.get(project, transcript)?.id ?? null : null);
}

function growthTracker(db, { findDup = () => null, insertRaw = () => 0 } = {}) {
  if (!tableExists(db, 'capture_state') || !tableExists(db, 'observations')) return null;
  const cols = new Set(db.prepare('PRAGMA table_info(observations)').all().map((c) => c.name));
  const getState = db.prepare('SELECT bytes, status FROM capture_state WHERE transcript_path = ?');
  const setStatus = db.prepare('UPDATE capture_state SET status = ? WHERE transcript_path = ?');
  const setState = db.prepare(
    `INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status)
     VALUES (?,?,?,?,'captured')
     ON CONFLICT(transcript_path) DO UPDATE SET mtime = excluded.mtime, bytes = excluded.bytes`
  );
  // The session's capture row: the distiller's upgrade of it first (it upgrades
  // in place, so there is at most one), else the raw row this module wrote.
  const findRow = db.prepare(
    `SELECT id, text, generated_by_model AS gbm${cols.has('status') ? ', status' : ', NULL AS status'}${cols.has('metadata') ? ', metadata' : ', NULL AS metadata'}
       FROM observations
      WHERE memory_session_id = ?
        AND ((type = 'session' AND COALESCE(generated_by_model, ?) = ?)
             OR generated_by_model LIKE '${PROVENANCE_PREFIX}%')
      ORDER BY (generated_by_model LIKE '${PROVENANCE_PREFIX}%') DESC, id
      LIMIT 1`
  );
  // Compare-and-set on what findRow just read (see above).
  const SAME = `id = ? AND COALESCE(text, '') = ? AND COALESCE(generated_by_model, '') = ?`;
  const updRaw = db.prepare(`UPDATE observations SET text = ?, narrative = ?, title = ?, content_hash = ? WHERE ${SAME}`);
  const updText = db.prepare(`UPDATE observations SET text = ? WHERE ${SAME}`);
  const markRegrown = db.prepare(
    `INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status)
     VALUES (?,?,0,?,'regrown')
     ON CONFLICT(transcript_path) DO UPDATE SET mtime = excluded.mtime, status = 'regrown'`
  );
  const markPending = db.prepare(
    `INSERT INTO capture_state (transcript_path, mtime, bytes, session_id, status)
     VALUES (?,?,0,?,'pending')
     ON CONFLICT(transcript_path) DO UPDATE SET mtime = excluded.mtime, bytes = 0, status = 'pending'`
  );

  // Is any row hidden as a copy of this one? (Informational: they stay hidden.)
  // true: the raw capture row was refreshed and re-queued.
  // 'kept': the row's raw text followed the transcript, but its distillation,
  //   edit or hidden state was kept as it is (not re-queued).
  // false: nothing changed. null: the row changed under us — retry next run.
  // Growth that is not applied (deleted row, not a pure append) is held.n.
  const held = { n: 0 };
  const refresh = (mem, tool, it) => {
    const row = findRow.get(mem, tool, tool);
    if (!row) return false;
    if (row.status === 'deleted') { held.n++; return false; }
    const text = row.text || '';
    if (text === it.transcript) return false; // clipped text unchanged — nothing to redo
    // Only pure append growth is ever applied: the old text survives inside the new.
    if (!(it.transcript.length > text.length && it.transcript.startsWith(text))) { held.n++; return false; }
    const distilled = (row.gbm || '').startsWith(PROVENANCE_PREFIX);
    const edited = isEdited(row.metadata);
    const hidden = row.status === DUPLICATE;
    let res;
    try {
      if (distilled || edited) res = updText.run(it.transcript, row.id, text, row.gbm || '');
      else res = updRaw.run(it.transcript, it.transcript, it.title, hash(it.transcript), row.id, text, row.gbm || '');
    } catch { return false; } // ux_observations_session_hash: leave the row as it is
    if (res.changes !== 1) return null;
    if (distilled && !edited) markRegrown.run(regrownStateKey(mem), Date.now(), mem);
    if (distilled || edited || hidden) return 'kept';
    markPending.run(distillStateKey(mem), Date.now(), mem);
    return true;
  };

  // Called once per ingested item, after its session/raw-row inserts.
  // → true: the capture row was refreshed; 'captured': a session skipped as a
  // duplicate grew into its own memory and got its raw row now; false: nothing.
  const track = (mem, tool, it, isNewSession, skippedDuplicate = false) => {
    const key = ingestStateKey(mem);
    const size = Number.isFinite(it.size) ? it.size : it.transcript.length;
    const st = getState.get(key);
    let refreshed = false;
    if (!isNewSession && st && st.status === SKIPPED_DUPLICATE) {
      if (size <= (st.bytes || 0)) return false;
      let captured = false;
      if (!findDup(it.project, it.transcript) && insertRaw(mem, tool, it)) {
        setStatus.run('captured', key);
        captured = true;
      }
      setState.run(key, Date.now(), size, mem);
      return captured ? 'captured' : false;
    }
    if (!isNewSession) {
      // No bookmark: a session captured before bookmarks existed. First sight
      // only records the baseline — rewriting rows that were already in the store
      // is `brain recapture`'s job (journalled, behind a backup), never a side
      // effect of the first ingest after an upgrade.
      if (!st) { /* baseline only */ }
      else if (size > (st.bytes || 0)) {
        refreshed = refresh(mem, tool, it);
        if (refreshed === null) return false; // raced another writer: keep the bookmark, retry next run
      } else return false; // same or shorter: bookmark stays at the high-water mark
    }
    setState.run(key, Date.now(), size, mem);
    if (isNewSession && skippedDuplicate) setStatus.run(SKIPPED_DUPLICATE, key);
    return refreshed;
  };
  track.held = held; // grown sessions left as captured this run (see header)
  return track;
}

// Cursor sessions captured before parseCursor knew their folder sit under the
// placeholder project 'cursor'. Ingest does NOT relabel them: a session seen for
// the first time is stored under its real project, and an existing one is left
// as it is. This only counts the existing placeholder sessions whose folder is
// now known, so the log can point at `brain clean --cursor-projects` (opt-in,
// dry-run first, journalled — recapture.mjs), which does the relabelling.
function cursorUnfiledCounter(db) {
  const q = db.prepare(`SELECT 1 FROM sdk_sessions WHERE memory_session_id = ? AND project = ?`);
  return (mem, project) => !!project && project !== CURSOR_PROJECT && !!q.get(mem, CURSOR_PROJECT);
}

/** The parsed, scrubbed sessions of one tool — what ingest would store. Read-only
 *  (recapture.mjs plans against it). */
export function parsedItems(tool) {
  if (!PARSERS[tool]) throw new Error(`no parser for ${tool}`);
  return PARSERS[tool]();
}

const RAW_PARSERS = { claude: parseClaude, codex: parseCodex, antigravity: parseAntigravity, cursor: parseCursor, kilo: parseKilo };
const PARSERS = Object.fromEntries(
  Object.entries(RAW_PARSERS).map(([tool, fn]) => [tool, () => fn().map(scrubItem)])
);

// `cutoff` (epoch ms): skip sessions that started before it. Set when the user
// chose at install to start fresh instead of with their past sessions
// (pastsessions.mjs); 0 captures everything.
export async function ingest({ log = () => {}, only = null, cutoff = captureCutoff() } = {}) {
  // A brand-new user has no memory DB at all. Create the native store rather
  // than throwing: otherwise capture fails on every run and the user records
  // nothing, with nothing telling them. This is the whole reason the project
  // stopped depending on claude-mem owning the database.
  if (!existsSync(MEMORY_DB)) {
    const { openStore } = await import('./store.mjs');
    try { openStore({ path: MEMORY_DB }).close(); log(`  created memory store → ${MEMORY_DB}`); }
    catch (e) { throw new Error(`No memory store and could not create one at ${MEMORY_DB}: ${e.message}`); }
  }
  // detect.mjs ids the three Claude Code profiles separately (claude_code /
  // claude_work / claude_personal); parseClaude reads all of their transcript
  // dirs in one pass, so map any of them to the single `claude` parser.
  const detected = effectiveLinked(config);
  const ids = new Set(detected);
  if (detected.some((id) => id.startsWith('claude_') && id !== 'claude_mem' && id !== 'claude_desktop' && id !== 'claude_vscode')) {
    ids.add('claude');
  }
  const linked = [...ids].filter((id) => PARSERS[id] && (!only || only.includes(id)));
  if (!linked.length) {
    log('  no linked tools with a parser — skipping ingest');
    return {};
  }
  const db = openDb(MEMORY_DB);
  isFixtureProject = captureSkipper(readCleanedProjects(db));
  const insSession = db.prepare(
    `INSERT OR IGNORE INTO sdk_sessions
     (content_session_id, memory_session_id, project, platform_source, user_prompt,
      started_at, started_at_epoch, completed_at, completed_at_epoch, status)
     VALUES (?,?,?,?,?,?,?,?,?,'completed')`
  );
  const insObs = db.prepare(
    `INSERT OR IGNORE INTO observations
     (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
      prompt_number, created_at, created_at_epoch, content_hash, generated_by_model)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const findDup = rawDuplicateFinder(db);
  // The one raw capture row for a session nothing else covered.
  const insertRaw = (mem, tool, it) => {
    const epoch = epochOf(it.ts);
    const iso = it.ts || new Date(epoch || 0).toISOString();
    const concepts = JSON.stringify(['imported', tool]);
    return insObs.run(
      mem, it.project, it.transcript, 'session', it.title, `via ${tool}`,
      '[]', it.transcript, concepts, 0, iso, epoch, hash(it.transcript), tool
    ).changes;
  };
  const track = growthTracker(db, { findDup, insertRaw });
  // Full transcripts of sessions longer than the row's clip (segments.mjs): one
  // gzip row per session, rewritten only when the session's size changed. This is
  // new data beside the capture row — no existing row is touched. A session
  // skipped as a duplicate has no capture row to distil, so none is stored.
  let fullTable = false;
  try { ensureTranscriptTable(db); fullTable = true; } catch { /* read-only / odd store: capture continues without it */ }
  const bookmark = db.prepare('SELECT status FROM capture_state WHERE transcript_path = ?');
  const storeFull = (mem, it, skippedDuplicate) => {
    if (!fullTable || !(it.loadFull || it.fullText) || skippedDuplicate) return 0;
    if (bookmark.get(ingestStateKey(mem))?.status === SKIPPED_DUPLICATE) return 0;
    const have = transcriptMeta(db, mem);
    if (have && have.size === it.size) return 0;
    try {
      const f = it.loadFull ? it.loadFull() : { text: scrubText(it.fullText).text, marks: null, size: it.size };
      if (!f || !f.text) return 0;
      saveTranscript(db, mem, { text: f.text, marks: f.marks, size: f.size });
      return 1;
    } catch { return 0; } // never let a side-table failure cost the capture
  };
  const cursorUnfiled = cursorUnfiledCounter(db);
  const insPrompt = db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
     SELECT ?,?,?,?,? WHERE NOT EXISTS
       (SELECT 1 FROM user_prompts WHERE content_session_id=? AND prompt_number=?)`
  );

  const result = {};
  for (const tool of linked) {
    let sessions = 0, observations = 0, prompts = 0, fullStored = 0, refreshed = 0, refreshedKept = 0, unfiled = 0, duplicates = 0;
    const heldBefore = track ? track.held.n : 0;
    let items = [];
    try { items = PARSERS[tool](); } catch (e) { log(`  ${tool} parse error: ${e.message}`); }
    // The brain's own headless runs (distiller, learning drafts, explain) are
    // not the user's work — capturing them is the self-capture loop. Dropped
    // here, once, for every parser (selfcapture.mjs has both signals).
    const found = items.length;
    items = items.filter((it) => !isSelfCaptureItem(it));
    const selfSkipped = found - items.length;
    // Test-fixture runs (testdata.mjs: e2e probes, run-context fixtures, and
    // any project `brain clean --test-data --apply` removed) are some harness's
    // throwaway sessions, not the user's work. Bare-UUID dirs are clean-only:
    // captured until the operator removes them by name.
    const before = items.length;
    items = items.filter((it) => !isFixtureProject(it.project));
    const testSkipped = before - items.length;
    const beforeCutoff = items.length;
    if (cutoff) items = items.filter((it) => epochOf(it.ts) >= cutoff);
    const pastSkipped = beforeCutoff - items.length;
    db.exec('BEGIN');
    try {
      for (const it of items) {
        const mem = `${tool}:${it.sid}`;
        const epoch = epochOf(it.ts);
        const iso = it.ts || new Date(epoch || 0).toISOString();
        const isNewSession = insSession.run(
          it.sid, mem, it.project, tool, clip(it.title, 200), iso, epoch, iso, epoch
        ).changes;
        sessions += isNewSession;
        if (!isNewSession && tool === 'cursor' && cursorUnfiled(mem, it.project)) unfiled++;
        // SAFETY NET, NOT A SECOND OPINION. When the session is already known —
        // e.g. claude-mem has distilled it into several rich observations — do
        // not also store the raw transcript. A single large raw blob matches many
        // terms and would dilute BM25 against the well-distilled rows for the very
        // same session. Only sessions nothing else covered get a raw observation,
        // which is exactly the gap this parser exists to fill.
        let skippedDuplicate = false;
        if (isNewSession) {
          const held = findDup(it.project, it.transcript);
          if (held != null) {
            bumpRelevance(db, held);
            duplicates++;
            skippedDuplicate = true;
          } else {
            observations += insertRaw(mem, tool, it);
          }
        }
        if (track) {
          const tr = track(mem, tool, it, isNewSession, skippedDuplicate);
          if (tr === 'captured') observations++;
          else if (tr === 'kept') refreshedKept++;
          else if (tr) refreshed++;
        }
        fullStored += storeFull(mem, it, skippedDuplicate);
        it.prompts.forEach((p, i) => {
          prompts += insPrompt.run(it.sid, i, clip(p, 4000), iso, epoch, it.sid, i).changes;
        });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      log(`  ${tool} ingest failed: ${e.message}`);
    }
    const grownHeld = track ? track.held.n - heldBefore : 0;
    result[tool] = { sessions, observations, prompts, fullStored, refreshed, refreshedKept, grownHeld, duplicates, found, selfSkipped, testSkipped, pastSkipped };
    if (tool === 'cursor') result[tool].unfiled = unfiled;
    log(`  ${tool}: +${sessions} sessions, +${observations} observations, +${prompts} prompts` +
      (fullStored ? `, ${fullStored} full transcript(s) stored for segmented distillation` : '') +
      (refreshed ? `, ${refreshed} grown sessions refreshed` : '') +
      (duplicates ? `, ${duplicates} already held (same transcript) — not stored twice` : '') +
      (refreshedKept ? `, ${refreshedKept} grown session(s) had only their raw text refreshed (distillation, edit or hidden state kept) — 'brain recapture' can re-distill them` : '') +
      (grownHeld ? `, ${grownHeld} grown session(s) not captured (row deleted, or the transcript changed rather than grew)` : '') +
      (unfiled ? `, ${unfiled} existing 'cursor' session(s) could be filed under their project — 'brain clean --cursor-projects'` : '') + ` (of ${found} found` +
      (selfSkipped ? `, ${selfSkipped} own runs skipped` : '') +
      (testSkipped ? `, ${testSkipped} test-fixture runs skipped` : '') +
      (pastSkipped ? `, ${pastSkipped} from before you started fresh skipped` : '') + ')');
  }
  db.close();
  return result;
}
