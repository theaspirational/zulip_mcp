- Made `ZULIP_STREAMS_MODE` explicit: `list` (the unchanged default),
  `subscribed` (unchanged security policy), or `public` (all-public queue,
  ignoring the stream list, with mutes still enforced). Invalid values fail
  startup. `filters_get` reports non-default modes only; list-mode bytes stay
  unchanged. Live unsubscribed public-stream delivery remains unverified.
