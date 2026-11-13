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
| Monitoring/status/resources | ID-pinned monitoring state, synchronous purge and outer resource scope |
| Stream descriptors and channel lists | ID-based final projection, no cached read authority |
| Context and open history | whole-result read scope and final recheck |
| Live/pre-live/batched/replayed messages | epoch metadata and final delivery check |
| Vote, reaction and edit notifications | source/destination authorization and retained-event epochs |
| Attachments | required `message_id`, fresh authorized source and exact attachment match |
| System notices | no cross-stream message anchors; generic continuity notice |

Revocation synchronously purges pending/batched messages, conversation hints,
replay cursors/tallies, adapter placement/topic caches and monitoring metadata.
Directory identity mappings remain upstream-owned; their presence never grants
read authority. Stream/user/channel IDs and persistence formats remain numeric.
This is read confinement, not a blanket write ban: a standalone send without a
reply or link can still use the bot's write permission.
