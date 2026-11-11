# Subscribed-mode emission inventory

`StreamReadGate` is installed only for `ZULIP_STREAMS_MODE=subscribed`.
Authorization is current, ID-based subscription + filters + mute policy, not
retained descriptors, cursors, pending announcements, or old API snapshots.
Unknown subscription state denies every stream. DMs remain independent.

## Host/agent output boundaries

- **channels/register**: `registerChannelsWithHost` projects descriptors by
  `address.stream_id` immediately before `sendRequest`. Discovery is also
  filtered by the manager's `visible` hook.
- **channels/changed**: `channelsChangedWithHost` gates **added and updated
  descriptors and removed IDs** before sending. `registerAdditional` applies
  the same visibility hook to fresh descriptors **and the retained retry
  backlog**. No authorized entries means no wire request. Cleanup does not
  re-announce unauthorized IDs to tell the host they disappeared.
- **channels/list**: `ChannelManager.listChannels` projects retained descriptors
  through the visibility hook on each call. A stored descriptor is not a grant.
- **channels/open**: the selected descriptor's immutable ID is asserted before
  use and at return. History carries its own read dependencies. The enclosing
  wire response scope rechecks after all awaits, including subscription setup.
- **context/beforeInference**: per-injection captured ID checks filter the final
  response, recording surviving dependencies in the enclosing wire scope.
- **channels/incoming**: both batch/retry and final host transport boundaries
  call `mayDeliver`. This gates ordinary messages, reactions, edits, moves,
  deletes, replay/catch-up blocks and connection/system notifications, including
  their channel envelopes. Moves retain destination read IDs through batching.
- **push/event**: `mayDeliver` is checked at emission (also after `beforeOffer`),
  covering origin, payload, missed tallies, attachments, reactions and changes.
- **tools/call**: runtime + server `StreamReadGate.run` scopes retain reads
  across nested helpers and await boundaries. The final wire write rechecks
  their union. Stream lists, monitoring state, topics, history, polls,
  attachments, reply/link/move placement, missed state and refresh results
  participate. Filter-name arrays are projected through the gate too.
  Failed monitoring rows redact names. Standalone stream-send result metadata
  requires current read authority, even when the write itself is permitted.
- **Cleanup/write-only tool receipts**: `stop_monitoring` (targeted and all),
  `unlisten` (subscription unregister), `listen`, delete/reaction writes,
  mute/unmute and reaction visibility return counts/status, not raw API names,
  IDs or diagnostic strings. Cleanup still executes without read authority.
- **resources/list**: per-stream descriptors/URIs are filtered using the stored
  immutable ID, synchronously before the response write.
- **resources/read**: `StreamReadGate.run` covers summary, monitoring status,
  per-channel contents **and URIs**, with a final wire recheck. Unknown or
  unmonitored named streams cannot bypass authorization via an error response.
- **channels/publish, channels/acknowledge, channels/typing**: channel reads
  used for routing/results require current authority; responses have the same
  wire recheck. Typing stop may clean up without exposing stream metadata.
- **channels/close and state/rollback**: cleanup works on retained state;
  receipts contain only booleans/counts/checkpoint, never stream metadata.
- **RPC/tool/resource errors**: subscribed-mode wire errors omit exception text
  and data; caught tool/resource errors and failed rows are similarly redacted.
  Unknown channel/resource names cannot be echoed by diagnostics.

Initialize, ping, tools/list, prompts/list, featureSets/update, mcpl/manifest
and mcpl/manifestChanged contain static protocol/capability metadata, not
stream-derived state. Client notifications have no response; resulting stream
traffic follows the boundaries above. Operator stderr is not agent content.

The emission-inventory regression walks these dynamic output paths with a
removed stream and with unknown state, capturing host requests, responses and
errors; it also walks every registered tool. Separate probes cover retained
backlogs/listing, all stop-monitoring variants, and revocation between a helper
return and the actual wire response. Default-mode compatibility remains covered
by the existing suite.


## Queue and cached dependencies

Subscribed queues omit `all_public_streams`; default queues retain the previous
`'true'` string parameter. Zulip maintains the live queue's user subscriptions,
including re-subscriptions; membership changes do not need queue refreshes.
Queue replacement still reloads membership and fails closed while unknown.

Cache admission and every cached quote/placement/fallback read check immutable
source IDs. Revocation synchronously removes unavailable messages and topic
lists, invalidates pending topic snapshots and clears derived reply state.
History/placement reads spanning policy changes cannot repopulate those caches.
Poll votes in subscribed mode retain no unscoped poll data: question/options and
placement are rebuilt from the same fresh authorized message response. Data-only
poll events do not populate a cache before source authorization.

Reply classifications carry `readStreamIds` through history, batched delivery,
changes and synthetic catch-up blocks; the final transport checks these alongside
the message's own stream. Server reply-verdict fallbacks carry the same IDs and
are cleared on policy changes. Unavailable routing hints and queued payloads are
purged; retained descriptors/cursors are address bookkeeping only and remain
unavailable behind the existing ID gate. Regrant does not restore old message,
poll or topic snapshots. Default `filters_get` has its original schema, key order
and note; subscription fields exist only in subscribed mode.
