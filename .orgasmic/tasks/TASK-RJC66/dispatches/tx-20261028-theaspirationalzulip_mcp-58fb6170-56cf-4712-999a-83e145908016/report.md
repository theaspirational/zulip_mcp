# Changed

Follow-up commit: `be08fd5855efbfface716618e52b7906e662c17b`, directly on `c741dc9b84179d46d831253a99e459fe891d2c00`. No amend or push. Working tree clean.

Only three files changed this round:

- `src/platforms/zulip.ts`: stop collecting after the first two distinct quote targets; use a dedicated, shared three-second lookup budget measured with a monotonic clock (`markQuoteMention`, lines 387–403). Existing non-quote callers retain their 15-second timeout. Update the docstring to state both limits. Accept arbitrary heading link text and tilde quote fences.
- `test/quoteReplies.test.ts`: four new regression tests for a hung lookup followed by an unrelated message, many quote headings, translated link text, and tilde fences. The many-heading test also verifies duplicate targets do not consume additional lookups and later targets deliberately do not affect addressing.
- `changelog.d/quote-replies.fixed.md`: document awaited handlers, ordering, and bounded quote lookups.

Retain `await onMessage` in `src/platforms/zulip-events.ts:475`: it preserves incoming delivery order while the quote verdict is resolved. Quote processing can now delay later events by at most one shared three-second lookup budget, plus scheduler overhead, not 15 seconds per heading. No retry loop was added.

The existing addressed mechanism is unchanged: `src/history.ts:334` emits `chat:mention`, line 381 supplies `metadata.mentioned`, and `src/server.ts:896` decides addressed delivery. No new tags or changes to `edit_message`.

# Verification Gates

Fresh gates ran through the required wrapper; summary logs below are relative to this report and identify the associated gate-receipt logs.

| Gate | Command | Result | Log |
|---|---|---|---|
| `round2-red` | `node --import tsx --test test/quoteReplies.test.ts` | Expected failure on `c741dc9` production source: 21 tests, 17 pass, all 4 new tests fail | `round2-red.log` |
| `round2-install` | `npm ci` | Pass at clean final commit | `round2-install.log` |
| `round2-build` | `npm run build` | Pass at clean final commit | `round2-build.log` |
| `round2-test` | `npm test` | 297 tests: 296 pass, 0 fail, 1 skip | `round2-test.log` |
| `round2-final-green` | `node --import tsx --test test/quoteReplies.test.ts` | 21 pass, 0 fail | `round2-final-green.log` |

The hung-lookup regression exercises the production queue → adapter → incoming-message path. It delivers the unrelated message after approximately 3000 ms, inside a 3500 ms assertion deadline that allows scheduler overhead. The same test fails on the parent commit because the unrelated message remains blocked beyond that deadline. Test cleanup releases the synthetic hung request.

`git diff --check` passed. Only the three listed paths changed; no dependencies, lockfile or tracked generated files changed.

Inherited evidence: the earlier clean-parent suite had 293 tests (292 pass, 1 platform-specific skip); the original base had 276 tests (275 pass, the same skip). These are historical count comparisons, not reused gate passes. The parent commit, original 17 quote tests, addressed-routing code, and dependency inputs were unchanged at this round's start. Existing coverage was rerun in the fresh final suite. Earlier source inspection of the authenticated client's GET behavior remains applicable because the client dependency and lookup method are unchanged. No earlier gate substitutes for this round's required checks.

# Unmet Criteria

None. Both requested bounds and both compatibility fixes are implemented, tested red then green, and committed separately. Publication remains deferred.

# Residual Risk

- Only the first two distinct targets are considered; a quote of an own message appearing later can deliberately remain unaddressed.
- Three seconds bounds waiting across both lookups, not cancellation of the underlying HTTP request. Event-loop scheduling can add overhead; a later incoming message can attempt a previously failed target again.
- Tests use synthetic service responses rather than a live service.
- Install reports three dependency audit findings (one low, two high), unchanged from the previous round; remediation is outside scope.

# Updated Draft PR

**Title:** Treat quote replies to own stream messages as addressed

**Description:**

Recognize quote-reply headings in raw Zulip Markdown, including translated link text and backtick or tilde quote fences. Mark a stream message as a mention only when a recognized quote target's sender matches the connector's own user. Reuse the author cache, otherwise make a bounded authenticated message lookup and fail closed on errors. Silent mentions alone, unrelated links, and quotes of other senders do not qualify.

Process only the first two distinct quote targets under a shared three-second lookup budget. Await message handlers to preserve delivery order without allowing a hung quote lookup to block unrelated events beyond that budget, apart from scheduler overhead. Reuse the existing mention metadata and tags.

Deliberate limits:
- Live incoming path only; history and catch-up remain unchanged.
- DM and group-DM addressing remain unchanged, with no quote lookups for already-addressed messages.
- Target matching trusts only the message id: the link's realm and mention text are ignored. Sender identity is checked against the local author cache or the authenticated service, not against the heading's displayed text.
- Targets after the first two distinct ids are ignored.

Include a changelog fragment and 21 quote-reply regression tests. All four follow-up tests fail on the preceding implementation and pass after these fixes. Fresh `npm ci`, `npm run build`, and `npm test` pass: 296 passing tests and one unchanged platform-specific skip. Independent of the existing `edit_message` change.
