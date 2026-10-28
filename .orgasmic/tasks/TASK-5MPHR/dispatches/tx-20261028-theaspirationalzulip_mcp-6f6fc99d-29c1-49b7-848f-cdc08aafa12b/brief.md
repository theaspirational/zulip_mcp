PUBLIC repository and ledger: public technical facts only. No agent, host, person, company or private-system names in code, tests, commits, changelog or report.

TASK-5MPHR: `edit_message` ignores `message_id`. Reported behaviour: the tool returns success, but the Zulip response contains `ignored_parameters_unsupported: ["message_id"]` and the edit never applies. Likely cause: the client sends message_id as a body/query parameter to the wrong endpoint or with the wrong name; Zulip's edit endpoint is PATCH /api/v1/messages/{message_id} with the id in the path (https://zulip.com/api/update-message).

Base: upstream main e5c4b4c01c63c100f5671fef86f74b23c72bbdcb (fork main is identical). This fix becomes ONE upstream PR to antra-tess/zulip_mcp, so keep it minimal and in upstream's style (read CONTRIBUTING/README and any changelog convention).
1. Locate the edit_message implementation and its parameter mapping; cite file:line.
2. Fix so the id goes in the path and only supported fields (content, topic, propagate_mode, etc. as the tool exposes) go in the body. If Zulip reports ignored_parameters_unsupported for anything, surface that as a tool error rather than success.
3. Tests: a test with a fake HTTP/Zulip client asserting the exact method, path and body; and a test that an ignored_parameters_unsupported response is reported as failure. Show red on e5c4b4c, then green.
4. Gates: install with the lockfile, build, typecheck if present, full test suite; report counts base vs final.
One or a few small commits on your branch, no push. Report a draft PR title and description (public-safe, short: problem, cause, fix, tests).