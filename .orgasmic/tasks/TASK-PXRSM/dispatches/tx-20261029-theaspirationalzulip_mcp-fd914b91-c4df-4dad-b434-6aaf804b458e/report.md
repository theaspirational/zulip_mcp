# TASK-PXRSM re-review 3 — fix round 2 (`78ffb5f`, `952b9aa`, `3ff25b3` on `e8a1fe8`; base upstream `e5c4b4c`)

## Verdict

**Approve — ready to go upstream** (no HIGH, no MEDIUM; four LOWs, none blocking).

All five review-2 findings are fixed, and every one of them is now mutation-sensitive: eight
targeted mutations of the round's logic each break the suite (table below), including the
ambiguity guard that review-2 LOW-1 showed was silently removable. The two MEDIUMs are
properly closed — `type` is guarded at both layers again (`src/tools.ts:208` schema
`required: ["type"]`, runtime refusal at `src/tool-runtime.ts:715`), and the user-directory
fallback now only runs when the referenced message's own metadata carries a synthetic
address, so a stale directory can no longer satisfy the cross-check on a conversation whose
participants have real visible emails (`src/tool-runtime.ts:322`, `:334`). I re-ran install,
typecheck, build and the full suite myself at `3ff25b3`: all exit 0, 304 tests / 303 pass /
1 known skip.

On the brief's two specific questions:

- **Synthetic detection (`user<ID>` local part), `src/tool-runtime.ts:322`** — the shape test
  is `r.email?.toLowerCase().startsWith(\`user${r.id}@\`)`, i.e. the local part must agree
  with *that same participant's* id. That matches Zulip's `user{id}@{realm.host}` dummy
  exactly, and the id-agreement requirement is what makes it tight. Probed: canonical
  `user42@` and uppercase `User42@` detect; `user042@` and `user42x@` do not (Zulip emits
  neither), and metadata whose numeric local part belongs to a *different* participant does
  not (pinned by a test). **No false negative that refuses a valid call** was found, except
  the degenerate no-`email` metadata case (LOW-2). One **false positive** is real but narrow
  (LOW-1) and cannot misroute.
- **Memoised `members()` promise, `src/tool-runtime.ts:1035-1047`** — correct on error and
  expiry. Probed: one in-flight request is shared across different call sites (reply path and
  `resolveUserId`), `userLookup` is cleared on success *and* on rejection, a rejection is not
  cached (a retry re-issues), and the resolved 60 s cache still short-circuits later calls. A
  directory outage on the reply path fails closed with zero sends. Its one wart is
  pre-existing and unchanged (see Residual Risk).

## Findings

### LOW-1 — correctness (narrow, no misroute): a genuine address shaped `user<own id>@…` re-opens the directory fallback for the whole recipient set (`src/tool-runtime.ts:322`)

`hasSyntheticEmails` is a shape test over the recipients, so a *real* address whose local part
happens to be `user<that user's id>` flips the whole conversation back to review-2 MEDIUM-2's
behaviour, where a stale directory entry satisfies the agreement check.

Probe (`$ORGASMIC_EVIDENCE_DIR/probe-synthetic-and-memo.mts`, case B): DM participants
`790 bot@example.com`, `7 user7@corp.example.com` (a genuine corporate address), `42
bo@example.com`; directory maps `alice@example.com → 7`.

```
B send_message { reply_to:1, to:['alice@example.com','bo@example.com',790] }
  → accepted; 1 GET /users; wire to = [790,7,42]
```

The caller believed one party was Alice; it was user 7. **The destination is still the
referenced conversation** — no misroute is possible, since `to` only feeds the check and the
send always uses `display_recipient` ids (`:349`) — so this is a check that passes vacuously,
not a wrong send. The fix report names this residual explicitly and `README.md:325-329`
documents that id-based `to` is the only exact cross-check, which is why it is LOW.

*Fix direction (optional):* also require the resolved id to belong to a participant whose
metadata address is itself synthetic — `matches.length === 1 && recipients.some((r) => r.id === matches[0].user_id && isSynthetic(r))`
— which removes the mixed-metadata hole without changing any current test.

### LOW-2 — correctness/usability: `display_recipient` entries with no `email` field make an email-based `to` unsatisfiable (`src/tool-runtime.ts:331`, `:334`)

If a recipient entry carries no `email`, neither the direct comparison nor the fallback can
match, and the refusal names only "to (DM participants) disagrees" with no hint that only ids
will work here.

Probe (case A), participants `[{id:790},{id:42}]`, directory `42 → bo@example.com`:

```
A  to:'bo@example.com' → REFUSED "reply_to 1: to (DM participants) disagrees…"; 0 lookups, 0 sends
A2 to:[42]             → accepted
```

Fail-closed with a working alternative, and Zulip's API does include `email` in
`display_recipient`, so this is a robustness nit rather than a live defect. *Fix direction:*
when a recipient lacks `email`, say so in the conflict message (e.g. "…; this conversation's
metadata has no addresses — use user IDs").

### LOW-3 — test/usability: the directory-outage path under `reply_to` is uncovered and surfaces the raw client error (`src/tool-runtime.ts:337`)

`await this.members()` rejects straight through `replyDestination`, so the tool error is the
transport's own wording, unrelated to `reply_to`:

```
D directory outage, to:'bo@example.com' → REFUSED "directory unavailable"; 1 lookup, 0 sends
```

Behaviour is right (fail closed, nothing sent, nothing uploaded). The new retry test
(`test/toolRuntime.test.ts:655`) covers rejection handling only via `resolveUserId`, not the
reply path, so a future change that swallowed this error and fell through to "disagrees" —
or worse, to `undefined` — would not be caught. *Fix direction:* assert the outage case on the
reply path (refusal plus `sends == []`), and optionally wrap it as
`reply_to <id>: could not resolve "<email>" (user directory unavailable)`.

### LOW-4 — docs: the changelog fragment still advertises inferred `type` without noting the schema now requires it (`changelog.d/send-message-reply-to.added.md:3`)

"Reply message type is inferred when omitted" is true of the runtime but no longer of the tool
contract — a schema-conformant client must send `type` (`src/tools.ts:208`). The same fragment's
later sentence qualifies the refusal only for "when not replying", so a reader of the release
notes alone would expect `{reply_to, content}` to validate. `README.md:317-318` and the tool
description are correct and consistent. *Fix direction:* one clause — "the tool schema requires
`type`; direct runtime callers may still omit it with `reply_to`".

## Verification Gates

Rerun by me in this worktree at `3ff25b3e231ebd0d6ce3179c17bc91ee14aeb80d` (tree clean before
and after), per the brief — not reused from the implementer's receipts:

| gate | command | result | log |
| --- | --- | --- | --- |
| install | `npm ci` | exit 0 | `gate-install-01M63Y7RGFWE3VHDE4593GXSXF.log` |
| typecheck | `npx tsc --noEmit` | exit 0 | `gate-typecheck-01M63Y7WN74RYDCN3GTCVCXKM1.log` |
| build | `npm run build` | exit 0 | `gate-build-01M63Y7XX4YB8SAP8X0VTJFSTA.log` |
| test | `npm test` | exit 0 — 304 tests, 303 pass, 0 fail, 1 skip | `gate-test-01M63Y80R3N4VMNGGF9G5QJXP9.log` |

Logs in `$ORGASMIC_EVIDENCE_DIR` (run-01M63Y5RASQSMVGYK636HH8JXK). Counts match the fix
report's 304/303/1. The skip is the known pre-existing non-Linux local-file upload test. `npm ci`
reports the same 3 pre-existing advisories (1 low, 2 high); no lockfile or dependency change in
the round diff. No lint script is configured.

**Mutation sensitivity of the five fixes.** Eight mutations applied in a scratch copy of the
tree outside the worktree (`node_modules` symlinked, deleted afterwards; the tracked tree was
never touched — `git status --porcelain` empty before and after). Each mutation's application was
verified by diff line count, so none silently no-opped. Baseline there: 48 pass / 0 fail.

| review-2 finding | fixed at | mutation | result |
| --- | --- | --- | --- |
| MEDIUM-1 `type` unguarded at runtime | `tool-runtime.ts:715` | m1: drop `|| args.type === undefined` | 1 fail |
| MEDIUM-1 `type` unguarded in schema | `tools.ts:208` | m2: remove `required: ["type"]` | 1 fail |
| MEDIUM-1 (schema `anyOf`) | `tools.ts:209` | m8: drop the `reply_to` branch | 1 fail |
| MEDIUM-2 fallback too broad | `tool-runtime.ts:334` | m3: remove the `!hasSyntheticEmails` early return | 2 fail |
| MEDIUM-2 detection must agree with the id | `tool-runtime.ts:322` | m4: `startsWith("user")` instead of `user${r.id}@` | 1 fail |
| LOW-1 ambiguity guard untested | `tool-runtime.ts:337` | m5: `matches.length >= 1` | 1 fail (was 0 in round 1) |
| LOW-3 shared in-flight lookup | `tool-runtime.ts:1039` | m6: always start a new request | 2 fail |
| LOW-3 rejection must not poison the memo | `tool-runtime.ts:1045` | m7: drop the `.finally` reset | 1 fail |

LOW-2 (review 2) was docs-only and is satisfied at `README.md:320-321` ("An all-digit `to` is
always an ID, so digit-named streams must be addressed by ID"); the behaviour it describes is
still pinned by `test/toolRuntime.test.ts:507`.

**Scoped probe**, outside the tracked tree, `node --import tsx` against the real
`ZulipToolRuntime`: `probe-synthetic-and-memo.mts` / `.log` — cases A (no-email metadata),
B (false-positive collision), C (four detection shapes), D (directory outage on the reply
path), E (cross-call-site memo sharing, cache timestamping), F (rejection not cached, expired
cache not reused on a failed refresh).

**Scope and process.** Round diff touches only `README.md`, the changelog fragment,
`src/tool-runtime.ts`, `src/tools.ts`, `test/toolRuntime.test.ts`; no dependency, lockfile,
permission, CI, or generated-file change, and no new API scope (`GET /api/v1/users` was already
used by `find_user`/`send_dm`). `e5c4b4c` is an ancestor of HEAD, so the branch is still
upstream-first and independent of PRs #36/#37/#38. Three separate commits as the owner asked,
all authored and committed as Vasyl Dovhanchyn with the `GPT-6-Astra` co-author trailer. No
push, PR, merge, or outbound messaging. Acceptance criteria all still covered: stream reply,
1:1 and group DM reply, disagreement refusal, unknown/inaccessible id, and `reply_to` absent
unchanged (payload-exact at `test/toolRuntime.test.ts:414-429`, plus the unchanged real-client
loopback GET-before-POST test).

## Unmet Criteria / test gaps

None unmet. Remaining gaps, all LOW:

1. Directory outage on the `reply_to` path is untested (LOW-3).
2. No test for the `user<own id>@` collision that re-enables the fallback (LOW-1) — probe case
   B stands in; adding one would also pin the optional tighter check.
3. No test for recipient metadata lacking `email` (LOW-2) — probe case A stands in.
4. Carried over from reviews 1–2: no live-realm verification that Zulip accepts a `to`
   containing the bot's own id, nor that a numeric `to` is read as a channel id; both are
   covered only by the loopback wire-form test. The CI OS/Node matrix was not exercised locally.

## Residual Risk

- Email-based `to` is still an approximate cross-check wherever metadata is synthetic: it
  depends on realm directory state that is mutable and up to 60 s stale. Correctly narrowed and
  now documented (`README.md:325-329`); id-based `to` is exact. The fail-closed direction
  (false refusal) remains the common one.
- `members()` stamps `userCache.at` with the pre-request timestamp (`:1036`, `:1042`), so the
  effective TTL is 60 s minus request latency (probe E: offset 0 ms for a 150 ms request).
  Conservative, pre-existing, unchanged this round.
- An expired cache is not used as a fallback when the refresh fails (probe F) — the call rejects.
  Pre-existing and fail-closed.
- Under restricted `EMAIL_ADDRESS_VISIBILITY` the directory also returns synthetic addresses, so
  the fallback does not help there and matching stays fail-closed.
- Lookup and send remain two non-atomic requests: a topic move or deletion in between means the
  destination is the lookup's snapshot. Unavoidable at this layer.
- Schema-conformant callers must now always pass `type`, which is stricter than round 1 but
  matches base `e5c4b4c`; direct runtime callers can still omit it with `reply_to` (intentional,
  stated in the fix report).
- `npm ci`'s 3 pre-existing advisories are out of scope for this round.

## Fix Directions (ordered, all optional — none gate the push)

1. `src/tool-runtime.ts:337` — require the directory match's user id to belong to a participant
   whose metadata address is itself synthetic (LOW-1).
2. `test/toolRuntime.test.ts` — add the reply-path directory-outage case (LOW-3); it is the one
   behaviour here that is correct but unpinned.
3. `changelog.d/send-message-reply-to.added.md:3` — note that the tool schema requires `type`
   (LOW-4).
4. `src/tool-runtime.ts:331` — mention "no addresses in this conversation's metadata; use user
   IDs" in the conflict message when a recipient lacks `email` (LOW-2).
