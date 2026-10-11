#!/usr/bin/env bash
# Agentic Brain installer — two modes, auto-detected.
#
#   INIT     brand-new user: clone the engine, then `brain init` creates your own
#            private brain repo + encryption key and does the first sync.
#   RESTORE  you already have a brain: clone it, paste your key, `brain restore`.
#
#   curl -fsSL https://raw.githubusercontent.com/rohithhn/Ultra-Agentic-Memory-Brain-Public/main/install.sh | bash
#
# There are TWO repo slugs and they are not the same thing:
#   ENGINE_REPO  where this installer fetches the ENGINE CODE from.
#                Default below; override with AGENTIC_BRAIN_REPO=<owner>/<repo>.
#   BRAIN_REPO   YOUR OWN private data repo (<you>/claude-brain). Created by
#                `brain init`; recorded in config.json. Set BRAIN_REPO=<owner>/<repo>
#                only when restoring an existing brain onto a second machine.
#
# The engine slug cannot be self-resolved under `curl | bash` (the script arrives
# on stdin: $0 is "bash", BASH_SOURCE is unset, macOS has no /proc), so it is a
# literal here. Keep ENGINE_REPO_DEFAULT and the README one-liner in step.
set -euo pipefail

TARGET="${CLAUDE_BRAIN_DIR:-$HOME/Documents/Brain-claude-mem}"
ENGINE_REPO_DEFAULT="rohithhn/Ultra-Agentic-Memory-Brain-Public"
ENGINE_REPO="${AGENTIC_BRAIN_REPO:-$ENGINE_REPO_DEFAULT}"

echo "🧠 Agentic Brain installer"

# macOS is the tested platform. Linux: dependency hints are apt/dnf instead of
# Homebrew, the key lives in libsecret (secret-tool) or an encrypted file, and
# background jobs are systemd --user units — UNTESTED on real Linux so far.
# BRAIN_PLATFORM_OVERRIDE=linux exists only for tests.
case "${BRAIN_PLATFORM_OVERRIDE:-$(uname -s)}" in linux|Linux) OS=linux ;; *) OS=mac ;; esac

# 1. Dependencies. Check that each tool WORKS, not just that it exists; fix what
#    Homebrew can fix, re-verify every fix, and stop with one clear instruction
#    when something can't be fixed here. Real failures seen on real Macs: a git
#    whose HTTPS helper is missing (clone/push die with "remote-https"), git-lfs
#    absent (the repo's LFS hooks then block every push), node too old for
#    node:sqlite, and no git credential helper (sync's push can't authenticate).
DEP_LOG=""
dep_ok()    { DEP_LOG="${DEP_LOG}   ✅ $1\n"; }
dep_fixed() { DEP_LOG="${DEP_LOG}   🔧 $1\n"; }
die_dep() {
  printf '%b' "$DEP_LOG"
  printf '   ❌ %s\n\n   Fix: %s\n   Then re-run this installer — it picks up where it stopped.\n' "$1" "$2" >&2
  exit 1
}
have_brew() { command -v brew >/dev/null 2>&1; }
brew_do() { # brew_do <install|reinstall|upgrade> <formula>
  have_brew || return 1
  echo "   🔧 brew $1 $2 …"
  # Homebrew 7+ asks "proceed? [y/n]" by default; with output hidden that is an
  # invisible hang. Running the installer is the consent, so skip the prompt
  # (older Homebrew ignores the variable) and never let brew read stdin.
  HOMEBREW_NO_ASK=1 HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew "$1" "$2" >/dev/null 2>&1 </dev/null
  hash -r
}

git_ok()  { command -v git >/dev/null 2>&1 && [ -x "$(git --exec-path 2>/dev/null)/git-remote-https" ]; }
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ]; }
age_ok()  { command -v age >/dev/null 2>&1 && command -v age-keygen >/dev/null 2>&1; }
gh_ok()   { command -v gh >/dev/null 2>&1; }
lfs_ok()  { command -v git-lfs >/dev/null 2>&1; }
tar_ok()  { command -v tar >/dev/null 2>&1; }

ensure() { # ensure <label> <check> <verb-if-present> <formula> <manual fix> <command>
  if "$2"; then dep_ok "$1"; return 0; fi
  # Linux without (Linux)brew: nothing to auto-fix with — give the distro command.
  [ "$OS" = linux ] && ! have_brew && die_dep "$1 is missing or broken" "$5"
  have_brew || die_dep "$1 is missing or broken, and Homebrew isn't installed" \
    "install Homebrew (https://brew.sh), or: $5"
  # Absent → install. Present but broken/old → the given verb (reinstall/upgrade).
  local verb=install
  command -v "$6" >/dev/null 2>&1 && verb="$3"
  brew_do "$verb" "$4"
  "$2" || { [ "$verb" != install ] && brew_do install "$4"; }
  "$2" && dep_fixed "$1 (brew $verb $4)" || die_dep "$1 still doesn't work after brew $verb $4" "$5"
}

echo "🔎 Checking dependencies…"
# Seen after a Mac migration: $(brew --prefix)/bin/git is a stray symlink to some
# other git, which then looks for its HTTPS helper inside Homebrew's tree and
# fails. `brew reinstall git` leaves that foreign link alone; relinking Homebrew's
# own (working) git over it is the fix.
if ! git_ok && have_brew; then
  BREW_GIT="$(brew --prefix git 2>/dev/null)/bin/git"
  if [ -x "$BREW_GIT" ] && [ -x "$("$BREW_GIT" --exec-path 2>/dev/null)/git-remote-https" ]; then
    echo "   🔧 brew link --overwrite git …"
    HOMEBREW_NO_ASK=1 brew link --overwrite git >/dev/null 2>&1 </dev/null
    hash -r
    git_ok && dep_fixed "git with HTTPS (relinked Homebrew's git over a stray one)"
  fi
fi
if [ "$OS" = linux ]; then
  FIX_GIT="sudo apt install git   (or: sudo dnf install git)"
  FIX_NODE="install Node 22+ from https://nodejs.org or NodeSource   (or with nvm: nvm install 22 && nvm alias default 22)"
  FIX_AGE="sudo apt install age   (or: sudo dnf install age)"
  FIX_GH="sudo apt install gh   (or: sudo dnf install gh; older distros: https://github.com/cli/cli/blob/trunk/docs/install_linux.md)"
  FIX_LFS="sudo apt install git-lfs   (or: sudo dnf install git-lfs)"
  FIX_TAR="sudo apt install tar   (or: sudo dnf install tar)"
else
  FIX_GIT="brew reinstall git   (or: xcode-select --install)"
  FIX_NODE="brew install node   (or with nvm: nvm install 22 && nvm alias default 22)"
  FIX_AGE="brew install age"
  FIX_GH="brew install gh"
  FIX_LFS="brew install git-lfs"
  FIX_TAR="xcode-select --install"
fi
ensure "git with HTTPS"  git_ok  reinstall git     "$FIX_GIT" git
ensure "node ≥ 22"       node_ok upgrade   node    "$FIX_NODE" node
ensure "age encryption"  age_ok  install   age     "$FIX_AGE" age-keygen
ensure "GitHub CLI (gh)" gh_ok   install   gh      "$FIX_GH" gh
ensure "git-lfs"         lfs_ok  install   git-lfs "$FIX_LFS" git-lfs
tar_ok && dep_ok "tar" || die_dep "tar is missing" "$FIX_TAR"
if [ "$OS" = linux ] && ! command -v secret-tool >/dev/null 2>&1; then
  # Optional: without it the key is kept in an encrypted file (~/.claude-brain/secrets.enc).
  DEP_LOG="${DEP_LOG}   ℹ️  no desktop keyring tool — key goes in an encrypted file (for the keyring: sudo apt install libsecret-tools  /  sudo dnf install libsecret)\n"
fi
git lfs install >/dev/null 2>&1 || true

# GitHub sign-in: needed to create/read the private brain repo. Interactive when
# there is a terminal; otherwise one exact command to run.
if gh auth status >/dev/null 2>&1; then
  dep_ok "GitHub sign-in"
else
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    echo "🔑 Sign in to GitHub (your private brain repo lives there)…"
    gh auth login -h github.com -s repo -w </dev/tty >/dev/tty 2>&1 || true
  fi
  gh auth status >/dev/null 2>&1 && dep_fixed "GitHub sign-in" \
    || die_dep "not signed in to GitHub" "gh auth login -s repo"
fi
# Let plain `git push` (used by brain sync) authenticate through gh. Idempotent.
gh auth setup-git >/dev/null 2>&1 && dep_ok "git uses your GitHub sign-in" \
  || die_dep "couldn't connect git to your GitHub sign-in" "gh auth setup-git"
printf '%b' "$DEP_LOG"

# 2. Mode: RESTORE if there is already a brain to restore, else INIT.
#    Override with BRAIN_MODE=init|restore (required when there is no tty).
# A real terminal is one we can actually open: /dev/tty exists (and looks read/writable) even
# with no controlling terminal (Docker without -t, CI, cron), where opening it fails.
have_tty() { { : </dev/tty >/dev/tty; } 2>/dev/null; }
ask() { # ask "<prompt>" <default>  → echoes the answer. Reads /dev/tty, never stdin
  local prompt="$1" default="${2:-}" ans=""
  if have_tty; then printf '%s' "$prompt" > /dev/tty; read -r ans < /dev/tty || ans=""; fi
  printf '%s' "${ans:-$default}"
}

# Past sessions: the history every supported tool already keeps on this computer.
# Asked once, before anything can capture (onboard and the background jobs start
# reading as soon as they're installed), and remembered: "start fresh" holds for
# every later capture run, not just this install. No terminal → the recommended
# default. BRAIN_PAST_SESSIONS=all|fresh answers it up front.
ask_past_sessions() {
  [ -n "$(node bin/brain.mjs past-sessions status --decided 2>/dev/null)" ] && return 0
  local choice="${BRAIN_PAST_SESSIONS:-}"
  if [ -z "$choice" ] && have_tty; then
    {
      echo ""
      echo "🧠 Your AI tools already keep your past sessions on this computer"
      echo "   (Claude Code, Codex, Cursor, Gemini, Antigravity, Kilo)."
      echo "   Starting your memory with them means your tools know your work from day one."
      echo "   They're turned into memories on this computer; you can see and delete any of them."
      echo ""
      echo "   1) Start with my past sessions (recommended)"
      echo "   2) Start fresh: only sessions from now on"
    } > /dev/tty 2>/dev/null || true
    case "$(ask "   Choose [1]: " "1")" in 2*|[Ff]*|[Nn]*) choice=fresh ;; *) choice=all ;; esac
  fi
  [ "$choice" = fresh ] || choice=all
  node bin/brain.mjs past-sessions "$([ "$choice" = fresh ] && echo off || echo on)" --quiet || true
}

CONFIG_SLUG=""
if [ -f "$TARGET/config.json" ]; then
  CONFIG_SLUG=$(node -e '
    try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (c.repo && c.repo.owner && c.repo.name && c.repo.owner !== "YOUR_GITHUB_USERNAME")
        console.log(c.repo.owner + "/" + c.repo.name); } catch {}
  ' "$TARGET/config.json" 2>/dev/null || true)
fi

MODE="${BRAIN_MODE:-}"
if [ -z "$MODE" ]; then
  if [ -n "$CONFIG_SLUG" ]; then MODE=restore            # update-in-place
  elif [ -n "${BRAIN_REPO:-}" ]; then MODE=restore       # returning user, 2nd machine
  else MODE=init; fi
fi
if [ "$MODE" != init ] && [ "$MODE" != restore ]; then
  echo "❌ BRAIN_MODE must be 'init' or 'restore' (got '$MODE')." >&2; exit 2
fi

if [ "$MODE" = restore ]; then
  # ── RESTORE ──────────────────────────────────────────────────────────────
  # Which repo holds your brain: explicit override > existing local config.json.
  REPO_SLUG="${BRAIN_REPO:-$CONFIG_SLUG}"
  if [ -z "$REPO_SLUG" ]; then
    echo "❌ Don't know which repo holds your brain. Set BRAIN_REPO=<owner>/<repo> and re-run." >&2
    echo "   Brand new? Run with BRAIN_MODE=init instead — it creates the repo for you." >&2
    exit 1
  fi

  # 3. Clone or update your brain repo
  if [ ! -d "$TARGET/.git" ]; then
    echo "📥 Cloning $REPO_SLUG → $TARGET"
    # GIT_LFS_SKIP_SMUDGE=1: the current tree has no LFS files (blob is a Release asset now);
    # this only prevents fetching stale LFS objects from historical commits.
    if command -v gh >/dev/null 2>&1; then GIT_LFS_SKIP_SMUDGE=1 gh repo clone "$REPO_SLUG" "$TARGET";
    else GIT_LFS_SKIP_SMUDGE=1 git clone "https://github.com/$REPO_SLUG.git" "$TARGET"; fi
  else
    echo "📂 Repo already present — updating"
    git -C "$TARGET" pull --rebase --autostash origin main || true
  fi
  cd "$TARGET"
  ask_past_sessions

  # config.json is gitignored in the engine, so a fresh clone of your brain repo
  # doesn't say which repo it is. Without this, restore looks for the blob in
  # the example's placeholder repo, finds nothing, and "succeeds" with no memory.
  node -e '
    const fs = require("fs"), [slug] = process.argv.slice(1), [owner, name] = slug.split("/");
    let c = {};
    try { c = JSON.parse(fs.readFileSync("config.json", "utf8")); } catch {
      c = JSON.parse(fs.readFileSync("config.example.json", "utf8"));
    }
    if (!c.repo || c.repo.owner !== owner || c.repo.name !== name) {
      c.repo = { ...(c.repo || {}), owner, name, private: true };
      fs.writeFileSync("config.json", JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
      console.log("📝 config.json → " + slug);
    }' "$REPO_SLUG"

  # 4. Key setup (INIT skips this — init generates the key itself). If the brain
  #    carries a recovery file (brain key backup), the passphrase is enough;
  #    otherwise — or if that fails — paste the key in the OS UI.
  if [ "$OS" = linux ]; then
    has_key() { node --input-type=module -e "import('./bin/lib/keychain.mjs').then((m) => process.exit(m.hasSecret('age-identity') ? 0 : 1))" >/dev/null 2>&1; }
  else
    has_key() { security find-generic-password -s claude-brain -a age-identity -w >/dev/null 2>&1; }
  fi
  if ! has_key && [ -f memory/key-recovery.age ] && have_tty; then
    echo ""
    echo "🔐 No encryption key on this Mac yet — your brain has a recovery passphrase."
    node bin/brain.mjs key recover || echo "   Recovery didn't work — you can paste the key itself instead."
  fi
  if ! has_key; then
    echo ""
    echo "🔐 No encryption key on this Mac yet."
    echo "   Starting the Agentic Brain UI so you can paste your key (from your first Mac)."
    echo "   → open http://127.0.0.1:37800  (Ctrl-C here once the key is saved)"
    node bin/brain.mjs serve
  fi

  # 5. Restore the full brain
  echo "⬇️  Restoring your brain…"
  node bin/brain.mjs restore
else
  # ── INIT ─────────────────────────────────────────────────────────────────
  if ! have_tty && [ -z "${BRAIN_MODE:-}" ]; then
    echo "❌ No terminal available to ask setup questions (running under a pipe?)." >&2
    echo "   Re-run with an explicit mode, e.g.:  BRAIN_MODE=init bash install.sh" >&2
    exit 2
  fi

  # 3. Clone the ENGINE (not your data repo) and park it on a remote named
  #    `engine`, so `origin` stays free for the private brain repo `brain init`
  #    is about to create. Pushing to the engine is made impossible on purpose;
  #    engine updates arrive via `git pull engine main`.
  if [ ! -d "$TARGET/.git" ]; then
    echo "📥 Cloning engine $ENGINE_REPO → $TARGET"
    if command -v gh >/dev/null 2>&1; then GIT_LFS_SKIP_SMUDGE=1 gh repo clone "$ENGINE_REPO" "$TARGET";
    else GIT_LFS_SKIP_SMUDGE=1 git clone "https://github.com/$ENGINE_REPO.git" "$TARGET"; fi
    git -C "$TARGET" remote rename origin engine
    git -C "$TARGET" remote set-url --push engine no_push
  else
    echo "📂 Engine already present — updating"
    if git -C "$TARGET" remote get-url engine >/dev/null 2>&1; then
      git -C "$TARGET" pull --rebase --autostash engine main || true
    fi
  fi
  cd "$TARGET"
  ask_past_sessions

  # 4. The one question INIT asks.
  BRAIN_NAME=$(ask "Repo name for your private brain [claude-brain]: " "claude-brain")
  echo "🚀 Creating your private brain repo: $BRAIN_NAME"
  INIT_ARGS=(init --repo "$BRAIN_NAME")
  have_tty || INIT_ARGS+=(--yes)
  node bin/brain.mjs "${INIT_ARGS[@]}"
fi

# ── Both modes from here on ────────────────────────────────────────────────
# 5a. Meaning-based search. Recall finds memories by meaning (not just keywords)
# once the optional on-device embedding library is installed and the embeddings
# are backfilled. Install the library here (into the engine dir, optional
# dependency of package.json); the backfill itself runs later as a low-priority
# background job (step 5b/6/7 below) so it never blocks the install. Every
# failure is tolerated: without it recall is keyword (BM25) search, as before.
#   BRAIN_EMBED=0     opt out entirely (no library, no background job)
#   BRAIN_SKIP_NPM=1  skip just the npm step (offline machines, sandboxes/tests)
if [ "${BRAIN_EMBED:-}" = "0" ]; then
  echo "⏭  BRAIN_EMBED=0 — skipping meaning-based search (recall stays keyword-only)"
elif [ "${BRAIN_SKIP_NPM:-}" = "1" ]; then
  echo "⏭  BRAIN_SKIP_NPM=1 — not installing the embedding library"
elif ! command -v npm >/dev/null 2>&1; then
  echo "ℹ️  npm not found — recall stays keyword-only (install npm, then: cd \"$TARGET\" && npm install --omit=dev)"
else
  echo "🔎 Installing on-device search model library (optional, a few hundred MB)…"
  if (cd "$TARGET" && npm install --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error >/dev/null 2>&1 </dev/null); then
    echo "   ✅ done — memories are embedded in the background; recall turns hybrid as that finishes"
  else
    echo "   ⚠️  couldn't install it (offline?) — recall stays keyword-only. Retry later: cd \"$TARGET\" && npm install --omit=dev"
  fi
fi

# 5b/6/7. Background services. `brain init` already ran `brain onboard` (which
# installs these); they are idempotent and RESTORE needs them, so run them in
# both modes. BRAIN_NO_AUTOMATION=1 skips every launchd job (the acceptance
# harness depends on this — it must leave `launchctl list` untouched).
if [ "${BRAIN_NO_AUTOMATION:-}" = "1" ]; then
  echo "⏭  BRAIN_NO_AUTOMATION=1 — skipping all launchd jobs (daily sync, panel, watchers)"
else
  node bin/setup-automation.mjs || true
  node bin/brain.mjs serve --install || true
  node bin/brain.mjs watch-codex --install || true
  node bin/brain.mjs ingest --install || true
  node bin/brain.mjs embed --install || true   # background embedding backfill (no-op under BRAIN_EMBED=0)
fi

# 8. Pre-populate from history already on this machine, now, instead of waiting
#    for the first background timer: every supported tool's past sessions are
#    read (ingest), memory-building starts in the background, and the user is
#    told what was found. Nothing here can fail the install.
echo ""
if [ -n "$(node bin/brain.mjs past-sessions status --fresh 2>/dev/null)" ]; then
  echo "🌱 Starting fresh: your memory begins with your next AI session."
else
  echo "🔎 Reading your past AI sessions (Claude Code, Codex, Cursor, Gemini, Antigravity, Kilo)…"
fi
node bin/brain.mjs ingest >/dev/null 2>&1 || true
[ "${BRAIN_NO_AUTOMATION:-}" = "1" ] || node bin/brain.mjs distill-sessions --install >/dev/null 2>&1 || true

# claude-mem users: their whole history can come over instantly (verified import,
# undo available). Asked, never assumed; skipped without a terminal.
CM_PENDING=$(node bin/brain.mjs first-run --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { const c = JSON.parse(s).claudeMem; if (c && c.observations && !c.imported) console.log(c.observations); } catch {}
  });' 2>/dev/null || true)
if [ -n "$CM_PENDING" ] && have_tty; then
  ANS=$(ask "📥 claude-mem found with $CM_PENDING memories. Bring them into Agentic Brain now? (undo any time) [Y/n]: " "Y")
  case "$ANS" in [Nn]*) echo "   Skipped. Later: node bin/brain.mjs switch-from-claude-mem --apply" ;;
    *) node bin/brain.mjs switch-from-claude-mem --apply || echo "   claude-mem import didn't finish; nothing was changed. Retry: node bin/brain.mjs switch-from-claude-mem --apply" ;;
  esac
fi

echo ""
node bin/brain.mjs first-run 2>/dev/null || true
echo ""
echo "✅ Done. Your brain is on this machine and will keep syncing."
echo "   Control panel is always-on → http://127.0.0.1:37800"

# 9. Open the control panel. Waits briefly for the always-on panel to answer.
#    BRAIN_NO_OPEN=1 (or BRAIN_NO_AUTOMATION=1) skips it.
if [ -z "${BRAIN_NO_OPEN:-}" ] && [ "${BRAIN_NO_AUTOMATION:-}" != "1" ]; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsS -o /dev/null --max-time 1 http://127.0.0.1:37800/ 2>/dev/null && break
    sleep 1
  done
  if command -v open >/dev/null 2>&1; then open "http://127.0.0.1:37800/" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:37800/" >/dev/null 2>&1 || true
  fi
fi
