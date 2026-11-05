/** Emit cases for markdown-table-context-differential.py (offline Python-Markdown). */
import { normalizeMarkdownTables as normalize } from '../src/markdown-tables.ts';
import { contextTableCases } from '../test/markdownTableContextCases.ts';

function emit(name: string, input: string) {
  const output = normalize(input);
  console.log(JSON.stringify({ name, input, output, idempotent: normalize(output) === output }));
}
for (const [name, input] of contextTableCases) emit(name, input);
const constructs = [
  ['*', '*'], ['**', '**'], ['_', '_'], ['__', '__'], ['***', '***'],
  ['~~', '~~'], ['`', '`'], ['``', '``'], ['[', '](https://example.invalid)'],
  ['<span>', '</span>'], ['$', '$'], ['$$', '$$'], ['&', ';'], ['\\', '\\'],
  ['!', '!'], ['(', ')'], [':', ':'], ['', ''],
];
for (const [open, close] of constructs) {
  for (const gap of ['\n', '\nPlain line\n', '\n\n']) {
    for (const ending of ['\n', '\r\n']) {
      for (const table of ['a|b\n-|-', '|a|b|\n|-|-|\n|c|d|', '*a*|**b**\n-|-\n_c_|__d__']) {
        // The markers let the Python oracle compare text AND inline ancestry
        // of the actual surrounding content, ignoring only paragraph splitting.
        emit(`surround ${open} ${JSON.stringify(gap)}`, `${open}CTXBEFORE prefix ENDBEFORE${gap}${table}${gap}CTXAFTER suffix ENDAFTER${close}`.replaceAll('\n', ending));
      }
    }
  }
}
for (const prefix of ['Results:', ':', '::', ':status:', 'https://example.invalid/path',
  'Letters 123 . , ; ? \' " - / % # + = @', '💬 café']) {
  for (const gap of ['\n', '\nPlain line\n', '\n\n']) {
    emit('plain context ' + prefix, `CTXBEFORE ${prefix} ENDBEFORE${gap}a|b\n-|-\nc|d${gap}CTXAFTER Done. ENDAFTER`);
  }
}
