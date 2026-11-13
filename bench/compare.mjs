// Compares two bench result files: node bench/compare.mjs before.json after.json
import fs from 'node:fs';
import { compare } from './lib/report.mjs';

const [before, after] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
if (!before || !after) {
  console.error('usage: node bench/compare.mjs before.json after.json');
  process.exit(2);
}
console.log(`${before.label} (${before.commit}) → ${after.label} (${after.commit})\n`);
console.log(compare(before, after));
