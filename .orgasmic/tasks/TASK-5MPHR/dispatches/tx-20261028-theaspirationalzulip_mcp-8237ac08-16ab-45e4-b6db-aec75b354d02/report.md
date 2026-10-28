# Review — TASK-5MPHR, round 2 (`46a6dacae42e8008e4b4cf1b952648016ef2e7d6`)

## Verdict

**Approve.** Both previous MEDIUMs are closed, verified on the production path, not only
in unit tests. No HIGH or MEDIUM findings. Three LOW findings, all optional for this PR;
the credential-redaction one (L1) is the only one I would consider fixing before merge,
since it is a two-token reorder.

Range reviewed: `e5c4b4c..46a6daca` as one upstream PR (4 files, +178/-5).

## Previous findings — closed

- **MEDIUM (1) missing content wrote `undefined`** — closed. `src/tool-runtime.ts:709`
  rejects non-string content before any request. Production probe: `{message_id: 42}` and
  `{message_id: 42, content: 123}` both return the MCP tool error `content is required`
  with **zero** HTTP requests recorded by the fake realm.
- **MEDIUM (2) `response.json()` before the status check lost non-JSON failures** — closed.
  `src/tool-runtime.ts:720-726` reads `text()`, tries `JSON.parse` in a `try`, and checks
  `response.ok` first (`:727`). Production probe: HTML 502 → `HTTP 502: Bad Gateway 502 Bad
  Gateway upstream failed; …` (211 chars total, snippet bounded); empty 502 → `HTTP 502`;
  JSON 400 → `HTTP 400: The time limit for editing this message has passed`.

New diagnostic path, checked as asked:
- **Snippet bounding**: `.slice(0, 160)` at `:733`; probe's 1.2 KB HTML body produced a
  211-char message. Confirmed bounded.
- **Markup stripping**: `<[^>]*>` → space, whitespace collapsed (`:733`). Confirmed.
- **Credential redaction**: the full `Basic …` header, the bare base64, and both decoded
  components (email, API key) are redacted (`:729-732`). Probe with a body echoing
  `Authorization: Basic <b64>` verbatim: redacted to `[redacted]`; no leak of base64, API
  key or bot email. One ordering gap, see L1.
- **Proportionality**: justified, not overbuilt. The hand-rolled `fetch` is necessary, not
  preference: `node_modules/zulip-js/lib/api.js:33-41` appends every param to the **query
  string** for any non-POST method and sends no body, so both `messages.update()` and
  `callEndpoint('/messages/42','PATCH',…)` reproduce the original
  `ignored_parameters_unsupported: message_id` bug. `~35` lines, one comment explaining why.
  `assertApiSuccess` is still reused for the 2xx-with-`result:error` shape.
- **Changelog fragment**: accurate and conformant. `changelog.d/edit-message-request.fixed.md`
  matches the `<slug>.<category>.md` flat-file rule in `changelog.d/README.md`, is bullets
  only (no headings/rules), and both bullets describe exactly what the code does.

## Findings

### LOW — security (credential disclosure) — `src/tool-runtime.ts:729-733`
Redaction runs **before** markup stripping, so a credential interleaved with markup escapes
redaction and is then partially reassembled by the strip. Failure scenario: a proxy that
echoes the request headers inside markup, e.g.
`echo: Basic <b>Ym90QGV4</b><i>YW1wbGUu…</i> key=<b>super</b>-secret-key`. Probe output
(`probe/probe-output.json`, scenario `markup-split cred`):
`HTTP 500: echo: Basic Ym90QGV4 YW1wbGUuY29tOnN1cGVyLXNlY3JldC1rZXk= key= super -secret-key`.
The tags become spaces, so the credential is space-mangled rather than verbatim — but it is
trivially rejoined by a reader of the error. Contrived enough to be LOW (a proxy must insert
markup *inside* the credential), and the normal case — a verbatim echoed header, the one
proxies actually produce — is correctly redacted. Fix direction: strip markup and collapse
whitespace *first*, then redact, then slice.

### LOW — correctness/UX — `src/tool-runtime.ts:709, 715`
`content` is validated but `message_id` is not, and nothing validates tool args against the
schema before `handleToolCall` (`src/server.ts:1374` calls it directly; `required:
["message_id","content"]` in `src/tools.ts:267` is advisory). A call missing `message_id`
issues `PATCH /api/v1/messages/undefined` — confirmed by probe (`probe2.mjs` output: path
`/api/v1/messages/undefined`, body `content=updated`). Against a real realm Zulip's int URL
converter misses and returns 404, so the model sees an opaque `HTTP 404` instead of a usable
message; against a lenient proxy the fake-realm run even returned a *success* envelope.
Fix direction: `if (!Number.isInteger(Number(args.message_id))) throw new Error("message_id
is required")` next to the content guard.

### LOW — diagnostics — `src/tool-runtime.ts:736-738`
The `result?.result !== "success"` branch throws `HTTP <status>` with **no** detail, so a
2xx response that is not a success envelope (an SSO interstitial or proxy page served with
200, a JSON body without `result`) loses exactly the diagnostics this round added for the
non-2xx side. Not reachable in the probe (needs a 200 + non-envelope body), so this is a
code-path observation, not a reproduced symptom. Fix direction: factor the
redact/strip/bound snippet into a small local helper and use it in both throw sites.

## Verification Gates

| Gate | Command | Result | Log |
| --- | --- | --- | --- |
| `review-edit-tests` (mine) | `node --import tsx --test test/editMessage.test.ts test/server.test.ts` | exit 0 — 56 pass, 0 fail | `gate-review-edit-tests-01M61KA2RPHA0VZPBT6SDYWYWN.log` |
| `round2-final-test` (reused) | `npm test` | exit 0 — 273 pass, 1 skip | implementer evidence |
| `round2-final-build` (reused) | `npm run build` | exit 0 (strict tsc) | implementer evidence |
| `round2-final-install` (reused) | `npm ci` | exit 0 | implementer evidence |

Production-path probe (not a gate; artifacts in `$ORGASMIC_EVIDENCE_DIR/probe/`): built
`build/index.js` spawned over stdio as a real MCP server against a fake Zulip realm on
loopback, driven through `initialize` + `tools/call edit_message`. Scenarios: success,
HTML 502, empty 502, JSON 400 with `msg`, missing content, non-string content, missing
`message_id`, markup-split credential. On success the realm recorded exactly
`PATCH /api/v1/messages/42`, body `content=updated+**body**+%26+%2B+%3D+%E2%9C%93`,
`content-type: application/x-www-form-urlencoded;charset=UTF-8` — the ID only in the path,
only `content` in the body, which is the acceptance criterion. Raw output:
`probe/probe-output.json`; scripts `probe/probe.mjs`, `probe/probe2.mjs`.

## Unmet criteria / test gaps

Acceptance criteria 1 and 2 are met (mapping located; fix plus tests that the edit request is
correct and that failures become proper errors). Criterion 3 (upstream PR) is correctly left
undone — the brief is read-only and public push needs the owner's go.

Test gaps, none blocking:
- No test for a 2xx response that is not a success envelope (the L3 path).
- No test for a missing/non-numeric `message_id` (L2).
- No test for a credential interleaved with markup (L1); the existing HTML test at
  `test/editMessage.test.ts:76` only covers the verbatim-echo case.
- `test/server.test.ts:341` mocks `globalThis.fetch` and separately stubs
  `client.messages.update`; the stub is vestigial — the runtime no longer calls it — so that
  test would still pass if the handler regressed back to `messages.update()`. The wire-level
  assertion it makes (MCP `isError` for `ignored_parameters_unsupported`) is still real, and
  `test/editMessage.test.ts` covers encoding against a real socket, so this is a tidiness
  note.

## Residual risk

- Nothing in this range is verified against a live Zulip realm; both the tests and my probe
  use loopback stand-ins. The request shape matches Zulip's documented
  `PATCH /api/v1/messages/{message_id}`, and the original defect's mechanism is confirmed in
  `zulip-js`'s own source, so the risk is that Zulip accepts the request but behaves
  differently than the stand-in — low, but only a real-realm edit closes it.
- `fetch` here has no timeout or abort (consistent with `src/uploads.ts:160`), so a hung
  proxy hangs the tool call.
- Error text can still carry arbitrary upstream content (bounded to 160 chars, markup
  stripped, known credentials redacted); unrelated secrets in a proxy's error page are not
  classifiable here.

## Fix directions (priority order)

1. Reorder `src/tool-runtime.ts:729-733`: strip markup + collapse whitespace, then redact,
   then `slice(0, 160)`. Add the markup-interleaved case to `test/editMessage.test.ts`.
2. Validate `message_id` alongside `content` at `src/tool-runtime.ts:709`.
3. Reuse the snippet helper in the `result?.result !== "success"` throw at `:737`.
4. Optional: drop the vestigial `client.messages.update` stub in `test/server.test.ts:345`.

Worktree left as found: clean at `46a6dacae42e8008e4b4cf1b952648016ef2e7d6`, no tracked-file
changes (only ignored `build/` output); all artifacts under `$ORGASMIC_EVIDENCE_DIR`.
