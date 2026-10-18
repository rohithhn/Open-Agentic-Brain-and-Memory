#!/usr/bin/env bash
# Open Agentic Brain and Memory v1 — does it work inside every app? (sandbox)
# Apps: Claude Code · Claude Desktop · Cursor · Codex CLI (+ Codex/ChatGPT desktop,
# which share ~/.codex/config.toml) · Antigravity CLI · Kilo Code (VS Code extension, beta). Gemini CLI is deliberately
# NOT installed, to prove it isn't falsely wired.
#
# Same isolation as sandbox-test.sh: fake HOME, fake gh/Keychain/launchd, no network.
# Engine = local repo HEAD + your uncommitted bin/ changes (WIP=0 to test HEAD only).
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/lib.sh"
sb_mktemp apps
export SB_GITHUB="$SB/github" SB_LOG="$SB/calls.log"
PASS=0; FAIL=0; RESULTS=()
ok()  { PASS=$((PASS+1)); RESULTS+=("PASS  $1"); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1${2:+ — $2}"); echo "  ❌ $1${2:+ — $2}"; }
check(){ local n="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi; }
H="$SB/mac"; KC="$SB/mac-keychain"
FULLPATH="$ROOT/shims:$TOOLPATH"
# Where desktop apps keep per-user data: macOS ~/Library/Application Support, Linux ~/.config
# (Electron userData — what real Cursor / Claude Desktop use). Linux also needs shims-linux
# (file-backed secret-tool, md5, BSD-form script) and the libsecret path selected.
if [ "$(uname -s)" = Linux ]; then
  APPSUP="$SB/mac/.config"; FULLPATH="$ROOT/shims-linux:$FULLPATH"; LINUX_ENV="BRAIN_SECRET_BACKEND=libsecret"
  mkdir -p "$SB/hostbin" && ln -sf "$ROOT/shims-linux/md5" "$SB/hostbin/md5" && PATH="$SB/hostbin:$PATH"
  SBSUM=sha1sum
else
  APPSUP="$SB/mac/Library/Application Support"; LINUX_ENV=""
  SBSUM=shasum
fi
GUIPATH="/usr/bin:/bin:/usr/sbin:/sbin"   # what macOS gives apps launched from the Dock
on() { env -i HOME="$H" PATH="$FULLPATH" USER=sandbox TMPDIR="$H/tmp" SB_GITHUB="$SB_GITHUB" \
         SB_LOG="$SB_LOG" SB_KEYCHAIN="$KC" BRAIN_NO_AUTOMATION=1 BRAIN_SKIP_NPM=1 BRAIN_TEST=1 ${LINUX_ENV:-} "$@"; }
E="$H/agentic-brain"
brain() { on node "$E/bin/brain.mjs" "$@"; }

# ── engine ────────────────────────────────────────────────────────────────
sb_engine "$SB/engine-src" || exit 2
mkdir -p "$SB_GITHUB/OWNER"; git clone -q --bare "$SB/engine-src" "$SB_GITHUB/OWNER/agentic-brain.git"
echo "🧪 Open Agentic Brain and Memory — app wiring sandbox"; echo "   engine: $WIPNOTE"

# ── a Mac with every app installed, each already holding the user's own stuff ──
mkdir -p "$H/tmp" "$H/Documents"
HOME="$H" git config --global user.name sandbox; HOME="$H" git config --global user.email s@sandbox.invalid
HOME="$H" git config --global url."file://$SB_GITHUB/".insteadOf "https://github.com/"
# Claude Code
mkdir -p "$H/.claude/projects/-Users-demo-shop"
cat > "$H/.claude.json" <<'EOF'
{ "numStartups": 42, "theme": "dark",
  "mcpServers": { "figma": { "command": "npx", "args": ["-y", "figma-mcp"] } },
  "projects": { "/Users/demo/shop": { "allowedTools": [] } } }
EOF
cat > "$H/.claude/projects/-Users-demo-shop/11111111-aaaa-bbbb-cccc-000000000001.jsonl" <<'EOF'
{"type":"user","sessionId":"11111111-aaaa-bbbb-cccc-000000000001","cwd":"/Users/demo/shop","timestamp":"2026-09-28T10:00:00Z","message":{"role":"user","content":"Refactor the checkout flow, codename kiwi"}}
{"type":"assistant","sessionId":"11111111-aaaa-bbbb-cccc-000000000001","timestamp":"2026-09-28T10:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"Done — kiwi checkout now uses one reducer."}]}}
EOF
cat > "$H/.claude/settings.json" <<'EOF2'
{ "theme": "dark", "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "echo my-own-hook" } ] } ] } }
EOF2
mkdir -p "$H/work/shop"
# Claude Desktop
CD="$APPSUP/Claude"; mkdir -p "$CD"
cat > "$CD/claude_desktop_config.json" <<'EOF'
{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/demo"] },
                  "github": { "command": "docker", "args": ["run", "ghcr.io/github/github-mcp-server"] } },
  "preferences": { "quickEntryShortcut": "off" } }
EOF
# Cursor (config + chat DB)
mkdir -p "$H/.cursor" "$APPSUP/Cursor/User/globalStorage"
echo '{ "mcpServers": { "storybook": { "url": "http://localhost:6006/mcp" } } }' > "$H/.cursor/mcp.json"
sqlite3 "$APPSUP/Cursor/User/globalStorage/state.vscdb" <<'EOF'
CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
INSERT INTO cursorDiskKV VALUES ('composerData:c1', '{"composerId":"c1","name":"Fix papaya layout","createdAt":1790000000000,"fullConversationHeadersOnly":[{"bubbleId":"b1"},{"bubbleId":"b2"}]}');
INSERT INTO cursorDiskKV VALUES ('bubbleId:c1:b1', '{"type":1,"text":"Why does the papaya grid overflow on mobile?"}');
INSERT INTO cursorDiskKV VALUES ('bubbleId:c1:b2', '{"type":2,"text":"The papaya grid needs min-width: 0."}');
EOF
# …and its workspaceStorage: the window c1 ran in was the folder ~/work/papaya-shop
CWS="$APPSUP/Cursor/User/workspaceStorage/0123456789abcdef0123456789abcdef"; mkdir -p "$CWS"
echo "{ \"folder\": \"file://$H/work/papaya-shop\" }" > "$CWS/workspace.json"
sqlite3 "$CWS/state.vscdb" <<'EOF'
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
INSERT INTO ItemTable VALUES ('composer.composerData', '{"selectedComposerIds":["c1"],"lastFocusedComposerIds":["c1"],"hasMigratedComposerData":true}');
EOF
CURSOR_SUM_BEFORE=$(cd "$APPSUP/Cursor" && find . -type f -exec "$SBSUM" {} + | sort)
# Codex CLI / Codex app / ChatGPT desktop (shared config.toml)
mkdir -p "$H/.codex/sessions/2026/09/28"
cat > "$H/.codex/config.toml" <<'EOF'
model = "gpt-5-codex"
approval_policy = "on-request"

[mcp_servers.linear]
command = "npx"
args = ["-y", "linear-mcp"]

[profiles.fast]
model = "gpt-5-mini"
EOF
cat > "$H/.codex/sessions/2026/09/28/rollout-2026-09-28T09-00-00-cx1.jsonl" <<'EOF'
{"timestamp":"2026-09-28T09:00:00Z","type":"session_meta","payload":{"id":"cx1","cwd":"/Users/demo/api","timestamp":"2026-09-28T09:00:00Z"}}
{"timestamp":"2026-09-28T09:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Add rate limiting to the mango endpoint"}]}}
{"timestamp":"2026-09-28T09:00:09Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Added a token bucket to mango."}]}}
EOF
# Gemini CLI present (signed in, binary on PATH) — still must never be wired.
mkdir -p "$H/.gemini" "$H/stubbin"
echo '{ "access_token": "sandbox-not-a-token" }' > "$H/.gemini/oauth_creds.json"
printf '#!/bin/sh\necho 0.1.0\n' > "$H/stubbin/gemini"; chmod +x "$H/stubbin/gemini"
FULLPATH="$H/stubbin:$FULLPATH"
# Antigravity CLI
mkdir -p "$H/.gemini/config" "$H/.gemini/antigravity-cli"
echo '{ "mcpServers": { "figma": { "command": "npx", "args": ["figma-mcp"] } } }' > "$H/.gemini/config/mcp_config.json"
# agy < 1.3 wrote a prompt log (history.jsonl); agy >= 1.3 writes one SQLite DB per conversation with the
# trajectory as protobuf blobs (layout: parseAntigravity in bin/lib/ingest.mjs). Both must be captured.
echo '{"display":"Write tests for the guava parser","timestamp":"1790000000000","workspace":"/Users/demo/guava","conversationId":"ag1"}' > "$H/.gemini/antigravity-cli/history.jsonl"
mkdir -p "$H/.gemini/antigravity-cli/conversations"
"$NODE_BIN" --input-type=module -e '
  const { DatabaseSync } = await import("node:sqlite");
  const { pbEncode } = await import(process.argv[1]);
  const db = new DatabaseSync(process.argv[2]);
  db.exec("CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id)); CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx)); CREATE TABLE trajectory_metadata_blob (id text DEFAULT \"main\", data blob, PRIMARY KEY (id))");
  const ts = [[1, 1790000100], [2, 0]];
  db.prepare("INSERT INTO trajectory_meta VALUES (?, ?, 4, 17)").run("tr1", "ag2-0000-4000-8000-000000000001");
  db.prepare("INSERT INTO trajectory_metadata_blob VALUES (?, ?)").run("main", pbEncode([[1, [[1, "file:///Users/demo/tamarind-api"]]], [2, ts], [6, "ag2-0000-4000-8000-000000000001"], [7, "file:///Users/demo/tamarind-api"]]));
  const step = (i, type, body) => db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)").run(i, type, pbEncode([[1, type], [4, 3], [5, [[1, ts]]], ...body]));
  step(0, 14, [[19, [[2, "Why does the tamarind importer drop rows?"]]]]);
  step(1, 15, [[20, [[1, "The tamarind importer skips rows with an empty id."], [7, [[2, "view_file"]]]]]]);
  db.close();
' "$SRC/bin/lib/protowire.mjs" "$H/.gemini/antigravity-cli/conversations/ag2-0000-4000-8000-000000000001.db" || echo "  (could not build the agy 1.3 fixture)"

# Kilo Code (beta): the VS Code extension + the CLI share ~/.config/kilo/kilo.jsonc (MCP under `mcp`,
# JSONC with the user's own comments + server), ~/.config/kilo/AGENTS.md (global instructions the user
# already owns) and ~/.local/share/kilo/kilo.db (sessions). Shapes read from Kilo-Org/kilocode source.
KGS="$APPSUP/Code/User/globalStorage/kilocode.kilo-code"; mkdir -p "$KGS" "$H/.config/kilo" "$H/.local/share/kilo"
cat > "$H/.config/kilo/kilo.jsonc" <<'KEOF'
// my kilo config
{
  "$schema": "https://app.kilo.ai/config.json",
  "model": "kilo/auto", // keep this
  "mcp": {
    "docs": { "type": "remote", "url": "https://docs.example/mcp" },
  },
}
KEOF
printf '# my kilo rules\nBe terse.\n' > "$H/.config/kilo/AGENTS.md"
sqlite3 "$H/.local/share/kilo/kilo.db" <<'KEOF'
CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL);
CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
INSERT INTO project VALUES ('prj_1', '/Users/demo/soursop-app', 1790000000000, 1790000000000, '[]');
INSERT INTO session VALUES ('ses_k1', 'prj_1', NULL, 'bright-comet', '/Users/demo/soursop-app/web', 'New session - 2026-09-28', '7.8.8', 1790000000000, 1790000060000, NULL);
INSERT INTO message VALUES ('msg_k1', 'ses_k1', 1790000001000, 1790000001000, '{"role":"user"}');
INSERT INTO part VALUES ('prt_k1', 'msg_k1', 'ses_k1', 1790000001000, 1790000001000, '{"type":"text","text":"Why is the soursop cache never invalidated?"}');
INSERT INTO message VALUES ('msg_k2', 'ses_k1', 1790000002000, 1790000002000, '{"role":"assistant"}');
INSERT INTO part VALUES ('prt_k2', 'msg_k2', 'ses_k1', 1790000002000, 1790000002000, '{"type":"tool","tool":"read","state":{"status":"completed"}}');
INSERT INTO part VALUES ('prt_k3', 'msg_k2', 'ses_k1', 1790000002000, 1790000002000, '{"type":"text","text":"The soursop cache key omits the tenant id."}');
KEOF
KILO_SUM_BEFORE=$(find "$H/.local/share/kilo" "$KGS" -type f -exec "$SBSUM" {} + | sort)
AGY_SUM_BEFORE=$(find "$H/.gemini/antigravity-cli/conversations" "$H/.gemini/antigravity-cli/history.jsonl" -type f -exec "$SBSUM" {} + | sort)

snap() { # checksum every app config — for idempotency + preservation checks
  for f in "$H/.claude/settings.json" "$H/.claude.json" "$CD/claude_desktop_config.json" "$H/.cursor/mcp.json" "$H/.codex/config.toml" "$H/.gemini/config/mcp_config.json" "$H/.config/kilo/kilo.jsonc"; do
    [ -f "$f" ] && md5 -q "$f"; done | tr '\n' ' '; }

# ── 1. install + onboard ─────────────────────────────────────────────────
echo; echo "1) install.sh (init) → brain onboard"
on env BRAIN_MODE=init AGENTIC_BRAIN_REPO=OWNER/agentic-brain bash "$SB/engine-src/install.sh" > "$SB/1-install.log" 2>&1 \
  && ok "install exits 0" || bad "install exits 0" "see 1-install.log"
# First run: the installer back-fills from history already on the machine and says so.
grep -q "past session" "$SB/1-install.log" && ok "install reports the past sessions it found" \
  || bad "install reports the past sessions it found" "$(grep -E 'past AI sessions|past session' "$SB/1-install.log" | head -2)"
grep -q "37800" "$SB/1-install.log" && ok "install points to the control panel" || bad "install points to the control panel" "no panel URL in 1-install.log"
# Past sessions: asked before anything captures; with no terminal the recommended answer (include) is recorded.
grep -q '"mode": "all"' "$H/.claude-brain/past-sessions.json" 2>/dev/null && ok "past-sessions choice recorded (no terminal → recommended: include)" \
  || bad "past-sessions choice recorded (no terminal → recommended: include)" "$(cat "$H/.claude-brain/past-sessions.json" 2>&1 | head -3)"
brain onboard > "$SB/1-onboard.log" 2>&1 && ok "brain onboard exits 0" || bad "brain onboard exits 0" "see 1-onboard.log"
check "server shim installed (~/.agentic-brain/server.cjs)" test -f "$H/.agentic-brain/server.cjs"

# ── 2. each app's config: wired, nothing of the user's lost ─────────────────
echo; echo "2) App configs"
jsonchk() { # jsonchk <label> <file> <key> <mustKeepServer> [<mustKeepTopKey>]
  node -e '
    const [f,key,keep,top]=process.argv.slice(1); const c=JSON.parse(require("fs").readFileSync(f,"utf8"));
    const s=(c[key]||{})["agentic-brain"]; const r=[];
    if(!s) r.push("no agentic-brain entry");
    else { if(!require("path").isAbsolute(s.command)) r.push("command not absolute: "+s.command);
           if(!require("fs").existsSync(s.args?.[0]||"")) r.push("server path missing"); }
    if(!(c[key]||{})[keep]) r.push("LOST existing server "+keep);
    if(top && !(top in c)) r.push("LOST top-level key "+top);
    if((c[key]||{})["claude-mem"]) r.push("legacy claude-mem entry still present");
    if(r.length){console.log(r.join("; "));process.exit(1)}' "$2" "$3" "$4" "${5:-}" > "$SB/.why" 2>&1 \
    && ok "$1: wired, existing config kept" || bad "$1: wired, existing config kept" "$(cat "$SB/.why")"; }
jsonchk "Claude Code"     "$H/.claude.json"                  mcpServers figma numStartups
jsonchk "Claude Desktop"  "$CD/claude_desktop_config.json"   mcpServers filesystem preferences
jsonchk "Cursor"          "$H/.cursor/mcp.json"              mcpServers storybook
jsonchk "Antigravity CLI" "$H/.gemini/config/mcp_config.json" mcpServers figma
T="$H/.codex/config.toml"; why=""
grep -q '^\[mcp_servers\.agentic-brain\]' "$T" || grep -q '^\[mcp_servers\."agentic-brain"\]' "$T" || why+="no agentic-brain table; "
grep -q '^\[mcp_servers\.linear\]' "$T" || why+="LOST linear server; "
grep -q '^model = "gpt-5-codex"' "$T" || why+="LOST model setting; "
grep -q '^\[profiles\.fast\]' "$T" || why+="LOST profile; "
[ -z "$(grep '^\[' "$T" | sort | uniq -d)" ] || why+="duplicate TOML table (invalid file); "
[ -z "$why" ] && ok "Codex / ChatGPT desktop (config.toml): wired, existing config kept" || bad "Codex / ChatGPT desktop (config.toml): wired, existing config kept" "$why"
# Kilo keeps MCP under `mcp` (JSONC): wired, the user's comments / server / model kept byte-for-byte
KJ="$H/.config/kilo/kilo.jsonc"
node --input-type=module -e '
  const { parseJsonc, valueOf } = await import(process.argv[1]); const fs = await import("node:fs"), path = await import("node:path");
  const raw = fs.readFileSync(process.argv[2], "utf8"); const p = parseJsonc(raw); const r = [];
  if (!p.ok) r.push("config no longer parses: " + p.error); else {
    const c = valueOf(p.root); const s = (c.mcp || {})["agentic-brain"];
    if (!s) r.push("no agentic-brain entry"); else {
      if (s.type !== "local") r.push("type " + s.type);
      if (!path.isAbsolute(s.command?.[0] || "")) r.push("command not absolute: " + s.command?.[0]);
      if (!fs.existsSync(s.command?.[1] || "")) r.push("server path missing"); }
    if (!(c.mcp || {}).docs) r.push("LOST existing server docs"); if (c.model !== "kilo/auto") r.push("LOST model");
    if (c.mcpServers) r.push("wrote the wrong key (mcpServers)"); }
  if (!raw.startsWith("// my kilo config\n{\n  \"$schema\"")) r.push("LOST leading comment/format");
  if (!raw.includes("\"model\": \"kilo/auto\", // keep this")) r.push("LOST inline comment");
  if (r.length) { console.log(r.join("; ")); process.exit(1); }' "file://$E/bin/lib/jsonc-edit.mjs" "$KJ" > "$SB/.why" 2>&1 \
  && ok "Kilo Code (kilo.jsonc mcp): wired, comments + existing server + model kept" || bad "Kilo Code (kilo.jsonc mcp): wired, existing config kept" "$(cat "$SB/.why")"
check "Gemini CLI (installed + signed in) NOT wired" test ! -e "$H/.gemini/settings.json"
grep -q '^{ "access_token": "sandbox-not-a-token" }$' "$H/.gemini/oauth_creds.json" && ok "Gemini CLI creds untouched" || bad "Gemini CLI creds untouched"

# ── 3. idempotency ──────────────────────────────────────────────────────────
echo; echo "3) Re-running onboard changes nothing"
before="$(snap)"; brain onboard > "$SB/3-onboard2.log" 2>&1; after="$(snap)"
[ "$before" = "$after" ] && ok "second onboard leaves every config byte-identical" || bad "second onboard leaves every config byte-identical"

echo; echo "3b) Machines wired by the old version (bare \"node\") get upgraded"
node -e 'const f=process.argv[1];const c=JSON.parse(require("fs").readFileSync(f));c.mcpServers["agentic-brain"].command="node";require("fs").writeFileSync(f,JSON.stringify(c,null,2))' "$CD/claude_desktop_config.json"
brain onboard > "$SB/3b-onboard.log" 2>&1
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(require("path").isAbsolute(c.mcpServers["agentic-brain"].command)?0:1)' "$CD/claude_desktop_config.json" \
  && ok "old bare-node entry upgraded to absolute node" || bad "old bare-node entry upgraded to absolute node"

# ── 4. launch the brain the way each app does, and use it ────────────────────
echo; echo "4) Each app launches the brain and uses it (real MCP handshake)"
serverdef() { # prints "<command>\t<argsJSON>" from the app's own config
  case "$1" in
    toml) node -e '
      const t=require("fs").readFileSync(process.argv[1],"utf8");
      const m=t.split(/^\[/m).find(s=>/^mcp_servers\.("?)agentic-brain\1\]/.test(s))||"";
      const cmd=(m.match(/^command\s*=\s*"([^"]*)"/m)||[])[1]; const args=(m.match(/^args\s*=\s*(\[.*\])/m)||[])[1]||"[]";
      console.log(cmd+"\t"+args)' "$2";;
    kilo) node --input-type=module -e '
      const { parseJsonc, valueOf } = await import(process.argv[1]); const c = valueOf(parseJsonc((await import("node:fs")).readFileSync(process.argv[2], "utf8")).root);
      const s = (c.mcp || {})["agentic-brain"] || {}; console.log((s.command || [])[0] + "\t" + JSON.stringify((s.command || []).slice(1)))' "file://$E/bin/lib/jsonc-edit.mjs" "$2";;
    *) node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const s=c.mcpServers["agentic-brain"]||{};console.log(s.command+"\t"+JSON.stringify(s.args||[]))' "$2";;
  esac; }
probe() { # probe <label> <fmt> <config> <PATH> <word-to-save> <word-to-find>
  IFS=$'\t' read -r cmd args < <(serverdef "$2" "$3")
  env -i HOME="$H" PATH="$4" TMPDIR="$H/tmp" BRAIN_TEST=1 "$NODE_BIN" "$ROOT/mcp-probe.mjs" "$1" "$cmd" "$args" "note about $5" "$6" > "$SB/.p" 2>&1
  local r; r="$(tail -1 "$SB/.p")"; echo "$r" >> "$SB/4-probes.jsonl"
  node -e 'const r=JSON.parse(process.argv[1]);
    const need=["brain_remember","brain_recall","brain_context"];const miss=need.filter(t=>!(r.tools||[]).includes(t));
    const why=[]; if(r.error)why.push(r.error); if(miss.length)why.push("missing tools "+miss); if(r.ok&&!r.remembered)why.push("save failed "+(r.rememberRaw||"")); if(r.ok&&!r.recallHit)why.push("could not find "+process.argv[2]); if(r.ok&&!r.overview)why.push("\"load all my memory\" gave no overview");
    if(why.length){console.log(why.join("; ").slice(0,300));process.exit(1)}' "$r" "$6" > "$SB/.why" 2>&1 \
    && ok "$1: saves; answers a specific ask from another app's memory; \"load all my memory\" → overview" || bad "$1: specific + load-all" "$(cat "$SB/.why")"; }
# each app saves a word; the next app must find the previous app's word (cross-tool)
probe "Claude Code"      json "$H/.claude.json"                    "$FULLPATH" lychee  kiwi
probe "Claude Desktop (Dock PATH)" json "$CD/claude_desktop_config.json" "$GUIPATH" durian  lychee
probe "Cursor (Dock PATH)"         json "$H/.cursor/mcp.json"            "$GUIPATH" rambutan durian
probe "Codex/ChatGPT (Dock PATH)"  toml "$H/.codex/config.toml"          "$GUIPATH" quince  rambutan
probe "Antigravity CLI"  json "$H/.gemini/config/mcp_config.json"  "$FULLPATH" feijoa  quince
probe "Kilo Code (VS Code)" kilo "$KJ" "$GUIPATH" soursopnote feijoa

# ── 5. context pushed into each app's instructions file ─────────────────────
echo; echo "5) Brain context injected into each tool's instructions file"
for pair in "Claude Code:$H/.claude/CLAUDE.md" "Codex:$H/.codex/AGENTS.md" "Antigravity:$H/.gemini/GEMINI.md"; do
  n="${pair%%:*}"; f="${pair#*:}"
  if [ -s "$f" ] && grep -qi "brain" "$f" && grep -q "load all my memory" "$f"; then ok "$n: $(basename "$f") has the brain block + how to ask for everything"; else bad "$n: $(basename "$f") has the brain block + load-all line" "missing"; fi
done
KA="$H/.config/kilo/AGENTS.md"
if grep -q "load all my memory" "$KA" && grep -q "^# my kilo rules" "$KA" && grep -q "^Be terse" "$KA"; then ok "Kilo Code: ~/.config/kilo/AGENTS.md has the brain block, the user's own rules kept"; else bad "Kilo Code: AGENTS.md has the brain block + user rules kept" "missing"; fi
echo "  ℹ️  Claude Desktop, Cursor, ChatGPT have no global instructions file — they rely on the MCP tools (step 4)"

# ── 6. capture: each app's past work lands in the brain ─────────────────────
echo; echo "6) Capture — existing sessions from each app become memory"
brain sync > "$SB/6-sync.log" 2>&1 || bad "brain sync exits 0" "see 6-sync.log"
for pair in "Claude Code:kiwi" "Cursor:papaya" "Codex:mango" "Antigravity (history.jsonl, agy < 1.3):guava" "Antigravity (conversation DB, agy >= 1.3):tamarind" "Kilo Code:soursop"; do
  n="${pair%%:*}"; w="${pair#*:}"
  brain recall "$w" > "$SB/.r" 2>&1
  grep -qv "no results" "$SB/.r" && ! grep -q "no results" "$SB/.r" \
    && ok "$n session captured (\"$w\" is recallable)" || bad "$n session captured (\"$w\" is recallable)"
done
CPROJ=$(sqlite3 -readonly "$H/.claude-brain/brain.db" "SELECT project FROM sdk_sessions WHERE memory_session_id='cursor:c1'" 2>/dev/null)
[ "$CPROJ" = "papaya-shop" ] && ok "Cursor session filed under its folder's project (papaya-shop)" \
  || bad "Cursor session filed under its folder's project (papaya-shop)" "got '$CPROJ'"
CURSOR_SUM_AFTER=$(cd "$APPSUP/Cursor" && find . -type f -exec "$SBSUM" {} + | sort)
[ "$CURSOR_SUM_BEFORE" = "$CURSOR_SUM_AFTER" ] && ok "Cursor's own files untouched by capture (read-only)" \
  || bad "Cursor's own files untouched by capture (read-only)"
KPROJ=$(sqlite3 -readonly "$H/.claude-brain/brain.db" "SELECT project FROM sdk_sessions WHERE memory_session_id='kilo:ses_k1'" 2>/dev/null)
[ "$KPROJ" = "soursop-app" ] && ok "Kilo session filed under its repo's project (soursop-app)" || bad "Kilo session filed under its repo's project (soursop-app)" "got '$KPROJ'"
KILO_SUM_AFTER=$(find "$H/.local/share/kilo" "$KGS" -type f -exec "$SBSUM" {} + | sort)
[ "$KILO_SUM_BEFORE" = "$KILO_SUM_AFTER" ] && ok "Kilo's own kilo.db untouched by capture (read-only)" || bad "Kilo's own kilo.db untouched by capture (read-only)"
APROJ=$(sqlite3 -readonly "$H/.claude-brain/brain.db" "SELECT project FROM sdk_sessions WHERE memory_session_id='antigravity:ag2-0000-4000-8000-000000000001'" 2>/dev/null)
[ "$APROJ" = "tamarind-api" ] && ok "Antigravity conversation filed under its workspace's project (tamarind-api)" || bad "Antigravity conversation filed under its workspace's project (tamarind-api)" "got '$APROJ'"
AGY_SUM_AFTER=$(find "$H/.gemini/antigravity-cli/conversations" "$H/.gemini/antigravity-cli/history.jsonl" -type f -exec "$SBSUM" {} + | sort)
[ "$AGY_SUM_BEFORE" = "$AGY_SUM_AFTER" ] && ok "Antigravity's own files untouched by capture (read-only)" || bad "Antigravity's own files untouched by capture (read-only)"
echo "  ℹ️  Claude Desktop / ChatGPT chats are not auto-captured (no readable local store); they save via brain_remember (step 4)"

# ── 7. fresh clone: Claude Code shows folder memory at startup, no hand edits ──
echo; echo "7) Fresh clone — Claude Code startup shows this folder's memories"
node -e '
  const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const r=[];
  const cmds=(c.hooks?.SessionStart||[]).flatMap(g=>g.hooks||[]).map(h=>h.command);
  if(!cmds.some(x=>x.includes("session-start-context.sh"))) r.push("brain hook not registered");
  if(!cmds.includes("echo my-own-hook")) r.push("LOST the user\x27s own hook");
  if(c.theme!=="dark") r.push("LOST theme");
  if(cmds.filter(x=>x.includes("session-start-context.sh")).length>1) r.push("hook registered twice");
  if(r.length){console.log(r.join("; "));process.exit(1)}' "$H/.claude/settings.json" > "$SB/.why" 2>&1 \
  && ok "onboard registered the startup hook, user's own hook + settings kept" || bad "onboard registered the startup hook" "$(cat "$SB/.why")"
HOOKCMD=$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log((c.hooks.SessionStart.flatMap(g=>g.hooks)).find(h=>h.command.includes("session-start-context")).command)' "$H/.claude/settings.json")
# a project folder the user worked in earlier (the captured Claude Code session was in .../shop)
( cd "$H/work/shop" && env -i HOME="$H" PATH="$GUIPATH" BRAIN_TEST=1 CLAUDE_PROJECT_DIR="$H/work/shop" bash -c "$HOOKCMD" ) > "$SB/7-hook.json" 2>/dev/null
node -e '
  const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const r=[];
  const sm=(j.systemMessage||"").replace(/\x1b\[[0-9;]*m/g,""); if(!/^\[shop\] recent memory/.test(sm)) r.push("no visible preview: "+sm.slice(0,80)); if(Buffer.byteLength(j.systemMessage||"")>3500) r.push("preview too big");
  if(!/kiwi/.test(j.systemMessage||"")) r.push("preview lacks the folder\x27s past work (kiwi)");
  if(!/kiwi/.test(j.hookSpecificOutput?.additionalContext||"")) r.push("Claude\x27s context lacks it");
  const L=(j.systemMessage||"").split("\n"); if(!/load all my memory/.test(L[L.length-1])) r.push("hint is not the last line");
  if(r.length){console.log(r.join("; "));process.exit(1)}' "$SB/7-hook.json" > "$SB/.why" 2>&1 \
  && ok "opening claude in ~/work/shop shows its past memories (bare PATH)" || bad "opening claude shows the folder's memories" "$(cat "$SB/.why")"
mkdir -p "$H/work/brand-new"
( cd "$H/work/brand-new" && env -i HOME="$H" PATH="$GUIPATH" BRAIN_TEST=1 CLAUDE_PROJECT_DIR="$H/work/brand-new" bash -c "$HOOKCMD" ) > "$SB/7-hook-new.json" 2>/dev/null
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const L=j.systemMessage.split("\n");
  process.exit(/\[brand-new\] no memory here yet/.test(L[0]) && /load all my memory/.test(L[L.length-1]) ? 0 : 1)' "$SB/7-hook-new.json" \
  && ok "brand-new folder: says no memory yet, then the ask line" || bad "brand-new folder startup preview" "$(head -c 200 "$SB/7-hook-new.json")"
echo "     folder with memories — terminal shows:"; node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).systemMessage.split("\n").map(l=>"       "+l).join("\n"))' "$SB/7-hook.json" 2>/dev/null
env -i HOME="$H" PATH="$GUIPATH" BRAIN_TEST=1 "$NODE_BIN" -e '
  const {spawn}=require("child_process");const c=JSON.parse(require("fs").readFileSync(process.argv[1]));const s=c.mcpServers["agentic-brain"];
  const p=spawn(s.command,s.args);let b="";p.stdout.on("data",d=>{b+=d;if(b.includes("\"id\":2")){const t=JSON.parse(b.trim().split("\n").pop()).result.tools;
    const ctx=t.find(x=>x.name==="brain_context").description, rem=t.find(x=>x.name==="brain_remember").description;
    process.exit(/FIRST/.test(ctx)&&/without waiting to be asked/.test(rem)?0:1)}});
  p.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"claude-ai",version:"1"}}})+"\n");
  p.stdin.write(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list"})+"\n"); setTimeout(()=>process.exit(2),15000)' "$CD/claude_desktop_config.json" \
  && ok "Claude Desktop chat gets the stronger load/save tool descriptions" || bad "Claude Desktop chat gets the stronger load/save tool descriptions"

echo; echo "════════ $PASS passed · $FAIL failed ════════"
printf '%s\n' "${RESULTS[@]}" > "$SB/RESULTS.txt"
echo "(set SB_KEEP=1 to keep the sandbox dir + logs; it is kept automatically on failure)"
[ "$FAIL" = 0 ]
