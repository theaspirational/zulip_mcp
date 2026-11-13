import { CallerValidationError } from './validation-errors.js';
/** Wire format checked against Zulip 12.3 event_types.py, widget.py and validator.py.
 * Initial options use canned,N; added options use sender_id,idx.
 */
import type { ZulipApi } from './zulip-api.js';
import type { ZulipRawMessage } from './history.js';

export interface WidgetSubmessage {
  readEpoch?: number;
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
  content: 1_000_000, lookups: 20 } as const;
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

/** Optional voter focus avoids the display voter cap when deciding this bot's vote. */
export function reconstructPoll(submessages: WidgetSubmessage[] = [], voterId?: number): PollState | null {
  let state: PollState | null = null;
  if (!Array.isArray(submessages)) return null;
  for (const s of submessages.filter(s => s && positiveId(s.id)).sort((a, b) => a.id - b.id)) {
    const update = parsePollSubmessage(s);
    if (voterId !== undefined && update?.type === 'vote' && update.voterId !== voterId) continue;
    state = applyPollUpdate(state, update);
  }
  return state;
}

/** Keys and exact displayed text share a namespace: never guess on a collision. */
export function resolvePollOption(state: PollState, value: unknown): PollOption {
  if (typeof value !== 'string' || !value) throw new CallerValidationError('option must be a nonempty option key or exact text');
  const matches = [...state.options.values()].filter(o => o.key === value || o.text === value);
  if (!matches.length) throw new CallerValidationError('unknown poll option; use a key or exact text from get_poll_results');
  if (matches.length !== 1) throw new CallerValidationError('ambiguous poll option; use an unambiguous key from get_poll_results');
  return matches[0];
}

export function pollContent(question: unknown, options: unknown): string {
  if (typeof question !== 'string' || !question.trim() || /[\r\n]/.test(question)) throw new CallerValidationError('question must be a nonempty single line');
  if (!Array.isArray(options) || options.length < 2 || options.some(o => typeof o !== 'string' || !o.trim() || /[\r\n]/.test(o))) {
    throw new CallerValidationError('options must contain at least two nonempty single-line strings');
  }
  return `/poll ${question}\n${options.join('\n')}`;
}

/** Total budget for resolving an unplaced vote; never wait for lane frontiers. */
export const POLL_PLACEMENT_WAIT_MS = 3000;

export class PollLookupTimeout extends Error {}

/** Bounds callers; native transport also aborts timed-out GETs. */
export async function boundedPollRead<T>(read: Promise<T>, ms = POLL_PLACEMENT_WAIT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PollLookupTimeout('poll lookup timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** Bounded poll data only: never retains a message envelope or route. */
export interface PollRecord { state: PollState | null }
export class PollCache {
  private records = new Map<number, PollRecord>();
  constructor(private cap = POLL_LIMITS.polls as number) {
    this.cap = Math.max(1, Math.min(cap, POLL_LIMITS.polls));
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
  clear(): void { this.records.clear(); }
  remember(message: ZulipRawMessage): void {
    if (!message.submessages?.length) return;
    const state = reconstructPoll(message.submessages);
    if (state) this.entry(message.id).state ??= state;
  }
}

/** Adapter-wide burst/refill budget and actual outstanding-request cap.
 * No cache hits, coalescing or negative cache: every notification needs its
 * own GET started after its event. Timed-out GETs still occupy a slot until
 * the underlying request settles (a test transport may not support cancellation).
 */
export class PollLookups {
  private inFlight = 0;
  private tokens: number = POLL_LIMITS.lookups;
  private refilled: number;
  constructor(private now = Date.now, private timeoutMs = POLL_PLACEMENT_WAIT_MS) { this.refilled = now(); }
  async fetch(api: ZulipApi, id: number): Promise<ZulipRawMessage | null> {
    const now = this.now();
    this.tokens = Math.min(POLL_LIMITS.lookups, this.tokens + Math.max(0, now - this.refilled) / 3000);
    this.refilled = now;
    if (this.inFlight >= POLL_LIMITS.lookups) { countPollDrop('lookup_in_flight'); return null; }
    if (this.tokens < 1) { countPollDrop('lookup_budget'); return null; }
    this.tokens--;
    this.inFlight++;
    try {
      const read = Promise.resolve().then(() => api.requestAnswer<{ message?: ZulipRawMessage }>('GET', `/messages/${id}`, { apply_markdown: false }, { timeoutMs: this.timeoutMs }))
        .finally(() => { this.inFlight--; });
      const result = await boundedPollRead<any>(read, this.timeoutMs);
      if (result?.result !== 'success' || !result.message) {
        countPollDrop('message_unavailable'); return null;
      }
      const m = result.message;
      if (m.id !== id || !positiveId(m.sender_id) ||
          (m.type !== 'stream' && m.type !== 'private') ||
          (m.type === 'stream' && (typeof m.display_recipient !== 'string' || !m.display_recipient || typeof m.subject !== 'string')) ||
          (m.type === 'private' && (!Array.isArray(m.display_recipient) || !m.display_recipient.length ||
            !m.display_recipient.every((r: any) => r && positiveId(r.id))))) {
        countPollDrop('invalid_message'); return null;
      }
      return m;
    } catch (error) {
      countPollDrop(error instanceof PollLookupTimeout ? 'lookup_timeout' : 'lookup_failed');
      return null;
    }
  }
}

/** One bounded user-directory read per adapter; no lookup per vote. */
export class PollUsers {
  private known = new Map<number, { name: string; email: string }>();
  peek() { return this.known; }
  private users?: Promise<Map<number, { name: string; email: string }>>;
  async get(api: ZulipApi): Promise<Map<number, { name: string; email: string }>> {
    return this.users ??= (async () => {
      const names = new Map<number, { name: string; email: string }>();
      try {
        const result = await boundedPollRead<any>(api.requestAnswer<{ members?: any[] }>('GET', '/users', {}, { timeoutMs: 3000 }));
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
