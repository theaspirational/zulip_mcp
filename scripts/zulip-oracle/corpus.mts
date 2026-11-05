/** Deterministic source inputs, not expected output from the normalizer. */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { normalizeMarkdownTables } from '../../src/markdown-tables.ts';
import { reviewTableCases } from '../../test/markdownTableCases.ts';
const module = process.env.NORMALIZER_MODULE;
const normalize = module ? (await import(module)).normalizeMarkdownTables : normalizeMarkdownTables;
function emit(name: string, input: string) {
  const output = normalize(input);
  console.log(JSON.stringify({name, input, output, idempotent: normalize(output) === output}));
}
for (const {name, input} of JSON.parse(readFileSync(new URL('./corpus-a.json', import.meta.url), 'utf8'))) emit(name, input);
for (const [name, input] of reviewTableCases) emit('unit: ' + name, input);
const contexts = [
  ['', ''], ['Intro', 'After'], ['First\nSecond', 'Next\nLast'],
  ['Results:', 'Done.'],
  [':emoji:', 'Done'], ['Intro', ':zulip:'], ['https://example.invalid/path', 'Done'],
  ['Intro', '-'], ['Intro', '='], ['A\tB', 'After'], ['Intro', 'After\u00a0'],
  ['Intro', 'After '], ['Paragraph', '**Other paragraph**\n\nDone'],
  ['Intro', 'More\n# Heading'], ['Intro', '@**user**'],
 ['Intro', 'After\nFinal'], ['Summary  ', 'Done'], ['Intro', '# Next'], ['Intro  ', 'After'], ['Intro', 'Heading\n==='],
  ['Intro', 'Heading\n---'], ['1. item\ncontinuation', 'After'],
  ['+ item\ncontinuation', 'After'], ['- item\n# Heading', 'After'],
  ['> quote\ncontinuation', 'After'], ['    code\ncontinuation', 'After'],
  ['*prefix', 'end*'], ['**prefix', 'end**'], ['_prefix', 'end_'],
  ['~~prefix', 'end~~'], ['prefix `', 'end`'], ['[label', 'end](https://example.invalid)'],
  ['- ```\ncode', '```'], ['> ```', '> ```'], ['# Heading', '# Next'],
  ['---', '---'], ['===', '==='], ['💬 café', 'fin 🎉'],
  ['Intro\n\n*Other paragraph*\n\nSummary', 'Done\n\n- item'],
  ['~~~text\nliteral code\n~~~\n\nSummary', 'Done'],
  ['````\n- ````\n\nIntro', 'After\n````'],
  ['~~~quote\nIntro', 'After\n~~~'],
  ['~~~spoiler Details\nIntro', 'After\n~~~'],
  ['#**stream**', '@**user**'], ['Intro', 'Done.  \nMore'],
];
const tables = [
  'a|b\n-|-\nc|d', '| a | b |\n|---|:--:|\n| c | d |',
  'a|b\n:|:', 'a|b\n--- ---|---', '|a|\n|:|\n|b|',
  '*a*|**b**\n-|-\n_c_|__d__', '*a|b*\n-|-',
  String.raw`a\|b|c`+'\n-|-\nc|d', 'a|b\n---',
  'a|b|c\n-|-', 'a|b\n-|-\nc|d\ne|f',
  'a|b\n-|-\nc|d\na|b\n-|-\nc|d',
];
for (const [before, after] of contexts) for (const table of tables)
  for (const gap of ['\n', '\n\n']) for (const ending of ['\n', '\r\n']) {
    emit('generated context ' + JSON.stringify([before, after, table, gap, ending]),
      [before, table, after].filter(x => x !== '').join(gap).replaceAll('\n', ending));
  }

for (const token of [':emoji:', '/me waves', '{foo}', '1. item', '+ item', '@_**user**',
  '@**user**', '#**stream**', '![alt](url)', '&amp;', '[^1]', '*[ABC]: full',
  '===', '---', '-', '=', '**a** b**|c**', '**a** b**|c', 'a|b  ']) {
  for (const ending of ['\n', '\r\n']) emit('unusual syntax: ' + token,
    ('Intro\na|b\n-|-\nc|d\n' + token).replaceAll('\n', ending));
}
// Independent table-grammar cross product, in real surrounding paragraphs.
for (const header of ['|', '||', 'a|', '|a', 'a||b', String.raw`a\|b`,
  String.raw`a\\|b`, String.raw`a|b\|`, 'a | b |', '|a|b|', 'a|b|c']) {
  for (const separator of ['|', '||', ':|:', '-|-', '|-|-|', '---', ':',
    '--- ---|---', '---|', '|---', '|:|', '-|-|-']) {
    emit('generated grammar', `Intro\n${header}\n${separator}\nAfter`);
  }
}

for (const open of ['~~~!', '~~~text`', '~~~text~', '```{', '~~~ invalid~', '~~~\ttext']) {
  emit('invalid fence opener', `${open}\nopaque\n~~~\nIntro\na|b\n-|-\nAfter`);
}

// Independent 2160-input corpus: recompute all outputs locally.
for (const {name, input} of JSON.parse(readFileSync(new URL('./corpus-b.json', import.meta.url), 'utf8'))) emit(name, input);

// Independent 11,520 source inputs; recompute outputs locally.
for (const {name, input} of JSON.parse(gunzipSync(readFileSync(new URL('./corpus-c.json.gz', import.meta.url))).toString('utf8'))) emit(name, input);
