import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useAttachmentOrder } from '../useAttachmentOrder';

jest.mock('@oxy.so/bloom/hooks', () => ({
  moveItem: <T,>(items: T[], from: number, to: number): T[] => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  },
}));

/**
 * The live carousel's order, built from `composeContent`'s attachment keys — the
 * same keys a restored draft and a thread box's payload use.
 */

type Props = Parameters<typeof useAttachmentOrder>[0];
type Result = ReturnType<typeof useAttachmentOrder>;

const EVENT = { name: 'Launch', date: '2026-10-01T18:00:00.000Z' };

const base: Props = {
  showPollCreator: false,
  article: null,
  event: null,
  room: null,
  podcast: null,
  job: null,
  location: null,
  sources: [],
  mediaIds: [],
  linkUrls: [],
};

let latest: Result | null = null;
function Probe(props: Props) {
  latest = useAttachmentOrder(props);
  return null;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function mount(props: Props) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe {...props} />);
  });
  return renderer;
}

describe('useAttachmentOrder', () => {
  it('shows a card only for an attachment that counts', () => {
    mount({
      ...base,
      event: { name: ' ', date: EVENT.date },
      mediaIds: [{ id: 'm1', type: 'image' }],
    });
    expect(latest!.attachmentOrder).toEqual(['media:m1']);
  });

  it('keeps a chosen order as attachments come and go', () => {
    const media = [{ id: 'm1', type: 'image' as const }];
    const renderer = mount({ ...base, event: EVENT, mediaIds: media });
    expect(latest!.attachmentOrder).toEqual(['event', 'media:m1']);

    act(() => latest!.setAttachmentOrder(['media:m1', 'event']));
    expect(latest!.attachmentOrder).toEqual(['media:m1', 'event']);

    act(() =>
      renderer.update(
        <Probe {...base} event={EVENT} mediaIds={media} linkUrls={['https://x.test']} />,
      ),
    );
    expect(latest!.attachmentOrder).toEqual(['media:m1', 'event', 'link:https://x.test']);

    act(() => renderer.update(<Probe {...base} mediaIds={media} linkUrls={['https://x.test']} />));
    expect(latest!.attachmentOrder).toEqual(['media:m1', 'link:https://x.test']);
  });

  it('moves a card, and moving media reorders the media list with it', () => {
    const setMediaIds = jest.fn();
    const media = [
      { id: 'm1', type: 'image' as const },
      { id: 'm2', type: 'image' as const },
    ];
    mount({ ...base, mediaIds: media, setMediaIds });
    expect(latest!.attachmentOrder).toEqual(['media:m1', 'media:m2']);

    act(() => latest!.moveAttachment('media:m2', 'left'));
    expect(latest!.attachmentOrder).toEqual(['media:m2', 'media:m1']);
    expect(setMediaIds).toHaveBeenCalled();
    const reorder = setMediaIds.mock.calls[0][0] as (prev: typeof media) => typeof media;
    expect(reorder(media).map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it('clears to the default order', () => {
    mount({ ...base, event: EVENT, mediaIds: [{ id: 'm1', type: 'image' }] });
    act(() => latest!.setAttachmentOrder(['media:m1', 'event']));
    act(() => latest!.clearAttachmentOrder());
    expect(latest!.attachmentOrder).toEqual(['event', 'media:m1']);
  });
});
