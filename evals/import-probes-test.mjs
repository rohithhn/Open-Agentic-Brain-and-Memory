#!/usr/bin/env node
// Adversarial probes against the claude-mem importer. Each builds a synthetic
// source DB engineered to trigger a specific suspected defect, then checks
// whether data was lost, mis-attached, or silently dropped.
// Nothing here touches the real DB or ~/.claude-brain.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importClaudeMem } from '../bin/lib/import-claude-mem.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'probe-'));
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch {} });
let n = 0, bad = 0;
const say = (ok, m, d) => { n++; if (!ok) bad++; console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ DEFECT\x1b[0m'} ${m}${d ? `\n        ${d}` : ''}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// Minimal claude-mem-shaped source.
function src(name, build) {
  const p = join(ROOT, `${name}.db`);
  const db = new DatabaseSync(p);
  db.exec(`
    CREATE TABLE sdk_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT,
      memory_session_id TEXT, project TEXT, platform_source TEXT, user_prompt TEXT,
      started_at TEXT, started_at_epoch INTEGER, completed_at TEXT, completed_at_epoch INTEGER,
      status TEXT, custom_title TEXT);
    CREATE TABLE user_prompts(id INTEGER PRIMARY KEY AUTOINCREMENT, session_db_id INTEGER,
      content_session_id TEXT, prompt_number INTEGER, prompt_text TEXT,
      created_at TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations(id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT,
      project TEXT, text TEXT, type TEXT, title TEXT, subtitle TEXT, facts TEXT, narrative TEXT,
      concepts TEXT, files_read TEXT, files_modified TEXT, prompt_number INTEGER,
      discovery_tokens INTEGER, created_at TEXT, created_at_epoch INTEGER, content_hash TEXT,
      generated_by_model TEXT, relevance_count INTEGER, merged_into_project TEXT,
      agent_type TEXT, agent_id TEXT, metadata TEXT);
    CREATE TABLE session_summaries(id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT,
      project TEXT, request TEXT, investigated TEXT, learned TEXT, completed TEXT,
      next_steps TEXT, files_read TEXT, files_edited TEXT, notes TEXT, prompt_number INTEGER,
      created_at TEXT, created_at_epoch INTEGER);
  `);
  build(db);
  db.close();
  return p;
}
const sess = (db, { csid, msid, proj = 'p', epoch = 1000 }) => db.prepare(
  `INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,platform_source,
     started_at,started_at_epoch,status) VALUES (?,?,?,'claude','t',?,'completed')`
).run(csid, msid, proj, epoch);
const prompt = (db, { sdbid, csid, num, text, epoch }) => db.prepare(
  `INSERT INTO user_prompts(session_db_id,content_session_id,prompt_number,prompt_text,
     created_at,created_at_epoch) VALUES (?,?,?,?,'t',?)`
).run(sdbid, csid, num, text, epoch);

const run = async (source, tag) => {
  const dest = join(ROOT, `dest-${tag}.db`);
  const r = await importClaudeMem({ source, dest, apply: true, log: () => {} });
  return { r, dest, db: new DatabaseSync(`file:${dest}?mode=ro`, { readOnly: true }) };
};

// ── PROBE A: session_db_id remapping ────────────────────────────────────────
head('PROBE A — session_db_id remapping (can a prompt attach to the WRONG session?)');
{
  // Two sessions; prompts reference them by source rowid. Destination rowids
  // will differ, so a verbatim copy would mis-attach.
  const s = src('A', (db) => {
    sess(db, { csid: 'sess-one', msid: 'm1', epoch: 100 });   // source rowid 1
    sess(db, { csid: 'sess-two', msid: 'm2', epoch: 200 });   // source rowid 2
    prompt(db, { sdbid: 1, csid: 'sess-one', num: 1, text: 'belongs to ONE', epoch: 101 });
    prompt(db, { sdbid: 2, csid: 'sess-two', num: 1, text: 'belongs to TWO', epoch: 201 });
    // a prompt whose content_session_id has no matching session at all
    prompt(db, { sdbid: 99, csid: 'sess-orphan', num: 1, text: 'orphan', epoch: 301 });
    // a prompt with NULL content_session_id
    prompt(db, { sdbid: 1, csid: null, num: 2, text: 'null csid', epoch: 102 });
  });
  const { r, db } = await run(s, 'A');
  say(r.ok !== undefined, `import ran (ok=${r.ok})`);
  const rows = db.prepare(`SELECT p.prompt_text, s.content_session_id AS attached
     FROM user_prompts p LEFT JOIN sdk_sessions s ON s.id = p.session_db_id`).all();
  const find = (t) => rows.find((x) => x.prompt_text === t);
  say(find('belongs to ONE')?.attached === 'sess-one', 'prompt 1 attached to the correct session',
    `attached to: ${find('belongs to ONE')?.attached}`);
  say(find('belongs to TWO')?.attached === 'sess-two', 'prompt 2 attached to the correct session',
    `attached to: ${find('belongs to TWO')?.attached}`);
  const orphan = find('orphan');
  say(orphan && orphan.attached == null, 'orphan prompt kept with NULL session (not mis-attached)',
    `attached to: ${orphan?.attached}`);
  // The native schema declares content_session_id NOT NULL, so such a row cannot
  // land. The contract is not "it survives" — it is "it survives OR the loss is
  // counted and the run refuses to claim success".
  const nullc = find('null csid');
  say(!!nullc || (r.ok === false && r.rejected > 0),
    'NULL-csid prompt either survived or was counted and failed the run',
    `survived=${!!nullc} ok=${r.ok} rejected=${r.rejected}`);
  db.close();
}

// ── PROBE B: same-millisecond collision on the 3-part key ───────────────────
head('PROBE B — two distinct prompts, same session, same millisecond');
{
  const s = src('B', (db) => {
    sess(db, { csid: 'sess-x', msid: 'mx', epoch: 500 });
    // Same csid + SAME prompt_number + SAME epoch, different text.
    prompt(db, { sdbid: 1, csid: 'sess-x', num: 1, text: 'FIRST distinct prompt', epoch: 777 });
    prompt(db, { sdbid: 1, csid: 'sess-x', num: 1, text: 'SECOND distinct prompt', epoch: 777 });
    // Same csid + DIFFERENT prompt_number + same epoch — must both survive.
    prompt(db, { sdbid: 1, csid: 'sess-x', num: 2, text: 'same ms, diff number A', epoch: 888 });
    prompt(db, { sdbid: 1, csid: 'sess-x', num: 3, text: 'same ms, diff number B', epoch: 888 });
  });
  const { r, db } = await run(s, 'B');
  const texts = db.prepare('SELECT prompt_text FROM user_prompts').all().map((x) => x.prompt_text);
  say(texts.includes('same ms, diff number A') && texts.includes('same ms, diff number B'),
    'same-millisecond prompts with different numbers both survive');
  // A UNIQUE index cannot hold both, so one must drop. What must NOT happen is
  // dropping it silently: the loss has to be counted and the run must fail.
  const collided = texts.filter((t) => t.includes('distinct prompt')).length;
  say(collided === 2 || (r.ok === false && r.distinctLost > 0),
    'colliding distinct rows: kept both, or reported the loss and failed',
    `kept=${collided}/2 ok=${r.ok} distinctLost=${r.distinctLost}`);
  say(r.ok === false, 'run does NOT report success after losing distinct content');
  db.close();
}

// ── PROBE C: dangling FTS after INSERT OR IGNORE skips ──────────────────────
head('PROBE C — does a skipped row leave a dangling FTS entry?');
{
  const s = src('C', (db) => {
    sess(db, { csid: 'sess-f', msid: 'mf', epoch: 10 });
    const ins = db.prepare(`INSERT INTO observations(memory_session_id,project,text,type,title,
      created_at,created_at_epoch,content_hash) VALUES ('mf','p',?,'note',?,'t',?,?)`);
    ins.run('alpha body', 'alpha title', 11, 'hash-a');
    ins.run('beta body', 'beta title', 12, 'hash-b');
  });
  // import twice — the second run's rows are all duplicates and get IGNOREd
  const { db: d1, dest } = await run(s, 'C');
  const before = d1.prepare('SELECT count(*) c FROM observations_fts').get().c;
  d1.close();
  await importClaudeMem({ source: s, dest, apply: true, log: () => {} });
  const d2 = new DatabaseSync(`file:${dest}?mode=ro`, { readOnly: true });
  const after = d2.prepare('SELECT count(*) c FROM observations_fts').get().c;
  const obs = d2.prepare('SELECT count(*) c FROM observations').get().c;
  say(obs === 2, `observations still 2 after re-import (got ${obs})`);
  say(after === before, `FTS rows unchanged by the ignored re-import (${before} → ${after})`);
  const hit = d2.prepare(`SELECT count(*) c FROM observations_fts WHERE observations_fts MATCH 'alpha'`).get().c;
  say(hit === 1, `FTS finds exactly 1 match for a term in 1 row (got ${hit})`);
  const integrity = (() => { try { d2.exec(`INSERT INTO observations_fts(observations_fts) VALUES('integrity-check')`); return 'ok'; } catch (e) { return e.message; } })();
  say(integrity === 'ok' || /readonly|read-only/i.test(integrity), `FTS integrity: ${integrity === 'ok' ? 'ok' : 'not checkable read-only (expected)'}`);
  d2.close();
}

// ── PROBE D: strict-schema row that claude-mem allows ───────────────────────
head('PROBE D — a source row the stricter native schema rejects');
{
  const s = src('D', (db) => {
    sess(db, { csid: 'sess-g', msid: 'mg', epoch: 10 });
    // claude-mem allows a NULL project / bogus status; native schema does not.
    db.exec(`INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,
      platform_source,started_at,started_at_epoch,status)
      VALUES ('sess-bad','mbad',NULL,'claude','t',20,'weird-status')`);
  });
  const { r, db } = await run(s, 'D');
  const got = db.prepare('SELECT count(*) c FROM sdk_sessions').get().c;
  const accounted = (r.rejected || 0) > 0 || got === 2;
  say(accounted, `violating row either imported or COUNTED as rejected (dest rows=${got}, rejected=${r.rejected})`,
    accounted ? '' : 'SILENT LOSS — row vanished without being counted');
  say(!(got < 2 && r.ok === true), 'import does not report ok:true while having dropped a row',
    r.ok === true && got < 2 ? 'reported success despite losing a row' : '');
  db.close();
}

console.log(`\n${n - bad} passed, ${bad} defects  ·  sandbox: ${ROOT}`);
process.exit(bad ? 1 : 0);
