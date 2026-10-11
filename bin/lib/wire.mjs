// `brain wire-mcp` — Phase 1 of cross-CLI memory: give Antigravity (agy) and Codex
// the SAME live, searchable memory Claude Code gets, by registering claude-mem's
// MCP search server into each tool's MCP config. Points them at our stable bridge
// (bin/mcp-bridge.cjs), which resolves the newest installed claude-mem at launch —
// so the wiring never goes stale on claude-mem updates.
//
// Reads: claude-mem's DB via its MCP server (all tools query one brain).
// This handles READ/search parity. Capture (write) parity for agy is a later phase
// (session-log ingestion); Codex capture comes from claude-mem's own codex plugin.
//
// SAFETY CONTRACT (docs/specs/auto-wiring.md §3) — these configs belong to other
// vendors and routinely hold a dozen hand-made server entries. Therefore:
//   1. Merge, never overwrite. Every key/table/comment we did not author survives.
//   2. A config we cannot parse is NEVER written — we report and skip. (Previously
//      `catch { obj = {} }` + unconditional write silently replaced a malformed
//      claude_desktop_config.json with a claude-mem-only file, destroying 11 servers.)
//   3. TOML block extent is found by a line-based scan with quote/bracket-depth
//      awareness — not by regex. (Previously `\[mcp_servers\.claude-mem\][^\[]*`
//      stopped at the `[` opening `args = [ ... ]`, so any content change orphaned
//      the tail of the old block as invalid TOML.)
//   4. Any modifying write is preceded by a timestamped `.bak-` copy; the 3 newest
//      of our own backups are kept, older ones pruned.
//   5. Already-wired is decided semantically (command resolves to node + args[0] is
//      our bridge), so re-runs write nothing and back nothing up. wireMcp() is
//      called on every `brain onboard`; it must be inert when there is no change.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { resolveNodeBinary } from './bridgehome.mjs';
import { TARGETS, detectedTargets, brainServerDef, supersedeSpec, SERVER_NAME } from './wire-targets.mjs';
import { parseJsonc, valueOf, getMember, insertMember, replaceMemberValue, prettyJson } from './jsonc-edit.mjs';

// Default managed entry name. Kept as the default so every existing 2-/3-arg
// caller (doctor.mjs's checkPull, the original wire eval) is bit-for-bit
// unchanged; wireMcp() now opts into 'agentic-brain' explicitly.
const DEFAULT_NAME = 'claude-mem';
const BRIDGE = join(REPO_ROOT, 'bin', 'mcp-bridge.cjs');

// Legacy default entry (mcp-bridge.cjs directly, no shim indirection). This
// stays the DEFAULT for wireJson()/wireToml() when no third `def` argument is
// given — evals/wire-test.mjs asserts against exactly this path, and
// bin/lib/doctor.mjs's checkPull() calls both functions with the 2-arg form.
// wireMcp() (below) is the only caller that opts into the real, registry-
// driven, stable-shim entry via wire-targets.mjs's serverDef().
export function serverDef() {
  return { command: 'node', args: [BRIDGE] };
}

// ---------------------------------------------------------------- backups ---

const BAK_KEEP = 3;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function utcStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

// Copy <file> to <file>.bak-YYYYMMDD-HHMMSS (the convention already on disk for
// claude_desktop_config.json), then prune to the BAK_KEEP newest of OUR backups.
// Only files matching our own naming pattern are ever deleted.
function backupFile(file) {
  if (!existsSync(file)) return null;
  const dir = dirname(file);
  const base = basename(file);
  let bak = join(dir, `${base}.bak-${utcStamp()}`);
  // Never clobber a backup made in the same second.
  for (let n = 1; existsSync(bak); n++) bak = join(dir, `${base}.bak-${utcStamp()}.${n}`);
  copyFileSync(file, bak);
  try {
    const re = new RegExp(`^${escapeRe(base)}\\.bak-\\d{8}-\\d{6}(\\.\\d+)?$`);
    const mine = readdirSync(dir).filter((f) => re.test(f)).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - BAK_KEEP))) {
      try { unlinkSync(join(dir, old)); } catch { /* pruning is best-effort */ }
    }
  } catch { /* pruning is best-effort */ }
  return bak;
}

export function backupAndWrite(file, content) {
  const bak = backupFile(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return bak;
}

// ------------------------------------------------------------ semantics -----

// "Already wired" is a semantic question, not a string comparison: a node upgrade
// or an absolute node path must not churn the user's config (spec §3, §8).
// `bridge` is the expected args[0] — the caller's `def.args[0]` — never a
// hardcoded constant, so this stays correct whether we're wiring the legacy
// default (mcp-bridge.cjs) or the registry's stable shim.
const isNodeCmd = (c) => typeof c === 'string' && (c === 'node' || /(^|[/\\])node(\.exe)?$/.test(c));
const wiredTo = (cmd, args, bridge) => isNodeCmd(cmd) && Array.isArray(args) && args[0] === bridge;
// A bare `node` only resolves for apps that inherit a login-shell PATH. Apps
// launched from the Dock get /usr/bin:/bin:/usr/sbin:/sbin, where Homebrew's
// node is absent, so the server never starts. When we have an absolute node to
// offer, an existing bare-`node` entry is stale and gets upgraded; an entry that
// already names some absolute node is left alone (no churn on node upgrades).
const needsAbsNode = (curCmd, defCmd) => isAbsolute(String(defCmd || '')) && !isAbsolute(String(curCmd || ''));

// The supersede gate (docs/specs/mcp-memory-server.md §8). Removing an entry
// from someone else's config is destructive and unrecoverable, so we only ever
// remove a `claude-mem` entry that WE demonstrably wrote: node + args[0] equal
// to one of the paths the registry says are ours (the ~/.agentic-brain shim, or
// an engine-relative bin/mcp-bridge.cjs). A `claude-mem` entry the user wired
// themselves — a different command, npx, a wrapper script, a path into some
// other checkout — fails this test and is left exactly where it is.
export const wiredToAny = (cmd, args, paths) =>
  Array.isArray(paths) && paths.some((p) => wiredTo(cmd, args, p));

// --------------------------------------------------------------- JSON -------

// Merge our managed server into a JSON mcpServers map, preserving everything
// else. If the file exists but does not parse we REFUSE to write: silently
// discarding a user's config is unrecoverable, a report is not.
//
// `opts.name` is the managed entry key (default 'claude-mem' — the legacy
// 2-/3-arg call used by doctor.mjs and the original eval suite behaves exactly
// as before). `opts.supersede` = { name, paths } optionally removes ONE other
// entry, and only when `wiredToAny()` proves that entry is ours. Removal and
// addition happen in the SAME backed-up write, so no config is ever left with
// neither server.
export function wireJson(file, write, def = serverDef(), opts = {}) {
  const NAME = opts.name || DEFAULT_NAME;
  const sup = opts.supersede && opts.supersede.name && opts.supersede.name !== NAME ? opts.supersede : null;
  const existed = existsSync(file);
  let obj = {};
  if (existed) {
    const raw = readFileSync(file, 'utf8');
    if (raw.trim() === '') {
      obj = {};
    } else {
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        const error = `malformed JSON: ${e.message}`;
        return {
          file, existed, ok: false, changed: false, status: 'failed', error,
          action: `FAIL malformed — could not parse ${basename(file)} (${e.message}); fix or remove it, then re-run brain onboard`,
          others: [],
        };
      }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        const error = 'malformed JSON: top level is not an object';
        return {
          file, existed, ok: false, changed: false, status: 'failed', error,
          action: `FAIL malformed — ${basename(file)} is not a JSON object; fix or remove it, then re-run brain onboard`,
          others: [],
        };
      }
      if (obj.mcpServers !== undefined &&
          (obj.mcpServers === null || typeof obj.mcpServers !== 'object' || Array.isArray(obj.mcpServers))) {
        const error = 'malformed JSON: "mcpServers" is not an object';
        return {
          file, existed, ok: false, changed: false, status: 'failed', error,
          action: `FAIL malformed — "mcpServers" in ${basename(file)} is not an object; fix or remove it, then re-run brain onboard`,
          others: [],
        };
      }
    }
  }
  obj.mcpServers = obj.mcpServers || {};
  const servers = obj.mcpServers;
  const cur = servers[NAME];
  const had = !!cur;
  const identical = had && JSON.stringify(cur) === JSON.stringify(def);
  const same = identical || (had && wiredTo(cur.command, cur.args, def.args[0]) && !needsAbsNode(cur.command, def.command));

  // Supersede decision — three outcomes, only the first ever deletes anything.
  let superseded = null;      // ours → removed in this same write
  let supersedeKept = null;   // the user's own → untouched, reported
  if (sup && Object.prototype.hasOwnProperty.call(servers, sup.name)) {
    const legacy = servers[sup.name] || {};
    if (wiredToAny(legacy.command, legacy.args, sup.paths)) superseded = sup.name;
    else supersedeKept = sup.name;
  }

  // A no-op is "our entry is right AND there is nothing of ours to remove".
  const noop = same && !superseded;

  const base = same
    ? (identical ? 'already wired' : 'already wired (customized)')
    : had ? 'would update entry' : existed ? 'would add entry' : 'would create config';
  const action = superseded
    ? (same ? `would remove superseded ${superseded} entry` : `${base} + remove superseded ${superseded}`)
    : base;

  let backup = null;
  if (write && !noop) {
    if (superseded) delete servers[superseded];
    servers[NAME] = def;
    backup = backupAndWrite(file, JSON.stringify(obj, null, 2) + '\n');
  }
  return {
    file, existed, ok: true, changed: write && !noop, backup, name: NAME, superseded, supersedeKept,
    status: noop ? 'unchanged' : write ? 'wrote' : 'would-write',
    action: write ? action.replace('would ', '') : action,
    others: Object.keys(servers).filter((k) => k !== NAME && k !== superseded),
  };
}

// --------------------------------------------------------- Kilo (JSONC) -------
//
// Kilo (CLI and VS Code extension share one backend) keeps MCP servers under a
// top-level `mcp` key — NOT `mcpServers` — in ~/.config/kilo/kilo.jsonc (or
// kilo.json / opencode.json[c] / config.json), as
//   "name": { "type": "local", "command": ["node", "<shim>"], "enabled": true }
// (packages/core/src/v1/config/mcp.ts; docs automate/mcp/using-in-cli.md). The
// file is JSONC and user-edited, so this is a TEXT splice (jsonc-edit.mjs): the
// only bytes that change are our own member. Same contract as wireJson():
// refuse to touch a file we cannot parse, back up before any write, inert when
// already wired.
export const kiloEntry = (def) => ({ type: 'local', command: [def.command, def.args[0]], enabled: true, timeout: 30000 });

// Semantic "already wired" for a Kilo entry (node + our shim, absolute node when we have one).
const kiloWiredTo = (e, def) => !!e && typeof e === 'object' && e.type === 'local' && Array.isArray(e.command) &&
  e.command.length >= 2 && wiredTo(e.command[0], [e.command[1]], def.args[0]) && !needsAbsNode(e.command[0], def.command);

export function wireKiloJson(file, write, def = serverDef(), opts = {}) {
  const NAME = opts.name || DEFAULT_NAME;
  const existed = existsSync(file);
  const fail = (error, action) => ({ file, existed, ok: false, changed: false, status: 'failed', error, action, others: [] });
  const raw = existed ? readFileSync(file, 'utf8') : '';
  const entry = kiloEntry(def);
  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';

  let next, base, others = [];
  let noop = false, identical = false, had = false;
  if (raw.trim() === '') {
    next = prettyJson({ $schema: 'https://app.kilo.ai/config.json', mcp: { [NAME]: entry } }).replace(/\n/g, eol) + eol;
    base = existed ? 'would add entry' : 'would create config';
  } else {
    const p = parseJsonc(raw);
    if (!p.ok) return fail(`malformed JSONC: ${p.error}`, `FAIL malformed — could not parse ${basename(file)} (${p.error}); fix or remove it, then re-run brain onboard`);
    if (p.root.kind !== 'object') return fail('malformed JSONC: top level is not an object', `FAIL malformed — ${basename(file)} is not a JSON object; fix or remove it, then re-run brain onboard`);
    const mcp = getMember(p.root, 'mcp');
    if (mcp && mcp.value.kind !== 'object') return fail('malformed JSONC: "mcp" is not an object', `FAIL malformed — "mcp" in ${basename(file)} is not an object; fix or remove it, then re-run brain onboard`);
    const cur = mcp ? getMember(mcp.value, NAME) : null;
    others = mcp ? mcp.value.members.map((m) => m.key).filter((k) => k !== NAME) : [];
    had = !!cur;
    if (cur) {
      const v = valueOf(cur.value);
      identical = JSON.stringify(v) === JSON.stringify(entry);
      noop = identical || kiloWiredTo(v, def);
    }
    if (noop) { next = raw; base = identical ? 'already wired' : 'already wired (customized)'; }
    else if (cur) { next = replaceMemberValue(raw, cur, entry, { eol }); base = 'would update entry'; }
    else if (mcp) { next = insertMember(raw, mcp.value, NAME, entry, { eol }); base = 'would add entry'; }
    else { next = insertMember(raw, p.root, 'mcp', { [NAME]: entry }, { eol }); base = 'would add entry'; }
    // Never ship a document we can no longer parse ourselves.
    if (!noop && !parseJsonc(next).ok) return fail('refused: generated JSONC would be invalid', `refused: writing ${basename(file)} would produce invalid JSON`);
  }
  let backup = null;
  if (write && !noop) backup = backupAndWrite(file, next);
  return {
    file, existed, ok: true, changed: write && !noop, backup, name: NAME, superseded: null, supersedeKept: null,
    status: noop ? 'unchanged' : write ? 'wrote' : 'would-write',
    action: write ? base.replace('would ', '') : base,
    others,
  };
}

// One call site for "write/probe this target's MCP entry", whatever its file shape.
// Rows with `mcpShape: 'kilo'` use the JSONC `mcp` map; everything else is
// unchanged (json → wireJson, toml → wireToml).
export function wireTargetConfig(target, file, write, def, opts) {
  if (target.mcpShape === 'kilo') return wireKiloJson(file, write, def, opts);
  return target.format === 'toml' ? wireToml(file, write, def, opts) : wireJson(file, write, def, opts);
}

// --------------------------------------------------------------- TOML -------
//
// A tiny structural scanner — enough to locate table headers reliably and to
// reject files we do not understand. It is deliberately NOT a TOML parser: we
// never re-emit the document, so comments, ordering and formatting of every
// other section pass through byte-identical (zero-dependency policy holds).

function readTomlString(text, i) {
  const q = text[i];
  const triple = text.slice(i, i + 3);
  if (triple === '"""' || triple === "'''") {
    const end = text.indexOf(triple, i + 3);
    if (end === -1) return null;
    return { end: end + 3, value: text.slice(i + 3, end), multiline: true };
  }
  let j = i + 1;
  let value = '';
  while (j < text.length) {
    const c = text[j];
    if (c === '\n') return null;            // unterminated single-line string
    if (q === '"' && c === '\\') {
      const n = text[j + 1];
      const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
      if (n in map) { value += map[n]; j += 2; continue; }
      if (n === 'u' || n === 'U') {         // \uXXXX / \UXXXXXXXX — keep raw
        const w = n === 'u' ? 4 : 8;
        value += text.slice(j, j + 2 + w); j += 2 + w; continue;
      }
      value += n; j += 2; continue;
    }
    if (c === q) return { end: j + 1, value, multiline: false };
    value += c; j++;
  }
  return null;
}

// Parse a table header starting at text[i] === '['. Returns the dotted key parts
// (quoted parts unquoted) or null if this is not a well-formed header line.
function readTomlHeader(text, i) {
  let j = i + 1;
  let aot = false;
  if (text[j] === '[') { aot = true; j++; }
  const parts = [];
  for (;;) {
    while (text[j] === ' ' || text[j] === '\t') j++;
    const c = text[j];
    if (c === undefined || c === '\n') return null;
    if (c === '"' || c === "'") {
      const s = readTomlString(text, j);
      if (!s || s.multiline) return null;
      parts.push(s.value); j = s.end;
    } else {
      let k = j;
      while (k < text.length && /[A-Za-z0-9_-]/.test(text[k])) k++;
      if (k === j) return null;
      parts.push(text.slice(j, k)); j = k;
    }
    while (text[j] === ' ' || text[j] === '\t') j++;
    if (text[j] === '.') { j++; continue; }
    if (text[j] === ']') {
      j++;
      if (aot) { if (text[j] !== ']') return null; j++; }
      break;
    }
    return null;
  }
  // Only whitespace or a comment may follow a header on its line.
  let k = j;
  while (text[k] === ' ' || text[k] === '\t' || text[k] === '\r') k++;
  if (text[k] !== undefined && text[k] !== '\n' && text[k] !== '#') return null;
  if (!parts.length) return null;
  return { parts, aot, end: j };
}

// Walk the document once, tracking quoted strings and array bracket depth, and
// record every line that opens a table at depth zero. Anything we cannot make
// sense of (unterminated string/array, junk header) is reported as an error —
// callers must then refuse to write.
export function scanToml(text) {
  const headers = [];
  let i = 0, line = 0, atLineStart = true, depth = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; atLineStart = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '[' && atLineStart && depth === 0) {
      const hdr = readTomlHeader(text, i);
      if (!hdr) return { headers, error: `line ${line + 1}: malformed table header` };
      headers.push({ line, parts: hdr.parts, aot: hdr.aot });
      i = hdr.end; atLineStart = false; continue;
    }
    atLineStart = false;
    if (c === '"' || c === "'") {
      const s = readTomlString(text, i);
      if (!s) return { headers, error: `line ${line + 1}: unterminated string` };
      for (let k = i; k < s.end; k++) if (text[k] === '\n') line++;
      i = s.end; continue;
    }
    if (c === '[') { depth++; i++; continue; }
    if (c === ']') { depth--; if (depth < 0) return { headers, error: `line ${line + 1}: unbalanced ']'` }; i++; continue; }
    i++;
  }
  if (depth !== 0) return { headers, error: 'unterminated array — unbalanced [ ]' };
  return { headers, error: null };
}

const isHeaderFor = (p, name) => p.length === 2 && p[0] === 'mcp_servers' && p[1] === name;
const isSubTableFor = (p, name) => p.length > 2 && p[0] === 'mcp_servers' && p[1] === name;

// Extent of a managed block: the header line through the line before the next
// table header at bracket depth zero that is NOT one of that block's own
// sub-tables (so a stale [mcp_servers.<name>.env] is replaced with the block,
// never orphaned), or EOF. Trailing blank/comment lines are handed back so the
// next section keeps its own separator and its own comments.
function blockExtent(lines, headers, idx, name) {
  const start = headers[idx].line;
  let end = lines.length;
  for (let k = idx + 1; k < headers.length; k++) {
    if (isSubTableFor(headers[k].parts, name)) continue;
    end = headers[k].line;
    break;
  }
  while (end > start + 1) {
    const prev = lines[end - 1].trim();
    if (prev === '' || prev.startsWith('#')) end--;
    else break;
  }
  return { start, end };
}

// Read back the command / first arg of an existing block so "already wired" can
// be decided semantically instead of by string equality.
function blockIdentity(blockText) {
  const cmd = /^[ \t]*command[ \t]*=[ \t]*(.+?)[ \t]*(?:#.*)?$/m.exec(blockText);
  let command = null;
  if (cmd) {
    const s = readTomlString(cmd[1], 0);
    command = s && s.end === cmd[1].length ? s.value : null;
  }
  const args = /^[ \t]*args[ \t]*=[ \t]*\[([\s\S]*?)\]/m.exec(blockText);
  let arg0 = null;
  if (args) {
    const inner = args[1];
    const m = /["']/.exec(inner);
    if (m) {
      const s = readTomlString(inner, m.index);
      if (s) arg0 = s.value;
    }
  }
  return { command, arg0 };
}

// A bare TOML key if it can be one, a quoted key otherwise.
const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

// Ensure a single [mcp_servers.<name>] block in a TOML file, preserving the
// rest of the document exactly. `opts` mirrors wireJson(): `name` (default
// 'claude-mem') and `supersede` = { name, paths }. When a supersede block is
// present AND proven ours, its removal and our block's write are ONE edit of
// one buffer, followed by one re-scan and one backed-up write — the file is
// never observed with neither server.
export function wireToml(file, write, def = serverDef(), opts = {}) {
  const NAME = opts.name || DEFAULT_NAME;
  const sup = opts.supersede && opts.supersede.name && opts.supersede.name !== NAME ? opts.supersede : null;
  const existed = existsSync(file);
  // Generous timeouts: the first search is slow (cold-starts the index/worker),
  // longer than codex's short defaults — without these the tool call gets cancelled.
  const block = `[mcp_servers.${tomlKey(NAME)}]\ncommand = ${JSON.stringify(def.command)}\nargs = [${JSON.stringify(def.args[0])}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 180\n`;
  const cur = existed ? readFileSync(file, 'utf8') : '';

  const fail = (error, hint) => ({
    file, existed, ok: false, changed: false, status: 'failed', error,
    action: `FAIL malformed — ${hint}; fix or remove it, then re-run brain onboard`,
  });

  const scan = scanToml(cur);
  if (scan.error) return fail(`malformed TOML: ${scan.error}`, `could not parse ${basename(file)} (${scan.error})`);

  const indicesFor = (name) =>
    scan.headers.map((hd, i) => (isHeaderFor(hd.parts, name) ? i : -1)).filter((i) => i !== -1);

  const ours = indicesFor(NAME);
  if (ours.length > 1) {
    return fail(
      `duplicate [mcp_servers.${NAME}] blocks (lines ${ours.map((i) => scan.headers[i].line + 1).join(', ')})`,
      `${basename(file)} has ${ours.length} [mcp_servers.${NAME}] blocks — remove the extras`,
    );
  }

  const eol = /\r\n/.test(cur) ? '\r\n' : '\n';
  const lines = cur.split(/\r?\n/);
  const has = ours.length === 1;
  let span = null, identical = false, same = false;
  if (has) {
    span = blockExtent(lines, scan.headers, ours[0], NAME);
    const blockText = lines.slice(span.start, span.end).join('\n');
    identical = blockText.trim() === block.trim();
    const id = blockIdentity(blockText);
    same = identical || (wiredTo(id.command, id.arg0 === null ? [] : [id.arg0], def.args[0]) && !needsAbsNode(id.command, def.command));
  }

  // Supersede. Ambiguity is never resolved destructively: more than one block
  // with the legacy name (already invalid TOML) is reported and left alone.
  let superseded = null, supersedeKept = null, legacySpan = null;
  if (sup) {
    const legacy = indicesFor(sup.name);
    if (legacy.length === 1) {
      const s = blockExtent(lines, scan.headers, legacy[0], sup.name);
      const id = blockIdentity(lines.slice(s.start, s.end).join('\n'));
      if (wiredToAny(id.command, id.arg0 === null ? [] : [id.arg0], sup.paths)) {
        superseded = sup.name; legacySpan = s;
      } else supersedeKept = sup.name;
    } else if (legacy.length > 1) supersedeKept = sup.name;
  }

  const noop = same && !superseded;

  const base = same
    ? (identical ? 'already wired' : 'already wired (customized)')
    : has ? 'would update block' : existed ? 'would add block' : 'would create config';
  const action = superseded
    ? (same ? `would remove superseded ${superseded} block` : `${base} + remove superseded ${superseded}`)
    : base;

  let backup = null;
  if (write && !noop) {
    // One buffer, edits applied back-to-front so earlier line indices stay valid.
    let out = lines.slice();
    const edits = [];
    if (has) edits.push({ start: span.start, end: span.end, rep: block.replace(/\n$/, '').split('\n') });
    if (superseded) edits.push({ start: legacySpan.start, end: legacySpan.end, rep: [] });
    edits.sort((a, b) => b.start - a.start);
    for (const e of edits) {
      let s = e.start;
      if (e.rep.length === 0) {
        // A pure removal would otherwise leave the blank line that separated the
        // block from its neighbour doubled up (or trailing at EOF). Collapse it.
        if (e.end >= out.length) { while (s > 0 && out[s - 1].trim() === '') s--; }
        else if (s > 0 && out[s - 1].trim() === '' && out[e.end].trim() === '') s--;
      }
      out = [...out.slice(0, s), ...e.rep, ...out.slice(e.end)];
    }
    let next = out.join(eol);
    if (!has) {
      const tail = block.replace(/\n/g, eol);
      next = next.trimEnd() + (next.trim() ? eol + eol : '') + tail;
    }
    // Never ship a document we can no longer parse ourselves.
    const after = scanToml(next);
    if (after.error) return fail(`refused: generated TOML would be invalid (${after.error})`, `writing ${basename(file)} would produce invalid TOML (${after.error})`);
    backup = backupAndWrite(file, next);
  }
  return {
    file, existed, ok: true, changed: write && !noop, backup, name: NAME, superseded, supersedeKept,
    status: noop ? 'unchanged' : write ? 'wrote' : 'would-write',
    action: write ? action.replace('would ', '') : action,
  };
}

// Registry-driven (docs/specs/auto-wiring.md §3/§4): walks every DETECTED
// target (bin/lib/wire-targets.mjs) instead of two hardcoded tools, and
// writes the registry's own serverDef() — the stable ~/.agentic-brain/
// bridge.cjs shim, never a repo-relative path. Per-target dispatch is by
// `format` ('json'|'toml'); `serversKey` is documentation of which key each
// format's writer manages (wireJson always manages `mcpServers`, wireToml
// always manages `[mcp_servers.claude-mem]` — every registry row's
// serversKey agrees with that by construction, enforced by
// evals/wire-targets-test.mjs).
//
// The three Claude Code profiles are wired like everyone else: their pull is
// a user-scope `mcpServers` entry in <config dir>/.claude.json. (They used to
// be skipped as "native (claude-mem plugin) — verify only", which left every
// Claude Code session without brain_recall/brain_context; `capture: 'native'`
// describes how observations arrive, not how the MCP tools are exposed.)
//
// FAIL rows never abort the others (spec §4): the outer `ok` stays true,
// only the per-row `ok` goes false. An undetected tool (config dir absent)
// is not in detectedTargets() at all here, so — to keep `results` a complete
// per-registry-row report the way the old two-tool version was — we still
// walk the FULL TARGETS list and emit a `skipped (not installed)` row for
// anything detectedTargets() left out.
export function wireMcp({ write = false, log = () => {} } = {}) {
  // docs/specs/mcp-memory-server.md §8: what we register is now THIS project's
  // own memory server (`agentic-brain`, read+write), pointing at the stable
  // ~/.agentic-brain/server.cjs shim — and in the same write we drop the
  // `claude-mem` bridge entry wherever it is provably one of ours, so no client
  // ever sees two competing "search my memory" toolsets.
  // Wire an absolute node (bridgehome.mjs explains why a bare `node` breaks GUI
  // apps). Falls back to the registry's bare def only when no node is found.
  const def = brainServerDef();
  let nodeWarning = null;
  try {
    const node = resolveNodeBinary();
    def.command = node.path;
    nodeWarning = node.warning;
  } catch (e) {
    nodeWarning = e.message;
  }
  if (nodeWarning) log(`  ⚠️  ${nodeWarning}`);
  const opts = { name: SERVER_NAME, supersede: supersedeSpec() };
  const bridge = def.args[0];
  // Only a hard stop for real writes: onboard's order is installBridgeHome()
  // THEN wireMcp({write:true}), so by the time a real write happens the shim
  // exists. A dry-run preview must work even before the shim is installed
  // (that's the whole point of previewing 'brain onboard --dry-run' on a
  // machine that has never been onboarded) — wireJson/wireToml with
  // write:false never touch disk, so there is nothing unsafe about computing
  // the plan against a bridge path that doesn't exist yet.
  if (write && !existsSync(bridge)) return { ok: false, error: `server shim missing: ${bridge} — run: brain onboard` };

  const detected = new Set(detectedTargets().map((t) => t.id));
  const results = [];

  for (const target of TARGETS) {
    if (!detected.has(target.id)) {
      let file;
      try { file = target.configPath(); } catch { file = '(unknown)'; }
      results.push({
        tool: target.name, id: target.id, installed: false,
        action: 'skipped (not installed)', file, ok: true, changed: false, status: 'skipped',
      });
      continue;
    }

    const file = target.configPath();
    const r = wireTargetConfig(target, file, write, def, opts);
    results.push({ tool: target.name, id: target.id, installed: true, restart: target.restart, ...r });
    if (write) log(`  ${target.name}: ${r.action} → ${r.file}`);
  }

  return {
    ok: true,
    // `bridge` keeps its meaning for existing callers: the one absolute path we
    // just wired every config at. It is now the server shim, not the bridge shim.
    bridge, server: bridge, serverName: SERVER_NAME, command: def.command, nodeWarning, wrote: write, results,
    superseded: results.filter((r) => r.superseded).map((r) => r.id),
    supersedeKept: results.filter((r) => r.supersedeKept).map((r) => r.id),
  };
}
