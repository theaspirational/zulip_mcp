/** Wire format checked against Zulip 12.3 event_types.py, widget.py and validator.py.
 * Initial options use canned,N; added options use sender_id,idx.
 */
import type { ZulipRawMessage } from './history.js';

export interface WidgetSubmessage {
  id: number;
  message_id?: number;
  sender_id: number;
  msg_type: string;
  content: string;
}
export interface PollOption { key: string; text: string; voters: Set<number> }
export interface PollState { question: string; options: Map<string, PollOption> }
export type PollUpdate =
  | { type: 'init'; question: string; options: string[] }
  | { type: 'question'; question: string }
  | { type: 'new_option'; key: string; text: string }
  | { type: 'vote'; key: string; voterId: number; action: 'vote' | 'unvote' };

export const POLL_LIMITS = { options: 100, text: 2000, polls: 500, voters: 1000,
  content: 1_000_000, lookups: 20, negativeTtlMs: 60_000 } as const;
export const pollDrops: Record<string, number> = Object.create(null);
export function countPollDrop(reason: string): void { pollDrops[reason] = (pollDrops[reason] ?? 0) + 1; }
function textLimit(text: string): string {
  if (text.length > POLL_LIMITS.text) countPollDrop('text_truncated');
  return text.slice(0, POLL_LIMITS.text);
}

const positiveId = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
export function parsePollSubmessage(s: WidgetSubmessage): PollUpdate | null {
  if (!s || s.msg_type !== 'widget' || !positiveId(s.sender_id)) return null;
  if (typeof s.content !== 'string' || s.content.length > POLL_LIMITS.content) { countPollDrop('content_too_large'); return null; }
  let c;
  try { c = JSON.parse(s.content); } catch { return null; }
  if (!c || typeof c !== 'object') return null;
  if (c.widget_type === 'poll' && typeof c.extra_data?.question === 'string' &&
      Array.isArray(c.extra_data.options)) {
    if (c.extra_data.options.length > POLL_LIMITS.options) countPollDrop('options_truncated');
    const options = c.extra_data.options.slice(0, POLL_LIMITS.options);
    if (!options.every((x: unknown) => typeof x === 'string')) return null;
    return { type: 'init', question: textLimit(c.extra_data.question), options: options.map(textLimit) };
  }
  // Zulip 12.3 validate_poll_data allows exactly question, new_option and vote.
  // Unknown types (including other widgets) are intentionally ignored.
  if (c.type === 'question' && typeof c.question === 'string') {
    return { type: 'question', question: textLimit(c.question) };
  }
  if (c.type === 'new_option' && typeof c.option === 'string' && Number.isSafeInteger(c.idx) && c.idx >= 0 && c.idx <= 1000) {
    return { type: 'new_option', key: `${s.sender_id},${c.idx}`, text: textLimit(c.option) };
  }
  if (c.type === 'vote' && typeof c.key === 'string' && /^(canned|[1-9]\d*),\d+$/.test(c.key) && (c.vote === 1 || c.vote === -1)) {
    return { type: 'vote', key: c.key, voterId: s.sender_id, action: c.vote === 1 ? 'vote' : 'unvote' };
  }
  return null;
}

export function applyPollUpdate(state: PollState | null, update: PollUpdate | null): PollState | null {
  if (!update) return state;
  if (update.type === 'init') {
    // A replay of initialization must not erase votes already received live.
    return state ?? { question: textLimit(update.question), options: new Map(update.options.slice(0, POLL_LIMITS.options).map((text, i) =>
      [`canned,${i}`, { key: `canned,${i}`, text: textLimit(text), voters: new Set<number>() }])) };
  }
  if (!state) return null;
  if (update.type === 'question') {
    state.question = textLimit(update.question);
  } else if (update.type === 'new_option') {
    if (!state.options.has(update.key)) {
      if (state.options.size >= POLL_LIMITS.options) countPollDrop('option_limit');
      else state.options.set(update.key, { key: update.key, text: textLimit(update.text), voters: new Set() });
    }
  } else {
    const option = state.options.get(update.key);
    if (option) {
      if (update.action === 'vote') {
        if (option.voters.size < POLL_LIMITS.voters) option.voters.add(update.voterId);
        else countPollDrop('voter_limit');
      }
      else option.voters.delete(update.voterId);
    }
  }
  return state;
}

export function reconstructPoll(submessages: WidgetSubmessage[] = []): PollState | null {
  let state: PollState | null = null;
  if (!Array.isArray(submessages)) return null;
  for (const s of submessages.filter(s => s && positiveId(s.id)).sort((a, b) => a.id - b.id)) {
    state = applyPollUpdate(state, parsePollSubmessage(s));
  }
  return state;
}

export function pollContent(question: unknown, options: unknown): string {
  if (typeof question !== 'string' || !question.trim() || /[\r\n]/.test(question)) throw new Error('question must be a nonempty single line');
  if (!Array.isArray(options) || options.length < 2 || options.some(o => typeof o !== 'string' || !o.trim() || /[\r\n]/.test(o))) {
    throw new Error('options must contain at least two nonempty single-line strings');
  }
  return `/poll ${question}\n${options.join('\n')}`;
}

/** Bounds waits. zulip-js cannot cancel an underlying GET. */
export async function boundedPollRead<T>(read: Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('poll lookup timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** Shared by ALL placement writers, including ordinary history/quote GETs.
 * A stamp is taken BEFORE observing/awaiting data; writes are CAS operations.
 * Eviction advances a conservative floor, so forgetting a version can never
 * resurrect an old observation. Versions never reset when either cache evicts.
 */
export class PlacementVersions {
  private sequence = 0;
  private floor = 0;
  private versions = new Map<number, number>();
  snapshot(): number { return this.sequence; }
  current(id: number, version: number | undefined): boolean {
    return version !== undefined && this.versions.get(id) === version;
  }
  /** A propagated move may include an uncached, in-flight GET target whose
   * source is not known yet. Fence all older observations conservatively. */
  barrier(): void { this.floor = ++this.sequence; }
  canWrite(id: number, observedAt: number): boolean {
    return observedAt >= Math.max(this.versions.get(id) ?? 0, this.floor);
  }
  write(id: number, observedAt: number): number | null {
    if (!this.canWrite(id, observedAt)) return null;
    this.versions.delete(id);
    const version = ++this.sequence;
    this.versions.set(id, version);
    if (this.versions.size > 4000) {
      const oldest = this.versions.keys().next().value!;
      this.floor = Math.max(this.floor, this.versions.get(oldest)!);
      this.versions.delete(oldest);
    }
    return version;
  }
}

/** placementVersion is the envelope observation, not a second generation. */
export interface PollRecord { message?: ZulipRawMessage; state: PollState | null; placementUnknown?: boolean; placementVersion?: number }
export class PollCache {
  private records = new Map<number, PollRecord>();
  // Attempts survive record eviction. Token refill bounds all IDs, including cycles.
  private attempts = new Map<number, number>();
  private inFlight = 0;
  private tokens: number = POLL_LIMITS.lookups;
  private refilled: number;
  constructor(private cap = POLL_LIMITS.polls as number, private now = Date.now,
    readonly placements = new PlacementVersions()) {
    this.cap = Math.max(1, Math.min(cap, POLL_LIMITS.polls));
    this.refilled = now();
  }
  entry(id: number): PollRecord {
    let entry = this.records.get(id);
    if (!entry) {
      if (this.records.size >= this.cap) this.records.delete(this.records.keys().next().value!);
      entry = { state: null };
      this.records.set(id, entry);
    }
    return entry;
  }
  remember(message: ZulipRawMessage, observedAt = this.placements.snapshot()): void {
    // Ordinary messages must not evict useful polls.
    if (!message.submessages?.length) return;
    const entry = this.entry(message.id);
    const version = this.placements.write(message.id, observedAt);
    if (version === null) return;
    entry.placementUnknown = false;
    entry.placementVersion = version;
    entry.message = { ...message, submessages: undefined, content: message.content.slice(0, POLL_LIMITS.text) };
    entry.state = reconstructPoll(message.submessages) ?? entry.state;
  }
  /** Retain poll contents, but never treat the original envelope as placement. */
  invalidatePlacement(matches: (id: number, record: PollRecord) => boolean): number[] {
    const ids: number[] = [];
    for (const [id, entry] of this.records) if (matches(id, entry)) {
      entry.placementUnknown = true;
      this.placements.write(id, this.placements.snapshot());
      ids.push(id);
    }
    return ids;
  }
  async locate(client: any, id: number, refreshPlacement = false): Promise<PollRecord> {
    const entry = this.entry(id);
    if (refreshPlacement) entry.placementUnknown = true;
    if (entry.message && entry.state && !entry.placementUnknown &&
        this.placements.current(id, entry.placementVersion)) return entry;
    entry.placementUnknown = true;
    const observedAt = this.placements.snapshot();
    const now = this.now();
    for (const [key, expires] of this.attempts) if (expires <= now) this.attempts.delete(key);
    if (this.attempts.has(id)) { countPollDrop('negative_cached'); return entry; }
    this.tokens = Math.min(POLL_LIMITS.lookups, this.tokens + Math.max(0, now - this.refilled) / 3000);
    this.refilled = now;
    if (this.inFlight >= POLL_LIMITS.lookups) { countPollDrop('lookup_in_flight'); return entry; }
    if (this.tokens < 1) { countPollDrop('lookup_budget'); return entry; }
    this.tokens--;
    // At most 40 attempts fit in the TTL (20 burst + 20 refill).
    this.attempts.set(id, now + POLL_LIMITS.negativeTtlMs);
    try {
      this.inFlight++;
      const read = Promise.resolve().then(() => client.messages.getById({ message_id: id, apply_markdown: false }))
        .finally(() => { this.inFlight--; });
      const result = await boundedPollRead<any>(read);
      if (result?.result !== 'success' || result.message?.id !== id) return entry;
      if (this.records.get(id) !== entry) return entry; // Evicted while awaiting GET.
      const version = this.placements.write(id, observedAt);
      if (version === null) return entry; // A newer placement overtook this GET.
      entry.placementVersion = version;
      entry.placementUnknown = false;
      entry.message = { ...result.message, submessages: undefined, content: String(result.message.content ?? '').slice(0, POLL_LIMITS.text) };
      entry.state ??= reconstructPoll(result.message.submessages);
    } catch { /* Missing, inaccessible, malformed or timed out: no repeat GET storm. */ }
    return entry;
  }
}

/** One bounded user-directory read per adapter; no lookup per vote. */
export class PollUsers {
  private known = new Map<number, { name: string; email: string }>();
  peek() { return this.known; }
  private users?: Promise<Map<number, { name: string; email: string }>>;
  async get(client: any): Promise<Map<number, { name: string; email: string }>> {
    return this.users ??= (async () => {
      const names = new Map<number, { name: string; email: string }>();
      try {
        const result = await boundedPollRead<any>(client.users.retrieve());
        if (result?.result === 'success') for (const u of result.members ?? []) {
          if (positiveId(u.user_id) && typeof u.full_name === 'string') names.set(u.user_id, { name: u.full_name, email: u.email ?? '' });
        }
      } catch { /* Fall back to the numeric user id when the directory is unavailable. */ }
      this.known = names;
      return names;
    })();
  }
}

export function pollResults(messageId: number, state: PollState, users: Map<number, { name: string }>) {
  return { message_id: messageId, question: state.question, options: [...state.options.values()].map(o => ({
    key: o.key, text: o.text, count: o.voters.size,
    voters: [...o.voters].sort((a, b) => a - b).map(id => ({ id, name: users.get(id)?.name ?? `user ${id}` })),
  })) };
}
