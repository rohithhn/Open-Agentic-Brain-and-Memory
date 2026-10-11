// Git plumbing for the brain repo. Uses the system git (+ git-lfs) and the gh
// CLI for creating the private remote.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { REPO_ROOT, config } from './paths.mjs';

export const BLOB_RELEASE = 'brain-latest';       // the single release that always holds the latest blob
export const BLOB_ASSET = 'brain.age';            // asset name inside the release

function repoSlug() {
  return `${config.repo.owner}/${config.repo.name}`;
}

export function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

export function isRepo() {
  return existsSync(join(REPO_ROOT, '.git'));
}

export function ensureRepo({ log = () => {} } = {}) {
  if (!isRepo()) {
    git(['init', '-b', 'main']);
    log('  git repo initialized');
  }
  try {
    git(['lfs', 'install', '--local']);
  } catch {
    /* lfs optional */
  }
}

// The branch `restore` / `install.sh` read. The cloud brain lives here.
export const BRAIN_BRANCH = 'main';

export function currentBranch() {
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch {
    return BRAIN_BRANCH;
  }
}

export function hasRemote() {
  try {
    git(['remote', 'get-url', 'origin']);
    return true;
  } catch {
    return false;
  }
}

export function remoteUrl() {
  try {
    return git(['remote', 'get-url', 'origin']).trim();
  } catch {
    return '';
  }
}

// `gh repo view` says exactly this when (and only when) the repo definitely does not exist.
// Anything else — DNS/TLS/timeouts, 401/403, rate limits, 5xx, a missing gh — is "unknown",
// and creating a repo on "unknown" is how a flaky network produces a duplicate or a confusing
// "name already exists" failure. Only this pattern may lead to `gh repo create`.
const REPO_NOT_FOUND_RE = /could not resolve to a repository|\bhttp 404\b|repository not found/i;

export function isRepoNotFound(text) {
  return REPO_NOT_FOUND_RE.test(String(text || ''));
}

export class RemoteLookupError extends Error {
  constructor(message, { code = 'REMOTE_LOOKUP_FAILED', retryable = true, detail = '' } = {}) {
    super(message);
    this.name = 'RemoteLookupError';
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

function runGh(args, opts = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return { ok: r.status === 0 && !r.error, out: r.stdout || '', err: r.stderr || '', error: r.error, status: r.status };
}

// Create (or connect) the private GitHub repo via gh, then wire origin.
// Creates ONLY on a definite "repo not found" from `gh repo view`; on any other failure it throws
// a RemoteLookupError (retryable) and leaves GitHub and the local remotes untouched.
// `gh` / `addRemote` / `hasOrigin` are injectable for tests: gh(args, opts) -> {ok, out, err, error, status}.
export function ensureRemote({ log = () => {}, gh = runGh, addRemote, hasOrigin = hasRemote } = {}) {
  if (hasOrigin()) return remoteUrl();
  const { owner, name, private: priv } = config.repo;
  const slug = `${owner}/${name}`;
  const view = gh(['repo', 'view', slug, '--json', 'url', '-q', '.url']);
  if (view.ok) {
    log(`  repo ${slug} already exists — connecting`);
    (addRemote || ((u) => git(['remote', 'add', 'origin', u])))(`https://github.com/${slug}.git`);
    return view.out.trim() || `https://github.com/${slug}`;
  }
  const text = `${view.err}\n${view.out}`.trim();
  if (view.error && view.error.code === 'ENOENT') {
    throw new RemoteLookupError(
      `The GitHub CLI (gh) is not installed, so I can't check whether ${slug} exists. Install gh and run 'brain sync' again — nothing was created.`,
      { code: 'GH_MISSING', retryable: false, detail: String(view.error.message) }
    );
  }
  if (!isRepoNotFound(text)) {
    throw new RemoteLookupError(
      `Could not check whether ${slug} exists on GitHub (${text.split('\n')[0].slice(0, 160) || 'no output from gh'}). ` +
        `This looks like a network or auth problem, not a missing repo, so I did NOT create anything. ` +
        `Check 'gh auth status' and your connection, then run 'brain sync' again — it is safe to retry.`,
      { detail: text }
    );
  }
  log(`  creating private repo ${slug}…`);
  const created = gh(
    ['repo', 'create', slug, priv ? '--private' : '--public', '--source', REPO_ROOT, '--remote', 'origin'],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
  if (!created.ok) {
    throw new RemoteLookupError(`'gh repo create ${slug}' failed${created.status != null ? ` (exit ${created.status})` : ''}. Re-run 'brain sync' to retry.`, {
      code: 'REMOTE_CREATE_FAILED',
    });
  }
  return `https://github.com/${slug}.git`;
}

export function hasChanges() {
  return git(['status', '--porcelain']).trim().length > 0;
}

// User data this tool writes into the brain repo and must sync. A public user's
// brain repo starts life as a clone of the engine, whose .gitignore (written for
// contributors) ignores memory/, settings/ and *.age — so `add -A` alone would
// silently never commit the recovery file or the redacted settings. Force-add
// them; once tracked, later `add -A` runs stage their changes normally.
export const USER_DATA_PATHS = ['settings', 'memory/key-recovery.age', 'MANIFEST.json', 'skills-external/MANIFEST.json'];

export function commitAll(message) {
  git(['add', '-A']);
  const present = USER_DATA_PATHS.filter((p) => existsSync(join(REPO_ROOT, p)));
  if (present.length) git(['add', '-f', '--', ...present]);
  if (!hasChanges() && !git(['status', '--porcelain']).trim()) {
    // nothing staged
  }
  try {
    git(['commit', '-m', message], { inherit: true });
    return true;
  } catch {
    return false; // nothing to commit
  }
}

export function pull({ log = () => {} } = {}) {
  if (!hasRemote()) return;
  const branch = currentBranch();
  try {
    git(['pull', '--rebase', '--autostash', 'origin', branch], { inherit: true });
  } catch (e) {
    log('  pull failed (first push?) — continuing');
  }
}

export function push({ log = () => {} } = {}) {
  if (!hasRemote()) {
    log('  no remote configured — skipping push');
    return false;
  }
  const branch = currentBranch();
  // Push the branch we actually committed to. Pushing a hardcoded `main` from a
  // feature branch is a silent no-op: the commit lands locally, the cloud never moves.
  git(['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], { inherit: true });
  if (branch !== BRAIN_BRANCH) {
    log(`  ⚠️  pushed to '${branch}', but restore reads '${BRAIN_BRANCH}'.`);
    log(`     The cloud brain is NOT updated until you merge into ${BRAIN_BRANCH}.`);
  }
  return true;
}

// Does the cloud already hold a blob? 'present' | 'absent' | 'unknown'.
// 'unknown' (network/auth) must be treated as unsafe by callers that are about
// to overwrite the cloud copy: uploading without merging would drop whatever
// another device pushed.
export function blobReleaseState() {
  if (!hasRemote()) return 'absent';
  try {
    execFileSync('gh', ['release', 'view', BLOB_RELEASE, '-R', repoSlug()], { stdio: ['ignore', 'pipe', 'pipe'] });
    return 'present';
  } catch (e) {
    const text = `${e.stderr || ''}\n${e.stdout || ''}\n${e.message || ''}`;
    if (/release not found|no releases found|could not resolve to a repository|repository not found/i.test(text)) return 'absent';
    return 'unknown';
  }
}

// Upload the encrypted blob to the brain-latest release, replacing the prior asset.
// Idempotent: creates the release once, then --clobber on every subsequent upload.
export function uploadBlob(blobPath, { log = () => {} } = {}) {
  if (!hasRemote()) { log('  no remote — skipping blob upload'); return false; }
  if (!existsSync(blobPath)) { log(`  no blob at ${blobPath} — skipping upload`); return false; }
  const slug = repoSlug();
  try {
    execFileSync('gh', ['release', 'view', BLOB_RELEASE, '-R', slug], { stdio: 'ignore' });
  } catch {
    execFileSync('gh', ['release', 'create', BLOB_RELEASE, '-R', slug,
      '--title', 'Brain (latest encrypted blob)',
      '--notes', 'Encrypted brain payload. Replaced on every `brain sync`. Do not delete.'],
      { stdio: 'inherit' });
    log(`  created release ${BLOB_RELEASE}`);
  }
  execFileSync('gh', ['release', 'upload', BLOB_RELEASE, blobPath, '--clobber', '-R', slug],
    { stdio: 'inherit' });
  log(`  ⬆️  uploaded ${BLOB_ASSET} to release ${BLOB_RELEASE}`);
  return true;
}

// Download the latest blob from the release to destPath (overwriting). Tolerant:
// returns false and leaves any existing local file if the release/asset is missing.
export function downloadBlob(destPath, { log = () => {} } = {}) {
  if (!hasRemote()) return false;
  const slug = repoSlug();
  try {
    mkdirSync(dirname(destPath), { recursive: true });
    execFileSync('gh', ['release', 'download', BLOB_RELEASE, '-R', slug,
      '-p', BLOB_ASSET, '-O', destPath, '--clobber'], { stdio: 'inherit' });
    log(`  ⬇️  downloaded ${BLOB_ASSET} from release ${BLOB_RELEASE}`);
    return true;
  } catch (e) {
    log(`  ⚠️  could not download blob from release (${(e.message||'').split('\n')[0]})`);
    return false;
  }
}
