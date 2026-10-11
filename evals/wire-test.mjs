#!/usr/bin/env node
// Tests for bin/lib/wire.mjs — the config-merging code that edits OTHER vendors'
// MCP configs (Codex TOML, Claude Desktop / agy / Cursor JSON).
//
// These configs are irreplaceable user data, so the tests below are the contract:
//   * Bug 1 — wireToml's old regex `\[mcp_servers\.claude-mem\][^\[]*` stopped at
//     the `[` opening `args = [ ... ]` and orphaned the rest of the block.
//   * Bug 2 — wireJson's old `catch { obj = {} }` + unconditional write replaced a
//     malformed config with a claude-mem-only file (11 servers → 1).
//
// Runs entirely inside a throwaway directory. It NEVER touches a real config:
// nothing here reads or writes ~/.codex, ~/.gemini, ~/.cursor, ~/.claude*, or
// ~/Library/Application Support/Claude. Set BRAIN_WIRE_TEST_DIR to pick the
// sandbox location; otherwise a mkdtemp under TMPDIR is used.
//
//   node evals/wire-test.mjs
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wireJson, wireToml } from '../bin/lib/wire.mjs';
import { REPO_ROOT } from '../bin/lib/paths.mjs';

const BRIDGE = join(REPO_ROOT, 'bin', 'mcp-bridge.cjs');
const OLD_BRIDGE = '/Users/someone/old-location/Brain-claude-mem/bin/mcp-bridge.cjs';

const ROOT = process.env.BRAIN_WIRE_TEST_DIR
  ? (mkdirSync(process.env.BRAIN_WIRE_TEST_DIR, { recursive: true }), mkdtempSync(join(process.env.BRAIN_WIRE_TEST_DIR, 'wire-')))
  : mkdtempSync(join(tmpdir(), 'wire-test-'));

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }

let n = 0;
function fixture(name, content) {
  const dir = join(ROOT, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  if (content !== undefined) writeFileSync(f, content);
  return f;
}
const baks = (file) => readdirSync(join(file, '..')).filter((f) => f.includes('.bak-')).sort();

// --------------------------------------------------------------------------
// Minimal, independent TOML validity check (no dependency — package.json stays
// at zero deps). Deliberately NOT the scanner wire.mjs uses: it must be able to
// disagree. Returns { tables: Map<name, Map<key, rawValue>> }, throws on junk.
// --------------------------------------------------------------------------
function parseToml(text) {
  const tables = new Map();
  let cur = '';            // root table
  tables.set(cur, new Map());
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const s = line.trim();
    if (s === '' || s.startsWith('#')) continue;
    if (s.startsWith('[')) {
      const m = /^\[\[?([^\]]*(?:"[^"]*"[^\]]*)*)\]\]?\s*(#.*)?$/.exec(s);
      if (!m) throw new Error(`line ${i + 1}: bad table header: ${s}`);
      cur = m[1].trim();
      if (tables.has(cur)) throw new Error(`line ${i + 1}: duplicate table [${cur}]`);
      tables.set(cur, new Map());
      continue;
    }
    // key = value, possibly a multi-line array
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(s);
    if (!kv) throw new Error(`line ${i + 1}: not a key/value or header: ${s}`);
    let value = kv[2];
    let depth = balance(value);
    if (depth < 0) throw new Error(`line ${i + 1}: unbalanced ]`);
    while (depth > 0) {
      i++;
      if (i >= lines.length) throw new Error(`line ${i}: unterminated array`);
      value += '\n' + lines[i];
      depth += balance(lines[i]);
    }
    if (value.trim() === '') throw new Error(`line ${i + 1}: empty value`);
    tables.get(cur).set(kv[1].trim(), value.trim());
  }
  return tables;
}
function balance(str) {
  let d = 0, q = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) { if (c === '\\' && q === '"') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#') break;
    if (c === '[') d++;
    if (c === ']') d--;
  }
  return d;
}
const tableNames = (text) => [...parseToml(text).keys()].filter((k) => k !== '');

// ==========================================================================
// TOML
// ==========================================================================

// The exact structural shape of a real ~/.codex/config.toml: root keys, project
// tables, our block with a bracketed `args` value, sub-tables after it, quoted
// table names, comments. (Structure copied from the real file; no secrets.)
const CODEX = `personality = "pragmatic"
model = "gpt-5.5"
notify = [ "/Applications/Some.app/Contents/MacOS/client", "turn-ended" ]

[projects."/Users/x/dev/My Video App"]
trust_level = "trusted"

# our managed block
[mcp_servers.claude-mem]
command = "node"
args = [ "${OLD_BRIDGE}" ]
startup_timeout_sec = 30
tool_timeout_sec = 180

[mcp_servers.node_repl]
args = []
command = "/Applications/ChatGPT.app/Contents/Resources/node_repl"
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/x/.codex"
NODE_REPL_NODE_MODULE_DIRS = "/Applications/ChatGPT.app/lib/node_modules"

[mcp_servers."Figma Dev Mode MCP"]
url = "http://127.0.0.1:3845/mcp"

[features]
js_repl = false
`;

t('BUG 1 — TOML update-in-place with args=[...] leaves no orphaned lines', () => {
  const f = fixture('config.toml', CODEX);
  const before = tableNames(CODEX);
  const r = wireToml(f, true);
  eq(r.action, 'update block', 'should report an update');
  eq(r.changed, true, 'should have changed');
  const after = readFileSync(f, 'utf8');

  // 1. still valid TOML by an independent parser
  const tables = parseToml(after);          // throws if orphaned lines appeared
  // 2. every other table survived, same order, same content
  const names = [...tables.keys()].filter((k) => k !== '');
  eq(names.join(' | '), before.join(' | '), 'table set/order changed');
  eq(tables.get('mcp_servers.node_repl').get('startup_timeout_sec'), '120', 'node_repl mangled');
  eq(tables.get('mcp_servers.node_repl.env').get('CODEX_HOME'), '"/Users/x/.codex"', 'node_repl.env mangled');
  eq(tables.get('mcp_servers."Figma Dev Mode MCP"').get('url'), '"http://127.0.0.1:3845/mcp"', 'figma table mangled');
  eq(tables.get('features').get('js_repl'), 'false', 'features table mangled');
  eq(tables.get('').get('model'), '"gpt-5.5"', 'root keys mangled');
  // 3. our block is fully rewritten — no leftover of the old path anywhere
  assert(!after.includes(OLD_BRIDGE), 'old bridge path still present');
  eq(tables.get('mcp_servers.claude-mem').get('args'), JSON.stringify([BRIDGE]).replace('[', '[').replace(/,/g, ','), 'args not rewritten');
  eq(tables.get('mcp_servers.claude-mem').get('tool_timeout_sec'), '180', 'timeouts missing');
  // 4. the preceding comment stays attached
  assert(after.includes('# our managed block\n[mcp_servers.claude-mem]'), 'leading comment lost');
  // 5. exactly one backup was made
  eq(baks(f).length, 1, 'expected exactly one backup');
  eq(readFileSync(join(f, '..', baks(f)[0]), 'utf8'), CODEX, 'backup is not the original bytes');
});

t('TOML insert when block absent', () => {
  const src = `model = "gpt-5.5"\n\n[features]\njs_repl = false\n`;
  const f = fixture('config.toml', src);
  const r = wireToml(f, true);
  eq(r.action, 'add block', 'should add');
  const after = readFileSync(f, 'utf8');
  const tables = parseToml(after);
  assert(tables.has('mcp_servers.claude-mem'), 'block not added');
  eq(tables.get('features').get('js_repl'), 'false', 'existing table lost');
  assert(after.startsWith(src.trimEnd()), 'existing content not preserved verbatim');
});

t('TOML block at EOF (nothing follows it)', () => {
  const src = `[features]\njs_repl = false\n\n[mcp_servers.claude-mem]\ncommand = "node"\nargs = [ "${OLD_BRIDGE}" ]\nstartup_timeout_sec = 30\ntool_timeout_sec = 180\n`;
  const f = fixture('config.toml', src);
  const r = wireToml(f, true);
  eq(r.action, 'update block', 'should update');
  const tables = parseToml(readFileSync(f, 'utf8'));
  eq(tables.get('features').get('js_repl'), 'false', 'features lost');
  assert(readFileSync(f, 'utf8').includes(BRIDGE), 'not rewired');
  assert(!readFileSync(f, 'utf8').includes(OLD_BRIDGE), 'orphan of old block left behind');
});

t('TOML block is the only table', () => {
  const src = `[mcp_servers.claude-mem]\ncommand = "node"\nargs = [ "${OLD_BRIDGE}" ]\n`;
  const f = fixture('config.toml', src);
  wireToml(f, true);
  const after = readFileSync(f, 'utf8');
  eq(tableNames(after).join(','), 'mcp_servers.claude-mem', 'unexpected tables');
  assert(after.includes('tool_timeout_sec = 180'), 'timeouts not written');
});

t('TOML file absent → creates config with only our block', () => {
  const f = fixture('config.toml', undefined);
  const r = wireToml(f, true);
  eq(r.action, 'create config', 'should create');
  eq(tableNames(readFileSync(f, 'utf8')).join(','), 'mcp_servers.claude-mem', 'unexpected content');
  eq(baks(f).length, 0, 'created file must not produce a backup');
});

t('TOML quoted header form + whitespace variants are recognised', () => {
  const src = `  [ mcp_servers . "claude-mem" ]   # managed\ncommand = "node"\nargs = [ "${OLD_BRIDGE}" ]\n\n[features]\njs_repl = false\n`;
  const f = fixture('config.toml', src);
  const r = wireToml(f, true);
  eq(r.action, 'update block', 'quoted/spaced header not recognised as ours');
  const after = readFileSync(f, 'utf8');
  parseToml(after);
  assert(!after.includes(OLD_BRIDGE), 'old block not replaced');
  eq(tableNames(after).join(','), 'mcp_servers.claude-mem,features', 'other tables disturbed');
});

t('TOML stale sub-table [mcp_servers.claude-mem.env] is absorbed, not orphaned', () => {
  const src = `[mcp_servers.claude-mem]\ncommand = "node"\nargs = [ "${OLD_BRIDGE}" ]\n\n[mcp_servers.claude-mem.env]\nFOO = "bar"\n\n[features]\njs_repl = false\n`;
  const f = fixture('config.toml', src);
  wireToml(f, true);
  const after = readFileSync(f, 'utf8');
  parseToml(after);
  assert(!after.includes('FOO'), 'stale sub-table survived (would shadow our block)');
  eq(tableNames(after).join(','), 'mcp_servers.claude-mem,features', 'other tables disturbed');
});

t('TOML with a value containing brackets/quotes is not confused', () => {
  const src = `notify = [ "a[b]c", 'd]e' ]\n\n[mcp_servers.claude-mem]\ncommand = "node"\nargs = [\n  "${OLD_BRIDGE}"\n]\n\n[features]\njs_repl = false\n`;
  const f = fixture('config.toml', src);
  const r = wireToml(f, true);
  eq(r.action, 'update block', 'multi-line args block not detected');
  const after = readFileSync(f, 'utf8');
  const tables = parseToml(after);
  eq(tables.get('').get('notify'), `[ "a[b]c", 'd]e' ]`, 'root array value mangled');
  eq(tables.get('features').get('js_repl'), 'false', 'features lost');
});

t('malformed TOML → refuse, no write, no backup', () => {
  const bad = `[features\njs_repl = false\n\n[mcp_servers.claude-mem]\ncommand = "node"\n`;
  const f = fixture('config.toml', bad);
  const r = wireToml(f, true);
  eq(r.ok, false, 'should not be ok');
  eq(r.changed, false, 'must not report a change');
  assert(/^FAIL malformed/.test(r.action), `action should say FAIL malformed, got: ${r.action}`);
  assert(/config\.toml/.test(r.action), 'action should name the file');
  eq(readFileSync(f, 'utf8'), bad, 'file was modified');
  eq(baks(f).length, 0, 'must not create a backup when refusing');
});

t('unterminated string in TOML → refuse, no write', () => {
  const bad = `command = "oops\n[mcp_servers.claude-mem]\n`;
  const f = fixture('config.toml', bad);
  const r = wireToml(f, true);
  eq(r.ok, false, 'should refuse');
  eq(readFileSync(f, 'utf8'), bad, 'file was modified');
});

t('duplicate [mcp_servers.claude-mem] blocks → refuse, no write', () => {
  const bad = `[mcp_servers.claude-mem]\ncommand = "node"\n\n[mcp_servers.claude-mem]\ncommand = "node"\n`;
  const f = fixture('config.toml', bad);
  const r = wireToml(f, true);
  eq(r.ok, false, 'should refuse ambiguous duplicates');
  eq(readFileSync(f, 'utf8'), bad, 'file was modified');
  eq(baks(f).length, 0, 'must not back up when refusing');
});

t('TOML dry-run writes nothing', () => {
  const f = fixture('config.toml', CODEX);
  const r = wireToml(f, false);
  eq(r.action, 'would update block', 'dry-run wording');
  eq(readFileSync(f, 'utf8'), CODEX, 'dry-run modified the file');
  eq(baks(f).length, 0, 'dry-run made a backup');
});

t('TOML re-run is a no-op: unchanged, no second backup', () => {
  const f = fixture('config.toml', CODEX);
  wireToml(f, true);
  const afterFirst = readFileSync(f, 'utf8');
  const r2 = wireToml(f, true);
  eq(r2.action, 'already wired', 'second run should be already wired');
  eq(r2.status, 'unchanged', 'status should be unchanged');
  eq(r2.changed, false, 'second run must not change');
  eq(readFileSync(f, 'utf8'), afterFirst, 'second run rewrote the file');
  eq(baks(f).length, 1, 'second run created another backup');
});

t('TOML semantic no-op: absolute node path + same bridge counts as wired', () => {
  const src = `[mcp_servers.claude-mem]\ncommand = "/opt/homebrew/bin/node"\nargs = [ "${BRIDGE}" ]\nstartup_timeout_sec = 30\ntool_timeout_sec = 180\n`;
  const f = fixture('config.toml', src);
  const r = wireToml(f, true);
  eq(r.action, 'already wired (customized)', 'should treat abs node path as wired');
  eq(readFileSync(f, 'utf8'), src, 'user customization was overwritten');
  eq(baks(f).length, 0, 'no-op made a backup');
});

// ==========================================================================
// JSON
// ==========================================================================

const ELEVEN = ['reddit_auth', 'twitter-mcp', 'browser-use-mcp-server', 'kite', 'linkedin',
  'linkedin_feed', 'figma', 'nanobanana', 'kie-ai', 'post-designer', 'content-writer'];
const desktopCfg = () => JSON.stringify({
  mcpServers: Object.fromEntries(ELEVEN.map((k) => [k, { command: 'npx', args: ['-y', `${k}-mcp`], env: { K: 'v' } }])),
  coworkUserFilesPath: '/Users/x/dev/Claude',
  preferences: { theme: 'dark' },
}, null, 2) + '\n';

t('JSON insert preserves 11 existing servers (11 → 12) and sibling keys', () => {
  const src = desktopCfg();
  const f = fixture('claude_desktop_config.json', src);
  const r = wireJson(f, true);
  eq(r.action, 'add entry', 'should add');
  const after = JSON.parse(readFileSync(f, 'utf8'));
  eq(Object.keys(after.mcpServers).length, 12, 'server count');
  for (const k of ELEVEN) {
    eq(JSON.stringify(after.mcpServers[k]), JSON.stringify(JSON.parse(src).mcpServers[k]), `server ${k} mutated`);
  }
  eq(after.coworkUserFilesPath, '/Users/x/dev/Claude', 'sibling key lost');
  eq(after.preferences.theme, 'dark', 'sibling key lost');
  eq(after.mcpServers['claude-mem'].args[0], BRIDGE, 'wrong bridge');
  eq(baks(f).length, 1, 'expected one backup');
  eq(readFileSync(join(f, '..', baks(f)[0]), 'utf8'), src, 'backup is not the original bytes');
});

t('BUG 2 — malformed JSON → refuse, no write, no backup (11 servers survive)', () => {
  const bad = desktopCfg().replace('"mcpServers": {', '"mcpServers": {,');   // trailing junk
  const f = fixture('claude_desktop_config.json', bad);
  const r = wireJson(f, true);
  eq(r.ok, false, 'should not be ok');
  eq(r.changed, false, 'must not report a change');
  assert(/^FAIL malformed/.test(r.action), `action should say FAIL malformed, got: ${r.action}`);
  assert(/claude_desktop_config\.json/.test(r.action), 'action should name the file');
  assert(!!r.error, 'result should carry the parse error');
  eq(readFileSync(f, 'utf8'), bad, 'file was modified — user config destroyed');
  eq(baks(f).length, 0, 'must not create a backup when refusing');
  // the 11 servers are still literally in the file
  for (const k of ELEVEN) assert(readFileSync(f, 'utf8').includes(`"${k}"`), `server ${k} gone`);
});

t('JSON that parses to a non-object → refuse', () => {
  const f = fixture('mcp.json', '[1,2,3]\n');
  const r = wireJson(f, true);
  eq(r.ok, false, 'array top level should be refused');
  eq(readFileSync(f, 'utf8'), '[1,2,3]\n', 'file was modified');
});

t('JSON with non-object mcpServers → refuse', () => {
  const f = fixture('mcp.json', '{"mcpServers": "nope"}\n');
  const r = wireJson(f, true);
  eq(r.ok, false, 'should be refused');
  eq(readFileSync(f, 'utf8'), '{"mcpServers": "nope"}\n', 'file was modified');
});

t('JSON file absent → creates minimal config, no backup', () => {
  const f = fixture('mcp.json', undefined);
  const r = wireJson(f, true);
  eq(r.action, 'create config', 'should create');
  const after = JSON.parse(readFileSync(f, 'utf8'));
  eq(Object.keys(after.mcpServers).join(','), 'claude-mem', 'unexpected servers');
  eq(baks(f).length, 0, 'created file must not produce a backup');
});

t('empty JSON file is treated as empty config, not malformed', () => {
  const f = fixture('mcp.json', '');
  const r = wireJson(f, true);
  eq(r.ok, true, 'empty file should be writable');
  eq(Object.keys(JSON.parse(readFileSync(f, 'utf8')).mcpServers).join(','), 'claude-mem', 'unexpected servers');
});

t('JSON update rewires a stale bridge path, keeping others', () => {
  const src = JSON.stringify({ mcpServers: { other: { command: 'x' }, 'claude-mem': { command: 'node', args: [OLD_BRIDGE] } } }, null, 2) + '\n';
  const f = fixture('mcp.json', src);
  const r = wireJson(f, true);
  eq(r.action, 'update entry', 'should update');
  const after = JSON.parse(readFileSync(f, 'utf8'));
  eq(after.mcpServers['claude-mem'].args[0], BRIDGE, 'not rewired');
  eq(after.mcpServers.other.command, 'x', 'other server lost');
});

t('JSON dry-run writes nothing', () => {
  const src = desktopCfg();
  const f = fixture('claude_desktop_config.json', src);
  const r = wireJson(f, false);
  eq(r.action, 'would add entry', 'dry-run wording');
  eq(readFileSync(f, 'utf8'), src, 'dry-run modified the file');
  eq(baks(f).length, 0, 'dry-run made a backup');
});

t('JSON re-run is a no-op: unchanged, no second backup', () => {
  const f = fixture('claude_desktop_config.json', desktopCfg());
  wireJson(f, true);
  const afterFirst = readFileSync(f, 'utf8');
  const r2 = wireJson(f, true);
  eq(r2.action, 'already wired', 'second run should be already wired');
  eq(r2.status, 'unchanged', 'status should be unchanged');
  eq(r2.changed, false, 'second run must not change');
  eq(readFileSync(f, 'utf8'), afterFirst, 'second run rewrote the file');
  eq(baks(f).length, 1, 'second run created another backup');
});

t('JSON semantic no-op: absolute node path + same bridge counts as wired', () => {
  const src = JSON.stringify({ mcpServers: { 'claude-mem': { command: '/usr/local/bin/node', args: [BRIDGE], env: { X: '1' } } } }, null, 2) + '\n';
  const f = fixture('mcp.json', src);
  const r = wireJson(f, true);
  eq(r.action, 'already wired (customized)', 'should treat abs node path as wired');
  eq(readFileSync(f, 'utf8'), src, 'user customization was overwritten');
  eq(baks(f).length, 0, 'no-op made a backup');
});

t('backups are pruned to the 3 newest', () => {
  const f = fixture('mcp.json', desktopCfg());
  const dir = join(f, '..');
  for (const s of ['20260101-000001', '20260101-000002', '20260101-000003', '20260101-000004']) {
    writeFileSync(join(dir, `mcp.json.bak-${s}`), 'old');
  }
  wireJson(f, true);
  const b = baks(f);
  eq(b.length, 3, `expected 3 backups after prune, got ${b.join(',')}`);
  assert(!b.includes('mcp.json.bak-20260101-000001'), 'oldest backup should have been pruned');
});

// ==========================================================================
// SUPERSEDE — `agentic-brain` replaces the claude-mem bridge entry
// (docs/specs/mcp-memory-server.md §8)
//
// Two overlapping "search my memory" toolsets in one client is a usability
// failure, so onboarding registers exactly one brain server per config. But
// deleting an entry from someone else's config is unrecoverable, so a
// claude-mem entry is only ever removed when it PROVABLY points at one of our
// own bridges; anything else is left byte-for-byte alone and merely reported.
//
// These tests pass name/supersede explicitly (never the machine's real home),
// so they assert the contract, not this laptop's paths.
// ==========================================================================

const AB_BRIDGE = '/Users/x/.agentic-brain/bridge.cjs';   // our stable bridge shim
const AB_SERVER = '/Users/x/.agentic-brain/server.cjs';   // our stable server shim
const BRAIN = { command: 'node', args: [AB_SERVER] };
// Exactly what wire-targets.mjs's supersedeSpec() produces: the shim, plus the
// engine-relative bridge older versions wired directly.
const SUP = { name: 'claude-mem', paths: [AB_BRIDGE, BRIDGE] };
const OPTS = { name: 'agentic-brain', supersede: SUP };
const jsonAt = (f) => JSON.parse(readFileSync(f, 'utf8'));
const svr = (f) => jsonAt(f).mcpServers;

// ---------------------------------------------------------------- JSON -----

t('SUPERSEDE/JSON absent config → creates agentic-brain only, no claude-mem', () => {
  const f = fixture('mcp.json', undefined);
  const r = wireJson(f, true, BRAIN, OPTS);
  eq(r.action, 'create config', 'should create');
  eq(Object.keys(svr(f)).join(','), 'agentic-brain', 'unexpected servers');
  eq(svr(f)['agentic-brain'].args[0], AB_SERVER, 'must point at the server shim');
  eq(r.superseded, null, 'nothing to supersede');
  eq(baks(f).length, 0, 'created file must not produce a backup');
});

t('SUPERSEDE/JSON fresh config with other servers gains agentic-brain', () => {
  const src = desktopCfg();
  const f = fixture('claude_desktop_config.json', src);
  const r = wireJson(f, true, BRAIN, OPTS);
  eq(r.action, 'add entry', 'should add');
  eq(Object.keys(svr(f)).length, 12, '11 → 12');
  eq(svr(f)['agentic-brain'].args[0], AB_SERVER, 'wrong server path');
  for (const k of ELEVEN) assert(svr(f)[k], `server ${k} lost`);
  eq(baks(f).length, 1, 'expected one backup');
});

t('SUPERSEDE/JSON our claude-mem entry is REPLACED in one write, others intact', () => {
  const src = JSON.stringify({
    mcpServers: {
      figma: { command: 'npx', args: ['-y', 'figma-mcp'] },
      'claude-mem': { command: 'node', args: [AB_BRIDGE] },
      kite: { command: 'node', args: ['/opt/k.js'] },
    },
    preferences: { theme: 'dark' },
  }, null, 2) + '\n';
  const f = fixture('mcp.json', src);
  const r = wireJson(f, true, BRAIN, OPTS);
  eq(r.superseded, 'claude-mem', 'should have superseded our own entry');
  eq(r.supersedeKept, null, 'nothing should be reported as kept');
  eq(r.action, 'add entry + remove superseded claude-mem', 'action wording');
  const after = svr(f);
  assert(!('claude-mem' in after), 'claude-mem entry survived');
  eq(after['agentic-brain'].args[0], AB_SERVER, 'agentic-brain missing/wrong');
  eq(Object.keys(after).join(','), 'figma,kite,agentic-brain', 'unrelated servers disturbed');
  eq(jsonAt(f).preferences.theme, 'dark', 'sibling key lost');
  // ONE write, ONE backup — the config is never left with neither server.
  eq(baks(f).length, 1, 'removal + addition must be a single backed-up write');
  eq(readFileSync(join(f, '..', baks(f)[0]), 'utf8'), src, 'backup is not the original bytes');
  assert(svr(join(f, '..', baks(f)[0]))['claude-mem'], 'backup should still hold the old entry');
});

t('SUPERSEDE/JSON a legacy engine-relative claude-mem entry is also ours', () => {
  const src = JSON.stringify({ mcpServers: { 'claude-mem': { command: '/opt/homebrew/bin/node', args: [BRIDGE] } } }, null, 2) + '\n';
  const f = fixture('mcp.json', src);
  const r = wireJson(f, true, BRAIN, OPTS);
  eq(r.superseded, 'claude-mem', 'engine-relative bridge (abs node path) is ours');
  eq(Object.keys(svr(f)).join(','), 'agentic-brain', 'should be exactly one brain server');
});

t('SUPERSEDE/JSON a user-configured claude-mem entry is LEFT ALONE', () => {
  const mine = { command: 'npx', args: ['-y', 'claude-mem@latest', 'mcp'], env: { X: '1' } };
  const src = JSON.stringify({ mcpServers: { 'claude-mem': mine, other: { command: 'x' } } }, null, 2) + '\n';
  const f = fixture('mcp.json', src);
  const r = wireJson(f, true, BRAIN, OPTS);
  eq(r.superseded, null, 'must NOT remove an entry we did not write');
  eq(r.supersedeKept, 'claude-mem', 'should report the entry it left alone');
  eq(r.action, 'add entry', 'action must not claim a removal');
  const after = svr(f);
  eq(JSON.stringify(after['claude-mem']), JSON.stringify(mine), "user's claude-mem entry was modified");
  eq(after['agentic-brain'].args[0], AB_SERVER, 'agentic-brain not added beside it');
  eq(after.other.command, 'x', 'unrelated server lost');
});

t('SUPERSEDE/JSON a claude-mem entry pointing at ANOTHER clone is left alone', () => {
  const src = JSON.stringify({ mcpServers: { 'claude-mem': { command: 'node', args: [OLD_BRIDGE] } } }, null, 2) + '\n';
  const f = fixture('mcp.json', src);
  const r = wireJson(f, true, BRAIN, OPTS);
  eq(r.superseded, null, 'a path outside the supersede set is not ours to delete');
  eq(r.supersedeKept, 'claude-mem', 'should be reported');
  assert(readFileSync(f, 'utf8').includes(OLD_BRIDGE), 'foreign entry was destroyed');
});

t('SUPERSEDE/JSON malformed config still refuses — no write, no backup', () => {
  const bad = desktopCfg().replace('"mcpServers": {', '"mcpServers": {,');
  const f = fixture('claude_desktop_config.json', bad);
  const r = wireJson(f, true, BRAIN, OPTS);
  eq(r.ok, false, 'should refuse');
  eq(r.changed, false, 'must not report a change');
  eq(readFileSync(f, 'utf8'), bad, 'file was modified');
  eq(baks(f).length, 0, 'must not back up when refusing');
});

t('SUPERSEDE/JSON re-run is a semantic no-op — no second write, no second backup', () => {
  const f = fixture('mcp.json', JSON.stringify({ mcpServers: { 'claude-mem': { command: 'node', args: [AB_BRIDGE] } } }, null, 2) + '\n');
  const r1 = wireJson(f, true, BRAIN, OPTS);
  eq(r1.superseded, 'claude-mem', 'first run supersedes');
  const afterFirst = readFileSync(f, 'utf8');
  const r2 = wireJson(f, true, BRAIN, OPTS);
  eq(r2.action, 'already wired', 'second run should be already wired');
  eq(r2.status, 'unchanged', 'status should be unchanged');
  eq(r2.changed, false, 'second run must not change');
  eq(r2.superseded, null, 'nothing left to supersede');
  eq(readFileSync(f, 'utf8'), afterFirst, 'second run rewrote the file');
  eq(baks(f).length, 1, 'second run created another backup');
});

t('SUPERSEDE/JSON dry-run reports the removal and writes nothing', () => {
  const src = JSON.stringify({ mcpServers: { 'claude-mem': { command: 'node', args: [AB_BRIDGE] } } }, null, 2) + '\n';
  const f = fixture('mcp.json', src);
  const r = wireJson(f, false, BRAIN, OPTS);
  eq(r.action, 'would add entry + remove superseded claude-mem', 'dry-run wording');
  eq(r.status, 'would-write', 'dry-run status');
  eq(readFileSync(f, 'utf8'), src, 'dry-run modified the file');
  eq(baks(f).length, 0, 'dry-run made a backup');
});

t('SUPERSEDE/JSON already-superseded config with a NEW user claude-mem entry re-reports it', () => {
  // agentic-brain correct, plus a claude-mem the user added back by hand.
  const mine = { command: 'npx', args: ['claude-mem'] };
  const f = fixture('mcp.json', JSON.stringify({ mcpServers: { 'agentic-brain': BRAIN, 'claude-mem': mine } }, null, 2) + '\n');
  const r = wireJson(f, true, BRAIN, OPTS);
  eq(r.status, 'unchanged', 'nothing of ours to do');
  eq(r.supersedeKept, 'claude-mem', 'should still report the coexisting user entry');
  eq(baks(f).length, 0, 'a no-op must not back up');
});

// ---------------------------------------------------------------- TOML -----

// The CODEX fixture, but with the claude-mem block pointing at OUR shim.
const CODEX_OURS = CODEX.replace(OLD_BRIDGE, AB_BRIDGE);

t('SUPERSEDE/TOML our claude-mem block is removed and agentic-brain added, no orphans', () => {
  const f = fixture('config.toml', CODEX_OURS);
  const r = wireToml(f, true, BRAIN, OPTS);
  eq(r.superseded, 'claude-mem', 'should supersede our own block');
  eq(r.action, 'add block + remove superseded claude-mem', 'action wording');
  const after = readFileSync(f, 'utf8');
  const tables = parseToml(after);                    // throws on orphaned lines
  assert(!tables.has('mcp_servers.claude-mem'), 'claude-mem block survived');
  assert(tables.has('mcp_servers.agentic-brain'), 'agentic-brain block missing');
  eq(tables.get('mcp_servers.agentic-brain').get('args'), JSON.stringify([AB_SERVER]), 'wrong args');
  assert(!after.includes(AB_BRIDGE), 'old bridge path still present');
  // everything else byte-intact
  eq(tables.get('mcp_servers.node_repl').get('startup_timeout_sec'), '120', 'node_repl mangled');
  eq(tables.get('mcp_servers.node_repl.env').get('CODEX_HOME'), '"/Users/x/.codex"', 'node_repl.env mangled');
  eq(tables.get('mcp_servers."Figma Dev Mode MCP"').get('url'), '"http://127.0.0.1:3845/mcp"', 'figma table mangled');
  eq(tables.get('features').get('js_repl'), 'false', 'features mangled');
  eq(tables.get('').get('model'), '"gpt-5.5"', 'root keys mangled');
  eq(baks(f).length, 1, 'removal + addition must be a single backed-up write');
  eq(readFileSync(join(f, '..', baks(f)[0]), 'utf8'), CODEX_OURS, 'backup is not the original bytes');
});

t("SUPERSEDE/TOML a user's claude-mem block is left alone, agentic-brain added beside it", () => {
  const f = fixture('config.toml', CODEX);                 // points at another clone
  const r = wireToml(f, true, BRAIN, OPTS);
  eq(r.superseded, null, 'must not delete a block we did not write');
  eq(r.supersedeKept, 'claude-mem', 'should report it');
  const after = readFileSync(f, 'utf8');
  const tables = parseToml(after);
  assert(tables.has('mcp_servers.claude-mem'), "user's block was destroyed");
  eq(tables.get('mcp_servers.claude-mem').get('args'), `[ "${OLD_BRIDGE}" ]`, "user's args were rewritten");
  assert(tables.has('mcp_servers.agentic-brain'), 'agentic-brain not added');
  assert(after.includes('# our managed block'), 'comment lost');
});

t('SUPERSEDE/TOML stale [mcp_servers.claude-mem.env] sub-table is removed with the block', () => {
  const src = `model = "gpt-5.5"\n\n[mcp_servers.claude-mem]\ncommand = "node"\nargs = [ "${AB_BRIDGE}" ]\n\n[mcp_servers.claude-mem.env]\nFOO = "bar"\n\n[features]\njs_repl = false\n`;
  const f = fixture('config.toml', src);
  const r = wireToml(f, true, BRAIN, OPTS);
  eq(r.superseded, 'claude-mem', 'should supersede');
  const after = readFileSync(f, 'utf8');
  parseToml(after);
  assert(!after.includes('FOO'), 'orphaned sub-table survived');
  eq(tableNames(after).join(','), 'features,mcp_servers.agentic-brain', 'unexpected table set/order');
});

t('SUPERSEDE/TOML block at EOF is removed cleanly', () => {
  const src = `[features]\njs_repl = false\n\n[mcp_servers.claude-mem]\ncommand = "node"\nargs = [ "${AB_BRIDGE}" ]\nstartup_timeout_sec = 30\n`;
  const f = fixture('config.toml', src);
  wireToml(f, true, BRAIN, OPTS);
  const after = readFileSync(f, 'utf8');
  const tables = parseToml(after);
  eq(tables.get('features').get('js_repl'), 'false', 'features lost');
  assert(!after.includes(AB_BRIDGE), 'orphan of the removed block left behind');
  eq(tableNames(after).join(','), 'features,mcp_servers.agentic-brain', 'unexpected tables');
  assert(!/\n\n\n/.test(after), 'removal left a run of blank lines');
});

t('SUPERSEDE/TOML absent config → creates agentic-brain block only', () => {
  const f = fixture('config.toml', undefined);
  const r = wireToml(f, true, BRAIN, OPTS);
  eq(r.action, 'create config', 'should create');
  eq(tableNames(readFileSync(f, 'utf8')).join(','), 'mcp_servers.agentic-brain', 'unexpected content');
  eq(baks(f).length, 0, 'created file must not produce a backup');
});

t('SUPERSEDE/TOML malformed config still refuses — no write, no backup', () => {
  const bad = `[features\njs_repl = false\n\n[mcp_servers.claude-mem]\ncommand = "node"\nargs = [ "${AB_BRIDGE}" ]\n`;
  const f = fixture('config.toml', bad);
  const r = wireToml(f, true, BRAIN, OPTS);
  eq(r.ok, false, 'should refuse');
  eq(r.changed, false, 'must not report a change');
  eq(readFileSync(f, 'utf8'), bad, 'file was modified');
  eq(baks(f).length, 0, 'must not back up when refusing');
});

t('SUPERSEDE/TOML duplicate claude-mem blocks are reported, never removed', () => {
  // Two blocks with the legacy name is ambiguous (and already invalid TOML for
  // that key) — we add ours and refuse to guess which one to delete.
  const src = `[mcp_servers.claude-mem]\ncommand = "node"\nargs = [ "${AB_BRIDGE}" ]\n\n[mcp_servers.claude-mem]\ncommand = "node"\nargs = [ "${AB_BRIDGE}" ]\n`;
  const f = fixture('config.toml', src);
  const r = wireToml(f, true, BRAIN, OPTS);
  eq(r.ok, true, 'our own block is unambiguous, so this is still writable');
  eq(r.superseded, null, 'must not delete an ambiguous match');
  eq(r.supersedeKept, 'claude-mem', 'should report the ambiguity');
  const after = readFileSync(f, 'utf8');
  assert(after.includes('[mcp_servers.agentic-brain]'), 'our block not added');
  eq((after.match(/\[mcp_servers\.claude-mem\]/g) || []).length, 2, 'legacy blocks were touched');
});

t('SUPERSEDE/TOML re-run is a semantic no-op — no second write, no second backup', () => {
  const f = fixture('config.toml', CODEX_OURS);
  wireToml(f, true, BRAIN, OPTS);
  const afterFirst = readFileSync(f, 'utf8');
  const r2 = wireToml(f, true, BRAIN, OPTS);
  eq(r2.action, 'already wired', 'second run should be already wired');
  eq(r2.status, 'unchanged', 'status should be unchanged');
  eq(r2.changed, false, 'second run must not change');
  eq(r2.superseded, null, 'nothing left to supersede');
  eq(readFileSync(f, 'utf8'), afterFirst, 'second run rewrote the file');
  eq(baks(f).length, 1, 'second run created another backup');
});

t('SUPERSEDE/TOML dry-run reports the removal and writes nothing', () => {
  const f = fixture('config.toml', CODEX_OURS);
  const r = wireToml(f, false, BRAIN, OPTS);
  eq(r.action, 'would add block + remove superseded claude-mem', 'dry-run wording');
  eq(readFileSync(f, 'utf8'), CODEX_OURS, 'dry-run modified the file');
  eq(baks(f).length, 0, 'dry-run made a backup');
});

t('SUPERSEDE/TOML updating an existing agentic-brain block AND removing claude-mem is one write', () => {
  const src = `[mcp_servers.agentic-brain]\ncommand = "node"\nargs = [ "/stale/server.cjs" ]\n\n[mcp_servers.claude-mem]\ncommand = "node"\nargs = [ "${AB_BRIDGE}" ]\n\n[features]\njs_repl = false\n`;
  const f = fixture('config.toml', src);
  const r = wireToml(f, true, BRAIN, OPTS);
  eq(r.superseded, 'claude-mem', 'should supersede');
  eq(r.action, 'update block + remove superseded claude-mem', 'action wording');
  const after = readFileSync(f, 'utf8');
  const tables = parseToml(after);
  assert(!after.includes('/stale/server.cjs'), 'stale args not rewritten');
  assert(!after.includes(AB_BRIDGE), 'claude-mem block not removed');
  eq(tables.get('mcp_servers.agentic-brain').get('args'), JSON.stringify([AB_SERVER]), 'wrong args');
  eq(tables.get('features').get('js_repl'), 'false', 'features lost');
  eq(baks(f).length, 1, 'must be a single backed-up write');
});

// The legacy (2-/3-arg) call is what bin/lib/doctor.mjs uses — it must keep
// managing `claude-mem` with no supersede behaviour at all.
t('legacy 2-arg calls are untouched by supersede (doctor contract)', () => {
  const f = fixture('mcp.json', JSON.stringify({ mcpServers: { 'claude-mem': { command: 'node', args: [AB_BRIDGE] } } }, null, 2) + '\n');
  const r = wireJson(f, true);
  eq(r.superseded, null, 'legacy call must never supersede');
  eq(r.name, 'claude-mem', 'legacy call manages claude-mem');
  assert(svr(f)['claude-mem'], 'legacy call must keep managing claude-mem');
  assert(!svr(f)['agentic-brain'], 'legacy call must not write agentic-brain');
});

// ==========================================================================

const w = Math.max(...results.map((r) => r[1].length));
for (const [st, name, msg] of results) {
  console.log(`${st === 'PASS' ? '✅' : '❌'} ${name.padEnd(w)}${msg ? '\n    ' + msg : ''}`);
}
console.log(`\n${pass} passed, ${fail} failed  ·  sandbox: ${ROOT}`);
if (!fail && !process.env.BRAIN_WIRE_TEST_KEEP) rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
