import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FiltersPlane } from '../src/filters.ts';
import { ZulipToolRuntime } from '../src/tool-runtime.ts';
import { ZulipAdapter } from '../src/platforms/zulip.ts';
import { ZulipMcplServer } from '../src/server.ts';
import { StreamDirectory } from '../src/stream-directory.ts';
import { ZulipNoAnswer, zulipApi } from '../src/zulip-api.ts';
import { CallerValidationError, StreamPolicyError, subscribedError } from '../src/tool-errors.ts';

async function fixture(t: any) {
  let posts = 0;
  let failure: unknown;
  const api = zulipApi(async (method, path) => {
    if (path === '/users/me/subscriptions') return { status: 200, body: { result: 'success', subscriptions: [{ stream_id: 12, name: 'allowed' }] } };
    if (failure) throw failure;
    if (method === 'POST') { posts++; return { status: 200, body: { result: 'success', id: 20 } }; }
    return { status: 400, body: { result: 'error', code: 'BAD_REQUEST', msg: 'private stream 987 hidden topic secret content' } };
  });
  const dir = mkdtempSync(join(tmpdir(), 'subscribed-errors-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filters = new FiltersPlane(join(dir, 'filters.json'), { ZULIP_STREAMS_MODE: 'subscribed' });
  t.after(() => filters.subscriptions.stop());
  const directory = new StreamDirectory(); directory.list([{ stream_id: 12, name: 'allowed' }]);
  const tools = new ZulipToolRuntime({ api, selfUserId: 1, realm: 'https://alpha.example.invalid', authHeader: '', sessionId: 'test' }, dir);
  const adapter = new ZulipAdapter(api, 1, 'test', { filters, directory });
  const server = new ZulipMcplServer(adapter, tools, { serverInfo: { name: 'test', version: '1' }, filters, directory });
  await filters.subscriptions.connect(api, 1);
  const call = async (name: string, args: any) => {
    const result = await (server as any).callTool(name, args);
    assert.equal(result.isError, true);
    return result.content[0].text as string;
  };
  return { call, tools, server, posts: () => posts, fail: (e: unknown) => { failure = e; } };
}

test('unescaped nonnumeric message token reports validation with escape hint, not policy; zero POSTs', async t => {
  const f = await fixture(t);
  for (const content of ['[[msg:not-a-number]]', '[[msg:]]']) {
    const error = await f.call('send_message', { type: 'stream', to: 'allowed', topic: 'neutral', content });
    assert.match(error, /Invalid message-link token/);
    assert.match(error, /backslash: \\\[/);
    assert.doesNotMatch(error, /subscribed-stream policy|not-a-number/);
  }
  assert.equal(f.posts(), 0);
  const result = await (f.server as any).callTool('send_message', { type: 'stream', to: 'allowed', topic: 'neutral', content: '\\[[msg:not-a-number]]' });
  assert.notEqual(result.isError, true);
  assert.equal(f.posts(), 1);
});

test('actual gate refusals retain exact inner and outer refusal text', async t => {
  const f = await fixture(t);
  assert.equal(await f.call('fetch_history', { channel: 'hidden' }), 'Operation refused by subscribed-stream policy');
  f.tools.handleToolCall = async () => { throw new StreamPolicyError(); };
  assert.equal(await f.call('send_message', {}), 'Operation refused by subscribed-stream policy');
  assert.equal(subscribedError(new StreamPolicyError(), 'Read refused by subscribed-stream policy'), 'Read refused by subscribed-stream policy');
});

test('caller validation remains actionable, remote failures expose only safe code/status categories', async t => {
  const f = await fixture(t);
  assert.match(await f.call('send_message', {}), /type and to are required/);
  const error = await f.call('send_message', { reply_to: 7, content: 'hello' });
  assert.equal(error, 'Error: Zulip error (BAD_REQUEST; HTTP 400)');
  assert.doesNotMatch(error, /987|hidden|secret|topic|stream/);
  for (const kind of ['network', 'timeout'] as const) {
    f.fail(new ZulipNoAnswer(kind, 'GET', '/messages/987', false, 'secret content private host'));
    assert.equal(await f.call('send_message', { reply_to: 7, content: 'hello' }), `Error: ${kind} error`);
  }
  f.fail(new Error('stream hidden/987 topic secret content'));
  assert.equal(await f.call('send_message', { reply_to: 7, content: 'hello' }), 'Error: internal error');
  assert.equal(subscribedError(new CallerValidationError('message_id must be a positive integer')), 'Error: message_id must be a positive integer');
});

test('outer final recheck keeps the Read refusal text after revocation', async t => {
  const f = await fixture(t);
  const gate = (f.server as any).streamGate;
  (f.server as any).callGatedTool = async () => {
    gate.assert(12);
    gate.policyChanged();
    // Exercise the genuine final recheck, not a text-matched ordinary Error.
    const original = gate.fresh.bind(gate);
    gate.fresh = () => false;
    t.after(() => { gate.fresh = original; });
    return { content: [{ type: 'text', text: 'withhold' }] };
  };
  assert.equal(await f.call('fetch_history', { channel: 'allowed' }), 'Read refused by subscribed-stream policy');
});
