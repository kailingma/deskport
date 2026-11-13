// Turns bench results into a table, one row per link and case, with the
// median of each value over the runs.

/** Values the table shows, as [column, getter]. */
export const COLUMNS = [
  ['key ms', (r) => r.keyToPixel?.median ?? r.echo?.median],
  ['key p90', (r) => r.keyToPixel?.p90 ?? r.echo?.p90],
  ['missed', (r) => r.keyToPixel?.missed ?? r.echo?.missed],
  ['press ms', (r) => r.pressToPixel?.median],
  ['catch-up ms', (r) => r.catchUpMs],
  ['motion fps', (r) => r.motion?.fps],
  ['motion KB/min', (r) => r.motionKBPerMin],
  ['typing KB/min', (r) => r.typingKBPerMin],
  ['idle KB/min', (r) => r.idleKBPerMin],
  ['encode ms', (r) => r.encodeMs?.median],
  ['first ms', (r) => r.firstPictureMs],
  ['ctrl-c ms', (r) => r.interruptMs],
  ['flood KB', (r) => r.floodKB],
];

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

/** { "link case": { column: median } } */
export function rows(out) {
  const groups = new Map();
  for (const r of out.results) {
    const k = `${r.link} ${r.encoding}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const res = {};
  for (const [k, rs] of groups) {
    res[k] = Object.fromEntries(COLUMNS.map(([c, get]) => [c, median(rs.map(get))]));
    const errors = rs.filter((r) => r.error).map((r) => r.error);
    if (errors.length) res[k].errors = errors;
  }
  return res;
}

function render(header, body) {
  const w = header.map((h, i) => Math.max(h.length, ...body.map((b) => String(b[i]).length)));
  const line = (cells) => `| ${cells.map((c, i) => String(c).padEnd(w[i])).join(' | ')} |`;
  return [line(header), `| ${w.map((n) => '-'.repeat(n)).join(' | ')} |`, ...body.map(line)].join('\n');
}

/** Markdown table of one result file; columns with no values are left out. */
export function table(out) {
  const rs = rows(out);
  const cols = COLUMNS.map(([c]) => c).filter((c) => Object.values(rs).some((r) => r[c] !== null));
  const body = Object.entries(rs).map(([k, r]) => [k, ...cols.map((c) => r[c] ?? '')]);
  const errs = Object.entries(rs).filter(([, r]) => r.errors).map(([k, r]) => `${k}: ${r.errors.join('; ')}`);
  return render(['link case', ...cols], body) + (errs.length ? `\n\nerrors:\n${errs.join('\n')}` : '');
}

/** Markdown table of `after` against `before`: "before → after". */
export function compare(before, after) {
  const a = rows(before);
  const b = rows(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const cols = COLUMNS.map(([c]) => c).filter((c) => keys.some((k) => (a[k]?.[c] ?? b[k]?.[c] ?? null) !== null));
  const body = keys.map((k) => [k, ...cols.map((c) => {
    const x = a[k]?.[c] ?? null;
    const y = b[k]?.[c] ?? null;
    return x === null && y === null ? '' : `${x ?? '-'} → ${y ?? '-'}`;
  })]);
  return render(['link case', ...cols], body);
}
