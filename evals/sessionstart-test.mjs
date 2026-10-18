#!/usr/bin/env node
// Tests for bin/lib/sessionstart.mjs + hooks/session-start-context.sh — the
// SessionStart context block.
//
//   node evals/sessionstart-test.mjs
//
// Everything runs against synthetic SQLite stores built under the scratchpad
// via bin/lib/store.mjs's ensureSchema() (the same schema brain.db uses). The
// real ~/.claude-brain/brain.db is opened read-only, for shape and size only —
// no observation content is ever printed.
//
// The suite is organised around the properties the hook must never lose:
//   render     — ids, types, dates, file grouping, empty state
//   budget     — the cap holds, and trimming keeps the rows that matter
//   honesty    — economics computed or omitted, never fabricated
//   safety     — missing/locked/corrupt store => empty output, exit 0
//   hygiene    — no credential-shaped strings escape into the block
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../bin/lib/store.mjs';
import {
  sessionContext, selectRows, projectNameFor, projectRootFor, estimateTokens,
  maskSecrets, primaryFile, typeInfo, renderEmpty, renderPreview, PREVIEW_ROWS, PREVIEW_MAX_BYTES, ASK_HINT,
  DEFAULT_BUDGET_TOKENS, MAX_OUTPUT_BYTES, DEFAULT_MAX_ROWS, MIN_RECENT,
} from '../bin/lib/sessionstart.mjs';
import { MEMORY_DB, REPO_ROOT } from '../bin/lib/paths.mjs';

// Real-store sanity checks below must never append to the real tokens-saved ledger.
process.env.BRAIN_NO_ECONOMICS = '1';

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `sessionstart-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
let seq = 0;

// ── fixtures ─────────────────────────────────────────────────────────────

/** Synthetic native-schema store with the given observation rows. */
function buildDb(rows) {
  const dbPath = join(ROOT, `db-${++seq}.db`);
  const db = openStore({ path: dbPath }); // write-mode: creates + ensureSchema()
  const insSession = db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
     VALUES (?,?,?,?,?,?,'completed')`
  );
  const insObs = db.prepare(
    `INSERT INTO observations
     (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
      files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch,
      content_hash, generated_by_model)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let n = 0;
  for (const r of rows) {
    const mem = `test:${dbPath}:${++n}`;
    const epoch = r.epoch ?? Date.UTC(2026, 0, 1, 12, 0, 0) + n * 60000;
    const created = r.created_at || new Date(epoch).toISOString();
    insSession.run(mem, mem, r.project || 'proj', r.platform || 'claude', created, epoch);
    insObs.run(
      mem, r.project || 'proj', r.text || '', r.type || 'discovery', r.title || `title ${n}`,
      r.subtitle || null, '[]', r.narrative || '', '[]',
      r.files_read ?? '[]', r.files_modified ?? '[]', 0,
      r.discovery_tokens ?? 0, created, epoch, `hash-${n}`, 'test'
    );
  }
  db.close();
  return dbPath;
}

/** N rows of one type, newest first when read back. */
function rowsOf(type, count, extra = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ project: 'proj', type, title: `${type} row ${i}`, ...extra });
  }
  return out;
}

const ctx = (dbPath, opts = {}) => sessionContext({ project: 'proj', dbPath, ...opts });

// =====================================================================
// render
// =====================================================================

t('a project with rows renders a timeline with ids, type glyphs and dates', () => {
  const dbPath = buildDb([
    { project: 'proj', type: 'decision', title: 'Chose SQLite over JSON files' },
    { project: 'proj', type: 'bugfix', title: 'Race in the merge path' },
    { project: 'proj', type: 'discovery', title: 'The importer dedupes on content_hash' },
  ]);
  const out = ctx(dbPath);
  eq(out.rows, 3, 'all three rows should be shown');
  eq(out.project, 'proj', 'project name');
  eq(out.total, 3, 'total for project');
  assert(out.text.includes('Timeline (newest first)'), 'missing timeline header');
  assert(/#\d+ ◆ \d{2}:\d{2}  Chose SQLite/.test(out.text), 'decision line missing id/glyph/time');
  assert(/#\d+ ✗ \d{2}:\d{2}  Race in the merge path/.test(out.text), 'bugfix line missing id/glyph/time');
  assert(/^\d{4}-\d{2}-\d{2}$/m.test(out.text), 'no dated day header');
  assert(out.text.includes('Legend'), 'missing legend');
  assert(out.text.includes('Columns'), 'missing column key');
});

const plain = (t) => String(t).replace(/\x1b\[[0-9;]*m/g, '');

t('terminal preview: header, economics, newest-first timeline, ask line last', () => {
  const rows = [];
  for (let i = 0; i < PREVIEW_ROWS + 3; i++) {
    rows.push({ project: 'proj', type: i === 0 ? 'decision' : 'discovery', title: `memory ${i}`,
      epoch: Date.UTC(2026, 8, 1 + i, 9, 0), discovery_tokens: 5000 });
  }
  const out = ctx(buildDb(rows));
  const lines = plain(out.preview).split('\n');
  assert(/^\[proj\] recent memory, \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(am|pm) GMT[+-]\d/.test(lines[0]), `bad header: ${lines[0]}`);
  assert(/11 memories in this folder · 11 across 1 project/.test(lines[1]), `bad totals: ${lines[1]}`);
  assert(lines.some((l) => /^Legend: ◆ decision/.test(l)), 'legend missing');
  assert(lines.some((l) => /Your savings: \d+% reduction from reuse/.test(l)), 'economics missing');
  const ids = lines.filter((l) => /^ {2}#\d+ /.test(l));
  eq(ids.length, PREVIEW_ROWS, 'exactly PREVIEW_ROWS timeline rows');
  assert(ids[0].includes(`memory ${PREVIEW_ROWS + 2}`), 'newest memory must come first');
  assert(!plain(out.preview).includes('memory 0'), 'oldest memory beyond the cap must not appear');
  eq(lines[lines.length - 1], ASK_HINT, 'ends with the ask line');
  assert(Buffer.byteLength(out.preview) <= PREVIEW_MAX_BYTES, 'preview over the size cap');
});

t('provenance: rows from another tool carry a [tool] tag; Claude Code rows stay unmarked', () => {
  const dbPath = buildDb([
    { project: 'proj', type: 'decision', title: 'Chose age over gpg', platform: 'codex' },
    { project: 'proj', type: 'bugfix', title: 'Fixed the watcher leak', platform: 'claude' },
    { project: 'proj', type: 'discovery', title: 'Gemini keeps sessions in tmp', platform: 'gemini' },
  ]);
  const out = ctx(dbPath);
  assert(/#\d+ ◆ \d{2}:\d{2}  \[codex\] Chose age over gpg/.test(out.text), 'codex row should be tagged [codex]');
  assert(/#\d+ ✗ \d{2}:\d{2}  Fixed the watcher leak/.test(out.text), 'claude row must stay unmarked');
  assert(/\[gemini\] Gemini keeps sessions/.test(out.text), 'gemini row should be tagged');
  assert(out.text.includes('`[tool]`'), 'Columns key should explain the [tool] tag');
  const pv = plain(out.preview);
  assert(/\[codex\] Chose age over gpg/.test(pv), 'preview should tag the codex row');
  assert(!/\[claude/.test(pv) && !/\[claude/.test(out.text.replace(/\[tool\]/g, '')), 'claude rows must never be tagged');
});

t('provenance: worst case (every row from another tool) still fits the byte and token caps', () => {
  const dbPath = buildDb(rowsOf('discovery', 400, { platform: 'mcp_local_agent_mode_agentic_brain', discovery_tokens: 500 }));
  const out = ctx(dbPath);
  assert(out.bytes <= MAX_OUTPUT_BYTES, `block ${out.bytes}B over the ${MAX_OUTPUT_BYTES}B cap`);
  assert(out.tokens <= DEFAULT_BUDGET_TOKENS, `block ${out.tokens} tokens over budget`);
  assert(Buffer.byteLength(out.preview) <= PREVIEW_MAX_BYTES, 'preview over the 3.5KB cap');
  assert(/\[mcp-agent\] discovery row/.test(out.text), 'long platform names should be shortened');
});

t('terminal preview masks secrets, stays under the cap, and says so plainly when the folder is new', () => {
  const fake = ['ghp', 'x'.repeat(30)].join('_');
  const out = ctx(buildDb([{ project: 'proj', title: `rotated ${fake} today ${'long '.repeat(80)}` }]));
  assert(!out.preview.includes(fake), 'secret leaked into the terminal preview');
  assert(Buffer.byteLength(out.preview) <= PREVIEW_MAX_BYTES, 'preview over the size cap');
  const fresh = plain(renderPreview({ project: 'fresh', total: 0, recent: [], brain: { total: 42, projects: 3 }, color: false })).split('\n');
  eq(fresh[0], '[fresh] no memory here yet — it fills as you work  · 🧠 Open Agentic Brain and Memory', 'empty-folder header');
  eq(fresh[1], 'Your brain: 42 across 3 projects', 'empty-folder totals');
  eq(fresh[fresh.length - 1], ASK_HINT, 'empty folder still ends with the ask line');
});

t('NO_COLOR / color:false gives plain text; default is colored', () => {
  const r = [{ id: 1, type: 'bugfix', title: 't', __date: new Date(2026, 8, 1, 9, 0) }];
  assert(!/\x1b\[/.test(renderPreview({ project: 'p', total: 1, recent: r, color: false })), 'color:false still colored');
  if (!process.env.NO_COLOR) assert(/\x1b\[/.test(renderPreview({ project: 'p', total: 1, recent: r })), 'default not colored');
});

t('every rendered observation line carries a fetchable id', () => {
  const dbPath = buildDb(rowsOf('feature', 8));
  const out = ctx(dbPath);
  const obsLines = out.text.split('\n').filter((l) => /^\s+#?\d|^\s+#\d/.test(l) && l.includes('  '));
  const idLines = out.text.split('\n').filter((l) => /#\d+ /.test(l));
  eq(idLines.length, out.rows, 'one id-bearing line per shown observation');
  assert(obsLines.length >= idLines.length - 1, 'observation lines should be indented');
  for (const l of idLines) assert(/#\d+ \S \d{2}:\d{2}  /.test(l), `malformed line: ${l}`);
});

t('guidance names retrieval paths that exist in THIS project', () => {
  const dbPath = buildDb(rowsOf('decision', 3));
  const out = ctx(dbPath);
  assert(out.text.includes('brain recall'), 'must mention the brain recall CLI');
  assert(out.text.includes('brain_recall'), 'must mention the brain_recall MCP tool');
  assert(out.text.includes('brain_context'), 'must mention the brain_context MCP tool');
  assert(out.text.includes('/api/observation?id='), 'must give an id-based fetch path');
  assert(!/claude-mem|mem-search|smart_search/i.test(out.text), 'must not point at claude-mem tooling');
});

t('rows WITH files_modified are grouped under the file path', () => {
  const dbPath = buildDb([
    { project: 'proj', type: 'change', title: 'Tightened the parser', files_modified: '["bin/lib/parse.mjs"]' },
    { project: 'proj', type: 'bugfix', title: 'Off-by-one in the parser', files_modified: '["bin/lib/parse.mjs"]' },
  ]);
  const out = ctx(dbPath);
  const lines = out.text.split('\n');
  const header = lines.findIndex((l) => l.trim() === 'bin/lib/parse.mjs');
  assert(header > -1, 'file group header missing');
  eq(lines.filter((l) => l.trim() === 'bin/lib/parse.mjs').length, 1, 'file header should appear once, not per row');
  assert(/^ {4}#\d+/.test(lines[header + 1]), 'rows should be indented under the file header');
});

t('rows WITHOUT files_modified render flat, with no file group and no empty bucket label', () => {
  const dbPath = buildDb(rowsOf('discovery', 5)); // all files_modified = '[]'
  const out = ctx(dbPath);
  assert(!out.text.includes('(no file recorded)'), 'must not label the bucket when nothing has a file');
  assert(!/^ {4}#\d+/m.test(out.text), 'flat rows should not be double-indented');
  assert(/^ {2}#\d+ /m.test(out.text), 'flat rows should still be indented under the day');
});

t('a mix of filed and unfiled rows renders both a file group and a labelled loose bucket', () => {
  const dbPath = buildDb([
    { project: 'proj', type: 'feature', title: 'Added the exporter', files_modified: '["bin/lib/export.mjs"]' },
    { project: 'proj', type: 'discovery', title: 'Exports are idempotent' },
  ]);
  const out = ctx(dbPath);
  assert(out.text.includes('bin/lib/export.mjs'), 'file group missing');
  assert(out.text.includes('(no file recorded)'), 'loose bucket should be labelled when file groups exist');
});

t('files_modified variants (empty array, malformed JSON, bare string) never throw', () => {
  const dbPath = buildDb([
    { project: 'proj', title: 'a', files_modified: '[]' },
    { project: 'proj', title: 'b', files_modified: 'not json at all [' },
    { project: 'proj', title: 'c', files_modified: 'bin/plain/path.mjs' },
    { project: 'proj', title: 'd', files_modified: '[null, "", "bin/real.mjs"]' },
    { project: 'proj', title: 'e', files_modified: null },
  ]);
  const out = ctx(dbPath);
  eq(out.rows, 5, 'all rows should survive');
  assert(out.text.includes('bin/plain/path.mjs'), 'bare-string path should be used');
  assert(out.text.includes('bin/real.mjs'), 'first non-empty entry of the array should be used');
});

t('files_read is only a fallback — files_modified wins when both are present', () => {
  eq(primaryFile({ files_modified: '["mod.mjs"]', files_read: '["read.mjs"]' }), 'mod.mjs', 'modified should win');
  eq(primaryFile({ files_modified: '[]', files_read: '["read.mjs"]' }), 'read.mjs', 'read is the fallback');
  eq(primaryFile({ files_modified: '[]', files_read: '[]' }), '', 'neither -> ungrouped');
});

// =====================================================================
// empty state
// =====================================================================

t('a project with NO rows renders the short honest empty state, not a wall of text', () => {
  const dbPath = buildDb([{ project: 'someone-elses-repo', title: 'unrelated work' }]);
  const out = sessionContext({ project: 'brand-new-repo', dbPath });
  eq(out.rows, 0, 'no rows');
  eq(out.reason, 'no memory for this project', 'reason should say so');
  assert(out.text.includes('no memory for **brand-new-repo** yet'), 'empty state should name the project');
  assert(!out.text.includes('Timeline'), 'empty state must not render a timeline');
  assert(!out.text.includes('unrelated work'), 'empty state must not leak other projects\' observations');
  assert(out.text.split('\n').length <= 6, `empty state should be short, got ${out.text.split('\n').length} lines`);
  assert(estimateTokens(out.text) < 100, 'empty state should cost almost nothing');
});

t('the empty state still points at a retrieval path that works', () => {
  assert(renderEmpty('x').includes('brain recall'), 'empty state should still offer search');
});

// =====================================================================
// budget
// =====================================================================

t('the default budget is respected on a store far larger than it', () => {
  const dbPath = buildDb(rowsOf('discovery', 500, { discovery_tokens: 900 }));
  const out = ctx(dbPath);
  assert(out.tokens <= DEFAULT_BUDGET_TOKENS, `block ${out.tokens} exceeds default budget ${DEFAULT_BUDGET_TOKENS}`);
  assert(out.rows <= DEFAULT_MAX_ROWS, `rows ${out.rows} exceeds row cap ${DEFAULT_MAX_ROWS}`);
  eq(out.total, 500, 'header should still report the true total');
});

t('a tight explicit budget forces the block down under it', () => {
  const dbPath = buildDb(rowsOf('discovery', 400, { discovery_tokens: 500 }));
  for (const budgetTokens of [300, 600, 1200]) {
    const out = ctx(dbPath, { budgetTokens });
    assert(out.tokens <= budgetTokens, `budget ${budgetTokens}: got ${out.tokens} tokens`);
    assert(out.rows >= 1, `budget ${budgetTokens}: should still show something`);
  }
});

t('maxRows caps the row count independently of the token budget', () => {
  const dbPath = buildDb(rowsOf('discovery', 300));
  const out = ctx(dbPath, { maxRows: 7, budgetTokens: 100000 });
  eq(out.rows, 7, 'maxRows should bind');
});

t('env overrides configure the budget', () => {
  const dbPath = buildDb(rowsOf('discovery', 300));
  const prevB = process.env.BRAIN_SESSION_BUDGET_TOKENS;
  const prevR = process.env.BRAIN_SESSION_MAX_ROWS;
  try {
    process.env.BRAIN_SESSION_MAX_ROWS = '9';
    process.env.BRAIN_SESSION_BUDGET_TOKENS = '50000';
    eq(sessionContext({ project: 'proj', dbPath }).rows, 9, 'BRAIN_SESSION_MAX_ROWS should apply');
  } finally {
    if (prevB === undefined) delete process.env.BRAIN_SESSION_BUDGET_TOKENS; else process.env.BRAIN_SESSION_BUDGET_TOKENS = prevB;
    if (prevR === undefined) delete process.env.BRAIN_SESSION_MAX_ROWS; else process.env.BRAIN_SESSION_MAX_ROWS = prevR;
  }
});

t('config.json sessionStart tunables are honoured', () => {
  const dbPath = buildDb(rowsOf('discovery', 300));
  const out = sessionContext({ project: 'proj', dbPath, config: { sessionStart: { maxRows: 5, budgetTokens: 90000 } } });
  eq(out.rows, 5, 'config sessionStart.maxRows should apply');
});

t('trimming prefers decisions/bugfixes/features over routine discovery rows', () => {
  // 400 discoveries interleaved with a handful of high-value rows, all older
  // than the recency guarantee so ranking (not recency) decides.
  const rows = [];
  for (let i = 0; i < 400; i++) {
    rows.push({ project: 'proj', type: 'discovery', title: `noise ${i}` });
    if (i % 40 === 0) rows.push({ project: 'proj', type: 'decision', title: `DECIDED ${i}` });
    if (i % 40 === 20) rows.push({ project: 'proj', type: 'bugfix', title: `FIXED ${i}` });
  }
  // Newest rows are all noise, so the recency guarantee cannot supply them.
  for (let i = 0; i < 40; i++) rows.push({ project: 'proj', type: 'discovery', title: `newest noise ${i}` });
  const dbPath = buildDb(rows);
  const out = ctx(dbPath, { maxRows: 40, budgetTokens: 100000 });
  const decisions = (out.text.match(/DECIDED /g) || []).length;
  const fixes = (out.text.match(/FIXED /g) || []).length;
  const noise = (out.text.match(/noise /g) || []).length;
  // 20 high-value rows exist in a store of 440. Under a 40-row cap, ALL of them
  // must make the cut before a single extra discovery row does — the remaining
  // slots are the MIN_RECENT recency guarantee plus whatever is left over.
  eq(decisions + fixes, 20, 'every decision/bugfix must survive trimming before any surplus discovery does');
  eq(decisions + fixes + noise, out.rows, 'accounting: shown rows are all one or the other');
  assert(noise <= out.rows - 20, `discovery should only fill the leftover slots, got ${noise}`);
});

t('the newest rows are shown even when they are all low-priority discovery', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push({ project: 'proj', type: 'decision', title: `old decision ${i}` });
  for (let i = 0; i < 20; i++) rows.push({ project: 'proj', type: 'discovery', title: `JUSTNOW ${i}` });
  const dbPath = buildDb(rows);
  const out = ctx(dbPath, { maxRows: MIN_RECENT + 5, budgetTokens: 100000 });
  const recent = (out.text.match(/JUSTNOW /g) || []).length;
  eq(recent, MIN_RECENT, `the ${MIN_RECENT} newest rows must survive regardless of type`);
});

t('selectRows is newest-first and never exceeds its cap', () => {
  const cands = [];
  for (let i = 0; i < 50; i++) cands.push({ id: i, type: i % 2 ? 'discovery' : 'decision', __epoch: 1000 - i });
  const got = selectRows(cands, 10);
  eq(got.length, 10, 'cap respected');
  for (let i = 1; i < got.length; i++) assert(got[i - 1].__epoch >= got[i].__epoch, 'not newest-first');
  eq(selectRows(cands, 999).length, 50, 'cap larger than input returns everything');
});

// =====================================================================
// honesty — economics computed, or omitted
// =====================================================================

t('economics are computed from the rows actually shown', () => {
  const dbPath = buildDb(rowsOf('decision', 10, { discovery_tokens: 1000 }));
  const out = ctx(dbPath);
  eq(out.workTokens, 10000, 'work investment should be the sum of shown rows');
  assert(out.text.includes('Context economics'), 'economics header missing');
  assert(/Loading: 10 observations \([\d,]+ tokens to read\)/.test(out.text), 'loading line missing/malformed');
  assert(out.text.includes('Work investment: 10,000 tokens'), 'work investment line missing');
  assert(/Your savings: \d+% reduction from reuse/.test(out.text), 'savings line missing');
});

t('the reported read cost matches the block it describes (within rounding)', () => {
  const dbPath = buildDb(rowsOf('feature', 60, { discovery_tokens: 700 }));
  const out = ctx(dbPath);
  const claimed = Number((out.text.match(/\(([\d,]+) tokens to read\)/) || [])[1].replace(/,/g, ''));
  const actual = estimateTokens(out.text);
  eq(actual, out.tokens, 'returned token count must be the block\'s own estimate');
  // Exact, not approximate: the figure is a fixed point over the finished text,
  // so the block prices itself including the line that states the price.
  eq(claimed, actual, 'the quoted read cost must equal the block\'s real cost');
});

t('the work/savings lines are OMITTED, not fabricated, when discovery_tokens are absent', () => {
  const dbPath = buildDb(rowsOf('decision', 10, { discovery_tokens: 0 }));
  const out = ctx(dbPath);
  eq(out.workTokens, 0, 'no work tokens available');
  assert(out.text.includes('Loading: 10 observations'), 'the true loading line should still appear');
  assert(!out.text.includes('Work investment'), 'work investment must be omitted when unknown');
  assert(!out.text.includes('Your savings'), 'savings must be omitted when unknown');
  assert(!/\bNaN\b|undefined|Infinity/.test(out.text), 'no placeholder garbage in the block');
});

t('a negative-value ratio is omitted rather than printed as a loss', () => {
  // One row whose work investment is smaller than the block it produces:
  // there is no saving to claim, so no savings line.
  const dbPath = buildDb([{ project: 'proj', type: 'decision', title: 'tiny', discovery_tokens: 3 }]);
  const out = ctx(dbPath);
  assert(out.text.includes('Work investment: 3 tokens'), 'the true work figure should still be reported');
  assert(!out.text.includes('Your savings'), 'no savings line when work < read');
});

t('partial discovery_tokens coverage sums only what exists', () => {
  const dbPath = buildDb([
    { project: 'proj', type: 'decision', title: 'a', discovery_tokens: 5000 },
    { project: 'proj', type: 'decision', title: 'b', discovery_tokens: 0 },
    { project: 'proj', type: 'decision', title: 'c', discovery_tokens: null },
  ]);
  eq(ctx(dbPath).workTokens, 5000, 'nulls and zeroes contribute nothing, and are not guessed at');
});

t('the header total reflects the store, not the trimmed view', () => {
  const dbPath = buildDb(rowsOf('discovery', 300));
  const out = ctx(dbPath, { maxRows: 10, budgetTokens: 100000 });
  eq(out.total, 300, 'total');
  assert(out.text.includes('300 observations recorded, 10 shown'), 'header must distinguish recorded from shown');
});

// =====================================================================
// project resolution
// =====================================================================

t('cwd resolves to the enclosing git repo, from any depth', () => {
  const repo = join(ROOT, 'fake-repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'a', 'b', 'c'), { recursive: true });
  eq(projectNameFor(join(repo, 'a', 'b', 'c')), 'fake-repo', 'should walk up to the repo root');
  eq(projectRootFor(join(repo, 'a', 'b')), repo, 'root path');
  const loose = join(ROOT, 'not-a-repo-xyz');
  mkdirSync(loose, { recursive: true });
  eq(projectNameFor(loose), 'not-a-repo-xyz', 'no .git -> basename of cwd');
});

t('subagent project scopes (name/agent-*) fold into the parent project', () => {
  const dbPath = buildDb([
    { project: 'proj', type: 'decision', title: 'main scope' },
    { project: 'proj/agent-abc123', type: 'bugfix', title: 'subagent scope' },
    { project: 'other', type: 'decision', title: 'DIFFERENT PROJECT' },
  ]);
  const out = ctx(dbPath);
  eq(out.total, 2, 'parent + subagent rows, not the unrelated project');
  assert(out.text.includes('subagent scope'), 'subagent rows should be included');
  assert(!out.text.includes('DIFFERENT PROJECT'), 'unrelated project must never leak in');
});

t('project matching is case-insensitive but not a substring match', () => {
  const dbPath = buildDb([
    { project: 'MyRepo', type: 'decision', title: 'cased row' },
    { project: 'MyRepo-other', type: 'decision', title: 'NEIGHBOUR' },
  ]);
  const out = sessionContext({ project: 'myrepo', dbPath });
  eq(out.total, 1, 'only the case-insensitive exact match');
  assert(!out.text.includes('NEIGHBOUR'), 'a similarly-named sibling repo must not be absorbed');
});

// =====================================================================
// safety — never fail the session
// =====================================================================

t('a missing store produces empty output and a reason, never a throw', () => {
  const out = sessionContext({ project: 'proj', dbPath: join(ROOT, 'does-not-exist.db') });
  eq(out.text, '', 'no output');
  eq(out.reason, 'no store', 'reason');
  eq(out.rows, 0, 'no rows');
});

t('no dbPath at all produces empty output', () => {
  eq(sessionContext({ project: 'proj' }).text, '', 'no output without a store');
});

t('a corrupt (non-SQLite) store produces empty output, never a throw', () => {
  const bad = join(ROOT, 'corrupt.db');
  writeFileSync(bad, 'this is definitely not a sqlite database\n'.repeat(50));
  const out = sessionContext({ project: 'proj', dbPath: bad });
  eq(out.text, '', 'no output from a corrupt store');
  assert(out.reason, 'a reason should be recorded');
  // Specifically NOT the friendly empty state: an unreadable store must never
  // be reported as "this project has no memory yet".
  assert(!out.text.includes('no memory'), 'must not claim the project is empty when the store is broken');
});

t('a store with no observations table produces empty output', () => {
  const p = join(ROOT, 'schemaless.db');
  const db = new DatabaseSync(p, { open: true });
  db.exec('CREATE TABLE unrelated (x INTEGER)');
  db.close();
  const out = sessionContext({ project: 'proj', dbPath: p });
  eq(out.text, '', 'no output when the schema is missing');
});

t('a LOCKED store degrades to empty output rather than hanging or throwing', () => {
  const dbPath = buildDb(rowsOf('decision', 5));
  const holder = new DatabaseSync(dbPath, { open: true });
  holder.exec('PRAGMA journal_mode = DELETE');
  holder.exec('BEGIN EXCLUSIVE');
  try {
    const started = Date.now();
    const out = sessionContext({ project: 'proj', dbPath });
    const elapsed = Date.now() - started;
    // Either it degrades (expected under an exclusive lock) or SQLite let the
    // read through; both are acceptable, hanging is not.
    assert(out.text === '' || out.rows > 0, 'must either degrade cleanly or render');
    // And when it degrades it must NOT claim the project is empty.
    if (out.text === '') eq(out.reason, 'store unreadable', 'a lock is not the same as an empty project');
    assert(elapsed < 1000, `a locked DB must not delay session start (took ${elapsed}ms)`);
  } finally {
    try { holder.exec('ROLLBACK'); } catch { /* ignore */ }
    holder.close();
  }
});

t('a row with a broken timestamp renders without throwing and without 1970', () => {
  const dbPath = buildDb([
    { project: 'proj', type: 'decision', title: 'good row', epoch: Date.UTC(2026, 5, 1, 9, 30) },
    { project: 'proj', type: 'decision', title: 'bad epoch row', epoch: 0, created_at: 'not a date' },
  ]);
  const out = ctx(dbPath);
  eq(out.rows, 2, 'both rows kept');
  assert(!out.text.includes('1970'), 'a zero epoch must not render as 1970');
  assert(out.text.includes('undated') || out.text.includes('--:--'), 'undated rows should say so');
});

t('seconds-precision epochs are normalised instead of rendering as 1970', () => {
  const secs = Math.floor(Date.UTC(2026, 3, 2, 10, 0) / 1000);
  const dbPath = buildDb([{ project: 'proj', type: 'decision', title: 'seconds row', epoch: secs }]);
  const out = ctx(dbPath);
  assert(out.text.includes('2026-04-02'), 'second-precision epoch should resolve to its real date');
});

// =====================================================================
// hygiene
// =====================================================================

t('credential-shaped strings in titles are masked out of the block', () => {
  const fakes = [
    'ghp_' + 'A'.repeat(36),
    'sk-' + 'b'.repeat(32),
    'AKIA' + 'C'.repeat(16),
    'AGE-SECRET-KEY-' + 'D'.repeat(40),
    'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4',
    'li_at=' + 'e'.repeat(40),
  ];
  const dbPath = buildDb(fakes.map((f, i) => ({ project: 'proj', type: 'decision', title: `leaked ${i}: ${f}` })));
  const out = ctx(dbPath);
  for (const f of fakes) assert(!out.text.includes(f), `credential-shaped string survived: ${f.slice(0, 8)}…`);
  assert(out.text.includes('[REDACTED]'), 'redaction marker should be present');
});

t('maskSecrets leaves ordinary titles untouched', () => {
  const plain = 'Fixed the merge race in bin/lib/store.mjs (see #1234)';
  eq(maskSecrets(plain), plain, 'ordinary prose must not be mangled');
});

t('very long titles are truncated rather than blowing the budget', () => {
  const dbPath = buildDb([{ project: 'proj', type: 'decision', title: 'x'.repeat(4000) }]);
  const out = ctx(dbPath);
  for (const l of out.text.split('\n')) assert(l.length < 220, `line too long (${l.length})`);
});

t('type glyphs are stable and unknown types fall back rather than break', () => {
  eq(typeInfo('decision').glyph, '◆', 'decision glyph');
  eq(typeInfo('DECISION').glyph, '◆', 'type match is case-insensitive');
  eq(typeInfo('discovery').tier, 2, 'discovery is lowest priority');
  eq(typeInfo('decision').tier, 0, 'decision is highest priority');
  assert(typeInfo('some-new-type-we-have-never-seen').glyph, 'unknown types still get a glyph');
});

// =====================================================================
// CLI + hook — the path that actually runs at session start
// =====================================================================

const RENDERER = join(REPO_ROOT, 'bin', 'lib', 'sessionstart.mjs');
const HOOK = join(REPO_ROOT, 'hooks', 'session-start-context.sh');

/** Run a command, capturing stdout/stderr/status without throwing. */
function run(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

t('the CLI exits 0 and prints nothing when the directory has no memory', () => {
  const dir = join(ROOT, 'unknown-repo-name-zzz');
  mkdirSync(join(dir, '.git'), { recursive: true });
  const r = run(process.execPath, [RENDERER, dir], { env: { ...process.env, HOME: ROOT } });
  eq(r.status, 0, 'must exit 0');
  eq(r.stderr, '', 'must never write to stderr');
});

t('the CLI --json mode reports metrics without printing the block', () => {
  const r = run(process.execPath, [RENDERER, REPO_ROOT, '--json']);
  eq(r.status, 0, 'must exit 0');
  const j = JSON.parse(r.stdout);
  for (const k of ['project', 'rows', 'tokens', 'total', 'workTokens', 'budgetTokens', 'chars']) {
    assert(k in j, `--json missing ${k}`);
  }
  assert(!/Timeline/.test(r.stdout), '--json must not dump the block');
});

t('the hook script exits 0 and stays silent when the renderer is missing', () => {
  const fakeRepo = join(ROOT, 'fake-brain-repo');
  mkdirSync(fakeRepo, { recursive: true });
  const r = run('/bin/bash', [HOOK], { env: { ...process.env, CLAUDE_BRAIN_DIR: fakeRepo } });
  eq(r.status, 0, 'must exit 0');
  eq(r.stdout, '', 'must print nothing');
  eq(r.stderr, '', 'must never write to stderr');
});

t('the hook script exits 0 and stays silent for a directory with no memory', () => {
  const dir = join(ROOT, 'unknown-repo-name-yyy');
  mkdirSync(join(dir, '.git'), { recursive: true });
  const r = run('/bin/bash', [HOOK], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, cwd: dir });
  eq(r.status, 0, 'must exit 0');
  eq(r.stderr, '', 'must never write to stderr');
});

t('the hook script is executable and has no bashisms that trip -n parsing', () => {
  const r = run('/bin/bash', ['-n', HOOK]);
  eq(r.status, 0, `hook failed syntax check: ${r.stderr}`);
  assert(existsSync(HOOK), 'hook missing');
});

t('the hook emits the real block on stdout, and nothing on stderr', () => {
  if (!existsSync(MEMORY_DB)) { console.log('  (skipped — MEMORY_DB not present)'); return; }
  const r = run('/bin/bash', [HOOK], { env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT }, cwd: REPO_ROOT });
  eq(r.status, 0, 'must exit 0');
  eq(r.stderr, '', 'must never write to stderr — not even a job-control notice');
  assert(r.stdout.length > 0, 'should emit a block for a repo with memory');
  // Shape only; never print the content.
  console.log(`  hook stdout: ${r.stdout.split('\n').length} lines, ${r.stdout.length} chars, ~${estimateTokens(r.stdout)} tokens`);
});

t('the watchdog kill path yields empty output and exit 0, not a broken session', () => {
  const r = run('/bin/bash', [HOOK], {
    env: { ...process.env, BRAIN_SESSION_TIMEOUT_SECS: '0', CLAUDE_PROJECT_DIR: REPO_ROOT },
    cwd: REPO_ROOT,
  });
  eq(r.status, 0, 'a timed-out render must still exit 0');
  eq(r.stdout, '', 'a killed render must print nothing rather than half a block');
  eq(r.stderr, '', 'must never write to stderr');
});

t('the hook emits the renderer output only when the renderer exited 0 (never a truncated JSON)', () => {
  // A fake brain repo whose renderer we control. The real one prints SessionStart
  // JSON; a renderer that dies mid-write leaves half a document, which the host
  // would reject as a broken hook — so a non-zero exit must produce NO output.
  const mk = (name, body) => {
    const repo = join(ROOT, name);
    mkdirSync(join(repo, 'bin', 'lib'), { recursive: true });
    writeFileSync(join(repo, 'bin', 'lib', 'sessionstart.mjs'), body);
    return repo;
  };
  const env = (repo) => ({ ...process.env, CLAUDE_BRAIN_DIR: repo, CLAUDE_PROJECT_DIR: ROOT });
  const doc = JSON.stringify({ systemMessage: 'hi', hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } });

  const good = run('/bin/bash', [HOOK], { env: env(mk('hook-good', `process.stdout.write(${JSON.stringify(doc)});\n`)) });
  eq(good.status, 0, 'good: must exit 0');
  eq(JSON.stringify(JSON.parse(good.stdout)), doc, 'good: the renderer JSON passes through intact');

  const cut = run('/bin/bash', [HOOK], { env: env(mk('hook-cut', `process.stdout.write(${JSON.stringify(doc.slice(0, 40))});\nprocess.exit(1);\n`)) });
  eq(cut.status, 0, 'crashed renderer: hook must still exit 0');
  eq(cut.stdout, '', 'crashed renderer: a truncated document must never be emitted');
  eq(cut.stderr, '', 'crashed renderer: stderr stays empty');

  const hung = run('/bin/bash', [HOOK], { env: { ...env(mk('hook-hung', `process.stdout.write(${JSON.stringify(doc.slice(0, 40))});\nsetInterval(() => {}, 1000);\n`)), BRAIN_SESSION_TIMEOUT_SECS: '1' } });
  eq(hung.status, 0, 'hung renderer: hook must still exit 0');
  eq(hung.stdout, '', 'hung renderer: the watchdog kill must yield no output, not half a document');
});

t('a junk watchdog timeout falls back to the default instead of killing instantly', () => {
  if (!existsSync(MEMORY_DB)) { console.log('  (skipped — MEMORY_DB not present)'); return; }
  const r = run('/bin/bash', [HOOK], {
    env: { ...process.env, BRAIN_SESSION_TIMEOUT_SECS: 'not-a-number', CLAUDE_PROJECT_DIR: REPO_ROOT },
    cwd: REPO_ROOT,
  });
  eq(r.status, 0, 'must exit 0');
  eq(r.stderr, '', 'must never write to stderr');
  assert(r.stdout.length > 0, 'a junk timeout must not silently suppress the block every session');
});

/**
 * Run the hook as the leader of its own process group, then report every
 * process still in that group once it has exited. Background jobs of a
 * non-interactive bash keep the group, and orphans keep it after reparenting
 * to init, so this finds a leaked watchdog (or its `sleep`) exactly, without
 * the global `pgrep sleep` count the old check used — which any unrelated
 * `sleep 0.1` on the machine (another session's hook) could trip.
 */
function runHookAndListLeftovers(env, cwd, cmdArgs = [HOOK]) {
  const r = spawnSync('/bin/bash', cmdArgs, { env, cwd, encoding: 'utf8', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pgid = r.pid;
  const ps = run('/bin/ps', ['-A', '-o', 'pid=,pgid=,command=']).stdout.split('\n');
  const left = ps.map((l) => l.trim().split(/\s+/)).filter((c) => Number(c[1]) === pgid).map((c) => c.slice(2).join(' '));
  for (const l of ps.map((x) => x.trim().split(/\s+/)).filter((c) => Number(c[1]) === pgid)) { // never leave a leak running
    try { process.kill(Number(l[0]), 'SIGKILL'); } catch { /* already gone */ }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, left };
}

t('the hook leaves no temp files and no stray watchdog processes behind (every path)', () => {
  // A fake brain repo per scenario so the check never depends on the real store
  // being present: renderer fast, renderer slow enough that the poller is
  // certainly mid-`sleep 0.1` when it finishes, renderer crashing, renderer
  // hung until the watchdog kills it.
  const doc = JSON.stringify({ systemMessage: 'hi', hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } });
  const scenarios = {
    fast: [`process.stdout.write(${JSON.stringify(doc)});`, {}],
    slow: [`setTimeout(() => process.stdout.write(${JSON.stringify(doc)}), 350);`, {}],
    crash: ['process.exit(3);', {}],
    hung: ['setInterval(() => {}, 1000);', { BRAIN_SESSION_TIMEOUT_SECS: '1' }],
    junk: [`process.stdout.write(${JSON.stringify(doc)});`, { BRAIN_SESSION_TIMEOUT_SECS: 'abc' }],
  };
  for (const [name, [body, extra]] of Object.entries(scenarios)) {
    const repo = join(ROOT, `leak-${name}`);
    mkdirSync(join(repo, 'bin', 'lib'), { recursive: true });
    writeFileSync(join(repo, 'bin', 'lib', 'sessionstart.mjs'), body + '\n');
    for (let i = 0; i < 3; i++) {
      const r = runHookAndListLeftovers({ ...process.env, CLAUDE_BRAIN_DIR: repo, CLAUDE_PROJECT_DIR: ROOT, ...extra }, ROOT);
      eq(r.status, 0, `${name}: must exit 0`);
      eq(r.stderr, '', `${name}: must never write to stderr`);
      eq(r.left.join(' | '), '', `${name} run ${i}: processes left behind by the hook`);
      const tmp = run('/bin/bash', ['-c', `ls ${JSON.stringify(join(repo, '.brain-tmp'))} 2>/dev/null | grep -c session-context`]).stdout.trim();
      eq(tmp, '0', `${name}: the hook must clean up its temp file`);
    }
  }
});

t('a host signal to the hook reaps the renderer and the watchdog too (no unbounded orphan)', () => {
  // The host may kill the hook itself. A hung renderer must not outlive it: the
  // watchdog that would have bounded it dies with the hook, so the hook's own
  // trap has to take the renderer down. The driver runs the hook as a child of
  // a group leader, waits (bounded) until the renderer has really started, then
  // signals ONLY the hook's pid, and reports the hook's exit status.
  const repo = join(ROOT, 'leak-signal');
  mkdirSync(join(repo, 'bin', 'lib'), { recursive: true });
  const ready = join(ROOT, 'leak-signal.ready');
  writeFileSync(join(repo, 'bin', 'lib', 'sessionstart.mjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'up');\nsetInterval(() => {}, 1000);\n`.replace('require(', 'process.getBuiltinModule('));
  const driver = `
    rm -f "$READY"
    /bin/bash "$HOOK" & hp=$!
    i=0
    while [ ! -e "$READY" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done
    kill -TERM "$hp"
    wait "$hp"; echo "hook-exit=$?"
  `;
  for (const sig of ['TERM', 'HUP', 'INT']) {
    const r = runHookAndListLeftovers(
      { ...process.env, CLAUDE_BRAIN_DIR: repo, CLAUDE_PROJECT_DIR: ROOT, READY: ready, HOOK, BRAIN_SESSION_TIMEOUT_SECS: '30' },
      ROOT,
      ['-c', driver.replace('-TERM', `-${sig}`)]
    );
    assert(existsSync(ready), `${sig}: the renderer never started, so the signal path was not exercised`);
    eq(r.stdout.trim(), 'hook-exit=0', `${sig}: a signalled hook must still exit 0`);
    eq(r.stderr, '', `${sig}: must never write to stderr`);
    eq(r.left.join(' | '), '', `${sig}: processes left behind after the hook was signalled`);
    rmSync(ready, { force: true });
  }
  const tmp = run('/bin/bash', ['-c', `ls ${JSON.stringify(join(repo, '.brain-tmp'))} 2>/dev/null | grep -c session-context`]).stdout.trim();
  eq(tmp, '0', 'a signalled hook must clean up its temp file');
});

t('the real hook against the real renderer leaves nothing behind, with or without a store', () => {
  const fakeHome = join(ROOT, 'leak-fake-home');
  mkdirSync(fakeHome, { recursive: true });
  for (const env of [
    { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT },                 // whatever store this machine has
    { ...process.env, HOME: fakeHome, CLAUDE_PROJECT_DIR: REPO_ROOT }, // fresh machine: no store
  ]) {
    for (let i = 0; i < 3; i++) {
      const r = runHookAndListLeftovers(env, REPO_ROOT);
      eq(r.status, 0, 'must exit 0');
      eq(r.stderr, '', 'must never write to stderr');
      eq(r.left.join(' | '), '', 'processes left behind by the hook');
    }
  }
  const tmp = run('/bin/bash', ['-c', `ls ${JSON.stringify(join(REPO_ROOT, '.brain-tmp'))} 2>/dev/null | grep -c session-context`]).stdout.trim();
  eq(tmp, '0', 'the hook must clean up its temp file');
});

t('the hook resolves node by absolute path even with an empty PATH', () => {
  // The launchd/GUI case: PATH has nothing useful in it. The hook must still
  // find node, and must still exit 0 either way.
  const r = run('/bin/bash', [HOOK], {
    env: { ...process.env, PATH: '/nonexistent', CLAUDE_PROJECT_DIR: REPO_ROOT },
    cwd: REPO_ROOT,
  });
  eq(r.status, 0, 'must exit 0 with a stripped PATH');
  eq(r.stderr, '', 'must never write to stderr');
});

// =====================================================================
// real store — shape, size and timing only. NEVER content.
// =====================================================================

t('sanity: the real store renders fast and inside budget (shape only)', () => {
  if (!existsSync(MEMORY_DB)) {
    console.log('  (skipped — MEMORY_DB not present on this machine)');
    return;
  }
  const started = process.hrtime.bigint();
  const out = sessionContext({ cwd: REPO_ROOT, dbPath: MEMORY_DB, record: false });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert(typeof out.text === 'string', 'text must be a string');
  assert(out.tokens <= (out.budgetTokens || DEFAULT_BUDGET_TOKENS), `real block ${out.tokens} exceeded budget`);
  assert(ms < 1000, `real-store render took ${ms.toFixed(0)}ms — must be well under a second`);
  console.log(
    `  real store: project=${out.project} total=${out.total} shown=${out.rows} ` +
    `lines=${out.text ? out.text.split('\n').length : 0} chars=${out.text.length} ` +
    `~tokens=${out.tokens}/${out.budgetTokens} render=${ms.toFixed(1)}ms`
  );
});

t('sanity: an unknown project against the real store degrades to the empty state', () => {
  if (!existsSync(MEMORY_DB)) { console.log('  (skipped — MEMORY_DB not present)'); return; }
  const out = sessionContext({ project: 'no-such-project-abcxyz-123', dbPath: MEMORY_DB, record: false });
  eq(out.rows, 0, 'no rows');
  assert(out.text.includes('no memory'), 'should be the short empty state');
  assert(out.text.split('\n').length <= 6, 'empty state stays short even against a 30k-row store');
});

// ── report ──────────────────────────────────────────────────────────────
console.log(`\nsessionstart-test: ${pass} passed, ${fail} failed\n`);
for (const [status, name, msg] of results) {
  console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}${msg ? `\n      ${msg}` : ''}`);
}
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
if (fail > 0) process.exit(1);
