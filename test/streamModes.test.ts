import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Subscriptions, parseStreamsMode } from '../src/subscriptions.ts';
import { StreamReadGate } from '../src/stream-read-gate.ts';
import { FiltersPlane } from '../src/filters.ts';
import { ZulipToolRuntime } from '../src/tool-runtime.ts';
import { ZulipAdapter } from '../src/platforms/zulip.ts';
import { ZulipMcplServer } from '../src/server.ts';
import { StreamDirectory } from '../src/stream-directory.ts';
import { streamKey } from '../src/channel-key.ts';
import { standInApi } from './zulip-stand-in.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));
const raw = (id = 7, stream_id = 12) => ({ id, stream_id, type: 'stream', display_recipient: stream_id === 12 ? 'allowed' : 'hidden', subject: 'neutral topic', content: 'test content', sender_id: 9, sender_full_name: 'Test User', sender_email: 'user@example.invalid', timestamp: 1700000000 });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function gateFixture() {
  let allowed = new Set([12, 13]);
  const gate = new StreamReadGate({ allows: id => id !== undefined && allowed.has(id), resolveName: name => ({ allowed: 12, hidden: 13 }[name]), known: () => true, ids: () => [...allowed] });
  return { gate, set: (ids: number[]) => { allowed = new Set(ids); gate.policyChanged(); } };
}
async function fixture(t: any, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stream-modes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const streams = [{ stream_id: 12, name: 'allowed' }, { stream_id: 13, name: 'hidden' }];
  const { api, calls } = standInApi({
    'GET /users/me/subscriptions': { result: 'success', subscriptions: [streams[0]] },
    'GET /streams': { result: 'success', streams },
    'GET /messages': { result: 'success', messages: [raw(), raw(8, 13)], found_oldest: true, found_newest: true },
    'GET /messages/:id': (_: any, c: any) => ({ result: 'success', message: raw(c.id, c.id === 8 ? 13 : 12) }),
    'GET /users/me/:id/topics': { result: 'success', topics: [{ name: 'neutral topic', max_id: 7 }] },
    'POST /messages': { result: 'success', id: 20 },
    'GET /users': { result: 'success', members: [] },
    'GET /get_stream_id': (p: any) => ({ result: 'success', stream_id: p.stream === 'allowed' ? 12 : 13 }),
  });
  const filters = new FiltersPlane(join(dir, 'filters.json'), { ZULIP_STREAMS_MODE: 'subscribed' }); filters.start();
  t.after(() => { filters.stop(); filters.subscriptions.stop(); });
  const directory = new StreamDirectory(); directory.list(streams);
  const tools = new ZulipToolRuntime({ api, selfUserId: 1, realm: 'https://alpha.example.invalid', authHeader: '', sessionId: 'test' }, dir);
  const adapter = new ZulipAdapter(api, 1, 'test', { directory, filters, ...options });
  const server = new ZulipMcplServer(adapter, tools, { serverInfo: { name: 'test', version: '1' }, filters, directory, stateDir: null });
  await filters.subscriptions.connect(api, 1);
  return { api, calls, filters, directory, tools, adapter, server, gate: (server as any).streamGate as StreamReadGate };
}

test('list/subscribed/public parse strictly; public ignores stream list but mutes remain', t => {
  assert.equal(parseStreamsMode(undefined), 'list');
  assert.throws(() => parseStreamsMode('all'), /ZULIP_STREAMS_MODE/);
  const list = new FiltersPlane('/unused', { ZULIP_STREAMS: 'allowed' });
  const pub = new FiltersPlane('/unused', { ZULIP_STREAMS_MODE: 'public', ZULIP_STREAMS: 'allowed', ZULIP_MUTED_STREAMS: 'hidden' });
  assert.equal(list.streamAllowed('hidden'), false);
  assert.equal(pub.streamAllowed('hidden'), true);
  assert.equal(pub.streamMuted('hidden'), true);
});

test('subscriptions fail closed, reconcile events by receiving user and never infer public membership', async () => {
  const s = new Subscriptions('subscribed');
  assert.equal(s.allows(12), false);
  const { api } = standInApi({ 'GET /users/me/subscriptions': { result: 'success', subscriptions: [{ stream_id: 12, name: 'allowed' }] } });
  await s.connect(api, 1); s.stop();
  s.observe([{ stream_id: 13, name: 'hidden' }]);
  assert.equal(s.allows(13), false);
  s.apply({ op: 'peer_add', user_id: 2, subscriptions: [{ stream_id: 13, name: 'hidden' }] });
  assert.equal(s.allows(13), false);
  s.apply({ op: 'remove', stream_ids: [12] });
  assert.equal(s.allows(12), false);
  s.apply({ op: 'add', subscriptions: [{ stream_id: 13, name: 'hidden' }] });
  assert.equal(s.allows(13), true);
  s.invalidate(); assert.equal(s.allows(13), false);
});

test('native gate pins stream names to immutable IDs and projects cross-stream and verbose lists', async () => {
  const f = gateFixture(); f.set([12]);
  const { api, calls } = standInApi({ 'GET /messages': { result: 'success', messages: [raw(), raw(8, 13)] }, 'GET /streams': { result: 'success', streams: [{ stream_id: 12 }, { stream_id: 13 }] } });
  const scoped = f.gate.api(api);
  const result = await f.gate.run(() => scoped.request<any>('GET', '/messages', 'history', { narrow: [['stream', 'allowed']] }));
  assert.deepEqual(calls[0].params.narrow, [{ operator: 'stream', operand: 12 }]);
  assert.equal(result.messages.length, 1);
  const listed = await scoped.request<any>('GET', '/streams', 'streams', { include_public: true });
  assert.equal(calls[1].params.include_public, false);
  assert.deepEqual(listed.streams, [{ stream_id: 12 }]);
  await assert.rejects(f.gate.run(() => scoped.request('GET', '/messages', 'history', { narrow: [['stream', 'hidden']] })), /policy/);
  assert.equal(calls.length, 2);
});

test('revocation/regrant fences in-flight GETs, nested scopes and retained snapshots', async () => {
  const f = gateFixture();
  const pending = deferred<any>();
  const { api } = standInApi({ 'GET /messages/:id': () => pending.promise });
  const read = f.gate.run(() => f.gate.api(api).request('GET', '/messages/7', 'message'));
  await turn(); f.set([13]); f.set([12, 13]); pending.resolve({ result: 'success', message: raw() });
  await assert.rejects(read, /revoked snapshot/);
  const blocker = deferred<void>();
  const outer = f.gate.run(async () => { await f.gate.run(async () => f.gate.assert(12)); await blocker.promise; return 'stale'; });
  await turn(); f.set([13]); f.set([12, 13]); blocker.resolve();
  await assert.rejects(outer, /revoked snapshot/);
  const epoch = f.gate.checkpoint(); f.set([12]);
  assert.equal(f.gate.fresh(12, epoch), true, 'unrelated changes do not revoke permitted snapshots');
});

test('runtime, cached status, resources, polls and server filters share one policy', async t => {
  const f = await fixture(t);
  const history = await f.tools.handleToolCall('fetch_history', { channel: 'allowed' });
  assert.equal(history.count, 1);
  await assert.rejects(f.tools.handleToolCall('fetch_history', { channel: 'hidden' }), /policy/);
  await assert.rejects(f.tools.handleToolCall('fetch_around', { message_id: 8 }), /policy/);
  const listed = await f.tools.handleToolCall('list_streams', { verbose: true });
  assert.deepEqual(listed.stream_ids, { allowed: 12 });
  assert.doesNotMatch(JSON.stringify(listed), /hidden/);
  const filters = await (f.server as any).serverTool('filters_get', {});
  assert.doesNotMatch(JSON.stringify(filters), /hidden/);
  await f.tools.handleToolCall('start_monitoring', { channels: ['allowed'] });
  assert.match(JSON.stringify(f.tools.listResources()), /allowed/);
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12] });
  assert.doesNotMatch(JSON.stringify(await f.tools.handleToolCall('get_monitored_channels', {})), /allowed/);
  assert.doesNotMatch(JSON.stringify(f.tools.listResources()), /allowed/);
  assert.doesNotMatch(JSON.stringify(await f.tools.readResource('zulip://monitoring/status')), /allowed/);
});

test('subscription purge drops batches, replay state, hints and retained messages across regrant', async t => {
  const f = await fixture(t);
  const key = streamKey(12);
  const epoch = f.gate.checkpoint();
  const message: any = { key, messageId: '7', threadId: 'neutral topic', timestamp: new Date().toISOString(), author: { id: '9', name: 'Test User' }, content: [{ type: 'text', text: 'test content' }], metadata: { readEpoch: epoch, streamId: 12 } };
  (f.server as any).preLive.push({ message });
  f.server.delivery.advance(key, 7);
  f.server.channelManager.noteConversation(key, message);
  assert.equal((f.server as any).isAllowed(key, message), true);
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12] });
  assert.equal((f.server as any).preLive.length, 0);
  assert.equal(f.server.delivery.watermark(key), undefined);
  assert.equal((f.server.channelManager as any).lastIncoming.has(key), false);
  f.filters.subscriptions.apply({ op: 'add', subscriptions: [{ stream_id: 12, name: 'allowed' }] });
  assert.equal((f.server as any).isAllowed(key, message), false);
  assert.equal((f.server as any).isAllowed(key, { ...message, metadata: { readEpoch: f.gate.checkpoint() } }), true);
});

test('subscribed opens do not autojoin and attachment reads require fresh message provenance', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.ensureSubscribed(streamKey(13)), /policy/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  await assert.rejects(f.tools.handleToolCall('fetch_attachment', { path: '/user_uploads/1/test.txt' }), /message_id/);
  await assert.rejects(f.tools.handleToolCall('fetch_attachment', { path: '/user_uploads/1/test.txt', message_id: 8 }), /policy/);
});

test('a placement lookup cannot repopulate stale caches after an awaited name resolution', async t => {
  const f = await fixture(t);
  const blocked = deferred<any>();
  (f.adapter as any).keyFor = () => blocked.promise;
  const lookup = (f.adapter as any).locate(7);
  await turn();
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12] });
  f.filters.subscriptions.apply({ op: 'add', subscriptions: [{ stream_id: 12, name: 'allowed' }] });
  blocked.resolve(streamKey(12));
  assert.equal(await lookup, null);
  assert.equal((f.adapter as any).seen.has(7), false);
});

test('channel publish cannot reuse a revoked routing snapshot or its cached dependencies', async t => {
  const f = await fixture(t);
  const epoch = f.gate.checkpoint();
  f.filters.subscriptions.apply({ op: 'remove', stream_ids: [12] });
  f.filters.subscriptions.apply({ op: 'add', subscriptions: [{ stream_id: 12, name: 'allowed' }] });
  await assert.rejects(f.gate.run(() => f.adapter.publish(streamKey(12), undefined, [{ type: 'text', text: 'hello' }], { threadId: 'old', metadata: { readEpoch: epoch } })), /revoked snapshot/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});


test('subscribed mode preserves disabled active-topic hints', async t => {
  const f = await fixture(t, { activeTopics: 0 });
  const message = { key: streamKey(12), messageId: '7', timestamp: new Date().toISOString(), threadId: 'topic', author: { id: '9', name: 'Test User' }, content: [{ type: 'text', text: 'hello' }], metadata: { topic: 'topic' } };
  assert.equal((f.adapter as any).activeTopics.decorate(message, 12), message);
  await turn();
  assert.equal(f.calls.filter(c => c.path.endsWith('/topics')).length, 0);
});
