# Implement fix round — Dispatch Brief
```brief
Fix round 2 for TASK-PXRSM, from re-review /srv/review-drop/TASK-PXRSM-REVIEW2.md (read in full). On top of e8a1fe8265a8749b7c3716832f9b8a39788b5048:
- MEDIUM-1: restore `required: ["type"]` in the send_message schema (the anyOf then only adds `to`), and extend the local guard at src/tool-runtime.ts:712 so a call without reply_to also refuses when `type` is missing, before any lookup/upload/send. Add the missing-type case to the missing-destination test.
- MEDIUM-2: narrow the email->directory fallback: use it only when the referenced message's display_recipient emails look synthetic (restricted email visibility); when the message carries real emails, compare by email/id only and refuse on mismatch. Document in README next to the synthetic-email note that id-based `to` is the only exact cross-check. Tests for both branches.
- LOW-1: test two members sharing one email -> refused, no sends.
- LOW-2: one README sentence: all-digit `to` is always an id, so digit-named streams are addressed by id.
- LOW-3: memoise the in-flight members() promise so one send makes at most one GET /users; test the call count.
Same author/committer and trailer, separate small commits, full gates (npm ci, tsc, build, npm test), local only, report.
```

## Round context
Resume round contract: 2. Continues dispatch tx-20261029-theaspirationalzulip_mcp-2762a941-6e4f-442c-86ec-42e9e8014815, run run-01M63X9WC86J8JV9NHYA50JTZB, in your own native session and the same worktree.
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