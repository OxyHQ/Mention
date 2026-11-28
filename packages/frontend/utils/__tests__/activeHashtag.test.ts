import { activeHashtag } from '../activeHashtag';

const at = (text: string) => activeHashtag(text.replace('|', ''), text.indexOf('|'));

it.each([
  ['#bar|', { start: 0, query: 'bar' }],
  ['hola #Català|', { start: 5, query: 'Català' }],
  ['(#art| more', { start: 1, query: 'art' }],
  ['line\n#next_1|', { start: 5, query: 'next_1' }],
])('finds the hashtag being typed in %j', (text, expected) => {
  expect(at(text)).toEqual(expected);
});

it.each([
  '|',
  '#|',
  '#2026|',
  'word#tag|',
  'https://example.com/#section|',
  '##tag|',
  '#ta|g',
  '#tag done|',
])('offers nothing for %j', (text) => {
  expect(at(text)).toBeNull();
});
