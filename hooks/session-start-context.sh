#!/usr/bin/env bash
# Claude Code SessionStart hook: print this repo's brain context as SessionStart
# JSON on stdout (systemMessage for the user, additionalContext for Claude). Unlike session-start-pull.sh (which
# pulls/merges in the background and prints nothing), this one is synchronous by
# necessity — its whole job is to produce text before the first prompt — so it
# is bounded hard and fails silent.
#
# Contract, in order of importance:
#   1. NEVER fail the session. Every path exits 0, stderr is discarded, and any
#      error produces no output at all rather than a message the host would
#      surface as a broken hook.
#   2. NEVER block. A watchdog kills the renderer after WATCHDOG_SECS.
#   3. Resolve node by ABSOLUTE path. Hooks inherit a launchd/GUI PATH that has
#      neither /opt/homebrew/bin nor an nvm shim — this has bitten us three
#      times, and a bare `node` there silently does nothing.

# Belt and braces on rule 1: nothing this script does can reach stderr, so the
# host can never surface it as a failing hook. Every diagnostic path below is
# already silenced individually; this guarantees it even for messages bash
# itself emits (job-control notices, for one).
exec 2>/dev/null

# The brain's own headless runs (distiller, learning drafts, explain) set
# BRAIN_DISTILLER=1. Injecting memory into them spends tokens and feeds the
# brain's own output back into what it distils — the self-capture loop.
[ "${BRAIN_DISTILLER:-}" = "1" ] && exit 0

REPO="${CLAUDE_BRAIN_DIR:-}"
if [ -z "$REPO" ]; then
  # Prefer the repo this script actually lives in; fall back to the documented
  # default so a copied-out hook still works.
  SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)" || SELF_DIR=""
  [ -n "$SELF_DIR" ] && REPO="$(dirname "$SELF_DIR")"
  [ -f "$REPO/bin/lib/sessionstart.mjs" ] || REPO="$HOME/Documents/Brain-claude-mem"
fi
RENDERER="$REPO/bin/lib/sessionstart.mjs"
[ -f "$RENDERER" ] || exit 0

# Seconds before the renderer is killed. Validated as digits: a junk value would
# make the arithmetic below fail silently, leaving the loop bound empty and the
# watchdog killing the renderer instantly on every session.
WATCHDOG_SECS="${BRAIN_SESSION_TIMEOUT_SECS:-8}"
case "$WATCHDOG_SECS" in
  ''|*[!0-9]*) WATCHDOG_SECS=8 ;;
esac

# Absolute node. `command -v` first (works for an interactive shell), then the
# usual install locations, then the newest nvm version. First hit wins.
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
fi
if [ -z "$NODE" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.local/bin/node" \
           /opt/homebrew/opt/node/bin/node /usr/local/opt/node/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  for c in $(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -Vr); do
    [ -x "$HOME/.nvm/versions/node/$c/bin/node" ] && NODE="$HOME/.nvm/versions/node/$c/bin/node" && break
  done
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || exit 0

# The directory the session was opened in. Claude Code sets CLAUDE_PROJECT_DIR;
# PWD is the fallback and is what the hook is invoked with anyway.
TARGET="${CLAUDE_PROJECT_DIR:-$PWD}"

TMPDIR_BRAIN="$REPO/.brain-tmp"
mkdir -p "$TMPDIR_BRAIN" 2>/dev/null || exit 0
OUT="$TMPDIR_BRAIN/session-context.$$"

# Run bounded. The killer POLLS instead of sleeping through the whole timeout
# (`kill`ing a `( sleep N; ... )` subshell orphans the `sleep` inside it), and
# the hook REAPS it explicitly the moment the renderer finishes: the poller may
# be mid-`sleep 0.1`, so waiting for it to notice on its own would let it
# outlive the hook. Reaping is: freeze the poller (so it cannot fork another
# sleep), kill its children, kill it, wait for it. No path leaves it behind.
wd=""
kill_children_of() {
  # pkill -P where it exists; a ps/awk walk where it does not (minimal CI images).
  if command -v pkill >/dev/null 2>&1; then
    pkill -9 -P "$1" >/dev/null 2>&1
  else
    for c in $(ps -A -o pid= -o ppid= 2>/dev/null | awk -v p="$1" '$2 == p { print $1 }'); do
      kill -9 "$c" >/dev/null 2>&1
    done
  fi
}
reap_watchdog() {
  [ -n "$wd" ] || return 0
  kill -STOP "$wd" >/dev/null 2>&1
  # SIGSTOP is asynchronous: confirm the poller is actually stopped before
  # killing its children, or it could fork one more `sleep` in the gap. Each
  # `ps` call is the delay; bounded so a odd ps cannot stall the hook.
  _n=0
  while [ "$_n" -lt 50 ]; do
    case "$(ps -o stat= -p "$wd" 2>/dev/null)" in
      T*|'') break ;;
    esac
    _n=$(( _n + 1 ))
  done
  kill_children_of "$wd"
  kill -9 "$wd" >/dev/null 2>&1
  kill -CONT "$wd" >/dev/null 2>&1
  wait "$wd" >/dev/null 2>&1
  wd=""
}
# The renderer is also ours to reap: a host kill must not leave it running
# unbounded once the watchdog that would have timed it out is gone. rpid is
# cleared as soon as the renderer has been waited on, so a recycled pid is
# never signalled.
rpid=""
reap_renderer() {
  [ -n "$rpid" ] || return 0
  kill_children_of "$rpid"
  kill -9 "$rpid" >/dev/null 2>&1
  wait "$rpid" >/dev/null 2>&1
  rpid=""
}
cleanup() {
  reap_watchdog
  reap_renderer
  rm -f "$OUT" >/dev/null 2>&1
}
# The host may kill the hook itself; the poller and temp file must not outlive it.
trap 'cleanup; exit 0' HUP INT TERM
trap cleanup EXIT

"$NODE" "$RENDERER" "$TARGET" --hook >"$OUT" 2>/dev/null &
pid=$!
rpid=$pid
(
  i=0
  limit=$(( WATCHDOG_SECS * 10 ))
  while [ "$i" -lt "$limit" ]; do
    kill -0 "$pid" 2>/dev/null || exit 0   # renderer finished — nothing to do
    sleep 0.1
    i=$(( i + 1 ))
  done
  kill -9 "$pid" 2>/dev/null
) >/dev/null 2>&1 &
wd=$!
wait "$pid" 2>/dev/null
rc=$?
rpid=""   # waited on above: already reaped, never signal this pid again
reap_watchdog

# Only emit when the renderer exited 0 AND wrote something. A renderer killed by
# the watchdog (or crashed mid-write) leaves a truncated, invalid JSON file; the
# host would reject it as a broken hook, so the exit status gates the cat, not
# merely the file size. Anything else is silence by design: a partial block is
# worse than no block, and stderr stays empty either way.
# The renderer runs with --hook and prints SessionStart JSON: `systemMessage`
# (the last few memories for this folder, shown to the user in the terminal) and
# `additionalContext` (the full block, for Claude before the first prompt).
if [ "$rc" -eq 0 ] && [ -s "$OUT" ]; then
  cat "$OUT" 2>/dev/null
fi
exit 0
