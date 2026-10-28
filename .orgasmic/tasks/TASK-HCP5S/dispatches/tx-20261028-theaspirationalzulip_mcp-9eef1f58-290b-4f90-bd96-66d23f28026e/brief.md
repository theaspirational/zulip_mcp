PUBLIC repository and ledger: public technical facts only. No agent, host, person, company, realm or private-system names in code, tests, commits, changelog or report.

TASK-HCP5S = upstream issue antra-tess/zulip_mcp#34 (open): the rendered-HTML -> text path drops tag-shaped text. Zulip sends escaped entities (`&lt;MPID id=&quot;X&quot;/&gt;`) inside <pre><code>, inline <code> and <p>; the text renderer appears to unescape first and then strip anything tag-shaped, so `<MPID …/>`, `a < b and c > d`, `` `<…>` `` disappear. Affects incoming channel events, fetch_history, fetch_around and get_channel_history format "detailed". `format: "raw"` is intact.

Base: upstream main e5c4b4c01c63c100f5671fef86f74b23c72bbdcb. This becomes ONE upstream PR (reference #34), minimal and in upstream style (changelog.d convention).
1. Locate the HTML->text conversion (likely src/content.ts) and every caller on the listed paths; cite file:line. Explain the exact order bug.
2. Fix: translate/drop only real markup elements, and decode entities only after markup removal (or equivalent), so escaped text survives verbatim in code fences, inline code and paragraphs. Do not change raw format or unrelated rendering (mentions, links, images, emoji, quotes) except where the test proves current behaviour was wrong.
3. Tests: fixtures with Zulip-shaped rendered HTML for: fenced XML line, inline code `<…>`, paragraph `a < b and c > d`, `&amp;lt;` double-escape staying literal `&lt;`, and existing mention/link rendering unchanged. Cover the incoming-event path and a history path. Red on e5c4b4c, then green.
4. Gates: npm ci, npm run build, npm test; base vs final counts.
Commits on your branch, no push. Report a short public-safe draft PR title/description that says "Fixes #34".