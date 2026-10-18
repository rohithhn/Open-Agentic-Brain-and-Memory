// `brain switch-from-claude-mem` — move a claude-mem user onto Open Agentic Brain and Memory in
// one command, without breaking claude-mem.
//
//   1. PLAN (default, writes nothing): what the import would copy, which tools
//      would be wired, which claude-mem settings would change.
//   2. --apply:
//        a. import claude-mem's DB into the native store and VERIFY it (the
//           source is opened read-only by import-claude-mem.mjs, always). An
//           unverified import stops here — nothing is wired or silenced, so the
//           user is never left with claude-mem muted and a partial brain.
//        b. wire Open Agentic Brain and Memory everywhere (bridge home, MCP server in every
//           detected tool, Claude Code startup hook, context digest) — the same
//           steps `brain onboard` runs, minus the launchd installs.
//        c. if the user keeps claude-mem (the default): silence ONLY its
//           SessionStart context dump. Capture is untouched — its hooks, worker
//           and Haiku distillation keep running, and `brain sync` keeps pulling
//           the new rows across. Otherwise every Claude Code session would open
//           with two memory dumps.
//   3. --undo: put back exactly what step 2 changed in claude-mem's settings,
//      and drop the READY marker if this command was the one that set it.
//
// How the silence works: claude-mem reads ~/.claude-mem/settings.json on every
// SessionStart. Its CLAUDE_MEM_CONTEXT_* keys size the dump (observations,
// session summaries, full-narrative rows, last summary / message). Setting them
// to zero leaves claude-mem's one-line empty-state notice — the dump itself is
// gone. We deliberately do NOT edit the plugin's hooks.json: it lives in a
// versioned cache dir that every plugin update replaces, and removing the hook
// would also stop the `start` command that boots the capture worker.
//
// Backups: the settings file is copied to <store dir>/backups/ before it is
// touched, and the prior value of every key we set is recorded in
// <store dir>/switch-from-claude-mem.json. Undo restores key by key, and leaves
// alone any key the user has changed since (reported, never clobbered).
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { importClaudeMem } from './import-claude-mem.mjs';
import { storeReady, clearStoreReady } from './store.mjs';

// claude-mem settings that size its SessionStart context. Values are strings —
// that is how claude-mem stores every setting.
export const SILENCE_KEYS = {
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: '0',
  CLAUDE_MEM_CONTEXT_SESSION_COUNT: '0',
  CLAUDE_MEM_CONTEXT_FULL_COUNT: '0',
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
};

const STATE_NAME = 'switch-from-claude-mem.json';
export const statePath = (dest) => join(dirname(dest), STATE_NAME);

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function readJsonObject(file) {
  if (!existsSync(file)) return { existed: false, obj: {} };
  const raw = readFileSync(file, 'utf8');
  if (!raw.trim()) return { existed: true, obj: {} };
  let obj;
  try { obj = JSON.parse(raw); } catch { return { existed: true, error: `${file} is not valid JSON — fix it, then re-run` }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { existed: true, error: `${file} is not a JSON object` };
  return { existed: true, obj };
}

// ── silence ─────────────────────────────────────────────────────────────────

/** What silencing would change. Read-only. */
export function planSilence(settingsFile) {
  const r = readJsonObject(settingsFile);
  if (r.error) return { file: settingsFile, existed: r.existed, error: r.error, changes: [] };
  const changes = [];
  for (const [key, to] of Object.entries(SILENCE_KEYS)) {
    const from = Object.prototype.hasOwnProperty.call(r.obj, key) ? r.obj[key] : null;
    if (from !== to) changes.push({ key, from, to });
  }
  return { file: settingsFile, existed: r.existed, changes };
}

/**
 * Silence claude-mem's startup dump. Backs up the settings file first; every
 * other key is preserved. Returns the record undo needs.
 */
export function applySilence(settingsFile, backupDir) {
  const plan = planSilence(settingsFile);
  if (plan.error) return { ok: false, ...plan };
  if (!plan.changes.length) return { ok: true, ...plan, backup: null, prior: {} };
  const { obj } = readJsonObject(settingsFile);
  let backup = null;
  if (plan.existed) {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    backup = join(backupDir, `claude-mem-settings-${stamp()}.json`);
    for (let n = 1; existsSync(backup); n++) backup = join(backupDir, `claude-mem-settings-${stamp()}.${n}.json`);
    copyFileSync(settingsFile, backup);
  }
  const prior = {};
  for (const c of plan.changes) { prior[c.key] = c.from; obj[c.key] = c.to; }
  mkdirSync(dirname(settingsFile), { recursive: true });
  const tmp = settingsFile + '.brain-tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, settingsFile);
  return { ok: true, ...plan, backup, prior };
}

// ── wiring (the parts of `brain onboard` that make the brain the memory) ─────

async function wireEverywhere({ write, log }) {
  const steps = [];
  const step = async (name, fn) => {
    try { steps.push({ step: name, ...(await fn()) }); }
    catch (e) { steps.push({ step: name, ok: false, detail: e.message }); }
  };
  await step('bridge home', async () => {
    const { installBridgeHome } = await import('./bridgehome.mjs');
    const b = installBridgeHome({ dry: !write });
    return { ok: true, detail: b.changed ? (write ? 'installed/refreshed' : 'would install/refresh') : 'already current' };
  });
  await step('MCP server', async () => {
    const { wireMcp } = await import('./wire.mjs');
    const r = wireMcp({ write, log });
    if (!r.ok) return { ok: false, detail: r.error };
    const on = r.results.filter((t) => t.installed);
    return { ok: true, detail: on.length ? on.map((t) => `${t.tool}: ${t.action}`).join('; ') : 'no AI tools detected' };
  });
  await step('Claude Code startup hook', async () => {
    const { wireSessionHook } = await import('./wire-hook.mjs');
    const r = wireSessionHook({ write });
    return { ok: r.every((x) => x.ok), detail: r.length ? r.map((x) => `${x.profile}: ${x.action}`).join('; ') : 'no Claude Code profile found' };
  });
  await step('context digest', async () => {
    const { injectContext } = await import('./inject.mjs');
    const r = injectContext({ write, log: () => {} });
    if (!r.ok && r.error) return { ok: !write, detail: r.error };
    const on = (r.results || []).filter((t) => t.installed !== false);
    return { ok: true, detail: on.length ? on.map((t) => `${t.label}: ${t.action}`).join('; ') : 'no instruction files to inject' };
  });
  return steps;
}

// ── main entry point ─────────────────────────────────────────────────────────

/**
 * @param {object}  opts
 * @param {string}  opts.source            claude-mem DB (opened read-only)
 * @param {string}  opts.dest              native store path
 * @param {string}  opts.settingsFile      claude-mem settings.json
 * @param {boolean} [opts.apply]           false (default) = plan only, writes nothing
 * @param {boolean} [opts.silence]         keep claude-mem but mute its startup dump (default true)
 * @param {Function} [opts.wire]           ({write, log}) => steps[]; default wires every detected tool
 */
export async function switchFromClaudeMem({ source, dest, settingsFile, apply = false, silence = true, wire = wireEverywhere, log = () => {} } = {}) {
  if (!source || !dest || !settingsFile) throw new Error('switchFromClaudeMem: source, dest and settingsFile are required');
  const out = { ok: false, dryRun: !apply, source, dest, settingsFile, import: null, wiring: [], silence: null, statePath: statePath(dest), warnings: [] };

  if (!existsSync(source)) {
    out.error = `no claude-mem database at ${source} — nothing to switch from. (Fresh install? Run: brain init)`;
    return out;
  }

  const readyBefore = storeReady(dest);

  // ── plan ──────────────────────────────────────────────────────────────────
  if (!apply) {
    out.import = await importClaudeMem({ source, dest, apply: false });
    out.wiring = await wire({ write: false, log });
    out.silence = silence ? planSilence(settingsFile) : { skipped: 'claude-mem left exactly as it is (--no-silence)' };
    if (out.silence.error) out.warnings.push(out.silence.error);
    out.ok = out.import.ok && !out.silence.error;
    return out;
  }

  // ── a. import + verify (one automatic retry: claude-mem writes continuously,
  // and a second pass of this idempotent import usually clears a race) ──────
  let imp = await importClaudeMem({ source, dest, apply: true, resume: false, verify: true, log });
  if (!imp.ok) {
    log('  verification did not pass — retrying once');
    imp = await importClaudeMem({ source, dest, apply: true, resume: false, verify: true, log });
  }
  out.import = imp;
  if (!imp.ok) {
    out.error = 'the import did not verify — stopped before wiring or touching claude-mem. claude-mem is still your memory; re-run to retry.';
    return out;
  }

  // ── b. wire the brain everywhere ─────────────────────────────────────────
  out.wiring = await wire({ write: true, log });
  for (const s of out.wiring) if (!s.ok) out.warnings.push(`${s.step}: ${s.detail}`);

  // ── c. silence claude-mem's startup dump (capture untouched) ─────────────
  if (silence) {
    out.silence = applySilence(settingsFile, join(dirname(dest), 'backups'));
    if (!out.silence.ok) out.warnings.push(out.silence.error);
  } else {
    out.silence = { skipped: 'claude-mem left exactly as it is (--no-silence)' };
  }

  // Record what undo needs. A second switch keeps the FIRST run's prior values
  // (the user's originals) rather than recording our own zeros as "prior".
  const prev = readState(dest);
  const priorSettings = { ...(out.silence?.prior || {}), ...(prev?.claudeMemSettings?.prior || {}) };
  const state = {
    version: 1,
    at: new Date().toISOString(),
    source,
    dest,
    readyMarkerSetByUs: prev ? !!prev.readyMarkerSetByUs : !readyBefore,
    claudeMemSettings: {
      file: settingsFile,
      existed: prev?.claudeMemSettings ? prev.claudeMemSettings.existed : !!out.silence?.existed,
      backup: prev?.claudeMemSettings?.backup || out.silence?.backup || null,
      prior: priorSettings,
    },
  };
  writeFileSync(out.statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  out.ok = !out.silence?.error;
  return out;
}

function readState(dest) {
  const f = statePath(dest);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

/**
 * Undo the switch: restore claude-mem's settings key by key, and drop the READY
 * marker if this command set it (readers fall back to claude-mem's DB). Imported
 * rows stay in the native store — claude-mem's DB was never modified, so there
 * is nothing to restore there. Tool wiring stays too; it is what `brain onboard`
 * installs and is harmless alongside claude-mem.
 */
// Order-insensitive deep equality for JSON values.
function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]));
}

export function undoSwitch({ dest, log = () => {} } = {}) {
  const state = readState(dest);
  if (!state) return { ok: false, error: `nothing to undo — no ${statePath(dest)} (switch-from-claude-mem was never applied here)` };
  const out = { ok: true, restored: [], keptUserEdits: [], readyCleared: false, fileRemoved: false, backup: state.claudeMemSettings?.backup || null };
  const cm = state.claudeMemSettings || {};
  if (cm.file && Object.keys(cm.prior || {}).length) {
    const r = readJsonObject(cm.file);
    if (r.error) return { ok: false, error: `${r.error} — restore it by hand from ${cm.backup || '(no backup: file did not exist before)'}` };
    const obj = r.obj;
    for (const [key, prior] of Object.entries(cm.prior)) {
      // Changed since we set it? That's the user's choice now — leave it.
      if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== SILENCE_KEYS[key]) { out.keptUserEdits.push(key); continue; }
      if (prior === null) delete obj[key]; else obj[key] = prior;
      out.restored.push(key);
    }
    if (!cm.existed && !Object.keys(obj).length) {
      if (existsSync(cm.file)) { rmSync(cm.file); out.fileRemoved = true; }
    } else if (r.existed || Object.keys(obj).length) {
      const tmp = cm.file + '.brain-tmp';
      // Byte-exact when nothing else changed: if the restored settings equal the
      // backup taken before the switch, put the backup's own bytes back (its
      // formatting, key order, trailing newline) instead of re-serialising.
      let bytes = JSON.stringify(obj, null, 2) + '\n';
      try {
        if (cm.backup && existsSync(cm.backup)) {
          const orig = readFileSync(cm.backup, 'utf8');
          if (sameJson(JSON.parse(orig), obj)) bytes = orig;
        }
      } catch { /* unreadable backup: the re-serialised form is still correct */ }
      writeFileSync(tmp, bytes);
      renameSync(tmp, cm.file);
    }
  }
  if (state.readyMarkerSetByUs) out.readyCleared = clearStoreReady(dest);
  renameSync(statePath(dest), statePath(dest) + `.undone-${stamp()}`);
  log(`  undo: restored ${out.restored.length} claude-mem setting(s)`);
  return out;
}

// ── report ───────────────────────────────────────────────────────────────────

export function formatSwitchReport(r) {
  const L = [];
  L.push(r.dryRun ? '🔀 switch-from-claude-mem — PLAN (nothing written)' : '🔀 switch-from-claude-mem — applied');
  if (r.error && !r.import) { L.push(`  ✖ ${r.error}`); return L.join('\n'); }
  const imp = r.import;
  if (imp) {
    L.push('');
    L.push(`1) import claude-mem → native store (source read-only: ${r.source})`);
    for (const t of imp.tables) {
      if (t.skipped) { L.push(`   ${t.table.padEnd(18)} — ${t.skipped}`); continue; }
      L.push(r.dryRun
        ? `   ${t.table.padEnd(18)} ${String(t.sourceRows).padStart(7)} in claude-mem, ${t.projectedInserts} to copy, ${t.alreadyPresent} already here`
        : `   ${t.table.padEnd(18)} +${t.inserted} copied, ${t.alreadyPresent} already here${t.rejected ? `, ❌ ${t.rejected} rejected` : ''}`);
    }
    if (imp.verification) L.push(`   verification: ${imp.verification.ok ? 'PASSED' : '❌ FAILED'}`);
  }
  if (r.error) { L.push(''); L.push(`  ✖ ${r.error}`); return L.join('\n'); }
  L.push('');
  L.push(`2) wire Open Agentic Brain and Memory into your tools${r.dryRun ? ' (preview)' : ''}`);
  for (const s of r.wiring) L.push(`   ${s.ok ? '✅' : '⚠️ '} ${s.step}: ${s.detail}`);
  L.push('');
  L.push('3) claude-mem\'s startup context dump');
  const si = r.silence;
  if (!si || si.skipped) L.push(`   ${si ? si.skipped : 'skipped'}`);
  else if (si.error) L.push(`   ⚠️  ${si.error}`);
  else if (!si.changes.length) L.push('   already silenced — nothing to change');
  else {
    L.push(`   ${r.dryRun ? 'would set' : 'set'} in ${si.file}${si.existed ? '' : ' (new file)'}:`);
    for (const c of si.changes) L.push(`     ${c.key}: ${c.from === null ? '(unset)' : JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
    if (si.backup) L.push(`   backup: ${si.backup}`);
    L.push('   claude-mem keeps capturing (hooks, worker, Haiku distillation untouched); the brain shows memory at startup instead.');
  }
  if (r.warnings.length) { L.push(''); L.push('Notes'); for (const w of r.warnings) L.push(`   • ${w}`); }
  L.push('');
  if (r.dryRun) L.push('Re-run with --apply to do it. Nothing has been changed.');
  else {
    L.push(`Undo any time: brain switch-from-claude-mem --undo   (record: ${r.statePath})`);
    L.push('Start a new Claude Code session (and restart any desktop apps listed above) to pick it up.');
  }
  return L.join('\n');
}

export function formatUndoReport(r) {
  if (!r.ok) return `✖ ${r.error}`;
  const L = ['↩️  switch-from-claude-mem — undone'];
  L.push(`   claude-mem settings restored: ${r.restored.length ? r.restored.join(', ') : 'none'}${r.fileRemoved ? ' (file removed — it did not exist before)' : ''}`);
  if (r.keptUserEdits.length) L.push(`   left as you changed them since: ${r.keptUserEdits.join(', ')}`);
  L.push(`   readers: ${r.readyCleared ? 'back on claude-mem\'s DB (READY marker removed)' : 'unchanged'}`);
  if (r.backup) L.push(`   original settings backup kept at ${r.backup}`);
  L.push('   imported rows stay in the native store; tool wiring stays (remove with your tools\' settings if unwanted).');
  return L.join('\n');
}

