#!/usr/bin/env node
// Tests for ensureRemote (bin/lib/git.mjs): `gh repo create` runs ONLY on a definite
// "repo not found" — never on a network/auth/rate-limit/5xx/missing-gh failure.
//
//   node evals/git-remote-test.mjs
//
// gh is a stub function; no network, no real gh, no git writes. The end-to-end story with the
// sandbox gh shim (SB_GH_OFFLINE) lives in evals/sandbox/sandbox-test.sh §6a.
import './test-env.mjs'; // BRAIN_TEST=1
import { ensureRemote, isRepoNotFound, RemoteLookupError } from '../bin/lib/git.mjs';

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// A stub gh: `view` is the result of `gh repo view`; records every call.
function world(view, create = { ok: true, status: 0 }) {
  const w = { calls: [], remotes: [] };
  w.gh = (args) => {
    w.calls.push(args.slice(0, 2).join(' '));
    if (args[1] === 'view') return { out: '', err: '', ...view };
    if (args[1] === 'create') return { out: '', err: '', ...create };
    throw new Error('unexpected gh ' + args.join(' '));
  };
  w.opts = { gh: w.gh, addRemote: (u) => w.remotes.push(u), hasOrigin: () => false };
  return w;
}
const created = (w) => w.calls.includes('repo create');

function failure(err) { return { ok: false, status: 1, err }; }

await t('isRepoNotFound matches the definite not-found messages only', () => {
  assert(isRepoNotFound("GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)"), 'graphql not found');
  assert(isRepoNotFound('HTTP 404: Not Found (https://api.github.com/repos/o/r)'), 'http 404');
  for (const bad of [
    'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host',
    'Post "https://api.github.com/graphql": net/http: TLS handshake timeout',
    'HTTP 401: Bad credentials',
    'HTTP 403: API rate limit exceeded',
    'HTTP 502: Bad Gateway',
    'To get started with GitHub CLI, please run:  gh auth login',
    'could not resolve host: github.com',
    '',
  ]) assert(!isRepoNotFound(bad), 'must not match: ' + bad);
});

await t('definite not-found -> creates the repo', () => {
  const w = world(failure("GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)"));
  const url = ensureRemote(w.opts);
  assert(created(w), 'did not create');
  assert(/^https:\/\/github\.com\/.+\.git$/.test(url), 'url ' + url);
});

await t('HTTP 404 -> creates the repo', () => {
  const w = world(failure('HTTP 404: Not Found (https://api.github.com/repos/o/r)'));
  ensureRemote(w.opts);
  assert(created(w), 'did not create');
});

for (const [label, msg] of [
  ['offline / DNS', 'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host'],
  ['TLS timeout', 'Post "https://api.github.com/graphql": net/http: TLS handshake timeout'],
  ['bad credentials (401)', 'HTTP 401: Bad credentials'],
  ['not logged in', 'To get started with GitHub CLI, please run:  gh auth login'],
  ['rate limited (403)', 'HTTP 403: API rate limit exceeded'],
  ['server error (502)', 'HTTP 502: Bad Gateway'],
  ['empty output', ''],
]) {
  await t(`${label} -> throws a retryable error and never creates`, () => {
    const w = world(failure(msg));
    let err;
    try { ensureRemote(w.opts); } catch (e) { err = e; }
    assert(err instanceof RemoteLookupError, 'did not throw RemoteLookupError: ' + (err && err.message));
    assert(err.retryable === true && err.code === 'REMOTE_LOOKUP_FAILED', `code/retryable: ${err.code}/${err.retryable}`);
    assert(/did NOT create anything/.test(err.message) && /retry/.test(err.message), 'message not clear: ' + err.message);
    assert(!created(w), 'gh repo create ran');
    assert(w.remotes.length === 0, 'origin was wired');
  });
}

await t('gh not installed -> clear non-retryable error, never creates', () => {
  const w = world({ ok: false, error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) });
  let err;
  try { ensureRemote(w.opts); } catch (e) { err = e; }
  assert(err instanceof RemoteLookupError && err.code === 'GH_MISSING' && err.retryable === false, 'wrong error: ' + (err && err.code));
  assert(!created(w), 'created');
});

await t('repo exists -> connects, wires origin, does not create', () => {
  const w = world({ ok: true, out: 'https://github.com/o/r\n' });
  const url = ensureRemote(w.opts);
  assert(url === 'https://github.com/o/r', 'url ' + url);
  assert(w.remotes.length === 1 && !created(w), 'remotes/created');
});

await t('repo exists but the lookup is a single call (no second lookup that could fall through to create)', () => {
  const w = world({ ok: true, out: 'https://github.com/o/r\n' });
  ensureRemote(w.opts);
  assert(w.calls.filter((c) => c === 'repo view').length === 1, 'calls: ' + w.calls);
});

await t('create failure -> throws, does not claim success', () => {
  const w = world(failure("Could not resolve to a Repository"), { ok: false, status: 1 });
  let err;
  try { ensureRemote(w.opts); } catch (e) { err = e; }
  assert(err && err.code === 'REMOTE_CREATE_FAILED', 'wrong: ' + (err && err.code));
});

await t('origin already wired -> no gh calls at all', () => {
  const w = world(failure('whatever'));
  ensureRemote({ ...w.opts, hasOrigin: () => true });
  assert(w.calls.length === 0, 'gh called: ' + w.calls);
});

for (const [s, n, m] of results) console.log(`${s}  ${n}${m ? '\n      ' + m : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
