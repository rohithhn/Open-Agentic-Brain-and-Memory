// `brain init` — fresh-brain onboarding (docs/specs/brain-init.md §2).
//
// A stranger with a clean Mac and `gh auth login` reaches a working, syncing,
// encrypted brain: key → private repo → config → first sync → wiring.
//
// Three properties this file exists to guarantee:
//
//  1. ORDER IS LOAD-BEARING: key BEFORE repo BEFORE sync. A blob uploaded under
//     a key that is later regenerated is permanently unreadable.
//  2. THE KEY IS NEVER REGENERATED OVER AN EXISTING BRAIN. Before key
//     generation can even be attempted we probe `gh release view brain-latest`
//     on the target repo; a release there + no local key ⇒ hard STOP
//     (brain-init.md §3 failure mode 6). `generateAndStoreKey()` has its own
//     refuse-if-present guard in crypto.mjs; init never passes `force`.
//  3. STATE IS DERIVED, NEVER STORED. Every run re-probes and resumes at the
//     first unfinished step; there is no ledger file to go stale.
//
// Everything that touches the world (keychain, gh, git, spawn, tty, fs) goes
// through the injectable `deps` object so the acceptance harness can simulate
// the destructive paths without a real key, repo, or network.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, CONFIG_PATH, CONFIG_EXAMPLE_PATH } from './paths.mjs';

export const DEFAULT_REPO_NAME = 'claude-brain';
export const BLOB_RELEASE = 'brain-latest';
export const MIN_NODE_MAJOR = 22;

// ── errors ────────────────────────────────────────────────────────────────
// `resumable: true`  → re-running `brain init` picks up where it stopped (R)
// `resumable: false` → everything this run created was undone before exit (X)
export class InitError extends Error {
  constructor(message, { code = 'INIT_FAILED', resumable = true, step = null, exitCode = 1 } = {}) {
    super(message);
    this.name = 'InitError';
    this.code = code;
    this.resumable = resumable;
    this.step = step;
    this.exitCode = exitCode;
  }
}

// The normative failure table (brain-init.md §3), kept next to the code that
// implements it so the two cannot drift. R = resumable, X = rolled back.
export const FAILURE_MODES = {
  NO_GH_AUTH: { n: 1, resumable: true, step: 1 },
  NO_REPO_SCOPE: { n: 2, resumable: true, step: 1 },
  REPO_NAME_TAKEN: { n: 3, resumable: true, step: 5 },
  REPO_PUBLIC: { n: 4, resumable: true, step: 5 },
  KEYCHAIN_DENIED: { n: 5, resumable: false, step: 3 },
  EXISTING_BRAIN_NO_KEY: { n: 6, resumable: true, step: 3 },
  NODE_TOO_OLD: { n: 7, resumable: false, step: 1 },
  NETWORK: { n: 8, resumable: true, step: null },
  SYNC_FAILED: { n: 9, resumable: true, step: 7 },
};

const NETWORK_RE =
  /could not resolve host|name or service not known|network is (down|unreachable)|timed? ?out|connection refused|no such host|dial tcp|tls handshake|temporary failure in name resolution|offline/i;

export function looksLikeNetworkFailure(text) {
  return NETWORK_RE.test(String(text || ''));
}

// ── injectable world ──────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd || REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  return {
    ok: r.status === 0,
    code: r.status == null ? -1 : r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim() || (r.error ? r.error.message : ''),
  };
}

export function defaultDeps() {
  return {
    log: (m) => console.log(m),

    // environment
    nodeMajor: () => Number(process.versions.node.split('.')[0]),
    which: (bin) => run('/usr/bin/which', [bin]).ok,

    // keychain / crypto — imported lazily so a test harness that never reaches
    // these steps never loads the module that can talk to the real Keychain.
    hasKey: async () => (await import('./crypto.mjs')).hasKey(),
    generateAndStoreKey: async () => (await import('./crypto.mjs')).generateAndStoreKey(), // NEVER pass {force}
    getRecipient: async () => {
      const { getSecret, SECRET_KEYS } = await import('./keychain.mjs');
      return getSecret(SECRET_KEYS.AGE_RECIPIENT);
    },
    getIdentity: async () => {
      const { getSecret, SECRET_KEYS } = await import('./keychain.mjs');
      return getSecret(SECRET_KEYS.AGE_KEY);
    },
    deleteKeyPair: async () => {
      const { deleteSecret, SECRET_KEYS } = await import('./keychain.mjs');
      deleteSecret(SECRET_KEYS.AGE_KEY);
      deleteSecret(SECRET_KEYS.AGE_RECIPIENT);
    },

    // recovery passphrase (lib/recovery.mjs) — optional second copy of the key
    // in the brain repo, encrypted with a passphrase the user picks.
    hasRecovery: async () => (await import('./recovery.mjs')).hasRecoveryFile(),
    promptHidden: async (q) => (await import('./recovery.mjs')).promptHidden(q),
    passphraseProblem: async (p) => (await import('./recovery.mjs')).passphraseProblem(p),
    writeRecovery: async (identity, passphrase, recipient) =>
      (await import('./recovery.mjs')).writeRecoveryFile(identity, passphrase, { recipient }),

    // external commands
    gh: (args, opts) => run('gh', args, opts),
    git: (args, opts) => run('git', args, opts),

    // filesystem (repo-local only)
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFileAtomic: (p, data) => {
      const tmp = `${p}.tmp.${process.pid}`;
      try {
        writeFileSync(tmp, data, { mode: 0o600 });
        renameSync(tmp, p);
      } catch (e) {
        try { unlinkSync(tmp); } catch {}
        throw e;
      }
    },
    removeFile: (p) => { try { unlinkSync(p); } catch {} },

    // first sync + wiring run as SUBPROCESSES on purpose: paths.mjs caches
    // config at import time, so an in-process doSync() after init writes
    // config.json would still be holding the config.example.json fallback and
    // would push to `YOUR_GITHUB_USERNAME/claude-brain`.
    sync: () => run('node', [join(REPO_ROOT, 'bin', 'brain.mjs'), 'sync'], { stdio: ['ignore', 'inherit', 'pipe'] }),
    onboard: () => run('node', [join(REPO_ROOT, 'bin', 'brain.mjs'), 'onboard'], { stdio: ['ignore', 'inherit', 'pipe'] }),

    // one-line prompt from the controlling terminal. Under `curl | bash` stdin
    // is the script itself, so /dev/tty is the only honest source. Returns null
    // when there is no tty — callers must then require --yes.
    prompt: async (question) => {
      const fs = await import('node:fs');
      const tty = await import('node:tty');
      let fd, out;
      try { fd = fs.openSync('/dev/tty', 'r+'); out = fs.openSync('/dev/tty', 'w'); } catch {
        if (fd !== undefined) fs.closeSync(fd);
        return null;
      }
      // tty streams, not fs.createReadStream: an fs stream keeps a read pending
      // on the thread pool after the answer and would swallow the NEXT line
      // typed — e.g. the hidden recovery passphrase asked right after this.
      const input = new tty.ReadStream(fd);
      const output = new tty.WriteStream(out);
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input, output });
      const answer = await new Promise((res) => rl.question(question, res));
      rl.close();
      input.destroy();
      output.destroy();
      return answer;
    },
  };
}

// ── probes ────────────────────────────────────────────────────────────────

// Does the target repo already hold an encrypted brain?
//
// THE most important function in this file. Returns one of:
//   'absent'  — provably no brain-latest release ⇒ safe to generate a key
//   'present' — a release exists ⇒ generating a key destroys that brain
//   'unknown' — probe could not answer (network/auth) ⇒ treated as unsafe
// Never returns 'absent' on an inconclusive answer: fail-safe by construction.
export function probeBrainRelease(slug, deps) {
  const r = deps.gh(['release', 'view', BLOB_RELEASE, '-R', slug]);
  if (r.ok) return { state: 'present', detail: r.out.split('\n')[0] || '' };
  const text = `${r.err}\n${r.out}`;
  if (looksLikeNetworkFailure(text)) return { state: 'unknown', detail: 'network' };
  // gh says exactly this when the repo exists but has no such release.
  if (/release not found|not found \(HTTP 404\)|no releases found/i.test(text)) {
    return { state: 'absent', detail: 'no release' };
  }
  if (/could not resolve to a repository|repository not found/i.test(text)) {
    return { state: 'absent', detail: 'repo does not exist' };
  }
  return { state: 'unknown', detail: text.split('\n')[0] || `gh exit ${r.code}` };
}

// Hard gate in front of key generation (brain-init.md §3 #6, §4 #1).
// Throws InitError unless it can PROVE the target repo holds no encrypted brain.
export function assertKeyGenerationSafe({ slug, repoExists, deps }) {
  if (!repoExists) return { safe: true, reason: 'repo-absent' };
  const probe = probeBrainRelease(slug, deps);
  if (probe.state === 'absent') return { safe: true, reason: probe.detail };
  if (probe.state === 'present') {
    throw new InitError(
      `${slug} already holds an encrypted brain, but this Mac has no key.\n` +
        `  Generating a new key would make that brain permanently unreadable.\n` +
        `  • Restore the key from your other Mac:  brain key import AGE-SECRET-KEY-…\n` +
        `  • Set a recovery passphrase earlier? Clone ${slug} and run:  brain key recover\n` +
        `  • Or, if the key is lost for good, start over:  brain init --repo <new-name>\n` +
        `  (No key was generated. Nothing was changed.)`,
      { code: 'EXISTING_BRAIN_NO_KEY', resumable: true, step: 3, exitCode: 3 }
    );
  }
  throw new InitError(
    `Couldn't check whether ${slug} already holds an encrypted brain (${probe.detail}).\n` +
      `  Refusing to generate a key while that is unknown — a new key would make an\n` +
      `  existing brain permanently unreadable.\n` +
      `  Check your network / 'gh auth status', then re-run: brain init`,
    { code: 'RELEASE_PROBE_INCONCLUSIVE', resumable: true, step: 3, exitCode: 3 }
  );
}

export function readRepoSlugFromConfig(deps, path = CONFIG_PATH) {
  if (!deps.exists(path)) return null;
  try {
    const c = JSON.parse(deps.readFile(path));
    if (c?.repo?.owner && c?.repo?.name && c.repo.owner !== 'YOUR_GITHUB_USERNAME') {
      return { owner: c.repo.owner, name: c.repo.name };
    }
  } catch {
    throw new InitError(
      `config.json is not valid JSON — fix it or delete it and re-run 'brain init'.`,
      { code: 'CONFIG_MALFORMED', resumable: true, step: 0 }
    );
  }
  return null;
}

export function ghRepoInfo(slug, deps) {
  const r = deps.gh(['repo', 'view', slug, '--json', 'name,isPrivate,url,diskUsage']);
  if (r.ok) {
    try {
      const j = JSON.parse(r.out);
      return { exists: true, private: !!j.isPrivate, url: j.url, empty: !j.diskUsage };
    } catch {
      return { exists: true, private: null, url: `https://github.com/${slug}`, empty: null };
    }
  }
  const text = `${r.err}\n${r.out}`;
  if (looksLikeNetworkFailure(text)) {
    throw new InitError(
      `Lost network while looking up ${slug}. Nothing is corrupted — re-run 'brain init' when you're back online; it resumes from here.`,
      { code: 'NETWORK', resumable: true, step: 5 }
    );
  }
  return { exists: false, private: null, url: null, empty: null };
}

// The 5-line ✅/⬜ checklist every run opens with (brain-init.md §2 step 0).
export function renderChecklist(state) {
  const box = (v) => (v ? '✅' : '⬜');
  return [
    `${box(state.ghAuth)} GitHub CLI authenticated`,
    `${box(state.hasKey)} encryption key on this Mac`,
    `${box(state.configPresent)} config.json (repo.owner/name)`,
    `${box(state.repoExists)} private brain repo${state.slug ? ` (${state.slug})` : ''}`,
    `${box(state.hasOrigin)} git origin wired`,
  ].join('\n   ');
}

// Ask twice (hidden) and write the recovery file. false = skipped / no tty.
// Never fatal: the brain works without it, and `brain key backup` adds it later.
export async function offerRecoveryPassphrase({ deps, recipient }) {
  const identity = await deps.getIdentity();
  if (!identity) return false;
  for (let i = 0; i < 3; i++) {
    const p = await deps.promptHidden('      Recovery passphrase (not shown, Enter to skip): ');
    if (p === null || p === '') return false;
    const weak = await deps.passphraseProblem(p);
    if (weak) { deps.log(`      ${weak}`); continue; }
    if ((await deps.promptHidden('      Type it again: ')) !== p) { deps.log('      The two entries did not match.'); continue; }
    try {
      await deps.writeRecovery(identity, p, recipient || '');
      return true;
    } catch (e) {
      deps.log(`      Couldn't write the recovery file: ${e.message}`);
      return false;
    }
  }
  return false;
}

// ── main flow ─────────────────────────────────────────────────────────────
/**
 * Run `brain init`.
 *
 * @param {object} opts   { repo, owner, yes, noAutomation }
 * @param {object} depsOverride  partial deps (see defaultDeps) — tests inject here
 * @returns {Promise<{ok, slug, recipient, repoUrl, steps, warnings, exitCode}>}
 * @throws {InitError} for every specified failure mode; `.resumable` says
 *         whether re-running picks up (R) or everything was rolled back (X).
 */
export async function runInit(opts = {}, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const log = deps.log;
  const warnings = [];
  const steps = [];
  const done = (n, label, note) => { steps.push({ n, label, note }); log(`   ${label}${note ? ` — ${note}` : ''}`); };

  log('🧠 brain init — setting up a fresh brain on this Mac\n');

  // ── step 1: preflight ───────────────────────────────────────────────────
  const major = deps.nodeMajor();
  if (major < MIN_NODE_MAJOR) {
    throw new InitError(
      `Node ${MIN_NODE_MAJOR}+ required (found ${process.versions.node}) — the brain uses node:sqlite.\n` +
        `  brew install node   # or: nvm install 22`,
      { code: 'NODE_TOO_OLD', resumable: false, step: 1, exitCode: 2 }
    );
  }
  const missing = ['git', 'age', 'age-keygen', 'gh', 'tar'].filter((b) => !deps.which(b));
  if (missing.length) {
    throw new InitError(
      `Missing required tool(s): ${missing.join(', ')}.\n  Install:  brew install ${missing.join(' ')}\n  Then re-run: brain init`,
      { code: 'MISSING_DEPS', resumable: true, step: 1, exitCode: 2 }
    );
  }
  const auth = deps.gh(['auth', 'status']);
  if (!auth.ok) {
    throw new InitError(
      `GitHub CLI is not logged in.\n  Run:  gh auth login\n  Then re-run: brain init`,
      { code: 'NO_GH_AUTH', resumable: true, step: 1, exitCode: 2 }
    );
  }
  // Scope check is advisory: fine-grained tokens carry no X-OAuth-Scopes header,
  // and a missing header must not block a token that would actually work. A
  // present-but-insufficient header is a definite answer, so we act on it.
  const scopeProbe = deps.gh(['api', 'user', '-i', '-q', '.login']);
  const scopeLine = /x-oauth-scopes:\s*([^\r\n]*)/i.exec(`${scopeProbe.out}\n${scopeProbe.err}`);
  if (scopeLine && scopeLine[1].trim() && !/\brepo\b/.test(scopeLine[1])) {
    throw new InitError(
      `Your GitHub token can't create private repos (missing the 'repo' scope).\n` +
        `  Run:  gh auth refresh -h github.com -s repo\n  Then re-run: brain init`,
      { code: 'NO_REPO_SCOPE', resumable: true, step: 1, exitCode: 2 }
    );
  }
  done(1, 'preflight ok', `node ${process.versions.node}, gh authenticated`);

  // Guardrail §4.8 — refuse to run inside somebody else's worktree.
  const top = deps.git(['rev-parse', '--show-toplevel']);
  if (top.ok && top.out && top.out !== REPO_ROOT) {
    throw new InitError(
      `${REPO_ROOT} sits inside another git repository (${top.out}).\n` +
        `  Move the engine to its own directory (e.g. ~/agentic-brain) and re-run: brain init`,
      { code: 'NESTED_WORKTREE', resumable: true, step: 1, exitCode: 2 }
    );
  }

  // ── step 2: identity ────────────────────────────────────────────────────
  const fromConfig = readRepoSlugFromConfig(deps);
  let owner = opts.owner || fromConfig?.owner;
  if (!owner) {
    const who = deps.gh(['api', 'user', '-q', '.login']);
    if (!who.ok || !who.out) {
      throw new InitError(
        `Couldn't read your GitHub login (${who.err.split('\n')[0] || 'gh api user failed'}).\n  Run:  gh auth login\n  Then re-run: brain init`,
        { code: 'NO_GH_AUTH', resumable: true, step: 2, exitCode: 2 }
      );
    }
    owner = who.out.trim();
  }
  let name = opts.repo || fromConfig?.name;
  if (!name) {
    const answer = opts.yes ? '' : await deps.prompt(`Repo name for your private brain [${DEFAULT_REPO_NAME}]: `);
    if (answer === null && !opts.yes) {
      throw new InitError(
        `No terminal available to ask for a repo name.\n  Re-run with:  brain init --repo <name> --yes`,
        { code: 'NO_TTY', resumable: true, step: 2, exitCode: 2 }
      );
    }
    name = (answer || '').trim() || DEFAULT_REPO_NAME;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new InitError(`"${name}" is not a valid GitHub repo name (letters, digits, . _ - only).`, {
      code: 'BAD_REPO_NAME', resumable: true, step: 2, exitCode: 2,
    });
  }
  const slug = `${owner}/${name}`;
  done(2, 'identity', slug);

  // ── step 0 (printed after identity so the slug is known): probe ─────────
  const keyPresent = await deps.hasKey();
  const repo = ghRepoInfo(slug, deps);
  const originUrl = (() => { const r = deps.git(['remote', 'get-url', 'origin']); return r.ok ? r.out : ''; })();
  const state = {
    ghAuth: true,
    hasKey: keyPresent,
    configPresent: deps.exists(CONFIG_PATH),
    repoExists: repo.exists,
    hasOrigin: !!originUrl,
    slug,
  };
  log('\n   state:\n   ' + renderChecklist(state) + '\n');

  // ── step 3: KEY FIRST ───────────────────────────────────────────────────
  let recipient = null;
  let keyCreatedThisRun = false;
  if (keyPresent) {
    recipient = await deps.getRecipient();
    done(3, '🔐 key already present', `${recipient || 'age1…'} — keeping it`);
  } else {
    // Gate BEFORE generation. See assertKeyGenerationSafe.
    assertKeyGenerationSafe({ slug, repoExists: repo.exists, deps });
    try {
      recipient = await deps.generateAndStoreKey(); // no {force} — ever
      keyCreatedThisRun = true;
    } catch (e) {
      throw new InitError(
        `Couldn't create your encryption key: ${e.message}\n  Nothing was created — no repo, no key.`,
        { code: 'KEYGEN_FAILED', resumable: false, step: 3, exitCode: 2 }
      );
    }
    // Round-trip verification (failure mode 5): a Keychain that silently
    // refuses the write must not look like success.
    const readBack = await deps.getIdentity();
    if (!readBack) {
      await deps.deleteKeyPair(); // only ever removes what this run just made
      throw new InitError(
        `Couldn't save your encryption key to the macOS Keychain.\n` +
          `  Unlock the login keychain (or run from a logged-in GUI session) and re-run.\n` +
          `  Nothing was created — no repo, no key.`,
        { code: 'KEYCHAIN_DENIED', resumable: false, step: 3, exitCode: 2 }
      );
    }
    done(3, '🔐 key created', recipient);
  }

  // ── step 4: config.json ─────────────────────────────────────────────────
  let configCreatedThisRun = false;
  try {
    let cfg;
    if (deps.exists(CONFIG_PATH)) {
      cfg = JSON.parse(deps.readFile(CONFIG_PATH));
    } else {
      if (!deps.exists(CONFIG_EXAMPLE_PATH)) {
        throw new Error(`config.example.json is missing from ${REPO_ROOT} — re-clone the engine.`);
      }
      cfg = JSON.parse(deps.readFile(CONFIG_EXAMPLE_PATH));
      configCreatedThisRun = true;
    }
    cfg.repo = { ...(cfg.repo || {}), owner, name, private: true }; // §4.2: never public
    if (fromConfig && cfg.repo.private === false) warnings.push('config.repo.private was false — forced to true.');
    deps.writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    done(4, configCreatedThisRun ? 'config.json created' : 'config.json updated', `repo → ${slug}`);
  } catch (e) {
    if (configCreatedThisRun) deps.removeFile(CONFIG_PATH); // rollback (§3 policy)
    if (e instanceof InitError) throw e;
    throw new InitError(`Couldn't write config.json: ${e.message}`, {
      code: 'CONFIG_WRITE_FAILED', resumable: true, step: 4,
    });
  }

  // ── step 5: repo ────────────────────────────────────────────────────────
  let repoUrl = repo.url;
  if (repo.exists) {
    if (repo.private === false) {
      throw new InitError(
        `${slug} is public. Your brain must live in a private repo.\n` +
          `  Fix:  gh repo edit ${slug} --visibility private\n  Or:   brain init --repo <another-name>`,
        { code: 'REPO_PUBLIC', resumable: true, step: 5, exitCode: 2 }
      );
    }
    // Re-running init on a machine that already holds this brain's key and a
    // config naming this very repo is a resume, not a name clash: the "not
    // empty" guard exists to protect SOMEONE ELSE's repo, not the user's own.
    const ownBrain = keyPresent && !!fromConfig && `${fromConfig.owner}/${fromConfig.name}` === slug;
    if (repo.empty === false && !opts.yes && !ownBrain) {
      const answer = await deps.prompt(
        `⚠️  ${slug} already exists and is not empty.\n` +
          `   Use it anyway (its history will gain your brain commits)? [y/N] `
      );
      if (answer === null || !/^y(es)?$/i.test((answer || '').trim())) {
        throw new InitError(
          `Stopped: ${slug} already exists and is not empty.\n  Pick another name:  brain init --repo <name>`,
          { code: 'REPO_NAME_TAKEN', resumable: true, step: 5, exitCode: 2 }
        );
      }
    }
    done(5, 'repo adopted', `${slug}${repo.empty ? ' (empty)' : ''}`);
  } else {
    // No --source: the working tree is wired up by step 6, and --source would
    // also push. Creation stays a pure, empty, private repo.
    const r = deps.gh(['repo', 'create', slug, '--private']);
    if (!r.ok) {
      const text = `${r.err}\n${r.out}`;
      if (/403|resource not accessible|must have admin rights|scope/i.test(text)) {
        throw new InitError(
          `Your GitHub token can't create private repos (missing the 'repo' scope).\n` +
            `  Run:  gh auth refresh -h github.com -s repo\n  Then re-run: brain init`,
          { code: 'NO_REPO_SCOPE', resumable: true, step: 5, exitCode: 2 }
        );
      }
      if (looksLikeNetworkFailure(text)) {
        throw new InitError(
          `Lost network at step 5 (create repo). Nothing is corrupted — re-run 'brain init' when you're back online; it resumes from here.`,
          { code: 'NETWORK', resumable: true, step: 5 }
        );
      }
      throw new InitError(`Couldn't create ${slug}: ${text.split('\n')[0]}`, {
        code: 'REPO_CREATE_FAILED', resumable: true, step: 5,
      });
    }
    repoUrl = `https://github.com/${slug}`;
    done(5, 'private repo created', repoUrl);
  }

  // ── step 6: remote ──────────────────────────────────────────────────────
  const wantUrl = `https://github.com/${slug}.git`;
  // Same repo = same owner/name, however the URL is spelled: https, ssh
  // (git@github.com:o/n), or rewritten by the user's url.<x>.insteadOf rules —
  // `git remote get-url` returns the rewritten form.
  const repoOf = (u) => String(u).replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).slice(-2).join('/').toLowerCase();
  const sameRemote = (a, b) => repoOf(a) === repoOf(b);
  if (!originUrl) {
    const r = deps.git(['remote', 'add', 'origin', wantUrl]);
    if (!r.ok) throw new InitError(`Couldn't add git remote: ${r.err.split('\n')[0]}`, { code: 'REMOTE_FAILED', step: 6 });
    done(6, 'origin wired', wantUrl);
  } else if (sameRemote(originUrl, wantUrl)) {
    done(6, 'origin already correct', originUrl);
  } else {
    let ok = opts.yes;
    if (!ok) {
      const answer = await deps.prompt(
        `⚠️  git origin currently points at ${originUrl}\n   Repoint it at ${wantUrl}? [y/N] `
      );
      ok = answer !== null && /^y(es)?$/i.test((answer || '').trim());
    }
    if (!ok) {
      throw new InitError(
        `origin points at ${originUrl}, not ${wantUrl}.\n` +
          `  Repoint it yourself:  git remote set-url origin ${wantUrl}\n  Then re-run: brain init`,
        { code: 'REMOTE_MISMATCH', resumable: true, step: 6, exitCode: 2 }
      );
    }
    const r = deps.git(['remote', 'set-url', 'origin', wantUrl]);
    if (!r.ok) throw new InitError(`Couldn't repoint origin: ${r.err.split('\n')[0]}`, { code: 'REMOTE_FAILED', step: 6 });
    done(6, 'origin repointed', wantUrl);
  }

  // ── step 6b: recovery passphrase (optional) ─────────────────────────────
  // Offered, never forced. Written before the first sync so that sync commits
  // and pushes it: a new Mac then needs only the repo + the passphrase.
  let recoverySet = await deps.hasRecovery();
  if (!recoverySet && !opts.yes) {
    const answer = await deps.prompt(
      `\n   🔑 Protect your key with a recovery passphrase? A new Mac can then unlock your\n` +
        `      brain with just the passphrase (the key is stored encrypted in your brain repo). [Y/n] `
    );
    if (answer !== null && !/^n(o)?$/i.test(answer.trim())) {
      recoverySet = await offerRecoveryPassphrase({ deps, recipient });
      if (recoverySet) done('6b', '🔑 recovery passphrase set', 'memory/key-recovery.age (encrypted)');
    }
  }
  if (!recoverySet) warnings.push('No recovery passphrase yet — lose this Mac and you need the raw key. Add one:  brain key backup');

  // ── step 7: first sync ──────────────────────────────────────────────────
  // Resume-only from here on: init never deletes a repo, a release, or a key.
  let synced = false;
  const sync = deps.sync();
  if (sync.ok) {
    synced = true;
    done(7, 'first sync complete', 'release brain-latest holds your encrypted brain');
  } else {
    const detail = (sync.err || '').split('\n').filter(Boolean).pop() || `exit ${sync.code}`;
    warnings.push(
      `Repo and key are set up; the first sync failed: ${detail}\n     Re-run:  brain sync`
    );
    log(`   ⚠️  first sync failed — ${detail}`);
  }

  // ── step 8: automation / wiring ─────────────────────────────────────────
  const skipAutomation = opts.noAutomation || process.env.BRAIN_NO_AUTOMATION === '1';
  if (skipAutomation) {
    done(8, 'wiring skipped', 'BRAIN_NO_AUTOMATION=1 / --no-automation');
  } else {
    const ob = deps.onboard();
    if (ob.ok) done(8, 'machine wired', 'brain onboard');
    else {
      warnings.push(`Wiring (brain onboard) failed — re-run:  brain onboard`);
      log('   ⚠️  brain onboard failed — re-run it manually');
    }
  }

  // ── step 9: report ──────────────────────────────────────────────────────
  log('\n✅ Your brain is live.');
  log(`   repo:      ${repoUrl || `https://github.com/${slug}`}  (private)`);
  log(`   recipient: ${recipient || '(age1…)'}`);
  log('   panel:     http://127.0.0.1:37800');
  if (!synced) log('   sync:      ⚠️  not yet — run: brain sync');
  log('');
  // install.sh back-fills right after this and reports what it found, so don't
  // tell a user with history that their brain is empty.
  log('   🧠 Next: reading the past sessions already on this computer, so your memory');
  log('      starts with your history. From then on it fills itself as you work.');
  log('');
  if (recoverySet) {
    log('   🔑 Recovery passphrase set: a new Mac can unlock this brain with it');
    log('      (brain restore asks for it). Keep the passphrase somewhere safe too.');
  }
  log('   ⚠️  BACK UP YOUR KEY. It is the only thing that can read your brain.');
  log('      Show it:  brain key show          (prints the public recipient)');
  log('      The private key lives in your Keychain (service "claude-brain",');
  log('      account "age-identity"). Copy it into your password manager now —');
  log('      lose it and every encrypted backup becomes unreadable forever.');
  for (const w of warnings) log(`   ⚠️  ${w}`);

  return {
    ok: synced,
    slug,
    owner,
    name,
    recipient,
    repoUrl: repoUrl || `https://github.com/${slug}`,
    keyCreatedThisRun,
    configCreatedThisRun,
    recoverySet,
    synced,
    steps,
    warnings,
    exitCode: synced ? 0 : 1,
  };
}

export default runInit;
