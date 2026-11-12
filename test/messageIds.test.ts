import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageIds, idToolDefinitions, type IdMode } from '../src/message-ids.ts';
import { ZulipToolRuntime, formatHistoryLines, formatMessages } from '../src/tool-runtime.ts';
import { initializeZulipClient } from '../src/zulip-client.ts';
import { normalizeMessage, toIncoming, dmDescriptor, dmCounterparts } from '../src/history.ts';
import { attributeMessage, renderMissedBlock, viewOf, DeliveryState } from '../src/delivery.ts';
import { ZulipAdapter } from '../src/platforms/zulip.ts';
import { ZulipEventLoop } from '../src/platforms/zulip-events.ts';
import { ZulipMcplServer } from '../src/server.ts';
import { toolDefinitions } from '../src/tools.ts';

const raw = (realm = 'alpha') => ({ id: 7, type: 'stream', stream_id: 12, display_recipient: 'general', subject: 'topic',
  content: `hello ${realm}`, sender_id: 9, sender_full_name: 'Ada Lovelace', sender_email: 'v@example.invalid', timestamp: 1700000000 });

function fixture(t: TestContext, tag: string, mode: IdMode) {
  const calls: { op: string; args: any }[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'zulip-ids-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = (op: string, result: any) => async (args: any) => { calls.push({ op, args }); return result; };
  const client = { callEndpoint: record('destination', { result: 'success', stream_id: 12 }), messages: {
    getById: record('get', { result: 'success', message: raw(tag) }),
    retrieve: record('history', { result: 'success', messages: [raw(tag)], found_oldest: true, found_newest: true }),
    send: record('send', { result: 'success', id: 7 }), deleteById: record('delete', { result: 'success' }),
  }, reactions: { add: record('add', { result: 'success' }), remove: record('remove', { result: 'success' }) } };
  const previousFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: any, options: any) => {
    if (new URL(String(url)).hostname !== `${tag}.example.invalid`) return previousFetch(url, options);
    calls.push({ op: 'patch', args: { url, body: options.body } });
    return new Response(JSON.stringify({ result: 'success' }), { status: 200 });
  });
  const ids = new MessageIds(tag, mode);
  const tools = new ZulipToolRuntime({ client, selfUserId: 1, realm: `https://${tag}.example.invalid`, authHeader: 'Basic test', sessionId: tag }, dir, {
    messageIds: ids, formatTime: () => 'T',
    uploader: { upload: async () => { calls.push({ op: 'upload', args: {} }); return { uri: '/user_uploads/x', name: 'x' }; } } as any,
  });
  tools.onDeleted = id => calls.push({ op: 'onDeleted', args: id });
  tools.onMoveStarted = id => { calls.push({ op: 'onMoveStarted', args: id }); return new Map(); };
  return { tools, calls, dir, client, ids };
}

const fields = [
  ['send_message', 'reply_to', { content: 'hi' }],
  ['edit_message', 'message_id', { content: 'hi' }],
  ['move_messages', 'message_id', { topic: 'other' }],
  ['delete_message', 'message_id', {}],
  ['add_reaction', 'message_id', { emoji_name: 'eyes' }],
  ['remove_reaction', 'message_id', { emoji_name: 'eyes' }],
  ['fetch_around', 'message_id', {}],
  ['fetch_history', 'before', { channel: 'general' }],
  ['fetch_history', 'after', { channel: 'general' }],
] as const;

for (const mode of ['legacy', 'compat', 'strict'] as const) {
  for (const [name, field, args] of fields) {
    test(`${mode}: ${name}.${field} own/foreign/bare with two realms sharing id 7`, async t => {
      const a = fixture(t, 'alpha', mode);
      const b = fixture(t, 'beta', mode);
      const logs: unknown[][] = [];
      t.mock.method(console, 'error', (...items) => { logs.push(items); });
      for (const value of ['alpha:7', 'beta:7', 7]) {
        a.calls.length = 0; logs.length = 0;
        const run = () => a.tools.handleToolCall(name, { ...args, [field]: value });
        if (mode === 'legacy') {
          // Frozen baseline: legacy never interprets tags. The old delete/reaction
          // handlers pass strings through; history bounds ignore them; others refuse.
          const accepts = typeof value === 'number' || ['delete_message', 'add_reaction', 'remove_reaction', 'fetch_history'].includes(name);
          if (accepts) await run(); else await assert.rejects(run());
          assert.equal(logs.length, 0);
          if (typeof value === 'string' && ['delete_message', 'add_reaction', 'remove_reaction'].includes(name)) {
            assert.equal(a.calls.at(-1)!.args.message_id, value);
          }
          continue;
        }
        if (value === 'beta:7' || (value === 7 && mode === 'strict')) {
          await assert.rejects(run(), value === 'beta:7'
            ? { message: 'message_id tag "beta" differs from this server\'s "alpha"; use the matching server' }
            : /bare message_id is refused/);
          assert.deepEqual(a.calls, [], 'no API call, callback, upload or write on refusal');
          assert.deepEqual(readdirSync(a.dir), []);
        } else {
          const result = await run();
          assert.ok(a.calls.length > 0);
          assert.equal(result.warnings?.length ?? 0, value === 7 ? 1 : 0);
          assert.equal(logs.length, value === 7 ? 1 : 0);
          for (const c of a.calls) if (c.args?.message_id !== undefined) assert.equal(c.args.message_id, 7);
          if (name === 'fetch_history') assert.equal(a.calls[0].args.anchor, 7);
        }
      }
      if (mode !== 'legacy') {
        b.calls.length = 0;
        await assert.rejects(b.tools.handleToolCall(name, { ...args, [field]: 'alpha:7' }), /differs from this server's "beta"/);
        assert.deepEqual(b.calls, []);
        await b.tools.handleToolCall(name, { ...args, [field]: 'beta:7' });
      }
    });
  }
}

for (const mode of ['compat', 'strict'] as const) {
  test(`${mode}: all link tokens and fields validated before even the first lookup`, async t => {
    const f = fixture(t, 'alpha', mode);
    for (const name of ['send_message', 'edit_message']) {
      for (const content of ['[[msg:alpha:7]] [[msg:beta:7]]', '[[msg:alpha:7]] [[msg:0]]', '[[msg:alpha:7]] [[msg:9007199254740992]]']) {
        f.calls.length = 0;
        await assert.rejects(f.tools.handleToolCall(name, { reply_to: 'alpha:7', message_id: 'alpha:7', content }));
        assert.deepEqual(f.calls, []);
      }
    }
    await assert.rejects(f.tools.handleToolCall('fetch_history', { channel: 'general', before: 'alpha:7', after: 'beta:7' }), /differs/);
    assert.deepEqual(f.calls, []);
    await assert.rejects(f.tools.handleToolCall('send_message', { reply_to: 'beta:7', content: '[[msg:alpha:7]]' }), /differs/);
    assert.deepEqual(f.calls, []);
  });

  test(`${mode}: message-link tokens use numeric APIs, escaped tokens do no lookup`, async t => {
    const f = fixture(t, 'alpha', mode);
    const logs: unknown[] = [];
    t.mock.method(console, 'error', (...items) => { logs.push(items); });
    const result = await f.tools.handleToolCall('send_message', { type: 'stream', to: 'general', topic: 'topic', content: '[[msg:alpha:7]] \\[[msg:beta:7]]' });
    assert.equal(result.id, 'alpha:7');
    assert.equal(f.calls[0].args.message_id, 7);
    const sent = f.calls.find(c => c.op === 'send')!;
    assert.match(sent.args.content, /near\/7/);
    assert.match(sent.args.content, /\[\[msg:beta:7\]\]/);
    assert.deepEqual(result.links, [{ token: '[[msg:alpha:7]]', url: 'https://alpha.example.invalid/#narrow/channel/12-general/topic/topic/near/7' }]);
    f.calls.length = 0;
    if (mode === 'strict') {
      await assert.rejects(f.tools.handleToolCall('send_message', { reply_to: 'alpha:7', content: '[[msg:7]]' }), /bare/);
      assert.deepEqual(f.calls, []);
    } else {
      const warned = await f.tools.handleToolCall('send_message', { reply_to: 7, content: '[[msg:7]] [[msg:7]]' });
      assert.equal(warned.warnings.length, 1);
      assert.equal(logs.length, 1, 'one stderr warning, not one per field/token');
    }
  });
}

test('realm defaults, tag/mode validation and startup failures are local', async () => {
  assert.equal(MessageIds.fromEnv('https://chat-one.example.org', {}).tag, 'chat-one');
  assert.equal(MessageIds.fromEnv('https://EXAMPLE.test', {}).mode, 'legacy');
  assert.equal(MessageIds.fromEnv('https://one.test', {}).tag, MessageIds.fromEnv('https://one.example.org', {}).tag);
  for (const tag of ['', 'Upper', '-bad', 'a.b', 'a'.repeat(65), 'a\n']) {
    assert.throws(() => MessageIds.fromEnv('https://one.test', { ZULIP_REALM_TAG: tag }), /ZULIP_REALM_TAG/);
    await assert.rejects(initializeZulipClient({ ZULIP_REALM: 'https://never-connect.invalid', ZULIP_EMAIL: 'x', ZULIP_API_KEY: 'x', ZULIP_REALM_TAG: tag }), /ZULIP_REALM_TAG/);
  }
  assert.throws(() => MessageIds.fromEnv('https://one.test', { ZULIP_ID_MODE: 'nope' }), /ZULIP_ID_MODE/);
});

test('legacy exact snapshots: schema, receipts, stream lines, raw output and numeric disk state', async t => {
  const f = fixture(t, 'alpha', 'legacy');
  assert.equal(idToolDefinitions(toolDefinitions, f.ids), toolDefinitions);
  const sent = await f.tools.handleToolCall('send_message', { type: 'stream', to: 'general', topic: 'topic', content: 'hi' });
  assert.equal(JSON.stringify(sent), '{"result":"success","id":7,"type":"stream","channelId":"zulip:general","stream":"general","topic":"topic","links":[]}');
  const fetched = await f.tools.handleToolCall('fetch_history', { channel: 'general' });
  assert.equal(JSON.stringify(fetched), '{"channel":"general","channelId":"zulip:general","count":1,"oldest_id":7,"newest_id":7,"reached_oldest":true,"reached_newest":true,"formatted_history":"[T id=7] [#general > topic] Ada Lovelace: hello alpha"}');
  assert.equal(formatMessages([raw()], 'raw'), JSON.stringify([raw()], null, 2));
  assert.equal(formatHistoryLines([normalizeMessage(raw())], undefined, undefined, 1, () => 'T'), '[T id=7] [#general > topic] Ada Lovelace: hello alpha');
  await f.tools.handleToolCall('start_monitoring', { channels: ['general'] });
  const disk = JSON.parse(readFileSync(join(f.dir, 'alpha.json'), 'utf8'));
  assert.equal(disk.monitoredChannels.general.lastReadMessageId, 7);
});

test('tagged receipts/history/raw/resources never tag channels, users, stream IDs or persisted cursors', async t => {
  const f = fixture(t, 'alpha', 'strict');
  const receipt = await f.tools.handleToolCall('send_message', { type: 'stream', to: 'general', topic: 'topic', content: 'hi' });
  assert.equal(receipt.id, 'alpha:7'); assert.equal(receipt.channelId, 'zulip:general');
  const page = await f.tools.handleToolCall('fetch_around', { message_id: 'alpha:7' });
  assert.equal(page.message_id, 'alpha:7'); assert.equal(page.oldest_id, 'alpha:7');
  assert.match(page.formatted_history, /id=alpha:7/);
  const body = JSON.parse(formatMessages([raw()], 'raw', f.ids))[0];
  assert.equal(body.id, 'alpha:7'); assert.equal(body.sender_id, 9); assert.equal(body.stream_id, 12);
  await f.tools.handleToolCall('start_monitoring', { channels: ['general'] });
  const status = JSON.parse((await f.tools.readResource('zulip://monitoring/status')).contents[0].text);
  assert.equal(status.channels[0].last_read_message_id, 'alpha:7');
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'alpha.json'), 'utf8')).monitoredChannels.general.lastReadMessageId, 7);
});

for (const mode of ['legacy', 'compat', 'strict'] as const) {
  for (const group of [false, true]) {
    test(`${mode}: ${group ? 'group' : '1:1'} DM headers across fetch, context, live and catch-up; no machine changes`, async t => {
      const people = [{ id: 1, full_name: 'Self', email: 'self@example.invalid' }, { id: 9, full_name: 'Ada Lovelace', email: 'v@example.invalid' },
        ...(group ? [{ id: 10, full_name: 'Grace Hopper', email: 't@example.invalid' }] : [])];
      const message = normalizeMessage({ ...raw(), type: 'private', display_recipient: people });
      const channel = `zulip:dm:${group ? '9+10' : '9'}`;
      const names = group ? ['Ada Lovelace', 'Grace Hopper'] : ['Ada Lovelace'];
      const header = `[${group ? 'group DM' : 'DM'} ${channel} · ${names.join(', ')}]`;
      const f = fixture(t, 'alpha', mode);
      const incoming = toIncoming(channel, message, { selfUserId: 1, sessionId: 'alpha' });
      const before = structuredClone(incoming);
      const line = formatHistoryLines([message], undefined, undefined, 1, () => 'T', f.ids);
      assert.ok(line.includes(header)); assert.ok(!line.includes('Self'));
      const attributed = attributeMessage(incoming, () => 'T', f.ids, names);
      assert.ok((attributed.content[0] as any).text.includes(header));
      assert.equal(attributed.messageId, '7'); assert.equal(attributed.channelId, channel);
      assert.deepEqual(incoming, before);
      const missed = renderMissedBlock([viewOf(incoming)], { channelId: channel, streamName: 'DM', reason: 'backscroll', count: 1,
        formatTime: () => 'T', messageIds: f.ids, dmParticipants: names });
      assert.ok(missed.includes(header));
      const client = { messages: { retrieve: async () => ({ messages: [{ ...raw(), type: 'private', display_recipient: people }] }) } };
      const adapter = new ZulipAdapter(client, 1, 'alpha', { messageIds: f.ids, formatTime: () => 'T' });
      assert.ok((await adapter.fetchContext(channel, undefined, 1))!.content.includes(header));
      assert.deepEqual(dmDescriptor(dmCounterparts(people, 1), 50).id, channel);
    });
  }
}

test('tagged schemas cover exactly the nine fields without changing legacy definitions', () => {
  const original = JSON.stringify(toolDefinitions);
  for (const mode of ['compat', 'strict'] as const) {
    const definitions = idToolDefinitions(toolDefinitions, new MessageIds('alpha', mode));
    for (const [name, field] of fields) {
      const tool = definitions.find(t => t.name === name)!;
      assert.ok((tool.inputSchema.properties as any)[field].type.includes('string'));
    }
  }
  assert.equal(JSON.stringify(toolDefinitions), original);
});

test('catch-up continuation hints and elided ranges use tagged IDs; channelId is untouched', () => {
  const ids = new MessageIds('alpha', 'strict');
  const messages = Array.from({ length: 5 }, (_, i) => viewOf(toIncoming('zulip:general', normalizeMessage({ ...raw(), id: i + 1,
    content: 'x'.repeat(200) }), { selfUserId: 1, sessionId: 'alpha' })));
  const block = renderMissedBlock(messages, { streamName: 'general', channelId: 'zulip:general', reason: 'backscroll', count: 5,
    formatTime: () => 'T', maxChars: 800, moreBeyond: true, newestScannedId: 7, messageIds: ids });
  assert.match(block, /ids alpha:1–alpha:/);
  assert.match(block, /before="alpha:/);
  assert.match(block, /after="alpha:7"/);
  assert.match(block, /channelId="zulip:general"/);
});

test('move diagnostics qualify only message IDs, not counts or HTTP/API values', async t => {
  const f = fixture(t, 'alpha', 'strict');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ result: 'error', msg: 'Too old',
    code: 'MOVE_LIMIT', first_message_id_allowed_to_move: 19, total_messages_in_topic: 20, total_messages_allowed_to_move: 3 }), { status: 400 }));
  await assert.rejects(f.tools.handleToolCall('move_messages', { message_id: 'alpha:7', topic: 'other' }), error => {
    assert.match(String(error), /moving message alpha:7/);
    assert.match(String(error), /first_message_id_allowed_to_move=alpha:19/);
    assert.match(String(error), /total_messages_in_topic=20/);
    assert.match(String(error), /HTTP 400/);
    return true;
  });
});

for (const mode of ['legacy', 'compat', 'strict'] as const) {
  test(`${mode}: topic latest IDs agree in prose and raw_data`, async t => {
    const f = fixture(t, 'alpha', mode);
    (f.client as any).streams = { topics: { retrieve: async () => ({
      result: 'success', topics: [{ name: 'topic', max_id: 7 }],
    }) } };
    const result = await f.tools.handleToolCall('get_stream_topics', { stream_id: 12, verbose: true });
    const shown = mode === 'legacy' ? 7 : 'alpha:7';
    assert.equal(result.formatted_list, `📑 **1 Topics**

1. **topic** (latest msg: ${shown})`);
    assert.equal(result.raw_data.topics[0].max_id, shown);
  });

  test(`${mode}: adapter lookup, timeout, move, ack and delete diagnostics qualify IDs`, async t => {
    const ids = new MessageIds('alpha', mode);
    const shown = String(ids.format(7));
    const logs: unknown[][] = [];
    t.mock.method(console, 'error', (...items) => { logs.push(items); });
    const fail = async () => ({ result: 'error', msg: 'denied' });
    const client = { messages: { getById: fail, deleteById: fail }, reactions: { add: fail } };
    const adapter: any = new ZulipAdapter(client, 1, 'alpha', { messageIds: ids });
    await assert.rejects(adapter.acknowledge('zulip:general', '7'), {
      message: `Zulip refused acknowledging message ${shown}: denied`,
    });
    await assert.rejects(adapter.deleteMessage('zulip:general', '7'), {
      message: `Zulip refused deleting message ${shown}: denied`,
    });
    assert.equal(await adapter.locate(7), null);
    assert.deepEqual(logs.pop(), [
      `[zulip-mcp] could not resolve message ${shown} for a reaction:`,
      `Zulip refused message ${shown}: denied`,
    ]);
    client.messages.getById = () => new Promise(() => {});
    assert.equal(await adapter.locate(7, 'a reaction', 1), null);
    const timeout = logs.pop()!;
    assert.equal(timeout[0], `[zulip-mcp] could not resolve message ${shown} for a reaction:`);
    assert.ok(String(timeout[1]).includes(`GET message ${shown}`));
    adapter.locate = async () => ({ isDm: false });
    adapter.streamNameById = async () => null;
    await adapter.onZulipChange({ kind: 'edit', messageId: 7, messageIds: [7],
      actorId: 9, streamId: 12, newStreamId: 13, topic: 'other', origTopic: 'topic' }, () => {});
    assert.deepEqual(logs.pop(), [
      `[zulip-mcp] dropping a move of message ${shown}: origin stream 12 unknown`,
    ]);
  });

  test(`${mode}: overflow and unavailable push diagnostics qualify IDs`, async t => {
    const f = fixture(t, 'alpha', mode);
    const adapter = new ZulipAdapter(f.client, 1, 'alpha', { messageIds: f.ids });
    const server: any = new ZulipMcplServer(adapter, f.tools, { serverInfo: { name: 'test', version: '0' } });
    const logs: unknown[][] = [];
    t.mock.method(console, 'error', (...items) => { logs.push(items); });
    // Exercise the real server's policy wiring, not a separately configured state.
    const delivery: DeliveryState = server.delivery;
    for (let id = 1; id <= 50_001; id++) delivery.hold('zulip:general', id);
    assert.deepEqual(logs.pop(), [
      `[zulip-mcp] zulip:general: undelivered floor holds 50000 ids; not tracking ${f.ids.format(50_001)}`,
    ]);
    server.conn = {};
    server.mcplActive = true;
    assert.equal(await server.pushEvent({ messageId: '7', channelId: 'zulip:general' }, 'test'), false);
    assert.deepEqual(logs.pop(), [
      `[zulip-mcp] pushEvents not granted; dropping addressed message ${f.ids.format(7)} on closed zulip:general`,
    ]);
  });

  test(`${mode}: queue expiry prose qualifies the message anchor, not queue/event IDs`, async t => {
    const ids = new MessageIds('alpha', mode);
    t.mock.method(console, 'error', () => {});
    let registrations = 0;
    let polls = 0;
    const events: any[] = [];
    const loop = new ZulipEventLoop({ messageIds: ids, sleep: async () => {} });
    await loop.start({
      queues: { register: async () => ({ queue_id: `q${++registrations}`, last_event_id: -1 }) },
      events: { retrieve: async () => {
        if (++polls === 1) return { events: [{ id: 42, type: 'message', flags: [], message: raw() }] };
        if (polls === 2) return { result: 'error', code: 'BAD_EVENT_QUEUE_ID' };
        loop.stop();
        return { events: [] };
      } },
    }, () => {}, e => events.push(e));
    const gap = events.find(e => e.kind === 'gap');
    assert.ok(gap.text.includes(`after message id ${ids.format(7)} (`));
    assert.ok(gap.text.includes('queue q1 expired and was re-registered as q2'));
    assert.equal(gap.metadata.lastMessageId, 7, 'internal recovery anchor stays numeric');
  });
}
