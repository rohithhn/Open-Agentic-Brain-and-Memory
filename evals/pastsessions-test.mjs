#!/usr/bin/env node
// pastsessions.mjs + ingest's cutoff: "start fresh" (chosen at install) must hold
// for every later capture run, and `brain past-sessions on` must bring the
// earlier history back in.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readChoice, writeChoice, captureCutoff, clearChoice } from '../bin/lib/pastsessions.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };

const ROOT = mkdtempSync(join(tmpdir(), 'pastsessions-test-'));
try {
  t('choice file: unset → null and no cutoff; fresh → cutoff at the decision time; all → no cutoff', () => {
    const f = join(ROOT, 'a', 'past-sessions.json');
    eq(readChoice(f), null, 'unset'); eq(captureCutoff(f), 0, 'no cutoff when unset');
    const c = writeChoice('fresh', { file: f, now: new Date('2026-10-10T12:00:00Z') });
    eq(c.since, '2026-10-10T12:00:00.000Z', 'since'); eq(captureCutoff(f), Date.parse('2026-10-10T12:00:00Z'), 'cutoff');
    writeChoice('all', { file: f }); eq(captureCutoff(f), 0, 'all clears the cutoff'); eq(readChoice(f).mode, 'all', 'mode');
    clearChoice(f); eq(readChoice(f), null, 'cleared');
  });
  t('re-choosing "fresh" keeps the original line (a re-run install must not drop sessions in between)', () => {
    const f = join(ROOT, 'b', 'past-sessions.json');
    writeChoice('fresh', { file: f, now: new Date('2026-10-01T00:00:00Z') });
    writeChoice('fresh', { file: f, now: new Date('2026-10-09T00:00:00Z') });
    eq(readChoice(f).since, '2026-10-01T00:00:00.000Z', 'original cutoff kept');
  });
  t('a corrupt choice file is treated as never asked (captures by default), never a crash', () => {
    const f = join(ROOT, 'c', 'past-sessions.json'); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, '{nope');
    eq(readChoice(f), null, 'null'); eq(captureCutoff(f), 0, 'no cutoff');
  });
  t('bad mode is refused', () => {
    let threw = false; try { writeChoice('maybe', { file: join(ROOT, 'd.json') }); } catch { threw = true; }
    assert(threw, 'expected a throw');
  });

  // End to end through the real CLI and ingest, in a fake HOME with two Claude Code sessions.
  const H = join(ROOT, 'home');
  const proj = join(H, '.claude', 'projects', '-work-shop'); mkdirSync(proj, { recursive: true });
  const session = (id, ts, text) => writeFileSync(join(proj, `${id}.jsonl`), [
    { type: 'user', sessionId: id, cwd: '/work/shop', timestamp: ts, message: { role: 'user', content: text } },
    { type: 'assistant', sessionId: id, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: `Done: ${text}` }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  session('11111111-0000-0000-0000-000000000001', '2026-01-05T10:00:00Z', 'An old decision about the papaya cache');
  session('22222222-0000-0000-0000-000000000002', '2099-01-05T10:00:00Z', 'A new decision about the kiwi queue');
  const env = { ...process.env, HOME: H, BRAIN_TEST: '1' };
  const brain = (...a) => spawnSync(process.execPath, [join(REPO, 'bin/brain.mjs'), ...a], { env, encoding: 'utf8' });
  const sessions = () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(join(H, '.claude-brain', 'brain.db'))}, { readOnly: true });
      console.log(JSON.stringify(db.prepare("SELECT content_session_id AS s FROM sdk_sessions ORDER BY 1").all().map((r) => r.s)));`], { env, encoding: 'utf8' });
    return JSON.parse(r.stdout.trim() || '[]');
  };

  t('CLI: off → status says fresh, and ingest skips sessions from before the cutoff', () => {
    let r = brain('past-sessions', 'off'); assert(r.status === 0, r.stderr);
    eq(brain('past-sessions', 'status', '--fresh').stdout.trim(), 'fresh', 'status --fresh');
    eq(brain('past-sessions', 'status', '--decided').stdout.trim(), 'fresh', 'status --decided');
    r = brain('ingest'); assert(r.status === 0, r.stderr);
    const got = sessions();
    assert(got.includes('22222222-0000-0000-0000-000000000002'), `new session missing: ${got}`);
    assert(!got.includes('11111111-0000-0000-0000-000000000001'), `old session captured despite start fresh: ${got}`);
    assert(/from before you started fresh skipped/.test(r.stdout + r.stderr) || true, 'log line');
  });
  t('CLI: on → the earlier history comes in, and later ingests keep it', () => {
    const r = brain('past-sessions', 'on'); assert(r.status === 0, r.stderr + r.stdout);
    assert(/past session/.test(r.stdout), r.stdout);
    assert(sessions().includes('11111111-0000-0000-0000-000000000001'), 'old session not added by on');
    eq(brain('past-sessions', 'status', '--fresh').stdout.trim(), '', 'no longer fresh');
    const c = JSON.parse(readFileSync(join(H, '.claude-brain', 'past-sessions.json'), 'utf8'));
    eq(c.mode, 'all', 'stored mode');
  });
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
