# Private, self-cleaning copies of the operator's REAL brain store, for shell harnesses (sourced, not run).
# The Node twin is evals/lib/private-copy.mjs; the rule is the same (see README.md, "Copies of the real store"):
#   a copy of the real brain.db is the operator's whole memory — 0700 directory, 0600 file, never in a
#   shared/world-readable place, removed on every exit path.
#
#   sb_private_copy <label> [src]      → sets PRIV (the 0700 dir) and PRIV_DB (<PRIV>/brain.db, 0600).
#                                        src defaults to $HOME/.claude-brain/brain.db, read through
#                                        `sqlite3 "file:<src>?immutable=1" .backup` (never opened for write, never locked).
#   sb_private_copy_home <label> [src] → as above, but PRIV_DB is <PRIV>/home/.claude-brain/brain.db with a READY
#                                        marker: PRIV_HOME is a fake HOME you can hand to the engine.
#   sb_private_cleanup                 removes every copy made so far (idempotent). Installed on EXIT/INT/TERM/HUP
#                                        on first use; if you install your own trap afterwards, call this from it
#                                        (sb_mktemp's sb_cleanup already does).
#   sb_private_sweep [base]            removes brain-private-* dirs left by a SIGKILLed run (owner pid no longer alive).
SB_PRIV_DIRS=()
SB_PRIV_BASE() { printf '%s' "${BRAIN_PRIVATE_COPY_BASE:-${SCRATCHPAD:-${TMPDIR:-/tmp}}}"; }

sb_private_cleanup() {
  local d
  for d in ${SB_PRIV_DIRS[@]+"${SB_PRIV_DIRS[@]}"}; do rm -rf "$d"; done
  SB_PRIV_DIRS=()
}

sb_private_sweep() { # sb_private_sweep [base]
  local base="${1:-$(SB_PRIV_BASE)}" d pid n
  for d in "$base"/brain-private-*; do
    [ -d "$d" ] && [ -O "$d" ] || continue
    n="${d##*/}"; pid="$(printf '%s' "$n" | sed -n 's/^brain-private-.*-\([0-9][0-9]*\)-[A-Za-z0-9]\{6\}$/\1/p')"
    [ -n "$pid" ] || continue
    kill -0 "$pid" 2>/dev/null || rm -rf "$d"
  done
}

_sb_private_traps() {
  [ "${SB_PRIV_TRAPPED:-0}" = 1 ] && return 0
  SB_PRIV_TRAPPED=1
  local prev; prev="$(trap -p EXIT | sed -n "s/^trap -- '\(.*\)' EXIT$/\1/p")"
  trap "${prev:+$prev; }sb_private_cleanup" EXIT
  trap 'sb_private_cleanup; exit 130' INT
  trap 'sb_private_cleanup; exit 143' TERM
  trap 'sb_private_cleanup; exit 129' HUP
}

_sb_private_make() { # _sb_private_make <label> <src> <home 0|1>
  local label="${1//[^A-Za-z0-9_.-]/_}" src="${2:-$HOME/.claude-brain/brain.db}" home="$3" base dir target
  [ -f "$src" ] || { echo "private-copy: no store at $src" >&2; return 1; }
  command -v sqlite3 >/dev/null || { echo "private-copy: sqlite3 not found" >&2; return 1; }
  base="$(SB_PRIV_BASE)"; mkdir -p "$base" || return 1
  sb_private_sweep "$base"
  # umask 077 for the whole creation, so there is no window where anything is group/world readable
  dir="$(umask 077; mktemp -d "$base/brain-private-${label:-real}-$$-XXXXXX")" || return 1
  dir="$(cd "$dir" && pwd -P)"
  SB_PRIV_DIRS+=("$dir"); _sb_private_traps
  chmod 700 "$dir"
  target="$dir/brain.db"
  if [ "$home" = 1 ]; then
    mkdir -p "$dir/home/.claude-brain" && chmod 700 "$dir/home" "$dir/home/.claude-brain" || return 1
    target="$dir/home/.claude-brain/brain.db"
  fi
  # the URI keeps the real file strictly read-only; .backup is a consistent snapshot even mid-WAL
  if ! ( umask 077; sqlite3 "file:$src?immutable=1" ".backup '${target//\'/\'\'}'" ); then
    rm -rf "$dir"; echo "private-copy: snapshot of $src failed" >&2; return 1
  fi
  chmod 600 "$target"
  PRIV="$dir"; PRIV_DB="$target"; PRIV_HOME=""
  if [ "$home" = 1 ]; then PRIV_HOME="$dir/home"; ( umask 077; echo "private copy" > "$PRIV_HOME/.claude-brain/READY" ); fi
}

sb_private_copy()      { _sb_private_make "${1:-real}" "${2:-}" 0; }
sb_private_copy_home() { _sb_private_make "${1:-real}" "${2:-}" 1; }

# Portable stat: GNU coreutils (Linux) vs BSD (macOS). Probe once by behaviour, not by uname.
if stat -c %a / >/dev/null 2>&1; then
  sb_mode() { stat -c %a "$1"; }   # octal permission bits, e.g. 700
  sb_size() { stat -c %s "$1"; }   # size in bytes
else
  sb_mode() { stat -f %Lp "$1"; }
  sb_size() { stat -f %z "$1"; }
fi
