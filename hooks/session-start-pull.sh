#!/usr/bin/env bash
# Claude Code SessionStart hook: pull the latest brain from the cloud and merge
# any newer memory from your other machines into the local DB. Runs in the
# background so it never blocks session start.
# Engine folder: CLAUDE_BRAIN_DIR, else ~/agentic-brain, else the legacy
# ~/Documents/Brain-claude-mem (installs made before the default changed).
REPO="${CLAUDE_BRAIN_DIR:-}"
if [ -z "$REPO" ]; then
  REPO="$HOME/agentic-brain"
  [ ! -f "$REPO/bin/brain.mjs" ] && [ -f "$HOME/Documents/Brain-claude-mem/bin/brain.mjs" ] \
    && REPO="$HOME/Documents/Brain-claude-mem"
fi
[ -d "$REPO/.git" ] || exit 0
# Not for the brain's own headless runs (BRAIN_DISTILLER=1): one pull per
# distilled session is pure churn.
[ "${BRAIN_DISTILLER:-}" = "1" ] && exit 0

# Never let a credential prompt block a background hook. Without this, git will
# sit forever on an auth prompt (or on an IDE's GIT_ASKPASS helper) and leave a
# zombie process behind on every session start.
export GIT_TERMINAL_PROMPT=0
unset GIT_ASKPASS SSH_ASKPASS

(
  cd "$REPO" || exit 0
  mkdir -p "$REPO/.brain-tmp"
  # Watchdog: if the merge wedges anyway (network stall, LFS fetch), kill it
  # rather than accumulate a stuck process per session.
  node bin/brain.mjs merge >>"$REPO/.brain-tmp/session-pull.log" 2>&1 &
  pid=$!
  ( sleep 120; kill -9 "$pid" 2>/dev/null ) &
  watchdog=$!
  wait "$pid" 2>/dev/null
  kill "$watchdog" 2>/dev/null
) >/dev/null 2>&1 &
exit 0
