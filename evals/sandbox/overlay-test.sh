#!/usr/bin/env bash
# Unit test for lib.sh's sb_engine: committed HEAD + uncommitted bin/ hooks/ changes
# (modified, staged-new, untracked, deleted) reach the sandbox engine; personal config.json does not.
# Uses a throwaway git repo, never the real checkout.
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/lib.sh"
sb_mktemp overlay
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
t() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi; }
R="$SB/repo"; mkdir -p "$R/bin/lib" "$R/hooks" && cd "$R"
git init -q -b work . && git config user.email t@t && git config user.name t
echo committed > bin/a.mjs; echo gone > bin/gone.mjs; echo hook > hooks/h.sh; echo '{"personal":1}' > config.json; echo i > install.sh
git add -A && git commit -qm base
echo modified > bin/a.mjs; rm bin/gone.mjs; echo staged > bin/staged.mjs; git add bin/staged.mjs
echo untracked > bin/lib/new.mjs; echo ux > hooks/new.sh; echo outside > elsewhere.txt
echo "  overlay on (default)"
SRC="$R" WIP=1 sb_engine "$SB/e1"
t "modified tracked file overlaid"   test "$(cat "$SB/e1/bin/a.mjs")" = modified
t "deleted file removed"             test ! -e "$SB/e1/bin/gone.mjs"
t "staged new file present"          test "$(cat "$SB/e1/bin/staged.mjs")" = staged
t "untracked bin/ file present"      test "$(cat "$SB/e1/bin/lib/new.mjs")" = untracked
t "untracked hooks/ file present"    test "$(cat "$SB/e1/hooks/new.sh")" = ux
t "files outside bin/hooks not copied" test ! -e "$SB/e1/elsewhere.txt"
t "config.json stripped"             test ! -e "$SB/e1/config.json"
t "config.json not tracked in engine" test -z "$(git -C "$SB/e1" ls-files config.json)"
t "engine branch is main"            test "$(git -C "$SB/e1" branch --show-current)" = main
t "working tree clean (WIP committed)" test -z "$(git -C "$SB/e1" status --porcelain)"
echo "  WIP=0 (HEAD only)"
SRC="$R" WIP=0 sb_engine "$SB/e2"
t "HEAD version of modified file"    test "$(cat "$SB/e2/bin/a.mjs")" = committed
t "deleted file still in HEAD"       test -e "$SB/e2/bin/gone.mjs"
t "untracked file absent"            test ! -e "$SB/e2/bin/lib/new.mjs"
echo "  clean tree (empty diff)"
git -C "$R" add -A && git -C "$R" commit -qm wip
SRC="$R" WIP=1 sb_engine "$SB/e3"; t "empty overlay still succeeds" test -e "$SB/e3/bin/a.mjs"
echo; echo "════════ $PASS passed · $FAIL failed ════════"
[ "$FAIL" = 0 ]
