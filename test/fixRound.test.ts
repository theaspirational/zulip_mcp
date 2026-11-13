import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ZulipEventLoop } from '../src/platforms/zulip-events.ts';
import { StreamReadGate } from '../src/stream-read-gate.ts';
import { FiltersPlane } from '../src/filters.ts';
import { ZulipToolRuntime } from '../src/tool-runtime.ts';
import { ZulipAdapter } from '../src/platforms/zulip.ts';
import { ZulipMcplServer } from '../src/server.ts';
import { streamKey } from '../src/channel-key.ts';
import { standInApi } from './zulip-stand-in.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));
const raw = (id: number) => ({ id, stream_id: 12, type: 'stream', display_recipient: 'allowed', subject: 'topic', content: 'hello', timestamp: 1700000000, sender_id: 9 });

// Delivery checks are deferred, like the adapter's channel-lane jobs: an event
// preceding the remove must remain fenced even when the batch ends subscribed.
test('regrant batch advances epochs in order for messages, votes, reactions and changes', async t => {
  const before = process.env.ZULIP_POLLS;
  process.env.ZULIP_POLLS = '1';
  t.after(() => { if (before === undefined) delete process.env.ZULIP_POLLS; else process.env.ZULIP_POLLS = before; });
  let allowed = true;
  const gate = new StreamReadGate({ allows: id => id === 12 && allowed, ids: () => [12], known: () => true, resolveName: () => 12 });
  const seen: { kind: string; epoch: number }[] = [];
  let polls = 0;
  const loop = new ZulipEventLoop({ readEpoch: () => gate.checkpoint(), onSubscription: event => { allowed = event.op === 'add'; gate.policyChanged(); } });
  const { api } = standInApi({
    'POST /register': { queue_id: 'q', last_event_id: -1 },
    'GET /events': () => {
      if (polls++ === 0) return { events: [
        { id: 1, type: 'message', message: raw(87) },
        { id: 2, type: 'subscription', op: 'remove', stream_ids: [12] },
        { id: 3, type: 'subscription', op: 'add', subscriptions: [{ stream_id: 12, name: 'allowed' }] },
        { id: 4, type: 'message', message: raw(88) },
        { id: 5, type: 'reaction', message_id: 88, op: 'add', user_id: 9 },
        { id: 6, type: 'update_message', message_id: 88, orig_content: 'old', content: 'new', stream_id: 12 },
        { id: 7, type: 'submessage', message_id: 88, submessage_id: 1, sender_id: 9, msg_type: 'widget', content: '{}' },
      ] };
      if (polls === 2) return { events: [{ id: 8, type: 'message', message: raw(89) }] };
      loop.stop(); return { events: [] };
    },
  });
  await loop.start(api, (_name, m) => { seen.push({ kind: String(m.id), epoch: (m as any).readEpoch }); }, undefined,
    r => { seen.push({ kind: 'reaction', epoch: r.readEpoch! }); },
    c => { seen.push({ kind: 'change', epoch: c.readEpoch! }); },
    s => { seen.push({ kind: 'vote', epoch: s.readEpoch! }); });
  assert.deepEqual(seen.filter(s => gate.fresh(12, s.epoch)).map(s => s.kind), ['88', 'reaction', 'change', 'vote', '89']);
  assert.deepEqual(seen.map(s => s.epoch), [0, 2, 2, 2, 2, 2]);
});

for (const view of ['resources/list', 'resource read', 'tool call', 'persisted monitoring']) {
  test(`held stream lane retains monitoring through revoke + ${view}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-round-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { api } = standInApi({
      'GET /users/me/subscriptions': { result: 'success', subscriptions: [{ stream_id: 12, name: 'allowed' }] },
      'GET /messages': { result: 'success', messages: [raw(88)] },
    });
    const filters = new FiltersPlane(join(dir, 'filters.json'), { ZULIP_STREAMS_MODE: 'subscribed' });
    t.after(() => { filters.stop(); filters.subscriptions.stop(); });
    const tools = new ZulipToolRuntime({ api, selfUserId: 1, sessionId: 'test' } as any, dir);
    const adapter = new ZulipAdapter(api, 1, 'test', { filters });
    const server = new ZulipMcplServer(adapter, tools, { filters, stateDir: null, serverInfo: { name: 'test', version: '1' } });
    await filters.subscriptions.connect(api, 1);
    await tools.handleToolCall('start_monitoring', { channels: ['allowed'] });
    const lanes = (server as any).makeLanes(); (server as any).lanes = lanes;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    t.after(() => release());
    lanes.lane(streamKey(12)).enterRead(async () => { await held; });
    await turn();
    const retained = (tools as any).monitoredChannels;
    const state = retained.get('allowed');
    assert.ok(state);
    if (view === 'persisted monitoring') { delete state.streamId; delete state.readEpoch; }
    filters.subscriptions.apply({ op: 'remove', stream_ids: [12] });
    const result = view === 'resources/list' ? tools.listResources() : view === 'resource read'
      ? await tools.readResource('zulip://monitoring/status') : await tools.handleToolCall('get_monitored_channels', {});
    assert.doesNotMatch(JSON.stringify(result), /allowed/);
    assert.equal(retained.get('allowed'), state, 'views must not bypass the held lane');
    release(); await lanes.quiet();
    assert.equal(retained.has('allowed'), false, 'the queued channel-owned purge deletes after the read');
  });
}

for (const [extra, expected] of [
  [{ type: 'stream' }, 'reply_to 77: type disagrees with the referenced message'],
  [{ topic: 'no topic' }, 'reply_to 77 is a direct message, which has no topic; omit topic'],
] as const) {
  test(`no-env reply diagnostic matches a2bfec12: ${expected}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-default-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { api, calls } = standInApi({ 'GET /messages/:id': { result: 'success', message: { id: 77, type: 'private' } } });
    const tools = new ZulipToolRuntime({ api, selfUserId: 1, sessionId: 'test' } as any, dir);
    await assert.rejects(tools.handleToolCall('send_message', { reply_to: 77, content: 'hello', ...extra }), { message: expected });
    assert.deepEqual(calls.map(c => c.method), ['GET']);
  });
}


test('no-env reply refusal without msg preserves upstream unknown-error fallback', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-refusal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { api } = standInApi({ 'GET /messages/:id': { result: 'error', code: 'INVALID_MESSAGE_ID' } });
  const tools = new ZulipToolRuntime({ api, selfUserId: 1, sessionId: 'test' } as any, dir);
  await assert.rejects(tools.handleToolCall('send_message', { reply_to: 77, content: 'hello' }),
    { message: 'Zulip refused reply_to 77 (INVALID_MESSAGE_ID): unknown error' });
});
