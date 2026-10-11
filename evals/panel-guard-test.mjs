#!/usr/bin/env node
// The control panel's write guard (ui/server.mjs): every request that changes
// anything — any POST/PUT/PATCH/DELETE, and the state-changing SSE GET — must
// come from this panel's own page or a local non-browser client. A cross-site
// <form> post, a no-cors fetch from another origin, a DNS-rebinding Host, or a
// Sec-Fetch-Site: cross-site request is refused on every route, before the
// route runs; the panel's own JSON requests still work.
//
//   node evals/panel-guard-test.mjs
//
// Hermetic by construction, so even a regression that let a request through
// could not touch anything real: the server runs from a COPY of bin/ + ui/ in
// a scratch dir (its REPO_ROOT — config.json, wiki/, learnings/ — is that
// copy), against a fake HOME, with gh/git/security/launchctl and the agent
// CLIs shadowed on PATH by stubs that only log that they were called.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../bin/lib/store.mjs';

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m}\n    expected: ${B}\n    actual:   ${A}`);
}

const SRC = fileURLToPath(new URL('..', import.meta.url));
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `panel-guard-test-${process.pid}`);
const ENGINE = join(ROOT, 'engine');
const HOME = join(ROOT, 'home');
const STUBS = join(ROOT, 'stubs');
const CALLS = join(ROOT, 'calls.log');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// ── the engine copy: no config.json (config.example.json is the fallback) ──
for (const f of ['bin', 'ui', 'package.json', 'config.example.json']) cpSync(join(SRC, f), join(ENGINE, f), { recursive: true });
const SERVER_SRC = readFileSync(join(ENGINE, 'ui', 'server.mjs'), 'utf8');

// ── stubs: anything that could reach GitHub, the Keychain, launchd or an AI CLI ──
mkdirSync(STUBS, { recursive: true });
for (const name of ['gh', 'git', 'security', 'launchctl', 'claude', 'codex', 'gemini', 'agy', 'antigravity', 'age', 'age-keygen', 'brew', 'open']) {
  const f = join(STUBS, name);
  writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${CALLS}"\nexit 1\n`);
  chmodSync(f, 0o755);
}

// ── fake HOME with a small native store, so a same-origin curation write can succeed ──
mkdirSync(join(HOME, '.claude-brain'), { recursive: true });
const DB = join(HOME, '.claude-brain', 'brain.db');
{
  const db = openStore({ path: DB });
  const mem = 'guard:test';
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
              VALUES (?,?,?,?,?,?,'completed')`).run(mem, mem, 'guard-proj', 'claude', '2026-01-01T00:00:00Z', 1);
  const ins = db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, facts, narrative, concepts,
      prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash, generated_by_model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ['Guard target memory', 'Guard neighbour memory'].forEach((title, i) => {
    const e = Date.UTC(2026, 8, 1 + i);
    ins.run(mem, 'guard-proj', '', 'decision', title, JSON.stringify([`fact ${i}`]), `narrative ${i}`, '[]', 0, 10, new Date(e).toISOString(), e, `g-${i}`, 'test');
  });
  db.close();
  writeFileSync(join(HOME, '.claude-brain', 'READY'), 'ok\n');
}
const pinnedAt = (id) => {
  const db = new DatabaseSync(DB, { readOnly: true });
  try { return db.prepare('SELECT pinned_at FROM observations WHERE id = ?').get(id)?.pinned_at ?? null; }
  catch { return null; } finally { db.close(); }
};

// Every file under a dir with its size + mtime: "nothing was written here".
// SQLite's -shm index is rewritten by plain reads, so it is left out (a write
// still shows: in brain.db itself, or in the -wal's size).
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.endsWith('-shm')) { const s = statSync(p); out[p.slice(dir.length)] = `${s.size}:${s.mtimeMs}`; }
    }
  };
  walk(dir);
  return out;
}

function httpReq(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data !== null && h['content-length'] === undefined) h['content-length'] = Buffer.byteLength(data);
    const req = request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: j, text: buf, type: res.headers['content-type'] || '' });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

const PORT = 39000 + ((process.pid + 53) % 900);
const nodeDir = dirname(process.execPath);
const env = {
  HOME, PATH: `${STUBS}:${nodeDir}:/usr/bin:/bin`, USER: process.env.USER || 'guard', TMPDIR: join(ROOT, 'tmp'),
  BRAIN_UI_PORT: String(PORT), BRAIN_EMBED: '0', BRAIN_NO_ECONOMICS: '1', BRAIN_NO_AUTOMATION: '1',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
};
mkdirSync(env.TMPDIR, { recursive: true });
const srv = spawn(process.execPath, [join(ENGINE, 'ui', 'server.mjs')], { cwd: ENGINE, env, stdio: 'ignore' });

// ── the write routes, read from the server source so a new one is covered automatically ──
function writeRoutes(src) {
  const routes = new Set();
  for (const line of src.split('\n')) {
    const m = line.match(/req\.method === '(POST|PUT|PATCH|DELETE)'/);
    if (!m) continue;
    for (const [, path] of line.matchAll(/p === '([^']+)'/g)) routes.add(`${m[1]} ${path}`);
    if (line.includes("p.startsWith('/api/memory/')")) for (const k of ['edit', 'delete', 'restore', 'pin']) routes.add(`${m[1]} /api/memory/${k}`);
  }
  return [...routes].map((r) => { const [method, path] = r.split(' '); return { method, path }; });
}
const ROUTES = writeRoutes(SERVER_SRC);

const SAME = { origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
// What a hostile page in the same browser can make the browser send.
const ATTACKS = [
  ['cross-site <form> post (text/plain, no Origin)', { 'content-type': 'text/plain' }],
  ['urlencoded <form> post with Origin', { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
  ['no-cors fetch from a foreign origin', { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
  ['foreign Origin with a JSON type', { 'content-type': 'application/json', origin: 'https://evil.example' }],
  ['opaque Origin (sandboxed iframe / file:)', { 'content-type': 'application/json', origin: 'null' }],
  ['another local port (same-site, not same-origin)', { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORT + 1}`, 'sec-fetch-site': 'same-site' }],
  ['Sec-Fetch-Site: cross-site', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }],
  ['DNS-rebinding Host', { ...SAME, host: `evil.example:${PORT}`, origin: `http://evil.example:${PORT}` }],
  ['wrong port in Host', { 'content-type': 'application/json', host: `127.0.0.1:${PORT + 1}` }],
  ['no content type at all', {}],
  ['Host without a port (means :80, not this panel)', { ...SAME, host: 'localhost', origin: 'http://localhost' }],
  ['bare 127.0.0.1 Host, no port', { ...SAME, host: '127.0.0.1' }],
  ['Origin with userinfo (user@)', { ...SAME, origin: `http://user@127.0.0.1:${PORT}` }],
  ['Origin with userinfo (user:pw@, localhost)', { ...SAME, origin: `http://user:pw@localhost:${PORT}` }],
  ['Origin with a path', { ...SAME, origin: `http://127.0.0.1:${PORT}/x` }],
  ['Origin that only looks local (127.0.0.1@evil)', { ...SAME, origin: `http://127.0.0.1:${PORT}@evil.example` }],
];

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { up = (await httpReq(PORT, { path: '/api/memory/stats' })).status === 200; } catch { /* not yet */ }
  }
  if (!up) throw new Error('panel did not start');
  const engineBefore = snapshot(ENGINE), homeBefore = snapshot(HOME);

  await t('the write routes are all found in ui/server.mjs (the parser is not silently missing any)', async () => {
    const paths = ROUTES.map((r) => r.path);
    for (const want of ['/api/key/generate', '/api/key/import', '/api/secret', '/api/sync', '/api/restore', '/api/merge',
      '/api/inject', '/api/dream', '/api/ingest', '/api/sync-claude', '/api/tools', '/api/agent', '/api/learn',
      '/api/learn/feedback', '/api/learn/drafts/approve', '/api/learn/drafts/dismiss', '/api/lint', '/api/wiki/note',
      '/api/eval', '/api/explain/ai', '/api/github', '/api/mcp', '/api/memory/edit', '/api/memory/delete', '/api/memory/restore', '/api/memory/pin'])
      assert(paths.includes(want), `route ${want} found (have: ${paths.join(' ')})`);
    assert(ROUTES.length >= 26, `${ROUTES.length} routes`);
  });

  await t('every write route refuses every cross-site / rebinding shape with 403, before the route runs', async () => {
    const leaks = [];
    for (const { method, path } of ROUTES) {
      for (const [label, headers] of ATTACKS) {
        const r = await httpReq(PORT, { method, path, headers, body: JSON.stringify({ id: 1, pinned: true, name: 'github', value: 'x', identity: 'x', unlinked: ['x'], topic: 't', note: 'n', subject: 's' }) });
        if (r.status !== 403 || r.body?.ok !== false || !r.body?.error) leaks.push(`${method} ${path} [${label}] → ${r.status} ${r.text.slice(0, 80)}`);
      }
    }
    assert(!leaks.length, `not refused:\n      ${leaks.join('\n      ')}`);
  });

  await t('the guard is structural: PUT / PATCH / DELETE and unknown write paths are refused cross-site too', async () => {
    const evil = { 'content-type': 'text/plain', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/api/secret', '/api/sync', '/api/memory/delete', '/api/some-future-route']) {
        eq((await httpReq(PORT, { method, path, headers: evil, body: '{}' })).status, 403, `${method} ${path}`);
      }
    }
    eq((await httpReq(PORT, { method: 'POST', path: '/api/some-future-route', headers: evil, body: '{}' })).status, 403, 'unknown POST path, cross-site');
    // ...and the same unknown path from the panel itself just isn't there.
    eq((await httpReq(PORT, { method: 'POST', path: '/api/some-future-route', headers: SAME, body: '{}' })).status, 404, 'unknown POST path, same-origin');
  });

  await t('the state-changing GET (skill sync SSE) is guarded too', async () => {
    for (const [label, headers] of [
      ['cross-site', { 'sec-fetch-site': 'cross-site' }],
      ['foreign Origin', { origin: 'https://evil.example' }],
      ['same-site other port', { origin: `http://localhost:${PORT + 1}`, 'sec-fetch-site': 'same-site' }],
      ['rebinding Host', { host: `evil.example:${PORT}` }],
    ]) {
      const r = await httpReq(PORT, { path: '/api/skills/sync/stream', headers });
      assert(r.status === 403 && !r.type.includes('event-stream'), `${label}: ${r.status} ${r.type}`);
    }
  });

  await t('the side-effecting GETs are guarded: skill exports and the SSE sync refuse cross-site / rebinding / userinfo shapes', async () => {
    const bad = [
      ['cross-site navigation', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }],
      ['cross-site, same-site flavour', { 'sec-fetch-site': 'same-site' }],
      ['foreign Origin', { origin: 'https://evil.example' }],
      ['opaque Origin', { origin: 'null' }],
      ['other local port', { origin: `http://localhost:${PORT + 1}`, 'sec-fetch-site': 'same-site' }],
      ['rebinding Host', { host: `evil.example:${PORT}` }],
      ['Host without a port', { host: 'localhost' }],
      ['Origin with userinfo', { origin: `http://user@127.0.0.1:${PORT}` }],
    ];
    const leaks = [];
    for (const path of ['/api/skills/export', '/api/skills/export?source=all', '/api/skill/export?id=anything', '/api/skills/sync/stream']) {
      for (const [label, headers] of bad) {
        const r = await httpReq(PORT, { path, headers });
        if (r.status !== 403 || r.type.includes('zip') || r.type.includes('event-stream')) leaks.push(`GET ${path} [${label}] -> ${r.status} ${r.type}`);
      }
    }
    assert(!leaks.length, `not refused:\n      ${leaks.join('\n      ')}`);
    // The panel's own navigation (same-origin click) and a typed URL ("none") still get through the guard.
    for (const site of ['same-origin', 'none']) {
      const r = await httpReq(PORT, { path: '/api/skills/export?source=live', headers: { 'sec-fetch-site': site, host: `127.0.0.1:${PORT}` } });
      assert(r.status !== 403, `Sec-Fetch-Site: ${site} was refused: ${r.status} ${r.text.slice(0, 80)}`);
    }
    const r = await httpReq(PORT, { path: '/api/skill/export?id=nope', headers: { 'sec-fetch-site': 'same-origin' } });
    eq(r.status, 404, `same-origin single-skill export reaches its route: ${r.text}`);
  });

  await t('process-spawning GETs (/api/status, /api/agents, /api/home) and the stateful GETs need a positive same-origin signal', async () => {
    const paths = ['/api/status', '/api/agents', '/api/home', '/api/skills/export?source=live', '/api/skill/export?id=nope', '/api/skills/sync/stream', '/api/graph', '/api/graph/search?q=a'];
    const host = `127.0.0.1:${PORT}`;
    const bad = [
      ['cross-site', { 'sec-fetch-site': 'cross-site' }],
      ['same-site', { 'sec-fetch-site': 'same-site' }],
      ['foreign Origin', { origin: 'https://evil.example' }],
      ['no signal at all (old Safari / bare form navigation)', {}],
      ['wrong X-Brain-Panel value', { 'x-brain-panel': '0' }],
      ['rebinding Host with the panel header', { 'x-brain-panel': '1', host: `evil.example:${PORT}` }],
      ['foreign Origin with the panel header', { 'x-brain-panel': '1', origin: 'https://evil.example' }],
    ];
    const leaks = [];
    for (const path of paths) for (const [label, h] of bad) {
      const r = await httpReq(PORT, { path, headers: { host, ...h } });
      if (r.status !== 403) leaks.push(`GET ${path} [${label}] -> ${r.status}`);
    }
    assert(!leaks.length, `not refused:\n      ${leaks.join('\n      ')}`);
    eq(existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim() : '', '', 'no process was spawned for any refused request');
    for (const path of ['/api/status', '/api/agents', '/api/home', '/api/graph', '/api/graph/search?q=a']) {
      for (const [label, h] of [['Sec-Fetch-Site same-origin', { 'sec-fetch-site': 'same-origin' }], ['Sec-Fetch-Site none', { 'sec-fetch-site': 'none' }],
        ['own Origin', { origin: `http://127.0.0.1:${PORT}` }], ['X-Brain-Panel: 1', { 'x-brain-panel': '1' }]]) {
        const r = await httpReq(PORT, { path, headers: { host, ...h } });
        assert(r.status === 200, `GET ${path} [${label}] -> ${r.status} ${r.text.slice(0, 80)}`);
      }
    }
    const a = await httpReq(PORT, { path: '/api/agents', headers: { host, 'x-brain-panel': '1' } });
    assert(Array.isArray(a.body?.tools) && a.body.tools.every((x) => typeof x.available === 'boolean'), 'agents payload shape');
    writeFileSync(CALLS, ''); // the allowed calls above legitimately ran the (stubbed) security/git/launchctl
  });

  await t('/api/github and /api/mcp are POST-only now: a GET (cross-site or not) neither runs gh nor probes the MCP server', async () => {
    for (const path of ['/api/github', '/api/mcp']) {
      for (const headers of [{}, { 'sec-fetch-site': 'cross-site' }, { origin: 'https://evil.example' }]) {
        const r = await httpReq(PORT, { path, headers });
        assert(r.status === 403 || r.status === 404, `GET ${path} ${JSON.stringify(headers)} -> ${r.status}`);
        assert(!r.body || (r.body.ghInstalled === undefined && r.body.probe === undefined), `GET ${path} returned data`);
      }
    }
    const calls = existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim() : '';
    eq(calls, '', 'no stub (gh, ...) was called');
  });

  await t('reads need a loopback Host with this exact port: no port, or another port, is refused', async () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', `localhost:${PORT + 1}`, `127.0.0.1:80`, `localhost:`])
      eq((await httpReq(PORT, { path: '/api/memory/stats', headers: { host } })).status, 403, `read with Host ${host}`);
    for (const host of [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, `LOCALHOST:${PORT}`])
      eq((await httpReq(PORT, { path: '/api/memory/stats', headers: { host } })).status, 200, `read with Host ${host}`);
  });

  await t('Origin must be exactly scheme://local-host:this-port (userinfo, path, query refused; a plain one still passes)', async () => {
    const P = (origin) => httpReq(PORT, { method: 'POST', path: '/api/secret', headers: { ...SAME, origin }, body: { name: 'nope' } });
    for (const o of [`http://u@127.0.0.1:${PORT}`, `http://u:p@localhost:${PORT}`, `http://127.0.0.1:${PORT}/`, `http://127.0.0.1:${PORT}?x`, `http://127.0.0.1:${PORT}#x`, `https://127.0.0.1:${PORT}`, 'http://127.0.0.1'])
      eq((await P(o)).status, 403, `Origin ${o}`);
    for (const o of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`])
      eq((await P(o)).status, 400, `Origin ${o} reaches the route`);
  });

  await t('reads need a loopback Host too (DNS rebinding cannot read memory), and work normally otherwise', async () => {
    eq((await httpReq(PORT, { path: '/api/memory/stats', headers: { host: `evil.example:${PORT}` } })).status, 403, 'rebinding read');
    eq((await httpReq(PORT, { path: '/api/observation?id=1', headers: { host: 'attacker.test' } })).status, 403, 'rebinding read, no port');
    eq((await httpReq(PORT, { path: '/api/memory/stats' })).status, 200, 'plain local read');
    eq((await httpReq(PORT, { path: '/api/memory/stats', headers: { host: `localhost:${PORT}` } })).status, 200, 'localhost read');
    const page = await httpReq(PORT, { path: '/', headers: { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'none' } });
    eq(page.status, 200, 'the page itself');
  });

  await t('nothing ran: no stub was called, the engine copy and the fake HOME are untouched, the store row is unpinned', async () => {
    const calls = existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim() : '';
    eq(calls, '', 'stub calls');
    eq(snapshot(ENGINE), engineBefore, 'engine copy unchanged (no config.json / wiki / learnings written)');
    eq(snapshot(HOME), homeBefore, 'fake HOME unchanged');
    eq(pinnedAt(1), null, 'row 1 not pinned');
  });

  await t("the panel's own same-origin JSON requests pass the guard and reach their route", async () => {
    // Validation errors from the ROUTE (not the guard) prove the request got through.
    let r = await httpReq(PORT, { method: 'POST', path: '/api/secret', headers: SAME, body: { name: 'nope' } });
    eq([r.status, r.body?.error], [400, 'unknown secret'], `secret: ${r.text}`);
    r = await httpReq(PORT, { method: 'POST', path: '/api/secret', headers: SAME, body: { name: '__proto__', value: 'x' } });
    eq([r.status, r.body?.error], [400, 'unknown secret'], `secret __proto__: ${r.text}`);
    r = await httpReq(PORT, { method: 'POST', path: '/api/wiki/note', headers: SAME, body: {} });
    eq([r.status, r.body?.error], [400, 'topic and note required'], `wiki note: ${r.text}`);
    r = await httpReq(PORT, { method: 'POST', path: '/api/explain/ai', headers: SAME, body: {} });
    eq([r.status, r.body?.error], [400, 'subject required'], `explain: ${r.text}`);
    // A real write: unlinking a tool rewrites config.json — of the engine COPY.
    r = await httpReq(PORT, { method: 'POST', path: '/api/tools', headers: { ...SAME, origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` }, body: { unlinked: ['guard-tool'] } });
    eq([r.status, r.body?.unlinked], [200, ['guard-tool']], `tools: ${r.text}`);
    eq(JSON.parse(readFileSync(join(ENGINE, 'config.json'), 'utf8')).unlinkedTools, ['guard-tool'], 'engine-copy config.json written');
    // A curation write against the fake store.
    r = await httpReq(PORT, { method: 'POST', path: '/api/memory/pin', headers: SAME, body: { id: 1, pinned: true } });
    eq(r.status, 200, `pin: ${r.text}`);
    assert(pinnedAt(1), 'row 1 pinned');
    // A local non-browser client (curl, a script) sends no Origin / Sec-Fetch-Site: fine with the JSON type.
    r = await httpReq(PORT, { method: 'POST', path: '/api/secret', headers: { 'content-type': 'application/json; charset=utf-8' }, body: { name: 'nope' } });
    eq(r.status, 400, `curl-style client: ${r.text}`);
  });

  await t('one strict body reader for every write: empty / malformed / non-object / oversized bodies are refused', async () => {
    const P = (path, body) => httpReq(PORT, { method: 'POST', path, headers: SAME, body });
    eq((await P('/api/wiki/note', '')).status, 400, 'empty body');
    eq((await P('/api/wiki/note', '{"topic":')).status, 400, 'malformed JSON');
    eq((await P('/api/wiki/note', '[1,2]')).status, 400, 'array body');
    eq((await P('/api/wiki/note', '"str"')).status, 400, 'string body');
    const big = JSON.stringify({ topic: 't', note: 'x'.repeat(70 * 1024) });
    eq((await P('/api/wiki/note', big)).status, 413, '64 KiB cap on an ordinary route');
    eq((await P('/api/memory/edit', JSON.stringify({ id: 1, narrative: 'x'.repeat(70 * 1024) }))).status, 413, '64 KiB cap on curation');
    // /api/learn carries an agent run's output (up to 8 MiB) — it has its own, larger cap.
    const r = await P('/api/learn', { role: 'Engineer', tool: 'stub', task: 'guard test learning', output: 'y'.repeat(200 * 1024) });
    eq(r.status, 200, `learn with a 200 KiB output: ${r.text.slice(0, 120)}`);
    assert(existsSync(join(ENGINE, 'learnings')), 'learning written into the engine copy');
  });

  await t('ui/app.js sends every write as JSON with the JSON content type', async () => {
    const js = (await httpReq(PORT, { path: '/app.js' })).text;
    const posts = [...js.matchAll(/method:'POST'/g)].length;
    eq(posts, 1, "exactly one method:'POST' in app.js (the jsonPost helper)");
    assert(/const jsonPost=\(p,body=\{\}\)=>pfetch\(p,\{method:'POST',headers:\{'content-type':'application\/json'\},body:JSON\.stringify\(body\)\}\)/.test(js), 'jsonPost sets the header and a JSON body');
    assert(!/api\([^)]*method:/.test(js), 'no write goes through bare api()');
    assert(!/(?<!p)fetch\((?!p,)/.test(js), 'no other bare fetch() call (everything goes through pfetch, which adds X-Brain-Panel)');
    assert(!/api\('\/api\/(github|mcp)'/.test(js), '/api/github and /api/mcp are not fetched with a GET');
    for (const route of ['/api/github', '/api/mcp', '/api/dream', '/api/inject', '/api/sync-claude', '/api/eval', '/api/key/generate', '/api/key/import', '/api/tools', '/api/agent', '/api/learn'])
      assert(js.includes(`send('${route}'`), `${route} goes through send()`);
    assert(js.includes("send('/api/'+kind)"), 'sync / restore / merge go through send()');
  });
} catch (e) {
  fail++; results.push(['FAIL', 'harness', e.message]);
} finally {
  srv.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  rmSync(ROOT, { recursive: true, force: true });
}

for (const [s, n, m] of results) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${m ? `\n      ${m}` : ''}`);
console.log(`\npanel-guard-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
