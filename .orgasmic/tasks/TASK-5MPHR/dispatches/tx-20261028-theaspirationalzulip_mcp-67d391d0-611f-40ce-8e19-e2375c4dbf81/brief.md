# Implement fix round — Dispatch Brief
```brief
PUBLIC repo/ledger: public technical facts only. Fix round 2 on TASK-5MPHR; new commit on top of 0b1290329fff6c78a92db2c5706cfaf33e9c9b40 (no amend, no push).
The review found two MEDIUMs in the new edit_message code:
1. src/tool-runtime.ts:717: a call without `content` sends content=undefined and overwrites the message with the literal text "undefined". Add `if (typeof args.content !== "string") throw new Error("content is required")` (match the repo's existing guard style) before any request, plus a test asserting no request is made.
2. src/tool-runtime.ts:719: response.json() runs before the status check, so an HTML 502 or empty body becomes a bare SyntaxError with no status. Parse defensively, check !response.ok first, and include the HTTP status plus the server's msg when present (or a short, credential-free body snippet) in the error. Change the existing HTTP 503 test to serve an HTML body, and add an empty-body case.
Nothing else (LOWs go to a follow-up). Show both new tests red on 0b129032, then green. Gates: npm ci, npm run build, npm test; report counts. Update the draft PR description if needed.
```

## Round context
Resume round contract: 2. Continues dispatch tx-20261028-theaspirationalzulip_mcp-6f6fc99d-29c1-49b7-848f-cdc08aafa12b, run run-01M61J5TJH8VNK2YRV27RJARSE, in your own native session and the same worktree.
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