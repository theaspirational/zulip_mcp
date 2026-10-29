# Changed

- Head: `fb9cc23184d66597d6517939c03695e666472b0a`.
- Branch: `edit-message-topic-moves`, based on fork main `369959c58913d87b307a0b37342fa5bd810b583d`.
- Exactly one separable commit: `Add topic rename and move parameters to edit_message`.
- Author and committer: `orgasmic worker (devbox) <orgasmic@devbox>`.
- Added optional `topic`, `propagate_mode`, and positive-integer `stream_id` to the tool schema and PATCH form body. At least one of content/topic/stream_id is required; invalid types and propagation modes fail locally before HTTP. Omitted propagation is not sent, leaving Zulip's default intact.
- Preserved content-only form encoding, endpoint, authentication, and the existing #36 error handling. No permission logic added; realm refusal messages are surfaced.
- Concise tool/parameter descriptions explain rename/move behavior, propagation semantics, and realm-controlled permissions. Added the required user-visible changelog fragment.
- A separate `move_topic` tool is not preferable here: it would duplicate the same endpoint and validation, while optional fields support both standalone moves and combined content/topic edits without another tool.
- Instructions read: `/home/orgasmic/.agents/skills/orgasmic/SKILL.md`, worker command-ownership page, supplied `/home/orgasmic/.orgasmic/ledgers/theaspirational.zulip_mcp/.orgasmic/project.org`, and `changelog.d/README.md`. No applicable AGENTS.md found; conventions/gotchas explicitly supplied as none.

Diff stat:

```text
 changelog.d/edit-message-topic-moves.added.md |   1 +
 src/tool-runtime.ts                         |  18 ++++-
 src/tools.ts                                |  18 ++++-
 test/editMessage.test.ts                    | 101 +++++++++++++++++++++++++-
 4 files changed, 131 insertions(+), 7 deletions(-)
```

No lockfile or generated-file changes; final working tree clean.

# Verification Gates

All npm/node commands used `env PATH=/opt/node/bin:$PATH`; `/opt/node/bin/node --version` returned `v22.23.3`. Log paths below are relative to this report's evidence directory.

| Check | Command (inside `orgasmic dispatch gate <name> --`) | Outcome | Log |
| --- | --- | --- | --- |
| base-install | `env PATH=/opt/node/bin:$PATH npm ci --ignore-scripts` | Pass at base, clean | `gate-base-install-01M638NJEJ8VMPMTDQQHKQESJG.log` |
| base-test | `env PATH=/opt/node/bin:$PATH npm test` | 297 tests: 296 pass, 0 fail, 1 skip | `gate-base-test-01M638NRR17K2QMW4AHPGDADEQ.log` |
| edit-message-red | `env PATH=/opt/node/bin:$PATH node --import tsx --test test/editMessage.test.ts` | Expected failure before implementation: 8 pass, 18 fail | `gate-edit-message-red-01M638Q4YEW5NWHEZBMMAWQQAJ.log` |
| edit-message-green | `env PATH=/opt/node/bin:$PATH node --import tsx --test test/editMessage.test.ts` | 26 pass, 0 fail | `gate-edit-message-green-01M638R5FK0WVKNZ8W282FRSMH.log` |
| install | `env PATH=/opt/node/bin:$PATH npm ci --ignore-scripts` | Pass at reported head, clean | `gate-install-01M638RKAY3RSKJPMQD4JFED7W.log` |
| build | `env PATH=/opt/node/bin:$PATH npm run build` (tsc) | Pass at reported head, clean | `gate-build-01M638RM3J92490W1B44AMFGPK.log` |
| test | `env PATH=/opt/node/bin:$PATH npm test` | 315 tests: 314 pass, 0 fail, 1 skip; reported head, clean | `gate-test-01M638RR9HRMFD1JYE3X52Y2Q5.log` |

Net increase: 18 tests. The unchanged skip is the non-Linux upload guard test, skipped on Linux. Red/green checks intentionally ran on a dirty implementation tree; the three final required gates have clean-head receipts.

The tests exercise the production runtime and real zulip-js client against a loopback HTTP server, verifying PATCH URL, exact form body, content type and authorization. Coverage includes topic-only, each propagation enum, stream-only, stream+topic, content+topic, content+stream, all fields, stream+propagation, empty strings, omitted fields, invalid enum/stream/topic/content, schema exposure, and a realm permission error. Existing content-only and HTTP/error-redaction tests remain covered. No live Zulip requests or push performed.

`git diff --check HEAD^ HEAD` passed.

## Cherry-pick probes

Evidence: `cherry-pick-probes.log`. Ran `git cherry-pick --no-commit fb9cc23184d66597d6517939c03695e666472b0a` in separate detached scratch worktrees; removed both afterward.

- Upstream main + #36, without #37 (`fafaeef8664c5765dbc7e6863b26f6911c1ac900`): exit 0, applies cleanly. This verifies #37 is not a dependency.
- Bare upstream main `e5c4b4c01c63c100f5671fef86f74b23c72bbdcb`, without #36/#37: exit 1, does **not** apply cleanly.
  - Content conflict in `src/tool-runtime.ts`: bare upstream uses `zulipClient.messages.update`; this change extends #36's direct PATCH form-body and validation path.
  - Modify/delete conflict in `test/editMessage.test.ts`: the #36 test file/HTTP fixture does not exist on bare upstream.
  - `src/tools.ts` and the new changelog fragment apply cleanly.
  - Merge/apply #36 first; do not resolve this by dropping its transport/error handling.

# Unmet Criteria

None for this implementation dispatch. PR publication, landing, and pin bump remain owner/manager actions; no push or live realm validation was attempted, as requested.

# Residual Risk

- Real realm policy behavior was not exercised; the implementation deliberately delegates permissions and edit limits to Zulip and preserves its errors.
- `npm ci` reports 3 existing dependency vulnerabilities (1 low, 2 high) at both base and head. Dependencies were unchanged; remediation is outside this task.
- Bare upstream requires #36 before this commit, as demonstrated above.

# Draft PR

**Title:** Add topic rename and move parameters to edit_message

**Body:**

## Summary
- Add optional `topic`, `stream_id`, and `propagate_mode` to `edit_message`.
- Allow content-free topic renames/moves, requiring at least one edit field and validating propagation mode and positive stream IDs locally.
- Keep the existing URL-encoded content path and Zulip error handling; permissions and omitted propagation defaults remain server-controlled.
- Document the new fields and add HTTP request-body, validation, and realm-error regression tests.

Extending the existing tool avoids a redundant `move_topic` tool and supports combined content/topic updates.

## Dependencies
Based on the edit-message encoding/error fix in #36; applies cleanly with #36 and does not require #37. Without #36, runtime and test-file conflicts are expected.

## Verification
- Node 22.23.3: `npm ci --ignore-scripts`, `npm run build`, `npm test` pass.
- Base: 296 pass / 1 skip. Head: 314 pass / 1 skip.
- Regression tests were red before implementation, then passed against a local HTTP stand-in. No live Zulip access.
