// Run under the same offline, memory-limited gate wrapper as the suite.
// Each deliberate regression must fail an assertion, never merely fail to load.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const evidence = process.env.FORK_MUTATION_EVIDENCE_DIR ?? '.tmp/mutations';
mkdirSync(evidence, { recursive: true });
const mutants = [
  {
    name: 'unplaced-reserves-frontiers', file: 'src/server.ts', test: 'test/fixRound2.test.ts',
    from: 'void boundedPollRead(entry.ready(), POLL_PLACEMENT_WAIT_MS).then(result => {',
    to: `const frontier = Promise.all([...lanes.keys()].map(key => new Promise<void>(resolve => lanes.lane(key).enter(() => resolve()))));
    void boundedPollRead(frontier.then(() => entry.ready()), POLL_PLACEMENT_WAIT_MS).then(result => {`,
    killedBy: 'best-effort vote still checks revocation after placement, moved=false',
    pattern: 'best-effort vote still checks revocation after placement, moved=false',
  },
  {
    name: 'vote-bypasses-lane', file: 'src/platforms/zulip.ts', test: 'test/forkLanes.test.ts',
    from: `onMessage({
        key: this.placementHints.get(s.message_id!) ?? null,
        messageId: \`poll:\${s.message_id}:\${s.id}\`,
        ready: () => this.scopedEntry(s.readEpoch, () => this.onPollSubmessage(s)),
      });`,
    to: `const eager = this.scopedEntry(s.readEpoch, () => this.onPollSubmessage(s));
      onMessage({
        key: this.placementHints.get(s.message_id!) ?? null,
        messageId: \`poll:\${s.message_id}:\${s.id}\`,
        ready: () => eager,
      });`,
    killedBy: 'a poll vote waits behind its channel read',
  },
  {
    name: 'purge-skips-revocation-gate', file: 'src/server.ts', test: 'test/forkLanes.test.ts',
    from: 'this.streamGate!.policyChanged();', to: '// mutation: purge without revocation vector',
    killedBy: 'a late incoming acceptance cannot resurrect a purged cursor after regrant',
  },
  {
    name: 'purge-bypasses-lane', file: 'src/server.ts', test: 'test/forkLanes.test.ts',
    from: 'if (lane) lane.host(purge); else purge();', to: 'purge();',
    killedBy: 'revocation gates immediately but purge waits for the lane',
  },
  {
    name: 'polls-on-by-default', file: 'src/features.ts', test: 'test/optInDefaults.test.ts',
    from: "env.ZULIP_POLLS === '1'", to: "env.ZULIP_POLLS !== '0'",
    killedBy: 'default tools/list is byte-identical',
  },
];
let killed = 0;
for (const mutant of mutants) {
  const original = readFileSync(mutant.file, 'utf8');
  if (original.split(mutant.from).length !== 2) throw new Error(`mutation target not unique: ${mutant.name}`);
  let result;
  try {
    writeFileSync(mutant.file, original.replace(mutant.from, mutant.to));
    result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...(mutant.pattern ? ['--test-name-pattern', mutant.pattern] : []), mutant.test], { encoding: 'utf8', timeout: 30000 });
  } finally {
    writeFileSync(mutant.file, original);
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(join(evidence, `mutation-${mutant.name}.log`), output);
  if (result.error || result.signal || result.status === 0 || !output.split('\n').some(line => line.startsWith('not ok ') && line.includes(mutant.killedBy)) || !output.includes('ERR_ASSERTION')) {
    throw new Error(`mutation survived or failed for the wrong reason: ${mutant.name}`);
  }
  killed++;
  console.log(`KILLED ${mutant.name}: ${mutant.killedBy}`);
}
console.log(`${killed}/${mutants.length} mutations killed; source restored`);
