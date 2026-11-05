# Offline Zulip 12.3 oracle (development only)

The oracle imports **unmodified** `zerver/lib/markdown/__init__.py` and calls
`markdown_convert(content, no_previews=True)` -> `do_convert` -> `ZulipMarkdown`.
It uses the real selected block processors, custom list preprocessor and
`sane_lists` subclasses, Zulip `fenced_code`, tables, `nl2br`, inline processors,
codehilite, tree processors and postprocessors. No substitute Markdown engine.
Source: Zulip tag 12.3, b31982251ff82d0b02e59f63ad21f19204e37aea;
Python-Markdown 3.10.3, Django 5.2.17, Python 3.12.

All tooling/fixtures here are excluded by package.json's npm `files` allowlist.
The external source, wheels and virtual environment must stay outside the repository
and published package. There is no Python at runtime. `npm test` stays offline
and does not require this optional external fixture.

Zulip source attribution: Copyright Zulip contributors, licensed under Apache-2.0.
No Zulip source is included in this repository.

## Setup and reproduction

Use Node 22.23.3 and Python 3.12.3. From the repository root, choose an external
scratch directory (the example uses a temporary directory):

```bash
export ORACLE_WORK="$(mktemp -d)"
git clone --depth 1 --branch 12.3 https://github.com/zulip/zulip "$ORACLE_WORK/zulip"
export ZULIP_SRC="$ORACLE_WORK/zulip"
test "$(git -C "$ZULIP_SRC" rev-parse HEAD)" = b31982251ff82d0b02e59f63ad21f19204e37aea
python3 -m venv "$ORACLE_WORK/venv"
export ORACLE_PYTHON="$ORACLE_WORK/venv/bin/python"
"$ORACLE_PYTHON" -m pip install \
  markdown==3.10.3 django==5.2.17 lxml==6.1.1 google-re2==1.1.20251105 \
  pyahocorasick==2.3.1 pygments==2.21.0 tlds==2026072401 beautifulsoup4==4.15.0 \
  regex requests uri-template python-dateutil typing-extensions
```

The explicitly pinned versions above match Zulip's `uv.lock`. Required source
paths are `zerver/lib/**`, `version.py`, `pyproject.toml`, and `uv.lock`.
For an offline setup, transfer those paths from the verified commit and a
compatible wheelhouse, verify the transfer's SHA256 manifest, then install the
same dependencies with `pip install --no-index --find-links "$WHEELHOUSE" ...`.
Do not copy the source or wheels into this repository. Provision JavaScript
dependencies with `npm ci` before disconnecting.

Run the checks offline, with no Zulip credentials/configuration in the environment
(other than the source path above). The renderer forbids all socket connects,
including loopback. For the surrounding Node checks, allow loopback only.
Disable package-manager notifiers and network fetching:

```bash
export NO_UPDATE_NOTIFIER=1 npm_config_update_notifier=false npm_config_offline=true
export PYTHONDONTWRITEBYTECODE=1
"$ORACLE_PYTHON" scripts/zulip-oracle/proofs.py
"$ORACLE_PYTHON" scripts/zulip-oracle/selftest.py
node --import tsx scripts/zulip-oracle/corpus.mts > "$ORACLE_WORK/corpus.jsonl"
"$ORACLE_PYTHON" scripts/zulip-oracle/differential.py < "$ORACLE_WORK/corpus.jsonl"
node --import tsx scripts/zulip-oracle/performance.mts
```

On Linux with a user systemd instance, each check can be bounded with
`systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0`.
Expected results: 8 positive and 16 negative selftests; 19,166 differential cases,
4,075 changed and zero mismatches.

`proofs.py` proves the complaint: no preceding blank gives a literal paragraph
with `<br>`; no following blank lets prose become table rows; both blanks give a
`<table>` and separate paragraphs. It also proves fenced-code protection,
`nl2br`, two-space behavior, and **disabled setext headings**. Zulip has no
separate two-space hard-break inline processor: its newlines use `nl2br`.

## Every stub / configuration boundary

`renderer.py` lists every replacement explicitly; no catch-all MagicMock.
Unknown service calls fail rather than silently accepting them.

- Minimal Django settings: no apps/DB, file links/camo/previews off, generous
  message length limit; no change to parser registration or block rules.
- `zerver.models`: Message/Realm/UserProfile type shells. Calls use the supported
  no-message/no-realm path, so DB data is absent. Mention regexes and value
  dataclasses are **AST-extracted unchanged** from real `mention.py`; backend/data
  types are shells and display-name lookup raises. Real mention/stream/topic
  inline processors fall back to literal/no-match without DB data. Their
  registration and syntactic matching are not removed. URL encoding functions
  raise if unexpectedly called; topic display string is the real literal.
- Realm linkifiers return `[]`; realm emoji lookup raises; EmojiInfo and
  LinkifierDict are annotation-only dicts. These features only supply inline
  substitutions, not block recognizers. Custom realm linkifiers are not modeled.
- Emoji name/codepoint maps are empty and emoticon regex never matches;
  translation raises. Emoji source data is absent. Real emoji processors remain,
  with literal fallbacks (and the real special `:zulip:` case). Unicode helpers
  are real. Emoji are inline payloads, not paragraph/table/fence delimiters.
- `realm_playgrounds.PLAYGROUND_LANGUAGE_REGEX`: the model is absent from the
  sparse archive; a stand-in `[a-zA-Z0-9_+-]+` supplies its language-token regex.
  Tests that change messages accept only empty/simple alphabetic/alphanumeric
  labels supported by real Zulip (`text`, `md`, `info`, `spoiler`, `quote`, etc.).
  Arbitrary punctuation/header/indented opener syntax is refused by TypeScript.
  The real fence recognizer's anchors, delimiter runs, closing logic, handlers,
  quote/spoiler recursion and HTML stashing remain unchanged. The stand-in
  therefore cannot alter fence or table boundaries in an accepted change.
- Camo URL generation raises; subdomain classification returns false (no realm).
  HTTP sessions and socket connects raise. Previews are disabled by settings
  **and** `no_previews=True`; attachment lookup/rewriting raises. Thus optional
  preview blocks cannot be introduced; ordinary links use real processors.
- `render_tex` returns None (real error/literal payload fallback), because no
  KaTeX service is installed. Math contents are opaque to outer Markdown via
  the real HTML stash. Inline `$$` causes identity refusal; fenced math contents
  are never normalized. This affects math payload HTML, not surrounding block
  parsing or fence boundaries. No equivalence claim for successful KaTeX HTML.
- `MarkdownRenderingError` is a plain exception class. Timeout executes the real
  converter synchronously (external command ownership supplies resource limits).
  Both are error/control flow only, not parser substitutions.
- Timestamp timezone aliases are `{}` (numeric/time parsing is real); timestamp
  syntax outside fences is refused because of `<`. Types for attachments are
  shells; their methods are never called. Actual mime types, emoji utilities,
  per-request cache, URL-preview data classes and all Markdown modules are real.

These stubs bound the oracle to structural Markdown with DB-backed features
literal/disabled. They do not claim identical realm-specific inline decoration
or successful math/preview payloads. No stub replaces a table, paragraph, list,
heading, fence, whitespace, or linebreak processor. For unchanged messages,
identity is inherently safe regardless of stubbed feature behavior.

## Differential criterion / corpus

Both original and normalized messages pass through the oracle, even refusals.
Changes must be insertion-only blank lines (including exact LF/CRLF preservation),
idempotent, and produce standalone tables. HTML is compared **exactly**, not by
text with whitespace/paragraphs/void tags discarded. The only allowed surgery:

1. Replace the table source's original literal inline HTML with its standalone
   table HTML; split `<p>` exactly at those two boundaries, removing only the
   boundary `nl2br` breaks. Cross-boundary inline constructs fail the exact match.
2. If a table already rendered, map source lines to its actual `<tbody>` rows.
   Only identified source-table rows may become new tables. Swallowed prose may
   return to paragraphs only with identical inline HTML (including internal
   `<br>`); padding cells must be empty. Newly active block tags or whitespace
   changes fail. All other original HTML is retained byte-for-byte.

Every inserted blank is also checked at its exact output line position against
the start/end of an independent unit that actually renders as `<table>`. Only
one blank at a missing boundary is allowed; an existing blank cannot be padded.
This check runs regardless of how many other tables convert in the message.
Untouched fenced units are compared as complete original HTML, including when
identical table strings appear inside a fence and elsewhere. Selftests include
16 negative and 8 positive controls: line-ending replacement, lost internal
breaks, lazy-list membership, a newly active rule, multiline link, changed text,
prose whitespace, hash headers, Unicode non-boundaries, unrelated blank insertion,
and changes inside fences. Mixed-conversion controls include a heading
non-table followed by a quote fence (LF/CRLF), plus valid table/fence boundaries.
An already-rendered table may also gain a redundant blank immediately before
an independent, unprotected fence opener. That special case requires **exact
whole-message HTML equality**, insertion-only edits at actual opener positions,
and a standalone table immediately preceding that fence; it does not allow arbitrary whitespace changes or a
non-table candidate. The fence-boundary cases expose this checker limitation; three positive
and five negative controls lock down the narrow exception.

This deliberately rejects unmodeled complicated transformations rather than
silently weakening the comparison.

`corpus-a.json` preserves 137 source inputs with neutral case labels.
`corpus-b.json` contains 2,160 independent source inputs; `corpus-c.json.gz`
contains 11,520 more. The gzip is deterministic (mtime=0). Only labels have been
renamed; original inputs are preserved. Outputs and idempotence are recomputed
locally, never taken from fixture claims.

`corpus.mts` also includes shared helper/send/edit fixtures, unusual syntax,
invalid fence openers, and over 2,000 deterministic context/grammar combinations.
Coverage includes LF/CRLF, adjacent/single-column tables, escaped pipes,
malformed grammar, setext markers, hard breaks, lazy lists, multiline inline
constructs, container and quote/spoiler/math fences, and agent reports.
`performance.mts` checks seven 1 MiB inputs, including 131072 adjacent candidate
tables, without a size cutoff. The differential reports each corpus separately.

Residual limits: one Zulip version, finite corpus, no live server/database or
custom realm settings. The published TypeScript deliberately refuses complex
contexts; agents must still provide blanks in those messages.

### Inline-paragraph widening

The original 16,697 inputs remain in order. An additional 2,304 generated
agent-like messages combine code, links, resolved message URLs, multiline and
unmatched spans, adjacent tables, blank/fence isolation, and LF/CRLF; 165 targeted
inline fixtures are appended too. Total: 19,166 cases, 4,075 normalized, zero
mismatches. Against the original normalizer, 12 previously refused original
inputs and 1,872 added inputs now normalize (1,884 total); no prior normalization
is lost. `proofs.py` adds 24 exact-HTML checks that even unmatched code/link
openers cannot cross ASCII blank lines or complete fences in Zulip 12.3.

To reproduce coverage, save the original `src/markdown-tables.ts` outside the
repository as `baseline.mts`, generate the corpus with
`NORMALIZER_MODULE=file:///absolute/path/to/baseline.mts`, then compare that JSONL
with the current JSONL using `node scripts/zulip-oracle/coverage.mjs BEFORE AFTER`.
The baseline is commit `afcc0b34dbc2517500912c0274f12da8a7646c98`.
