/** Fixtures reconstructed from Zulip's poll widget format, NOT upstream
 * captures: widget_type/extra_data; vote {key,vote}; new_option {option,idx}.
 * Keys are canned,N or sender_id,idx. No network is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPollUpdate, boundedPollRead, parsePollSubmessage, PollCache, pollContent, reconstructPoll, type WidgetSubmessage } from '../src/polls.ts';
import { ZulipToolRuntime } from '../src/tool-runtime.ts';
import { ZulipAdapter, type FilterView } from '../src/platforms/zulip.ts';
import { MessageIds } from '../src/message-ids.ts';
import type { ZulipRawMessage } from '../src/history.ts';
import type { IncomingChannelMessage } from '@animalabs/mcpl-core';

function sub(id: number, content: unknown, sender_id = 7, message_id = 77): WidgetSubmessage {
  return { id, message_id, sender_id, msg_type: 'widget', content: JSON.stringify(content) };
}
const init = sub(1, { widget_type: 'poll', extra_data: { question: 'Ship?', options: ['Yes', 'Wait'] } }, 790);
const vote = (id: number, key = 'canned,0', yes = true, sender = 7) => sub(id, { type: 'vote', key, vote: yes }, sender);
const added = sub(4, { type: 'new_option', option: 'Review first', idx: 0 }, 42);
const raw = (over: Partial<ZulipRawMessage> = {}): ZulipRawMessage => ({
  id: 77, sender_id: 790, sender_full_name: 'Bot', sender_email: 'ship-bot@example.invalid',
  type: 'stream', display_recipient: 'general', stream_id: 12, subject: 'Release',
  content: '/poll Ship?\nYes\nWait', timestamp: 1700000000, submessages: [init], ...over,
});
const directory = { result: 'success', members: [
  { user_id: 7, full_name: 'Ann', email: 'ann@example.invalid' },
  { user_id: 42, full_name: 'Bo', email: 'bo@example.invalid' },
] };

test('poll widget reducer resolves canned and sender keys, votes, unvotes, new options and duplicate votes', () => {
  const state = reconstructPoll([vote(7, '42,0'), vote(3, 'canned,0', false), init, added, vote(2), vote(5, '42,0'), vote(6, '42,0', true, 42)])!;
  assert.equal(state.question, 'Ship?');
  assert.deepEqual([...state.options.values()].map(o => [o.key, o.text, [...o.voters]]), [
    ['canned,0', 'Yes', []], ['canned,1', 'Wait', []], ['42,0', 'Review first', [7, 42]],
  ]);
  applyPollUpdate(state, parsePollSubmessage(init));
  assert.equal(state.options.get('42,0')!.voters.size, 2, 'initialization replay cannot clear votes');
  assert.equal(parsePollSubmessage(vote(8, 'canned,0', false))?.type, 'vote');
});

test('non-poll widgets, malformed JSON, invalid vote keys/types and absent initialization are ignored', () => {
  for (const s of [
    { ...init, msg_type: 'other' }, { ...init, content: '{' }, sub(2, null),
    sub(2, { widget_type: 'other', extra_data: { question: 'Q', options: ['A'] } }),
    sub(2, { type: 'vote', key: 'canned,0', vote: 'false' }), vote(2, '__proto__'),
    sub(2, { type: 'new_option', option: 'X', idx: -1 }), { ...vote(2), sender_id: 0 },
  ]) assert.equal(parsePollSubmessage(s), null);
  assert.equal(reconstructPoll([vote(1)]), null);
  const state = reconstructPoll([init, vote(2, 'canned,99')])!;
  assert.equal(state.options.size, 2, 'a missing key never becomes executable or an invented option');
});

test('poll reads have a timeout and negative lookups are fetched once with bounded retention', async () => {
  await assert.rejects(boundedPollRead(new Promise(() => {}), 5), /timed out/);
  let gets = 0;
  const cache = new PollCache(2);
  const client = { messages: { async getById() { gets++; throw new Error('unavailable'); } } };
  await cache.locate(client, 1); await cache.locate(client, 1);
  assert.equal(gets, 1);
  await cache.locate(client, 2); await cache.locate(client, 3);
  await cache.locate(client, 1);
  assert.equal(gets, 4, 'old negative entries evict at the cap');
});

async function eventFixture(events: any[], message = raw(), filters?: FilterView, ids?: MessageIds) {
  const incoming: IncomingChannelMessage[] = [];
  const registrations: any[] = [];
  let gets = 0, users = 0, reads = 0;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const client = {
    queues: { async register(p: any) { registrations.push(p); return { queue_id: 'q', last_event_id: -1 }; } },
    events: { async retrieve() {
      if (reads++ === 0) return { events };
      adapter.stopEvents(); finish(); return { events: [] };
    } },
    messages: { async getById(p: any) { gets++; assert.equal(p.message_id, 77); return { result: 'success', message }; } },
    users: { async retrieve() { users++; return directory; } },
  };
  const adapter = new ZulipAdapter(client, 790, 'polls', { filters, messageIds: ids });
  adapter.startEvents(m => { incoming.push(m); }, undefined, undefined, () => {});
  await done;
  return { incoming, gets, users, registrations };
}
const envelope = (s: WidgetSubmessage) => ({ id: s.id + 10, type: 'submessage', submessage: s });

test('live widget events emit vote/unvote text and metadata; bot polls addressed, unique ids, no extra GET', async () => {
  const result = await eventFixture([
    { id: 0, type: 'message', message: raw() },
    envelope(added), envelope(vote(5, '42,0')), envelope(vote(6, '42,0', false)),
    envelope(sub(7, { type: 'vote', key: 'canned,1', vote: true }, 42)),
    envelope({ ...vote(8), msg_type: 'other' }),
  ], raw(), undefined, new MessageIds('acme', 'strict'));
  assert.equal(result.gets, 0);
  assert.equal(result.users, 1);
  assert.ok(result.registrations[0].event_types.includes('submessage'));
  assert.equal(result.incoming.length, 3, 'no init/new_option/other-widget messages');
  const first = result.incoming[0];
  assert.equal(first.channelId, 'zulip:general'); assert.equal(first.threadId, 'Release');
  assert.equal(first.content[0].type, 'text');
  assert.equal((first.content[0] as any).text, "[poll vote] Ann (user 7) voted 'Review first' on poll acme:77 'Ship?'");
  assert.deepEqual(first.tags, ['zulip:poll-vote', 'chat:addressed']);
  assert.deepEqual(first.metadata, { pollVote: true, pollMessageId: 77, optionKey: '42,0', optionText: 'Review first', voterId: 7,
    action: 'vote', question: 'Ship?', onOwnMessage: true, topic: 'Release', isDM: false, senderEmail: 'ann@example.invalid' });
  assert.match((result.incoming[1].content[0] as any).text, /unvoted 'Review first'/);
  assert.equal((result.incoming[1].metadata as any).action, 'unvote');
  assert.equal(new Set(result.incoming.map(m => m.messageId)).size, 3);
  assert.ok(result.incoming.every(m => !Number.isFinite(Number(m.messageId))), 'not history cursors');
});

test('unknown human UI polls fetch once with submessages and remain ambient', async () => {
  const ui = raw({ content: '', sender_id: 42, submessages: [init, added, vote(5, '42,0')] });
  const result = await eventFixture([envelope(vote(5, '42,0')), envelope(vote(6, '42,0', false))], ui);
  assert.equal(result.gets, 1);
  assert.equal(result.incoming.length, 2);
  assert.deepEqual(result.incoming[0].tags, ['zulip:poll-vote', 'chat:ambient']);
  assert.match((result.incoming[0].content[0] as any).text, /'Review first'/);
});

test('a poll vote waits for an earlier topic move and follows the current topic', async () => {
  const result = await eventFixture([
    { id: 0, type: 'message', message: raw() },
    { id: 1, type: 'update_message', message_id: 77, user_id: 42, stream_id: 12,
      orig_subject: 'Release', subject: 'Decision', edit_timestamp: 1700000010 },
    envelope(vote(2)),
  ]);
  assert.equal(result.gets, 0);
  assert.equal(result.incoming.length, 1);
  assert.equal(result.incoming[0].threadId, 'Decision');
  assert.equal((result.incoming[0].metadata as any).topic, 'Decision');
});

test('initial widget submessages arriving live also initialize human UI polls', async () => {
  const result = await eventFixture([envelope(init), envelope(added), envelope(vote(5, '42,0'))], raw({ sender_id: 42, submessages: [] }));
  assert.equal(result.gets, 1);
  assert.equal(result.incoming.length, 1);
  assert.match((result.incoming[0].content[0] as any).text, /Review first/);
  assert.deepEqual(result.incoming[0].tags, ['zulip:poll-vote', 'chat:ambient']);
});

test('stream and DM voter allowlists apply to poll events', async () => {
  const filters = { streamAllowed: () => false, dmAllowed: (u: { id: number }) => u.id === 42 };
  const events = [envelope(vote(2)), envelope(vote(3, 'canned,0', false))];
  assert.equal((await eventFixture(events, raw(), filters)).incoming.length, 0);
  const dm = raw({ type: 'private', display_recipient: [
    { id: 790, full_name: 'Bot', email: 'ship-bot@example.invalid' },
    { id: 7, full_name: 'Ann', email: 'ann@example.invalid' },
    { id: 42, full_name: 'Bo', email: 'bo@example.invalid' },
  ] });
  const result = await eventFixture([...events, envelope(vote(4, 'canned,0', true, 42))], dm, filters);
  assert.equal(result.incoming.length, 1);
  assert.equal(result.incoming[0].channelId, 'zulip:dm:7+42');
  assert.equal(result.incoming[0].author.name, 'Bo');
});

function toolsFixture(t: any, message = raw(), ids?: MessageIds) {
  const dir = mkdtempSync(join(tmpdir(), 'zulip-polls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sends: any[] = [], gets: any[] = [], sent: any[] = [];
  const client = {
    messages: {
      async send(p: any) { sends.push(p); return { result: 'success', id: 501 }; },
      async getById(p: any) { gets.push(p); return { result: 'success', message }; },
    }, users: { async retrieve() { return directory; } },
  };
  const tools = new ZulipToolRuntime({ client, realm: 'https://example.invalid', authHeader: '', selfUserId: 790, sessionId: 'polls' }, dir, { messageIds: ids });
  tools.onSent = s => sent.push(s);
  return { tools, sends, gets, sent };
}

test('send_poll validation is side-effect free and emits exact Zulip syntax, including literal options', async t => {
  const { tools, sends, gets, sent } = toolsFixture(t);
  const base = { type: 'stream', to: 'general', topic: 'Release', question: 'Ship?', options: ['Yes', 'Wait'] };
  for (const options of [[], ['one'], ['Yes', ''], ['Yes', '  '], ['Yes', 'a\nb'], ['Yes', 'a\rb'], ['Yes', 2], null]) {
    await assert.rejects(tools.handleToolCall('send_poll', { ...base, options }), /options/);
  }
  for (const question of ['', ' ', 'Q\nx', null]) {
    await assert.rejects(tools.handleToolCall('send_poll', { ...base, question }), /question/);
  }
  await assert.rejects(tools.handleToolCall('send_poll', { ...base, topic: null }), /topic/);
  await assert.rejects(tools.handleToolCall('send_poll', { ...base, options: ['A', 'x'.repeat(10000)] }), /cannot be split/);
  assert.deepEqual(sends, []); assert.deepEqual(gets, []);
  const result = await tools.handleToolCall('send_poll', { ...base, options: ['Yes', '[[msg:42]]'] });
  assert.deepEqual(sends, [{ type: 'stream', to: 'general', topic: 'Release', content: '/poll Ship?\nYes\n[[msg:42]]' }]);
  assert.deepEqual(result, { result: 'success', id: 501, type: 'stream', channelId: 'zulip:general', stream: 'general', topic: 'Release' });
  assert.equal(sent.length, 1, 'rollback records the poll send');
  assert.equal(pollContent('Q', ['A', 'B']), '/poll Q\nA\nB');
});

test('send_poll supports reply topic overrides and strict realm IDs', async t => {
  const { tools, sends } = toolsFixture(t, raw(), new MessageIds('acme', 'strict'));
  const result = await tools.handleToolCall('send_poll', { reply_to: 'acme:77', topic: 'Decision', question: 'Ship?', options: ['Yes', 'Wait'] });
  assert.equal(result.id, 'acme:501');
  assert.equal(result.channelId, 'zulip:general'); assert.equal(result.topic, 'Decision');
  assert.deepEqual(sends, [{ type: 'stream', to: 12, topic: 'Decision', content: '/poll Ship?\nYes\nWait' }]);
  await assert.rejects(tools.handleToolCall('send_poll', { reply_to: 'else:77', question: 'Q', options: ['A', 'B'] }), /differs/);
});

test('send_poll supports DM destinations and full DM reply participants', async t => {
  const { tools, sends } = toolsFixture(t, raw({ type: 'private', display_recipient: [
    { id: 790, full_name: 'Bot', email: 'bot@example.invalid' }, { id: 7, full_name: 'Ann', email: 'ann@example.invalid' },
  ] }));
  const args = { question: 'Q', options: ['A', 'B'] };
  const dm = await tools.handleToolCall('send_poll', { ...args, type: 'private', to: 'ann@example.invalid', topic: null, reply_to: 0 });
  assert.deepEqual(dm.recipients, ['ann@example.invalid']);
  const reply = await tools.handleToolCall('send_poll', { ...args, reply_to: 77 });
  assert.equal(reply.channelId, 'zulip:dm:7'); assert.deepEqual(reply.recipients, [790, 7]);
  assert.deepEqual(sends[1], { type: 'private', to: [790, 7], topic: undefined, content: '/poll Q\nA\nB' });
  await assert.rejects(tools.handleToolCall('send_poll', { ...args, reply_to: 77, topic: 'bad' }), /private reply_to/);
});

test('get_poll_results reconstructs live counts, ids and names and tags only message ids', async t => {
  const { tools, sends, gets } = toolsFixture(t, raw({ submessages: [init, vote(2), vote(3, 'canned,0', false), added,
    vote(5, '42,0'), vote(6, '42,0', true, 42), vote(7, '42,0', true, 99)] }), new MessageIds('acme', 'strict'));
  const result = await tools.handleToolCall('get_poll_results', { message_id: 'acme:77' });
  assert.deepEqual(result, { message_id: 'acme:77', question: 'Ship?', options: [
    { key: 'canned,0', text: 'Yes', count: 0, voters: [] }, { key: 'canned,1', text: 'Wait', count: 0, voters: [] },
    { key: '42,0', text: 'Review first', count: 3, voters: [{ id: 7, name: 'Ann' }, { id: 42, name: 'Bo' }, { id: 99, name: 'user 99' }] },
  ] });
  assert.equal(gets.length, 1); assert.deepEqual(sends, []);
  await assert.rejects(tools.handleToolCall('get_poll_results', { message_id: 77 }), /bare message_id/);
});

test('get_poll_results rejects non-polls and invalid legacy ids', async t => {
  const { tools, gets } = toolsFixture(t, raw({ submessages: [] }));
  await assert.rejects(tools.handleToolCall('get_poll_results', { message_id: 77 }), /no supported poll/);
  await assert.rejects(tools.handleToolCall('get_poll_results', { message_id: 0 }), /positive safe integer/);
  assert.equal(gets.length, 1);
});
