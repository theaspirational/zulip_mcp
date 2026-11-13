import { ZulipRefused, statusOfAnswer } from './zulip-api.js';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Explicit audit inventory. New registrations must choose a read contract. */
export const STREAM_READ_TOOLS = new Set([
  'start_monitoring', 'get_monitored_channels', 'get_channel_history', 'get_unread_messages',
  'fetch_history', 'fetch_around', 'get_poll_results', 'list_streams', 'get_stream_topics',
  'fetch_attachment', 'refresh_channels', 'channel_missed', 'filters_get', 'filters_update',
  // Conditional reads: reply destinations, message links, move placement.
  'send_message', 'send_poll', 'send_dm', 'edit_message', 'move_messages', 'vote_poll',
]);
export const CONDITIONAL_STREAM_READ_TOOLS = new Set(['send_message', 'send_poll', 'send_dm', 'edit_message']);
export const NON_STREAM_READ_TOOLS = new Set([
  'stop_monitoring', 'listen', 'unlisten', 'upload_file', 'delete_message', 'add_reaction',
  'remove_reaction', 'list_users', 'find_user', 'get_user_profile', 'list_emojis',
  'mute_channel', 'unmute_channel', 'set_reaction_visibility',
]);

export interface StreamReadPolicy {
  allows(id: number | undefined): boolean;
  resolveName(name: string): number | undefined;
  known(): boolean;
  ids(): number[];
}

/**
 * One ID-based decision, used before requests and at the outermost return.
 * Async-local read sets keep concurrent calls isolated. A later await (users,
 * uploads, another channel, attachment bytes, host announcement, etc.) cannot
 * launder an earlier authorized snapshot after unsubscribe.
 */
export class StreamReadGate {
  private readonly reads = new AsyncLocalStorage<Map<number, number>>();
  // A checkpoint is a compact cutoff for the per-ID revocation vector.
  // Regrant never resets revoked[id]; unrelated stream changes stay valid.
  private clock = 0;
  private readonly revoked = new Map<number, number>();
  constructor(private readonly policy: StreamReadPolicy) {
    for (const id of policy.ids()) this.revoked.set(id, 0);
  }

  /** Called synchronously on policy changes, before any purge or regrant. */
  policyChanged(): void {
    this.clock++;
    for (const id of this.policy.ids()) if (!this.revoked.has(id)) this.revoked.set(id, 0);
    for (const id of this.revoked.keys()) if (!this.policy.allows(id)) this.revoked.set(id, this.clock);
  }
  dependencies(): number[] { return [...(this.reads.getStore()?.keys() ?? [])]; }
  checkpoint(): number { return this.clock; }
  unchanged(id: number | undefined, checkpoint = this.clock): boolean {
    return id !== undefined && (this.revoked.get(id) ?? 0) <= checkpoint;
  }
  fresh(id: number | undefined, checkpoint = this.clock): boolean {
    return this.allowed(id) && this.unchanged(id, checkpoint);
  }
  assertFresh(id: number | undefined, checkpoint: number): void {
    if (!this.fresh(id, checkpoint)) throw new Error('Read refused by subscribed-stream policy: revoked snapshot');
    this.assert(id);
  }

  allowed(id: number | undefined): boolean {
    if (id !== undefined && !this.revoked.has(id)) this.revoked.set(id, 0);
    return this.policy.allows(id);
  }
  /** Synchronous output projection: retained state is not read authority. */
  select<T>(items: T[], id: (item: T) => number | undefined): T[] {
    return items.filter(item => {
      const streamId = id(item);
      if (!this.allowed(streamId)) return false;
      this.assert(streamId);
      return true;
    });
  }
  visibleNames(names: string[]): string[] {
    return this.select(names, name => this.policy.resolveName(name));
  }
  assert(id: number | undefined): void {
    if (id === undefined || !this.allowed(id)) throw new Error('Read refused by subscribed-stream policy');
    const reads = this.reads.getStore();
    const epoch = reads?.get(id) ?? this.clock;
    if (!this.fresh(id, epoch)) throw new Error('Read refused by subscribed-stream policy: revoked snapshot');
    reads?.set(id, epoch);
  }
  named(name: string): number {
    const id = this.policy.resolveName(name);
    this.assert(id);
    return id!;
  }
  requireKnown(): void {
    if (!this.policy.known()) throw new Error('Read refused by subscribed-stream policy: unknown state');
  }
  recheck(): void {
    for (const [id, epoch] of this.reads.getStore() ?? []) this.assertFresh(id, epoch);
  }
  async run<T>(read: () => Promise<T>): Promise<T> {
    const parent = this.reads.getStore();
    return this.reads.run(new Map(parent), async () => {
      try {
        const result = await read();
        // No await between the last decision and returning the complete result.
        for (const [id, epoch] of this.reads.getStore()!) this.assertFresh(id, epoch);
        return result;
      } catch (error) {
        // Errors can contain read metadata too.
        for (const [id, epoch] of this.reads.getStore()!) this.assertFresh(id, epoch);
        throw error;
      } finally {
        // A server-owned scope must retain reads performed by nested runtime
        // and adapter calls until its own final return.
        for (const [id, epoch] of this.reads.getStore()!) parent?.set(id, Math.min(parent.get(id) ?? epoch, epoch));
      }
    });
  }

  /** Native upstream API seam: pin names before GET and check again after it. */
  api(original: import('./zulip-api.js').ZulipApi): import('./zulip-api.js').ZulipApi {
    const gate = this;
    const prepare = (method: string, path: string, params: Record<string, unknown> = {}) => {
      gate.recheck();
      if (method !== 'GET') return params;
      if (path === '/messages' || /^\/messages\/\d+$/.test(path) || path === '/streams' || path === '/get_stream_id' || /^\/streams\/\d+$/.test(path) || /^\/users\/me\/\d+\/topics$/.test(path)) gate.requireKnown();
      const topic = /^\/users\/me\/(\d+)\/topics$/.exec(path);
      const stream = /^\/streams\/(\d+)$/.exec(path);
      if (topic || stream) gate.assert(Number((topic ?? stream)![1]));
      if (path === '/get_stream_id') gate.named(String(params.stream));
      if (path === '/streams') return { ...params, include_public: false, include_subscribed: true };
      if (path !== '/messages') return params;
      const narrow = (Array.isArray(params.narrow) ? params.narrow : []).map((item: any) => {
        const op = Array.isArray(item) ? item[0] : item.operator;
        if (op !== 'stream' && op !== 'channel') return item;
        const operand = Array.isArray(item) ? item[1] : item.operand;
        const id = typeof operand === 'number' ? operand : gate.named(operand);
        gate.assert(id);
        return { operator: op, operand: id };
      });
      return { ...params, narrow };
    };
    const project = (method: string, path: string, params: Record<string, unknown>, result: any, epoch: number) => {
      gate.recheck();
      if (result?.result === 'error') throw new ZulipRefused('operation', result, method !== 'GET' && (statusOfAnswer(result) ?? 0) >= 500, statusOfAnswer(result));
      if (method !== 'GET') return result;
      if (/^\/messages\/\d+$/.test(path) && result?.message?.type !== 'private') gate.assertFresh(result?.message?.stream_id, epoch);
      if (path === '/messages' && Array.isArray(result.messages)) {
        result = { ...result, messages: result.messages.filter((m: any) => m.type === 'private' || (m.type === 'stream' && gate.allowed(m.stream_id))) };
        for (const m of result.messages) if (m.type === 'stream') gate.assertFresh(m.stream_id, epoch);
      }
      if (path === '/streams') {
        result = { ...result, streams: (result.streams ?? []).filter((s: any) => gate.allowed(s.stream_id)) };
        for (const s of result.streams) gate.assertFresh(s.stream_id, epoch);
      }
      if (path === '/get_stream_id') {
        gate.assertFresh(result.stream_id, epoch);
        if (gate.named(String(params.stream)) !== result.stream_id) throw new Error('Read refused by subscribed-stream policy: address changed');
      }
      const id = /^\/(?:users\/me\/(\d+)\/topics|streams\/(\d+))$/.exec(path);
      if (id) gate.assertFresh(Number(id[1] ?? id[2]), epoch);
      gate.recheck();
      return result;
    };
    const request = async (answer: boolean, method: any, path: string, what: string, params?: Record<string, unknown>, opts?: any) => {
      const epoch = gate.checkpoint();
      const pinned = prepare(method, path, params);
      const result = answer ? await original.requestAnswer(method, path, pinned, opts) : await original.request(method, path, what, pinned, opts);
      return project(method, path, pinned, result, epoch);
    };
    return {
      request: (method, path, what, params, opts) => request(false, method, path, what, params, opts),
      requestAnswer: (method, path, params, opts) => request(true, method, path, '', params, opts),
    };
  }
}
