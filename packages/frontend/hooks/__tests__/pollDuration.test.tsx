import TestRenderer, { act } from 'react-test-renderer';
import { usePollManager } from '../usePollManager';
import { useThreadManager } from '../useThreadManager';

let thread: ReturnType<typeof useThreadManager>;
let poll: ReturnType<typeof usePollManager>;

function Probe() {
  thread = useThreadManager();
  poll = usePollManager();
  return null;
}

beforeEach(() => {
  act(() => {
    TestRenderer.create(<Probe />);
  });
});

it('returns the root poll to a week once the poll is removed or cleared', () => {
  expect(poll.pollDurationDays).toBe(7);
  act(() => poll.setPollDurationDays(1));
  act(() => poll.removePoll());
  expect(poll.pollDurationDays).toBe(7);
  act(() => poll.setPollDurationDays(14));
  act(() => poll.clearPoll());
  expect(poll.pollDurationDays).toBe(7);
});

it('keeps a thread box its own length until its poll is removed', () => {
  // A box's id comes from the clock, so the two are made at different instants.
  let now = 1;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now++);
  act(() => {
    thread.addThread();
  });
  act(() => {
    thread.addThread();
  });
  clock.mockRestore();
  const [first, second] = thread.threadItems;
  act(() => thread.openThreadPollCreator(first.id));
  act(() => thread.updateThreadPollDuration(first.id, 3));
  expect(thread.threadItems[0].pollDurationDays).toBe(3);
  expect(thread.threadItems[1].pollDurationDays).toBeUndefined();
  expect(thread.threadItems[1].id).toBe(second.id);

  act(() => thread.removeThreadPoll(first.id));
  expect(thread.threadItems[0].pollDurationDays).toBeUndefined();
});

it('restores the length a draft stored', () => {
  act(() =>
    thread.loadThreadsFromDraft([
      {
        id: 'thread-1',
        text: '',
        mediaIds: [],
        pollOptions: ['a', 'b'],
        pollTitle: '',
        pollDurationDays: 14,
        showPollCreator: true,
        location: null,
        mentions: [],
        sources: [],
        article: null,
        event: null,
        room: null,
        podcast: null,
        attachmentOrder: [],
      },
    ]),
  );
  expect(thread.threadItems[0].pollDurationDays).toBe(14);
});
