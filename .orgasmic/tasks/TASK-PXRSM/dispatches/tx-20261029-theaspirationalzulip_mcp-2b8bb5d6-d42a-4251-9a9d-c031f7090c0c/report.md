# TASK-PXRSM — fix round 2

## Changed

Read `/srv/review-drop/TASK-PXRSM-REVIEW2.md` in full. Addressed MEDIUM-1, MEDIUM-2, and LOW-1/2/3 in three small local commits on `e8a1fe8265a8749b7c3716832f9b8a39788b5048`:

1. `78ffb5f550fdae1b60865c74efa5cbfd367465be` — Restore required message type and enforce ordinary-send inputs locally.
   - Restore schema `required: ["type"]`; `anyOf` requires either `to` or `reply_to`.
   - Without `reply_to`, missing `type` or `to` refuses before lookup/upload/send. Test includes missing type with a destination, each missing-destination variant, and empty arguments with content/files.
   - Align README example and schema description with the required type. Existing runtime inference for direct callers omitting type on replies remains intact, as does explicit mismatch refusal.
2. `952b9aa0ff05c1dade18c21e30b9fdbadf8bc8dc` — Restrict reply email fallback to synthetic recipient metadata.
   - Only allow directory fallback when at least one fetched participant email looks synthetic: local part `user<ID>` agrees with that participant's ID. Otherwise compare directly by email/ID and refuse mismatches without a user-directory request.
   - Tests cover real-email matches, mismatches that a stale directory could otherwise satisfy, unrelated numeric local parts, existing synthetic-email acceptance/nonparticipant refusal, and two members sharing one email (refusal, no sends/uploads).
   - README states that ID-based `to` is the only exact cross-check, email mappings can be mutable/stale, and digit-named streams must be addressed by ID because all-digit `to` is always an ID.
3. `3ff25b3e231ebd0d6ce3179c17bc91ee14aeb80d` — Share in-flight user directory lookups across reply recipients.
   - Memoise the pending `members()` promise while retaining the resolved cache's 60-second lifetime. Clear pending state after success or failure so rejected requests can retry.
   - Tests demonstrate three concurrent email misses cause one GET /users, subsequent sends reuse the resolved cache, and failed concurrent lookups share one request then retry successfully.
   - Update the existing changelog fragment.

Author and committer on all three: **Vasyl Dovhanchyn <48733736+theaspirational@users.noreply.github.com>**. Trailer on all three: **Co-Authored-By: GPT-6-Astra <noreply@openai.com>**.

The synthetic-address shape was checked against the [official Zulip user-resolution source](https://github.com/zulip/zulip/blob/main/zerver/lib/users.py). Detection is deliberately shape-based rather than an assertion about actual address ownership.

Round diff (`e8a1fe8..3ff25b3`):

```text
 README.md                                | 20 ++++---
 changelog.d/send-message-reply-to.added.md |  4 +-
 src/tool-runtime.ts                      | 19 +++++--
 src/tools.ts                             |  7 +--
 test/toolRuntime.test.ts                  | 86 +++++++++++++++++++++++++++---
 5 files changed, 114 insertions(+), 22 deletions(-)
```

No dependency, lockfile, permission, CI, or tracked generated-file changes. Build output stays in the ignored worktree build directory. Final worktree clean.

## Verification Gates

All checks used `orgasmic dispatch gate <name> -- <command>`. Logs below are relative to this report's evidence directory. No earlier-round gate pass or receipt was reused.

### Red-before and scoped checks

| Gate | Command | Result | Log |
| --- | --- | --- | --- |
| type-guard-red | `node --import tsx --test --test-name-pattern 'schema requires type\|refuses a missing destination' test/toolRuntime.test.ts` | Expected failure: 2 failed (schema and old error wording) | `gate-type-guard-red-01M63XYFHERCPHK0XX6172ZN3C.log` |
| missing-type-red | `node --import tsx --test --test-name-pattern 'refuses a missing destination' test/toolRuntime.test.ts` | Expected failure after putting missing-type case first: missing expected rejection | `gate-missing-type-red-01M63XYRQNGK5MBCP9KAABS8V7.log` |
| type-guard-green | `node --import tsx --test --test-name-pattern 'schema requires type\|refuses a missing destination' test/toolRuntime.test.ts` | 2 passed | `gate-type-guard-green-01M63XZBF667JKJ0ZBB00EHVCQ.log` |
| email-fallback-red | `node --import tsx --test --test-name-pattern 'email fallback\|synthetic recipient' test/toolRuntime.test.ts` | Expected failure: 2 failed, 4 passed | `gate-email-fallback-red-01M63Y06HS010G4SAQ6N7GGRXN.log` |
| email-fallback-green | Same email-fallback command | 6 passed | `gate-email-fallback-green-01M63Y0VVXDPV5H87VGAV0Q1J5.log` |
| directory-cache-red | `node --import tsx --test --test-name-pattern 'directory lookup' test/toolRuntime.test.ts` | Expected failure: 2 failed; observed 3 GETs instead of 1 and 2 failed concurrent GETs instead of 1 | `gate-directory-cache-red-01M63Y23PPRMJR4E3W6S3PVSK0.log` |
| directory-cache-green | `node --import tsx --test test/toolRuntime.test.ts` | 48 passed | `gate-directory-cache-green-01M63Y2M97H8FT3CD4Y0352XEX.log` |

In the command cells above, `\|` is Markdown table escaping; the actual regex argv contains plain `|`.

### Final gates at clean commit 3ff25b3e231ebd0d6ce3179c17bc91ee14aeb80d

| Gate | Command | Result | Log |
| --- | --- | --- | --- |
| install | `npm ci` | Passed, including prepare/build | `gate-install-01M63Y2MN4NCYDSRQN4Z2NSFSQ.log` |
| typecheck | `npx tsc --noEmit` | Passed | `gate-typecheck-01M63Y2PRFBB1R0ZMYDZ421TFQ.log` |
| build | `npm run build` | Passed | `gate-build-01M63Y2QSPD3ARYQQS196CFHRG.log` |
| test | `npm test` | 304 tests: 303 passed, 0 failed, 1 platform-specific skip | `gate-test-01M63Y2RTKYED3A90SKNSKWQKW.log` |
| diff-check | `git diff --check e8a1fe8265a8749b7c3716832f9b8a39788b5048 HEAD` | Passed | `gate-diff-check-01M63Y2Y8PM1R0TYAA2FTMSF8T.log` |

The one skip is the existing non-Linux local-file test, skipped on Linux. No lint script is configured.

### Inherited evidence and unchanged scope

- Previously read baseline/project instructions, changelog rules, and CI configuration are unchanged and remain applicable.
- Dependency/permission declarations and lockfile are unchanged; nevertheless `npm ci` and every assigned gate were rerun at the reported final commit.
- Original destination, no-reply payload parity, API error, canonical DM channel, and null-identity regression tests remain in the suite. The unchanged real-client loopback GET-before-POST/error-no-POST probe was rerun in scoped and full-suite gates; no earlier pass is substituted for current verification.
- Re-review findings were treated as claims and checked against current source. The red-before checks reproduce the missing-type guard, overbroad email fallback, and duplicated lookup behavior before their corresponding fixes.

## Unmet Criteria

None. All five requested findings are addressed. Local only: no push, PR, external chat, main-checkout edit, merge, or dispatch close.

## Residual Risk

- Synthetic-email recognition uses the conventional `user<ID>@...` shape. A real address with that same shape is indistinguishable from metadata alone. ID-based `to` remains the only exact cross-check, now documented.
- For synthetic metadata, email matching still depends on mutable directory state and its existing 60-second cache; the send destination itself always remains the referenced message's original participant IDs. If the real email is unavailable through existing permissions, matching fails closed.
- The required schema type and runtime reply-type inference intentionally coexist per the brief: schema-valid callers supply type; direct runtime callers can still omit it with `reply_to`.
- Lookup and send are separate requests, so concurrent message moves/deletions remain non-atomic. No live-realm test or remote OS/Node matrix was run.
- `npm ci` reports the existing 3 dependency vulnerabilities (1 low, 2 high). Dependencies were not changed; remediation is outside this round.

## User-facing PR description

Strengthen reply destination validation by enforcing ordinary-send inputs locally and limiting email-directory fallback to synthetic recipient metadata. Add ambiguous-email regression coverage, share concurrent directory lookups, and document exact ID matching and numeric stream-name behavior.

Validation: clean install, typecheck, build, and full suite passed (303 passed, one platform-specific skip).
