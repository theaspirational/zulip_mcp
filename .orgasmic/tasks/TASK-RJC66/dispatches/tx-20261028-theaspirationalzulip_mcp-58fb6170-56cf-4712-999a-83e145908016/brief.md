# Implement fix round — Dispatch Brief
`````brief
PUBLIC repository and ledger: public technical facts only. Fix round 2 on TASK-RJC66: new commit on top of c741dc9b84179d46d831253a99e459fe891d2c00 (no amend, no push).
The review rejected for two MEDIUMs; fix both:
1. src/platforms/zulip.ts:386-397: bound the work. Look up at most the first 2 distinct quoted ids per message, with a short dedicated timeout for this path (about 3 s, not the 15 s LOCATE_TIMEOUT_MS). Update the :385 docstring to match.
2. With (1) the stall is bounded; keep `await onMessage` only if delivery order needs it, and make sure a hung quote lookup delays unrelated events by at most that bound. Add the regression test: deliver [quote-reply whose lookup hangs, unrelated message] and assert the unrelated message arrives within the bound (fail on c741dc9b). Add a test that a message with many quote headings triggers at most 2 lookups.
Cheap LOWs to include: accept any link text in the heading (`\[[^\]\n]*\]` instead of `\[said\]`, Zulip translates "said") and `~~~quote` fences, one test each. Changelog: mention that message handlers may now be awaited (bounded) if you keep that.
Do not touch anything else. Gates: npm ci, npm run build, npm test with counts; red then green for the new tests. Update the draft PR description to state the deliberate limits: live path only (history/catch-up unchanged), DM/group-DM addressing unchanged, matching trusts only the message id (realm and mention text are ignored).
`````

## Round context
Resume round contract: 2. Continues dispatch tx-20261028-theaspirationalzulip_mcp-4132933a-6ae0-4a11-bb0e-76b7aa11c7da, run run-01M61Q8GY52QMA9595JN2C5FXD, in your own native session and the same worktree.
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