# TASK-PXRSM — fix round 1

## Changed

Read `/srv/review-drop/TASK-PXRSM-REVIEW1.md` in full and reproduced the findings against the current source. Fixed both MEDIUM findings and, following the explicit scope expansion below, all three LOW findings.

### Scope-change message (quoted as requested)

Message `msg-b1cf9a19f7ed40cb9540fcdf7f39c08b`, received from member:tarn2 at 2026-10-29T13:24:51.296077280+00:00:

> Scope change from the project owner (pxrsm:lows:fold): in this same fix round, also fix the three LOW findings from review 1. 3) When `type` is absent and `reply_to` is given, take the type from the referenced message; give the disagreement error only for a real mismatch. 4) Build the DM reply channelId from dmCounterparts (bot excluded), keep `to: ids` as it is, and assert channelId in the DM reply tests. 5) Qualify the implicit-sender rule in README.md:320 and src/tools.ts:176, and add a test with selfUserId null on the DM path. Put the fixes in separate commits if that's easy, then run the full gates again. Please quote this message back in your report.

### Local commits

Two new commits on top of `8f3a8248a95b2352acd90850d045347d38ec826a`:

1. `353369031cfa7d326ed24574b5ff5b956e177866` — Fix reply destination ID matching and missing-destination guard.
   - Numeric strings compare as IDs for stream and DM destinations, rather than stream names/emails.
   - When a DM email does not match message metadata, resolve a uniquely matching visible email through the existing user directory and compare its user ID with the original participant set. The derived send destination never changes to the supplied email.
   - Refuse calls missing both `to` and `reply_to` locally, before lookups, uploads, sends, or sent-record callbacks.
   - Tests cover acceptance of `'12'`, `['42']`, `'42,7'`; mismatched numeric IDs; a numeric stream name that must not override ID interpretation; matching and nonmatching IDs behind real/synthetic emails; and absent-destination side effects.
2. `e8a1fe8265a8749b7c3716832f9b8a39788b5048` — Infer reply types and use canonical DM reply channel IDs.
   - Infer omitted reply type from the referenced message; preserve refusal of explicit mismatches.
   - Use `dmCounterparts` for DM sent-record channel IDs while keeping the full original `to` list, including the bot. Tests assert 1:1/group DM channel IDs and self-DM fallback.
   - Qualify the implicit-sender rule in README and tool schema; add null-selfUserId tests for omitted `to`, full participant sets, and refusal of incomplete sets.
   - Update schema, README example, and existing changelog fragment for the corrected behavior.

Both commits use author/committer **Vasyl Dovhanchyn <48733736+theaspirational@users.noreply.github.com>** and trailer **Co-Authored-By: GPT-6-Astra <noreply@openai.com>**. Worktree clean after final gates. No dependencies, permissions, lockfiles, or tracked generated files changed. Build output remains in the worktree's ignored build directory.

Round diff (`8f3a824..e8a1fe8`):

```text
 README.md                                |  17 ++--
 changelog.d/send-message-reply-to.added.md |   5 +-
 src/tool-runtime.ts                      |  30 ++++---
 src/tools.ts                             |  11 ++-
 test/toolRuntime.test.ts                 | 126 +++++++++++++++++++++++++++--
 5 files changed, 158 insertions(+), 31 deletions(-)
```

## Verification Gates

All commands below used `orgasmic dispatch gate <name> -- <command>`. Log paths are relative to this report's current evidence directory. No earlier-round gate receipt was reused.

### Red-before / development checks

| Gate | Command | Outcome | Log |
| --- | --- | --- | --- |
| review-medium-red | `node --import tsx --test --test-name-pattern 'send_message review' test/toolRuntime.test.ts` | Expected failure before fixes: 7 failed, 2 passed | `gate-review-medium-red-01M63XCCK57CZC13MPKGC4KDXN.log` |
| review-medium-green | `node --import tsx --test test/toolRuntime.test.ts` | 38 passed | `gate-review-medium-green-01M63XD08ZSQ4G2J8PP86JQWED.log` |
| review-low-red | `node --import tsx --test test/toolRuntime.test.ts` | Expected failure before LOW fixes: 5 failed, 37 passed | `gate-review-low-red-01M63XE7FC763Q4RQK7Q2FQ7YA.log` |
| review-low-green | `node --import tsx --test test/toolRuntime.test.ts` | 42 passed | `gate-review-low-green-01M63XFBHB5RTAHDV5MM5ED6CN.log` |
| review-typecheck-development | `npx tsc --noEmit` | Passed | `gate-review-typecheck-development-01M63XFBWSV9PQP8ZSB1T9T37B.log` |

### Final checks at clean commit e8a1fe8265a8749b7c3716832f9b8a39788b5048

| Gate | Command | Outcome | Log |
| --- | --- | --- | --- |
| typecheck | `npx tsc --noEmit` | Passed | `gate-typecheck-01M63XG2ERY7G6XWVK6NA40GYW.log` |
| build | `npm run build` | Passed | `gate-build-01M63XG3G05VA9RKAQKFNAJCRN.log` |
| test | `npm test` | 298 tests: 297 passed, 0 failed, 1 platform-specific skip | `gate-test-01M63XG4MR7040D1Y4X4S1VAJS.log` |
| diff-check | `git diff --check 8f3a8248a95b2352acd90850d045347d38ec826a HEAD` | Passed | `gate-diff-check-01M63XG8WBAVY30ZF5S9E7VHPW.log` |

The skip remains the existing non-Linux local-file test on Linux. No lint command is configured; the unchanged package scripts/CI use TypeScript checks and the build/test suite.

### Inherited evidence and unchanged scope

- Earlier repository/project instruction reads remain applicable: the supplied baseline and repository changelog/CI rules were not changed. No new convention/gotcha instructions were introduced.
- Dependency declarations, lockfile, build/test configuration, and permissions are unchanged. The existing installed dependencies were used; this round does not claim a new `npm ci` receipt or reuse an earlier verification pass.
- The original fake-client tests for derived destinations, conflict/error side effects, and exact ordinary-send parity remain in the suite. The real-client loopback GET-before-POST / error-no-POST test is unchanged and was rerun in both scoped and full-suite gates this round.
- Review assertions were treated as claims, not proof. The red-before gates above reproduced the defects using current source before their corresponding fixes.

## Unmet Criteria

None under the expanded scope. All five findings addressed. Local only: no push, PR creation, external chat messages, main-checkout edits, merge, or dispatch close.

## Residual Risk

- Real-email fallback can only resolve emails visible through the bot's existing user-directory access. If the real email is unavailable there too, matching remains fail-closed; callers can supply IDs or omit `to`. No new permissions are requested.
- Null bot identity still requires the full explicit participant set; this limitation is now documented and tested. Omitted `to` continues to work.
- Verified with fake-client tests and a real-client loopback HTTP probe, not a live Zulip realm. The remote OS/Node CI matrix was not run locally.
- Lookup and send remain separate requests; concurrent message moves/deletions after lookup are not atomic with sending.

## User-facing PR description

Improve reply destination validation: accept numeric-string IDs, resolve visible real emails against DM participant IDs, and reject missing destinations before side effects. Replies now infer their message type and record canonical DM conversation IDs. Documentation and regression tests cover these cases, including unavailable bot identity.

Validation: typecheck, build, and full test suite passed (297 passed; one platform-specific skip).
