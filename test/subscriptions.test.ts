import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Subscriptions } from '../src/subscriptions.ts';
import { FiltersPlane } from '../src/filters.ts';
import { ZulipAdapter } from '../src/platforms/zulip.ts';
import { ZulipToolRuntime } from '../src/tool-runtime.ts';
import { ZulipMcplServer } from '../src/server.ts';
import { normalizeMessage } from '../src/history.ts';
import { MessageIds } from '../src/message-ids.ts';

const SELF = 790;
const general = { stream_id: 12, name: 'general' };
const privateStream = { stream_id: 13, name: 'private' };
const publicStream = { stream_id: 14, name: 'public' };
const raw = (id: number, name = 'general', stream_id = 12) => ({
  id, sender_id: 7, sender_full_name: 'Ann', sender_email: 'ann@example.invalid',
  type: 'stream', display_recipient: name, stream_id, subject: 'Topic',
  content: `message ${id}`, timestamp: 1700000000, flags: [],
});
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function drain() { for (let i = 0; i < 12; i++) await turn(); }

function planeFixture(env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zulip-subs-'));
  const plane = new FiltersPlane(join(dir, 'filters.json'), env);
  plane.start();
  return { dir, plane, close() { plane.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

async function eventFixture(env: NodeJS.ProcessEnv = { ZULIP_STREAMS_MODE: 'subscribed' }, activeTopics = 0) {
  const f = planeFixture(env);
  const incoming: any[] = [], reactions: any[] = [], changes: any[] = [], registrations: any[] = [];
  let subscriptionReads = 0, messageReads = 0;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let send!: (value: any) => void;
  const messages = new Map<number, any>();
  const client = {
    async callEndpoint(path: string, method: string) {
      subscriptionReads++;
      assert.equal(path, 'users/me/subscriptions'); assert.equal(method, 'GET');
      return { result: 'success', subscriptions: [general] };
    },
    queues: { async register(params: any) { registrations.push(params); return { queue_id: 'q', last_event_id: -1 }; } },
    events: { retrieve() { ready(); return new Promise<any>(resolve => { send = resolve; }); } },
    streams: { async retrieve() { return { streams: [general, privateStream, publicStream] }; }, topics: { async retrieve() { return { result: 'success', topics: [{ name: 'OLD SECRET TOPIC', max_id: 77 }] }; } } },
    users: { async retrieve() { return { result: 'success', members: [] }; } },
    messages: { async getById(p: any) { messageReads++; return { result: 'success', message: messages.get(p.message_id) }; }, async retrieve(_p: any) { return { result: 'success', messages: [...messages.values()], found_newest: true }; } },
  };
  const adapter = new ZulipAdapter(client, SELF, 'subs', { filters: f.plane, activeTopics });
  adapter.startEvents(m => incoming.push(m), undefined, r => reactions.push(r), c => changes.push(c));
  await started;
  return { ...f, client, adapter, incoming, reactions, changes, messages, registrations,
    get subscriptionReads() { return subscriptionReads; }, get messageReads() { return messageReads; },
    async batch(events: any[]) { send({ events }); await drain(); },
    close() { adapter.stopEvents(); send({ events: [] }); f.close(); },
  };
}

// Offline synthetic fixtures use Zulip's own-user add/remove and peer user id shapes.
test('subscribed public only; private add then message; remove immediately blocks messages, reactions, edits and deletes', async () => {
  const f = await eventFixture();
  try {
    assert.equal(f.subscriptionReads, 1);
    assert.equal(Object.hasOwn(f.registrations[0], 'all_public_streams'), false);
    assert.ok(f.registrations[0].event_types.includes('subscription'));
    await f.batch([
      { id: 1, type: 'message', message: raw(1) },
      { id: 2, type: 'message', message: raw(2, 'public', 14) },
      { id: 3, type: 'subscription', op: 'add', subscriptions: [privateStream] },
      { id: 4, type: 'message', message: raw(4, 'private', 13) },
    ]);
    assert.deepEqual(f.incoming.map(m => m.channelId), ['zulip:general', 'zulip:private']);
    assert.deepEqual((await f.adapter.discoverChannels()).filter(c => !c.id.startsWith('zulip:dm:')).map(c => c.id), ['zulip:general', 'zulip:private']);
    f.messages.set(4, raw(4, 'private', 13));
    await f.batch([
      { id: 5, type: 'subscription', op: 'remove', subscriptions: [privateStream] },
      { id: 6, type: 'message', message: raw(6, 'private', 13) },
      { id: 7, type: 'reaction', op: 'add', message_id: 4, user_id: 8, emoji_name: 'eyes' },
      { id: 8, type: 'update_message', message_id: 4, user_id: 8, stream_id: 13, orig_content: 'old', content: 'new' },
      { id: 9, type: 'delete_message', message_id: 4, message_type: 'stream', stream_id: 13 },
    ]);
    assert.equal(f.incoming.length, 2); assert.deepEqual(f.reactions, []); assert.deepEqual(f.changes, []);
    const gets = f.messageReads;
    assert.equal(await f.adapter.fetchContext('zulip:private', undefined, 10), null);
    assert.deepEqual((await f.adapter.fetchHistory('zulip:public', { limit: 10 })).messages, []);
    assert.equal(f.messageReads, gets);
  } finally { f.close(); }
});

test('mutes win and explicit streams narrow subscriptions; DM rules remain independent', async () => {
  const f = await eventFixture({ ZULIP_STREAMS_MODE: 'subscribed', ZULIP_STREAMS: 'general,public', ZULIP_MUTED_STREAMS: 'general', ZULIP_DM_USERS: '42' });
  try {
    await f.batch([
      { id: 1, type: 'subscription', op: 'add', subscriptions: [privateStream, publicStream] },
      ...[raw(2), raw(3, 'private', 13), raw(4, 'public', 14)].map(message => ({ id: message.id, type: 'message', message, flags: ['mentioned'] })),
      { id: 5, type: 'message', message: { ...raw(5), type: 'private', sender_id: 42, display_recipient: [{ id: 42, full_name: 'Bo', email: 'bo@example.invalid' }, { id: SELF, full_name: 'Bot', email: 'bot@example.invalid' }] } },
    ]);
    assert.deepEqual(f.incoming.map(m => m.channelId), ['zulip:public', 'zulip:dm:42']);
    f.plane.update(filters => ({ ...filters, mutedStreams: [] }));
    await f.batch([{ id: 6, type: 'message', message: raw(6) }]);
    assert.equal(f.incoming.at(-1).channelId, 'zulip:general');
  } finally { f.close(); }
});

test('unknown state fails closed, bounded GET retries, and queue replacement invalidates membership', async () => {
  const subscriptions = new Subscriptions('subscribed', { retryMs: 10, timeoutMs: 5 });
  let calls = 0;
  const client = { callEndpoint() {
    calls++;
    if (calls === 1) return new Promise(() => {}); // Timeout, not only returned API errors.
    return Promise.resolve({ result: 'success', subscriptions: [general] });
  } };
  try {
    await subscriptions.connect(client, SELF);
    assert.equal(subscriptions.status().known, false); assert.equal(subscriptions.allows(14), false);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('retry did not recover')), 200);
      subscriptions.onChange(() => { if (subscriptions.status().known) { clearTimeout(timer); resolve(); } });
    });
    assert.equal(calls, 2); assert.equal(subscriptions.allows(12), true);
    client.callEndpoint = async () => ({ result: 'error' } as any);
    await subscriptions.refresh(true);
    assert.equal(subscriptions.allows(12), false);
  } finally { subscriptions.stop(); }
  const f = planeFixture({ ZULIP_STREAMS_MODE: 'subscribed', ZULIP_STREAMS: 'general' });
  try { assert.equal(f.plane.streamAllowed('general'), false); assert.equal(f.plane.streamAllowed('public'), false); } finally { f.close(); }
});

test('peer events apply only to the bot, and an in-flight old snapshot cannot undo a removal', async () => {
  const subscriptions = new Subscriptions('subscribed');
  let resolve!: (value: any) => void;
  const client = { callEndpoint: async () => ({ result: 'success', subscriptions: [general] }) };
  try {
    await subscriptions.connect(client, SELF);
    subscriptions.apply({ op: 'peer_remove', stream_ids: [12], user_id: 42 });
    assert.equal(subscriptions.allows(12), true);
    subscriptions.apply({ op: 'peer_remove', stream_ids: [12], user_ids: [SELF] });
    assert.equal(subscriptions.allows(12), false);
    subscriptions.apply({ op: 'peer_add', stream_ids: [12], user_id: 42 });
    assert.equal(subscriptions.allows(12), false);
    subscriptions.apply({ op: 'peer_add', stream_ids: [12], user_id: SELF });
    assert.equal(subscriptions.allows(12), true);
    client.callEndpoint = () => new Promise(r => { resolve = r; });
    const pending = subscriptions.refresh();
    subscriptions.apply({ op: 'remove', subscriptions: [general] });
    resolve({ result: 'success', subscriptions: [general] }); await pending;
    assert.equal(subscriptions.allows(12), false);
  } finally { subscriptions.stop(); }
});

test('poll votes use fresh response and are dropped in unsubscribed streams even after a subscribed message', async () => {
  const f = await eventFixture();
  try {
    const init = { id: 1, msg_type: 'widget', sender_id: SELF, content: JSON.stringify({ widget_type: 'poll', extra_data: { question: 'Q?', options: ['Yes'] } }) };
    await f.batch([{ id: 1, type: 'message', message: { ...raw(77), sender_id: SELF, submessages: [init] } }]);
    f.messages.set(77, { ...raw(77, 'public', 14), sender_id: SELF, submessages: [init] });
    await f.batch([{ id: 2, type: 'submessage', submessage_id: 2, message_id: 77, sender_id: 7, msg_type: 'widget', content: JSON.stringify({ type: 'vote', key: 'canned,0', vote: 1 }) }]);
    assert.equal(f.messageReads, 1, 'a fresh GET is still required'); assert.deepEqual(f.incoming, []);
    await f.batch([{ id: 3, type: 'subscription', op: 'add', subscriptions: [publicStream] }]);
    await f.batch([{ id: 4, type: 'submessage', submessage_id: 3, message_id: 77, sender_id: 7, msg_type: 'widget', content: JSON.stringify({ type: 'vote', key: 'canned,0', vote: -1 }) }]);
    assert.equal(f.incoming.length, 1); assert.equal(f.incoming[0].channelId, 'zulip:public');
  } finally { f.close(); }
});

test('history tools and resources refuse unsubscribed streams, including tagged id lookups and fresh in-flight responses', async () => {
  const f = planeFixture({ ZULIP_STREAMS_MODE: 'subscribed' });
  let gets = 0, lists = 0;
  let rows = [raw(77, 'public', 14)];
  const client = {
    async callEndpoint() { return { result: 'success', subscriptions: [general] }; },
    messages: {
      async getById() { gets++; return { result: 'success', message: rows[0] }; },
      async retrieve() { lists++; return { result: 'success', messages: rows, found_newest: true }; },
    },
  };
  try {
    await f.plane.subscriptions.connect(client, SELF);
    const adapter = new ZulipAdapter(client, SELF, 'subs', { filters: f.plane });
    const runtime = new ZulipToolRuntime({ client, selfUserId: SELF, sessionId: 'subs', realm: '', authHeader: '' }, f.dir, { messageIds: new MessageIds('acme', 'strict') });
    new ZulipMcplServer(adapter, runtime, { serverInfo: { name: 'test', version: '0' }, filters: f.plane });
    for (const name of ['fetch_history', 'get_channel_history']) await assert.rejects(runtime.handleToolCall(name, { channel: 'public' }), /subscribed-stream policy/);
    assert.equal(lists, 0, 'named disallowed stream is refused without GET');
    for (const name of ['fetch_around', 'get_poll_results']) await assert.rejects(runtime.handleToolCall(name, { message_id: 'acme:77' }), /subscribed-stream policy/);
    assert.equal(gets, 2);
    const result = await runtime.handleToolCall('start_monitoring', { channels: ['public'] });
    assert.equal(result.channels[0].status, 'error'); assert.equal(lists, 0);
    rows = [raw(78)];
    const allowed = await runtime.handleToolCall('fetch_history', { channel: 'general' });
    assert.equal(allowed.count, 1); assert.match(allowed.formatted_history, /acme:78/);
    await runtime.handleToolCall('start_monitoring', { channels: ['general'] });
    const beforeResource = lists;
    f.plane.subscriptions.apply({ op: 'remove', subscriptions: [general] });
    await runtime.readResource('zulip://unread/summary');
    await assert.rejects(runtime.readResource('zulip://channel/general/unread'), /subscribed-stream policy/);
    assert.equal(lists, beforeResource, 'legacy resources cannot read a removed stream');
    f.plane.subscriptions.apply({ op: 'add', subscriptions: [general] });
    // A stale/nonsensical response must not smuggle a different public stream through a permitted narrow.
    rows = [raw(79, 'public', 14)];
    assert.equal((await runtime.handleToolCall('fetch_history', { channel: 'general' })).count, 0);
    // An unsubscribe while a message-id GET is pending must win over its response.
    let resolve!: (value: any) => void;
    client.messages.getById = () => new Promise(r => { resolve = r; });
    const pending = runtime.handleToolCall('fetch_around', { message_id: 'acme:78' });
    f.plane.subscriptions.apply({ op: 'remove', subscriptions: [general] });
    resolve({ result: 'success', message: raw(78) });
    await assert.rejects(pending, /subscribed-stream policy/);
    await assert.rejects(runtime.handleToolCall('fetch_history', { channel: 'general' }), /subscribed-stream policy/);
  } finally { f.close(); }
});

test('default mode still delivers unsubscribed public streams and makes no subscription reads', async () => {
  const f = await eventFixture({});
  try {
    await f.batch([{ id: 1, type: 'message', message: raw(1, 'public', 14) }]);
    assert.equal(f.subscriptionReads, 0); assert.equal(f.incoming.length, 1);
    assert.equal(f.registrations[0].all_public_streams, 'true');
    assert.equal(f.plane.streamAllowed('public'), true);
    assert.equal(f.plane.subscriptions.mode, 'all');
  } finally { f.close(); }
  assert.throws(() => new Subscriptions('typo'), /ZULIP_STREAMS_MODE/);
});

test('queue requests and handles stream rename/create/delete without granting old-name public streams', async () => {
  const f = await eventFixture();
  try {
    assert.ok(f.registrations[0].event_types.includes('stream'));
    await f.batch([
      { id: 1, type: 'stream', op: 'update', stream_id: 12, property: 'name', value: 'renamed' },
      { id: 2, type: 'stream', op: 'create', streams: [{ stream_id: 14, name: 'general' }] },
      { id: 3, type: 'message', message: raw(3, 'general', 14) },
      { id: 4, type: 'message', message: raw(4, 'renamed', 12) },
      // A forged/stale display name must not make ID 14 a member.
      { id: 5, type: 'message', message: raw(5, 'renamed', 14) },
      { id: 6, type: 'subscription', op: 'update', stream_id: 12, property: 'color', value: '#123456' },
      { id: 7, type: 'stream', op: 'delete', streams: [{ stream_id: 12, name: 'renamed' }] },
      { id: 8, type: 'message', message: raw(8, 'renamed', 12) },
    ]);
    assert.deepEqual(f.incoming.map(m => m.messageId), ['4']);
    assert.equal(f.plane.subscriptions.allows(12), false);
    assert.equal(f.plane.subscriptions.allows(14), false);
  } finally { f.close(); }
});


const quote = (id: number) => `[said](/#narrow/channel/14/near/${id}):\n\n\`\`\`quote\noriginal\n\`\`\`\nreply`;
const vote = (id: number, message_id = 77) => ({ id, type: 'submessage', submessage_id: id, message_id, sender_id: 7, msg_type: 'widget', content: JSON.stringify({ type: 'vote', key: 'canned,0', vote: 1 }) });

test('unauthorized live messages never enter placement, poll, topic or cursor caches; cached quote sources are authorized independently', async () => {
  const f = await eventFixture(undefined, 3);
  try {
    const forbidden = { ...raw(88, 'public', 14), sender_id: SELF };
    await f.batch([{ id: 1, type: 'message', message: forbidden }]);
    const a = f.adapter as any;
    assert.equal(a.seen.has(88), false);
    assert.equal(a.highestMessageId, 0);
    assert.equal(a.polls.records.size, 0);
    assert.equal(a.activeTopics.streams.has(14), false);
    a.remember('zulip:public', normalizeMessage(forbidden));
    assert.equal(a.seen.has(88), false, 'history/GET cache admission has the same guard');
    // Simulate a stale cache from before the fix: readers must not trust admission alone.
    a.seen.set(88, { ...normalizeMessage(forbidden), channelId: 'zulip:public', quoteTargets: new Set(), replyToSelf: false });
    await f.batch([{ id: 2, type: 'message', message: { ...raw(89), content: quote(88) } }]);
    assert.equal(f.incoming[0].metadata.replyToSelf, false);
    assert.equal(f.incoming[0].metadata.isReplyToBot, false);
    assert.ok(!f.incoming[0].tags.includes('chat:reply'));
    f.messages.set(90, { ...raw(90), content: quote(88) });
    const history = await f.adapter.fetchHistory('zulip:general', { limit: 10 });
    assert.equal(history.messages[0].metadata?.replyToSelf, false);
  } finally { f.close(); }
});

for (const unknown of [false, true]) {
  test(`${unknown ? 'unknown state' : 'unsubscribe'} purges messages and topic lists; quote/poll/history cannot reuse old data after resubscribe`, async () => {
    const f = await eventFixture(undefined, 3);
    try {
      const init = { id: 1, msg_type: 'widget', sender_id: SELF, content: JSON.stringify({ widget_type: 'poll', extra_data: { question: 'OLD SECRET POLL?', options: ['Yes'] } }) };
      await f.batch([
        { id: 1, type: 'subscription', op: 'add', subscriptions: [publicStream] },
        { id: 2, type: 'message', message: { ...raw(77, 'public', 14), submessages: [init] } },
        { id: 3, type: 'message', message: { ...raw(88, 'public', 14), sender_id: SELF } },
        { id: 4, type: 'message', message: { ...raw(89), content: quote(88) } },
      ]);
      const a = f.adapter as any;
      assert.ok(a.seen.has(88));
      assert.ok(a.activeTopics.streams.get(14).ready);
      assert.equal(f.incoming.at(-1).metadata.replyToSelf, true);
      assert.deepEqual(f.incoming.at(-1).metadata.readStreamIds, [14]);
      if (unknown) {
        f.client.callEndpoint = async () => ({ result: 'error' } as any);
        await f.plane.subscriptions.refresh(true);
      } else f.plane.subscriptions.apply({ op: 'remove', stream_ids: [14] });
      assert.equal(a.seen.has(77), false);
      assert.equal(a.seen.has(88), false);
      assert.equal(a.activeTopics.streams.has(14), false);
      assert.equal(a.streamNamesById.has(14), false);
      assert.equal(a.polls.records.size, 0, 'subscribed polls retain no unscoped records');
      if (!unknown) assert.equal(a.seen.get(89).replyToSelf, false, 'derived verdict revoked too');
      assert.equal(await f.adapter.fetchContext('zulip:public', undefined, 10), null);
      assert.deepEqual((await f.adapter.fetchHistory('zulip:public', { limit: 10 })).messages, []);
      const before = f.incoming.length;
      f.messages.set(77, { ...raw(77, 'public', 14), submessages: [init] });
      await f.batch([vote(5)]);
      assert.equal(f.incoming.length, before);
      if (unknown) {
        f.client.callEndpoint = async () => ({ result: 'success', subscriptions: [general, publicStream] });
        await f.plane.subscriptions.refresh();
      } else await f.batch([{ id: 6, type: 'subscription', op: 'add', subscriptions: [publicStream] }]);
      // Old message/poll state must stay gone after regrant; only a fresh response counts.
      f.messages.set(77, raw(77, 'public', 14));
      await f.batch([vote(7)]);
      assert.equal(f.incoming.length, before);
      await f.batch([{ id: 8, type: 'message', message: { ...raw(90), content: quote(88) } }]);
      assert.equal(f.incoming.at(-1).metadata.replyToSelf, false);
      f.messages.clear(); f.messages.set(91, { ...raw(91), content: quote(88) });
      assert.equal((await f.adapter.fetchHistory('zulip:general', { limit: 10 })).messages[0].metadata?.replyToSelf, false);
      assert.equal(f.registrations.length, 1, 'Zulip updates subscriptions on a live queue, including re-add');
    } finally { f.close(); }
  });
}

test('revocation after quote classification but before live emission treats the dependency as absent', async () => {
  const f = await eventFixture();
  try {
    await f.batch([
      { id: 1, type: 'subscription', op: 'add', subscriptions: [publicStream] },
      { id: 2, type: 'message', message: { ...raw(88, 'public', 14), sender_id: SELF } },
    ]);
    const a = f.adapter as any;
    const classify = a.classifyQuoteReply.bind(a);
    a.classifyQuoteReply = async (...args: any[]) => {
      const verdict = await classify(...args);
      f.plane.subscriptions.apply({ op: 'remove', stream_ids: [14] });
      return verdict;
    };
    await f.batch([{ id: 3, type: 'message', message: { ...raw(90), content: quote(88) } }]);
    assert.equal(f.incoming[0].metadata.replyToSelf, false);
  } finally { f.close(); }
});
