#!/usr/bin/env node
// Tests for Kilo Code wiring: the JSONC text editor (bin/lib/jsonc-edit.mjs), the
// `mcp`-map writer wireKiloJson() (bin/lib/wire.mjs), the three registry rows
// (bin/lib/wire-targets.mjs), path helpers (bin/lib/kilo.mjs), the push block
// (inject.mjs) and the doctor rows. BETA: the shapes come from Kilo's open-source
// code (see bin/lib/kilo.mjs), not from a live install.
//
//   node evals/kilo-wiring-test.mjs
//
// SAFETY: pure-function tests use files under the scratchpad; everything that
// resolves $HOME runs in a child with HOME=<fake>. No real tool config, brain
// store, Kilo/VS Code/Cursor directory is read or written.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../bin/lib/store.mjs';
import { wireKiloJson, wireTargetConfig } from '../bin/lib/wire.mjs';
import { parseJsonc, valueOf, getMember, insertMember } from '../bin/lib/jsonc-edit.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `kilo-wiring-test-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

const DEF = { command: '/opt/node/bin/node', args: ['/home/u/.agentic-brain/server.cjs'] };
const NAME = { name: 'agentic-brain' };
let n = 0;
const file = (text, ext = 'jsonc') => { const f = join(ROOT, `c${++n}`, `kilo.${ext}`); mkdirSync(dirname(f), { recursive: true }); if (text !== null) writeFileSync(f, text); return f; };
const read = (f) => readFileSync(f, 'utf8');
const ours = (text) => valueOf(getMember(getMember(parseJsonc(text).root, 'mcp').value, 'agentic-brain').value);
const baks = (f) => readdirSync(dirname(f)).filter((x) => x.includes('.bak-'));

// ── jsonc-edit ───────────────────────────────────────────────────────────────
await t('jsonc: comments, trailing commas, escapes and nesting parse; garbage is rejected with an offset', () => {
  const ok = parseJsonc('// c\n{ /* x */ "a": [1, 2,], "b": { "c": "q\\"uote\\n" },\n}\n');
  assert(ok.ok, 'valid JSONC parses');
  eq(JSON.stringify(valueOf(ok.root)), JSON.stringify({ a: [1, 2], b: { c: 'q"uote\n' } }), 'value');
  for (const bad of ['{', '{"a":}', '{"a" 1}', '[1] x', '{"a":"unterminated}', '/* open', '']) assert(!parseJsonc(bad).ok, `rejects ${JSON.stringify(bad)}`);
});
await t('jsonc: insertMember keeps every other byte (comments, ordering, odd spacing) — only the insertion differs', () => {
  const src = '{\n  // keep me\n  "a":   1, /* and me */\n  "mcp": {\n    "x": { "type": "remote", "url": "u" } // trailing note\n  }\n}\n';
  const p = parseJsonc(src);
  const out = insertMember(src, getMember(p.root, 'mcp').value, 'new', { k: 1 });
  assert(parseJsonc(out).ok, 'still valid');
  eq(out, '{\n  // keep me\n  "a":   1, /* and me */\n  "mcp": {\n    "x": { "type": "remote", "url": "u" }, // trailing note\n    "new": {\n      "k": 1\n    }\n  }\n}\n', 'exactly: a comma after the last member, our member after its trailing note, nothing else');
});

// ── wireKiloJson ─────────────────────────────────────────────────────────────
await t('wireKiloJson: creates kilo.jsonc with $schema + the entry when nothing exists (and its parent dir)', () => {
  const f = join(ROOT, 'fresh', 'deep', 'kilo.jsonc');
  const r = wireKiloJson(f, true, DEF, NAME);
  eq(r.ok, true, 'ok'); eq(r.status, 'wrote', 'status'); eq(r.action, 'create config', 'action'); eq(r.backup, null, 'nothing to back up');
  const v = JSON.parse(read(f));
  eq(v.$schema, 'https://app.kilo.ai/config.json', 'schema'); eq(JSON.stringify(v.mcp['agentic-brain'].command), JSON.stringify([DEF.command, DEF.args[0]]), 'command array');
  eq(v.mcp['agentic-brain'].type, 'local', 'local');
  assert(read(f).includes(`"command": ["${DEF.command}", "${DEF.args[0]}"]`), 'command stays on one line like Kilo\'s own docs');
});
await t('wireKiloJson: dry run reports and writes nothing', () => {
  const f = file('{ "theme": "dark" }');
  const r = wireKiloJson(f, false, DEF, NAME);
  eq(r.status, 'would-write', 'status'); eq(r.changed, false, 'changed'); eq(read(f), '{ "theme": "dark" }', 'bytes'); eq(baks(f).length, 0, 'no backup');
  const none = join(ROOT, 'never', 'kilo.jsonc');
  eq(wireKiloJson(none, false, DEF, NAME).action, 'would create config', 'would create'); assert(!existsSync(dirname(none)), 'dry run creates no directory');
});
await t('wireKiloJson: adds under an existing mcp map, keeping user servers, comments, trailing commas and the user\'s own trailing note byte-for-byte', () => {
  const src = '// my kilo config\n{\n  // theme\n  "theme": "dark", /* c */\n  "mcp": {\n    "figma": { "type": "remote", "url": "https://x" }, // keep\n  },\n}\n';
  const f = file(src);
  const r = wireKiloJson(f, true, DEF, NAME);
  eq(r.status, 'wrote', 'status'); eq(r.others.join(','), 'figma', 'others');
  const out = read(f);
  assert(out.startsWith('// my kilo config\n{\n  // theme\n  "theme": "dark", /* c */\n  "mcp": {\n    "figma": { "type": "remote", "url": "https://x" }, // keep\n'), 'everything before our member is untouched');
  assert(out.endsWith('  },\n}\n'), 'closing braces + trailing comma untouched');
  eq(ours(out).type, 'local', 'our entry parses');
  eq(baks(f).length, 1, 'one timestamped backup'); eq(read(join(dirname(f), baks(f)[0])), src, 'backup is the original');
});
await t('wireKiloJson: adds an mcp map to a config that has none (plain JSON, tabs, CRLF each keep their style)', () => {
  const tabs = file('{\n\t"model": "x"\n}\n');
  wireKiloJson(tabs, true, DEF, NAME);
  assert(read(tabs).startsWith('{\n\t"model": "x",\n\t"mcp": {\n\t\t"agentic-brain": {\n\t\t\t"type": "local",'), 'tab indent');
  const crlf = file('{\r\n  "a": 1\r\n}\r\n');
  wireKiloJson(crlf, true, DEF, NAME);
  assert(!/[^\r]\n/.test(read(crlf)), 'no bare LF introduced into a CRLF file'); eq(JSON.parse(read(crlf)).a, 1, 'user key kept');
  const mini = file('{"a":1}');
  wireKiloJson(mini, true, DEF, NAME);
  assert(read(mini).startsWith('{"a":1,"mcp":{"agentic-brain":{'), 'minified file stays minified'); eq(JSON.parse(read(mini)).a, 1, 'a');
  const empty = file('{}');
  wireKiloJson(empty, true, DEF, NAME); eq(ours(read(empty)).type, 'local', 'empty object');
  const blank = file('   \n');
  wireKiloJson(blank, true, DEF, NAME); eq(JSON.parse(read(blank)).mcp['agentic-brain'].type, 'local', 'whitespace-only file treated as empty');
});
await t('wireKiloJson: idempotent — a second and third run write nothing and make no backup', () => {
  const f = file('{ "mcp": { "other": { "type": "remote", "url": "u" } } }');
  wireKiloJson(f, true, DEF, NAME);
  const once = read(f), bak = baks(f).length;
  for (let i = 0; i < 2; i++) {
    const r = wireKiloJson(f, true, DEF, NAME);
    eq(r.status, 'unchanged', 'status'); eq(r.changed, false, 'changed'); eq(r.action, 'already wired', 'action');
  }
  eq(read(f), once, 'bytes identical'); eq(baks(f).length, bak, 'no new backup');
});
await t('wireKiloJson: a user-customised entry (extra env, disabled, other timeout) is left alone; a bare "node" is upgraded to the absolute node', () => {
  const custom = file(JSON.stringify({ mcp: { 'agentic-brain': { type: 'local', command: ['/other/node', DEF.args[0]], enabled: false, environment: { A: '1' }, timeout: 99 } } }, null, 2));
  const before = read(custom);
  const r = wireKiloJson(custom, true, DEF, NAME);
  eq(r.status, 'unchanged', 'status'); eq(r.action, 'already wired (customized)', 'action'); eq(read(custom), before, 'bytes');
  const bare = file(JSON.stringify({ keep: 1, mcp: { 'agentic-brain': { type: 'local', command: ['node', DEF.args[0]] } } }, null, 2));
  const r2 = wireKiloJson(bare, true, DEF, NAME);
  eq(r2.status, 'wrote', 'upgraded'); eq(ours(read(bare)).command[0], DEF.command, 'absolute node'); eq(JSON.parse(read(bare)).keep, 1, 'rest kept');
  const stale = file(JSON.stringify({ mcp: { 'agentic-brain': { type: 'local', command: ['node', '/old/path/server.cjs'] } } }));
  wireKiloJson(stale, true, DEF, NAME); eq(ours(read(stale)).command[1], DEF.args[0], 'a stale shim path is repointed');
});
await t('wireKiloJson: refuses (ok:false, file untouched, no backup) on malformed JSONC, a non-object root, or a non-object mcp', () => {
  for (const [label, bad, why] of [['malformed', '{ "mcp": { , } }', /could not parse/], ['array root', '[1,2]', /not a JSON object/], ['mcp array', '{ "mcp": [] }', /"mcp" in .* is not an object/], ['mcp string', '{ "mcp": "x" }', /not an object/]]) {
    const f = file(bad);
    const r = wireKiloJson(f, true, DEF, NAME);
    eq(r.ok, false, `${label}: ok`); eq(r.status, 'failed', `${label}: status`); assert(why.test(r.action), `${label}: ${r.action}`);
    eq(read(f), bad, `${label}: bytes untouched`); eq(baks(f).length, 0, `${label}: no backup`);
  }
});
await t('wireKiloJson: never reports unrelated servers as ours and ignores the legacy supersede option', () => {
  const f = file(JSON.stringify({ mcp: { 'claude-mem': { type: 'local', command: ['node', '/x/bridge.cjs'] } } }));
  const r = wireKiloJson(f, true, DEF, { name: 'agentic-brain', supersede: { name: 'claude-mem', paths: ['/x/bridge.cjs'] } });
  eq(r.superseded, null, 'Kilo never had our claude-mem entry'); assert(JSON.parse(read(f)).mcp['claude-mem'], 'the user\'s claude-mem entry is kept');
});
await t('wireTargetConfig dispatches by mcpShape/format (kilo → mcp map; json → mcpServers; toml → mcp_servers)', () => {
  const k = file(null); const j = file(null, 'json'); const tm = file(null, 'toml');
  wireTargetConfig({ mcpShape: 'kilo', format: 'json' }, k, true, DEF, NAME);
  wireTargetConfig({ format: 'json' }, j, true, DEF, NAME);
  wireTargetConfig({ format: 'toml' }, tm, true, DEF, NAME);
  assert(JSON.parse(read(k)).mcp, 'kilo'); assert(JSON.parse(read(j)).mcpServers, 'json'); assert(/\[mcp_servers\.agentic-brain\]/.test(read(tm)), 'toml');
});

// ── children with a fake $HOME: helpers, registry, wireMcp, push, doctor ──────
const cleanEnv = (home, extra = {}) => {
  const env = { ...process.env, HOME: home, ...extra };
  for (const k of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'KILO_DB', 'KILO_CONFIG_DIR', 'AGENTIC_BRAIN_HOME']) if (!(k in extra)) delete env[k];
  return env;
};
function child(home, code, extra = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import ${JSON.stringify(join(REPO, 'evals/test-env.mjs'))};\n${code}`], { env: cleanEnv(home, extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const imp = (m) => `await import(${JSON.stringify(join(REPO, 'bin/lib', m))})`;
const home = (name) => { const h = join(ROOT, name); mkdirSync(h, { recursive: true }); return h; };
const appSup = (h, ...p) => (process.platform === 'linux' ? join(h, '.config', ...p) : join(h, 'Library', 'Application Support', ...p));
const hostGs = (h, host) => appSup(h, host, 'User', 'globalStorage', 'kilocode.kilo-code');
const fakeBin = (dir, name) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), '#!/bin/sh\n'); chmodSync(join(dir, name), 0o755); return dir; };

await t('kilo.mjs: config/db/push paths follow xdg-basedir (~/.config, ~/.local/share — also on macOS) and the real precedence', () => {
  const H = home('h-paths');
  const out = child(H, `const k = ${imp('kilo.mjs')}; console.log(JSON.stringify({ cfg: k.kiloConfigDir(), data: k.kiloDataDir(), db: k.kiloDbPath(), file: k.kiloGlobalConfigFile(), push: k.kiloPushFile() }));`);
  eq(out.cfg, join(H, '.config', 'kilo'), 'config dir'); eq(out.data, join(H, '.local', 'share', 'kilo'), 'data dir'); eq(out.db, join(H, '.local', 'share', 'kilo', 'kilo.db'), 'db');
  eq(out.file, join(H, '.config', 'kilo', 'kilo.jsonc'), 'default config file when none exists (what Kilo seeds)'); eq(out.push, join(H, '.config', 'kilo', 'AGENTS.md'), 'push file');
  // Kilo picks the FIRST existing of kilo.jsonc, kilo.json, opencode.jsonc, opencode.json, config.json
  mkdirSync(join(H, '.config', 'kilo'), { recursive: true });
  writeFileSync(join(H, '.config', 'kilo', 'opencode.json'), '{}');
  eq(child(H, `console.log(JSON.stringify((${imp('kilo.mjs')}).kiloGlobalConfigFile()))`), join(H, '.config', 'kilo', 'opencode.json'), 'opencode.json when it is the only one');
  writeFileSync(join(H, '.config', 'kilo', 'kilo.json'), '{}');
  eq(child(H, `console.log(JSON.stringify((${imp('kilo.mjs')}).kiloGlobalConfigFile()))`), join(H, '.config', 'kilo', 'kilo.json'), 'kilo.json beats opencode.json');
  const X = join(H, 'xdg');
  const o = child(H, `const k = ${imp('kilo.mjs')}; console.log(JSON.stringify({ c: k.kiloConfigDir(), d: k.kiloDataDir() }))`, { XDG_CONFIG_HOME: join(X, 'c'), XDG_DATA_HOME: join(X, 'd') });
  eq(o.c, join(X, 'c', 'kilo'), 'XDG_CONFIG_HOME'); eq(o.d, join(X, 'd', 'kilo'), 'XDG_DATA_HOME');
});
await t('kilo.mjs push file: AGENTS.md normally; the CLAUDE.md fallback Kilo is really reading when AGENTS.md is absent — never shadowed', () => {
  const H = home('h-pushfile');
  const push = () => child(H, `console.log(JSON.stringify((${imp('kilo.mjs')}).kiloPushFile()))`);
  eq(push(), join(H, '.config', 'kilo', 'AGENTS.md'), 'no files at all');
  mkdirSync(join(H, '.claude'), { recursive: true }); writeFileSync(join(H, '.claude', 'CLAUDE.md'), 'my global claude instructions\n');
  eq(push(), join(H, '.claude', 'CLAUDE.md'), 'CLAUDE.md exists, AGENTS.md does not → Kilo reads CLAUDE.md; do not create a shadowing AGENTS.md');
  mkdirSync(join(H, '.config', 'kilo'), { recursive: true }); writeFileSync(join(H, '.config', 'kilo', 'AGENTS.md'), 'kilo specific\n');
  eq(push(), join(H, '.config', 'kilo', 'AGENTS.md'), 'AGENTS.md exists → it wins in Kilo, so it is the target');
});
await t('detection: one row per host — VS Code family, Cursor, CLI binary; the shared data dir alone proves nothing', () => {
  const probe = (H, extra = {}) => child(H, `const m = ${imp('wire-targets.mjs')}; const d = new Set(m.detectedTargets().map((t) => t.id)); console.log(JSON.stringify(['kilo_vscode','kilo_cursor','kilo_cli'].filter((i) => d.has(i))))`, { PATH: '/usr/bin:/bin', ...extra });
  const machineHasKiloBin = ['/opt/homebrew/bin', '/usr/local/bin'].some((d) => existsSync(join(d, 'kilo')) || existsSync(join(d, 'kilocode')));
  const none = home('h-det-none'); mkdirSync(join(none, '.local', 'share', 'kilo'), { recursive: true }); mkdirSync(join(none, '.config', 'kilo'), { recursive: true });
  const base = machineHasKiloBin ? ['kilo_cli'] : [];
  eq(probe(none).join(','), base.join(','), 'only the data/config dirs exist → no row detected (the extension creates them too)');
  const code = home('h-det-code'); mkdirSync(hostGs(code, 'Code'), { recursive: true });
  eq(probe(code).filter((x) => x !== 'kilo_cli').join(','), 'kilo_vscode', 'VS Code globalStorage/kilocode.kilo-code');
  const ext = home('h-det-ext'); mkdirSync(join(ext, '.cursor', 'extensions', 'kilocode.kilo-code-7.8.8-universal'), { recursive: true });
  eq(probe(ext).filter((x) => x !== 'kilo_cli').join(','), 'kilo_cursor', 'Cursor extension dir');
  for (const [dir, label] of [['.vscode-insiders', 'Insiders'], ['.vscode-oss', 'VSCodium'], ['.windsurf', 'Windsurf']]) {
    const h = home(`h-det-${label}`); mkdirSync(join(h, dir, 'extensions', 'kilocode.kilo-code-7.8.8-darwin-arm64'), { recursive: true });
    eq(probe(h).filter((x) => x !== 'kilo_cli').join(','), 'kilo_vscode', `${label} counts as the VS Code row`);
  }
  const other = home('h-det-other'); mkdirSync(join(other, '.vscode', 'extensions', 'someone.else-1.0.0'), { recursive: true }); mkdirSync(appSup(other, 'Code', 'User', 'globalStorage', 'someone.else'), { recursive: true });
  eq(probe(other).filter((x) => x !== 'kilo_cli').join(','), '', 'other extensions do not count');
  const cli = home('h-det-cli');
  eq(probe(cli, { PATH: `${fakeBin(join(cli, 'bin'), 'kilo')}:/usr/bin:/bin` }).join(','), 'kilo_cli', '`kilo` on PATH');
  const cli2 = home('h-det-cli2');
  eq(probe(cli2, { PATH: `${fakeBin(join(cli2, 'bin'), 'kilocode')}:/usr/bin:/bin` }).join(','), 'kilo_cli', '`kilocode` alias on PATH');
  const lin = home('h-det-linux'); mkdirSync(join(lin, '.config', 'Cursor', 'User', 'globalStorage', 'kilocode.kilo-code'), { recursive: true });
  eq(probe(lin, { BRAIN_PLATFORM_OVERRIDE: 'linux' }).filter((x) => x !== 'kilo_cli').join(','), 'kilo_cursor', 'Linux layout ~/.config/Cursor/User/globalStorage');
});

// wireMcp over a whole fake machine: Kilo in VS Code + Cursor + the CLI, plus a Kilo config the user already owns.
const W = home('h-wire');
mkdirSync(hostGs(W, 'Code'), { recursive: true }); mkdirSync(hostGs(W, 'Cursor'), { recursive: true });
fakeBin(join(W, 'bin'), 'kilo');
mkdirSync(join(W, '.config', 'kilo'), { recursive: true });
const USER_CFG = '// mine\n{\n  "$schema": "https://app.kilo.ai/config.json",\n  "model": "kilo/auto",\n  "mcp": {\n    "docs": { "type": "remote", "url": "https://docs.example/mcp" },\n  },\n}\n';
writeFileSync(join(W, '.config', 'kilo', 'kilo.jsonc'), USER_CFG);
mkdirSync(join(W, '.agentic-brain'), { recursive: true }); writeFileSync(join(W, '.agentic-brain', 'server.cjs'), '// fake shim\n');
const wireChild = (H, write, extra = {}) => child(H, `const { wireMcp } = ${imp('wire.mjs')}; const r = wireMcp({ write: ${write} }); console.log(JSON.stringify({ ok: r.ok, rows: r.results.filter((x) => x.id.startsWith('kilo_')).map((x) => ({ id: x.id, installed: x.installed, status: x.status, action: x.action, file: x.file, backup: !!x.backup })) }));`, { PATH: `${join(H, 'bin')}:/usr/bin:/bin`, ...extra });
await t('wireMcp: one write wires the shared Kilo config; the other Kilo rows report it already wired (no 2nd write, no 2nd backup)', () => {
  const dry = wireChild(W, false);
  eq(dry.rows.map((r) => r.id).join(','), 'kilo_vscode,kilo_cursor,kilo_cli', 'rows'); assert(dry.rows.every((r) => r.installed), 'all detected');
  eq(read(join(W, '.config', 'kilo', 'kilo.jsonc')), USER_CFG, 'dry run wrote nothing');
  const w = wireChild(W, true);
  eq(w.rows[0].status, 'wrote', 'first row writes'); eq(w.rows[0].file, join(W, '.config', 'kilo', 'kilo.jsonc'), 'the file Kilo itself reads/writes');
  eq(w.rows[1].status, 'unchanged', 'cursor row: already wired'); eq(w.rows[2].status, 'unchanged', 'cli row: already wired');
  const out = read(join(W, '.config', 'kilo', 'kilo.jsonc'));
  assert(out.startsWith('// mine\n{\n  "$schema": "https://app.kilo.ai/config.json",\n  "model": "kilo/auto",\n  "mcp": {\n    "docs": { "type": "remote", "url": "https://docs.example/mcp" },\n'), 'user content before our entry byte-identical');
  assert(out.endsWith('  },\n}\n'), 'user content after our entry byte-identical');
  const e = ours(out);
  eq(e.type, 'local', 'local'); eq(e.command[1], join(W, '.agentic-brain', 'server.cjs'), 'stable shim'); assert(e.command[0].startsWith('/'), 'absolute node');
  eq(readdirSync(join(W, '.config', 'kilo')).filter((f) => f.includes('.bak-')).length, 1, 'exactly one backup');
});
await t('wireMcp: re-running onboard changes nothing', () => {
  const f = join(W, '.config', 'kilo', 'kilo.jsonc');
  const before = read(f);
  const again = wireChild(W, true);
  assert(again.rows.every((r) => r.status === 'unchanged'), `all unchanged: ${JSON.stringify(again.rows.map((r) => r.status))}`);
  eq(read(f), before, 'bytes'); eq(readdirSync(join(W, '.config', 'kilo')).filter((x) => x.includes('.bak-')).length, 1, 'still one backup');
});
await t('wireMcp: no Kilo anywhere → every Kilo row "skipped (not installed)" and nothing is created', () => {
  const E = home('h-wire-none'); mkdirSync(join(E, '.agentic-brain'), { recursive: true }); writeFileSync(join(E, '.agentic-brain', 'server.cjs'), 'x');
  const r = wireChild(E, true, { PATH: '/usr/bin:/bin' });
  const machineHasKiloBin = ['/opt/homebrew/bin', '/usr/local/bin'].some((d) => existsSync(join(d, 'kilo')) || existsSync(join(d, 'kilocode')));
  for (const row of r.rows.filter((x) => x.id !== 'kilo_cli' || !machineHasKiloBin)) { eq(row.installed, false, `${row.id} installed`); eq(row.action, 'skipped (not installed)', `${row.id} action`); }
  assert(!existsSync(join(E, '.config', 'kilo')) || machineHasKiloBin, 'no ~/.config/kilo created');
});
await t('wireMcp: a Kilo config we cannot parse is reported FAIL on that row and never overwritten; other tools still wired', () => {
  const B = home('h-wire-bad'); mkdirSync(hostGs(B, 'Code'), { recursive: true }); mkdirSync(join(B, '.config', 'kilo'), { recursive: true });
  writeFileSync(join(B, '.config', 'kilo', 'kilo.jsonc'), '{ "mcp": { oops } }');
  mkdirSync(join(B, '.agentic-brain'), { recursive: true }); writeFileSync(join(B, '.agentic-brain', 'server.cjs'), 'x');
  mkdirSync(join(B, '.cursor'), { recursive: true }); writeFileSync(join(B, '.cursor', 'mcp.json'), '{"mcpServers":{"a":{"command":"x"}}}');
  const r = child(B, `const { wireMcp } = ${imp('wire.mjs')}; const r = wireMcp({ write: true }); console.log(JSON.stringify({ ok: r.ok, rows: r.results.filter((x) => x.installed).map((x) => ({ id: x.id, ok: x.ok, status: x.status })) }))`, { PATH: '/usr/bin:/bin' });
  eq(r.ok, true, 'outer ok'); eq(r.rows.find((x) => x.id === 'kilo_vscode').ok, false, 'kilo row failed'); eq(r.rows.find((x) => x.id === 'cursor').ok, true, 'cursor still wired');
  eq(read(join(B, '.config', 'kilo', 'kilo.jsonc')), '{ "mcp": { oops } }', 'untouched');
});

// push + doctor
function seedStore(H) {
  mkdirSync(join(H, '.claude-brain'), { recursive: true });
  openStore({ path: join(H, '.claude-brain', 'brain.db') }).close();
  writeFileSync(join(H, '.claude-brain', 'READY'), 'test\n');
}
const injectChild = (H, write = true) => child(H, `
  const { MEMORY_DB } = ${imp('paths.mjs')};
  if (!MEMORY_DB.startsWith(${JSON.stringify(H)})) { console.log('UNSAFE'); process.exit(3); }
  const { injectContext } = ${imp('inject.mjs')};
  const r = injectContext({ write: ${write} });
  console.log(JSON.stringify(r.results.map((x) => ({ id: x.id, ids: x.ids, label: x.label, file: x.file, action: x.action, installed: x.installed }))));`, { PATH: '/usr/bin:/bin' });
await t('push: the managed digest block goes into ~/.config/kilo/AGENTS.md, user text outside it survives, re-run is a no-op', () => {
  const H = home('h-push'); seedStore(H); mkdirSync(hostGs(H, 'Code'), { recursive: true });
  const f = join(H, '.config', 'kilo', 'AGENTS.md');
  const rows = injectChild(H);
  const row = rows.find((x) => x.file === f);
  assert(row && row.installed, 'Kilo push row present and installed'); eq(row.ids.join(','), 'kilo_vscode', 'serves the detected host'); eq(row.action, 'created file', 'created');
  assert(/<!-- BRAIN:START/.test(read(f)) && /<!-- BRAIN:END -->/.test(read(f)), 'managed block');
  writeFileSync(f, `# my kilo rules\nBe terse.\n\n${read(f)}\n\nTrailing user text\n`);
  const keep = read(f);
  eq(injectChild(H).find((x) => x.file === f).action, 'unchanged', 'second run changes nothing'); eq(read(f), keep, 'bytes');
  const stripped = keep.replace(/<!-- BRAIN:START[\s\S]*?<!-- BRAIN:END -->/, '');
  assert(stripped.includes('# my kilo rules\nBe terse.') && stripped.includes('Trailing user text'), 'user text kept');
});
await t('push: with ~/.claude/CLAUDE.md and no Kilo AGENTS.md, Kilo\'s global file IS CLAUDE.md — written once, reported for both, no shadowing AGENTS.md created', () => {
  const H = home('h-push-shared'); seedStore(H); mkdirSync(hostGs(H, 'Cursor'), { recursive: true });
  mkdirSync(join(H, '.claude'), { recursive: true }); writeFileSync(join(H, '.claude', 'CLAUDE.md'), '# global claude rules\n');
  const rows = injectChild(H);
  const shared = rows.find((x) => x.file === join(H, '.claude', 'CLAUDE.md'));
  assert(shared.ids.includes('claude_code') && shared.ids.includes('kilo_cursor'), `one write serves both: ${shared.ids}`); assert(/Kilo Code \(Cursor\)/.test(shared.label), shared.label);
  assert(!existsSync(join(H, '.config', 'kilo', 'AGENTS.md')), 'no AGENTS.md that would replace the user\'s CLAUDE.md for Kilo');
  assert(read(join(H, '.claude', 'CLAUDE.md')).startsWith('# global claude rules\n'), 'user text kept');
});
await t('push: nothing is written for a Kilo that is not installed', () => {
  const H = home('h-push-none'); seedStore(H);
  const rows = injectChild(H, true);
  assert(!existsSync(join(H, '.config', 'kilo')), 'no ~/.config/kilo created');
  const k = rows.find((x) => x.ids && x.ids.some((i) => i.startsWith('kilo_')));
  if (k) eq(k.installed, false, 'reported not installed');
});

const doctorChild = (H, extra = {}) => child(H, `
  const d = ${imp('doctor.mjs')};
  const registry = await d.loadRegistry();
  const health = { capture: { state: 'ok', lastObs: Date.now(), ageMs: 1000, sources: { kilo: { ageMs: 3600000 } } } };
  const rows = await d.toolRows(registry, health, 5, true);
  console.log(JSON.stringify(rows.filter((r) => r.id.startsWith('kilo_')).map((r) => ({ id: r.id, name: r.name, installed: r.installed, level: r.level, capture: r.checks.capture?.level, push: r.checks.push?.level, pull: r.checks.pull?.level, pullDetail: r.checks.pull?.detail, pushDetail: r.checks.push?.detail, captureDetail: r.checks.capture?.detail, notes: r.notes }))));`,
  { PATH: '/usr/bin:/bin', ...extra });
await t('doctor: Kilo rows are SKIP (never FAIL) when not installed', () => {
  const H = home('h-doc-none');
  const rows = doctorChild(H);
  eq(rows.map((r) => r.name).join(' | '), 'Kilo Code (VS Code) | Kilo Code (Cursor) | Kilo CLI', 'one row per host, named per the brief');
  const machineHasKiloBin = ['/opt/homebrew/bin', '/usr/local/bin'].some((d) => existsSync(join(d, 'kilo')) || existsSync(join(d, 'kilocode')));
  for (const r of rows.filter((x) => x.id !== 'kilo_cli' || !machineHasKiloBin)) { eq(r.installed, false, r.id); eq(r.level, 'SKIP', r.id); }
});
await t('doctor: installed host → capture/push/pull rows; WARN before wiring, PASS after onboard + inject; capture reads the "kilo" source', () => {
  const H = join(ROOT, 'h-doc'); mkdirSync(hostGs(H, 'Code'), { recursive: true }); seedStore(H);
  mkdirSync(join(H, '.agentic-brain'), { recursive: true }); writeFileSync(join(H, '.agentic-brain', 'server.cjs'), 'x');
  // bridgeOk = true is passed by the stub above; pull needs the shim path to equal the registry's — real wireMcp below writes it
  const before = doctorChild(H).find((r) => r.id === 'kilo_vscode');
  eq(before.installed, true, 'installed'); eq(before.pull, 'WARN', `pull not registered yet: ${before.pullDetail}`); eq(before.push, 'WARN', `push not created yet: ${before.pushDetail}`);
  eq(before.capture, 'PASS', `capture: ${before.captureDetail}`); assert(/^BETA/.test(before.notes), 'tool marked beta in its notes');
  child(H, `const { wireMcp } = ${imp('wire.mjs')}; wireMcp({ write: true }); console.log('{}')`);
  injectChild(H);
  const after = doctorChild(H).find((r) => r.id === 'kilo_vscode');
  eq(after.pull, 'PASS', `pull: ${after.pullDetail}`); eq(after.push, 'PASS', `push: ${after.pushDetail}`); eq(after.level, 'PASS', 'row level');
  assert(/agentic-brain registered in kilo\.jsonc/.test(after.pullDetail), after.pullDetail);
});
await t('doctor: a malformed Kilo config is a FAIL pull row with a fix hint (read-only: file untouched)', () => {
  const H = join(ROOT, 'h-doc-bad'); mkdirSync(hostGs(H, 'Code'), { recursive: true }); seedStore(H);
  mkdirSync(join(H, '.config', 'kilo'), { recursive: true }); writeFileSync(join(H, '.config', 'kilo', 'kilo.json'), '{ nope');
  const r = doctorChild(H).find((x) => x.id === 'kilo_vscode');
  eq(r.pull, 'FAIL', r.pullDetail); eq(r.level, 'FAIL', 'row'); eq(read(join(H, '.config', 'kilo', 'kilo.json')), '{ nope', 'untouched');
});
await t('registry: Kilo rows are beta-marked, ingest-captured, share one config + one push file, and have a restart hint', () => {
  const H = home('h-reg');
  const rows = child(H, `const m = ${imp('wire-targets.mjs')}; console.log(JSON.stringify(m.TARGETS.filter((t) => t.id.startsWith('kilo_')).map((t) => ({ id: t.id, name: t.name, format: t.format, mcpShape: t.mcpShape, serversKey: t.serversKey, capture: t.capture, cfg: t.configPath(), push: t.push.file(), restart: t.restart, notes: t.notes }))))`);
  eq(rows.length, 3, 'three rows');
  for (const r of rows) {
    eq(r.capture, 'ingest', `${r.id} capture`); eq(r.mcpShape, 'kilo', `${r.id} shape`); eq(r.serversKey, 'mcp', `${r.id} key`); eq(r.format, 'json', `${r.id} format`);
    assert(r.id === 'kilo_cli' ? /^BETA — verified against a live Kilo CLI/.test(r.notes) : /^BETA — verified against source, not yet against a live install/.test(r.notes), `${r.id} beta note`);
    eq(r.cfg, rows[0].cfg, 'one shared config'); eq(r.push, rows[0].push, 'one shared push file');
  }
});

// ── report ───────────────────────────────────────────────────────────────────
for (const [s, nm, m] of results) console.log(`${s === 'PASS' ? '  ✓' : '  ✗'} ${nm}${m ? '\n    ' + m.replace(/\n/g, '\n    ') : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
