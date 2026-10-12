// Detect every AI tool / CLI on this machine and where it stores data — the
// engine behind the OS "Detect" and "Locate data" steps. Fast: stats + shallow
// counts only, never walks huge cache trees.
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { binOnPath } from './wire-targets.mjs';
import { appSupportDir } from './platform.mjs';
import { kiloDataDir, kiloHostGroupInstalled } from './kilo.mjs';

const HOME = homedir();
const h = (...p) => join(HOME, ...p);

// Registry of known tools. `data` = where sessions/history live; `sessions` =
// subpath we count for a rough session/chat number; `sync` = lightweight globs
// worth backing up (configs + session logs, NOT model/blob caches); `markers`
// = optional product-specific paths a row's `detect()` keys on instead of the
// default "does paths[] exist" check, for tools that share a home dir with
// another product; `detect()` = optional override of the default check.
export const TOOLS = [
  { id: 'claude_code', name: 'Claude Code', kind: 'cli', paths: [h('.claude')], sessions: 'projects', sync: ['settings.json', 'CLAUDE.md', '.mcp.json'] },
  { id: 'claude_work', name: 'Claude Code (work)', kind: 'cli', paths: [h('.claude-work')], sessions: 'projects', sync: ['settings.json'] },
  { id: 'claude_personal', name: 'Claude Code (personal)', kind: 'cli', paths: [h('.claude-personal')], sessions: 'projects', sync: ['settings.json'] },
  { id: 'claude_desktop', name: 'Claude Desktop', kind: 'app', paths: [appSupportDir('Claude')], sessions: '', sync: ['claude_desktop_config.json'] },
  { id: 'claude_vscode', name: 'Claude in VS Code', kind: 'ide', paths: [appSupportDir('Code', 'User')], sessions: '', sync: [] },
  { id: 'claude_mem', name: 'claude-mem', kind: 'memory', paths: [h('.claude-mem')], sessions: '', sync: ['settings.json'] },
  { id: 'codex', name: 'OpenAI Codex', kind: 'cli', paths: [h('.codex')], sessions: 'sessions', sync: ['config.toml', 'config.json'] },
  // Antigravity CLI is the Go binary ~/.local/bin/agy. It owns
  // ~/.gemini/config/ and ~/.gemini/antigravity-cli/ (history.jsonl,
  // conversations/, mcp/) — NOT ~/.antigravity/, which is the separate
  // Antigravity IDE (see antigravity_ide below). Sessions are the per-
  // conversation .db files under antigravity-cli/conversations/. Google's
  // separate `gemini` CLI (the ~/.gemini root files) is not a supported tool,
  // so this row keys on ~/.gemini/antigravity-cli, never on ~/.gemini/ alone.
  { id: 'antigravity', name: 'Antigravity CLI (agy)', kind: 'cli', paths: [h('.gemini', 'antigravity-cli')], sessions: 'conversations', sync: [] },
  // Antigravity IDE: a VS Code fork's user dir (argv.json, extensions/).
  // Detect-only — it is never a wiring target (no MCP config of its own to
  // manage, no sessions to ingest).
  { id: 'antigravity_ide', name: 'Antigravity IDE', kind: 'ide', paths: [h('.antigravity')], sessions: '', sync: [] },
  { id: 'cursor', name: 'Cursor', kind: 'ide', paths: [h('.cursor')], sessions: '', sync: [] },
  // Kilo Code (extension in VS Code / Cursor / forks, and the CLI) is ONE backend with one
  // session DB (~/.local/share/kilo/kilo.db), so it is one linked tool, `kilo`, and one ingest
  // source. Detected by a host extension or a `kilo` binary — never by the data dir alone.
  {
    id: 'kilo', name: 'Kilo Code', kind: 'ide', paths: [kiloDataDir()], sessions: '', sync: [],
    detect: () => kiloHostGroupInstalled('vscode') || kiloHostGroupInstalled('cursor') || binOnPath('kilo') || binOnPath('kilocode'),
  },
  { id: 'openclaw', name: 'OpenClaw', kind: 'cli', paths: [h('.openclaw')], sessions: '', sync: [] },
  { id: 'aider', name: 'Aider', kind: 'cli', paths: [h('.aider')], sessions: '', sync: ['.aider.conf.yml'] },
  { id: 'ollama', name: 'Ollama (local models)', kind: 'local', paths: [h('.ollama')], sessions: 'models', sync: [] },
  { id: 'continue', name: 'Continue', kind: 'ide', paths: [h('.continue')], sessions: 'sessions', sync: ['config.json'] },
  { id: 'goose', name: 'Goose', kind: 'cli', paths: [h('.config', 'goose')], sessions: 'sessions', sync: ['config.yaml'] },
];

export const API_KEYS = [
  { id: 'anthropic', name: 'Anthropic API', env: 'ANTHROPIC_API_KEY' },
  { id: 'openai', name: 'OpenAI API', env: 'OPENAI_API_KEY' },
  { id: 'openrouter', name: 'OpenRouter', env: 'OPENROUTER_API_KEY' },
  { id: 'gemini_api', name: 'Google Gemini API', env: 'GEMINI_API_KEY' },
  { id: 'groq', name: 'Groq', env: 'GROQ_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', env: 'DEEPSEEK_API_KEY' },
  { id: 'mistral', name: 'Mistral', env: 'MISTRAL_API_KEY' },
];

function safeCount(dir) {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.')).length;
  } catch {
    return 0;
  }
}

function iso(ts) {
  return ts ? new Date(ts).toISOString() : null;
}

export function scanTool(t) {
  const path = t.paths.find((p) => existsSync(p)) || t.paths[0];
  // Default rule: detected iff any of paths[] exists. A row may override with
  // a pure `detect(): boolean` when the parent dir is shared with another
  // product and its mere existence would false-positive (e.g. `kilo`
  // above) — mirrors wire-targets.mjs's `detectedTargets()` predicate style.
  const detected = typeof t.detect === 'function' ? !!t.detect() : t.paths.some((p) => existsSync(p));
  if (!detected) return { ...t, path, detected: false };
  let lastActive = null;
  try {
    lastActive = statSync(path).mtimeMs;
  } catch {}
  let sessions = 0;
  if (t.sessions) {
    const sd = join(path, t.sessions);
    if (existsSync(sd)) sessions = safeCount(sd);
  }
  return { id: t.id, name: t.name, kind: t.kind, path, detected: true, sessions, lastActive: iso(lastActive) };
}

export function detectAll() {
  const tools = TOOLS.map(scanTool);
  const keys = API_KEYS.map((k) => ({ ...k, present: !!process.env[k.env] }));
  return {
    tools,
    keys,
    detectedCount: tools.filter((t) => t.detected).length,
    total: tools.length,
  };
}

export function toolById(id) {
  return TOOLS.find((t) => t.id === id);
}

// Opt-out model: every DETECTED tool is linked by default; a tool is only
// unlinked if the user explicitly turned it off (config.unlinkedTools).
export function effectiveLinked(config = {}) {
  const off = new Set(config.unlinkedTools || []);
  return TOOLS.map(scanTool)
    .filter((t) => t.detected && !off.has(t.id))
    .map((t) => t.id);
}
