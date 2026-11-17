// Guacamole elements are "<length>.<value>", separated by commas, ending in
// a semicolon. Lengths count Unicode code points, not UTF-16 units or bytes.

const ASCII_ONLY = /^[\x00-\x7f]*$/;

function codePointLength(s) {
  if (ASCII_ONLY.test(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function encode(elements) {
  return elements.map((e) => {
    const s = String(e);
    return `${codePointLength(s)}.${s}`;
  }).join(',') + ';';
}

/** Index just past `count` code points starting at `start`, or -1 if incomplete. */
function advanceCodePoints(s, start, count) {
  const fastEnd = start + count;
  if (fastEnd > s.length) return -1;
  if (!/[\uD800-\uDBFF]/.test(s.slice(start, fastEnd))) return fastEnd;
  let i = start;
  for (let n = 0; n < count; n++) {
    if (i >= s.length) return -1;
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }
  return i > s.length ? -1 : i;
}

export class GuacParser {
  buf = '';

  /** Appends text and returns every complete instruction as {raw, elements}. */
  push(text) {
    this.buf += text;
    const s = this.buf;
    const out = [];
    let pos = 0;
    let instStart = 0;
    let elements = [];

    while (pos < s.length) {
      const dot = s.indexOf('.', pos);
      if (dot === -1) break;
      const lenStr = s.slice(pos, dot);
      if (!/^\d{1,9}$/.test(lenStr)) throw new Error(`malformed Guacamole instruction near "${s.slice(pos, pos + 20)}"`);
      const end = advanceCodePoints(s, dot + 1, Number(lenStr));
      if (end === -1 || end >= s.length) break;
      const term = s[end];
      if (term !== ',' && term !== ';') throw new Error('malformed Guacamole instruction terminator');
      elements.push(s.slice(dot + 1, end));
      pos = end + 1;
      if (term === ';') {
        out.push({ raw: s.slice(instStart, pos), elements });
        instStart = pos;
        elements = [];
      }
    }

    this.buf = s.slice(instStart);
    return out;
  }
}
