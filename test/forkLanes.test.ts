import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { method } from '@animalabs/mcpl-core';
import { ZulipAdapter } from '../src/platforms/zulip.ts';
import { ZulipEventLoop } from '../src/platforms/zulip-events.ts';
import { ZulipMcplServer } from '../src/server.ts';
import { ZulipToolRuntime } from '../src/tool-runtime.ts';
import { FiltersPlane } from '../src/filters.ts';
import { StreamDirectory } from '../src/stream-directory.ts';
import { streamKey } from '../src/channel-key.ts';
import { MessageIds } from '../src/message-ids.ts';
import { standInApi } from './zulip-stand-in.ts';

const turn = () => new Promise<void>(r => setImmediate(r));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(r => { resolve = r; }), resolve: (v: T) => resolve(v) };
};
const streams = [{ stream_id: 12, name: 'general' }, { stream_id: 13, name: 'other' }];
const init = { id: 1, sender_id: 1, msg_type: 'widget', content: JSON.stringify({ widget_type: 'poll', extra_data: { question: 'Ready?', options: ['Yes', 'Wait'] } }) };
const vote = (id = 2) => ({ id, message_id: 77, sender_id: 9, msg_type: 'widget', content: JSON.stringify({ type: 'vote', key: 'canned,0', vote: 1 }) });
const raw = (id = 77, stream_id = 12, extra = {}) => ({ id, stream_id, type: 'stream', display_recipient: stream_id === 12 ? 'general' : 'other', subject: 'topic', content: 'hello', sender_id: 1, sender_full_name: 'Bot', sender_email: 'bot@example.invalid', timestamp: 1700000000, submessages: [init], ...extra });

/** Real adapter entries, server routing and ChannelManager batching; only the
 * event transport and the accepting host are stand-ins. No alternate lane. */
async function fixture(t: any, { scoped = false, open = true, active = false, preconnected = false, maxWaitingMessages = 5000 } = {}) {
  for (const [key, value] of Object.entries({ ZULIP_POLLS: '1', ZULIP_ACTIVE_TOPICS: active ? '1' : '0' })) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  const dir = mkdtempSync(join(tmpdir(), 'fork-lanes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let current = raw();
  let get: (() => Promise<any>) | undefined;
  let hooks: any[] = [];
  t.mock.method(ZulipEventLoop.prototype, 'start', async function (...args: any[]) { hooks = args; });
  const { api, calls } = standInApi({
    'GET /users/me/subscriptions': { result: 'success', subscriptions: streams },
    'GET /streams': { result: 'success', streams },
    'GET /messages': { result: 'success', messages: [], found_newest: true },
    'GET /messages/:id': () => get ? get() : { result: 'success', message: current },
    'GET /users': { result: 'success', members: [] },
    'GET /get_stream_id': (p: any) => ({ result: 'success', stream_id: p.stream === 'general' ? 12 : 13 }),
    'GET /users/me/:id/topics': { result: 'success', topics: [{ name: 'topic', max_id: 77 }] },
    'PATCH /messages/:id': (p: any) => { current = { ...current, subject: p.topic ?? current.subject, stream_id: p.stream_id ?? current.stream_id }; return { result: 'success' }; },
  });
  const filters = new FiltersPlane(join(dir, 'filters.json'), scoped ? { ZULIP_STREAMS_MODE: 'subscribed' } : {});
  t.after(() => filters.subscriptions.stop());
  const directory = new StreamDirectory(); directory.list(streams);
  const ids = new MessageIds('alpha', 'strict');
  const adapter = new ZulipAdapter(api, 1, 'test', { directory, filters, messageIds: ids });
  const tools = new ZulipToolRuntime({ api, selfUserId: 1, sessionId: 'test', realm: 'https://alpha.example.invalid', authHeader: '' }, dir, { messageIds: ids });
  if (scoped && preconnected) await filters.subscriptions.connect(api, 1);
  const server = new ZulipMcplServer(adapter, tools, { serverInfo: { name: 'test', version: '1' }, directory, filters, messageIds: ids, stateDir: null, batchWindowMs: 100000, maxWaitingMessages });
  if (scoped && !preconnected) await filters.subscriptions.connect(api, 1);
  server.grant.apply({ effectiveCapabilities: ['tools', 'pushEvents', 'channels.*', 'contextHooks.beforeInference.inject.*'] });
  const incoming: any[] = [], pushed: any[] = [];
  let answerIncoming: (() => Promise<any>) | undefined;
  const conn = { isClosed: false, sendRequest: async (name: string, params: any) => {
    if (name === method.CHANNELS_INCOMING) {
      incoming.push(...params.messages);
      return answerIncoming ? answerIncoming() : { results: params.messages.map((m: any) => ({ messageId: m.messageId, accepted: true })) };
    }
    if (name === method.PUSH_EVENT) { pushed.push(params); return { accepted: true }; }
    return { results: (params.channels ?? params.added ?? []).map((c: any) => ({ id: c.id, accepted: true })) };
  } };
  Object.assign(server, { conn, mcplActive: true, lanes: (server as any).makeLanes() });
  await server.channelManager.registerChannels();
  if (open) for (const s of streams) server.channelManager.markOpen(`zulip:${s.name}`);
  (server as any).startEvents();
  t.after(async () => { await server.shutdown(); });
  const lanes = (server as any).lanes;
  const gate = (server as any).streamGate;
  const epoch = () => gate?.checkpoint();
  const message = (id: number, stream = 12) => hooks[1](null, { ...raw(id, stream, { sender_id: 9, sender_full_name: 'Human' }), ...(scoped ? { readEpoch: epoch() } : {}) }, []);
  // Seed only placement, as an own poll's initial message does in production.
  hooks[1](null, raw(), []);
  await lanes.quiet();
  const poll = (id = 2) => hooks[5]({ ...vote(id), ...(scoped ? { readEpoch: epoch() } : {}) });
  return { server, adapter, tools, filters, calls, incoming, pushed, lanes, gate, message, poll, hooks,
    set: (m: any) => { current = m; }, get: (fn?: () => Promise<any>) => { get = fn; },
    answerIncoming: (fn: () => Promise<any>) => { answerIncoming = fn; },
    flush: async () => { await lanes.quiet(); await server.channelManager.flush(); await lanes.quiet(); },
  };
}

test('a poll vote waits behind its channel read, not another channel; no eager fresh GET or delivery', async t => {
  const f = await fixture(t);
  const held = deferred<void>(); let reading = false;
  f.lanes.lane(streamKey(12)).enterRead(async () => { reading = true; await held.promise; });
  await turn(); assert.ok(reading);
  f.poll(); f.message(80, 13);
  await turn();
  assert.equal(f.calls.filter(c => c.path === '/messages/77').length, 0, 'fresh poll content is read only at the lane turn');
  await f.server.channelManager.flush();
  assert.deepEqual(f.incoming.map(m => m.messageId), ['alpha:80']);
  held.resolve(); await f.flush();
  assert.deepEqual(f.incoming.map(m => m.messageId), ['alpha:80', 'poll:77:2']);
  assert.equal(f.incoming[1].metadata.pollMessageId, 'alpha:77');
  assert.equal(f.server.delivery.watermark(streamKey(12)), undefined, 'a vote never advances a message cursor');
  assert.equal(f.server.channelManager.hintsOf(streamKey(12)), undefined, 'a vote never retargets replies');
});

test('poll events serialize their fresh GETs with messages, reactions and changes in one lane', async t => {
  const f = await fixture(t);
  f.filters.update(v => ({ ...v, reactionChannels: ['zulip:general'] }));
  const held = deferred<any>(); f.get(() => held.promise);
  f.poll(); await turn();
  f.message(78);
  f.hooks[3]({ op: 'add', message_id: 77, emoji_name: 'thumbs_up', emoji_code: '1f44d', reaction_type: 'unicode_emoji', user_id: 9 });
  f.hooks[4]({ kind: 'edit', messageId: 77, messageIds: [77], actorId: 9, content: 'changed', origContent: null, origTopic: null, flags: [], topic: null, newStreamId: null, streamId: 12, editedAt: 1700000001 });
  f.poll(3);
  await turn(); assert.equal(f.calls.filter(c => c.path === '/messages/77').length, 1);
  held.resolve({ result: 'success', message: raw() });
  await f.flush();
  assert.deepEqual(f.incoming.map(m => m.metadata.pollVote ? 'poll' : m.metadata.reaction ? 'reaction' : m.metadata.change ?? 'message'), ['poll', 'message', 'reaction', 'edit', 'poll']);
  assert.equal(f.calls.filter(c => c.path === '/messages/77').length, 2, 'one fresh read for each vote, never a cached envelope');
  assert.equal(f.server.delivery.watermark(streamKey(12)), 78);
});

test('fresh poll placement after a move enters the destination lane, still behind its held read', async t => {
  const f = await fixture(t);
  const held = deferred<void>();
  f.lanes.lane(streamKey(13)).enterRead(async () => { await held.promise; });
  await turn();
  f.set(raw(77, 13, { subject: 'moved' }));
  f.poll(); await turn(); await turn();
  await f.server.channelManager.flush();
  assert.equal(f.incoming.length, 0);
  held.resolve(); await f.flush();
  assert.equal(f.incoming.length, 1);
  assert.equal(f.incoming[0].channelId, 'zulip:other');
  assert.equal(f.incoming[0].threadId, 'moved');
});

test('revocation gates immediately but purge waits for the lane; regrant cannot revive queued messages or votes', async t => {
  const f = await fixture(t, { scoped: true });
  const key = streamKey(12), held = deferred<void>();
  (f.server.delivery as any).advance(key, 76);
  f.lanes.lane(key).enterRead(async () => { await held.promise; });
  await turn();
  f.poll(); f.message(78);
  const oldEpoch = f.gate.checkpoint();
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12] });
  assert.equal(f.gate.fresh(12, oldEpoch), false, 'no async cleanup window grants reads');
  assert.equal(f.server.delivery.watermark(key), 76, 'writer purge cannot bypass a running lane read');
  f.message(80, 13); await turn(); await f.server.channelManager.flush();
  assert.equal(f.incoming[0].messageId, 'alpha:80');
  f.filters.subscriptions.apply({ op: 'add', subscriptions: [streams[0]] });
  held.resolve(); await f.flush();
  assert.equal(f.server.delivery.watermark(key), undefined);
  assert.equal(f.server.channelManager.hintsOf(key), undefined);
  assert.deepEqual(f.incoming.map(m => m.messageId), ['alpha:80']);
  assert.equal((f.adapter as any).seen.has(77), false);
});

test('revocation during an in-flight vote GET drops its data after regrant', async t => {
  const f = await fixture(t, { scoped: true });
  const held = deferred<any>(); f.get(() => held.promise);
  f.poll(); await turn();
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12] });
  f.filters.subscriptions.apply({ op: 'add', subscriptions: [streams[0]] });
  held.resolve({ result: 'success', message: raw() });
  await f.flush();
  assert.deepEqual(f.incoming, []);
  assert.deepEqual(f.pushed, []);
});

test('a late incoming acceptance cannot resurrect a purged cursor after regrant', async t => {
  const f = await fixture(t, { scoped: true });
  const held = deferred<any>(); f.answerIncoming(() => held.promise);
  f.message(78); await f.lanes.quiet();
  const flushing = f.server.channelManager.flush(); await turn();
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12] });
  await f.lanes.quiet();
  f.filters.subscriptions.apply({ op: 'add', subscriptions: [streams[0]] });
  held.resolve({ results: [{ messageId: 'alpha:78', accepted: true }] });
  await flushing; await f.lanes.quiet();
  assert.equal(f.server.delivery.watermark(streamKey(12)), undefined);
});

test('native moves accept realm anchors and retain upstream receipt/fields; subscribed destination denies before PATCH', async t => {
  const f = await fixture(t, { scoped: true });
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [13] });
  await f.lanes.quiet();
  await assert.rejects(f.tools.handleToolCall('move_messages', { message_id: 'alpha:77', stream: 'other', scope: 'all' }), /policy/);
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0);
  await assert.rejects(f.tools.handleToolCall('move_messages', { message_id: 'beta:77', topic: 'x', scope: 'one' }), /differs/);
  const result = await f.tools.handleToolCall('move_messages', { message_id: 'alpha:77', topic: '', scope: 'all' });
  assert.deepEqual(f.calls.find(c => c.method === 'PATCH')?.params, { propagate_mode: 'change_all', topic: '' });
  assert.equal(result.topic, '');
  assert.equal(result.channel, 'general');
  assert.equal(result.moved_to, undefined, 'no obsolete fork move receipt');
});

test('own-message active topic observations enter the lane and respect revocation', async t => {
  const f = await fixture(t, { scoped: true, active: true });
  const held = deferred<void>(); f.lanes.lane(streamKey(12)).enterRead(async () => { await held.promise; });
  await turn();
  f.hooks[1](null, { ...raw(81), subject: 'new own topic', readEpoch: f.gate.checkpoint() }, []);
  const cache = (f.adapter as any).activeTopics;
  assert.ok(!JSON.stringify([...cache.streams.values()]).includes('new own topic'));
  held.resolve(); await f.lanes.quiet();
  assert.match(JSON.stringify([...cache.streams.values()]), /new own topic/);
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12] }); await f.lanes.quiet();
  assert.equal(cache.streams.has(12), false);
});

test('a purge on one channel cannot purge monitoring state ahead of another channel lane', async t => {
  const f = await fixture(t, { scoped: true });
  const held = deferred<void>();
  const monitored = (f.tools as any).monitoredChannels;
  for (const s of streams) monitored.set(s.name, { channelName: s.name, streamId: s.stream_id, readEpoch: f.gate.checkpoint() });
  f.lanes.lane(streamKey(13)).enterRead(async () => { await held.promise; });
  await turn();
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12, 13] });
  await turn(); await turn();
  assert.equal(monitored.has('general'), false);
  assert.equal(monitored.has('other'), true, 'other channel purge is still waiting on its read');
  held.resolve(); await f.lanes.quiet();
  assert.equal(monitored.has('other'), false);
});

test('closed-channel vote pushes are own-poll only and never create missed tallies or hints', async t => {
  const f = await fixture(t, { open: false });
  f.poll(); await f.flush();
  assert.equal(f.pushed.length, 1);
  assert.equal(f.incoming.length, 0);
  assert.equal(f.server.delivery.watermark(streamKey(12)), undefined);
  assert.equal(f.server.channelManager.hintsOf(streamKey(12)), undefined);
  f.set(raw(77, 12, { sender_id: 9 }));
  f.poll(3); await f.flush();
  assert.equal(f.pushed.length, 1);
  assert.equal(f.server.delivery.tally(streamKey(12)), undefined);
});


test('pre-existing membership is retained in the purge inventory before a channel has a lane', async t => {
  const f = await fixture(t, { scoped: true, preconnected: true });
  const monitored = (f.tools as any).monitoredChannels;
  monitored.set('other', { channelName: 'other', streamId: 13, readEpoch: f.gate.checkpoint() });
  assert.equal([...f.lanes.keys()].includes(streamKey(13)), false);
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [13] });
  await f.lanes.quiet();
  assert.equal(monitored.has('other'), false);
  assert.equal(f.server.channelManager.listChannels().channels.some(c => c.id === 'zulip:other'), false);
});
