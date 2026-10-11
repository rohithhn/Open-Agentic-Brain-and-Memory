#!/usr/bin/env node
// pruneCommonTerms (bin/lib/fts.mjs): terms in more than half the rows are
// dropped from the FTS5 query (BM25 already gives them ~zero weight), so
// search is faster without changing what ranks first.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../bin/lib/store.mjs';
import { ftsMatchExpr, pruneCommonTerms, MIN_ROWS_TO_PRUNE } from '../bin/lib/fts.mjs';
// The fixture is 10 rows; the product only prunes from MIN_ROWS_TO_PRUNE up.
const prune = (db, e) => pruneCommonTerms(db, e, { minRows: 0 });

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

const dir = mkdtempSync(join(tmpdir(), 'fts-prune-test-'));
try {
  const db = new DatabaseSync(join(dir, 'brain.db'));
  ensureSchema(db);
  const ins = db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch, content_hash) VALUES ('s','p','discovery',?,?,'2026-01-01',0,?)`);
  // "the"/"we" in every row, "sync" in 3, "keychain" in 1 → N = 10
  const rows = [
    ['the sync bug', 'we fixed the sync race in the keychain unlock'],
    ['the sync retry', 'we added a retry to the sync job'],
    ['the sync docs', 'we documented the sync flow'],
    ...Array.from({ length: 7 }, (_, i) => [`the note ${i}`, `we wrote the note number ${i}`]),
  ];
  rows.forEach(([title, narrative], i) => ins.run(title, narrative, `h${i}`));
  const rank = (expr) => db.prepare('SELECT rowid AS id FROM observations_fts WHERE observations_fts MATCH ? ORDER BY rank LIMIT 3').all(expr).map((r) => r.id);

  t('drops terms in more than half the rows (and terms in none), keeps the rest in order', () => {
    eq(prune(db, ftsMatchExpr('how did we fix the sync keychain')), '"sync" OR "keychain"', 'pruned');
  });
  t('top results are unchanged by pruning', () => {
    const full = ftsMatchExpr('we fixed the sync keychain');
    eq(rank(prune(db, full)), rank(full), 'top 3');
  });
  t('when every term is common, the rarest (up to 3) are kept so the query still matches', () => {
    eq(prune(db, ftsMatchExpr('the we')), '"the" OR "we"', 'all common');
  });
  t('below MIN_ROWS_TO_PRUNE the expression is never touched', () => {
    const e = ftsMatchExpr('the sync keychain');
    eq(pruneCommonTerms(db, e), e, `store of 10 < ${MIN_ROWS_TO_PRUNE}`);
  });
  t('a term every row has is not traded for terms no row has (one-row brain keeps its topic word)', () => {
    // all present terms common, absent terms dropped: the rarest PRESENT ones stay
    eq(prune(db, ftsMatchExpr('could you remind me where we discussed the')), '"we" OR "the"', 'present terms kept');
  });
  t('a single term or an empty expression is returned as is', () => {
    eq(prune(db, '"the"'), '"the"', 'single');
    eq(prune(db, ''), '', 'empty');
  });
  t('nothing to prune returns the identical string', () => {
    const e = ftsMatchExpr('sync keychain');
    eq(prune(db, e), e, 'unchanged');
  });
  t('any failure (no FTS table) falls back to the original expression', () => {
    const bare = new DatabaseSync(':memory:');
    eq(prune(bare, '"a" OR "b"'), '"a" OR "b"', 'fallback');
    bare.close();
  });
  t('works on a read-only handle (the vocab table lives in temp)', () => {
    const ro = new DatabaseSync(join(dir, 'brain.db'), { readOnly: true });
    eq(prune(ro, ftsMatchExpr('the sync keychain')), '"sync" OR "keychain"', 'readonly');
    ro.close();
  });
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
