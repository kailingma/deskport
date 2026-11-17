import { GuacParser } from './guac-protocol.js';

const SCREEN_OPS = new Set(['sync', 'ack', 'nop', 'disconnect']);
const MAX_INPUT = 64 * 1024;

/** A per-stream input allowlist. Screen instructions may span messages. */
export function createReadOnlyFilter(kind) {
  const parser = kind === 'screen' ? new GuacParser() : null;
  return (data, isBinary = false) => {
    if (isBinary) return null;
    const text = data.toString();
    if (parser) {
      if (parser.buf.length + text.length > MAX_INPUT) { parser.buf = ''; return null; }
      try {
        const safe = parser.push(text).filter(({ elements: [op, arg] }) => SCREEN_OPS.has(op) || (op === '' && arg === 'ping'));
        return safe.length ? safe.map((i) => i.raw).join('') : null;
      } catch {
        parser.buf = '';
        return null;
      }
    }
    if (text.length > MAX_INPUT) return null;
    let msg;
    try { msg = JSON.parse(text); } catch { return null; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
    const allowed = kind === 'term' ? ['ack', 'ping'] : kind === 'video' ? ['ack', 'key'] : [];
    return allowed.includes(msg.type) ? data : null;
  };
}

/** The hub's authority cannot be overridden by browser query parameters. */
export function readOnlyQuery(kind, query = '') {
  const params = new URLSearchParams(query);
  params.set('readonly', '1');
  if (kind === 'screen') {
    params.set('source', 'mirror');
    for (const key of ['match', 'monitor', 'path']) params.delete(key);
  }
  return `?${params}`;
}
