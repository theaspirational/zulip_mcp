- Poll vote notifications use best-effort ordering: known channel hints retain
  lane arrival order, but unknown/evicted votes resolve placement independently
  (at most 3 seconds, dropping failed lookups) and moved votes join the resolved
  channel's current lane tail with no extra ordering wait. Rare moves/evictions
  may reorder votes relative to messages; unrelated held/stuck channels never
  block them. Visibility/revocation checks and fresh vote reads remain enforced.
