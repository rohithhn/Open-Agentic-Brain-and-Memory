#!/usr/bin/env node
'use strict';
// Open Agentic Brain and Memory — stable MCP bridge shim.
//
// This file is GENERATED. It is copied verbatim from <engine>/bin/templates/
// bridge-shim.cjs to ~/.agentic-brain/bridge.cjs by `brain onboard`. Edit the
// template in the repo, not this copy — the next onboard overwrites it.
//
// WHY IT EXISTS
// Every tool's MCP config (Codex TOML, Claude Desktop JSON, Cursor, Antigravity …)
// must name an absolute path to a stdio server. Pointing them straight at the
// clone bakes one user's checkout path into their config: move or rename the
// clone and every tool silently gets a dead MCP server. So configs point HERE
// — a path that never moves — and this shim reads a one-line pointer file next
// to it (`engine-path`) to find the current clone. Moving the repo is then
// repaired by re-running `brain onboard`, which rewrites ONE pointer file and
// touches zero tool configs.
//
// PROTOCOL RULE
// This process IS the MCP stdio server as far as the host app is concerned.
// stdout is the JSON-RPC framing channel and belongs exclusively to the
// delegate. Nothing in this file may write to stdout — not a log line, not a
// newline. All diagnostics go to stderr, which MCP hosts surface as server logs.
//
// IN-PROCESS require() vs. spawning a child — deliberate choice: require().
// <engine>/bin/mcp-bridge.cjs is a plain top-level script (resolve newest
// claude-mem plugin, then spawn its mcp-server.cjs with stdio:'inherit' and
// forward SIGTERM/SIGINT/SIGHUP, exiting with the child's code/signal).
// Requiring it runs exactly that in this process, so this shim BECOMES the
// bridge: same pid, same fds, same signal handlers, same exit code — one
// process instead of two, and zero stdio plumbing to get wrong (a re-piped
// stdout is precisely how MCP framing gets corrupted). Spawning would only buy
// crash isolation we do not want anyway: if the bridge dies the server is dead,
// and the host must see that immediately rather than talk to a live husk.
// Requiring is safe because mcp-bridge.cjs is CommonJS, dependency-free, never
// writes stdout itself, and its own failure path already exits non-zero.

const fs = require('fs');
const path = require('path');
const os = require('os');

const TAG = 'agentic-brain bridge: ';
const FIX = "  fix: run 'brain onboard' from your Open Agentic Brain and Memory clone.\n";

function die(msg) {
  // stderr only — never stdout (see PROTOCOL RULE above).
  process.stderr.write(TAG + msg + '\n' + FIX);
  process.exit(1); // exit, never hang: a hung stdio server looks like a healthy one.
}

// The shim always lives beside its pointer file, so its own location is the
// stable home — no homedir() guess, and a test harness can copy the pair
// anywhere. AGENTIC_BRAIN_ENGINE overrides for debugging / CI.
const HOME = __dirname;
const POINTER = path.join(HOME, 'engine-path');

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

let engine = process.env.AGENTIC_BRAIN_ENGINE || '';

if (!engine) {
  let raw;
  try {
    raw = fs.readFileSync(POINTER, 'utf8');
  } catch (e) {
    die(
      (e && e.code === 'ENOENT' ? 'pointer file missing: ' : 'cannot read pointer file: ') +
        POINTER +
        (e && e.code === 'ENOENT' ? '' : ' (' + e.code + ')')
    );
  }
  // First non-empty, non-comment line. Tolerant of a trailing newline or a
  // hand-added "# written by brain onboard" header.
  engine =
    raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) || '';
  if (!engine) die('pointer file is empty: ' + POINTER);
}

engine = path.resolve(expandHome(engine));
const target = path.join(engine, 'bin', 'mcp-bridge.cjs');

if (!fs.existsSync(engine)) {
  die('engine path no longer exists: ' + engine + '\n' + TAG + '  (the clone was moved, renamed, or deleted)');
}
if (!fs.existsSync(target)) {
  die('engine path exists but is not an Open Agentic Brain and Memory clone: ' + engine + '\n' + TAG + '  (missing bin/mcp-bridge.cjs)');
}

try {
  require(target);
} catch (e) {
  die('failed to start ' + target + '\n' + TAG + '  ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
}
