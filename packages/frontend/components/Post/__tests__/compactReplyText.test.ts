import { acceptsCompactReplyText, COMPACT_REPLY_TEXT_LIMIT } from '../compactReplyText';

it('accepts exactly 250 code units and rejects overflow, including a paste', () => {
  expect(COMPACT_REPLY_TEXT_LIMIT).toBe(250);
  expect(acceptsCompactReplyText('', 'a'.repeat(250))).toBe(true);
  expect(acceptsCompactReplyText('a'.repeat(250), 'a'.repeat(251))).toBe(false);
  expect(acceptsCompactReplyText('short', 'pasted '.repeat(50))).toBe(false);
});
it('allows replacement and deletion at the limit with the same Unicode count as full Compose', () => {
  const current = 'a'.repeat(248) + '😀';
  expect(acceptsCompactReplyText('', current)).toBe(true);
  expect(acceptsCompactReplyText(current, 'a'.repeat(248) + '🦋')).toBe(true);
  expect(acceptsCompactReplyText(current, current + 'x')).toBe(false);
  expect(acceptsCompactReplyText(current, current.slice(0, 248))).toBe(true);
});
it('does not truncate earlier longer drafts but rejects growth until they fit', () => {
  const prior = 'existing '.repeat(50);
  expect(acceptsCompactReplyText(prior, prior.slice(0, -1))).toBe(true);
  expect(acceptsCompactReplyText(prior, prior + 'x')).toBe(false);
  expect(acceptsCompactReplyText(prior, 'shorter')).toBe(true);
});
