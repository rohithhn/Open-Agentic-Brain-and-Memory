# Agentic Brain — private beta

You have been invited to try Agentic Brain. This is a private beta: the repo has no public
listing, testers are added one at a time, and there is exactly one prior production user (the
author). This document is everything you need to go from nothing to a working brain, and back
out again if it's not for you.

## What this is, in three sentences

Agentic Brain captures what your AI coding sessions (Claude Code, Codex, Cursor, and others)
actually establish, distills it into a searchable memory, and injects the relevant parts back
into every tool you use. The memory lives as an `age`-encrypted blob in a **GitHub Release
asset on your own private repo** — not on a vendor server — and the decryption key never
leaves your Mac's Keychain. Nothing about this system requires trusting the author with your
data; it requires trusting `age` encryption and your own GitHub account.

## Prerequisites

- **macOS.** This is the only supported platform right now — the Keychain and `launchd`
  integrations it depends on are Mac-specific.
- **Node ≥ 22.** The engine uses `node:sqlite`, which only exists from Node 22 onward. Check
  with `node --version`; install/upgrade with `brew install node` or `nvm install 22`.
- **`gh` (GitHub CLI), authenticated.** Run `gh auth login` before anything else. `brain init`
  needs a token with the `repo` scope to create your private data repo and upload Release
  assets.
- A GitHub account you're willing to host a private repo on. `brain init` creates it for you —
  you do not create anything by hand.

## Install and initialize

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/agentic-brain/main/install.sh | bash
```

On a machine with no existing brain, this clones the engine (this code — read-only for you;
updates flow in via `git pull`, never push) and then runs `brain init`, which:

1. Generates your `age` encryption key and stores it in the macOS Keychain (never overwrites an
   existing one).
2. Creates a **private** GitHub repo under your account (default name `claude-brain`) to hold
   your data.
3. Runs the first sync — commits the (currently empty) tree and uploads the encrypted blob as a
   `brain-latest` Release asset.

If you already have a brain on another machine, the installer detects that and switches to
RESTORE mode instead: it clones your existing data repo, opens a local page for you to paste
your key, then downloads and decrypts your existing memory.

## Wiring your tools

```bash
node bin/brain.mjs onboard
```

This is what connects the brain to whatever AI tools you actually have installed — Claude
Code, Codex CLI/desktop, Antigravity CLI, Kilo Code, Cursor, Claude Desktop, ChatGPT desktop.
It is additive and safe to re-run any time (e.g. after installing a new tool): it only ever
adds a `claude-mem` MCP entry to each tool's config and never touches other servers you already
have configured. It prints a per-tool report of what got wired and what was skipped (not
installed).

**Honest support matrix — read this before assuming a tool "just works":**

| Tool | Capture (sessions feed the brain) | Push (always-on, zero action) | Pull (model can search, on demand) |
|---|---|---|---|
| Claude Code | yes | yes — `CLAUDE.md` | yes |
| Codex CLI | yes | yes — `AGENTS.md` | yes |
| Codex desktop app | yes | yes | yes |
| Antigravity CLI | yes | yes — `GEMINI.md` | yes |
| Kilo Code (beta) | yes | yes — `~/.config/kilo/AGENTS.md` | yes |
| Cursor | yes | per-repo only, not global | yes |
| Claude Desktop | **no — server-side history, nothing local to read** | no | yes |
| ChatGPT desktop | **no — local history is encrypted, not readable without defeating another vendor's protection** | no | yes |

Claude Desktop and ChatGPT desktop are **pull-only, permanently** — not "not yet." There is no
capture channel to build for either, by design of those apps, not by a gap in this project.
Cursor's push is per-repo because Cursor's own Rules-for-AI live in an internal database this
project deliberately does not touch.

## Verify

```bash
node bin/brain.mjs doctor
```

This is the diagnostic. It is read-only — it never fixes anything, only reports — and for each
tool it checks capture, push, and pull, printing PASS/WARN/FAIL/N-A with a fix command next to
every FAIL. Run it right after onboarding, and run it again any time something seems off.

**When filing a bug, paste the full `brain doctor` output.** It is the fastest way for a
one-person team to diagnose a problem it can't reproduce locally.

## Day one: an empty brain is empty

Nothing is pre-loaded. If you just ran `init`, your memory has zero observations, and that is
correct, not broken:

- `brain dream` (builds the wiki) and `brain distill` (drafts reusable learnings) have nothing
  to work with yet — they'll print a short "nothing to do yet" message and exit cleanly rather
  than error.
- Injection into `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` writes **nothing** into those files while
  your brain is empty — you will not see a "0 observations" banner cluttering every tool you
  open.
- The moment you use Claude Code, Codex, or another wired tool for a real session, that session
  is captured automatically. Give it a day or two of normal use, then run `brain dream` and
  `brain eval` to see the wiki and retrieval scoring come alive.

## The key-loss warning (read this twice)

**The `age` key is the only thing that can decrypt your memory, and it is unrecoverable if
lost.** It lives only in your Mac's Keychain — it is never written to disk in plaintext, never
committed to your repo, and the author has no copy and no way to recover it for you.

If you lose the key (wiped Mac, deleted Keychain entry, no backup) before copying it
elsewhere, **the encrypted blob in your GitHub repo becomes permanently unreadable.** Not
"hard to recover" — permanently. There is no reset-password flow, no vendor support ticket,
no backdoor.

Before you rely on this for anything you care about:

- Run `node bin/brain.mjs key show` and store the printed key somewhere safe outside this Mac
  (a password manager is a reasonable place) — this is the only backup that exists.
- If you set up a second machine, use that saved key with the RESTORE flow, or run
  `brain key import AGE-SECRET-KEY-...` there.
- Again: **the `age` key is the whole security boundary and the whole recovery story.** Losing
  it is losing the data. Leaking it is losing the confidentiality. Treat it like a password
  manager master password, because functionally it is one.

## Reporting bugs

1. Run `node bin/brain.mjs doctor` and copy the full output.
2. Note your macOS version, `node --version`, and which AI tools you have installed
   (Claude Code / Codex / Cursor / Antigravity / Kilo Code / Claude Desktop / ChatGPT
   desktop — whichever apply).
3. Open an issue using the bug report template, or send it directly to whoever invited you to
   the beta. Do not paste your `age` key, GitHub token, or raw `brain doctor` output if it
   happens to contain observation text you don't want shared — redact first if unsure.

## What will probably break

This is one person's tool with one prior production user. Be ready for:

- **Retrieval misses on paraphrased questions.** Search is lexical (BM25), not semantic — if
  you ask about something using none of the original words, it may not surface.
- **Multi-machine sync is whole-blob and merge-based, not real-time.** Editing memory on two
  machines at once needs `brain merge` to reconcile; it will not resolve live conflicts for
  you.
- **New or unusual tool versions can break parsers.** Session-file formats for Codex/Kilo/
  Antigravity/Cursor were reverse-engineered from what those tools wrote at the time; a tool
  update can change that format out from under the parser. `brain doctor`'s capture check is
  your early warning.
- **The secret scrubber is best-effort, not a guarantee** — see `SECURITY.md`. Do not treat an
  unflagged observation as proof it's clean.
- **Sharp edges in error messages.** You may see a raw stack trace instead of a friendly
  message in some code paths that haven't been beta-hardened yet. If you hit one, that's useful
  bug-report material, not a sign you did something wrong.

## Uninstalling — leaving cleanly

A beta tester should be able to walk away and leave nothing behind. Here is everything this
tool writes on your machine and how to remove each piece.

**1. Stop and remove the background services (`launchd` agents):**

```bash
for label in com.claudebrain.serve com.claudebrain.ingest com.claudebrain.watch-agy com.claudebrain.watch-codex; do
  launchctl unload "$HOME/Library/LaunchAgents/$label.plist" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
```

**2. Remove the stable bridge home:**

```bash
rm -rf "$HOME/.agentic-brain"
```

**3. Remove the `claude-mem` MCP entries from each tool you wired.** `brain onboard` only ever
adds one entry (keyed `claude-mem`) to each config below — it never touches anything else in
these files, so removing just that key is safe:

- `~/.claude/.mcp.json`, `~/.claude-work/.mcp.json`, `~/.claude-personal/.mcp.json` (whichever
  profiles you have) — remove the `mcpServers.claude-mem` entry.
- `~/.codex/config.toml` — remove the `[mcp_servers.claude-mem]` block.
- `~/.gemini/config/mcp_config.json` and `~/.gemini/settings.json` — remove the `claude-mem`
  key under `mcpServers`.
- `~/.cursor/mcp.json` — remove the `claude-mem` key under `mcpServers`.
- `~/Library/Application Support/Claude/claude_desktop_config.json` — remove the `claude-mem`
  key under `mcpServers`.

Each of these files also has recent timestamped `.bak.*` copies next to it from the last time
it was wired, if you'd rather diff and restore by hand than edit live.

**4. Remove the managed context blocks.** Each pushed file has your normal content untouched,
plus one delimited block:

```
<!-- BRAIN:START (auto-generated by claude-brain — ...) -->
...
<!-- BRAIN:END -->
```

Open `~/.claude/CLAUDE.md` (and any other profile's `CLAUDE.md`), `~/.codex/AGENTS.md`, and
`~/.gemini/GEMINI.md`, and delete everything between (and including) those two marker lines.
Everything outside the markers is yours and is never touched by this tool.

**5. Remove the local data directories:**

```bash
rm -rf "$HOME/.agentic-brain"        # if step 2 was skipped
rm -rf ~/Documents/Brain-claude-mem  # or wherever you cloned the engine — this repo itself
```

Note: your captured session memory lives in claude-mem's own database
(`~/.claude-mem/claude-mem.db`), which this project reads but does not own. If you also want to
remove claude-mem's data, that is a separate tool with its own uninstall — this beta doesn't
touch that decision for you.

**6. Remove the Keychain entry (your encryption key):**

```bash
security delete-generic-password -s claude-brain -a age-identity
security delete-generic-password -s claude-brain -a age-recipient
```

Do this **last**, and only once you're sure you don't want the data back — after this, the
Release asset in your GitHub repo is unreadable by anyone, including you (see the key-loss
warning above; this is that warning, deliberately invoked).

**7. Delete (or keep) your private data repo.** Your memory lives in the private GitHub repo
`brain init` created for you (default `<you>/claude-brain`). It is entirely yours — delete it
from GitHub's repo settings if you want it gone, or leave it private and untouched if you might
come back.

That's the full footprint: four LaunchAgents, one directory (`~/.agentic-brain`), MCP entries
in whichever tool configs you had, managed blocks in up to three instructions files, two
Keychain entries, and one GitHub repo that is entirely under your own control throughout.
