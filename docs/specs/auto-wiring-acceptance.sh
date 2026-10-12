#!/usr/bin/env bash
# Acceptance harness for end-to-end auto-wiring (auto-wiring.md T8).
#
# Proves the chain a stranger hits: fake tool landscape -> brain onboard ->
# every tool wired to the shim -> idempotent -> doctor agrees -> repo move
# recovers by pointer rewrite alone.
#
# ── HONESTY: what is real vs stubbed ─────────────────────────────────────────
#   REAL      : bridge-home install, MCP wiring into 4 config files (JSON+TOML),
#               idempotence, brain doctor, repo-move recovery.
#   STUBBED   : `brain init` (needs a real GitHub repo + age key — never created),
#               launchd installs (BRAIN_NO_AUTOMATION=1; launchctl acts on the
#               real login session regardless of $HOME), `brain sync`.
#   NOT PROVEN: first-sync/release upload, real Keychain round-trip, capture flow.
#
# Everything runs under a throwaway $HOME. The real machine is verified
# byte-identical (sha1) at the end.
set -uo pipefail
# Test run: bin/lib/testguard.mjs refuses writes to the real ~/.claude-brain / ~/.claude-mem.
export BRAIN_TEST=1

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRATCH="$(cd "${TMPDIR:-/tmp}" && pwd -P)/awa-$$"   # pwd -P: macOS TMPDIR has a trailing slash + is a symlink
SANDBOX="$SCRATCH/home"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── guard: real files we must not touch ──────────────────────────────────────
REAL_FILES=(
  "$HOME/.codex/config.toml"
  "$HOME/.cursor/mcp.json"
  "$HOME/.gemini/settings.json"
  "$HOME/.gemini/config/mcp_config.json"
  "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
)
declare -a BEFORE
for f in "${REAL_FILES[@]}"; do
  BEFORE+=("$( [ -f "$f" ] && shasum -a 1 "$f" | awk '{print $1}' || echo MISSING )")
done
REAL_AB_BEFORE=$( [ -e "$HOME/.agentic-brain" ] && echo present || echo absent )

cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

# ── fabricate a stranger's machine ───────────────────────────────────────────
mkdir -p "$SANDBOX"/.codex "$SANDBOX"/.cursor "$SANDBOX"/.gemini/config \
         "$SANDBOX"/.claude "$SANDBOX/Library/Application Support/Claude"

# TOML with the Bug-1 shape: a "[" inside args = [...] must not truncate the block.
cat > "$SANDBOX/.codex/config.toml" <<'TOML'
model = "gpt-5.5"

[projects."/tmp/example"]
trust_level = "trusted"

[mcp_servers.existing_one]
command = "node"
args = [ "/opt/tools/one.js", "--flag" ]

[mcp_servers.existing_two]
command = "uvx"
args = [ "two" ]

[tui]
theme = "dark"
TOML

cat > "$SANDBOX/.cursor/mcp.json" <<'JSON'
{ "mcpServers": {
  "figma": { "command": "npx", "args": ["-y", "figma-mcp"] },
  "storybook": { "command": "node", "args": ["/opt/sb.js"] } } }
JSON

echo '{ "theme": "dark" }' > "$SANDBOX/.gemini/settings.json"
echo '{ "mcpServers": { "gsearch": { "command": "node", "args": ["/opt/g.js"] } } }' \
  > "$SANDBOX/.gemini/config/mcp_config.json"
# Google's separate Gemini CLI is NOT a supported target. Seed the files it
# leaves in the ~/.gemini root (an EMPTY creds marker — never real
# credentials) so the run proves onboard leaves ~/.gemini/settings.json alone
# while still wiring Antigravity CLI (~/.gemini/config/mcp_config.json).
touch "$SANDBOX/.gemini/oauth_creds.json"
GEMINI_SETTINGS_BEFORE=$(shasum -a 1 "$SANDBOX/.gemini/settings.json" | awk '{print $1}')

cat > "$SANDBOX/Library/Application Support/Claude/claude_desktop_config.json" <<'JSON'
{ "mcpServers": {
  "figma":  { "command": "npx", "args": ["-y", "figma-mcp"] },
  "reddit": { "command": "uvx", "args": ["reddit-mcp"] },
  "kite":   { "command": "node", "args": ["/opt/kite.js"] } } }
JSON

count_json() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.keys(j.mcpServers||{}).length)' "$1" 2>/dev/null || echo ERR; }
has_json()   { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const s=(j.mcpServers||{})[process.argv[2]];console.log(s?JSON.stringify(s.args||[]):"")' "$1" "$2" 2>/dev/null; }

run_onboard() {
  env HOME="$SANDBOX" \
      AGENTIC_BRAIN_HOME="$SANDBOX/.agentic-brain" \
      BRAIN_NO_AUTOMATION=1 \
      PATH="$SCRATCH/stub:$PATH" \
      node "$REPO/bin/brain.mjs" onboard 2>&1
}

# defense in depth: a stub launchctl that records instead of acting
mkdir -p "$SCRATCH/stub"
printf '#!/bin/sh\necho "launchctl $*" >> "%s/launchctl.calls"\nexit 0\n' "$SCRATCH" > "$SCRATCH/stub/launchctl"
chmod +x "$SCRATCH/stub/launchctl"

head_ "1. brain onboard (real, sandboxed \$HOME)"
OUT="$(run_onboard)"; RC=$?
[ $RC -eq 0 ] && ok "onboard exited 0" || bad "onboard exited $RC"
[ -f "$SANDBOX/.agentic-brain/bridge.cjs" ] && ok "bridge shim created" || bad "bridge shim missing"
[ -f "$SANDBOX/.agentic-brain/engine-path" ] && ok "engine pointer created" || bad "engine pointer missing"
[ ! -f "$SCRATCH/launchctl.calls" ] && ok "no launchctl calls (BRAIN_NO_AUTOMATION=1)" \
  || bad "launchctl was invoked: $(cat "$SCRATCH/launchctl.calls" | head -2)"

head_ "2. every tool wired to the SHIM path"
SHIM="$SANDBOX/.agentic-brain/server.cjs"   # wireMcp now writes the MCP server, not the bridge
for pair in "cursor:$SANDBOX/.cursor/mcp.json" \
            "claude_desktop:$SANDBOX/Library/Application Support/Claude/claude_desktop_config.json" \
            "antigravity:$SANDBOX/.gemini/config/mcp_config.json"; do
  name="${pair%%:*}"; file="${pair#*:}"
  args="$(has_json "$file" agentic-brain)"
  case "$args" in
    *"$SHIM"*) ok "$name → shim path" ;;
    "")        bad "$name → agentic-brain NOT registered" ;;
    *)         bad "$name → wrong path: $args" ;;
  esac
done
[ -z "$(has_json "$SANDBOX/.gemini/settings.json" agentic-brain)" ] \
  && [ "$(shasum -a 1 "$SANDBOX/.gemini/settings.json" | awk '{print $1}')" = "$GEMINI_SETTINGS_BEFORE" ] \
  && ok "Gemini CLI ~/.gemini/settings.json NOT wired (unsupported; bytes unchanged)" \
  || bad "Gemini CLI ~/.gemini/settings.json was modified — Gemini CLI is not a supported target"
grep -q "mcp_servers.agentic-brain" "$SANDBOX/.codex/config.toml" && ok "codex (toml) → agentic-brain block added" \
  || bad "codex (toml) → agentic-brain block missing"
grep -q "$SHIM" "$SANDBOX/.codex/config.toml" && ok "codex (toml) → shim path" \
  || bad "codex (toml) → not pointing at shim"

head_ "3. pre-existing servers survived (the critical assertion)"
[ "$(count_json "$SANDBOX/.cursor/mcp.json")" = "3" ] && ok "cursor 2 → 3 (figma, storybook kept)" \
  || bad "cursor server count = $(count_json "$SANDBOX/.cursor/mcp.json"), expected 3"
[ "$(count_json "$SANDBOX/Library/Application Support/Claude/claude_desktop_config.json")" = "4" ] \
  && ok "claude desktop 3 → 4 (figma, reddit, kite kept)" \
  || bad "claude desktop count = $(count_json "$SANDBOX/Library/Application Support/Claude/claude_desktop_config.json"), expected 4"
[ "$(count_json "$SANDBOX/.gemini/config/mcp_config.json")" = "2" ] && ok "antigravity mcp 1 → 2 (gsearch kept)" \
  || bad "antigravity mcp count wrong"
for t in existing_one existing_two; do
  grep -q "\[mcp_servers.$t\]" "$SANDBOX/.codex/config.toml" && ok "codex: $t survived" || bad "codex: $t LOST"
done
grep -q '\[tui\]' "$SANDBOX/.codex/config.toml" && ok "codex: [tui] table survived" || bad "codex: [tui] LOST"
grep -q '/opt/tools/one.js' "$SANDBOX/.codex/config.toml" && ok "codex: Bug-1-shaped args = [...] intact" \
  || bad "codex: args with '[' was corrupted"
# no orphaned table header (the Bug-1 signature)
if grep -qE '^\["?/.*\.(cjs|js)"?\]' "$SANDBOX/.codex/config.toml"; then
  bad "codex: ORPHANED table header present (Bug 1 regression)"
else ok "codex: no orphaned table header"; fi

head_ "4. backups created for modified configs"
BAKS=$(find "$SANDBOX" -name '*.bak-*' 2>/dev/null | wc -l | tr -d ' ')
[ "$BAKS" -ge 3 ] && ok "$BAKS backup file(s) created" || bad "only $BAKS backups (expected ≥3)"

head_ "5. idempotence — second run changes nothing"
SNAP="$SCRATCH/snap1"; mkdir -p "$SNAP"
find "$SANDBOX" -name '*.json' -o -name '*.toml' | while read -r f; do shasum -a 1 "$f"; done | sort > "$SNAP/a"
OUT2="$(run_onboard)"
find "$SANDBOX" -name '*.json' -o -name '*.toml' | while read -r f; do shasum -a 1 "$f"; done | sort > "$SNAP/b"
diff -q "$SNAP/a" "$SNAP/b" >/dev/null && ok "no config bytes changed on re-run" || bad "re-run modified configs"
BAKS2=$(find "$SANDBOX" -name '*.bak-*' 2>/dev/null | wc -l | tr -d ' ')
[ "$BAKS2" = "$BAKS" ] && ok "no new backups on re-run" || bad "re-run created backups ($BAKS → $BAKS2)"
echo "$OUT2" | grep -qiE "already wired|unchanged" && ok "report says already wired/unchanged" \
  || bad "report did not say unchanged"

head_ "6. brain doctor agrees with onboard (the T5/T6 seam)"
# stdout only: Node may print warnings (e.g. "SQLite is an experimental feature") on stderr,
# which would make the JSON unparseable if merged in.
DOC="$(env HOME="$SANDBOX" AGENTIC_BRAIN_HOME="$SANDBOX/.agentic-brain" \
        node "$REPO/bin/brain.mjs" doctor --json 2>/dev/null)"; DRC=$?
echo "$DOC" | grep -qiE '"level"\s*:\s*"PASS"' && ok "doctor reports PASS rows" || bad "doctor reports no PASS rows"
WIRED_NOTREG=$(node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let j; try{ j=JSON.parse(s) }catch{ console.log("PARSE_FAIL"); return }
  const rows=(j.tools||j.rows||[]).filter(r=>["cursor","claude_desktop","antigravity","codex"].includes(r.id));
  const bad=rows.filter(r=>/not registered/i.test(JSON.stringify((r.checks&&r.checks.pull)||r.pull||"")));
  console.log(bad.length?bad.map(r=>r.id).join(","):"NONE");
});' <<<"$DOC")
if [ "$WIRED_NOTREG" = "NONE" ]; then ok "no wired tool reported 'not registered'"
elif [ "$WIRED_NOTREG" = "PARSE_FAIL" ]; then bad "doctor --json did not emit parseable JSON"
else bad "doctor says not-registered for: $WIRED_NOTREG (seam regression)"; fi
echo "     doctor exit code: $DRC"

head_ "7. repo move recovers via pointer rewrite only"
CFG_BEFORE=$(shasum -a 1 "$SANDBOX/.cursor/mcp.json" | awk '{print $1}')
PTR_BEFORE=$(cat "$SANDBOX/.agentic-brain/engine-path" 2>/dev/null)
MOVED="$SCRATCH/moved-engine"; mkdir -p "$MOVED"
tar -C "$REPO" --exclude .git --exclude node_modules -cf - . | tar -C "$MOVED" -xf -
[ -f "$MOVED/bin/brain.mjs" ] && ok "engine copied to new location" || bad "engine copy failed"
env HOME="$SANDBOX" AGENTIC_BRAIN_HOME="$SANDBOX/.agentic-brain" BRAIN_NO_AUTOMATION=1 \
    node "$MOVED/bin/brain.mjs" onboard >/dev/null 2>&1
PTR_AFTER=$(cat "$SANDBOX/.agentic-brain/engine-path" 2>/dev/null)
CFG_AFTER=$(shasum -a 1 "$SANDBOX/.cursor/mcp.json" | awk '{print $1}')
[ "$PTR_BEFORE" != "$PTR_AFTER" ] && ok "pointer rewritten to new engine path" || bad "pointer unchanged after move"
[ "$CFG_BEFORE" = "$CFG_AFTER" ] && ok "tool config untouched by repo move" || bad "repo move rewrote tool config"

head_ "8. Gemini CLI is never wired — even with its creds and binary present"
# Gemini CLI is unsupported: no registry row exists, so neither its creds
# marker nor a `gemini` binary on PATH may cause ~/.gemini/settings.json to be
# written. Antigravity (~/.gemini/config/) must still be wired. A stub
# `gemini` binary on PATH makes this deterministic on every machine.
NEGHOME="$SCRATCH/neg-home"
mkdir -p "$NEGHOME"/.gemini/config "$NEGHOME"/.claude "$SCRATCH/gstub"
printf '#!/bin/sh\nexit 0\n' > "$SCRATCH/gstub/gemini"; chmod +x "$SCRATCH/gstub/gemini"
echo '{ "mcpServers": { "figma-x": { "command": "npx", "args": ["x"] } } }' \
  > "$NEGHOME/.gemini/config/mcp_config.json"
echo '{ "theme": "dark" }' > "$NEGHOME/.gemini/settings.json"
: > "$NEGHOME/.gemini/oauth_creds.json"
env HOME="$NEGHOME" \
    AGENTIC_BRAIN_HOME="$NEGHOME/.agentic-brain" \
    BRAIN_NO_AUTOMATION=1 \
    PATH="$SCRATCH/gstub:$SCRATCH/stub:$PATH" \
    node "$REPO/bin/brain.mjs" onboard >/dev/null 2>&1
NEG_SHIM="$NEGHOME/.agentic-brain/server.cjs"
NEG_GEMINI_ARGS="$(has_json "$NEGHOME/.gemini/settings.json" agentic-brain)"
[ -z "$NEG_GEMINI_ARGS" ] && ok "Gemini CLI settings.json NOT wired (creds + binary present)" \
  || bad "Gemini CLI settings.json was wired: $NEG_GEMINI_ARGS"
NEG_ANTI_ARGS="$(has_json "$NEGHOME/.gemini/config/mcp_config.json" agentic-brain)"
case "$NEG_ANTI_ARGS" in
  *"$NEG_SHIM"*) ok "antigravity still wired alongside Gemini CLI files (config/ present)" ;;
  *) bad "antigravity should have been wired: $NEG_ANTI_ARGS" ;;
esac
rm -rf "$NEGHOME"

head_ "9. REAL machine untouched"
i=0; REAL_OK=1
for f in "${REAL_FILES[@]}"; do
  now=$( [ -f "$f" ] && shasum -a 1 "$f" | awk '{print $1}' || echo MISSING )
  if [ "$now" != "${BEFORE[$i]}" ]; then bad "MODIFIED: $f"; REAL_OK=0; fi
  i=$((i+1))
done
[ "$REAL_OK" = 1 ] && ok "all real tool configs byte-identical (sha1)"
now_ab=$( [ -e "$HOME/.agentic-brain" ] && echo present || echo absent )
[ "$now_ab" = "$REAL_AB_BEFORE" ] && ok "real ~/.agentic-brain unchanged ($now_ab)" \
  || bad "real ~/.agentic-brain changed: $REAL_AB_BEFORE → $now_ab"

printf '\n\033[1m%s\033[0m\n' "── summary ──"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
printf '  real: wiring, idempotence, doctor, repo-move | stubbed: brain init, launchd, sync\n'
[ "$FAIL" -eq 0 ] || exit 1
