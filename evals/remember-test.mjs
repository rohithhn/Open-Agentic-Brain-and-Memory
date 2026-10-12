#!/usr/bin/env node
// Acceptance test for bin/lib/remember.mjs (the `brain_remember` write path)
// and bin/lib/scrub.mjs's scrubObservation().  Run: node evals/remember-test.mjs
//
// SAFETY CONTRACT for this file:
//   • Every DB it touches is a synthetic fixture created under the scratchpad
//     directory via an explicit path argument. It NEVER opens ~/.claude-brain/
//     brain.db or ~/.claude-mem/claude-mem.db — not even read-only.
//   • The "secrets" below are FAKE: structurally valid shapes built from
//     keyboard-mashed characters, so the detectors fire. No real credential,
//     nor any value derived from one, appears anywhere in this file.
//   • Nothing prints an observation's content or a (fake) credential value —
//     assertions report ids, counts and detector names only.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../bin/lib/store.mjs';
import { scrubObservation, scrubObservationWithHits } from '../bin/lib/scrub.mjs';
import {
  rememberObservation,
  validateObservation,
  canonicalHash,
  normalizeTitle,
  platformSourceFor,
  modelProvenance,
  newMcpSession,
  projectScopedSession,
  OBSERVATION_TYPES,
  REMEMBER_INPUT_SCHEMA,
  MCP_CAPTURE_CONCEPT,
  mergeFacts,
  LIMITS,
} from '../bin/lib/remember.mjs';

// ── harness ──────────────────────────────────────────────────────────────────
let passed = 0;
let failures = 0;
const groups = new Map();
let group = 'general';
function section(name) { group = name; if (!groups.has(name)) groups.set(name, { pass: 0, fail: 0 }); }
function ok(cond, msg) {
  const g = groups.get(group) || (groups.set(group, { pass: 0, fail: 0 }), groups.get(group));
  if (cond) { passed++; g.pass++; }
  else { failures++; g.fail++; console.log(`  ✗ [${group}] ${msg}`); }
}
const eq = (a, b, msg) => ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

// ── scratchpad-only fixture DBs ──────────────────────────────────────────────
const SCRATCH =
  process.env.BRAIN_TEST_SCRATCH ||
  '';
const ROOT = existsSync(SCRATCH) ? mkdtempSync(join(SCRATCH, 'remember-')) : mkdtempSync(join(tmpdir(), 'remember-'));

let dbSeq = 0;
function freshDb() {
  const p = join(ROOT, `fixture-${++dbSeq}.db`);
  const db = openStore({ path: p }); // creates schema + FTS triggers
  db.close();
  return p;
}
const read = (p) => new DatabaseSync(p, { readOnly: true, open: true });
const rowCount = (p, t) => { const d = read(p); try { return d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } finally { d.close(); } };
const allObs = (p) => { const d = read(p); try { return d.prepare('SELECT * FROM observations ORDER BY id').all(); } finally { d.close(); } };

// ── FAKE credentials (see safety contract above) ─────────────────────────────
const FAKE_GH_TOKEN = 'ghp_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY2z4A';
const FAKE_GH_TOKEN_2 = 'ghp_' + 'zY4xW2vU9tS7rQ5pN3mL1kJ9hG7fE5dB3aC6';
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);
const SESSION = newMcpSession('claude_desktop', NOW);

const base = (over = {}) => ({
  title: 'Native store went live for the brain',
  subtitle: 'READY marker gates every reader',
  project: 'brain-fixture',
  type: 'discovery',
  facts: ['MEMORY_DB now resolves to the native store', 'The READY marker is the gate'],
  narrative: 'The importer verified row counts, then wrote the READY marker.',
  concepts: ['native-store'],
  model: 'claude-opus-4-6',
  ...over,
});
const call = (input, opts = {}) =>
  rememberObservation(input, { session: SESSION, clientName: 'Claude Desktop', now: NOW, log: () => {}, ...opts });

// ═════════════════════════════════════════════════════════════════════════════
// 1. Schema / validation
// ═════════════════════════════════════════════════════════════════════════════
section('validation');
ok(REMEMBER_INPUT_SCHEMA.additionalProperties === false, 'schema forbids additional properties');
ok(
  ['title', 'project', 'type', 'facts'].every((k) => REMEMBER_INPUT_SCHEMA.required.includes(k)),
  'schema requires title/project/type/facts'
);
eq(OBSERVATION_TYPES.join(','), 'discovery,change,bugfix,feature,refactor,decision', 'type enum matches the live vocabulary');

ok(validateObservation(base()).ok, 'a well-formed observation validates');
ok(!validateObservation(base({ title: 'short' })).ok, 'title under 8 chars rejected');
ok(!validateObservation(base({ title: 'x'.repeat(201) })).ok, 'title over 200 chars rejected');
ok(!validateObservation(base({ type: 'rumination' })).ok, 'type outside the enum rejected');
ok(!validateObservation(base({ facts: [] })).ok, 'empty facts rejected');
ok(!validateObservation(base({ facts: Array(13).fill('a fact') })).ok, '13 facts rejected');
ok(!validateObservation(base({ facts: 'not an array' })).ok, 'non-array facts rejected');
ok(!validateObservation(base({ facts: ['x'.repeat(501)] })).ok, 'fact over 500 chars rejected');
ok(!validateObservation(base({ concepts: Array(11).fill('c') })).ok, '11 concepts rejected');
ok(!validateObservation(base({ narrative: 'x'.repeat(2001) })).ok, 'narrative over 2000 chars rejected');
ok(!validateObservation(base({ nope: 1 })).ok, 'unknown property rejected');
ok(!validateObservation(null).ok, 'null input rejected');
ok(!validateObservation('a string').ok, 'string input rejected');
{
  const r = validateObservation({ title: 'x'.repeat(9), project: 'p', type: 'bugfix', facts: ['f'] });
  ok(r.ok && r.value.subtitle === undefined && r.value.concepts.length === 0, 'optional fields default cleanly');
  // Error text must never echo a value — it may be the credential we scrub next.
  const bad = validateObservation(base({ facts: [FAKE_GH_TOKEN, 'x'.repeat(501)] }));
  ok(!bad.ok && !bad.errors.join(' ').includes(FAKE_GH_TOKEN), 'validation errors never echo field values');
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Provenance mapping
// ═════════════════════════════════════════════════════════════════════════════
section('provenance');
eq(platformSourceFor('Claude Desktop'), 'claude_desktop', 'Claude Desktop → claude_desktop');
// Real clientInfo names (from ~/Library/Logs/Claude/mcp-server-*.log and the
// claude-cli MCP logs): exact names beat the "claude" substring.
eq(platformSourceFor('claude-ai'), 'claude_desktop', 'claude-ai (Claude Desktop) → claude_desktop');
eq(platformSourceFor('claude-code'), 'claude_code', 'claude-code → claude_code, not claude_desktop');
eq(platformSourceFor('Claude Code'), 'claude_code', 'Claude Code (title form) → claude_code');
eq(platformSourceFor('local-agent-mode-agentic-brain'), 'claude_desktop_agent', 'local-agent-mode-* → claude_desktop_agent (Claude Desktop Cowork, not Claude Code)');
eq(platformSourceFor('local-agent-mode-whatever-else'), 'claude_desktop_agent', 'any local-agent-mode-* server → claude_desktop_agent');
eq(platformSourceFor('Local-Agent-Mode-X'), 'claude_desktop_agent', 'local-agent-mode is case-insensitive');
eq(platformSourceFor('codex-mcp-client'), 'codex', 'codex-mcp-client → codex');
eq(platformSourceFor('claude-code-vscode'), 'claude_code', 'substring fallback: claude-code-* → claude_code');
eq(platformSourceFor('claude-something-new'), 'claude_desktop', 'unknown claude* falls back to desktop (insistent instructions)');
eq(platformSourceFor('  CLAUDE-CODE  '), 'claude_code', 'case/whitespace insensitive');
eq(platformSourceFor('ChatGPT'), 'chatgpt_desktop', 'ChatGPT → chatgpt_desktop');
eq(platformSourceFor('chatgpt-desktop (claude-compatible)'), 'chatgpt_desktop', 'chatgpt wins over claude');
eq(platformSourceFor('codex-cli'), 'codex', 'codex-cli → codex');
eq(platformSourceFor('Cursor'), 'cursor', 'Cursor → cursor');
eq(platformSourceFor('gemini-cli-mcp-client'), 'mcp_gemini_cli_mcp_client', 'Gemini CLI is unsupported: no gemini bucket');
eq(platformSourceFor('Antigravity'), 'antigravity', 'Antigravity → antigravity');
eq(platformSourceFor('Some New Client 2.0'), 'mcp_some_new_client_2_0', 'unknown client → mcp_<sanitized>');
eq(platformSourceFor(''), 'mcp_unknown', 'missing client name → mcp_unknown');
eq(platformSourceFor(undefined), 'mcp_unknown', 'undefined client name → mcp_unknown');

eq(modelProvenance({ model: 'claude-opus-4-6' }), 'mcp/claude-opus-4-6', 'model id keeps its hyphens under the mcp/ prefix');
eq(modelProvenance({ clientName: 'ChatGPT' }), 'mcp/ChatGPT', 'falls back to clientInfo.name');
eq(modelProvenance({}), 'mcp/unknown', 'falls back to unknown');
eq(modelProvenance({ model: 'mcp/haiku' }), 'mcp/haiku', 'never double-prefixes');
// The six values the live store already contains must stay disjoint forever.
for (const existing of ['claude-haiku-4-5-20251001', 'haiku', 'gemini', 'cursor', 'codex', 'antigravity', 'claude']) {
  ok(modelProvenance({ model: existing }) !== existing, `mcp/ prefix keeps rows disjoint from "${existing}"`);
  ok(!existing.startsWith('mcp/'), `existing value "${existing}" cannot be mistaken for an MCP row`);
}
{
  const s = newMcpSession('chatgpt_desktop', NOW);
  ok(/^mcp-\d+-[0-9a-f]{6}$/.test(s.contentSessionId), 'content_session_id shape is mcp-<epoch>-<6 hex>');
  eq(s.memorySessionId, `mcp:chatgpt_desktop:${s.contentSessionId}`, 'memory_session_id encodes the platform source');
  ok(newMcpSession('x').contentSessionId !== newMcpSession('x').contentSessionId, 'session ids are unique per mint');
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Happy path — one row, correct columns
// ═════════════════════════════════════════════════════════════════════════════
section('happy path');
{
  const db = freshDb();
  const before = rowCount(db, 'observations');
  const r = await call(base(), { dbPath: db });
  eq(r.ok, true, 'result is ok');
  eq(r.status, 'saved', 'status is saved');
  eq(r.saved, true, 'saved flag set');
  eq(r.project, 'brain-fixture', 'project echoed back');
  ok(Number.isInteger(r.id) && r.id > 0, 'a row id is returned');
  eq(rowCount(db, 'observations') - before, 1, 'exactly one observation row written');
  eq(rowCount(db, 'sdk_sessions'), 1, 'exactly one session row written');
  eq(rowCount(db, 'user_prompts'), 0, 'no user_prompts rows are ever faked');

  const row = allObs(db)[0];
  eq(row.memory_session_id, SESSION.memorySessionId, 'observation carries the MCP session id');
  eq(row.type, 'discovery', 'type stored');
  eq(row.generated_by_model, 'mcp/claude-opus-4-6', 'generated_by_model is mcp/-prefixed');
  eq(row.prompt_number, 0, 'prompt_number is 0');
  eq(row.relevance_count, 0, 'relevance_count starts at 0');
  eq(row.text, base().narrative, 'text = narrative (so FTS and every text reader work)');
  eq(JSON.parse(row.facts).length, 2, 'facts stored as a JSON array');
  ok(JSON.parse(row.concepts).includes(MCP_CAPTURE_CONCEPT), 'mcp-capture concept appended');
  ok(JSON.parse(row.concepts).includes('native-store'), 'model-supplied concepts preserved');
  eq(row.content_hash, canonicalHash(scrubObservation(validateObservation(base()).value)), 'content_hash is the canonical hash');

  const sess = read(db);
  const s = sess.prepare('SELECT * FROM sdk_sessions').get();
  sess.close();
  eq(s.platform_source, 'claude_desktop', 'session platform_source mapped from clientInfo');
  eq(s.content_session_id, SESSION.contentSessionId, 'session content id stored');
  eq(s.status, 'completed', 'session status completed');
  eq(s.user_prompt, null, 'no user prompt is invented');

  // text falls back to facts when there is no narrative
  const r2 = await call(base({ title: 'A second distinct observation title', narrative: undefined, facts: ['alpha', 'beta'] }), { dbPath: db });
  eq(r2.status, 'saved', 'second distinct observation saved');
  const row2 = allObs(db).find((o) => o.id === r2.id);
  eq(row2.text, 'alpha\nbeta', 'text falls back to facts.join(\\n)');
  eq(rowCount(db, 'sdk_sessions'), 1, 'the per-process session row is not duplicated');

  // FTS stays in sync (the store's triggers must see our INSERT)
  const f = read(db);
  const n = f.prepare("SELECT COUNT(*) n FROM observations_fts WHERE observations_fts MATCH 'READY'").get().n;
  f.close();
  ok(n >= 1, 'the new row is searchable in observations_fts');
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Scrub before hash — the core safety property
// ═════════════════════════════════════════════════════════════════════════════
section('scrub-before-hash');
{
  // scrubObservation covers every free-text field.
  const dirty = {
    title: `Token ${FAKE_GH_TOKEN} rotated`,
    subtitle: `old was ${FAKE_GH_TOKEN}`,
    narrative: `We replaced ${FAKE_GH_TOKEN} everywhere.`,
    facts: ['clean fact', `the value was ${FAKE_GH_TOKEN}`],
    concepts: ['tag', FAKE_GH_TOKEN],
    project: 'p',
    type: 'bugfix',
  };
  const clean = scrubObservation(dirty);
  for (const field of ['title', 'subtitle', 'narrative']) {
    ok(!clean[field].includes(FAKE_GH_TOKEN), `scrubObservation redacts ${field}`);
    ok(clean[field].includes('[REDACTED:github-token]'), `${field} carries the typed marker`);
  }
  ok(!clean.facts.join('|').includes(FAKE_GH_TOKEN), 'scrubObservation redacts facts[]');
  ok(!clean.concepts.join('|').includes(FAKE_GH_TOKEN), 'scrubObservation redacts concepts[]');
  eq(clean.facts[0], 'clean fact', 'clean facts pass through untouched');
  eq(clean.project, 'p', 'project is not rewritten');
  eq(clean.type, 'bugfix', 'type is not rewritten');
  eq(dirty.title.includes(FAKE_GH_TOKEN), true, 'input object is never mutated');
  ok(scrubObservationWithHits(dirty).hits.some((h) => h.detector === 'github-token'), 'hits report the detector id');
  ok(!JSON.stringify(scrubObservationWithHits(dirty).hits).includes(FAKE_GH_TOKEN), 'hits never carry the value');

  // End-to-end: the planted fake secret never reaches the DB, and the stored
  // content_hash is the hash of the SCRUBBED text (not the raw text).
  const db = freshDb();
  const input = base({ title: 'Rotated the CI deploy token', facts: ['rotation done', `old token was ${FAKE_GH_TOKEN}`], narrative: `Replaced ${FAKE_GH_TOKEN} in CI.` });
  const r = await call(input, { dbPath: db });
  eq(r.status, 'saved', 'observation with a planted secret still saves');

  const d = read(db);
  const dump = JSON.stringify(d.prepare('SELECT * FROM observations').all()) + JSON.stringify(d.prepare('SELECT * FROM sdk_sessions').all());
  const ftsHit = d.prepare("SELECT COUNT(*) n FROM observations_fts WHERE observations_fts MATCH ?").get(FAKE_GH_TOKEN.slice(4, 20)).n;
  d.close();
  ok(!dump.includes(FAKE_GH_TOKEN), 'the planted secret is absent from every stored column');
  ok(!dump.includes(FAKE_GH_TOKEN.slice(4, 24)), 'no 20-char substring of the secret survives');
  ok(dump.includes('[REDACTED:github-token]'), 'the typed redaction marker is what was stored');
  eq(ftsHit, 0, 'the secret is not searchable in the FTS shadow table either');

  const stored = allObs(db)[0];
  const scrubbed = scrubObservation(validateObservation(input).value);
  eq(stored.content_hash, canonicalHash(scrubbed), 'stored content_hash matches the hash of the SCRUBBED text');
  ok(stored.content_hash !== canonicalHash(validateObservation(input).value), 'and differs from the hash of the raw text');

  // Two observations differing ONLY in the secret's value scrub to the same
  // canonical text — so the second must dedupe rather than create a twin row.
  const r2 = await call(base({ title: 'Rotated the CI deploy token', facts: ['rotation done', `old token was ${FAKE_GH_TOKEN_2}`], narrative: `Replaced ${FAKE_GH_TOKEN_2} in CI.` }), { dbPath: db });
  eq(r2.status, 'duplicate', 'scrub-before-hash makes two different secrets dedupe to one row');
  eq(rowCount(db, 'observations'), 1, 'no twin row was created');

  // stdout purity: this module must never write to the JSON-RPC channel.
  const realWrite = process.stdout.write.bind(process.stdout);
  let stdoutBytes = 0;
  process.stdout.write = (chunk, ...rest) => { stdoutBytes += Buffer.byteLength(String(chunk)); return realWrite(chunk, ...rest); };
  try {
    await rememberObservation(base({ title: 'Another secret bearing observation', facts: [`token ${FAKE_GH_TOKEN}`] }), { dbPath: db, session: SESSION, now: NOW });
  } finally {
    process.stdout.write = realWrite;
  }
  eq(stdoutBytes, 0, 'rememberObservation writes nothing to stdout (diagnostics go to stderr)');
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Dedupe — counts can never inflate
// ═════════════════════════════════════════════════════════════════════════════
section('dedupe');
{
  const db = freshDb();
  const r1 = await call(base(), { dbPath: db });
  eq(r1.status, 'saved', 'first write saves');

  // Exact duplicate — identical content, and a DIFFERENT session (every app
  // launch is a fresh process, so the session-scoped unique index can't help).
  const other = newMcpSession('chatgpt_desktop', NOW + 1000);
  const r2 = await call(base(), { dbPath: db, session: other });
  eq(r2.status, 'duplicate', 'exact duplicate across sessions is detected');
  eq(r2.saved, false, 'duplicate reports saved:false');
  eq(r2.reason, 'duplicate', 'duplicate reason is set');
  eq(r2.id, r1.id, 'duplicate points at the original row');
  eq(rowCount(db, 'observations'), 1, 'no second row inserted');
  eq(allObs(db)[0].relevance_count, 1, 'relevance_count incremented to 1');

  const r3 = await call(base(), { dbPath: db });
  eq(r3.status, 'duplicate', 'third capture is still a duplicate');
  eq(rowCount(db, 'observations'), 1, 'still one row');
  eq(allObs(db)[0].relevance_count, 2, 'relevance_count incremented to 2');

  // Whitespace-only differences are the same content (canonical normalization).
  const r4 = await call(base({ title: '  Native   store went live for the   brain ' }), { dbPath: db });
  eq(r4.status, 'duplicate', 'whitespace-only title differences are the same observation');
  eq(rowCount(db, 'observations'), 1, 'whitespace variant inserted nothing');

  // Near-duplicate: same project + same normalized title, different facts,
  // 12h later → merge into the existing row, never a second row.
  const near = await call(base({ facts: ['a completely different fact'], narrative: 'Different story entirely.' }), {
    dbPath: db,
    now: NOW + 12 * 3600 * 1000,
  });
  eq(near.status, 'merged', 'near-duplicate within 72h merges');
  eq(near.merged, true, 'merged flag set');
  eq(near.saved, true, 'merged reports saved:true per spec');
  eq(near.id, r1.id, 'merged into the original row');
  eq(rowCount(db, 'observations'), 1, 'near-duplicate inserted nothing');
  eq(allObs(db)[0].relevance_count, 4, 'relevance_count incremented by the merge');

  // Case-insensitive title normalization still merges.
  const nearCase = await call(base({ title: 'NATIVE STORE WENT LIVE FOR THE BRAIN', facts: ['yet another fact'] }), {
    dbPath: db,
    now: NOW + 3600 * 1000,
  });
  eq(nearCase.status, 'merged', 'title normalization is case-insensitive');
  eq(rowCount(db, 'observations'), 1, 'case variant inserted nothing');

  // Same title 73h later → a genuinely separate row.
  const far = await call(base({ facts: ['a fact from three days later'], narrative: 'Three days later.' }), {
    dbPath: db,
    now: NOW + 73 * 3600 * 1000,
  });
  eq(far.status, 'saved', 'same title outside the 72h window is a new observation');
  eq(rowCount(db, 'observations'), 2, 'a second row now exists');
  ok(far.id !== r1.id, 'the new row has its own id');
  eq(allObs(db)[0].relevance_count, 5, 'the original row was not touched by the far write');

  // Dedupe is per-project: identical content in another project is its own row.
  const otherProject = await call(base({ project: 'a-different-project' }), { dbPath: db });
  eq(otherProject.status, 'saved', 'identical content in another project is a separate row');
  eq(rowCount(db, 'observations'), 3, 'three rows total');
  // Two session rows only: the process session, plus the project-scoped sibling
  // minted for the cross-project row. Duplicate/merge paths mint nothing.
  eq(rowCount(db, 'sdk_sessions'), 2, 'the cross-project row got a deterministic project-scoped sibling session');
  eq(
    projectScopedSession(SESSION, 'a-different-project').memorySessionId,
    projectScopedSession(SESSION, 'a-different-project').memorySessionId,
    'projectScopedSession is deterministic (no session growth on repeat writes)'
  );

  // Total accounting: 9 write calls, 3 rows. Counts never inflated.
  eq(rowCount(db, 'observations'), 3, '8 write calls produced exactly 3 rows');
}

// ═════════════════════════════════════════════════════════════════════════════
// 5b. Near-dup merge keeps the incoming facts (append the ones not already present)
// ═════════════════════════════════════════════════════════════════════════════
section('merge facts');
{
  // pure helper
  const m = mergeFacts(['a one', 'b two'], ['A  ONE', 'c three', '  ', 'c THREE', 7, 'd four']);
  eq(JSON.stringify(m.facts), JSON.stringify(['a one', 'b two', 'c three', 'd four']), 'mergeFacts: appends only new facts (case/whitespace-insensitive, order kept)');
  eq(m.added, 2, 'mergeFacts: counts what it added');
  const full = Array.from({ length: LIMITS.facts.max }, (_, i) => `existing fact number ${i}`);
  const capped = mergeFacts(full, ['one more fact', 'and another']);
  eq(capped.facts.length, LIMITS.facts.max, 'mergeFacts: never exceeds the 12-fact cap');
  eq(capped.dropped, 2, 'mergeFacts: reports the overflow it dropped');
  const longOne = mergeFacts([], ['x'.repeat(LIMITS.fact.max + 100)]);
  eq(longOne.facts[0].length, LIMITS.fact.max, 'mergeFacts: a new fact is held to 500 chars');

  // end to end
  const db = freshDb();
  const r1 = await call(base(), { dbPath: db });
  const hash0 = allObs(db)[0].content_hash;
  const later = NOW + 12 * 3600 * 1000;
  const near = await call(
    base({ facts: ['The READY marker is the gate', 'a completely different fact', 'one more new fact'], narrative: 'Different story entirely.', concepts: ['other'] }),
    { dbPath: db, now: later }
  );
  eq(near.status, 'merged', 'near-dup merges');
  eq(near.id, r1.id, 'merged into the original row');
  eq(near.factsAdded, 2, 'result reports how many facts were appended');
  let row = allObs(db)[0];
  eq(
    JSON.stringify(JSON.parse(row.facts)),
    JSON.stringify(['MEMORY_DB now resolves to the native store', 'The READY marker is the gate', 'a completely different fact', 'one more new fact']),
    'incoming facts not already present were appended; the duplicate fact was not'
  );
  eq(row.narrative, 'The importer verified row counts, then wrote the READY marker.', 'existing narrative wins');
  eq(row.relevance_count, 1, 'relevance_count bumped once');
  eq(row.content_hash, hash0, 'content_hash is NOT recomputed by a merge (row identity stays as first written)');
  eq(rowCount(db, 'observations'), 1, 'still one row');

  // The original capture is still an exact duplicate afterwards (the point of keeping the hash).
  const again = await call(base(), { dbPath: db, now: later + 1000 });
  eq(again.status, 'duplicate', 're-sending the original after a merge is still an exact duplicate');

  // Merging the same facts again adds nothing.
  const same = await call(base({ facts: ['a completely different fact'], narrative: 'x' }), { dbPath: db, now: later + 2000 });
  eq(same.status, 'merged', 'second merge is still a merge');
  eq(same.factsAdded, 0, 'nothing new to add');
  eq(JSON.parse(allObs(db)[0].facts).length, 4, 'no facts re-added');

  // Overflow is bounded at 12 facts.
  const many = Array.from({ length: 12 }, (_, i) => `overflow fact number ${i}`);
  const over = await call(base({ facts: many, narrative: 'y' }), { dbPath: db, now: later + 3000 });
  eq(over.status, 'merged', 'overflow write merges');
  eq(JSON.parse(allObs(db)[0].facts).length, LIMITS.facts.max, 'merged row holds at most 12 facts');
  eq(over.factsAdded, 8, '8 slots were free');
  eq(over.factsDropped, 4, 'the rest were dropped, reported');
  ok(JSON.parse(allObs(db)[0].facts).every((f) => f.length <= LIMITS.fact.max), 'every fact within 500 chars');

  // Secrets in merged facts are scrubbed before they are appended.
  const db2 = freshDb();
  await call(base(), { dbPath: db2 });
  await call(base({ facts: [`rotated the token ${FAKE_GH_TOKEN}`], narrative: 'z' }), { dbPath: db2, now: later });
  const stored = JSON.stringify(JSON.parse(allObs(db2)[0].facts));
  ok(!stored.includes(FAKE_GH_TOKEN) && stored.includes('[REDACTED:github-token]'), 'a secret in a merged fact is redacted, not stored');

  // text mirrors facts on a narrative-less row.
  const db3 = freshDb();
  await call(base({ narrative: undefined }), { dbPath: db3 });
  await call(base({ narrative: undefined, facts: ['fresh fact for text'] }), { dbPath: db3, now: later });
  row = allObs(db3)[0];
  ok(row.text.includes('fresh fact for text'), 'text (facts mirror) stays in step on a narrative-less row');

  // A foreign row whose facts cell is not a JSON array of strings is left alone (relevance only).
  const db4 = freshDb();
  await call(base(), { dbPath: db4 });
  { const w = new DatabaseSync(db4); w.prepare("UPDATE observations SET facts = 'not json at all'").run(); w.close(); }
  const odd = await call(base({ facts: ['whatever new fact'], narrative: 'q' }), { dbPath: db4, now: later });
  eq(odd.status, 'merged', 'foreign-format row still merges');
  eq(odd.factsAdded, 0, 'foreign-format facts untouched');
  eq(allObs(db4)[0].facts, 'not json at all', 'foreign facts cell preserved byte for byte');
}

// ═════════════════════════════════════════════════════════════════════════════
// 5c. Tier 5 (generic high entropy) is review-only at capture
// ═════════════════════════════════════════════════════════════════════════════
section('tier 5 review-only');
{
  const T5 = 'Xq9#mR2$vK7!pL4@wN8&zT1^yB6*cJ3%hG5';
  const db = freshDb();
  const logs = [];
  const r = await call(base({ title: 'Webhook signing value rotated', facts: [`The webhook signing value was ${T5} and had to be rotated`] }), { dbPath: db, log: (m) => logs.push(m) });
  eq(r.status, 'saved', 'saves');
  const f = JSON.parse(allObs(db)[0].facts)[0];
  ok(f.includes(T5), 'a tier-5 candidate is NOT redacted at capture');
  ok(logs.some((m) => /high-entropy candidate/.test(m)), 'it is reported (count only) on the log');
  ok(!logs.some((m) => m.includes(T5)), 'the log never carries the value');
  const { review, hits } = scrubObservationWithHits(validateObservation(base({ facts: [`signing value ${T5}`] })).value);
  ok(review.length === 1 && review[0].detector === 'high-entropy-secret' && review[0].field === 'facts[0]' && hits.length === 0, 'scrubObservationWithHits reports it under review, not hits');
  // tier 1 is still redacted next to it
  const mix = scrubObservationWithHits(validateObservation(base({ facts: [`signing value ${T5}`, `gh ${FAKE_GH_TOKEN}`] })).value);
  ok(mix.hits.length === 1 && mix.review.length === 1 && mix.obs.facts[0].includes(T5) && !mix.obs.facts[1].includes(FAKE_GH_TOKEN), 'tier 1 still redacts alongside a review-only tier-5 candidate');
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. Failure paths — structured errors, never a throw, never a partial write
// ═════════════════════════════════════════════════════════════════════════════
section('errors');
{
  const db = freshDb();
  for (const [label, bad] of [
    ['missing title', base({ title: undefined })],
    ['bad type', base({ type: 'nonsense' })],
    ['no facts', base({ facts: [] })],
    ['unknown property', base({ surprise: true })],
    ['null', null],
    ['string', 'remember this'],
    ['array', [1, 2, 3]],
    ['number', 42],
  ]) {
    const r = await call(bad, { dbPath: db });
    eq(r.ok, false, `${label} → ok:false`);
    eq(r.code, 'invalid_input', `${label} → code invalid_input`);
    eq(r.status, 'error', `${label} → status error`);
    ok(typeof r.error === 'string' && r.error.length > 0, `${label} → a human-readable message`);
    ok(!(r instanceof Error), `${label} → a plain result object, not a thrown Error`);
  }
  eq(rowCount(db, 'observations'), 0, 'no invalid input wrote a row');
  eq(rowCount(db, 'sdk_sessions'), 0, 'no invalid input wrote a session either');

  // Uninitialized brain.
  const missing = await call(base(), { dbPath: join(ROOT, 'does-not-exist.db') });
  eq(missing.ok, false, 'missing DB → ok:false');
  eq(missing.code, 'not_initialized', 'missing DB → not_initialized');
  ok(/brain onboard/.test(missing.error), 'missing DB error names the fix');
  ok(!existsSync(join(ROOT, 'does-not-exist.db')), 'a missing DB is never created as a side effect');

  // A DB file that exists but has no schema (a half-created store).
  const emptyPath = join(ROOT, 'empty.db');
  new DatabaseSync(emptyPath, { open: true }).close();
  const noSchema = await call(base(), { dbPath: emptyPath });
  eq(noSchema.code, 'not_initialized', 'schema-less DB → not_initialized, not a crash');
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. Locked database — clean error, no crash, no write
// ═════════════════════════════════════════════════════════════════════════════
section('locked db');
{
  const db = freshDb();
  await call(base({ title: 'A row that exists before the lock' }), { dbPath: db });
  const before = rowCount(db, 'observations');

  // claude-mem's worker writes concurrently: hold an exclusive write lock and
  // confirm we degrade to a structured, retriable error instead of throwing.
  const blocker = new DatabaseSync(db, { open: true });
  blocker.exec('PRAGMA busy_timeout = 0');
  blocker.exec('BEGIN EXCLUSIVE');
  blocker.prepare("INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch) VALUES ('blocker','p','change','x',1)").run();

  const t0 = Date.now();
  let threw = null;
  let r;
  try {
    r = await call(base({ title: 'This write happens while the store is locked' }), {
      dbPath: db, busyTimeoutMs: 30, retries: 2, retryDelayMs: 10, deadlineMs: 4000,
    });
  } catch (e) { threw = e; }
  const elapsed = Date.now() - t0;

  ok(threw === null, 'a locked DB never throws at the caller');
  ok(r && r.ok === false, 'locked DB → ok:false');
  eq(r && r.code, 'busy', 'locked DB → code busy');
  eq(r && r.retriable, true, 'locked DB → marked retriable');
  ok(/NOT saved/.test((r && r.error) || ''), 'the message states plainly that nothing was saved');
  ok(elapsed < 4000, `retry+backoff finished well inside the deadline (${elapsed}ms)`);
  ok(elapsed >= 30, `the call actually retried with backoff before giving up (${elapsed}ms)`);

  blocker.exec('ROLLBACK');
  blocker.close();
  eq(rowCount(db, 'observations'), before, 'the locked write left no partial row behind');

  // Once the lock is released, the same call succeeds.
  const after = await call(base({ title: 'This write happens after the lock is gone' }), { dbPath: db });
  eq(after.status, 'saved', 'writes resume normally once the lock clears');
  eq(rowCount(db, 'observations'), before + 1, 'exactly one row added after recovery');
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. Canonical hash + title normalization units
// ═════════════════════════════════════════════════════════════════════════════
section('canonical');
{
  const a = validateObservation(base()).value;
  eq(canonicalHash(a), canonicalHash(validateObservation(base()).value), 'hash is deterministic');
  ok(canonicalHash(a) !== canonicalHash(validateObservation(base({ facts: ['different'] })).value), 'facts change the hash');
  ok(canonicalHash(a) !== canonicalHash(validateObservation(base({ narrative: 'different' })).value), 'narrative changes the hash');
  ok(canonicalHash(a) !== canonicalHash(validateObservation(base({ subtitle: 'different' })).value), 'subtitle changes the hash');
  eq(canonicalHash(a), canonicalHash(validateObservation(base({ concepts: ['x', 'y'] })).value), 'concepts do NOT change the hash');
  eq(canonicalHash(a), canonicalHash(validateObservation(base({ model: 'other-model' })).value), 'model does NOT change the hash');
  ok(/^[0-9a-f]{32}$/.test(canonicalHash(a)), 'hash uses the strong v2 format shared with ingest.mjs (hash.mjs: SHA-256/128, 32 hex)');
  eq(normalizeTitle('  Mixed   CASE  Title '), 'mixed case title', 'normalizeTitle lowercases and collapses whitespace');
}

// ── report ───────────────────────────────────────────────────────────────────
try { rmSync(ROOT, { recursive: true, force: true }); } catch {}

console.log('');
console.log('── brain_remember write-path results ────────────────────────────');
for (const [name, g] of groups) {
  console.log(`  ${g.fail ? '✗' : '✓'} ${name.padEnd(20)} ${g.pass}/${g.pass + g.fail}`);
}
console.log('─────────────────────────────────────────────────────────────────');
if (failures > 0) {
  console.log(`\nFAIL — ${failures} of ${passed + failures} assertions failed.`);
  process.exit(1);
}
console.log(`\nPASS — ${passed} assertions.`);
process.exit(0);
