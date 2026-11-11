/** Subscription authorization state. Never infer membership from public-stream visibility. */
export interface SubscriptionEvent {
  op: string;
  subscriptions?: { stream_id: number; name?: string }[];
  stream_ids?: number[];
  user_id?: number;
  user_ids?: number[];
}

export class Subscriptions {
  readonly mode: 'all' | 'subscribed';
  private known = false;
  private streams = new Map<number, string>();
  private revision = 0;
  private names = new Map<number, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private loading: Promise<void> | undefined;
  private client: any;
  private selfId: number | null = null;
  private listeners: (() => void)[] = [];

  constructor(mode: string | undefined, private readonly options: { retryMs?: number; timeoutMs?: number } = {}) {
    if (mode && mode !== 'all' && mode !== 'subscribed') throw new Error('ZULIP_STREAMS_MODE must be all or subscribed');
    this.mode = mode === 'subscribed' ? 'subscribed' : 'all';
  }

  allows(name: string): boolean {
    return this.mode === 'all' || (this.known && [...this.streams.values()].includes(name));
  }

  observe(streams: { stream_id: number; name: string }[]): void {
    for (const s of streams) this.names.set(s.stream_id, s.name);
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

  async connect(client: any, selfId: number | null, invalidate = false): Promise<void> {
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
          this.client.callEndpoint('users/me/subscriptions', 'GET', {}),
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
    // add/remove are for the receiving user; peer_* explicitly name affected users.
    const users = event.user_ids ?? (event.user_id === undefined ? undefined : [event.user_id]);
    if (users && (this.selfId === null || !users.includes(this.selfId))) return;
    if (event.op.startsWith('peer_') && (!users || this.selfId === null)) return;
    if (!['add', 'remove', 'peer_add', 'peer_remove'].includes(event.op)) return;
    this.revision++;
    if (event.op === 'remove' || event.op === 'peer_remove') {
      for (const id of event.stream_ids ?? event.subscriptions?.map(s => s.stream_id) ?? []) this.streams.delete(id);
    } else if (event.subscriptions) {
      for (const s of event.subscriptions) if (typeof s.name === 'string') { this.streams.set(s.stream_id, s.name); this.names.set(s.stream_id, s.name); }
    } else {
      // peer_add carries ids only. Known names are applied synchronously;
      // an unknown private stream needs a bounded subscription read first.
      let missing = false;
      for (const id of event.stream_ids ?? []) {
        const name = this.names.get(id);
        if (name === undefined) missing = true;
        else this.streams.set(id, name);
      }
      if (missing) { this.known = false; void this.refresh(); }
    }
    this.changed();
  }
}
