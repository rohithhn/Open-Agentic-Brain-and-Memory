// A tiny JSONC (JSON + comments + trailing commas) reader that keeps SOURCE
// POSITIONS, and the one edit we need: add/replace a member of an object by
// splicing text — never re-serialising the document. Kilo's global config is
// `kilo.jsonc` by default (comments are normal there), so wireJson()'s
// parse → JSON.stringify round trip would destroy the user's comments and
// formatting. Everything outside the spliced span stays byte-identical.
// Zero deps, pure functions, no fs.

export class JsoncError extends Error {
  constructor(msg, at) { super(`${msg} at offset ${at}`); this.at = at; }
}

const WS = /[\s﻿]/;

/** Index of the next significant char at/after i (skips whitespace and comments). */
export function skipTrivia(t, i) {
  for (;;) {
    while (i < t.length && WS.test(t[i])) i++;
    if (t[i] === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (t[i] === '/' && t[i + 1] === '*') {
      const e = t.indexOf('*/', i + 2);
      if (e === -1) throw new JsoncError('unterminated comment', i);
      i = e + 2; continue;
    }
    return i;
  }
}

function parseString(t, i) {
  let j = i + 1;
  while (j < t.length) {
    const c = t[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '"') {
      let value;
      try { value = JSON.parse(t.slice(i, j + 1)); } catch { throw new JsoncError('bad string', i); }
      return { kind: 'string', start: i, end: j + 1, value };
    }
    if (c === '\n') break;
    j++;
  }
  throw new JsoncError('unterminated string', i);
}

function parseValue(t, i, depth) {
  if (depth > 200) throw new JsoncError('nesting too deep', i);
  i = skipTrivia(t, i);
  const c = t[i];
  if (c === '"') return parseString(t, i);
  if (c === '{') {
    const members = [];
    let j = i + 1;
    for (;;) {
      j = skipTrivia(t, j);
      if (t[j] === '}') return { kind: 'object', start: i, end: j + 1, members };
      if (t[j] !== '"') throw new JsoncError('expected a string key', j);
      const key = parseString(t, j);
      j = skipTrivia(t, key.end);
      if (t[j] !== ':') throw new JsoncError("expected ':'", j);
      const val = parseValue(t, j + 1, depth + 1);
      members.push({ key: key.value, start: key.start, end: val.end, value: val });
      j = skipTrivia(t, val.end);
      if (t[j] === ',') { j++; continue; }
      if (t[j] === '}') return { kind: 'object', start: i, end: j + 1, members };
      throw new JsoncError("expected ',' or '}'", j);
    }
  }
  if (c === '[') {
    const items = [];
    let j = i + 1;
    for (;;) {
      j = skipTrivia(t, j);
      if (t[j] === ']') return { kind: 'array', start: i, end: j + 1, items };
      const v = parseValue(t, j, depth + 1);
      items.push(v);
      j = skipTrivia(t, v.end);
      if (t[j] === ',') { j++; continue; }
      if (t[j] === ']') return { kind: 'array', start: i, end: j + 1, items };
      throw new JsoncError("expected ',' or ']'", j);
    }
  }
  const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(t.slice(i, i + 64));
  if (!m) throw new JsoncError('unexpected token', i);
  return { kind: 'literal', start: i, end: i + m[0].length, value: JSON.parse(m[0]) };
}

/** → { ok:true, root } | { ok:false, error }. The whole text must be exactly one value. */
export function parseJsonc(text) {
  try {
    const root = parseValue(text, 0, 0);
    const rest = skipTrivia(text, root.end);
    if (rest < text.length) throw new JsoncError('trailing content', rest);
    return { ok: true, root };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** The plain JS value of a node (comments dropped). */
export function valueOf(node) {
  switch (node.kind) {
    case 'object': return Object.fromEntries(node.members.map((m) => [m.key, valueOf(m.value)]));
    case 'array': return node.items.map(valueOf);
    default: return node.value;
  }
}

export const getMember = (obj, key) => obj.members.find((m) => m.key === key) || null;

const lineStart = (t, pos) => t.lastIndexOf('\n', pos - 1) + 1;
const leadingWs = (t, pos) => /^[ \t]*/.exec(t.slice(lineStart(t, pos)))[0];

/** The document's indent unit: its first indented line (tab, or that many spaces), else 2 spaces. */
export function indentUnit(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return '  ';
  return m[1][0] === '\t' ? '\t' : ' '.repeat(Math.min(m[1].length, 8));
}

/** Pretty JSON like Kilo's own configs: objects expanded, arrays of scalars kept on one line. */
function pretty(v, unit, cur) {
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
    return `[\n${v.map((x) => cur + unit + pretty(x, unit, cur + unit)).join(',\n')}\n${cur}]`;
  }
  if (v && typeof v === 'object') {
    const ks = Object.keys(v);
    if (!ks.length) return '{}';
    return `{\n${ks.map((k) => `${cur}${unit}${JSON.stringify(k)}: ${pretty(v[k], unit, cur + unit)}`).join(',\n')}\n${cur}}`;
  }
  return JSON.stringify(v);
}

/** Render `v` for insertion as a member value whose line is indented by `indent`. */
function render(v, unit, indent, multi) {
  return multi ? pretty(v, unit, indent) : JSON.stringify(v);
}

/** End of a comment that sits on the same line right after `pos` (spaces allowed), else pos. */
function sameLineTrailer(t, pos) {
  let q = pos;
  while (t[q] === ' ' || t[q] === '\t') q++;
  if (t.startsWith('//', q)) { const e = t.indexOf('\n', q); return e === -1 ? t.length : (t[e - 1] === '\r' ? e - 1 : e); }
  if (t.startsWith('/*', q)) {
    const e = t.indexOf('*/', q + 2);
    if (e !== -1 && !t.slice(q, e).includes('\n')) return e + 2;
  }
  return pos;
}

/**
 * Text with `"key": <v>` added as the LAST member of `obj` (a parsed object node).
 * Only the insertion point changes; the user's comments, ordering, trailing-comma
 * style and line endings elsewhere are untouched. Returns the new full text.
 */
export function insertMember(text, obj, key, v, { unit = indentUnit(text), eol = '\n' } = {}) {
  const multiline = text.slice(obj.start, obj.end).includes('\n');
  const base = leadingWs(text, obj.start);
  const nl = (s) => s.replace(/\n/g, eol);
  if (obj.members.length) {
    const first = obj.members[0];
    const last = obj.members[obj.members.length - 1];
    const ownLine = /^[ \t]*$/.test(text.slice(lineStart(text, first.start), first.start));
    const child = multiline ? (ownLine ? leadingWs(text, first.start) : base + unit) : '';
    const member = `${JSON.stringify(key)}${multiline ? ': ' : ':'}${render(v, unit, child, multiline)}`;
    const after = skipTrivia(text, last.end);
    if (text[after] === ',') { // trailing comma: keep that style; a `// note` on that line stays with its member
      const at = sameLineTrailer(text, after + 1);
      const ins = multiline ? `${eol}${child}${nl(member)},` : `${nl(member)},`;
      return text.slice(0, at) + ins + text.slice(at);
    }
    const at = multiline ? sameLineTrailer(text, last.end) : last.end;
    const ins = multiline ? `${eol}${child}${nl(member)}` : `,${nl(member)}`;
    return multiline
      ? text.slice(0, last.end) + ',' + text.slice(last.end, at) + ins + text.slice(at)
      : text.slice(0, at) + ins + text.slice(at);
  }
  const child = base + unit;
  const member = `${JSON.stringify(key)}: ${render(v, unit, child, true)}`;
  const inner = text.slice(obj.start + 1, obj.end - 1);
  if (inner.trim() === '') {
    return text.slice(0, obj.start + 1) + `${eol}${child}${nl(member)}${eol}${base}` + text.slice(obj.end - 1);
  }
  return text.slice(0, obj.start + 1) + `${eol}${child}${nl(member)}` + text.slice(obj.start + 1);
}

/** Text with the value node of an existing member replaced by `v`. */
export function replaceMemberValue(text, member, v, { unit = indentUnit(text), eol = '\n' } = {}) {
  const pretty = text.includes('\n'); // a minified file stays minified
  const src = render(v, unit, leadingWs(text, member.start), pretty).replace(/\n/g, eol);
  return text.slice(0, member.value.start) + src + text.slice(member.value.end);
}

/** A whole new document, in the same style insertMember() writes. */
export const prettyJson = (v, unit = '  ') => pretty(v, unit, '');
