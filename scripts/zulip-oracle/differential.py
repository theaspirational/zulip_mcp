"""Strict HTML surgery, not whitespace/ancestry-only comparison.

Allowed edits: replace a source table's literal inline HTML with its standalone
<table>, split <p> precisely at its boundaries (remove the boundary nl2br only),
and release swallowed trailing table rows as prose with identical inline HTML.
Everything else, including internal <br>, whitespace and block tags, is exact.
"""
import difflib
import json
import re
import sys
from functools import lru_cache
from lxml import etree, html
from renderer import render as uncached_render
from zerver.lib.markdown.fenced_code import FENCE_RE

render = lru_cache(maxsize=20000)(uncached_render)
BREAK = re.compile(r'\n[ \t]*\n(?:[ \t]*\n)*')

def paragraphs(source):
    # Fences are independent units, even without source blank boundaries. Use
    # Zulip's own opener regex; do not accidentally select a duplicate table
    # string inside an untouched fence elsewhere in the message.
    plain = []
    fence = None
    protected = []
    def split_plain():
        yield from (part.strip('\n') for part in BREAK.split('\n'.join(plain)))
    for line in source.split('\n'):
        if fence is not None:
            protected.append(line)
            if line.rstrip() == fence:
                yield '\n'.join(protected)
                protected = []
                fence = None
        elif (match := FENCE_RE.match(line)):
            yield from split_plain()
            plain = []
            fence = match['fence']
            protected = [line]
        else:
            plain.append(line)
    if protected:
        yield '\n'.join(protected)
    yield from split_plain()


def inner(node):
    return (node.text or '') + ''.join(etree.tostring(child, encoding='unicode', method='html') for child in node)


def splice_literal(original, raw, table):
    guarded = render('ORACLEGUARD\n' + raw + '\nORACLEEND')
    left, right = '<p>ORACLEGUARD<br>\n', '<br>\nORACLEEND</p>'
    assert guarded.startswith(left) and guarded.endswith(right), ('not literal inline table', raw, guarded)
    literal = guarded[len(left):-len(right)]
    # This exact match deliberately fails when a link/code/emphasis/block spans
    # the boundary. Only the two boundary breaks may disappear, never inner br.
    pattern = re.compile(r'(<p>|<br>\n)' + re.escape(literal) + r'(</p>|<br>\n)')
    def replacement(match):
        return ('' if match[1] == '<p>' else '</p>\n') + table + ('' if match[2] == '</p>' else '\n<p>')
    result, count = pattern.subn(replacement, original, count=1)
    assert count == 1, ('literal table not found at paragraph boundaries', raw, original)
    return result


def release_rows(paragraph, spans, old):
    """Already-rendered table: retain exact inline HTML of every non-table row.

    Source lines map one-to-one to tbody rows in TableProcessor.run. Additional
    candidate tables may occupy those rows; those alone may become new tables.
    """
    tree = html.fragment_fromstring(old, create_parent=True)
    assert len(tree) == 1 and tree[0].tag == 'table', ('not a single root table', old)
    rows = tree[0].findall('./tbody/tr')
    lines = paragraph.split('\n')
    assert len(rows) == max(1, len(lines) - 2), ('source/row mapping', paragraph, old)
    pieces = []
    position = 0
    for start, end, raw, table in spans + [(len(paragraph), len(paragraph), '', '')]:
        prose = paragraph[position:start].strip('\n')
        if prose:
            first_line = paragraph[:position].count('\n')
            # position is immediately after a candidate, before its newline.
            if position and paragraph[position:position+1] == '\n':
                first_line += 1
            prose_rows = rows[first_line - 2:first_line - 2 + len(prose.split('\n'))]
            assert len(prose_rows) == len(prose.split('\n'))
            inline = []
            for row in prose_rows:
                cells = list(row)
                assert all(inner(cell) == '' for cell in cells[1:]), ('lost non-padding cells', old)
                inline.append(inner(cells[0]))
            preserved = '<p>' + '<br>\n'.join(inline) + '</p>'
            assert render(prose) == preserved, ('non-table block/inline change', prose, preserved, render(prose))
            pieces.append(preserved)
        if raw:
            pieces.append(table)
        position = end
    return '\n'.join(pieces)


def redundant_fence_blanks(source, output, candidates):
    """Only new blanks immediately before real, unprotected fence openers.

    Fences split units even without blank lines. No table conversion is needed
    in this case; check() still requires a standalone table and exact whole HTML.
    """
    a, b = source.split('\n'), output.split('\n')
    openers = set()
    tables = {raw for raw, _ in candidates}
    plain = []
    fence = None
    for index, line in enumerate(a):
        if fence is not None:
            if line.rstrip() == fence:
                fence = None
        elif (match := FENCE_RE.match(line)):
            # The preceding independent source unit must itself be the table;
            # an unrelated table elsewhere cannot excuse a bogus candidate.
            if BREAK.split('\n'.join(plain))[-1].strip('\n') in tables:
                openers.add(index)
            plain = []
            fence = match['fence']
        else:
            plain.append(line)
    return all(kind == 'equal' or kind == 'insert' and a0 in openers and
               all(line == '' for line in b[b0:b1])
               for kind, a0, a1, b0, b1 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes())


def validate_blank_boundaries(source, output, starts, ends):
    """Account for every insertion, even alongside a legitimate conversion.

    Positions refer to independent output units proven to render as tables,
    never merely table-looking source or matching text inside a fence.
    """
    a, b = source.split('\n'), output.split('\n')
    for kind, a0, a1, b0, b1 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if kind == 'equal':
            continue
        assert (kind == 'insert' and b[b0:b1] == [''] and
                0 < a0 < len(a) and a[a0-1].strip(' \t') and a[a0].strip(' \t') and
                (b1 in starts or b0 in ends)), ('blank outside a missing table boundary', a0, b0, b1)


def check(case):
    source = case['input'].replace('\r\n', '\n')
    output = case['output'].replace('\r\n', '\n')
    before, after = render(source), render(output)
    assert case['idempotent'], ('not idempotent', case)
    if case['input'] == case['output']:
        assert before == after
        return False
    # Check byte edits independently, including original line endings.
    a, b = case['input'].splitlines(keepends=True), case['output'].splitlines(keepends=True)
    for kind, a0, a1, b0, b1 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        assert kind == 'equal' or kind == 'insert' and all(line in ['\n', '\r\n'] for line in b[b0:b1]), ('not insertion-only', case)
    candidates = []
    starts, ends = set(), set()
    position = 0
    for raw in paragraphs(output):
        start = output.find(raw, position)
        assert start >= position
        position = start + len(raw)
        rendered = render(raw)
        tree = html.fragment_fromstring(rendered or '<p></p>', create_parent=True)
        if len(tree) == 1 and tree[0].tag == 'table':
            candidates.append((raw, rendered))
            first_line = output[:start].count('\n')
            starts.add(first_line)
            ends.add(first_line + len(raw.split('\n')))
    assert candidates, ('no standalone table in changed output', case)
    validate_blank_boundaries(source, output, starts, ends)
    expected = before
    converted = 0
    output_paragraphs = set(paragraphs(output))
    for paragraph in paragraphs(source):
        if paragraph in output_paragraphs:
            continue
        spans = []
        position = 0
        for raw, table in candidates:
            start = paragraph.find(raw, position)
            if start < 0:
                continue
            end = start + len(raw)
            if (start and paragraph[start-1] != '\n') or (end < len(paragraph) and paragraph[end] != '\n'):
                continue
            spans.append((start, end, raw, table))
            position = end
        if not spans:
            continue
        old = render(paragraph)
        if old.startswith('<table>'):
            new = release_rows(paragraph, spans, old)
        else:
            new = old
            for _, _, raw, table in spans:
                new = splice_literal(new, raw, table)
        assert old in expected, ('paragraph context changed before normalization', paragraph, before)
        expected = expected.replace(old, new, 1)
        converted += len(spans)
    if not converted:
        assert before == after and redundant_fence_blanks(source, output, candidates), ('no conversions accounted for', case)
    assert expected == after, ('HTML differs beyond table/boundary surgery', before, expected, after)
    return True


def main():
    total = changed = failed = generated = prior = 0
    groups = {}
    for line in sys.stdin:
        case = json.loads(line)
        total += 1
        group = ('corpus_c' if case['name'].startswith('review-c-') else
                 'corpus_b' if case['name'].startswith('review-b-') else 'base')
        counts = groups.setdefault(group, dict(cases=0, changed=0, mismatches=0))
        counts['cases'] += 1
        generated += case['name'].startswith('generated')
        prior += case['name'].startswith('review-a-')
        try:
            accepted = check(case)
            changed += accepted
            counts['changed'] += accepted
        except (AssertionError, ValueError) as error:
            failed += 1
            counts['mismatches'] += 1
            print(json.dumps({'case': case, 'error': str(error)}, ensure_ascii=False))
    print(json.dumps({'cases': total, 'generated': generated, 'corpus_a_inputs': prior, 'changed': changed, 'mismatches': failed, 'corpora': groups}))
    assert generated >= 2000 and prior == 137 and groups['corpus_b']['cases'] == 2160 and groups['corpus_c']['cases'] == 11520 and changed >= 100 and failed == 0


if __name__ == '__main__':
    main()
