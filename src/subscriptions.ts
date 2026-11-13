import type { ZulipApi } from './zulip-api.js';

/** Subscription authorization state. Never infer membership from public-stream visibility. */
export interface SubscriptionEvent {
  op: string;
  type?: string;
  stream_id?: number;
  streams?: { stream_id: number; name: string }[];
  property?: string;
  value?: unknown;
  subscriptions?: { stream_id: number; name?: string }[];
  stream_ids?: number[];
  user_id?: number;
  user_ids?: number[];
}

export type StreamsMode = 'list' | 'subscribed' | 'public';

export function parseStreamsMode(mode: string | undefined): StreamsMode {
  if (mode === undefined) return 'list';
  if (mode === 'list' || mode === 'subscribed' || mode === 'public') return mode;
  throw new Error('ZULIP_STREAMS_MODE must be list, subscribed, or public');
}

export class Subscriptions {
  readonly mode: StreamsMode;
  readonly configured: boolean;
  private known = false;
  private streams = new Map<number, string>();
  private revision = 0;
  private names = new Map<number, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private loading: Promise<void> | undefined;
  private client?: ZulipApi;
  private selfId: number | null = null;
  private listeners: (() => void)[] = [];

  constructor(mode: string | undefined, private readonly options: { retryMs?: number; timeoutMs?: number } = {}) {
    this.mode = parseStreamsMode(mode);
    this.configured = mode !== undefined;
  }

  allows(id: number | undefined): boolean {
    return this.mode !== 'subscribed' || (this.known && id !== undefined && this.streams.has(id));
  }

  resolveName(name: string): number | undefined {
    // Names are an address/display index only, never membership.
    return [...this.names].find(([, current]) => current === name)?.[0];
  }

  name(id: number): string | undefined { return this.names.get(id); }

  observe(streams: { stream_id: number; name: string }[]): void {
    for (const s of streams) {
      // A newly created stream may reuse a renamed/deleted stream's name.
      for (const [id, name] of this.names) if (name === s.name && id !== s.stream_id) this.names.delete(id);
      this.names.set(s.stream_id, s.name);
      if (this.streams.has(s.stream_id)) this.streams.set(s.stream_id, s.name);
    }
  }

  status() {
    return { mode: this.mode, known: this.known, streams: [...this.streams].map(([id, name]) => ({ id, name })).sort((a, b) => a.id - b.id) };
  }

  onChange(listener: () => void): void { this.listeners.push(listener); }
  private changed(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { console.error('[zulip-mcp] subscription listener failed'); }
    }
  }

  async connect(client: ZulipApi, selfId: number | null, invalidate = false): Promise<void> {
    if (this.mode !== 'subscribed') return;
    this.client = client;
    this.selfId = selfId;
    if (!this.timer) {
      // Unknown state is retried at most 30s after a failed bounded GET.
      this.timer = setInterval(() => { if (!this.known) void this.refresh(); }, this.options.retryMs ?? 30_000);
      this.timer.unref();
    }
    await this.refresh(invalidate);
  }

  invalidate(): void { if (this.mode === "subscribed") { this.revision++; this.known = false; this.changed(); } }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** A replacement queue may have missed membership changes. Do not retain stale authorization. */
  async refresh(invalidate = false): Promise<void> {
    if (this.mode !== 'subscribed' || !this.client) return;
    if (invalidate) { this.revision++; this.known = false; this.changed(); }
    if (this.loading) { await this.loading; if (invalidate) return this.refresh(); return; }
    const revision = this.revision;
    this.loading = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          this.client!.requestAnswer<{ subscriptions?: { stream_id: number; name: string }[] }>('GET', '/users/me/subscriptions', {}, { timeoutMs: this.options.timeoutMs ?? 10_000 }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('subscription read timed out')), this.options.timeoutMs ?? 10_000); }),
        ]);
        if (result?.result !== 'success' || !Array.isArray(result.subscriptions) || result.subscriptions.some((s: any) => !Number.isSafeInteger(s.stream_id) || typeof s.name !== 'string')) {
          throw new Error('invalid subscription response');
        }
        // A retry may overlap live events. Never overwrite newer membership with an older snapshot.
        if (revision !== this.revision) return;
        this.observe(result.subscriptions);
        this.streams = new Map(result.subscriptions.map((s: any) => [s.stream_id, s.name]));
        this.known = true;
        this.changed();
      } catch {
        console.error('[zulip-mcp] subscription state unavailable; subscribed mode fails closed; retry within 30s');
      } finally { if (timer) clearTimeout(timer); }
    })();
    try { await this.loading; } finally { this.loading = undefined; }
  }

  apply(event: SubscriptionEvent): void {
    if (this.mode !== 'subscribed') return;
    if (event.type === 'stream') {
      this.revision++;
      if (event.op === 'delete') {
        for (const s of event.streams ?? []) { this.streams.delete(s.stream_id); this.names.delete(s.stream_id); }
      } else if (event.op === 'update' && event.property === 'name' && event.stream_id !== undefined && typeof event.value === 'string') {
        this.observe([{ stream_id: event.stream_id, name: event.value }]);
      } else if (event.op === 'create') this.observe(event.streams ?? []);
      this.changed();
      return;
    }
    // Subscription property updates do not grant membership; reconcile display names.
    if (event.op === 'update') {
      this.revision++;
      if (event.property === 'name' && event.stream_id !== undefined && typeof event.value === 'string')
        this.observe([{ stream_id: event.stream_id, name: event.value }]);
      this.changed();
      return;
    }
    // add/remove are for the receiving user; peer_* explicitly name affected users.
    const users = event.user_ids ?? (event.user_id === undefined ? undefined : [event.user_id]);
    if (users && (this.selfId === null || !users.includes(this.selfId))) return;
    if (event.op.startsWith('peer_') && (!users || this.selfId === null)) return;
    if (!['add', 'remove', 'peer_add', 'peer_remove'].includes(event.op)) return;
    this.revision++;
    if (event.op === 'remove' || event.op === 'peer_remove') {
      for (const id of event.stream_ids ?? event.subscriptions?.map(s => s.stream_id) ?? []) this.streams.delete(id);
    } else if (event.subscriptions) {
      for (const s of event.subscriptions) {
        this.streams.set(s.stream_id, s.name ?? this.names.get(s.stream_id) ?? '');
        if (typeof s.name === 'string') this.observe([{ stream_id: s.stream_id, name: s.name }]);
      }
    } else {
      for (const id of event.stream_ids ?? []) this.streams.set(id, this.names.get(id) ?? '');
    }
    this.changed();
  }
}
