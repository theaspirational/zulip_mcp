# TASK-PXRSM — final implementation report

## Changed

Squashed commit: **`0c36b6ff8e29dada02474f1ddebdbdea56078163`**

- Subject: **Add reply_to to send_message**.
- Direct parent: `e5c4b4c01c63c100f5671fef86f74b23c72bbdcb`.
- `git rev-list --count e5c4b4c01c63c100f5671fef86f74b23c72bbdcb..HEAD` returns **1**.
- Author and committer: **Vasyl Dovhanchyn <48733736+theaspirational@users.noreply.github.com>**.
- Trailer: **Co-Authored-By: GPT-6-Astra <noreply@openai.com>**.
- Neutral body: “Derive reply destinations from a message ID and reject conflicting destinations before uploading or sending. Document the behavior and cover stream and direct-message replies with regression tests.”
- Final worktree clean. No push, PR, external chat messages, main-checkout edits, merge, or dispatch close.

The complete change adds optional `reply_to` to `send_message`, fetching the referenced message to derive its stream/topic or full DM participants. Explicit destination conflicts and unreadable IDs refuse before uploads or sends. The schema requires `type`; direct runtime reply callers can still omit it. Existing valid non-reply sends retain their payload and behavior. Documentation, changelog, fake-client regressions, and a real-client loopback HTTP test accompany the implementation. No dependency, permission, lockfile, CI, or tracked generated-file changes.

### Final-round changes

Read the Findings in `/srv/review-drop/TASK-PXRSM-REVIEW3.md` in full and verified them against `3ff25b3e231ebd0d6ce3179c17bc91ee14aeb80d`.

1. Directory aliases are accepted only for a uniquely matched participant whose **own** metadata address looks synthetic. The new mixed-metadata test refuses an alias resolving to real-address participant 42, with no uploads or sends.
2. Missing recipient emails add a conflict hint to use user IDs. Tests verify the hint, no lookup/upload/send on refusal, and successful ID-based addressing.
3. Rejected directory lookups on replies are wrapped as `reply_to <id>: could not resolve "<email>" (user directory unavailable)`. Test verifies the exact message and no uploads/sends.
4. Changelog now distinguishes required schema `type` from direct runtime inference with `reply_to`.

README additionally records the synthetic-shape collision following the clarification below. Then the complete branch was squashed into the single commit above, as requested.

### Clarification of case B

The original brief asked for both a per-participant synthetic predicate and refusal of review case B. In that case, the matched participant 7 itself has `user7@...`, so the predicate cannot distinguish a genuine address from a synthetic one. Asked through `orgasmic dispatch ask`, ID `ask-ad514a0f4ee04babafc050f1b9f29e7d`, and received this answer before changing the predicate:

> Manager answer (Tarn's call): you're right, case B can't be told apart by shape. Implement the per-participant predicate, test refusal when the fallback resolves to a real-address participant (42), and document the collision in README next to the synthetic-email note: a genuine address shaped user<own id>@ is treated as synthetic, and id-based `to` is the only exact cross-check. Don't add a domain or realm-host rule. Mention this in the report.

Implemented exactly that clarification; no domain/realm-host rule was added. The original synthetic-shaped-address collision remains documented rather than falsely claimed fixed.

### Final diff stat against upstream base

```text
 README.md                                |  34 +++
 changelog.d/send-message-reply-to.added.md |   9 +
 src/tool-runtime.ts                      | 100 ++++++-
 src/tools.ts                             |  23 +-
 test/toolRuntime.test.ts                  | 428 ++++++++++++++++++++++++++++-
 5 files changed, 579 insertions(+), 15 deletions(-)
```

## Verification Gates

Every command below ran through `orgasmic dispatch gate <name> -- <command>`. Logs are relative to this report's evidence directory. Build artifacts remain in the worktree's ignored build directory, not evidence.

### Red-before / scoped checks

- `diagnostics-red`: `node --import tsx --test --test-name-pattern 'suggests user IDs|wraps directory outages' test/toolRuntime.test.ts` — expected failure, **2 failed** before fixes. Log: `gate-diagnostics-red-01M63YND51MC5EMZ7KTYPS92BY.log`.
- `mixed-metadata-red`: `node --import tsx --test --test-name-pattern 'real-address participant in mixed metadata' test/toolRuntime.test.ts` — expected failure, **1 failed** before the per-participant restriction. Log: `gate-mixed-metadata-red-01M63YPDZPHMAF34TMHS1DW0W0.log`.
- `runtime-green`: `node --import tsx --test test/toolRuntime.test.ts` — **51 passed**. Log: `gate-runtime-green-01M63YPE8239YZPXRT4RSX43TN.log`.

### Final gates at clean squashed commit 0c36b6ff8e29dada02474f1ddebdbdea56078163

| Gate | Command | Result | Log |
| --- | --- | --- | --- |
| install | `npm ci` | Passed, including prepare/build | `gate-install-01M63YPXRY895BTX3DKRY54VCR.log` |
| typecheck | `npx tsc --noEmit` | Passed | `gate-typecheck-01M63YPZQB9TJS7ZJ6EF5EXEQ9.log` |
| build | `npm run build` | Passed | `gate-build-01M63YQ0RHKYRB6NY4X2STK4Y4.log` |
| test | `npm test` | **307 tests: 306 passed, 0 failed, 1 skipped** | `gate-test-01M63YQ1X6FWZTG0E36Q1H1XT0.log` |
| diff-check | `git diff --check e5c4b4c01c63c100f5671fef86f74b23c72bbdcb HEAD` | Passed | `gate-diff-check-01M63YQ9RQ9JKMACBE1A5ANTQC.log` |

The skip is the pre-existing non-Linux local-file test on Linux. No lint command is configured.

### Inherited evidence

No earlier-round receipt or passing gate was reused. The unchanged project baseline/instructions, changelog rules, dependency declarations, lockfile, and CI configuration remain applicable. Existing regression tests and the unchanged real-client loopback GET-before-POST/error-no-POST test were inherited as test code, then rerun in this round's scoped and full-suite gates. Earlier findings were treated as claims; the red-before checks above reproduce the defects against current source before the corresponding edits.

## Unmet Criteria

None under the clarified final-round contract. The branch contains exactly one local commit directly on the specified upstream base, with the requested message, author/committer, and trailer. All assigned final gates passed on that squashed commit.

## Residual Risk

- A genuine `user<own id>@...` address is indistinguishable from synthetic metadata by shape. This is documented, per clarification. ID-based `to` is the only exact cross-check; emails and the existing 60-second directory cache can change or become stale.
- Directory matching remains fail-closed when existing permissions do not expose the supplied real email. No new permissions are requested.
- Message lookup and send are separate, non-atomic requests. Concurrent moves/deletions can occur after the destination snapshot is read.
- Verification uses fake clients and a real-client loopback HTTP probe, not a live realm; the remote OS/Node CI matrix was not run locally.
- `npm ci` reports the existing three dependency advisories (one low, two high). Dependency remediation is outside scope.

## Final user-facing PR

### Title

Add reply_to to send_message

### Body

Add an optional `reply_to` message ID so replies use the referenced message's stream/topic or complete DM conversation. `to` and `topic` can be omitted; conflicting destinations and unreadable message IDs are rejected before uploads or sends.

Includes documentation and regression tests for stream, 1:1 DM, and group DM replies, destination checks, lookup failures, and unchanged valid non-reply sends. No additional permissions are required.

Validation: `npm ci`, TypeScript typecheck, build, and the full test suite passed (306 passed; one platform-specific skip).
