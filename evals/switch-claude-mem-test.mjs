#!/usr/bin/env node
// Tests for `brain switch-from-claude-mem` (bin/lib/switch-claude-mem.mjs) and
// the opt-in claude-mem enabling in bin/lib/profiles.mjs.
//
// Two layers, both on synthetic data only:
//   A. in-process — explicit temp paths for the claude-mem DB, the native store
//      and claude-mem's settings.json, with a recording stub for tool wiring.
//   B. the real CLI under a sandbox $HOME (fake ~/.claude-mem, ~/.claude, …),
//      BRAIN_NO_AUTOMATION=1 — nothing here reads or writes the real home.
//
//   node evals/switch-claude-mem-test.mjs
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { switchFromClaudeMem, undoSwitch, planSilence, SILENCE_KEYS, statePath, formatSwitchReport } from '../bin/lib/switch-claude-mem.mjs';
import { claudeMemState, claudeMemOptIn } from '../bin/lib/profiles.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAIN = join(REPO, 'bin', 'brain.mjs');
const SCRATCH = process.env.SCRATCHPAD || tmpdir();
mkdirSync(SCRATCH, { recursive: true });
const ROOT = mkdtempSync(join(SCRATCH, 'switch-claude-mem-test-'));

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ── synthetic claude-mem DB (claude-mem's column layout, invented content) ────
const SCHEMA = `
CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT, memory_session_id TEXT UNIQUE,
  project TEXT, platform_source TEXT, user_prompt TEXT, started_at TEXT, started_at_epoch INTEGER,
  completed_at TEXT, completed_at_epoch INTEGER, status TEXT, worker_port INTEGER, prompt_counter INTEGER, custom_title TEXT);
CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT, text TEXT, type TEXT,
  title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT, files_read TEXT, files_modified TEXT,
  prompt_number INTEGER, discovery_tokens INTEGER, created_at TEXT, created_at_epoch INTEGER, content_hash TEXT,
  generated_by_model TEXT, relevance_count INTEGER);
CREATE UNIQUE INDEX ux_obs ON observations(memory_session_id, content_hash);
CREATE TABLE user_prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, session_db_id INTEGER, content_session_id TEXT,
  prompt_number INTEGER, prompt_text TEXT, created_at TEXT, created_at_epoch INTEGER);
CREATE TABLE session_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT, request TEXT,
  investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, files_read TEXT, files_edited TEXT, notes TEXT,
  prompt_number INTEGER, created_at TEXT, created_at_epoch INTEGER);`;

function buildClaudeMemDb(path, { sessions = 3, obs = 3, badRow = false, reDistilled = 0 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const e0 = 1_750_000_000_000;
  for (let s = 1; s <= sessions; s++) {
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt,
      started_at, started_at_epoch, status) VALUES (?,?,?,?,?,?,?,?)`)
      .run(`c-${s}`, `m-${s}`, 'synthetic-proj', 'claude', `prompt ${s}`, '2026-06-01T00:00:00Z', e0 + s * 1000, 'completed');
    for (let o = 0; o < obs; o++) {
      db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, facts, narrative, concepts,
        created_at, created_at_epoch, content_hash, generated_by_model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(`m-${s}`, 'synthetic-proj', `obs ${s}.${o}`, 'discovery', `switch title ${s}.${o}`, '["f"]', 'n', '["c"]',
          '2026-06-01T00:00:00Z', e0 + s * 1000 + o, `h-${s}-${o}`, 'claude-haiku-4-5');
      db.prepare(`INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
        VALUES (?,?,?,?,?,?)`).run(s, `c-${s}`, o, `p ${s}.${o}`, '2026-06-01T00:00:00Z', e0 + s * 1000 + o);
    }
    // prompt_number set, as in real claude-mem data (0 NULLs measured): the
    // natural key includes it, and NULLs never collide in a UNIQUE index.
    db.prepare(`INSERT INTO session_summaries (memory_session_id, project, request, prompt_number, created_at, created_at_epoch)
      VALUES (?,?,?,?,?,?)`).run(`m-${s}`, 'synthetic-proj', 'req', 1, '2026-06-01T00:00:00Z', e0 + s * 1000 + 500);
  }
  // claude-mem re-distils a session under a NEW memory_session_id and keeps the
  // old rows too: same project + content_hash, different session id. Real stores
  // carry these (117 of 28,283 measured); the import keeps them once.
  for (let i = 0; i < reDistilled; i++) {
    db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, facts, narrative, concepts,
      created_at, created_at_epoch, content_hash, generated_by_model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`m-regen-${i}`, 'synthetic-proj', `obs 1.${i}`, 'discovery', `switch title 1.${i}`, '["f"]', 'n', '["c"]',
        '2026-06-01T00:00:00Z', e0 + 1000 + i, `h-1-${i}`, 'claude-haiku-4-5');
  }
  // A status the native schema's CHECK rejects → the import cannot verify.
  if (badRow) {
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at,
      started_at_epoch, status) VALUES (?,?,?,?,?,?,?)`).run('c-bad', 'm-bad', 'p', 'claude', '2026-06-01T00:00:00Z', 1, 'zombie');
  }
  db.close();
  return path;
}

const count = (db, t) => { const d = new DatabaseSync(`file:${db}?mode=ro`, { readOnly: true }); try { return d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } finally { d.close(); } };

let caseN = 0;
function fixture({ settings = { CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_MODEL: 'claude-haiku-4-5', CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50' }, ...db } = {}) {
  const dir = join(ROOT, `case-${++caseN}`);
  const source = buildClaudeMemDb(join(dir, 'claude-mem', 'claude-mem.db'), db);
  const settingsFile = join(dir, 'claude-mem', 'settings.json');
  if (settings !== null) writeFileSync(settingsFile, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  const dest = join(dir, 'brain', 'brain.db');
  const calls = [];
  const wire = async ({ write }) => { calls.push(write); return [{ step: 'stub', ok: true, detail: write ? 'wired' : 'would wire' }]; };
  return { dir, source, settingsFile, dest, calls, wire };
}

// ═══ A. in-process ═══════════════════════════════════════════════════════════

await test('plan (default) writes nothing: no store, settings + source byte-identical', async () => {
  const f = fixture();
  const s0 = sha(f.settingsFile), src0 = sha(f.source);
  const r = await switchFromClaudeMem({ ...f });
  assert(r.ok && r.dryRun, `plan should be ok: ${r.error || JSON.stringify(r.warnings)}`);
  assert(!existsSync(f.dest), 'plan must not create the native store');
  assert(!existsSync(statePath(f.dest)), 'plan must not write the undo record');
  eq(sha(f.settingsFile), s0, 'plan changed claude-mem settings');
  eq(sha(f.source), src0, 'plan changed the claude-mem DB');
  eq(f.calls.join(), 'false', 'wiring must be previewed with write:false only');
  const obsPlan = r.import.tables.find((t) => t.table === 'observations');
  eq(obsPlan.projectedInserts, 9, 'plan counts the observations to copy');
  eq(r.silence.changes.length, Object.keys(SILENCE_KEYS).length, 'plan lists every key it would set');
  assert(/PLAN \(nothing written\)/.test(formatSwitchReport(r)), 'report must say nothing was written');
});

await test('real-store shape: re-distilled duplicates under new session ids still verify (regression)', async () => {
  const f = fixture({ reDistilled: 2 });
  const r = await switchFromClaudeMem({ ...f, apply: true });
  assert(r.ok, `apply must verify with re-distilled duplicates: ${r.error || JSON.stringify(r.import?.verification?.checks?.filter((c) => !c.ok))}`);
  eq(count(f.dest, 'observations'), 9, 'each duplicate kept once (9 distinct of 11 source rows)');
});

await test('undo restores claude-mem settings byte-for-byte (no trailing newline, custom formatting)', async () => {
  const raw = '{\n    "CLAUDE_MEM_MODEL": "claude-haiku-4-5",\n    "CLAUDE_MEM_RUNTIME": "worker"\n}';
  const f = fixture({ settings: raw });
  const before = sha(f.settingsFile);
  const r = await switchFromClaudeMem({ ...f, apply: true });
  assert(r.ok, `apply failed: ${r.error}`);
  assert(sha(f.settingsFile) !== before, 'apply must have changed the settings');
  const u = undoSwitch({ dest: f.dest });
  assert(u.ok, `undo failed: ${u.error}`);
  eq(sha(f.settingsFile), before, 'settings must be byte-identical after undo');
});

await test('--apply: import verifies, store READY, wired, startup dump silenced, capture keys kept, backup made', async () => {
  const f = fixture();
  const orig = readFileSync(f.settingsFile, 'utf8'), src0 = sha(f.source);
  const r = await switchFromClaudeMem({ ...f, apply: true });
  assert(r.ok, `apply failed: ${r.error || JSON.stringify(r.warnings)}`);
  assert(r.import.verification && r.import.verification.ok, 'import must be verified');
  eq(count(f.dest, 'observations'), 9, 'all observations imported');
  eq(count(f.dest, 'sdk_sessions'), 3, 'all sessions imported');
  assert(existsSync(join(dirname(f.dest), 'READY')), 'verified import marks the store READY');
  eq(sha(f.source), src0, 'the claude-mem DB must never be modified');
  eq(f.calls.join(), 'true', 'wiring runs once, for real');
  const s = readJson(f.settingsFile);
  for (const [k, v] of Object.entries(SILENCE_KEYS)) eq(s[k], v, `${k} silenced`);
  eq(s.CLAUDE_MEM_RUNTIME, 'worker', 'unrelated claude-mem setting kept');
  eq(s.CLAUDE_MEM_MODEL, 'claude-haiku-4-5', 'capture model setting kept');
  assert(r.silence.backup && readFileSync(r.silence.backup, 'utf8') === orig, 'backup holds the original bytes');
  const st = readJson(statePath(f.dest));
  eq(st.claudeMemSettings.prior.CLAUDE_MEM_CONTEXT_OBSERVATIONS, '50', 'prior value recorded');
  eq(st.claudeMemSettings.prior.CLAUDE_MEM_CONTEXT_SESSION_COUNT, null, 'unset key recorded as unset');
  eq(st.readyMarkerSetByUs, true, 'records that this run set READY');
});

await test('re-apply is idempotent and keeps the ORIGINAL prior values for undo', async () => {
  const f = fixture();
  await switchFromClaudeMem({ ...f, apply: true });
  const r2 = await switchFromClaudeMem({ ...f, apply: true });
  assert(r2.ok, 're-apply should succeed');
  eq(r2.import.tables.reduce((n, t) => n + (t.inserted || 0), 0), 0, 're-apply inserts nothing');
  eq(r2.silence.changes.length, 0, 're-apply changes no settings');
  const st = readJson(statePath(f.dest));
  eq(st.claudeMemSettings.prior.CLAUDE_MEM_CONTEXT_OBSERVATIONS, '50', 'second run must not record our zeros as prior');
  eq(st.readyMarkerSetByUs, true, 'second run must not forget who set READY');
});

await test('--undo restores claude-mem settings exactly and returns readers to claude-mem', async () => {
  const f = fixture();
  const before = readJson(f.settingsFile);
  await switchFromClaudeMem({ ...f, apply: true });
  await switchFromClaudeMem({ ...f, apply: true });
  const u = undoSwitch({ dest: f.dest });
  assert(u.ok, `undo failed: ${u.error}`);
  eq(JSON.stringify(readJson(f.settingsFile)), JSON.stringify(before), 'settings back to the original keys + values');
  assert(!existsSync(join(dirname(f.dest), 'READY')), 'READY removed (it was set by the switch)');
  assert(u.readyCleared, 'undo reports the reader flip');
  assert(!existsSync(statePath(f.dest)), 'undo record retired');
  eq(count(f.dest, 'observations'), 9, 'imported rows are kept');
  const again = undoSwitch({ dest: f.dest });
  assert(!again.ok && /nothing to undo/.test(again.error), 'a second undo is a clean no-op error');
});

await test('undo never clobbers a setting the user changed after the switch', async () => {
  const f = fixture();
  await switchFromClaudeMem({ ...f, apply: true });
  const s = readJson(f.settingsFile);
  s.CLAUDE_MEM_CONTEXT_OBSERVATIONS = '7';
  s.CLAUDE_MEM_NEW_USER_KEY = 'x';
  writeFileSync(f.settingsFile, JSON.stringify(s));
  const u = undoSwitch({ dest: f.dest });
  assert(u.ok, 'undo ok');
  assert(u.keptUserEdits.includes('CLAUDE_MEM_CONTEXT_OBSERVATIONS'), 'user edit reported as kept');
  const after = readJson(f.settingsFile);
  eq(after.CLAUDE_MEM_CONTEXT_OBSERVATIONS, '7', 'user edit kept');
  eq(after.CLAUDE_MEM_NEW_USER_KEY, 'x', 'user-added key kept');
  assert(!('CLAUDE_MEM_CONTEXT_SESSION_COUNT' in after), 'key that was unset before is unset again');
});

await test('no settings file before → created by the switch, removed by undo', async () => {
  const f = fixture({ settings: null });
  const r = await switchFromClaudeMem({ ...f, apply: true });
  assert(r.ok && existsSync(f.settingsFile), 'settings file created');
  eq(r.silence.backup, null, 'nothing to back up');
  const u = undoSwitch({ dest: f.dest });
  assert(u.ok && u.fileRemoved && !existsSync(f.settingsFile), 'undo removes the file it created');
});

await test('unparseable claude-mem settings are refused, left byte-identical', async () => {
  const f = fixture({ settings: '{ not json' });
  const r = await switchFromClaudeMem({ ...f, apply: true });
  assert(!r.ok, 'must not report success when it could not silence');
  eq(readFileSync(f.settingsFile, 'utf8'), '{ not json', 'broken file must not be rewritten');
  assert(r.warnings.some((w) => /not valid JSON/.test(w)), 'the reason is surfaced');
});

await test('an import that does not verify stops before wiring or touching claude-mem', async () => {
  const f = fixture({ badRow: true });
  const s0 = sha(f.settingsFile);
  const r = await switchFromClaudeMem({ ...f, apply: true });
  assert(!r.ok && /did not verify/.test(r.error), `expected a verification stop, got ${r.error}`);
  eq(f.calls.length, 0, 'no wiring after a failed import');
  eq(sha(f.settingsFile), s0, 'claude-mem settings untouched after a failed import');
  assert(!existsSync(join(dirname(f.dest), 'READY')), 'no READY marker for an unverified import');
  assert(!existsSync(statePath(f.dest)), 'no undo record for a stopped run');
});

await test('--no-silence leaves claude-mem exactly as it is', async () => {
  const f = fixture();
  const s0 = sha(f.settingsFile);
  const r = await switchFromClaudeMem({ ...f, apply: true, silence: false });
  assert(r.ok && r.silence.skipped, 'silence skipped');
  eq(sha(f.settingsFile), s0, 'settings untouched');
});

await test('undo keeps a READY marker that existed before the switch', async () => {
  const f = fixture();
  await switchFromClaudeMem({ ...f, apply: true, silence: false }); // store becomes READY
  rmSync(statePath(f.dest)); // as if the store came from an earlier plain import
  await switchFromClaudeMem({ ...f, apply: true });
  eq(readJson(statePath(f.dest)).readyMarkerSetByUs, false, 'READY predates this switch');
  undoSwitch({ dest: f.dest });
  assert(existsSync(join(dirname(f.dest), 'READY')), 'undo must not demote a store that was already live');
});

await test('no claude-mem DB → clear error, nothing written', async () => {
  const dir = join(ROOT, 'no-source');
  const r = await switchFromClaudeMem({ source: join(dir, 'nope.db'), dest: join(dir, 'b', 'brain.db'), settingsFile: join(dir, 's.json'), apply: true, wire: async () => { throw new Error('must not wire'); } });
  assert(!r.ok && /no claude-mem database/.test(r.error), 'error names the missing DB');
  assert(!existsSync(dir), 'nothing created');
});

await test('planSilence reports only keys that differ', async () => {
  const f = fixture({ settings: { ...SILENCE_KEYS, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50' } });
  const p = planSilence(f.settingsFile);
  eq(p.changes.length, 1, 'one key differs');
  eq(p.changes[0].key, 'CLAUDE_MEM_CONTEXT_OBSERVATIONS', 'the right key');
});

await test('profiles: claudeMemState reads parsed settings, not substrings', async () => {
  eq(claudeMemState({ enabledPlugins: { 'claude-mem@thedotmack': true } }), 'enabled', 'enabled plugin');
  eq(claudeMemState({ enabledPlugins: { 'claude-mem@thedotmack': false } }), 'disabled', 'explicitly off is NOT "already enabled"');
  eq(claudeMemState({ hooks: { SessionStart: [{ hooks: [{ command: 'bash /opt/x/Brain-claude-mem/hooks/session-start-context.sh' }] }] } }),
    'absent', "a path containing 'claude-mem' is not claude-mem");
  eq(claudeMemState({ hooks: { PostToolUse: [{ hooks: [{ command: 'node ~/.claude/plugins/cache/thedotmack/claude-mem/1/scripts/worker-service.cjs hook' }] }] } }),
    'enabled', 'hand-wired hooks count as enabled');
  eq(claudeMemState({}), 'absent', 'empty settings');
});

await test('profiles: enabling claude-mem everywhere is opt-in', async () => {
  eq(claudeMemOptIn({ env: {}, cfg: {} }), false, 'off by default');
  eq(claudeMemOptIn({ flag: true, env: {}, cfg: {} }), true, '--with-claude-mem');
  eq(claudeMemOptIn({ env: { BRAIN_ENABLE_CLAUDE_MEM: '1' }, cfg: {} }), true, 'env opt-in');
  eq(claudeMemOptIn({ env: {}, cfg: { claudeMem: { enableEverywhere: true } } }), true, 'config opt-in');
});

// ═══ B. the real CLI under a sandbox $HOME ═══════════════════════════════════

const H = join(ROOT, 'home');
function brain(args, extraEnv = {}) {
  const env = { ...process.env, HOME: H, BRAIN_NO_AUTOMATION: '1', ...extraEnv };
  delete env.BRAIN_ENABLE_CLAUDE_MEM;
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [BRAIN, ...args], { env, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
// Every file under the sandbox HOME → sha, for "wrote nothing" checks.
function snapshot(dir = H, acc = {}) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) snapshot(p, acc); else acc[p] = sha(p);
  }
  return acc;
}
function setupHome() {
  buildClaudeMemDb(join(H, '.claude-mem', 'claude-mem.db'));
  writeFileSync(join(H, '.claude-mem', 'settings.json'), JSON.stringify({ CLAUDE_MEM_RUNTIME: 'worker' }, null, 2));
  mkdirSync(join(H, '.claude'), { recursive: true });
  writeFileSync(join(H, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { 'claude-mem@thedotmack': true },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo users-own-hook' }] }] },
    theme: 'dark',
  }, null, 2));
  mkdirSync(join(H, '.claude-work'), { recursive: true });
  writeFileSync(join(H, '.claude-work', 'settings.json'), JSON.stringify({ theme: 'light' }, null, 2));
}

setupHome();

await test('CLI: plan writes nothing under the sandbox HOME', async () => {
  const before = snapshot();
  const r = brain(['switch-from-claude-mem']);
  eq(r.code, 0, `plan exit code (output: ${r.out.slice(-800)})`);
  assert(/PLAN \(nothing written\)/.test(r.out), 'plan banner');
  assert(/CLAUDE_MEM_CONTEXT_OBSERVATIONS: \(unset\) → "0"/.test(r.out), 'plan shows the settings it would change');
  eq(JSON.stringify(snapshot()), JSON.stringify(before), 'a file under HOME changed during the plan');
});

await test('CLI: --apply imports, wires the startup hook, silences claude-mem, keeps its capture', async () => {
  const r = brain(['switch-from-claude-mem', '--apply']);
  eq(r.code, 0, `apply exit code (output: ${r.out.slice(-1500)})`);
  const store = join(H, '.claude-brain', 'brain.db');
  eq(count(store, 'observations'), 9, 'observations imported into the sandbox store');
  assert(existsSync(join(H, '.claude-brain', 'READY')), 'store READY');
  const cm = readJson(join(H, '.claude-mem', 'settings.json'));
  eq(cm.CLAUDE_MEM_CONTEXT_OBSERVATIONS, '0', 'startup dump silenced');
  eq(cm.CLAUDE_MEM_RUNTIME, 'worker', 'claude-mem runtime kept');
  const cs = readJson(join(H, '.claude', 'settings.json'));
  eq(cs.enabledPlugins['claude-mem@thedotmack'], true, 'claude-mem plugin (capture) still enabled');
  const cmds = cs.hooks.SessionStart.flatMap((g) => g.hooks.map((x) => x.command));
  assert(cmds.includes('echo users-own-hook'), "user's own hook kept");
  assert(cmds.some((c) => c.includes('session-start-context.sh')), 'brain startup hook wired');
  eq(cs.theme, 'dark', 'other user settings kept');
  assert(existsSync(join(H, '.agentic-brain')), 'bridge home installed in the sandbox');
  assert(/Undo any time/.test(r.out), 'report tells the user how to undo');
});

await test('CLI: --undo restores claude-mem settings and the reader flip', async () => {
  const r = brain(['switch-from-claude-mem', '--undo']);
  eq(r.code, 0, `undo exit code (output: ${r.out.slice(-800)})`);
  eq(JSON.stringify(readJson(join(H, '.claude-mem', 'settings.json'))), JSON.stringify({ CLAUDE_MEM_RUNTIME: 'worker' }), 'settings restored');
  assert(!existsSync(join(H, '.claude-brain', 'READY')), 'READY removed');
});

await test('CLI: onboard --dry-run no longer plans to enable claude-mem unless asked', async () => {
  const r = brain(['onboard', '--dry-run']);
  eq(r.code, 0, `onboard dry-run exit (output: ${r.out.slice(-800)})`);
  assert(/claude-mem plugin: left as it is/.test(r.out), 'default onboard leaves claude-mem alone');
  assert(!/would enable claude-mem/.test(r.out), 'default onboard must not plan to enable claude-mem');
  const w = brain(['onboard', '--dry-run', '--with-claude-mem']);
  eq(w.code, 0, 'opt-in onboard dry-run exit');
  assert(/plugin · work: would enable claude-mem/.test(w.out), `opt-in plans it for the profile without it:\n${w.out.slice(-1500)}`);
  assert(/plugin · default: already enabled/.test(w.out), 'already-enabled profile reported, not rewritten');
  eq(readJson(join(H, '.claude-work', 'settings.json')).enabledPlugins, undefined, 'dry-run wrote nothing');
});

// ==========================================================================
const w = Math.max(...results.map((r) => r[1].length));
for (const [st, name, msg] of results) console.log(`${st === 'PASS' ? '✅' : '❌'} ${name.padEnd(w)}${msg ? '\n    ' + msg : ''}`);
console.log(`\n${pass} passed, ${fail} failed  ·  sandbox: ${ROOT}`);
if (!fail && !process.env.BRAIN_SWITCH_TEST_KEEP) rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
