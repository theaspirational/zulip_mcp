import type { ChannelKey } from './channel-key.js';
import type { ZulipRawMessage } from './history.js';

export interface ConfirmedMove {
  messageId: number;
  source: { streamId: number; topic: string };
  propagateMode: 'change_one' | 'change_later' | 'change_all';
  destination: { streamId: number; topic: string; stream: string } | null;
  snapshot?: ReadonlyMap<ChannelKey, unknown>;
}
export function moveCovers(move: ConfirmedMove, id: number | undefined, streamId: number, topic: string | undefined): boolean {
  if (id === undefined || streamId !== move.source.streamId || topic !== move.source.topic) return false;
  return move.propagateMode === 'change_all' || (move.propagateMode === 'change_later' ? id >= move.messageId : id === move.messageId);
}
export function moveDestination(message: ZulipRawMessage | undefined, requestedStream?: number): ConfirmedMove['destination'] {
  if (message?.type !== 'stream' || !Number.isSafeInteger(message.stream_id) || typeof message.display_recipient !== 'string' ||
      typeof message.subject !== 'string' || (requestedStream !== undefined && message.stream_id !== requestedStream)) return null;
  return { streamId: message.stream_id!, stream: message.display_recipient, topic: message.subject };
}
