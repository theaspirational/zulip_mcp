import assert from 'node:assert/strict';
import { normalizeMarkdownTables as normalize } from '../../src/markdown-tables.ts';
const MiB = 1024 * 1024;
// Include the adjacent-table adversarial shape, not only a long plain string.
const cases: [string, string][] = [
  ['many-tables', 'a|b\n-|-\n'.repeat(MiB / 8)],
  ['long-line', 'x'.repeat(MiB)],
  ['many-pipes', '|'.repeat(MiB)],
  ['large-table', 'a|b\n-|-\n' + 'c|d\n'.repeat((MiB - 8) / 4)],
  ['many-blanks', '\r\n'.repeat(MiB / 2)],
  ['wide-table', 'a|'.repeat(MiB / 4 - 1) + 'b\n' + '-|'.repeat(MiB / 4 - 1) + '-\n'],
];
for (const [name, input] of cases) {
  const start = performance.now();
  const output = normalize(input);
  const ms = performance.now() - start;
  console.log(JSON.stringify({name, bytes: Buffer.byteLength(input), ms, outputBytes: Buffer.byteLength(output)}));
  assert.ok(ms < 200, `${name}: ${ms} ms >= 200 ms`);
  assert.equal(normalize(output), output, name + ': idempotent');
}
