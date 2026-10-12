#!/usr/bin/env node
// Claude Brain CLI — the engine behind the Agentic Brain.
//   brain sync        push this machine's brain to the cloud repo
//   brain restore     pull the cloud brain onto this machine
//   brain merge       merge the repo's exported memory into the local DB
//   brain export      write memory exports locally (no git)
//   brain status      show brain status
//   brain key ...     manage the age encryption key (generate|import|show|backup|recover)
//   brain serve       start the localhost Agentic Brain UI
//   brain distill     draft learnings from resolved-struggle episodes (--dry, --since <hours>)
//   brain eval        score retrieval against evals/questions.jsonl (--no-wiki, --bm25, --verify)
//   brain workflows   mine recurring rituals (verify/test → commit/deploy) → wiki/workflows/
//   brain mcp-server  run the agentic-brain MCP server on stdio (foreground; stdout is JSON-RPC only)
//   brain recall      search memory from the terminal (brain_recall's CLI twin)
//   brain remember    capture one observation from the terminal (brain_remember's CLI twin)
//   brain lifecycle   mark memories superseded / contested / stale (dry-run default)
//   brain status-mark manual lifecycle override for one memory
//   brain migrate-hash rewrite old rows' 32-bit content_hash to the strong hash (dry-run default)
//   brain switch-from-claude-mem  import claude-mem, wire the brain, mute claude-mem's startup dump (plan by default)
//   brain audit       read-only: what leaves this machine (ciphertext, plaintext files, key location, visibility)
import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { runExport } from './lib/export.mjs';
import { runImport } from './lib/import.mjs';
import { pushSkills, pushAgents, pushSettings, restoreSkills, restoreAgents, skillCounts } from './lib/assets.mjs';
import { pushContext, restoreContext } from './lib/context.mjs';
import { packMemory, unpackMemory, mergeRemoteMemory } from './lib/bundle.mjs';
import { ingest } from './lib/ingest.mjs';
import { auditScrub, applyScrub, revertScrub } from './lib/scrub.mjs';
import { recapture, formatRecaptureReport, cleanCursorProjects, formatCursorProjectsReport } from './lib/recapture.mjs';
import { cleanSelfCapture, formatSelfCaptureReport, cleanTestData, formatTestDataReport, cleanDupes, formatDupesReport } from './lib/clean.mjs';
import { detectAll } from './lib/detect.mjs';
import { dream, lint, lintFindings } from './lib/dream.mjs';
import { runLifecycle, formatLifecycleReport, openForLifecycle, markStatus } from './lib/lifecycle.mjs';
import { writeWorkflows } from './lib/workflows.mjs';
import { doDistill } from './lib/distill.mjs';
import { runEval, writeReport, verifyQuestions, loadQuestions } from './lib/eval.mjs';
import { injectContext, injectFolder, refreshLaunchContext } from './lib/inject.mjs';
import { wireMcp } from './lib/wire.mjs';
import { wireSessionHook } from './lib/wire-hook.mjs';
import { TARGETS as WIRE_TARGETS } from './lib/wire-targets.mjs';
import { installBridgeHome } from './lib/bridgehome.mjs';
import { enableClaudeMemEverywhere, claudeMemOptIn } from './lib/profiles.mjs';
import { watchAgy, installWatchAgy, uninstallWatchAgy, watchCodex, installWatchCodex, uninstallWatchCodex } from './lib/watch.mjs';
import { installServe, uninstallServe } from './lib/serve.mjs';
import { installIngest, uninstallIngest } from './lib/capture.mjs';
import { ensureRepo, ensureRemote, pull, push, commitAll, remoteUrl, hasRemote, uploadBlob, git as gitCmd } from './lib/git.mjs';
import { secretStatus, SECRET_KEYS, getSecret } from './lib/keychain.mjs';
import { generateAndStoreKey, importIdentity, hasKey } from './lib/crypto.mjs';
import { REPO_MANIFEST, config, MEMORY_DB, CLAUDE_MEM_DB } from './lib/paths.mjs';
import { runInit, InitError } from './lib/init.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { runAudit, formatAudit } from './lib/audit.mjs';
import { RECOVERY_FILE, hasRecoveryFile, writeRecoveryFile, readRecoveryFile, passphraseProblem, promptHidden, readPassphraseStdin, RecoveryError } from './lib/recovery.mjs';
import { recallSearch } from './lib/recall.mjs';
import { rememberObservation } from './lib/remember.mjs';

const log = (m) => console.log(m);

// Read one line from the controlling terminal (not stdin, which under `curl |
// bash`-style invocation or scripted use may be the script/pipe itself). Used
// only for the rare "type this exact phrase to confirm" destructive prompts.
// Like promptTTY, but nothing typed or pasted is echoed — for secrets. Reads
// stdin directly (raw mode), so the value never lands in shell history, on
// screen, or in a scrollback buffer.
async function promptSecret(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return '';
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return await new Promise((resolve) => {
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function promptTTY(question) {
  const fs = await import('node:fs');
  let fd = null;
  try { fd = fs.openSync('/dev/tty', 'r+'); } catch { fd = null; }
  if (fd !== null) {
    // A plain blocking read of one line, then close: no stream left behind to
    // swallow the next prompt's input (rotate asks twice in one process).
    try {
      fs.writeSync(fd, question);
      const chunk = Buffer.alloc(1);
      let line = '';
      for (;;) {
        let n;
        try { n = fs.readSync(fd, chunk, 0, 1, null); } catch (e) { if (e.code === 'EAGAIN') continue; if (e.code === 'EOF') break; throw e; }
        if (n === 0) break;
        const ch = chunk.toString('utf8');
        if (ch === '\n') break;
        if (ch !== '\r') line += ch;
      }
      return line;
    } finally { try { fs.closeSync(fd); } catch {} }
  }
  if (!process.stdin.isTTY) return ''; // no interactive terminal available — treat as "not confirmed"
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer;
}

function writeManifest(extra = {}) {
  const now = new Date().toISOString();
  const manifest = {
    schema: 1,
    lastSync: now,
    machine: process.env.USER || 'unknown',
    hostname: hostname(),
    encryption: config.encryption.enabled,
    ...extra,
  };
  writeFileSync(REPO_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// ── recovery passphrase (lib/recovery.mjs) ─────────────────────────────────
// A second copy of the age key, encrypted with a passphrase, committed to the
// brain repo so a new Mac needs only the repo + the passphrase. The key itself
// is never printed.
const RECOVERY_REL = 'memory/key-recovery.age';

// New passphrase, asked twice with echo off. null = no terminal / gave up.
async function askNewPassphrase({ stdin = false } = {}) {
  if (stdin) {
    const p = readPassphraseStdin();
    const weak = passphraseProblem(p);
    if (weak) throw new RecoveryError(weak, 'WEAK_PASSPHRASE');
    return p;
  }
  for (let i = 0; i < 3; i++) {
    const p = await promptHidden('Choose a recovery passphrase (not shown): ');
    if (p === null) return null;
    const weak = passphraseProblem(p);
    if (weak) { console.log('  ' + weak); continue; }
    if ((await promptHidden('Type it again: ')) !== p) { console.log('  The two entries did not match.'); continue; }
    return p;
  }
  return null;
}

// Commit only the recovery file (never sweeps other changes), then try to
// upload it. A failed push is fine: the next `brain sync` carries the commit.
function publishRecoveryChange(message) {
  try {
    gitCmd(['add', '-f', '--', RECOVERY_REL]); // -f: an engine-cloned repo ignores *.age
    gitCmd(['commit', '-q', '-m', message, '--', RECOVERY_REL]);
  } catch {
    log(`  (not committed yet — ${RECOVERY_REL} goes up with your next brain sync)`);
    return;
  }
  if (!hasRemote()) return;
  try {
    pull({ log });
    push({ log });
  } catch {
    log('  (offline? it is committed and goes up with your next brain sync)');
  }
}

async function doKeyBackup({ stdin = false } = {}) {
  const identity = getSecret(SECRET_KEYS.AGE_KEY);
  if (!identity) throw new Error('No key on this Mac to back up. Set one up first: brain init (new brain) or brain key import.');
  if (hasRecoveryFile()) log(`A recovery file already exists (${RECOVERY_REL}) — it will be replaced.`);
  const passphrase = await askNewPassphrase({ stdin });
  if (!passphrase) throw new Error('No passphrase set — nothing was changed. Re-run in a terminal: brain key backup');
  writeRecoveryFile(identity, passphrase, { recipient: getSecret(SECRET_KEYS.AGE_RECIPIENT) || '' });
  // Prove it opens before telling the user they are covered.
  if (readRecoveryFile(passphrase) !== identity) throw new Error('The recovery file did not verify — re-run: brain key backup');
  publishRecoveryChange('brain: key recovery file (passphrase-encrypted)');
  log(`✅ Key backed up to ${RECOVERY_REL}, encrypted with your passphrase.`);
  log('   On a new Mac: clone your brain, then  brain key recover  (or just brain restore).');
  log('   Remember the passphrase — it cannot be reset, and without it this file is useless.');
}

// Show the raw private key — the one deliberate exception to "the key is never
// printed". Everything goes to /dev/tty, never stdout/stderr, so `brain key
// reveal > file`, a pipe, a CI log or an agent's captured output can't pick it
// up. No controlling terminal → refuse. Needs the word "reveal" typed first.
async function doKeyReveal() {
  const fs = await import('node:fs');
  const identity = getSecret(SECRET_KEYS.AGE_KEY);
  if (!identity) { console.error('✖ No key on this Mac to reveal.'); process.exitCode = 1; return; }
  let fd;
  try { fd = fs.openSync('/dev/tty', 'r+'); }
  catch {
    console.error('✖ No terminal available — the private key is only ever shown on a real terminal, never to a pipe or file.\n' +
      '  Safer for another Mac: brain key backup, then brain key recover there.');
    process.exitCode = 1;
    return;
  }
  const tty = (s) => fs.writeSync(fd, s);
  try {
    tty('\nWARNING: this shows your PRIVATE encryption key. Anyone who sees it can read your whole brain backup.\n' +
      'Do not paste it into chats, tickets or screenshots. Store it only in a password manager.\n' +
      '(Safer for another Mac: brain key backup, then brain key recover there.)\n\n');
  } finally { try { fs.closeSync(fd); } catch {} }
  const answer = await promptTTY('Type "reveal" to show it: ');
  if (answer.trim() !== 'reveal') { console.log('Aborted. Nothing was shown.'); process.exitCode = 1; return; }
  const fd2 = fs.openSync('/dev/tty', 'r+');
  try { fs.writeSync(fd2, '\n' + identity + '\n\n'); } finally { try { fs.closeSync(fd2); } catch {} }
}

// Import the key from the recovery file. Returns the recipient. Throws (and
// changes nothing) on a wrong passphrase, a missing file, or a different key
// already on this Mac.
async function doKeyRecover({ stdin = false, file = RECOVERY_FILE } = {}) {
  if (!existsSync(file) && file === RECOVERY_FILE && hasRemote()) pull({ log });
  if (!existsSync(file)) {
    throw new RecoveryError(
      `This brain has no recovery file (${RECOVERY_REL}). Import the key itself instead: brain key import`,
      'NO_FILE'
    );
  }
  let identity = null;
  const tries = stdin ? 1 : 3;
  for (let i = 0; i < tries && !identity; i++) {
    const p = stdin ? readPassphraseStdin() : await promptHidden('Recovery passphrase (not shown): ');
    if (p === null) throw new Error('No terminal to ask for the passphrase. Re-run in a terminal (or pipe it: brain key recover --passphrase-stdin).');
    try {
      identity = readRecoveryFile(p, { path: file });
    } catch (e) {
      if (e.code !== 'WRONG_PASSPHRASE' || i === tries - 1) throw new Error(`${e.message} Nothing was changed.`);
      console.log('  Wrong passphrase — try again.');
    }
  }
  if (hasKey()) {
    if (getSecret(SECRET_KEYS.AGE_KEY) === identity) {
      log('✅ This Mac already has that key — nothing to do.');
      return getSecret(SECRET_KEYS.AGE_RECIPIENT);
    }
    throw new Error(
      'This Mac already has a DIFFERENT key; recovering would replace it and could strand backups made with it.\n' +
        '  Nothing was changed. If that key is wrong or unwanted, remove it in Keychain Access (service "claude-brain") and re-run.'
    );
  }
  const recipient = importIdentity(identity);
  log('✅ Key recovered from your passphrase and saved to the Keychain.');
  return recipient;
}

export async function doSync() {
  log('🔄 Claude Brain — sync (push)');
  ensureRepo({ log });
  if (hasRemote()) pull({ log });

  log('📦 skills / agents / settings');
  const skills = pushSkills({ log });
  pushAgents({ log });
  pushSettings({ log });

  // Skills that live outside the shared library — plugin skills and each
  // project's own .claude/skills — backed up into skills-external/. Kept out of
  // the library on purpose so they never shadow the originals (see the module).
  try {
    const { pushExternalSkills } = await import('./lib/external-skills.mjs');
    pushExternalSkills({ log });
  } catch (e) { log('  external skills skipped: ' + e.message); }

  // Relink the library into every tool that reads skills off disk, so a skill
  // saved in one CLI is callable from all of them. Additive: never touches a
  // tool's own skills, and new library entries pick up links automatically.
  try {
    const { syncSkills } = await import('./lib/skills-sync.mjs');
    const r = syncSkills({ apply: true });
    if (r.ok && r.linked) log(`  🎓 linked ${r.linked} skill(s) into other tools`);
  } catch (e) { log('  skill link skipped: ' + e.message); }

  log('🔌 ingest linked tools (codex / antigravity / …)');
  try { await ingest({ log }); } catch (e) { log('  ingest skipped: ' + e.message); }

  // Once the native store is live, claude-mem keeps distilling into ITS database.
  // Those Haiku-generated observations are the highest-quality rows in the brain,
  // so pull the new ones across every sync. Incremental (resumes from
  // import_state.last_epoch), idempotent, and the source stays read-only. Skipped
  // entirely while MEMORY_DB still IS claude-mem's DB — there is nothing to move.
  if (existsSync(CLAUDE_MEM_DB) && MEMORY_DB !== CLAUDE_MEM_DB) {
    log('📥 pull new claude-mem distillations into the native store');
    try {
      const { importClaudeMem } = await import('./lib/import-claude-mem.mjs');
      // resume:false — the rowid cursor was measured skipping ~2,200 rows, so the
      // native store silently went stale. A full scan is ~5s for 46k rows and
      // INSERT OR IGNORE makes it idempotent; correctness beats the shortcut.
      // verify:false — claude-mem writes continuously, so a routine pull races it
      // and would fail on "destination is behind by 4 seconds", which clears the
      // READY marker and demotes a perfectly healthy store. The initial import is
      // fully verified; `brain import-claude-mem` still verifies on demand.
      const r = await importClaudeMem({ source: CLAUDE_MEM_DB, apply: true, resume: false, verify: false, log: () => {} });
      const added = (r.tables || []).reduce((n, t) => n + (t.inserted || 0), 0);
      log(r.ok ? `  +${added} row(s) from claude-mem` : `  ⚠️  import reported a problem — run: brain import-claude-mem`);
    } catch (e) { log('  claude-mem pull skipped: ' + e.message); }
  }

  // Fold in other devices' memories BEFORE export/pack, so the blob we upload
  // is the union — never just this machine's view. Aborts the sync on failure.
  log('🔀 merge cloud brain (other devices)');
  mergeRemoteMemory({ log });

  log('🧠 memory export');
  const mem = existsSync(MEMORY_DB) ? runExport({ log }) : { totals: {} };

  log('🗂  folder context');
  pushContext({ log });

  log('🌙 dream — distill memory into wiki');
  try { if (existsSync(MEMORY_DB)) dream({ log }); } catch (e) { log('  dream skipped: ' + e.message); }

  // Opt-in only (profiles.mjs): a daily sync must not switch a third-party
  // plugin on in profiles the user never enabled it in.
  if (claudeMemOptIn()) {
    log('🧩 enable claude-mem across all Claude profiles (default / work / personal)');
    try { enableClaudeMemEverywhere({ write: true, log }); } catch (e) { log('  enable skipped: ' + e.message); }
  }

  log('💉 inject cross-project context into every CLI + Claude profile');
  try { injectContext({ write: true, log }); } catch (e) { log('  inject skipped: ' + e.message); }

  log('🔐 pack + encrypt memory');
  const packed = packMemory({ log });

  const manifest = writeManifest({ skills, memory: mem.totals, blobStorage: 'release:brain-latest' });

  log('⬆️  commit + push');
  ensureRemote({ log });
  // Upload the blob to the brain-latest Release AFTER ensureRemote: on a fresh machine origin
  // doesn't exist until ensureRemote runs, and uploadBlob silently no-ops without a remote —
  // which would make the very first sync report success while never uploading the 33MB blob.
  if (packed.blob) uploadBlob(packed.blob, { log });
  commitAll(`brain sync ${manifest.lastSync}`);
  push({ log });
  log('✅ sync complete');
  return manifest;
}

// `interactive` = run from the CLI. The UI server calls this too, and must
// never grab the terminal it happens to have been started from.
export async function doRestore({ interactive = false } = {}) {
  log('⬇️  Claude Brain — restore (pull)');
  if (hasRemote()) pull({ log });
  // New Mac with no key: if this brain carries a recovery file, the passphrase
  // is enough (asked hidden; needs a terminal).
  if (!hasKey() && hasRecoveryFile()) {
    if (!interactive) throw new Error('No encryption key on this machine. This brain has a recovery passphrase — in a terminal run: brain key recover');
    log('🔐 No key on this Mac yet — this brain has a recovery passphrase.');
    await doKeyRecover();
  }
  if (!hasKey()) throw new Error('No encryption key on this machine. Add it in the OS UI (brain serve) first, or: brain key import');
  log('🔓 decrypt memory');
  unpackMemory({ refresh: true, log });
  log('📦 restore skills / agents / context');
  restoreSkills({ log });
  restoreAgents({ log });
  restoreContext({ log });
  log('✅ restore complete. If chroma search is stale, run: npx claude-mem restart');
}

export async function doMerge() {
  log('🔀 Claude Brain — merge exports → local DB');
  if (hasRemote()) pull({ log });
  if (config.encryption.enabled) unpackMemory({ restoreDb: false, log });
  const added = runImport({ log });
  return added;
}

async function doEval({ noWiki, bm25Only } = {}) {
  const result = await runEval({ noWiki, bm25Only, log });
  const r = writeReport(result, new Date().toISOString(), { log });
  log(`🧪 brain eval: full ${r.fullPct}% (${r.fullHits}/${r.total}) · baseline ${r.basePct}% (${r.baseHits}/${r.total}) · ${r.retrieval}${noWiki ? ' · wiki disabled' : ''} → ${r.report}`);
  return r;
}

// brain scrub — audit (default, read-only) / apply (mutating, backup-first) /
// revert. See docs/specs/secret-scrubber.md §5.4. NEVER prints a secret value:
// only detector ids, tiers, row/column identity, project, and timestamps.
function doScrubAudit({ json = false, tiersOpt, sinceHours } = {}) {
  const tiers = tiersOpt || [1, 2, 3, 4, 5];
  const sinceEpoch = sinceHours ? Date.now() - sinceHours * 3600 * 1000 : 0;
  const r = auditScrub({ tiers, sinceEpoch });
  const totalRows = Object.values(r.rowsScanned).reduce((a, n) => a + n, 0);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    const totals = Object.entries(r.rowsScanned).map(([t, n]) => `${n} ${t}`).join(' · ');
    console.log(`brain scrub --audit  ·  ${totals || totalRows + ' rows'}`);
    console.log('');
    for (const tier of [1, 2, 3, 4, 5]) {
      const rows = r.detectors.filter((d) => d.tier === tier);
      if (!rows.length) continue;
      const label = tier === 5 ? 'TIER 5 (review only, not redacted)' : tier <= 2 ? 'TIER ' + tier + ' (certain)' : 'TIER ' + tier;
      console.log(`  ${label}`);
      for (const d of rows) {
        console.log(`    ${d.detector.padEnd(32)} hits=${d.hits}  rows=${d.rows}  projects=${d.projects}  first_seen=${d.firstSeen || '—'}`);
      }
    }
    console.log('');
    console.log(`  ${r.certain} certain · ${r.review} for review · ${r.ageSecretKeyFired ? '⚠️  age-secret-key FIRED' : '0 age-secret-key'}`);
    if (r.certain > 0) {
      console.log('  A detected secret is not un-leaked by scrubbing the local DB — rotate it anyway.');
      console.log('  Run `brain scrub --apply` to redact certain (Tier 1-4) hits (dry-run gate: backup-first, reversible).');
    }
  }
  if (r.ageSecretKeyFired) {
    log('✖ age-secret-key detector fired — this tool\'s own master key may be exposed in an observation. Investigate before doing anything else.');
    process.exitCode = 1;
  }
  return r;
}

function doScrubApply({ yes = false, force = false, tiersOpt, sinceHours } = {}) {
  if (!yes) {
    console.log('brain scrub --apply requires --yes to run non-interactively (or run without --apply for a dry-run audit).');
    process.exitCode = 1;
    return null;
  }
  const tiers = tiersOpt || [1, 2, 3, 4];
  const sinceEpoch = sinceHours ? Date.now() - sinceHours * 3600 * 1000 : 0;
  const r = applyScrub({ tiers, sinceEpoch, force });
  log(`🔏 brain scrub --apply: ${r.rowsUpdated} row(s) updated across ${Object.keys(r.changesByDetector).length} detector(s)`);
  for (const [d, n] of Object.entries(r.changesByDetector)) log(`   ${d}: ${n}`);
  log(`   backup:  ${r.backupPath}`);
  log(`   ledger:  ${r.ledgerPath}`);
  log(`   observations_fts integrity: ${r.ftsOk ? 'ok' : 'FAILED'}`);
  if (!r.ftsOk) process.exitCode = 1;
  return r;
}

function doStatus() {
  const s = secretStatus();
  const sk = skillCounts();
  let manifest = null;
  if (existsSync(REPO_MANIFEST)) {
    try {
      manifest = JSON.parse(readFileSync(REPO_MANIFEST, 'utf8'));
    } catch {}
  }
  console.log(JSON.stringify({ secrets: s, keyRecovery: hasRecoveryFile(), skills: sk, remote: remoteUrl(), manifest }, null, 2));
}

const TOP_USAGE = `usage: brain <command> [options]

Commands:
  init [--repo <name>] [--owner <o>] [--yes] [--no-automation]
                        fresh-machine setup: key → private repo → config → first sync → wiring
  sync                  push this machine's brain to the cloud repo
  restore               pull the cloud brain onto this machine
  merge                 merge the repo's exported memory into the local DB
  export                write memory exports locally (no git)
  status                show brain status
  doctor [--json]       read-only diagnostic: is every tool actually wired and working
  audit [--json] [--offline] [--deep] [--no-scrub]
                        read-only: what leaves this machine — the encrypted upload (verified as age
                        ciphertext), the plaintext files in git, secret-scrubber counts, where the key
                        lives, recovery backup, repo visibility (never prints a secret value;
                        --offline skips GitHub, --deep downloads and verifies the cloud blob)
  import-claude-mem [--apply]   copy an existing claude-mem memory into the native store
                        (dry-run default; source opened read-only, never modified)
  switch-from-claude-mem [--apply] [--no-silence] [--undo] [--source <db>] [--json]
                        one-command move from claude-mem: plan (default) → import + verify →
                        wire the brain into every tool → keep claude-mem capturing but mute
                        its startup context dump (backed up; --undo puts it back)
  key <sub>             manage the age encryption key (generate|import|show|rotate|reveal)
  key backup            store the key in the brain repo, encrypted with a recovery passphrase
  key recover           new Mac: unlock the key from that file with the passphrase (hidden prompt)
  key reveal            print the PRIVATE key to the terminal only (typed confirmation; refuses without a tty)
  serve                 start the localhost Agentic Brain UI
  distill               draft learnings from resolved-struggle episodes (--dry, --since <hours>)
  skills [status|--apply]  make one skill library callable from every tool (--relink, --json)
  distill-sessions      turn captured sessions into observations with our own LLM distiller
                        [--limit <n>] [--concurrency <n>] [--provider <claude|codex|agy>]
                        [--model <m>] [--critique] [--dry-run] [--json]
  eval                  score retrieval against evals/questions.jsonl (--no-wiki, --bm25;
                        --verify: read-only check that every question is answerable)
  workflows             mine recurring rituals → wiki/workflows/
  inject [--write]      inject cross-project context into every CLI's global context file
  inject-folder [path]  write a folder-scoped AGENTS.md into a repo
  launch <tool> [args]  refresh context then exec claude|codex|agy
  scrub [--apply|...]   audit (default) / apply / revert the secret scrubber
  clean --self-capture [--apply] [--json] [--db <path>]
                        remove the brain's own headless runs captured as user work
                        (dry-run default; --apply makes a verified backup first)
  clean --test-data [--apply] [--json] [--db <path>]
                        remove test-fixture projects (e2e-probe-*, proj-run-context-*,
                        OpenDesign od-* fixtures, bare-UUID run dirs); same safety contract;
                        removed names stay skipped by capture and sync
  clean --dupes [--apply] [--undo] [--json] [--db <path>]
                        hide effectively-identical copies of a memory (same project, same
                        title/subtitle/facts/narrative up to case, spacing and trailing
                        punctuation); nothing is deleted, one copy stays; dry-run default,
                        --apply makes a verified backup first, --undo brings them back
  clean --cursor-projects [--apply] [--undo [--run <id>]] [--json] [--db <path>]
                        file existing Cursor sessions captured under the placeholder project
                        'cursor' under the project their folder maps to (ingest only does this
                        for NEW sessions); dry-run default, --apply makes a verified backup
                        and journals the old project, --undo puts it back
  recapture [--tool <t,..>] [--apply] [--undo [--run <id>]] [--json] [--db <path>]
                        finish what ingest leaves open for sessions that grew after capture:
                        queue them for a fresh distillation (ingest already keeps the raw text
                        current and never overwrites a distillation or edit), bring back hidden
                        copies that grew into their own memory, re-check their copies;
                        dry-run default, --apply makes a verified backup and journals every old
                        value (incl. the earlier distillation, and the --dupes copies it
                        un-hides / re-checks), --undo restores them where the row still holds
                        what the run wrote
  lifecycle [--apply] [--clear] [--json] [--db <path>]
                        mark memories superseded / contested / stale (dry-run default;
                        first --apply migrates the store after a verified backup)
  migrate-hash [--apply] [--json] [--db <path>]
                        rewrite old rows' 32-bit FNV content_hash to the strong SHA-256/128
                        hash (dry-run default; --apply makes a verified backup first; optional —
                        sync/merge already match both versions). Update EVERY synced Mac to this
                        build first: an older build would duplicate each rewritten row on sync
  embed [--apply] [--limit <n>] [--clear] [--json] [--db <path>]
                        local semantic search: status (default, read-only) / backfill
                        embeddings for recall (--apply; resumable, on-device, the
                        one-time model download is the only network use)
  embed --install [--every <sec>] | --uninstall
                        the background backfill job (low priority, bounded per run);
                        install.sh / onboard turn it on. BRAIN_EMBED=0 opts out everywhere
  status-mark <id> <active|superseded|contested|stale|auto> [--by <id>] [--note <text>] [--db <path>]
                        manual lifecycle override (sticks; 'auto' hands the row back)
  onboard [--dry-run] [--with-claude-mem]
                        wire this machine end-to-end (idempotent); --dry-run previews, writes nothing;
                        --with-claude-mem also enables the claude-mem plugin in every Claude profile
  ingest [--install]    capture Codex/Cursor sessions
  watch-agy / watch-codex [--install|--uninstall]
  mcp-server            run the agentic-brain MCP server on stdio (foreground; for tool configs / debugging)
  first-run [--json]    what was found on this machine and how far memory-building is
  past-sessions on|off|status
                        include the AI history already on this computer (on, recommended) or start fresh (off)
  recall <query>        search memory from the terminal [--project <p>] [--limit <n>] [--deep] [--json] [--db <path>]
  remember              capture one observation [--title --project --type --fact (repeatable) --narrative] or --json <payload> [--db <path>]

Pass --help (or -h) after any command for a reminder of its own flags — this
never runs the command itself, only prints usage and exits 0.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  // --help / -h short-circuits BEFORE any subcommand logic runs — this must
  // never do real work (two agents have already tripped on `distill --help`
  // silently running the real distiller for ~2 minutes because this guard
  // didn't exist).
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(TOP_USAGE);
    return;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`brain ${cmd}: see the command list below for its flags.\n`);
    console.log(TOP_USAGE);
    return;
  }

  switch (cmd) {
    case 'sync':
      await doSync();
      break;
    case 'restore':
      await doRestore({ interactive: true });
      break;
    case 'merge':
      await doMerge();
      break;
    case 'export':
      console.log(JSON.stringify(runExport({ log }).totals, null, 2));
      break;
    case 'dream':
      console.log(JSON.stringify(dream({ log }), null, 2));
      break;
    case 'lint':
      console.log(JSON.stringify(lint({ log }), null, 2));
      break;
    case 'distill': {
      // Nightly: detect resolved-struggle episodes, draft learnings into learnings/_drafts/
      // for one-click approval in the UI. Never auto-approved. TODO: wire into launchd
      // alongside the daily sync (kept out of doSync itself to keep sync fast/cheap).
      const dry = rest.includes('--dry');
      const sIdx = rest.indexOf('--since');
      const sinceHours = sIdx !== -1 ? Number(rest[sIdx + 1]) || 24 : 24;
      const mIdx = rest.indexOf('--max');
      const maxCandidates = mIdx !== -1 ? Number(rest[mIdx + 1]) || 8 : 8;
      const r = doDistill({ sinceHours, dry, maxCandidates, log });
      console.log(`🕵️  distill: ${r.candidates.length} candidate(s)${dry ? ' (dry run — Stage 2 skipped)' : `, ${r.drafted} drafted, ${r.skipped} skipped`}`);
      for (const c of r.candidates) console.log(c.kind === 'decision'
        ? `  · ${c.project} — decision → "${c.resolution.title}"`
        : `  · ${c.project} / ${c.file} — ${c.attempts} fix attempts → "${c.resolution.title}"`);
      break;
    }
    case 'skills': {
      // Make one skill library reachable from every tool that reads skills off
      // disk. Link, don't copy — see lib/skills-sync.mjs for why.
      const { syncSkills, skillsStatus } = await import('./lib/skills-sync.mjs');
      const asJson = rest.includes('--json');
      if (rest[0] === 'status' || rest.includes('--status')) {
        const s = skillsStatus();
        if (asJson) { console.log(JSON.stringify(s, null, 2)); break; }
        if (!s.libDir) { console.log('⚠️  no skill library found (looked for ~/.claude-shared/skills, ~/.claude/skills)'); break; }
        console.log(`🎓 skill library: ${s.libDir} — ${s.total} skills`);
        for (const t of s.targets) {
          const mark = t.isLibrary ? '◆' : t.missing === 0 ? '✅' : t.present === 0 ? '❌' : '⚠️ ';
          const detail = t.isLibrary ? 'the library itself'
            : !t.exists ? 'directory does not exist yet'
            : `${t.present}/${s.total} available${t.missing ? ` · ${t.missing} missing` : ''}`;
          console.log(`  ${mark} ${t.name.padEnd(22)} ${detail}`);
        }
        // The library is only one of three populations. Plugin and project
        // skills are never linked into it (that would shadow the marketplace
        // copy, or fire a project's skill in unrelated repos) but they ARE
        // backed up on every sync, so report them rather than leaving the
        // count looking like the whole story.
        try {
          const { discoverPluginSkills, discoverProjectSkills, externalSkillCounts } =
            await import('./lib/external-skills.mjs');
          const plugins = discoverPluginSkills();
          const projects = discoverProjectSkills();
          const backed = externalSkillCounts();
          console.log('\n🔎 found elsewhere on this machine (backed up, not linked):');
          const byPlugin = {};
          for (const p of plugins) byPlugin[`${p.plugin} ${p.version}`] = (byPlugin[`${p.plugin} ${p.version}`] || 0) + 1;
          const byProject = {};
          for (const p of projects) byProject[p.project] = (byProject[p.project] || 0) + 1;
          const line = (mark, label, n, extra) =>
            console.log(`  ${mark} ${label.padEnd(22)} ${n} skill(s)${extra ? ` · ${extra}` : ''}`);
          line(backed.plugins === plugins.length ? '✅' : '⚠️ ', 'plugin skills', plugins.length,
            `${backed.plugins} in the brain` + (backed.plugins === plugins.length ? '' : ' → run: brain sync'));
          for (const [k, n] of Object.entries(byPlugin).sort()) console.log(`       ${k.padEnd(19)} ${n}`);
          line(backed.projects === projects.length ? '✅' : '⚠️ ', 'project skills', projects.length,
            `${backed.projects} in the brain` + (backed.projects === projects.length ? '' : ' → run: brain sync'));
          for (const [k, n] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) console.log(`       ${k.padEnd(19)} ${n}`);
          console.log(`\n  total discoverable: ${s.total + plugins.length + projects.length} skills`);
        } catch (e) { console.log('  (external scan skipped: ' + e.message + ')'); }
        break;
      }
      // `--all` is the full skill pass: mirror the library into the repo,
      // rediscover plugin + project skills, then relink. Lives here rather than
      // in the UI server because it is all synchronous fs work — running it in
      // the server process blocks the event loop and freezes the UI, so the UI
      // spawns this command and streams its stdout instead.
      if (rest.includes('--all')) {
        const say = (m) => console.log(m);
        say('mirroring the shared library → repo…');
        const library = pushSkills({ log: (l) => say(l.trim()) });
        say('scanning plugin cache and project folders…');
        const { pushExternalSkills } = await import('./lib/external-skills.mjs');
        const ext = pushExternalSkills({ log: (l) => say(l.trim()) });
        say('relinking the library into Codex / Cursor / agy…');
        let linked = 0;
        try {
          const r = syncSkills({ apply: true });
          if (r.ok) { linked = r.linked || 0; say(`linked ${linked} skill(s) into other tools`); }
          else say(`link step skipped: ${r.error}`);
        } catch (e) { say(`link step skipped: ${e.message}`); }
        if (asJson) console.log(JSON.stringify({ ok: true, library, ...ext, linked }));
        else console.log(`✅ ${library} library · ${ext.plugins} plugin · ${ext.projects} project · ${linked} linked`);
        break;
      }
      const apply = rest.includes('--apply');
      const relink = rest.includes('--relink');
      const r = syncSkills({ apply, relink, log: asJson ? () => {} : () => {} });
      if (asJson) { console.log(JSON.stringify(r, null, 2)); break; }
      if (!r.ok) { console.log(`⚠️  ${r.error}`); break; }
      console.log(`🎓 ${r.skillCount} skills in ${r.libDir}`);
      for (const t of r.targets) {
        if (t.isLibrary) { console.log(`  ◆ ${t.name.padEnd(22)} ${t.note}`); continue; }
        const bits = [];
        if (t.linked) bits.push(`${apply ? 'linked' : 'would link'} ${t.linked}`);
        if (t.already) bits.push(`${t.already} already`);
        if (t.ownCopies.length && !relink) bits.push(`${t.ownCopies.length} own copies left alone`);
        if (t.foreign) bits.push(`${t.foreign} foreign links`);
        if (t.created) bits.push(apply ? 'created dir' : 'would create dir');
        console.log(`  ${t.linked ? '→' : '·'} ${t.name.padEnd(22)} ${bits.join(' · ') || 'nothing to do'}`);
        if (t.error) console.log(`      ⚠️  ${t.error}`);
      }
      if (r.relinked) console.log(`  ${apply ? 'replaced' : 'would replace'} ${r.relinked} stale copies (originals kept as *.replaced-by-brain)`);
      if (r.skipped) console.log(`  ${r.skipped} existing copies left untouched — pass --relink to point them at the library`);
      if (!apply) console.log('\n  dry run — pass --apply to write');
      break;
    }
    case 'distill-sessions': {
      // Our own distiller: captured sessions -> observations. This is the job
      // claude-mem used to do; wiring it here is what lets the plugin be turned
      // off without the store going quiet. Provider is chosen per session from
      // the CLI that produced it (claude->haiku, agy->flash, ...) and falls
      // back down FALLBACK_CHAIN when one is missing or errors.
      if (rest.includes('--install') || rest.includes('--uninstall')) {
        const { installDistill, uninstallDistill } = await import('./lib/distill-schedule.mjs');
        const iIdx = rest.indexOf('--every');
        const interval = iIdx !== -1 ? Number(rest[iIdx + 1]) || undefined : undefined;
        if (rest.includes('--uninstall')) uninstallDistill({ log: console.log });
        else installDistill({ interval, log: console.log });
        break;
      }
      const { distillPending, planBatch } = await import('./lib/distiller.mjs');
      const num = (flag, dflt) => {
        const i = rest.indexOf(flag);
        return i !== -1 && Number.isFinite(Number(rest[i + 1])) ? Number(rest[i + 1]) : dflt;
      };
      const str = (flag) => {
        const i = rest.indexOf(flag);
        return i !== -1 ? rest[i + 1] : undefined;
      };
      const dryRun = rest.includes('--dry-run') || rest.includes('--dry');
      const asJson = rest.includes('--json');
      if (rest.includes('--plan')) {
        // Preview of the whole backlog: sessions, segments, model calls. Opens the store
        // READ-ONLY, calls no model, writes nothing.
        const p = planBatch(MEMORY_DB, { limit: num('--limit', undefined) });
        if (asJson) { console.log(JSON.stringify(p, null, 2)); break; }
        console.log('🗺️  distill-sessions plan (read-only; no model called, nothing written)');
        console.log(`  fresh sessions (segment 0 pending):       ${p.freshSessions}`);
        console.log(`  later segments of those sessions:         ${p.laterSegmentsOfFreshSessions}`);
        console.log(`  further segments of started sessions:     ${p.continuationSegments}  (${p.continuationSessions} session(s))`);
        console.log(`  grown segments to re-distil in place:     ${p.regrownSegments}`);
        console.log(`  waiting for their session to go quiet:    ${p.waitingForIdle}`);
        console.log(`  → model calls: ${p.calls}  ·  ~${p.estimatedTokens.total.toLocaleString()} tokens  ·  ${p.runsAtLimit} run(s) at --limit ${p.limit}`);
        console.log(`  sessions with a stored full transcript:   ${p.sessionsWithFullTranscript}`);
        console.log(`  long sessions awaiting their full text:   ${p.longSessionsAwaitingFullTranscript}  (their extra segments appear after the next 'brain ingest')`);
        const plat = Object.entries(p.byPlatform).map(([k, v]) => `${k} ${v}`).join(' · ');
        if (plat) console.log(`  by tool: ${plat}`);
        for (const b of p.biggest) console.log(`  · ${b.session}: ${b.segments} segment(s)`);
        break;
      }
      const r = await distillPending(MEMORY_DB, {
        limit: num('--limit', undefined),
        concurrency: num('--concurrency', undefined),
        provider: str('--provider'),
        model: str('--model'),
        selfCritique: rest.includes('--critique'), // distillSession reads opts.selfCritique
        dryRun,
        log: asJson ? () => {} : log,
      });
      if (asJson) { console.log(JSON.stringify(r, null, 2)); break; }
      if (r.error) { console.log(`⚠️  distill-sessions: ${r.error}`); break; }
      const tok = r.estimatedTokens || {};
      if (dryRun) {
        console.log(`🔍 distill-sessions (dry run): ${r.scanned} segment(s) pending · ~${(tok.total || 0).toLocaleString()} tokens to process`);
        break;
      }
      console.log(`🧪 distill-sessions: ${r.scanned} segment(s) scanned · ${r.distilled} distilled · ${r.rejected} rejected · ${r.failed} failed · ${Math.round((r.ms || 0) / 1000)}s`);
      for (const [p, s] of Object.entries(r.byProvider || {})) {
        console.log(`  · ${p}: ${s.distilled} distilled, ${s.rejected} rejected, ${s.failed} failed`);
      }
      if (r.unavailable) console.log(`  ⚠️  ${r.unavailable} session(s) had no available provider`);
      if (r.stale) console.log(`  ↻ ${r.stale} session(s) changed while distilling — left pending for the next run`);
      for (const rej of (r.rejects || []).slice(0, 5)) console.log(`  ✗ ${rej.reason || 'rejected'}`);
      break;
    }
    case 'eval': {
      if (rest.includes('--verify')) {
        // Read-only: is every question answerable from the store at all?
        const questions = loadQuestions();
        const bad = questions.length ? verifyQuestions({ questions }) : [];
        for (const b of bad) log(`  ✗ ${b.id}: ${b.reason}${b.perTerm ? ' ' + JSON.stringify(b.perTerm) : ''}`);
        log(`🧪 brain eval --verify: ${!questions.length ? 'no questions in evals/questions.jsonl'
          : bad.length ? `${bad.length} of ${questions.length} question(s) unanswerable` : `all ${questions.length} questions are answerable from the store`}`);
        if (bad.length || !questions.length) process.exitCode = 1;
        break;
      }
      const noWiki = rest.includes('--no-wiki');
      await doEval({ noWiki, bm25Only: rest.includes('--bm25') });
      break;
    }
    case 'workflows': {
      const r = writeWorkflows({ log });
      if (r.written) for (const n of r.names) log(`  · ${n}`);
      break;
    }
    case 'inject': {
      const write = rest.includes('--write') || rest.includes('-w');
      const r = injectContext({ write, log });
      if (!write) {
        console.log('\n--- DIGEST (dry-run, use --write to apply) ---\n');
        console.log(r.digest || r.error);
        console.log('\n--- TARGETS ---');
        for (const t of r.results) console.log(`  ${t.label}: ${t.action} → ${t.file}`);
      }
      break;
    }
    case 'launch': {
      const tool = rest[0];
      const passthrough = rest.slice(1);
      if (!['claude', 'codex', 'agy'].includes(tool)) { console.log('usage: brain launch <claude|codex|agy> [args…]'); break; }
      try {
        const { file } = refreshLaunchContext(tool, process.cwd());
        log(`🧠 refreshed ${tool} context (map + this folder's memory) → ${file}`);
      } catch (e) { log('  context refresh skipped: ' + e.message); }
      const { spawnSync } = await import('node:child_process');
      const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
      const r = spawnSync(tool, passthrough, { stdio: 'inherit', env });
      process.exit(r.status == null ? 0 : r.status);
    }
    case 'watch-agy': {
      if (rest.includes('--install')) { installWatchAgy({ log }); break; }
      if (rest.includes('--uninstall')) { uninstallWatchAgy({ log }); break; }
      await watchAgy({ log }); // foreground, runs until killed
      break;
    }
    case 'watch-codex': {
      if (rest.includes('--install')) { installWatchCodex({ log }); break; }
      if (rest.includes('--uninstall')) { uninstallWatchCodex({ log }); break; }
      await watchCodex({ log }); // foreground, runs until killed
      break;
    }
    case 'sync-claude': {
      const write = rest.includes('--write') || rest.includes('-w');
      const en = enableClaudeMemEverywhere({ write, log });
      const inj = injectContext({ write, log });
      console.log(write ? '🧩 Synced claude-mem + brain across all Claude profiles:' : '👁 sync-claude dry-run (use --write):');
      for (const r of en.results) console.log(`  plugin · ${r.profile}: ${r.action}${r.file ? '  → ' + r.file : ''}`);
      for (const t of (inj.results || [])) console.log(`  digest · ${t.label}: ${t.action}${t.file ? '  → ' + t.file : ''}`);
      break;
    }
    case 'wire-mcp': {
      const write = rest.includes('--write') || rest.includes('-w');
      const r = wireMcp({ write });
      if (!r.ok) { console.log('  ' + r.error); break; }
      console.log(write ? '💉 Wired the agentic-brain MCP server into your tools:' : '👁 wire-mcp dry-run (use --write to apply):');
      for (const t of r.results) console.log(`  ${t.installed ? '✅' : '⚪️'} ${t.tool}: ${t.action}${t.file ? `  → ${t.file}` : ''}`);
      console.log(`\n  bridge: ${r.bridge}`);
      if (!write) console.log('  (After --write: start a new Claude Code session / restart agy, codex, Cursor, Claude Desktop; they can then live-search your whole memory DB via brain_recall / brain_context.)');
      break;
    }
    case 'inject-folder': {
      const write = rest.includes('--write') || rest.includes('-w');
      const pIdx = rest.indexOf('--project');
      const project = pIdx !== -1 ? rest[pIdx + 1] : undefined;
      const path = rest.find((a) => !a.startsWith('-') && a !== project);
      const r = injectFolder({ folder: path || process.cwd(), project, write });
      if (!r.ok) { console.log('  ' + r.error); break; }
      if (!write) {
        console.log(`\n--- ${r.project}: ${r.action} → ${r.file} (${r.count} observations) ---\n`);
        console.log(r.digest);
        console.log('\n(dry-run — use --write to apply. Tip: add AGENTS.md to .gitignore if you don\'t want it committed.)');
      } else console.log(`  ${r.project}: ${r.action} → ${r.file} (${r.count} observations)`);
      break;
    }
    // What the brain found on this machine and how far it is with building
    // memories from it (firstrun.mjs). Printed at the end of install; read-only.
    case 'past-sessions': {
      // on: include the history already on this computer · off: only sessions
      // from now on · status [--decided|--fresh]: prints a word, or nothing (for install.sh).
      const ps = await import('./lib/pastsessions.mjs');
      const sub = rest[0] || 'status';
      const quiet = rest.includes('--quiet');
      if (sub === 'status') {
        const c = ps.readChoice();
        if (rest.includes('--decided')) { if (c) console.log(c.mode); break; }
        if (rest.includes('--fresh')) { if (c?.mode === 'fresh') console.log('fresh'); break; }
        console.log(!c ? 'Past sessions: not chosen yet (they are included by default).'
          : c.mode === 'all' ? 'Past sessions: included. Your memory starts with the history already on this computer.'
          : `Past sessions: starting fresh. Only sessions since ${c.since.slice(0, 10)} are read. Include the rest: brain past-sessions on`);
        break;
      }
      if (sub === 'on') {
        ps.writeChoice('all');
        if (!quiet) {
          console.log('✅ Past sessions included. Reading them now; they become memories in the background.');
          const r = await ingest({ cutoff: 0 });
          const n = Object.values(r).reduce((a, t) => a + (t.sessions || 0), 0);
          console.log(`   ${n} past session${n === 1 ? '' : 's'} added. Progress: brain first-run`);
        }
        break;
      }
      if (sub === 'off') {
        const c = ps.writeChoice('fresh');
        if (!quiet) console.log(`✅ Starting fresh: only sessions from ${c.since.slice(0, 10)} on are read. Memories you already have are kept; delete any of them in the control panel.`);
        break;
      }
      console.error('usage: brain past-sessions on | off | status');
      process.exitCode = 2;
      break;
    }
    case 'first-run': {
      const { firstRunStatus, formatFirstRun } = await import('./lib/firstrun.mjs');
      const st = await firstRunStatus();
      console.log(rest.includes('--json') ? JSON.stringify(st, null, 2) : formatFirstRun(st));
      break;
    }
    case 'ingest':
      // `--install` runs ingest continuously on a timer (Codex/Cursor auto-capture).
      if (rest.includes('--install') || rest.includes('--autostart')) { installIngest({ log }); break; }
      if (rest.includes('--uninstall')) { uninstallIngest({ log }); break; }
      console.log(JSON.stringify(await ingest({ log }), null, 2));
      // Self-heal: capture without the distiller fills the store with raw
      // sessions that never become memories. This command is what the ingest
      // timer runs every few minutes, so if a setup step failed (or a machine
      // predates onboard installing the distiller), the next pass repairs it.
      // Never in tests or when automation is switched off.
      if (process.env.BRAIN_NO_AUTOMATION !== '1' && process.env.BRAIN_TEST !== '1') {
        try {
          const { distillStatus, installDistill } = await import('./lib/distill-schedule.mjs');
          const { availableProviders } = await import('./lib/distiller.mjs');
          if (!distillStatus().installed && availableProviders().some((p) => p.available)) {
            log('distiller job missing — installing it (captured sessions were not becoming memories)');
            installDistill({ log });
          }
        } catch (e) { log('distiller self-heal skipped: ' + e.message); }
      }
      break;
    // Run the agentic-brain MCP server in the foreground on stdio — this is
    // exactly what a tool config's command invokes, and what a user runs by
    // hand to debug it. Importing bin/mcp-server.mjs starts it (it wires
    // stdin/stdout at import time and exits on stdin close); this case must
    // do nothing else — stdout belongs exclusively to the server's JSON-RPC
    // frames from the moment this import resolves.
    case 'mcp-server':
      await import('./mcp-server.mjs');
      break;
    // Terminal equivalent of the brain_recall MCP tool: read-only FTS search
    // over the memory store, no writes, safe to run against the real DB.
    case 'recall': {
      const json = rest.includes('--json');
      const deep = rest.includes('--deep'); // cross-encoder rerank; may download the model on first use
      const flagValue = (flag) => { const i = rest.indexOf(flag); return i !== -1 ? rest[i + 1] : undefined; };
      const limitRaw = flagValue('--limit');
      const project = flagValue('--project');
      const dbPath = flagValue('--db');
      const skip = new Set([limitRaw, project, dbPath].filter((v) => v !== undefined));
      const flagWords = new Set(['--json', '--deep', '--limit', '--project', '--db']);
      const query = rest.filter((a) => !flagWords.has(a) && !skip.has(a)).join(' ').trim();
      if (!query) {
        console.log('usage: brain recall <query> [--project <name>] [--limit <n>] [--deep] [--json] [--db <path>]');
        process.exitCode = 1;
        break;
      }
      const r = await recallSearch({ query, project, limit: limitRaw ? Number(limitRaw) : undefined, dbPath: dbPath || undefined, deep, allowRemoteModel: deep });
      if (json) {
        console.log(JSON.stringify(r, null, 2));
      } else if (!r.results.length) {
        console.log(`(no results${r.reason ? ' — ' + r.reason : ''})`);
      } else {
        for (const row of r.results) {
          console.log(`${row.project} · ${row.title || '(untitled)'} · ${row.date || '—'}${row.lifecycle ? ` · [${row.lifecycle}]` : ''}`);
          // where it came from: tool · day · project · file
          if (row.provenance) console.log(`  ↳ ${row.provenance}`);
        }
        console.log(`\n${r.count} result(s)`);
      }
      break;
    }
    // Terminal equivalent of the brain_remember MCP tool: capture one
    // observation from flags or a --json payload. Never throws — reports
    // saved/duplicate/merged/error honestly and sets a non-zero exit only on
    // a genuine error (invalid input, write failure, busy store).
    case 'remember': {
      const flagValue = (flag) => { const i = rest.indexOf(flag); return i !== -1 ? rest[i + 1] : undefined; };
      const flagValues = (flag) => rest.reduce((acc, a, i) => (a === flag && rest[i + 1] !== undefined ? [...acc, rest[i + 1]] : acc), []);
      let input;
      const jsonPayload = flagValue('--json');
      if (jsonPayload !== undefined) {
        try {
          input = JSON.parse(jsonPayload);
        } catch (e) {
          console.log('✖ --json payload is not valid JSON: ' + e.message);
          process.exitCode = 1;
          break;
        }
      } else {
        input = {
          title: flagValue('--title'),
          subtitle: flagValue('--subtitle'),
          project: flagValue('--project'),
          type: flagValue('--type'),
          facts: flagValues('--fact'),
          narrative: flagValue('--narrative'),
          concepts: flagValues('--concept'),
          model: flagValue('--model'),
        };
        for (const k of Object.keys(input)) {
          const v = input[k];
          if (v === undefined || (Array.isArray(v) && v.length === 0)) delete input[k];
        }
      }
      const dbPath = flagValue('--db');
      const r = await rememberObservation(input, { dbPath: dbPath || undefined, clientName: 'brain-cli' });
      if (r.ok && r.status === 'saved') console.log(`✅ saved (id=${r.id}, project=${r.project})${r.supersedes ? ` — supersedes #${r.supersedes.join(', #')}` : ''}`);
      else if (r.ok && r.status === 'duplicate') console.log(`⚪️ duplicate — already have this one (id=${r.id})`);
      else if (r.ok && r.status === 'merged') console.log(`🔀 merged into a near-duplicate (id=${r.id})`);
      else console.log(`✖ ${r.error || 'brain remember failed'}`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'scrub': {
      // Dry-run is the default: bare `brain scrub` == `brain scrub --audit`. There
      // is no argument-free path to mutation (docs/specs/secret-scrubber.md §5.4.1).
      const json = rest.includes('--json');
      const tIdx = rest.indexOf('--tier');
      const tiersOpt = tIdx !== -1 ? rest[tIdx + 1].split(',').map(Number) : undefined;
      const sIdx = rest.indexOf('--since');
      const sinceHours = sIdx !== -1 ? Number(rest[sIdx + 1]) : undefined;
      if (rest.includes('--apply')) {
        doScrubApply({ yes: rest.includes('--yes'), force: rest.includes('--force'), tiersOpt, sinceHours });
      } else if (rest.includes('--revert')) {
        const rIdx = rest.indexOf('--revert');
        const ledgerPath = rest[rIdx + 1];
        if (!ledgerPath) { console.log('usage: brain scrub --revert <ledger-path>'); break; }
        const r = revertScrub({ ledgerPath });
        log(`↩️  reverted ${r.restored} column(s) from ${ledgerPath}`);
      } else {
        doScrubAudit({ json, tiersOpt, sinceHours });
      }
      break;
    }
    // Targeted store cleanups. Dry-run is the default (read-only open); --apply
    // backs the DB up (verified) before deleting anything.
    case 'clean': {
      const flagValue = (flag) => { const i = rest.indexOf(flag); return i !== -1 ? rest[i + 1] : undefined; };
      const modes = ['--self-capture', '--test-data', '--dupes', '--cursor-projects'].filter((m) => rest.includes(m));
      if (modes.length !== 1 || (rest.includes('--undo') && !['--dupes', '--cursor-projects'].includes(modes[0]))) { // exactly one mode
        console.log('usage: brain clean --self-capture|--test-data|--dupes|--cursor-projects [--undo] [--apply] [--json] [--db <path>]');
        process.exitCode = 1;
        break;
      }
      const opts = { dbPath: flagValue('--db') || MEMORY_DB, apply: rest.includes('--apply') };
      const mode = modes[0];
      let r;
      try {
        r = mode === '--test-data' ? cleanTestData(opts)
          : mode === '--dupes' ? cleanDupes({ ...opts, undo: rest.includes('--undo') })
          : mode === '--cursor-projects' ? cleanCursorProjects({ ...opts, undo: rest.includes('--undo'), runId: flagValue('--run') || null })
          : cleanSelfCapture(opts);
      } catch (e) { console.log('✖ ' + e.message); process.exitCode = 1; break; }
      const fmt = mode === '--test-data' ? formatTestDataReport : mode === '--dupes' ? formatDupesReport
        : mode === '--cursor-projects' ? formatCursorProjectsReport : formatSelfCaptureReport;
      console.log(rest.includes('--json') ? JSON.stringify(r, null, 2) : fmt(r));
      break;
    }
    // Re-capture sessions that grew after they were captured (recapture.mjs).
    // Ingest never rewrites an existing row on its own; this is the opt-in:
    // dry-run by default, --apply behind a verified backup, --undo restores the
    // journalled old values (including the earlier distillation).
    case 'recapture': {
      const flagValue = (flag) => { const i = rest.indexOf(flag); return i !== -1 ? rest[i + 1] : undefined; };
      const tool = flagValue('--tool');
      let r;
      try {
        r = recapture({
          dbPath: flagValue('--db') || MEMORY_DB, apply: rest.includes('--apply'), undo: rest.includes('--undo'), runId: flagValue('--run') || null,
          ...(tool ? { tools: tool.split(',') } : {}),
        });
      } catch (e) { console.log('✖ ' + e.message); process.exitCode = 1; break; }
      console.log(rest.includes('--json') ? JSON.stringify(r, null, 2) : formatRecaptureReport(r));
      break;
    }
    // Memory lifecycle (lifecycle.mjs). Dry-run is the default and opens the
    // store read-only; --apply writes status metadata only (never content),
    // migrating the store first — behind a verified backup — if it has to.
    case 'lifecycle': {
      const flagValue = (flag) => { const i = rest.indexOf(flag); return i !== -1 ? rest[i + 1] : undefined; };
      const dbPath = flagValue('--db') || MEMORY_DB;
      const clear = rest.includes('--clear');
      let findings = {};
      if (!clear) {
        const { openDb } = await import('./lib/db.mjs');
        const rdb = openDb(dbPath, { readonly: true });
        try { findings = lintFindings(rdb); } finally { rdb.close(); }
      }
      const r = runLifecycle({ dbPath, apply: rest.includes('--apply'), findings, clear });
      console.log(rest.includes('--json') ? JSON.stringify(r, null, 2) : formatLifecycleReport(r));
      break;
    }
    // content_hash v1 → v2 (migrate-hash.mjs). Dry-run is the default and opens
    // the store read-only; --apply backs it up (verified) before rewriting.
    case 'migrate-hash': {
      const flagValue = (flag) => { const i = rest.indexOf(flag); return i !== -1 ? rest[i + 1] : undefined; };
      const { migrateHash, formatMigrateHashReport } = await import('./lib/migrate-hash.mjs');
      let r;
      try { r = migrateHash({ dbPath: flagValue('--db') || MEMORY_DB, apply: rest.includes('--apply') }); }
      catch (e) { console.log('✖ ' + e.message); process.exitCode = 1; break; }
      console.log(rest.includes('--json') ? JSON.stringify(r, null, 2) : formatMigrateHashReport(r));
      if (r.applied && !r.verified) process.exitCode = 1;
      break;
    }
    // Local semantic search (embed.mjs). Default is a read-only status report;
    // --apply backfills vectors into their own table (observations are never
    // changed) — incremental and resumable, so re-run it to pick up new memories.
    case 'embed': {
      const flagValue = (flag) => { const i = rest.indexOf(flag); return i !== -1 ? rest[i + 1] : undefined; };
      // The background backfill job (embed-schedule.mjs) — installed by install.sh / onboard.
      if (rest.includes('--install') || rest.includes('--uninstall')) {
        const { installEmbed, uninstallEmbed } = await import('./lib/embed-schedule.mjs');
        const iIdx = rest.indexOf('--every');
        const interval = iIdx !== -1 ? Number(rest[iIdx + 1]) || undefined : undefined;
        if (rest.includes('--uninstall')) uninstallEmbed({ log: console.log });
        else installEmbed({ interval, log: console.log });
        break;
      }
      const { runEmbed } = await import('./lib/embed.mjs');
      const limit = flagValue('--limit') ? Number(flagValue('--limit')) : Infinity;
      const batch = Number(flagValue('--batch')) > 0 ? Number(flagValue('--batch')) : undefined;
      const r = await runEmbed({ dbPath: flagValue('--db') || MEMORY_DB, apply: rest.includes('--apply'), clear: rest.includes('--clear'), limit, batch, log });
      if (rest.includes('--json')) { console.log(JSON.stringify(r, null, 2)); }
      else if (r.skipped) { console.log(`⏭  ${r.skipped} — meaning-based search is off, nothing embedded`); }
      else if (r.error) { console.log(`✖ ${r.error}`); }
      else if (r.clear) { console.log(r.apply ? `🧹 removed ${r.cleared || 0} vector(s) — recall is BM25-only until the next 'brain embed --apply'` : `would remove ${r.vectors} vector(s) (dry-run; add --apply)`); }
      else {
        console.log(`brain embed · model ${r.model} · library ${r.library ? 'installed' : 'NOT installed (npm install @huggingface/transformers)'}`);
        console.log(`  ${r.embedded}/${r.total} memories embedded · ${r.pending} pending${r.stale ? ` (${r.stale} changed since)` : ''}${r.orphans ? ` · ${r.orphans} orphan vector(s)` : ''}`);
        if (r.written !== undefined) console.log(`  wrote ${r.written} in ${(r.ms / 1000).toFixed(1)}s`);
        else if (r.pending) console.log('  dry-run — add --apply to backfill (resumable; re-run any time for new memories)');
      }
      // --scheduled (the background job): "library not installed" / "model not
      // downloadable yet (offline)" are not failures — try again next wake-up.
      if (r.error && !(rest.includes('--scheduled') && r.unavailable)) process.exitCode = 1;
      break;
    }
    case 'status-mark': {
      const flagValue = (flag) => { const i = rest.indexOf(flag); return i !== -1 ? rest[i + 1] : undefined; };
      const [id, status] = rest;
      if (!id || !status || id.startsWith('--')) {
        console.log('usage: brain status-mark <id> <active|superseded|contested|stale|auto> [--by <id>] [--note <text>] [--db <path>]');
        process.exitCode = 1;
        break;
      }
      const dbPath = flagValue('--db') || MEMORY_DB;
      let h;
      try { h = openForLifecycle(dbPath); } catch (e) { console.log('✖ ' + e.message); process.exitCode = 1; break; }
      try {
        if (h.backupPath) console.log(`  (first lifecycle write: store migrated, backup at ${h.backupPath})`);
        const r = markStatus(h.db, id, status, { by: flagValue('--by'), note: flagValue('--note') || '' });
        if (r.ok) console.log(`✅ #${r.id}: ${r.from} → ${r.to}${r.by ? ` (by #${r.by})` : ''}`);
        else { console.log('✖ ' + r.error); process.exitCode = 1; }
      } finally { h.db.close(); }
      break;
    }
    case 'onboard': {
      // One command to wire this machine end-to-end (docs/specs/auto-wiring.md §4).
      // Glues the existing steps — each is individually idempotent/additive.
      // (New-machine restore stays install.sh.) Order is load-bearing: the
      // bridge home MUST exist before anything wires an MCP config at it.
      //
      //   1. detect tools
      //   2. installBridgeHome()               — BEFORE wiring; every config points at the shim
      //   3. wireMcp({write})                   — registry-driven, all detected targets
      //   4. enableClaudeMemEverywhere / injectContext
      //   5. launchd installs (watchers / daily sync / control panel)  — skipped on --dry-run
      //   6. summary table (capture / push / pull / restart)
      //
      // --dry-run (alias --dry): compute and print the exact same plan, write nothing —
      // this is how a user safely previews onboarding before it touches real tool configs.
      const write = !(rest.includes('--dry-run') || rest.includes('--dry'));
      log(`🚀 Claude Brain — onboarding this machine${write ? '' : ' (--dry-run: preview only, nothing will be written)'}\n`);

      log('1) detected AI tools');
      try { for (const t of detectAll().tools.filter((t) => t.detected)) log(`   ✅ ${t.name}`); }
      catch (e) { log('   detect skipped: ' + e.message); }

      log('\n2) stable bridge home (~/.agentic-brain) — must exist before any tool is wired');
      let bridgeInfo = null;
      try {
        bridgeInfo = installBridgeHome({ dry: !write });
        const verb = bridgeInfo.changed ? (write ? 'installed/refreshed' : 'would install/refresh') : 'already current';
        log(`   ${verb} → ${bridgeInfo.bridge}`);
        log(`   engine → ${bridgeInfo.engine}`);
        if (bridgeInfo.node) log(`   node   → ${bridgeInfo.node.path} (${bridgeInfo.node.source})`);
        for (const w of bridgeInfo.warnings) log(`   ⚠️  ${w}`);
      } catch (e) { log('   bridge home FAILED: ' + e.message + ' — wiring below cannot succeed until this is fixed'); }

      log('\n3) wire the agentic-brain MCP server into every detected AI tool');
      let wireResult = null;
      try {
        wireResult = wireMcp({ write });
        if (wireResult.ok) for (const t of wireResult.results) log(`   ${t.installed ? '✅' : '⚪️'} ${t.tool}: ${t.action}`);
        else log('   ' + wireResult.error);
      } catch (e) { log('   wire-mcp skipped: ' + e.message); }

      log('\n3b) Claude Code startup hook — shows this folder\'s latest memories when `claude` opens');
      try {
        const hk = wireSessionHook({ write });
        if (!hk.length) log('   ⚪️ no Claude Code profile found');
        for (const r of hk) log(`   ${r.ok ? '✅' : '❌'} ${r.profile}/settings.json: ${r.action}`);
      } catch (e) { log('   session hook skipped: ' + e.message); }

      // claude-mem is a third-party plugin: enabling it in every profile is opt-in
      // (--with-claude-mem / BRAIN_ENABLE_CLAUDE_MEM=1 / config claudeMem.enableEverywhere).
      const withClaudeMem = claudeMemOptIn({ flag: rest.includes('--with-claude-mem') });
      log(`\n4) brain digest across Claude profiles${withClaudeMem ? ' + enable claude-mem' : ''}`);
      try {
        if (withClaudeMem) {
          const en = enableClaudeMemEverywhere({ write, log });
          if (!write) for (const r of en.results) log(`   plugin · ${r.profile}: ${r.action}${r.file ? `  → ${r.file}` : ''}`);
        } else {
          log('   claude-mem plugin: left as it is (opt in with --with-claude-mem)');
        }
        // A brand-new machine has no store yet. Create it so the digest can be
        // written: guarding on existsSync skipped injection for exactly the user
        // this step serves, while the summary still claimed "injected".
        if (write && !existsSync(MEMORY_DB)) {
          try { const { openStore } = await import('./lib/store.mjs'); openStore({ path: MEMORY_DB }).close(); }
          catch (e) { log('   store create skipped: ' + e.message); }
        }
        {
          const inj = injectContext({ write, log });
          if (!write) for (const t of (inj.results || [])) log(`   digest · ${t.label}: ${t.action}${t.file ? `  → ${t.file}` : ''}`);
        }
      } catch (e) { log('   sync-claude skipped: ' + e.message); }

      log('\n4b) make saved skills callable from every tool');
      try {
        const { syncSkills } = await import('./lib/skills-sync.mjs');
        const sk = syncSkills({ apply: write });
        if (!sk.ok) log(`   ${sk.error}`);
        else {
          for (const t of sk.targets) {
            if (t.isLibrary) { log(`   ◆ ${t.name}: the library (${sk.skillCount} skills)`); continue; }
            log(`   ${t.linked ? '✅' : '⚪️'} ${t.name}: ${write ? 'linked' : 'would link'} ${t.linked}, ${t.already} already`);
          }
          log(`   desktop apps (Claude Desktop / ChatGPT) reach these via the brain_skills + brain_skill MCP tools`);
        }
      } catch (e) { log('   skill link skipped: ' + e.message); }

      // BRAIN_NO_AUTOMATION=1 wires configs but installs no LaunchAgents. install.sh
      // already honours this; onboard must too, or the two disagree. It is also what
      // makes onboard safe to run under a sandboxed $HOME: launchctl acts on the real
      // login session regardless of $HOME, so a test run would otherwise leak agents.
      const noAutomation = process.env.BRAIN_NO_AUTOMATION === '1';
      if (write && noAutomation) {
        log('\n5-7) launchd installs — skipped, BRAIN_NO_AUTOMATION=1');
      } else if (write) {
        log('\n5) install the always-on agy watcher (launchd)');
        try { installWatchAgy({ log }); } catch (e) { log('   watch-agy skipped: ' + e.message); }
        log('\n5b) install the near-live Codex watcher (launchd)');
        try { installWatchCodex({ log }); } catch (e) { log('   watch-codex skipped: ' + e.message); }
        log('\n5c) auto-capture Cursor sessions (launchd timer)');
        try { installIngest({ log }); } catch (e) { log('   ingest timer skipped: ' + e.message); }
        // Without this, captured sessions never become memories: ingest stores the
        // raw sessions, the distiller (Claude/Codex/Antigravity CLI, whichever is here)
        // turns them into observations. It used to be a manual opt-in, so a new
        // machine silently captured transcripts and grew no memories.
        log('\n5c+) turn captured sessions into memories (distiller, launchd timer)');
        try { const { installDistill } = await import('./lib/distill-schedule.mjs'); installDistill({ log }); } catch (e) { log('   ❌ distill timer FAILED: ' + e.message + ' — captured sessions will not become memories until fixed: brain distill-sessions --install (the ingest timer also retries this automatically)'); }
        log('\n5d) meaning-based search: background backfill of embeddings (low priority; BRAIN_EMBED=0 skips)');
        try { const { installEmbed } = await import('./lib/embed-schedule.mjs'); installEmbed({ log }); } catch (e) { log('   embed job skipped: ' + e.message); }
        log('\n6) schedule the daily sync (launchd)');
        try { const { installDailySync } = await import('./setup-automation.mjs'); installDailySync({ log }); } catch (e) { log('   automation skipped: ' + e.message); }
        log('\n7) make the control panel always-on (launchd)');
        try { installServe({ log }); } catch (e) { log('   control panel autostart skipped: ' + e.message); }
      } else {
        log('\n5-7) launchd installs (watchers, daily sync, control panel) — skipped, --dry-run');
      }

      // ── summary table (spec §4) ─────────────────────────────────────────
      const restartWord = (r) => (r === 'restart-app' ? 'restart app' : r === 'next-launch' ? 'next launch' : 'no');
      const wireById = new Map((wireResult?.ok ? wireResult.results : []).map((r) => [r.id, r]));
      log(`\n${write ? '✅ onboarding complete.' : '👁  dry-run complete — nothing was written.'}\n`);
      log('Summary — per tool');
      const col = (s, w) => { const str = String(s); return str.length >= w ? str + ' ' : str.padEnd(w); };
      const nameW = Math.max(24, ...WIRE_TARGETS.map((t) => t.name.length + 2));
      log('  ' + col('tool', nameW) + col('capture', 10) + col('push', 14) + col('pull (MCP)', 24) + 'restart');
      const restartNeeded = [];
      for (const target of WIRE_TARGETS) {
        const wr = wireById.get(target.id);
        const installed = !!wr && wr.installed;
        const pull = !installed ? 'skipped (not installed)' : target.capture === 'native' ? 'native plugin' : (wr.action || wr.status || '?');
        const push = target.push === null ? '— (n/a)' : !installed ? 'skipped' : (write ? 'injected' : 'would inject');
        const changedThisRun = installed && write && wr.changed;
        log('  ' + col(target.name, nameW) + col(target.capture, 10) + col(push, 14) + col(pull, 24) + restartWord(target.restart));
        if (changedThisRun && target.restart !== 'none') restartNeeded.push(target.name);
      }
      if (restartNeeded.length) log(`\n⚠️  restart these apps to finish: ${restartNeeded.join(', ')}`);
      else if (write) log('\nNothing newly wired needs a restart this run.');
      break;
    }
    case 'status':
      doStatus();
      break;
    case 'init': {
      const repoIdx = rest.indexOf('--repo');
      const ownerIdx = rest.indexOf('--owner');
      const opts = {
        repo: repoIdx !== -1 ? rest[repoIdx + 1] : undefined,
        owner: ownerIdx !== -1 ? rest[ownerIdx + 1] : undefined,
        yes: rest.includes('--yes') || rest.includes('-y'),
        noAutomation: rest.includes('--no-automation'),
      };
      try {
        const r = await runInit(opts);
        process.exitCode = r.exitCode ?? (r.ok ? 0 : 1);
      } catch (e) {
        console.error('✖ ' + e.message);
        process.exitCode = e instanceof InitError ? (e.exitCode ?? 1) : 1;
      }
      break;
    }
    case 'doctor': {
      const json = rest.includes('--json');
      const { exitCode } = await runDoctor({ json });
      process.exitCode = exitCode;
      break;
    }
    // Read-only: what leaves this machine. Exit 1 iff a check fails (like doctor).
    case 'audit': {
      const r = runAudit({ network: !rest.includes('--offline'), deep: rest.includes('--deep'), scrub: !rest.includes('--no-scrub') });
      console.log(rest.includes('--json') ? JSON.stringify(r, null, 2) : formatAudit(r));
      process.exitCode = r.exitCode;
      break;
    }
    // Copy an existing claude-mem memory into the native store. Dry-run by
    // default; --apply writes. The source is opened read-only and is never
    // modified — claude-mem stays installed and working either way.
    case 'import-claude-mem': {
      const { importClaudeMem, formatReport } = await import('./lib/import-claude-mem.mjs');
      const { MEMORY_DB } = await import('./lib/paths.mjs');
      const arg = (flag) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
      const r = await importClaudeMem({
        source: arg('--source') || MEMORY_DB,
        dest: arg('--dest'),
        apply: rest.includes('--apply'),
        since: arg('--since') ? Number(arg('--since')) : null,
        resume: !rest.includes('--no-resume'),
        verify: !rest.includes('--no-verify'),
        log,
      });
      console.log(formatReport(r));
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    // One-command move from claude-mem (lib/switch-claude-mem.mjs). Plan by
    // default; --apply imports + verifies, wires, and mutes claude-mem's startup
    // dump; --undo restores claude-mem's settings from the recorded prior values.
    case 'switch-from-claude-mem': {
      const sw = await import('./lib/switch-claude-mem.mjs');
      const { CLAUDE_MEM_DIR, NATIVE_DB_PATH } = await import('./lib/paths.mjs');
      const arg = (flag) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
      const asJson = rest.includes('--json');
      if (rest.includes('--undo')) {
        const r = sw.undoSwitch({ dest: NATIVE_DB_PATH, log: asJson ? () => {} : log });
        console.log(asJson ? JSON.stringify(r, null, 2) : sw.formatUndoReport(r));
        process.exitCode = r.ok ? 0 : 1;
        break;
      }
      const r = await sw.switchFromClaudeMem({
        source: arg('--source') || CLAUDE_MEM_DB,
        dest: NATIVE_DB_PATH,
        settingsFile: join(CLAUDE_MEM_DIR, 'settings.json'),
        apply: rest.includes('--apply'),
        silence: !rest.includes('--no-silence'),
        log: asJson ? () => {} : log,
      });
      console.log(asJson ? JSON.stringify(r, null, 2) : sw.formatSwitchReport(r));
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    // Mirror allowlisted engine code into the sibling engine repo. Maintainer-only:
    // deliberately left out of the help listing, but still works. Dry-run is the
    // default everywhere (same convention as `scrub`); --apply is required to write.
    // Creating the GitHub repo, adding a remote, pushing and flipping visibility
    // are deliberately NOT here — those stay owner-only, by hand.
    case 'engine-export':
    case 'engine-diff':
    case 'engine-import': {
      const { engineExport, engineDiff, engineImport } = await import('./lib/engine-mirror.mjs');
      const apply = rest.includes('--apply');
      const toIdx = rest.indexOf('--to');
      const to = toIdx >= 0 ? rest[toIdx + 1] : null;
      const r = cmd === 'engine-diff'
        ? engineDiff({ orphans: rest.includes('--orphans') })
        : cmd === 'engine-import'
          ? engineImport({ apply })
          : engineExport({ apply, to });
      console.log(r.lines.join('\n'));
      process.exitCode = r.code;
      break;
    }
    case 'key': {
      const sub = rest[0];
      if (sub === 'generate') {
        const force = rest.includes('--force');
        if (force && hasKey()) {
          // Explicit, typed confirmation — force must never be reachable by accident.
          const answer = await promptTTY(
            'This will DESTROY the existing age key and make every backup encrypted to it ' +
              'permanently unreadable.\nType exactly "destroy old key" to proceed: '
          );
          if (answer.trim() !== 'destroy old key') {
            console.log('Aborted. No key was changed.');
            process.exitCode = 1;
            break;
          }
        }
        console.log('recipient:', generateAndStoreKey({ force }));
      } else if (sub === 'rotate') {
        // Replace the key (e.g. after it was exposed) without stranding the cloud
        // backup. A bare `key generate --force` makes the next sync unable to read
        // the cloud copy, and sync rightly refuses to overwrite what it can't read.
        // Order: merge the cloud in under the OLD key → new key → re-encrypt and
        // upload. If anything after the new key fails, the old key is put back.
        if (!hasKey()) { console.log('✖ No key on this Mac to rotate. Import it first: brain key import'); process.exitCode = 1; break; }
        const answer = await promptTTY(
          'Rotate your encryption key: your cloud backup will be re-encrypted with a NEW key,\n' +
            'and the old key stops working. Type "rotate" to continue: '
        );
        if (answer.trim() !== 'rotate') { console.log('Aborted. Nothing changed.'); process.exitCode = 1; break; }
        const oldIdentity = getSecret(SECRET_KEYS.AGE_KEY);
        log('1/3 sync with the current key (brings the cloud copy in first)');
        await doSync();
        log('2/3 new key');
        generateAndStoreKey({ force: true });
        try {
          log('3/3 re-encrypt + upload');
          const packed = packMemory({ log });
          if (!packed.blob || !uploadBlob(packed.blob, { log })) throw new Error('upload did not happen');
        } catch (e) {
          importIdentity(oldIdentity);
          console.log(`✖ ${e.message} — your old key is back in place; nothing is lost. Fix the problem and re-run: brain key rotate`);
          process.exitCode = 1;
          break;
        }
        // The recovery file holds the OLD key, which no longer opens anything —
        // leaving it would hand a new Mac the wrong key. Remove it; re-create.
        if (hasRecoveryFile()) {
          try { unlinkSync(RECOVERY_FILE); } catch {}
          publishRecoveryChange('brain: remove key recovery file (key rotated)');
          log('   Your recovery passphrase file held the old key and was removed. Re-create it: brain key backup');
        }
        console.log('\n✅ Key rotated. Your cloud backup is now locked with the new key.');
        console.log('   The new private key is NOT printed (it would land in terminal scrollback and logs).');
        console.log('   Public key (safe to share): ' + getSecret(SECRET_KEYS.AGE_RECIPIENT));
        // Another Mac needs the new key. The safe route is a passphrase-encrypted
        // recovery file, not a key pasted from the screen — offer it right now.
        const wantBackup = await promptTTY('\nBack the new key up now with a recovery passphrase (asked hidden)? Type "y" to do it, Enter to skip: ');
        if (/^y(es)?$/i.test(wantBackup.trim())) {
          try { await doKeyBackup(); }
          catch (e) { console.log(`✖ ${e.message}\n   Nothing was exposed. Try again any time: brain key backup`); process.exitCode = 1; }
        } else {
          console.log('   Later:  brain key backup   (recommended — a new Mac then needs only the passphrase)');
        }
        console.log('   Other Macs: brain key recover (after backup) — or, if you must hold the raw key: brain key reveal\n');
      } else if (sub === 'import') {
        // No key on the command line → ask for it, hidden. Keeps the secret out
        // of shell history and avoids quoting/placeholder mistakes when pasting.
        let key = rest[1] || '';
        if (!key) key = await promptSecret('Paste your key (AGE-SECRET-KEY-1…) and press Enter — it will not be shown: ');
        console.log('recipient:', importIdentity(key));
      }
      else if (sub === 'backup') await doKeyBackup({ stdin: rest.includes('--passphrase-stdin') });
      else if (sub === 'recover') {
        const fi = rest.indexOf('--file');
        const recipient = await doKeyRecover({ stdin: rest.includes('--passphrase-stdin'), file: fi >= 0 ? rest[fi + 1] : RECOVERY_FILE });
        console.log('recipient:', recipient);
      }
      else if (sub === 'reveal') await doKeyReveal();
      else if (sub === 'show') console.log('recipient:', getSecret(SECRET_KEYS.AGE_RECIPIENT) || '(none)');
      else console.log('usage: brain key generate [--force] | import [AGE-SECRET-KEY-...]  (no key → hidden prompt) | rotate | show\n' +
        '       brain key reveal                                 show the private key on the terminal only (typed confirmation)\n' +
        '       brain key backup [--passphrase-stdin]            key → memory/key-recovery.age, passphrase-encrypted\n' +
        '       brain key recover [--passphrase-stdin] [--file <path>]   passphrase → key (new Mac)');
      break;
    }
    case 'serve': {
      // `--install` makes the control panel an always-on background service
      // (auto-start at login, auto-restart on crash). Default = run foreground.
      if (rest.includes('--install') || rest.includes('--autostart')) { installServe({ log }); break; }
      if (rest.includes('--uninstall')) { uninstallServe({ log }); break; }
      await import('../ui/server.mjs');
      break;
    }
    default:
      console.log('usage: brain <init|sync|restore|merge|export|status|doctor|audit|key|serve|onboard|skills|distill|distill-sessions|eval|workflows|ingest|scrub|clean|recapture|lifecycle|status-mark|migrate-hash|import-claude-mem|switch-from-claude-mem|mcp-server|recall|remember>');
  }
}

import { pathToFileURL } from 'node:url';
// Only run the CLI when invoked directly (not when imported by the UI server).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('✖', e.message);
    process.exit(1);
  });
}
