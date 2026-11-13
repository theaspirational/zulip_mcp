# Realm-tagged message IDs

Set `ZULIP_ID_MODE=compat` or `strict` and optionally `ZULIP_REALM_TAG=alpha`
(default: first realm hostname label). Message IDs in tool receipts, history,
structured events, context and catch-up lines become `alpha:123`. Channel,
stream and user IDs and persisted cursors are unchanged.

`compat` accepts bare IDs with a warning; `strict` refuses them. Foreign tags
are refused before requests, including every active `[[msg:alpha:123]]` token.
`legacy` preserves upstream's numeric IDs and schemas. There are no new nullable
or zero-valued destination placeholders. Use stable, distinct tags across realms.
