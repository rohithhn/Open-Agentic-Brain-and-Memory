# Shared helpers for the sandbox harnesses (sourced, not run).
#   ROOT        this folder (shims/, core/, brew-sim, mcp-probe.mjs live here)
#   SRC         the engine checkout under test — defaults to this repo's root
#   NODE_BIN    the real node/age binaries the fake Macs link to
#   sb_mktemp   a fresh sandbox dir under $TMPDIR, removed on exit unless SB_KEEP=1 or a check failed
#   sb_private_copy / sb_private_copy_home / sb_private_cleanup   (private-copy.sh) the ONLY way to copy the real brain.db: 0700 dir, 0600 file, removed on every exit
#   sb_engine   committed HEAD (+ uncommitted/untracked bin/ hooks/ install.sh, unless WIP=0), personal config + evals/sandbox stripped, history flattened to one commit
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SRC="${ENGINE_SRC:-$(cd "$ROOT/../.." && pwd -P)}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"; AGE_BIN="${AGE_BIN:-$(command -v age)}"; AGEK_BIN="${AGEK_BIN:-$(command -v age-keygen)}"
for _t in "$NODE_BIN" "$AGE_BIN" "$AGEK_BIN"; do [ -x "$_t" ] || { echo "sandbox: need node, age and age-keygen on PATH" >&2; exit 2; }; done
# Test run: bin/lib/testguard.mjs refuses any write-mode open of the operator's real
# ~/.claude-brain / ~/.claude-mem store while this is set (the fake Macs use a fake HOME).
export BRAIN_TEST=1
TOOLPATH="$(dirname "$NODE_BIN"):$(dirname "$AGE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

. "$ROOT/private-copy.sh"

sb_mktemp() { # sb_mktemp <label> → sets SB
  SB="$(mktemp -d "${TMPDIR:-/tmp}/brain-sb-$1.XXXXXX")"; SB="$(cd "$SB" && pwd -P)"
  trap 'sb_cleanup' EXIT
  trap 'sb_cleanup; exit 130' INT; trap 'sb_cleanup; exit 143' TERM; trap 'sb_cleanup; exit 129' HUP
}
sb_cleanup() {
  sb_private_cleanup
  if [ "${SB_KEEP:-0}" = 1 ] || [ "${FAIL:-0}" != 0 ]; then echo "sandbox kept: $SB"; else rm -rf "$SB"; fi
}

sb_engine() { # sb_engine <dest> → a committed engine checkout at <dest>; sets WIPNOTE
  local dest="$1" paths="bin hooks install.sh" f
  git clone -q --no-local "$SRC" "$dest" 2>/dev/null || { echo "sandbox: cannot clone $SRC" >&2; return 1; }
  # the published engine's branch is `main`, whatever branch/worktree is being tested
  git -C "$dest" checkout -q -B main || return 1
  if [ "${WIP:-1}" = 1 ]; then
    { ( cd "$SRC" && git diff --binary HEAD -- $paths ) | ( cd "$dest" && git apply --allow-empty --whitespace=nowarn ) \
      && ( cd "$SRC" && git ls-files --others --exclude-standard -- $paths ) | while read -r f; do
           mkdir -p "$dest/$(dirname "$f")"; cp -p "$SRC/$f" "$dest/$f"; done; } \
      && WIPNOTE="HEAD $(git -C "$SRC" rev-parse --short HEAD) + uncommitted bin/ hooks/ changes" \
      || WIPNOTE="HEAD $(git -C "$SRC" rev-parse --short HEAD) (WIP overlay failed)"
  else WIPNOTE="HEAD $(git -C "$SRC" rev-parse --short HEAD)"; fi
  # the public engine never carries the operator's personal config.json, nor the harnesses (MANIFEST.json has no evals/ entries) — and its history is flattened to one commit: the fake Macs
  # push this repo, and this repo's own history holds harness scripts the plaintext-leak checks must not trip over
  ( cd "$dest" && git rm -q --cached --ignore-unmatch config.json && rm -f config.json \
    && git rm -r -q --cached --ignore-unmatch evals/sandbox && rm -rf evals/sandbox && git add -A $paths \
    && git checkout -q --orphan flat && git add -A \
    && git -c user.name=t -c user.email=t@t commit -qm "sandbox: engine snapshot ($WIPNOTE)" \
    && git branch -M flat main ) || return 1
}
