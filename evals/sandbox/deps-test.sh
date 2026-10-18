#!/usr/bin/env bash
# Open Agentic Brain and Memory — installer dependency sandbox. Each scenario is a fresh fake Mac
# whose PATH holds ONLY what that scenario says is installed (plus /usr/bin:/bin).
# "Homebrew" is simulated: it links real binaries into that Mac's bin dir.
set -uo pipefail
# macOS-only by construction: it simulates Homebrew and a PATH where age/gh/git are genuinely
# absent (/usr/bin on a Linux box usually has them via apt). The Linux installer branch (apt/dnf
# hint when git is missing) is covered by evals/platform-test.mjs.
if [ "$(uname -s)" = Linux ]; then echo "deps-test: skipped on Linux (Homebrew simulation is macOS-only)"; exit 0; fi
. "$(cd "$(dirname "$0")" && pwd -P)/lib.sh"
sb_mktemp deps
sb_engine "$SB/engine-src" || exit 2; ENG="$SB/engine-src"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1${2:+ — $2}"; }

# engine on fake GitHub
export SB_GITHUB="$SB/github"; mkdir -p "$SB_GITHUB/OWNER"
/usr/bin/git clone -q --bare "$ENG" "$SB_GITHUB/OWNER/agentic-brain.git" 2>/dev/null

# mac <name> <brew:yes|no> <preinstalled...>  (node age gh gitlfs brokengit oldnode)
mac() {
  local n="$1" brew="$2"; shift 2
  local H="$SB/$n"; mkdir -p "$H/bin" "$H/tmp" "$H/.claude"
  HOME="$H" /usr/bin/git config --global user.name s; HOME="$H" /usr/bin/git config --global user.email s@s.invalid
  HOME="$H" /usr/bin/git config --global url."file://$SB_GITHUB/".insteadOf "https://github.com/"
  cp "$ROOT/core/"* "$H/bin/"
  [ "$brew" = yes ] && cp "$ROOT/brew-sim" "$H/bin/brew"
  for p in "$@"; do case "$p" in
    node)     ln -sf "$NODE_BIN" "$H/bin/node" ;;
    age)      ln -sf "$AGE_BIN" "$H/bin/age"; ln -sf "$AGEK_BIN" "$H/bin/age-keygen" ;;
    gh)       cp "$ROOT/shims/gh" "$H/bin/gh" ;;
    gitlfs)   printf '#!/bin/sh\nexit 0\n' > "$H/bin/git-lfs"; chmod +x "$H/bin/git-lfs" ;;
    brokengit) mkdir -p "$H/empty-exec"; printf '#!/bin/sh\n[ "$1" = --exec-path ] && { echo "%s"; exit 0; }\nexec /usr/bin/git "$@"\n' "$H/empty-exec" > "$H/bin/git"; chmod +x "$H/bin/git" ;;
    foreigngit) touch "$H/.foreign-git"; mkdir -p "$H/brewgit/bin"; ln -sf /usr/bin/git "$H/brewgit/bin/git" ;;
    oldnode)  printf '#!/bin/sh\n[ "$1" = -p ] && { echo 20; exit 0; }\necho v20.11.0\n' > "$H/bin/node"; chmod +x "$H/bin/node" ;;
  esac; done
}
install() { # install <mac> [extra env...]
  local H="$SB/$1"; shift
  env -i HOME="$H" PATH="$H/bin:/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="$H/tmp" USER=s \
    SB_GITHUB="$SB_GITHUB" SB_LOG="$SB/$(basename "$H").calls" SB_KEYCHAIN="$H/keychain" \
    SB_GH_LOGIN="u-$(basename "$H")" SB_BIN="$H/bin" SB_SHIMS="$ROOT/shims" SB_NODE="$NODE_BIN" SB_AGE="$AGE_BIN" SB_AGEK="$AGEK_BIN" BRAIN_NO_AUTOMATION=1 BRAIN_SKIP_NPM=1 BRAIN_TEST=1 BRAIN_MODE=init \
    AGENTIC_BRAIN_REPO=OWNER/agentic-brain "$@" bash "$ENG/install.sh" </dev/null
}
works() { # works <mac> [engine dir under HOME]: the installed brain saves and finds a memory
  local H="$SB/$1" B="$SB/$1/${2:-agentic-brain}/bin/brain.mjs"
  env -i HOME="$H" PATH="$H/bin:/usr/bin:/bin" TMPDIR="$H/tmp" SB_KEYCHAIN="$H/keychain" BRAIN_TEST=1 \
    node "$B" remember --title "Deps scenario works" --type discovery --project deps --fact "okra quokka" >/dev/null 2>&1 &&
  env -i HOME="$H" PATH="$H/bin:/usr/bin:/bin" TMPDIR="$H/tmp" SB_KEYCHAIN="$H/keychain" BRAIN_TEST=1 \
    node "$B" recall "okra quokka" 2>/dev/null | grep -q "Deps scenario works"
}
calls() { cat "$SB/$1.calls" 2>/dev/null; }
# A fake npm that records "<cwd> :: <args>" and never touches the network. npm_shim <mac> <ok|fail>
npm_shim() {
  printf '#!/bin/sh\necho "$(pwd -P) :: $*" >> "%s"\n[ "%s" = fail ] && { echo "npm ERR! network" >&2; exit 1; }\nexit 0\n' "$SB/$1.npm" "$2" > "$SB/$1/bin/npm"
  chmod +x "$SB/$1/bin/npm"
}

echo "🧪 installer dependency sandbox — engine $WIPNOTE"

echo; echo "1) New Mac with Homebrew but none of the tools (no node, age, gh, git-lfs)"
mac m1 yes
install m1 > "$SB/1.log" 2>&1 && ok "installer finishes" || bad "installer finishes" "see 1.log: $(tail -2 "$SB/1.log" | tr '\n' ' ')"
for f in node age gh git-lfs; do calls m1 | grep -q "brew install $f" && ok "installed $f" || bad "installed $f"; done
calls m1 | grep -q "gh auth setup-git" && ok "git connected to GitHub sign-in (gh auth setup-git)" || bad "gh auth setup-git ran"
works m1 && ok "brain works after install (remember + recall)" || bad "brain works after install"
install m1 > "$SB/1b.log" 2>&1; [ $? = 0 ] && ! grep -q "🔧" "$SB/1b.log" && ok "re-run: everything ✅, nothing reinstalled" || bad "re-run is a no-op"
install m1 BRAIN_MODE= > "$SB/1c.log" 2>&1 && ok "re-run with no mode (curl | bash again) updates in place" || bad "auto-mode re-run" "$(tail -2 "$SB/1c.log" | tr '\n' ' ')"
echo "     what the user saw:"; grep -E "^   (✅|🔧)" "$SB/1.log" | sed 's/^/     /'

echo; echo "1d) Legacy install folder (~/Documents/Brain-claude-mem, the pre-~/agentic-brain default)"
mkdir -p "$SB/m1/Documents" && mv "$SB/m1/agentic-brain" "$SB/m1/Documents/Brain-claude-mem"
install m1 BRAIN_MODE= > "$SB/1d.log" 2>&1 && ok "re-run finds the legacy folder and updates it" || bad "legacy re-run" "$(tail -2 "$SB/1d.log" | tr '\n' ' ')"
[ ! -e "$SB/m1/agentic-brain" ] && ok "…without cloning a second copy into ~/agentic-brain" || bad "no second clone" "~/agentic-brain was created"
works m1 Documents/Brain-claude-mem && ok "brain works from the legacy folder" || bad "brain works from the legacy folder"

echo; echo "2) Broken git (no HTTPS helper) + node 20"
mac m2 yes age gh gitlfs brokengit oldnode
install m2 > "$SB/2.log" 2>&1 && ok "installer finishes" || bad "installer finishes" "see 2.log: $(tail -3 "$SB/2.log" | tr '\n' ' ')"
calls m2 | grep -q "brew reinstall git" && ok "repaired git (brew reinstall git)" || bad "repaired git"
calls m2 | grep -q "brew upgrade node" && ok "upgraded node" || bad "upgraded node"
works m2 && ok "brain works after repair" || bad "brain works after repair"

echo; echo "2b) Stray git symlink in Homebrew's bin (seen after a Mac migration)"
mac m2b yes node age gh gitlfs brokengit foreigngit
install m2b > "$SB/2b.log" 2>&1 && ok "installer finishes" || bad "installer finishes" "$(grep -E '❌|Fix' "$SB/2b.log" | tr '\n' ' ')"
calls m2b | grep -q "brew link --overwrite git" && ok "relinked Homebrew's git" || bad "relinked Homebrew's git"
works m2b && ok "brain works after relink" || bad "brain works after relink"

echo; echo "3) No Homebrew, age missing"
mac m3 no node gh gitlfs
install m3 > "$SB/3.log" 2>&1; rc=$?
[ $rc != 0 ] && ok "stops (exit $rc)" || bad "stops" "exit 0"
grep -q "brew.sh" "$SB/3.log" && grep -q "brew install age" "$SB/3.log" && ok "says exactly what to do (Homebrew link + brew install age)" || bad "clear instruction" "$(grep '❌\|Fix' "$SB/3.log" | tr '\n' ' ')"
[ ! -e "$SB/m3/keychain" ] && [ ! -d "$SB_GITHUB/u-m3/claude-brain.git" ] && ok "nothing half-created (no key, no repo)" || bad "nothing half-created"

echo; echo "4) Not signed in to GitHub, no terminal to ask"
mac m4 yes node age gh gitlfs
install m4 SB_GH_NOAUTH=1 > "$SB/4.log" 2>&1; rc=$?
[ $rc != 0 ] && grep -q "gh auth login -s repo" "$SB/4.log" && ok "stops with: gh auth login -s repo" || bad "sign-in instruction" "exit $rc"
[ ! -e "$SB/m4/keychain" ] && ok "no key created" || bad "no key created"

echo; echo "5) Meaning-based search: the installer fetches the optional embedding library (npm is faked — no network)"
mac m5a yes node age gh gitlfs; npm_shim m5a ok
install m5a BRAIN_SKIP_NPM= > "$SB/5a.log" 2>&1 && ok "installer finishes" || bad "installer finishes" "$(tail -2 "$SB/5a.log" | tr '\n' ' ')"
ENGDIR="$(cd "$SB/m5a/agentic-brain" 2>/dev/null && pwd -P)"
grep -q -- "install --omit=dev" "$SB/m5a.npm" 2>/dev/null && ok "ran npm install --omit=dev" || bad "ran npm install --omit=dev" "$(cat "$SB/m5a.npm" 2>/dev/null)"
grep -q "^$ENGDIR :: " "$SB/m5a.npm" 2>/dev/null && ok "…inside the engine dir" || bad "…inside the engine dir" "want $ENGDIR, got $(cut -d' ' -f1 "$SB/m5a.npm" 2>/dev/null | tr '\n' ' ')"
works m5a && ok "brain works" || bad "brain works"

mac m5b yes node age gh gitlfs; npm_shim m5b fail
install m5b BRAIN_SKIP_NPM= > "$SB/5b.log" 2>&1 && ok "npm failure (offline) is tolerated — installer still finishes" || bad "installer finishes after npm failure" "$(tail -2 "$SB/5b.log" | tr '\n' ' ')"
grep -q "keyword-only" "$SB/5b.log" && ok "tells the user recall stays keyword-only + how to retry" || bad "failure message"
works m5b && ok "brain works without the library (BM25)" || bad "brain works without the library"

mac m5c yes node age gh gitlfs; npm_shim m5c ok
install m5c BRAIN_SKIP_NPM= BRAIN_EMBED=0 > "$SB/5c.log" 2>&1 && ok "BRAIN_EMBED=0: installer finishes" || bad "BRAIN_EMBED=0 installer" "$(tail -2 "$SB/5c.log" | tr '\n' ' ')"
[ ! -s "$SB/m5c.npm" ] && ok "BRAIN_EMBED=0: npm never run" || bad "BRAIN_EMBED=0: npm never run" "$(cat "$SB/m5c.npm")"

mac m5d yes node age gh gitlfs; npm_shim m5d ok
install m5d > "$SB/5d.log" 2>&1 && [ ! -s "$SB/m5d.npm" ] && grep -q "BRAIN_SKIP_NPM=1" "$SB/5d.log" && ok "BRAIN_SKIP_NPM=1 (the sandbox default): npm step skipped" || bad "BRAIN_SKIP_NPM=1 skips npm"

mac m5e yes node age gh gitlfs
install m5e BRAIN_SKIP_NPM= > "$SB/5e.log" 2>&1 && grep -q "npm not found" "$SB/5e.log" && ok "no npm on PATH: noted, installer finishes" || bad "no npm on PATH" "$(tail -2 "$SB/5e.log" | tr '\n' ' ')"

echo; echo "════════ $PASS passed · $FAIL failed ════════"
[ "$FAIL" = 0 ]
