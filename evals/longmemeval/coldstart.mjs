#!/usr/bin/env node
// Cold-start latency of hybrid search in a fresh MCP server (S10).
//
//   node evals/longmemeval/coldstart.mjs --real --models <model dir> [--backfill] [--n 6] [--delay ms] [--env '{"BRAIN_EMBED":"0"}'] [--server path/to/mcp-server.mjs]
//   node evals/longmemeval/coldstart.mjs --home <private fake HOME> --models <model dir> ...
//
// Spawns N fresh `bin/mcp-server.mjs` processes at once against a COPY of a
// store (HOME/.claude-brain/brain.db + READY; vectors backfilled with
// `brain embed --apply` into that copy), and times initialize and the first
// three brain_recall calls of each, plus RSS after initialize and after the
// searches, and how many searches answered with BM25 because the model was
// still loading (the cold-start budget, embed.mjs). N > 1 is the "many apps
// start a server at login" case: the model loads compete for the CPU.
//
// The copy of the real store is the operator's whole memory, so it is only ever
// made by evals/lib/private-copy.mjs: --real snapshots ~/.claude-brain/brain.db
// (immutable read) into a 0700 directory and deletes it when this process ends,
// however it ends; --backfill then runs the embedding backfill INTO that copy.
// --home <dir> is for a store you already hold privately (or a synthetic one);
// it is refused when the copy is readable by group/other or is the real HOME.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { makePrivateCopy, exposedTo } from '../lib/private-copy.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? dflt : process.argv[i + 1]; };
const REAL = process.argv.includes('--real');
const BACKFILL = process.argv.includes('--backfill');
let HOME = arg('home');
const MODELS = arg('models');
const N = Number(arg('n', 1));
const EXTRA = JSON.parse(arg('env', '{}'));
const DELAY = Number(arg('delay', 0)); // ms between initialize and the first search (a user typing)
const SERVER = arg('server', fileURLToPath(new URL('../../bin/mcp-server.mjs', import.meta.url)));
if ((!HOME && !REAL) || !MODELS) { console.error('usage: coldstart.mjs (--real | --home <private copy HOME>) --models <model dir> [--backfill] [--n N] [--delay ms] [--env JSON] [--server path]'); process.exit(2); }
if (REAL && HOME) { console.error('refusing: --real and --home are exclusive'); process.exit(2); }
if (REAL) {
  HOME = makePrivateCopy({ label: 'coldstart', home: true }).home; // removed on exit / signal by the helper
  console.error(`private copy of the real store: ${HOME} (0700, deleted when this run ends)`);
} else {
  if (resolve(HOME) === resolve(userInfo().homedir)) { console.error('refusing: --home must be a copy, not your real HOME'); process.exit(2); }
  const db = join(HOME, '.claude-brain', 'brain.db');
  const open = existsSync(db) ? exposedTo(db, resolve(HOME)) : [];
  if (open.length) { console.error(`refusing: the copy is readable by others (${open.join(', ')}). Use --real, or chmod 700 the directories and 600 the file, and delete it afterwards.`); process.exit(2); }
}
if (BACKFILL) {
  execFileSync(process.execPath, ['--input-type=module', '-e',
    `await (await import(${JSON.stringify(new URL('../../bin/lib/embed.mjs', import.meta.url).href)})).runEmbed({ dbPath: ${JSON.stringify(join(HOME, '.claude-brain', 'brain.db'))}, apply: true })`],
    { stdio: 'inherit', env: { ...process.env, HOME, BRAIN_MODEL_DIR: MODELS, BRAIN_TEST: '1' } });
}

const QUERIES = [
  'how does the brain publish memory to github',
  'cold start latency of the mcp server',
  'keychain recovery passphrase',
];

const rssMb = (pid) => {
  try { return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024); } catch { return null; }
};

function start() {
  const t0 = performance.now();
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // BRAIN_DEBUG: embed.mjs then logs each search that fell back to BM25
    env: { ...process.env, HOME, BRAIN_MODEL_DIR: MODELS, BRAIN_NO_ECONOMICS: '1', BRAIN_DEBUG: '1', ...EXTRA },
  });
  let buf = '', id = 0, err = '';
  const pending = new Map();
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      pending.get(m.id)?.(m); pending.delete(m.id);
    }
  });
  const req = (method, params) => new Promise((r) => {
    const k = ++id; pending.set(k, r);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n');
  });
  return { child, t0, req, stderr: () => err };
}

async function one(i) {
  const s = start();
  const out = { i };
  await s.req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'coldstart', version: '1' } });
  out.initMs = Math.round(performance.now() - s.t0);
  if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
  out.rssAfterInit = rssMb(s.child.pid);
  for (const [k, q] of QUERIES.entries()) {
    const t = performance.now();
    const r = await s.req('tools/call', { name: 'brain_recall', arguments: { query: q } });
    out[`recall${k + 1}Ms`] = Math.round(performance.now() - t);
    if (r.result?.isError) out[`recall${k + 1}Err`] = r.result.content[0].text;
  }
  out.rssAfterSearch = rssMb(s.child.pid);
  out.bm25Fallbacks = (s.stderr().match(/BM25 for this query/g) || []).length;
  s.child.stdin.end();
  return out;
}

const runs = await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
const stat = (k) => {
  const v = runs.map((r) => r[k]).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return v.length ? (v.length === 1 ? `${v[0]}` : `min ${v[0]} / median ${v[Math.floor(v.length / 2)]} / max ${v[v.length - 1]}`) : '-';
};
console.log(`servers=${N} env=${JSON.stringify(EXTRA)}${DELAY ? ` delay=${DELAY}ms` : ''}`);
for (const k of ['initMs', 'recall1Ms', 'recall2Ms', 'recall3Ms', 'rssAfterInit', 'rssAfterSearch', 'bm25Fallbacks']) console.log(`  ${k.padEnd(15)} ${stat(k)}`);
const errs = runs.flatMap((r) => Object.entries(r).filter(([k]) => k.endsWith('Err')).map(([, v]) => v));
if (errs.length) console.log(`  errors: ${errs.length} — ${errs[0]}`);
