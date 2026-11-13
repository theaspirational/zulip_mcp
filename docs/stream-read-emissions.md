# Stream modes and read boundaries

`ZULIP_STREAMS_MODE=list|subscribed|public` defaults to `list` (upstream
allowlist behavior; an absent/empty list remains unrestricted). `public`
ignores the stream list, not mutes or DM policy. Public delivery without an
actual subscription still depends on Zulip's event coverage; it is not a
promise of complete live public-stream history.

`subscribed` authorizes immutable stream IDs from a fresh
`GET /users/me/subscriptions`, intersected with the stream list and mutes.
Unknown state fails closed and is retried; replacement queues invalidate
membership before registering and refresh it before handling events. Queues
request subscription/stream events and do not ask for all public messages.
`listen`/`unlisten` retain upstream tool names; membership changes are confirmed
by subscription events or a fresh subscription read, never inferred from
public stream visibility. Opening a channel does not silently join it.

The native API gate pins named history narrows to IDs and projects list and
cross-stream results. Async-local read sets recheck every dependency at the
outer return, including after another channel, users, uploads or attachment
bytes have been awaited. A monotonic per-ID revocation vector rejects retained
snapshots even after unsubscribe/regrant. Unrelated stream changes do not
invalidate permitted reads.

| Surface | Boundary |
| --- | --- |
| History, topics, reply targets, links, polls | native API preflight and response checks, outer tool scope |
| Monitoring/status/resources | ID-pinned monitoring state, lane-owned purge and outer resource scope |
| Stream descriptors and channel lists | ID-based final projection, no cached read authority |
| Context and open history | whole-result read scope and final recheck |
| Live/lane-queued/batched/replayed messages | epoch metadata and final delivery check |
| Vote, reaction and edit notifications | source/destination authorization and retained-event epochs |
| Attachments | required `message_id`, fresh authorized source and exact attachment match |
| System notices | no cross-stream message anchors; generic continuity notice |

Revocation synchronously closes the ID-based read gate. Cleanup of pending/batched
messages, conversation hints, replay cursors/tallies, adapter placement/topic caches
and monitoring metadata runs as a writer job on the affected channel’s delivery
lane, after its running job. Per-ID epochs fence reads and late host answers
across unsubscribe/regrant while that cleanup waits. Poll votes enter the same
lane; each fresh content/placement GET starts at its turn. A changed placement
re-enters the destination lane before delivery.
Directory identity mappings remain upstream-owned; their presence never grants
read authority. Stream/user/channel IDs and persistence formats remain numeric.
This is read confinement, not a blanket write ban: a standalone send without a
reply or link can still use the bot's write permission.

## Opt-in surface

Unset `ZULIP_STREAMS_MODE` preserves upstream behavior and omits `streamsMode`
from `filters_get`. Subscription event registration is restricted to explicit
`subscribed`/`public` mode. Attachment `message_id` provenance is exposed only
in subscribed mode; it is not a move-tool schema change.
Poll tools/vote events/submessage registration require `ZULIP_POLLS=1`;
active-topic hints require `ZULIP_ACTIVE_TOPICS=1`. Both default off.
`move_messages` is upstream’s unconditional tool (`stream`/`topic`/`scope`),
not the old fork’s `stream_id`/`propagate_mode` tool. In subscribed mode its
source and resolved destination are gated before the native PATCH. Realm-tagged
anchors are decoded before I/O; upstream routing-hint updates and receipt shape
are retained. `ZULIP_MOVE_MESSAGES` has no effect.
