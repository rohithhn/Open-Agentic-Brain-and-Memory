#!/usr/bin/env bash
# Agentic Brain v1 — end-to-end sandbox test.
#
# Everything the product touches in the real world is faked or isolated:
#   $HOME        → a throwaway folder per simulated Mac (macA, macB, macC)
#   GitHub       → local bare repos + a releases folder (shims/gh)
#   launchd      → recorded, never loaded (shims/launchctl) + BRAIN_NO_AUTOMATION=1
# Real: git, age, tar, node, and the engine code (cloned from the local repo HEAD).
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/lib.sh"
sb_mktemp sync
export SB_GITHUB="$SB/github" SB_LOG="$SB/calls.log" BRAIN_NO_AUTOMATION=1
BASEPATH="$ROOT/shims:$TOOLPATH"
# Linux: no `security`/`md5`/BSD `script` — shims-linux/ supplies a file-backed libsecret
# (`secret-tool`), md5 and a BSD-form script(1); the engine is told to use the libsecret path.
SB_OS="$(uname -s)"
if [ "$SB_OS" = Linux ]; then BASEPATH="$ROOT/shims-linux:$BASEPATH"; LINUX_ENV="BRAIN_SECRET_BACKEND=libsecret"; mkdir -p "$SB/hostbin" && ln -sf "$ROOT/shims-linux/md5" "$SB/hostbin/md5" && PATH="$SB/hostbin:$PATH"; else LINUX_ENV=""; fi
PASS=0; FAIL=0; RESULTS=()
ok()   { PASS=$((PASS+1)); RESULTS+=("PASS  $1"); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1${2:+ — $2}"); echo "  ❌ $1${2:+ — $2}"; }
check(){ local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
# The canary/secret literals are built at runtime on purpose: this script is committed in the engine repo
# that the fake Macs clone and push, so a contiguous literal here would trip the leak checks below.
CANARY_A="purple zebra light""house"; CANARY_B="orange okapi sub""marine"
FAKE_MARK="SANDBOX""FAKE"
FAKE_SECRET="sk-ant-api03-${FAKE_MARK}$(printf 'x%.0s' {1..60})AA"

# A simulated Mac: own HOME, own keychain, git pointed at fake GitHub.
mac() { # mac <name>  → prints env assignments via global vars
  local n="$1" h="$SB/$1"
  mkdir -p "$h/.claude" "$h/Documents"
  HOME="$h" git config --global user.name "sandbox $n"
  HOME="$h" git config --global user.email "$n@sandbox.invalid"
  HOME="$h" git config --global init.defaultBranch main
  HOME="$h" git config --global url."file://$SB_GITHUB/".insteadOf "https://github.com/"
  # A realistic Claude Code settings file carrying a secret — sync must redact it.
  cat > "$h/.claude/settings.json" <<EOF
{ "env": { "ANTHROPIC_API_KEY": "$FAKE_SECRET" }, "theme": "dark" }
EOF
}
on() { # on <mac> <cmd...> — run inside that Mac's world
  local n="$1"; shift
  env -i HOME="$SB/$n" PATH="$BASEPATH" USER=sandbox TMPDIR="$SB/$n/tmp" \
    SB_GITHUB="$SB_GITHUB" SB_LOG="$SB_LOG" SB_KEYCHAIN="$SB/$n-keychain" \
    BRAIN_NO_AUTOMATION=1 BRAIN_SKIP_NPM=1 BRAIN_TEST=1 ${LINUX_ENV:-} ${EXTRA_ENV:-} "$@"
}
brain() { local n="$1"; shift; on "$n" node "$SB/$n/agentic-brain/bin/brain.mjs" "$@"; }
# tty_feed <log> <pattern> <nth> <text> ... — the "user at the keyboard" for a command run under
# `script` (a real pty): types <text> once <pattern> has appeared <nth> times in <log>, then stays
# attached until $TTY_UNTIL shows up in <log> (an early EOF on the pty would end the command).
tty_feed() {
  local log="$1" i; shift
  while [ $# -ge 3 ]; do
    i=0; while [ "$(grep -ao -- "$1" "$log" 2>/dev/null | wc -l)" -lt "$2" ] && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done
    sleep 0.3; printf '%s\r' "$3"; shift 3
  done
  i=0; while ! grep -Eqa -- "${TTY_UNTIL:-✅|✖}" "$log" 2>/dev/null && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done; sleep 1
}
RECOVERY_PASS="blue canyon river lantern"   # the user's recovery passphrase (synthetic)

mkdir -p "$SB_GITHUB/OWNER"
sb_engine "$SB/engine-src" || exit 2
echo "🧪 Agentic Brain v1 sandbox — $SB"
echo "   engine source: $SRC @ $WIPNOTE"

# ── 0. Publish a clean "engine" to fake GitHub (no personal config.json) ────
git clone -q --bare "$SB/engine-src" "$SB_GITHUB/OWNER/agentic-brain.git"
for m in macA macB macC; do mac $m; mkdir -p "$SB/$m/tmp"; done

# ── 1. Fresh user on Mac A: curl|bash-style INIT ────────────────────────────
echo; echo "1) Mac A — fresh install (BRAIN_MODE=init)"
on macA env BRAIN_MODE=init AGENTIC_BRAIN_REPO=OWNER/agentic-brain \
  bash "$SB/engine-src/install.sh" > "$SB/1-install-macA.log" 2>&1; rc=$?
[ $rc = 0 ] && ok "install.sh exits 0" || bad "install.sh exits 0" "exit $rc (see 1-install-macA.log)"
A="$SB/macA/agentic-brain"; BR="$SB_GITHUB/sandbox-user/claude-brain"
check "key stored in (fake) Keychain"         test -s "$SB/macA-keychain/claude-brain__age-identity"
check "config.json → sandbox-user/claude-brain, private" \
  node -e 'const c=require(process.argv[1]);process.exit(c.repo.owner==="sandbox-user"&&c.repo.name==="claude-brain"&&c.repo.private===true?0:1)' "$A/config.json"
check "private brain repo created"            test -d "$BR.git"
check "brain repo has commits on main"        git -C "$BR.git" rev-parse --verify -q main
check "encrypted blob uploaded to release"    test -s "$BR.releases/brain-latest/brain.age"
check "engine remote is push-disabled"        test "$(git -C "$A" remote get-url --push engine 2>/dev/null)" = no_push
grep -q "launchctl load" "$SB_LOG" && bad "no launchd jobs loaded" || ok "no launchd jobs loaded"

# ── 2. Capture + sync; is GitHub ciphertext-only? ───────────────────────────
echo; echo "2) Mac A — remember a canary, sync, inspect what GitHub holds"
brain macA remember --title "Sandbox canary A" --project sandbox --type discovery \
  --fact "The secret word is $CANARY_A" > "$SB/2-remember-A.log" 2>&1
check "brain remember saved"                  grep -q "saved" "$SB/2-remember-A.log"
brain macA recall "$CANARY_A" > "$SB/2-recall-A.log" 2>&1
check "recall finds it locally"               grep -q "Sandbox canary A" "$SB/2-recall-A.log"
brain macA sync > "$SB/2-sync-A.log" 2>&1; rc=$?
[ $rc = 0 ] && ok "brain sync exits 0" || bad "brain sync exits 0" "exit $rc (see 2-sync-A.log)"
check "blob is age ciphertext"                grep -qa "age-encryption.org/v1" "$BR.releases/brain-latest/brain.age"
if grep -qa "$CANARY_A" "$BR.releases/brain-latest/brain.age"; then bad "canary NOT readable in blob"; else ok "canary NOT readable in blob"; fi
# every object in every commit of the pushed repo
if git -C "$BR.git" grep -q "$CANARY_A" $(git -C "$BR.git" rev-list --all) 2>/dev/null; then
  bad "canary absent from git history (plaintext memory leak)"; else ok "canary absent from git history"; fi
if git -C "$BR.git" grep -q "$FAKE_MARK" $(git -C "$BR.git" rev-list --all) 2>/dev/null; then
  bad "API key from ~/.claude/settings.json redacted before push" "$(git -C "$BR.git" grep -l "$FAKE_MARK" main | head -3 | tr '\n' ' ')"
else ok "API key from ~/.claude/settings.json redacted before push"; fi
BLOBSZ=$(sb_size "$BR.releases/brain-latest/brain.age"); echo "     blob size: $BLOBSZ bytes"
# decrypt with Mac A's key and prove the canary is really inside
KEY="$(cat "$SB/macA-keychain/claude-brain__age-identity")"
printf '%s\n' "$KEY" > "$SB/idA.txt"; chmod 600 "$SB/idA.txt"
mkdir -p "$SB/peek" && age -d -i "$SB/idA.txt" "$BR.releases/brain-latest/brain.age" | tar -xz -C "$SB/peek" 2>/dev/null
if grep -rqa "$CANARY_A" "$SB/peek"; then ok "blob decrypts with the key and contains the memory"; else bad "blob decrypts with the key and contains the memory"; fi

# ── 2b. `brain audit`: what leaves the Mac, verified against what GitHub really holds ──
echo; echo "2b) Mac A — brain audit (read-only)"
AUD_BEFORE="$(git -C "$A" status --porcelain; git -C "$A" rev-parse HEAD; ls "$SB/macA-keychain" | md5 -q)"
LOG_BEFORE=$(wc -l < "$SB_LOG" | tr -d ' ')
MUT_BEFORE=$(grep -cE '^(security (add|delete)-generic-password|secret-tool (store|clear)|gh (release (upload|create|delete)|repo (create|edit|delete)))' "$SB_LOG")
brain macA audit --deep --json > "$SB/2b-audit-A.json" 2> "$SB/2b-audit-A.err"; rc=$?
[ $rc = 0 ] && ok "audit exits 0 on a healthy brain" || bad "audit exits 0 on a healthy brain" "exit $rc (see 2b-audit-A.json)"
aud() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=Object.values(r.sections).flatMap(s=>s.checks).find(x=>x.id===process.argv[2]);process.exit(c&&c.level===process.argv[3]?0:1)' "$SB/2b-audit-A.json" "$@"; }
check "audit: local blob verified as age ciphertext"        aud blob-ciphertext ok
check "audit: the copy GitHub holds downloads and verifies" aud cloud-ciphertext ok
check "audit: repo reported PRIVATE"                        aud visibility ok
check "audit: key found in the (fake) Keychain, by name"    aud key-present ok
check "audit: settings committed redacted"                  aud settings-redacted ok
check "audit: no plaintext memory/db/identity in git"       aud forbidden-path ok
check "audit: scrubber ran and found nothing certain"       aud scrub-certain ok
check "audit: no recovery backup yet -> flagged to review"  aud recovery-file warn
if grep -qaE "$CANARY_A|$FAKE_MARK|AGE-SECRET-KEY-1[0-9A-Z]{20}" "$SB/2b-audit-A.json" "$SB/2b-audit-A.err"; then bad "audit output holds no memory, secret or key value"; else ok "audit output holds no memory, secret or key value"; fi
brain macA audit --offline > "$SB/2b-audit-A.txt" 2>&1
check "audit: human report renders every section"           grep -q "6\. Remote" "$SB/2b-audit-A.txt"
[ "$(git -C "$A" status --porcelain; git -C "$A" rev-parse HEAD; ls "$SB/macA-keychain" | md5 -q)" = "$AUD_BEFORE" ] \
  && ok "audit changed nothing (repo, HEAD, keychain)" || bad "audit changed nothing (repo, HEAD, keychain)"
[ "$(grep -cE '^(security (add|delete)-generic-password|secret-tool (store|clear)|gh (release (upload|create|delete)|repo (create|edit|delete)))' "$SB_LOG")" = "$MUT_BEFORE" ] \
  && ok "audit issued no write calls to Keychain or GitHub" || bad "audit issued no write calls to Keychain or GitHub"
# (libsecret has no presence-only query — a lookup IS the probe — so this is a macOS-only property)
if [ "$SB_OS" != Linux ]; then
if tail -n +$((LOG_BEFORE+1)) "$SB_LOG" | grep -qE '^security find-generic-password .*-[wg]( |$)'; then bad "audit never asked the Keychain for a secret value"; else ok "audit never asked the Keychain for a secret value"; fi
fi
touch "$BR.git/PUBLIC"
brain macA audit --json --no-scrub > "$SB/2b-audit-public.json" 2>/dev/null; rc=$?
[ $rc = 1 ] && ok "audit exits 1 when the repo is public" || bad "audit exits 1 when the repo is public" "exit $rc"
rm -f "$BR.git/PUBLIC"
EXTRA_ENV="SB_GH_OFFLINE=1" brain macA audit --json --no-scrub > "$SB/2b-audit-off.json" 2>/dev/null; rc=$?
[ $rc = 0 ] && ok "audit survives GitHub being unreachable (warning, not crash)" || bad "audit survives GitHub being unreachable" "exit $rc"

# ── 3. Second Mac: RESTORE with the pasted key ──────────────────────────────
echo; echo "3) Mac B — restore onto a second machine"
on macB env BRAIN_REPO=sandbox-user/claude-brain bash -c "true" # (installer's key step is a GUI paste; do it via CLI)
on macB gh repo clone sandbox-user/claude-brain "$SB/macB/agentic-brain" > /dev/null 2>&1
brain macB key import "$KEY" > "$SB/3-key-B.log" 2>&1
check "key import on Mac B"                   grep -q "recipient: age1" "$SB/3-key-B.log"
on macB env BRAIN_REPO=sandbox-user/claude-brain bash "$SB/macB/agentic-brain/install.sh" > "$SB/3-install-macB.log" 2>&1; rc=$?
[ $rc = 0 ] && ok "install.sh (restore) exits 0" || bad "install.sh (restore) exits 0" "exit $rc (see 3-install-macB.log)"
brain macB recall "$CANARY_A" > "$SB/3-recall-B.log" 2>&1
check "Mac B recalls Mac A's memory"          grep -q "Sandbox canary A" "$SB/3-recall-B.log"
# Workaround so later steps still test sync: create the missing ~/.claude-brain, retry.
mkdir -p "$SB/macB/.claude-brain"; brain macB restore > "$SB/3-restore-B-retry.log" 2>&1
brain macB recall "$CANARY_A" > "$SB/3-recall-B2.log" 2>&1
check "…after mkdir ~/.claude-brain workaround, Mac B recalls it" grep -q "Sandbox canary A" "$SB/3-recall-B2.log"

# ── 4. Safety guards ────────────────────────────────────────────────────────
echo; echo "4) Safety guards"
# 4a. A third Mac with NO key must refuse to init over the existing brain.
on macC gh repo clone OWNER/agentic-brain "$SB/macC/agentic-brain" > /dev/null 2>&1
git -C "$SB/macC/agentic-brain" remote rename origin engine
brain macC init --repo claude-brain --yes > "$SB/4a-init-C.log" 2>&1; rc=$?
[ $rc != 0 ] && grep -q "already holds an encrypted brain" "$SB/4a-init-C.log" \
  && ok "no-key Mac refuses to overwrite existing brain" || bad "no-key Mac refuses to overwrite existing brain" "exit $rc"
check "…and generated no key"                 test ! -e "$SB/macC-keychain/claude-brain__age-identity"
# 4b. Wrong key → restore fails loudly, never silently empties the brain.
brain macC key import "$(age-keygen 2>/dev/null | grep AGE-SECRET)" > /dev/null 2>&1
cp "$A/config.json" "$SB/macC/agentic-brain/config.json"
git -C "$SB/macC/agentic-brain" remote add origin https://github.com/sandbox-user/claude-brain.git
brain macC restore > "$SB/4b-restore-wrongkey.log" 2>&1; rc=$?
[ $rc != 0 ] && ok "wrong key → restore fails loudly" || bad "wrong key → restore fails loudly" "exit 0"
# 4c. Offline during init → resumable, no key generated, nothing half-made.
rm -rf "$SB/macD" && mac macD && mkdir -p "$SB/macD/tmp"
on macD gh repo clone OWNER/agentic-brain "$SB/macD/agentic-brain" >/dev/null 2>&1
git -C "$SB/macD/agentic-brain" remote rename origin engine
EXTRA_ENV="SB_GH_OFFLINE=1" brain macD init --repo other-brain --yes > "$SB/4c-offline.log" 2>&1; rc=$?
[ $rc != 0 ] && ok "offline init stops with an error" || bad "offline init stops with an error"
check "…and generated no key"                 test ! -e "$SB/macD-keychain/claude-brain__age-identity"

# ── 5. Two Macs write, both sync — is anything lost? ────────────────────────
echo; echo "5) Mac A and Mac B both add memories, then both sync"
brain macA remember --title "From A after split" --project sandbox --type discovery --fact "A says green walrus teapot" > /dev/null 2>&1
brain macB remember --title "From B after split" --project sandbox --type discovery --fact "B says $CANARY_B" > "$SB/5-remember-B.log" 2>&1
check "Mac B remember saved"                   grep -q saved "$SB/5-remember-B.log"
brain macA sync > "$SB/5-sync-A.log" 2>&1
brain macB sync > "$SB/5-sync-B.log" 2>&1
sqlite3 "$SB/macA/.claude-brain/brain.db" "select count(*) from observations" > "$SB/5-countA-before.txt" 2>&1
brain macA restore > "$SB/5-restore-A.log" 2>&1
echo "     Mac A observations: before restore $(cat "$SB/5-countA-before.txt"), after $(sqlite3 "$SB/macA/.claude-brain/brain.db" "select count(*) from observations")"
brain macA recall "green walrus teapot" > "$SB/5-recall-A1.log" 2>&1
brain macA recall "$CANARY_B"   > "$SB/5-recall-A2.log" 2>&1
check "Mac A still has its own post-split memory" grep -q "From A after split" "$SB/5-recall-A1.log"
check "Mac A received Mac B's memory"          grep -q "From B after split" "$SB/5-recall-A2.log"
age -d -i "$SB/idA.txt" "$BR.releases/brain-latest/brain.age" | tar -xzO 2>/dev/null > "$SB/cloud.bin"
grep -qa "green walrus teapot" "$SB/cloud.bin" && ok "cloud blob keeps A's post-split memory" || bad "cloud blob keeps A's post-split memory" "B's sync overwrote it"
grep -qa "$CANARY_B"   "$SB/cloud.bin" && ok "cloud blob has B's memory" || bad "cloud blob has B's memory"

# ── 6. Sync must never overwrite a cloud brain it couldn't read ─────────────
echo; echo "6) Sync refuses to clobber the cloud when it can't merge first"
before=$(md5 -q "$BR.releases/brain-latest/brain.age")
EXTRA_ENV="SB_GH_OFFLINE=1" brain macA sync > "$SB/6-offline-sync.log" 2>&1; rc=$?
after=$(md5 -q "$BR.releases/brain-latest/brain.age")
[ $rc != 0 ] && [ "$before" = "$after" ] && ok "offline sync aborts, cloud blob untouched" || bad "offline sync aborts, cloud blob untouched" "exit $rc"
brain macA sync > "$SB/6-sync-again.log" 2>&1 && ok "sync runs again cleanly (idempotent merge)" || bad "sync runs again cleanly (idempotent merge)"
n1=$(sqlite3 "$SB/macA/.claude-brain/brain.db" "select count(*) from observations"); brain macA sync >/dev/null 2>&1
n2=$(sqlite3 "$SB/macA/.claude-brain/brain.db" "select count(*) from observations")
[ "$n1" = "$n2" ] && ok "repeated syncs create no duplicates ($n2 observations)" || bad "repeated syncs create no duplicates" "$n1 → $n2"

# ── 6c. content_hash v1 → v2: one Mac migrates, the other does not ─────────
echo; echo "6c) Mixed content-hash versions: Mac A runs brain migrate-hash, Mac B does not"
# downgrade <mac> <title> — make that row look like an older build captured it (v1 FNV content_hash).
downgrade() {
  on "$1" node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const [eng, db, title] = process.argv.slice(1);
    const { legacyHash, canonicalString } = await import(eng + "/bin/lib/hash.mjs");
    const d = new DatabaseSync(db);
    const r = d.prepare("SELECT * FROM observations WHERE title = ?").get(title);
    const h = legacyHash(canonicalString({ title: r.title, subtitle: r.subtitle, facts: JSON.parse(r.facts || "[]"), narrative: r.narrative }));
    d.prepare("UPDATE observations SET content_hash = ? WHERE id = ?").run(h, r.id);
    d.close(); console.log(h);' "$SB/$1/agentic-brain" "$SB/$1/.claude-brain/brain.db" "$2"
}
sq() { sqlite3 "$SB/$1/.claude-brain/brain.db" "$2"; }
LEG1="Legacy hash memory one"; LEG2="Legacy hash memory two"
legcount() { sq "$1" "select count(*) from observations where title in ('$LEG1','$LEG2')"; }
brain macA remember --title "$LEG1" --project sandbox --type decision --fact "captured before the hash upgrade" > /dev/null 2>&1
brain macA remember --title "$LEG2" --project sandbox --type decision --fact "curated later on Mac B" > /dev/null 2>&1
H1=$(downgrade macA "$LEG1"); H2=$(downgrade macA "$LEG2")
check "fixture: two Mac A rows carry v1 (FNV) hashes" sh -c "echo '$H1 $H2' | grep -Eq '^[0-9a-f]{9,12} [0-9a-f]{9,12}$'"
brain macA sync > "$SB/6c-sync-A1.log" 2>&1
brain macB sync > "$SB/6c-sync-B1.log" 2>&1
check "Mac B pulled both v1 rows"              test "$(legcount macB)" = 2
check "…with their v1 hashes verbatim"         test "$(sq macB "select content_hash from observations where title='$LEG1'")" = "$H1"
# Curated on Mac B: the content changes, the v1 hash is kept (curate.mjs policy).
sq macB "update observations set facts='[\"curated later on Mac B (edited)\"]', metadata='{\"edited_at\":1}' where title='$LEG2'"
brain macB sync > "$SB/6c-sync-B2.log" 2>&1
brain macA migrate-hash > "$SB/6c-migrate-dry.log" 2>&1
check "migrate-hash dry run plans the rewrite"  grep -Eq "would rewrite[^:]*: [1-9]" "$SB/6c-migrate-dry.log"
check "…and changes nothing"                    test "$(sq macA "select content_hash from observations where title='$LEG1'")" = "$H1"
brain macA migrate-hash --apply > "$SB/6c-migrate-apply.log" 2>&1; rc=$?
[ $rc = 0 ] && grep -q "verification: passed" "$SB/6c-migrate-apply.log" \
  && ok "migrate-hash --apply verifies" || bad "migrate-hash --apply verifies" "exit $rc (see 6c-migrate-apply.log)"
check "…behind a backup"                       sh -c "ls '$SB/macA/.claude-brain/backups/'pre-migrate-hash-*.db"
check "Mac A rows now carry the 32-hex v2 hash" test "$(sq macA "select count(*) from observations where title in ('$LEG1','$LEG2') and length(content_hash)=32")" = 2
check "…and remember their v1 hash"            test "$(sq macA "select json_extract(metadata,'\$.legacy_content_hash') from observations where title='$LEG1'")" = "$H1"
brain macA sync > "$SB/6c-sync-A2.log" 2>&1; rcA=$?
brain macB sync > "$SB/6c-sync-B3.log" 2>&1; rcB=$?
brain macA sync > "$SB/6c-sync-A3.log" 2>&1
[ $rcA = 0 ] && [ $rcB = 0 ] && ok "both Macs sync across the version split" || bad "both Macs sync across the version split" "A=$rcA B=$rcB"
check "Mac A (migrated): no duplicates from Mac B's v1 copies (incl. the curated one)" test "$(legcount macA)" = 2
check "Mac B (not migrated): no duplicates from Mac A's v2 copies"                    test "$(legcount macB)" = 2
brain macB restore > "$SB/6c-restore-B.log" 2>&1
check "Mac B restore (merge path) adds no duplicates" test "$(legcount macB)" = 2
check "Mac B keeps its curated edit"           sh -c "sqlite3 '$SB/macB/.claude-brain/brain.db' \"select facts from observations where title='$LEG2'\" | grep -q edited"
nA=$(sq macA "select count(*) from observations"); nB=$(sq macB "select count(*) from observations")
brain macA sync >/dev/null 2>&1; brain macB sync >/dev/null 2>&1; brain macA sync >/dev/null 2>&1
[ "$nA" = "$(sq macA "select count(*) from observations")" ] && [ "$nB" = "$(sq macB "select count(*) from observations")" ] \
  && ok "repeated mixed-version syncs are stable (A $nA, B $nB)" || bad "repeated mixed-version syncs are stable" "A $nA→$(sq macA "select count(*) from observations"), B $nB→$(sq macB "select count(*) from observations")"
brain macB migrate-hash --apply > "$SB/6c-migrate-B.log" 2>&1
check "after Mac B migrates too, both hold the same v2 hash for the same memory" \
  test "$(sq macB "select content_hash from observations where title='$LEG1'")" = "$(sq macA "select content_hash from observations where title='$LEG1'")"
brain macB sync >/dev/null 2>&1; brain macA sync >/dev/null 2>&1
check "…and still no duplicates on either Mac" sh -c "[ \"\$(sqlite3 '$SB/macA/.claude-brain/brain.db' \"select count(*) from observations where title in ('$LEG1','$LEG2')\")\" = 2 ] && [ \"\$(sqlite3 '$SB/macB/.claude-brain/brain.db' \"select count(*) from observations where title in ('$LEG1','$LEG2')\")\" = 2 ]"

# ── 6d. duplicate memories: write-time dedupe, clean --dupes, across Macs ──
echo; echo "6d) Duplicates: remember dedupes, clean --dupes hides copies (never blanks them), sync keeps it that way"
DUP="Dedupe sandbox memory"
dupcount() { sq "$1" "select count(*) from observations where lower(title) like 'dedupe sandbox memory%'"; }
duphidden() { sq "$1" "select count(*) from observations where lower(title) like 'dedupe sandbox memory%' and status='duplicate'" 2>/dev/null || echo 0; }
blank() { sq "$1" "select count(*) from observations where trim(coalesce(title,''))=''"; }
brain macA remember --title "$DUP" --project sandbox --type decision --fact "Deploys go out on Tuesdays" > "$SB/6d-rem1.log" 2>&1
brain macA remember --title "dedupe sandbox memory." --project sandbox --type decision --fact "deploys go out on tuesdays" > "$SB/6d-rem2.log" 2>&1
check "remember: the same memory in other case/punctuation is a duplicate" grep -q "duplicate" "$SB/6d-rem2.log"
check "…so Mac A holds one row"                 test "$(dupcount macA)" = 1
# Copies captured before this build (claude-mem stored it twice): same content, other sessions.
sq macA "insert into observations (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts, prompt_number, created_at, created_at_epoch, content_hash, generated_by_model) select o.memory_session_id||'-copy'||n.n, o.project, o.text, o.type, o.title, o.subtitle, o.facts, o.narrative, o.concepts, o.prompt_number, o.created_at, o.created_at_epoch+n.n, o.content_hash, o.generated_by_model from observations o, (select 1 n union select 2) n where o.title='$DUP'"
check "fixture: three copies on Mac A"          test "$(dupcount macA)" = 3
brain macA recall "Dedupe sandbox memory Tuesdays" > "$SB/6d-recall-A0.log" 2>&1
check "recall shows it once even before a clean" test "$(grep -c "$DUP" "$SB/6d-recall-A0.log")" = 1
mkdir -p "$SB/macA/work/sandbox"
on macA sh -c "cd '$SB/macA/work/sandbox' && node '$SB/macA/agentic-brain/bin/lib/sessionstart.mjs' --hook" > "$SB/6d-start-A0.json" 2>&1
check "startup block + preview: once, no (untitled)" sh -c "[ \"\$(grep -o '$DUP' '$SB/6d-start-A0.json' | wc -l | tr -d ' ')\" -le 2 ] && grep -q '$DUP' '$SB/6d-start-A0.json' && ! grep -q '(untitled)' '$SB/6d-start-A0.json'"
brain macA sync > "$SB/6d-sync-A1.log" 2>&1
brain macB sync > "$SB/6d-sync-B1.log" 2>&1
check "Mac B received the memory"              test "$(dupcount macB)" -ge 1
brain macB recall "Dedupe sandbox memory Tuesdays" > "$SB/6d-recall-B0.log" 2>&1
check "Mac B recall shows it once"              test "$(grep -c "$DUP" "$SB/6d-recall-B0.log")" = 1
HA=$(md5 -q "$SB/macA/.claude-brain/brain.db"); BLANK_A=$(blank macA); NA=$(sq macA "select count(*) from observations")
brain macA clean --dupes > "$SB/6d-clean-dry.log" 2>&1
check "clean --dupes dry run plans the copies"  grep -Eq "[1-9][0-9]* copies to hide" "$SB/6d-clean-dry.log"
check "…and writes nothing"                     sh -c "[ \"\$(md5 -q '$SB/macA/.claude-brain/brain.db')\" = '$HA' ] && ! ls '$SB/macA/.claude-brain/backups/'pre-clean-dupes-*.db"
brain macA clean --dupes --apply > "$SB/6d-clean-apply.log" 2>&1
check "--apply behind a verified backup"        sh -c "ls '$SB/macA/.claude-brain/backups/'pre-clean-dupes-*.db && grep -q 'nothing deleted' '$SB/6d-clean-apply.log'"
check "…two copies hidden, none deleted"        test "$(duphidden macA)/$(dupcount macA)/$(sq macA 'select count(*) from observations')" = "2/3/$NA"
check "…no row left blank or untitled"          test "$(blank macA)" = "$BLANK_A"
on macA sh -c "cd '$SB/macA/work/sandbox' && node '$SB/macA/agentic-brain/bin/lib/sessionstart.mjs'" > "$SB/6d-start-A1.txt" 2>&1
check "startup block after clean: once, no (untitled)" sh -c "[ \"\$(grep -c '$DUP' '$SB/6d-start-A1.txt')\" = 1 ] && ! grep -q '(untitled)' '$SB/6d-start-A1.txt'"
brain macA sync > "$SB/6d-sync-A2.log" 2>&1; rcA=$?
brain macB sync > "$SB/6d-sync-B2.log" 2>&1; rcB=$?
brain macA sync > "$SB/6d-sync-A3.log" 2>&1
[ $rcA = 0 ] && [ $rcB = 0 ] && ok "both Macs sync after the clean" || bad "both Macs sync after the clean" "A=$rcA B=$rcB"
check "Mac A: nothing re-inserted, nothing un-hidden" test "$(dupcount macA)/$(duphidden macA)" = "3/2"
brain macB recall "Dedupe sandbox memory Tuesdays" > "$SB/6d-recall-B1.log" 2>&1
check "Mac B recall still shows it once"        test "$(grep -c "$DUP" "$SB/6d-recall-B1.log")" = 1
brain macA clean --dupes --undo --apply > "$SB/6d-undo.log" 2>&1
check "clean --dupes --undo --apply brings them back" test "$(duphidden macA)" = 0
brain macA clean --dupes --apply > /dev/null 2>&1

# ── 6a. ensureRemote creates a repo ONLY on a definite "not found" ──────────
echo; echo "6a) Sync with no origin: offline must NOT create a repo; online connects to the existing one"
git -C "$A" remote remove origin
: > "$SB_LOG"
EXTRA_ENV="SB_GH_OFFLINE=1" brain macA sync > "$SB/6a-offline-noorigin.log" 2>&1; rc=$?
[ $rc != 0 ] && ok "no-origin offline sync stops with an error" || bad "no-origin offline sync stops with an error" "exit 0"
check "…the error says it is retryable and nothing was created" grep -q "did NOT create anything" "$SB/6a-offline-noorigin.log"
if grep -q "^gh repo create" "$SB_LOG"; then bad "…and never ran 'gh repo create'"; else ok "…and never ran 'gh repo create'"; fi
check "…and left origin unwired" test -z "$(git -C "$A" remote | grep -x origin)"
# repo exists on (fake) GitHub: an online sync must connect to it, not create
: > "$SB_LOG"
brain macA sync > "$SB/6a-online-noorigin.log" 2>&1 && ok "no-origin online sync succeeds" || bad "no-origin online sync succeeds"
if grep -q "^gh repo create" "$SB_LOG"; then bad "…connecting to the existing repo, not creating one"; else ok "…connecting to the existing repo, not creating one"; fi
check "…and origin is wired again" test -n "$(git -C "$A" remote get-url origin)"

# ── 6b. recovery passphrase: back the key up into the brain repo ────────────
echo; echo "6b) brain key backup (recovery passphrase)"
L="$SB/6b-backup.log"; : > "$L"
tty_feed "$L" "Choose a recovery passphrase" 1 "$RECOVERY_PASS" "Type it again" 1 "$RECOVERY_PASS" \
  | on macA script -q /dev/null node "$A/bin/brain.mjs" key backup > "$L" 2>&1
check "backup: recovery file committed + pushed to the brain repo" git -C "$BR.git" cat-file -e main:memory/key-recovery.age
check "backup: it is an age passphrase (scrypt) file" sh -c "git -C '$BR.git' show main:memory/key-recovery.age | head -2 | grep -q '^-> scrypt '"
if git -C "$BR.git" show main:memory/key-recovery.age | grep -qa "AGE-SECRET-KEY"; then bad "backup: no plaintext key in git"; else ok "backup: no plaintext key in git"; fi
if grep -qa "$(cat "$SB/macA-keychain/claude-brain__age-identity")" "$L" || grep -qa "$RECOVERY_PASS" "$L"; then
  bad "backup: neither the key nor the passphrase is shown"; else ok "backup: neither the key nor the passphrase is shown"; fi

# ── 7. key rotation (e.g. after a key was exposed) ───────────────────────────
echo; echo "7) brain key rotate"
KA="$SB/macA-keychain/claude-brain__age-identity"; old_key=$(cat "$KA"); old_blob=$(md5 -q "$BR.releases/brain-latest/brain.age")
# offline: must refuse before touching the key
( sleep 1; printf 'rotate\r'; sleep 3 ) | EXTRA_ENV="SB_GH_OFFLINE=1" on macA script -q /dev/null node "$A/bin/brain.mjs" key rotate > "$SB/7a-rotate-offline.log" 2>&1
[ "$(cat "$KA")" = "$old_key" ] && ok "offline rotate leaves the key unchanged" || bad "offline rotate leaves the key unchanged"
# wrong confirmation word → nothing changes
( sleep 1; printf 'yes\r'; sleep 2 ) | on macA script -q /dev/null node "$A/bin/brain.mjs" key rotate > "$SB/7b-rotate-abort.log" 2>&1
[ "$(cat "$KA")" = "$old_key" ] && grep -q "Aborted" "$SB/7b-rotate-abort.log" && ok "rotate needs the typed word; otherwise nothing changes" || bad "rotate confirmation"
# real rotation
# …then skip the (new) offer to back the key up with a passphrase: Enter. §8 does the backup.
L="$SB/7c-rotate.log"; : > "$L"
TTY_UNTIL="brain key reveal|✖" tty_feed "$L" 'Type "rotate" to continue' 1 rotate 'Enter to skip' 1 "" \
  | on macA script -q /dev/null node "$A/bin/brain.mjs" key rotate > "$L" 2>&1
new_key=$(cat "$KA")
[ "$new_key" != "$old_key" ] && grep -q "Key rotated" "$SB/7c-rotate.log" && ok "rotate: new key in place" || bad "rotate: new key in place" "$(tail -2 "$SB/7c-rotate.log" | tr -d '\r' | tr '\n' ' ')"
[ "$(md5 -q "$BR.releases/brain-latest/brain.age")" != "$old_blob" ] && ok "cloud backup re-uploaded" || bad "cloud backup re-uploaded" "md5 unchanged: $old_blob"
printf '%s\n' "$old_key" > "$SB/old.id"; printf '%s\n' "$new_key" > "$SB/new.id"
age -d -i "$SB/old.id" "$BR.releases/brain-latest/brain.age" >/dev/null 2>&1 && bad "old key can NOT open the new backup" || ok "old key can NOT open the new backup"
rm -rf "$SB/rx" && mkdir -p "$SB/rx" && age -d -i "$SB/new.id" "$BR.releases/brain-latest/brain.age" | tar -xz -C "$SB/rx" 2>/dev/null
[ "$(sqlite3 "$SB/rx/claude-mem.db" "select count(*) from observations where facts like '%green walrus teapot%'" 2>/dev/null)" = 1 ] && ok "new key opens it, all memories inside" || bad "new key opens it, all memories inside"
brain macA sync > "$SB/7d-sync.log" 2>&1 && ok "Mac A syncs normally after rotation" || bad "Mac A syncs normally after rotation"
# Mac B still has the OLD key → must be refused, not silently wiped
before=$(md5 -q "$BR.releases/brain-latest/brain.age")
brain macB sync > "$SB/7e-syncB-oldkey.log" 2>&1; rc=$?
[ $rc != 0 ] && [ "$(md5 -q "$BR.releases/brain-latest/brain.age")" = "$before" ] && ok "Mac B with the old key is refused, cloud untouched" || bad "Mac B with the old key is refused" "exit $rc"
brain macB key import "$new_key" > /dev/null 2>&1; brain macB restore > "$SB/7f-restoreB.log" 2>&1
brain macB recall "green walrus teapot" 2>&1 | grep -q "From A after split" && ok "Mac B with the new key restores everything" || bad "Mac B with the new key restores everything"
# the private key is never printed — only the public recipient, plus the offer to back up with a passphrase
if grep -aq "AGE-SECRET-KEY" "$SB/7c-rotate.log" || grep -aqF "$new_key" "$SB/7c-rotate.log" || grep -aqF "$old_key" "$SB/7c-rotate.log"; then
  bad "rotate never prints a private key (old or new)"; else ok "rotate never prints a private key (old or new)"; fi
grep -aqF "$(cat "$SB/macA-keychain/claude-brain__age-recipient")" "$SB/7c-rotate.log" && grep -aq "Back the new key up now" "$SB/7c-rotate.log" \
  && ok "rotate shows the public recipient and offers brain key backup" || bad "rotate shows the public recipient and offers brain key backup"
# brain key reveal: the typed word is required; the key goes to the terminal only, never stdout
L="$SB/7g-reveal-abort.log"; : > "$L"
TTY_UNTIL="Aborted" tty_feed "$L" 'Type "reveal"' 1 yes \
  | on macA script -q /dev/null node "$A/bin/brain.mjs" key reveal > "$L" 2>&1
if grep -aqF "$new_key" "$L"; then bad "reveal: a wrong answer shows nothing"; else ok "reveal: a wrong answer shows nothing"; fi
L="$SB/7h-reveal.log"; : > "$L"; rm -f "$SB/7h-stdout.txt"
TTY_UNTIL="[A-Z0-9]{50}" tty_feed "$L" 'Type "reveal"' 1 reveal \
  | on macA script -q /dev/null sh -c "node '$A/bin/brain.mjs' key reveal > '$SB/7h-stdout.txt'" > "$L" 2>&1
grep -aqF "$new_key" "$L" && grep -aq "PRIVATE" "$L" && ok "reveal: warns, then shows the key on the terminal" || bad "reveal: warns, then shows the key on the terminal"
if grep -aqF "$new_key" "$SB/7h-stdout.txt"; then bad "reveal: key never reaches stdout"; else ok "reveal: key never reaches stdout"; fi
# no controlling terminal (perl setsid drops it, even if a developer runs this from one) → refuse
on macA perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' node "$A/bin/brain.mjs" key reveal < /dev/null > "$SB/7i-reveal-notty.log" 2>&1; rc=$?
if [ $rc != 0 ] && ! grep -aqF "$new_key" "$SB/7i-reveal-notty.log"; then ok "reveal: with no terminal it refuses and prints nothing"; else bad "reveal: with no terminal it refuses and prints nothing" "exit $rc"; fi
# the recovery file held the OLD key — rotate must not leave it for a new Mac to trip over
git -C "$BR.git" cat-file -e main:memory/key-recovery.age 2>/dev/null \
  && bad "rotate removes the stale recovery file from the brain repo" \
  || { grep -q "brain key backup" "$SB/7c-rotate.log" && ok "rotate removes the stale recovery file (and says to re-create it)" \
       || bad "rotate removes the stale recovery file" "no hint in 7c-rotate.log"; }

# ── 8. new Mac restores with the recovery passphrase ONLY (no key pasted) ───
echo; echo "8) Mac E — restore with the recovery passphrase only"
L="$SB/8a-backup.log"; : > "$L"
tty_feed "$L" "Choose a recovery passphrase" 1 "$RECOVERY_PASS" "Type it again" 1 "$RECOVERY_PASS" \
  | on macA script -q /dev/null node "$A/bin/brain.mjs" key backup > "$L" 2>&1
check "Mac A backs up the (rotated) key"      git -C "$BR.git" cat-file -e main:memory/key-recovery.age
for m in macE macF; do rm -rf "$SB/$m" "$SB/$m-keychain"; mac $m; mkdir -p "$SB/$m/tmp" "$SB/$m/.claude-brain"; done
# the real installer, restore mode, in a terminal: it finds the recovery file and asks for the passphrase
L="$SB/8b-install-macE.log"; : > "$L"
# it also asks, before anything is captured, whether to start with past sessions: this user picks "start fresh"
TTY_UNTIL="Done. Your brain|❌" tty_feed "$L" "Choose \[1\]" 1 "2" "Recovery passphrase" 1 "$RECOVERY_PASS" \
  | on macE env BRAIN_REPO=sandbox-user/claude-brain script -q /dev/null bash "$SB/engine-src/install.sh" > "$L" 2>&1
E="$SB/macE/agentic-brain"
check "Mac E: installer asked about past sessions, recommending them" grep -q "Start with my past sessions (recommended)" "$L"
check "Mac E: 'start fresh' was recorded" grep -q '"mode": "fresh"' "$SB/macE/.claude-brain/past-sessions.json"
check "Mac E: install summary says it started fresh" grep -q "Starting fresh" "$L"
check "Mac E: installer asked for the passphrase" grep -q "has a recovery passphrase" "$L"
[ "$(cat "$SB/macE-keychain/claude-brain__age-identity" 2>/dev/null)" = "$new_key" ] \
  && ok "Mac E: passphrase unlocked the right key into the Keychain" || bad "Mac E: passphrase unlocked the right key into the Keychain" "see 8b-install-macE.log"
if grep -qa "$new_key" "$L" || grep -qa "$RECOVERY_PASS" "$L"; then bad "Mac E: key and passphrase never shown"; else ok "Mac E: key and passphrase never shown"; fi
brain macE recall "green walrus teapot" > "$SB/8c-recall-E.log" 2>&1
check "Mac E recalls Mac A's memory"          grep -q "From A after split" "$SB/8c-recall-E.log"
brain macE recall "$CANARY_B" > "$SB/8d-recall-E.log" 2>&1
check "…and Mac B's"                          grep -q "From B after split" "$SB/8d-recall-E.log"
# wrong passphrase: fails cleanly, nothing stored, nothing restored
on macF gh repo clone sandbox-user/claude-brain "$SB/macF/agentic-brain" > /dev/null 2>&1
cp "$E/config.json" "$SB/macF/agentic-brain/config.json"
echo "not the passphrase at all" | brain macF key recover --passphrase-stdin > "$SB/8e-wrong-stdin.log" 2>&1; rc=$?
[ $rc != 0 ] && grep -q "Wrong recovery passphrase" "$SB/8e-wrong-stdin.log" && grep -q "Nothing was changed" "$SB/8e-wrong-stdin.log" \
  && ok "wrong passphrase → clear error, non-zero exit" || bad "wrong passphrase → clear error, non-zero exit" "exit $rc"
L="$SB/8f-wrong-restore.log"; : > "$L"
tty_feed "$L" "Recovery passphrase" 1 "wrong one 1234" "Recovery passphrase" 2 "wrong two 1234" "Recovery passphrase" 3 "wrong three 1234" \
  | on macF script -q /dev/null node "$SB/macF/agentic-brain/bin/brain.mjs" restore > "$L" 2>&1; rc=$?
[ $rc != 0 ] && grep -q "Wrong recovery passphrase" "$L" && ok "restore: 3 wrong passphrases → stops cleanly" || bad "restore: 3 wrong passphrases → stops cleanly" "exit $rc"
check "…no key stored on Mac F"               test ! -e "$SB/macF-keychain/claude-brain__age-identity"
check "…no memory restored on Mac F"          test ! -e "$SB/macF/.claude-brain/brain.db"
# a Mac that already holds a DIFFERENT key is never silently switched
rm -rf "$SB/macG" "$SB/macG-keychain"; mac macG; mkdir -p "$SB/macG/tmp"
on macG gh repo clone sandbox-user/claude-brain "$SB/macG/agentic-brain" > /dev/null 2>&1
brain macG key import "$(age-keygen 2>/dev/null | grep AGE-SECRET)" > /dev/null 2>&1
cK=$(cat "$SB/macG-keychain/claude-brain__age-identity" 2>/dev/null)
echo "$RECOVERY_PASS" | brain macG key recover --passphrase-stdin > "$SB/8g-recover-G.log" 2>&1; rc=$?
[ $rc != 0 ] && [ -n "$cK" ] && grep -q "DIFFERENT key" "$SB/8g-recover-G.log" && [ "$(cat "$SB/macG-keychain/claude-brain__age-identity")" = "$cK" ] \
  && ok "recover refuses to replace a different existing key" || bad "recover refuses to replace a different existing key" "exit $rc"
# with the right passphrase from stdin (scripted use), Mac F recovers too
echo "$RECOVERY_PASS" | brain macF key recover --passphrase-stdin > "$SB/8h-recover-F.log" 2>&1
[ "$(cat "$SB/macF-keychain/claude-brain__age-identity" 2>/dev/null)" = "$new_key" ] && ! grep -qa "$new_key" "$SB/8h-recover-F.log" \
  && ok "--passphrase-stdin recovers (key not printed)" || bad "--passphrase-stdin recovers (key not printed)"
# brain init offers it: a fresh user in a terminal says yes → the first sync already carries the file
rm -rf "$SB/macH" "$SB/macH-keychain"; mac macH; mkdir -p "$SB/macH/tmp"
on macH gh repo clone OWNER/agentic-brain "$SB/macH/agentic-brain" > /dev/null 2>&1
git -C "$SB/macH/agentic-brain" remote rename origin engine
L="$SB/8i-init-H.log"; : > "$L"
TTY_UNTIL="Your brain is live|✖" tty_feed "$L" "Protect your key" 1 "y" "Recovery passphrase" 1 "$RECOVERY_PASS" "Type it again" 1 "$RECOVERY_PASS" \
  | on macH script -q /dev/null node "$SB/macH/agentic-brain/bin/brain.mjs" init --repo h-brain --no-automation > "$L" 2>&1
HB="$SB_GITHUB/sandbox-user/h-brain"
check "init offers the passphrase; first sync pushes the recovery file" git -C "$HB.git" cat-file -e main:memory/key-recovery.age
git -C "$HB.git" show main:memory/key-recovery.age > "$SB/h-recovery.age" 2>/dev/null
rm -rf "$SB/macI" "$SB/macI-keychain"; mac macI; mkdir -p "$SB/macI/tmp"
on macI gh repo clone sandbox-user/h-brain "$SB/macI/agentic-brain" > /dev/null 2>&1
echo "$RECOVERY_PASS" | brain macI key recover --passphrase-stdin > "$SB/8j-recover-I.log" 2>&1
[ -s "$SB/macH-keychain/claude-brain__age-identity" ] && [ "$(cat "$SB/macI-keychain/claude-brain__age-identity" 2>/dev/null)" = "$(cat "$SB/macH-keychain/claude-brain__age-identity")" ] \
  && ok "…and it unlocks that brain's key on another Mac" || bad "…and it unlocks that brain's key on another Mac"

# ── 9. Keychain writes never put the secret on argv (visible in `ps`) ──────
echo; echo "9) Keychain writes go over stdin (security -i), never argv"
if [ "$SB_OS" = Linux ]; then
  grep -q '^secret-tool store .*<redacted:stdin>' "$SB_LOG" \
    && ok "keys were stored via secret-tool (stdin)" || bad "keys were stored via secret-tool (stdin)"
else
grep -q '^security add-generic-password .*<redacted:stdin>' "$SB_LOG" \
  && ok "keys were stored via security -i (stdin)" || bad "keys were stored via security -i (stdin)"
fi
if grep -q '<redacted:argv>' "$SB_LOG"; then bad "no secret ever passed to security on argv" "$(grep -c '<redacted:argv>' "$SB_LOG") argv write(s)"
else ok "no secret ever passed to security on argv"; fi

# ── report ─────────────────────────────────────────────────────────────────
echo; echo "════════ $PASS passed · $FAIL failed ════════"
printf '%s\n' "${RESULTS[@]}" > "$SB/RESULTS.txt"
echo "(set SB_KEEP=1 to keep the sandbox dir + logs; it is kept automatically on failure)"
[ "$FAIL" = 0 ]
