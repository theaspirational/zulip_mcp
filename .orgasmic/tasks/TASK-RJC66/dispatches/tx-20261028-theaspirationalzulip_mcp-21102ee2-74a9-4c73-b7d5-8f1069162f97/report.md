# Review — TASK-RJC66 (c741dc9) "Treat quote replies to own stream messages as mentions"

## Verdict

**Changes requested — do not open the upstream PR as-is.** The addressing logic is
correct, well-tested and well-scoped: the parser handles real Zulip raw Markdown
(including nested `````quote`` and absolute realm URLs), it trusts only the `/near/<id>`
integer, it fails closed, it skips the lookup whenever the message is already
addressed, and group-DM behaviour is unchanged per the manager's decision. The commit
cherry-picks onto upstream `e5c4b4c` cleanly and the whole suite passes there, so it is
genuinely independent of the edit_message PR.

What blocks the PR is item 2 of the brief: `await onMessage(...)` in the shared event
loop. I reproduced that **one hung quoted-message GET stops delivery of every
subsequent, unrelated event for up to 15 s**, and that a single incoming message can
force an unbounded number of serialized GETs (50 proven). Both are small fixes.

## Findings

### MEDIUM — bug/perf: awaiting the handler stalls delivery of unrelated events for up to 15 s
`src/platforms/zulip-events.ts:475` (`await onMessage(...)`), reached from
`src/platforms/zulip.ts:913` → `locate` at `:361` with `LOCATE_TIMEOUT_MS = 15_000`
(`:132`).

Before this commit `onMessage` was fire-and-forget, so handler work never gated the
queue. Now the loop awaits it, and the quote lookup is an in-handler network GET.

Failure scenario (reproduced, `probe-stall.out` / `stall.ts`): a batch of three stream
messages — `300` is a quote-reply whose `getById` never answers, `301` and `302` are
unrelated messages in other topics. **Nothing at all is delivered within 2 s**; `301`
and `302` wait on `300`'s 15 s timeout before the host sees them, and the next long-poll
is not issued either. One slow realm GET on one quote-reply therefore delays every
other channel's traffic.

This is not proportionate: `mentioned` must be known before `toIncoming`, but only the
quote-reply itself needs to wait. Note that the file's own established pattern for the
same lookup on the reaction path is explicitly non-blocking (`void this.locate(...)` at
`src/platforms/zulip.ts:878`), so awaiting here is also inconsistent with the
surrounding design.

Not HIGH: acceptance is met, no events are lost (the id is already acked and in-batch
order is preserved — covered by the "without ... losing later events" tests), and a
message with no quote heading performs zero awaits, so the common path is untouched. It
becomes HIGH if combined with the next finding (see the queue-expiry note there).

### MEDIUM — bug/perf: unbounded, serialized quoted-message lookups per incoming message
`src/platforms/zulip.ts:388` — `for (const id of quotedMessageIds(m.rawContent))` has no
cap, and each iteration `await`s its own up-to-15 s GET.

Failure scenario (reproduced, `probe-parser.out`, case "50 distinct quote headers"): a
single 10 kB stream message containing 50 synthetic `[said](/near/N):` + `` ```quote ``
pairs produces **50 sequential `messages.getById` calls** inside the awaited handler.
Any user who can post in an allowed stream controls this count (~160 headers fit in
Zulip's 10 000-char limit). Normal "message not found" answers return fast, but against
a hanging or rate-limited realm the worst case is N × 15 s of total event-delivery
stall; past ~40 ids that exceeds Zulip's idle queue lifetime, which forces a
re-registration and a history gap rather than a mere delay.

The docstring at `src/platforms/zulip.ts:385` ("makes one bounded GET") describes the
intent but not the code — it is one GET *per distinct quoted id*.

### MEDIUM — coverage: the quote verdict is live-path only, so catch-up drops it
`src/history.ts:230` derives `mentioned` from Zulip's flags alone, and catch-up filters
on it (`src/server.ts:1238` skips non-`mentioned` views, `:1199`/`:1220` build the
mention tally from it). `markQuoteMention` only runs on the live event path
(`src/platforms/zulip.ts:913`).

Failure scenario: a quote-reply to the agent's own message arrives while the agent is
restarting or during an event-queue gap. The live verdict never runs, history reports
`mentioned: false`, and the mention-only catch-up discards it — exactly the "never wakes
for a quote-reply" symptom the task set out to fix, just on the recovery path. Strictly
this is outside the written acceptance criteria (which name the live path only), so it
need not block, but it should be stated as a known limitation in the upstream PR
description rather than left implicit. The `src/history.ts:379-380` comment is honest
about it ("a **live** quote reply").

### LOW — correctness: Zulip's "said" string is translatable, so non-English quote replies are missed
`src/platforms/zulip.ts:110` hard-codes `\[said\]`. Zulip composes the quote heading from
a translated message (`"{username} [said]({link}):"`), using the *quoting* user's UI
language. Reproduced (`probe-parser.out`, case "localized said (German)"): a heading
reading `[sagte](...)` yields `not-addr gets=0`. Fails closed, so it is a missed wake,
not a false positive. Fix direction: match any single link whose target ends in
`/near/<id>` and that is the whole line ending in `:`, i.e. replace `\[said\]` with
`\[[^\]\n]*\]`; the id-only trust model keeps this safe.

### LOW — correctness: `~~~quote` fences are not recognized
`src/platforms/zulip.ts:104` requires `marker[1][0] === '`'`, while the fence *opener*
regex at `:98` accepts tildes. Reproduced (`probe-parser.out`, "tilde fence ~~~quote"):
`not-addr gets=0`. The Zulip web client always emits backticks, so this only affects a
hand-typed quote reply; Zulip itself renders `~~~quote` as a quote block. Fails closed.

### LOW — security/design: the quote link's realm and the silent mention are both ignored
`src/platforms/zulip.ts:110-112` extracts only the integer. Reproduced
(`probe-parser.out`): `[said](https://evil.example/#narrow/near/200):` and a
mention-less hand-written `[said](/near/200):` both yield `ADDRESSED`. So any user in an
allowed stream can hand-craft a heading with arbitrary quoted text and wake the agent.
I consider this acceptable and arguably correct — ids are the only trustworthy part of
the heading, and the same user can already wake the agent with a plain `@`-mention, so
no capability is gained — but it is worth one sentence in the PR so reviewers do not
read the realm-agnostic match as an oversight.

### LOW — docs: the changelog omits the event-loop behaviour change
`changelog.d/quote-replies.fixed.md` is accurate about the feature ("using the quoted
message's sender rather than the silent mention's label") and matches the directory's
prose-bullet style, but says nothing about message handlers now being awaited — a
visible behaviour change for anyone embedding `ZulipEventLoop`. The `OnZulipMessage`
widening at `src/platforms/zulip-events.ts:57` is itself backward-compatible for sync
handlers.

## Verification Gates

Rerun in this worktree at c741dc9 (not relying on implementer receipts):

| gate | command | result | log |
| --- | --- | --- | --- |
| `review-install` | `npm ci` | exit 0 | `gate-review-install-01M61QSGVV79D4MCJ8A8WYZB7A.log` |
| `review-build` | `npm run build` (`tsc`) | exit 0 | `gate-review-build-01M61QSM6V21VE9JCZ9H7HXDEC.log` |
| `review-test` | `npm test` | exit 0 — 293 tests, 292 pass, 1 skip (platform), 0 fail | `gate-review-test-01M61QSPXPBAJZ7TR531582Y92.log` |

`npm test` globs `test/*.test.ts`, so `test/quoteReplies.test.ts` is inside it; all 17 of
its cases are present and green in the log (ok 135-151), so no separate run was needed.

Unwrapped probes (no reusable receipt; artifacts in this evidence dir):

- **Red on base** — `test/quoteReplies.test.ts` replayed against `fafaeef`'s `src` in a
  clean `git archive` export: **8 of 17 fail** (`probe-base-red.out`). The failures are
  the positive and lookup-accounting cases; the negative cases pass on base, as they
  should. The tests exercise production code through
  `ZulipAdapter.startEvents` → real `ZulipEventLoop` → `toIncoming`, not a reimplemented
  parser.
- **Parser behaviour on real and adversarial Markdown** — `probe.ts` /
  `probe-parser.out`, driving the same production path. Confirmed ADDRESSED: real Zulip
  web output (absolute realm URL, fence on the next line, no blank line); nested quote
  with a `````quote`` outer fence; "other sender's quote first, own quote second" (2
  GETs, correct order). Confirmed not-addressed with **zero** GETs: non-numeric id,
  20-digit id (`Number.isSafeInteger` guard), heading inside a `>` blockquote, text
  after the colon, a quote heading swallowed by an earlier unclosed fence, localized
  `said`, `~~~quote`.
- **Stall** — `stall.ts` / `probe-stall.out`: see the first MEDIUM finding.
- **Independence from the edit_message PR** — cherry-picked c741dc9 onto upstream
  `e5c4b4c` in a throwaway clone: clean apply, `tsc --noEmit` exit 0, full suite 284
  tests / 283 pass / 1 skip / 0 fail. The commit touches no edit_message code path and
  adds its own changelog fragment, so it stands alone as one upstream PR.

Also checked by inspection: the queue is registered with `apply_markdown: 'false'`
(`src/platforms/zulip-events.ts:292`), so `m.rawContent` really is raw Markdown on the
live path — the parser is reading what it assumes. The `seen` cache is bounded
(`SEEN_CAP = 2000`, FIFO eviction at `src/platforms/zulip.ts:344-347`) and the quote
lookup adds no new cache. Failures are not negatively cached but are never retried
either, so there is no retry storm — exactly one GET per distinct uncached id per
incoming message (asserted by the three "fails closed … without retrying" tests). No
new tags: the verdict only flips the existing `chat:mention` / `chat:ambient` choice at
`src/history.ts:334`. Neither regex is ReDoS-prone (single greedy quantifier followed by
a fixed literal; linear backtracking).

## Unmet criteria / test gaps

All five acceptance bullets are met and tested on the production path. Gaps:

1. No test asserts that a slow quote lookup does **not** delay unrelated events — the
   existing tests only assert order and eventual delivery, which is why the stall
   survived. Any fix for the MEDIUM findings needs such a test (deliver `[quote-reply,
   unrelated]`, hang the GET, assert the unrelated message arrives promptly).
2. No test bounds the number of lookups a single message can trigger.
3. No coverage of the catch-up/history path for quote-replies (third MEDIUM).
4. No coverage of a localized `said` or a `~~~quote` fence (currently fail-closed).

## Residual risk

- Realm-dependent latency: in a healthy realm each lookup is a few ms and the stall is
  invisible; the regression only bites on a slow, rate-limited or hanging realm — which
  is precisely when timely delivery matters most and when it is hardest to diagnose,
  since the symptom appears on channels unrelated to the quote reply.
- Zulip may change the quote-and-reply heading format (it has changed the URL shape
  before); the parser fails closed if it does, so the symptom would be a silent
  regression to pre-commit behaviour with no error. Nothing in the tests pins the format
  against a real Zulip fixture.

## Fix directions

1. Bound the work (`src/platforms/zulip.ts:386-397`): look up at most the first one or
   two distinct quote ids per message, and use a short timeout for this path rather than
   the 15 s `LOCATE_TIMEOUT_MS` (a quote reply is only interesting while it is fresh).
   Zulip's own quote-and-reply emits one heading per quote and the self-quote is
   effectively always the first; capping costs no real coverage. Update the `:385`
   docstring to match. This alone turns the worst case from unbounded into a fixed,
   small delay and is the minimal change I would want before the PR.
2. Then keep `await onMessage` or drop it, as preferred — with (1) in place the
   remaining stall is one bounded short timeout, which I would accept. If you prefer to
   leave the shared loop untouched for upstream, revert
   `src/platforms/zulip-events.ts:475` to the fire-and-forget call and keep the
   `void`-style precedent at `src/platforms/zulip.ts:878`, doing the lookup inside the
   adapter handler and emitting that one message when it resolves; note this reorders
   the quote reply relative to later messages, so (1) is the cleaner option.
3. Either way, add the "slow lookup does not delay unrelated events" test from gap 1 —
   it is the regression this review found, and without it the fix is unprotected.
4. Optional, cheap: relax `\[said\]` to `\[[^\]\n]*\]` at `src/platforms/zulip.ts:110`
   and accept `~` fences at `:104`, with a one-line test each.
5. In the upstream PR description, state the three deliberate limits so reviewers do not
   re-derive them: live-path only (history/catch-up unchanged), group-DM addressing
   unchanged by decision, and realm/mention-agnostic matching that trusts only the id.
