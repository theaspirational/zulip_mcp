/** Zulip poll widget reducer. Fixtures are reconstructed, not captured upstream.
 * Wire assumptions: widget/extra_data initializes; vote {key,vote};
 * new_option {option,idx} uses the submessage sender as the key namespace.
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
  | { type: 'new_option'; key: string; text: string }
  | { type: 'vote'; key: string; voterId: number; action: 'vote' | 'unvote' };

const positiveId = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
export function parsePollSubmessage(s: WidgetSubmessage): PollUpdate | null {
  if (!s || s.msg_type !== 'widget' || !positiveId(s.sender_id)) return null;
  let c;
  try { c = JSON.parse(s.content); } catch { return null; }
  if (!c || typeof c !== 'object') return null;
  if (c.widget_type === 'poll' && typeof c.extra_data?.question === 'string' &&
      Array.isArray(c.extra_data.options) && c.extra_data.options.every((x: unknown) => typeof x === 'string')) {
    return { type: 'init', question: c.extra_data.question, options: c.extra_data.options };
  }
  if (c.type === 'new_option' && typeof c.option === 'string' && Number.isSafeInteger(c.idx) && c.idx >= 0) {
    return { type: 'new_option', key: `${s.sender_id},${c.idx}`, text: c.option };
  }
  if (c.type === 'vote' && typeof c.key === 'string' && /^(canned|[1-9]\d*),\d+$/.test(c.key) && typeof c.vote === 'boolean') {
    return { type: 'vote', key: c.key, voterId: s.sender_id, action: c.vote ? 'vote' : 'unvote' };
  }
  return null;
}

export function applyPollUpdate(state: PollState | null, update: PollUpdate | null): PollState | null {
  if (!update) return state;
  if (update.type === 'init') {
    // A replay of initialization must not erase votes already received live.
    return state ?? { question: update.question, options: new Map(update.options.map((text, i) =>
      [`canned,${i}`, { key: `canned,${i}`, text, voters: new Set<number>() }])) };
  }
  if (!state) return null;
  if (update.type === 'new_option') {
    if (!state.options.has(update.key)) state.options.set(update.key, { key: update.key, text: update.text, voters: new Set() });
  } else {
    const option = state.options.get(update.key);
    if (option) {
      if (update.action === 'vote') option.voters.add(update.voterId);
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

/** Bounds waits and retained poll ids (including negative lookups). zulip-js
 * cannot cancel an underlying GET; after a timeout the id stays attempted. */
export async function boundedPollRead<T>(read: Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('poll lookup timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export interface PollRecord { message?: ZulipRawMessage; state: PollState | null; attempted: boolean }
export class PollCache {
  private records = new Map<number, PollRecord>();
  constructor(private cap = 500) {}
  entry(id: number): PollRecord {
    let entry = this.records.get(id);
    if (!entry) {
      if (this.records.size >= this.cap) this.records.delete(this.records.keys().next().value!);
      entry = { state: null, attempted: false };
      this.records.set(id, entry);
    }
    return entry;
  }
  remember(message: ZulipRawMessage): void {
    // Ordinary messages must not evict useful polls.
    if (!message.submessages?.length) return;
    const entry = this.entry(message.id);
    entry.message = message;
    entry.state = reconstructPoll(message.submessages) ?? entry.state;
  }
  async locate(client: any, id: number): Promise<PollRecord> {
    const entry = this.entry(id);
    if ((entry.message && entry.state) || entry.attempted) return entry;
    entry.attempted = true;
    try {
      const result = await boundedPollRead<any>(client.messages.getById({ message_id: id, apply_markdown: false }));
      if (result?.result !== 'success' || result.message?.id !== id) return entry;
      entry.message = result.message;
      entry.state = reconstructPoll(result.message.submessages);
    } catch { /* Missing, inaccessible, malformed or timed out: no repeat GET storm. */ }
    return entry;
  }
}

/** One bounded user-directory read per adapter; no lookup per vote. */
export class PollUsers {
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
