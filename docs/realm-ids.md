# Realm-tagged message IDs

Set `ZULIP_ID_MODE=compat` or `strict` and optionally `ZULIP_REALM_TAG=alpha`
(default: first realm hostname label). Message IDs in tool receipts, history,
structured events, context and catch-up lines become `alpha:123`. Channel,
stream and user IDs and persisted cursors are unchanged.

`compat` accepts bare IDs with a warning; `strict` refuses them. Foreign tags
are refused before requests, including every active `[[msg:alpha:123]]` token.
`legacy` preserves upstream's numeric IDs and schemas. There are no new nullable
or zero-valued destination placeholders. Use stable, distinct tags across realms.

Token validation also applies to channel publishing: strict refuses bare
`[[msg:7]]` before any read/upload/write; compat accepts bare and tagged tokens.
Default legacy keeps upstream token scanning: literals such as `[[msg:abc]]`
and `[[msg:]]` pass through unchanged (no validation or lookup).
