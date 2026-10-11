#!/usr/bin/env node
// Agentic Brain — stdio MCP memory server (docs/specs/mcp-memory-server.md §1/§7).
//
// Zero dependencies, hand-rolled JSON-RPC 2.0 over stdio. Framing matches
// bin/lib/doctor.mjs's spawnProbe() client (the one existing piece of this repo
// that already speaks MCP-over-stdio): ONE JSON object per line, newline-
// delimited, no embedded newlines — NOT LSP-style Content-Length framing. That
// choice is also what the MCP spec's stdio transport actually documents.
//
// PROTOCOL RULE (repeated from bridge-shim.cjs / server-shim.cjs — the same
// rule applies inside this process too): stdout is the JSON-RPC channel and
// belongs exclusively to it. Nothing else may ever write there — no
// console.log, no banner, no stray newline. All diagnostics go to stderr.
//
// Five tools: brain_remember / brain_recall / brain_context delegate to the
// already-built, already-tested semantics in bin/lib/remember.mjs and
// bin/lib/recall.mjs; brain_skills / brain_skill list and fetch saved skills.
// This file owns ONLY the protocol shell around them: framing, initialize/session-mint, tools/list, tools/call dispatch, prompts,
// per-call deadlines, and error-result shaping (tool failure vs protocol
// failure, per spec §7).
//
// Importing this module STARTS the server (bin/templates/server-shim.cjs
// dynamic-imports it and awaits that import) — so every import-time side
// effect below is deliberately confined to stdin/stdout wiring, never a
// synchronous DB open or a stdout write.

import {
  rememberObservation,
  REMEMBER_TOOL,
  platformSourceFor,
  newMcpSession,
} from './lib/remember.mjs';
import { recallSearch, taskContext, isOverviewRequest, MAX_RESULT_LIMIT, DEFAULT_RESULT_LIMIT } from './lib/recall.mjs';
import { warmSemantic, embeddingsDisabled } from './lib/embed.mjs';
import { MEMORY_DB } from './lib/paths.mjs';
// Static, because prompts/list must answer synchronously — a skill published as
// a prompt is what makes `/skill-name` appear in clients that have no
// filesystem hook (Claude Desktop, ChatGPT/Codex app).
import * as skillsLib from './lib/skills-sync.mjs';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

// ─────────────────────────── stderr-only logging (spec §7) ───────────────────
function log(...args) {
  try {
    process.stderr.write(`[mcp-server] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
  } catch {
    /* stderr itself can fail if the pipe is gone at shutdown — never let a log call crash us */
  }
}

// ─────────────────────────── framing (write side) ─────────────────────────────
// The ONLY function in this file allowed to touch process.stdout. Every frame
// is exactly one JSON.stringify'd object plus one trailing '\n' — never more,
// never less, and JSON.stringify never itself contains a raw newline for a
// well-formed JS object, so this cannot corrupt framing.
function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (e) {
    // The pipe is gone (host closed stdout without closing stdin, or similar).
    // Nothing useful to do — log and keep the process alive; stdin-close is
    // the only sanctioned exit path (spec §7).
    log('write to stdout failed:', e && e.message);
  }
}

function sendResult(id, result) {
  if (id === undefined) return; // notifications never get a response
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  if (id === undefined) return; // JSON-RPC: don't respond to notifications, even on error
  const err = { code, message };
  if (data !== undefined) err.data = data;
  send({ jsonrpc: '2.0', id, error: err });
}

// Tool-level failure: a valid JSON-RPC *result*, content marked isError. Per
// spec §7 this is how EVERY tool failure surfaces — never a thrown exception,
// never a protocol error. Protocol errors (-326xx) are reserved for
// violations of JSON-RPC/MCP itself (malformed envelope, unknown method,
// unknown tool name — see JSON-RPC/MCP method-dispatch below).
function toolErrorResult(id, text) {
  sendResult(id, { isError: true, content: [{ type: 'text', text: String(text) }] });
}

function toolTextResult(id, obj) {
  sendResult(id, { isError: false, content: [{ type: 'text', text: JSON.stringify(obj) }] });
}

// ─────────────────────────── request size / framing bounds (spec §7 "Bounded") ─
const MAX_LINE_BYTES = 1024 * 1024; // 1 MiB — generous for a tool call, far below a runaway payload
const MAX_BUFFER_BYTES = 4 * 1024 * 1024; // hard ceiling on unterminated input before we give up on the line

// ─────────────────────────── per-call deadlines (spec §7) ─────────────────────
const REMEMBER_DEADLINE_MS = 5000;
const RECALL_DEADLINE_MS = 10000;
// Hybrid search cold start (embed.mjs "cold start"; measured in
// evals/longmemeval/RESULTS.md). The first search in a fresh server loads the
// embedding model and every vector: ~0.25 s on an idle Mac, past the 10 s
// deadline above when two dozen servers start at once on a busy one. A cold
// start may hold searches up at most this long; then they answer with BM25
// while the load finishes in the background. The load starts only when a
// search arrives (or at initialize with BRAIN_EMBED_PREWARM=1): every app runs
// its own server, and one that never searches should not carry ~200 MB of model.
const SEMANTIC_BUDGET_MS = 2500;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─────────────────────────── server identity / capabilities ───────────────────
const PROTOCOL_VERSION = '2024-11-05';
let SERVER_VERSION = '0.0.0';
try {
  // Best-effort only — a missing/unreadable package.json must never block
  // startup or crash the server; version just falls back.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { join, dirname } = await import('node:path');
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg && typeof pkg.version === 'string') SERVER_VERSION = pkg.version;
} catch (e) {
  log('could not read package.json version (non-fatal):', e && e.message);
}

const SERVER_INFO = { name: 'agentic-brain', version: SERVER_VERSION };

const PROMPT_NAME = 'load-my-brain';
// The CLIs capture themselves — we read their transcript files off disk. The
// desktop apps cannot be captured that way: Claude Desktop keeps conversations
// server-side (its local IndexedDB holds no message text), and the ChatGPT app
// encrypts its local conversation store. So for those two surfaces the only
// honest write path is an explicit one the user invokes, which is this prompt.
const SAVE_PROMPT_NAME = 'save-to-brain';
const PROMPTS = [
  {
    name: PROMPT_NAME,
    description: 'Load relevant memory context for the current task before continuing.',
    arguments: [
      { name: 'task', description: 'One-line summary of what you are about to work on', required: false },
    ],
  },
  {
    name: SAVE_PROMPT_NAME,
    description: 'Save what we worked out in this conversation into your Agentic Brain.',
    arguments: [
      { name: 'project', description: 'Project to file it under (defaults to a sensible guess)', required: false },
    ],
  },
];

function savePromptResult(args) {
  const project = (args && typeof args.project === 'string' && args.project.trim()) || '';
  return {
    description: 'Instructs the model to write this conversation\'s conclusions to the brain.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            'Call the brain_remember tool now to save what this conversation established.\n\n' +
            'Record conclusions, decisions, and things that would be expensive to work out again — ' +
            'not a transcript. Write a specific title, and put each durable fact in its own entry. ' +
            'Skip anything already obvious from the code or docs.\n' +
            (project ? `File it under project "${project}".\n` : 'Infer a sensible project name from what we discussed.\n') +
            '\nAfter saving, tell me in one line what you stored.',
        },
      },
    ],
  };
}

function promptGetResult(args) {
  const task = (args && typeof args.task === 'string' && args.task.trim()) || 'the current conversation';
  return {
    description: 'Instructs the model to pull relevant memory context via brain_context.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `Call the brain_context tool now with a one-line task description summarizing ${
              task === 'the current conversation' ? 'what we are about to work on' : task
            }. Use the returned context before continuing.`,
        },
      },
    ],
  };
}

// ─────────────────────────── session, minted once at initialize (spec §2.5) ───
// Per spec: "mint the session once at initialize". Before initialize, tool
// calls (which should not happen per MCP lifecycle, but a misbehaving client
// might) fall back to remember.mjs's own lazily-minted per-process session so
// a write still succeeds and groups sensibly instead of erroring out.
let mcpSession = null;
let platformSource = 'mcp_unknown';
let clientInfoName = '';

function handleInitialize(params) {
  const clientInfo = (params && params.clientInfo) || {};
  clientInfoName = typeof clientInfo.name === 'string' ? clientInfo.name : '';
  platformSource = platformSourceFor(clientInfoName);
  mcpSession = newMcpSession(platformSource, Date.now());
  log(`initialize: clientInfo=${JSON.stringify(clientInfo)} -> platform_source=${platformSource}`);
  maybePrewarm();
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {}, prompts: {} },
    serverInfo: SERVER_INFO,
    instructions: instructionsFor(platformSource),
  };
}

// Opt-in (BRAIN_EMBED_PREWARM=1): load the model in the background right after
// initialize, for a single long-lived server (a desktop app) that should have
// hybrid search from its very first call. Deferred past the initialize reply
// and skipped when semantic search is off or the store has no vectors.
let prewarmStarted = false;
function maybePrewarm() {
  if (prewarmStarted || process.env.BRAIN_EMBED_PREWARM !== '1' || embeddingsDisabled()) return;
  prewarmStarted = true;
  setImmediate(() => {
    const t0 = Date.now();
    warmSemantic({ dbPath: MEMORY_DB })
      .then((ok) => log(ok ? `semantic search warmed in ${Date.now() - t0}ms` : 'semantic warm-up skipped (no vectors, or model unavailable)'))
      .catch(() => {});
  });
}

// The CLIs capture themselves: a hook reads their transcripts off disk, so the
// model there never has to think about saving. The desktop apps have no such
// hook and no readable transcript, so whether anything is ever written depends
// entirely on this string. Hence the sharper wording for them — a soft "call it
// once per distinct outcome" competes with everything else in the prompt and
// loses. Everything below still describes the same tools.
// Sources whose sessions are captured from transcript files on disk by
// bin/lib/ingest.mjs. Anything NOT in this set — the desktop apps, and any
// unrecognised MCP client — has no capture channel at all.
const SELF_CAPTURING = new Set(['claude', 'claude_code', 'codex', 'cursor', 'gemini', 'antigravity', 'kilo']);

function instructionsFor(source) {
  const shared =
    'Use brain_recall for targeted lookups and brain_skills / brain_skill to find and run the ' +
    "user's saved skills.";
  if (SELF_CAPTURING.has(String(source || ''))) {
    return (
      'Agentic Brain memory: call brain_context at the start of substantive tasks; call ' +
      'brain_remember once per distinct outcome (decision, bugfix, discovery, stated preference), ' +
      "or whenever the user says 'remember this'. " + shared
    );
  }
  return (
    'Agentic Brain memory is active. This client has NO automatic transcript capture, so nothing ' +
    'is remembered unless you write it.\n' +
    '1. At the start of any substantive request, call brain_context with a one-line task summary ' +
    'and use what it returns.\n' +
    '2. Whenever the conversation settles something worth keeping — a decision, a fix, a discovery, ' +
    'a preference the user states, a conclusion that took real work — call brain_remember right ' +
    'then, without being asked and without asking permission. Save conclusions, not transcripts: a ' +
    'specific title and one entry per durable fact. Skip anything obvious from context.\n' +
    '3. Do not batch this to the end of the conversation; save as things are settled.\n' +
    shared
  );
}


// ─────────────────────────── tools/list ────────────────────────────────────────
const RECALL_TOOL = {
  name: 'brain_recall',
  description:
    "Search the user's cross-tool memory for something specific. Returns a short list of matching " +
    'observations (project, title, type, date, snippet, plus provenance: tool · day · project · file) — never the full stored text. ' +
    'Memories that are no longer current rank lower and carry a lifecycle label (e.g. "superseded by #id", "stale"). Use for ' +
    'targeted lookups; use brain_context instead when starting a new task.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    additionalProperties: false,
    properties: {
      query: { type: 'string', maxLength: 200 },
      project: { type: 'string', maxLength: 120 },
      limit: { type: 'integer', minimum: 1, maximum: MAX_RESULT_LIMIT, default: DEFAULT_RESULT_LIMIT },
      deep: {
        type: 'boolean', default: false,
        description: 'Slower (~2 s), more thorough search: a local model re-reads a wider set of candidates against the query. ' +
          'Use when the answer is spread over several memories (counts, totals, "all the times…") or a normal search missed it.',
      },
    },
  },
};

const CONTEXT_TOOL = {
  name: 'brain_context',
  description:
    "Call this FIRST, before answering, at the start of every conversation about the user's work, " +
    'projects, or plans — pass a one-line summary of the request. Returns the ranked memory context ' +
    'relevant to it (learnings, prior observations tagged [project · tool · day · file], workflows, wiki) as one markdown block, so you ' +
    'answer with what the user already decided instead of starting from zero. When the user asks ' +
    'to load all their memory (or for an overview of everything), pass task "load all my memory" to ' +
    'get the cross-project overview.',
  inputSchema: {
    type: 'object',
    required: ['task'],
    additionalProperties: false,
    properties: {
      task: { type: 'string', maxLength: 300 },
    },
  },
};

// Skills reach the CLIs by being linked into each tool's skills directory
// (`brain skills`). Desktop apps — Claude Desktop, the ChatGPT/Codex app — have
// no such directory, so for them the library is only reachable over MCP. These
// two tools are that path: list what exists, then fetch one in full.
const SKILLS_TOOL = {
  name: 'brain_skills',
  description:
    'List the skills available in the user\'s shared skill library — the same set their CLIs can ' +
    'load. Returns name + description for each. Call this when the user refers to one of "their ' +
    'skills", or to check whether a saved skill already covers the task before writing something new.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', maxLength: 120, description: 'optional filter over name and description' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
  },
};

const SKILL_TOOL = {
  name: 'brain_skill',
  description:
    'Fetch one skill from the user\'s library in full, by name, so you can follow its instructions. ' +
    'Use after brain_skills has identified the right one.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', maxLength: 120 },
    },
  },
};

const TOOLS = [REMEMBER_TOOL, RECALL_TOOL, CONTEXT_TOOL, SKILLS_TOOL, SKILL_TOOL];

function handleToolsList() {
  return { tools: TOOLS };
}

// Every skill in the library is also published as an MCP prompt. Clients that
// support prompts surface them as slash commands, which is what makes
// `/skill-name` work in Claude Desktop the way it already does in Claude Code —
// the CLIs get the same skills as files, but an app has no filesystem hook.
// Prefixed so a skill can never shadow `load-my-brain`.
const SKILL_PROMPT_PREFIX = 'skill:';

function skillPrompts() {
  try {
    const lib = resolveLibrarySync();
    if (!lib) return [];
    const { listSkills, readSkillMeta } = skillsLib;
    return listSkills(lib).map((s) => {
      const meta = readSkillMeta(lib, s);
      // Prompt descriptions land in a command palette; keep them one line.
      const d = (meta.description || '').replace(/\s+/g, ' ').trim();
      return {
        name: `${SKILL_PROMPT_PREFIX}${s}`,
        description: d.length > 300 ? d.slice(0, 297) + '…' : (d || `Run the ${s} skill.`),
        arguments: [
          { name: 'input', description: 'What you want the skill to work on', required: false },
        ],
      };
    });
  } catch { return []; }
}

// Loaded once per process; the library rarely changes mid-session and a sync
// read here keeps prompts/list cheap.
let libCache;
function resolveLibrarySync() {
  if (libCache !== undefined) return libCache;
  try { libCache = skillsLib.resolveLibrary(); } catch { libCache = null; }
  return libCache;
}

function handlePromptsList() {
  return { prompts: [...PROMPTS, ...skillPrompts()] };
}

function handlePromptsGet(params) {
  const name = params && params.name;
  if (name === PROMPT_NAME) return promptGetResult(params && params.arguments);
  if (name === SAVE_PROMPT_NAME) return savePromptResult(params && params.arguments);

  if (typeof name === 'string' && name.startsWith(SKILL_PROMPT_PREFIX)) {
    const want = name.slice(SKILL_PROMPT_PREFIX.length);
    const lib = resolveLibrarySync();
    const match = lib ? skillsLib.listSkills(lib).find((s) => s === want) : null;
    if (match) {
      const file = nodePath.join(lib, match, 'SKILL.md');
      let body = '';
      try { body = nodeFs.readFileSync(file, 'utf8'); } catch {}
      const input = (params && params.arguments && params.arguments.input) || '';
      const text =
        `You are running the user's saved skill "${match}" from their Agentic Brain skill library.\n` +
        `Follow its instructions for the current request.\n\n` +
        (input ? `The user's input for this skill:\n${String(input).slice(0, 2000)}\n\n` : '') +
        `--- SKILL.md (${match}) ---\n${body.slice(0, 60000)}`;
      return {
        description: `Skill: ${match}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      };
    }
  }

  const e = new Error(`unknown prompt: ${JSON.stringify(name)}`);
  e.rpcCode = -32602;
  throw e;
}

// ─────────────────────────── tools/call dispatch ───────────────────────────────
// Every branch here returns/throws only via toolErrorResult (a valid JSON-RPC
// result) — a thrown JS error escaping this function is caught by the caller
// and turned into a JSON-RPC PROTOCOL error instead, which would be wrong for
// a tool-level failure. So every awaited call below is individually guarded.
async function handleToolsCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};

  if (name === 'brain_remember') {
    // The brain's own headless runs (distiller, learning drafts, explain) set
    // BRAIN_DISTILLER=1 and the CLI hands its env to this server. A write from
    // one of them would be the self-capture loop by another door.
    if (process.env.BRAIN_DISTILLER === '1') {
      toolTextResult(id, { saved: false, reason: 'internal brain run — memory writes are disabled' });
      return;
    }
    try {
      const result = await withTimeout(
        rememberObservation(args, {
          session: mcpSession || undefined,
          platformSource: mcpSession ? mcpSession.platformSource : platformSource,
          clientName: clientInfoName,
        }),
        REMEMBER_DEADLINE_MS,
        'brain_remember'
      );
      if (!result || result.ok === false) {
        toolErrorResult(id, (result && result.error) || 'brain_remember failed');
        return;
      }
      const out = { saved: !!result.saved };
      if (result.status === 'duplicate') { out.saved = false; out.reason = 'duplicate'; out.id = result.id; }
      else if (result.status === 'merged') { out.saved = true; out.merged = true; out.id = result.id; }
      else { out.saved = true; out.id = result.id; out.project = result.project; }
      if (result.supersedes && result.supersedes.length) out.supersedes = result.supersedes; // older same-topic rows it retired
      toolTextResult(id, out);
    } catch (e) {
      toolErrorResult(id, `brain_remember failed: ${e && e.message ? e.message : String(e)}`);
    }
    return;
  }

  if (name === 'brain_recall') {
    try {
      const out = await withTimeout(recallSearch({ ...args, semanticBudgetMs: SEMANTIC_BUDGET_MS }), RECALL_DEADLINE_MS, 'brain_recall');
      toolTextResult(id, out);
    } catch (e) {
      toolErrorResult(id, `brain_recall failed: ${e && e.message ? e.message : String(e)}`);
    }
    return;
  }

  if (name === 'brain_context') {
    try {
      // "load all my memory" / "everything" / "overview" is not a search: a
      // ranked keyword match on those words returns a few unrelated rows. Give
      // the cross-project overview instead (the same digest injected into
      // CLAUDE.md / AGENTS.md), and say how to go deeper on any one project.
      if (isOverviewRequest(args && args.task)) {
        const { buildDigest } = await import('./lib/inject.mjs');
        const digest = await withTimeout(Promise.resolve().then(() => buildDigest()), RECALL_DEADLINE_MS, 'brain_context');
        toolTextResult(id, {
          overview: true,
          block: digest || '(the brain is empty so far — it fills as you work)',
          next: 'For detail on one project, call brain_recall with project=<name>, or brain_context with a specific task.',
        });
        return;
      }
      const out = await withTimeout(taskContext({ ...args, semanticBudgetMs: SEMANTIC_BUDGET_MS }), RECALL_DEADLINE_MS, 'brain_context');
      toolTextResult(id, out);
    } catch (e) {
      toolErrorResult(id, `brain_context failed: ${e && e.message ? e.message : String(e)}`);
    }
    return;
  }

  if (name === 'brain_skills') {
    try {
      const { resolveLibrary, listSkills, readSkillMeta } = await import('./lib/skills-sync.mjs');
      const lib = resolveLibrary();
      if (!lib) { toolTextResult(id, { skills: [], count: 0, note: 'no skill library on this machine' }); return; }
      const q = String(args && args.query || '').toLowerCase().trim();
      const limit = Math.min(Math.max(Number(args && args.limit) || 200, 1), 200);
      const all = listSkills(lib).map((s) => {
        const m = readSkillMeta(lib, s);
        return { name: s, description: m.description };
      });
      const hits = (q ? all.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q)) : all).slice(0, limit);
      toolTextResult(id, { skills: hits, count: hits.length, total: all.length, library: lib });
    } catch (e) {
      toolErrorResult(id, `brain_skills failed: ${e && e.message ? e.message : String(e)}`);
    }
    return;
  }

  if (name === 'brain_skill') {
    try {
      const { resolveLibrary, listSkills } = await import('./lib/skills-sync.mjs');
      const { readFileSync, existsSync } = await import('node:fs');
      const { join, resolve, sep } = await import('node:path');
      const lib = resolveLibrary();
      if (!lib) { toolErrorResult(id, 'no skill library on this machine'); return; }
      const want = String(args && args.name || '').trim();
      // Resolve through the real listing rather than trusting the argument:
      // this is a filesystem read driven by model-supplied text, so the name
      // must match a skill that actually exists, and the resolved path must
      // still sit inside the library.
      const match = listSkills(lib).find((s) => s.toLowerCase() === want.toLowerCase());
      if (!match) { toolErrorResult(id, `no skill named "${want}" — call brain_skills to list them`); return; }
      const file = resolve(join(lib, match, 'SKILL.md'));
      if (!file.startsWith(resolve(lib) + sep) || !existsSync(file)) { toolErrorResult(id, `skill "${match}" has no SKILL.md`); return; }
      const body = readFileSync(file, 'utf8');
      toolTextResult(id, { name: match, path: file, content: body.slice(0, 60000) });
    } catch (e) {
      toolErrorResult(id, `brain_skill failed: ${e && e.message ? e.message : String(e)}`);
    }
    return;
  }

  // Unknown tool name: a tool-level error result, NOT a protocol error — the
  // envelope (tools/call) was well-formed; it just named a tool we don't have.
  toolErrorResult(id, `unknown tool: ${JSON.stringify(name)}`);
}

// ─────────────────────────── one request, dispatched ───────────────────────────
async function dispatch(msg) {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        sendResult(id, handleInitialize(params));
        return;
      case 'notifications/initialized':
      case 'initialized':
        return; // notification; no response
      case 'tools/list':
        sendResult(id, handleToolsList());
        return;
      case 'tools/call':
        if (!params || typeof params.name !== 'string') {
          sendError(id, -32602, 'invalid params: tools/call requires { name, arguments? }');
          return;
        }
        await handleToolsCall(id, params);
        return;
      case 'prompts/list':
        sendResult(id, handlePromptsList());
        return;
      case 'prompts/get':
        try {
          sendResult(id, handlePromptsGet(params));
        } catch (e) {
          sendError(id, e.rpcCode || -32602, e.message || 'invalid prompt request');
        }
        return;
      case 'ping':
        sendResult(id, {});
        return;
      default:
        sendError(id, -32601, `method not found: ${method}`);
        return;
    }
  } catch (e) {
    // Absolute backstop for this one request: never let a bug in a handler
    // take the whole process down (spec §7 "never a broken chat"). A genuine
    // internal error here is still a protocol-level failure to answer the
    // request that was asked, so -32603 (Internal error) is correct — tool
    // *results* are handled entirely inside handleToolsCall and never reach
    // this catch.
    log('unhandled dispatch error:', e && e.stack ? e.stack : e);
    sendError(id, -32603, `internal error: ${e && e.message ? e.message : String(e)}`);
  }
}

// ─────────────────────────── stdin framing (read side) ────────────────────────
let inBuf = '';

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (Buffer.byteLength(trimmed, 'utf8') > MAX_LINE_BYTES) {
    // Malformed/hostile input: bounded, and we cannot know the request id
    // without parsing (which we are refusing to do for an oversized frame),
    // so there is no id to reply to — log and move on. The server survives.
    log(`rejected oversized request line (${Buffer.byteLength(trimmed, 'utf8')} bytes > ${MAX_LINE_BYTES})`);
    return;
  }

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (e) {
    // Malformed JSON on stdin: JSON-RPC parse error, per spec. No id is
    // knowable, so id is null per the JSON-RPC 2.0 spec for parse errors.
    // Server survives and keeps reading subsequent lines.
    sendError(null, -32700, `parse error: ${e.message}`);
    return;
  }

  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    sendError(msg && msg.id, -32600, 'invalid request: not a well-formed JSON-RPC 2.0 request');
    return;
  }

  // Dispatch async; a rejection inside dispatch() is already caught there,
  // but guard again here as an absolute backstop against a stray throw
  // between here and the try inside dispatch (e.g. malformed structuring of
  // dispatch itself in a future edit) — this is the "never crash the user's
  // chat" contract from spec §7, enforced at every layer.
  dispatch(msg).catch((e) => {
    log('dispatch() rejected outside its own guard:', e && e.stack ? e.stack : e);
    try { sendError(msg.id, -32603, 'internal error'); } catch {}
  });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inBuf += chunk;
  if (Buffer.byteLength(inBuf, 'utf8') > MAX_BUFFER_BYTES) {
    log(`stdin buffer exceeded ${MAX_BUFFER_BYTES} bytes without a newline — dropping buffer`);
    inBuf = '';
    return;
  }
  let idx;
  while ((idx = inBuf.indexOf('\n')) !== -1) {
    const line = inBuf.slice(0, idx);
    inBuf = inBuf.slice(idx + 1);
    handleLine(line);
  }
});

// The ONLY sanctioned exit: stdin closes (spec §7 "The server exits only when
// stdin closes"). No idle timers, no other exit path.
process.stdin.on('end', () => {
  log('stdin closed — exiting');
  process.exit(0);
});
process.stdin.on('error', (e) => {
  log('stdin error (treating as close):', e && e.message);
  process.exit(0);
});

// ─────────────────────────── absolute backstops (spec §7 "never crash") ───────
process.on('uncaughtException', (e) => {
  log('uncaughtException (server continues):', e && e.stack ? e.stack : e);
});
process.on('unhandledRejection', (e) => {
  log('unhandledRejection (server continues):', e && e.stack ? e.stack : e);
});

log(`agentic-brain mcp server started (pid=${process.pid})`);
