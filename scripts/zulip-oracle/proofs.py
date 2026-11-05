import json
from renderer import render

T = '| A | B |\n| --- | --- |\n| 1 | 2 |'
cases = {
    'missing both': 'Intro\n' + T + '\nOutro',
    'missing before': 'Intro\n' + T + '\n\nOutro',
    'missing after': 'Intro\n\n' + T + '\nOutro',
    'separated': 'Intro\n\n' + T + '\n\nOutro',
    'fence': '```\n' + T + '\n```',
    'nl2br': 'First\nSecond',
    'setext disabled': 'Heading\n===',
    'two spaces': 'First  \nSecond',
}
for name, source in cases.items():
    html = render(source)
    print(json.dumps(dict(name=name, input=source, html=html)))
    if name.startswith('missing b'):
        assert '<table>' not in html
    if name == 'missing after':
        assert '<td>Outro</td>' in html
    if name == 'separated':
        assert '<table>' in html and '<p>Outro</p>' in html
    if name == 'fence':
        assert '<table>' not in html and '<pre>' in html
    if name in ['nl2br', 'two spaces']:
        assert '<br>' in html
    if name == 'setext disabled':
        assert '<h1>' not in html and '<br>' in html
print('Zulip 12.3 markdown_convert proofs: PASS')

# Inline spans are scoped to Zulip blocks, not balanced across the message.
# Assert exact surrounding HTML, including unmatched delimiters and line breaks.
span_proofs = 0
for left, right in [('`open', 'close`'), ('``open', 'close``'),
                    ('[open', 'close](https://example.invalid)'),
                    ('[open](', 'https://example.invalid)')]:
    for gap in ['\n\n', '\n \t\n', '\n~~~text\nopaque\n~~~\n']:
        for ending in ['\n', '\r\n']:
            source = (left + gap + T + gap + right).replace('\n', ending)
            expected = render(left) + '\n'
            if '~~~' in gap:
                expected += render('~~~text\nopaque\n~~~') + '\n'
            expected += render(T) + '\n'
            if '~~~' in gap:
                expected += render('~~~text\nopaque\n~~~') + '\n'
            expected += render(right)
            assert render(source) == expected, (left, gap, ending, render(source))
            span_proofs += 1
print(f'Inline paragraph/fence isolation: {span_proofs} exact-HTML proofs PASS')
