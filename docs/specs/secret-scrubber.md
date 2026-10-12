> Historical design note. It explains why the code is shaped the way it is; details may be out of date — the code and README are authoritative.

# Spec — Observation secret-scrubber (`bin/lib/scrub.mjs` + `brain scrub`)

**Status:** specification. No production code exists yet.
**Date:** 2026-08-04.
**Test corpus:** `evals/scrubber-corpus/positives.txt`, `evals/scrubber-corpus/negatives.txt`.

> ⚠️ **First step when this was built.** `evals/` is gitignored (`.gitignore:9`, because
> the real eval data travels inside the encrypted blob). The corpus files are
> therefore currently **untracked** and would never reach CI or the public
> `agentic-brain` repo. Fix this before anything else, by adding a negation to
> `.gitignore`:
>
> ```gitignore
> evals/
> !evals/scrubber-corpus/
> !evals/scrubber-corpus/**
> ```
>
> The corpus contains only fake, structurally-valid values and is explicitly safe
> to commit and to publish. Acceptance criterion **E3** below covers this.

> **Scope discipline.** This is a *hygiene* filter, not a security control. Read §6
> (Non-goals) before quoting this document anywhere user-facing.

---

## 1. Problem and current state

### 1.1 What exists today

Redaction exists in exactly one place, and it only covers **settings files**:

- `bin/lib/redact.mjs:4` — `SECRET_KEY` regex over JSON *key names*.
- `bin/lib/redact.mjs:5-13` — `SECRET_VALUE` array of 7 value patterns.
- `bin/lib/redact.mjs:15` — mask constant `REDACTED-BY-CLAUDE-BRAIN`.
- `bin/lib/assets.mjs:83` — the single call site: `redactJsonText()` applied to
  `settings.json`, `shared-settings.json`, `.mcp.json` on their way into `settings/`.
- Invoked from `bin/brain.mjs:61` (`pushSettings` inside `doSync`).

**Observation content is never scrubbed anywhere.** The DB at
`~/.claude-mem/claude-mem.db` holds 21,070 observations / 11,054 user prompts /
4,367 session summaries / 6,161 sessions captured verbatim from real terminal work.

### 1.2 Why `redact.mjs` cannot simply be reused on observations

Two of its patterns are catastrophic on prose:

| Pattern | `redact.mjs` line | Hits in the live observation corpus |
|---|---|---|
| `/\b[A-Za-z_][A-Za-z0-9_]{1,30}=[A-Za-z0-9_\-+/.]{20,}/g` | :11 | fires on every `content_hash=…`, base64 fragment, long CLI flag value |
| `/\b[A-Za-z0-9_-]{40,}\b/g` | :12 | **442 tokens** in a 21k-row scan — nearly all git SHAs, checksums, chunk names |

Measured false-positive surface over the live corpus (21,070 rows scanned, read-only):

```
git-SHA-like tokens (7–40 hex):  3,526
UUIDs:                             391
64-char hex hashes:                 13
base64 image fragments:             36
generic 40+ char [A-Za-z0-9_-]:    442
```

A naive entropy or "long token" rule destroys the memory's usefulness. The whole
design problem of this spec is **precision, not recall**.

### 1.3 Does the live DB actually contain secrets?

Yes. Read-only audit (a filesystem copy of the DB was scanned; the live DB was
never opened for write). **Counts and categories only — no values were recorded
anywhere.** Hits were filtered to exclude obvious placeholders
(`REDACTED|EXAMPLE|XXXX|YOUR_|placeholder|<…>|…`):

| Category | `observations` | `user_prompts` | Notes |
|---|---|---|---|
| PEM `BEGIN … PRIVATE KEY` blocks | 3 | 0 | full-block starts |
| JWTs (3-segment, 10+ chars/segment) | 4 | 0 | |
| `sk-` / `sk-proj-` API keys (20+ chars) | 2 | 1 | |
| Connection strings with inline credentials | 2 | 0 | `scheme://user:pass@host` |
| Google `AIza…` (35-char body) | 0 | 1 | |
| `Authorization: Bearer <16+ chars>` | 10 (LIKE-level) | — | some are prose/doc lines |
| AWS `AKIA…`, Slack `xox…`, `AGE-SECRET-KEY-1…`, Stripe `sk_live_` | 0 | 0 | clean |

`session_summaries` and `sdk_sessions.user_prompt`: **0** hits.

So: ~13 high-confidence, non-placeholder credential occurrences in a 21k-row
personal DB. Small, real, and exactly the class of thing that must not be in a
tool other people install.

### 1.4 The `age` blob is not a defence

`memory/brain.age` is encrypted at rest, but every one of these strings is
decrypted on restore and, more importantly, the same rows are read and fed into
LLM context on every session (`bin/lib/inject.mjs:137`, `ui/server.mjs:116`).
Encryption protects the transport; it does nothing about the injection path.

---

## 2. Where observation text lives (schema)

`~/.claude-mem/claude-mem.db`, `journal_mode = wal`.

### 2.1 Free-text columns in scope

| Table | Columns to scrub | Rows (2026-08-04) |
|---|---|---|
| `observations` | `text`, `narrative`, `facts`, `title`, `subtitle`, `metadata` | 21,070 |
| `user_prompts` | `prompt_text` | 11,054 |
| `session_summaries` | `request`, `investigated`, `learned`, `completed`, `next_steps`, `notes` | 4,367 |
| `sdk_sessions` | `user_prompt` | 6,161 |
| `pending_messages` | `tool_input`, `tool_response`, `last_user_message`, `last_assistant_message` | 0 (transient) |

**Explicitly out of scope for value-rewriting:** `project`, `memory_session_id`,
`content_hash`, `concepts`, `files_read`, `files_modified`, `files_edited`,
`type`, timestamps. Rewriting `content_hash` would break
`ux_observations_session_hash` dedup and the merge path.

### 2.2 FTS coupling — the retroactive trap

```
observations      → observations_fts        triggers: observations_ai / _ad / _au   ✅ auto
user_prompts      → user_prompts_fts        triggers: user_prompts_ai / _ad / _au   ✅ auto
session_summaries → session_summaries_fts   NO TRIGGERS                             ❌ manual
```

A plain `UPDATE observations SET text=…` fires `observations_au`, which deletes
and reinserts the FTS row — correct automatically. **`session_summaries_fts` has
no triggers** (claude-mem maintains it in application code), so after scrubbing
`session_summaries` the scrubber MUST run:

```sql
INSERT INTO session_summaries_fts(session_summaries_fts) VALUES('rebuild');
```

Skipping this leaves unscrubbed text searchable in the FTS shadow tables — a real
leak, since `ui/server.mjs:206-209` queries `observations_fts` directly and the
same pattern exists for summaries.

Also note `observations.sync_rev` / `synced_at` / `origin_*`: a scrub is a content
mutation. §5.4 covers how to handle them.

---

## 3. Detector design

Implement as `bin/lib/scrub.mjs`, exporting:

```js
export function findSecrets(text, opts) -> Array<{ detector, start, end, match, confidence }>
export function scrubText(text, opts) -> { text, hits: Array<{detector, fingerprint}> }
export const DETECTORS  // introspectable, for `--list-detectors` and tests
```

`redact.mjs` stays as-is and keeps owning settings JSON. `scrub.mjs` is a
separate module because the tuning is opposite (settings favour recall; prose
favours precision). Optionally, once `scrub.mjs` proves out, `redact.mjs:12` (the
40+ char catch-all) may import `scrub.mjs`'s tiers — but that is a follow-up, not
part of A4.

### 3.1 Tier 1 — provider-prefixed tokens (high confidence, always redact)

These have distinctive prefixes and fixed-ish shapes. False-positive rate ≈ 0.
Redact unconditionally, **including inside code fences and quoted output** — a
leaked key is leaked regardless of markdown context.

```js
const T1 = [
  ['aws-access-key-id',        /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g],
  ['aws-secret-access-key',    /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?([A-Za-z0-9\/+=]{40})["']?/g],
  ['github-token',             /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g],
  ['github-fine-grained-pat',  /\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}\b/g],
  ['gitlab-token',             /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['anthropic-key',            /\bsk-ant-(?:api|admin)[0-9]{2}-[A-Za-z0-9_-]{80,}\b/g],
  ['openai-key',               /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token',              /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g],
  ['slack-webhook',            /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/g],
  ['google-api-key',           /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ['google-oauth-token',       /\bya29\.[A-Za-z0-9_-]{20,}\b/g],
  ['stripe-secret-key',        /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ['stripe-restricted-key',    /\brk_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ['sendgrid-key',             /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g],
  ['npm-token',                /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['twilio-key',               /\bSK[0-9a-fA-F]{32}\b/g],
  ['age-secret-key',           /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}\b/g],
  ['jwt',                      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['azure-storage-key',        /\bAccountKey\s*=\s*[A-Za-z0-9+\/]{80,}={0,2}/g],
];
```

Notes on specific choices:

- **`openai-key` must be ordered after `anthropic-key`** and after Stripe, or
  `sk-` would swallow `sk-ant-…` and mislabel it. Detector order is significant;
  first match wins and the scanner advances past the consumed span.
- **`github-token` requires 36+ chars**, not the 20+ used in `redact.mjs:6`. The
  20-char bound is what makes the word "ghost" adjacent-risky in loose matchers and
  produces junk hits; real classic PATs are 36 chars of body.
- **`age-secret-key` matters most of all here** — it is *this tool's own* master
  key. If it ever appears in an observation, the entire encrypted-blob model is
  void. It is Tier 1, and `brain scrub --audit` MUST exit non-zero if it ever fires.
- **`jwt`** deliberately does not require a valid base64 header decode. A
  3-segment `eyJ…` token is a JWT in practice, and requiring a decode adds a
  parse failure mode for no precision gain. Single-segment `eyJ…` strings (which
  do occur as URL fragments — see negatives.txt) are *not* matched.

### 3.2 Tier 2 — PEM blocks (structural, multiline)

```js
const PEM = /-----BEGIN\s+(?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[^\n]*-----|$)/g;
```

Redact the **entire block including the BEGIN/END armour**, replaced by a single
marker. Rationale: keeping the armour lines makes a scrubbed DB look like it
still contains keys and defeats grep-based verification. The `|$` alternative
handles truncated captures — observation text is clipped at 8,000 chars
(`bin/lib/ingest.mjs:29,86`), so a PEM block frequently has no END line.

### 3.3 Tier 3 — context-bound assignment (keyish name near a value)

The generalisation of `redact.mjs:4`'s `SECRET_KEY` idea, but anchored so it
requires **both** a credential-ish name **and** a value that is plausibly a
secret. Neither half fires alone.

```js
const KEYISH = /(?:api[_-]?key|apikey|secret|passwd|password|pwd|token|auth|bearer|credential|client[_-]?secret|access[_-]?key|private[_-]?key|session[_-]?key|signing[_-]?key|encryption[_-]?key|refresh[_-]?token|webhook[_-]?secret)/i;

// name = value | name: value | "name": "value" | -H 'X-Api-Key: value' | --password=value
const ASSIGNMENT = new RegExp(
  String.raw`(["'\`]?[A-Za-z0-9_.\-]*` + KEYISH.source + String.raw`[A-Za-z0-9_.\-]*["'\`]?)` +
  String.raw`\s*(?:[:=]|=>|\bis\b)\s*` +
  String.raw`(["'\`]?)([^\s"'\`,;)]{12,512})\2`,
  'gi'
);
```

A Tier-3 candidate is redacted only if the captured **value** passes
`isSecretValue()` (§4). The captured **name is preserved** — `DATABASE_PASSWORD=` stays,
only the value becomes `[REDACTED:generic-assigned-secret]`. Keeping the name is
what preserves the memory's usefulness ("the fix was setting DATABASE_PASSWORD").

Two additional context-bound forms, each requiring a value that passes §4:

```js
['authorization-bearer', /\b(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+\/-]{16,})/gi],
['authorization-basic',  /\b(Authorization\s*:\s*Basic\s+)([A-Za-z0-9+\/]{16,}={0,2})/gi],
['password-flag',        /(--password[= ]|-p(?=[^\s])|\bpassword=)(["']?)([^\s"']{8,})\2/g],
['netrc-credentials',    /(\bpassword\s+)([^\s]{8,})/gi],  // only when the line also matches /\bmachine\s+\S+\s+login\s+\S+/
```

`password-flag`'s `-p<value>` branch is high-risk (matches `-print`, `-pretty`).
Gate it on the surrounding token being a known credential-taking CLI
(`mysql|mysqldump|psql|redis-cli|mongosh|curl -u`) within the preceding 40 chars.

### 3.4 Tier 4 — connection strings with inline credentials

```js
['connection-string-credentials',
  /\b([a-z][a-z0-9+.\-]{1,20}:\/\/)([^\s:@\/]{1,64}):([^\s:@\/]{1,256})@([^\s\/?#]{1,256})/gi]
```

Redact **only capture group 3** (the password). Scheme, user, and host stay —
`postgres://app_user:[REDACTED:connection-password]@db.internal:5432/prod` is
still a useful memory and still auditable. This is the highest-value/lowest-risk
detector in the set: a URL with `user:pass@` is essentially never a false positive
outside placeholders, which §4.4 handles.

### 3.5 Tier 5 — generic high entropy (last resort, opt-in)

**Review-only at capture time** (ingest, distill, `brain_remember` and its near-dup
merge, curation edits, imports): `scrubText()` / `scrubObservation*()` report tier-5
candidates (`review`, detector id + fingerprint only) and leave the text untouched.
Redaction is explicit opt-in (`entropyMode: "redact"`). `brain scrub --audit` surfaces
the same candidates as "things worth a human look". Export and the at-rest sweep
(`brain scrub --apply`, `scrubSweep`) run tiers 1-4 only. Egress into other repos'
context files (`inject.mjs`, P8) keeps tier 5 on and redacts — a miss there escapes
the brain entirely.

Fires only when **all** of the following hold:

1. Token length ∈ [24, 512] and matched by `/[A-Za-z0-9+\/=_\-!@#$%^&*]{24,512}/`.
2. Shannon entropy of the token ≥ **4.0 bits/char** for base64-ish charsets,
   ≥ **3.0 bits/char** for hex-only charsets. (Random hex tops out at 4.0 bits/char;
   requiring 4.0 across the board would silently exclude every hex secret while
   letting base64 noise through — hence the split.)
3. Charset diversity: at least **3 of 4** classes present (lower, upper, digit,
   symbol) **or** the token contains at least one symbol from `+/=_-` and mixes case.
4. It survives every false-positive control in §4.
5. Within 80 characters of a `KEYISH` word **or** on a line that also matches
   `/\b(export|setenv|-H|--header|curl|-e )\b/`. Pure floating high-entropy
   strings with no credential context are **reported, never auto-redacted**.

Knob: `entropyMode: "off" | "audit" | "redact"` on `findSecrets()` / `scrubText()`,
default `"audit"` (report, don't redact). (The `config.json → scrub.entropy` key in §5.5
is the intended user-facing surface for this; no code reads it yet.)

---

## 4. Entropy heuristic and false-positive controls

`isSecretValue(token, context)` returns `true` only if the token clears every gate
below. This function is the single most important piece of the implementation and
must be unit-tested against `negatives.txt` line by line.

### 4.1 Shannon entropy

```js
function entropy(s) {
  const f = new Map();
  for (const c of s) f.set(c, (f.get(c) || 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h; // bits per character
}
```

Thresholds (bits/char), by inferred charset:

| Charset of token | Min entropy | Min length |
|---|---|---|
| hex only (`^[0-9a-f]+$` or `^[0-9A-F]+$`) | 3.0 | 32 — **and** only if §4.2 does not reject |
| base64/base64url (`^[A-Za-z0-9+/=_-]+$`) | 4.0 | 24 |
| mixed with symbols | 3.5 | 16 |
| all-lowercase alpha, no digits | never (reject) | — |

Reference points: a 40-char git SHA has ≈3.8 bits/char over a 16-symbol alphabet
(near its 4.0 max) — **entropy alone cannot distinguish a SHA from a secret.**
This is the central reason §4.2 exists and is mandatory rather than advisory.

### 4.2 Shape rejects (checked before entropy — cheap and decisive)

Reject the token outright if it matches any of:

```js
const SHAPE_REJECTS = [
  /^[0-9a-f]{7}$|^[0-9a-f]{8}$|^[0-9a-f]{10}$|^[0-9a-f]{12}$|^[0-9a-f]{40}$/,   // git short+full SHA-1
  /^[0-9a-f]{64}$/,                                                              // sha256 / git SHA-256
  /^[0-9a-f]{128}$/,                                                             // sha512
  /^[0-9a-f]{32}$/,                                                              // md5 / trace-id (see 4.2.1)
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,             // UUID
  /^sha(1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/,                                   // npm/SRI integrity
  /^sha256:[0-9a-f]{64}$/,                                                       // OCI image digest
  /^[0-9a-f]{2}(:[0-9a-f]{2}){5,}$/i,                                            // colon-separated fingerprints
  /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?$/,                                     // semver
  /^\d{10,19}$/,                                                                 // epoch ms / snowflake ids
  /^[A-Za-z0-9_-]*\.(js|mjs|ts|tsx|css|map|json|png|jpg|svg|woff2?)$/,           // bundled filenames
];
```

**4.2.1 The md5/32-hex conflict.** `^[0-9a-f]{32}$` is both md5 and the Twilio
`SK`-less API secret shape. This is resolved by *precedence*: Tier 1's
`twilio-key` requires the literal `SK` prefix, so it matches first; a bare 32-hex
token is treated as a hash and rejected. Accepted cost, documented in §6.

**4.2.2 Path and URL suppression.** If the token is preceded by `/`, `\`, or
`://` without an intervening space, and the whole surrounding run matches a path
or URL shape, reject. Prevents `node_modules/.pnpm/typescript@5.4.5/…` and
`ui/assets/app-Bq7dK2Lm.js` from firing.

**4.2.3 Data-URI suppression.** If the token's line contains
`/data:[a-z]+\/[a-z0-9.+-]+;base64,/i`, suppress **all** Tier-3/4/5 detectors for
the remainder of that data URI (up to the next whitespace). Tier 1 and Tier 2 are
NOT suppressed — a key pasted next to an image is still a key. 36 base64 image
fragments exist in the live corpus.

**4.2.4 Repetition and dictionary rejects.** Reject if the token contains a
6+ character run of a single character, if 60%+ of its characters are the same,
or if it splits cleanly into 3+ English dictionary words of 4+ letters (catches
`superlongdescriptivevariablename`). A small embedded word list (~2k common
programming/English words) is sufficient; do not add a dependency for this.

### 4.3 Neighbourhood suppression

Reject if the 40 characters preceding the match contain any of:
`commit`, `sha`, `SHA`, `digest`, `checksum`, `hash`, `integrity`, `rev`,
`revision`, `content_hash`, `etag`, `uuid`, `session`, `trace`, `request-id`,
`build`, `chunk`.

This is the cheapest high-yield control given the measured 3,526 SHA-like tokens,
because those tokens almost always appear next to one of these words in real
observation prose ("Reverted 4b454c7", "content_hash 3f9a2c1b14",
"The docker image digest is sha256:…").

### 4.4 Placeholder allowlist

Reject if the matched value matches any of:

```js
/REDACTED|EXAMPLE|SAMPLE|PLACEHOLDER|CHANGE_?ME|YOUR[_-]|MY[_-]KEY|xxxx+|XXXX+|\.\.\.|…|^<.*>$|^\$\{.*\}$|^\$[A-Z_]+$|dummy|fakekey|test[_-]?key|localhost|password123|^password$|^secret$|^token$/i
```

Plus the two literal masks already in circulation: `REDACTED-BY-CLAUDE-BRAIN`
(`bin/lib/redact.mjs:15`) and this spec's own `[REDACTED:…]` format — which makes
the scrubber **idempotent by construction**: rescanning already-scrubbed text
produces zero new hits. This property is required by §5.4 and testable directly.

Note the deliberate consequence: `AKIAIOSFODNN7EXAMPLE` (from AWS's own docs) and
`postgres://user:password@localhost:5432/test_db` are NOT redacted. Both are in
`negatives.txt`. This is correct — redacting documentation examples is noise that
trains the user to ignore the marker.

### 4.5 Precedence and non-overlap

Detectors run in tier order (1 → 2 → 3 → 4 → 5). Matches are collected into a
non-overlapping interval set; on conflict the **earlier tier wins**, then the
**longer match** wins. Replacement happens in a single right-to-left pass over
the interval set so offsets stay valid.

---

## 5. Redaction format and placement

### 5.1 Replacement token

```
[REDACTED:<detector-id>]
```

Examples: `[REDACTED:github-token]`, `[REDACTED:connection-password]`,
`[REDACTED:high-entropy-secret]`.

Rationale for a typed marker rather than a bare `***`:

- The memory stays *readable*: "auth failed because GH_TOKEN=[REDACTED:github-token]
  had expired" is still a useful recollection; `***` is not.
- `brain scrub --audit` can count by category and report a breakdown.
- Grep-verifiable: `grep -c '\[REDACTED:' ` gives a hit count over any export.
- It round-trips through the allowlist in §4.4, so the operation is idempotent.

Do **not** preserve a prefix/suffix of the secret (no `ghp_9fQ2…u8g`). Partial
disclosure of a token is disclosure, and prefix-preservation offers no value the
detector-id doesn't already give.

### 5.2 Fingerprint for dedup — recommendation: **yes, in the ledger only**

Compute `fp = sha256(secret + per-DB salt).slice(0, 12)` where the salt is a
random 32-byte value generated once and stored in the local Keychain alongside
the age key (`bin/lib/keychain.mjs`), never in git and never in the blob.

- The fingerprint is written **only to the scrub ledger** (§5.5), never into the
  observation text. Putting it inline would create a stable cross-row correlator
  and, for short/low-entropy secrets, a brute-forceable one.
- Salting is non-negotiable. An unsalted `sha256("ghp_…")` is trivially reversible
  against a wordlist of leaked tokens and would be worse than storing nothing.
- Value: the ledger can say "this same credential appeared in 47 observations
  across 6 projects, first seen 2026-03-11" — which is exactly the information a
  user needs to decide what to rotate.

### 5.3 Forward protection — capture/ingest-time insertion points

**Reality check first:** Claude Code observations are generated and written by
**claude-mem**, an external plugin
(`~/.claude/plugins/marketplaces/thedotmack/src/services/sqlite/SessionStore.ts`,
driven by hooks in `settings/settings.json:28-90`). This repo does **not** own
that write path and cannot intercept it in-process. Consequently "forward
protection" here is (a) full coverage of the write paths this repo *does* own,
plus (b) a fast periodic sweep that closes the gap for claude-mem's rows.

| # | Insertion point | File:line | What to do |
|---|---|---|---|
| **P1** | Codex/Gemini/Antigravity/Cursor ingest — observation body | `bin/lib/ingest.mjs:276` (`insObs.run(mem, it.project, it.transcript, …)`) | Scrub `it.transcript` **before** `hash(it.transcript)` is computed, so the content_hash is the hash of the *scrubbed* text. Otherwise a rescrub changes text without changing the hash and the dedup index goes inconsistent. |
| **P2** | Same, session title/subtitle | `bin/lib/ingest.mjs:271, 275` | Scrub `it.title` (titles are derived from the first user prompt — `ingest.mjs:79,124,167,218` — a prime place for a pasted key). |
| **P3** | Same, user prompts | `bin/lib/ingest.mjs:279` (`insPrompt.run(it.sid, i, clip(p, 4000), …)`) | Scrub `p` before clip. |
| **P4** | Cleanest single choke point for P1–P3 | `bin/lib/ingest.mjs:231` — wrap each parser: `const PARSERS = mapValues(RAW_PARSERS, fn => () => fn().map(scrubItem))` | Preferred implementation: one `scrubItem()` covering `title`, `transcript`, `prompts` means the four parsers (`parseCodex:32`, `parseGemini:96`, `parseAntigravity:145`, `parseCursor:183`) can never regress independently. |
| **P5** | Multi-machine merge | `bin/lib/import.mjs:75-89` (`insertOrIgnore(db,'observations',…)`, summaries, prompts) | Scrub incoming JSONL rows. A machine running an older build (or another user's export in a future shared-brain scenario) must not reintroduce secrets. Do it in `insertOrIgnore`/`insertIfAbsent` via a column allowlist (§2.1). |
| **P6** | Periodic sweep — covers claude-mem's rows | new: `bin/lib/scrub.mjs` `scrubSweep({ sinceEpoch })`, called from `ingest()` at `bin/lib/ingest.mjs:290` (just before `db.close()`) | The ingest launchd timer already runs every 600s (`bin/lib/capture.mjs:16,36`) and Antigravity's watcher calls the same function (`bin/lib/watch.mjs`). Sweeping only rows with `created_at_epoch > lastSweepEpoch` makes the steady-state cost trivial (tens of rows). This gives Claude Code capture a ≤10-minute exposure window. |
| **P7** | Pre-export gate (defence in depth) | `bin/brain.mjs:67` → `bin/lib/export.mjs:24-32` | Run a **full** sweep before `runExport`. Nothing unscrubbed should ever reach `memory/exports/**` or the encrypted blob. If the sweep finds Tier-1 hits at this stage, log loudly — it means P1–P6 missed something. |
| **P8** | Injection boundary (belt and braces) | `bin/lib/inject.mjs:137` (folder digest select), `bin/lib/inject.mjs:236,249` (writes to `CLAUDE.md`/`AGENTS.md`) | Scrub the assembled digest string before write. `CLAUDE.md` is frequently committed to *other* repos — this is the one path where a leak escapes the brain entirely. |
| **P9** | UI read paths | `ui/server.mjs:116-120, 187-217` | No scrub needed if P6/P7 hold, but the UI is the natural place to surface `brain scrub --audit` results. |

Recommended build order: **P4 → P6 → P7 → P8 → P5**. P4 and P6 together cover
every row that can enter the DB; P7/P8 are the boundaries where a miss becomes
external.

### 5.4 Retroactive path — `brain scrub`

New command in `bin/brain.mjs` (`case 'scrub':` alongside `case 'ingest':` at
`bin/brain.mjs:254`), backed by `bin/lib/scrub.mjs`.

```
brain scrub --audit            # DEFAULT. Read-only. Report only. Exit 0.
brain scrub --audit --json     # machine-readable
brain scrub --apply            # mutate. Requires backup to succeed first.
brain scrub --apply --yes      # skip the interactive confirmation (CI only)
brain scrub --revert <ledger>  # restore original values from a ledger
brain scrub --tier 1,2         # limit detectors
brain scrub --since <hours>    # incremental
```

**Safety design.** This DB is the user's irreplaceable memory. Every one of these
is mandatory, not optional:

1. **Dry-run is the default.** Bare `brain scrub` == `brain scrub --audit`. There
   is no argument-free path to mutation. `--apply` alone still prompts unless
   `--yes`.
2. **Mandatory pre-flight backup.** Before any write, take a
   `VACUUM INTO '<backup>'` snapshot to
   `~/.claude-mem/backups/pre-scrub-<ISO8601>.db`. Use `VACUUM INTO`, not `cp` —
   it is WAL-safe and produces a consistent single file without touching the
   source's WAL. (`VACUUM INTO` writes a *new* file; it is not the forbidden
   in-place `VACUUM`.) Verify the backup opens and
   `SELECT COUNT(*) FROM observations` matches before proceeding. If any step
   fails, **abort with exit 1 and change nothing.**
3. **WAL safety.** Open with `openDb(CLAUDE_MEM_DB)` (`bin/lib/db.mjs:5`) — do not
   change `journal_mode`. Refuse to run if the claude-mem worker is live
   (`~/.claude-mem/worker.pid` names a running process) unless `--force`; a
   concurrent writer plus a long write transaction is how the WAL bug that "silently
   lost the newest memories" happened before. Chunk writes into transactions of
   ≤500 rows so no single `BEGIN…COMMIT` holds the write lock for long.
4. **Idempotent.** Guaranteed by §4.4 (the `[REDACTED:…]` marker is allowlisted).
   Acceptance test: `--apply` twice ⇒ second run reports 0 changes.
5. **Reversible.** Every mutation is journaled to
   `~/.claude-mem/backups/scrub-ledger-<ISO8601>.jsonl` **before** the UPDATE:
   `{table, rowid, column, detector, fingerprint, before, after}`. The ledger
   contains plaintext secrets and therefore: mode `0600`, written inside
   `~/.claude-mem/` (already covered by the `age` blob boundary), and **must be
   added to `.gitignore` in the same change**. `--revert <ledger>` replays it
   backwards. The implementer must confirm `~/.claude-mem/backups/` is not
   swept into `memory/exports/` — it is not today (`export.mjs:53` rebuilds only
   `REPO_EXPORTS`), but assert it.
6. **FTS integrity.** After mutating `session_summaries`, run the `'rebuild'`
   command from §2.2. After mutating `observations`/`user_prompts`, verify with
   `INSERT INTO observations_fts(observations_fts) VALUES('integrity-check')`.
7. **Hashes and sync columns.** Do **not** recompute `content_hash` on the
   retroactive path — changing it would orphan rows against
   `ux_observations_session_hash` and break merge dedup on other machines. Do
   bump `sync_rev` and null `synced_at` so the change propagates. Document that
   scrubbed and unscrubbed copies of the same row will dedup as identical across
   machines (correct: the merge keeps whichever arrived first, and the sweep at
   P6/P7 re-scrubs on the receiving machine).
8. **Ordering with sync.** `brain scrub --apply` must not run concurrently with
   `brain sync`. Take an advisory lock file `~/.claude-mem/scrub.lock`.

**Audit output** (`--audit`) reports, without ever printing a secret value:

```
brain scrub --audit  ·  21,070 observations · 11,054 prompts · 4,367 summaries

  TIER 1 (certain)                      hits   rows   projects   first seen
    private-key-pem                        3      3          2   2026-04-02
    jwt                                    4      4          2   2026-05-19
    openai-key                             3      3          2   2026-06-08
    google-api-key                         1      1          1   2026-07-14
  TIER 4 (credentialed URLs)
    connection-string-credentials          2      2          1   2026-03-27
  TIER 5 (review only, not redacted)
    high-entropy-secret                   19     17          5   —

  13 certain · 19 for review · 0 age-secret-key   →  run `brain scrub --apply`
```

Redacted-value display rule: show detector, row id, project, timestamp, and a
±30-char context window **with the secret span replaced by `[REDACTED:…]`**. Never
print the value, not even truncated, not even under `--verbose`. Provide
`--show-values` only if the implementer decides it is necessary; if so it must
require an explicit second confirmation and must be absent from all documentation
examples.

### 5.5 Config surface

```jsonc
// config.json
"scrub": {
  "enabled": true,            // capture-time scrubbing (P1–P6)
  "entropy": "audit",         // "off" | "audit" | "redact"
  "tiers": [1, 2, 3, 4],      // which tiers redact at capture time
  "allowPatterns": [],        // user-supplied regex strings that suppress hits
  "sweepBatch": 500
}
```

`allowPatterns` exists because every user has one internal identifier shape that
trips a heuristic; without an escape hatch they will disable the whole feature.

---

## 6. Non-goals and known limits

State these plainly in the README section that describes the feature. **This is a
hygiene filter that reduces accidental credential retention. It is not a security
guarantee and must never be described as one.**

It will **not** catch:

1. **Novel or bespoke credential formats** with no distinctive prefix and no
   assignment context — internal company tokens, custom HMAC secrets, license
   keys. Tier 5 flags some for review; most it will miss.
2. **Secrets in prose form.** "the prod password is hunter2 by the way" is a
   sentence, not a token. No pattern in this spec fires.
3. **Low-entropy real passwords.** `Summer2026!` fails every entropy gate. This is
   an intentional precision trade-off, not an oversight.
4. **Split or encoded secrets** — a key spread across two lines, base64'd twice,
   rot13'd, or reassembled from variables at runtime.
5. **Non-credential sensitive data** — PII, customer names, health data, internal
   IP ranges, unreleased product plans, proprietary source code. Observations are
   full of these and this feature does not touch them.
6. **Secrets inside `files_read`/`files_modified` file *contents*** — only the
   paths are stored, so the content never enters the DB, but if a tool response
   quoting a `.env` file lands in `observations.text`, only §3's patterns apply.
7. **Bare 32-char hex API secrets** — indistinguishable from md5 (§4.2.1). Rejected
   as a hash unless a Tier-1 prefix or Tier-3 assignment context is present.
8. **Anything already synced.** Scrubbing the local DB does not retract a blob
   already uploaded to a GitHub Release, does not rewrite git history, and does
   not un-send anything an LLM provider already received in context. **A detected
   secret must still be rotated.** The audit report must say this explicitly, in
   those words, every time it reports a Tier-1 hit.
9. **Adversarial evasion.** Anyone who wants a secret in the DB can trivially put
   one there. This defends against accident, not intent.
10. **Other tools' copies.** claude-mem also maintains a Chroma index
    (`~/.claude-mem/chroma/`) and corpora (`~/.claude-mem/corpora/`) derived from
    the same rows. Scrubbing SQLite does not scrub those. A follow-up task should
    trigger a claude-mem reindex after `--apply`; until then the audit must warn.

---

## 7. Acceptance criteria

All of these must pass before the implementation is considered done.

**A. Corpus (the primary gate)**

- **A1.** Every non-comment, non-blank line in `evals/scrubber-corpus/positives.txt`
  (**46 lines / 46 seeded secrets**) produces **≥1 hit**, with tiers 1–5 all enabled.
  Recall = 100%. Under the capture-time default, the 44 tier 1–4 lines are redacted
  (no 12+ char leak) and the 2 tier-5 lines are reported under `review` with the text
  unchanged (A5).
- **A2.** Each positive line's leading `<detector-id>` field matches the detector
  actually reported for that line. Detector-attribution accuracy = 100%.
- **A3.** Every non-comment, non-blank line in `evals/scrubber-corpus/negatives.txt`
  (**63 lines**) produces **0 hits** with tiers 1–4 enabled and entropy in
  `"redact"` mode. False positives = 0. *This is the criterion that fails first
  and matters most.*
- **A4.** No line in `positives.txt` leaks its secret through: after
  `scrubText()`, the output must not contain any 12+ char substring of the
  original secret.

**B. Idempotence and safety**

- **B1.** `scrubText(scrubText(x).text).hits.length === 0` for all corpus lines.
- **B2.** `brain scrub --apply` run twice on a fixture DB: second run reports
  0 changes, 0 rows updated.
- **B3.** `brain scrub --apply` on a fixture DB with a read-only backup directory
  aborts with exit 1 and leaves the DB byte-identical.
- **B4.** `brain scrub --revert <ledger>` restores the fixture DB to a
  byte-identical state (modulo `sync_rev`/`synced_at`), verified by comparing
  every in-scope column.
- **B5.** After `--apply`, `INSERT INTO observations_fts(observations_fts)
  VALUES('integrity-check')` succeeds, and a full-text search for a scrubbed
  secret returns 0 rows across `observations_fts`, `user_prompts_fts`, and
  `session_summaries_fts`.
- **B6.** Row counts in all five tables are unchanged after `--apply`.

**C. Live-corpus regression (no fixed numbers, a ratio)**

- **C1.** Run `--audit` (tiers 1–4) against a **copy** of the real 21k-row DB.
  Total hits must be **≤ 40**. Given the measured ~13 genuine occurrences, a
  result in the hundreds means a heuristic is misfiring.
- **C2.** Hits on tokens that also match a `SHAPE_REJECTS` pattern: **0**.
- **C3.** Manual review of every Tier-1 and Tier-4 hit from C1 confirms ≥90% are
  genuine credentials. Reviewer records category counts only, never values.

**D. Integration**

- **D1.** `brain ingest` with a seeded fake Codex session containing 3 positives
  writes 0 unscrubbed secrets — verified by querying the DB after.
- **D2.** `brain sync` fails loudly (non-zero exit) if the pre-export sweep (P7)
  finds a Tier-1 hit, rather than silently uploading.
- **D3.** `brain scrub --audit --json` emits a stable schema suitable for automated
  pre-publish checks.
- **D4.** Scrub adds **< 200ms** to a steady-state `brain ingest` run (incremental
  sweep of ~tens of rows) and **< 60s** for a full 21k-row `--audit`.

**E. Documentation**

- **E1.** README gains a Safety bullet describing the scrubber, with §6's
  "not a security guarantee" framing and the "rotate anyway" instruction.
- **E2.** `~/.claude-mem/backups/` and `scrub-ledger-*.jsonl` are gitignored,
  verified by `git check-ignore`.
- **E3.** `git check-ignore evals/scrubber-corpus/positives.txt` returns non-zero
  (i.e. the corpus is tracked) after the `.gitignore` negation from the header
  note is applied, while `git check-ignore evals/questions.jsonl` still returns 0.

---

## 8. Implementation notes

- New files only: `bin/lib/scrub.mjs`, `bin/lib/scrub-detectors.mjs` (data),
  `evals/scrub.test.mjs`. Edits to existing files are confined to the insertion
  points listed in §5.3 plus one `case 'scrub':` in `bin/brain.mjs`.
- Do **not** modify `bin/lib/redact.mjs` as part of this task. It ships working
  settings redaction; unifying the two is a separate, later change.
- Keep zero runtime dependencies, matching the rest of `bin/lib/` (`node:sqlite`,
  `node:crypto`, `node:fs` only).
- Regexes must be constructed fresh per call or have `lastIndex` reset — several
  above carry the `g` flag and will silently skip matches if reused statelessly.
- The scanner must handle 8,000-char strings (`ingest.mjs:29`) without
  catastrophic backtracking. Avoid nested quantifiers; prefer explicit character
  classes with bounded repetition. Add a 50ms-per-string timeout guard as a
  backstop and count timeouts in the audit output.
- Test runner: extend the existing eval harness pattern in `bin/lib/eval.mjs` or
  use `node --test`. Corpus files are parsed as
  `line.split('\t')` for positives, whole-line for negatives; `#` and blank lines
  are skipped in both.
