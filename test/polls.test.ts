/** Fixtures checked against offline Zulip 12.3 server sources; reconstructed from Zulip's poll widget format, NOT upstream
 * captures: widget_type/extra_data; vote {key,vote:1|-1}; question {question}; new_option {option,idx}.
 * Keys are canned,N or sender_id,idx. No network is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPollUpdate, boundedPollRead, parsePollSubmessage, PollCache, pollContent, reconstructPoll, POLL_LIMITS, pollDrops, PollLookups, type WidgetSubmessage } from '../src/polls.ts';
import { ZulipToolRuntime } from '../src/tool-runtime.ts';
import { ZulipAdapter, type FilterView } from '../src/platforms/zulip.ts';
import { MessageIds } from '../src/message-ids.ts';
import { normalizeMessage, type ZulipRawMessage } from '../src/history.ts';
import type { IncomingChannelMessage } from '@animalabs/mcpl-core';

function sub(id: number, content: unknown, sender_id = 7, message_id = 77): WidgetSubmessage {
  return { id, message_id, sender_id, msg_type: 'widget', content: JSON.stringify(content) };
}
const init = sub(1, { widget_type: 'poll', extra_data: { question: 'Ship?', options: ['Yes', 'Wait'] } }, 790);
const vote = (id: number, key = 'canned,0', yes = true, sender = 7) => sub(id, { type: 'vote', key, vote: yes ? 1 : -1 }, sender);
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

async function eventFixture(events: any[], message = raw(), filters?: FilterView, ids?: MessageIds, later: any[] = [], changes = true) {
  const incoming: IncomingChannelMessage[] = [];
  const registrations: any[] = [];
  let gets = 0, users = 0, reads = 0;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const client = {
    queues: { async register(p: any) { registrations.push(p); return { queue_id: 'q', last_event_id: -1 }; } },
    events: { async retrieve() {
      if (reads++ === 0) return { events };
      if (reads === 2 && later.length) {
        await new Promise(resolve => setImmediate(resolve));
        return { events: later };
      }
      await new Promise(resolve => setImmediate(resolve));
      adapter.stopEvents(); finish(); return { events: [] };
    } },
    messages: { async getById(p: any) { gets++; assert.equal(p.message_id, 77); return { result: 'success', message }; } },
    streams: { async retrieve() { return { streams: [{ stream_id: 12, name: 'general' }, { stream_id: 13, name: 'private' }] }; } },
    users: { async retrieve() { users++; return directory; } },
  };
  const adapter = new ZulipAdapter(client, 790, 'polls', { filters, messageIds: ids });
  adapter.startEvents(m => { incoming.push(m); }, undefined, undefined, changes ? () => {} : undefined);
  await done;
  return { incoming, gets, users, registrations };
}
const envelope = (s: WidgetSubmessage) => ({ ...s, id: s.id + 10, type: 'submessage', submessage_id: s.id });

test('live widget events emit vote/unvote text and metadata; bot polls addressed, unique ids, fresh GET per vote', async () => {
  const result = await eventFixture([
    { id: 0, type: 'message', message: raw() },
    envelope(added), envelope(vote(5, '42,0')), envelope(vote(6, '42,0', false)),
    envelope(sub(7, { type: 'vote', key: 'canned,1', vote: 1 }, 42)),
    envelope({ ...vote(8), msg_type: 'other' }),
  ], raw(), undefined, new MessageIds('acme', 'strict'));
  assert.equal(result.gets, 3);
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

test('known human UI polls remain ambient', async () => {
  const ui = raw({ content: '', sender_id: 42, submessages: [init, added, vote(5, '42,0')] });
  const result = await eventFixture([{ id: 0, type: 'message', message: ui }, envelope(vote(5, '42,0')), envelope(vote(6, '42,0', false))], ui);
  assert.equal(result.gets, 2);
  assert.equal(result.incoming.length, 3);
  assert.deepEqual(result.incoming[1].tags, ['zulip:poll-vote', 'chat:ambient']);
  assert.match((result.incoming[1].content[0] as any).text, /'Review first'/);
});

const evictionMessages = () => Array.from({ length: 2001 }, (_, i) => ({
  id: 100 + i, type: 'message', message: raw({ id: 1000 + i, submessages: [] }),
}));

test('unknown live initialization reduces data without GETs; its vote fetches a fresh route', async () => {
  const result = await eventFixture([envelope(init), envelope(added), envelope(vote(5, '42,0'))], raw({ sender_id: 42, submessages: [] }));
  assert.equal(result.gets, 1);
  assert.equal(result.incoming.length, 1);
  assert.deepEqual(result.incoming[0].tags, ['zulip:poll-vote', 'chat:ambient']);
});

test('a previously unknown poll vote reconstructs data and routes only from its fresh response', async () => {
  const result = await eventFixture([envelope(vote(2))], raw({ display_recipient: 'current', stream_id: 99, subject: 'Now' }));
  assert.equal(result.gets, 1);
  assert.equal(result.incoming.length, 1);
  assert.equal(result.incoming[0].channelId, 'zulip:current');
  assert.equal(result.incoming[0].threadId, 'Now');
});

test('stream and DM voter allowlists apply to poll events', async () => {
  const filters = { streamAllowed: () => false, dmAllowed: (u: { id: number }) => u.id === 42 };
  const events = [{ id: 0, type: 'message', message: raw() }, envelope(vote(2)), envelope(vote(3, 'canned,0', false))];
  assert.equal((await eventFixture(events, raw(), filters)).incoming.length, 0);
  const dm = raw({ type: 'private', display_recipient: [
    { id: 790, full_name: 'Bot', email: 'ship-bot@example.invalid' },
    { id: 7, full_name: 'Ann', email: 'ann@example.invalid' },
    { id: 42, full_name: 'Bo', email: 'bo@example.invalid' },
  ] });
  const result = await eventFixture([{ id: 0, type: 'message', message: dm }, ...events.slice(1), envelope(vote(4, 'canned,0', true, 42))], dm, filters);
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

test('501 IDs cycled four times share one budget independent of state eviction', async () => {
  let gets = 0;
  const cache = new PollCache(500);
  const lookups = new PollLookups(() => 0);
  const client = { messages: { async getById() { gets++; return { result: 'error' }; } } };
  const before = pollDrops.lookup_budget ?? 0;
  for (let cycle = 0; cycle < 4; cycle++) for (let id = 1; id <= 501; id++) {
    cache.entry(id);
    await lookups.fetch(client, id);
  }
  assert.equal(gets, POLL_LIMITS.lookups);
  assert.equal(pollDrops.lookup_budget, before + 2004 - POLL_LIMITS.lookups);
});

 test('100,000-option initialization and retained voters/text/polls are bounded', () => {
  const state = reconstructPoll([sub(1, { widget_type: 'poll', extra_data: {
    question: 'Q'.repeat(3000), options: Array(100000).fill('A') } })])!;
  assert.equal(state.options.size, POLL_LIMITS.options);
  assert.equal(state.question.length, POLL_LIMITS.text);
  for (let id = 1; id <= 2000; id++) applyPollUpdate(state, { type: 'vote', key: 'canned,0', voterId: id, action: 'vote' });
  assert.equal(state.options.get('canned,0')!.voters.size, POLL_LIMITS.voters);
  applyPollUpdate(state, { type: 'new_option', key: '7,0', text: 'huge'.repeat(10000) });
  assert.equal(state.options.size, POLL_LIMITS.options);
  const cache = new PollCache(2);
  const first = cache.entry(1); cache.entry(2); cache.entry(3);
  assert.notEqual(cache.entry(1), first);
  assert.ok(pollDrops.options_truncated && pollDrops.voter_limit && pollDrops.option_limit);
 });

 test('flat submessage envelope needs no nested field; numeric vote protocol only', async () => {
  assert.equal(parsePollSubmessage(sub(2, { type: 'vote', key: 'canned,0', vote: true })), null);
  const event = envelope(vote(2));
  assert.equal('submessage' in event, false);
  const result = await eventFixture([{ id: 0, type: 'message', message: raw() }, event]);
  assert.equal(result.incoming.length, 1);
  assert.equal(result.incoming[0].messageId, 'poll:77:2');
 });

for (const cached of [false, true]) test(`an unresolved ${cached ? 'placement' : 'poll'} lookup never delays the next ordinary message`, async () => {
  let release!: (value: unknown) => void;
  const read = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const incoming: IncomingChannelMessage[] = [];
  const client = {
    queues: { async register() { return { queue_id: 'q', last_event_id: -1 }; } },
    events: { async retrieve() {
      if (reads++ === 0) return { events: [...(cached ? [{ id: 0, type: 'message', message: raw() }, ...evictionMessages()] : []), envelope(vote(2)), { id: 99, type: 'message', message: raw({ id: 88, sender_id: 42, submessages: [] }) }] };
      adapter.stopEvents(); return { events: [] };
    } },
    messages: { getById() { return read; } },
    users: { async retrieve() { return directory; } },
  };
  const adapter = new ZulipAdapter(client, 790, 'nonblocking');
  try {
    const delivered = new Promise<void>(resolve => adapter.startEvents(m => { incoming.push(m); resolve(); }));
    await boundedPollRead(delivered, 100);
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0].messageId, '88');

  } finally { release({ result: 'error' }); adapter.stopEvents(); }
 });

test('every event gets a new lookup, including repeat failures; shared budget refills', async () => {
  let now = 0, gets = 0;
  const lookups = new PollLookups(() => now);
  const client = { messages: { async getById() { gets++; return { result: 'error' }; } } };
  for (let i = 0; i < 21; i++) await lookups.fetch(client, 77);
  assert.equal(gets, 20);
  now = 3000;
  await lookups.fetch(client, 77);
  assert.equal(gets, 21);
});

const emptyInit = sub(1, { widget_type: 'poll', extra_data: { question: '', options: [] } }, 790);
const question = (id: number, text: unknown) => sub(id, { type: 'question', question: text }, 790);

test('empty initialization then bounded question updates reconstruct current results', async t => {
  const before = pollDrops.text_truncated ?? 0;
  const state = reconstructPoll([question(3, 'Q'.repeat(3000)), emptyInit])!;
  assert.equal(state.question, 'Q'.repeat(POLL_LIMITS.text));
  assert.equal(pollDrops.text_truncated, before + 1);
  assert.equal(parsePollSubmessage(question(4, 123)), null);
  assert.equal(parsePollSubmessage(sub(4, { type: 'delete_option', key: 'canned,0' })), null,
    'not a Zulip 12.3 poll type; ignored rather than invented');
  const { tools } = toolsFixture(t, raw({ submessages: [emptyInit, question(2, 'Current?'), added, vote(5, '42,0')] }));
  const result = await tools.handleToolCall('get_poll_results', { message_id: 77 });
  assert.equal(result.question, 'Current?');
  assert.equal(result.options[0].count, 1);
});

test('live empty initialization then question updates change vote text and metadata', async () => {
  const result = await eventFixture([
    { id: 0, type: 'message', message: raw({ submessages: [emptyInit] }) },
    envelope(question(2, 'Current?')), envelope(added), envelope(vote(5, '42,0')),
    envelope(question(6, 'Revised?')), envelope(vote(7, '42,0', false)),
  ]);
  assert.equal(result.incoming.length, 2, 'question updates themselves do not notify');
  assert.equal(result.gets, 2, 'data-only question/option updates do not fetch routes');
  assert.match((result.incoming[0].content[0] as any).text, /'Current\?'/);
  assert.equal(result.incoming[1].metadata?.question, 'Revised?');
});

function routingFixture(getById: (...args: any[]) => Promise<any>, filters?: FilterView) {
  const adapter = new ZulipAdapter({ messages: { getById }, users: { async retrieve() { return directory; } } }, 790, 'race', { filters });
  const internal = adapter as any;
  internal.polls.remember(raw());
  internal.remember('zulip:general', normalizeMessage(raw()));
  const incoming: IncomingChannelMessage[] = [];
  const descriptors: any[] = [];
  return { adapter, internal, incoming, descriptors,
    vote: (id = 2, yes = true) => internal.onPollSubmessage(vote(id, 'canned,0', yes), (m: IncomingChannelMessage, d: any) => { incoming.push(m); descriptors.push(d); }) };
}
const moved = () => ({
  messageId: 77, source: { channelId: 'zulip:general', topic: 'Release' }, propagateMode: 'change_one' as const,
  newStreamId: 13, destinationChannelId: 'zulip:private', topic: 'Hidden',
});
const destination = () => raw({ stream_id: 13, display_recipient: 'private', subject: 'Hidden' });
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

for (const policy of ['allowed', 'muted', 'disallowed'] as const) {
  for (const probe of ['in-transit envelope then confirmed self move', 'stale GET', 'server move', 'eviction'] as const) {
    test(`pre-move vote, post-move GET: ${probe}, ${policy}; zero old-location deliveries`, async () => {
      const read = deferred();
      const stale = deferred();
      let gets = 0;
      const checked: string[] = [];
      const f = routingFixture(async (p: any) => {
        assert.equal(p.message_id, 77);
        gets++;
        return probe === 'stale GET' && gets === 1 ? stale.promise : read.promise;
      }, {
        streamAllowed: name => { checked.push(name); return policy !== 'disallowed' || name !== 'private'; },
        streamMuted: name => policy === 'muted' && name === 'private', dmAllowed: () => true,
      });
      let oldRead: Promise<any> | undefined;
      if (probe === 'stale GET') {
        f.internal.seen.clear();
        oldRead = f.internal.locate(77);
      }
      const reason = policy === 'muted' ? 'stream_muted' : 'stream_disallowed';
      const before = pollDrops[reason] ?? 0;
      const pending = f.vote(); // Arrives BEFORE the move; GET remains pending.
      await settle();
      assert.equal(gets, probe === 'stale GET' ? 2 : 1);
      assert.deepEqual(f.incoming, []);
      if (probe === 'server move') {
        f.internal.streamNamesById.set(12, 'general');
        f.internal.streamNamesById.set(13, 'private');
        await f.internal.onZulipChange({
          kind: 'edit', messageId: 77, messageIds: [77], actorId: 42, editedAt: 1700000010,
          streamId: 12, newStreamId: 13, origTopic: 'Release', topic: 'Hidden',
          propagateMode: 'change_one', content: null, origContent: null, flags: [],
        }, () => {});
      } else {
        f.adapter.noteSelfMoved(moved());
        if (probe === 'in-transit envelope then confirmed self move') {
          // An old envelope can arrive on either side of the tool receipt.
          f.internal.polls.remember(raw());
          f.internal.remember('zulip:general', normalizeMessage(raw()));
          f.adapter.noteSelfMoved(moved());
        }
      }
      if (probe === 'eviction') {
        for (let id = 1000; id < 3500; id++) {
          f.internal.polls.entry(id);
          f.internal.remember('zulip:general', normalizeMessage(raw({ id, submessages: [] })));
        }
      }
      checked.length = 0; // Ignore the ordinary move handler's own policy checks.
      // Response reflects the server's new placement, even though the vote
      // and its request started in the old location.
      read.resolve({ result: 'success', message: destination() });
      await pending;
      if (oldRead) {
        stale.resolve({ result: 'success', message: raw() });
        await oldRead; // Stale ordinary GET may not decide this or later votes.
      }
      await f.vote(3, false);
      assert.equal(f.incoming.filter(m => m.channelId === 'zulip:general' || m.threadId === 'Release').length, 0);
      assert.equal(f.incoming.length, policy === 'allowed' ? 2 : 0);
      if (policy === 'allowed') for (const m of f.incoming) {
        assert.equal(m.channelId, 'zulip:private');
        assert.equal(m.threadId, 'Hidden');
        assert.equal(m.metadata?.topic, 'Hidden');
      }
      else assert.equal(pollDrops[reason], before + 2);
      assert.ok(checked.every(name => name === 'private'), 'only fresh GET destination is policy checked');
      assert.equal(f.descriptors[0]?.address.stream_id, policy === 'allowed' ? 13 : undefined);
    });
  }
}

test('fresh GET alone decides DM participants, ownership and stream ID despite stale cache', async () => {
  const dm = raw({ type: 'private', sender_id: 42, display_recipient: [
    { id: 790, full_name: 'Bot', email: 'bot@example.invalid' },
    { id: 42, full_name: 'Bo', email: 'bo@example.invalid' },
  ] });
  let fresh = dm, gets = 0;
  const f = routingFixture(async () => { gets++; return { result: 'success', message: fresh }; });
  await f.vote();
  assert.equal(f.incoming[0].channelId, 'zulip:dm:42');
  assert.deepEqual(f.incoming[0].tags, ['zulip:poll-vote', 'chat:ambient']);
  assert.equal(f.incoming[0].metadata?.onOwnMessage, false);
  fresh = destination();
  await f.vote(3, false);
  assert.equal(gets, 2);
  assert.equal(f.incoming[1].channelId, 'zulip:private');
  assert.deepEqual(f.incoming[1].tags, ['zulip:poll-vote', 'chat:addressed']);
  assert.equal(f.descriptors[1].address.stream_id, 13);
});

test('even a known, allowed poll drops failed, invisible, malformed and timed-out fresh GETs', async () => {
  for (const [reason, get] of [
    ['lookup_failed', async () => { throw new Error('offline'); }],
    ['message_unavailable', async () => ({ result: 'error', msg: 'not visible' })],
    ['message_unavailable', async () => ({ result: 'success' })],
    ['invalid_message', async () => ({ result: 'success', message: raw({ id: 88 }) })],
    ['invalid_message', async () => ({ result: 'success', message: raw({ type: 'private', display_recipient: [] }) })],
    ['lookup_timeout', () => new Promise(() => {})],
  ] as const) {
    const before = pollDrops[reason] ?? 0;
    const f = routingFixture(get);
    f.internal.pollLookups = new PollLookups(() => 0, 5);
    await f.vote();
    assert.deepEqual(f.incoming, []);
    assert.equal(pollDrops[reason], before + 1);
    assert.ok(f.internal.polls.entry(77).state.options.get('canned,0').voters.has(7), 'failed delivery does not erase reduction');
  }
});

test('timeout never releases an outstanding GET slot; late results never deliver', async () => {
  let now = 0, gets = 0;
  const read = deferred();
  const f = routingFixture(() => { gets++; return read.promise; });
  f.internal.pollLookups = new PollLookups(() => now, 5);
  const before = pollDrops.lookup_timeout ?? 0;
  await Promise.all(Array.from({ length: 20 }, (_, i) => f.vote(i + 2)));
  assert.equal(gets, 20);
  assert.equal(pollDrops.lookup_timeout, before + 20);
  now = 60000; // Tokens refill, but actual unresolved requests still cap concurrency.
  const capBefore = pollDrops.lookup_in_flight ?? 0;
  await f.vote(30);
  assert.equal(gets, 20);
  assert.equal(pollDrops.lookup_in_flight, capBefore + 1);
  read.resolve({ result: 'success', message: raw() });
  await settle();
  assert.deepEqual(f.incoming, []);
  await f.vote(31);
  assert.equal(gets, 21);
  assert.equal(f.incoming.length, 1);
});

test('exhausted adapter-wide budget drops even a known poll; get_poll_results still shows votes', async t => {
  let gets = 0;
  const f = routingFixture(async () => { gets++; return { result: 'success', message: raw() }; });
  f.internal.pollLookups = new PollLookups(() => 0);
  for (let id = 2; id < 22; id++) await f.vote(id);
  const before = pollDrops.lookup_budget ?? 0;
  await f.vote(22);
  assert.equal(gets, 20);
  assert.equal(f.incoming.length, 20);
  assert.equal(pollDrops.lookup_budget, before + 1);
  const { tools } = toolsFixture(t, raw({ submessages: [init, vote(22)] }));
  const result = await tools.handleToolCall('get_poll_results', { message_id: 77 });
  assert.equal(result.options[0].count, 1);
  assert.equal(result.options[0].voters[0].id, 7);
});

test('data cache retains no placement or message envelope and stays bounded', () => {
  const cache = new PollCache(1);
  cache.remember(raw());
  assert.deepEqual(Object.keys(cache.entry(77)), ['state']);
  const first = cache.entry(77);
  cache.remember(raw({ id: 88, submessages: [] }));
  assert.equal(cache.entry(77), first, 'ordinary messages do not evict polls');
  cache.remember(raw({ id: 88 }));
  assert.notEqual(cache.entry(77), first);
});
