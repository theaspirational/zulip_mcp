import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticError } from '../src/diagnostics.ts';

test('default diagnostics preserve exact console arguments; subscribed diagnostics never serialize details', () => {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args) => { calls.push(args); };
  try {
    const error = new Error('revoked stream 987654321');
    const body = { toJSON() { throw new Error('must not serialize'); } };
    diagnosticError(false, 'test', 'original label', error, body);
    assert.deepEqual(calls[0], ['original label', error, body]);
    diagnosticError(true, 'test', 'revoked stream', error, body);
    assert.deepEqual(calls[1], ['[zulip-mcp:test] diagnostic details withheld by subscribed-stream policy']);
  } finally { console.error = original; }
});
