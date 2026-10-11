#!/usr/bin/env node
// Tests for the content_hash v1 → v2 transition: bin/lib/hash.mjs (the hashes
// and cross-version matching), bin/lib/migrate-hash.mjs (`brain migrate-hash`),
// and the dedupe paths that must tolerate a mix of versions — brain_remember
// (remember.mjs), the sync/restore merge (import-claude-mem.mjs) and the
// exports merge (import.mjs).
//
// Everything runs on synthetic stores in a throwaway directory. Rows that "an
// older build wrote" are inserted with the v1 FNV hash directly. No real store
// is ever opened.
//
//   node evals/hash-test.mjs
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync, statSync, readdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../bin/lib/store.mjs';
import {
  legacyHash, strongHash, contentHash, isStrongHash, isLegacyShaped, canonicalString,
  reproduce, equivalentHashes, legacyFromMetadata, hashAliasIndex,
} from '../bin/lib/hash.mjs';
import { canonicalHash, legacyCanonicalHash, fnvHash, rememberObservation, newMcpSession } from '../bin/lib/remember.mjs';
import { migrateHash, formatMigrateHashReport } from '../bin/lib/migrate-hash.mjs';
import { importClaudeMem } from '../bin/lib/import-claude-mem.mjs';
import { runImport } from '../bin/lib/import.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = process.env.SCRATCHPAD || tmpdir();
mkdirSync(SCRATCH, { recursive: true });
const ROOT = mkdtempSync(join(SCRATCH, 'hash-test-'));

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };

// ── fixtures ────────────────────────────────────────────────────────────────
let seq = 0;
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
function freshStore(name = 'store') {
  const p = join(ROOT, `${name}-${++seq}.db`);
  openStore({ path: p }).close();
  return p;
}
const read = (p) => new DatabaseSync(p, { readOnly: true, open: true });
const write = (p) => new DatabaseSync(p, { open: true });
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const allObs = (p) => { const d = read(p); try { return d.prepare('SELECT * FROM observations ORDER BY id').all(); } finally { d.close(); } };
const count = (p) => { const d = read(p); try { return d.prepare('SELECT COUNT(*) n FROM observations').get().n; } finally { d.close(); } };
const byTitle = (p, title) => { const d = read(p); try { return d.prepare('SELECT * FROM observations WHERE title = ? ORDER BY id').all(title); } finally { d.close(); } };

// A raw ingest row (transcript in text/narrative) as `version` would hash it.
function rawRow(i, { version = 'legacy', project = 'alpha' } = {}) {
  const transcript = `user: fix the retry cap number ${i}\nassistant: capped retries at ${i}`;
  return {
    memory_session_id: `codex:sid-${i}`, project, text: transcript, type: 'session', title: `retry cap ${i}`,
    subtitle: 'via codex', facts: '[]', narrative: transcript, concepts: '["imported","codex"]',
    created_at: new Date(T0 + i * 1000).toISOString(), created_at_epoch: T0 + i * 1000,
    content_hash: version === 'legacy' ? legacyHash(transcript) : strongHash(transcript), generated_by_model: 'codex',
  };
}
// A brain_remember / distilled row (canonical string) as `version` would hash it.
function mcpRow(i, { version = 'legacy', project = 'alpha', session = `mcp:claude_desktop:s${i}`, metadata = null } = {}) {
  const obs = { title: `Decision number ${i} on the cache`, subtitle: 'cache layer', facts: [`fact ${i} a`, `fact ${i} b`], narrative: `Narrative ${i}.` };
  const cs = canonicalString(obs);
  return {
    memory_session_id: session, project, text: obs.narrative, type: 'decision', title: obs.title,
    subtitle: obs.subtitle, facts: JSON.stringify(obs.facts), narrative: obs.narrative, concepts: '["mcp"]',
    created_at: new Date(T0 + 500000 + i * 1000).toISOString(), created_at_epoch: T0 + 500000 + i * 1000,
    content_hash: version === 'legacy' ? legacyHash(cs) : strongHash(cs), generated_by_model: 'mcp/claude-desktop',
    metadata,
  };
}
// A claude-mem row: its own 16-hex hash (never ours to recompute).
function claudeMemRow(i, { project = 'alpha' } = {}) {
  return {
    memory_session_id: `cm-session-${i}`, project, text: `claude-mem text ${i}`, type: 'discovery', title: `claude-mem obs ${i}`,
    subtitle: null, facts: '["x"]', narrative: `claude-mem narrative ${i}`, concepts: '[]',
    created_at: new Date(T0 + 900000 + i).toISOString(), created_at_epoch: T0 + 900000 + i,
    content_hash: createHash('sha256').update(`cm${i}`).digest('hex').slice(0, 16), generated_by_model: 'claude-haiku-4-5-20251001',
  };
}
const COLS = ['memory_session_id', 'project', 'text', 'type', 'title', 'subtitle', 'facts', 'narrative', 'concepts',
  'created_at', 'created_at_epoch', 'content_hash', 'generated_by_model', 'metadata'];
function insert(p, rows) {
  const d = write(p);
  try {
    const st = d.prepare(`INSERT INTO observations (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`);
    for (const r of rows) st.run(...COLS.map((c) => r[c] ?? null));
  } finally { d.close(); }
}
function sql(p, q, ...args) { const d = write(p); try { return d.prepare(q).run(...args); } finally { d.close(); } }
const merge = (source, dest, extra = {}) =>
  importClaudeMem({ source, dest, apply: true, resume: false, verify: true, touchReady: false, ...extra });
const obsTable = (r) => r.tables.find((x) => x.table === 'observations');

// ── hash.mjs ────────────────────────────────────────────────────────────────
await t('legacyHash is byte-identical to the old FNV-1a (golden values) and fnvHash still exports it', () => {
  eq(legacyHash(''), '811c9dc50', 'empty');
  eq(legacyHash('hello'), '4f9f2cab5', 'hello');
  eq(legacyHash('user: fix the retry cap\nassistant: done'), 'bd28250627', 'multi-line');
  eq(legacyHash('é漢字🙂'), '8da6418c5', 'non-ASCII (UTF-16 code units)');
  eq(fnvHash('hello'), '4f9f2cab5', 'remember.mjs fnvHash');
});

await t('strongHash: SHA-256 truncated to 128 bits, lowercase hex, deterministic; contentHash is it', () => {
  const s = strongHash('hello');
  eq(s, createHash('sha256').update('hello', 'utf8').digest('hex').slice(0, 32), 'sha256/128');
  eq(s.length, 32, '32 hex digits');
  eq(strongHash('hello'), s, 'deterministic');
  eq(contentHash('hello'), s, 'contentHash = strongHash');
  assert(strongHash('é漢字🙂') !== strongHash('e漢字🙂'), 'UTF-8 sensitive');
});

await t('version shapes never overlap: v1 (9..16 hex), v2 (32 hex), claude-mem (16 hex, never reproduces)', () => {
  assert(isStrongHash(strongHash('x')) && !isLegacyShaped(strongHash('x')), 'v2 is strong only');
  assert(isLegacyShaped(legacyHash('x')) && !isStrongHash(legacyHash('x')), 'v1 is legacy-shaped only');
  const cm = claudeMemRow(1);
  assert(isLegacyShaped(cm.content_hash) && !isStrongHash(cm.content_hash), 'claude-mem 16-hex is legacy-SHAPED');
  eq(reproduce(cm), null, '…but never reproduces (its declared length is absurd)');
  eq(equivalentHashes(cm).length, 0, 'no equivalents for a foreign row');
  assert(!isStrongHash('ABCDEF0123456789ABCDEF0123456789'), 'uppercase is not ours');
});

await t('reproduce(): raw transcript and canonical recipes, both versions; edited content reproduces nothing', () => {
  const raw = rawRow(1);
  const r1 = reproduce(raw);
  eq(r1.version, 'legacy', 'raw legacy'); eq(r1.recipe, 'text', 'raw recipe');
  eq(reproduce(rawRow(1, { version: 'strong' })).version, 'strong', 'raw strong');
  const m = mcpRow(1);
  const r2 = reproduce(m);
  eq(r2.version, 'legacy', 'mcp legacy'); eq(r2.recipe, 'canonical', 'mcp recipe');
  eq(reproduce({ ...m, title: 'curated title' }), null, 'an edit (hash kept) no longer reproduces');
  eq(reproduce({ ...m, content_hash: null }), null, 'no hash');
});

await t('equivalentHashes(): the other version both ways, plus metadata.legacy_content_hash', () => {
  const l = mcpRow(2), s = mcpRow(2, { version: 'strong' });
  eq(JSON.stringify(equivalentHashes(l)), JSON.stringify([s.content_hash]), 'legacy → strong');
  eq(JSON.stringify(equivalentHashes(s)), JSON.stringify([l.content_hash]), 'strong → legacy');
  const edited = { ...s, title: 'edited', metadata: JSON.stringify({ legacy_content_hash: l.content_hash, edited_at: 1 }) };
  eq(JSON.stringify(equivalentHashes(edited)), JSON.stringify([l.content_hash]), 'edited migrated row: metadata alias');
  eq(legacyFromMetadata('{"legacy_content_hash":"not-a-hash"}'), null, 'malformed alias ignored');
  eq(legacyFromMetadata('not json legacy_content_hash'), null, 'non-JSON metadata ignored');
});

await t('canonicalHash (brain_remember / distiller) is now the strong hash; legacyCanonicalHash is the v1 one', () => {
  const obs = { title: 'T', subtitle: '', facts: ['a', 'b'], narrative: 'n' };
  eq(canonicalHash(obs), strongHash(canonicalString(obs)), 'strong');
  eq(legacyCanonicalHash(obs), '486913828', 'v1 golden value (pre-change canonicalHash)');
});

// ── new rows ───────────────────────────────────────────────────────────────
await t('brain_remember writes the strong hash and dedupes against a row an older build hashed with v1', async () => {
  const p = freshStore('remember');
  const input = { title: 'Remember dedupes across hash versions', project: 'alpha', type: 'decision', facts: ['one', 'two'], narrative: 'Because of the migration.' };
  const first = await rememberObservation(input, { dbPath: p, session: newMcpSession('claude_desktop', T0), now: T0, log: () => {} });
  eq(first.status, 'saved', 'first write saved');
  const row = allObs(p)[0];
  assert(isStrongHash(row.content_hash), `new row hash is strong: ${row.content_hash}`);
  // Downgrade it to what an older build stored, then say it again from a new process session.
  sql(p, 'UPDATE observations SET content_hash = ? WHERE id = ?', legacyHash(canonicalString({ ...input, subtitle: '' })), row.id);
  assert(reproduce(allObs(p)[0])?.version === 'legacy', 'fixture: row now reproduces as v1');
  const again = await rememberObservation(input, { dbPath: p, session: newMcpSession('cursor', T0 + 10 * 86400000), now: T0 + 10 * 86400000, log: () => {} });
  eq(again.status, 'duplicate', 'v1 row matched as the exact duplicate');
  eq(count(p), 1, 'no second row');
});

// ingest.mjs's raw rows: asserted end-to-end in evals/ingest-growth-test.mjs
// (first capture and growth refresh both carry strongHash(text)).

// ── brain migrate-hash ──────────────────────────────────────────────────────
function mixedStore() {
  const p = freshStore('mixed');
  insert(p, [
    rawRow(1), rawRow(2),                                               // v1 raw → migrate (text)
    mcpRow(1), mcpRow(2, { metadata: JSON.stringify({ provider: 'claude', source_content_hash: 'abc' }) }), // v1 canonical → migrate
    { ...mcpRow(3), title: 'Decision number 3, curated' },              // edited after capture → kept
    claudeMemRow(1), claudeMemRow(2),                                   // claude-mem's own → kept
    rawRow(5, { version: 'strong' }),                                   // already v2
    { ...mcpRow(6), metadata: '"a json string"' },                      // metadata not an object → kept
  ]);
  return p;
}

await t('migrate-hash dry run: correct plan, writes nothing (store bytes identical)', () => {
  const p = mixedStore();
  const before = sha(p);
  const r = migrateHash({ dbPath: p });
  eq(r.applied, false, 'dry run');
  eq(r.total, 9, 'total');
  eq(r.toMigrate, 4, 'to migrate'); eq(r.byRecipe.text, 2, 'transcript recipe'); eq(r.byRecipe.canonical, 2, 'canonical recipe');
  eq(r.unreproducible, 1, 'edited row kept'); eq(r.foreign, 2, 'claude-mem rows kept');
  eq(r.alreadyStrong, 1, 'already strong'); eq(r.badMetadata, 1, 'non-object metadata kept');
  eq(r.rows, undefined, 'no row payload in the report');
  eq(sha(p), before, 'store unchanged');
  assert(!existsSync(join(dirname(p), 'backups')), 'no backup dir on a dry run');
  assert(/dry run[\s\S]*would rewrite[^\n]*: 4/.test(formatMigrateHashReport(r)), 'report text');
});

await t('migrate-hash --apply: verified backup, exact rewrites, legacy hash kept in metadata, others untouched', () => {
  const p = mixedStore();
  const pre = allObs(p);
  const r = migrateHash({ dbPath: p, apply: true });
  eq(r.applied, true, 'applied'); eq(r.migrated, 4, 'migrated'); eq(r.verified, true, 'verified'); eq(r.ftsOk, true, 'fts');
  assert(r.backupPath && existsSync(r.backupPath), 'backup exists');
  eq(statSync(r.backupPath).mode & 0o777, 0o600, 'backup is 0600');
  // The backup is the store as it was.
  const bk = allObs(r.backupPath);
  eq(JSON.stringify(bk.map((x) => x.content_hash)), JSON.stringify(pre.map((x) => x.content_hash)), 'backup holds the pre-migration hashes');
  const post = allObs(p);
  eq(post.length, pre.length, 'row count unchanged');
  for (let i = 0; i < pre.length; i++) {
    const a = pre[i], b = post[i];
    const rep = reproduce(a);
    const shouldMove = rep?.version === 'legacy' && a.metadata !== '"a json string"';
    if (shouldMove) {
      eq(b.content_hash, strongHash(rep.input), `row ${a.id} rewritten to the strong hash of the same input`);
      eq(legacyFromMetadata(b.metadata), a.content_hash, `row ${a.id} remembers its v1 hash`);
    } else {
      eq(b.content_hash, a.content_hash, `row ${a.id} hash untouched`);
      eq(b.metadata, a.metadata, `row ${a.id} metadata untouched`);
    }
    for (const c of ['text', 'title', 'subtitle', 'facts', 'narrative', 'project', 'memory_session_id']) eq(b[c], a[c], `row ${a.id} ${c} untouched`);
  }
  const kept = JSON.parse(post[3].metadata);
  eq(kept.provider, 'claude', 'existing metadata keys kept'); eq(kept.source_content_hash, 'abc', 'existing metadata keys kept (2)');
  // FTS still finds a migrated row.
  const d = read(p);
  try { eq(d.prepare("SELECT COUNT(*) n FROM observations_fts WHERE observations_fts MATCH 'retry'").get().n, 3, 'FTS intact (raw rows 1, 2, 5)'); } finally { d.close(); }
});

await t('migrate-hash is idempotent: a second --apply rewrites nothing and makes no backup', () => {
  const p = mixedStore();
  migrateHash({ dbPath: p, apply: true });
  const mid = sha(p);
  const backups = readdirSync(join(dirname(p), 'backups')).length;
  const r = migrateHash({ dbPath: p, apply: true });
  eq(r.toMigrate, 0, 'nothing left'); eq(r.migrated, 0, 'nothing rewritten'); eq(r.backupPath, null, 'no backup');
  eq(r.alreadyStrong, 5, 'all migrated rows now strong');
  eq(readdirSync(join(dirname(p), 'backups')).length, backups, 'no new backup file');
  eq(sha(p), mid, 'store unchanged');
});

await t('migrate-hash never forces a unique-index collision: same content already strong in the session → skipped', () => {
  const p = freshStore('conflict');
  const l = mcpRow(7, { session: 'mcp:x:one' });
  const s = { ...mcpRow(7, { version: 'strong', session: 'mcp:x:one' }), project: 'beta' };
  insert(p, [l, s]);
  const r = migrateHash({ dbPath: p, apply: true });
  eq(r.conflicts, 1, 'conflict reported'); eq(r.migrated, 0, 'not rewritten');
  eq(allObs(p)[0].content_hash, l.content_hash, 'v1 row left as it was');
  assert(/already taken in the same session: 1/.test(formatMigrateHashReport(r)), 'report names it');
});

await t('migrate-hash aborts with nothing changed when the backup cannot be written', () => {
  const p = mixedStore();
  const before = sha(p);
  const ro = join(ROOT, `ro-${seq}`);
  mkdirSync(ro); chmodSync(ro, 0o500);
  let threw = null;
  try { migrateHash({ dbPath: p, apply: true, backupDir: ro }); } catch (e) { threw = e; }
  chmodSync(ro, 0o700);
  assert(threw && /Backup verification failed[\s\S]*nothing changed/.test(threw.message), `refused: ${threw && threw.message}`);
  eq(sha(p), before, 'store unchanged');
});

await t('CLI: brain migrate-hash (dry run) then --apply --json on a --db store', () => {
  const p = mixedStore();
  const env = { ...process.env, HOME: join(ROOT, 'cli-home') };
  const run = (...a) => execFileSync(process.execPath, [join(REPO, 'bin/brain.mjs'), 'migrate-hash', ...a, '--db', p], { encoding: 'utf8', env });
  const dry = run();
  assert(/dry run \(nothing changed\)/.test(dry) && /would rewrite[^\n]*: 4/.test(dry) && /--apply/.test(dry), `dry output: ${dry}`);
  const j = JSON.parse(run('--apply', '--json'));
  eq(j.migrated, 4, 'applied via CLI'); eq(j.verified, true, 'verified via CLI');
  assert(!dry.includes('retry cap number'), 'never prints row content');
});

// ── sync / restore merge (import-claude-mem.mjs) across versions ────────────
// Machine "old" never migrated; machine "new" did. Same memories on both.
function twoMachines() {
  const old = freshStore('machine-old');
  insert(old, [rawRow(1), rawRow(2), mcpRow(1), mcpRow(2), claudeMemRow(1)]);
  const neu = join(ROOT, `machine-new-${++seq}.db`);
  copyFileSync(old, neu);
  const r = migrateHash({ dbPath: neu, apply: true });
  assert(r.migrated === 4 && r.verified, 'fixture: new machine migrated');
  return { old, neu };
}

await t('merge: un-migrated machine → migrated machine adds no duplicates, verification passes', () => {
  const { old, neu } = twoMachines();
  const n = count(neu);
  const r = merge(old, neu);
  assert(r.ok, `verification: ${JSON.stringify(r.verification?.checks.filter((c) => !c.ok))}`);
  eq(obsTable(r).inserted, 0, 'nothing inserted'); eq(obsTable(r).hashAliased, 4, 'four matched under the other version');
  eq(count(neu), n, 'row count unchanged');
});

await t('merge: migrated machine → un-migrated machine adds no duplicates, verification passes', () => {
  const { old, neu } = twoMachines();
  const n = count(old);
  const r = merge(neu, old);
  assert(r.ok, `verification: ${JSON.stringify(r.verification?.checks.filter((c) => !c.ok))}`);
  eq(obsTable(r).inserted, 0, 'nothing inserted'); eq(obsTable(r).hashAliased, 4, 'four matched');
  eq(count(old), n, 'row count unchanged');
});

await t('merge: a row curated after the split still matches (metadata.legacy_content_hash), both directions', () => {
  const { old, neu } = twoMachines();
  // Curated on the un-migrated machine: content changes, v1 hash kept (curate.mjs policy).
  sql(old, "UPDATE observations SET title = 'Decision number 1, curated', metadata = '{\"edited_at\":1}' WHERE title = 'Decision number 1 on the cache'");
  const r1 = merge(old, neu);
  assert(r1.ok, 'verify old→new');
  eq(obsTable(r1).inserted, 0, 'old→new: edited row not duplicated');
  // Curated on the migrated machine instead: its strong hash no longer reproduces; metadata carries v1.
  const { old: old2, neu: neu2 } = twoMachines();
  sql(neu2, "UPDATE observations SET title = 'Decision number 2, curated' WHERE title = 'Decision number 2 on the cache'");
  const r2 = merge(neu2, old2);
  assert(r2.ok, 'verify new→old');
  eq(obsTable(r2).inserted, 0, 'new→old: edited row not duplicated');
  const r3 = merge(old2, neu2);
  eq(obsTable(r3).inserted, 0, 'old→new against the edited migrated row: not duplicated');
});

await t('merge: genuinely new content still copies across versions (no over-matching)', () => {
  const { old, neu } = twoMachines();
  insert(old, [rawRow(30), mcpRow(31)]);
  insert(neu, [mcpRow(32, { version: 'strong' })]);
  const a = merge(old, neu);
  eq(obsTable(a).inserted, 2, 'two new legacy rows copied into the migrated machine');
  const b = merge(neu, old);
  eq(obsTable(b).inserted, 1, 'one new strong row copied into the un-migrated machine');
  // Same content in a DIFFERENT project is a different memory.
  const c = freshStore('other-project');
  insert(c, [mcpRow(1, { project: 'gamma', session: 'mcp:claude_desktop:other' })]);
  const d = merge(c, neu);
  eq(obsTable(d).inserted, 1, 'other project, other session: copied');
});

await t('merge: repeated merges converge (idempotent) and dry-run projects the same', () => {
  const { old, neu } = twoMachines();
  merge(old, neu); merge(neu, old);
  const n1 = count(old), n2 = count(neu);
  merge(old, neu); merge(neu, old);
  eq(count(old), n1, 'old stable'); eq(count(neu), n2, 'new stable');
  const plan = importClaudeMem({ source: old, dest: neu, apply: false });
  const t1 = plan.tables.find((x) => x.table === 'observations');
  eq(t1.projectedInserts, 0, 'dry run projects zero inserts'); eq(t1.hashAliased, 4, 'and names the four aliased rows');
});

await t('merge: after BOTH machines migrate, the same memory carries the same hash on each', () => {
  const { old, neu } = twoMachines();
  migrateHash({ dbPath: old, apply: true });
  const h = (p) => allObs(p).map((r) => r.content_hash).sort().join(',');
  eq(h(old), h(neu), 'identical hash sets');
  const r = merge(old, neu);
  eq(obsTable(r).inserted, 0, 'nothing inserted'); eq(obsTable(r).hashAliased, 0, 'no alias needed any more');
});

await t('claude-mem import is unaffected: 16-hex hashes copied verbatim into a migrated store', () => {
  const { neu } = twoMachines();
  const cm = freshStore('claude-mem');
  insert(cm, [claudeMemRow(10), claudeMemRow(11), claudeMemRow(1)]);
  const r = merge(cm, neu);
  assert(r.ok, 'verifies');
  eq(obsTable(r).inserted, 2, 'two new claude-mem rows'); eq(obsTable(r).hashAliased, 0, 'no alias matching on foreign hashes');
  const hashes = new Set(allObs(neu).map((x) => x.content_hash));
  for (const i of [1, 10, 11]) assert(hashes.has(claudeMemRow(i).content_hash), `claude-mem hash ${i} verbatim`);
});

// ── exports merge (import.mjs / `brain merge`) across versions ──────────────
function exportOf(p, dir) {
  const rows = allObs(p).map((r) => Object.fromEntries(COLS.map((c) => [c, r[c]])));
  const byProject = new Map();
  for (const r of rows) { if (!byProject.has(r.project)) byProject.set(r.project, []); byProject.get(r.project).push(r); }
  for (const [proj, list] of byProject) {
    mkdirSync(join(dir, proj), { recursive: true });
    writeFileSync(join(dir, proj, 'observations.jsonl'), list.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return dir;
}

await t('brain merge (exports): no duplicates either direction; new rows still added', () => {
  const { old, neu } = twoMachines();
  const fromOld = exportOf(old, join(ROOT, `exports-old-${++seq}`));
  const fromNew = exportOf(neu, join(ROOT, `exports-new-${seq}`));
  const n1 = count(neu), n2 = count(old);
  eq(runImport({ dbPath: neu, exportsDir: fromOld }).observations, 0, 'old exports into migrated store: 0 added');
  eq(count(neu), n1, 'migrated store unchanged');
  eq(runImport({ dbPath: old, exportsDir: fromNew }).observations, 0, 'new exports into un-migrated store: 0 added');
  eq(count(old), n2, 'un-migrated store unchanged');
  insert(neu, [mcpRow(40, { version: 'strong' })]);
  const fromNew2 = exportOf(neu, join(ROOT, `exports-new2-${seq}`));
  eq(runImport({ dbPath: old, exportsDir: fromNew2 }).observations, 1, 'a new memory is still merged');
});

await t('hashAliasIndex: own hash vs another row\'s metadata alias, by session and by project', () => {
  const p = freshStore('alias');
  const l = mcpRow(50).content_hash;
  insert(p, [{ ...mcpRow(50, { version: 'strong' }), title: 'edited', metadata: JSON.stringify({ legacy_content_hash: l }) }]);
  const d = read(p);
  try {
    const idx = hashAliasIndex(d);
    assert(idx.has({ ...mcpRow(50), title: 'edited elsewhere' }), 'unreproducible v1 row matched via the stored alias');
    assert(!idx.has({ ...mcpRow(50), project: 'zeta', memory_session_id: 'other', title: 'edited elsewhere' }), 'other project + session: no match');
    const sessOnly = hashAliasIndex(d, { byProject: false });
    assert(sessOnly.has({ ...mcpRow(50), title: 'x' }), 'session-scoped match');
    assert(!sessOnly.has({ ...mcpRow(50), memory_session_id: 'other', title: 'x' }), 'session-scoped: other session is not matched');
  } finally { d.close(); }
});

// ── migrate-hash under a concurrent writer ──────────────────────────────────
await t('migrate-hash --apply: a panel edit made after the plan (during the backup) is never lost', () => {
  const p = freshStore('race');
  insert(p, [rawRow(1), mcpRow(1), { ...rawRow(2), metadata: JSON.stringify({ provider: 'claude' }) }]);
  const [raw1, mcp1, raw2] = allObs(p);
  const stamp = '2026-10-01T00:00:00.000Z';
  const r = migrateHash({
    dbPath: p, apply: true,
    // What curate.mjs does, from another connection, between plan and UPDATE.
    onBackedUp: () => {
      sql(p, 'UPDATE observations SET title = ?, metadata = ? WHERE id = ?', 'EDITED BY PANEL', JSON.stringify({ edited_at: stamp }), raw1.id);
      sql(p, 'UPDATE observations SET title = ?, metadata = ? WHERE id = ?', 'Decision 1, curated', JSON.stringify({ edited_at: stamp }), mcp1.id);
      sql(p, 'UPDATE observations SET metadata = ? WHERE id = ?', JSON.stringify({ provider: 'claude', edited_at: stamp }), raw2.id);
    },
  });
  eq(r.toMigrate, 3, 'planned all three'); eq(r.verified, true, 'verified');
  eq(r.migrated, 2, 'two rows still reproduce their v1 hash (transcript recipe): rewritten');
  eq(r.raced, 1, 'the curated canonical row no longer does: left alone');
  const [a, b, c] = allObs(p);
  // Raw row 1: the transcript (what the hash is of) is unchanged, so it migrates — with the edit intact.
  eq(a.title, 'EDITED BY PANEL', 'edited title kept');
  eq(a.content_hash, strongHash(raw1.text), 'rewritten to the strong hash');
  const am = JSON.parse(a.metadata);
  eq(am.edited_at, stamp, 'edited_at survives (ingest/distiller keep honouring the edit)');
  eq(am.legacy_content_hash, raw1.content_hash, 'v1 alias added');
  // Canonical row: its content changed, so its v1 hash stays its identity, edit untouched.
  eq(b.content_hash, mcp1.content_hash, 'curated row keeps its v1 hash');
  eq(b.title, 'Decision 1, curated', 'curated title kept');
  eq(b.metadata, JSON.stringify({ edited_at: stamp }), 'curated row metadata exactly as the edit left it');
  const cm = JSON.parse(c.metadata);
  eq(cm.provider, 'claude', 'pre-existing key kept'); eq(cm.edited_at, stamp, 'concurrently added key kept');
  eq(cm.legacy_content_hash, raw2.content_hash, 'alias added alongside');
  assert(/verification: passed/.test(formatMigrateHashReport(r)), 'report says passed');
  assert(/changed by another writer[^\n]*: 1/.test(formatMigrateHashReport(r)), 'report names the skipped row');
});

await t('migrate-hash --apply: a rewrite that does not read back right is rolled back alone', () => {
  const p = freshStore('tamper');
  insert(p, [rawRow(1), rawRow(2)]);
  const [x, y] = allObs(p);
  // Something else rewrites the row as it is updated: the read-back must catch it.
  const d = write(p);
  try { d.exec(`CREATE TRIGGER t_tamper AFTER UPDATE OF content_hash ON observations WHEN NEW.id = ${x.id} BEGIN UPDATE observations SET title = 'tampered' WHERE id = NEW.id; END`); }
  finally { d.close(); }
  const r = migrateHash({ dbPath: p, apply: true });
  eq(r.migrated, 1, 'the clean row migrated'); eq(r.verifyFailures, 1, 'the tampered one did not');
  const [a, b] = allObs(p);
  eq(a.content_hash, x.content_hash, 'rolled-back row keeps its v1 hash');
  eq(a.title, x.title, '…and its title (the trigger write rolled back too)');
  eq(a.metadata, x.metadata, '…and its metadata');
  eq(b.content_hash, strongHash(y.text), 'the other row is rewritten');
  assert(/did not check out, rolled back[^\n]*: 1/.test(formatMigrateHashReport(r)), 'report names it');
});

await t('migrate-hash: the backup is checked whole (integrity_check + every column), and the report warns to update every Mac first', () => {
  const p = mixedStore();
  const dry = formatMigrateHashReport(migrateHash({ dbPath: p }));
  assert(/every Mac that syncs this brain must already run this build/i.test(dry), `dry-run warns: ${dry}`);
  const r = migrateHash({ dbPath: p, apply: true });
  const bk = read(r.backupPath);
  try { eq(bk.prepare('PRAGMA integrity_check').get().integrity_check, 'ok', 'backup sound'); } finally { bk.close(); }
  const pre = allObs(r.backupPath);
  assert(pre.some((x) => x.metadata === '"a json string"') && pre.every((x) => !legacyFromMetadata(x.metadata)), 'backup is the pre-migration store, metadata included');
  assert(/must run this build \(or newer\) before its next sync/.test(formatMigrateHashReport(r)), 'apply report warns too');
});

// ── a v1 collision must not swallow a NEW memory ─────────────────────────────
// Two different canonical strings with the same 32-bit v1 hash (birthday search).
function legacyCollision(make) {
  const seen = new Map();
  for (let i = 0; i < 5e6; i++) {
    const obs = make(i.toString(36).padStart(6, '0'));
    const h = legacyHash(canonicalString(obs));
    const prev = seen.get(h);
    if (prev) return [prev, obs];
    seen.set(h, obs);
  }
  throw new Error('no v1 collision found');
}
const COLL = legacyCollision((tag) => ({ title: 'Collision probe', subtitle: '', facts: ['one', 'two'], narrative: `Probe ${tag}.` }));
function rowOf(obs, { version = 'legacy', session = 'mcp:claude_desktop:coll', project = 'alpha', metadata = null } = {}) {
  const cs = canonicalString(obs);
  return {
    memory_session_id: session, project, text: obs.narrative, type: 'decision', title: obs.title, subtitle: obs.subtitle || null,
    facts: JSON.stringify(obs.facts), narrative: obs.narrative, concepts: '["mcp"]',
    created_at: new Date(T0).toISOString(), created_at_epoch: T0,
    content_hash: version === 'legacy' ? legacyHash(cs) : strongHash(cs), generated_by_model: 'mcp/claude-desktop', metadata,
  };
}

await t('fixture: two different memories share one v1 hash', () => {
  const [a, b] = COLL;
  assert(canonicalString(a) !== canonicalString(b), 'different content');
  eq(legacyHash(canonicalString(a)), legacyHash(canonicalString(b)), 'same v1 hash');
  assert(strongHash(canonicalString(a)) !== strongHash(canonicalString(b)), 'different strong hash');
});

await t('brain_remember: a new memory whose v1 hash collides with an old row is saved, not called a duplicate', async () => {
  const [a, b] = COLL;
  const p = freshStore('remember-coll');
  const input = (o) => ({ title: o.title, project: 'alpha', type: 'decision', facts: o.facts, narrative: o.narrative });
  const first = await rememberObservation(input(a), { dbPath: p, session: newMcpSession('claude_desktop', T0), now: T0, log: () => {} });
  eq(first.status, 'saved', 'A saved');
  sql(p, 'UPDATE observations SET content_hash = ? WHERE id = ?', legacyHash(canonicalString(a)), first.id); // an older build's row
  const later = T0 + 10 * 86400000;
  const second = await rememberObservation(input(b), { dbPath: p, session: newMcpSession('cursor', later), now: later, log: () => {} });
  eq(second.status, 'saved', 'B is a different memory: saved');
  eq(count(p), 2, 'two rows');
  const old = allObs(p).find((r) => r.id === first.id);
  eq(old.relevance_count ?? 0, 0, 'the old row was not bumped');
  const again = await rememberObservation(input(a), { dbPath: p, session: newMcpSession('codex', later + 1), now: later + 1, log: () => {} });
  eq(again.status, 'duplicate', 'A again still matches its own v1 row'); eq(again.id, first.id, 'the right row');
});

await t('merge: a new strong row colliding on v1 with a different old row in the same session is copied, both directions', () => {
  const [a, b] = COLL;
  const oldStore = freshStore('coll-old'); insert(oldStore, [rowOf(a)]);                          // v1 row, content A
  const newStore = freshStore('coll-new'); insert(newStore, [rowOf(b, { version: 'strong' })]);   // new row, content B
  const r1 = merge(newStore, oldStore);
  assert(r1.ok, `verify new→old: ${JSON.stringify(r1.verification?.checks.filter((c) => !c.ok))}`);
  eq(obsTable(r1).inserted, 1, 'new → old: B copied'); eq(obsTable(r1).hashAliased, 0, 'not mistaken for A');
  const oldStore2 = freshStore('coll-old'); insert(oldStore2, [rowOf(a)]);
  const newStore2 = freshStore('coll-new'); insert(newStore2, [rowOf(b, { version: 'strong' })]);
  const r2 = merge(oldStore2, newStore2);
  assert(r2.ok, 'verify old→new');
  eq(obsTable(r2).inserted, 1, 'old → new: A copied');
  // A migrated old row that collides: both contents still reproduce → compared, kept apart.
  const mig = freshStore('coll-mig');
  insert(mig, [rowOf(b, { version: 'strong', metadata: JSON.stringify({ legacy_content_hash: legacyHash(canonicalString(b)) }) })]);
  const oldStore3 = freshStore('coll-old'); insert(oldStore3, [rowOf(a)]);
  eq(obsTable(merge(mig, oldStore3)).inserted, 1, 'migrated B is not v1-colliding A');
  // Exports merge too.
  const oldStore4 = freshStore('coll-old'); insert(oldStore4, [rowOf(a)]);
  eq(runImport({ dbPath: oldStore4, exportsDir: exportOf(newStore2, join(ROOT, `exports-coll-${++seq}`)) }).observations, 1, 'brain merge: B added');
  // hashAliasIndex directly: the v1 key is shared, only the same content matches.
  const only = freshStore('coll-only'); insert(only, [rowOf(a)]);
  const d = read(only);
  try {
    const idx = hashAliasIndex(d);
    assert(idx.has(rowOf(a, { version: 'strong' })), 'strong A matches the v1 A row');
    assert(!idx.has(rowOf(b, { version: 'strong' })), 'strong B does not, though its v1 hash is the same');
  } finally { d.close(); }
});

// ── report ──────────────────────────────────────────────────────────────────
for (const [s, name, err] of results) console.log(`${s === 'PASS' ? '  ✓' : '  ✗'} ${name}${err ? `\n      ${err}` : ''}`);
console.log(`\nhash-test: ${pass} passed, ${fail} failed`);
if (fail) { console.log(`  (fixtures kept in ${ROOT})`); process.exitCode = 1; }
else rmSync(ROOT, { recursive: true, force: true });
