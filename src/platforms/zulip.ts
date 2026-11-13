import type { StreamReadGate } from '../stream-read-gate.js';
import { PollLookups, PollUsers, reconstructPoll, applyPollUpdate, parsePollSubmessage, countPollDrop, type WidgetSubmessage } from '../polls.js';
/**
 * ZulipAdapter — Zulip implementation of PlatformAdapter.
 *
 * Channels are keyed by stream id or by a DM's user ids (channel-key.ts);
 * a stream's name comes from the stream directory at the moment it is
 * needed. Threads map to topics: incoming carries the topic as threadId,
 * and publishes route to the topic of the newest message
 * ChannelManager.noteConversation took there, else 'mcpl'. The descriptor
 * this adapter builds for a stream carries the id `zulip:{stream_name}`.
 *
 * DM conversations are discovered from recent DM history at startup and
 * described on the fly when a message from a new conversation arrives.
 */

import type {
  ChannelDescriptor,
  ContentBlock,
  ContextInjection,
  TextContent,
} from '@animalabs/mcpl-core';
import { isDmKey, dmKey, parseKey, streamIdOfKey, streamKey, type ChannelKey, type KeyedMessage } from '../channel-key.js';
import { StreamDirectory } from '../stream-directory.js';
import type {
  ChangeEntry,
  ChannelHistoryPage,
  ChannelHistoryQuery,
  MessageChangeEvent,
  OnIncomingMessage,
  OnMessageChange,
  OnReaction,
  OnSystemEvent,
  PlatformAdapter,
  PublishResult,
  ReactionEvent,
  RoutingHints,
  SentRecord,
} from './adapter.js';
import { ZulipEventLoop, type ZulipMessageChange } from './zulip-events.js';
import { cleanMarkdown } from '../content.js';
import { namePosted, NothingToSend, SendRefused, sendMessage, ZULIP_MAX_MESSAGE_LENGTH, type Destination } from '../outgoing.js';
import { ActiveTopicsCache } from '../active-topics.js';
import { LEGACY_IDS, type MessageIds } from '../message-ids.js';
import { messageLineHead } from '../message-line.js';
import { agentLineTimeFormatter } from '../timezone.js';
import { uploadBlocks, type UploadPolicy, type Uploader } from '../uploads.js';
import { isRefusal, mayHaveBeenApplied, ZulipRefused, type ZulipApi } from '../zulip-api.js';
import {
  dmChannelIdFor,
  dmCounterparts,
  dmDescriptor,
  editedTrailer,
  fetchHistory,
  keyOfMessage,
  normalizeMessage,
  looksLikeBotEmail,
  toIncoming,
  type ZulipIdentity,
  type ZulipMessage,
  type ZulipRawMessage,
} from '../history.js';

/** The address every stream descriptor carries. */
export interface ZulipChannelAddress {
  stream_name: string;
  stream_id: number;
}

export function zulipChannelId(streamName: string): string {
  return `zulip:${streamName}`;
}

const SNIPPET_MAX = 80;

/** One line of a message body, whitespace collapsed, capped; null when empty. */
export function snippetOf(text: string): string | null {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return one.length > SNIPPET_MAX ? `${one.slice(0, SNIPPET_MAX - 1)}…` : one;
}


/** Only a link immediately heading a quote fence is a reply target.
 *  Ignore fenced examples; keep only the first two distinct targets. */
function quotedMessageIds(content: string): Set<number> {
  const ids = new Set<number>();
  let pending: number | null = null;
  let fence: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) {
      if (pending !== null && marker[2].trim() === 'quote') ids.add(pending);
      if (ids.size === 2) return ids;
      fence = marker[1];
      pending = null;
      continue;
    }
    if (!line.trim()) continue;
    const header = /^(?:@_\*\*[^\r\n]*\*\* )?\[[^\]\n]*\]\s*\([^\s)]*\/near\/([1-9]\d*)\)\s*[:：][ \t]*$/.exec(line);
    const id = header ? Number(header[1]) : NaN;
    pending = Number.isSafeInteger(id) ? id : null;
  }
  return ids;
}

type QuoteLookup = { authorId: number } | null | 'budget-skipped';
type QuoteVerdict = 'reply' | 'not-reply' | 'ineligible' | 'unverified' | 'budget-skipped';

interface ZulipStream {
  stream_id?: number;
  name: string;
  subscriber_count?: number;
  invite_only?: boolean;
}

/** A recently seen message, as the cache places reactions and changes. */
interface SeenMessage {
  readEpoch?: number;
  key: ChannelKey;
  authorId: number;
  authorName: string;
  authorEmail: string;
  isDm: boolean;
  topic: string;
  snippet: string | null;
  /** Zulip's mention verdict. */
  mentioned: boolean;
  replyToSelf: boolean;
  quoteTargets: ReadonlySet<number>;
}

/** How long a GET placing a change may take before the change is dropped
 *  rather than wedging every change behind it. */
const LOCATE_TIMEOUT_MS = 15_000;
/** Wait budget for one incoming stream message's quote targets. */
const QUOTE_TIMEOUT_MS = 3_000;
/** Maximum uncached quote-target GETs shared by a history page. */
const HISTORY_QUOTE_GET_CAP = 8;
/** Avoid repeatedly GETting inaccessible/deleted targets; retry after three minutes. */
const FAILED_LOOKUP_TTL_MS = 3 * 60_000;
/** How long the bot's own deletion is remembered so its echo is dropped. */
const SELF_DELETE_TTL_MS = 10 * 60_000;
const SELF_DELETE_CAP = 500;
/** How long the stream list isn't read again for the same stream id or name. */
const STREAM_REFRESH_HOLDOFF_MS = 60_000;
/** How long "moved to a stream the bot cannot see" explains a following delete event. */
const MOVED_AWAY_TTL_MS = 60_000;

/** Process-wide quote-only bucket: burst 30, sustained 30 GETs/minute.
 *  Sends, reactions and edit placement do not spend these tokens. */
const QUOTE_GET_BURST = 30;
const QUOTE_GET_REFILL_PER_MS = 30 / 60_000;

/** The live filters the adapter consults — the plane, or a stand-in. */
export interface FilterView {
  subscriptions?: import("../subscriptions.js").Subscriptions;
  streamAllowed(streamName: string, streamId?: number): boolean;
  dmAllowed(sender: { id: number; email: string }): boolean;
}

const ALLOW_ALL: FilterView = { streamAllowed: () => true, dmAllowed: () => true };

export interface ZulipAdapterOptions {
  activeTopics?: number;
  activeTopicsTtlMs?: number;
  messageIds?: MessageIds;
  /** Backscroll cap advertised per channel and enforced on channels/open. */
  backscrollDefault?: number;
  /** Per-stream overrides of the backscroll cap. */
  backscrollLimits?: ReadonlyMap<string, number>;
  /** Stream allowlist + DM allowlist, read live on every event. */
  filters?: FilterView;
  /** How many recent DMs to scan for conversations at startup. */
  dmDiscoveryLimit?: number;
  directory?: StreamDirectory;
  /** The realm's max message length; longer publishes are split. */
  maxMessageLength?: number;
  /** Uploads for the media blocks of a publish (image/audio with inline data). Unset: such blocks are dropped. */
  uploader?: Uploader;
  /** Size and count limits for those uploads. Required with `uploader`. */
  uploadPolicy?: UploadPolicy;
  /** Line time for the recent history injected before inference (default: the agent line time from env). */
  formatTime?: (d: Date) => string;
}

export const DEFAULT_BACKSCROLL = 500;
const DEFAULT_DM_DISCOVERY_LIMIT = 300;

export class ZulipAdapter implements PlatformAdapter {
  readonly type = 'zulip';
  onSent: ((sent: SentRecord) => void) | null = null;

  private eventLoop: ZulipEventLoop | null = null;
  private readonly identity: ZulipIdentity;
  private readonly backscrollDefault: number;
  private readonly backscrollLimits: ReadonlyMap<string, number>;
  private backscrollFormerSaid = new Map<string, string | undefined>();
  private readonly filters: FilterView;
  private readonly dmDiscoveryLimit: number;
  private readonly maxMessageLength: number;
  private readonly uploader: Uploader | null;
  private readonly uploadPolicy: UploadPolicy | null;
  private readonly formatTime: (d: Date) => string;
  readonly directory: StreamDirectory;
  /** DM conversations already described to the server, by channel id. */
  private knownDms = new Map<string, ChannelDescriptor>();
  /** Recently seen messages, so a reaction or an edit can be placed without
   *  a round trip: id → channel, author, topic, snippet. Bounded; oldest
   *  evicted. A deletion can only be placed from here — the message is gone. */
  private seen = new Map<number, SeenMessage>();
  private static readonly SEEN_CAP = 2000;
  private static quoteBudget = { tokens: QUOTE_GET_BURST, updatedAt: performance.now() };

  private static takeQuoteToken(): boolean {
    const budget = ZulipAdapter.quoteBudget;
    const now = performance.now();
    budget.tokens = Math.min(QUOTE_GET_BURST, budget.tokens + Math.max(0, now - budget.updatedAt) * QUOTE_GET_REFILL_PER_MS);
    budget.updatedAt = now;
    if (budget.tokens < 1) return false;
    budget.tokens--;
    return true;
  }

  /** Failed quote-target GETs only; id → retry-after timestamp. Bounded like seen. */
  private failedQuoteLookups = new Map<number, number>();
  /** Messages this adapter deleted itself (rollback, the delete tool), by
   *  id → when: Zulip's delete event names no actor, so the echo of the
   *  bot's own deletion is recognised here and dropped. Bounded and expiring
   *  — a failed delete never echoes. */
  private selfDeleted = new Map<number, number>();
  /** What the stream list was last read for, a stream id or a name the
   *  directory did not hold, and when. */
  private readonly listReadFor = new Map<string, number>();
  private listRead: Promise<boolean> | null = null;
  /** Messages just moved to a stream the bot cannot see, by id → when: the
   *  delete event Zulip sends for lost visibility is a vanishing, not a deletion. */
  private streamGate?: StreamReadGate;
  private readonly originalApi: ZulipApi;
  private readonly pollLookups = new PollLookups();
  private readonly pollUsers = new PollUsers();
  private activeTopics: ActiveTopicsCache;
  private readonly activeTopicsConfig: Pick<ZulipAdapterOptions, 'activeTopics' | 'activeTopicsTtlMs'>;
  private readonly messageIds: MessageIds;
  private movedAway = new Map<number, number>();
  private readonly changeOf = new WeakMap<ChangeEntry, ZulipMessageChange>();
  private placing = 0;
  private placed: Promise<void> = Promise.resolve();

  constructor(
    private api: ZulipApi,
    selfUserId: number | null,
    sessionId: string,
    options: ZulipAdapterOptions = {},
  ) {
    this.activeTopicsConfig = options;
    this.originalApi = api;
    this.activeTopics = new ActiveTopicsCache(this.api, options.activeTopics, Date.now, options.activeTopicsTtlMs);
    this.messageIds = options.messageIds ?? LEGACY_IDS;
    this.identity = { selfUserId, sessionId };
    this.backscrollDefault = options.backscrollDefault ?? DEFAULT_BACKSCROLL;
    this.backscrollLimits = options.backscrollLimits ?? new Map();
    this.filters = options.filters ?? ALLOW_ALL;
    this.dmDiscoveryLimit = options.dmDiscoveryLimit ?? DEFAULT_DM_DISCOVERY_LIMIT;
    this.maxMessageLength = options.maxMessageLength ?? ZULIP_MAX_MESSAGE_LENGTH;
    this.uploader = options.uploader ?? null;
    this.uploadPolicy = options.uploadPolicy ?? null;
    this.formatTime = options.formatTime ?? agentLineTimeFormatter();
    this.directory = options.directory ?? new StreamDirectory();
    if (this.backscrollLimits.size > 0) {
      void this.directory.whenFilled().then(() => this.logFormerBackscrollNames());
      this.directory.onChange((change) => {
        if (change.renamed.length > 0 && this.directory.isFilled) this.logFormerBackscrollNames();
      });
    }
    if (this.uploader && !this.uploadPolicy) throw new Error('ZulipAdapter: uploader needs an uploadPolicy');
  }

  private logFormerBackscrollNames(): void {
    for (const name of this.backscrollLimits.keys()) {
      const former = this.directory.formerOf(name);
      const said = former ? `${former.id}:${former.current}` : undefined;
      if (this.backscrollFormerSaid.get(name) === said) continue;
      this.backscrollFormerSaid.set(name, said);
      if (former) console.error(`[zulip-mcp] ZULIP_BACKSCROLL_CHANNELS names #${name}, which Zulip stream ${former.id} had before it was renamed #${former.current}; the default cap applies to it`);
    }
  }

  /** The history cap for a stream (descriptor `capabilities.history.maxMessages`), by its current name. */
  backscrollLimitFor(streamName: string): number {
    return this.backscrollLimits.get(streamName) ?? this.backscrollDefault;
  }

  private streamAllowed(streamId: number): boolean {
    const name = this.directory.nameOf(streamId);
    return name !== undefined && this.filters.streamAllowed(name, streamId);
  }

  async refreshSubscriptions(): Promise<void> { await this.filters.subscriptions?.connect(this.originalApi, this.identity.selfUserId, true); }

  setStreamReadPolicy(gate: StreamReadGate): void { this.streamGate = gate; this.api = gate.api(this.originalApi); this.activeTopics = new ActiveTopicsCache(this.api, this.activeTopicsConfig.activeTopics, Date.now, this.activeTopicsConfig.activeTopicsTtlMs); void this.filters.subscriptions?.connect(this.originalApi, this.identity.selfUserId); }

  purgeUnavailable(key?: ChannelKey): void {
    if (!this.streamGate) return;
    for (const [id, m] of this.seen) if (!isDmKey(m.key) && (key ? m.key === key : !this.streamGate.allowed(streamIdOfKey(m.key)!))) this.seen.delete(id);
    this.failedQuoteLookups.clear();
    this.activeTopics.purgeUnavailable(id => key ? streamKey(id) !== key : this.streamGate!.allowed(id));
  }

  get selfUserId(): number | null {
    return this.identity.selfUserId;
  }

  async discoverChannels(): Promise<ChannelDescriptor[]> {
    return this.streamGate ? this.streamGate.run(() => this.discoverScopedChannels()) : this.discoverScopedChannels();
  }
  private async discoverScopedChannels(): Promise<ChannelDescriptor[]> {
    const epoch = this.streamGate?.checkpoint();
    const channels: ChannelDescriptor[] = [];
    try {
      const result = await this.originalApi.request<{ streams?: ZulipStream[] }>('GET', '/streams', 'listing streams', {
        include_public: true,
        include_subscribed: true,
      });
      if (!Array.isArray(result.streams)) throw new Error('the answer carried no stream list');
      const streams = result.streams;
      this.directory.list(streams);
      this.filters.subscriptions?.observe(streams.filter((s): s is ZulipStream & { stream_id: number } => typeof s.stream_id === "number"));
      for (const stream of streams) {
        if (typeof stream.stream_id !== 'number' || !this.streamAllowed(stream.stream_id)) continue;
        const descriptor = this.streamDescriptor(stream.stream_id, {
          subscriber_count: stream.subscriber_count,
          is_public: !stream.invite_only,
        });
        if (descriptor) { this.streamGate?.assertFresh(stream.stream_id, epoch!); channels.push(descriptor); }
      }
    } catch (error) {
      console.error('Failed to discover Zulip streams:', error);
    }
    channels.push(...(await this.discoverDmChannels()));
    return channels;
  }

  /**
   * The descriptor for a stream, under its current name. Built from
   * discovery and, for a stream the bot joined after startup, from the first
   * message that arrives on it — both must describe the same channel, so
   * they share this (#20). null for a stream the directory does not hold.
   */
  streamDescriptor(streamId: number, metadata: Record<string, unknown> = {}): ChannelDescriptor | null {
    if (this.streamGate && !this.streamGate.allowed(streamId)) return null;
    const name = this.directory.nameOf(streamId);
    if (name === undefined) return null;
    metadata = { ...metadata, ...(this.streamGate ? { readEpoch: this.streamGate.checkpoint() } : {}) };
    const address: ZulipChannelAddress = { stream_name: name, stream_id: streamId };
    const descriptor: ChannelDescriptor = {
      id: zulipChannelId(name),
      type: 'zulip',
      label: `#${name}`,
      direction: 'bidirectional',
      address,
      metadata,
      capabilities: {
        history: {
          maxMessages: this.backscrollLimitFor(name),
          supportsBeforeMessage: true,
          supportsSinceLastSeen: true,
        },
      },
    };
    return descriptor;
  }

  /**
   * Descriptors for stream channels. A stream the directory does not hold
   * can cost one read of the stream list; one still unknown after it, or one
   * outside the allowlist, is never described. A DM is described by its
   * first message.
   */
  async describeChannels(keys: ChannelKey[]): Promise<ChannelDescriptor[]> {
    const out: ChannelDescriptor[] = [];
    for (const key of keys) {
      const streamId = streamIdOfKey(key);
      if (streamId === null || !(await this.knownStream(streamId)) || !this.streamAllowed(streamId)) continue;
      const descriptor = this.streamDescriptor(streamId);
      if (descriptor) out.push(descriptor);
    }
    return out;
  }

  /**
   * DM conversations the bot has been part of recently. Zulip has no
   * "list my DM conversations" call; the recent DM history is the source.
   */
  private async discoverDmChannels(): Promise<ChannelDescriptor[]> {
    if (this.dmDiscoveryLimit <= 0) return [];
    try {
      const result = await this.api.request<{ messages?: ZulipRawMessage[] }>('GET', '/messages', 'recent direct messages', {
        anchor: 'newest',
        num_before: this.dmDiscoveryLimit,
        num_after: 0,
        narrow: [['is', 'dm']],
        apply_markdown: false,
        include_anchor: true,
      });
      for (const raw of result.messages ?? []) {
        const m = normalizeMessage(raw);
        if (!m.isDm) continue;
        if (!this.filters.dmAllowed({ id: m.authorId, email: m.authorEmail }) && m.authorId !== this.identity.selfUserId) continue;
        this.describeDm(m);
      }
    } catch (error) {
      console.error('Failed to discover Zulip DM conversations:', (error as Error).message);
    }
    return [...this.knownDms.values()];
  }

  private remember(key: ChannelKey, m: ZulipMessage): void {
    this.failedQuoteLookups.delete(m.id);
    this.movedAway.delete(m.id);
    if (!this.seen.has(m.id) && this.seen.size >= ZulipAdapter.SEEN_CAP) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(m.id, {
      readEpoch: this.streamGate?.checkpoint(),
      key,
      authorId: m.authorId,
      authorName: m.authorName,
      authorEmail: m.authorEmail,
      isDm: m.isDm,
      topic: m.topic,
      snippet: snippetOf(m.cleanContent),
      mentioned: m.mentioned,
      replyToSelf: m.replyToSelf,
      quoteTargets: quotedMessageIds(m.rawContent),
    });
  }

  private cached(id: number): SeenMessage | undefined {
    const m = this.seen.get(id);
    if (m && this.streamGate && !isDmKey(m.key) && !this.streamGate.fresh(streamIdOfKey(m.key)!, m.readEpoch)) return undefined;
    if (m && this.streamGate && !isDmKey(m.key)) this.streamGate.assert(streamIdOfKey(m.key)!);
    return m;
  }

  private quoteLookupFailed(messageId: number): boolean {
    const retryAfter = this.failedQuoteLookups.get(messageId);
    if (retryAfter !== undefined && Date.now() < retryAfter) return true;
    this.failedQuoteLookups.delete(messageId);
    return false;
  }

  private rememberFailedQuoteLookup(messageId: number): void {
    if (this.failedQuoteLookups.size >= ZulipAdapter.SEEN_CAP) {
      const oldest = this.failedQuoteLookups.keys().next().value;
      if (oldest !== undefined) this.failedQuoteLookups.delete(oldest);
    }
    this.failedQuoteLookups.set(messageId, Date.now() + FAILED_LOOKUP_TTL_MS);
  }

  /** Where a message lives — from the recent-messages cache, else one GET. */
  private async locate(messageId: number, purpose = 'a reaction', timeoutMs = LOCATE_TIMEOUT_MS, quoteLookup = false): Promise<SeenMessage | null> {
    const cached = this.cached(messageId);
    if (cached) return cached;
    const epoch = this.streamGate?.checkpoint();
    try {
      const result = await this.api.requestAnswer<{ message?: ZulipRawMessage }>(
        'GET', `/messages/${messageId}`, { apply_markdown: false }, { timeoutMs },
      );
      // This endpoint uses BAD_REQUEST for both missing and inaccessible ids.
      // Older (pre-5.0) servers omit code; only then use the legacy text.
      if (quoteLookup && result.result === 'error' &&
          (result.code === 'BAD_REQUEST' || (result.code === undefined && result.msg === 'Invalid message(s)'))) return null;
      if (isRefusal(result)) throw new ZulipRefused(`message ${messageId}`, result);
      const raw = result.message;
      if (!raw) throw new Error('response contained no message');
      if (raw.id !== messageId) throw new Error('response contained a different message id');
      if (!Number.isSafeInteger(raw.sender_id) || raw.sender_id <= 0) throw new Error('response contained no valid sender_id');
      const m = normalizeMessage(raw);
      const key = await this.keyFor(m, raw);
      if (key === null) {
        if (quoteLookup) throw new Error(`the stream of message ${messageId} is not in the stream list yet`);
        return null;
      }
      if (this.streamGate && !m.isDm) this.streamGate.assertFresh(m.streamId ?? undefined, epoch!);
      this.remember(key, m);
      return this.cached(messageId) ?? null;
    } catch (err) {
      console.error(`[zulip-mcp] could not resolve message ${messageId} for ${purpose}:`, (err as Error).message);
      if (quoteLookup) throw err;
      return null;
    }
  }

  /** Cache explicit invalid-id errors only; transient failures must get
   *  a fresh chance in the deferred pass. */
  private async resolveQuoteTarget(id: number, remainingMs: number): Promise<QuoteLookup> {
    if (!ZulipAdapter.takeQuoteToken()) return 'budget-skipped';
    try {
      const quoted = await this.locate(id, 'a quote reply', remainingMs, true);
      if (!quoted) this.rememberFailedQuoteLookup(id);
      return quoted;
    } catch {
      return 'budget-skipped';
    }
  }

  /** Verify at most two quote targets; all readers use the same classifier.
   *  Cached authors remain usable even after the lookup budget is exhausted. */
  private async classifyQuoteReply(
    m: Pick<ZulipMessage, 'mentioned' | 'isDm' | 'authorId' | 'authorEmail' | 'rawContent'>,
    resolve = async (id: number, remainingMs: number): Promise<QuoteLookup> => {
      const known = this.cached(id);
      if (known) return known;
      if (this.quoteLookupFailed(id)) return null;
      if (remainingMs <= 0) return 'budget-skipped';
      return this.resolveQuoteTarget(id, remainingMs);
    },
    deadline = performance.now() + QUOTE_TIMEOUT_MS,
  ): Promise<QuoteVerdict> {
    const targets = quotedMessageIds(m.rawContent);
    if (targets.size === 0) return 'not-reply';
    if (m.mentioned || m.isDm || this.identity.selfUserId === null || m.authorId === this.identity.selfUserId || looksLikeBotEmail(m.authorEmail)) return 'ineligible';
    let verdict: QuoteVerdict = 'not-reply';
    for (const id of targets) {
      const quoted = await resolve(id, deadline - performance.now());
      if (quoted === 'budget-skipped') verdict = 'budget-skipped';
      else if (quoted === null) {
        if (verdict !== 'budget-skipped') verdict = 'unverified';
      } else if (quoted.authorId === this.identity.selfUserId) return 'reply';
    }
    return verdict;
  }

  /** Only an unresolved lookup of the same targets can retain a verified
   *  reply. Ineligible messages and confident negatives always clear it. */
  private replyToSelfForVerdict(verdict: QuoteVerdict, targets: ReadonlySet<number>, previous: SeenMessage | null | undefined): boolean {
    return verdict === 'reply' ||
      ((verdict === 'budget-skipped' || verdict === 'unverified') && previous?.replyToSelf === true &&
        targets.size === previous.quoteTargets.size && [...targets].every((id) => previous.quoteTargets.has(id)));
  }

  /**
   * The allowlists as the live event path applies them to a placed message.
   * A DM is judged by its sender; the bot's own DM message has no sender to
   * judge and is left to the server's per-conversation check.
   */
  private changeAllowed(where: SeenMessage): boolean {
    const parsed = parseKey(where.key);
    if (parsed.kind === 'dm') {
      if (this.identity.selfUserId !== null && where.authorId === this.identity.selfUserId) {
        // The bot's own DM message: judged by whom it was sent to.
        return parsed.userIds.some((id) => this.filters.dmAllowed({ id, email: '' }));
      }
      return this.filters.dmAllowed({ id: where.authorId, email: where.authorEmail });
    }
    return this.streamAllowed(parsed.streamId);
  }

  private keyNow(m: ZulipMessage, raw: Pick<ZulipRawMessage, 'display_recipient'>): ChannelKey | null {
    if (m.isDm) return keyOfMessage(m, this.identity.selfUserId);
    if (m.streamId !== null) return streamKey(m.streamId);
    const id = typeof raw.display_recipient === 'string' ? this.directory.idOf(raw.display_recipient) : undefined;
    return id !== undefined ? streamKey(id) : null;
  }

  private changeKeyNow(change: ZulipMessageChange): ChannelKey | null {
    if (change.kind === 'edit') {
      const cached = this.cached(change.messageId);
      if (cached) return cached.key;
    } else {
      for (const id of change.messageIds) {
        const cached = this.cached(id);
        if (cached) return cached.key;
      }
    }
    return change.streamId !== null ? streamKey(change.streamId) : null;
  }

  private inOrder(current: () => boolean, place: () => Promise<void>): void {
    this.placing++;
    this.placed = this.placed
      .then(() => (current() ? place() : undefined))
      .catch((err) => { console.error('[zulip-mcp] placing an event failed:', (err as Error).message); })
      .finally(() => { this.placing--; });
  }

  private async keyFor(m: ZulipMessage, raw: Pick<ZulipRawMessage, 'display_recipient'>): Promise<ChannelKey | null> {
    if (m.isDm) return keyOfMessage(m, this.identity.selfUserId);
    let streamId = m.streamId;
    if (streamId === null) {
      const name = typeof raw.display_recipient === 'string' ? raw.display_recipient : null;
      if (name !== null && this.directory.idOf(name) === undefined) await this.refreshStreams(`#${name}`);
      streamId = name !== null ? this.directory.idOf(name) ?? null : null;
      if (streamId === null) {
        console.error(`[zulip-mcp] dropping message ${m.id}: it carries no stream id, and no stream is named ${name === null ? '(none)' : `#${name}`}`);
        return null;
      }
    }
    if (!(await this.knownStream(streamId))) {
      console.error(`[zulip-mcp] dropping message ${m.id}: stream ${streamId} is not in the stream list`);
      return null;
    }
    return streamKey(streamId);
  }

  /**
   * An edit, move or deletion from the event queue, cleaned for the server
   * in the channel it was placed in. A change someone else made to the
   * bot's message is news. A deletion is described from the cache (the
   * message is gone), or else by the stream the event names alone — a
   * deleted DM the cache never saw cannot be placed and is dropped.
   */
  private async onZulipChange(change: ZulipMessageChange, located?: SeenMessage, only?: readonly number[]): Promise<MessageChangeEvent | null> {
    const epoch = change.readEpoch ?? this.streamGate?.checkpoint();
    if (this.streamGate) {
      if (change.streamId !== null && !this.streamGate.fresh(change.streamId, epoch)) return null;
      if (change.kind === 'edit' && change.newStreamId !== null && !this.streamGate.fresh(change.newStreamId, epoch)) return null;
    }
    this.activeTopics.invalidate(change.streamId);
    if (change.kind === "edit" && change.newStreamId !== null) this.activeTopics.invalidate(change.newStreamId);
    const self = this.identity.selfUserId;
    if (change.kind === 'edit') {
      // A cache miss GETs the message as it reads NOW. For a content edit
      // that is the right place; for a cross-stream move it is the stream
      // the message went to, and the agent only ever saw it in the one it
      // came from — which the event names.
      const known = located ? null : this.cached(change.messageId) ?? null;
      const first = located ?? known ?? await this.locate(change.messageId, 'an edit');
      const id = first ? change.messageId : change.messageIds.find((m) => this.seen.has(m)) ?? change.messageId;
      const cached = first ? known : this.cached(id) ?? null;
      const where = first ?? cached;
      if (!where) return null;
      const crossStream = change.newStreamId !== null && !where.isDm;
      // A cross-stream move of an uncached message whose origin the event
      // doesn't name has nowhere honest to go: the GET only knows the destination.
      if (crossStream && !cached && change.streamId === null) {
        console.error(`[zulip-mcp] dropping a move of message ${id}: the event names no origin stream`);
        return null;
      }
      const fromKey = crossStream && change.streamId !== null ? streamKey(change.streamId) : where.key;
      const placed: SeenMessage = { ...where, key: fromKey };
      if (!this.changeAllowed(placed)) return null;
      const raw = id === change.messageId ? change.content : null;
      const flags = id === change.messageId ? change.flags : [];
      const content = raw !== null ? cleanMarkdown(raw) : null;
      const previousContent = raw !== null && change.origContent !== null ? cleanMarkdown(change.origContent) : null;
      const topic = change.topic ?? where.topic;
      const movedToKey = crossStream && (await this.knownStream(Number(change.newStreamId))) ? streamKey(Number(change.newStreamId)) : null;
      // Zulip's verdict on the new content replaces the cached one only when
      // the content changed; a move keeps the mention it had (the event's
      // flags are not relied on to be present for a move).
      const mentioned = content !== null ? flags.includes('mentioned') : (where.mentioned || flags.includes('mentioned'));
      const replyVerdict = raw !== null
        ? await this.classifyQuoteReply({ ...where, rawContent: raw, mentioned })
        : null;
      const quoteTargets = raw !== null ? quotedMessageIds(raw) : where.quoteTargets;
      const replyToSelf = replyVerdict !== null ? this.replyToSelfForVerdict(replyVerdict, quoteTargets, where) : where.replyToSelf;
      // Keep the cache current: a later reaction or deletion reads the message
      // as it now is. A move re-seats every co-moved message, not only the one
      // acted on.
      this.seen.set(id, {
        ...where,
        topic,
        mentioned,
        replyToSelf,
        quoteTargets,
        ...(content !== null ? { snippet: snippetOf(content) } : {}),
        ...(movedToKey !== null ? { key: movedToKey } : {}),
      });
      if (change.topic !== null || movedToKey !== null) {
        for (const other of change.messageIds) {
          if (other === id) continue;
          const co = this.cached(other);
          if (co) this.seen.set(other, { ...co, topic, ...(movedToKey !== null ? { key: movedToKey } : {}) });
        }
      }
      if (crossStream && movedToKey === null) {
        const now = Date.now();
        for (const [old, at] of this.movedAway) if (now - at > MOVED_AWAY_TTL_MS) this.movedAway.delete(old);
        for (const moved of change.messageIds) this.movedAway.set(moved, now);
      } else if (movedToKey !== null) {
        for (const moved of change.messageIds) this.movedAway.delete(moved);
      }
      return {
        kind: content !== null ? 'edit' : 'move',
        key: fromKey,
        messageId: String(id),
        messageIds: change.messageIds.map(String),
        authorId: String(where.authorId),
        authorName: where.authorName,
        authorEmail: where.authorEmail,
        actorId: change.actorId !== null ? String(change.actorId) : null,
        topic,
        previousTopic: change.topic !== null ? change.origTopic : null,
        movedToKey,
        leftChannel: crossStream,
        byBot: self !== null && change.actorId === self,
        content,
        previousContent,
        mentioned,
        replyToSelf,
        ...(replyVerdict !== null ? { replyToSelfVerified: replyVerdict === 'reply' || replyVerdict === 'not-reply' } : {}),
        previouslyReplyToSelf: cached ? cached.replyToSelf : null,
        // The cache holds the pre-change verdict; a GET only the post-change one.
        previouslyMentioned: cached ? cached.mentioned : null,
        vanished: false,
        isDM: where.isDm,
        onOwnMessage: self !== null && where.authorId === self,
        timestamp: new Date(change.editedAt * 1000),
      };
    }

    // The bot's own deletions (rollback, the delete tool) echo back without
    // an actor: drop what this adapter deleted itself.
    const ids = change.messageIds.filter((id) => (only === undefined || only.includes(id)) && !this.wasSelfDeleted(id));
    if (ids.length === 0) return null;
    // A bulk deletion is reported under an id the cache can vouch for, so the
    // line never shows one message's id with another's author and quote.
    const placedId = ids.find((id) => this.seen.has(id)) ?? ids[0];
    const cached = this.cached(placedId) ?? null;
    const now = Date.now();
    const vanished = ids.some((id) => {
      const at = this.movedAway.get(id);
      return at !== undefined && now - at <= MOVED_AWAY_TTL_MS;
    });
    for (const id of ids) { this.seen.delete(id); this.movedAway.delete(id); }
    if (cached) {
      if (!this.changeAllowed(cached)) return null;
      return {
        kind: 'delete',
        key: cached.key,
        messageId: String(placedId),
        messageIds: ids.map(String),
        authorId: String(cached.authorId),
        authorName: cached.authorName,
        authorEmail: cached.authorEmail,
        actorId: null,
        topic: change.topic ?? cached.topic,
        previousTopic: null,
        movedToKey: null,
        leftChannel: false,
        byBot: false,
        content: null,
        previousContent: cached.snippet,
        // A deleted mention is the one the agent was about to answer.
        mentioned: cached.mentioned,
        replyToSelf: cached.replyToSelf,
        previouslyReplyToSelf: cached.replyToSelf,
        previouslyMentioned: cached.mentioned,
        vanished,
        isDM: cached.isDm,
        onOwnMessage: self !== null && cached.authorId === self,
        timestamp: new Date(),
      };
    }
    if (change.messageType === 'stream' && change.streamId !== null) {
      if (!(await this.knownStream(change.streamId)) || !this.streamAllowed(change.streamId)) return null;
      return {
        kind: 'delete',
        key: streamKey(change.streamId),
        messageId: String(placedId),
        messageIds: ids.map(String),
        authorId: null,
        authorName: null,
        authorEmail: null,
        actorId: null,
        topic: change.topic ?? '',
        previousTopic: null,
        movedToKey: null,
        leftChannel: false,
        byBot: false,
        content: null,
        previousContent: null,
        mentioned: false,
        previouslyMentioned: null,
        vanished,
        isDM: false,
        onOwnMessage: false,
        timestamp: new Date(),
      };
    }
    return null;
  }

  /** The descriptor for a DM's conversation, remembered once described. */
  private describeDm(m: ZulipMessage): ChannelDescriptor {
    const counterparts = dmCounterparts(m.recipients, this.identity.selfUserId);
    const descriptor = dmDescriptor(counterparts, this.backscrollDefault);
    this.knownDms.set(descriptor.id, descriptor);
    return descriptor;
  }

  async publish(
    target: ChannelKey | { streamName: string },
    _descriptor: ChannelDescriptor | undefined,
    content: ContentBlock[],
    hints?: RoutingHints,
  ): Promise<PublishResult> {
    const textContent = content
      .filter((c): c is TextContent => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    // Image and audio blocks ride along as uploads, linked after the text
    // (Zulip's own attachment form). Uploads happen before the send, so a
    // failed upload fails the publish whole; a send that fails after them
    // leaves unreferenced uploads, which Zulip garbage-collects.
    const uploader = this.uploader;
    const uploadPolicy = this.uploadPolicy;
    const upload = uploader && uploadPolicy ? () => uploadBlocks(uploader, content, uploadPolicy) : undefined;

    const parsed = typeof target === 'string' ? parseKey(target) : null;
    if (this.streamGate && parsed?.kind !== 'dm') {
      const id = parsed?.kind === 'stream' ? parsed.streamId : this.streamGate.named((target as { streamName: string }).streamName);
      const epoch = typeof hints?.metadata?.readEpoch === 'number' ? hints.metadata.readEpoch : this.streamGate.checkpoint();
      this.streamGate.assertFresh(id, epoch);
      for (const dependency of Array.isArray(hints?.metadata?.readStreamIds) ? hints.metadata.readStreamIds : []) this.streamGate.assertFresh(Number(dependency), epoch);
    }
    let destination: Destination;
    let channelId: string;
    let what: string;
    if (parsed?.kind === 'dm') {
      destination = { type: 'private', to: parsed.userIds };
      channelId = dmChannelIdFor(parsed.userIds);
      what = `direct message to ${channelId}`;
    } else {
      // Route to the topic of the newest message noteConversation took on
      // this channel (in-thread answers); fall back to the 'mcpl' topic when
      // the agent initiates the conversation.
      const topic =
        (typeof hints?.metadata?.topic === 'string' ? hints.metadata.topic : undefined) ??
        hints?.threadId ??
        'mcpl';
      const streamName = parsed?.kind === 'stream' ? this.directory.nameOf(parsed.streamId) ?? String(parsed.streamId) : (target as { streamName: string }).streamName;
      destination = { type: 'stream', to: parsed?.kind === 'stream' ? parsed.streamId : streamName, topic };
      channelId = zulipChannelId(streamName);
      what = `message to #${streamName}`;
    }

    const posted: number[] = [];
    try {
      const { chunks } = await sendMessage(this.api, destination, textContent, {
        limit: this.maxMessageLength,
        unlinkable: 'as-typed',
        ...(upload ? { upload } : {}),
        onChunk: (chunk) => {
          posted.push(chunk.id);
          this.onSent?.({ messageId: String(chunk.id), channelId, content: chunk.content });
        },
      });
      const messageIds = chunks.map((c) => String(c.id));
      return { delivered: true, messageId: messageIds[messageIds.length - 1], messageIds };
    } catch (err) {
      if (err instanceof NothingToSend) return { delivered: false };
      if (err instanceof SendRefused) throw namePosted(new ZulipRefused(what, err.answer), posted);
      throw err instanceof Error ? namePosted(err, posted) : err;
    }
  }

  /** Mark a message as seen: a reaction, 👀 by default. `value` may be an emoji name (':eyes:' / 'eyes'). */
  async acknowledge(_key: ChannelKey | null, messageId: string, value?: string): Promise<string> {
    const name = (value ?? '').trim().replace(/^:|:$/g, '') || 'eyes';
    await this.api.request('POST', `/messages/${Number(messageId)}/reactions`, `acknowledging message ${messageId}`, { emoji_name: name, reaction_type: 'unicode_emoji' });
    return `:${name}:`;
  }

  async deleteMessage(_channelId: string, messageId: string): Promise<void> {
    const id = Number(messageId);
    this.noteSelfDeleted(id);
    try {
      await this.api.request('DELETE', `/messages/${id}`, `deleting message ${messageId}`);
    } catch (err) {
      if (!mayHaveBeenApplied(err)) this.selfDeleted.delete(id);
      throw err;
    }
  }

  /** A message the bot deleted through another path (the delete tool): its
   *  delete event is the bot's own doing and must not surface. */
  noteSelfDeleted(messageId: number): void {
    if (!Number.isFinite(messageId)) return;
    const now = Date.now();
    for (const [id, at] of this.selfDeleted) {
      if (now - at > SELF_DELETE_TTL_MS) this.selfDeleted.delete(id);
    }
    this.selfDeleted.delete(messageId);
    if (this.selfDeleted.size >= SELF_DELETE_CAP) {
      const oldest = this.selfDeleted.keys().next().value;
      if (oldest !== undefined) this.selfDeleted.delete(oldest);
    }
    this.selfDeleted.set(messageId, now);
  }

  forgetSelfDeleted(messageId: number): void {
    this.selfDeleted.delete(messageId);
  }

  whereSeen(messageId: string): { key: ChannelKey; topic: string } | null {
    const id = Number(messageId);
    const seen = this.cached(id);
    if (!seen || seen.isDm || this.movedAway.has(id)) return null;
    return { key: seen.key, topic: seen.topic };
  }

  private wasSelfDeleted(messageId: number): boolean {
    const at = this.selfDeleted.get(messageId);
    if (at === undefined) return false;
    this.selfDeleted.delete(messageId);
    return Date.now() - at <= SELF_DELETE_TTL_MS;
  }

  /** Whether the directory holds a stream, after one read of the stream list on a miss. */
  private async knownStream(streamId: number): Promise<boolean> {
    if (this.directory.nameOf(streamId) !== undefined) return true;
    await this.refreshStreams(`stream ${streamId}`);
    return this.directory.nameOf(streamId) !== undefined;
  }

  async refreshStreams(why = 'a name the directory does not hold', force = false): Promise<void> {
    const now = Date.now();
    if (!force && this.listRead === null && now - (this.listReadFor.get(why) ?? -Infinity) < STREAM_REFRESH_HOLDOFF_MS) return;
    const started = this.listRead === null;
    this.listRead ??= this.readStreamList(why).finally(() => { this.listRead = null; });
    if (!(await this.listRead) || !started) return;
    for (const [what, at] of this.listReadFor) if (now - at >= STREAM_REFRESH_HOLDOFF_MS) this.listReadFor.delete(what);
    this.listReadFor.set(why, now);
  }

  private async readStreamList(why: string): Promise<boolean> {
    try {
      const result = await this.api.request<{ streams?: unknown[] }>(
        'GET', '/streams', 'refreshing the stream list', { include_public: true, include_subscribed: true }, { timeoutMs: LOCATE_TIMEOUT_MS },
      );
      if (!Array.isArray(result.streams)) throw new Error('the answer carried no stream list');
      this.directory.list(result.streams);
      return true;
    } catch (err) {
      console.error(`[zulip-mcp] could not refresh the stream list for ${why}:`, (err as Error).message);
      return false;
    }
  }

  /**
   * Best-effort typing indicator.
   *
   * Stream typing goes to `metadata.topic`. ChannelManager.sendTyping fills
   * it in when the host names none (the topic of the newest message
   * noteConversation took) and stops a run in the topic it started in;
   * falls back to 'mcpl' only when there is still no topic.
   *
   * `op` is passed through: 'start' while the host refreshes (every ~7s
   * during inference), 'stop' when the turn ends. Zulip expires a start that
   * is never stopped on its own, so a missed stop lingers but does not stick.
   */
  async sendTyping(
    key: ChannelKey,
    _descriptor: ChannelDescriptor | undefined,
    metadata: Record<string, unknown> | undefined,
    op: 'start' | 'stop',
  ): Promise<void> {
    const send = (params: Record<string, unknown>) => this.api.requestAnswer('POST', '/typing', params);
    const parsed = parseKey(key);
    try {
      let result: Awaited<ReturnType<typeof send>>;
      if (parsed.kind === 'dm') {
        result = await send({ type: 'direct', to: parsed.userIds, op });
      } else {
        const topic = typeof metadata?.topic === 'string' ? metadata.topic : 'mcpl';
        result = await send({ type: 'stream', stream_id: parsed.streamId, topic, op });
      }
      if (result.result && result.result !== 'success') {
        console.error(`[zulip-mcp] typing.send(${op}) non-success: ${result.result} ${result.msg ?? ''}`);
      }
    } catch (err) {
      // Best-effort — swallow errors so typing never breaks the agent.
      console.error(`[zulip-mcp] typing.send(${op}) failed:`, (err as Error).message);
    }
  }

  /**
   * The allowlists, applied to what a history read may hand on: a message
   * from a stream outside `streams`, or a DM from a sender outside `dmUsers`,
   * is withheld here the same way the live event path withholds it — so a
   * narrowed allowlist is enforced on catch-up, gap recovery, backscroll and
   * context injection, not only on live delivery. The bot's own messages
   * pass (they are its own doing); callers decide whether to show them.
   */
  private allowed(m: ZulipMessage): boolean {
    if (this.identity.selfUserId !== null && m.authorId === this.identity.selfUserId) return true;
    if (m.isDm) return this.filters.dmAllowed({ id: m.authorId, email: m.authorEmail });
    return m.streamId === null || this.streamAllowed(m.streamId);
  }

  async fetchContext(
    key: ChannelKey,
    _descriptor: ChannelDescriptor | undefined,
    historySize: number,
  ): Promise<Omit<ContextInjection, 'namespace'> | null> {
    const parsed = parseKey(key);
    if (parsed.kind === 'stream' && !this.streamAllowed(parsed.streamId)) return null;
    const streamName = parsed.kind === 'stream' ? this.directory.nameOf(parsed.streamId) ?? '' : null;
    const page = await fetchHistory(this.api, parsed.kind === 'dm'
      ? { dmUserIds: parsed.userIds, limit: historySize }
      : { streamId: parsed.streamId, limit: historySize });
    const messages = page.messages.filter((m) => this.allowed(m));
    if (messages.length === 0) return null;

    // The shared line shape, so injected history reads like live delivery
    // and every line carries an id the agent can fetch_around.
    const formatted = messages.map((m) => messageLineHead({
      id: this.messageIds.format(m.id),
      time: Number.isNaN(m.timestamp.getTime()) ? '' : this.formatTime(m.timestamp),
      stream: parsed.kind === 'dm' ? null : m.streamNameShown ?? streamName,
      topic: m.topic,
      author: m.authorName,
      mentioned: m.mentioned,
    }) + m.cleanContent + editedTrailer(m)).join('\n');

    const label = parsed.kind === 'dm' ? `the direct-message conversation ${dmChannelIdFor(parsed.userIds)}` : `Zulip #${streamName}`;
    return {
      position: 'beforeUser',
      content: `Recent messages from ${label}:\n${formatted}`,
    };
  }

  /**
   * History as incoming-shaped messages, oldest first, the bot's own
   * messages excluded (they are already in the agent's own record as its
   * turns) and disallowed senders withheld. Marked `backscroll: true` so
   * consumers can tell replayed history from live delivery. The page's
   * `scannedThrough` covers the excluded rows too, so a pager never mistakes
   * a page of nothing but the bot's own messages for the end of history.
   */
  async fetchHistory(key: ChannelKey, query: ChannelHistoryQuery): Promise<ChannelHistoryPage> {
    return this.streamGate ? this.streamGate.run(() => this.fetchGatedHistory(key, query)) : this.fetchGatedHistory(key, query);
  }
  private async fetchGatedHistory(key: ChannelKey, query: ChannelHistoryQuery): Promise<ChannelHistoryPage> {
    const epoch = this.streamGate?.checkpoint();
    const parsed = parseKey(key);
    if (parsed.kind === 'stream' && !this.streamAllowed(parsed.streamId)) {
      return { messages: [], scannedThrough: null, reachedNewest: true };
    }
    const page = await fetchHistory(this.api, {
      ...(parsed.kind === 'dm' ? { dmUserIds: parsed.userIds } : { streamId: parsed.streamId }),
      limit: query.limit,
      before: query.beforeMessageId !== undefined ? Number(query.beforeMessageId) : undefined,
      after: query.afterMessageId !== undefined ? Number(query.afterMessageId) : undefined,
      timeoutMs: query.timeoutMs,
    });
    // Page authors take precedence over older cached rows, including targets
    // later in the page and pages larger than the seen cache. Uncached targets
    // share a page GET cap and wait budget, within the process-wide quote
    // bucket and any shared quote-wait allowance supplied by the server.
    const pageById = new Map(page.messages.map((m) => [m.id, m]));
    let getsLeft = HISTORY_QUOTE_GET_CAP;
    let pageRemainingMs = QUOTE_TIMEOUT_MS;
    const unverifiedMessageIds: string[] = [];
    const resolve = async (id: number, remainingMs: number): Promise<QuoteLookup> => {
      const known = pageById.get(id) ?? this.cached(id);
      if (known) return known;
      if (this.quoteLookupFailed(id)) return null;
      remainingMs = Math.min(remainingMs, pageRemainingMs, query.quoteLookupBudget?.remainingMs ?? Infinity);
      if (getsLeft <= 0 || remainingMs <= 0) return 'budget-skipped';
      getsLeft--;
      const started = performance.now();
      try {
        return await this.resolveQuoteTarget(id, remainingMs);
      } finally {
        const waited = Math.max(0, performance.now() - started);
        pageRemainingMs = Math.max(0, pageRemainingMs - waited);
        if (query.quoteLookupBudget) query.quoteLookupBudget.remainingMs = Math.max(0, query.quoteLookupBudget.remainingMs - waited);
      }
    };
    for (const m of page.messages) {
      if (!this.allowed(m)) continue;
      const verdict = await this.classifyQuoteReply(m, resolve, Infinity);
      m.replyToSelf = this.replyToSelfForVerdict(verdict, quotedMessageIds(m.rawContent), this.cached(m.id));
      if (verdict === 'budget-skipped') unverifiedMessageIds.push(String(m.id));
    }
    this.streamGate?.recheck();
    for (const m of page.messages) this.remember(key, m);
    const messages = page.messages
      .filter((m) => this.identity.selfUserId === null || m.authorId !== this.identity.selfUserId)
      .filter((m) => this.allowed(m))
      .map((m) => toIncoming(key, m, this.identity, { backscroll: true, ...(this.streamGate ? { readEpoch: epoch, streamId: m.streamId } : {}) }));
    return {
      messages,
      scannedThrough: page.messages.length > 0 ? page.messages[page.messages.length - 1].id : null,
      reachedNewest: page.foundNewest,
      ...(unverifiedMessageIds.length > 0 ? { unverifiedMessageIds } : {}),
    };
  }

  /**
   * Even with `all_public_streams` on the queue, a bot that isn't subscribed
   * gets a public stream's edits and reactions only for messages that
   * mention it, and from a private stream at most the messages that mention
   * it. So opening a channel must also subscribe the bot, or the host would
   * miss the rest.
   * Idempotent; subscription persists server-side. DMs need nothing.
   *
   * Asks Zulip every time rather than remembering: the `unlisten` tool
   * removes subscriptions behind this adapter's back, and a remembered
   * "subscribed" would let a later open succeed without it. The add call
   * is cheap and answers `already_subscribed` when there is nothing to do.
   *
   * Throws when the subscription did not happen: an API error, a transport
   * failure, or — Zulip's way of refusing a private stream — a `success`
   * result that lists the stream under `unauthorized`. The caller (the open
   * lifecycle) turns that into a failed open rather than a silent one.
   */
  async ensureSubscribed(key: ChannelKey): Promise<void> {
    if (this.streamGate && !isDmKey(key)) { this.streamGate.assert(streamIdOfKey(key)!); return; }
    const streamId = streamIdOfKey(key);
    if (streamId === null) return;
    // Zulip's subscribe call takes names only: the name is read at the call.
    const streamName = this.directory.nameOf(streamId);
    if (streamName === undefined) throw new Error(`stream ${streamId} is not in the stream list`);
    const result = await this.api.request<{ unauthorized?: unknown; subscribed?: Record<string, unknown> }>(
      'POST', '/users/me/subscriptions', `subscribing to #${streamName}`, { subscriptions: [{ name: streamName }] },
    );
    const unauthorized: unknown[] = Array.isArray(result.unauthorized) ? result.unauthorized : [];
    if (unauthorized.includes(streamName)) {
      throw new Error(`not authorized to subscribe to #${streamName} (private stream; the bot must be invited)`);
    }
    const fresh = result.subscribed && Object.keys(result.subscribed).length > 0;
    if (fresh) console.error(`[zulip-mcp] subscribed to #${streamName} (stream ${streamId})`);
  }

  startEvents(
    onMessage: OnIncomingMessage,
    onSystemEvent?: OnSystemEvent,
    onReaction?: OnReaction,
    onMessageChange?: OnMessageChange,
  ): void {
    const subscriptions = this.filters.subscriptions;
    const loop = this.eventLoop = new ZulipEventLoop({ directory: this.directory, messageIds: this.messageIds,
      streamsMode: subscriptions?.mode, readEpoch: () => this.streamGate?.checkpoint(),
      beforeRegister: () => subscriptions?.invalidate(),
      afterRegister: () => subscriptions?.connect(this.originalApi, this.identity.selfUserId),
      onSubscription: event => subscriptions?.apply(event),
    });
    const current = () => this.eventLoop === loop;
    const changeHandler = onMessageChange
      ? (change: ZulipMessageChange) => {
          const byBot = change.kind === 'edit' && this.identity.selfUserId !== null && change.actorId === this.identity.selfUserId;
          if (byBot && change.topic === null && change.newStreamId === null) return;
          const kind = change.kind === 'delete' ? 'delete' : change.topic !== null || change.newStreamId !== null ? 'move' : 'edit';
          const enter = (key: ChannelKey, located?: SeenMessage) => {
            const entry: ChangeEntry = { key, messageIds: change.messageIds, kind, ready: (only) => this.scopedEntry(change.readEpoch, () => this.onZulipChange(change, located, only)) };
            this.changeOf.set(entry, change);
            onMessageChange(entry);
          };
          const key = this.changeKeyNow(change);
          if (key !== null && (change.streamId !== null || this.placing === 0)) return enter(key);
          this.inOrder(current, async () => {
            const cachedKey = this.changeKeyNow(change);
            const located = cachedKey === null && change.kind === 'edit' ? await this.locate(change.messageId, 'an edit') : null;
            const placedKey = cachedKey ?? located?.key ?? null;
            if (placedKey !== null && current()) enter(placedKey, located ?? undefined);
          });
        }
      : undefined;
    const reactionHandler = onReaction
      ? (ev: import('./zulip-events.js').ZulipReactionEvent) => {
          // The bot's own reactions are its own doing; only others' are news.
          if (this.identity.selfUserId !== null && ev.user_id === this.identity.selfUserId) return;
          const at = (where: SeenMessage, timestamp: Date): ReactionEvent => ({
            ...(this.streamGate ? { readEpoch: ev.readEpoch ?? this.streamGate.checkpoint() } : {}),
            action: ev.op,
            key: where.key,
            messageId: String(ev.message_id),
            emoji: ev.emoji_name,
            emojiCode: ev.emoji_code || undefined,
            emojiType: ev.reaction_type || undefined,
            reactorId: String(ev.user_id),
            reactorName: ev.user?.full_name ?? `user ${ev.user_id}`,
            onOwnMessage: this.identity.selfUserId !== null && where.authorId === this.identity.selfUserId,
            messageSnippet: where.snippet,
            timestamp,
          });
          const emit = (where: SeenMessage | null) => {
            if (!where || !current() || (where.isDm && where.authorId !== this.identity.selfUserId && !this.changeAllowed(where))) return;
            const arrived = at(where, new Date());
            onReaction({ ...arrived, placed: () => at(this.cached(ev.message_id) ?? where, arrived.timestamp) });
          };
          const cached = this.cached(ev.message_id);
          if (cached && this.placing === 0) return emit(cached);
          this.inOrder(current, async () => emit(await this.locate(ev.message_id)));
        }
      : undefined;
    loop.start(this.originalApi, (_streamName, msg, flags) => {
      const raw = { ...(msg as ZulipRawMessage), flags };
      const m = normalizeMessage(raw);
      const key = this.keyNow(m, raw);
      if (key !== null && (m.isDm || m.streamId !== null || this.placing === 0)) return this.handOn(raw, m, key, onMessage);
      this.inOrder(current, async () => {
        const placed = await this.keyFor(m, raw);
        if (placed !== null && current()) this.handOn(raw, m, placed, onMessage);
      });
    }, onSystemEvent, reactionHandler, changeHandler, s => {
      const known = this.cached(s.message_id!);
      const enter = (key: ChannelKey) => onMessage({ key, messageId: `poll:${s.message_id}:${s.id}`, ready: () => this.scopedEntry(s.readEpoch, () => this.onPollSubmessage(s)) });
      if (known && this.placing === 0) return enter(known.key);
      this.inOrder(current, async () => {
        const where = await this.locate(s.message_id!, "a poll vote");
        if (where && current()) enter(where.key);
      });
    }).catch(error => {
      console.error('Zulip event loop failed:', error);
    });
  }

  private async scopedEntry<T extends { message: KeyedMessage } | MessageChangeEvent>(epoch: number | undefined, read: () => Promise<T | null>): Promise<T | null> {
    if (!this.streamGate) return read();
    const gate = this.streamGate;
    epoch ??= gate.checkpoint();
    try {
      return await gate.run(async () => {
        const result = await read();
        if (!result) return null;
        const message = ('message' in result ? result.message : result) as KeyedMessage | MessageChangeEvent;
        if (!isDmKey(message.key)) gate.assertFresh(streamIdOfKey(message.key)!, epoch!);
        const fields = { readEpoch: epoch, readStreamIds: gate.dependencies() };
        if ('message' in result) result.message = { ...result.message, metadata: { ...result.message.metadata as object, ...fields } };
        else Object.assign(result, fields);
        return result;
      });
    } catch { return null; }
  }

  private handOn(raw: ZulipRawMessage, m: ZulipMessage, key: ChannelKey, onMessage: OnIncomingMessage): void {
    if (this.streamGate && !m.isDm && !this.streamGate.fresh(m.streamId ?? undefined, (raw as any).readEpoch)) return;
    // Remember our own messages too: reactions to them are the ones that
    // matter most ("someone reacted to your message").
    this.remember(key, m);
    if (this.identity.selfUserId !== null && m.authorId === this.identity.selfUserId) return;
    if (m.isDm) {
      if (!this.filters.dmAllowed({ id: m.authorId, email: m.authorEmail })) {
        console.error(`[zulip-mcp] dropping DM from ${m.authorEmail} (${m.authorId}): not in the dmUsers allowlist`);
        return;
      }
      const descriptor = this.describeDm(m);
      onMessage({
        key,
        messageId: String(m.id),
        ready: async (changes) => {
          const now = this.applyChanges(raw, m, changes);
          return now === null ? null : { message: toIncoming(key, now, this.identity), newChannel: descriptor };
        },
      });
      return;
    }
    onMessage({
      key,
      messageId: String(m.id),
      ready: async (changes) => {
        const now = this.applyChanges(raw, m, changes);
        return now === null ? null : this.scopedEntry((raw as any).readEpoch, () => this.readyStreamMessage(now, key));
      },
    });
  }

  private applyChanges(raw: ZulipRawMessage, m: ZulipMessage, entries: readonly ChangeEntry[] | undefined): ZulipMessage | null {
    if (!entries || entries.length === 0) return m;
    let edited = raw;
    for (const entry of entries) {
      const change = this.changeOf.get(entry);
      if (change?.kind === 'delete') {
        this.seen.delete(m.id);
        this.movedAway.delete(m.id);
        return null;
      }
      if (change?.kind === 'edit' && change.content !== null) edited = { ...edited, content: change.content, flags: change.flags, last_edit_timestamp: change.editedAt };
    }
    if (edited === raw) return m;
    const fresh = normalizeMessage(edited);
    const now: ZulipMessage = {
      ...m,
      rawContent: fresh.rawContent,
      cleanContent: fresh.cleanContent,
      mentioned: fresh.mentioned,
      wildcardMentioned: fresh.wildcardMentioned,
      attachments: fresh.attachments,
      editedAt: fresh.editedAt,
    };
    const cached = this.cached(m.id);
    if (cached) this.seen.set(m.id, { ...cached, snippet: snippetOf(now.cleanContent), mentioned: now.mentioned, quoteTargets: quotedMessageIds(now.rawContent) });
    return now;
  }

  private async readyStreamMessage(m: ZulipMessage, key: ChannelKey): Promise<{ message: KeyedMessage; newChannel?: ChannelDescriptor } | null> {
    const streamId = streamIdOfKey(key)!;
    if (!(await this.knownStream(streamId))) {
      console.error(`[zulip-mcp] dropping message ${m.id}: stream ${streamId} is not in the stream list`);
      return null;
    }
    if (!this.streamAllowed(streamId)) return null;
    this.activeTopics.observe(streamId, m.topic, m.id, m.timestamp.toISOString());
    m.replyToSelf = await this.classifyQuoteReply(m) === 'reply';
    const cached = this.cached(m.id);
    if (cached) cached.replyToSelf = m.replyToSelf;
    // A stream the bot joined after startup is unknown to the host; the
    // message proves it is reachable, so it travels with its descriptor
    // (#20). Sent with EVERY message, never suppressed as "already
    // described": the registry that decides what is new is the server's,
    // it is cleared on reconnect, and a descriptor the host refused or
    // never confirmed must be offered again rather than held back by
    // adapter-side memory.
    const newChannel = this.streamDescriptor(streamId);
    return { message: this.activeTopics.decorate(toIncoming(key, m, this.identity), streamId), ...(newChannel ? { newChannel } : {}) };
  }

  private async onPollSubmessage(s: WidgetSubmessage): Promise<{ message: KeyedMessage; newChannel?: ChannelDescriptor } | null> {
    if (!Number.isSafeInteger(s.message_id) || s.message_id! <= 0 || !Number.isSafeInteger(s.id) || s.id <= 0) return null;
    const epoch = s.readEpoch ?? this.streamGate?.checkpoint();
    const update = parsePollSubmessage(s);
    if (update?.type !== 'vote') return null;
    void this.pollUsers.get(this.api);
    // Each vote starts its own GET AFTER its event; no cached envelope can route it.
    const message = await this.pollLookups.fetch(this.api, s.message_id!);
    if (!message || (this.streamGate && message.type !== "private" && !this.streamGate.fresh(message.stream_id, epoch))) return null;
    const state = applyPollUpdate(reconstructPoll(message.submessages), update);
    const option = state?.options.get(update.key);
    if (!state || !option) { countPollDrop('unknown_poll_option'); return null; }
    const m = normalizeMessage(message);
    const key = await this.keyFor(m, message);
    if (key === null) return null;
    if (!m.isDm && (!this.streamAllowed(m.streamId!))) return null;
    const voter = this.pollUsers.peek().get(update.voterId) ?? { name: `user ${update.voterId}`, email: '' };
    if (m.isDm && !this.filters.dmAllowed({ id: update.voterId, email: voter.email })) return null;
    if (this.streamGate && !m.isDm && !this.streamGate.fresh(m.streamId ?? undefined, epoch)) return null;
    const own = this.identity.selfUserId !== null && m.authorId === this.identity.selfUserId;
    const descriptor = m.isDm ? this.describeDm(m) : this.streamDescriptor(m.streamId!) ?? undefined;
    return { message: { key, messageId: `poll:${s.message_id}:${s.id}`, threadId: m.topic || undefined,
      author: { id: String(update.voterId), name: voter.name }, timestamp: new Date().toISOString(),
      content: [{ type: 'text', text: `[poll vote] ${voter.name} ${update.action === 'vote' ? 'voted' : 'unvoted'} '${option.text}' on poll ${this.messageIds.format(s.message_id!)} '${state.question}'` }],
      tags: ['zulip:poll-vote', own ? 'chat:addressed' : 'chat:ambient'],
      metadata: { ...(this.streamGate ? { readEpoch: epoch, streamId: m.streamId } : {}), pollVote: true, pollMessageId: s.message_id, optionKey: update.key, optionText: option.text,
        voterId: update.voterId, action: update.action, question: state.question, onOwnMessage: own,
        topic: m.topic, isDM: m.isDm, senderEmail: voter.email, attributed: true },
    }, ...(descriptor ? { newChannel: descriptor } : {}) };
  }

  stopEvents(): void {
    this.filters.subscriptions?.stop();
    this.eventLoop?.stop();
    this.eventLoop = null;
  }
}
