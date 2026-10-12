> Historical design note. It explains why the code is shaped the way it is; details may be out of date — the code and README are authoritative.

# Spec — `brain init` (fresh-brain onboarding)

Status: **Ready to implement** · Date: 2026-08-04
Consistent with ADR-001 (two-repo split). **Implementer: change no behaviour not described here.**

Goal: a stranger with a clean Mac and `gh auth login` reaches a working, syncing, encrypted brain in
under 5 minutes, with zero reference to anyone else's accounts.

---

## 0. Decision: there are **two** repo slugs, not one

The A2 sweep collapsed a distinction the code always had. Separate them explicitly:

| Name | Meaning | Source of truth |
|---|---|---|
| `ENGINE_REPO` | where `install.sh` fetches **engine code** from (`agentic-brain`) | literal default in `install.sh`, overridable by `$AGENTIC_BRAIN_REPO` |
| `BRAIN_REPO` | the user's **own private data repo** (`<user>/claude-brain`) | `config.json` `repo.owner/name`; created by `brain init` |

`install.sh` today conflates them, which is why de-personalization broke the one-liner: it made the *engine*
slug unresolvable on a machine that has no `config.json`.

### The three candidate fixes, judged

- **(3) self-resolve the slug from the download URL — NOT ACHIEVABLE. Verified empirically.** Under
  `curl … | bash` the script arrives on **stdin**; there is no path and no URL anywhere in the bash process.
  Probe result on this machine: `$0` = `bash`, `${BASH_SOURCE[0]}` = *unset*, and `ps -o args= -p $PPID`
  returns the *invoking* shell's command line, not the pipeline (curl and bash are siblings, not
  parent/child). A sibling scan (`pgrep -P $PPID`) did not even find curl — it had already exited. macOS has
  no `/proc`. Any recovery would be a race-prone argv scrape in the first ten seconds of a stranger's
  experience. **Rejected on evidence, not taste.**
- **(2) a personal default kept out of the published engine only** — rejected: creates a permanent divergence in a file
  ADR-001 §2 lists as *mirrored byte-identical*, and the flip-day literal has to be edited anyway.
- **(1) `brain init` owns fresh installs — CHOSEN**, with one addition that makes the one-liner work again:
  `install.sh` carries `ENGINE_REPO_DEFAULT="OWNER/agentic-brain"` as a **placeholder literal**.
  Before the engine repo was public this was harmless because `raw.githubusercontent.com` 404s on a
  private repo — the one-liner *cannot* work until then regardless. Once public, `ENGINE_REPO_DEFAULT` and
  the README one-liner are set to the real slug, which contains no personal data. Testing before that
  uses `AGENTIC_BRAIN_REPO=…`.

`BRAIN_REPO` is never required from a fresh user — `brain init` creates the repo and writes the slug.

---

## 1. Blocking prerequisite: `config.json` must stop being load-bearing at import time

`bin/lib/paths.mjs:19,23` does `JSON.parse(readFileSync(config.json))` at **top-level module scope**. A
fresh clone of `agentic-brain` has no `config.json` (gitignored, ADR-001 §4), so *every* command —
including `brain init` — dies with a raw Node stack trace before `brain.mjs`'s error handler exists.

**Required change (do this first):** `loadConfig()` falls back to `config.example.json` when `config.json`
is absent, and exports `export const CONFIG_PRESENT = existsSync(cfgPath)`. Malformed JSON still throws,
but with the message `config.json is not valid JSON — fix it or delete it and re-run 'brain init'`.
No other file changes behaviour. This alone converts the worst first-run experience into a legible one.

---

## 2. `brain init` — flow

New CLI case in `bin/brain.mjs`; implementation in `bin/lib/init.mjs`. **State is derived, never stored** —
no ledger file to go stale. Every run begins by printing the probe:

```
node bin/brain.mjs init [--repo <name>] [--owner <login>] [--yes] [--no-automation]
```

| # | Step | Command / action | Re-run behaviour (idempotent) |
|---|---|---|---|
| 0 | Probe | `hasKey()`, `existsSync(config.json)`, `gh auth status`, `gh repo view <slug>`, `hasRemote()`, `gh release view brain-latest` | Prints a 5-line checklist of ✅/⬜ and resumes at the first ⬜ |
| 1 | Preflight | node ≥ 22; `git`,`age`,`age-keygen`,`gh`,`tar` on PATH; `gh auth status` ok **and** token has `repo` scope | Pure check |
| 2 | Identity | `owner` = `--owner` ‖ `gh api user -q .login`; `name` = `--repo` ‖ prompt (default `claude-brain`) | Reads existing `config.json` values if present; never re-prompts |
| 3 | **Key first** | `if (!hasKey()) generateAndStoreKey()` | **Never overwrites.** Existing key ⇒ log `🔐 key already present (age1…) — keeping it` |
| 4 | Config | copy `config.example.json` → `config.json`, set `repo.owner/name`, `repo.private:true` | If present, edit only `repo.owner/name`; preserve every other field |
| 5 | Repo | `gh repo view <slug>` → if absent `gh repo create <slug> --private` (no `--source`, no push) | Existing repo is adopted, never recreated |
| 6 | Remote | `git remote add origin https://github.com/<slug>.git` (or `set-url` if it points elsewhere **and** `--yes`/confirmed) | Matching origin ⇒ no-op |
| 7 | First sync | `doSync()` — commits the tree, creates release `brain-latest`, uploads `brain.age` | Ordinary sync; safe any number of times |
| 8 | Automation | `brain onboard` unless `--no-automation` or `$BRAIN_NO_AUTOMATION=1` | Each installer is already additive/idempotent |
| 9 | Report | print recipient (public key), repo URL, `http://127.0.0.1:37800`, and the **key-backup warning** | — |

**Order is load-bearing.** Key *before* repo *before* sync. A blob uploaded under a key that is later
regenerated is permanently unreadable; §4 turns that into a hard guardrail.

### `install.sh` branching (fits the existing `$TARGET`/`CLAUDE_BRAIN_DIR` structure)

Insert between today's step 1 (deps) and step 3 (clone). Steps 4–7 are unchanged and run in **both** modes.

```
MODE:
  RESTORE  if $TARGET/config.json has repo.owner+name   (update-in-place, today's path)
  RESTORE  elif $BRAIN_REPO is set                      (returning user, 2nd machine)
  INIT     else
```

- **RESTORE** — byte-identical to today: `REPO_SLUG` from config/`$BRAIN_REPO` → clone → key-paste UI →
  `brain restore`. The hard error at `install.sh:40-43` stays, but is now reachable only in RESTORE mode.
- **INIT** — `ENGINE_REPO="${AGENTIC_BRAIN_REPO:-$ENGINE_REPO_DEFAULT}"`; clone it to `$TARGET`; then
  `git -C "$TARGET" remote rename origin engine` and
  `git -C "$TARGET" remote set-url --push engine no_push` (so `origin` is free for the user's own repo and
  an accidental `git push engine` is impossible; engine updates arrive via `git pull engine main`); then
  `node bin/brain.mjs init`. Skip the key-paste UI (step 4) — init generated the key.

**Prompting under `curl | bash`:** stdin is the script. Every prompt must read from `/dev/tty`
(`read -r ans < /dev/tty`); if `/dev/tty` is unavailable, do **not** prompt — require `BRAIN_MODE=init|restore`
and exit 2 with that instruction. Same rule inside `brain init` (Node: open `/dev/tty`, else require `--yes`).
`install.sh` asks exactly **one** question in INIT mode: *"Repo name for your private brain [claude-brain]:"*.

---

## 3. Failure modes

R = resumable (re-run `brain init`, it picks up) · X = rolled back before exit.

| # | Failure | Detection | R/X | Recovery + exact message |
|---|---|---|---|---|
| 1 | No `gh` auth | `gh auth status` exit ≠ 0 | R | `✖ GitHub CLI is not logged in.\n  Run:  gh auth login\n  Then re-run: brain init` · exit 2. Nothing created. |
| 2 | Token lacks `repo` scope | `gh api user -i -q .login` header `X-OAuth-Scopes` lacks `repo`; or `gh repo create` fails with 403/`Resource not accessible` | R | `✖ Your GitHub token can't create private repos (missing the 'repo' scope).\n  Run:  gh auth refresh -h github.com -s repo\n  Then re-run: brain init` |
| 3 | Repo name taken | `gh repo view <slug>` succeeds at step 5 | R | If it is **empty** (`gh api repos/<slug> -q .size` = 0) adopt it silently. If non-empty: `⚠️  <slug> already exists and is not empty.\n  Use it anyway (its history will gain your brain commits)? [y/N]\n  Or pick another name: brain init --repo <name>`. Default **No**. Never force-push, never delete. |
| 4 | Repo is public | `gh api repos/<slug> -q .private` = false | R | `✖ <slug> is public. Your brain must live in a private repo.\n  Fix:  gh repo edit <slug> --visibility private\n  Or:   brain init --repo <another-name>` · **stop before any sync.** |
| 5 | Keychain denied / headless | `security add-generic-password` non-zero, or `getSecret` returns null right after `setSecret` (always verify the round-trip) | X | `✖ Couldn't save your encryption key to the macOS Keychain.\n  Unlock the login keychain (or run from a logged-in GUI session) and re-run.\n  Nothing was created — no repo, no key.` Because key is step 3, **no repo exists yet**. |
| 6 | **Partial init: repo exists, key missing** | probe: `gh repo view` ✅ **and** `hasKey()` ⬜ | R, guarded | Only reachable if the user deleted the key or ran a pre-spec build. `gh release view brain-latest` decides: **no release** ⇒ generate a fresh key, continue. **Release exists** ⇒ **STOP**: `✖ <slug> already holds an encrypted brain, but this Mac has no key.\n  Generating a new key would make that brain permanently unreadable.\n  • Restore the key from your other Mac:  brain key import AGE-SECRET-KEY-…\n  • Or, if the key is lost for good, start over:  brain init --repo <new-name>\n  (No key was generated. Nothing was changed.)` **This is the most dangerous state in the whole flow — it is the one place init must refuse to proceed.** |
| 7 | Node < 22 | `process.versions.node` major < 22 (`install.sh:28` already; repeat in init since init is also run standalone) | X | `✖ Node 22+ required (found <v>) — the brain uses node:sqlite.\n  brew install node   # or: nvm install 22` |
| 8 | Network drops mid-flow | any `gh`/`git` throws with `Could not resolve host`/`timed out` | R | `⚠️  Lost network at step <n> (<label>). Nothing is corrupted — re-run 'brain init' when you're back online; it resumes from here.` Never retry automatically; never leave a half-written `config.json` (write via tmp-file + `rename`). |
| 9 | Sync fails after repo creation | step 7 throws | R | `⚠️  Repo and key are set up; the first sync failed: <msg>\n  Re-run:  brain sync` — do **not** delete the repo. |

**Rollback policy:** only step 3 (key) and step 4 (config) roll back, because both are cheap to redo and
dangerous to leave half-done. Steps 5–8 are **resume-only** — `brain init` never deletes a GitHub repo,
never deletes a Release, never deletes a Keychain item.

---

## 4. Guardrails — what `brain init` must NEVER do

1. **Never overwrite an existing age key.** `generateAndStoreKey()` is called only behind `!hasKey()`.
   (Today `setSecret` uses `-U`, so an unguarded call silently destroys the only copy — implement the guard
   inside `crypto.mjs:generateAndStoreKey()` too: throw unless `{ force: true }`, which only
   `brain key generate --force` passes, after an explicit typed confirmation.)
2. **Never create a public repo.** `--private` is unconditional; `config.repo.private:false` is ignored by
   init and warned about.
3. **Never force-push, never rewrite history, never `gh repo delete`.**
4. **Never touch a repo the user did not name** — no wildcard/"first repo that looks like a brain" logic.
5. **Never write a key, identity, or token to disk or to the repo** — Keychain only (`*.identity` is denied
   by ADR-001 §4 anyway).
6. **Never install launchd jobs when `$BRAIN_NO_AUTOMATION=1`** (the acceptance test depends on this).
7. **Never overwrite an existing `config.json`** wholesale — edit `repo.owner/name` only.
8. **Never run when `$TARGET` is inside another git repo's worktree** other than its own.
9. **Never print the private key.** Print the recipient (`age1…`) only.

---

## 5. The empty-brain problem — day one

A new brain has 0 observations until the first session is captured (`brain ingest`). Current behaviour ranges from fine to
alarming. Required end state:

| Path | Today | Required |
|---|---|---|
| `dream` / `lint` (`dream.mjs:187,331`) | throws `No memory DB to dream over.` | **Graceful no-op**, exit 0: `🌙 Nothing to dream about yet — your brain is empty.\n   Use Claude Code, Codex or Cursor once, then run: brain dream` |
| `distill` (`distill.mjs:20`) | throws `Database not found: /Users/<you>/…` | same shape as above; **stop leaking the absolute path** |
| `export` (`export.mjs:21,23`) | throws; also `no such table: sdk_sessions` when the DB exists without claude-mem's schema — this takes **`POST /api/sync` down with it** | guard with `existsSync` + `tableExists`; return zero totals so **the first `brain sync` succeeds on an empty brain** (init step 7 depends on this) |
| `eval` | reports `0% (0/0)` — reads as total failure | when `questions.jsonl` is missing/empty: `🧪 No eval questions yet — the eval scores your own history, so it needs a few weeks of memory first.` and exit 0 without writing a 0/0 report |
| `inject` (`inject.mjs:91-96`) | writes `🧠 Agentic Brain loaded — **0** observations across **0** projects` into every CLI's global `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` | **Hard requirement: write nothing when total = 0.** A boastful zero-block in every tool is the single worst first impression. `injectContext` returns `{ok:true, skipped:'empty'}` |
| `workflows`, `learn`, `graph` (read paths) | already no-op cleanly | unchanged |
| `graph.mjs:32` + `ui/app.js:437` | empty return omits `stats` ⇒ uncaught `TypeError`, Graph tab permanently blank | include `stats:{projects:0,concepts:0,…}` and `projects:[]` in the empty return |

**UI empty state.** The Home tab must show one dismissable card *instead of* the stat grid while
`memories === 0`:

> **Your brain is empty — that's expected.**
> It fills itself. Open Claude Code, Codex or Cursor and work normally; observations land automatically.
> ① Key created ✅ ② Private repo ✅ ③ First memories — waiting…
> `Check again` · `What gets captured?`

`Dream`, `Eval`, `Inject` and `Distill` buttons render **disabled with a tooltip** ("needs memories first"),
not red errors. Existing muted placeholders elsewhere ("No memory yet.", "none yet — …") are already correct.

---

## 6. Acceptance test — clean temp `$HOME`, throwaway private repo

Method: temp `$HOME` + isolated keychain. **Isolation is the whole test; get it
exactly right.** Save as `docs/specs/brain-init-acceptance.sh`, run manually — never in CI, never from launchd.

```bash
set -euo pipefail
export BRAIN_TEST_ROOT=$(mktemp -d /tmp/brain-init-XXXX)
export HOME="$BRAIN_TEST_ROOT/home"                 # os.homedir() honours $HOME → isolates ~/.claude-mem
export CLAUDE_BRAIN_DIR="$HOME/agentic-brain"
export BRAIN_NO_AUTOMATION=1                        # ← no launchd jobs, ever
export AGENTIC_BRAIN_REPO="<owner>/agentic-brain"
export TEST_REPO="brain-init-test-$(date +%s)"      # unique ⇒ never collides with claude-brain
mkdir -p "$HOME/Library/Preferences" "$HOME/Documents"
security create-keychain -p "" "$HOME/Library/Keychains/login.keychain-db"   # `security` resolves via $HOME/Library/Preferences
security default-keychain -s "$HOME/Library/Keychains/login.keychain-db"
security unlock-keychain -p "" "$HOME/Library/Keychains/login.keychain-db"
export GH_CONFIG_DIR="$BRAIN_TEST_ROOT/gh"; mkdir -p "$GH_CONFIG_DIR"
cp -R "${XDG_CONFIG_HOME:-$REAL_HOME/.config}/gh/hosts.yml" "$GH_CONFIG_DIR/"   # reuse auth, isolate config
```

Four isolation invariants, asserted **before** anything runs and again at teardown:

1. `$HOME` ≠ the real home ⇒ `~/.claude-mem` is `$BRAIN_TEST_ROOT/home/.claude-mem`.
2. The default keychain is the temp one ⇒ `security add-generic-password -s claude-brain` cannot reach the
   real login keychain. Assert `security default-keychain` contains `$BRAIN_TEST_ROOT`.
3. `$TEST_REPO` ≠ `claude-brain`. Assert `gh repo view <owner>/claude-brain` is **untouched**
   (`.pushedAt` identical before/after).
4. `BRAIN_NO_AUTOMATION=1`. Assert `launchctl list | grep -ci brain` is unchanged before/after.

Procedure and assertions:

```
1  bash install.sh                     # INIT mode: no config.json, no $BRAIN_REPO
   ⇒ clones engine; `git -C $TARGET remote -v` shows engine (push=no_push), origin=<owner>/$TEST_REPO
2  brain init --repo "$TEST_REPO" --yes --no-automation
   ⇒ security find-generic-password -s claude-brain -a age-recipient  → age1…
   ⇒ gh api repos/<owner>/$TEST_REPO -q .private                      → true
   ⇒ gh release view brain-latest -R <owner>/$TEST_REPO                → asset brain.age present
   ⇒ config.json repo.owner/name match; every other key == config.example.json
3  brain dream && brain distill && brain eval && brain inject          → all exit 0, no stack traces
   ⇒ grep -c "Agentic Brain loaded" $HOME/.claude/CLAUDE.md            → 0   (empty-brain rule)
4  brain init --repo "$TEST_REPO" --yes                                # idempotency
   ⇒ recipient unchanged; exactly one repo; no second release; config.json byte-identical
5  seed 3 fake observations into $HOME/.claude-mem/claude-mem.db; brain sync; brain dream
   ⇒ wiki/index.md written; blob re-uploaded; UI /api/graph returns stats
6  partial-state drill: security delete-generic-password -s claude-brain -a age-identity; brain init
   ⇒ MUST refuse with failure-mode #6's message and exit non-zero; repo untouched
7  timer: install.sh start → step 3 done  < 5 min
```

Teardown (always, `trap`): `gh repo delete <owner>/$TEST_REPO --yes` · `security delete-keychain
$HOME/Library/Keychains/login.keychain-db` · `rm -rf $BRAIN_TEST_ROOT` · re-assert invariants 2–4 · confirm
the real `~/.claude-mem/claude-mem.db` mtime and row count are unchanged.

**Pass = all 7 steps green with all 4 invariants intact.**
