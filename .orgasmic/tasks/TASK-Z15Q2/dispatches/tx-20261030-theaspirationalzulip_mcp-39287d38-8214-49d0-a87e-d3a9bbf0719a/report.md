# Implementation report

## Changed

- Local commit: `678956b8a44b6d48c00c970e63bfa45d7e038dd1`.
- Parent/upstream base: `e5c4b4c01c63c100f5671fef86f74b23c72bbdcb`, directly from `antra-tess/zulip_mcp` main, not fork main. `git ls-remote https://github.com/antra-tess/zulip_mcp refs/heads/main` returned that same SHA before work and after final gates; no rebase needed. See `upstream-start.txt` and `upstream-end.txt`.
- Author and committer: Vasyl Dovhanchyn <48733736+theaspirational@users.noreply.github.com>. Required GPT-6-Astra co-author trailer present. Worktree clean. No push or PR creation.
- `src/history.ts`: identity-aware sender matching and exactly one `chat:from-self` tag. Numeric authenticated profile ID is authoritative, including when the sender email matches but the ID differs. Only without that ID is exact nonempty email equality used. An unknown identity/sender is not tagged; the state/session key is never treated as identity.
- `src/zulip-client.ts`, `src/index.ts`: carry authenticated profile email, falling back to the resolved login email already obtained from zulip-js config/environment/zuliprc, into the adapter. Identity ID comes from **the startup profile**, not registration. Existing registration handling is unchanged.
- `src/platforms/zulip.ts`, `src/platforms/adapter.ts`, `src/server.ts`: identify cached/fetched message authors on edits/moves/deletions, identify reaction actors independently of target authors, preserve self tags in replay, and tag aggregate missed blocks only if all selected messages are self-authored. Existing ID-based suppression remains intact.
- `src/feature-sets.ts`, `README.md`, `changelog.d/own-message-tags.added.md`: advertise/document the tag, fallback, suppression, catch-up and reaction semantics.
- Tests: `test/history.test.ts`, `test/manifest.test.ts`, `test/zulipAdapter.test.ts`, `test/server.test.ts`, new `test/zulipClient.test.ts`. The existing fake history client's DM narrow parser now recognizes the object-shaped narrow actually sent by production, so the new DM history check is realistic.
- `chat:from-bot` classification is unchanged (the existing `-bot@` email heuristic). Own bot messages can carry both `chat:from-bot` and `chat:from-self`; own human-account messages can carry `chat:from-human` and `chat:from-self`.
- No dependency/lockfile changes. Builds populated ignored `build/` and `node_modules/`, not evidence. Baseline project instructions read; no conventions/gotchas or applicable AGENTS.md were supplied/found.

### Important upstream finding: suppression already exists

With a successful profile lookup, upstream drops own live messages before the server sees them and excludes own history rows before backscroll/recovery. The tag adds defense for the remaining emission paths; it does **not** newly forward messages that were already suppressed.

The startup sequence awaits `initializeZulipClient()` before constructing the adapter/server. There is no late-profile startup race in this revision. The profile is fetched once: failure or a response without numeric `user_id` leaves `selfUserId = null` for the adapter's lifetime. Registration/re-registration does not update it, and host reconnects reuse the adapter. Thus profile failure can explain own-post echoes across live, backscroll and catch-up paths, but this is a demonstrated possibility, **not a confirmed diagnosis of the reported deployment**.

#### Emission-path audit

All delivery remains subject to existing allowlists, muting, feature grants and visibility rules.

| Path / condition | Suppressed upstream? | Now tagged? | Test / evidence |
|---|---|---|---|
| Own live stream or DM; profile ID known | Yes, after caching, before `onMessage` | No emitted event; shared converter would tag it | Adapter `live and history retain existing suppression (identity 790)`; history `own stream` / `own DM` |
| Own live stream or DM; profile ID absent | No, if normal filters permit | Yes with matching authenticated email; no tag without usable identity | Adapter same test `(identity null)`; history unknown identity/sender and email precedence cases |
| Open-channel delivery, including ambient messages and host channel-mode/debounced handling | Adapter suppression applies before routing; server does not independently suppress self | Incoming tags survive attribution, attachments and batching | Wire `survives live incoming, closed pushes, backscroll and recovered delivery`; routing inspection in `src/server.ts` |
| Closed stream mention or closed/new DM | Same adapter suppression; closed ambient stream messages are tallied, not pushed | Forwarded messages preserve the self tag | Same wire test for closed mention; adapter own-DM test; existing new-DM wire test; `route` / `pushEvent` inspection |
| `channels/open` backscroll | Known-ID own rows excluded; unknown-ID rows allowed | Email-fallback own rows tagged; `history` response preserves tags | Adapter stream/DM history matrix and wire backscroll assertion |
| Open-channel gap recovery / held-message replay | Uses the same filtered adapter history | Individual self tags preserved alongside `zulip:missed` | Wire recovered delivery test; existing held replay tests; `replayOnOpen` inspection |
| Closed reconnect catch-up / closed gap recovery | Known-ID own rows excluded; otherwise normal missed selection applies | Aggregate tag only when **every selected row** is self; mixed/unknown authors never produce an aggregate self tag | Two wire `closed missed block` cases; existing reconnect sweep test; both paths call `catchUpClosedChannel` |
| Pre-live registration/reconnect buffer | Adapter suppression has already run; no separate identity race | Original tags retained in the buffer and replay | `onIncoming` / `route` inspection; existing pre-live and reconnect tests |
| Edit/move performed by own known-ID account | Yes, by change actor ID, regardless of original author | No event | Existing adapter edit suppression test retained |
| Another user's edit/move of an own message (cache or GET placement) | Intentionally not suppressed | Yes, based on original message author, not moderator/editor; email fallback works too | Adapter `changes use message authors, reactions use actors` for both identity states; wire edit/move/deletion test |
| Deletion of known own message by others | Not suppressed when placed from cache | Yes; actor often unavailable, original author known | Same adapter/wire tests |
| Own deletion through delete tool / rollback | Existing bounded local self-deletion suppression | No event while suppression applies | Existing own-deletions adapter test retained |
| Deletion without cached author | May emit stream-only marker; unknown deleted DM cannot be placed | No self tag; no sender is invented | Existing uncached/bulk deletion adapter tests and unknown-identity unit cases |
| Own reaction add/remove; profile ID known | Yes, by reactor ID | No event | Adapter actor tests |
| Own reaction add/remove; profile ID absent | No (with opt-in visibility) | Yes only if reactor email identifies self; missing reactor identity stays untagged | Adapter actor tests plus wire reaction add/remove assertions |
| Someone else reacts to an own message | No, with opt-in visibility | **Not** from self: target ownership is distinct from who reacted | Same adapter/wire reaction tests |
| Context-before-inference and history tools | Own turns intentionally retained | Not applicable: text context/tool results, not incoming/push message events | Existing context/history tests; `fetchContext` and tool `formatted_history` inspection |
| Queue gap/system markers | Not author-bearing message events | No self tag | Wire recovered-delivery test explicitly checks the gap marker |

Reaction semantics follow who acted, consistent with the [github-mcpl README tag table](https://github.com/anima-research/github-mcpl/blob/main/README.md). They do not infer self from a reaction's target. Changes follow the original author because that is the sender of the message-shaped marker in this connector; README documents this distinction.

#### Reproduced fail-open path

`test/zulipClient.test.ts` uses the **real zulip-js client and production initializer** against a local HTTP fixture. `/users/me` answers `{result: 'error', msg: 'profile unavailable'}`; `/messages` returns an own-authored stream message. Initialization succeeds with null ID. `ZulipAdapter.fetchHistory` returns the own row, now with `chat:ambient`, `chat:from-bot`, `chat:from-self`. A successful profile ID makes that same row disappear; a profile email without ID supplies the fallback instead of the login email. The adapter event-loop test separately reproduces live stream and DM echoes with null ID.

This is upstream's documented fail-open behavior, not a newly introduced suppression regression. No path bypassing successful known-ID live/history suppression was found. No suppression redesign, ID-refresh mechanism or host-policy change was added.

## Verification Gates

All gates ran through `orgasmic dispatch gate`. Full base/head gates ran with this exact command form, substituting the indicated gate name and Node path:

```sh
orgasmic dispatch gate NAME -- env XDG_RUNTIME_DIR=/run/user/1002 PATH=NODE_BIN:$PATH \
  systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0 \
  bash -c 'node --version && npm ci && npm run build && npm test'
```

Each log records its clean HEAD, actual Node version, systemd scope/invocation and exit. `npm ci` also runs the repository's prepare build; the explicit build was still run as requested. Gate wrappers own their command sessions; each was awaited to completion, with no concurrent installs.

| Gate | Commit | Node bin | Result | Durable log |
|---|---|---|---|---|
| base-node-22-23-3 | e5c4b4c | `/opt/node/bin` (22.23.3) | Pass: 266 passed, 1 skipped, 0 failed | `gate-base-node-22-23-3-01M66HFJ1M1KC1RXVPG8TKNMKS.log` |
| base-node-22-12-0 | e5c4b4c | `/tmp/credential-engines/node-v22.12.0-linux-x64/bin` (22.12.0) | Pass: 266 passed, 1 skipped, 0 failed | `gate-base-node-22-12-0-01M66HGXW95H5V4R9Z24E9A7P8.log` |
| head-node-22-23-3 | 678956b | `/opt/node/bin` (22.23.3) | Pass: 288 passed, 1 skipped, 0 failed | `gate-head-node-22-23-3-01M66HW7BKBCJP0EY4P4JF3GD6.log` |
| head-node-22-12-0 | 678956b | `/tmp/credential-engines/node-v22.12.0-linux-x64/bin` (22.12.0) | Pass: 288 passed, 1 skipped, 0 failed | `gate-head-node-22-12-0-01M66HX0FBGTVVYCGAMME4093J.log` |

The single skip is the existing off-Linux local-files test, skipped on Linux. All four full receipts were recorded reusable on clean trees. `git diff --check` passed before commit.

### Red-before / green-after

Before production edits, new tests ran on upstream implementation:

```sh
orgasmic dispatch gate red-self-tags -- env XDG_RUNTIME_DIR=/run/user/1002 PATH=/opt/node/bin:$PATH \
  systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0 \
  node --import tsx --test test/history.test.ts test/zulipAdapter.test.ts test/manifest.test.ts test/server.test.ts
```

`gate-red-self-tags-01M66HKMHMRFEG58X43BR12HQ0.log`: expected exit 1, 87 passed / 6 failed. Failures were own stream, own DM, email fallback, declaration, own-message deletion marker, and null-ID live adapter emissions.

After implementation, `green-self-tags` initially found three **new fixture mistakes**, not production failures: the old fake DM history client ignored object-form narrows, and new edit fixtures omitted Zulip's required `orig_content`. Corrected the fixtures. Both attempts are preserved (`gate-green-self-tags-01M66HPV8GX0SVR1CHNRJZW9MN.log`, `gate-green-self-tags-fixed-01M66HRMRCAMMSYJQRZN0AYAS4.log`). The corrected build + same four test files passed 99/99. The additional real-HTTP bootstrap probe passed 3/3 (`gate-self-bootstrap-probe-01M66HTECGV9HDPVEENNGGDNTA.log`). Final clean-commit full gates include all of them.

Other evidence: `change.patch`, `commit.txt`, `identity-paths.txt`, and matching `*.console.log` transcripts. All paths above are relative to this report's evidence directory.

## Unmet Criteria

None for this implementation dispatch. The owner explicitly confirmed that Opus review is a manager-owned stage after this report, not a prerequisite here. Review remains pending. Push/PR creation was explicitly prohibited and has not occurred.

## Residual Risk

- No live Zulip deployment or live host wake policy was exercised. Fake event queues, real Zulip client HTTP fixtures and in-memory production MCPL framing establish connector behavior, not the reported deployment's root cause.
- With neither profile ID nor matching authoritative email, the connector cannot safely identify self and leaves events untagged. Missing reactor email likewise prevents fallback classification. Profile identity is not refreshed during reconnect; the existing unavailable-ID DM channel-key behavior is unchanged.
- Mixed-author catch-up blocks intentionally stay untagged, so their self-authored lines can still be present when another author's message causes a wake. Context injection/tool history likewise intentionally retain own text.
- Host policies must explicitly exclude `chat:from-self`; this change supplies tags but does not alter wake rules. Excluding it also excludes another user's edit/move/deletion marker attributed to the bot's original message, as documented.
- `npm ci` reports the same pre-existing dependency audit result on base and head: 3 vulnerabilities (1 low, 2 high). Dependency remediation is outside scope; lockfile unchanged.

BEGIN PR BODY
## Summary
- Declare `chat:from-self` and identify own message events by profile user ID, using authenticated email only when the ID is unavailable.
- Preserve existing own-message suppression and `chat:from-bot` semantics. Tag remaining echoes, known-author changes and recovered delivery; never mark mixed-author catch-up blocks as self.
- Classify reaction echoes by who reacted, not who authored the target message. Document host filtering and fallback behavior.

## Verification
- Regression tests demonstrated failures before the change and pass afterward.
- `npm ci`, build and full tests pass on upstream base and this change with Node 22.23.3 and 22.12.0 under a 16 GiB systemd memory limit.
- Head: 288 passed, 1 platform-specific skip, 0 failed on each version; includes real-client HTTP identity/failure probes and MCPL wire tests.

Upstream main remains `e5c4b4c01c63c100f5671fef86f74b23c72bbdcb`.
END PR BODY
