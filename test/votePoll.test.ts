import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZulipToolRuntime } from '../src/tool-runtime.ts';
import { MessageIds, idToolDefinitions } from '../src/message-ids.ts';
import { FiltersPlane } from '../src/filters.ts';
import { ZulipAdapter } from '../src/platforms/zulip.ts';
import { ZulipMcplServer } from '../src/server.ts';
import { toolDefinitions } from '../src/tools.ts';
import { featureSetForTool, MESSAGING_FEATURE_SET } from '../src/feature-sets.ts';
import { TOOL_CLASSES } from '../src/tool-classes.ts';
import { POLL_LIMITS, reconstructPoll, resolvePollOption } from '../src/polls.ts';

const SELF = 790;
const sub = (id: number, content: unknown, sender_id = 42) => ({ id, sender_id, msg_type: 'widget', content: JSON.stringify(content) });
const initial = (options = ['Yes', 'Wait']) => sub(1, { widget_type: 'poll', extra_data: { question: 'Ship?', options } });
function fixture(t: any, env: NodeJS.ProcessEnv = {}, mode: 'legacy' | 'compat' | 'strict' = 'strict') {
  const dir = mkdtempSync(join(tmpdir(), 'zulip-vote-'));
  const plane = new FiltersPlane(join(dir, 'filters.json'), env);
  plane.start();
  t.after(() => { plane.stop(); rmSync(dir, { recursive: true, force: true }); });
  const gets: any[] = [], posts: any[] = [];
  const f = {
    message: { id: 77, sender_id: 42, sender_email: 'ann@example.invalid', sender_full_name: 'Ann',
      type: 'stream', display_recipient: 'general' as any, stream_id: 12, subject: 'Release', content: '', timestamp: 1700000000,
      submessages: [initial()] },
    response: { result: 'success' } as any,
  };
  const client = {
    messages: { async getById(params: any) { gets.push(params); return { result: 'success', message: f.message }; } },
    async callEndpoint(path: string, method: string, params: any) {
      if (method === 'GET') return { result: 'success', subscriptions: [{ stream_id: 12, name: 'general' }] };
      posts.push({ path, method, params });
      if (f.response.result === 'success') f.message.submessages.push(sub(Math.max(...f.message.submessages.map(s => s.id)) + 1, JSON.parse(params.content), SELF));
      return f.response;
    },
  };
  const runtime = new ZulipToolRuntime({ client, selfUserId: SELF, sessionId: 'vote', realm: '', authHeader: '' }, dir,
    { messageIds: new MessageIds('acme', mode) });
  new ZulipMcplServer(new ZulipAdapter(client, SELF, 'vote', { filters: plane }), runtime,
    { serverInfo: { name: 'test', version: '0' }, filters: plane });
  return { f, runtime, plane, gets, posts, client, call: (option: unknown, extra = {}) => runtime.handleToolCall('vote_poll', { message_id: 'acme:77', option, ...extra }) };
}

test('vote_poll is a default comms tool owned by messaging, with ID-aware schema', () => {
  const tool = toolDefinitions.find(t => t.name === 'vote_poll');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['message_id', 'option']);
  assert.equal(featureSetForTool('vote_poll'), MESSAGING_FEATURE_SET);
  assert.deepEqual(TOOL_CLASSES.vote_poll, ['comms']);
  const qualified = idToolDefinitions([tool], new MessageIds('acme', 'strict'));
  assert.deepEqual((qualified[0].inputSchema.properties as any).message_id.type, ['string']);
});

for (const author of [SELF, 42, 99]) test(`vote_poll resolves keys and exact text regardless of author ${author}, toggles with exact wire body`, async t => {
  const { f, call, posts, gets } = fixture(t);
  f.message.sender_id = author;
  assert.deepEqual(await call('Yes'), { message_id: 'acme:77', key: 'canned,0', text: 'Yes', vote: true });
  assert.deepEqual(await call('canned,0'), { message_id: 'acme:77', key: 'canned,0', text: 'Yes', vote: false });
  assert.deepEqual(posts, [1, -1].map(vote => ({ path: 'submessage', method: 'POST', params: {
    message_id: 77, msg_type: 'widget', content: JSON.stringify({ type: 'vote', key: 'canned,0', vote }),
  } })));
  assert.deepEqual(gets, Array(2).fill({ message_id: 77, apply_markdown: false }));
});

test('vote_poll explicit state is idempotent, added options use sender keys, and other votes are untouched', async t => {
  const { f, call, posts } = fixture(t);
  f.message.submessages.push(sub(2, { type: 'new_option', option: 'Review', idx: 3 }, 99),
    sub(3, { type: 'vote', key: '99,3', vote: 1 }, 42), sub(4, { type: 'vote', key: 'canned,1', vote: 1 }, SELF));
  assert.equal((await call('Review', { vote: false })).vote, false);
  assert.equal(posts.length, 0);
  assert.equal((await call('99,3', { vote: true })).vote, true);
  assert.equal((await call('Review', { vote: true })).vote, true);
  assert.equal(posts.length, 1);
  assert.equal((await call('Review', { vote: false })).vote, false);
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[1].params.content).vote, -1);
  assert.ok(f.message.submessages.some(s => s.sender_id === SELF && JSON.parse(s.content).key === 'canned,1'));
});

test('unknown, nonexact, duplicate text and key/text collisions refuse without a vote POST', async t => {
  const { f, call, posts } = fixture(t);
  for (const option of ['yes', ' Yes', 'missing', 'canned,9']) await assert.rejects(call(option), /unknown.*option/i);
  f.message.submessages = [initial(['Same', 'Same', 'canned,0'])];
  for (const option of ['Same', 'canned,0']) await assert.rejects(call(option), /ambiguous.*option/i);
  assert.equal((await call('canned,1')).text, 'Same', 'unique keys disambiguate duplicate text');
  assert.equal(posts.length, 1);
});

test('invalid arguments and ID modes refuse locally with zero requests; compat warns', async t => {
  const { runtime, call, gets, posts } = fixture(t);
  for (const id of [77, 'else:77', 'acme:0', 'acme:1.5', null])
    await assert.rejects(runtime.handleToolCall('vote_poll', { message_id: id, option: 'Yes' }), /message_id/);
  for (const option of [undefined, null, 1, '']) await assert.rejects(call(option), /option/);
  for (const vote of [null, 1, 'true']) await assert.rejects(call('Yes', { vote }), /vote.*boolean/);
  assert.equal(gets.length, 0); assert.equal(posts.length, 0);
  const legacy = fixture(t, {}, 'legacy');
  for (const id of [0, -1, '77', NaN, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(legacy.call('Yes', { message_id: id }), /positive safe integer/);
  assert.equal(legacy.gets.length, 0);
  assert.equal((await legacy.call('Yes', { message_id: 77 })).vote, true);
  const compat = fixture(t, {}, 'compat');
  assert.match((await compat.call('Yes', { message_id: 77 })).warnings[0], /bare message_id/);
});

test('non-polls, wrong message IDs, failed reads and failed writes are errors, not successful votes', async t => {
  const { f, call, posts, client } = fixture(t);
  f.message.submessages = [];
  await assert.rejects(call('Yes'), /no supported poll widget/);
  f.message.submessages = [{ ...initial(), msg_type: 'other' }];
  await assert.rejects(call('Yes'), /no supported poll widget/);
  f.message.submessages = [initial()]; f.message.id = 78;
  await assert.rejects(call('Yes'), /different message id/);
  f.message.id = 77;
  const get = client.messages.getById;
  client.messages.getById = async () => ({ result: 'error', msg: 'not accessible' } as any);
  await assert.rejects(call('Yes'), /reading poll/);
  assert.equal(posts.length, 0);
  client.messages.getById = get; f.response = { result: 'error', msg: 'not allowed' };
  await assert.rejects(call('Yes'), /voting in poll/);
});

for (const mode of ['list', 'subscribed']) test(`vote_poll refuses gated streams in ${mode} mode and unknown/revoked subscription state`, async t => {
  const { f, call, posts, gets, plane, client } = fixture(t, { ZULIP_STREAMS_MODE: mode, ZULIP_STREAMS: 'general' });
  if (mode === 'subscribed') {
    await assert.rejects(call('Yes'), /subscribed-stream policy/);
    assert.equal(gets.length, 0);
    await plane.subscriptions.connect(client, SELF);
  }
  f.message.stream_id = 13; f.message.display_recipient = 'secret';
  await assert.rejects(call('Yes'), /policy|visible/);
  assert.equal(posts.length, 0);
  f.message.stream_id = 12; f.message.display_recipient = 'general';
  if (mode === 'subscribed') {
    const get = client.messages.getById;
    client.messages.getById = async p => {
      const response = await get(p);
      plane.subscriptions.apply({ op: 'remove', stream_ids: [12] });
      return response;
    };
    await assert.rejects(call('Yes'), /subscribed-stream policy/);
    assert.equal(posts.length, 0);
  } else assert.equal((await call('Yes')).vote, true);
});

test('DM polls require a visible conversation including this bot, not ownership of the poll', async t => {
  const { f, call, posts } = fixture(t, { ZULIP_DM_USERS: '42' });
  f.message.type = 'private';
  f.message.display_recipient = [{ id: SELF, email: 'bot@example.invalid' }, { id: 99, email: 'other@example.invalid' }];
  await assert.rejects(call('Yes'), /visible/);
  f.message.display_recipient = [{ id: 42, email: 'ann@example.invalid' }];
  await assert.rejects(call('Yes'), /visible/);
  assert.equal(posts.length, 0);
  f.message.display_recipient.push({ id: SELF, email: 'bot@example.invalid' });
  assert.equal((await call('Yes')).vote, true);
});


test('option resolution uses exactly get_poll_results display text, including bounded text', () => {
  const state = reconstructPoll([initial(['x'.repeat(POLL_LIMITS.text + 1), 'Wait'])])!;
  assert.equal(resolvePollOption(state, 'x'.repeat(POLL_LIMITS.text)).key, 'canned,0');
  assert.throws(() => resolvePollOption(state, 'x'.repeat(POLL_LIMITS.text + 1)), /unknown/);
  const same = reconstructPoll([initial(['canned,0'])])!;
  assert.equal(resolvePollOption(same, 'canned,0').key, 'canned,0', 'one option matching key and text is not ambiguous');
});

test('toggle sees this bot beyond the results display voter cap', async t => {
  const { f, call, posts } = fixture(t);
  for (let i = 0; i < POLL_LIMITS.voters; i++)
    f.message.submessages.push(sub(i + 2, { type: 'vote', key: 'canned,0', vote: 1 }, 10000 + i));
  f.message.submessages.push(sub(POLL_LIMITS.voters + 2, { type: 'vote', key: 'canned,0', vote: 1 }, SELF));
  assert.equal((await call('Yes')).vote, false);
  assert.equal(JSON.parse(posts[0].params.content).vote, -1);
  assert.equal(reconstructPoll(f.message.submessages)!.options.get('canned,0')!.voters.size, POLL_LIMITS.voters,
    'default results reconstruction retains its existing cap');
});

test('muted streams, malformed placements, unavailable identity and malformed write responses fail closed', async t => {
  const muted = fixture(t, { ZULIP_MUTED_STREAMS: 'general' });
  await assert.rejects(muted.call('Yes'), /policy|visible/);
  assert.equal(muted.posts.length, 0);
  const { f, call, posts } = fixture(t);
  f.message.type = 'unknown';
  await assert.rejects(call('Yes'), /visible/);
  f.message.type = 'private'; f.message.display_recipient = [{ id: SELF }, { id: 0 }];
  await assert.rejects(call('Yes'), /visible/);
  assert.equal(posts.length, 0);
  f.message.type = 'stream'; f.message.display_recipient = 'general';
  f.response = {};
  await assert.rejects(call('Yes'), /invalid response while voting/);
  const missing = fixture(t);
  (missing.runtime as any).session.selfUserId = null;
  await assert.rejects(missing.call('Yes'), /user id is unavailable/);
  assert.equal(missing.gets.length, 0);
});
