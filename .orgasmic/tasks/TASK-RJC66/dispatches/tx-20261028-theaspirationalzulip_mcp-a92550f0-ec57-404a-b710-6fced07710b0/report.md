# Verdict

**Approve** — TASK-RJC66 round 2 (`be08fd5855efbfface716618e52b7906e662c17b`).

Both round-1 MEDIUMs are closed, reproduced-then-fixed with my own probes against both
commits. No HIGH or MEDIUM findings remain. Three LOW findings, one of which is a wording
inaccuracy in the changelog/PR text that is worth a one-line correction before publication.

# Findings

## LOW — perf/docs: the three-second budget is per incoming message, not per event batch

`src/platforms/zulip.ts:390` (`markQuoteMention`, `const deadline = performance.now() + QUOTE_TIMEOUT_MS`)
starts a fresh budget for every stream message. `src/platforms/zulip-events.ts:475` awaits
`onMessage` inside the per-batch `for` loop, so a poll batch carrying N quote-reply messages
with uncached targets stalls every later event in that batch by up to N x 3 s.

Probe P6 (`$ORGASMIC_EVIDENCE_DIR/probes/probe.test.ts`, run log
`probes/probe-be08fd5.log`): three hung quote messages plus one unrelated message in one
batch, `getById` never resolving — the unrelated message arrived after **9006 ms**, not 3 s.
The same probe on `c741dc9` took 45026 ms, so this is still a large improvement.

The defect is in the stated bound, not in the mechanism:
- `changelog.d/quote-replies.fixed.md:3-4` — "quote lookups limited to the first two distinct
  targets and a shared three-second budget" reads as a global bound.
- Draft PR text — "Await message handlers to preserve delivery order **without allowing a hung
  quote lookup to block unrelated events beyond that budget**, apart from scheduler overhead."
  Probe P6 shows unrelated events blocked 3x that budget.
- Implementer report, "Residual Risk" / prose — "later events by at most one shared
  three-second lookup budget". Same overstatement.

Not raised above LOW: it needs a hung-or-slow `getById` *and* several quote replies to
uncached ids in one poll; quote replies normally target recent messages, which the `seen`
cache serves with no GET (test `test/quoteReplies.test.ts:84`, probe P2 at 201 ms for 50
headings when targets resolve). Events are not lost — the queue buffers them.

Fix direction: either say "per incoming message" in the changelog and PR text, or thread one
deadline through the batch (hoist the deadline into `ZulipEventLoop`'s loop, or cap total
quote spend per poll) if a per-batch bound is actually wanted.

## LOW — design: an own-message quote at distinct-target position 3 or later never addresses

`src/platforms/zulip.ts:105` (`if (ids.size === 2) return ids;`) stops collecting after two
distinct targets, so a multi-quote reply whose third-or-later quote is of the agent's own
message does not wake the agent. This is deliberate, asserted by
`test/quoteReplies.test.ts:198-208` ("later targets deliberately do not affect addressing"),
and listed under "Deliberate limits" in the draft PR. Acceptance criteria name only the
single-quote cases, so this is not an unmet criterion. Recorded so the owner can decide
whether the cap belongs at 2 or higher.

## LOW — security (informational): any bot-authored `/near/<id>` counts, including DMs and non-allowlisted streams

`src/platforms/zulip.ts:393` resolves the heading id through the shared `locate`, which trusts
only the message id (by design — see the PR's "Deliberate limits"). Consequences I checked:
- A member of an allowlisted stream can force a wake by quoting *any* id the bot authored,
  including one in a stream outside `streamAllowed` or a DM. No privilege gain: the same member
  can wake the bot with a plain `@mention`.
- `locate` calls `remember` (`src/platforms/zulip.ts:379`), so up to two foreign messages per
  incoming message enter the 2000-entry FIFO `seen` cache (`src/platforms/zulip.ts:200-201`),
  adding mild eviction pressure.
- **No content leak.** Both consumers of the cache re-gate by allowlist after lookup: the
  reaction path at `src/platforms/zulip.ts:887` and the change path via `changeAllowed`
  (`src/platforms/zulip.ts:410-420`). `markQuoteMention` itself emits nothing from the quoted
  message — only the `authorId` comparison at `src/platforms/zulip.ts:397`.
- Pre-existing: `locate`'s fetch-then-gate shape predates this task (reaction path).

# Verification Gates

All three gates named in the brief were rerun by me in this worktree through the wrapper, on a
clean tree at `be08fd5855efbfface716618e52b7906e662c17b`:

| Gate | Command | Result | Log |
|---|---|---|---|
| `rev2-install` | `npm ci` | exit 0 (3 audit findings: 1 low, 2 high — unchanged, out of scope) | `gate-rev2-install-01M61RAR37ZFA7H6J3E0SGM79J.log` |
| `rev2-build` | `npm run build` | exit 0 | `gate-rev2-build-01M61RAVWNVK4ZJDAA0HYNHZYN.log` |
| `rev2-test` | `npm test` | exit 0 — 297 tests, 296 pass, 0 fail, 1 skip | `gate-rev2-test-01M61RAYTA6HDHNXX56GT6B1P8.log` |

## Independent probes (production path, both commits)

Probe suite `$ORGASMIC_EVIDENCE_DIR/probes/probe.test.ts` drives the real
`ZulipEventLoop` -> `ZulipAdapter` -> `IncomingChannelMessage` path with a stub Zulip client
(only `queues.register`, `events.retrieve`, `messages.getById` are stubbed). `c741dc9` was
exported with `git archive` into a temp directory, so this worktree was never modified.
Logs: `probes/probe-be08fd5.log` (6/6 pass) and `probes/probe-c741dc9.log` (probe suite plus the
round-2 `test/quoteReplies.test.ts` run against the parent source).

| Probe | be08fd5 | c741dc9 (parent) |
|---|---|---|
| P1 stall: hung lookup + unrelated message | pass, **3015 ms** | fail, **15016 ms** |
| P2 fan-out: 50 distinct headings, 100 ms per GET | pass, **2 calls / 201 ms** | fail, **50 calls / 5016 ms** |
| P3 shared budget: target A sleeps 2500 ms, target B hangs | pass, both tried, **3001 ms total** | fail, 17507 ms |
| P4 pending GET resolving after the budget | pass, **3001 ms**, verdict stays `false` | fail, 15005 ms |
| P5 core behaviour (own quote / other sender / silent mention) | pass | pass |
| P6 three hung quote messages in one batch | 9006 ms (see LOW #1) | 45026 ms |

Conclusions drawn from these:
- **MEDIUM #1 (stall) closed.** 15016 ms -> 3015 ms for a single hung lookup (P1).
- **MEDIUM #2 (unbounded serialized lookups) closed.** 50 -> 2 GETs (P2).
- **The budget is genuinely shared.** P3: the first target consumed 2500 ms, the second was
  still attempted and got only the ~500 ms remainder; total 3001 ms. The code recomputes
  `remaining` per iteration and bails on `remaining <= 0` (`src/platforms/zulip.ts:391-392`).
- **A pending request cannot extend the budget.** `withTimeout` (`src/platforms/zulip.ts:144-150`)
  is a `Promise.race`, so the deadline rejection wins and `locate`'s post-await
  `remember`/return never runs for the orphan. P4 confirms: the message was delivered
  not-addressed at 3001 ms, and resolving the orphaned GET afterwards with `sender_id: SELF`
  did **not** flip the already-delivered verdict.
- **No regression of the round-1 behaviour.** P5 passes identically on both commits, and the 17
  pre-existing tests in `test/quoteReplies.test.ts` pass on both.

## Tests hit production code and fail on the parent

The round-2 `test/quoteReplies.test.ts` run against the `c741dc9` source: 21 tests, 17 pass,
**exactly the 4 new tests fail** — hung-budget, two-distinct-ids, translated link text, tilde
fences. The implementer's red/green claim is reproduced.

I also confirmed the fixtures match production reality rather than only the test harness:
the event queue registers with `apply_markdown: 'false'` (`src/platforms/zulip-events.ts:292`)
and `getById` passes `apply_markdown: false` (`src/platforms/zulip.ts:370`), so
`m.rawContent` (`src/history.ts:228`) really is raw Markdown, which is what
`quotedMessageIds` parses and what the fixtures supply.

## Changelog and PR text

- `changelog.d/quote-replies.fixed.md` filename matches the enforced
  `<slug>.<breaking|added|changed|fixed>.md` convention (`scripts/release-changelog.mjs:73`).
- Draft PR counts verified: 21 quote-reply tests, 4 red on the parent, 296 passing + 1 skip,
  fresh `npm ci` / build / test green.
- The stated limits (two distinct targets; id-only matching; live path only; DM addressing
  unchanged) all match the code.
- One inaccuracy, LOW #1 above: the per-message budget is presented as a per-batch bound.

# Unmet Criteria / test gaps

No unmet acceptance criteria. Every acceptance line is covered through the production path:
own-message stream quote addressed (`test/quoteReplies.test.ts:57`); group DM unchanged
(line 69); silent mention, quote of another sender, non-heading `/near/` link, fenced example
(lines 95-120); fail-closed on throw / deleted / unfetchable (line 122).

Remaining gaps, none blocking:
- No test asserts an aggregate bound across a batch with several quote messages; LOW #1 is
  consequently untested in-repo (my probe P6 covers it externally).
- No coverage of a quote target in a stream outside the allowlist, or of a DM target, so the
  intended id-only matching is asserted only for same-stream ids.
- All coverage uses synthetic client responses; nothing runs against a live Zulip realm.

# Residual Risk

- Degraded-server burst: N quote-reply messages with uncached targets in one poll stall later
  events by N x 3 s. At roughly 200 such messages the event queue could pass Zulip's idle GC
  window; the loop's reconnect and gap handling would then apply.
- `QUOTE_TIMEOUT_MS` bounds waiting, not cancellation — orphaned GETs keep running against the
  realm, and a later message quoting the same id retries it (one GET per message, no retry loop).
- The two-target cap silently drops later own-message quotes.
- `npm ci` reports 3 dependency audit findings (1 low, 2 high), unchanged from the base and
  outside this task.

# Fix Directions

1. (LOW #1, recommended before publication) Change the changelog fragment and the PR body to
   say the three-second budget is **per incoming message**; or, if a per-batch bound is wanted,
   hoist the deadline into `ZulipEventLoop`'s batch loop and add a test asserting that N quote
   messages in one batch do not exceed one budget.
2. (LOW #2, owner's call) If multi-quote replies matter, raise the distinct-target cap or make
   it a named constant beside `QUOTE_TIMEOUT_MS` so the trade-off is adjustable.
3. (LOW #3, optional hardening) Skip or discard `remember` for quote targets whose resolved
   channel is outside the allowlist, to keep attacker-chosen ids out of the `seen` cache.

Worktree left as found: detached at `be08fd5855efbfface716618e52b7906e662c17b`, `git status`
clean, no commits, no tracked edits. Probe sources and logs are under
`$ORGASMIC_EVIDENCE_DIR/probes/`; the temporary `c741dc9` export was deleted.
