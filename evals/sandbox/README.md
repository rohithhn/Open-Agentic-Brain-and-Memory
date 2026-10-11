# Sandbox harnesses

End-to-end tests that run the real installer and engine inside throwaway "Macs". Nothing touches the
real machine: each simulated Mac has its own `$HOME`, fake `gh` (local bare repos + a releases folder),
fake `security` (file-backed Keychain), fake `launchctl` (recorded, never loaded), and
`BRAIN_NO_AUTOMATION=1`. Real: `git`, `age`, `tar`, `node`, and the engine code.

Runs on macOS and Linux. On Linux `shims-linux/` stands in for what macOS provides: a file-backed `secret-tool` (libsecret twin of the fake `security`, same `$SB_KEYCHAIN` layout), `md5 -q`, and BSD-form `script -q /dev/null` (translated to util-linux). `deps-test.sh` (Homebrew simulation) is macOS-only and skips itself on Linux. Needs `node` (>= 22), `age`, `age-keygen`, `git`, `sqlite3` on PATH.

    evals/sandbox/sandbox-test.sh     # sync / restore / guards / key rotation / recovery passphrase, `brain audit`, dedupe (126 checks)
    evals/sandbox/apps-test.sh        # wiring into every app + real MCP handshake        (37 checks)
    evals/sandbox/deps-test.sh        # installer dependency scenarios                    (32 checks)
    evals/sandbox/overlay-test.sh     # unit test of the engine/WIP overlay helper        (14 checks)

Each exits non-zero on any failure. `npm run test:sandbox` runs all four in turn and exits non-zero if any
fails; `npm test` runs the unit tests in `evals/*-test.mjs` the same way.

## Engine under test

By default the engine is **this repo**: committed `HEAD` plus your uncommitted changes under `bin/`,
`hooks/` and `install.sh` (modified, staged, deleted and untracked files), so you can test work in progress
without committing. The overlay is committed into a scratch clone whose branch is `main` and whose
personal `config.json` is stripped, then served as the fake GitHub engine repo.

| env | effect |
|---|---|
| `ENGINE_SRC=<path>` | test another checkout instead of this repo |
| `WIP=0` | committed `HEAD` only, ignore uncommitted changes |
| `SB_KEEP=1` | keep the sandbox dir and its logs (always kept when a check fails; the path is printed) |
| `NODE_BIN` / `AGE_BIN` / `AGEK_BIN` | override the node / age / age-keygen binaries the fake Macs link to |

Sandboxes live under `$TMPDIR` (`brain-sb-<name>.XXXXXX`) and are removed on success. A kept sandbox (failure or `SB_KEEP=1`) holds only synthetic data (fake age identities, a fake-secret `settings.json`); delete it when done.

## What each one does

- **`sandbox-test.sh`** — the v1 story. Mac A installs fresh (`BRAIN_MODE=init`), remembers a canary and syncs;
  checks GitHub holds only ciphertext (no canary, no redacted API key in git history or the blob), then Mac B
  restores from the pasted key. Safety guards: a no-key Mac refuses to overwrite an existing brain, a wrong key
  fails loudly, an offline init is resumable. Two Macs write and both sync without losing data; offline sync
  never clobbers the cloud; duplicate memories (`brain remember` answers duplicate for the same memory in other case/punctuation, `brain clean --dupes` dry run writes nothing, `--apply` hides copies behind a backup with no blank/untitled row, a sync never re-inserts or un-hides them, the other Mac's recall shows the memory once, `--undo` brings them back); content_hash v1/v2 mix (one Mac runs `brain migrate-hash --apply`, the other does not, a row curated on one side) syncs both ways with no duplicates; `brain key rotate` (typed confirmation, old key refused afterwards, no private key ever printed; `brain key reveal` is terminal-only and needs the typed word). Recovery
  passphrase: `brain key backup` in a real pty (key and passphrase never echoed), a fresh Mac restores through
  the installer with the passphrase only, wrong passphrases fail cleanly, a different existing key is never
  replaced, rotate removes the stale file, and `brain init` offers it before the first sync.
- **`apps-test.sh`** — one Mac with Claude Code, Claude Desktop, Cursor, Codex CLI (+ the Codex/ChatGPT desktop,
  which share `~/.codex/config.toml`), Antigravity CLI and Kilo Code (beta: VS Code extension + the shared `~/.config/kilo/kilo.jsonc`, `AGENTS.md` and `kilo.db`), each already holding the user's own config. Gemini CLI
  is deliberately absent to prove it isn't falsely wired. Checks `onboard` wiring and idempotence, that existing
  user config survives, that each app's MCP entry launches (with the Dock's minimal PATH for GUI apps) and
  saves / recalls across apps / answers "load all my memory", context injection into instruction files,
  capture of each app's existing sessions, and the Claude Code startup message.
- **`deps-test.sh`** — installer dependency scenarios. Each fake Mac's PATH holds only what the scenario says
  is installed; `brew-sim` "installs" real binaries into that Mac's bin dir. Covers: no tools at all, broken git
  (no HTTPS helper) + old node, a stray git symlink after a Mac migration, no Homebrew, not signed in to GitHub, and the optional embedding library step (fake `npm`: runs `npm install --omit=dev` in the engine dir, a failure is tolerated, `BRAIN_EMBED=0` / `BRAIN_SKIP_NPM=1` / no npm skip it).
  Every harness sets `BRAIN_SKIP_NPM=1` so the installer never touches the network; the deps scenarios that test the npm step override it.
- **`overlay-test.sh`** — tests `lib.sh`'s `sb_engine` against a throwaway repo (modified / staged / untracked /
  deleted files, `WIP=0`, empty diff, `config.json` stripped).

## Copies of the real store (rule)

A copy of the operator's real `~/.claude-brain/brain.db` is their whole memory. No harness, eval, reviewer
script or one-off command may leave one lying around, and none may put one anywhere another user can read it
(`/tmp`, `/private/tmp`, the repo). The rule:

1. **Never copy it by hand.** No `cp`, `sqlite3 ... .backup`, `VACUUM INTO` or `copyFileSync` of the real store
   outside the two helpers below. `evals/private-copy-test.mjs` scans `evals/` and `scripts/` and fails on a
   hand-rolled copy.
2. **Use the helper.** It creates a `0700` directory (`mkdtemp`, `umask 077`), snapshots the store with
   `sqlite3 "file:<store>?immutable=1" .backup` (the real file is never opened for write and never locked),
   `chmod 600` on the copy, and guarantees removal: `try/finally` or `trap` on EXIT/INT/TERM/HUP. A run that
   is SIGKILLed cannot clean up, so the directory name carries the owner pid and the next run's
   `sweepStale` / `sb_private_sweep` deletes any `brain-private-*` whose pid is gone.
3. **Delete before you finish.** Reviewers and agents: if you made a copy some other way, `rm -rf` it before
   you report; `ls -ld /private/tmp/* | grep -v ' root '` is a cheap check.

Node (`evals/lib/private-copy.mjs`):

    import { withPrivateCopy } from './lib/private-copy.mjs';
    await withPrivateCopy({ label: 'dedupe' }, async ({ db }) => { /* read-only work on db */ });
    // makePrivateCopy({ home: true }) also builds <dir>/home/.claude-brain/{brain.db,READY}: a fake HOME
    node evals/lib/private-copy.mjs [--home] -- <cmd> ...    # copy exposed as $BRAIN_REAL_COPY_DB (and $HOME with --home)

Shell (`evals/sandbox/private-copy.sh`, sourced by `lib.sh`):

    sb_private_copy dedupe        # sets PRIV (the 0700 dir) and PRIV_DB (0600)
    sb_private_copy_home cold     # also PRIV_HOME, a fake HOME with READY
    # removed on exit by lib.sh's sb_cleanup (or by the traps the helper installs itself)

Scratch location: `$BRAIN_PRIVATE_COPY_BASE`, else `$SCRATCHPAD`, else `$TMPDIR`. The mode of the directory,
not its path, is what keeps the copy private. Opt-in uses today: `BRAIN_DEDUPE_REAL=1 node evals/dedupe-test.mjs`
(read-only dry run on a private copy) and `node evals/longmemeval/coldstart.mjs --real ...`.
`BRAIN_PRIVATE_COPY_REAL=1 node evals/private-copy-test.mjs` also checks the helper against the real store.

## Files

- `lib.sh` — shared setup (paths, `mktemp` sandbox + cleanup, engine overlay). Sourced by the scripts.
- `private-copy.sh` — `sb_private_copy*`: the only sanctioned way to copy the real store (see the rule above); sourced by `lib.sh`.
- `shims/` — fake `gh`, `security` (argv or `security -i` commands on stdin, like keychain.mjs uses), `launchctl`, `brew` (refuses), `git` (symlink to `/usr/bin/git`), `git-lfs`.
- `core/` — `security` + `launchctl` shims copied into the deps-test Macs' bin dirs.
- `brew-sim` — simulated Homebrew for `deps-test.sh` (asks before installing unless `HOMEBREW_NO_ASK=1`).
- `mcp-probe.mjs` — launches the brain MCP server exactly as an app's config says and speaks MCP to it
  (`brain_remember`, `brain_recall`, `brain_context`); prints one JSON line.

The engine clone the fake Macs push (`sb_engine`) is a single-commit snapshot of HEAD (+ WIP overlay) with `evals/sandbox` and `config.json` removed. The scripts here hold the canary strings the leak checks grep for, and this repo's history would otherwise be scanned as if it were pushed memory. The canary and fake-secret literals are also built at runtime in `sandbox-test.sh` for the same reason.
