/** Compare two independently normalized, identically ordered corpus runs. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
const [before, after] = process.argv.slice(2).map(read);
assert.equal(before.length, after.length);
const originalCount = 16697;
assert.ok(after.length >= originalCount + 2000);
const counts = { original: { cases: 0, gain: 0 }, added: { cases: 0, gain: 0 } };
for (let i = 0; i < after.length; i++) {
  assert.equal(before[i].input, after[i].input);
  const count = counts[i < originalCount ? 'original' : 'added'];
  count.cases++;
  if (before[i].output === before[i].input && after[i].output !== after[i].input) count.gain++;
  // This widening must never lose an existing normalization.
  if (before[i].output !== before[i].input) assert.equal(after[i].output, before[i].output);
}
console.log(JSON.stringify(counts));
