import type { PlatformSystemEvent } from './platforms/adapter.js';

/** Connection-wide notices have no stream provenance. In subscribed mode
 * they must not borrow message anchors, error text or recovery totals from
 * any stream, including an otherwise authorized destination. */
export function unanchoredSystemEvent(event: PlatformSystemEvent): PlatformSystemEvent {
  const text = {
    gap: 'Zulip delivery gap: messages may have been missed.',
    degraded: 'Zulip real-time message delivery is degraded.',
    recovered: 'Zulip real-time message delivery has recovered.',
  }[event.kind];
  return { kind: event.kind, text };
}
