#!/usr/bin/env node
// Tests for parseGemini() in bin/lib/ingest.mjs — the Gemini CLI session reader.
//
// Why this exists: Gemini CLI moved from one `tmp/<slug>/logs.json` per project to
// one `tmp/<slug>/chats/session-<ISO>-<id8>.jsonl` per SESSION, and the old parser
// skipped every file in the new layout — hundreds of sessions silently never
// ingested. These tests pin BOTH layouts, the cross-format dedupe, and idempotence.
//
//   node evals/ingest-gemini-test.mjs
//
// Everything runs against a synthetic $HOME under the scratchpad. No real
// ~/.gemini file is read and no real session text appears anywhere in here —
// every fixture string below is invented for the test.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `ingest-gemini-test-${process.pid}`);
let caseSeq = 0;

// ── fixture builders (shapes copied from the real format; content invented) ──
const chatHeader = (sid, startTime) =>
  JSON.stringify({ sessionId: sid, projectHash: 'a'.repeat(64), startTime, lastUpdated: startTime, kind: 'main' });
const snapshotLine = (id, ts, text) =>
  JSON.stringify({ $set: { messages: [{ id, timestamp: ts, type: 'user', content: [{ text }] }], lastUpdated: ts } });
const heartbeatLine = (ts) => JSON.stringify({ $set: { lastUpdated: ts } });
const userLine = (id, ts, text) =>
  JSON.stringify({ id, timestamp: ts, type: 'user', content: [{ text }] });
const toolResultLine = (id, ts) =>
  JSON.stringify({ id, timestamp: ts, type: 'user', content: [{ functionResponse: { name: 'read_file', response: { output: 'irrelevant' } } }] });
const geminiLine = (id, ts, text, toolCalls) =>
  JSON.stringify({ id, timestamp: ts, type: 'gemini', model: 'gemini-x', thoughts: [], tokens: { total: 10 }, content: text, ...(toolCalls ? { toolCalls } : {}) });
const infoLine = (id, ts, text) => JSON.stringify({ id, timestamp: ts, type: 'info', content: text });

// Build a synthetic $HOME and return parseGemini()'s output against it.
// The module caches HOME at import time, so each case gets a fresh module
// instance via a cache-busting import specifier.
async function runCase(build) {
  const home = join(ROOT, `home-${++caseSeq}`);
  mkdirSync(join(home, '.gemini', 'tmp'), { recursive: true });
  build({
    home,
    slugDir(slug) {
      const d = join(home, '.gemini', 'tmp', slug);
      mkdirSync(d, { recursive: true });
      return d;
    },
    chatsDir(slug) {
      const d = join(home, '.gemini', 'tmp', slug, 'chats');
      mkdirSync(d, { recursive: true });
      return d;
    },
    projects(map) {
      writeFileSync(join(home, '.gemini', 'projects.json'), JSON.stringify({ projects: map }));
    },
  });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const mod = await import(`../bin/lib/ingest.mjs?case=${caseSeq}`);
    return mod.parseGemini();
  } finally {
    process.env.HOME = prevHome;
  }
}

const CHAT_A = [
  chatHeader('11111111-1111-4111-8111-111111111111', '2026-06-01T09:43:46.724Z'),
  snapshotLine('deadbeefdeadbeefdeadbeefdeadbeef', '2026-06-01T09:43:46.724Z', 'first prompt of the session'),
  heartbeatLine('2026-06-01T09:44:00.000Z'),
  geminiLine('22222222-2222-4222-8222-222222222222', '2026-06-01T09:44:01.000Z', 'model answer one', [
    { id: 'c1', name: 'read_file', displayName: 'ReadFile', args: {}, status: 'success', result: 'x', timestamp: '2026-06-01T09:44:02.000Z' },
  ]),
  toolResultLine('22222222-2222-4222-8222-222222222222', '2026-06-01T09:44:03.000Z'),
  userLine('33333333-3333-4333-8333-333333333333', '2026-06-01T09:45:00.000Z', 'second prompt'),
  geminiLine('44444444-4444-4444-8444-444444444444', '2026-06-01T09:45:10.000Z', 'model answer two'),
  heartbeatLine('2026-06-01T09:45:11.000Z'),
].join('\n') + '\n';

const CHAT_B = [
  chatHeader('55555555-5555-4555-8555-555555555555', '2026-07-04T18:38:11.894Z'),
  snapshotLine('cafebabecafebabecafebabecafebabe', '2026-07-04T18:38:11.894Z', 'other project prompt'),
  infoLine('66666666-6666-4666-8666-666666666666', '2026-07-04T18:38:12.000Z', 'context note'),
].join('\n') + '\n';

const SHARED_SID = '77777777-7777-4777-8777-777777777777';
const LEGACY_LOGS = [
  { sessionId: SHARED_SID, messageId: 1, type: 'user', message: 'legacy prompt two', timestamp: '2026-05-29T07:26:00.000Z' },
  { sessionId: SHARED_SID, messageId: 0, type: 'user', message: 'legacy prompt one', timestamp: '2026-05-29T07:25:33.148Z' },
];
const CHAT_SHARED = [
  chatHeader(SHARED_SID, '2026-05-29T07:25:33.148Z'),
  snapshotLine('0123456789abcdef0123456789abcdef', '2026-05-29T07:25:33.148Z', 'legacy prompt one'),
  geminiLine('88888888-8888-4888-8888-888888888888', '2026-05-29T07:25:40.000Z', 'model answer only in the new format'),
].join('\n') + '\n';

// ─────────────────────────────── run ────────────────────────────────────────
rmSync(ROOT, { recursive: true, force: true });
const cases = [];

// 1. NEW FORMAT ONLY — the regression that motivated this file.
cases.push(async () => {
  const items = await runCase(({ chatsDir, projects }) => {
    projects({ '/Users/x/dev/acme/server': 'server', '/Users/x/dev/Brain': 'brain-claude-mem' });
    writeFileSync(join(chatsDir('server'), 'session-2026-06-01T09-43-11111111.jsonl'), CHAT_A);
    writeFileSync(join(chatsDir('brain-claude-mem'), 'session-2026-07-04T18-38-55555555.jsonl'), CHAT_B);
  });
  t('new format: both chats sessions are captured', () => eq(items.length, 2, 'session count'));
  t('new format: sorted newest first', () =>
    eq(items[0].sid, '55555555-5555-4555-8555-555555555555', 'first item should be the July session'));

  const a = items.find((i) => i.sid === '11111111-1111-4111-8111-111111111111');
  t('new format: session id comes from the header', () => assert(a, 'header sessionId not used as sid'));
  t('new format: ts comes from header.startTime', () => eq(a.ts, '2026-06-01T09:43:46.724Z', 'ts'));
  t('new format: project resolves through projects.json', () => eq(a.project, 'server', 'project'));
  t('new format: title is the first user prompt', () => eq(a.title, 'first prompt of the session', 'title'));
  t('new format: prompts = user text turns only (snapshot + appended)', () =>
    eq(JSON.stringify(a.prompts), JSON.stringify(['first prompt of the session', 'second prompt']), 'prompts'));
  t('new format: functionResponse turns are NOT treated as prompts', () =>
    assert(!a.prompts.some((p) => /irrelevant|functionResponse/.test(p)), 'tool result leaked into prompts'));
  t('new format: transcript keeps model output', () =>
    assert(a.transcript.includes('gemini: model answer one') && a.transcript.includes('gemini: model answer two'),
      'model turns missing from transcript'));
  t('new format: transcript records tool names but not args/results', () =>
    assert(a.transcript.includes('tool: read_file') && !a.transcript.includes('irrelevant'),
      'tool call rendering wrong'));
  t('new format: info turns are kept in the transcript', () => {
    const b = items.find((i) => i.sid === '55555555-5555-4555-8555-555555555555');
    assert(b.transcript.includes('info: context note'), 'info turn missing');
  });
  t('new format: every item matches the PARSERS item contract', () => {
    for (const i of items) {
      for (const k of ['sid', 'project', 'title', 'transcript', 'ts', 'prompts']) assert(k in i, `missing ${k}`);
      assert(typeof i.transcript === 'string' && i.transcript.length > 0, 'transcript must be a non-empty string');
      assert(Array.isArray(i.prompts), 'prompts must be an array');
    }
  });
});

// 2. OLD FORMAT ONLY — unchanged behaviour, byte-for-byte.
cases.push(async () => {
  const items = await runCase(({ slugDir, projects }) => {
    projects({ '/Users/x/dev/My Video App': 'my-video-app' });
    writeFileSync(join(slugDir('my-video-app'), 'logs.json'), JSON.stringify(LEGACY_LOGS));
  });
  t('old format: logs.json session still parsed', () => eq(items.length, 1, 'session count'));
  t('old format: sid from sessionId', () => eq(items[0].sid, SHARED_SID, 'sid'));
  t('old format: project from projects.json basename', () => eq(items[0].project, 'My Video App', 'project'));
  t('old format: prompts ordered by messageId', () =>
    eq(JSON.stringify(items[0].prompts), JSON.stringify(['legacy prompt one', 'legacy prompt two']), 'prompts'));
  t('old format: transcript shape is "type: message" (unchanged)', () =>
    eq(items[0].transcript, 'user: legacy prompt one\n\nuser: legacy prompt two', 'transcript'));
});

// 3. BOTH PRESENT — the real tmp/my-video-app case. Exactly one item per sid,
//    and the legacy bytes win so an already-ingested row's content_hash is stable.
cases.push(async () => {
  const items = await runCase(({ slugDir, chatsDir, projects }) => {
    projects({ '/Users/x/dev/My Video App': 'my-video-app' });
    writeFileSync(join(slugDir('my-video-app'), 'logs.json'), JSON.stringify(LEGACY_LOGS));
    const c = chatsDir('my-video-app');
    writeFileSync(join(c, 'session-2026-05-29T07-25-77777777.jsonl'), CHAT_SHARED);
    writeFileSync(join(c, 'session-2026-06-01T09-43-11111111.jsonl'), CHAT_A);
  });
  t('both formats: no duplicate sessions', () => {
    const sids = items.map((i) => i.sid);
    eq(sids.length, new Set(sids).size, `duplicate sids emitted: ${sids.join(', ')}`);
  });
  t('both formats: shared session emitted exactly once', () =>
    eq(items.filter((i) => i.sid === SHARED_SID).length, 1, 'shared session count'));
  t('both formats: chats-only session still captured alongside', () =>
    eq(items.length, 2, 'total sessions'));
  t('both formats: legacy transcript wins for the shared session (hash stability)', () => {
    const shared = items.find((i) => i.sid === SHARED_SID);
    eq(shared.transcript, 'user: legacy prompt one\n\nuser: legacy prompt two', 'shared transcript');
    assert(!shared.transcript.includes('model answer only in the new format'), 'new-format text overwrote legacy');
  });
});

// 4. MALFORMED / TRUNCATED input must degrade, never throw.
cases.push(async () => {
  const truncated = CHAT_A.trimEnd() + '\n' + '{"id":"99999999","timestamp":"2026-06-01T09:46:00.000Z","type":"user","content":[{"tex';
  const items = await runCase(({ slugDir, chatsDir }) => {
    const c = chatsDir('server');
    writeFileSync(join(c, 'session-2026-06-01T09-43-11111111.jsonl'), truncated);
    writeFileSync(join(c, 'session-2026-06-02T00-00-aaaaaaaa.jsonl'), 'not json at all\n{"also": broken\n');
    writeFileSync(join(c, 'session-2026-06-03T00-00-bbbbbbbb.jsonl'), '');
    writeFileSync(join(c, 'ignore-me.txt'), 'not a session file');
    // a non-array logs.json must not kill the whole parse either
    writeFileSync(join(slugDir('broken'), 'logs.json'), '{"not":"an array"}');
    writeFileSync(join(slugDir('worse'), 'logs.json'), '{{{ truncated');
  });
  t('malformed: truncated last line is skipped, session still parsed', () => {
    eq(items.length, 1, 'only the recoverable session should survive');
    eq(items[0].sid, '11111111-1111-4111-8111-111111111111', 'sid');
    eq(JSON.stringify(items[0].prompts),
      JSON.stringify(['first prompt of the session', 'second prompt']), 'prompts from the intact lines');
  });
  t('malformed: unparseable + empty chat files are skipped, not fatal', () =>
    assert(!items.some((i) => /aaaaaaaa|bbbbbbbb/.test(i.sid)), 'garbage file produced an item'));
  t('malformed: non-.jsonl files in chats/ are ignored', () =>
    assert(!items.some((i) => i.sid.includes('ignore-me')), 'non-jsonl file parsed'));
});

// 5. Empty / absent directories.
cases.push(async () => {
  const items = await runCase(({ chatsDir, slugDir }) => {
    chatsDir('empty-chats');
    slugDir('no-chats-dir');
  });
  t('empty: empty chats dir yields no items and does not throw', () => eq(items.length, 0, 'items'));

  const none = await runCase(() => {});
  t('empty: tmp/ with no projects yields no items', () => eq(none.length, 0, 'items'));
});

// 6. Fallbacks: no projects.json → .project_root, then the slug.
cases.push(async () => {
  const items = await runCase(({ chatsDir, slugDir }) => {
    writeFileSync(join(slugDir('renders'), '.project_root'), '/Users/x/dev/My Video App/v1/renders\n');
    writeFileSync(join(chatsDir('renders'), 'session-2026-06-01T09-43-11111111.jsonl'), CHAT_A);
    writeFileSync(join(chatsDir('nameless'), 'session-2026-07-04T18-38-55555555.jsonl'), CHAT_B);
  });
  t('fallback: project from .project_root basename when projects.json is absent', () =>
    eq(items.find((i) => i.sid === '11111111-1111-4111-8111-111111111111').project, 'renders', 'project'));
  t('fallback: project is the slug when nothing else is available', () =>
    eq(items.find((i) => i.sid === '55555555-5555-4555-8555-555555555555').project, 'nameless', 'project'));
});

// 7. IDEMPOTENCE — re-parsing identical input must produce identical items, so the
//    INSERT OR IGNORE path (ux_observations_session_hash = memory_session_id +
//    content_hash over the transcript) inserts nothing on the launchd re-run.
cases.push(async () => {
  const build = ({ slugDir, chatsDir, projects }) => {
    projects({ '/Users/x/dev/My Video App': 'my-video-app' });
    writeFileSync(join(slugDir('my-video-app'), 'logs.json'), JSON.stringify(LEGACY_LOGS));
    const c = chatsDir('my-video-app');
    writeFileSync(join(c, 'session-2026-05-29T07-25-77777777.jsonl'), CHAT_SHARED);
    writeFileSync(join(c, 'session-2026-06-01T09-43-11111111.jsonl'), CHAT_A);
  };
  const first = await runCase(build);
  const second = await runCase(build);
  t('idempotence: a second parse of identical input is byte-identical', () =>
    eq(JSON.stringify(second), JSON.stringify(first), 'parse output drifted between runs'));
  t('idempotence: sids are stable across runs (no derived-from-mtime ids)', () =>
    eq(second.map((i) => i.sid).sort().join(','), first.map((i) => i.sid).sort().join(','), 'sids'));
});

// 8. The scrub choke point must still wrap this parser (spec: scrub BEFORE hash()).
cases.push(async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../bin/lib/ingest.mjs', import.meta.url), 'utf8'));
  t('contract: parseGemini is still routed through scrubItem via RAW_PARSERS', () => {
    assert(/RAW_PARSERS\s*=\s*\{[^}]*gemini:\s*parseGemini/.test(src), 'gemini missing from RAW_PARSERS');
    assert(/Object\.entries\(RAW_PARSERS\)[\s\S]*fn\(\)\.map\(scrubItem\)/.test(src),
      'parsers are no longer wrapped with scrubItem — content_hash would desync from the scrubbed text');
  });
});

for (const c of cases) await c();
rmSync(ROOT, { recursive: true, force: true });

console.log(`\ningest-gemini-test: ${pass} passed, ${fail} failed\n`);
for (const [status, name, msg] of results) {
  console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}${msg ? `\n      ${msg}` : ''}`);
}
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
if (fail > 0) process.exit(1);
