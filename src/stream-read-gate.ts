import { AsyncLocalStorage } from 'node:async_hooks';

/** Explicit audit inventory. New registrations must choose a read contract. */
export const STREAM_READ_TOOLS = new Set([
  'start_monitoring', 'get_monitored_channels', 'get_channel_history', 'get_unread_messages',
  'fetch_history', 'fetch_around', 'get_poll_results', 'list_streams', 'get_stream_topics',
  'fetch_attachment', 'refresh_channels', 'channel_missed', 'filters_get', 'filters_update',
  // Conditional reads: reply destinations, message links, move placement.
  'send_message', 'send_dm', 'send_poll', 'edit_message', 'move_messages',
]);
export const CONDITIONAL_STREAM_READ_TOOLS = new Set(['send_message', 'send_dm', 'send_poll', 'edit_message']);
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

  /** Intercept every Zulip content/metadata GET used by the runtime. */
  client(original: any): any {
    const gate = this;
    const visible = (m: any) => m?.type === 'private' || (m?.type === 'stream' && gate.allowed(m.stream_id));
    return { ...original,
      callEndpoint: async (path: string, method: string, params: any) => {
        const stream = /^streams\/(\d+)$/.exec(path);
        if (method !== 'GET' || (path !== 'get_stream_id' && !stream)) {
          return original.callEndpoint(path, method, params);
        }
        gate.recheck();
        gate.requireKnown();
        const epoch = gate.checkpoint();
        const id = stream ? Number(stream[1]) : gate.named(params.stream);
        gate.assert(id);
        const result = await original.callEndpoint(path, method, params);
        gate.assertFresh(id, epoch);
        if (path === 'get_stream_id') {
          gate.assertFresh(result?.stream_id, epoch);
          if (result.stream_id !== id) throw new Error('Read refused by subscribed-stream policy: address changed');
        } else if (result?.stream?.stream_id !== undefined && result.stream.stream_id !== id) {
          throw new Error('Read refused by subscribed-stream policy: address changed');
        }
        gate.recheck();
        return result;
      },
      messages: { ...original.messages,
        getById: async (params: any) => {
          const epoch = gate.checkpoint();
          gate.recheck();
          gate.requireKnown(); // Placement is only knowable from a fresh response.
          const result = await original.messages.getById(params);
          if (result?.message?.type !== 'private') gate.assertFresh(result?.message?.stream_id, epoch);
          gate.recheck();
          return result;
        },
        retrieve: async (params: any) => {
          gate.recheck();
          const epoch = gate.checkpoint();
          gate.requireKnown();
          const narrow = (params.narrow ?? []).map((item: any) => {
            const op = Array.isArray(item) ? item[0] : item.operator;
            if (op !== 'stream' && op !== 'channel') return item;
            const operand = Array.isArray(item) ? item[1] : item.operand;
            const id = typeof operand === 'number' ? operand : gate.named(operand);
            gate.assert(id);
            // Pin the GET itself to the ID, not a mutable/reusable name.
            return { operator: op, operand: id };
          });
          const result = await original.messages.retrieve({ ...params, narrow });
          gate.recheck();
          if (!Array.isArray(result?.messages)) return result;
          const messages = result.messages.filter(visible);
          for (const m of messages) if (m.type === 'stream') gate.assertFresh(m.stream_id, epoch);
          gate.recheck();
          return { ...result, messages };
        },
      },
      streams: { ...original.streams,
        retrieve: async (params: any) => {
          gate.recheck();
          const epoch = gate.checkpoint();
          gate.requireKnown();
          const result = await original.streams.retrieve({ ...params, include_public: false, include_subscribed: true });
          const streams = (result?.streams ?? []).filter((s: any) => gate.allowed(s.stream_id));
          for (const s of streams) gate.assertFresh(s.stream_id, epoch);
          gate.recheck();
          return { ...result, streams };
        },
        getStreamId: async (params: any) => {
          gate.recheck();
          const epoch = gate.checkpoint();
          const id = gate.named(params.stream);
          const result = await original.streams.getStreamId(params);
          gate.assertFresh(id, epoch);
          gate.assertFresh(result?.stream_id, epoch);
          if (result.stream_id !== id) throw new Error('Read refused by subscribed-stream policy: address changed');
          gate.recheck();
          return result;
        },
        topics: { ...original.streams?.topics,
          retrieve: async (params: any) => {
            gate.recheck();
            const epoch = gate.checkpoint();
            gate.assert(params.stream_id);
            const result = await original.streams.topics.retrieve(params);
            gate.assertFresh(params.stream_id, epoch);
            gate.recheck();
            return result;
          },
        },
      },
    };
  }
}
