import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconstructPoll, resolvePollOption, POLL_LIMITS } from '../src/polls.ts';
import { ZulipToolRuntime } from '../src/tool-runtime.ts';
import { ZulipAdapter } from '../src/platforms/zulip.ts';
import { MessageIds } from '../src/message-ids.ts';
import { StreamDirectory } from '../src/stream-directory.ts';
import { standInApi } from './zulip-stand-in.ts';

const sub = (id: number, value: unknown, sender_id = 7) => ({ id, message_id: 77, sender_id, msg_type: 'widget', content: JSON.stringify(value) });
const init = sub(1, { widget_type: 'poll', extra_data: { question: 'Ready?', options: ['Yes', 'Wait'] } });
const vote = (id: number, yes = true, sender = 7) => sub(id, { type: 'vote', key: 'canned,0', vote: yes ? 1 : -1 }, sender);
const raw = (extra = {}) => ({ id: 77, sender_id: 1, sender_full_name: 'Test Bot', sender_email: 'bot@example.invalid', type: 'stream', display_recipient: 'general', stream_id: 12, subject: 'topic', content: '/poll Ready?\nYes\nWait', timestamp: 1700000000, submessages: [init], ...extra });
function fixture(t: any, extra = {}) {
  let message = raw(extra);
  const { api, calls } = standInApi({
    'GET /messages/:id': () => ({ result: 'success', message }),
    'GET /users': { result: 'success', members: [] },
    'POST /messages': { result: 'success', id: 78 },
    'POST /submessage': (p: any) => { message.submessages.push(sub(message.submessages.length + 1, JSON.parse(p.content), 1)); return { result: 'success' }; },
  });
  const dir = mkdtempSync(join(tmpdir(), 'poll-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tools = new ZulipToolRuntime({ api, selfUserId: 1, realm: 'https://alpha.example.invalid', authHeader: '', sessionId: 'test' }, dir, { messageIds: new MessageIds('alpha', 'strict') });
  const directory = new StreamDirectory(); directory.list([{ stream_id: 12, name: 'general' }, { stream_id: 13, name: 'other' }]);
  const adapter = new ZulipAdapter(api, 1, 'test', { directory });
  return { tools, adapter, calls, setMessage: (m: any) => { message = m; }, message };
}

test('poll reducer orders widget submessages, includes added options, and isolates voter focus', () => {
  const added = sub(3, { type: 'new_option', idx: 0, option: 'Review' }, 8);
  const state = reconstructPoll([vote(4), added, init, vote(2), vote(5, false)])!;
  assert.equal(state.options.get('canned,0')!.voters.size, 0);
  assert.equal(state.options.get('8,0')!.text, 'Review');
  assert.equal(resolvePollOption(state, 'Review').key, '8,0');
  assert.throws(() => resolvePollOption(state, 'missing'), /unknown/);
  assert.equal(reconstructPoll([sub(1, { widget_type: 'other' })]), null);
  const collision = reconstructPoll([sub(1, { widget_type: 'poll', extra_data: { question: 'Q', options: ['canned,1', 'Yes'] } })])!;
  assert.throws(() => resolvePollOption(collision, 'canned,1'), /ambiguous/);
  const votes = Array.from({ length: POLL_LIMITS.voters + 1 }, (_, i) => vote(i + 2, true, i + 1));
  assert.ok(reconstructPoll([init, ...votes], POLL_LIMITS.voters + 1)!.options.get('canned,0')!.voters.has(POLL_LIMITS.voters + 1));
});

test('send_poll posts one exact unsplit poll and validates before requests', async t => {
  const f = fixture(t);
  const content = '/poll [[msg:literal]]?\nA | B\nWait';
  const result = await f.tools.handleToolCall('send_poll', { type: 'stream', to: 'general', topic: 'topic', question: '[[msg:literal]]?', options: ['A | B', 'Wait'] });
  assert.equal(result.id, 'alpha:78');
  assert.equal(f.calls.filter(c => c.method === 'POST')[0].params.content, content);
  f.calls.length = 0;
  for (const options of [[], ['one'], ['one\ntwo', 'three']]) await assert.rejects(f.tools.handleToolCall('send_poll', { question: 'Q', options }));
  await assert.rejects(f.tools.handleToolCall('send_poll', { question: 'x'.repeat(10001), options: ['A', 'B'] }), /cannot be split/);
  assert.equal(f.calls.length, 0);
});

test('results and idempotent/toggle voting always read fresh and keep API IDs numeric', async t => {
  const f = fixture(t);
  const call = (vote?: boolean) => f.tools.handleToolCall('vote_poll', { message_id: 'alpha:77', option: 'Yes', ...(vote === undefined ? {} : { vote }) });
  assert.equal((await call(true)).vote, true);
  assert.equal((await call(true)).vote, true);
  assert.equal((await call()).vote, false);
  assert.equal(f.calls.filter(c => c.path === '/messages/77').length, 3);
  assert.deepEqual(f.calls.filter(c => c.path === '/submessage').map(c => JSON.parse(c.params.content as string).vote), [1, -1]);
  assert.ok(f.calls.filter(c => c.path === '/submessage').every(c => c.params.message_id === 77));
  const result = await f.tools.handleToolCall('get_poll_results', { message_id: 'alpha:77' });
  assert.equal(result.message_id, 'alpha:77');
  assert.equal(result.options[0].count, 0);
  const writes = f.calls.filter(c => c.method === 'POST').length;
  await assert.rejects(f.tools.handleToolCall('vote_poll', { message_id: 'alpha:77', option: 'missing' }), /unknown/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, writes);
  await assert.rejects(f.tools.handleToolCall('vote_poll', { message_id: 'beta:77', option: 'Yes' }), /differs/);
});

test('each vote notification uses its own fresh placement, even for a cached poll after a move', async t => {
  const f = fixture(t);
  const events: any[] = [];
  await (f.adapter as any).onPollSubmessage(vote(2), (m: any) => events.push(m));
  f.setMessage(raw({ stream_id: 13, display_recipient: 'other', subject: 'moved', sender_id: 9 }));
  await (f.adapter as any).onPollSubmessage(vote(3), (m: any) => events.push(m));
  assert.equal(f.calls.filter(c => c.path === '/messages/77').length, 2);
  assert.deepEqual(events.map(m => m.key), ['s:12', 's:13']);
  assert.ok(events[0].tags.includes('chat:addressed'));
  assert.ok(events[1].tags.includes('chat:ambient'));
  assert.equal(events[1].threadId, 'moved');
  assert.equal(events[0].messageId, 'poll:77:2');
  f.setMessage(raw({ submessages: [] }));
  await (f.adapter as any).onPollSubmessage(vote(4), (m: any) => events.push(m));
  assert.equal(events.length, 2, 'no stale reducer or route on unreadable/unsupported widget');
});

test('poll voting respects stream/DM visibility and muted streams', async t => {
  const f = fixture(t);
  f.tools.setPollVoteFilters({ streamAllowed: () => false, streamMuted: () => false, dmAllowed: () => false });
  await assert.rejects(f.tools.handleToolCall('vote_poll', { message_id: 'alpha:77', option: 'Yes' }), /not visible/);
  f.setMessage(raw({ type: 'private', display_recipient: [{ id: 1 }, { id: 7 }] }));
  await assert.rejects(f.tools.handleToolCall('vote_poll', { message_id: 'alpha:77', option: 'Yes' }), /DM read policy/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});
