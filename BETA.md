# Getting started, backup & uninstall

Agentic Brain is open source (Apache-2.0). This page covers the practical bits the README
skims: what you need, how to protect your key, how to report a problem, and how to remove
everything again. The README is the authoritative overview.

## Prerequisites

- **macOS or Linux.** Windows is not supported.
- **Node 22 or newer** (`node:sqlite` needs it). Check with `node --version`.
- **`git` and a GitHub account.** The installer fetches `age`, `tar` and `gh` if they are
  missing. `brain init` uses `gh` to create your private data repo, so run `gh auth login` first.
- **Linux only:** install `libsecret-tools` (Debian/Ubuntu) or `libsecret` (Fedora) and have a
  keyring running (GNOME Keyring or KWallet). See "Where the key lives" below.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/rohithhn/Ultra-Agentic-Memory-and-Brain-Public/main/install.sh | bash
```

With no existing brain, the installer clones this engine and runs `brain init`: it generates
your `age` key, creates a **private** GitHub repo under your account (default name
`claude-brain`) for your data, and runs the first sync. If you already have a brain on another
machine, it switches to RESTORE mode: it clones your data repo, asks for your key, and decrypts
your memory.

Then wire your tools and check the result:

```bash
node bin/brain.mjs onboard   # safe to re-run, e.g. after installing a new tool
node bin/brain.mjs doctor    # read-only: PASS/WARN/FAIL per tool, with a fix for each FAIL
```

`onboard` adds one MCP server entry named `agentic-brain` to each tool it finds and never
touches other servers in those configs. Supported: Claude Code, Claude Desktop, Codex (CLI and
desktop), Cursor, Antigravity CLI and Kilo Code (beta). See the README's support matrix for
what capture, push and pull mean for each tool.

A new brain starts empty unless you chose to include the sessions already on your computer.
Give it a day of normal use, then try `brain dream` and `brain eval`.

## Where the key lives, and how to back it up

The `age` private key is the only thing that can decrypt your memory. Lose it and the
encrypted copy on GitHub is **permanently unreadable**. There is no reset, and nobody else
holds a copy.

- **macOS:** the Keychain (service `claude-brain`).
- **Linux:** your keyring via libsecret, when `secret-tool` is installed and a keyring answers.
  Otherwise it falls back to an encrypted file, `~/.claude-brain/secrets.enc`, whose key is
  derived from this machine's machine-id (or hostname), your uid and your username. That only
  protects against the file being casually copied elsewhere; anyone who can read your files
  on this machine can decrypt it. Use a keyring.

Back the key up as soon as you are set up:

```bash
node bin/brain.mjs key backup    # key → memory/key-recovery.age in your private data repo,
                                 # encrypted with a passphrase you choose (asked hidden)
```

On a new machine, `brain key recover` (or the RESTORE flow) asks for that passphrase.
Remember it: without it the file is useless. If you also want an offline copy,
`brain key reveal` prints the private key to your terminal only (after a typed confirmation)
so you can store it in a password manager. `brain key show` prints only the **public** key;
it is not a backup.

## Reporting bugs

Open an issue with the bug report template. Include the full `brain doctor` output, your OS
(macOS version or Linux distro), `node --version`, and which AI tools you use. Never paste
your `age` key or a GitHub token, and redact any memory text you don't want public. For
security problems, follow `SECURITY.md` instead.

## Uninstall

Everything below is on your own machine except the last step.

**1. Stop the background jobs.**

```bash
node bin/brain.mjs serve --uninstall
node bin/brain.mjs ingest --uninstall
node bin/brain.mjs watch-agy --uninstall
node bin/brain.mjs watch-codex --uninstall
node bin/brain.mjs distill-sessions --uninstall
node bin/brain.mjs embed --uninstall
```

These stop the jobs but leave their definition files. Delete those too, along with the daily
sync job, which has no uninstall command:

- **macOS:** in `~/Library/LaunchAgents/`, the six `com.claudebrain.*.plist` files (serve,
  ingest, watch-agy, watch-codex, distill, embed) and `com.<owner>.<repo>.sync.plist` (run
  `launchctl unload <file>` on the sync one first).
- **Linux:** the matching `.service` and `.timer` files in `~/.config/systemd/user/` (run
  `systemctl --user disable --now <name>.timer` for the sync one first), then
  `systemctl --user daemon-reload`.

**2. Remove the `agentic-brain` MCP entries** from each tool you wired. Remove only that key;
each file also has timestamped `.bak.*` copies from when it was wired.

- Claude Code: `~/.claude.json` → `mcpServers.agentic-brain` (and the same in
  `~/.claude-work/.claude.json` or `~/.claude-personal/.claude.json` if you have them)
- Codex and ChatGPT desktop: `~/.codex/config.toml` → `[mcp_servers.agentic-brain]`
- Antigravity CLI: `~/.gemini/config/mcp_config.json` → `mcpServers.agentic-brain`
- Cursor: `~/.cursor/mcp.json` → `mcpServers.agentic-brain`
- Kilo Code: `~/.config/kilo/kilo.jsonc` (or `kilo.json`) → `mcp.agentic-brain`
- Claude Desktop: `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
  Linux: `~/.config/Claude/`) → `mcpServers.agentic-brain`

Also remove the `SessionStart` hook that runs `session-start-context.sh` from
`~/.claude/settings.json` (and any other Claude profile's `settings.json`).

**3. Remove the managed context blocks.** In `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
`~/.gemini/GEMINI.md` and `~/.config/kilo/AGENTS.md`, delete everything from the
`<!-- BRAIN:START ... -->` line to the `<!-- BRAIN:END -->` line. This tool never writes
anything outside those markers.

**4. Remove local data.**

```bash
rm -rf ~/.agentic-brain     # MCP bridge home
rm -rf ~/.claude-brain      # local store (brain.db), logs, Linux fallback secrets file
```

Then delete the folder the installer cloned into (the installer prints it; `CLAUDE_BRAIN_DIR`
overrides it).

**5. Remove the key: last, and only if you never want the data back.**

```bash
# macOS
security delete-generic-password -s claude-brain -a age-identity
security delete-generic-password -s claude-brain -a age-recipient
# Linux (libsecret)
secret-tool clear service claude-brain account age-identity
secret-tool clear service claude-brain account age-recipient
```

**6. Delete (or keep) your private data repo** on GitHub. It is entirely yours.
