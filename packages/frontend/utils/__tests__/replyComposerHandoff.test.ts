import {
  consumeReplyComposerHandoff,
  createReplyComposerHandoff,
  discardReplyComposerHandoff,
} from '../replyComposerHandoff';
import type { ComposerMediaItem } from '../composeUtils';

const scope = { viewerId: 'viewer-a', epoch: 4, replyToPostId: 'parent-a' };
const input = { ...scope, sourceId: 'main:/post/parent-a', text: 'hello', revision: 7 };

it('preserves all text exactly and acknowledges the original revision only after acceptance', () => {
  const text = `  <literal>\n${'long reply '.repeat(120)}\n 🦋  `;
  const onClaim = jest.fn();
  const token = createReplyComposerHandoff({ ...input, text, onClaim })!;
  const received = consumeReplyComposerHandoff(token, scope)!;
  expect(received).toMatchObject({ text, revision: 7, sourceId: input.sourceId });
  expect(onClaim).not.toHaveBeenCalled();
  expect(consumeReplyComposerHandoff(token, scope)).toBeUndefined();
  expect(received.acknowledge(scope)).toBe(true);
  expect(received.acknowledge(scope)).toBe(false);
  expect(onClaim).toHaveBeenCalledTimes(1);
});

it.each([
  { viewerId: 'viewer-b' },
  { epoch: 6 },
  { replyToPostId: 'other-parent' },
])('rejects a different scope without consuming or clearing the source: %o', (change) => {
  const onClaim = jest.fn();
  const token = createReplyComposerHandoff({ ...input, onClaim })!;
  const wrong = { ...scope, ...change };
  expect(consumeReplyComposerHandoff(token, wrong)).toBeUndefined();
  expect(discardReplyComposerHandoff(token, wrong)).toBe(false);
  const received = consumeReplyComposerHandoff(token, scope)!;
  expect(received.acknowledge(wrong)).toBe(false);
  expect(onClaim).not.toHaveBeenCalled();
  expect(received.acknowledge(scope)).toBe(true);
});

it('cannot transfer an in-flight publication and keeps failed navigation unclaimed', () => {
  const onClaim = jest.fn();
  expect(createReplyComposerHandoff({ ...input, pending: true, onClaim })).toBeUndefined();
  const token = createReplyComposerHandoff({ ...input, onClaim })!;
  expect(discardReplyComposerHandoff(token, scope)).toBe(true);
  expect(consumeReplyComposerHandoff(token, scope)).toBeUndefined();
  expect(onClaim).not.toHaveBeenCalled();
});

it('replaces a source snapshot while keeping independent Deck sources isolated', () => {
  const first = createReplyComposerHandoff(input)!;
  const other = createReplyComposerHandoff({ ...input, sourceId: 'deck-2:/post/parent-a' })!;
  const latest = createReplyComposerHandoff({ ...input, text: 'new edit', revision: 8 })!;
  expect(consumeReplyComposerHandoff(first, scope)).toBeUndefined();
  expect(consumeReplyComposerHandoff(other, scope)?.text).toBe('hello');
  expect(consumeReplyComposerHandoff(latest, scope)).toMatchObject({ text: 'new edit', revision: 8 });
});

it('bounds abandoned navigation entries without clearing any unaccepted source', () => {
  const onClaim = jest.fn();
  const tokens = Array.from({ length: 33 }, (_, index) =>
    createReplyComposerHandoff({ ...input, sourceId: `bounded-source-${index}`, onClaim })!,
  );
  expect(consumeReplyComposerHandoff(tokens[0], scope)).toBeUndefined();
  for (const token of tokens.slice(1)) expect(discardReplyComposerHandoff(token, scope)).toBe(true);
  expect(onClaim).not.toHaveBeenCalled();
});

it('transfers staged image and GIF identities in order, with alt text and no second upload', () => {
  const mediaIds: ComposerMediaItem[] = [
    { id: 'private-uploaded-image', type: 'image', alt: '  An exact description 🦋  ' },
    { id: 'gif-picker-file-id', type: 'gif' },
  ];
  const token = createReplyComposerHandoff({ ...input, text: '', mediaIds })!;
  mediaIds[0]!.alt = 'Edited after navigation';
  mediaIds.reverse();
  const received = consumeReplyComposerHandoff(token, scope)!;
  expect(received.mediaIds).toEqual([
    { id: 'private-uploaded-image', type: 'image', alt: '  An exact description 🦋  ' },
    { id: 'gif-picker-file-id', type: 'gif' },
  ]);
  expect(received.text).toBe('');
  expect(received.mediaIds).not.toBe(mediaIds);
});

it('keeps text-only handoffs compatible with the existing media setter', () => {
  const token = createReplyComposerHandoff(input)!;
  expect(consumeReplyComposerHandoff(token, scope)?.mediaIds).toEqual([]);
});
