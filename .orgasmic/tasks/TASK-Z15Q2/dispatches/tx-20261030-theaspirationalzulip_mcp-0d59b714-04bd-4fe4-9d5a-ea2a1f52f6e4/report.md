# Review — TASK-Z15Q2, `chat:from-self` on own Zulip message events

Commit reviewed: `678956b8a44b6d48c00c970e63bfa45d7e038dd1` (parent `e5c4b4c01c63c100f5671fef86f74b23c72bbdcb`).
Upstream `antra-tess/zulip_mcp` main re-checked during this review: `git ls-remote` → `e5c4b4c01c63c100f5671fef86f74b23c72bbdcb`. The PR body's claim that upstream main is unmoved is accurate.

## Verdict

**Approve.** No HIGH findings. Self-identification is correct and false-positive-free, existing suppression is byte-for-byte preserved, the emission-path audit table is accurate, and the tests genuinely exercise the acceptance criterion — all eight behaviour mutations I injected were caught. Two MEDIUM findings are quality/robustness issues worth fixing before or during upstream review; neither blocks ship.

## Findings

### MEDIUM — the email fallback silently no-ops in realistic deployments of exactly the shape it targets
`src/history.ts:337`, `src/zulip-client.ts:95`

`isSelfSender` compares with raw `===`. No case folding, no trim, no `delivery_email` alternative. When `selfUserId` is `null` — the only situation where the fallback is ever consulted — `selfEmail` is `profile.email` if the profile responded without a `user_id`, otherwise the operator-supplied login email from `ZULIP_USERNAME`/`ZULIP_EMAIL`/zuliprc.

Reproduced (`probe-email-fallback-edges.log`, direct call against `src/history.ts`):

```
true  | exact match
false | config email mixed case          (selfEmail 'Bot@Example.com' vs sender 'bot@example.com')
false | sender email mixed case
false | trailing whitespace cfg          ('bot@example.com ' from a zuliprc line)
false | restricted-visibility            (sender_email 'user790@realm.zulipchat.com')
```

Failure scenario: the profile fetch fails (the diagnosed cause of the reported echo wakes), the operator's zuliprc/env email differs from the realm's stored `sender_email` by case or a trailing space, **or** the realm restricts email address visibility so message `sender_email` is the synthetic `user{id}@realm` form while the login email is the delivery address. The connector emits no `chat:from-self`, the host's `tagsNone` rule matches nothing, and the own-post wakes continue — with no log line saying identity could not be established. The whole purpose of the change is silently unmet and the operator has no signal.

Every failure mode is fail-*closed* (a missed tag, never a wrong one), so this is robustness, not correctness. Fix direction: normalize both sides with `.trim().toLowerCase()`; also compare against `profile.delivery_email` when present; and emit one `console.error` at startup when neither a numeric `user_id` nor a usable `selfEmail` was obtained, so a silently unidentifiable deployment is visible in the log.

### MEDIUM — reusing `onOwnMessage` for tagging also widens the open-channel change-delivery gate
`src/platforms/zulip.ts:457`, `src/platforms/zulip.ts:499`, consumed at `src/server.ts:1715`

The two change-event sites changed from `self !== null && authorId === self` to `isSelfSender(...)`. `onOwnMessage` is not only metadata — `src/server.ts:1715` uses it as a delivery gate:

```ts
if (open && !addressed && !ev.onOwnMessage) {
  // require the target id to be at/below the watermark, or held
}
```

That bypass is pre-existing and deliberate ("one the bot wrote is delivered too", `src/server.ts:1172`), and the existing test exercises it: `test/server.test.ts:2146` delivers a `delete` of message `12` on an open channel although only `10` was ever accepted, solely because `onOwnMessage: true`.

Failure scenario: profile lookup fails, email fallback matches. An ambient edit/move/deletion of a bot message the host never accepted (posted while the channel was closed or muted, or whose delivery was refused and whose hold has been released) now bypasses the watermark/held check and is delivered, where at the parent commit it was dropped. In a task whose purpose is *removing* own-echo wakes this adds a narrow new source of them. It is tagged `chat:from-self`, so a host with `tagsNone: ["chat:from-self"]` filters it — but the widening is undisclosed in the implementer report, the audit table, the PR body and the README, and no test covers the `!addressed` + `onOwnMessage`-via-email combination (`test/server.test.ts:2270` passes `mentioned: true`, so it takes the `addressed` path).

Fix direction: either keep the gate on the ID-only predicate and derive the tag from a separate `authorIsSelf` field, or disclose the widening in the PR body and add a test for an ambient, never-accepted, email-identified own change on an open channel.

### LOW — the root cause (identity never re-acquired) is left in place
`src/zulip-client.ts:93-104`

The profile is fetched once; failure or a response without numeric `user_id` leaves `selfUserId = null` for the adapter's lifetime, and neither queue re-registration nor a host reconnect retries it. The implementer identified and documented this honestly and scoped it out, and the email fallback is a reasonable mitigation — but combined with MEDIUM-1 the deployment can end up with neither identification path working and no recovery. Fix direction (separate change): retry the profile lookup on queue re-registration, or lazily on the first unidentified own-looking event.

### LOW — raw string literals where the shared constant exists
`src/history.ts:348`, `src/server.ts:1220`, `src/server.ts:1669`, `src/server.ts:1768`

`@animalabs/mcpl-core` already exports `CHAT_TAGS.fromSelf === 'chat:from-self'` (`node_modules/@animalabs/mcpl-core/dist/src/tags.d.ts`), and every adjacent tag in all four of these expressions is written as `CHAT_TAGS.*`. The four hand-written literals are the only ones in the emission paths, so a typo in any of them would not be a type error. Fix direction: use `CHAT_TAGS.fromSelf`.

### LOW — commit subject does not follow the repo's Conventional Commits convention
`678956b`

The subject is `Tag own Zulip message events with chat:from-self`. The last 30 non-merge commits on `e5c4b4c` are uniformly prefixed (`feat:`, `fix:`, `test:`, `docs:`, `fix(review):`), and the comparable feature commits are `feat: declare MCPL RFC-008 tool classes`, `feat: deliver message edits, topic moves and deletions to the agent (#22)`. For an upstream PR this should read `feat: tag own Zulip message events with chat:from-self`. The changelog fragment name `changelog.d/own-message-tags.added.md` does match `scripts/release-changelog.mjs`'s required `<slug>.<breaking|added|changed|fixed>.md` form, and the author/committer identity and the model co-author trailer match the repo's established pattern.

## Brief items, answered

1. **Self-identification correctness.** Correct. `src/history.ts:333-338` returns on the numeric-ID branch whenever `selfUserId` is a finite number, so an email match can never override or supplement a known ID; `Number.isFinite` admits `0` (verified: `selfUserId: 0` with sender `0` → true, with sender `7` → false) and sends `NaN` down the email branch. No false positives found: other users, other bots, an absent sender ID, an empty/undefined sender email, and an empty `selfEmail` all return false (`probe-email-fallback-edges.log`). A moderator editing an own message is tagged by the **original author**, not the actor (`src/platforms/zulip.ts:457/499`; `test/zulipAdapter.test.ts` asserts `['edit','50',true]` for `user_id: 7` editing author `790`) — that is deliberate and is documented in README "Own-message tags", including the consequence that `tagsNone: ["chat:from-self"]` also hides another user's edit of the bot's message. Reactions use the **reactor** (`src/platforms/zulip.ts:853`), so someone else reacting to an own message yields `fromSelf: false, onOwnMessage: true` — asserted directly as `['add', false, true]`. Email-fallback safety: see MEDIUM-1 — safe (no false positives) but brittle.
2. **Audit table accuracy.** Accurate, and I found no missed emission path. `grep -rn "tags:" src/` returns exactly six tag-producing sites: `src/history.ts:386` (shared converter, now identity-aware; all three callers at `src/platforms/zulip.ts:776/872/888` pass the single `this.identity`), `src/server.ts:1035` (recovered replay, preserves incoming tags), `src/server.ts:1083` (`pushEvent` passthrough), and the three new sites. `grep -rn "IncomingChannelMessage = {"` and `grep -n "author: {"` confirm no other author-bearing message is constructed; `src/channels.ts:538` is an untagged system connection notice. **Existing suppression is preserved exactly**: every suppression site still reads `selfUserId !== null && …` — `src/platforms/zulip.ts:368` (change actor), `:388`, `:716`, `:774` (history filter), `:839` (own reaction), `:865` (live message), and `changeAllowed` at `:368`. The diff touches none of them.
3. **Startup changes.** No behaviour change for a deployment whose profile succeeds: `selfEmail` is populated but `isSelfSender` returns on the ID branch before reading it. No new network call — `profile.email` is read from the response of the pre-existing `client.users.me.getProfile()`; `test/zulipClient.test.ts` asserts `profileCalls === 1`. No new failure mode: the `profile?.email` read is inside the existing try/catch and guarded by a `typeof` check, and `selfEmail` degrades to `''` (harmless, length-guarded) when no email is resolvable.
4. **Aggregate missed-block tagging.** Correct. `src/server.ts:1220` requires `kept.every((m) => m.fromSelf)`, over `kept` (the selected subset) rather than `views`, and `kept.length === 0` returns earlier so `every` cannot vacuously pass. `selectMissed` (`src/delivery.ts:380`) is generic and returns the same object references, so the `fromSelf` property spread in at `src/server.ts:1191` survives selection — confirmed by mutation M3.
5. **Tests are real.** Verified by injecting eight behaviour mutations into the production source and re-running the five relevant test files; every one failed, and the tree was restored to clean after each (`git status --porcelain` empty at the end). Baseline 102/102 pass (`probe-m0-baseline.log`).

   | Mutation | Result | Tests that caught it |
   |---|---|---|
   | M1 email fallback branch → `return false` | 5 fail | `from-self: email fallback`; adapter `identity null`; both `bootstrap` email cases |
   | M2 `tagsFor` never pushes the tag | 6 fail | `own stream`, `own DM`, `email fallback`, adapter, both bootstrap |
   | M3 `kept.every` → `kept.some` | 1 fail | `closed missed block with other authors is not self` |
   | M4 email checked before ID | 2 fail | `id wins over matching email`, `missing sender id cannot override known identity id` |
   | M5 reaction `fromSelf` uses target author | 2 fail | `changes use message authors, reactions use actors` (both identities) |
   | M6 change-marker tag removed | 2 fail | existing `#22` visibility test + `edit, move and deletion markers` |
   | M7 reaction tag removed | 1 fail | `reactions surface only on channels opted in…` |
   | M8 ontology declaration removed | 1 fail | `the tag ontology declares chat:from-self exactly once` |

   Fixture changes are legitimate. The DM narrow parser fix (`test/zulipAdapter.test.ts:47-49`) matches production: `narrowFor` at `src/history.ts:161` emits the object form `{ operator: 'dm', operand: ids }` for DMs and the tuple form for stream/topic. The old fixture's `n[0] === 'dm'` never matched, so DM queries fell through to `return true` and returned every row including stream rows — the fixture was wrong, and the fix makes it stricter, not laxer. The `orig_content` additions are required by production: `src/platforms/zulip-events.ts:403` gates `contentChanged` on `typeof event.orig_content === 'string'`, and Zulip sends that field only on a content edit. No existing test assertion was relaxed to accommodate either change (the only pre-existing assertion edited is `test/server.test.ts:2149`, which gains the new tag).
6. **PR body.** Accurate on every checkable claim: the ID-authoritative/email-fallback split, suppression and `chat:from-bot` preservation, mixed-author blocks, reactor-based reaction classification, the head counts (289 tests / 288 pass / 1 skip — matches `gate-head-node-22-23-3`), both Node versions, and the unchanged upstream SHA. No internal names, task IDs, manager names or orgasmic references leak into it. Its only gap is the undisclosed delivery-gate widening (MEDIUM-2). Identity and trailer match the repository's pattern; the subject prefix does not (LOW).

## Verification Gates

**Reused receipt** (eligible per the gate-receipts rules: this exact commit, clean tree at start and end, exit 0, in the implementer's assigned checkout):

- `head-node-22-23-3` — exit 0 — `node --version && npm ci && npm run build && npm test` under `XDG_RUNTIME_DIR=/run/user/1002 systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0`, Node 22.23.3 (log line 3: `v22.23.3`) — log `/home/orgasmic/.orgasmic/runs/run-01M66HEMB8CCCKYAM5Q76BCG9S/evidence/gate-head-node-22-23-3-01M66HW7BKBCJP0EY4P4JF3GD6.log`, tail: `# tests 289 / # pass 288 / # fail 0 / # skipped 1`, `exited:0; HEAD 678956b8… clean=yes`. This is the gate the brief assigns me, already satisfied at this commit, so I read the log instead of rerunning it.
- `head-node-22-12-0` — exit 0 — same command on Node 22.12.0 — log `…/gate-head-node-22-12-0-01M66HX0FBGTVVYCGAMME4093J.log`.

**Scoped probes I ran** (unwrapped — a mutated tree cannot produce a reusable receipt; artifacts in this evidence directory). Node 22.23.3 from `/opt/node/bin`, each under `XDG_RUNTIME_DIR=/run/user/1002 systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0`:

- `node --import tsx --test test/history.test.ts test/zulipAdapter.test.ts test/manifest.test.ts test/server.test.ts test/zulipClient.test.ts` — exit 0, 102/102 — `probe-m0-baseline.log`.
- The same command under each of the eight mutations M1–M8 — all exit 1 — `probe-m1-…` through `probe-m8-….log`.
- Direct `isSelfSender` edge-case probe against `src/history.ts` — `probe-email-fallback-edges.log`.
- `git ls-remote https://github.com/antra-tess/zulip_mcp refs/heads/main` → `e5c4b4c01c63c100f5671fef86f74b23c72bbdcb`.

No commits, edits or new tracked files were left behind; `git status --porcelain` is empty. All probe artifacts are in `$ORGASMIC_EVIDENCE_DIR`.

## Unmet criteria / test gaps

Acceptance criteria are met: the tag appears on own stream and DM messages (`test/history.test.ts` `own stream` / `own DM`, `test/zulipAdapter.test.ts` live and history matrix for both identity states), never on others (other human, other bot, unknown identity, unknown sender, ID-wins-over-email, session-ID-is-not-identity), and it is declared in the feature set (`test/manifest.test.ts`). Gates pass on two Node versions. Opus review is this dispatch.

Remaining gaps:

- No test for an ambient, never-accepted, email-identified own change on an **open** channel — the exact combination MEDIUM-2 widens. `test/server.test.ts:2270` takes the `addressed` path.
- No test pins the email comparison's normalization behaviour either way, so MEDIUM-1 is neither asserted nor forbidden; a future lowercase fix has no failing test to drive it.
- `src/server.ts:1191`'s `fromSelf` is derived by re-parsing the tag string out of an already-converted message rather than carrying a field, and no test covers a history row whose `tags` is `undefined` (handled correctly by `m.tags?.includes(...) === true`, but only by inspection).
- `test/server.test.ts:2229` asserts backscroll preservation with `JSON.stringify(opened).includes('chat:from-self')`, which would also pass if the tag appeared anywhere in the response. The per-message assertion exists in `test/zulipAdapter.test.ts`, so the criterion is covered; the wire-level assertion itself is weak.
- No live Zulip realm and no live host wake policy were exercised, here or by the implementer. Behaviour against a realm with restricted email address visibility — the configuration that defeats the email fallback (MEDIUM-1) — is untested in any form.

## Residual risk

- The headline motivation (114/156 wakes from own echoes) is addressed only if the host adds `tagsNone: ["chat:from-self"]` *and* the connector can identify itself. If the deployment's profile lookup fails for a reason that also defeats the email fallback (MEDIUM-1), nothing changes and nothing says so. Confirming the reported deployment's `Failed to fetch bot profile for self-filter` log line and its realm's email-visibility setting is the cheapest way to retire this risk before the follow-up host change lands.
- Mixed-author catch-up blocks stay untagged by design, so own text still rides along in a block another author's message triggered. Correct choice; it just means the wake reduction is incomplete for closed-channel catch-up.
- `npm ci` reports the same pre-existing 3 vulnerabilities (1 low, 2 high) on base and head; the lockfile is untouched. Out of scope, unchanged by this commit.
- Tagging own messages makes them newly filterable but also newly distinguishable in any host that logs or displays tags; no credential or content exposure is introduced.

## Fix directions

1. (MEDIUM-1) In `src/history.ts:333`, compare normalized emails — `const norm = (e: string) => e.trim().toLowerCase()` — and in `src/zulip-client.ts:98` also accept `profile.delivery_email`. Add a startup `console.error` when neither a numeric `user_id` nor a non-empty `selfEmail` was resolved. Pin the behaviour with a mixed-case case in the existing `test/history.test.ts` table.
2. (MEDIUM-2) Either split the concerns — keep `src/server.ts:1715`'s gate on an ID-only predicate and add a separate `authorIsSelf` field for the tag — or accept the widening, say so in the PR body, and add the missing ambient/open/never-accepted test.
3. (LOW) Replace the four `'chat:from-self'` literals with `CHAT_TAGS.fromSelf`.
4. (LOW) Reword the commit subject to `feat: tag own Zulip message events with chat:from-self` before pushing, matching the repo's Conventional Commits history.
5. (LOW, separate change) Retry the profile lookup on queue re-registration so a transient startup failure does not disable ID-based identification for the process's lifetime.
