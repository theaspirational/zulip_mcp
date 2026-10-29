# Changed

- Read `/srv/review-drop/TASK-WDCGX-REVIEW1.md` and implemented all four requested fixes.
- Head: `0c31d9d9cde7ef6de128f7992987dafdee4ac35e` on `edit-message-topic-moves`.
- Amended `fb9cc23184d66597d6517939c03695e666472b0a`; still exactly **one separable commit** above `369959c58913d87b307a0b37342fa5bd810b583d` (`git rev-list --count` = 1).
- Author/committer: `orgasmic worker (devbox) <orgasmic@devbox>`.
- The resumed worktree initially pointed at the original base on `task-wdcgx-impl`; switched back to the existing implementation branch before editing. No main-checkout or ledger writes.
- `message_id` is validated first.
- `content` + `stream_id` is rejected before HTTP, including empty content, with: `a stream move cannot be combined with a content edit; send two calls`. The description states this restriction. Content + topic remains supported and tested.
- Explicit `propagate_mode` requires `topic` or `stream_id`, including `change_one`, as requested by the narrowed brief. Content-only edits must omit propagation.
- Descriptions now explain Zulip's `change_one` default (this message only), `change_later` (this and later messages in the same topic), and `change_all` (rename/move the whole topic). Omitted propagation is still omitted from the request and schema defaults.
- Replaced the two misleading successful content+stream encoding cases with local rejection coverage. Added tests for content-only propagation, validation order, and description semantics.
- No notification parameters exposed. Content-only request encoding and #36 error handling remain unchanged; no permission logic added.
- Retained optional parameters rather than adding `move_topic`: the endpoint and validation are shared, and content+topic remains a valid combined operation.

Diff stat against original base:

```text
 changelog.d/edit-message-topic-moves.added.md |   1 +
 src/tool-runtime.ts                         |  24 +++-
 src/tools.ts                                |  18 ++-
 test/editMessage.test.ts                    | 153 +++++++++++++++++++++++++-
 4 files changed, 189 insertions(+), 7 deletions(-)
```

This round changed three existing files; the original changelog fragment remains. No dependency, lockfile, or generated-file changes. Working tree clean; `git diff --check HEAD^ HEAD` passed.

# Verification Gates

Node version verified: `/opt/node/bin/node --version` → `v22.23.3`.
All checks below ran through `orgasmic dispatch gate <name> -- <command>` in this round. Log names are relative to this report's directory.

| Gate | Command | Outcome | Log |
| --- | --- | --- | --- |
| fix-red | `env PATH=/opt/node/bin:$PATH node --import tsx --test test/editMessage.test.ts` | Expected failure before fixes: 24 pass, 4 fail | `gate-fix-red-01M6397GX7D2NGRDDEJ112AWM1.log` |
| fix-green | `env PATH=/opt/node/bin:$PATH node --import tsx --test test/editMessage.test.ts` | 28 pass, 0 fail | `gate-fix-green-01M6397W6N8AF5J9ZWEYRT9A0A.log` |
| fix-install | `env PATH=/opt/node/bin:$PATH npm ci --ignore-scripts` | Pass, clean amended head | `gate-fix-install-01M63984RA6C2DN07BPMD4DJB0.log` |
| fix-build | `env PATH=/opt/node/bin:$PATH npm run build` (tsc) | Pass, clean amended head | `gate-fix-build-01M63985K52C96YP88GEWJPMFW.log` |
| fix-test | `env PATH=/opt/node/bin:$PATH npm test` | 317 tests: 316 pass, 0 fail, 1 skip; clean amended head | `gate-fix-test-01M6398G39TKQ4A7A5ERXV1EZ7.log` |
| fix-cherry-pick | `bash "$ORGASMIC_EVIDENCE_DIR/cherry-pick-probe.sh"` | Pass, expected results asserted for both targets | `gate-fix-cherry-pick-01M6398Y0CSK32E84E8P45NYYB.log` |

Red/green tests intentionally ran on a dirty tree. Required final gates were rerun at the amended clean commit; no earlier receipt is claimed as a current-head gate pass. The tests exercise the production runtime against a loopback HTTP fixture; no live Zulip network calls or push.

## Inherited evidence and scope

The historical base count is inherited from the unchanged base commit `369959c58913d87b307a0b37342fa5bd810b583d`, not reused as proof of current-head correctness. Its original log was reread:
`/home/orgasmic/.orgasmic/runs/run-01M638MMSBD8VTDEYE5WMKEHQC/evidence/gate-base-test-01M638NRR17K2QMW4AHPGDADEQ.log`.

- Original base: 297 total, 296 pass, 0 fail, 1 skip.
- Reviewed pre-fix commit: 315 total, 314 pass, 0 fail, 1 skip (historical round-one measurement).
- Amended head, freshly verified: 317 total, 316 pass, 0 fail, 1 skip.
- Net increase over base: 20 tests. The skip remains the platform-specific non-Linux upload guard on Linux.

Prior review findings informed the requested changes; current source/tests and fresh gates establish the fixes. Prior skill/project instruction reads remain applicable; no new convention or gotcha references were supplied.

## Scratch cherry-pick probes

The evidence script runs `git cherry-pick --no-commit` with the amended head in detached scratch worktrees and removes them afterward.

- Onto `fafaeef8664c5765dbc7e6863b26f6911c1ac900` (upstream + #36, no #37): exit 0, **clean**; staged diff whitespace check also passed.
- Onto bare upstream `e5c4b4c01c63c100f5671fef86f74b23c72bbdcb`: expected exit 1, **not clean**. Content conflict in `src/tool-runtime.ts` (old zulip-js update call versus #36's direct PATCH/validation path), plus modify/delete conflict in `test/editMessage.test.ts` (fixture/test file introduced by #36). Schema and changelog apply cleanly. Apply #36 first; #37 is not required.

# Unmet Criteria

None for this fix round. PR publication, landing, and any pin bump remain owner/manager actions. No push performed.

# Residual Risk

- No live realm validation: server permissions, edit limits, and move-event/cache behavior are not exercised by loopback tests. Permission decisions remain Zulip's.
- Per the requested local contract, all explicit propagation modes are rejected on content-only edits; callers should omit that field.
- Installation still reports 3 pre-existing dependency vulnerabilities (1 low, 2 high); dependencies are unchanged and remediation is out of scope.
- This commit requires #36 for a conflict-free cherry-pick onto upstream.

# Draft PR

**Title:** Add topic rename and move parameters to edit_message

**Body:**

## Summary
- Add optional `topic`, `stream_id`, and `propagate_mode` to `edit_message`; require at least one of content/topic/stream_id.
- Validate message ID first, stream IDs as positive integers, and propagation modes locally.
- Reject content edits combined with stream moves with guidance to send two calls. Content+topic edits remain supported.
- Require topic or stream_id when propagation is supplied. Leave omitted propagation out of the request: Zulip defaults to `change_one` (only this message); use `change_all` for the whole topic or `change_later` for this and later messages.
- Preserve content-only form encoding and existing Zulip error handling. Permissions/edit limits remain realm-controlled; notification options are not exposed.
- Add request-body, validation, description, and server-error regression coverage plus a changelog fragment.

Optional parameters avoid a redundant `move_topic` tool while supporting legal combined content/topic edits.

## Dependencies
Requires #36's encoding/error fix. Fresh scratch cherry-pick onto upstream + #36 is clean; #37 is not required. Bare upstream conflicts in the runtime and #36's test file.

## Verification
- Node 22.23.3: `npm ci --ignore-scripts`, `npm run build`, and `npm test` pass.
- Base: 296 pass / 1 skip. Head: 316 pass / 1 skip.
- Four fix-round regression tests failed before implementation; all 28 edit-message tests now pass.
- HTTP tests use a local stand-in; no live Zulip access.
