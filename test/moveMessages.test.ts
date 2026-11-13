import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZulipToolRuntime } from '../src/tool-runtime.ts';
import { ZulipAdapter } from '../src/platforms/zulip.ts';
import { ZulipMcplServer } from '../src/server.ts';
import { StreamDirectory } from '../src/stream-directory.ts';
import { streamKey } from '../src/channel-key.ts';
import { MessageIds } from '../src/message-ids.ts';
import { ZulipNoAnswer } from '../src/zulip-api.ts';
import { standInApi } from './zulip-stand-in.ts';

const raw = (topic = 'original', stream_id = 12) => ({ id: 7, stream_id, subject: topic, display_recipient: stream_id === 12 ? 'general' : 'other', type: 'stream', content: 'hello', sender_id: 9, sender_full_name: 'Test User', sender_email: 'user@example.invalid', timestamp: 1700000000 });
function fixture(t: any) {
  let current = raw(); let confirmed = true; let patchFailure: unknown; let beforePatch: (() => void) | undefined;
  const { api, calls } = standInApi({
    'GET /messages/:id': () => { if (!confirmed && calls.some(c => c.method === 'PATCH')) throw new Error('unavailable'); return { result: 'success', message: current }; },
    'PATCH /messages/:id': (p: any) => { beforePatch?.(); if (patchFailure) throw patchFailure; current = raw(p.topic ?? current.subject, p.stream_id ?? current.stream_id); return { result: 'success' }; },
    'POST /messages': { result: 'success', id: 20 },
  });
  const dir = mkdtempSync(join(tmpdir(), 'move-messages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const directory = new StreamDirectory(); directory.list([{ stream_id: 12, name: 'general' }, { stream_id: 13, name: 'other' }]);
  const tools = new ZulipToolRuntime({ api, selfUserId: 1, realm: 'https://alpha.example.invalid', authHeader: '', sessionId: 'test' }, dir, { messageIds: new MessageIds('alpha', 'strict') });
  const adapter = new ZulipAdapter(api, 1, 'test', { directory });
  const server = new ZulipMcplServer(adapter, tools, { serverInfo: { name: 'test', version: '1' }, directory });
  const manager = server.channelManager;
  const note = (id: number, topic = 'original', stream = 12) => manager.noteConversation(streamKey(stream), { messageId: String(id), threadId: topic, metadata: { topic } });
  const hints = (stream = 12) => (manager as any).lastIncoming.get(streamKey(stream));
  return { tools, calls, manager, note, hints, failConfirm: () => { confirmed = false; }, failPatch: (e: unknown) => { patchFailure = e; }, duringPatch: (fn: () => void) => { beforePatch = fn; } };
}

test('move_messages sends only move fields in native PATCH, accepts tagged anchor and empty topic', async t => {
  const f = fixture(t); f.note(7);
  const moved = await f.tools.handleToolCall('move_messages', { message_id: 'alpha:7', topic: '', propagate_mode: 'change_all' });
  assert.deepEqual(f.calls.find(c => c.method === 'PATCH')?.params, { topic: '', propagate_mode: 'change_all' });
  assert.equal(moved.moved_to.topic, '');
  assert.equal(moved.moved_to.stream, 'general');
  assert.equal(f.hints().hints.threadId, '');
  assert.deepEqual(f.calls.map(c => `${c.method} ${c.path}`), ['GET /messages/7', 'PATCH /messages/7', 'GET /messages/7']);
});

test('move validation rejects unsupported combinations and foreign IDs before all API calls', async t => {
  const f = fixture(t);
  for (const args of [{ topic: null }, { stream_id: 0 }, { propagate_mode: 'bad', topic: 'x' }, { content: 'x', topic: 'x' }, {}]) {
    await assert.rejects(f.tools.handleToolCall('move_messages', { message_id: 'alpha:7', ...args }));
  }
  await assert.rejects(f.tools.handleToolCall('move_messages', { message_id: 'beta:7', topic: 'x' }), /differs/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.tools.handleToolCall('edit_message', { message_id: 'alpha:7', content: 'x', topic: 'x' }), /move_messages/);
});

test('propagation affects only matching original topic/range and never clobbers a newer concurrent conversation', async t => {
  const f = fixture(t); f.note(8);
  await f.tools.handleToolCall('move_messages', { message_id: 'alpha:7', topic: 'new', propagate_mode: 'change_one' });
  assert.equal(f.hints().hints.threadId, 'original', 'unmoved later anchor is unchanged');
  const g = fixture(t); g.note(8);
  await g.tools.handleToolCall('move_messages', { message_id: 'alpha:7', topic: 'new', propagate_mode: 'change_later' });
  assert.equal(g.hints().hints.threadId, 'new');
  const h = fixture(t); h.note(8); h.duringPatch(() => h.note(9, 'newer'));
  await h.tools.handleToolCall('move_messages', { message_id: 'alpha:7', topic: 'new', propagate_mode: 'change_all' });
  assert.equal(h.hints().hints.threadId, 'newer');
});

test('cross-stream move fences old source publishes; old replay/marker cannot clear refusal or retarget destination', async t => {
  const f = fixture(t); f.note(8); f.note(100, 'newer destination', 13);
  await f.tools.handleToolCall('move_messages', { message_id: 'alpha:7', stream_id: 13, topic: 'moved', propagate_mode: 'change_all' });
  assert.equal((f.manager as any).moveRefusals.has(streamKey(12)), true);
  assert.equal(f.hints(13).hints.threadId, 'newer destination');
  assert.equal(f.note(7), false);
  assert.equal(f.manager.noteConversation(streamKey(12), { messageId: 'poll:7:10', threadId: 'original', metadata: { pollVote: true } }), false);
  assert.equal((f.manager as any).moveRefusals.has(streamKey(12)), true);
  assert.equal(f.note(9, 'fresh'), true);
  assert.equal((f.manager as any).moveRefusals.has(streamKey(12)), false);
});

test('confirmation failure returns success with unresolved receipt and no automatic repeat; ambiguous PATCH fences routing', async t => {
  const f = fixture(t); f.note(7); f.failConfirm();
  const moved = await f.tools.handleToolCall('move_messages', { message_id: 'alpha:7', topic: 'new' });
  assert.equal(moved.result, 'success');
  assert.equal(moved.moved_to.topic, null);
  assert.match(moved.routing_note, /Do not repeat/);
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1);
  assert.equal((f.manager as any).moveRefusals.has(streamKey(12)), true);
  const g = fixture(t); g.note(7); g.failPatch(new ZulipNoAnswer('timeout', 'PATCH', '/messages/7', true, 'timeout'));
  await assert.rejects(g.tools.handleToolCall('move_messages', { message_id: 'alpha:7', topic: 'new' }));
  assert.equal((g.manager as any).moveRefusals.has(streamKey(12)), true);
});

// These tests explicitly exercise the opt-in surface, never the default one.
const previousFlag = process.env.ZULIP_MOVE_MESSAGES;
before(() => { process.env.ZULIP_MOVE_MESSAGES = '1'; });
after(() => { if (previousFlag === undefined) delete process.env.ZULIP_MOVE_MESSAGES; else process.env.ZULIP_MOVE_MESSAGES = previousFlag; });
