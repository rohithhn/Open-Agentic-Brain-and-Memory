#!/usr/bin/env node
// claude-mem MCP bridge. Locates the installed claude-mem plugin's MCP search
// server (newest version, across ~/.claude and ~/.codex plugin caches) and execs
// it over stdio. This gives ANY MCP-capable CLI (Antigravity/agy, Codex, …) the
// same live, searchable access to your memory DB that Claude Code gets natively.
//
// Wired into each tool's MCP config by `brain wire-mcp`. Using a stable bridge
// path (this file) means the wiring never goes stale when claude-mem updates —
// the newest version is resolved at launch time. Mirrors claude-mem's own resolver.
const fs = require('fs');
const p = require('path');
const o = require('os');
const c = require('child_process');

const h = o.homedir();
const C = process.env.CLAUDE_CONFIG_DIR || p.join(h, '.claude');

// newest-first version dirs (names starting with a digit) under a cache root
const versions = (root) => {
  try {
    return fs
      .readdirSync(root)
      .filter((n) => /^\d/.test(n))
      .map((n) => p.join(root, n))
      .filter((z) => { try { return fs.statSync(z).isDirectory(); } catch { return false; } })
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch { return []; }
};

const candidates = [
  ...versions(p.join(h, '.codex/plugins/cache/claude-mem-local/claude-mem')),
  ...versions(p.join(h, '.codex/plugins/cache/thedotmack/claude-mem')),
  ...versions(p.join(C, 'plugins/cache/thedotmack/claude-mem')),
  p.join(C, 'plugins/marketplaces/thedotmack/plugin'),
];

let root = null;
for (const k of candidates) {
  const r = fs.existsSync(p.join(k, 'plugin', 'scripts')) ? p.join(k, 'plugin') : k;
  if (fs.existsSync(p.join(r, 'scripts', 'mcp-server.cjs'))) { root = r; break; }
}
if (!root) {
  process.stderr.write('claude-mem: mcp server not found (is the claude-mem plugin installed?)\n');
  process.exit(1);
}

const child = c.spawn(process.execPath, [p.join(root, 'scripts', 'mcp-server.cjs')], { stdio: 'inherit' });
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { try { child.kill(s); } catch {} });
child.on('exit', (code, sig) => {
  if (sig) { process.removeAllListeners(sig); try { process.kill(process.pid, sig); } catch { process.exit(1); } }
  else process.exit(code == null ? 0 : code);
});
