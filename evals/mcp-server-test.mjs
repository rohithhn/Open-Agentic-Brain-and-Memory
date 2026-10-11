#!/usr/bin/env node
// Tests for bin/mcp-server.mjs — the stdio JSON-RPC protocol shell for the
// Agentic Brain MCP memory server (docs/specs/mcp-memory-server.md §1/§7).
//
//   node evals/mcp-server-test.mjs
//
// The server is driven as a REAL SUBPROCESS over real stdio pipes for every
// case — that is the only way to prove framing (byte-purity on stdout,
// survival of malformed input, etc.) rather than merely asserting behaviour
// of in-process functions. The fixture DB is a throwaway `~/.claude-brain/
// brain.db` under a fake HOME (same trick evals/recall-test.mjs uses for
// taskContext(), since MEMORY_DB/retrieveContext() resolve from paths.mjs's
// module-load-time HOME, not from a per-call override) — the real
// ~/.claude-brain/brain.db and ~/.claude-mem/claude-mem.db are never opened
// for write by this suite.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../bin/lib/store.mjs';
import { openDb } from '../bin/lib/db.mjs';

// Real-store sanity checks below must never append to the real tokens-saved ledger.
process.env.BRAIN_NO_ECONOMICS = '1';

let pass = 0, fail = 0;
const results = [];
function record(name, ok, err) {
  if (ok) { pass++; results.push(['PASS', name, '']); }
  else { fail++; results.push(['FAIL', name, err ? err.message || String(err) : '']); }
}
async function ta(name, fn) {
  try { await fn(); record(name, true); }
  catch (e) { record(name, false, e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

const SERVER_PATH = fileURLToPath(new URL('../bin/mcp-server.mjs', import.meta.url));
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `mcp-server-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
let seq = 0;

// ── fixture home (populated with a native brain.db, per recall-test.mjs's
// established pattern) ───────────────────────────────────────────────────────
function buildFixtureHome({ populate = true } = {}) {
  const home = join(ROOT, `home-${++seq}`);
  mkdirSync(join(home, '.claude-brain'), { recursive: true });
  const dbPath = join(home, '.claude-brain', 'brain.db');
  const db = openStore({ path: dbPath });
  if (populate) {
    const mem = 'test:fixture:1';
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
       VALUES (?,?,?,?,?,?,'completed')`
    ).run(mem, mem, 'proj-fixture', 'test', '2026-01-01T00:00:00Z', 1);
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts, prompt_number, created_at, created_at_epoch, content_hash, generated_by_model)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      mem, 'proj-fixture', '', 'discovery', 'Ptarmigan migration timing bug', null, '[]',
      'The ptarmigan migration scheduler had an off-by-one in its epoch math.', '[]', 0,
      '2026-01-01T00:00:00Z', 1, 'hash-fixture-1', 'test'
    );
  }
  db.close();
  writeFileSync(join(home, '.claude-brain', 'READY'), `${new Date().toISOString()}\ntest fixture\n`);
  return { home, dbPath };
}

function readFixtureRows(dbPath, where = '') {
  const db = openDb(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT * FROM observations ${where}`).all();
  } finally {
    db.close();
  }
}

// ── subprocess harness ───────────────────────────────────────────────────────
// Speaks newline-delimited JSON-RPC over real pipes. Records EVERY byte ever
// written to stdout (raw, unsplit) so byte-purity can be asserted across an
// entire session, not just per-line.
class ServerHarness {
  constructor({ home, env = {} } = {}) {
    this.home = home;
    this.rawStdout = '';
    this.stderrBuf = '';
    this.lineBuf = '';
    this.pending = new Map(); // id -> {resolve, reject}
    this.nextId = 1;
    this.child = spawn(process.execPath, [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home || homedir(), ...env },
    });
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => { this.exitCode = code; this.exitSignal = signal; resolve({ code, signal }); });
    });
    this.child.stderr.on('data', (d) => { this.stderrBuf += d.toString(); });
    this.child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      this.rawStdout += s;
      this.lineBuf += s;
      let idx;
      while ((idx = this.lineBuf.indexOf('\n')) !== -1) {
        const line = this.lineBuf.slice(0, idx);
        this.lineBuf = this.lineBuf.slice(idx + 1);
        this._onLine(line);
      }
    });
  }

  _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      this.frameError = `non-JSON line on stdout: ${JSON.stringify(line.slice(0, 300))}`;
      return;
    }
    if (msg && msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
      const { resolve } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      resolve(msg);
    }
    // Notifications (no id) and unmatched ids are just observed, not routed.
  }

  writeRaw(text) {
    this.child.stdin.write(text);
  }

  request(method, params, { id, timeoutMs = 5000 } = {}) {
    const useId = id === undefined ? this.nextId++ : id;
    const frame = { jsonrpc: '2.0', id: useId, method };
    if (params !== undefined) frame.params = params;
    const p = new Promise((resolve, reject) => {
      this.pending.set(useId, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(useId)) {
          this.pending.delete(useId);
          reject(new Error(`no response to ${method} (id=${useId}) within ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
    this.writeRaw(JSON.stringify(frame) + '\n');
    return p;
  }

  notify(method, params) {
    const frame = { jsonrpc: '2.0', method };
    if (params !== undefined) frame.params = params;
    this.writeRaw(JSON.stringify(frame) + '\n');
  }

  async initialize(clientInfo = { name: 'test-harness', version: '1.0.0' }) {
    return this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo });
  }

  async close() {
    try { this.child.stdin.end(); } catch {}
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 5000))]);
    if (this.exitCode === undefined) {
      try { this.child.kill('SIGKILL'); } catch {}
    }
  }

  // Every complete line ever emitted on stdout must itself parse as JSON-RPC
  // 2.0. Used at the end of a session for a whole-session byte-purity check.
  assertByteClean() {
    const text = this.rawStdout;
    // Trailing partial line (no final \n) would be a framing bug too — but by
    // the time we check, all responses we awaited arrived, so any leftover in
    // lineBuf here is itself a violation unless it's pure whitespace.
    if (this.lineBuf.trim()) {
      throw new Error(`unterminated / stray trailing bytes on stdout: ${JSON.stringify(this.lineBuf.slice(0, 300))}`);
    }
    const lines = text.split('\n');
    // split() on a string ending in \n produces a trailing '' element — fine.
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        throw new Error(`non-JSON-RPC bytes on stdout: ${JSON.stringify(line.slice(0, 300))}`);
      }
      if (!msg || msg.jsonrpc !== '2.0') {
        throw new Error(`JSON on stdout that is not JSON-RPC 2.0: ${JSON.stringify(line.slice(0, 300))}`);
      }
    }
  }
}

// =====================================================================
// initialize handshake
// =====================================================================
await ta('initialize: returns serverInfo, protocolVersion, capabilities', async () => {
  const { home } = buildFixtureHome();
  const h = new ServerHarness({ home });
  try {
    const resp = await h.initialize();
    assert(!resp.error, `initialize returned an error: ${JSON.stringify(resp.error)}`);
    assert(resp.result, 'initialize must return a result');
    eq(resp.result.serverInfo && resp.result.serverInfo.name, 'agentic-brain', 'serverInfo.name');
    assert(typeof resp.result.serverInfo.version === 'string' && resp.result.serverInfo.version.length > 0, 'serverInfo.version must be a non-empty string');
    eq(resp.result.protocolVersion, '2024-11-05', 'protocolVersion');
    assert(resp.result.capabilities && typeof resp.result.capabilities === 'object', 'capabilities object');
    assert(resp.result.capabilities.tools, 'capabilities.tools must be present');
    assert(resp.result.capabilities.prompts, 'capabilities.prompts must be present');
    h.notify('notifications/initialized');
    h.assertByteClean();
  } finally {
    await h.close();
  }
});

// Real clientInfo names (read from the user's own MCP logs) decide which
// instructions the model gets: self-capturing clients (Claude Code) get the
// short ones; clients with no capture channel (Claude Desktop) the insistent ones.
await ta('initialize: instructions follow the real clientInfo.name (Claude Code vs Claude Desktop incl. its agent mode)', async () => {
  const cases = [
    ['claude-code', true], ['codex-mcp-client', true],
    ['local-agent-mode-agentic-brain', false], ['claude-ai', false], ['Claude Desktop', false], ['some-unknown-client', false],
  ];
  for (const [name, selfCapturing] of cases) {
    const { home } = buildFixtureHome();
    const h = new ServerHarness({ home });
    try {
      const resp = await h.initialize({ name, version: '1.0.0' });
      assert(!resp.error, `initialize(${name}) errored`);
      const ins = String(resp.result.instructions || '');
      assert(ins.includes('brain_context'), `${name}: instructions mention brain_context`);
      eq(ins.includes('NO automatic transcript capture'), !selfCapturing,
        `${name}: ${selfCapturing ? 'self-capturing instructions (no "NO automatic capture" warning)' : 'desktop instructions with the no-capture warning'}`);
    } finally {
      await h.close();
    }
  }
});

// =====================================================================
// tools/list
// =====================================================================
await ta('tools/list: returns exactly the five tools with valid schemas', async () => {
  const { home } = buildFixtureHome();
  const h = new ServerHarness({ home });
  try {
    await h.initialize();
    const resp = await h.request('tools/list', {});
    assert(!resp.error, `tools/list returned an error: ${JSON.stringify(resp.error)}`);
    const tools = resp.result.tools;
    assert(Array.isArray(tools), 'tools must be an array');
    eq(tools.length, 5, 'tool count');
    const names = tools.map((t) => t.name).sort();
    eq(JSON.stringify(names), JSON.stringify(['brain_context', 'brain_recall', 'brain_remember', 'brain_skill', 'brain_skills']), 'tool names');
    for (const tool of tools) {
      assert(typeof tool.name === 'string' && tool.name, `${JSON.stringify(tool)} missing name`);
      assert(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name} missing description`);
      assert(tool.inputSchema && tool.inputSchema.type === 'object', `${tool.name} inputSchema must be a JSON object schema`);
      // brain_skills is a pure listing: every field (query, limit) is optional.
      if (tool.name !== 'brain_skills') assert(Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.length > 0, `${tool.name} inputSchema must declare required fields`);
      assert(tool.inputSchema.properties && typeof tool.inputSchema.properties === 'object', `${tool.name} inputSchema must declare properties`);
    }
    const remember = tools.find((t) => t.name === 'brain_remember');
    assert(remember.inputSchema.required.includes('title'), 'brain_remember must require title');
    assert(remember.inputSchema.required.includes('facts'), 'brain_remember must require facts');
    h.assertByteClean();
  } finally {
    await h.close();
  }
});

// =====================================================================
// brain_remember round-trip -> row lands in the fixture DB
// =====================================================================
await ta('brain_remember: round-trips and the row lands in the fixture DB', async () => {
  const { home, dbPath } = buildFixtureHome();
  const h = new ServerHarness({ home });
  try {
    await h.initialize({ name: 'Claude Desktop', version: '1.0.0' });
    const resp = await h.request('tools/call', {
      name: 'brain_remember',
      arguments: {
        title: 'MCP server test observation for round trip',
        project: 'mcp-server-test',
        type: 'discovery',
        facts: ['the round trip works end to end'],
        narrative: 'Verifying brain_remember lands a row in the fixture DB via real stdio.',
        model: 'test-model-1',
      },
    });
    assert(!resp.error, `tools/call returned a protocol error: ${JSON.stringify(resp.error)}`);
    assert(resp.result && Array.isArray(resp.result.content), 'tool result must have content');
    assert(resp.result.isError !== true, `brain_remember returned isError: ${JSON.stringify(resp.result)}`);
    const payload = JSON.parse(resp.result.content[0].text);
    assert(payload.saved === true, `expected saved:true, got ${JSON.stringify(payload)}`);
    assert(Number.isFinite(payload.id), 'expected a numeric id');

    const rows = readFixtureRows(dbPath, `WHERE project = 'mcp-server-test'`);
    eq(rows.length, 1, 'exactly one row landed in the fixture DB');
    eq(rows[0].title, 'MCP server test observation for round trip', 'stored title matches');
    assert(rows[0].generated_by_model.startsWith('mcp/'), `generated_by_model must be mcp/-prefixed, got ${rows[0].generated_by_model}`);
    eq(rows[0].generated_by_model, 'mcp/test-model-1', 'generated_by_model uses the model field');
    const concepts = JSON.parse(rows[0].concepts);
    assert(concepts.includes('mcp-capture'), 'concepts must include the mcp-capture marker');

    // Session provenance: platform_source resolved from clientInfo.name at initialize.
    const sess = openDb(dbPath, { readonly: true }).prepare('SELECT platform_source FROM sdk_sessions WHERE memory_session_id = ?').get(
      readFixtureRows(dbPath, `WHERE project = 'mcp-server-test'`)[0].memory_session_id
    );
    eq(sess.platform_source, 'claude_desktop', 'platform_source mapped from clientInfo.name="Claude Desktop"');

    h.assertByteClean();
  } finally {
    await h.close();
  }
});

// =====================================================================
// brain_recall finds the round-tripped row
// =====================================================================
await ta('brain_recall: finds the observation written via brain_remember', async () => {
  const { home } = buildFixtureHome();
  const h = new ServerHarness({ home });
  try {
    await h.initialize();
    const write = await h.request('tools/call', {
      name: 'brain_remember',
      arguments: {
        title: 'Unique recallable marker gribbleflotz observation',
        project: 'mcp-server-test',
        type: 'discovery',
        facts: ['gribbleflotz is the unique search token for this test'],
      },
    });
    assert(write.result.isError !== true, 'setup write must succeed');

    const resp = await h.request('tools/call', {
      name: 'brain_recall',
      arguments: { query: 'gribbleflotz', limit: 5 },
    });
    assert(resp.result.isError !== true, `brain_recall errored: ${JSON.stringify(resp.result)}`);
    const payload = JSON.parse(resp.result.content[0].text);
    assert(Array.isArray(payload.results), 'results must be an array');
    assert(payload.count >= 1, `expected at least one hit, got ${JSON.stringify(payload)}`);
    const hit = payload.results.find((r) => r.title.includes('gribbleflotz'));
    assert(hit, 'expected the written observation to be found by brain_recall');
    assert(typeof hit.snippet === 'string', 'result must include a snippet');
    assert(!('text' in hit), 'brain_recall must never return the raw text field');
    h.assertByteClean();
  } finally {
    await h.close();
  }
});

// =====================================================================
// brain_context returns a block
// =====================================================================
await ta('brain_context: returns a markdown block for a matching fixture', async () => {
  const { home } = buildFixtureHome({ populate: true });
  const h = new ServerHarness({ home });
  try {
    await h.initialize();
    const resp = await h.request('tools/call', {
      name: 'brain_context',
      arguments: { task: 'ptarmigan migration scheduler epoch bug' },
    });
    assert(resp.result.isError !== true, `brain_context errored: ${JSON.stringify(resp.result)}`);
    const payload = JSON.parse(resp.result.content[0].text);
    assert(typeof payload.block === 'string', 'block must be a string');
    assert(typeof payload.used === 'number', 'used must be a number');
    assert(Array.isArray(payload.learningFiles), 'learningFiles must be an array');
    assert(payload.used >= 1, `expected the fixture observation to be pulled in, got used=${payload.used}`);
    h.assertByteClean();
  } finally {
    await h.close();
  }
});

// =====================================================================
// stdout byte-purity across a mixed-traffic session
// =====================================================================
await ta('stdout byte-purity across initialize + tools/list + 3 tool calls + notify', async () => {
  const { home } = buildFixtureHome();
  const h = new ServerHarness({ home });
  try {
    await h.initialize();
    h.notify('notifications/initialized');
    await h.request('tools/list', {});
    await h.request('prompts/list', {});
    await h.request('tools/call', { name: 'brain_remember', arguments: { title: 'x'.repeat(20), project: 'p', type: 'change', facts: ['f'] } });
    await h.request('tools/call', { name: 'brain_recall', arguments: { query: 'x' } });
    await h.request('tools/call', { name: 'brain_context', arguments: { task: 'anything' } });
    h.assertByteClean();
    assert(!h.frameError, h.frameError || '');
  } finally {
    await h.close();
  }
});

// =====================================================================
// malformed JSON on stdin -> server survives, still answers next request
// =====================================================================
await ta('malformed JSON on stdin: survives and answers the next request', async () => {
  const { home } = buildFixtureHome();
  const h = new ServerHarness({ home });
  try {
    await h.initialize();
    h.writeRaw('{ this is not json at all \n');
    const resp = await h.request('tools/list', {});
    assert(!resp.error, `server did not recover: ${JSON.stringify(resp.error)}`);
    assert(Array.isArray(resp.result.tools), 'tools/list must still work after malformed input');
    h.assertByteClean();
  } finally {
    await h.close();
  }
});

// =====================================================================
// unknown method -> JSON-RPC error, server alive
// =====================================================================
await ta('unknown method: JSON-RPC error (-32601), server stays alive', async () => {
  const { home } = buildFixtureHome();
  const h = new ServerHarness({ home });
  try {
    await h.initialize();
    const resp = await h.request('totally/unknown/method', {});
    assert(resp.error, 'expected a JSON-RPC error');
    eq(resp.error.code, -32601, 'method not found code');
    const follow = await h.request('tools/list', {});
    assert(!follow.error, 'server must still answer after an unknown method');
    h.assertByteClean();
  } finally {
    await h.close();
  }
});

// =====================================================================
// unknown tool -> tool error RESULT (not a protocol error), server alive
// =====================================================================
await ta('unknown tool: MCP error result (isError:true), NOT a JSON-RPC error, server alive', async () => {
  const { home } = buildFixtureHome();
  const h = new ServerHarness({ home });
  try {
    await h.initialize();
    const resp = await h.request('tools/call', { name: 'brain_nonexistent_tool', arguments: {} });
    assert(!resp.error, `unknown tool must NOT be a JSON-RPC protocol error, got ${JSON.stringify(resp.error)}`);
    assert(resp.result.isError === true, 'unknown tool must be an isError:true tool result');
    assert(typeof resp.result.content[0].text === 'string', 'error result must carry text content');
    const follow = await h.request('tools/list', {});
    assert(!follow.error, 'server must still answer after an unknown tool call');
    h.assertByteClean();
  } finally {
    await h.close();
  }
});

// =====================================================================
// invalid params -> error result, not a crash
// =====================================================================
await ta('invalid params (missing required fields): tool error result, not a crash', async () => {
  const { home } = buildFixtureHome();
  const h = new ServerHarness({ home });
  try {
    await h.initialize();
    const resp = await h.request('tools/call', {
      name: 'brain_remember',
      arguments: { title: 'short' }, // missing project/type/facts, and title is too short
    });
    assert(!resp.error, 'invalid tool arguments must not be a JSON-RPC protocol error');
    assert(resp.result.isError === true, 'invalid observation must produce isError:true');
    const follow = await h.request('tools/list', {});
    assert(!follow.error, 'server must still answer after invalid params');
    h.assertByteClean();
  } finally {
    await h.close();
  }
});

await ta('invalid params (tools/call with no name): JSON-RPC invalid params error, server alive', async () => {
  const { home } = buildFixtureHome();
  const h = new ServerHarness({ home });
  try {
    await h.initialize();
    const resp = await h.request('tools/call', {});
    assert(resp.error, 'tools/call with no tool name must be a protocol-level invalid-params error');
    eq(resp.error.code, -32602, 'invalid params code');
    const follow = await h.request('tools/list', {});
    assert(!follow.error, 'server must still answer after invalid tools/call params');
    h.assertByteClean();
  } finally {
    await h.close();
  }
});

// =====================================================================
// huge payload -> rejected cleanly
// =====================================================================
await ta('huge payload: rejected cleanly, server survives and keeps serving', async () => {
  const { home } = buildFixtureHome();
  const h = new ServerHarness({ home });
  try {
    await h.initialize();
    // Oversized single line (no trailing newline yet) — bigger than the
    // server's MAX_LINE_BYTES bound.
    const huge = JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'brain_remember', arguments: { title: 'x'.repeat(3_000_000) } } });
    h.writeRaw(huge + '\n');
    // Give the server a moment to process/drop it, then prove it is still alive.
    const resp = await h.request('tools/list', {}, { timeoutMs: 8000 });
    assert(!resp.error, 'server must still answer tools/list after an oversized frame');
    assert(Array.isArray(resp.result.tools), 'tools/list result must be well-formed');
    h.assertByteClean();
  } finally {
    await h.close();
  }
});

// =====================================================================
// uninitialized brain -> tool error result, not a crash
// =====================================================================
await ta('uninitialized brain (no fixture DB): brain_remember returns an error result, not a crash', async () => {
  const home = join(ROOT, `home-uninit-${++seq}`);
  mkdirSync(home, { recursive: true }); // no .claude-brain dir at all
  const h = new ServerHarness({ home });
  try {
    await h.initialize();
    const resp = await h.request('tools/call', {
      name: 'brain_remember',
      arguments: { title: 'this should fail cleanly, no brain here', project: 'p', type: 'change', facts: ['f'] },
    });
    assert(!resp.error, 'uninitialized brain must not be a protocol error');
    assert(resp.result.isError === true, 'uninitialized brain must produce an isError:true tool result');
    const follow = await h.request('tools/list', {});
    assert(!follow.error, 'server must still answer after an uninitialized-brain failure');
    h.assertByteClean();
  } finally {
    await h.close();
  }
});

// =====================================================================
// process exits 0 on stdin close
// =====================================================================
await ta('process exits 0 when stdin closes', async () => {
  const { home } = buildFixtureHome();
  const h = new ServerHarness({ home });
  await h.initialize();
  h.child.stdin.end();
  const { code, signal } = await h.exited;
  eq(signal, null, 'must exit on its own, not via signal');
  eq(code, 0, 'exit code must be 0 on stdin close');
  h.assertByteClean();
});

// =====================================================================
// prompts/list + prompts/get for load-my-brain
// =====================================================================
await ta('prompts/list + prompts/get: load-my-brain prompt is present and well-formed', async () => {
  const { home } = buildFixtureHome();
  const h = new ServerHarness({ home });
  try {
    await h.initialize();
    const list = await h.request('prompts/list', {});
    assert(!list.error, 'prompts/list must not error');
    const names = list.result.prompts.map((p) => p.name);
    assert(names.includes('load-my-brain'), 'load-my-brain prompt must be listed');

    const got = await h.request('prompts/get', { name: 'load-my-brain', arguments: { task: 'fixing the widget' } });
    assert(!got.error, `prompts/get must not error: ${JSON.stringify(got.error)}`);
    assert(Array.isArray(got.result.messages) && got.result.messages.length > 0, 'prompts/get must return messages');
    assert(got.result.messages[0].content.text.toLowerCase().includes('brain_context'), 'prompt must instruct calling brain_context');

    const bad = await h.request('prompts/get', { name: 'no-such-prompt' });
    assert(bad.error, 'unknown prompt name must be a protocol error');
    h.assertByteClean();
  } finally {
    await h.close();
  }
});

// =====================================================================
// hybrid search cold start (S10): the model loads only in a server that can
// use it, and a first search never waits past the cold-start budget
// =====================================================================
const waitFor = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return pred();
};

// Shares no word with the fixture ("Ptarmigan migration timing bug" / "...
// scheduler had an off-by-one in its epoch math"): only meaning can find it.
const SEMANTIC_ONLY_QUERY = 'bird relocation date calculation error';

await ta('semantic warm-up: off by default; with BRAIN_EMBED_PREWARM=1 a store without vectors loads nothing', async () => {
  const { home } = buildFixtureHome();
  const quiet = new ServerHarness({ home, env: { BRAIN_EMBED_PREWARM: '' } });
  try {
    await quiet.initialize();
    const r = await quiet.request('tools/call', { name: 'brain_recall', arguments: { query: 'ptarmigan' } }, { timeoutMs: 10000 });
    eq(JSON.parse(r.result.content[0].text).count, 1, 'BM25 recall works');
    const miss = await quiet.request('tools/call', { name: 'brain_recall', arguments: { query: SEMANTIC_ONLY_QUERY } }, { timeoutMs: 10000 });
    eq(JSON.parse(miss.result.content[0].text).count, 0, 'BM25 alone cannot find the fixture by meaning');
    assert(!/semantic (search warmed|warm-up)/.test(quiet.stderrBuf), `no warm-up unless asked: ${quiet.stderrBuf}`);
    quiet.assertByteClean();
  } finally { await quiet.close(); }

  const pre = new ServerHarness({ home, env: { BRAIN_EMBED_PREWARM: '1' } });
  try {
    await pre.initialize();
    assert(await waitFor(() => /semantic warm-up skipped/.test(pre.stderrBuf)), `prewarm must skip a store without vectors: ${pre.stderrBuf}`);
    pre.assertByteClean();
  } finally { await pre.close(); }
});

// The real model, when this checkout has one cached (the LongMemEval harness
// keeps it under evals/longmemeval/data/models — never ~/.claude-brain).
const MODEL_DIR = fileURLToPath(new URL('./longmemeval/data/models', import.meta.url));
const HAVE_MODEL = existsSync(join(MODEL_DIR, 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model_quantized.onnx'));
await ta('semantic warm-up: real model — prewarm loads it in the background; without prewarm the first search starts it; recall is then hybrid', async () => {
  if (!HAVE_MODEL) { console.log('  (skipped — no cached model under evals/longmemeval/data/models)'); return; }
  const { home, dbPath } = buildFixtureHome();
  const prevDir = process.env.BRAIN_MODEL_DIR;
  process.env.BRAIN_MODEL_DIR = MODEL_DIR;
  try {
    const E = await import('../bin/lib/embed.mjs');
    const r = await E.runEmbed({ dbPath, apply: true });
    eq(r.embedded, 1, 'fixture row embedded with the real model');
  } finally { if (prevDir === undefined) delete process.env.BRAIN_MODEL_DIR; else process.env.BRAIN_MODEL_DIR = prevDir; }
  const h = new ServerHarness({ home, env: { BRAIN_EMBED_PREWARM: '1', BRAIN_MODEL_DIR: MODEL_DIR } });
  try {
    const t0 = Date.now();
    const init = await h.initialize();
    assert(!init.error && Date.now() - t0 < 3000, 'initialize answers without waiting for the model');
    assert(await waitFor(() => /semantic search warmed in \d+ms/.test(h.stderrBuf), 20000), `warm-up log missing: ${h.stderrBuf}`);
    const resp = await h.request('tools/call', { name: 'brain_recall', arguments: { query: SEMANTIC_ONLY_QUERY } }, { timeoutMs: 10000 });
    const out = JSON.parse(resp.result.content[0].text);
    eq(out.count, 1, `semantic hit expected: ${resp.result.content[0].text}`);
    h.assertByteClean();
  } finally { await h.close(); }

  // Default (no prewarm): the first search starts the load and waits at most
  // the cold-start budget (2.5 s); a later search is hybrid either way.
  const lazy = new ServerHarness({ home, env: { BRAIN_EMBED_PREWARM: '', BRAIN_MODEL_DIR: MODEL_DIR } });
  try {
    await lazy.initialize();
    const t0 = Date.now();
    const first = await lazy.request('tools/call', { name: 'brain_recall', arguments: { query: SEMANTIC_ONLY_QUERY } }, { timeoutMs: 10000 });
    const took = Date.now() - t0;
    assert(!first.result.isError && took < 4500, `first search bounded by the budget (took ${took} ms)`);
    let count = JSON.parse(first.result.content[0].text).count;
    for (let i = 0; i < 40 && count !== 1; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const again = await lazy.request('tools/call', { name: 'brain_recall', arguments: { query: SEMANTIC_ONLY_QUERY } }, { timeoutMs: 10000 });
      count = JSON.parse(again.result.content[0].text).count;
    }
    eq(count, 1, 'once the background load finishes, recall is hybrid');
    lazy.assertByteClean();
  } finally { await lazy.close(); }
});

// ── report ──────────────────────────────────────────────────────────────
console.log('');
for (const [status, name, err] of results) {
  console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}${err ? `\n    ${err}` : ''}`);
}
console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total)`);
try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
