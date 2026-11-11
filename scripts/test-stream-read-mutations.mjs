// Offline, focused security mutations. Always restore source, including on failure.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const evidence = process.env.ORGASMIC_EVIDENCE_DIR ?? '/tmp/zulip-stream-mutations';
mkdirSync(evidence, { recursive: true });
const mutations = [
  {
    name: 'membership-visibility',
    path: 'src/subscriptions.ts',
    from: 'this.streams.has(id)',
    to: 'this.names.has(id)',
    test: 'reviewer rename probe',
  },
  {
    name: 'omit-final-authorization',
    path: 'src/stream-read-gate.ts',
    from: 'for (const id of this.reads.getStore()!) this.assert(id);',
    to: '/* mutation: no final authorization */',
    test: 'unsubscribe during final await: get_poll_results',
  },
];
for (const mutation of mutations) {
  const source = readFileSync(mutation.path, 'utf8');
  if (!source.includes(mutation.from)) throw new Error(`Mutation site missing: ${mutation.name}`);
  try {
    writeFileSync(mutation.path, source.replaceAll(mutation.from, mutation.to));
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', '--test', `--test-name-pattern=${mutation.test}`, 'test/streamReadGate.test.ts',
    ], { encoding: 'utf8', env: { ...process.env, NO_UPDATE_NOTIFIER: '1' }, timeout: 30000 });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    writeFileSync(join(evidence, `mutation-${mutation.name}.log`), output);
    if (result.status !== 1 || !output.includes('not ok') || !/# fail [1-9]/.test(output) ||
        !/# cancelled 0/.test(output))
      throw new Error(`Mutation survived or failed to run: ${mutation.name}; see evidence log`);
    console.log(`KILLED ${mutation.name}: ${mutation.test}`);
  } finally {
    writeFileSync(mutation.path, source);
  }
}
