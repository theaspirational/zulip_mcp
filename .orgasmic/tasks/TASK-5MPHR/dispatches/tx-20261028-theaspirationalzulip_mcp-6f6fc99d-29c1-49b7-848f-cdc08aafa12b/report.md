# Implementation report

## Changed

- Local commit: `0b1290329fff6c78a92db2c5706cfaf33e9c9b40`, based on `e5c4b4c01c63c100f5671fef86f74b23c72bbdcb`. One commit; no push or PR creation. Working tree clean.
- Baseline mapping: `src/tool-runtime.ts:707-713` passed `{ message_id, content }` to `messages.update`. The exposed schema is content-only (`src/tools.ts:253-267`); topic and propagation options are not exposed and were not added.
- Root cause detail: locked `zulip-js` 2.1.0 already puts the ID in the correct path (`node_modules/zulip-js/lib/resources/messages.js:34-36`), but also forwards it with content to the query-string encoder (`node_modules/zulip-js/lib/api.js:35-40`). The HTTP probe captured `PATCH /api/v1/messages/42?message_id=42&content=...`, with an empty body. Its generic `callEndpoint` uses the same encoder, so switching to that method would not satisfy the body requirement.
- `src/tool-runtime.ts:707-727`: direct authenticated PATCH, ID only in the path, only content in the form body; rejects unsupported-parameter warnings and HTTP/API failures. Uses the resolved client API URL to preserve API-prefix configuration. Existing server error handling converts rejection into `isError: true` (`src/server.ts:1386-1388`).
- `test/editMessage.test.ts`: real locked client/runtime against a local HTTP stand-in; exact method, path, form body, authorization, Unicode/reserved-character encoding, unsupported fields, API and HTTP failures.
- `test/server.test.ts`: real runtime through the MCP wire verifies unsupported-parameter responses become tool errors.
- `changelog.d/edit-message-request.fixed.md`: required user-visible fix fragment.
- Read `README.md`, `CHANGELOG.md`, and `changelog.d/README.md`. No CONTRIBUTING or applicable AGENTS file found; no additional conventions or gotchas supplied. No dependency, lockfile, schema, or tracked generated-file changes.
- API contract verified against [Edit a message](https://zulip.com/api/update-message): PATCH `/api/v1/messages/{message_id}`.

## Verification Gates

Node `v22.23.3`, npm `10.9.9`. All checks below ran through the required gate wrapper. Log paths are relative to this report's directory.

| Gate | Command | Outcome | Log |
| --- | --- | --- | --- |
| `base-install` | `npm ci` | Pass; clean pinned base | `gate-base-install-01M61J6J5W565H59WHXHK5FFRP.log` |
| `base-build` | `npm run build` | Pass; TypeScript compilation/typecheck | `gate-base-build-01M61J70HG08C38277QJP6YW6Q.log` |
| `base-test` | `npm test` | 267 tests: 266 passed, 0 failed, 1 skipped | `gate-base-test-01M61J71FDHTHYBEKPH90YFPVT.log` |
| `red-edit-message` | `node --import tsx --test test/editMessage.test.ts` | Expected failure on base source: 1 passed, 3 failed | `gate-red-edit-message-01M61J9HD8AFJWF8XYRW0YQN33.log` |
| `red-edit-wire` | `node --import tsx --test --test-name-pattern=edit_message test/server.test.ts` | Expected failure on base source: missing isError | `gate-red-edit-wire-01M61JC4X5EQV90H18N07YYYH4.log` |
| `green-edit-message` | `node --import tsx --test test/editMessage.test.ts` | 4 passed, 0 failed | `gate-green-edit-message-01M61JAFH77PHGD6D2FKF29KZN.log` |
| `green-edit-wire` | `node --import tsx --test --test-name-pattern=edit_message test/server.test.ts` | 1 passed, 0 failed | `gate-green-edit-wire-01M61JB8AZ4EZCAX1BNSGT37PT.log` |
| `scoped-build` | `npm run build` | Pass | `gate-scoped-build-01M61JAFS6B4VMTDZJA95YE74D.log` |
| `final-install` | `npm ci` | Pass at final clean commit | `gate-final-install-01M61JCPZXXWNABW21649DZK40.log` |
| `final-build` | `npm run build` | Pass at final clean commit; includes typecheck | `gate-final-build-01M61JCRDF3438CVS4BP6DJRXQ.log` |
| `final-test` | `npm test` | 272 tests: 271 passed, 0 failed, 1 skipped; final clean commit | `gate-final-test-01M61JCSJK1P1KVVT3ZRSY9R6V.log` |

The red runs used production source from the pinned commit with the new tests added. The HTTP regression showed the unwanted query parameters/empty body and missing warning rejection; the wire regression returned no `isError`. The fixed source was restored before committing. Final full-suite results include all five added tests. `git diff --check` passed. There is no separate typecheck script; `build` invokes strict `tsc`.

The single skip is unchanged: the non-Linux local-file refusal test is skipped on Linux. Both installs reported the same three dependency audit findings (one low, two high); dependency remediation is outside this fix.

## Unmet Criteria

None. Publishing and opening the PR were intentionally not performed.

## Residual Risk

No live Zulip realm was contacted for an edit. Local HTTP and MCP probes establish the corrected production request and error behavior, but do not establish why a particular deployed server failed to apply an edit. In particular, an ignored redundant ID alone does not prove content was not applied. A warning may accompany a partially applied operation; the error does not imply rollback. Existing dependency audit findings remain unchanged.

## Draft PR

**Title:** Fix edit_message PATCH parameters and error reporting

- **Problem:** Message edits can report success despite unsupported-parameter warnings.
- **Cause:** The locked client duplicates `message_id` in the query and sends no PATCH body; the runtime ignores warnings.
- **Fix:** Send the ID only in the path and content in the form body; report unsupported parameters and HTTP/API failures as tool errors.
- **Tests:** HTTP request assertions and MCP error regression fail on the base and pass with the fix. Lockfile install and build/typecheck pass; full suite: 271 passed, one existing skip (base: 266 passed, one skip).
