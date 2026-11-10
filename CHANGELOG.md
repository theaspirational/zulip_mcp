# Changelog

Notable changes to `zulip-mcp-server`, loosely following
[Keep a Changelog](https://keepachangelog.com/). Entries land with the change
that causes them, as fragment files in [`changelog.d/`](changelog.d/) that are
folded into a version section at release time — see
[`changelog.d/README.md`](changelog.d/README.md).

Releases up to and including 2.2.1 predate this file; for their contents see
`git log`.

## Unreleased

- Added opt-in realm-qualified message IDs (`ZULIP_REALM_TAG`,
  `ZULIP_ID_MODE=legacy|compat|strict`), with foreign-realm refusal before lookups
  or writes and compat warnings for bare IDs. Channel IDs and persisted numeric
  formats are unchanged. See [configuration and migration](README.md#realm-qualified-message-ids).
- Changed human-readable DM/group-DM headers in all modes to include the unchanged
  conversation channelId and other participants' full names: live/push/recovered
  delivery, history/fetch, injected context, catch-up and message-change lines
  (and their `attributionHeader` mirror). Legacy stream outputs are unchanged.
