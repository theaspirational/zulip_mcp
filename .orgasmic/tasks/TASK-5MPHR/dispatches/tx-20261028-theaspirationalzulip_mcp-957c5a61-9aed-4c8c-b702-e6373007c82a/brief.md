# Implement fix round — Dispatch Brief
```brief
PUBLIC repo/ledger: public technical facts only. Fix round 3 on TASK-5MPHR; new commit on top of 46a6dacae42e8008e4b4cf1b952648016ef2e7d6 (no amend, no push). The re-review approved; fix only these two LOWs:
L1 src/tool-runtime.ts:729-733: redaction runs before markup stripping, so a credential split by tags (e.g. `Basic <b>Ym90</b><i>QGV4...</i>`) escapes redaction and is reassembled. Order must be: strip markup and collapse whitespace, then redact (full header, base64, decoded email and API key), then slice(0,160). Add the markup-interleaved case to test/editMessage.test.ts asserting no fragment of the base64, API key or email survives.
L2 src/tool-runtime.ts:709: validate message_id next to the content guard (positive integer, else throw "message_id is required"), before any request; add a test asserting no request is made.
Do not touch anything else. Show both tests red on 46a6daca, then green. Gates: npm ci, npm run build, npm test; report counts. Update the changelog fragment only if user-visible wording needs it. Give the final draft PR title/description.
```

## Round context
Resume round contract: 2. Continues dispatch tx-20261028-theaspirationalzulip_mcp-67d391d0-611f-40ce-8e19-e2375c4dbf81, run run-01M61K02B0T08QFA5QKKYTE5SA, in your own native session and the same worktree.
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