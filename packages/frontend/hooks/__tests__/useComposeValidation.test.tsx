import TestRenderer, { act } from 'react-test-renderer';
import { useComposeValidation } from '../useComposeValidation';
import type { ComposeContent } from '@/utils/composeContent';
import { createVariantsState, EMPTY_VARIANT_ITEM } from '@/utils/composeVariants';
import { MAX_POST_TEXT_LENGTH } from '@mention/shared-types/post';

const empty: ComposeContent = {
  postContent: '',
  mediaIds: [],
  pollOptions: [],
  location: null,
  sources: [],
  article: null,
  event: null,
  room: null,
  podcast: null,
  job: null,
  threadItems: [],
};
function validate(content: ComposeContent, variants = createVariantsState('en')) {
  let result: ReturnType<typeof useComposeValidation> | undefined;
  function Probe() {
    result = useComposeValidation({ content, variants, isPosting: false });
    return null;
  }
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(<Probe />);
  });
  act(() => tree?.unmount());
  if (!result) throw new Error('Validation did not render');
  return result;
}
it('accepts a valid source with an optional empty title', () => {
  expect(
    validate({ ...empty, sources: [{ id: 's', url: 'https://example.com/article', title: '' }] })
      .isPostButtonEnabled,
  ).toBe(true);
});
it.each(['not-a-url', 'javascript:alert(1)', 'mailto:a@example.com', 'https://'])(
  'rejects invalid source %s even with a title',
  (url) => {
    expect(
      validate({ ...empty, sources: [{ id: 's', url, title: 'Source' }] }).hasInvalidSources,
    ).toBe(true);
  },
);
it('checks sources in thread replies too', () => {
  const thread = {
    id: 'thread',
    text: 'reply',
    mediaIds: [],
    pollOptions: [],
    pollTitle: '',
    showPollCreator: false,
    location: null,
    mentions: [],
    sources: [{ id: 's', url: 'not-a-url', title: 'Title' }],
    article: null,
    event: null,
    room: null,
    podcast: null,
    laneId: null,
    attachmentOrder: [],
    replyPermission: [],
    reviewReplies: false,
    quotesDisabled: false,
    isSensitive: false,
    publishAs: null,
  };
  expect(
    validate({ ...empty, postContent: 'root', threadItems: [thread] }).isPostButtonEnabled,
  ).toBe(false);
  expect(
    validate({
      ...empty,
      threadItems: [{ ...thread, sources: [], text: 'x'.repeat(MAX_POST_TEXT_LENGTH + 1) }],
    }).hasOverlongText,
  ).toBe(true);
});
it('allows the maximum text length but rejects one character over', () => {
  expect(
    validate({ ...empty, postContent: 'x'.repeat(MAX_POST_TEXT_LENGTH) }).isPostButtonEnabled,
  ).toBe(true);
  expect(
    validate({ ...empty, postContent: 'x'.repeat(MAX_POST_TEXT_LENGTH + 1) }).isPostButtonEnabled,
  ).toBe(false);
});
it('checks every language rendition, including ones not currently selected', () => {
  const variants = {
    ...createVariantsState('en'),
    variantTags: ['es'],
    entries: {
      es: { main: { ...EMPTY_VARIANT_ITEM, text: 'x'.repeat(MAX_POST_TEXT_LENGTH + 1) } },
    },
  };
  expect(validate({ ...empty, postContent: 'ok' }, variants).isPostButtonEnabled).toBe(false);
});

it.each(['example.com/article', 'http://localhost/article', 'http://[::1]/article'])(
  'accepts a web source URL %s',
  (url) => {
    expect(validate({ ...empty, sources: [{ id: 's', url, title: '' }] }).isPostButtonEnabled).toBe(
      true,
    );
  },
);
