# Changed

Local commit: `c741dc9b84179d46d831253a99e459fe891d2c00`.
Base: `fafaeef8664c5765dbc7e6863b26f6911c1ac900`.
Working tree is clean; no push or PR creation was performed.

- `src/platforms/zulip.ts`: recognize a `[said](…/near/<id>):` heading immediately preceding a quote fence (blank lines allowed), excluding fenced examples and unrelated links. Resolve the quoted sender from the existing bounded author cache, otherwise the existing authenticated message GET with a 15-second timeout. Duplicate targets within a message are resolved once, without retries. Lookup errors and missing messages fail closed. Self messages, disallowed streams, already-mentioned messages and all DMs avoid quote lookups.
- `src/platforms/zulip-events.ts`: await message handlers so lookup completion preserves message delivery order and asynchronous handler errors remain isolated from polling failures.
- `src/history.ts`: update the mention metadata comment; no new tag or schema.
- `test/quoteReplies.test.ts`: 17 regression tests exercise the production event-queue → adapter → incoming-message path using a fake authenticated-client boundary.
- `changelog.d/quote-replies.fixed.md`: upstream-style fixed fragment. Read `changelog.d/README.md`; no additional project conventions were supplied.

Existing addressed path: `src/history.ts:334` emits `chat:mention`; `src/history.ts:381` carries `metadata.mentioned`; `src/server.ts:896` uses that metadata to decide addressed delivery. The new verdict is set at `src/platforms/zulip.ts:391` and applied to incoming streams at line 913. No distinct reply tag is needed.

Scope clarification received during implementation: preserve all existing DM addressing, including group DMs, and avoid lookups for already-addressed messages. The group-DM test checks unchanged `isDM`/`chat:dm` behavior, including quotes and silent mentions. Negative addressing cases apply to streams.

The change is independent of `edit_message`: no edit implementation or edit tests changed. No dependency, lockfile, tracked generated-file or unrelated documentation changes.

# Verification Gates

All commands below ran through the required gate wrapper. Log paths are relative to this report's evidence directory; each summary log identifies its full gate receipt.

| Source | Command | Result | Log |
|---|---|---|---|
| Clean base | `npm ci` | Pass | `base-install.log` |
| Clean base | `npm run build` | Pass | `base-build.log` |
| Clean base | `npm test` | 276 tests: 275 pass, 0 fail, 1 skip | `base-test.log` |
| Base production source + final regression tests | `node --import tsx --test test/quoteReplies.test.ts` | Expected red: 17 tests, 9 pass, 8 fail | `quote-final-red.log` |
| Clean final commit | `npm ci` | Pass | `final-install.log` |
| Clean final commit | `npm run build` | Pass | `final-build.log` |
| Clean final commit | `npm test` | 293 tests: 292 pass, 0 fail, 1 skip | `final-test.log` |
| Clean final commit | `node --import tsx --test test/quoteReplies.test.ts` | Green: 17 pass, 0 fail | `quote-final-green.log` |

Red reproduction restored the three changed production files from the base, ran the final new test file, then reapplied the implementation patch. Failures include own-message stream quotes, cached author recognition, and required lookup assertions. The unchanged platform-specific skip is the non-Linux local-file test.

Additional checks: `git diff --check` passed; the final commit changes only the five files above. Source inspection of the installed client's `lib/resources/messages.js` and `lib/api.js` confirms `getById` makes one authenticated GET without a retry loop. Tests verify the requested id and `apply_markdown: false`, not a request to the URL supplied in message text.

# Unmet Criteria

None under the clarified DM scope. Publishing remains intentionally deferred; the local commit and draft below are ready for approval.

# Residual Risk

- Verification used synthetic queue/client responses, not a live service.
- A cache miss can delay subsequent message events up to the existing 15-second timeout per distinct quote target. The timeout bounds waiting, not cancellation of the underlying HTTP request. There is no retry loop; a later incoming message can attempt a failed target again.
- Quote-derived addressing applies to live incoming messages; history and edit reclassification remain unchanged.
- Both base and final dependency installs report the same three audit findings (one low, two high). Dependency remediation is outside this change.

# Draft PR

**Title:** Treat quote replies to own stream messages as addressed

**Description:**

Recognize quote-reply headers in raw Zulip Markdown and treat a stream reply as a mention only when the quoted message was sent by the connector's own user. Reuse the existing author cache or one bounded authenticated lookup per distinct quote target, failing closed on lookup errors. Silent mentions alone and unrelated message links do not trigger addressing.

Reuse the existing mention metadata and tags. Preserve DM addressing and self-message filtering, and await message handlers to preserve delivery order. Include a changelog fragment and 17 regression tests.

Validation: the new tests fail on the base and pass after the fix. `npm ci`, `npm run build`, and `npm test` pass; the full suite increases from 275 to 292 passing tests with the same one platform-specific skip. Independent of the existing `edit_message` change.
