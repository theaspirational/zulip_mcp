# TASK-PXRSM re-review — fix round 1 (`3533690`, `e8a1fe8` on `8f3a8248`; base upstream `e5c4b4c`)

## Verdict

**Approve with changes (does not block ship).** All five review-1 findings are fixed, and
each fix is mutation-sensitive except one untested guard (see LOW-1). The new
email→user-directory fallback is safe in the way that matters: it **never changes the send
destination** — the DM destination is always the referenced message's `display_recipient`
ids (`src/tool-runtime.ts:345`), and the directory result only enters the `supplied` set
used for the agreement check (`:328-344`). It adds **one** `GET /api/v1/users` call, only
on the path where a supplied email does not match the message's own metadata, always
before any upload or send, through the existing 60s-cached `members()` helper
(`:1031-1037`) that `find_user`/`send_dm` already use — so no new permission scope. An
ambiguous directory refuses (`matches.length === 1`). A *stale* directory cannot misroute,
but it can silently satisfy the cross-check for a `to` the caller meant differently
(MEDIUM-2). One new regression against base was introduced while fixing review-1 MEDIUM-2:
`required` is now absent from the `send_message` schema entirely, and no runtime guard
replaced it for `type` (MEDIUM-1).

## Findings

### MEDIUM-1 — correctness: `type` lost both its schema `required` and any runtime guard (`src/tools.ts:208`, missing guard at `src/tool-runtime.ts:712`)

Review-1 MEDIUM-2 asked for a local destination guard because sibling top-level `anyOf` is
commonly dropped by MCP client schema sanitizers. The round added the `to`-or-`reply_to`
guard (`:712`) but also moved `type` out of `required` and into the same fragile `anyOf`
branch, and added no runtime check for it. `required` is now `undefined` — the test even
pins that (`test/toolRuntime.test.ts:433`). Base `e5c4b4c` had `required: ["type","to"]`;
round 1 had `required: ["type"]`. So for a sanitizing client, missing `type` is newly
unguarded at both layers.

Probe (`$ORGASMIC_EVIDENCE_DIR/probe-missing-type.mts`, real `ZulipToolRuntime`):

```
schema.required = undefined
send_message { to:12, topic:'Deploy status', content:'oops' }   // no type
→ wire sends: [{"to":12,"topic":"Deploy status","content":"oops"}]
→ threw: Missing 'type' argument        (remote 400, not a local refusal)
→ onSent records: []
```

Impact is bounded — a remote 400 instead of a local error, and no junk `onSent` record
(the callback runs only after success, `:729-730`) — which is why this is MEDIUM and not
HIGH. But it is strictly worse than both the base and the commit under fix.

*Fix direction:* extend the existing one-liner at `:712` to
`if (args.reply_to === undefined && (args.to === undefined || args.type === undefined)) throw new Error("type and to are required without reply_to")`,
and keep `required: ["type"]` in the schema alongside the `anyOf` (the `anyOf` branch
`{required:["type","to"]}` then only adds `to`). Add the missing-`type` case to the
existing `review refuses a missing destination before lookups, uploads or sends` test
(`test/toolRuntime.test.ts:546`).

### MEDIUM-2 — correctness: a stale user directory can silently satisfy the destination cross-check (`src/tool-runtime.ts:332-335`)

The fallback resolves a supplied email through `members()` and compares the resulting user
id against the participant set. The directory is cached for 60s (`:1033`) and is realm
state that can drift from what the caller believes. If an email the caller supplies
resolves to a *different* user who happens to be a participant of the referenced
conversation, the check passes and the send proceeds.

Probe (`$ORGASMIC_EVIDENCE_DIR/probe-directory-fallback.mts`), referenced DM with
participants `790, 42, 7` (synthetic emails), directory maps `alice@example.com → 7`:

```
(b) send_message { reply_to:123, to:['alice@example.com','42','790'] }
    → accepted; wire to = [790,42,7]; channelId zulip:dm:7+42
```

The caller named three parties, one of which it believed was Alice; it was user 7. No
misroute — the destination is still the referenced conversation (`(c)` below shows a
non-participant id still refuses) — but the `to`-vs-participants agreement check is exactly
the guardrail this feature exists to provide against the motivating "right text, wrong
conversation" failure, and here it passes vacuously. The same probe confirms the safe
boundaries:

```
(a) ambiguous (two members share the email) → refused, 1 lookup, 0 sends
(c) directory id not a participant          → refused, 0 sends
(e) emails already match message metadata   → 0 GET /users calls
```

*Fix direction:* this is inherent to matching by a mutable key, so prefer narrowing the
blast radius over removing the fallback: skip the directory when the supplied email is
non-synthetic and the message metadata carries real emails (i.e. only fall back when at
least one `display_recipient[].email` looks synthetic), and mention in the error/README
that id-based `to` is the only exact cross-check. At minimum document the limitation next
to the existing synthetic-email note in `README.md:318-321`.

### LOW-1 — test: the directory ambiguity guard is not covered (`src/tool-runtime.ts:335`)

`matches.length === 1` is the only thing preventing an ambiguous email from being accepted
as whichever duplicate sorts first. Relaxing it to `matches.length >= 1` leaves the whole
suite green:

```
M7 ambiguity guard length===1 -> length>=1   → 42 pass, 0 fail
```

(`$ORGASMIC_EVIDENCE_DIR/mutation-probes.sh`; every other fix in the round *is*
mutation-sensitive, M1–M6 and M8 all fail 1–7 tests). Probe case (a) above shows the code
is correct today; nothing would catch a regression.

*Fix direction:* add a case to the existing synthetic-email test
(`test/toolRuntime.test.ts:524-544`) with two members sharing the email, asserting refusal
and `sends == []`.

### LOW-2 — design (accepted narrowing, undocumented consequence): a stream literally named with digits can no longer be addressed by name under `reply_to` (`src/tool-runtime.ts:307`)

`to` is coerced to a number whenever it is all digits, so `to: '99'` against a message in a
stream *named* `"99"` with `stream_id: 12` refuses. That is the intended reading ("Numeric
strings are IDs", `src/tools.ts:176`) and is a refusal rather than a misroute, and the
round even pins it as a test (`test/toolRuntime.test.ts:507`). Noting it only because the
README's "case-insensitive, trimmed name" sentence (`README.md:315-317`) does not say the
name form is unavailable for all-digit stream names.

### LOW-3 — perf: one send issues N identical `GET /api/v1/users` calls for N unresolved emails (`src/tool-runtime.ts:324-336`, cache at `:1031-1037`)

`Promise.all` fans out before `members()` populates `userCache`, so every unresolved email
races its own fetch:

```
(d) GET /users calls for one send with 3 emails = 3
```

Harmless at tool-call rates and the same pattern already exists in `send_dm`
(`:745`), so pre-existing in kind. *Fix direction (optional):* memoise the in-flight
promise in `members()` (`this.userCache` holding a `Promise` rather than the resolved
array).

## Verification Gates

Rerun by me in this worktree at `e8a1fe8265a8749b7c3716832f9b8a39788b5048` (clean tree,
clean after), as the brief required — not reused from the implementer's receipts:

| gate | command | result | log |
| --- | --- | --- | --- |
| install | `npm ci` | exit 0 | `gate-install-01M63XPG69HRRTHNKTTZ63M9NG.log` |
| typecheck | `npx tsc --noEmit` | exit 0 | `gate-typecheck-01M63XPM6FW0C69381E4TAF7QV.log` |
| build | `npm run build` | exit 0 | `gate-build-01M63XPNAVGRK5QP79YC0464GV.log` |
| test | `npm test` | exit 0 — 298 tests, 297 pass, 0 fail, 1 skip | `gate-test-01M63XPSJ8MJ16F9R5WH61PRCA.log` |

Logs in `$ORGASMIC_EVIDENCE_DIR` (run-01M63XK42Q9G83MYJ49A34B6KD). The one skip is the
known pre-existing non-Linux local-file upload test (also skipped in round 1 and at base);
`npm ci` reports the same 3 pre-existing advisories, with no lockfile or dependency change
in the round diff. Test count matches the fix report's 298/297/1.

Scoped probes, all outside the tracked tree in `$ORGASMIC_EVIDENCE_DIR`, run with
`node --import tsx` against the real `ZulipToolRuntime` and real `toolDefinitions`:
- `probe-missing-type.mts` — MEDIUM-1; shows the schema has no `required` and the
  type-less payload reaches the wire.
- `probe-directory-fallback.mts` — the brief's three questions about the fallback:
  cases (a) ambiguous, (b) stale/reassigned, (c) non-participant, (d) lookup count,
  (e) no lookup when metadata emails match.
- `mutation-probes.sh` — records the eight mutations and their failure counts; run in a
  scratch copy of the source with `node_modules` symlinked, deleted afterwards. The
  tracked tree was never modified (`git status --porcelain` empty before and after).

Per-finding check of review-1's five findings (code read plus the mutation result that
would catch a regression):

| review-1 finding | fixed at | regression test | mutation |
| --- | --- | --- | --- |
| M1 numeric-string / email-mismatch false conflict | `tool-runtime.ts:307`, `:331-335` | `test/toolRuntime.test.ts:492-544` (accepts `'12'`, `['42']`, `'42,7'`; refuses mismatched `'99'`; synthetic-email accept/refuse) | M4 → 2 fail, M5 → 2 fail, M6 → 1 fail |
| M2 no enforced destination check | `tool-runtime.ts:712` | `:546` (asserts `gets`, `userLookups`, `uploaded`, `sends` all empty) | M2 → 1 fail |
| L3 `type` required / mis-attributed error | `tool-runtime.ts:296` | `:563` (infers for stream and DM, still refuses a real mismatch) | M1 → 2 fail |
| L4 DM channel id includes the bot | `tool-runtime.ts:345` | `:360` (1:1 and group `channelId`), `:585` (self-DM keeps the bot) | M3 → 2 fail |
| L5 implicit-sender rule unconditional | `README.md:317-319`, `src/tools.ts:176` | `:575` (`selfUserId: null`: omitted `to` works, full set accepted, partial set refused) | — (docs; the null-path behaviour is covered) |

Two corrections to the fix report's framing, neither a defect: it says review assertions
were treated as claims and reproduced — the red-before gates it cites do establish that;
and its PR description says "reject missing destinations before side effects", which is
true for `to` but, per MEDIUM-1, not for `type`.

Scope: round diff touches only `README.md`, the changelog fragment, `src/tool-runtime.ts`,
`src/tools.ts`, `test/toolRuntime.test.ts`. No dependency, lockfile, permission, or CI
change; `GET /api/v1/users` is already used by `find_user`/`send_dm`, so no new scope. No
push, PR, merge, or outbound messaging. The owner's `pxrsm:lows:fold` scope expansion is
quoted in the fix report as asked, and all three LOWs are addressed; the request to use
separate commits was honoured (MEDIUMs in `3533690`, LOWs in `e8a1fe8`).

## Unmet Criteria / test gaps

Task acceptance criteria all remain met (stream reply, 1:1 and group DM replies,
disagreement refusal, unknown/inaccessible id, `reply_to` absent unchanged — the last
still asserted payload-exact at `test/toolRuntime.test.ts:414-429`, and the loopback
real-client GET-before-POST test at `:448-487` is unchanged and rerun). Remaining gaps:

1. No test for an ambiguous directory match (LOW-1) — the guard is silently removable.
2. No test for `type` absent without `reply_to` (MEDIUM-1); the schema test at `:433` pins
   the *absence* of `required`, which locks in the weaker contract rather than flagging it.
3. No test for a stale/reassigned directory email that resolves onto a different
   participant (MEDIUM-2); probe case (b) stands in for it.
4. Still no live-realm verification that Zulip accepts `to` containing the bot's own id,
   nor that a numeric `to` is read as a channel id — carried over from review 1, covered
   only by the loopback wire-form test.

## Residual Risk

- The destination cross-check is only exact for id-based `to`. Email-based `to` depends on
  realm directory state that is up to 60s stale and mutable (MEDIUM-2); the fail-closed
  direction (false refusal) is the common case, the fail-open direction needs an email
  that resolves onto another participant of the same conversation.
- Under restricted `EMAIL_ADDRESS_VISIBILITY` the directory also returns synthetic
  addresses, so the fallback does not help there and matching stays fail-closed. The fix
  report records this.
- Lookup and send are still two non-atomic requests: a topic move or deletion between them
  means the destination is the lookup's snapshot. Unavoidable at this layer.
- `reply_to` now costs one `GET /api/v1/messages/{id}`, plus up to N `GET /api/v1/users`
  when emails need resolving (LOW-3).
- The CI OS/Node matrix was not exercised locally; the single skip is the known non-Linux
  upload test.

## Fix Directions (ordered)

1. `src/tool-runtime.ts:712` + `src/tools.ts:208` — restore a `type` guard at both layers
   (runtime check and `required: ["type"]`), and extend the missing-destination test.
2. `src/tool-runtime.ts:332-335` — narrow the directory fallback to the synthetic-email
   case it was added for, and document that only id-based `to` is an exact cross-check.
3. `test/toolRuntime.test.ts:524` — add the two-members-share-an-email ambiguity case.
4. `README.md:315-317` — note that an all-digit `to` is always read as an id, so a stream
   named with digits must be addressed by id under `reply_to`.
5. `src/tool-runtime.ts:1031` (optional) — cache the in-flight `members()` promise so one
   send makes one user-list request.
