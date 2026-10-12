> Historical design note. It explains why the code is shaped the way it is; details may be out of date — the code and README are authoritative.
>
> **Update:** Google's separate Gemini CLI (`~/.gemini/settings.json`) is **no longer a supported target** — its registry row, detection, ingest and distiller provider were removed. Antigravity CLI (`agy`, which stores its data under `~/.gemini/config` and `~/.gemini/antigravity-cli`) is the supported product. An `agentic-brain` entry an older version left in `~/.gemini/settings.json` is harmless and is not migrated.

# Spec — Auto-wiring: every AI tool wired to the brain by one command

Status: **Ready to implement** · Date: 2026-08-06 · Supersedes: `desktop-app-support.md` §0/§3.2 (ChatGPT rows only)
Companion: `brain-init.md` (fresh-brain flow — this spec plugs into its step 8). **Specification only — no code here.**

Goal: a stranger clones the public repo, runs `install.sh`, and EVERY supported AI tool on their machine is
wired to their brain — push where a mechanism exists, pull everywhere MCP is supported — with zero manual
config editing. Re-running is a safe no-op.

---

## 0. Correction to `desktop-app-support.md` (record this, don't silently diverge)

That spec claims ChatGPT desktop has **no local stdio MCP support** (§0 row 2, §3.2 item 4). **Wrong.**
OpenAI's docs state the ChatGPT desktop app, Codex CLI, and IDE extension **share `~/.codex/config.toml`**,
and stdio servers are supported there; only ChatGPT **web** is remote-HTTPS-only. Verified on this machine:
`~/.codex/config.toml` already contains `[mcp_servers.claude-mem]` — **ChatGPT desktop pull works today,
for free, via the existing Codex wiring.** Consequences:
- ChatGPT desktop moves from "paste-digest only" to **pull ✅ (shared TOML) + optional paste-digest push**.
- §3.2's remote-tunnel option stays rejected. §3.1 (capture impossible — encrypted cache) stands unchanged.
- Implementer: append a dated correction note to `desktop-app-support.md` §0 pointing here (task T7).

## 1. Architecture

Two mechanisms, one registry, one indirection:

- **Push** (recall always present): `injectContext()` writes the managed `BRAIN:START/END` block into each
  tool's auto-loaded global instructions file. Already correct; gains no new targets here (neither desktop
  app auto-loads a local instructions file — do not fake one).
- **Pull** (model searches on demand): register the `claude-mem` MCP server in each tool's MCP config.
  Today `wireMcp()` hardcodes two targets; it becomes **registry-driven** (§3) and gains Claude Desktop,
  and Cursor.
- **Indirection** (§2): tool configs never embed the repo path; they point at a stable shim.

## 2. The absolute-path problem — stable shim, decided

Today every MCP entry embeds the absolute path of one clone (`<clone>/bin/mcp-bridge.cjs`). For a public
repo the path must resolve from the user's clone at wire time — and survive the repo moving later.

**Decision: a two-file stable home at `~/.agentic-brain/`, written/refreshed by `brain onboard`:**
- `~/.agentic-brain/engine-path` — one line, the absolute repo root (`REPO_ROOT` at onboard time).
- `~/.agentic-brain/bridge.cjs` — ~10-line shim: read `engine-path`, `require(<engine>/bin/mcp-bridge.cjs)`;
  if the pointer dangles, exit with a one-line stderr message naming the fix (`brain onboard`). The shim is
  copied from a template in the repo (`bin/templates/bridge-shim.cjs`) so updates flow on re-onboard.

All MCP configs point at the **shim**, never the repo. Repo moved ⇒ every tool breaks identically with one
legible error; the fix is one command (`brain onboard` from the new location rewrites only `engine-path` —
zero tool configs are touched, no TOML surgery). `brain doctor` detects a dangling pointer explicitly.

**Node path:** GUI apps (Claude Desktop, ChatGPT desktop) spawn MCP servers without a login-shell PATH, so
`command: "node"` can fail. Wire `command` = first existing of `/opt/homebrew/bin/node`,
`/usr/local/bin/node`, `process.execPath` (resolved at wire time; stable symlinks preferred over
version-pinned Homebrew cellar paths). Doctor re-checks it exists.

## 3. Per-tool wiring registry (`bin/lib/wire-targets.mjs`, data-only module)

Each row: `{ id, detect, pull: {file, format}, push: injectTarget|null, restart, backup }`. Gate every
target on its **tool dir existing** (not the config file — absent file in a present dir = create it).

| Tool | Detect gate | Pull config (format) | Push | Restart to pick up? |
|---|---|---|---|---|
| Claude Code ×3 profiles | `~/.claude`, `~/.claude-work`, `~/.claude-personal` | `~/.claude.json` / `<profile dir>/.claude.json` → `mcpServers` (JSON) — the user-scope file `claude mcp add --scope user` writes; **not** `.claude/.mcp.json` (never loaded). Was wrongly "verify only" until 2026-09-28, so no Claude Code session had `brain_recall` | `CLAUDE.md` per profile ✅ exists | next session |
| Codex CLI + **Codex app** + **ChatGPT desktop** | `~/.codex` | `~/.codex/config.toml` (TOML) — one entry serves all three | `~/.codex/AGENTS.md` ✅ exists (Codex only; ChatGPT ignores it) | CLI/app: next launch; ChatGPT: quit+reopen |
| Antigravity (agy) | `~/.gemini/config` | `~/.gemini/config/mcp_config.json` (JSON) ✅ exists | `~/.gemini/GEMINI.md` ✅ exists | next launch |
| Cursor | `~/.cursor` | `~/.cursor/mcp.json` (JSON) — **new**; verified on disk: `mcpServers` map, 3 servers, no claude-mem | per-repo `AGENTS.md` via `injectFolder()` only; **no global push** (Rules-for-AI live in Cursor's own DB — never touch) | reload window / restart |
| Claude Desktop | `~/Library/Application Support/Claude` | `claude_desktop_config.json` (JSON) — **new**; automates today's manual 11→12 edit | none exists — do not fake | **yes, quit+reopen** |

**Merge-not-overwrite is the law.** Required behavior = today's manual Claude Desktop edit: N existing
servers preserved byte-for-byte in meaning, 1 added. Concretely:

- **JSON (`wireJson`, hardened):** parse whole file, set only `mcpServers['claude-mem']`, rewrite.
  Preserves all other keys and server entries. **Fix required first:** today's `catch { obj = {} }` on
  malformed JSON silently **replaces the user's entire config** with a claude-mem-only file — on Claude
  Desktop that destroys 11 servers. New rule: unparseable config ⇒ **never write**, report
  `FAIL malformed — fix or delete <file>, then re-run brain onboard`, leave a `.bak` of nothing (no write
  happened). Accepted cosmetic change: re-serialization normalizes whitespace (JSON has no comments).
- **TOML (`wireToml`, rewritten):** manage exactly one `[mcp_servers.claude-mem]` block. **Fix required
  first:** the current update regex `\[mcp_servers\.claude-mem\][^\[]*` stops at the `[` inside
  `args = [...]`, so any update whose content changed (e.g. repo moved) **corrupts the file**, orphaning
  half the old block. New extent rule, line-based: block = header line through the line before the next
  line matching `/^\s*\[/` (or EOF), which also captures future sub-tables
  (`[mcp_servers.claude-mem.env]`). Never parse/re-emit the whole TOML — comments, ordering, and every
  other section pass through untouched. No TOML dependency added (zero-dep policy). Keep
  `startup_timeout_sec = 30` / `tool_timeout_sec = 180`.
- **Backup policy:** before ANY modifying write to a config the brain does not own, copy to
  `<file>.bak.<ISO-ts>` (precedent already on disk for Claude Desktop). Keep the 3 newest `.bak.*`, prune
  older. No-op runs (already-wired) make no backup and no write.
- **Server def** (all targets): `{ command: <abs node, §2>, args: ["~/.agentic-brain/bridge.cjs" expanded
  absolute] }`. "Already wired" compares semantically (command resolves to node + args[0] is the shim),
  not string-equality, so a node upgrade doesn't churn configs.

## 4. `brain onboard` v2 — contract

Keeps today's step list (detect → MCP → profiles/inject → watchers → daily sync → serve). Step 2 becomes
registry-driven and the whole command ends with a **per-tool report table**, one row per registry entry:

```
tool                 capture   push              pull (MCP)
Claude Code          native    ✅ injected        ✅ added (~/.claude.json) — new session to load
Claude Code (work)   native    ✅ injected        ✅ added (~/.claude-work/.claude.json) — new session to load
Codex / ChatGPT app  watcher   ✅ injected        ✅ already wired (~/.codex/config.toml)
Antigravity (agy)    watcher   ✅ injected        ✅ already wired
Cursor               timer     per-repo only     ✅ added (~/.cursor/mcp.json) — restart to load
Claude Desktop       ❌ n/a    ❌ n/a             ✅ added (12 servers: 11 kept + 1) — restart app
```

Rules: every row states did / skipped / why; `skipped (not installed)` for undetected tools; `FAIL` rows
(malformed config, unwritable) never abort the other rows. Re-run ⇒ all `already wired`, zero writes, zero
backups — that is the idempotency test. `--dry` prints the same table with `would …` actions (the
write/dry duality already exists in `wireMcp`; keep it). Apps detected as **running** during wiring
(`pgrep -x Claude`, `pgrep -f com.openai.chat`, Cursor): still wire (safe — apps read config at startup),
but append `⚠ restart <app> to load` to the row.

## 5. Clone → working chain (reconciled with `brain-init.md`)

| # | Step | Owner | Status |
|---|---|---|---|
| 1 | `curl … install.sh \| bash` — deps (git/node≥22/age/tar/gh), clone engine | `install.sh` | exists; INIT/RESTORE mode split per brain-init §2 is **missing** |
| 2a | Fresh user: `brain init` — key → config.json → private repo → first sync | `bin/lib/init.mjs` | **missing** (specced in brain-init.md; blocked on its §1 `loadConfig()` fallback) |
| 2b | Returning user: key-paste UI → `brain restore` | `serve` + `doRestore` | exists |
| 3 | Wire everything: `brain onboard` (init step 8 / install.sh tail call it) | `brain.mjs onboard` + `wire.mjs` v2 + `wire-targets.mjs` + shim | partial — this spec |
| 4 | Verify: `brain doctor` — printed as the last line of install.sh | `bin/lib/doctor.mjs` | **missing** (§6) |

No contradiction with brain-init.md is introduced: init still owns key/repo/config; onboard still owns
machine wiring; this spec only widens what onboard wires and adds doctor. `BRAIN_NO_AUTOMATION=1` skips
launchd installs but NOT config wiring (wiring is inert files; the acceptance harness needs it testable).

## 6. `brain doctor` — verification command

Read-only (never repairs; each FAIL names the fix command). Per registry tool, three checks:

- **capture** — PASS: newest observation whose source maps to this tool is < 7 days old, OR the tool's
  watcher/timer launchd job is loaded (`launchctl list`); WARN: wired but no observations yet ("use it
  once"); N/A: Claude Desktop / ChatGPT (impossible by design); FAIL: job installed but not loaded.
- **push** — PASS: target file contains `BRAIN:START` block and block content is < 7 days stale (compare
  against a freshness marker inside the block); WARN: block present but stale; N/A: no push channel;
  FAIL: tool detected + DB non-empty + block absent.
- **pull** — three sub-checks, all required for PASS: (1) config entry present and parseable; (2) wired
  paths exist (node binary, shim, `engine-path` pointer resolves to a repo containing `bin/mcp-bridge.cjs`);
  (3) **live spawn**: run the wired command, send an MCP `initialize` over stdio, PASS on any valid JSON-RPC
  response within 15 s (cold index start), then kill. The spawn test runs **once** (same shim for every
  tool), per-tool checks only re-verify (1)+(2).

Exit 0 iff no FAIL. Healthy full-house looks like §4's table with a `doctor` column all-PASS plus one
line: `bridge: spawn OK (1.9s) · engine: /path/to/repo · key: present · db: 20882 obs`.
Also flags: dangling `engine-path` (repo moved) → `FAIL all pull — run: brain onboard`; empty DB → capture
WARNs, not FAILs (brain-init §5 tone: empty is expected, not broken).

## 7. Honest capability matrix (goes in public README verbatim)

| Tool | Capture | Push (always-on recall) | Pull (search on demand) |
|---|---|---|---|
| Claude Code (all profiles) | ✅ automatic | ✅ | ✅ |
| Codex CLI / Codex app | ✅ automatic | ✅ | ✅ |
| Antigravity CLI | ✅ automatic | ✅ | ✅ |
| Cursor | ✅ automatic (timer) | ⚠️ per-repo only | ✅ |
| Claude Desktop | ❌ chats are server-side (optional: official data-export import) | ❌ no mechanism exists | ✅ |
| ChatGPT desktop | ❌ local history is encrypted (optional: official data-export import) | ⚠️ manual paste-digest | ✅ via shared `~/.codex/config.toml` |

"Supported" means at least pull. The README must not say "works with Claude Desktop/ChatGPT" unqualified —
both are **recall-only**; the matrix is the claim.

## 8. Failure / edge cases (normative)

| Case | Behavior |
|---|---|
| Tool installed, never run (dir exists, config absent) | Create minimal config containing only our entry (JSON: `{mcpServers:{claude-mem}}`; TOML: our block). Report `created config`. |
| Config dir absent | `skipped (not installed)`. Never create another vendor's directory. |
| Config malformed | Never write. `FAIL malformed` + fix hint. Doctor repeats it. (Fixes today's clobber bug, §3.) |
| User hand-edited our entry | Semantic compare (§3): if it still resolves to node+shim, `already wired (customized)` — leave theirs. Else update it (with backup). |
| User hand-added other servers | Untouchable, always preserved — the 11→12 invariant. |
| Multiple Claude Code profiles | Push into each profile's `CLAUDE.md` (already done); pull is per-profile via the claude-mem plugin — onboard verifies plugin presence per profile and reports, never installs it itself. |
| Repo moved after wiring | Tool configs unaffected (shim indirection). Shim errors legibly; `brain onboard` from new location fixes all tools by rewriting one pointer file. Doctor detects. |
| App running during wiring | Wire anyway + `⚠ restart` note (§4). Configs are read at app startup on every target. |
| Two machines, same tool | Wiring is per-machine (paths differ); nothing about wiring syncs through the brain repo. `settings/` snapshots of these configs stay redacted-read-only. |
| `~/.codex/config.toml` has profiles/nested tables | Line-based block extent (§3) never touches sections other than ours. |

## 9. Implementation Handoff

Pre-existing bugs T1 must fix (both verified in `bin/lib/wire.mjs` today): (a) `wireToml` update-path
regex corrupts the file when block content changes; (b) `wireJson` clobbers the whole config on malformed
JSON. Ship no new target until both are dead.

| # | Task | Owns (exclusive) | Depends on |
|---|---|---|---|
| T1 | `wire.mjs` v2 core: registry consumption, hardened `wireJson` (malformed⇒refuse), rewritten line-based `wireToml`, backup+prune policy, semantic already-wired compare, node-path resolution | `bin/lib/wire.mjs` | — |
| T2 | Stable shim: `bin/templates/bridge-shim.cjs` + install/refresh of `~/.agentic-brain/{engine-path,bridge.cjs}` | `bin/lib/bridgehome.mjs`, `bin/templates/bridge-shim.cjs` | — |
| T3 | `brain init` + install.sh INIT/RESTORE split + `loadConfig()` fallback (build brain-init.md as written) | `bin/lib/init.mjs`, `install.sh`, `bin/lib/paths.mjs` | — |
| T4 | Registry data: all target rows incl. Claude Desktop / Cursor | `bin/lib/wire-targets.mjs` (new, data-only) | T1, T2 |
| T5 | `brain doctor` per §6 (incl. stdio spawn probe) | `bin/lib/doctor.mjs` (new) | T2, T4 |
| T6 | `onboard` v2 report table + `doctor`/`init` CLI cases; install.sh already patched by T3 | `bin/brain.mjs` | T1–T5 |
| T7 | README capability matrix (§7) + dated correction note in `desktop-app-support.md` (§0) | `README.md`, `docs/specs/desktop-app-support.md` | none (content), publish after T6 |
| T8 | Acceptance: temp-`$HOME` harness — seed fake configs (11-server Claude Desktop clone, commented TOML, malformed JSON), run onboard twice (second run: zero writes), assert preservation byte-ranges, run doctor | `docs/specs/auto-wiring-acceptance.sh` (new) | T1–T6 |

**Definition of done:** fresh temp-HOME run of `install.sh` (INIT mode) ends with `brain doctor` exit 0,
§4's table showing every detected tool wired, and a second `brain onboard` performing zero writes.
