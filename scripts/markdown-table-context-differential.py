"""Legacy stock-Markdown smoke check, NOT the Zulip safety oracle.

Use scripts/zulip-oracle/README.md for authoritative structural checks.
Compare non-table rendering: pipe node/tsx generator JSONL to stdin.

Requires offline Python-Markdown 3.10.3 with tables/fenced_code extensions.
Byte-identical refusals pass; changed cases compare marker-bounded prose text
and HTML ancestry, ignoring only paragraph boundaries and whitespace.
"""
import json
import sys
from html.parser import HTMLParser

import markdown


class Context(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.characters = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag not in ('br', 'hr', 'img', 'input'):
            self.stack.append((tag, tuple(attrs)))

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_data(self, data):
        ancestry = tuple(item for item in self.stack if item[0] != 'p')
        self.characters.extend((char, ancestry) for char in data)

    def prose(self):
        text = ''.join(char for char, _ in self.characters)
        result = []
        for start, end in [('CTXBEFORE', 'ENDBEFORE'), ('CTXAFTER', 'ENDAFTER')]:
            left = text.index(start)
            right = text.index(end, left) + len(end)
            result.append([(char, tags) for char, tags in self.characters[left:right] if not char.isspace()])
        return result


assert markdown.__version__ == '3.10.3', markdown.__version__
print('Python-Markdown', markdown.__version__, markdown.__file__)
total = changed = colon_changed = 0
for line in sys.stdin:
    case = json.loads(line)
    total += 1
    assert case['idempotent'], case
    if case['input'] == case['output']:
        continue
    changed += 1
    before = markdown.markdown(case['input'], extensions=['tables', 'fenced_code'])
    after = markdown.markdown(case['output'], extensions=['tables', 'fenced_code'])
    if 'CTXBEFORE' not in case['input']:
        # Shared helper/wire fixtures have exact expectations in the npm suite.
        continue
    assert Context(before).prose() == Context(after).prose(), (case, before, after)
    assert '<table>' in after, (case, after)
    if case['name'] == 'plain context Results:':
        colon_changed += 1
        print(json.dumps({'colon_evidence': case, 'before_html': before, 'after_html': after}))
assert changed > 20 and colon_changed >= 2, (changed, colon_changed)
print(json.dumps({'cases': total, 'changed': changed, 'colon_changed': colon_changed, 'mismatches': 0}))
