# Changed

None. The worktree remains clean at the requested base, `e5c4b4c01c63c100f5671fef86f74b23c72bbdcb`. No commit, push, changelog fragment, or PR was created: the supplied failure does not reproduce on this base. The dispatch requires stopping when its premise is false rather than manufacturing a change.

The supplied project baseline was read; no applicable repository instructions or additional conventions/gotchas were supplied or found.

## Trace and order evidence

- `src/content.ts:221` defines `cleanContent`. It strips markup at `src/content.ts:267`, **then** decodes `&lt;`, `&gt;`, `&amp;`, and `&quot;` at lines 268–271. There is no subsequent tag strip. The proposed decode-before-strip order bug is absent. `&amp;lt;` remains literal `&lt;` because the less-than replacement precedes ampersand decoding.
- `get_channel_history`: `src/tool-runtime.ts:509` retrieves rendered HTML; lines 548–549 select detailed output by default and call `formatMessages`. `formatMessages` calls `cleanContent` at line 158 (detailed) or line 148 (summary). Raw format returns JSON directly at lines 141–142.
- `fetch_history`: `src/tool-runtime.ts:876` calls `fetchHistory`; `src/history.ts:275` requests `apply_markdown: false`, and line 282 normalizes messages. `src/history.ts:229` uses `cleanMarkdown`, whose implementation at `src/content.ts:286–287` only normalizes line endings and trims. Output at `src/tool-runtime.ts:891` uses `formatHistoryLines`, which inserts the preserved text at line 208.
- `fetch_around`: `src/tool-runtime.ts:899` calls `fetchAround`; `src/history.ts:302` and line 314 request raw Markdown for the anchor and window. Lines 304 and 319 normalize it through the same raw-text path. Output is formatted at `src/tool-runtime.ts:909`.
- Incoming events: `src/platforms/zulip-events.ts:292` registers with `apply_markdown: 'false'`; `src/platforms/zulip.ts:857` calls `normalizeMessage`, then lines 868/884 deliver through `toIncoming`. `src/history.ts:365` inserts preserved text directly.
- Adapter history also calls the raw history helper at `src/platforms/zulip.ts:763` and `toIncoming` at line 773; context injection uses it at lines 725/740.

[Upstream issue #34](https://github.com/antra-tess/zulip_mcp/issues/34) was checked on 2026-10-28: open, with no linked development branch or PR shown. The [open PR list](https://github.com/antra-tess/zulip_mcp/pulls) showed no issue-specific fix. This observation does not establish the cause of the reported deployment behavior.

# Verification Gates

All commands ran through the required gate wrapper on the clean, unchanged base. Log paths below are relative to the evidence directory.

| Command | Result | Log |
| --- | --- | --- |
| `orgasmic dispatch gate base-npm-ci -- npm ci` | Passed; 51 packages installed. Audit reported 1 low and 2 high vulnerabilities. | `gate-base-npm-ci-01M61KVKN3HPH7ZGDC9VAHYVWN.log` |
| `orgasmic dispatch gate base-build -- npm run build` | Passed | `gate-base-build-01M61KVWJNH8SYKACT01GSSJKG.log` |
| `orgasmic dispatch gate base-test -- npm test` | 267 tests: 266 passed, 0 failed, 1 skipped | `gate-base-test-01M61KW52SJZGZ2KKQ1TWFWBN4.log` |
| `orgasmic dispatch gate base-render-probe -- node "$ORGASMIC_EVIDENCE_DIR/render-probe.mjs"` | All 9 probe groups passed | `gate-base-render-probe-01M61KWV7CFHX2N9BV5V696TQE.log` |

`render-probe.mjs` is an evidence-only reproducible probe, not a repository change. Run it from the worktree after building. Six rendered-HTML fixtures cover fenced XML, inline `<…>`, paragraph comparisons, paragraph XML, double escaping, and mention/link preservation. Each passes both the renderer and actual `get_channel_history` detailed/raw tool handlers. Additional groups exercise `fetch_history`, `fetch_around`, and queue-to-adapter incoming delivery with protocol-appropriate raw Markdown and mocked API responses. Queue registration is asserted to request raw Markdown.

Base versus final: no changed revision exists; the final tree is the base. Baseline counts are above. All requested reproduction fixtures are already green, so there is no honest red-to-green result.

# Unmet Criteria

- Cannot demonstrate the requested failure on the specified base or explain a decode-before-strip bug that is not present there.
- No implementation, committed regression tests, changelog fragment, local commit, or upstream PR draft claiming “Fixes #34”. Such a claim would be unsupported.
- The underlying reported deployment failure remains unresolved. A sanitized reproducer that fails on this base, or the actual affected source revision and path, is needed before implementation can proceed.

# Residual Risk

Mocks exercise production rendering and dispatch code but do not establish the payload or installed revision of an affected deployment. No live service was contacted for message data. Existing dependency audit findings were not changed. No unrelated rendering or dependency changes were made.
