# Implement fix round — Dispatch Brief
```brief
Fix round 1 for TASK-PXRSM, from review 1 (/srv/review-drop/TASK-PXRSM-REVIEW1.md, read it in full). Fix the two MEDIUM findings only:
1. src/tool-runtime.ts:307 and :321-325: a numeric-looking string `to` must compare as an id (stream: against stream_id; DM: as a user id), and DM participants must also match by display_recipient[].id when an email lookup misses (restricted email visibility). Add the refusal/acceptance tests: '12' for stream 12, ['42'] and '42,7' for DMs, a real email vs a synthetic display_recipient email.
2. src/tool-runtime.ts:703-706: local check that refuses when both `to` and `reply_to` are absent, before any lookup, upload or send; add a test asserting nothing is sent.
Don't touch the LOW findings in this round. Amend into a new commit on top of 8f3a8248a95b2352acd90850d045347d38ec826a (same author/committer and trailer), run typecheck, build and the full npm test, local only, and report.
```

## Round context
Resume round contract: 2. Continues dispatch tx-20261029-theaspirationalzulip_mcp-f4d1cd86-e5f0-4eac-b656-3f86b29f8f93, run run-01M63WHQ29S1H5YWTMRBYWYZHA, in your own native session and the same worktree.
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