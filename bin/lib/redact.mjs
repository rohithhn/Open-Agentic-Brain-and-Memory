// Redact secret-looking values before any settings file enters the repo.
// Keys whose name hints at a credential get their value replaced; obvious secret
// value patterns (tokens/keys) are masked even under innocuous key names.
const SECRET_KEY = /(key|token|secret|password|passwd|credential|apikey|api_key|auth|bearer|client_secret|access_key|private|cookie|session|webhook)/i;
const SECRET_VALUE = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /sk-[A-Za-z0-9-]{20,}/g, // OpenAI-style
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /AGE-SECRET-KEY-[A-Z0-9]+/g, // age identities
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /\b[A-Za-z_][A-Za-z0-9_]{1,30}=[A-Za-z0-9_\-+/.]{20,}/g, // cookies / key=longvalue (e.g. li_at=...)
  /\b[A-Za-z0-9_-]{40,}\b/g, // any long high-entropy token
];

const MASK = 'REDACTED-BY-CLAUDE-BRAIN';

function maskValue(v) {
  if (typeof v !== 'string') return v;
  let out = v;
  for (const re of SECRET_VALUE) out = out.replace(re, MASK);
  return out;
}

export function redactObject(obj) {
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        out[k] = MASK;
      } else if (typeof v === 'string') {
        out[k] = maskValue(v);
      } else {
        out[k] = redactObject(v);
      }
    }
    return out;
  }
  return obj;
}

export function redactJsonText(text) {
  try {
    return JSON.stringify(redactObject(JSON.parse(text)), null, 2) + '\n';
  } catch {
    // Not valid JSON — fall back to line masking.
    let out = text;
    for (const re of SECRET_VALUE) out = out.replace(re, MASK);
    return out;
  }
}
