# TASK-PXRSM review — `send_message` `reply_to` (commit 8f3a8248a95b2352acd90850d045347d38ec826a)

## Verdict

**Approve with changes (does not block ship).** The core of the task is correct: the
destination is resolved from `GET /api/v1/messages/{id}` *before* any upload or send
(`src/tool-runtime.ts:706` precedes `:708`), stream replies carry the API's own
`stream_id`/`subject`, DM replies carry the full participant set including the bot,
conflicting destinations and unreadable ids refuse with the Zulip error code intact,
and the no-`reply_to` path is unchanged (verified by test and by probe). All five
acceptance test cases exist and are mutation-sensitive (see Verification). Four
findings remain — three MEDIUM/LOW false-refusal or lost-guardrail issues at the edges
of the conflict checker, one LOW latent channel-id inconsistency. None causes a message
to land in the wrong destination, which was the motivating failure.

## Findings

### MEDIUM — correctness: a stream ID passed as a string false-conflicts (`src/tool-runtime.ts:307`, contract at `src/tools.ts:176`)

The schema advertises `to` as `{ anyOf: [string, integer, array] }` with
"For stream: stream name or ID" — so `"12"` is a documented way to name channel 12.
The checker only compares `stream_id` when `typeof to === "number"`; a string is
compared against the channel *name*, so a correct destination is reported as a
disagreement.

Probe (`$ORGASMIC_EVIDENCE_DIR/probe-missing-dest.mts`, case (c)), referenced message
in `stream_id: 12` / `display_recipient: 'General'`:

```
send_message { type:'stream', reply_to:123, to:'12' }
→ reply_to 123: to (stream) disagrees with the referenced message
```

The same class of false refusal applies on the DM side (`:321-325`): a participant
given as a numeric string (`to: ['42']`, or `to: '42,7'`) is only ever looked up by
email, so it resolves to `undefined` and refuses; and where the realm restricts
`EMAIL_ADDRESS_VISIBILITY`, `display_recipient[].email` is a synthetic address, so a
caller passing the user's real email also false-conflicts. Failure mode is a refusal,
not a mis-sent message, and omitting `to` always works — hence MEDIUM, not HIGH.

*Fix direction:* coerce a numeric-looking string to a number before comparing (stream:
compare against `stream_id`; DM: accept it as a user id), and fall back to matching
`display_recipient[].id` when an email lookup misses.

### MEDIUM — design: dropping `to` from `required` leaves no enforced destination check (`src/tools.ts:208-209`)

`required` went from `["type","to"]` to `["type"]`, with the new constraint expressed
only as a top-level `anyOf: [{required:["to"]},{required:["reply_to"]}]`. Nothing
validates arguments server-side (`src/tools.ts:8` types `inputSchema` as an opaque
`Record<string, unknown>`; no ajv/zod/jsonschema dependency exists), and sibling
top-level `anyOf` next to `properties` is commonly dropped by MCP client schema
sanitizers. A call with neither field therefore reaches the wire:

```
send_message { type:'stream', topic:'t', content:'oops' }
→ client.messages.send({"type":"stream","topic":"t","content":"oops"})   // no `to`
→ onSent channelId: "zulip:"
```

(probe case (a)). Previously a schema-conforming client could not make that call.
The outcome is a remote 400 plus a junk `zulip:` entry in the sent record rather than
a local error.

*Fix direction:* one line next to the existing content check at `:703-705` —
`if (args.reply_to === undefined && args.to === undefined) throw new Error("to is required without reply_to")` —
and a test asserting no send happens.

### LOW — usability: `type` is required and its omission is reported as a disagreement (`src/tool-runtime.ts:296`)

`reply_to` alone is not enough to send: `type` stays required and must equal the
referenced message's type, so the caller must already know whether the id is a stream
message or a DM. When it is simply omitted, the error misattributes the cause:

```
send_message { reply_to:123, content:'reply' }
→ reply_to 123: type disagrees with the referenced message
```

(probe case (b)). In the motivating scenario — a wake handing over a batch of message
ids — the id is the reliable datum and the type is the part most easily lost. README
(`README.md:317`) and the schema do document that `type` must match, so this is
documentation-accurate, just unergonomic.

*Fix direction:* when `args.type` is absent, adopt `message.type`; keep the
disagreement error only for an actual mismatch.

### LOW — correctness (latent): a DM reply records a channel id that includes the bot (`src/tool-runtime.ts:336`)

`dmChannelIdFor(ids)` is called with the full `display_recipient` set, but the
project's canonical DM channel id excludes the bot — `channelIdOf` →
`dmCounterparts` (`src/history.ts:178-184`, with the comment at `:171-173`: "A DM
conversation is identified by its participants other than the bot"), and `send_dm`
does the same (`src/tool-runtime.ts:737`). So the same conversation gets two ids:

```
reply recorded channel: zulip:dm:42+790     (probe-dm-channelid.mts)
ingest channelIdOf:     zulip:dm:42
send_dm channel:        zulip:dm:42
```

No present-day symptom: the only consumer is `StateTracker.recordSent`
(`src/state.ts:33`), and rollback's `deleteMessage(_channelId, messageId)` ignores the
channel (`src/platforms/zulip.ts:594`). It becomes a real bug the moment anything keys
sent records by channel. Self-DMs are unaffected (`dmCounterparts` falls back to the
full set). The `to:` payload including the bot is correct and should stay.

*Fix direction:* `channelId: dmChannelIdFor(dmCounterparts(recipients, this.session.selfUserId).map(r => r.id))`,
keeping `to: ids` as is; assert the recorded `channelId` in the DM reply tests.

### LOW — docs: the "sender is implicit" guarantee is conditional

`src/tool-runtime.ts:332` only adds the sender when `this.session.selfUserId !== null`,
and that is null on the documented fail-open path when the profile fetch fails
(`src/zulip-client.ts:91-92`). In that state a caller that correctly lists only the
counterparts is refused. `README.md:320` and `src/tools.ts:176` state the
implicit-sender rule unconditionally. The implementer's report notes this; the
user-facing docs do not.

## Verification Gates

Rerun by me in this worktree at 8f3a8248a95b2352acd90850d045347d38ec826a (clean tree,
clean after), not reused from the implementer's receipts:

| gate | command | result | log |
| --- | --- | --- | --- |
| install | `npm ci` | exit 0 | `gate-install-01M63X14T5YX0FSSV7VQZFWY50.log` |
| typecheck | `npx tsc --noEmit` | exit 0 | `gate-typecheck-01M63X49EX5N7M8CCB1EPMTAJ4.log` |
| build | `npm run build` | exit 0 | `gate-build-01M63X4AT1A05RDRJCKXHGHJJM.log` |
| test | `npm test` | exit 0 — 285 tests, 284 pass, 0 fail, 1 skip (the pre-existing non-Linux local-file test) | `gate-test-01M63X4BYHNJHQREHX67TBPW0Q.log` |

Logs in `$ORGASMIC_EVIDENCE_DIR` (run-01M63WZCHXBFMFD7ZGVW92JMAR). `npm ci` reports 3
pre-existing advisories; no lockfile or dependency change in the diff.

Scoped probes (both outside the tracked tree, in `$ORGASMIC_EVIDENCE_DIR`; run with
`node --import tsx` from the worktree):
- `probe-dm-channelid.mts` — DM reply channel-id divergence, against the real
  `ZulipToolRuntime` and the real `channelIdOf`/`normalizeMessage`.
- `probe-missing-dest.mts` — cases (a) missing destination, (b) omitted `type`,
  (c) stream id as string.

Test quality (read, not taken on trust — `test/toolRuntime.test.ts:305-487`):
- A wrong topic **would** be caught: `:336` asserts the exact send payload
  (`{type:'stream', to:12, topic:'Deploy status', content:'reply'}`) for all four
  destination spellings, `:375-379` asserts refusal plus `sends == []` and
  `uploaded == []` for eight disagreement shapes including topic case
  (`'deploy status'`).
- A send after a failed lookup **would** be caught twice: with the fake client
  (`:390-392`, `gets == [{message_id:999}]`, `sends == []`, `uploaded == []`) and on
  the production path through the real `zulip-js` client over loopback HTTP
  (`:444-487`), which pins request order `GET /api/v1/messages/123?message_id=123`
  then `POST /api/v1/messages`, asserts the multipart body carries `to=12` /
  `topic=Deploy status` and no `reply_to`, and asserts `requests.length === 3` after
  the 400 ("the failed lookup never posts"). That is the one production-path probe the
  behavioural claims needed.
- `selfUserId: 790` is a real participant in the DM fixtures, so the
  "Zulip implicitly includes the sender" case (`:349`) genuinely exercises the
  `supplied.add(selfUserId)` branch — removing line `:332` fails it.
- No-`reply_to` parity (`:410-425`) asserts the exact payload, the exact response, the
  `onSent` records and `gets == []`, so a stray lookup or payload drift is caught.
- Schema assertions (`:427-434`) pin `required`/`anyOf` and the `reply_to` description.

Docs/schema accuracy: `README.md:307-325` and `src/tools.ts:159-209` match the
implementation on trimming, case sensitivity, required `type`, refuse-before-send and
the no-fallback rule; the one inaccuracy is the unconditional implicit-sender claim
(LOW above). Changelog fragment present (`changelog.d/send-message-reply-to.added.md`).
Scope: one commit on `e5c4b4c`, touching only `send_message`; no dependency,
permission, or lockfile change; no push, PR or outbound messaging.

## Unmet Criteria / test gaps

Acceptance criteria are all met (stream reply, 1:1 and group DM replies, disagreement
refusal, unknown/inaccessible id, `reply_to` absent unchanged). Remaining gaps, each
matching a finding:

1. No test asserts the recorded `channelId` for a **DM** reply — the stream case is
   asserted (`:337`), the DM case is not, which is why the `dmCounterparts` divergence
   went unnoticed.
2. No test for `to`/`reply_to` both absent (the dropped `required: ["to"]`).
3. No test for `reply_to` with `type` omitted, nor for a numeric-string `to`
   (`'12'`, `['42']`), nor for an email that `display_recipient` reports differently
   under restricted email visibility.
4. No test with `selfUserId: null` on the DM path.

## Residual Risk

- Everything is verified against fake clients plus a loopback HTTP server; no live
  Zulip realm. The assumption that Zulip accepts `to` containing the bot's own id for
  a DM, and a numeric `to` as a channel id for a stream, is unverified against a real
  realm (both are documented API behaviour, and the loopback test confirms the wire
  form is `to=12`).
- Lookup and send are two requests: a topic move or deletion between them is not
  atomic, so the destination is the lookup's snapshot. Already recorded by the
  implementer; unavoidable at this layer.
- The lookup adds one API round-trip per `reply_to` send; irrelevant at tool-call
  rates.
- The CI OS/Node matrix was not exercised locally; the single skip is the known
  non-Linux upload test.

## Fix Directions (ordered)

1. `src/tool-runtime.ts:307` and `:321-325` — coerce numeric strings before comparing,
   and match DM participants by id as well as email; add the three refusal tests.
2. `src/tool-runtime.ts:703-706` — local `to`-or-`reply_to` check so the dropped schema
   `required` is not the only guard.
3. `src/tool-runtime.ts:336` — build the DM reply `channelId` from `dmCounterparts`;
   assert it in the DM reply tests. Leave `to: ids` alone.
4. `src/tool-runtime.ts:296` — default `args.type` from `message.type`; reserve the
   disagreement error for a real mismatch.
5. `README.md:320` / `src/tools.ts:176` — qualify the implicit-sender rule, or make
   it unconditional by refusing `to`-vs-participants comparison only when the sender is
   known.
