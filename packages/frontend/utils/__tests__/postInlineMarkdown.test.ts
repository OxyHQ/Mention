import { truncateInlineMarkdown } from '@oxy.so/bloom/markdown/inline';
import { parsePostInlineMarkdown, postMentionForLink } from '../postInlineMarkdown';

it('counts visible bold text and keeps the clipped mention linked to its identity', () => {
  const parsed = parsePostInlineMarkdown('**Mention**, [@Allo](allo) answers too');
  const preview = truncateInlineMarkdown(parsed.nodes, 11);
  expect(preview.isTruncated).toBe(true);
  expect(preview.nodes).toEqual([
    { type: 'strong', children: [{ type: 'text', value: 'Mention' }] },
    { type: 'text', value: ', ' },
    { type: 'link', url: 'allo', label: '@Allo', children: [{ type: 'text', value: 'Al…' }] },
  ]);
  expect(postMentionForLink(parsed.mentions, 'allo', '@Allo')?.value).toBe('allo');
});

it('keeps display names literal even when they contain Markdown', () => {
  const parsed = parsePostInlineMarkdown('[@**Alice**](alice)');
  expect(parsed.nodes).toEqual([
    {
      type: 'link',
      url: 'alice',
      label: '@**Alice**',
      children: [{ type: 'text', value: '**Alice**' }],
    },
  ]);
});

it('does not classify ordinary Markdown links as account mentions', () => {
  const parsed = parsePostInlineMarkdown('[Docs](https://example.com/docs)');
  expect(postMentionForLink(parsed.mentions, 'https://example.com/docs', 'Docs')).toBeUndefined();
});
