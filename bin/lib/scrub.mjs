// Secret scrubber for observation free-text (title / transcript / prompts / summaries).
// See docs/specs/secret-scrubber.md — this module implements §3 (detectors),
// §4 (entropy heuristic + false-positive controls) and §5.1 (redaction format).
//
// Design split from bin/lib/redact.mjs on purpose: redact.mjs tunes for recall over
// settings JSON (small, structured, low volume); this module tunes for PRECISION
// over free-text prose, where a naive "long token" rule destroys the memory's
// usefulness (see spec §1.2 — 442 false positives measured on the live corpus).
//
// Zero runtime dependencies: node:crypto, node:sqlite (via db.mjs), node:fs, node:os only.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, tableExists } from './db.mjs';
import { MEMORY_DB } from './paths.mjs';

// ───────────────────────── Tier 1 — provider-prefixed tokens ─────────────────────
// High confidence, near-zero false-positive rate. Order matters: sk-ant-… and
// sk_live_ must be tried before the generic sk-… (openai) pattern, or the shorter
// prefix would swallow and mislabel the longer one. All patterns carry 'd' so we
// can recover capture-group offsets for partial (value-only) redaction.
const T1 = [
  ['aws-access-key-id', /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/gd],
  ['aws-secret-access-key', /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/gd],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/gd],
  ['github-fine-grained-pat', /\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{20,}\b/gd],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{18,}\b/gd],
  ['anthropic-key', /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{60,}\b/gd],
  ['stripe-secret-key', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/gd],
  ['stripe-restricted-key', /\brk_(?:live|test)_[A-Za-z0-9]{16,}\b/gd],
  ['openai-key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/gd],
  ['slack-webhook', /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/gd],
  ['slack-token', /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/gd],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35,}\b/gd],
  ['google-oauth-token', /\bya29\.[A-Za-z0-9_-]{20,}\b/gd],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/gd],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/gd],
  ['twilio-key', /\bSK[0-9A-Za-z]{32}\b/gd],
  ['age-secret-key', /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}\b/gd],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gd],
  ['azure-storage-key', /\bAccountKey\s*=\s*[A-Za-z0-9+/]{80,}={0,2}/gd],
];

// ───────────────────────── Tier 2 — PEM blocks ────────────────────────────────
const PEM = /-----BEGIN\s+(?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[^\n]*-----|$)/g;

// ───────────────────────── Tier 3 — context-bound assignment ─────────────────
const KEYISH_SRC =
  '(?:api[_-]?key|apikey|secret|passwd|password|pwd|token|auth|bearer|credential|' +
  'client[_-]?secret|access[_-]?key|private[_-]?key|session[_-]?key|signing[_-]?key|' +
  'encryption[_-]?key|refresh[_-]?token|webhook[_-]?secret)';
const KEYISH = new RegExp(KEYISH_SRC, 'i');

const ASSIGNMENT = new RegExp(
  String.raw`(["'\`]?[A-Za-z0-9_.-]*` + KEYISH_SRC + String.raw`[A-Za-z0-9_.-]*["'\`]?)` +
  String.raw`\s*(?:[:=]|=>|\bis\b)\s*` +
  String.raw`(["'\`]?)([^\s"'\`,;)]{12,512})\2`,
  'gid'
);

const T3_EXTRA = [
  ['authorization-bearer', /\b(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/-]{16,})/gid],
  ['authorization-basic', /\b(Authorization\s*:\s*Basic\s+)([A-Za-z0-9+/]{16,}={0,2})/gid],
];
// password-flag / netrc-credentials are handled specially below (need CLI/line gating).
const PASSWORD_FLAG = /(--password[= ]|-p(?=\S)|\bpassword=)(["']?)([^\s"']{8,})\2/gd;
const CREDENTIAL_CLI = /\b(mysql|mysqldump|psql|redis-cli|mongosh|curl -u)\b/i;
const NETRC_LINE = /\bmachine\s+\S+\s+login\s+\S+/;
const NETRC_PASSWORD = /(\bpassword\s+)([^\s]{8,})/gid;

// ───────────────────────── Tier 4 — connection strings with inline creds ─────
const CONN_STRING = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:@/]{1,64}):([^\s:@/]{1,256})@([^\s/?#]{1,256})/gid;

// ───────────────────────── Tier 5 — generic high entropy (review-only) ───────
// Tier 5 is a last-resort heuristic with real false-positive risk on prose, so at
// capture time it is REVIEW-ONLY: findSecrets() reports candidates (confidence
// 'review'), scrubText()/scrubObservation*() leave the text untouched and list them
// under `review`. Redaction is explicit opt-in (entropyMode: 'redact'). Export and
// the at-rest sweep (applyScrub) never include tier 5: they run tiers 1-4 only.
const ENTROPY_TOKEN = /[A-Za-z0-9+/=_\-!@#$%^&*]{24,512}/g;
const TIER5_CONTEXT_WORD = new RegExp(
  '(?:api[_-]?key|apikey|secret|passwd|password|pwd|token|auth|bearer|credential|' +
  'client[_-]?secret|access[_-]?key|private[_-]?key|session[_-]?key|signing|sign|' +
  'webhook|encryption|refresh|cert|key|value)',
  'i'
);
const TIER5_LINE_CONTEXT = /\b(export|setenv|-H|--header|curl|-e)\b/;

// ───────────────────────── §4.1 Shannon entropy ───────────────────────────────
function entropy(s) {
  const f = new Map();
  for (const c of s) f.set(c, (f.get(c) || 0) + 1);
  let h = 0;
  for (const n of f.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function charsetOf(s) {
  if (/^[0-9a-f]+$/.test(s) || /^[0-9A-F]+$/.test(s)) return 'hex';
  if (/^[A-Za-z0-9+/=_-]+$/.test(s)) return 'base64';
  if (/^[a-zA-Z]+$/.test(s) && !/[0-9]/.test(s)) return 'alpha';
  return 'mixed';
}

function passesEntropyThreshold(s) {
  const cs = charsetOf(s);
  if (cs === 'alpha') return false; // all-lowercase/uppercase alpha, no digits — never
  const h = entropy(s);
  if (cs === 'hex') return h >= 3.0 && s.length >= 32;
  if (cs === 'base64') return h >= 4.0 && s.length >= 24;
  return h >= 3.5 && s.length >= 16; // mixed with symbols
}

// ───────────────────────── §4.2 Shape rejects ─────────────────────────────────
// Full set — applied to Tier 5 (context-free entropy scanning), where a bare
// hash/UUID/SHA/etc. is indistinguishable from a secret without a nearby name.
const SHAPE_REJECTS_FULL = [
  /^[0-9a-f]{7}$|^[0-9a-f]{8}$|^[0-9a-f]{10}$|^[0-9a-f]{12}$|^[0-9a-f]{40}$/i,
  /^[0-9a-f]{64}$/i,
  /^[0-9a-f]{128}$/i,
  /^[0-9a-f]{32}$/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^sha(1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/,
  /^sha256:[0-9a-f]{64}$/i,
  /^[0-9a-f]{2}(:[0-9a-f]{2}){5,}$/i,
  /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?$/,
  /^\d{10,19}$/,
  /^[A-Za-z0-9_-]*\.(js|mjs|ts|tsx|css|map|json|png|jpg|svg|woff2?)$/i,
];
// Light set — applied to Tier 3/4 context-bound values. A KEYISH assignment (e.g.
// "api_key": "<40-hex>") already carries strong contextual disambiguation that a
// bare floating token doesn't, so the hash/UUID shape rejects (designed to reject
// git SHAs found in prose with no assignment context) do not apply there. We keep
// the format-obviously-not-a-secret rejects (semver / epoch id / filename).
const SHAPE_REJECTS_LIGHT = [
  /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?$/,
  /^\d{10,19}$/,
  /^[A-Za-z0-9_-]*\.(js|mjs|ts|tsx|css|map|json|png|jpg|svg|woff2?)$/i,
];

function repetitionReject(s) {
  if (/(.)\1{5,}/.test(s)) return true;
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  const max = Math.max(...counts.values());
  if (max / s.length >= 0.6) return true;
  return dictionarySplitReject(s);
}

// Small embedded word list — enough to catch obviously-concatenated English/
// programming words (e.g. "superlongdescriptivevariablename"). Not a dependency.
const WORDS = new Set(
  ('this that with from your user name pass word secret token auth login logout ' +
    'session config setting value data base server client request response error ' +
    'success failure retry cache memory store save load read write file path name ' +
    'test debug build release version update install remove delete create update ' +
    'search find replace insert select where join group order limit count total ' +
    'time date year month week hour minute second start stop pause resume next ' +
    'prev first last long short variable function method class object array list ' +
    'string number boolean null true false none default custom simple complex ' +
    'system process thread worker queue event handler listener callback promise ' +
    'async await yield return throw catch finally block scope global local static ' +
    'public private protected internal external module package import export ' +
    'admin owner member guest visitor account profile settings preferences options').split(/\s+/)
);
function dictionarySplitReject(s) {
  const lower = s.toLowerCase().replace(/[^a-z]/g, '');
  if (lower.length < 12 || lower.length !== s.replace(/[^a-zA-Z]/g, '').length) return false;
  // Try to fully cover the token with 3+ dictionary words of 4+ letters.
  const n = lower.length;
  const memo = new Array(n + 1).fill(null);
  memo[0] = 0;
  for (let i = 0; i < n; i++) {
    if (memo[i] == null) continue;
    for (let len = 4; len <= 12 && i + len <= n; len++) {
      if (WORDS.has(lower.slice(i, i + len))) {
        const next = i + len;
        const words = memo[i] + 1;
        if (memo[next] == null || words > memo[next]) memo[next] = words;
      }
    }
  }
  return memo[n] != null && memo[n] >= 3;
}

// ───────────────────────── §4.2.2 / §4.2.3 path/url/data-uri suppression ─────
function precededByPathOrUrl(text, start) {
  const before = text.slice(Math.max(0, start - 8), start);
  return /[/\\]$/.test(before) || /:\/\/$/.test(before);
}
function withinDataUri(text, start) {
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const lineEnd = (() => { const i = text.indexOf('\n', start); return i === -1 ? text.length : i; })();
  const line = text.slice(lineStart, lineEnd);
  return /data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(line);
}

// ───────────────────────── §4.3 Neighbourhood suppression ────────────────────
const NEIGHBOURHOOD_SUPPRESS =
  /\b(commit|sha|SHA|digest|checksum|hash|integrity|rev|revision|content_hash|etag|uuid|session|trace|request-id|build|chunk)\b/;
function neighbourhoodSuppressed(text, start) {
  const pre = text.slice(Math.max(0, start - 40), start);
  return NEIGHBOURHOOD_SUPPRESS.test(pre);
}

// ───────────────────────── §4.4 Placeholder allowlist ────────────────────────
// Structural placeholders (template/mask shapes) — safe to apply even to Tier-1
// provider-prefixed hits, since they're shape-based, not keyword-based, and don't
// collide with real secrets that merely happen to contain a common English word.
const PLACEHOLDER_STRUCTURAL =
  /YOUR[_-]|MY[_-]KEY|xxxx+|XXXX+|\.\.\.|…|^<.*>$|^\$\{.*\}$|^\$[A-Z_]+$|REDACTED/i;
// Loose/keyword placeholders — applied to context-bound tiers (3/4/5) only. Applying
// these to Tier 1 would incorrectly reject real-looking secrets that merely contain
// the substring "EXAMPLE" etc. (see docs/specs/secret-scrubber.md §4.4 discussion of
// AKIAIOSFODNN7EXAMPLE vs a structurally-similar-but-real-looking AWS secret key).
const PLACEHOLDER_LOOSE =
  /EXAMPLE|SAMPLE|PLACEHOLDER|CHANGE_?ME|dummy|fakekey|test[_-]?key|localhost|password123|^password$|^secret$|^token$/i;
const PLACEHOLDER_FULL = new RegExp(PLACEHOLDER_STRUCTURAL.source + '|' + PLACEHOLDER_LOOSE.source, 'i');
// Well-known, widely-published documentation constants (the canonical AWS docs
// example access key id). Scanners like gitleaks/trufflehog special-case this exact
// value for the same reason: it's the single most copy-pasted "safe" credential on
// the internet, and no generic pattern can separate it from a real key by shape alone.
const WELL_KNOWN_T1 = new Set(['AKIAIOSFODNN7EXAMPLE']);

function isT1Placeholder(value) {
  return WELL_KNOWN_T1.has(value) || PLACEHOLDER_STRUCTURAL.test(value) || value === 'REDACTED-BY-CLAUDE-BRAIN';
}
function isPlaceholder(value) {
  return PLACEHOLDER_FULL.test(value) || value === 'REDACTED-BY-CLAUDE-BRAIN';
}

// ───────────────────────── Combined gate ───────────────────────────────────────
// strictShape: apply the full hash/UUID/etc. shape-reject list (Tier 5) vs the
// light list (Tier 3/4, where assignment context already disambiguates).
export function isSecretValue(token, { text, idx, strictShape = true } = {}) {
  if (!token || token.length < 8) return false;
  if (isPlaceholder(token)) return false;
  const shapeList = strictShape ? SHAPE_REJECTS_FULL : SHAPE_REJECTS_LIGHT;
  if (shapeList.some((re) => re.test(token))) return false;
  if (repetitionReject(token)) return false;
  if (!passesEntropyThreshold(token)) return false;
  if (text != null && idx != null) {
    if (neighbourhoodSuppressed(text, idx)) return false;
    if (withinDataUri(text, idx)) return false;
  }
  return true;
}

// ───────────────────────── Detector introspection (for --list-detectors) ──────
export const DETECTORS = [
  ...T1.map(([id]) => ({ id, tier: 1 })),
  { id: 'private-key-pem', tier: 2 },
  { id: 'generic-assigned-secret', tier: 3 },
  { id: 'authorization-bearer', tier: 3 },
  { id: 'authorization-basic', tier: 3 },
  { id: 'password-flag', tier: 3 },
  { id: 'netrc-credentials', tier: 3 },
  { id: 'connection-string-credentials', tier: 4 },
  { id: 'high-entropy-secret', tier: 5 },
];

function freshRe(re) {
  // Regexes are module-level with 'g'/'d' flags and carry lastIndex state across
  // calls; construct a fresh instance per scan so concurrent/repeated calls never
  // silently skip matches (spec §8).
  return new RegExp(re.source, re.flags);
}

function pushCandidate(list, tier, detector, start, end, value, matchStr) {
  if (end <= start) return;
  list.push({ tier, detector, start, end, match: matchStr, value, confidence: tier <= 2 ? 'high' : tier === 5 ? 'review' : 'medium' });
}

// ───────────────────────── Main scan ───────────────────────────────────────────
export function findSecrets(text, opts = {}) {
  if (typeof text !== 'string' || !text) return [];
  const tiers = new Set(opts.tiers || [1, 2, 3, 4, 5]);
  // Tier 5 behavior: 'off' = not scanned; 'audit' (default) = candidates are
  // returned for review, scrubText() does not redact them; 'redact' = scrubText()
  // redacts them like any other hit. findSecrets() itself returns the same
  // candidates for 'audit' and 'redact' — the mode is applied by scrubText().
  const entropyMode = opts.entropyMode || 'audit';
  const candidates = [];

  // Tier 1
  if (tiers.has(1)) {
    for (const [id, re] of T1) {
      const rex = freshRe(re);
      let m;
      while ((m = rex.exec(text))) {
        if (m[0].length === 0) { rex.lastIndex++; continue; }
        if (m[1] !== undefined && m.indices && m.indices[1]) {
          const [s, e] = m.indices[1];
          const val = m[1];
          if (!isT1Placeholder(val)) pushCandidate(candidates, 1, id, s, e, val, m[0]);
        } else {
          const val = m[0];
          if (!isT1Placeholder(val)) pushCandidate(candidates, 1, id, m.index, m.index + m[0].length, val, m[0]);
        }
      }
    }
  }

  // Tier 2 — PEM blocks, redact whole block, never gated.
  if (tiers.has(2)) {
    const rex = freshRe(PEM);
    let m;
    while ((m = rex.exec(text))) {
      pushCandidate(candidates, 2, 'private-key-pem', m.index, m.index + m[0].length, m[0], m[0]);
      if (m[0].length === 0) rex.lastIndex++;
    }
  }

  // Tier 3 — context-bound assignment + explicit forms. More specific detectors
  // (authorization-*, password-flag, netrc) are inserted BEFORE the generic
  // ASSIGNMENT scan, so that on an identical span/length tie (e.g. `password=` is
  // both a KEYISH assignment AND the dedicated password-flag form) the specific,
  // more informative detector id wins (stable-sort tie-break favours first-inserted).
  if (tiers.has(3)) {
    for (const [id, re] of T3_EXTRA) {
      const rex2 = freshRe(re);
      let mm;
      while ((mm = rex2.exec(text))) {
        const value = mm[2];
        const [vs, ve] = (mm.indices && mm.indices[2]) || [null, null];
        if (vs != null && isSecretValue(value, { text, idx: vs, strictShape: false })) {
          pushCandidate(candidates, 3, id, vs, ve, value, mm[0]);
        }
        if (mm[0].length === 0) rex2.lastIndex++;
      }
    }
    // password-flag: -p<value> branch is gated on a nearby credential-taking CLI.
    {
      const rex2 = freshRe(PASSWORD_FLAG);
      let mm;
      while ((mm = rex2.exec(text))) {
        const flag = mm[1];
        const value = mm[3];
        const [vs, ve] = (mm.indices && mm.indices[3]) || [null, null];
        const isDashP = /^-p/.test(flag) && !/^--password/.test(flag);
        if (isDashP) {
          const before = text.slice(Math.max(0, mm.index - 40), mm.index);
          if (!CREDENTIAL_CLI.test(before)) { if (mm[0].length === 0) rex2.lastIndex++; continue; }
        }
        if (vs != null && isSecretValue(value, { text, idx: vs, strictShape: false })) {
          pushCandidate(candidates, 3, 'password-flag', vs, ve, value, mm[0]);
        }
        if (mm[0].length === 0) rex2.lastIndex++;
      }
    }
    // netrc-credentials: only when the line also matches the machine/login shape.
    {
      const lines = text.split('\n');
      let offset = 0;
      for (const line of lines) {
        if (NETRC_LINE.test(line)) {
          const rex2 = freshRe(NETRC_PASSWORD);
          let mm;
          while ((mm = rex2.exec(line))) {
            const value = mm[2];
            const [vs, ve] = (mm.indices && mm.indices[2]) || [null, null];
            if (vs != null && isSecretValue(value, { text: line, idx: vs, strictShape: false })) {
              pushCandidate(candidates, 3, 'netrc-credentials', offset + vs, offset + ve, value, mm[0]);
            }
            if (mm[0].length === 0) rex2.lastIndex++;
          }
        }
        offset += line.length + 1;
      }
    }
    // Generic KEYISH-name assignment — last, so dedicated detectors above win ties.
    // Skip candidates whose name is a bare CLI flag (e.g. `--password`, `-p`); those
    // are covered by password-flag above and shouldn't double-fire under a vaguer id.
    {
      const rex = freshRe(ASSIGNMENT);
      let m;
      while ((m = rex.exec(text))) {
        const rawName = (m[1] || '').replace(/^["'`]|["'`]$/g, '');
        if (/^--?\w/.test(rawName)) { if (m[0].length === 0) rex.lastIndex++; continue; }
        const value = m[3];
        const [vs, ve] = (m.indices && m.indices[3]) || [null, null];
        if (vs != null && isSecretValue(value, { text, idx: vs, strictShape: false })) {
          pushCandidate(candidates, 3, 'generic-assigned-secret', vs, ve, value, m[0]);
        }
        if (m[0].length === 0) rex.lastIndex++;
      }
    }
  }

  // Tier 4 — connection strings; redact only the password capture group.
  if (tiers.has(4)) {
    const rex = freshRe(CONN_STRING);
    let m;
    while ((m = rex.exec(text))) {
      const value = m[3];
      const [vs, ve] = (m.indices && m.indices[3]) || [null, null];
      if (vs != null && !isPlaceholder(value) && value.length >= 4) {
        pushCandidate(candidates, 4, 'connection-string-credentials', vs, ve, value, m[0]);
      }
      if (m[0].length === 0) rex.lastIndex++;
    }
  }

  // Tier 5 — generic high entropy. Review-only at capture time (entropyMode
  // 'audit', the default): reported, never redacted. Callers opt in to redaction
  // with entropyMode 'redact', or out of scanning entirely with 'off'.
  if (tiers.has(5) && entropyMode !== 'off') {
    const rex = freshRe(ENTROPY_TOKEN);
    let m;
    while ((m = rex.exec(text))) {
      const token = m[0];
      const start = m.index;
      if (precededByPathOrUrl(text, start)) continue;
      // A token embedded in a URL path/fragment (scheme:// appears earlier on the
      // same line) is a path segment, not a secret, even if not immediately
      // preceded by '/' (e.g. right after a domain name's final '.').
      {
        const ls = text.lastIndexOf('\n', start) + 1;
        if (/:\/\//.test(text.slice(ls, start))) continue;
      }
      if (!isSecretValue(token, { text, idx: start, strictShape: true })) continue;
      // Charset diversity: 3-of-4 classes, or a symbol + mixed case.
      const hasLower = /[a-z]/.test(token);
      const hasUpper = /[A-Z]/.test(token);
      const hasDigit = /[0-9]/.test(token);
      const hasSymbol = /[+/=_\-!@#$%^&*]/.test(token);
      const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
      const diverse = classes >= 3 || (hasSymbol && hasLower && hasUpper);
      if (!diverse) continue;
      // Context: near a KEYISH-ish word, or on a line with an export/header/curl marker.
      const winStart = Math.max(0, start - 80);
      const winEnd = Math.min(text.length, m.index + token.length + 80);
      const window = text.slice(winStart, winEnd);
      const lineStart = text.lastIndexOf('\n', start) + 1;
      const lineEndIdx = (() => { const i = text.indexOf('\n', start); return i === -1 ? text.length : i; })();
      const line = text.slice(lineStart, lineEndIdx);
      if (!TIER5_CONTEXT_WORD.test(window) && !TIER5_LINE_CONTEXT.test(line)) continue;
      pushCandidate(candidates, 5, 'high-entropy-secret', start, start + token.length, token, token);
    }
  }

  // §4.5 Precedence: earlier tier wins, then longer match wins. Greedy non-overlap.
  const ordered = [...candidates].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const lenA = a.end - a.start, lenB = b.end - b.start;
    if (lenA !== lenB) return lenB - lenA;
    return a.start - b.start;
  });
  const accepted = [];
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;
  for (const c of ordered) {
    if (!accepted.some((a) => overlaps(a, c))) accepted.push(c);
  }
  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

// ───────────────────────── Fingerprint (ledger-only; never inline) ────────────
// Note: this is a per-process fingerprint, not the spec's per-DB-salted Keychain
// fingerprint (§5.2) — sufficient for scrubText()'s pure-function contract and for
// the ledger dedup use in scrubSweep/applyScrub below, which pass an explicit salt.
export function fingerprint(value, salt = '') {
  return createHash('sha256').update(salt + ':' + value).digest('hex').slice(0, 12);
}

// ───────────────────────── Public API ──────────────────────────────────────────
// Returns { text, hits, review }:
//   hits    — what was redacted (tiers 1-4; plus tier 5 only with entropyMode 'redact')
//   review  — tier-5 candidates left in place for a human look (entropyMode 'audit',
//             the default). Detector id + salted fingerprint only, never a value.
export function scrubText(text, opts = {}) {
  if (typeof text !== 'string' || text === '') return { text: text ?? '', hits: [], review: [] };
  const found = findSecrets(text, opts);
  if (!found.length) return { text, hits: [], review: [] };
  const redactTier5 = opts.entropyMode === 'redact';
  const toRedact = found.filter((f) => f.tier !== 5 || redactTier5);
  const toReview = found.filter((f) => f.tier === 5 && !redactTier5);
  const review = toReview.map((f) => ({ detector: f.detector, fingerprint: fingerprint(f.value, opts.salt || '') }));
  if (!toRedact.length) return { text, hits: [], review };
  const sorted = [...toRedact].sort((a, b) => b.start - a.start);
  let out = text;
  const hits = [];
  for (const f of sorted) {
    out = out.slice(0, f.start) + `[REDACTED:${f.detector}]` + out.slice(f.end);
  }
  for (const f of toRedact) hits.push({ detector: f.detector, fingerprint: fingerprint(f.value, opts.salt || '') });
  return { text: out, hits, review };
}

// P4: scrub the fields ingest.mjs writes, BEFORE content_hash is computed.
export function scrubItem(it, opts = {}) {
  if (!it || typeof it !== 'object') return it;
  const out = { ...it };
  if (typeof it.title === 'string') out.title = scrubText(it.title, opts).text;
  if (typeof it.transcript === 'string') out.transcript = scrubText(it.transcript, opts).text;
  if (Array.isArray(it.prompts)) out.prompts = it.prompts.map((p) => (typeof p === 'string' ? scrubText(p, opts).text : p));
  return out;
}

// MCP write path (docs/specs/mcp-memory-server.md §2.2): scrub every free-text
// field of a model-supplied observation BEFORE its canonical content_hash is
// computed. Same P4 contract as scrubItem() above — hashing first and scrubbing
// after would desync content_hash from the stored text and silently corrupt
// dedup (secret-scrubber.md §5.3 P1).
//
// Covers title / subtitle / narrative / facts[] / concepts[]. Everything else
// (project, type, model) is either an enum, a name, or out of scope per §2.1.
// Returns a NEW object; the input is never mutated. Never throws: a field of an
// unexpected type is passed through untouched rather than crashing a live chat.
export function scrubObservation(obs, opts = {}) {
  if (!obs || typeof obs !== 'object') return obs;
  const out = { ...obs };
  for (const field of ['title', 'subtitle', 'narrative']) {
    if (typeof obs[field] === 'string') out[field] = scrubText(obs[field], opts).text;
  }
  for (const field of ['facts', 'concepts']) {
    if (Array.isArray(obs[field])) {
      out[field] = obs[field].map((v) => (typeof v === 'string' ? scrubText(v, opts).text : v));
    }
  }
  return out;
}

// Same scrub, but also reporting WHAT fired — detector ids and salted
// fingerprints only, never a value. Lets the MCP write path log "2 secrets
// scrubbed (openai-key, jwt)" to stderr without ever touching stdout or
// disclosing the credential. scrubObservation() is the thin wrapper callers use
// when they don't need the report. `review` lists tier-5 candidates that were
// reported but left in the text (see the Tier 5 note above).
export function scrubObservationWithHits(obs, opts = {}) {
  if (!obs || typeof obs !== 'object') return { obs, hits: [], review: [] };
  const out = { ...obs };
  const hits = [];
  const review = [];
  for (const field of ['title', 'subtitle', 'narrative']) {
    if (typeof obs[field] === 'string') {
      const r = scrubText(obs[field], opts);
      out[field] = r.text;
      for (const h of r.hits) hits.push({ field, ...h });
      for (const h of r.review) review.push({ field, ...h });
    }
  }
  for (const field of ['facts', 'concepts']) {
    if (Array.isArray(obs[field])) {
      out[field] = obs[field].map((v, i) => {
        if (typeof v !== 'string') return v;
        const r = scrubText(v, opts);
        for (const h of r.hits) hits.push({ field: `${field}[${i}]`, ...h });
        for (const h of r.review) review.push({ field: `${field}[${i}]`, ...h });
        return r.text;
      });
    }
  }
  return { obs: out, hits, review };
}

export const IDEMPOTENT_MARKER = /\[REDACTED:[^\]]+\]/;

// ───────────────────────── §5.4 `brain scrub` — DB-level audit/apply/revert ───
// Free-text columns in scope (§2.1). content_hash / concepts / files_* / project /
// timestamps are deliberately NOT rewritten (§2.1, §5.4.7 — content_hash rewrite
// would orphan rows against ux_observations_session_hash and break merge dedup).
export const SCRUB_SCOPE = [
  { table: 'observations', cols: ['text', 'narrative', 'facts', 'title', 'subtitle', 'metadata'] },
  { table: 'user_prompts', cols: ['prompt_text'] },
  { table: 'session_summaries', cols: ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'] },
  { table: 'sdk_sessions', cols: ['user_prompt'] },
  // The journal behind `brain recapture` / `brain clean --cursor-projects`
  // (bulklog.mjs) holds copies of row content — old and new values as JSON. A
  // secret scrubbed out of the rows must not stay in the journal, or --undo
  // could write it back. JSON columns are scrubbed value by value, so the
  // result is still valid JSON.
  { table: 'bulk_change_log', cols: ['old_values', 'new_values'], json: true },
];

// Apply `fn` to every string leaf of a JSON text (keys are left alone).
// → { ok, value } ; ok is false when `val` is not JSON (it is then scanned as plain text).
function mapJsonStrings(val, fn) {
  let doc;
  try { doc = JSON.parse(val); } catch { return { ok: false }; }
  const walk = (v) => {
    if (typeof v === 'string') return fn(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  return { ok: true, value: walk(doc) };
}

function hitsIn(val, json, opts) {
  if (!json) return findSecrets(val, opts);
  const hits = [];
  const m = mapJsonStrings(val, (s) => { hits.push(...findSecrets(s, opts)); return s; });
  return m.ok ? hits : findSecrets(val, opts);
}

function scrubValue(val, json, opts) {
  if (!json) return scrubText(val, opts);
  const hits = [];
  const m = mapJsonStrings(val, (s) => { const r = scrubText(s, opts); hits.push(...r.hits); return r.text; });
  if (!m.ok) return scrubText(val, opts);
  return { text: hits.length ? JSON.stringify(m.value) : val, hits };
}

function existingCols(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

// Read-only. Never prints/returns a secret value — only detector id, tier,
// row/column identity, project, and timestamp. §5.4 "Audit output".
export function auditScrub({ dbPath = MEMORY_DB, tiers = [1, 2, 3, 4, 5], sinceEpoch = 0 } = {}) {
  const db = openDb(dbPath, { readonly: true });
  const byDetector = new Map();
  let ageSecretKeyFired = false;
  const rowsScanned = {};
  try {
    for (const { table, cols, json } of SCRUB_SCOPE) {
      if (!tableExists(db, table)) continue;
      const cset = existingCols(db, table);
      const useCols = cols.filter((c) => cset.has(c));
      if (!useCols.length) continue;
      const hasEpoch = cset.has('created_at_epoch');
      const hasProject = cset.has('project');
      const hasCreatedAt = cset.has('created_at');
      const select = ['id', ...useCols];
      if (hasProject) select.push('project');
      if (hasCreatedAt) select.push('created_at');
      const where = sinceEpoch && hasEpoch ? ` WHERE created_at_epoch > ${Number(sinceEpoch)}` : '';
      const rows = db.prepare(`SELECT ${select.join(',')} FROM ${table}${where}`).all();
      rowsScanned[table] = rows.length;
      for (const row of rows) {
        for (const col of useCols) {
          const val = row[col];
          if (typeof val !== 'string' || !val) continue;
          for (const h of hitsIn(val, json, { tiers, entropyMode: 'audit' })) {
            if (h.detector === 'age-secret-key') ageSecretKeyFired = true;
            let e = byDetector.get(h.detector);
            if (!e) {
              e = { detector: h.detector, tier: h.tier, hits: 0, rowKeys: new Set(), projects: new Set(), firstSeen: null };
              byDetector.set(h.detector, e);
            }
            e.hits++;
            e.rowKeys.add(`${table}#${row.id}`);
            if (hasProject && row.project) e.projects.add(row.project);
            if (hasCreatedAt && row.created_at && (!e.firstSeen || row.created_at < e.firstSeen)) e.firstSeen = row.created_at;
          }
        }
      }
    }
  } finally {
    db.close();
  }
  const detectors = [...byDetector.values()]
    .map((e) => ({ detector: e.detector, tier: e.tier, hits: e.hits, rows: e.rowKeys.size, projects: e.projects.size, firstSeen: e.firstSeen }))
    .sort((a, b) => a.tier - b.tier || b.hits - a.hits);
  const certain = detectors.filter((d) => d.tier <= 4).reduce((a, d) => a + d.hits, 0);
  const review = detectors.filter((d) => d.tier === 5).reduce((a, d) => a + d.hits, 0);
  return { rowsScanned, detectors, certain, review, ageSecretKeyFired };
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Mutating. Every safety step in §5.4 is mandatory: pre-flight VACUUM INTO backup
// (verified), advisory lock, WAL-live-worker refusal, chunked transactions, a
// plaintext ledger (0600, journaled before each UPDATE) for --revert, FTS rebuild
// for session_summaries (no triggers), FTS integrity check for observations, and
// sync_rev bump / synced_at null instead of touching content_hash.
export function applyScrub({ dbPath = MEMORY_DB, tiers = [1, 2, 3, 4], sinceEpoch = 0, force = false, batchSize = 500 } = {}) {
  if (!existsSync(dbPath)) throw new Error(`No DB at ${dbPath}`);
  const memDir = dirname(dbPath);
  const workerPidFile = join(memDir, 'worker.pid');
  if (existsSync(workerPidFile) && !force) {
    const pid = Number((readFileSync(workerPidFile, 'utf8') || '').trim());
    if (isProcessRunning(pid)) {
      throw new Error(
        `claude-mem worker (pid ${pid}) is live — refusing to run --apply concurrently ` +
          `(a concurrent writer + a long write transaction is how memories were previously lost). Pass --force to override.`
      );
    }
  }
  const lockFile = join(memDir, 'scrub.lock');
  if (existsSync(lockFile) && !force) {
    throw new Error(`${lockFile} exists — another scrub or sync may be in progress. Remove it or pass --force.`);
  }
  mkdirSync(memDir, { recursive: true });
  writeFileSync(lockFile, String(process.pid));
  let db;
  try {
    const backupsDir = join(memDir, 'backups');
    mkdirSync(backupsDir, { recursive: true });
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupsDir, `pre-scrub-${iso}.db`);

    db = openDb(dbPath);
    // VACUUM INTO writes a NEW file; it is WAL-safe and does not touch the source's
    // WAL/journal (unlike an in-place VACUUM, which is never run here).
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    let backupOk = existsSync(backupPath);
    if (backupOk) {
      const verify = openDb(backupPath, { readonly: true });
      try {
        const a = tableExists(db, 'observations') ? db.prepare('SELECT COUNT(*) n FROM observations').get().n : 0;
        const b = tableExists(verify, 'observations') ? verify.prepare('SELECT COUNT(*) n FROM observations').get().n : 0;
        backupOk = a === b;
      } finally {
        verify.close();
      }
    }
    if (!backupOk) {
      db.close();
      throw new Error(`Backup verification failed (${backupPath}) — aborting, nothing changed.`);
    }

    const ledgerPath = join(backupsDir, `scrub-ledger-${iso}.jsonl`);
    writeFileSync(ledgerPath, '');
    chmodSync(ledgerPath, 0o600);

    let rowsUpdated = 0;
    const changesByDetector = {};
    let touchedSummaries = false;

    for (const { table, cols, json } of SCRUB_SCOPE) {
      if (!tableExists(db, table)) continue;
      const cset = existingCols(db, table);
      const useCols = cols.filter((c) => cset.has(c));
      if (!useCols.length) continue;
      const hasEpoch = cset.has('created_at_epoch');
      const hasSyncRev = cset.has('sync_rev');
      const hasSyncedAt = cset.has('synced_at');
      const where = sinceEpoch && hasEpoch ? ` WHERE created_at_epoch > ${Number(sinceEpoch)}` : '';
      const rows = db.prepare(`SELECT id,${useCols.join(',')} FROM ${table}${where}`).all();

      for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        db.exec('BEGIN');
        try {
          for (const row of chunk) {
            const updates = {};
            for (const col of useCols) {
              const val = row[col];
              if (typeof val !== 'string' || !val) continue;
              const { text, hits } = scrubValue(val, json, { tiers, entropyMode: 'redact' });
              if (hits.length && text !== val) {
                updates[col] = text;
                for (const h of hits) changesByDetector[h.detector] = (changesByDetector[h.detector] || 0) + 1;
                appendFileSync(
                  ledgerPath,
                  JSON.stringify({
                    table, rowid: row.id, column: col,
                    detectors: hits.map((h) => h.detector),
                    fingerprints: hits.map((h) => h.fingerprint),
                    before: val, after: text,
                  }) + '\n'
                );
              }
            }
            const setCols = Object.keys(updates);
            if (setCols.length) {
              const setSql =
                setCols.map((c) => `${c}=?`).join(',') +
                (hasSyncRev ? ', sync_rev = COALESCE(sync_rev,0)+1' : '') +
                (hasSyncedAt ? ', synced_at = NULL' : '');
              db.prepare(`UPDATE ${table} SET ${setSql} WHERE id=?`).run(...setCols.map((c) => updates[c]), row.id);
              rowsUpdated++;
              if (table === 'session_summaries') touchedSummaries = true;
            }
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          db.close();
          throw e;
        }
      }
    }

    // §2.2 — session_summaries_fts has no triggers; must be rebuilt manually.
    if (touchedSummaries && tableExists(db, 'session_summaries_fts')) {
      try { db.exec(`INSERT INTO session_summaries_fts(session_summaries_fts) VALUES('rebuild')`); } catch {}
    }
    let ftsOk = true;
    if (tableExists(db, 'observations_fts')) {
      try { db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('integrity-check')`); } catch { ftsOk = false; }
    }

    db.close();
    return { rowsUpdated, changesByDetector, backupPath, ledgerPath, ftsOk };
  } finally {
    try { unlinkSync(lockFile); } catch {}
  }
}

// Replays a scrub ledger backwards, restoring original (before) values. Plaintext
// secrets flow through this path — caller must treat the ledger file itself as
// sensitive (mode 0600, gitignored — see .gitignore's scrub-ledger-*.jsonl entry).
export function revertScrub({ dbPath = MEMORY_DB, ledgerPath } = {}) {
  if (!existsSync(ledgerPath)) throw new Error(`No ledger at ${ledgerPath}`);
  const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const db = openDb(dbPath);
  db.exec('BEGIN');
  try {
    for (const entry of [...lines].reverse()) {
      db.prepare(`UPDATE ${entry.table} SET ${entry.column}=? WHERE id=?`).run(entry.before, entry.rowid);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.close();
    throw e;
  }
  db.close();
  return { restored: lines.length };
}

// P6 — periodic sweep, thin wrapper over applyScrub scoped to rows newer than
// sinceEpoch. Not wired into the ingest timer by this change (see docs/specs
// review notes) — exposed here so a future change can call it from ingest.mjs /
// watch.mjs without re-deriving the safety machinery.
export function scrubSweep({ dbPath = MEMORY_DB, sinceEpoch = 0 } = {}) {
  return applyScrub({ dbPath, sinceEpoch, tiers: [1, 2, 3, 4], batchSize: 500 });
}
