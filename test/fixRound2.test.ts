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
import { POLL_PLACEMENT_WAIT_MS } from '../src/polls.ts';
import { standInApi } from '../test/zulip-stand-in.ts';

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
  let history: any[] = [];
  let get: (() => Promise<any>) | undefined;
  let hooks: any[] = []; let eventLoop: any;
  t.mock.method(ZulipEventLoop.prototype, 'start', async function (...args: any[]) { hooks = args; eventLoop = this; });
  const { api, calls } = standInApi({
    'GET /users/me/subscriptions': { result: 'success', subscriptions: streams },
    'GET /streams': { result: 'success', streams },
    'GET /messages': () => ({ result: 'success', messages: history, found_newest: true }),
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
  const cleanup: (() => void)[] = [];
  t.after(async () => { for (const release of cleanup) release(); await server.shutdown(); });
  const lanes = (server as any).lanes;
  const gate = (server as any).streamGate;
  const epoch = () => gate?.checkpoint();
  const message = (id: number, stream = 12) => hooks[1](null, { ...raw(id, stream, { sender_id: 9, sender_full_name: 'Human' }), ...(scoped ? { readEpoch: epoch() } : {}) }, []);
  // Seed only placement, as an own poll's initial message does in production.
  hooks[1](null, raw(), []);
  await lanes.quiet();
  const poll = (id = 2) => hooks[5]({ ...vote(id), ...(scoped ? { readEpoch: epoch() } : {}) });
  return { server, adapter, tools, filters, calls, incoming, pushed, lanes, gate, message, poll, hooks, eventLoop,
    releaseOnShutdown: (release: () => void) => cleanup.push(release),
    setHistory: (messages: any[]) => { history = messages; },
    set: (m: any) => { current = m; }, get: (fn?: () => Promise<any>) => { get = fn; },
    answerIncoming: (fn: () => Promise<any>) => { answerIncoming = fn; },
    flush: async () => { await lanes.quiet(); await server.channelManager.flush(); await lanes.quiet(); },
  };
}


// The event loop applies policy synchronously; no event callback may read
// stale data after regrants. Unplaced votes use best-effort lane ordering.
const nativeStart = ZulipEventLoop.prototype.start;
for (const moved of [false, true]) test(`uncached vote survives regrants with best-effort ordering, moved=${moved}`, async t => {
  const f = await fixture(t, { scoped: true });
  const held = deferred<void>(); f.releaseOnShutdown(() => held.resolve());
  f.lanes.lane(streamKey(12)).enterRead(async () => { await held.promise; });
  await turn();
  const events: any[] = [];
  const add = (e: any) => events.push({ ...e, id: events.length + 1 });
  for (let i = 0; i < 3; i++) {
    add({ type: 'subscription', op: 'remove', stream_ids: [12] });
    add({ type: 'subscription', op: 'add', subscriptions: [streams[0]] });
  }
  add({ type: 'submessage', ...vote(20), submessage_id: 20 });
  add({ type: 'message', message: raw(99, 12, { sender_id: 9, sender_full_name: 'Human' }) });
  let polled = false;
  const { api } = standInApi({
    'POST /register': { result: 'success', queue_id: 'test', last_event_id: -1 },
    'GET /events': () => {
      if (polled) { f.eventLoop.stop(); return { events: [] }; }
      polled = true; return { events };
    },
  });
  const destination = deferred<void>(); f.releaseOnShutdown(() => destination.resolve());
  if (moved) {
    f.set(raw(77, 13, { subject: 'moved' }));
    f.lanes.lane(streamKey(13)).enterRead(async () => { await destination.promise; });
  }
  await nativeStart.call(f.eventLoop, api, ...f.hooks.slice(1));
  // Unknown placement may be read without waiting for the revoked source lane.
  assert.equal(f.incoming.length, 0);
  f.lanes.lane(streamKey(12)).host(async () => {
    await f.server.channelManager.registerChannels();
    f.server.channelManager.markOpen('zulip:general');
    f.server.channelManager.markOpen('zulip:other');
  });
  held.resolve();
  if (moved) {
    for (let i = 0; i < 5; i++) await turn();
    await f.server.channelManager.flush();
    assert.deepEqual(f.incoming.map(m => m.messageId), ['alpha:99']);
    destination.resolve();
  }
  await f.flush();
  assert.deepEqual(f.incoming.map(m => m.messageId).sort(), ['alpha:99', 'poll:77:20'].sort());
  assert.equal(f.server.delivery.watermark(streamKey(12)), 99);
  if (moved) assert.equal(f.incoming.find(m => m.messageId === 'poll:77:20').channelId, 'zulip:other');
});

for (const args of [{ channels: ['nonexistent'] }, {}, { channels: ['general'] }]) {
  test(`stop monitoring projects revoked names and leaves held state lane-owned: ${JSON.stringify(args)}`, async t => {
    const f = await fixture(t, { scoped: true });
    await f.tools.handleToolCall('start_monitoring', { channels: ['general'] });
    const retained = (f.tools as any).monitoredChannels;
    const state = retained.get('general'); assert.ok(state);
    const held = deferred<void>(); f.releaseOnShutdown(() => held.resolve());
    f.lanes.lane(streamKey(12)).enterRead(async () => { await held.promise; });
    await turn();
    f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12] });
    const result = await f.tools.handleToolCall('stop_monitoring', args);
    assert.doesNotMatch(JSON.stringify(result), /general/);
    assert.equal(retained.get('general'), state, 'stop must not preempt the queued purge');
    assert.doesNotMatch(JSON.stringify(f.tools.listResources()), /general/);
    assert.doesNotMatch(JSON.stringify(await f.tools.readResource('zulip://monitoring/status')), /general/);
    assert.doesNotMatch(JSON.stringify(await f.tools.handleToolCall('get_monitored_channels', {})), /general/);
    assert.doesNotMatch(JSON.stringify(await (f.server as any).callTool('filters_get', {})), /general/);
    held.resolve(); await f.lanes.quiet();
    assert.equal(retained.has('general'), false);
  });
}


for (const name of ['start_monitoring', 'get_channel_history', 'get_unread_messages', 'stop_monitoring']) {
  test(`${name} waits for its monitored channel lane before reading or mutating`, async t => {
    const f = await fixture(t, { scoped: true });
    const retained = (f.tools as any).monitoredChannels;
    const state = { channelName: 'general', streamId: 12, readEpoch: f.gate.checkpoint(), lastReadMessageId: 70, subscribed: true };
    retained.set('general', state);
    f.setHistory([raw()]);
    const held = deferred<void>(); f.releaseOnShutdown(() => held.resolve());
    f.lanes.lane(streamKey(12)).enterRead(async () => { await held.promise; });
    await turn();
    const readsBefore = f.calls.filter(c => c.path === '/messages').length;
    const args = name === 'get_channel_history' ? { channel: 'general' } : { channels: ['general'] };
    let finished = false;
    const pending = f.tools.handleToolCall(name, args).then(result => { finished = true; return result; });
    await turn();
    assert.equal(finished, false);
    assert.equal(retained.get('general'), state);
    assert.equal(state.lastReadMessageId, 70);
    assert.equal(f.calls.filter(c => c.path === '/messages').length, readsBefore);
    held.resolve(); await pending; await f.lanes.quiet();
    if (name === 'stop_monitoring') assert.equal(retained.has('general'), false);
    else assert.equal(retained.get('general').lastReadMessageId, 77);
  });
}

for (const name of ['mute_channel', 'set_reaction_visibility', 'filters_update']) {
  test(`${name} cannot mutate filters ahead of a held channel lane`, async t => {
    const f = await fixture(t, { scoped: true });
    const held = deferred<void>(); f.releaseOnShutdown(() => held.resolve());
    f.lanes.lane(streamKey(12)).enterRead(async () => { await held.promise; });
    await turn();
    const before = JSON.stringify(f.filters.current());
    const args = name === 'filters_update' ? { addStreams: ['general'], setDmUsers: ['9'] } : { channel: 'general', visible: true };
    let finished = false;
    const pending = (f.server as any).serverTool(name, args).then((result: any) => { finished = true; return result; });
    await turn();
    assert.equal(finished, false);
    assert.equal(JSON.stringify(f.filters.current()), before);
    held.resolve(); await pending; await f.lanes.quiet();
    assert.notEqual(JSON.stringify(f.filters.current()), before);
  });
}

test('a vote without any placement hint uses best-effort ordering', async t => {
  const f = await fixture(t, { scoped: true });
  (f.adapter as any).placementHints.clear();
  (f.adapter as any).seen.clear();
  const held = deferred<void>(); f.releaseOnShutdown(() => held.resolve());
  f.lanes.lane(streamKey(12)).enterRead(async () => { await held.promise; });
  await turn();
  f.poll(); f.message(99);
  await turn();
  held.resolve(); await turn(); await f.flush();
  assert.deepEqual(f.incoming.map(m => m.messageId).sort(), ['poll:77:2', 'alpha:99'].sort());
});


for (const name of ['start_monitoring', 'get_channel_history', 'get_unread_messages', 'stop_monitoring', 'mute_channel', 'unmute_channel', 'set_reaction_visibility', 'filters_update']) {
  test(`${name} queued behind a read cannot mutate after revoke/regrant`, async t => {
    const f = await fixture(t, { scoped: true });
    const retained = (f.tools as any).monitoredChannels;
    retained.set('general', { channelName: 'general', streamId: 12, readEpoch: f.gate.checkpoint(), lastReadMessageId: 70, subscribed: true });
    const held = deferred<void>(); f.releaseOnShutdown(() => held.resolve());
    f.lanes.lane(streamKey(12)).enterRead(async () => { await held.promise; });
    await turn();
    const isFilter = ['mute_channel', 'unmute_channel', 'set_reaction_visibility', 'filters_update'].includes(name);
    const args = name === 'filters_update' ? { addStreams: ['general'], setDmUsers: ['9'] }
      : isFilter ? { channel: 'general', visible: true }
      : name === 'get_channel_history' ? { channel: 'general' } : { channels: ['general'] };
    const before = JSON.stringify(f.filters.current());
    const pending = isFilter ? (f.server as any).callTool(name, args) : f.tools.handleToolCall(name, args);
    const refused = isFilter ? pending.then((r: any) => assert.equal(r.isError, true)) : assert.rejects(pending, /policy/);
    await turn();
    f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12] });
    f.filters.subscriptions.apply({ op: 'add', subscriptions: [streams[0]] });
    held.resolve(); await refused; await f.lanes.quiet();
    assert.equal(retained.has('general'), false);
    assert.equal(JSON.stringify(f.filters.current()), before);
  });
}

test('unplaced votes and multi-channel filter turns complete without deadlock', { timeout: 5000 }, async t => {
  const f = await fixture(t, { scoped: true });
  (f.adapter as any).placementHints.clear();
  const held = deferred<void>(); f.releaseOnShutdown(() => held.resolve());
  f.lanes.lane(streamKey(12)).enterRead(async () => { await held.promise; });
  await turn();
  f.poll();
  const pending = (f.server as any).serverTool('filters_update', { addStreams: ['general', 'other'], setDmUsers: ['9'] });
  f.poll(3); f.message(99);
  held.resolve(); await pending; await f.flush();
  await turn(); await f.flush();
  assert.deepEqual(f.incoming.map(m => m.messageId).sort(), ['poll:77:2', 'poll:77:3', 'alpha:99'].sort());
});


test('channel_missed waits for a regranted lane purge rather than exposing retained watermarks', async t => {
  const f = await fixture(t, { scoped: true });
  const key = streamKey(12), delivery = f.server.delivery as any;
  delivery.advance(key, 70); delivery.markOpen(key); delivery.markClosed(key);
  delivery.countMissed(key, { id: 77, text: 'old private tally' });
  const held = deferred<void>(); f.releaseOnShutdown(() => held.resolve());
  f.lanes.lane(key).enterRead(async () => { await held.promise; });
  await turn();
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12] });
  await assert.rejects((f.server as any).serverTool('channel_missed', { channel: 'general' }), /policy/);
  f.filters.subscriptions.apply({ op: 'add', subscriptions: [streams[0]] });
  let finished = false;
  const pending = (f.server as any).serverTool('channel_missed', { channel: 'general' }).then((r: any) => { finished = true; return r; });
  await turn(); assert.equal(finished, false);
  assert.equal(delivery.watermark(key), 70);
  held.resolve();
  const result = await pending;
  assert.equal(result.tracked, false);
  assert.equal(result.sinceMessageId, undefined);
  await f.lanes.quiet(); assert.equal(delivery.watermark(key), undefined);
});

test('all retained channel lists and unread resources use the authorized projection', async t => {
  const f = await fixture(t, { scoped: true });
  await f.tools.handleToolCall('start_monitoring', { channels: ['general'] });
  const held = deferred<void>(); f.releaseOnShutdown(() => held.resolve());
  f.lanes.lane(streamKey(12)).enterRead(async () => { await held.promise; });
  await turn();
  const retained = (f.tools as any).monitoredChannels;
  const state = retained.get('general');
  f.filters.update(v => ({ ...v, streams: ['general', 'other'], mutedStreams: ['general'], reactionChannels: ['zulip:general'] }));
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12] });
  const readsBefore = f.calls.length;
  const outputs = [
    f.tools.listResources(),
    await f.tools.readResource('zulip://monitoring/status'),
    await f.tools.readResource('zulip://unread/summary'),
    await f.tools.handleToolCall('get_monitored_channels', {}),
    await f.tools.handleToolCall('get_unread_messages', {}),
    await (f.server as any).serverTool('filters_get', {}),
  ];
  for (const output of outputs) assert.doesNotMatch(JSON.stringify(output), /general/);
  for (const [name, args] of [
    ['start_monitoring', { channels: ['general'] }],
    ['get_unread_messages', { channels: ['general'] }],
    ['get_channel_history', { channel: 'general' }],
  ] as const) await assert.rejects(f.tools.handleToolCall(name, args), /policy/);
  const resource = await f.tools.readResource('zulip://channel/general/unread');
  assert.match(resource.contents[0].text, /not being monitored/);
  assert.equal(f.calls.length, readsBefore, 'revoked reads never reach the API');
  assert.equal(retained.get('general'), state, 'none of the views mutate retained state');
  held.resolve(); await f.lanes.quiet();
});


// Review 3 probes: the unrelated lane stays held throughout the assertions.
async function promptly(check: (expired: () => boolean) => Promise<void>) {
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([check(() => expired), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('delivery exceeded 3 s bound')), 3000);
    })]);
  } finally { expired = true; clearTimeout(timer); }
}

for (const unknown of [true, false]) test(`vote placement never waits on unrelated held lane, unknown=${unknown}`, async t => {
  const f = await fixture(t);
  if (unknown) { (f.adapter as any).placementHints.clear(); (f.adapter as any).seen.clear(); }
  const held = deferred<void>(); f.releaseOnShutdown(() => held.resolve());
  f.lanes.lane(streamKey(12)).enterRead(async () => { await held.promise; });
  await turn();
  f.set(raw(77, 13, { subject: 'resolved' }));
  if (!unknown) {
    // The known hint uses 13, with 12 stuck elsewhere.
    (f.adapter as any).placementHints.set(77, streamKey(13));
  }
  f.poll(); f.message(99, 13);
  await promptly(async expired => {
    while (!expired() && f.incoming.length < 2) { await turn(); await f.server.channelManager.flush(); }
  });
  assert.deepEqual(f.incoming.map(m => m.messageId).sort(), ['alpha:99', 'poll:77:2'].sort());
  assert.equal(f.incoming.find(m => m.messageId === 'poll:77:2').channelId, 'zulip:other');
  assert.equal(f.server.delivery.watermark(streamKey(12)), undefined);
});

test('moved vote at a held destination completes without a circular frontier wait', async t => {
  const f = await fixture(t);
  const held = deferred<void>(); f.releaseOnShutdown(() => held.resolve());
  f.lanes.lane(streamKey(13)).enterRead(async () => { await held.promise; });
  await turn();
  f.set(raw(77, 13, { subject: 'moved' }));
  f.poll(); f.message(99, 13);
  await turn(); await turn();
  assert.equal(f.incoming.length, 0);
  held.resolve();
  await promptly(() => f.flush());
  assert.deepEqual(f.incoming.map(m => m.messageId).sort(), ['alpha:99', 'poll:77:2'].sort());
});

for (const moved of [false, true]) test(`best-effort vote still checks revocation after placement, moved=${moved}`, async t => {
  const f = await fixture(t, { scoped: true });
  if (!moved) { (f.adapter as any).placementHints.clear(); (f.adapter as any).seen.clear(); }
  const held = deferred<void>(); f.releaseOnShutdown(() => held.resolve());
  f.lanes.lane(streamKey(13)).enterRead(async () => { await held.promise; });
  await turn();
  f.set(raw(77, 13)); f.poll();
  for (let i = 0; i < 5; i++) await turn();
  assert.equal(f.calls.filter(c => c.path === '/messages/77').length, 1, 'placement resolved while destination held');
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [13] });
  f.filters.subscriptions.apply({ op: 'add', subscriptions: [streams[1]] });
  held.resolve(); await turn(); await f.flush();
  assert.deepEqual(f.incoming, []);
  assert.deepEqual(f.pushed, []);
});

test('a stuck unknown placement lookup never delays messages on any lane', async t => {
  const f = await fixture(t);
  (f.adapter as any).placementHints.clear(); (f.adapter as any).seen.clear();
  const lookup = deferred<any>(); f.releaseOnShutdown(() => lookup.resolve({ result: 'success', message: raw(77, 13) }));
  f.get(() => lookup.promise);
  f.poll();
  await turn();
  f.message(98, 12); f.message(99, 13);
  await promptly(async expired => {
    while (!expired() && f.incoming.length < 2) { await turn(); await f.server.channelManager.flush(); }
  });
  assert.deepEqual(f.incoming.map(m => m.messageId).sort(), ['alpha:98', 'alpha:99']);
});


test('unknown placement has one named total budget and cannot deliver a late result', async t => {
  const f = await fixture(t);
  assert.ok(POLL_PLACEMENT_WAIT_MS > 0 && POLL_PLACEMENT_WAIT_MS <= 3000);
  (f.adapter as any).placementHints.clear(); (f.adapter as any).seen.clear();
  const lookup = deferred<any>();
  f.get(() => lookup.promise);
  // Advance only placement timers, not wall time or unrelated lane scheduling.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  try {
    f.poll(); await turn();
    t.mock.timers.tick(POLL_PLACEMENT_WAIT_MS);
    await turn();
    lookup.resolve({ result: 'success', message: raw(77, 13) });
    await turn(); await f.flush();
    assert.deepEqual(f.incoming, []);
    assert.deepEqual(f.pushed, []);
  } finally { t.mock.timers.reset(); }
});
