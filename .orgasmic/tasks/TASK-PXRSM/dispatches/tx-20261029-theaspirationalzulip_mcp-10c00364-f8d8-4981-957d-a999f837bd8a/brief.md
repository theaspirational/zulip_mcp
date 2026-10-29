# Implement fix round — Dispatch Brief
```brief
Fix round 3 (small) for TASK-PXRSM, from re-review 3 (/srv/review-drop/TASK-PXRSM-REVIEW3.md, read Findings in full). On top of 3ff25b3e231ebd0d6ce3179c17bc91ee14aeb80d fix exactly the 4 LOWs:
1. src/tool-runtime.ts:322/337: accept a directory match only if the resolved id belongs to a participant whose own metadata address is synthetic (matches.length === 1 && recipients.some(r => r.id === matches[0].user_id && isSynthetic(r))). Add the mixed-metadata test from the review (case B must refuse).
2. When a recipient has no email, the conflict message adds a hint to use user IDs; test.
3. Directory outage on the reply_to path: wrap as `reply_to <id>: could not resolve "<email>" (user directory unavailable)`; test refusal with sends == [] and uploaded == [].
4. changelog fragment: the tool schema requires `type`; direct runtime callers may still omit it with reply_to.
Then SQUASH the whole branch e5c4b4c01c63c100f5671fef86f74b23c72bbdcb..HEAD into ONE commit on e5c4b4c, message "Add reply_to to send_message" plus a short neutral body, author/committer Vasyl Dovhanchyn <48733736+theaspirational@users.noreply.github.com>, trailer Co-Authored-By: GPT-6-Astra <noreply@openai.com>. Gates: npm ci, tsc, build, npm test. Local only. Report the squashed sha, diff stat and a final user-facing PR title + body (no internal names, hosts, agents or review history).
```

## Round context
Resume round contract: 2. Continues dispatch tx-20261029-theaspirationalzulip_mcp-2b8bb5d6-d42a-4251-9a9d-c031f7090c0c, run run-01M63XX104BT8JTAR8YS0W9F7M, in your own native session and the same worktree.
Changed this round: the brief above narrows the assignment; use this run's evidence directory and report, not the earlier round's destination.
Original instructions are history, not missing context. Original scope, security and read-only-ledger boundaries still apply, narrowed by this brief. Do not replay startup reads unless changed facts or this brief require them. Do not merge or close the dispatch.

## Evidence and verification
Earlier reads/code/reports remain context, not new proof. Identify valid inherited evidence and its unchanged inputs/scope in this round's report. No earlier gate pass is implied by resuming. Verify findings against current source. Run assigned checks and scoped probes through `orgasmic dispatch gate <name> -- <cmd> [args...]`; missing receipts do not assign a full suite. Keep builds outside evidence.

## Completion for this round
Report Changed, Verification Gates (commands/results/logs and inherited evidence), Unmet Criteria, and Residual Risk in `$ORGASMIC_EVIDENCE_DIR/report.md`. If unset, substitute a scratch path outside the worktree below.
For done, satisfy the narrowed brief and make a local commit in this worktree; stage explicit paths and do not bypass hooks. Then run:
`orgasmic dispatch finalize --status done --summary-file "$ORGASMIC_EVIDENCE_DIR/report.md"`
If blocked, report the exact unmet criteria and run:
`orgasmic dispatch finalize --status blocked --reason "<why>" --summary-file "$ORGASMIC_EVIDENCE_DIR/report.md"`
Blocking decision: `orgasmic dispatch ask "<question>"`; keep it alive for the stdout answer. A timeout is not permission. With `--no-wait`, Codex app-server accepts answers/messages mid-turn; other multi-turn harnesses receive them at turn boundaries or finalize. If finalize refuses for pending messages, handle their full text and retry. Successful finalize is terminal; no work follows it. Never disclose credentials or the run token.