"""Negative controls: the differential must not hide non-boundary changes."""
from differential import check
T = 'a|b\n-|-\nc|d'

def case(source, output):
    return dict(input=source, output=output, idempotent=True)

check(case('Intro\n' + T + '\nAfter', 'Intro\n\n' + T + '\n\nAfter'))
check(case(T + '\nAfter\nLast', T + '\n\nAfter\nLast'))
check(case('Intro\n' + T + '\nHeading\n===', 'Intro\n\n' + T + '\n\nHeading\n==='))
# No-op fence cases are checker limitations, not bad HTML.
for kind in ['quote', 'spoiler', 'math']:
    source = 'Lead\n\n' + T + '\n~~~' + kind + '\nopaque\n~~~'
    check(case(source, source.replace('\n~~~' + kind, '\n\n~~~' + kind)))
# A real conversion and the narrow fence exception can coexist (LF/CRLF).
mixed = 'Lead\n' + T + '\nTail\n\n'
converted = 'Lead\n\n' + T + '\n\nTail\n\n'
for ending in ['\n', '\r\n']:
    check(case((mixed + T + '\n~~~quote\nq\n~~~').replace('\n', ending),
               (converted + T + '\n\n~~~quote\nq\n~~~').replace('\n', ending)))
invalid = [
    # A conversion must not excuse an unrelated
    # blank before a quote fence after a hash-heading non-table.
    case(mixed + '# a|b\n-|-\nc|d\n~~~quote\nq\n~~~',
         converted + '# a|b\n-|-\nc|d\n\n~~~quote\nq\n~~~'),
    case((mixed + '# a|b\n-|-\nc|d\n~~~quote\nq\n~~~').replace('\n', '\r\n'),
         (converted + '# a|b\n-|-\nc|d\n\n~~~quote\nq\n~~~').replace('\n', '\r\n')),
    case(mixed + 'text\n\nmore', converted + 'text\n\n\nmore'),
    case(mixed + '~~~\n' + T + '\n~~~', converted + '~~~\n\n' + T + '\n~~~'),
    case(T + '\n\n# a|b\n-|-\nc|d\n~~~quote\nq\n~~~',
         T + '\n\n# a|b\n-|-\nc|d\n\n~~~quote\nq\n~~~'),
    # An unchanged rendering does NOT excuse a bogus heading candidate.
    case('Lead\n# a|b\n-|-\nc|d\n~~~quote\nq\n~~~',
         'Lead\n\n# a|b\n-|-\nc|d\n\n~~~quote\nq\n~~~'),
    case('Lead\n\n' + T + '\n\ntext', 'Lead\n\n' + T + '\n\n\ntext'),
    case(T + '\n~~~\ncode\n~~~', T + '\n~~~\n\ncode\n~~~'),
    case('\u00a0\n' + T + '\nTail', '\u00a0\n' + T + '\n\nTail'),
    case(('Intro\n' + T + '\nAfter'), ('Intro\n' + T + '\nAfter').replace('\n', '\r\n')),
    case('Intro\nMore\n' + T + '\nAfter', 'Intro\n\nMore\n\n' + T + '\n\nAfter'),
    case('1. item\ncontinuation\n' + T + '\nAfter', '1. item\ncontinuation\n\n' + T + '\n\nAfter'),
    case(T + '\nHeading\n---', T + '\n\nHeading\n---'),
    case('[label\n' + T + '\nend](https://example.invalid)', '[label\n\n' + T + '\n\nend](https://example.invalid)'),
    case('Intro\n' + T + '\nAfter', 'Changed\n\n' + T + '\n\nAfter'),
    case(T + '\nDone.  \nMore', T + '\n\nDone.  \nMore'),
]
for candidate in invalid:
    try:
        check(candidate)
    except AssertionError:
        pass
    else:
        raise AssertionError(('differential accepted an invalid change', candidate))
print('Differential selftest: 8 positive, 16 negative controls PASS (including mixed conversions and internal br)')
