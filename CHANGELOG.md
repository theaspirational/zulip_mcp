# Changelog

Notable changes to `zulip-mcp-server`, loosely following
[Keep a Changelog](https://keepachangelog.com/). Entries land with the change
that causes them, as fragment files in [`changelog.d/`](changelog.d/) that are
folded into a version section at release time — see
[`changelog.d/README.md`](changelog.d/README.md).

Releases up to and including 2.2.1 predate this file; for their contents see
`git log`.

## Unreleased

## Unreleased (fork ports)

- Preserve the upstream default tools/list byte-for-byte and original tests. Poll tools/vote events/submessage registration require `ZULIP_POLLS=1`; moves require `ZULIP_MOVE_MESSAGES=1`; active-topic hints require `ZULIP_ACTIVE_TOPICS=1` (optional `ZULIP_ACTIVE_TOPICS_LIMIT`, default 6). Unset stream mode omits `streamsMode`; subscription events require subscribed/public mode. Legacy literal tokens pass through unchanged.
- Enforce strict/compat realm tokens in channel publishing before I/O, and retain subscribed-policy refusal text through wrapped topic/link errors.

- Add opt-in realm-tagged message IDs (`ZULIP_REALM_TAG`, `ZULIP_ID_MODE`).
- Restore bounded active-topic hints on incoming events without replacing upstream `get_stream_topics`.
- Port `send_poll`, `get_poll_results`, fresh-placement vote events, and `vote_poll` to upstream's native API; preserve feature-set and comms classifications.
- Port `ZULIP_STREAMS_MODE=list|subscribed|public`, subscription refresh/events, ID-pinned StreamReadGate and revocation purge across tool, resource, context and delivery boundaries.
- Fix subscribed-mode errors: typed policy refusals retain their wording; caller validation (including literal-token escaping) stays actionable; remote/transport/internal failures use non-leaking categories.
