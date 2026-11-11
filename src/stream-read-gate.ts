import { AsyncLocalStorage } from 'node:async_hooks';

/** Explicit audit inventory. New registrations must choose a read contract. */
export const STREAM_READ_TOOLS = new Set([
  'start_monitoring', 'get_monitored_channels', 'get_channel_history', 'get_unread_messages',
  'fetch_history', 'fetch_around', 'get_poll_results', 'list_streams', 'get_stream_topics',
  'fetch_attachment', 'refresh_channels', 'channel_missed', 'filters_get', 'filters_update',
  // Conditional reads: reply destinations, message links, move placement.
  'send_message', 'send_poll', 'edit_message', 'move_messages',
]);
export const CONDITIONAL_STREAM_READ_TOOLS = new Set(['send_message', 'send_poll', 'edit_message']);
export const NON_STREAM_READ_TOOLS = new Set([
  'send_dm', 'stop_monitoring', 'listen', 'unlisten', 'upload_file', 'delete_message', 'add_reaction',
  'remove_reaction', 'list_users', 'find_user', 'get_user_profile', 'list_emojis',
  'mute_channel', 'unmute_channel', 'set_reaction_visibility',
]);

export interface StreamReadPolicy {
  allows(id: number | undefined): boolean;
  resolveName(name: string): number | undefined;
  known(): boolean;
}

/**
 * One ID-based decision, used before requests and at the outermost return.
 * Async-local read sets keep concurrent calls isolated. A later await (users,
 * uploads, another channel, attachment bytes, host announcement, etc.) cannot
 * launder an earlier authorized snapshot after unsubscribe.
 */
export class StreamReadGate {
  private readonly reads = new AsyncLocalStorage<Set<number>>();
  constructor(private readonly policy: StreamReadPolicy) {}

  allowed(id: number | undefined): boolean { return this.policy.allows(id); }
  assert(id: number | undefined): void {
    if (id === undefined || !this.allowed(id)) throw new Error('Read refused by subscribed-stream policy');
    this.reads.getStore()?.add(id);
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
    for (const id of this.reads.getStore() ?? []) this.assert(id);
  }
  async run<T>(read: () => Promise<T>): Promise<T> {
    const parent = this.reads.getStore();
    return this.reads.run(new Set(), async () => {
      try {
        const result = await read();
        // No await between the last decision and returning the complete result.
        for (const id of this.reads.getStore()!) this.assert(id);
        return result;
      } catch (error) {
        // Errors can contain read metadata too.
        for (const id of this.reads.getStore()!) this.assert(id);
        throw error;
      } finally {
        // A server-owned scope must retain reads performed by nested runtime
        // and adapter calls until its own final return.
        for (const id of this.reads.getStore()!) parent?.add(id);
      }
    });
  }

  /** Intercept every Zulip content/metadata GET used by the runtime. */
  client(original: any): any {
    const gate = this;
    const visible = (m: any) => m?.type === 'private' || (m?.type === 'stream' && gate.allowed(m.stream_id));
    return { ...original,
      messages: { ...original.messages,
        getById: async (params: any) => {
          gate.requireKnown(); // Placement is only knowable from a fresh response.
          const result = await original.messages.getById(params);
          if (result?.message?.type !== 'private') gate.assert(result?.message?.stream_id);
          return result;
        },
        retrieve: async (params: any) => {
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
          if (!Array.isArray(result?.messages)) return result;
          const messages = result.messages.filter(visible);
          for (const m of messages) if (m.type === 'stream') gate.assert(m.stream_id);
          return { ...result, messages };
        },
      },
      streams: { ...original.streams,
        retrieve: async (params: any) => {
          gate.requireKnown();
          const result = await original.streams.retrieve({ ...params, include_public: false, include_subscribed: true });
          const streams = (result?.streams ?? []).filter((s: any) => gate.allowed(s.stream_id));
          for (const s of streams) gate.assert(s.stream_id);
          return { ...result, streams };
        },
        getStreamId: async (params: any) => {
          const id = gate.named(params.stream);
          const result = await original.streams.getStreamId(params);
          gate.assert(id);
          gate.assert(result?.stream_id);
          if (result.stream_id !== id) throw new Error('Read refused by subscribed-stream policy: address changed');
          return result;
        },
        topics: { ...original.streams?.topics,
          retrieve: async (params: any) => {
            gate.assert(params.stream_id);
            const result = await original.streams.topics.retrieve(params);
            gate.assert(params.stream_id);
            return result;
          },
        },
      },
    };
  }
}
