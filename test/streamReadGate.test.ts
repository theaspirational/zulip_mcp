import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FiltersPlane } from '../src/filters.ts';
import { ZulipToolRuntime } from '../src/tool-runtime.ts';
import { ZulipAdapter } from '../src/platforms/zulip.ts';
import { ZulipMcplServer } from '../src/server.ts';
import { MessageIds } from '../src/message-ids.ts';
import { STREAM_READ_TOOLS, NON_STREAM_READ_TOOLS, CONDITIONAL_STREAM_READ_TOOLS } from '../src/stream-read-gate.ts';
import { toolDefinitions } from '../src/tools.ts';
import { method } from '@animalabs/mcpl-core';

const streams = [{ stream_id: 12, name: 'general' }, { stream_id: 13, name: 'second' }];
const path = '/user_uploads/1/ab/cd/file.txt';
const init = { id: 1, msg_type: 'widget', sender_id: 7,
  content: JSON.stringify({ widget_type: 'poll', extra_data: { question: 'SECRET?', options: ['Yes'] } }) };
const raw = (id = 77, stream_id = 12, display_recipient = 'general') => ({
  id, stream_id, display_recipient, type: 'stream', subject: 'SECRET topic',
  sender_id: 7, sender_full_name: 'Ann', sender_email: 'ann@example.invalid',
  content: `SECRET [file](${path})`, timestamp: 1700000000, flags: [], submessages: [init],
});
function deferred() {
  let resolve!: (value: any) => void;
  let start!: () => void;
  const started = new Promise<void>(r => { start = r; });
  const promise = new Promise<any>(r => { resolve = r; });
  return { resolve, started, wait: () => { start(); return promise; } };
}
async function fixture(known = true) {
  const dir = mkdtempSync(join(tmpdir(), 'zulip-read-gate-'));
  const plane = new FiltersPlane(join(dir, 'filters.json'), { ZULIP_STREAMS_MODE: 'subscribed' });
  plane.start();
  const calls: any[] = [];
  const client = {
    config: { apiURL: 'https://zulip.invalid/api/v1' },
    async callEndpoint() { return { result: 'success', subscriptions: streams }; },
    messages: {
      async getById(p: any) { calls.push(['id', p]); return { result: 'success', message: raw(p.message_id) }; },
      async retrieve(p: any) { calls.push(['messages', p]); return { result: 'success', messages: [raw()], found_newest: true }; },
      async send(p: any) { calls.push(['send', p]); return { result: 'success', id: 99 }; },
    },
    streams: {
      async retrieve(p: any) { calls.push(['streams', p]); return { result: 'success', streams: [...streams, { stream_id: 14, name: 'public', description: 'SECRET public' }] }; },
      topics: { async retrieve(p: any) { calls.push(['topics', p]); return { result: 'success', topics: [{ name: 'SECRET topic', max_id: 77 }] }; } },
      async getStreamId() { return { result: 'success', stream_id: 12 }; },
    },
    users: { async retrieve() { calls.push(['users']); return { result: 'success', members: [] }; } },
  };
  if (known) await plane.subscriptions.connect(client, 790);
  const runtime = new ZulipToolRuntime({
    client, selfUserId: 790, sessionId: 'read-gate', realm: 'https://zulip.invalid', authHeader: 'test-only',
  }, dir, { messageIds: new MessageIds('acme', 'strict') });
  const adapter = new ZulipAdapter(client, 790, 'read-gate', { filters: plane, activeTopics: 0 });
  const server = new ZulipMcplServer(adapter, runtime, { serverInfo: { name: 'test', version: '0' }, filters: plane });
  return { runtime, plane, client, adapter, server, calls,
    remove() { plane.subscriptions.apply({ op: 'remove', stream_ids: [12] }); },
    close() { plane.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('every registered tool has an explicit stream-read contract (new tools fail closed in the audit)', () => {
  const names = toolDefinitions.map(t => t.name).sort();
  assert.deepEqual([...STREAM_READ_TOOLS, ...NON_STREAM_READ_TOOLS].sort(), names);
  for (const name of STREAM_READ_TOOLS) assert.ok(!NON_STREAM_READ_TOOLS.has(name));
  for (const name of CONDITIONAL_STREAM_READ_TOOLS) assert.ok(STREAM_READ_TOOLS.has(name));
});

test('reviewer rename probe: old-name public impostor never inherits membership, even with stale display data', async () => {
  const f = await fixture();
  try {
    f.plane.subscriptions.apply({ type: 'stream', op: 'update', stream_id: 12, property: 'name', value: 'renamed' });
    f.plane.subscriptions.apply({ type: 'stream', op: 'create', streams: [{ stream_id: 14, name: 'general' }] });
    assert.equal(f.plane.streamReadAllowed(12), true);
    assert.equal(f.plane.streamReadAllowed(14), false);
    assert.equal(f.plane.streamAllowed('general'), false);
    f.client.messages.getById = async () => ({ result: 'success', message: raw(77, 14, 'general') });
    for (const name of ['get_poll_results', 'fetch_around'])
      await assert.rejects(f.runtime.handleToolCall(name, { message_id: 'acme:77' }), /subscribed-stream policy/);
    await assert.rejects(f.runtime.handleToolCall('fetch_history', { channel: 'general' }), /subscribed-stream policy/);
    f.client.messages.retrieve = async (p: any) => {
      assert.deepEqual(p.narrow[0], { operator: 'stream', operand: 12 });
      return { result: 'success', messages: [raw(77, 12, 'renamed')], found_newest: true };
    };
    assert.equal((await f.runtime.handleToolCall('fetch_history', { channel: 'renamed' })).count, 1);
    // Subscription properties update display data, never confer membership.
    f.plane.subscriptions.apply({ op: 'update', stream_id: 12, property: 'name', value: 'again' });
    assert.equal(f.plane.subscriptions.resolveName('again'), 12);
    f.plane.subscriptions.apply({ op: 'update', stream_id: 14, property: 'color', value: 'red' });
    assert.equal(f.plane.streamReadAllowed(14), false);
    f.plane.subscriptions.apply({ type: 'stream', op: 'delete', streams: [{ stream_id: 12, name: 'again' }] });
    assert.equal(f.plane.streamReadAllowed(12), false);
  } finally { f.close(); }
});

test('topics refused before GET and on return; stream-list verbose data is filtered by ID', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.runtime.handleToolCall('get_stream_topics', { stream_id: 14 }), /subscribed-stream policy/);
    assert.equal(f.calls.length, 0);
    const listing = await f.runtime.handleToolCall('list_streams', { verbose: true });
    assert.equal(JSON.stringify(listing).includes('SECRET public'), false);
    assert.deepEqual(listing.raw_data.streams.map((s: any) => s.stream_id), [12, 13]);
    const d = deferred();
    f.client.streams.topics.retrieve = () => d.wait();
    const pending = f.runtime.handleToolCall('get_stream_topics', { stream_id: 12, verbose: true });
    await d.started; f.remove(); d.resolve({ result: 'success', topics: [{ name: 'SECRET', max_id: 77 }] });
    await assert.rejects(pending, /subscribed-stream policy/);
  } finally { f.close(); }
});

const argumentsFor: Record<string, any> = {
  start_monitoring: { channels: ['general'] }, get_monitored_channels: {},
  filters_get: {}, filters_update: { addStreams: ['general'] },
  get_channel_history: { channel: 'general' }, get_unread_messages: { channels: ['general'] },
  fetch_history: { channel: 'general' }, fetch_around: { message_id: 'acme:77' },
  get_poll_results: { message_id: 'acme:77' }, list_streams: {}, get_stream_topics: { stream_id: 12 },
  fetch_attachment: { path, message_id: 'acme:77' }, refresh_channels: {}, channel_missed: { channel: 'general' },
  send_message: { type: 'stream', to: 'general', topic: 'T', content: '[[msg:acme:77]]' },
  send_poll: { reply_to: 'acme:77', question: 'Q?', options: ['Yes', 'No'] },
  edit_message: { message_id: 'acme:77', content: '[[msg:acme:78]]' },
  move_messages: { message_id: 'acme:77', topic: 'new' },
};
test('unknown state refuses every stream-reading tool and resource without returning metadata', async () => {
  const f = await fixture(false);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('unexpected fetch'); };
  try {
    for (const name of STREAM_READ_TOOLS) {
      assert.ok(argumentsFor[name], name);
      const result = await (f.server as any).callTool(name, argumentsFor[name]);
      assert.equal(result.isError, true, name);
      assert.ok(!JSON.stringify(result).includes('SECRET'), name);
    }
    for (const uri of ['zulip://unread/summary', 'zulip://monitoring/status', 'zulip://channel/general/unread'])
      await assert.rejects(f.runtime.readResource(uri), /subscribed-stream policy/);
    assert.equal(f.calls.length, 0);
  } finally { globalThis.fetch = originalFetch; f.close(); }
});

for (const name of ['get_poll_results', 'fetch_around', 'start_monitoring', 'get_unread_messages',
  'send_message', 'send_poll', 'edit_message', 'move_messages', 'fetch_attachment', 'unread-summary']) {
  test(`unsubscribe during final await: ${name}`, async () => {
    const f = await fixture();
    const d = deferred();
    const originalFetch = globalThis.fetch;
    try {
      let args: any = argumentsFor[name];
      let response: any = { result: 'success', messages: [raw(78, 13, 'second')], found_newest: true };
      if (name === 'get_poll_results') {
        f.client.users.retrieve = () => d.wait();
        response = { result: 'success', members: [] };
      } else if (name === 'fetch_around') {
        f.client.messages.retrieve = () => d.wait();
      } else if (['start_monitoring', 'get_unread_messages', 'unread-summary'].includes(name)) {
        if (name !== 'start_monitoring')
          await f.runtime.handleToolCall('start_monitoring', { channels: ['general', 'second'] });
        let calls = 0;
        f.client.messages.retrieve = async () => ++calls === 1 ? { result: 'success', messages: [raw()] } : d.wait();
        args = { channels: ['general', 'second'] };
      } else if (['send_message', 'send_poll'].includes(name)) {
        (f.runtime as any).zulipClient.messages.send = () => d.wait();
        response = { result: 'success', id: 99 };
      } else if (['edit_message', 'move_messages'].includes(name)) {
        globalThis.fetch = async () => d.wait();
        response = new Response(JSON.stringify({ result: 'success' }), { status: 200 });
      } else if (name === 'fetch_attachment') {
        globalThis.fetch = async () => d.wait();
        response = new Response('SECRET attachment', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      const pending = name === 'unread-summary' ? f.runtime.readResource('zulip://unread/summary') : f.runtime.handleToolCall(name, args);
      await d.started;
      f.remove();
      d.resolve(response);
      await assert.rejects(pending, /subscribed-stream policy/);
    } finally { globalThis.fetch = originalFetch; f.close(); }
  });
}

test('attachments require a readable message containing the exact upload path', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.runtime.handleToolCall('fetch_attachment', { path }), /provenance required/);
    await assert.rejects(f.runtime.handleToolCall('fetch_attachment', { path: '/user_uploads/elsewhere.txt', message_id: 'acme:77' }), /attachment not in message/);
  } finally { f.close(); }
});

test('multi-await adapter discovery and backscroll recheck IDs after DM/quote lookups', async () => {
  for (const surface of ['discover', 'history']) {
    const f = await fixture();
    const d = deferred();
    try {
      if (surface === 'discover') f.client.messages.retrieve = () => d.wait();
      else {
        // Use a supported Zulip quote header to force a target lookup.
        f.client.messages.retrieve = async () => ({ result: 'success', messages: [{ ...raw(), content: '@_**Bot** [said](https://zulip.invalid/#narrow/stream/12/near/88):\n\u0060\u0060\u0060quote\nhello\n\u0060\u0060\u0060' }], found_newest: true });
        f.client.messages.getById = () => d.wait();
      }
      const pending = surface === 'discover' ? f.adapter.discoverChannels() : f.adapter.fetchHistory('zulip:general', { limit: 5 });
      await d.started; f.remove();
      d.resolve(surface === 'discover' ? { result: 'success', messages: [] } : { result: 'success', message: raw(88) });
      await assert.rejects(pending, /subscribed-stream policy/);
    } finally { f.close(); }
  }
});

test('stored monitoring metadata retains its original stream ID across name reuse', async () => {
  const f = await fixture();
  try {
    await f.runtime.handleToolCall('start_monitoring', { channels: ['general'] });
    f.remove();
    f.plane.subscriptions.apply({ type: 'stream', op: 'update', stream_id: 12, property: 'name', value: 'renamed' });
    f.plane.subscriptions.apply({ op: 'add', subscriptions: [{ stream_id: 14, name: 'general' }] });
    await assert.rejects(f.runtime.handleToolCall('get_monitored_channels', {}), /subscribed-stream policy/);
    await assert.rejects(f.runtime.readResource('zulip://monitoring/status'), /subscribed-stream policy/);
    const before = f.calls.length;
    const result = await f.runtime.handleToolCall('get_unread_messages', { channels: ['general'] });
    assert.equal(result.total_unread, 0);
    assert.equal(f.calls.length, before, 'must not GET the new subscribed stream using the old cursor');
  } finally { f.close(); }
});

test('refresh_channels rechecks stream IDs after awaiting host registration', async () => {
  const f = await fixture();
  const d = deferred();
  try {
    (f.server as any).mcplActive = true;
    (f.server as any).conn = {};
    // Exercise the server-owned tool without negotiating a wire grant.
    (f.server as any).grant.has = () => true;
    (f.server as any).grant.isFeatureSetActive = () => true;
    (f.server as any).channelManager.registerAdditional = () => d.wait();
    const pending = (f.server as any).callTool('refresh_channels', {});
    await d.started; f.remove();
    d.resolve({ announced: ['zulip:general'], local: [], refused: [] });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes('zulip:general'));
  } finally { f.close(); }
});

const HIDDEN = { stream_id: 987654321, name: 'forbidden-stream-needle' };
const hiddenId = `zulip:${HIDDEN.name}`;
const hiddenDescriptor = {
  id: hiddenId, type: 'zulip', label: HIDDEN.name, direction: 'bidirectional',
  address: { stream_id: HIDDEN.stream_id, stream_name: HIDDEN.name },
} as const;
function assertRedacted(value: unknown, surface: string) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(HIDDEN.name), `${surface}: leaked name: ${text}`);
  assert.ok(!text.includes(String(HIDDEN.stream_id)), `${surface}: leaked immutable ID: ${text}`);
}
async function emissionFixture(unknown: boolean) {
  const f = await fixture();
  const server = f.server as any;
  const outputs: any[] = [];
  server.mcplActive = true;
  server.grant.has = () => true;
  server.grant.isFeatureSetActive = () => true;
  const conn = {
    sendResponse(id: unknown, result: unknown) { outputs.push({ id, result }); },
    sendError(id: unknown, code: unknown, message: unknown, data: unknown) { outputs.push({ id, code, message, data }); },
    async sendRequest(method: string, params: unknown) { outputs.push({ method, params }); return { results: [] }; },
  };
  f.plane.subscriptions.apply({ op: 'add', subscriptions: [HIDDEN] });
  f.plane.update(current => ({ ...current, reactionChannels: [hiddenId] }));
  server.conn = conn;
  await server.channelManager.registerAdditional([hiddenDescriptor]); // intentionally unconfirmed
  assert.equal(server.channelManager.unannounced.has(hiddenId), true, 'fixture must retain an actual retry backlog');
  server.channelManager.openChannels.add(hiddenId);
  const seed = () => (f.runtime as any).monitoredChannels.set(HIDDEN.name, {
    streamId: HIDDEN.stream_id, channelName: HIDDEN.name, lastReadMessageId: 0, subscribed: true,
  });
  seed();
  // Only retained metadata knows this channel after removal. Discovery is empty.
  f.adapter.discoverChannels = async () => [];
  if (unknown) {
    f.client.callEndpoint = async () => ({ result: 'error' } as any);
    await f.plane.subscriptions.refresh(true);
    assert.equal(f.plane.subscriptions.status().known, false);
  } else f.plane.subscriptions.apply({ op: 'remove', stream_ids: [HIDDEN.stream_id] });
  await new Promise(resolve => setImmediate(resolve));
  outputs.length = 0;
  return { ...f, server, outputs, conn, seed };
}

for (const unknown of [false, true]) {
  test(`reviewer backlog/list probe, unknown=${unknown}`, async () => {
    const f = await emissionFixture(unknown);
    try {
      assertRedacted(await f.server.applyFilterChange(), 'refresh result');
      assertRedacted(await f.server.channelManager.registerAdditional([], { retryBacklog: true }), 'registration result');
      assert.equal(f.outputs.length, 0, 'unauthorized backlog must never be offered again');
      await f.server.handleRequest(f.conn, { id: 1, method: method.CHANNELS_LIST });
      assert.deepEqual(f.outputs[0].result.channels, []);
      assertRedacted(f.outputs, 'retained descriptors');
    } finally { f.server.channelManager.destroy(); f.close(); }
  });

  test(`reviewer stop_monitoring probe, unknown=${unknown}`, async () => {
    const f = await emissionFixture(unknown);
    try {
      const partial = await f.runtime.handleToolCall('stop_monitoring', { channels: ['not-monitored'] });
      assert.equal(partial.still_monitoring_count, 1);
      assertRedacted(partial, 'still_monitoring');
      const targeted = await f.runtime.handleToolCall('stop_monitoring', { channels: [HIDDEN.name] });
      assert.equal(targeted.stopped_count, 1);
      assertRedacted(targeted, 'stopped_channels');
      f.seed();
      const all = await f.runtime.handleToolCall('stop_monitoring', {});
      assert.equal(all.stopped_count, 1);
      assert.equal((f.runtime as any).monitoredChannels.size, 0, 'cleanup must work without read authority');
      assertRedacted(all, 'stop all');
    } finally { f.server.channelManager.destroy(); f.close(); }
  });
}

test('emission inventory walk: no unauthorized stream name or ID on any host/agent surface', async () => {
  for (const unknown of [false, true]) {
    const f = await emissionFixture(unknown);
    try {
      const message = {
        channelId: hiddenId, messageId: '77', author: { id: '7', name: 'Ann' },
        timestamp: '2023-11-14T22:13:20Z', content: [{ type: 'text', text: HIDDEN.name }],
        metadata: { streamId: HIDDEN.stream_id, mentioned: true },
      };
      f.client.messages.getById = async () => ({ result: 'success', message: raw(77, HIDDEN.stream_id, HIDDEN.name) });
      (f.client.messages as any).deleteById = async () => ({ result: 'success', msg: HIDDEN.name });
      (f.runtime as any).zulipClient.reactions = {
        add: async () => ({ result: 'success', msg: HIDDEN.name }),
        remove: async () => ({ result: 'success', msg: HIDDEN.name }),
      };
      (f.runtime as any).zulipClient.emojis = { retrieve: async () => ({ result: 'success', emoji: {} }) };
      (f.client.users as any).me = { subscriptions: {
        add: async () => ({ result: 'success', subscribed: { self: [HIDDEN.name] }, msg: HIDDEN.name }),
        remove: async () => ({ result: 'success', removed: [HIDDEN.name], not_removed: [], msg: HIDDEN.name }),
      } };
      f.adapter.fetchContext = async () => ({ namespace: hiddenId, position: 'beforeUser', content: HIDDEN.name });
      await f.server.registerChannelsWithHost([hiddenDescriptor]);
      // Each descriptor variant and removal IDs have independent wire projections.
      for (const params of [{ added: [hiddenDescriptor] }, { updated: [hiddenDescriptor] }, { removed: [hiddenId] }])
        await f.server.channelsChangedWithHost(params);
      await f.server.sendIncomingToHost([message]);
      await f.server.pushEvent(message, 'event');
      await f.server.pushEvent({ ...message, metadata: { system: true } }, 'system-event');
      f.server.channelManager.onIncomingMessage(hiddenId, message);
      f.server.channelManager.broadcastSystemEvent('zulip', { kind: 'degraded', text: 'Connection degraded' });
      await f.server.channelManager.flush();
      await f.server.onSystemEvent({ kind: 'degraded', text: 'Connection degraded' });
      await f.server.channelManager.flush();
      await f.server.onIncoming(message);
      await f.server.onReaction({ channelId: hiddenId, streamId: HIDDEN.stream_id });
      await f.server.onMessageChange({ channelId: hiddenId, streamId: HIDDEN.stream_id, kind: 'edit', previousTopic: null, movedToChannelId: null });
      const request = async (method: string, params: any = {}) => {
        await f.server.handleRequest(f.conn, { id: 1, method, params });
        assertRedacted(f.outputs, `${method}, unknown=${unknown}`);
      };
      await request(method.CHANNELS_LIST);
      await request(method.CHANNELS_OPEN, { channelId: hiddenId, type: 'zulip', address: hiddenDescriptor.address, history: { limit: 10 } });
      await request(method.CONTEXT_BEFORE_INFERENCE);
      await request(method.CHANNELS_PUBLISH, { channelId: hiddenId, content: [] });
      await request(method.CHANNELS_ACKNOWLEDGE, { channelId: hiddenId, messageId: 'acme:77' });
      await request(method.CHANNELS_TYPING, { channelId: hiddenId });
      await request(method.CHANNELS_CLOSE, { channelId: hiddenId });
      const checkpoint = f.server.stateTracker.createCheckpoint();
      f.server.stateTracker.recordSent('77', hiddenId, HIDDEN.name);
      await request(method.STATE_ROLLBACK, { featureSet: 'zulip.messaging', checkpoint });
      await request('resources/list');
      for (const uri of ['zulip://unread/summary', 'zulip://monitoring/status', `zulip://channel/${HIDDEN.name}/unread`, `zulip://invalid/${HIDDEN.name}`])
        await request('resources/read', { uri });
      // Static protocol metadata contains no stream-derived state.
      for (const name of ['ping', 'tools/list', 'prompts/list', method.MCPL_MANIFEST, `unknown/${HIDDEN.name}`]) await request(name);
      const args: Record<string, any> = {
        ...argumentsFor,
        start_monitoring: { channels: [HIDDEN.name] }, stop_monitoring: { channels: [HIDDEN.name] },
        get_channel_history: { channel: HIDDEN.name }, get_unread_messages: { channels: [HIDDEN.name] },
        fetch_history: { channel: HIDDEN.name }, get_stream_topics: { stream_id: HIDDEN.stream_id },
        send_message: { type: 'stream', to: HIDDEN.name, content: 'hello' },
        send_poll: { type: 'stream', to: HIDDEN.name, topic: 'T', question: 'Q?', options: ['Yes', 'No'] },
        send_dm: { to: ['7'], content: 'hello' },
        listen: { channels: [HIDDEN.name] }, unlisten: { channels: [HIDDEN.name] },
        mute_channel: { channel: HIDDEN.name }, unmute_channel: { channel: HIDDEN.name },
        set_reaction_visibility: { channel: hiddenId, visible: true },
        filters_update: { addStreams: [HIDDEN.name] }, channel_missed: { channel: HIDDEN.name },
        delete_message: { message_id: 'acme:77' }, add_reaction: { message_id: 'acme:77', emoji_name: 'eyes' },
        remove_reaction: { message_id: 'acme:77', emoji_name: 'eyes' },
        upload_file: {}, list_users: {}, find_user: { query: 'Ann' }, get_user_profile: { user_id: 7 },
        list_emojis: {},
      };
      for (const { name } of toolDefinitions) {
        assert.ok(args[name], `missing emission audit arguments: ${name}`);
        f.seed();
        await request('tools/call', { name, arguments: args[name] });
      }
      assertRedacted(f.outputs, `entire emission inventory, unknown=${unknown}`);
    } finally { f.server.channelManager.destroy(); f.close(); }
  }
});


test('wire boundary rechecks reads after an awaited resource helper has returned', async () => {
  const f = await fixture();
  const outputs: any[] = [];
  try {
    await f.runtime.handleToolCall('start_monitoring', { channels: ['general'] });
    const original = f.runtime.readResource.bind(f.runtime);
    f.runtime.readResource = async uri => {
      const result = await original(uri);
      f.remove(); // A helper's own final-return check is no longer sufficient.
      return result;
    };
    await (f.server as any).handleRequest({
      sendResponse(_id: unknown, result: unknown) { outputs.push({ result }); },
      sendError(_id: unknown, _code: unknown, error: unknown) { outputs.push({ error }); },
    }, { id: 1, method: 'resources/read', params: { uri: 'zulip://monitoring/status' } });
    assert.equal(outputs.length, 1);
    assert.ok(outputs[0].error);
    assert.ok(!JSON.stringify(outputs).includes('general'));
  } finally { f.close(); }
});

test('quote-wire-probe: reviewer cached forbidden quote metadata probe', async () => {
 const f = await fixture();
 try {
  const { normalizeMessage } = await import('../src/history.ts');
  // This cache is populated before stream authorization by the live callback.
  (f.adapter as any).remember('zulip:public', normalizeMessage({...raw(88,14,'public'),sender_id:790}));
  f.client.messages.retrieve = async () => ({result:'success', messages:[{...raw(), content:'[said](/#narrow/channel/14/near/88):\n```quote\noriginal\n```\nreply'}],found_newest:true});
  const server=f.server as any;
  server.mcplActive=true; server.grant.has=()=>true; server.grant.isFeatureSetActive=()=>true;
  const outputs:any[]=[];
  const conn={sendResponse(_id:any,result:any){outputs.push({result});},sendError(_id:any,code:any,error:any){outputs.push({code,error});},async sendRequest(){return {results:[]};}};
  server.conn=conn;
  (f.adapter as any).ensureSubscribed=async()=>{};
  await server.channelManager.registerAdditional([{id:'zulip:general',type:'zulip',label:'#general',direction:'bidirectional',address:{stream_id:12,stream_name:'general'}}]);
  await server.handleRequest(conn,{id:1,method:method.CHANNELS_OPEN,params:{channelId:'zulip:general',type:'zulip',address:{},history:{limit:10}}});
  console.log('FORBIDDEN QUOTE WIRE OUTPUT',JSON.stringify(outputs));
  assert.equal(outputs[0].result.history[0].metadata.replyToSelf, false, 'must not disclose the author classification of a forbidden-stream cached message');
 } finally { f.close(); }
});


test('quote dependencies survive to final wire return; revocation after history helper refuses metadata', async () => {
  const f = await fixture();
  try {
    const { normalizeMessage } = await import('../src/history.ts');
    (f.adapter as any).remember('zulip:second', normalizeMessage({ ...raw(88, 13, 'second'), sender_id: 790 }));
    f.client.messages.retrieve = async () => ({ result: 'success', messages: [{ ...raw(), content: '[said](/#narrow/channel/13/near/88):\n```quote\noriginal\n```\nreply' }], found_newest: true });
    const server = f.server as any;
    server.mcplActive = true; server.grant.has = () => true; server.grant.isFeatureSetActive = () => true;
    const outputs: any[] = [];
    const conn = { sendResponse(_id: any, result: any) { outputs.push({ result }); }, sendError(_id: any, code: any, error: any) { outputs.push({ code, error }); }, async sendRequest() { return { results: [] }; } };
    server.conn = conn;
    (f.adapter as any).ensureSubscribed = async () => {};
    const fetch = f.adapter.fetchHistory.bind(f.adapter);
    f.adapter.fetchHistory = async (...args) => {
      const page = await fetch(...args);
      assert.equal(page.messages[0].metadata?.replyToSelf, true);
      f.plane.subscriptions.apply({ op: 'remove', stream_ids: [13] });
      return page;
    };
    await server.channelManager.registerAdditional([{ id: 'zulip:general', type: 'zulip', label: '#general', direction: 'bidirectional', address: { stream_id: 12, stream_name: 'general' } }]);
    await server.handleRequest(conn, { id: 1, method: method.CHANNELS_OPEN, params: { channelId: 'zulip:general', type: 'zulip', address: {}, history: { limit: 10 } } });
    assert.equal(outputs.length, 1);
    assert.ok(outputs[0].error);
    assert.equal(outputs[0].result, undefined);
    assert.ok(!JSON.stringify(outputs).includes('SECRET'));
  } finally { f.close(); }
});

test('unsubscribe purges queued cross-stream reply classifications and server fallback verdicts', async () => {
  const f = await fixture();
  try {
    const { normalizeMessage } = await import('../src/history.ts');
    (f.adapter as any).remember('zulip:second', normalizeMessage({ ...raw(88, 13, 'second'), sender_id: 790 }));
    f.client.messages.retrieve = async () => ({ result: 'success', messages: [{ ...raw(), content: '[said](/#narrow/channel/13/near/88):\n```quote\noriginal\n```\nreply' }], found_newest: true });
    const message = (await f.adapter.fetchHistory('zulip:general', { limit: 10 })).messages[0];
    assert.equal(message.metadata?.replyToSelf, true);
    assert.deepEqual(message.metadata?.readStreamIds, [13]);
    const server = f.server as any;
    server.grant.has = () => true; server.grant.isFeatureSetActive = () => true;
    await server.onIncoming(message); // Pre-live buffer + fallback verdict.
    server.channelManager.markOpen('zulip:general');
    server.channelManager.onIncomingMessage('zulip:general', message);
    assert.equal(server.pendingReplies.get('zulip:general').has(77), true);
    assert.equal(server.channelManager.pendingCount(), 1);
    f.plane.subscriptions.apply({ op: 'remove', stream_ids: [13] });
    assert.equal(server.pendingReplies.size, 0);
    assert.equal(server.preLive.length, 0);
    assert.equal(server.channelManager.pendingCount(), 0);
    assert.equal(server.mayDeliver(message), false, 'even an already-taken retry is gated at emission');
    server.channelManager.destroy();
  } finally { f.close(); }
});
