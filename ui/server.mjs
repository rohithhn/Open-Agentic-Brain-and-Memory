// Agentic Brain — localhost control panel server. Binds to 127.0.0.1 only.
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname, basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, REPO_MANIFEST, MEMORY_DB, NATIVE_DB_PATH, NATIVE_READY, CLAUDE_MEM_DB, REPO_SKILLS, REPO_ROOT, REPO_WIKI, SHARED_DIR } from '../bin/lib/paths.mjs';
import { brainHealthSection, bridgeHomeSection, loadRegistry, toolRows, serverProbe } from '../bin/lib/doctor.mjs';
import { serverPath } from '../bin/lib/bridgehome.mjs';
import { detectAll } from '../bin/lib/detect.mjs';
import { ingest } from '../bin/lib/ingest.mjs';
import { home, memorySignals } from '../bin/lib/home.mjs';
import { runAgent, agentRoles, availableTools } from '../bin/lib/agent.mjs';
import { saveLearning, listLearnings, readLearning, readDraft, recordFeedback, listDrafts, approveDraft, dismissDraft } from '../bin/lib/learn.mjs';
import { dream, lint, listWiki, listWikiMeta, readWiki, fileNote } from '../bin/lib/dream.mjs';
import { injectContext } from '../bin/lib/inject.mjs';
import { enableClaudeMemEverywhere } from '../bin/lib/profiles.mjs';
import { writeFileSync } from 'node:fs';
import { secretStatus, setSecret, deleteSecret, SECRET_KEYS, getSecret } from '../bin/lib/keychain.mjs';
import { generateAndStoreKey, importIdentity } from '../bin/lib/crypto.mjs';
import { skillCounts, pushSkills } from '../bin/lib/assets.mjs';
import { REPO_EXTERNAL, pushExternalSkills } from '../bin/lib/external-skills.mjs';
import { projectMap } from '../bin/lib/context.mjs';
import { remoteUrl } from '../bin/lib/git.mjs';
import { openDb, count } from '../bin/lib/db.mjs';
import { buildGraph, searchGraphConcepts } from '../bin/lib/graph.mjs';
import { doSync, doRestore, doMerge } from '../bin/brain.mjs';
import { runEval, writeReport, lastEval } from '../bin/lib/eval.mjs';
import { computeSavings } from '../bin/lib/economics.mjs';
import { liveOnly, hasLifecycle, hasPins, isForeignStore, DELETED } from '../bin/lib/lifecycle.mjs';
import { openForCuration, getMemory, editMemory, deleteMemory, restoreMemory, pinMemory, rowId } from '../bin/lib/curate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { host } = config.ui;
const port = Number(process.env.BRAIN_UI_PORT) || config.ui.port; // env override: tests run a throwaway server

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// ── localhost write guard (every request that changes anything) ─────────
// Binding to 127.0.0.1 keeps other machines out, but not a web page open in
// this machine's browser: it can still fire a <form> post or a no-cors fetch
// at the panel (CSRF), or rebind its own DNS name to 127.0.0.1 and talk to it
// "same-origin". So, before any route runs:
//   every request  — a loopback peer and a Host header naming this panel
//                    (127.0.0.1 / localhost / [::1] on this port: defeats DNS
//                    rebinding, which would otherwise let a page READ memory);
//   every write    — (any method but GET/HEAD/OPTIONS, plus the state-changing
//                    GETs below) and, when a browser sends them, an Origin
//                    that is this panel and a same-origin Sec-Fetch-Site; and
//                    a JSON content type, which a cross-site <form> cannot set
//                    and a fetch() cannot send cross-origin without a CORS
//                    preflight this server never grants. The body is then
//                    read once, capped and strictly parsed, and handed to the
//                    route — there is no other body reader, so a new write
//                    route gets the whole guard without asking for it.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_JSON_BODY = 64 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// GETs that do work anyway, so a cross-site page must not be able to fire them
// (even though it could not read the response): the SSE skill sync runs
// `brain skills --all` (EventSource can only GET), and the two skill exports
// spawn the archiver (they are plain navigations, which the browser owns as a
// download). Guarded like a write, minus the content type (neither an
// EventSource nor a navigation can set one, and neither sends a body). A
// cross-site navigation carries Sec-Fetch-Site: cross-site and is refused; a
// click in the panel is same-origin; a typed URL is "none". Routes that run a
// process or probe a server AND are called from fetch() (/api/github, /api/mcp)
// are POSTs instead, so they get the full write guard.
const STATEFUL_GETS = new Set(['/api/skills/sync/stream', '/api/skills/export', '/api/skill/export']);
// GETs that spawn a process (security / git / launchctl / pgrep) while building
// their answer. They are read-only, but a cross-site page must not be able to
// make the panel run programs, so they get the same refusal as STATEFUL_GETS.
const PROCESS_GETS = new Set(['/api/status', '/api/agents', '/api/home', '/api/firstrun']);
// GETs that scan the whole memory store (the knowledge graph and its concept
// search, tens of thousands of rows on a big brain): same refusal, so a
// cross-site page cannot make the panel burn CPU on them.
const SCAN_GETS = new Set(['/api/graph', '/api/graph/search']);
// For both sets, "no Origin and no Sec-Fetch-Site" (Safari < 16.4, or a bare
// script) is NOT enough: the request must carry a positive same-origin signal
// (Sec-Fetch-Site same-origin/none, an Origin that is this panel, or the
// X-Brain-Panel: 1 header the panel's own fetch() adds — a cross-site <form>,
// navigation or no-cors fetch cannot set a custom header).
const PANEL_HEADER = 'x-brain-panel';
let firstRunCache = null; // /api/firstrun, refreshed at most every 30 s
// Per-route body caps above the default. /api/learn carries an agent run's
// output, which agent.mjs lets grow to 8 MiB (its maxBuffer).
const BODY_LIMITS = { '/api/learn': 9 * 1024 * 1024 };

function peerRefusal(req) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return 'not a loopback client';
  const hostHdr = String(req.headers.host || '').toLowerCase();
  const m = hostHdr.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  // The port is required to match exactly; a bare "localhost" means port 80,
  // which is only this panel if the panel itself is on port 80.
  if (!m || !LOCAL_HOSTS.has(m[1]) || Number(m[2] ?? 80) !== port) return 'Host header is not this panel';
  return null;
}

function localWriteRefusal(req, { json = true, positive = false } = {}) {
  const peer = peerRefusal(req);
  if (peer) return peer;
  const origin = req.headers.origin;
  let originOk = false;
  if (origin !== undefined) {
    let u = null;
    try { u = new URL(origin); } catch { /* "null" or junk */ }
    // A browser's Origin is scheme://host[:port] and nothing more: userinfo
    // (http://x@127.0.0.1:port), a path, query or fragment is never sent by one.
    if (!u || u.protocol !== 'http:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash
      || /[/?#@]/.test(origin.replace(/^http:\/\//i, '')) || !LOCAL_HOSTS.has(u.hostname) || Number(u.port || 80) !== port) return 'cross-origin request';
    originOk = true;
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'cross-site request';
  if (positive && !originOk && site === undefined && req.headers[PANEL_HEADER] !== '1') return 'missing same-origin signal';
  if (json && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return 'content-type must be application/json';
  return null;
}

// The one body reader: capped, and a parse error is a 400 rather than a
// silent {}. Every write sends a JSON object — `{}` when it has nothing to say.
function readJsonBody(req, max = MAX_JSON_BODY) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { over = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return resolve({ ok: false, code: 413, error: 'request body too large' });
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const v = raw ? JSON.parse(raw) : null;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return resolve({ ok: false, code: 400, error: 'body must be a JSON object' });
        resolve({ ok: true, body: v });
      } catch {
        resolve({ ok: false, code: 400, error: 'body is not valid JSON' });
      }
    });
    req.on('error', () => resolve({ ok: false, code: 400, error: 'request error' }));
  });
}

// Edits go to the native store only — the row ids the panel shows, nothing
// else. claude-mem's DB (the fallback MEMORY_DB before an import) is refused.
function curationAllowed() {
  if (!existsSync(MEMORY_DB)) return { ok: false, code: 404, error: 'no memory store yet' };
  if (isForeignStore(MEMORY_DB)) return { ok: false, code: 409, error: "memory is read from claude-mem's DB — run `brain import` to move to the native store before editing" };
  return { ok: true };
}

function withCurationDb(fn) {
  const allowed = curationAllowed();
  if (!allowed.ok) return allowed;
  let h;
  try { h = openForCuration(MEMORY_DB); } catch (e) { return { ok: false, code: 409, error: e.message }; }
  // prepared = this write first ran the one-time lifecycle migration (verified
  // backup of the whole store); the panel tells the user where it went.
  try { const r = fn(h.db); return h.backupPath && r && r.ok ? { ...r, prepared: h.backupPath } : r; }
  finally { try { h.db.close(); } catch {} }
}

function statusPayload() {
  let manifest = null;
  if (existsSync(REPO_MANIFEST)) {
    try {
      manifest = JSON.parse(readFileSync(REPO_MANIFEST, 'utf8'));
    } catch {}
  }
  let totals = {};
  let projects = projectMap().slice(0, 50);
  if (existsSync(MEMORY_DB)) {
    const db = openDb(MEMORY_DB, { readonly: true });
    try {
      totals = {
        observations: count(db, 'observations'),
        summaries: count(db, 'session_summaries'),
        prompts: count(db, 'user_prompts'),
        sessions: count(db, 'sdk_sessions'),
      };
      projects = db
        .prepare(
          `SELECT project, COUNT(*) AS observations, MAX(created_at) AS last_seen
           FROM observations GROUP BY project ORDER BY observations DESC LIMIT 50`
        )
        .all();
    } finally {
      db.close();
    }
  }
  return {
    secrets: secretStatus(),
    recipient: getSecret(SECRET_KEYS.AGE_RECIPIENT),
    skills: skillCounts(),
    remote: remoteUrl(),
    manifest,
    totals,
    projects,
    encryption: config.encryption.enabled,
    repo: { owner: config.repo.owner, name: config.repo.name },
  };
}

function skillDescription(dir) {
  const skillMd = join(dir, 'SKILL.md');
  if (!existsSync(skillMd)) return '';
  let head;
  try {
    head = readFileSync(skillMd, 'utf8').slice(0, 2000);
  } catch {
    return '';
  }
  const clip = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 140);
  const m = head.match(/^description:[ \t]*(.*)$/im);
  if (m) {
    const inline = m[1].trim();
    // `description: >` / `|` is a YAML block scalar — the text is on the
    // following indented lines, not this one. 160 of this machine's skills use
    // that form, and reading only the marker printed a bare ">" on each card.
    if (/^[>|][-+]?$/.test(inline)) {
      const rest = head.slice(m.index + m[0].length).split('\n').slice(1);
      const body = [];
      for (const line of rest) {
        if (!line.trim()) { if (body.length) break; continue; }
        if (!/^\s/.test(line)) break; // dedent ends the block
        body.push(line.trim());
      }
      if (body.length) return clip(body.join(' '));
    } else if (inline) {
      return clip(inline.replace(/^["']|["']$/g, ''));
    }
  }
  const h = head.match(/^#\s*(.+)/m);
  return h ? clip(h[1]) : '';
}

// The two roots a skill can be addressed under. An id is `<root>/<rest>`, and
// every lookup is resolved back through here so a crafted id cannot escape
// (`../../etc/passwd`) — the grid is localhost-only, but the check is one line.
const SKILL_ROOTS = { library: REPO_SKILLS, external: REPO_EXTERNAL };

function resolveSkillId(id) {
  const [rootKey, ...rest] = String(id || '').split('/');
  const root = SKILL_ROOTS[rootKey];
  if (!root || !rest.length) return null;
  const target = resolve(root, ...rest);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return existsSync(join(target, 'SKILL.md')) ? target : null;
}

// Walk a tree collecting anything that declares itself a skill. skills-external
// nests them two or three deep (plugins/<marketplace>/<plugin>/<skill>,
// projects/<project>/<skill>), so depth is discovered rather than assumed.
function collectSkills(root, rootKey, depth, trail, out, meta) {
  if (!existsSync(root) || depth > 5) return;
  if (existsSync(join(root, 'SKILL.md'))) {
    out.push({
      id: [rootKey, ...trail].join('/'),
      name: trail[trail.length - 1],
      description: skillDescription(root),
      ...meta(trail),
    });
    return;
  }
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    collectSkills(join(root, e.name), rootKey, depth + 1, [...trail, e.name], out, meta);
  }
}

function listSkills() {
  const out = [];

  // The library you own and edit.
  collectSkills(REPO_SKILLS, 'library', 0, [], out, () => ({ scope: 'library', origin: 'library' }));

  // Backups of skills owned by a plugin or a project. The trail encodes where
  // each came from: plugins/<marketplace>/<plugin>/<skill>, projects/<proj>/<skill>.
  const versions = {};
  try {
    const m = JSON.parse(readFileSync(join(REPO_EXTERNAL, 'MANIFEST.json'), 'utf8'));
    for (const p of m.plugins || []) versions[`${p.plugin}/${p.skill}`] = p.version;
  } catch {}

  collectSkills(REPO_EXTERNAL, 'external', 0, [], out, (trail) => {
    if (trail[0] === 'plugins') {
      const plugin = trail[2];
      const skill = trail[trail.length - 1];
      const v = versions[`${plugin}/${skill}`];
      return { scope: 'plugin', origin: v ? `${plugin} ${v}` : plugin };
    }
    if (trail[0] === 'projects') return { scope: 'project', origin: trail[1] };
    return { scope: 'external', origin: trail[0] };
  });

  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// ─────────────────────────── skill library export ───────────────────────────
// Two sources, because they genuinely differ: the live library on this Mac is
// the authority (~/.claude-shared/skills, symlinked into ~/.claude and
// ~/.claude-personal), while REPO_SKILLS is the copy `brain sync` pushed — it
// lags until the next sync. The Skills grid lists the repo copy, so the export
// makes you pick rather than guessing on your behalf.
function liveSkillsDir() {
  const p = join(SHARED_DIR, 'skills');
  try {
    return realpathSync(p); // follow the symlink to ~/.claude-shared/skills
  } catch {
    return p;
  }
}

// An export source resolves to { parent, names } — the directory to archive
// FROM and the entries to archive. 'all' is two entries, which is why this
// isn't just a path: the library and the external backups are siblings in the
// repo and belong in one archive without flattening into each other.
function skillsSource(source) {
  if (source === 'repo') return { parent: dirname(REPO_SKILLS), names: [basename(REPO_SKILLS)] };
  if (source === 'all') return { parent: REPO_ROOT, names: ['skills', 'skills-external'] };
  const dir = liveSkillsDir();
  return { parent: dirname(dir), names: [basename(dir)] };
}

// Never leave the machine inside an export. Kept in one place so the zip and
// tar paths cannot drift apart.
const SECRET_PATTERNS = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '*.identity',
  '*.pem',
  '*.key',
  '*secret*.txt',
  '.DS_Store',
];
const SECRET_GLOBS = {
  zip: SECRET_PATTERNS.flatMap((g) => [g, `*/${g}`]),
  tar: SECRET_PATTERNS,
};

// zip is friendlier to double-click on macOS; tar is the portable fallback.
// Probed once — the answer cannot change while the server is running.
let SKILL_SYNC_CHILD = null;
let ZIP_OK = null;
function haveZip() {
  if (ZIP_OK === null) {
    try {
      ZIP_OK = spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0;
    } catch {
      ZIP_OK = false;
    }
  }
  return ZIP_OK;
}

// Stream an archive of `dir` straight to the response — never buffered, so a
// 137 MB library costs no heap. Both archivers write to stdout with `-`.
function streamSkillArchive(res, req, { parent, names }, source) {
  const zip = haveZip();
  const stamp = new Date().toISOString().slice(0, 10);
  // `source` is either an export source ('live'/'repo'/'all') or a single
  // skill's folder name; only the former deserves the brain-skills- prefix.
  const bulk = source === 'live' || source === 'repo' || source === 'all';
  const name = `${bulk ? `brain-skills-${source}-${stamp}` : source}.${zip ? 'zip' : 'tar.gz'}`;
  // Archive BY NAME from the parent, so everything lands inside a named folder —
  // unzipping at the archive root would spray 181 directories straight into the
  // user's Downloads.
  // git's ignore rules do NOT apply here — the live library isn't even a repo —
  // so the archiver has to be told itself. A real OPENAI_API_KEY lives in a
  // skill's .env on this machine, and an export is precisely the artifact a
  // person forwards to someone else. `.env.example` is kept: it's a template.
  const child = zip
    ? spawn('zip', ['-r', '-q', '-X', '-', ...names, '-x', ...SECRET_GLOBS.zip], { cwd: parent })
    : spawn('tar', ['-czf', '-', ...SECRET_GLOBS.tar.flatMap((g) => ['--exclude', g]), '-C', parent, ...names]);
  res.writeHead(200, {
    'content-type': zip ? 'application/zip' : 'application/gzip',
    'content-disposition': `attachment; filename="${name}"`,
    'cache-control': 'no-store',
  });
  child.stdout.pipe(res);
  child.stderr.resume(); // drain, or a chatty archiver deadlocks on a full pipe
  child.on('error', () => {
    try {
      res.destroy();
    } catch {}
  });
  // A cancelled download must not leave an orphan archiver churning over 137 MB.
  req.on('close', () => {
    try {
      child.kill('SIGTERM');
    } catch {}
  });
}

function getObservation(id) {
  if (!id || !existsSync(MEMORY_DB)) return null;
  const db = openDb(MEMORY_DB, { readonly: true });
  try {
    // status / pinned ride along so the panel can show the right buttons;
    // editable = the panel may change this store (native, not claude-mem's).
    // prep = the first write migrates it (a verified VACUUM INTO backup of the
    // whole store, seconds on a large brain.db), so the panel can say so.
    const o = getMemory(db, id);
    if (!o) return null;
    const editable = curationAllowed().ok;
    return { ...o, editable, prep: editable && !hasLifecycle(db) };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function activity(days = 21) {
  if (!existsSync(MEMORY_DB)) return { days: [], totalSessions: 0, totalHours: 0, byTool: [] };
  const db = openDb(MEMORY_DB, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT substr(started_at,1,10) AS day, COUNT(*) AS sessions,
                SUM(CASE WHEN completed_at_epoch>started_at_epoch
                    THEN (completed_at_epoch-started_at_epoch) ELSE 0 END) AS ms
         FROM sdk_sessions GROUP BY day ORDER BY day DESC LIMIT ?`
      )
      .all(days)
      .reverse();
    const byTool = db
      .prepare(`SELECT platform_source AS tool, COUNT(*) AS sessions FROM sdk_sessions GROUP BY tool ORDER BY sessions DESC`)
      .all();
    const dayRows = rows.map((r) => ({ day: r.day, sessions: r.sessions, hours: Math.round((r.ms || 0) / 3600000) }));
    return {
      days: dayRows,
      totalSessions: dayRows.reduce((a, d) => a + d.sessions, 0),
      totalHours: dayRows.reduce((a, d) => a + d.hours, 0),
      byTool,
    };
  } catch {
    return { days: [], totalSessions: 0, totalHours: 0, byTool: [] };
  } finally {
    db.close();
  }
}

function recentMemory(limit = 10) {
  if (!existsSync(MEMORY_DB)) return [];
  const db = openDb(MEMORY_DB, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT project, type, title, subtitle, created_at
         FROM observations o WHERE 1=1${liveOnly(db)} ORDER BY created_at_epoch DESC LIMIT ?`
      )
      .all(limit);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// Unified, paginated memory browser. Three modes:
//   concept → exact tag filter (concepts column, JSON array of quoted strings)
//   q       → natural-language full-text search, sanitized + relevance-ranked (BM25)
//   neither → browse ALL memory, newest first
// and a view on top of any mode: 'live' (default — soft-deleted rows hidden),
// 'pinned' (only pinned rows), 'deleted' (only deleted rows: the Undo list).
// Returns { results, total, offset, limit, mode, view }.
function browseMemory({ q = '', concept = '', offset = 0, limit = 25, view = 'live' } = {}) {
  offset = Math.max(0, Number(offset) || 0);
  limit = Math.min(100, Math.max(1, Number(limit) || 25));
  if (!['live', 'pinned', 'deleted'].includes(view)) view = 'live';
  if (!existsSync(MEMORY_DB)) return { results: [], total: 0, offset, limit, mode: 'all', view };
  const db = openDb(MEMORY_DB, { readonly: true });
  try {
    const lc = hasLifecycle(db), pins = hasPins(db);
    const COLS = `o.id, o.project, o.type, o.title, o.subtitle, o.created_at, ${lc ? "COALESCE(o.status,'active')" : "'active'"} AS status, ${pins ? 'o.pinned_at IS NOT NULL' : '0'} AS pinned`;
    // The view as a WHERE fragment (leading AND). A store without the columns
    // has nothing pinned or deleted.
    const V = view === 'pinned' ? (pins ? ` AND o.pinned_at IS NOT NULL${liveOnly(db)}` : ' AND 0')
      : view === 'deleted' ? (lc ? ` AND o.status = '${DELETED}'` : ' AND 0')
      : liveOnly(db);
    const shape = (rows) => rows.map((r) => ({ ...r, pinned: !!r.pinned }));
    // 1) Concept tag filter (this is what the "Top concepts" chips use).
    if (concept) {
      const like = `%"${concept}"%`;
      const total = db.prepare(`SELECT COUNT(*) n FROM observations o WHERE o.concepts LIKE ?${V}`).get(like).n;
      const results = db
        .prepare(`SELECT ${COLS} FROM observations o WHERE o.concepts LIKE ?${V} ORDER BY o.created_at_epoch DESC LIMIT ? OFFSET ?`)
        .all(like, limit, offset);
      return { results: shape(results), total, offset, limit, mode: 'concept', concept, view };
    }
    // 2) Natural-language search. Tokenize → quote each term (so hyphens/punctuation
    //    can't be read as FTS operators) → OR for recall → order by BM25 relevance.
    const tokens = String(q).toLowerCase().match(/[a-z0-9]+/g) || [];
    if (tokens.length) {
      const match = tokens.map((t) => `"${t}"`).join(' OR ');
      let total = 0, results = [];
      try {
        total = db.prepare(`SELECT COUNT(*) n FROM observations_fts f JOIN observations o ON o.id = f.rowid
                            WHERE observations_fts MATCH ?${V}`).get(match).n;
        results = db
          .prepare(`SELECT ${COLS} FROM observations_fts f JOIN observations o ON o.id = f.rowid
                    WHERE observations_fts MATCH ?${V} ORDER BY rank LIMIT ? OFFSET ?`)
          .all(match, limit, offset);
      } catch { /* malformed query → empty */ }
      return { results: shape(results), total, offset, limit, mode: 'search', q, view };
    }
    // 3) Browse everything, newest first (pinned view: newest pin first).
    const order = view === 'pinned' ? 'o.pinned_at DESC' : view === 'deleted' ? 'o.status_at DESC' : 'o.created_at_epoch DESC';
    const total = db.prepare(`SELECT COUNT(*) n FROM observations o WHERE 1=1${V}`).get().n;
    const results = db
      .prepare(`SELECT ${COLS} FROM observations o WHERE 1=1${V} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(limit, offset);
    return { results: shape(results), total, offset, limit, mode: 'all', view };
  } catch (e) {
    return { results: [], total: 0, offset, limit, mode: 'all', view, error: String(e.message || e) };
  } finally {
    db.close();
  }
}

// Detailed memory breakdowns for the Memory tab.
function memoryStats() {
  if (!existsSync(MEMORY_DB)) return { total: 0, byType: [], byProject: [], byMonth: [], topConcepts: [] };
  const db = openDb(MEMORY_DB, { readonly: true });
  try {
    const L = liveOnly(db); // soft-deleted rows are out of every figure, like the list
    const total = db.prepare(`SELECT COUNT(*) n FROM observations o WHERE 1=1${L}`).get().n;
    const byType = db.prepare(`SELECT type, COUNT(*) n FROM observations o WHERE 1=1${L} GROUP BY type ORDER BY n DESC`).all();
    const byProject = db
      .prepare(`SELECT project, COUNT(*) n FROM observations o WHERE 1=1${L} GROUP BY project ORDER BY n DESC LIMIT 12`)
      .all();
    const byMonth = db
      .prepare(`SELECT substr(created_at,1,7) m, COUNT(*) n FROM observations o WHERE created_at IS NOT NULL${L} GROUP BY m ORDER BY m DESC LIMIT 12`)
      .all()
      .reverse();
    const rows = db.prepare(`SELECT concepts FROM observations o WHERE concepts IS NOT NULL AND concepts != ''${L}`).all();
    const cc = new Map();
    for (const r of rows) {
      try {
        for (const c of JSON.parse(r.concepts)) {
          const k = String(c).trim();
          if (k) cc.set(k, (cc.get(k) || 0) + 1);
        }
      } catch {}
    }
    const topConcepts = [...cc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([concept, n]) => ({ concept, n }));
    return { total, byType, byProject, byMonth, topConcepts };
  } catch {
    return { total: 0, byType: [], byProject: [], byMonth: [], topConcepts: [] };
  } finally {
    db.close();
  }
}

// Read-only summary of the compounding wiki for the Dream tab (no side effects).
function dreamStatus() {
  const out = { concepts: 0, lastEpoch: 0, lint: { contradictions: 0, stale: 0, orphans: 0, isolated: 0 }, lastRun: '', hasWiki: existsSync(REPO_WIKI) };
  if (!out.hasWiki) return out;
  try {
    const st = JSON.parse(readFileSync(join(REPO_WIKI, '.state.json'), 'utf8'));
    out.concepts = Object.keys(st.concepts || {}).length;
    out.lastEpoch = st.lastEpoch || 0;
  } catch {}
  try {
    const lintTxt = readFileSync(join(REPO_WIKI, 'lint.md'), 'utf8');
    const grab = (re) => { const m = lintTxt.match(re); return m ? Number(m[1]) : 0; };
    out.lint = {
      contradictions: grab(/Contradictions[^(]*\((\d+)\)/),
      stale: grab(/Stale claims[^(]*\((\d+)\)/),
      orphans: grab(/Orphan pages[^(]*\((\d+)\)/),
      isolated: grab(/Isolated concepts[^(]*\((\d+)\)/),
    };
  } catch {}
  try {
    const logTxt = readFileSync(join(REPO_WIKI, 'log.md'), 'utf8');
    out.lastRun = ('## ' + (logTxt.split('\n## ')[1] || '')).split('\n## ')[0].trim();
  } catch {}
  return out;
}

// Instant, deterministic "explain" glossary — plain-English meaning of a term/metric
// with the operator's live numbers folded in. AI-deeper is a separate endpoint.
function explainTerm(key) {
  const s = memorySignals();
  const st = dreamStatus();
  const G = {
    observations: `**Observations** — the atomic unit of your brain. Each one is a single thing claude-mem noticed during a session (a bugfix, a decision, a discovery…). You have **${s.memories}** across **${s.projects}** projects. They are the raw source everything else is built from. Open one to **edit** its title/facts, **pin** it (pinned memories always rank in recall, brain_context and the startup block) or **delete** it (a soft delete with Undo — the Deleted view lists them; edits and pins stay on this Mac).`,
    memories: `**Memories (${s.memories})** — the total count of observations captured across every project and tool. This is the raw firehose; the Dream tab distills it into a wiki.`,
    types: `**Types (${s.types})** — observations are tagged by kind (e.g. bugfix, feature, decision, discovery, security_note). ${s.types} distinct types are present. The Memory tab breaks them down so you can see what your work is mostly made of.`,
    projects: `**Projects (${s.projects})** — distinct codebases/contexts the memory spans. Each observation belongs to one project.`,
    stale: `**Stale (${s.stale})** — projects with no new observation in 30+ days. They may hold outdated assumptions. Not a problem by itself — but worth re-verifying or archiving. The Dream → lint view lists stale *concepts* (60+ days) specifically.`,
    conflicts: `**Conflicts (${s.conflicts})** — the same content recorded under more than one project (identical content hash). Usually harmless duplication, occasionally a sign the same fact is being tracked in two places. The lint pass surfaces these as "contradictions to reconcile".`,
    relevance: `**Relevance** — how often an observation has been re-surfaced/reused. Dream ranks concepts by *frequency + relevance × 2*, so things you actually keep coming back to rise to the top of the wiki.`,
    concept: `**Concepts** — keyword tags attached to observations (e.g. "api-design", "encryption"). Dream groups observations by concept to build one wiki page per concept, and links concepts that co-occur.`,
    dream: `**Dream** — the distillation pass. It reads new observations, updates the machine-owned region of each concept page in place (your notes are preserved), recomputes cross-references, refreshes the briefing, appends to the log, and runs lint. Currently tracking **${st.concepts}** concepts.`,
    briefing: `**Briefing** — a short "what have I been doing" summary from the last 7 days: where your attention went, rising concepts, and which projects are going quiet.`,
    wiki: `**Knowledge wiki** — the compounding, synthesized version of your memory (Karpathy's "LLM Wiki" pattern). One page per concept, cross-referenced, with a human-owned Notes region that survives every dream. Agents read this instead of the raw firehose.`,
    lint: `**Lint** — a health check over the wiki. It flags four things to reconcile by hand (never auto-applied): contradictions (${st.lint.contradictions}), stale claims (${st.lint.stale}), orphan pages (${st.lint.orphans}), and isolated concepts (${st.lint.isolated}).`,
    contradictions: `**Contradictions (${st.lint.contradictions})** — the same content recorded under multiple projects. Confirm which project is canonical, or merge them.`,
    orphans: `**Orphan pages (${st.lint.orphans})** — concept pages that dropped out of the ranked index (too few recent observations) but are kept on disk. Merge into a live concept or archive.`,
    isolated: `**Isolated concepts (${st.lint.isolated})** — concepts with no cross-references to any other concept — knowledge islands. Worth linking to related pages by hand.`,
    schema: `**Schema (SCHEMA.md)** — the config layer of the wiki: it defines the page types, the machine/human regions, and the ingest/query/lint workflows. Human-editable; dream never overwrites it.`,
    tokenssaved: `**Tokens saved (estimate)** — each time the brain hands memories to a model (startup block, brain_recall, brain_context) it logs them. Saved = the work tokens those memories originally cost to produce (measured by the capturing tool) minus the tokens it costs to read them. A memory is credited once per day; memories with no measured work count for nothing. It assumes the memory spared the model from re-deriving it, so treat it as an estimate, not a bill.`,
    log: `**Dream log** — an append-only history of every dream pass: how many new observations were ingested, pages created/updated, and the lint counts at that time. Newest first.`,
  };
  const body = G[key];
  if (!body) return null;
  const title = key.charAt(0).toUpperCase() + key.slice(1);
  return { term: key, title, body };
}

// AI-deeper explanation: route the subject+detail through the operator's own CLI.
async function explainAI(subject, detail) {
  const tool = (availableTools().find((t) => t.available) || {}).id;
  if (!tool) return { ok: false, error: 'No AI CLI available on this machine (install Claude Code, Codex, or Antigravity).' };
  const task =
    `Explain the following in plain, concise English for a smart non-expert. ` +
    `2–4 short paragraphs, no preamble, no restating the question.\n\n` +
    `SUBJECT: ${subject}\n\nCONTEXT:\n${detail || '(none)'}`;
  try {
    const r = await runAgent({ role: 'engineer', tool, task, timeoutMs: 120000, injectMemory: false, selfRun: true });
    return { ok: true, tool, text: r.output || r.text || String(r) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Read-only wiring status for the Tools tab: is OUR MCP server (agentic-brain)
// installed and actually answering, which store does MEMORY_DB resolve to, and
// the per-tool capture/push/pull state doctor already computes. Everything here
// reuses bin/lib/doctor.mjs's exported, read-only sections — no new logic, no
// writes, and observation content is never returned (counts and paths only).
// serverProbe resolves node by absolute path internally (bridgehome.mjs), so
// this works under launchd's minimal PATH the same way /api/github does for gh.
async function mcpStatus() {
  const brainHealth = brainHealthSection();
  const bridgeHome = bridgeHomeSection();
  const registry = await loadRegistry();
  const tools = registry.ok
    ? await toolRows(registry, brainHealth.health, brainHealth.dbCount, bridgeHome.ok)
    : [];
  const probe = await serverProbe({ timeoutMs: 5000 });
  const countObs = (p) => {
    if (!existsSync(p)) return null;
    let db;
    try {
      db = openDb(p, { readonly: true });
      return db.prepare('SELECT COUNT(*) n FROM observations').get().n;
    } catch {
      return null;
    } finally {
      try { db?.close(); } catch {}
    }
  };
  return {
    serverName: registry.SERVER_NAME || 'agentic-brain',
    shim: { path: serverPath(), state: bridgeHome.verify.serverShim },
    probe,
    store: {
      resolved: MEMORY_DB,
      kind: MEMORY_DB === NATIVE_DB_PATH ? 'native' : 'claude-mem',
      native: { path: NATIVE_DB_PATH, exists: existsSync(NATIVE_DB_PATH), ready: existsSync(NATIVE_READY), observations: countObs(NATIVE_DB_PATH) },
      claudeMem: { path: CLAUDE_MEM_DB, exists: existsSync(CLAUDE_MEM_DB), observations: countObs(CLAUDE_MEM_DB) },
    },
    registryOk: registry.ok,
    // doctor's own Brain-health rows (config, capture, watcher, worker, sync,
    // distiller, store, claude-mem): already computed above, passed through
    // read-only so the panel's health summary matches `brain doctor`.
    doctor: brainHealth.rows.map((r) => ({ level: r.level, label: r.label, detail: r.detail || null, fix: r.fix || null })),
    tools: tools.map((t) => ({ id: t.id, name: t.name, installed: t.installed, level: t.level, detail: t.detail || null, checks: t.checks || {} })),
  };
}

// The four curation actions: body → result ({ok, …} or {ok:false, code, error}).
// The id is validated here and again in curate.mjs; unknown body keys are refused.
const onlyKeys = (b, keys) => {
  const extra = Object.keys(b).filter((k) => !keys.includes(k));
  return extra.length ? { ok: false, code: 400, error: `unknown field(s): ${extra.join(', ')}` } : null;
};
const needId = (b) => (rowId(b.id) ? null : { ok: false, code: 400, error: 'id must be a positive integer' });
const CURATE = {
  edit: (b) => {
    const bad = needId(b) || onlyKeys(b, ['id', 'title', 'facts', 'narrative']);
    if (bad) return bad;
    const { id, ...patch } = b;
    return withCurationDb((db) => editMemory(db, id, patch, { dbPath: MEMORY_DB }));
  },
  delete: (b) => needId(b) || onlyKeys(b, ['id']) || withCurationDb((db) => deleteMemory(db, b.id)),
  restore: (b) => needId(b) || onlyKeys(b, ['id']) || withCurationDb((db) => restoreMemory(db, b.id)),
  pin: (b) => needId(b) || onlyKeys(b, ['id', 'pinned']) || withCurationDb((db) => pinMemory(db, b.id, b.pinned)),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  const p = url.pathname;
  try {
    // The guard (see localWriteRefusal): one choke point, ahead of every route.
    const write = !SAFE_METHODS.has(req.method);
    const guarded = write || STATEFUL_GETS.has(p) || PROCESS_GETS.has(p) || SCAN_GETS.has(p);
    const refusal = guarded ? localWriteRefusal(req, { json: write, positive: !write }) : peerRefusal(req);
    if (refusal) return json(res, 403, { ok: false, error: refusal });
    let body = null;
    if (write) {
      const b = await readJsonBody(req, BODY_LIMITS[p] || MAX_JSON_BODY);
      if (!b.ok) return json(res, b.code, { ok: false, error: b.error });
      body = b.body;
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = readFileSync(join(__dirname, 'index.html'));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
      });
      return res.end(html);
    }
    if (req.method === 'GET' && p === '/app.js') {
      const js = readFileSync(join(__dirname, 'app.js'));
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
      });
      return res.end(js);
    }
    // Who are we actually connected to? All GitHub work goes through the `gh`
    // CLI (16 call sites), so gh's own auth state is the truth — not a token we
    // happen to have stored.
    if (req.method === 'POST' && p === '/api/github') {
      const { execFileSync } = await import('node:child_process');
      // This server usually runs under launchd, which supplies a minimal PATH —
      // a bare `gh` is not found even when it is installed. Resolve it the same
      // way bridgehome.mjs resolves node: explicit stable locations first.
      const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
        .find((p) => existsSync(p)) || 'gh';
      const sh = (args) => {
        try { return execFileSync(GH, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
        catch { return null; }
      };
      const ghInstalled = sh(['--version']) !== null;
      const login = ghInstalled ? sh(['api', 'user', '-q', '.login']) : null;
      const slug = `${config.repo.owner}/${config.repo.name}`;
      const url = remoteUrl() ? remoteUrl().replace(/\.git$/, '') : `https://github.com/${slug}`;
      let repoVisibility = null, repoExists = false;
      if (login) {
        const v = sh(['repo', 'view', slug, '--json', 'visibility', '-q', '.visibility']);
        if (v) { repoExists = true; repoVisibility = v.toLowerCase(); }
      }
      return json(res, 200, {
        ghInstalled,
        authenticated: !!login,
        login,
        slug,
        url,
        repoExists,
        visibility: repoVisibility,
        hasRemote: !!remoteUrl(),
      });
    }
    if (req.method === 'GET' && p === '/api/status') return json(res, 200, statusPayload());
    if (req.method === 'POST' && p === '/api/mcp') return json(res, 200, await mcpStatus());
    if (req.method === 'GET' && p === '/api/activity') return json(res, 200, activity());
    if (req.method === 'GET' && p === '/api/home') return json(res, 200, home());
    // First-run progress (firstrun.mjs): sessions found per tool, memories built,
    // what the distiller still has to do. Scans the whole store, so cached 30 s.
    if (req.method === 'GET' && p === '/api/firstrun') {
      if (!firstRunCache || Date.now() - firstRunCache.at > 30000) {
        const { firstRunStatus } = await import('../bin/lib/firstrun.mjs');
        firstRunCache = { at: Date.now(), body: await firstRunStatus() };
      }
      return json(res, 200, firstRunCache.body);
    }
    if (req.method === 'GET' && p === '/api/agents') return json(res, 200, { roles: agentRoles(), tools: availableTools() });
    if (req.method === 'POST' && p === '/api/agent') {
      return json(res, 200, { ok: true, result: await runAgent({ role: body.role, tool: body.tool, task: body.task }) });
    }
    if (req.method === 'POST' && p === '/api/learn') {
      return json(res, 200, { ok: true, ...saveLearning(body) });
    }
    if (req.method === 'POST' && p === '/api/learn/feedback') {
      return json(res, 200, { ok: true, ...recordFeedback(body.file, body.direction) });
    }
    if (req.method === 'GET' && p === '/api/learnings') {
      const file = url.searchParams.get('file');
      if (file) return json(res, 200, { file, content: readLearning(file) });
      return json(res, 200, { learnings: listLearnings() });
    }
    if (req.method === 'GET' && p === '/api/learn/drafts') {
      const file = url.searchParams.get('file');
      if (file) return json(res, 200, { file, content: readDraft(file) });
      return json(res, 200, { drafts: listDrafts() });
    }
    if (req.method === 'POST' && p === '/api/learn/drafts/approve') {
      return json(res, 200, { ok: true, ...approveDraft(body.file) });
    }
    if (req.method === 'POST' && p === '/api/learn/drafts/dismiss') {
      return json(res, 200, { ok: true, ...dismissDraft(body.file) });
    }
    // Knowledge graph: overview (?limit= topics), one project's own top concepts
    // (?project=), or one concept and its neighbours (?concept=). Read-only.
    if (req.method === 'GET' && p === '/api/graph') {
      const sp = url.searchParams;
      return json(res, 200, buildGraph({
        topConcepts: sp.get('limit') || (sp.get('project') ? 36 : 140),
        project: sp.get('project') || null,
        concept: sp.get('concept') || null,
      }));
    }
    if (req.method === 'GET' && p === '/api/graph/search') return json(res, 200, { results: searchGraphConcepts(url.searchParams.get('q') || '') });
    if (req.method === 'GET' && p === '/api/detect') {
      const d = detectAll();
      // Opt-out: detected tools are linked by default; only explicitly-off ones are unlinked.
      d.unlinked = config.unlinkedTools || [];
      d.linked = d.tools.filter((t) => t.detected && !d.unlinked.includes(t.id)).map((t) => t.id);
      return json(res, 200, d);
    }
    if (req.method === 'POST' && p === '/api/tools') {
      config.unlinkedTools = Array.isArray(body.unlinked) ? body.unlinked : [];
      writeFileSync(join(REPO_ROOT, 'config.json'), JSON.stringify(config, null, 2) + '\n');
      return json(res, 200, { ok: true, unlinked: config.unlinkedTools });
    }
    if (req.method === 'POST' && p === '/api/ingest') return json(res, 200, { ok: true, result: await ingest() });
    // Skill sync, streamed. A plain POST would sit silent for the seconds it
    // takes to walk the plugin cache and ~/Documents, so this reports each step
    // over SSE (GET, because that is what EventSource speaks) and the button
    // shows real progress instead of a spinner that might mean anything.
    if (req.method === 'GET' && p === '/api/skills/sync/stream') {
      if (SKILL_SYNC_CHILD) return json(res, 409, { error: 'a skill sync is already running' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let open = true;
      const send = (event, data) => {
        if (!open) return;
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { open = false; }
      };

      // Spawned, not called inline: the sync is synchronous fs work (cpSync over
      // ~426 skill trees) and running it in-process pins the event loop, so every
      // progress line lands at once when it finishes and the whole UI is frozen
      // meanwhile. A child process keeps this server answering and makes the
      // stream genuinely incremental.
      const t0 = Date.now();
      const child = spawn(process.execPath, [join(REPO_ROOT, 'bin', 'brain.mjs'), 'skills', '--all'], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      SKILL_SYNC_CHILD = child;

      let buf = '';
      const summary = { library: 0, plugins: 0, projects: 0, linked: 0 };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop(); // keep the partial line for the next chunk
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          const m = t.match(/^✅ (\d+) library · (\d+) plugin · (\d+) project · (\d+) linked/);
          if (m) {
            summary.library = +m[1]; summary.plugins = +m[2];
            summary.projects = +m[3]; summary.linked = +m[4];
            continue; // the tally is the `done` payload, not another log line
          }
          send('log', { line: t });
        }
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => { stderr += c; });

      const finish = (code) => {
        SKILL_SYNC_CHILD = null;
        send('done',
          code === 0
            ? { ok: true, ...summary, seconds: ((Date.now() - t0) / 1000).toFixed(1) }
            : { ok: false, error: (stderr.trim().split('\n').pop() || `exited with code ${code}`) });
        try { res.end(); } catch {}
      };
      child.on('error', (e) => { SKILL_SYNC_CHILD = null; send('done', { ok: false, error: e.message }); try { res.end(); } catch {} });
      child.on('close', finish);
      // Navigating away mid-sync should not leave the child orphaned.
      req.on('close', () => {
        open = false;
        if (SKILL_SYNC_CHILD === child) { try { child.kill('SIGTERM'); } catch {} }
      });
      return;
    }
    if (req.method === 'GET' && p === '/api/skills/export') {
      const q = url.searchParams.get('source');
      const source = q === 'repo' || q === 'all' ? q : 'live';
      const src = skillsSource(source);
      const present = src.names.filter((n) => existsSync(join(src.parent, n)));
      if (!present.length) return json(res, 404, { error: `nothing to export for source "${source}"` });
      return streamSkillArchive(res, req, { parent: src.parent, names: present }, source);
    }
    // One skill, zipped. Same archiver and the same secret exclusions as the
    // bulk export — a single skill folder is exactly as likely to hold a .env.
    if (req.method === 'GET' && p === '/api/skill/export') {
      const dir = resolveSkillId(url.searchParams.get('id'));
      if (!dir) return json(res, 404, { error: 'no such skill' });
      const safe = basename(dir).replace(/[^A-Za-z0-9._-]+/g, '-');
      return streamSkillArchive(res, req, { parent: dirname(dir), names: [basename(dir)] }, safe);
    }
    if (req.method === 'GET' && p === '/api/skills/export/info') {
      // Count skills the way a skill is actually defined — a directory holding a
      // SKILL.md — because skills-external/ nests them under plugin/project
      // folders, so counting top-level directories would report 2.
      const countSkills = (root, depth = 0) => {
        if (!existsSync(root)) return 0;
        if (existsSync(join(root, 'SKILL.md'))) return 1;
        if (depth > 4) return 0;
        let n = 0;
        for (const e of readdirSync(root, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith('.')) n += countSkills(join(root, e.name), depth + 1);
        }
        return n;
      };
      const out = {};
      for (const source of ['live', 'repo', 'all']) {
        const src = skillsSource(source);
        const paths = src.names.map((n) => join(src.parent, n));
        out[source] = {
          dir: paths.join(' + '),
          exists: paths.some(existsSync),
          count: paths.reduce((n, d) => n + countSkills(d), 0),
        };
      }
      out.format = haveZip() ? 'zip' : 'tar.gz';
      return json(res, 200, out);
    }
    if (req.method === 'GET' && p === '/api/skills') return json(res, 200, { skills: listSkills() });
    if (req.method === 'GET' && p === '/api/skill') {
      const id = url.searchParams.get('id');
      let dir;
      if (id) {
        dir = resolveSkillId(id);
      } else {
        // Legacy ?name= — library only, and still sanitised.
        const name = (url.searchParams.get('name') || '').replace(/[^A-Za-z0-9._-]/g, '');
        dir = name ? resolveSkillId(`library/${name}`) : null;
      }
      if (!dir) return json(res, 404, { error: 'no such skill', content: null });
      return json(res, 200, {
        id,
        path: dir,
        content: readFileSync(join(dir, 'SKILL.md'), 'utf8'),
      });
    }
    if (req.method === 'GET' && p === '/api/observation') {
      return json(res, 200, { observation: getObservation(Number(url.searchParams.get('id'))) });
    }
    if (req.method === 'GET' && p === '/api/recent') return json(res, 200, { results: recentMemory(10) });
    if (req.method === 'GET' && p === '/api/wiki') {
      const topic = url.searchParams.get('topic');
      if (topic) return json(res, 200, { topic, content: readWiki(topic) });
      if (url.searchParams.get('meta')) return json(res, 200, { pages: listWikiMeta() });
      return json(res, 200, { topics: listWiki() });
    }
    if (req.method === 'POST' && p === '/api/dream') return json(res, 200, { ok: true, result: dream() });
    if (req.method === 'POST' && p === '/api/lint') return json(res, 200, { ok: true, result: lint() });
    if (req.method === 'POST' && p === '/api/wiki/note') {
      if (!body.topic || !body.note) return json(res, 400, { error: 'topic and note required' });
      return json(res, 200, { ok: true, result: fileNote(body.topic, body.note) });
    }
    if (req.method === 'GET' && p === '/api/search') {
      const sp = url.searchParams;
      return json(res, 200, browseMemory({
        q: sp.get('q') || '', concept: sp.get('concept') || '',
        offset: sp.get('offset') || 0, limit: sp.get('limit') || 25,
        view: sp.get('view') || 'live',
      }));
    }
    // Curation: edit / soft-delete / undo / pin one memory. Guarded like every
    // write, strictly validated, one existing row of the native store per call.
    if (req.method === 'POST' && p.startsWith('/api/memory/') && Object.hasOwn(CURATE, p.slice('/api/memory/'.length))) {
      const r = CURATE[p.slice('/api/memory/'.length)](body);
      if (!r.ok) return json(res, r.code || 400, { ok: false, error: r.error });
      const { code, ...out } = r;
      return json(res, 200, out);
    }
    if (req.method === 'POST' && p === '/api/sync-claude') {
      const en = enableClaudeMemEverywhere({ write: true });
      const inj = injectContext({ write: true });
      return json(res, 200, { ok: true, plugins: en.results, digests: inj.results });
    }
    if (req.method === 'GET' && p === '/api/inject') return json(res, 200, injectContext({ write: false }));
    if (req.method === 'POST' && p === '/api/inject') return json(res, 200, injectContext({ write: true }));
    if (req.method === 'GET' && p === '/api/memory/stats') return json(res, 200, memoryStats());
    if (req.method === 'GET' && p === '/api/dream/status') return json(res, 200, dreamStatus());
    // Tokens-saved estimate (read-only: folds the delivery ledger next to the store).
    if (req.method === 'GET' && p === '/api/economics') return json(res, 200, computeSavings({ dbPath: MEMORY_DB }));
    if (req.method === 'GET' && p === '/api/eval') return json(res, 200, { last: lastEval() });
    if (req.method === 'POST' && p === '/api/eval') {
      return json(res, 200, writeReport(await runEval(), new Date().toISOString()));
    }
    if (req.method === 'GET' && p === '/api/explain') {
      const term = (url.searchParams.get('term') || '').toLowerCase();
      const r = explainTerm(term);
      return r ? json(res, 200, r) : json(res, 404, { error: 'unknown term', term });
    }
    if (req.method === 'POST' && p === '/api/explain/ai') {
      if (!body.subject) return json(res, 400, { error: 'subject required' });
      return json(res, 200, await explainAI(body.subject, body.detail || ''));
    }
    if (req.method === 'POST' && p === '/api/key/generate') {
      return json(res, 200, { recipient: generateAndStoreKey() });
    }
    if (req.method === 'POST' && p === '/api/key/import') {
      return json(res, 200, { recipient: importIdentity(body.identity || '') });
    }
    if (req.method === 'POST' && p === '/api/secret') {
      const map = { github: SECRET_KEYS.GITHUB_TOKEN };
      const account = Object.hasOwn(map, body.name) ? map[body.name] : null;
      if (!account) return json(res, 400, { error: 'unknown secret' });
      // An empty value clears the secret (the Keychain refuses empty writes).
      if (body.value) setSecret(account, String(body.value)); else deleteSecret(account);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (p === '/api/sync' || p === '/api/restore' || p === '/api/merge')) {
      const fn = p === '/api/sync' ? doSync : p === '/api/restore' ? doRestore : doMerge;
      const result = await fn();
      return json(res, 200, { ok: true, result });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// Port taken: usually the always-on panel (launchd/systemd job from `brain
// onboard`) is already serving it. Say so plainly and exit 0 — a crash with a
// stack trace reads like a broken install. Anything else on the port is a
// real conflict: explain it and exit 1.
server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  const url = `http://${host}:${port}`;
  let ours = false;
  try {
    const r = await fetch(`${url}/api/home`, { headers: { 'X-Brain-Panel': '1' }, signal: AbortSignal.timeout(2000) });
    ours = r.ok;
  } catch {}
  if (ours) {
    console.log(`Agentic Brain is already running at ${url} (the always-on background service) — open that.`);
    process.exit(0);
  }
  console.error(`Port ${port} is in use by another program. Free it, or run on another port: BRAIN_UI_PORT=37801 npm run serve`);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Agentic Brain running at http://${host}:${port}`);
});
