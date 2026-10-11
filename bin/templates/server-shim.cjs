#!/usr/bin/env node
'use strict';
// Agentic Brain — stable MCP *memory server* shim (sibling of bridge-shim.cjs).
//
// This file is GENERATED. It is copied verbatim from <engine>/bin/templates/
// server-shim.cjs to ~/.agentic-brain/server.cjs by `brain onboard`. Edit the
// template in the repo, not this copy — the next onboard overwrites it.
//
// WHY IT EXISTS
// Same problem as bridge.cjs, same fix: every tool's MCP config needs an
// absolute, never-moving path. This shim and bridge.cjs are installed side by
// side and share ONE pointer file (`engine-path`) — a moved/renamed clone is
// repaired for both servers by rewriting that single file, never a tool
// config. See docs/specs/mcp-memory-server.md §8.
//
// PROTOCOL RULE
// This process IS the MCP stdio server as far as the host app is concerned.
// stdout is the JSON-RPC framing channel and belongs exclusively to the
// delegate. Nothing in this file may write to stdout — not a log line, not a
// newline. All diagnostics go to stderr, which MCP hosts surface as server
// logs. (Identical rule to bridge-shim.cjs; repeated here because this file
// is read independently by whoever wires it.)
//
// CJS SHIM, ESM DELEGATE — dynamic import() is the bridge.
// <engine>/bin/mcp-server.mjs (this project's own server, docs/specs/
// mcp-memory-server.md) is an ES module — it needs top-level `import`, and
// likely imports other .mjs libs under bin/lib/. A CommonJS file cannot
// require() an ES module. The template stays .cjs (like bridge-shim.cjs, and
// so both shims install/verify/diff identically in bridgehome.mjs) and uses
// dynamic import() — the one standard way to load ESM from CJS — instead of
// converting the shim itself to .mjs. dynamic import() returns a Promise, and
// a plain CommonJS script has no top-level await, so the whole delegation is
// wrapped in an async IIFE; any rejection (syntax error, throw during the
// module's own startup) is funneled through the same die()-and-exit(1)
// contract as every other failure path below — never an unhandled rejection,
// never a crash that dumps a stack to stdout.
//
// IN-PROCESS import() vs. spawning a child — same reasoning as bridge-shim.cjs:
// one process, same pid/fds/signal handlers, same exit code, and no stdio
// plumbing to get wrong. mcp-server.mjs is expected to own its own signal
// handling and only exit when stdin closes (spec §7); this shim does not
// second-guess that — it imports once and gets out of the way.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const TAG = 'agentic-brain server: ';
const FIX = "  fix: run 'brain onboard' from your Agentic Brain clone.\n";

function die(msg) {
  // stderr only — never stdout (see PROTOCOL RULE above).
  process.stderr.write(TAG + msg + '\n' + FIX);
  process.exit(1); // exit, never hang: a hung stdio server looks like a healthy one.
}

// The shim always lives beside its pointer file (shared with bridge.cjs), so
// its own location is the stable home — no homedir() guess, and a test
// harness can copy the pair anywhere. AGENTIC_BRAIN_ENGINE overrides for
// debugging / CI, same env var the bridge shim honours.
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

if (!fs.existsSync(engine)) {
  die('engine path no longer exists: ' + engine + '\n' + TAG + '  (the clone was moved, renamed, or deleted)');
}
// The clone-identity marker is bin/mcp-bridge.cjs (always present, predates
// this server) rather than the server entry itself — that keeps "is this a
// real Agentic Brain clone" and "does this clone have the memory server yet"
// as two separate, separately-diagnosable failures (see the mcp-server.mjs
// check below).
if (!fs.existsSync(path.join(engine, 'bin', 'mcp-bridge.cjs'))) {
  die('engine path exists but is not an Agentic Brain clone: ' + engine + '\n' + TAG + '  (missing bin/mcp-bridge.cjs)');
}

const target = path.join(engine, 'bin', 'mcp-server.mjs');

if (!fs.existsSync(target)) {
  die(
    'engine path is a real clone but has no memory server yet: ' +
      target +
      '\n' +
      TAG +
      "  (bin/mcp-server.mjs is missing — update your clone, or this feature isn't built in this checkout yet)"
  );
}

(async () => {
  try {
    await import(pathToFileURL(target).href);
  } catch (e) {
    die('failed to start ' + target + '\n' + TAG + '  ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }
})();
