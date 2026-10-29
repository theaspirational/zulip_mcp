# Implement fix round — Dispatch Brief
```brief
Fix round on fb9cc23184d66597d6517939c03695e666472b0a. Review: /srv/review-drop/TASK-WDCGX-REVIEW1.md (read it). Amend into the SAME single commit (it must stay one separable commit; amend is fine, it's local only):
1. MEDIUM: Zulip rejects content + stream_id together. Reject that pair locally with a clear error ("a stream move cannot be combined with a content edit; send two calls") and say so in the description; replace the 'content and stream' / 'all fields' encoding tests with a rejection test (content+topic stays allowed).
2. MEDIUM: state the propagate_mode default in the description: Zulip defaults to change_one (this message only); change_all renames/moves the whole topic; change_later this and later messages. Keep omitting the field when not given.
3. LOW: propagate_mode is only valid with topic or stream_id: reject it locally for content-only edits, with a test.
4. LOW: validate message_id first.
Don't expose send_notification_* now. Gates: npm ci --ignore-scripts, npm run build, npm test on Node 22.23.3. Re-run the cherry-pick probe onto fafaeef8664c5765dbc7e6863b26f6911c1ac900. Update the draft PR body. No push.
```

## Round context
Resume round contract: 2. Continues dispatch tx-20261029-theaspirationalzulip_mcp-789c214c-a29f-406f-9069-452a6e7b3cb1, run run-01M638MMSBD8VTDEYE5WMKEHQC, in your own native session and the same worktree.
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
Blocking decision: `orgasmic dispatch ask "<question>"`; keep it alive for the stdout answer. A timeout is not permission. With `--no-wait`, answers/messages arrive at turn boundaries, not between tool calls. If finalize refuses for pending messages, handle their full text and retry. Successful finalize is terminal; no work follows it. Never disclose credentials or the run token.