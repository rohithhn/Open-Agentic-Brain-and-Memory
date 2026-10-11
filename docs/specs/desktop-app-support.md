# Spec — Claude Desktop, ChatGPT Desktop & Codex Desktop support

Status: **Proposed** · Date: 2026-08-05 · Scope: extend Agentic Brain's capture/recall loops to the
chat/agent desktop apps. Everything below was verified empirically on this machine (macOS, Claude
Desktop current, ChatGPT.app current, Codex app data present). **Specification only — no code.**

> ## ⚠️ CORRECTION — 2026-08-06 (superseding, not replacing, the text below)
>
> This spec originally claimed **"ChatGPT desktop has no local stdio MCP support"** and treated pull
> (MCP recall) on ChatGPT desktop as unavailable. **That claim is wrong.** It is corrected here rather
> than silently edited so the original reasoning stays visible (marked ⚠️ **SUPERSEDED** at each affected
> spot below) — the error and its correction are both part of the record.
>
> **What's actually true, verified two ways:**
> 1. OpenAI's own documentation states: *"The ChatGPT desktop app, Codex CLI, and IDE extension support
>    MCP servers and share MCP configuration for the same Codex host"* — configuration lives at
>    `~/.codex/config.toml`. Only **ChatGPT web** is restricted to remote HTTPS/SSE MCP endpoints; the
>    **desktop app** shares the Codex host's stdio MCP support.
> 2. Verified on this machine: `~/.codex/config.toml` already contains a `[mcp_servers.claude-mem]`
>    block (added for Codex CLI/app wiring elsewhere in this project). Because ChatGPT desktop shares
>    that same Codex-host MCP configuration, **ChatGPT desktop can already search the brain today** —
>    no new wiring code is required for *pull*; it is verify-only, the same shape as the Codex CLI row.
>
> **What is unaffected by this correction — still true, still the hard limits:**
> - **ChatGPT capture is still genuinely impossible.** Local chat history (`conversations-v3-*/*.data`)
>   is AES-encrypted with a Keychain-held key (§1.2); decrypting another vendor's Keychain item to read
>   it is circumvention and is correctly rejected in §3.1/§3.4. Nothing here changes that.
>   The only capture path remains the official data-export parser (§2.1/§3.1, still P3/P4, still unbuilt).
> - **Claude Desktop capture is still impossible** (conversations are server-side, §1.1/§2.1). Unaffected.
> - **Push (ambient `AGENTS.md`/`CLAUDE.md`-style injection) into ChatGPT desktop is still not a thing** —
>   there is no local instructions file the app auto-loads. Only *pull* (MCP) was wrong above; push was
>   correctly described as absent and remains absent.
>
> **Net effect on the verdict/recommendation tables below:** ChatGPT desktop's *recall* row moves from
> "paste-digest only, no MCP path" to "pull already works via the shared `~/.codex/config.toml` entry;
> verify + document, do not build." This makes T7's `README.md` capability matrix (`✅ pull` for ChatGPT
> desktop) consistent with this spec rather than contradicting it. See `docs/specs/auto-wiring.md` T7 for
> the task that produced this correction.

## 0. Verdict summary

| | Capture (local logs) | Capture (fallback) | Recall/injection |
|---|---|---|---|
| **Claude Desktop** | ❌ Not possible — chats are server-side | ✅ claude.ai data-export parser (manual) | ✅ **MCP, low effort** — `claude_desktop_config.json` is a supported public interface and `bin/mcp-bridge.cjs` already exists |
| **ChatGPT desktop** | ❌ Not possible — local cache is **encrypted** | ✅ ChatGPT data-export parser (manual) | ⚠️ **SUPERSEDED 2026-08-06, see correction at top of file.** Original text: "Paste-digest only. Local stdio MCP unsupported by the app; remote MCP requires a public tunnel — rejected as default." **Corrected: ✅ pull already works** — ChatGPT desktop shares the Codex host's `~/.codex/config.toml` MCP config with Codex CLI/app (OpenAI docs: desktop app, Codex CLI, and IDE extension "share MCP configuration for the same Codex host"). The `[mcp_servers.claude-mem]` entry already present there serves ChatGPT desktop too — verify-only, nothing to build. Paste-digest (below) remains a useful *push-like* supplement, since pull still requires the model to choose to search. |
| **Codex desktop app** | ✅ **Already works** — writes the same `~/.codex/sessions/rollout-*.jsonl` the existing `parseCodex` ingests | n/a | ✅ **Already works** — shares `~/.codex/AGENTS.md` (push, in `INJECT_TARGETS`) and `~/.codex/config.toml` MCP (`wireToml`) |

## 1. What is actually on disk (evidence)

### 1.1 Claude Desktop — `~/Library/Application Support/Claude/`
- Standard Electron tree: `IndexedDB/https_claude.ai_0.indexeddb.leveldb` (**800 KB**, near-empty blob
  dirs), `Local Storage/leveldb` (**11 MB**), `Session Storage` (236 KB). No SQLite conversation store
  anywhere (`Cookies`/`DIPS`/`Conversions` are Chromium-internal SQLite, not chat data).
- A read-only `strings` scan of a scratchpad **copy** of the Local Storage LevelDB found essentially no
  conversation structure: `conversation` ×4, `message` ×13, `chat_messages` ×0, `human`/`assistant` ×0
  across ~8.5 MB. It holds UI state, flags and drafts — **conversation text lives on claude.ai's servers
  and is not persisted locally in recoverable form.** This kills local capture honestly; no parser can
  exist for data that isn't there.
- Surprise finding: `claude-code-sessions/` and `local-agent-mode-sessions/` hold per-session JSON for
  Desktop's Cowork/Code mode (`local_*.json` with `cliSessionId`, `cwd`, `title`, `model`,
  `completedTurns` — **metadata only, no transcript**), plus a full embedded Claude Code
  (`claude-code/2.1.219/claude.app`) and cached cowork plugins/skills. Cowork sessions run Claude Code
  under the hood, so their transcripts are already in the Claude Code capture path (ingest.mjs parseClaude) — nothing new to build.
- `claude_desktop_config.json` (6,130 B): `mcpServers` map with **11 stdio servers** (npx/node/uv), plus
  `coworkUserFilesPath`, `preferences`. No `claude-mem` entry. This is the documented MCP config format —
  the same `{ command, args }` shape `bin/lib/wire.mjs → wireJson()` already merges for Antigravity.
- `Claude Extensions/` shows `.mcpb` Desktop Extensions are also supported (chrome-control, figma) — a
  viable later packaging, not needed for v1.

### 1.2 ChatGPT desktop — `~/Library/Application Support/com.openai.chat/`
- Not sandboxed (no `~/Library/Containers/com.openai.chat`; only the Widgets helper is containerized).
- **`conversations-v3-<userId>/` holds 894 per-conversation `<UUID>.data` files** — a complete local
  mirror of chat history — but they are **encrypted**: measured Shannon entropy **7.99 bits/byte**, zero
  ASCII runs ≥ 6 chars, no recognizable header. (Publicly documented behavior: AES with a per-user key in
  the macOS Keychain.) Also present: `drafts-v2-*` (same encrypted format), `gizmos-*`, ~50
  `project-g-p-*` dirs (ChatGPT Projects, same story), `workspace-data` (binary plists),
  `app_pairing_extensions/` ("Work with Apps" pairings — 16 Cursor entries).
- Decrypting would require extracting **another vendor's Keychain secret** and reversing an undocumented
  format. Rejected outright — see §3.4/§4.
- MCP/connectors: prefs (`defaults read com.openai.chat`) show connector UI flags
  (`hasSeenConnectorsNuxModal`). ChatGPT's custom connectors (Developer Mode, the in-app connector UI)
  are **remote-only** — that MCP client runs in OpenAI's cloud, so a server added *through that UI* must
  be a publicly reachable HTTPS/SSE endpoint. That specific claim stands.
  ⚠️ **SUPERSEDED 2026-08-06 (partially) — see correction at top of file:** the next clause, "there is no
  stdio/local-server registration mechanism," is **wrong as a claim about the app overall**. It conflated
  "the in-app connector UI is remote-only" with "the app has no local MCP path at all." In fact the
  ChatGPT desktop app **shares MCP configuration with the Codex host** (`~/.codex/config.toml`, the same
  file Codex CLI/app use) — OpenAI's docs confirm this — so a stdio server registered there (e.g. the
  `[mcp_servers.claude-mem]` entry already present on this machine) **is** available to ChatGPT desktop.
  Custom Instructions / Project instructions remain server-side, paste-only (~1,500 chars per field) —
  that part is unaffected.

## 2. Claude Desktop

### 2.1 Capture — not possible locally; two honest substitutes
**Verdict: local log capture is not possible.** Evidence in §1.1. Do not build a LevelDB parser — there
is no payload to parse, and Chromium LevelDB internals churn every release.

Substitutes, in priority order:
1. **Already covered:** Desktop Cowork/Code sessions execute embedded Claude Code → our Claude Code
   transcript parser captures them. Document this; zero work.
2. **`claude_export` parser (optional, P4):** claude.ai Settings → Privacy → Export data → emailed ZIP
   containing `conversations.json` (`{uuid, name, created_at, chat_messages:[{sender, text, created_at}]}`).
   New CLI/UI entry point `brain ingest --export <path>` (extracted dir or `conversations.json`); parser
   emits the standard item shape `{ sid: uuid, project: 'claude-desktop', title: name, transcript,
   ts: created_at, prompts }` and registers in `RAW_PARSERS` so the existing wrapper applies `scrubItem`
   **before** `hash(it.transcript)` (`ingest.mjs` P4 invariant — never bypass the choke point). Not part
   of the linked-tool auto-loop (no local files to poll); it is an on-demand import. `MAX_PER_TOOL`/8000-char
   clip apply unchanged.

### 2.2 Recall/injection — MCP, via the bridge that already exists
Ranked options:
1. **★ Register `claude-mem` in `claude_desktop_config.json`** pointing at `bin/mcp-bridge.cjs`
   (`{ "command": "node", "args": ["<repo>/bin/mcp-bridge.cjs"] }`). Extend `wireMcp()` with one
   `wireJson(h('Library','Application Support','Claude','claude_desktop_config.json'), write)` call,
   gated on the file existing; surface in `brain onboard` + OS UI. `wireJson` already merges without
   clobbering the 11 existing servers. Note in output: "restart Claude Desktop to load". Value: full
   brain search in every Desktop chat. Effort: **2–3 h**.
2. `.mcpb` Desktop Extension packaging of the bridge — nicer install UX for strangers post-launch; same
   capability. Later, **0.5–1 d**.
3. Paste a digest into claude.ai profile preferences / Project instructions — manual, goes stale; only
   as documentation ("you can also…").
4. A Claude Skill — Desktop skills are account/cloud-scoped and can't read `~/.claude-mem`; not viable
   for recall.

**Pull vs push, honestly:** `CLAUDE.md` injection is *push* — context is always present, zero user
action. MCP is *pull* — the model must decide to call `search`. Claude Desktop offers no push channel
(no auto-loaded local instructions file exists; §1.1). Mitigations: the bridge's tool descriptions
already advertise the brain; add an MCP **prompt** ("Load my brain") so it's one click from the `+`
menu; and the digest-paste option (3) exists for users who want quasi-push. Expectation to set in docs:
Desktop recall is on-demand, not ambient — same trade-off Atlaso has.

### 2.3 Stability & ToS
- `mcpServers` in `claude_desktop_config.json` is Anthropic's **documented public interface** — the most
  stable mechanism in this entire spec. App updates preserve it. Risk: low. First-party (Anthropic ↔
  Anthropic) — no ToS concern; config editing is the officially instructed workflow.
- The one hazard is *ours*: a bad merge nuking 11 working servers. Reuse `wireJson` (merge, never
  rewrite-from-scratch), and write a timestamped `.bak` first (precedent already on disk:
  `claude_desktop_config.json.bak.*`).

## 3. ChatGPT desktop

### 3.1 Capture — encrypted cache: **not possible**; export parser is the honest path
**Verdict: local capture is not possible.** The complete history *is* local (894 files) but AES-encrypted
with a Keychain-held key (§1.2). Reading it would mean programmatically lifting `com.openai.chat`'s
Keychain item and reversing an undocumented container — brittle (breaks on any format/key rotation) and
squarely against OpenAI's Terms ("attempt to… circumvent any protective measures"). **Do not build it;
do not ship it in an open-source repo.** No workaround is invented here.

**Build instead — `chatgpt_export` parser (P3):** ChatGPT Settings → Data Controls → Export → emailed ZIP
with `conversations.json`: array of `{title, create_time, conversation_id, mapping:{<node>:{message:
{author:{role}, content:{content_type, parts}, create_time}, parent, children}}}`. Parser: walk `mapping`
from root via `children` (fall back to `create_time` sort), keep `role ∈ {user, assistant}` text parts,
skip `system`/tool nodes and non-text `content_type`. Emit `{ sid: conversation_id, project: 'chatgpt',
title, transcript, ts: create_time ISO, prompts: user texts }`. Same `brain ingest --export <path>`
entry point as §2.1 (auto-detect vendor by JSON shape); same `scrubItem`-before-`hash` wrapper; zero new
deps (require pre-extracted ZIP, or shell out to `/usr/bin/unzip` — repo has a zero-dependency policy).

### 3.2 Recall/injection — paste-digest; remote MCP rejected as default
> ⚠️ **SUPERSEDED 2026-08-06** — see correction at top of file. This section's framing ("no stdio MCP
> option for ChatGPT desktop, digest-paste is the only push-ish channel, remote MCP is the only MCP
> option") is **wrong about stdio MCP**. ChatGPT desktop shares `~/.codex/config.toml` with the Codex
> host, so option 4 below ("Local stdio MCP: does not exist") is false and is superseded, not deleted —
> it already works today via the existing `[mcp_servers.claude-mem]` entry, verify-only. The digest-paste
> option (1) is still worth keeping as a *push-like* supplement (pull still requires the model to choose
> to search), just no longer the *only* recall channel.

Ranked (original, pre-correction):
1. **★ `brain digest --chatgpt`** — render `buildDigest()` (inject.mjs) trimmed to **≤1,500 chars**
   (Custom Instructions field limit), scrubbed (`scrubText` already runs), copied via `pbcopy`, with a
   one-liner telling the user where to paste (Custom Instructions, or a "My Brain" ChatGPT Project's
   instructions). Add a UI card with a Copy button. *Push-like once pasted, but manual and it goes
   stale* — print "last generated" date inside the digest so staleness is visible. Effort: **2–4 h**.
2. Larger digest as an uploaded Project file (`context/chatgpt-brain.md`) — more content than 1,500
   chars, still manual re-upload. Document as a variant of (1); no extra code beyond writing the file.
3. Remote MCP connector: expose the brain's search as streamable-HTTP MCP behind a tunnel
   (cloudflared/ngrok) + auth token, added in ChatGPT Developer Mode. Technically viable — **recommend
   against as a default**: it puts a 20k-observation personal memory on a public URL, demands auth we'd
   have to get perfectly right, and OpenAI's cloud does the fetching. Revisit only as a documented
   "advanced, at your own risk" recipe, never wired by `onboard`. Effort if ever: **2–3 d**.
4. ⚠️ **SUPERSEDED 2026-08-06 — this line was wrong.** Original claim: "Local stdio MCP: does not exist
   in ChatGPT desktop. Not an option." **Correction: it already exists and already works**, because the
   ChatGPT desktop app shares Codex-host MCP configuration (`~/.codex/config.toml`) with Codex CLI/app —
   OpenAI's own docs say the desktop app, Codex CLI, and IDE extension "share MCP configuration for the
   same Codex host." This machine's `~/.codex/config.toml` already has `[mcp_servers.claude-mem]`, so
   ChatGPT desktop can already call `search` against the brain today. Effort: **0 — verify only**, same
   as the Codex CLI row. Only the ChatGPT **web** client is restricted to remote HTTPS/SSE MCP endpoints
   (that restriction was real and stays real for web; it does not apply to the desktop app).

**Pull vs push (corrected 2026-08-06):** push (ambient, no user action) into ChatGPT desktop is still not
possible — no auto-loaded local instructions file exists, so that half of the original claim stands.
*Pull*, however, already works via the shared `~/.codex/config.toml` MCP entry (item 4 above); it requires
the model to choose to call `search`, same trade-off as any other pull channel. The digest-paste option
(1) remains useful as a push-like supplement precisely because pull is not ambient. Say so precisely in
the README rather than either overclaiming push or underclaiming pull.

### 3.3 Stability
- Export `conversations.json` mapping format: stable for years, widely parsed; medium-low risk; a format
  change breaks an *offline importer*, not a daily loop — acceptable.
- Digest paste: no coupling to the app at all; zero update risk.
- Anything touching `com.openai.chat/` beyond `detect.mjs` presence/mtime stats: high risk, rejected.

### 3.4 Legal/ToS (matters for open source)
- **Red line:** decrypting the conversation cache / touching OpenAI's Keychain items — circumvention;
  never ship.
- **Gray, already-crossed precedent:** `parseCursor` reads Cursor's unencrypted `state.vscdb`. Reading a
  user's own unencrypted data on their own machine is normal OSS practice, but note in the public README
  that ingestion parsers read *your* local app data and each is opt-out (`unlinkedTools`).
- **Clean:** official data exports (both vendors), documented MCP config editing, paste-digests.

## 3.5 Codex desktop app — already covered; verify, don't build
Verified on disk: `~/Library/Application Support/com.openai.codex/` contains **only** a 31-byte
`production-appcast-bootstrap.json` (Sparkle updater) — the app keeps all real state in **`~/.codex/`,
shared byte-for-byte with the Codex CLI**. 18 `rollout-*.jsonl` files written since 2026-07-01; a
current rollout's first line is the same `session_meta` shape `parseCodex` consumes (`id`, `cwd`,
`timestamp`, plus `originator`/`source` fields that distinguish app vs CLI sessions). `~/.codex/` also
now holds `history.jsonl`, `memories_1.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`,
`claude-cowork-transcript-imports/` — none needed; rollouts remain the transcript source of truth.
- **Capture: already works** via the existing `codex` parser — zero code. **Injection: already works**
  — the app's core loads `~/.codex/AGENTS.md` (push, already in `INJECT_TARGETS`) and
  `~/.codex/config.toml` MCP (`wireToml`, already wired).
- To-do (cosmetic, ~1–2 h): smoke-test one app-originated session end-to-end (ingest → search → inject);
  optionally read `session_meta.originator` to label sessions `via codex (app)`; mention the app in
  README's supported-tools table. Optionally add a `codex_app` detect.mjs row pointing at
  `com.openai.codex` for the Detect UI — display only.
- Stability/ToS: same first-party-file story as the CLI — the rollout format is the app's own durable
  store, not a scraped cache. Low risk.

## 4. Registry & code-touch summary (when implemented)
- `detect.mjs`: add `{ id: 'chatgpt_desktop', name: 'ChatGPT Desktop', kind: 'app', paths:
  [h('Library','Application Support','com.openai.chat')], sessions: '', sync: [] }` — detection only;
  never enumerate `conversations-v3-*` contents. `claude_desktop` entry unchanged.
- `wire.mjs`: add Claude Desktop `wireJson` target (+ `.bak` before write). `inject.mjs INJECT_TARGETS`:
  **unchanged** — neither app auto-loads a local instructions file; do not fake one.
- `ingest.mjs`: two export parsers behind `brain ingest --export`, registered through the existing
  `scrubItem` wrapper (scrub strictly before `hash`).
- `brain.mjs`/UI: `digest --chatgpt`, onboard step, two UI cards.

## 5. Recommendation, order, effort
| # | Item | Effort | Ship? |
|---|---|---|---|
| 0 | Codex app smoke-test + README claim (§3.5) | 1–2 h | **Yes — free win, do alongside #1.** |
| 0.5 | ⚠️ *Added 2026-08-06, see correction at top of file.* ChatGPT desktop MCP pull — verify the existing `~/.codex/config.toml` `[mcp_servers.claude-mem]` entry is reachable from ChatGPT desktop (shared Codex-host config); document it | 0 (verify-only) | **Yes — free win, nothing to build.** Corrects item 4 below. |
| 1 | Claude Desktop MCP wiring (`wireMcp` + onboard + UI) | 2–3 h | **Yes — do first.** This alone makes "Claude Desktop: supported" true in the same sense Atlaso claims it (pull-based recall). |
| 2 | `brain digest --chatgpt` + UI copy button | 2–4 h | **Yes.** Useful push-like supplement even now that pull (0.5) already works — pull still requires the model to choose to search. |
| 3 | `brain ingest --export` (ChatGPT + claude.ai parsers) | 1–1.5 d | **Yes, next.** Upgrades ChatGPT from "recall only" to "history searchable in the brain" with zero ToS/stability risk. |
| 4 | `.mcpb` extension packaging; `save_memory` MCP tool for explicit in-chat capture | 0.5–1 d each | Optional, post-launch polish. |
| — | LevelDB parsing, cache decryption, tunnel-by-default MCP | — | **Never.** Too fragile (Chromium internals), impossible (no local data), or hostile (Keychain circumvention / public exposure of the DB). |

**Bottom line (⚠️ partially SUPERSEDED 2026-08-06 — see correction at top of file):** The Codex desktop
app is already supported (it shares `~/.codex/` with the CLI) — just verify and claim it. Claude Desktop
gets real, low-risk support in an afternoon because Anthropic ships a public MCP interface and the bridge
already exists. ChatGPT's *capture* story is honest and small — paste-digest plus official-export
ingestion — because OpenAI encrypts local history; that much was always correct. What was **wrong**:
"only offers cloud-side MCP." ChatGPT desktop's *pull* already works today via the Codex-host-shared
`~/.codex/config.toml`, same as Codex CLI/app — nothing to build there, only to verify and document.
Full parity with the CLI tools (ambient **push** + automatic **capture**) is still **not achievable for
either app** — that half of the original conclusion is unaffected by this correction; the minimum
credible versions above are
also the maximum maintainable ones today.
