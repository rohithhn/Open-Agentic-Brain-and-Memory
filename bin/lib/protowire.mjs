// Minimal, dependency-free protobuf WIRE-FORMAT reader (and a matching writer
// the tests use to build fixtures). No .proto schema: it splits a buffer into
// tagged fields and leaves the meaning of each field number to the caller —
// enough to read the blobs Antigravity CLI (agy >= 1.3) keeps in its
// per-conversation SQLite DBs (see parseAntigravity in ingest.mjs).
//
// Wire types (protobuf encoding spec): 0 varint, 1 fixed64, 2 length-delimited
// (string / bytes / nested message — indistinguishable on the wire), 5 fixed32.
// Groups (3/4) are long deprecated and treated as malformed.
// Every reader throws on malformed input; the "try" helpers turn that into null
// so a corrupt blob can be skipped without a try/catch at every call site.

// One buffer → [{ f, w, v }] in wire order. v: Number for varints (BigInt when
// beyond 2^53), a Uint8Array view for fixed and length-delimited fields.
export function pbFields(buf) {
  if (!(buf instanceof Uint8Array)) throw new Error('protowire: not bytes');
  const out = [];
  let i = 0;
  const varint = () => {
    let lo = 0, mul = 1, big = null, shift = 0n;
    for (let n = 0; ; n++) {
      if (i >= buf.length) throw new Error('protowire: truncated varint');
      if (n >= 10) throw new Error('protowire: varint too long');
      const b = buf[i++];
      if (big === null && n < 7) { lo += (b & 0x7f) * mul; mul *= 128; }
      else { if (big === null) { big = BigInt(lo); shift = BigInt(7 * n); } big |= BigInt(b & 0x7f) << shift; shift += 7n; }
      if (!(b & 0x80)) break;
    }
    if (big === null) return lo;
    return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
  };
  const take = (n) => {
    if (n < 0 || i + n > buf.length) throw new Error('protowire: truncated field');
    const v = buf.subarray(i, i + n);
    i += n;
    return v;
  };
  while (i < buf.length) {
    const key = varint();
    const f = Math.floor(Number(key) / 8), w = Number(key) & 7;
    if (f < 1) throw new Error('protowire: bad field number');
    if (w === 0) out.push({ f, w, v: varint() });
    else if (w === 1) out.push({ f, w, v: take(8) });
    else if (w === 2) out.push({ f, w, v: take(Number(varint())) });
    else if (w === 5) out.push({ f, w, v: take(4) });
    else throw new Error('protowire: unsupported wire type ' + w);
  }
  return out;
}

// pbFields that answers null instead of throwing (null/undefined input too).
export function pbTry(buf) {
  if (!buf) return null;
  try { return pbFields(buf instanceof Uint8Array ? buf : new Uint8Array(buf)); } catch { return null; }
}

const utf8 = new TextDecoder('utf-8', { fatal: false });
// First / every value of field `f` in an already-split message.
export const pbOne = (fields, f) => (fields ? fields.find((x) => x.f === f) : undefined);
export const pbAll = (fields, f) => (fields ? fields.filter((x) => x.f === f) : []);
// Field `f` as a nested message (split), or null.
export const pbSub = (fields, f) => { const x = pbOne(fields, f); return x && x.w === 2 ? pbTry(x.v) : null; };
// Field `f` as a UTF-8 string ('' when absent or not length-delimited).
export const pbStr = (fields, f) => { const x = pbOne(fields, f); return x && x.w === 2 ? utf8.decode(x.v) : ''; };
export const pbText = (bytes) => utf8.decode(bytes);
// Field `f` as a varint Number (0 when absent).
export const pbNum = (fields, f) => { const x = pbOne(fields, f); return x && x.w === 0 ? Number(x.v) : 0; };
// A google.protobuf.Timestamp {1: seconds, 2: nanos} at field `f` → epoch ms (0 if absent).
export function pbTimeMs(fields, f) {
  const t = pbSub(fields, f);
  if (!t) return 0;
  const s = pbNum(t, 1), ns = pbNum(t, 2);
  return s > 0 ? s * 1000 + Math.floor(ns / 1e6) : 0;
}

// ── writer (fixtures only) ──────────────────────────────────────────────────
// pbEncode([[field, value], ...]): number → varint, string → UTF-8 bytes,
// Uint8Array → raw bytes, array → nested message (encoded recursively).
function encVarint(n, out) {
  let v = BigInt(n);
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
}
export function pbEncode(pairs) {
  const out = [];
  for (const [f, val] of pairs) {
    if (typeof val === 'number' || typeof val === 'bigint') { encVarint(f * 8, out); encVarint(val, out); continue; }
    const bytes = typeof val === 'string' ? new TextEncoder().encode(val) : Array.isArray(val) ? pbEncode(val) : val;
    encVarint(f * 8 + 2, out); encVarint(bytes.length, out);
    for (const b of bytes) out.push(b);
  }
  return Uint8Array.from(out);
}
