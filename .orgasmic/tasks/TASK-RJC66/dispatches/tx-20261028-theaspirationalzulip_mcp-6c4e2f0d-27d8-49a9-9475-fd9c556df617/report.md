# Changed

New local commit: `369959c58913d87b307a0b37342fa5bd810b583d`, directly on `be08fd5855efbfface716618e52b7906e662c17b`. No amend or push; working tree clean.

Wording only in two files:
- `changelog.d/quote-replies.fixed.md`
- The `markQuoteMention` docstring in `src/platforms/zulip.ts`

Both now explicitly state that at most the first two distinct quote targets per incoming message are considered, sharing a three-second budget per message. A poll batch containing several quote replies can delay later events by up to that budget for each message. No executable code or tests changed.

# Verification Gates

Ran `npm test` exactly once through gate `wording-test`, at the clean final commit: **297 tests, 296 pass, 0 fail, 1 skip**.

Logs relative to this report:
- Summary: `wording-test.log`
- Gate receipt: `gate-wording-test-01M61RTHYVP32PWYXXH017R32D.log`

`git diff --check HEAD^ HEAD` passed. The commit diff confirms only the changelog and docstring changed.

Inherited evidence: the parent implementation's 21 quote-reply regression tests and runtime behavior are unchanged. Earlier red/green evidence remains historical evidence for those unchanged code/test inputs, not a substituted gate pass for this round. The fresh full-suite run reproduces the parent's 296 passing tests and the same platform-specific skip. Install and build were not rerun: this wording-only round required only one test-suite run.

# Unmet Criteria

None. The requested wording correction is committed separately and the final draft below includes the same correction.

# Residual Risk

Runtime behavior is unchanged. The three-second lookup budget is per incoming message, not per poll batch: several quote replies can cumulatively delay subsequent events. Timeouts bound waiting rather than cancelling underlying HTTP requests; scheduler overhead can add latency. Targets beyond the first two distinct ids per message are deliberately ignored.

# Final Draft PR

**Title:** Treat quote replies to own stream messages as addressed

**Description:**

Recognize quote-reply headings in raw Zulip Markdown, including translated link text and backtick or tilde quote fences. Treat an incoming stream message as a mention only when a recognized quote target was sent by the connector's own user. Prefer the existing author cache, otherwise use an authenticated message lookup and fail closed on errors. Silent mentions alone, unrelated links, and quotes of other senders do not qualify.

Consider at most the first two distinct quote targets per incoming message, sharing a three-second lookup budget per message. Message handlers are awaited to preserve delivery order. A poll batch containing several quote replies can delay later events by up to that budget for each message, plus scheduler overhead; this is not a three-second bound for the entire batch.

Deliberate limits:
- Live incoming path only; history and catch-up remain unchanged.
- DM and group-DM addressing remain unchanged, with no quote lookups for already-addressed messages.
- Target matching uses only the message id: the link's realm and mention text are ignored. Sender identity is verified against the local author cache or authenticated service.
- Targets beyond the first two distinct ids per message are ignored.

Reuse the existing mention metadata and tags. Include a changelog fragment and 21 quote-reply regression tests. The prior implementation rounds established red/green coverage and passed install/build checks. The final wording-only commit passes `npm test`: 296 passed, 0 failed, 1 unchanged platform-specific skip. Independent of the existing `edit_message` change.
