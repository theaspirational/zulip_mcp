# Review — TASK-5MPHR (`edit_message` ignores `message_id`)

Commit reviewed: `0b1290329fff6c78a92db2c5706cfaf33e9c9b40` on
`e5c4b4c01c63c100f5671fef86f74b23c72bbdcb`. Worktree left clean, no commits,
no tracked-file edits.

## Verdict

**Approve with changes — one MEDIUM should be fixed before the upstream PR.**

The root-cause claim is correct and independently confirmed. The new request is
right per the documented API, the auth/URL/encoding handling is sound, and the
tests exercise real production code and genuinely fail on the base. Two gaps are
worth fixing while the PR is still local: a missing `content` guard that now
deterministically overwrites a message with the literal text `undefined`, and a
failure path that turns any non-JSON server response into an opaque
`SyntaxError` with the HTTP status discarded. Neither is a regression of the
behaviour being fixed; both are cheap to close and both land in code this PR
introduces.

## Findings

### MEDIUM — bug/data-loss. `src/tool-runtime.ts:717`: a missing `content` overwrites the message with the string `"undefined"`

`body: new URLSearchParams({ content: args.content })` stringifies `undefined`.
`args` is `Record<string, any>` and nothing validates the tool's `required`
schema at runtime — `src/server.ts:1386` only catches thrown errors, there is no
`inputSchema` validation anywhere in `src/server.ts`. Probe
(`$ORGASMIC_EVIDENCE_DIR/probe-nonjson.mts`, case `undef-content`):

```
edit_message { message_id: 42 }  ->  body: "content=undefined"  -> RESOLVED {"result":"success"}
```

Impact: a client (or model) that calls `edit_message` with only `message_id` —
plausible, e.g. reaching for a topic-only edit, which this schema does not
support — destroys the message body and gets `success` back. On the base this
same call put `content=undefined` in the query string with an empty body, so the
effect was indeterminate; the fix makes it certain, which is exactly the point of
the fix. The repo already uses explicit guards in this style
(`src/tool-runtime.ts:962` `"emoji_name is required"`, `src/server.ts:1452`
`"channel is required"`).

Fix direction: before the fetch, `if (typeof args.content !== "string") throw new
Error("content is required")`. One line, one test.

### MEDIUM — correctness/UX. `src/tool-runtime.ts:719`: `response.json()` ahead of any status check loses every non-JSON failure

`const result = await response.json()` runs before the `response.ok` check, so a
realm behind a proxy returning an HTML error page, or an empty body, surfaces as
a bare JSON parse error with no status, no URL, no hint. Probe output:

```
[html-502]  THREW: SyntaxError: Unexpected token '<', "<html><bod"... is not valid JSON
[empty-200] THREW: SyntaxError: Unexpected end of JSON input
[json-429]  THREW: Error: Zulip refused editing message 42: API usage exceeded rate limit   <- good
```

This is a quality regression specific to bypassing zulip-js: `api.js` handles the
case explicitly (`node_modules/zulip-js/lib/api.js:52-64`, "Server Returned a
non-JSON response… Maybe endpoint PATCH /messages/42 doesn't exist"), and every
other Zulip call in the runtime still gets that. 502/503/504 from a reverse proxy
is the ordinary way a self-hosted realm fails.

Related, same block: when the response is non-ok and the body has no `result`
field, line 722 reports only `HTTP ${status}` and drops any `msg` the server did
send.

Fix direction: wrap the parse — `const result = await response.json().catch(() =>
null)` — and move the `!response.ok` check ahead of `assertApiSuccess`, or keep
the order and include the status plus a body snippet in the thrown message. The
existing `HTTP 503` test passes `{}`, which is valid JSON, so this path is
untested either way.

### LOW — evidence gap. The symptom "the edit never applies" is not proven fixed

The wire defect is real and confirmed (see Verification). But the reported server
response was `ignored_parameters_unsupported: ["message_id"]` *only* — `content`
was not listed, even though the red-gate capture shows `content` went out in the
query string (`gate-red-edit-message…log`: `PATCH
/api/v1/messages/42?message_id=42&content=Updated+**text**…`, body `''`). If the
realm had discarded `content` it should have appeared in the same warning list.
That is consistent with Zulip having consumed `content` from the query — i.e. the
edit applying, and the agent treating the `message_id` warning as failure and
falling back to posting a new message. Under that reading the request fix is
correct and worth landing, but the user-visible symptom had a different cause.
The implementer's report states this residual risk honestly; I am recording it
because acceptance criterion 2 ("a test that the edit applies") is met at the
wire-format level, not against a live realm. No live realm is available in this
environment, so this cannot be closed here.

Note the new unsupported-parameter check is not reachable in practice now that
only `content` is sent — `content` has been supported by `PATCH /messages/{id}`
for the endpoint's whole life. It is a belt-and-braces guard, which is fine; the
wording ("Zulip refused editing message 42") would be wrong if a *future* added
field were the ignored one, since the content edit would in fact have applied and
the caller would likely re-post. Worth softening to name the applied/ignored
split if more edit fields are ever exposed, not worth blocking on today.

### LOW — test gap. API-URL resolution is single-pathed in tests

`src/tool-runtime.ts:713` has three behaviours — `client.config.apiURL`, the
`${realm}/api/v1` fallback, and (via zulip-js) a realm already ending in `/api`
(`node_modules/zulip-js/lib/index.js:75-79`). Only the first is covered.
`session.realm` is trailing-slash-normalised at `src/zulip-client.ts:61`, so the
fallback is safe; the `/api`-suffixed realm is handled only because
`config.apiURL` is preferred, which is the right preference and currently
unasserted.

## Verification Gates

Reused receipts at this exact commit (per dispatch, not re-run):

| Gate | Command | Outcome | Log |
| --- | --- | --- | --- |
| `final-install` | `npm ci` | exit 0 | `…/run-01M61J5TJH8VNK2YRV27RJARSE/evidence/gate-final-install-01M61JCPZXXWNABW21649DZK40.log` |
| `final-build` | `npm run build` (strict `tsc`) | exit 0 | `…gate-final-build-01M61JCRDF3438CVS4BP6DJRXQ.log` |
| `final-test` | `npm test` | 272 tests / 271 pass / 0 fail / 1 skip | `…gate-final-test-01M61JCSJK1P1KVVT3ZRSY9R6V.log` |

Base comparison from the same evidence dir: 267 tests / 266 pass / 1 skip — the
+5 accounts for all five added tests, so they are in the default suite. The
single skip is the pre-existing non-Linux local-file refusal test.

Run by me in this worktree:

| Gate | Command | Outcome | Log |
| --- | --- | --- | --- |
| `review-new-tests` | `node --import tsx --test test/editMessage.test.ts` | 4 pass / 0 fail | `$ORGASMIC_EVIDENCE_DIR/gate-review-new-tests-01M61JTTZKNC5BVB8AT4BS018A.log` |
| `review-wire-test` | `node --import tsx --test --test-name-pattern=edit_message test/server.test.ts` | 1 pass / 0 fail | `$ORGASMIC_EVIDENCE_DIR/gate-review-wire-test-01M61JTX5XJ77EES9PW45YA8TX.log` |
| production-path probe | `node --import tsx $ORGASMIC_EVIDENCE_DIR/probe-nonjson.mts` | 5 cases, output quoted above | `$ORGASMIC_EVIDENCE_DIR/probe-nonjson.mts` |

Checked by inspection:

- **Root cause (brief item 1): confirmed** against locked `zulip-js` 2.1.0.
  `lib/resources/messages.js:34-36` puts the id in the path *and* forwards the
  whole `params` object to `api()`; `lib/api.js:26-40` builds a `FormData` body
  only for `POST` and otherwise appends every param to `url.searchParams`, so
  `PATCH` goes out with the id duplicated in the query and no body. The red gate
  captured exactly that. `callEndpoint` (`lib/index.js:23-34`) routes through the
  same `api()`, so it would not have helped — the report's claim holds.
- **Direct request (brief item 2):** auth header is the session's own
  `Basic …` (`src/zulip-client.ts:82`), same mechanism as `src/uploads.ts:162`
  and `src/tool-runtime.ts:933`; preferring `client.config.apiURL` preserves
  `/api`-suffixed realms and zuliprc-derived URLs. `URLSearchParams` sets
  `application/x-www-form-urlencoded;charset=UTF-8` and encodes Unicode and
  reserved characters correctly (asserted in the test). No timeout/abort signal —
  consistent with zulip-js, which has none either, so not a divergence.
  **No credential leakage:** the three thrown messages carry only the message id,
  HTTP status and the ignored-parameter list; `config.apiKey` is never read.
- **Path safety:** `encodeURIComponent(args.message_id)` escapes separators —
  probe case `traversal` sent `message_id: '42/../../../users/me'` and the server
  saw `/api/v1/messages/42%2F..%2F..%2F..%2Fusers%2Fme`, i.e. no endpoint pivot.
- **Tests exercise production code (brief item 4):** `test/editMessage.test.ts`
  imports the real `ZulipToolRuntime` and the real locked `zulip-js` against a
  local HTTP server and asserts method, path, exact form body, and
  `Authorization`; the `server.test.ts` case drives the real runtime through the
  MCP wire and asserts `isError`. Both fail on the base (`gate-red-edit-message`:
  3 of 4 fail; `gate-red-edit-wire`: missing `isError`). The wire test mocks
  `globalThis.fetch` rather than using a server, which is weaker but adequate for
  what it asserts.
- **Minimal / upstream style (brief item 5):** 20 lines in one `case`, no other
  handler touched, no dependency/lockfile/schema change. The `server.test.ts`
  edit is the minimum needed to inject a real runtime (`import type` → value
  import, one optional harness option). Direct-`fetch` precedent exists
  (`src/uploads.ts`, `src/index.ts:146`). Changelog fragment name and format match
  `changelog.d/README.md` (`<slug>.fixed.md`, flat, bullets, two-space
  continuation) and the text describes a user-visible change accurately.
- **Public-safe (brief item 6):** code comments, changelog and commit message
  contain only public technical facts. Test fixtures use `test@example.com`,
  `test-key`, `127.0.0.1`, `https://z.example.com`. No ledger, task-id,
  infrastructure or credential references.

## Unmet Criteria / test gaps

- Acceptance 1 (locate the mapping) — met: `src/tool-runtime.ts:707-713` on the
  base passed `{message_id, content}` to `messages.update`.
- Acceptance 2 (a test that the edit applies, or a proper error) — met at the
  wire level, with the LOW evidence gap above: no live-realm confirmation that an
  edit now takes effect.
- Acceptance 3 (fork fix, upstream PR) — commit exists locally; no push, no PR,
  which matches the public-push rule. A draft PR body is in the implementer
  report. Still outstanding, correctly.
- Test gaps: no case for a non-JSON / empty error body (MEDIUM 2); no case for a
  missing `content` (MEDIUM 1); no case for the `${realm}/api/v1` fallback or an
  `/api`-suffixed realm (LOW).

## Residual Risk

- The deployed-realm symptom may have a cause this PR does not address (LOW
  above). If the upstream maintainer can edit on a real realm, that is the one
  check worth adding before merge.
- Bypassing zulip-js for one call means this request no longer inherits any
  future fix or behaviour change in `lib/api.js`; the inline comment records why,
  which is the right mitigation.
- Three pre-existing `npm audit` findings (one low, two high) are unchanged by
  this commit — out of scope.

## Fix Directions

1. Guard `content`: `if (typeof args.content !== "string") throw new Error("content is required");` before the fetch, plus a test.
2. Make the failure path survive a non-JSON body: `await response.json().catch(() => null)`, check `!response.ok` before `assertApiSuccess`, and include the status (and a short body snippet) in the thrown message. Change the existing `HTTP 503` test to serve HTML rather than `{}`.
3. Optional: assert the `${realm}/api/v1` fallback once, so the API-prefix preference is pinned.
4. Optional: if more edit fields (topic, propagate_mode) are ever exposed, revisit the unsupported-parameter wording so it does not claim a refusal when the content edit applied.
