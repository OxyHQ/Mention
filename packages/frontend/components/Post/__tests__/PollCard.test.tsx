import React from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import PollCard from '../PollCard';
import type { PollDetail } from '@/services/pollService';

/**
 * The bug this pins: `serializePoll` used to send `votes: option.votes.length`
 * for an anonymous poll and `votes: option.votes` (an array of voter ids) for
 * a visible one — UNDER THE SAME FIELD. `PollCard` read it as
 * `opt.votes?.length` for the total and `(opt.votes || []).includes(user.id)`
 * for `hasVoted`, so an anonymous poll with a vote made the first read zero
 * and the second throw `TypeError: includes is not a function`. Every fixture
 * below is shaped exactly like the real backend response — `voteCount` and
 * `viewerSelectedOptionIds`, never `votes` — so a regression back to the old
 * shape would fail these at the TYPE level before it ever reached a render.
 */

const mockGetPoll = jest.fn();
const mockVote = jest.fn();
jest.mock('@/services/pollService', () => ({
  pollService: {
    getPoll: (...args: unknown[]) => mockGetPoll(...args),
    vote: (...args: unknown[]) => mockVote(...args),
  },
  PollContractError: class PollContractError extends Error {},
}));

const mockToastError = jest.fn();
jest.mock('@oxy.so/bloom/toast', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args), success: jest.fn() },
}));

jest.mock('@oxy.so/core/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
}));

jest.mock('@oxy.so/bloom/loading', () => ({ Loading: 'Loading' }));
jest.mock('@oxy.so/bloom/card', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Card: ({ children }: { children?: React.ReactNode }) => <View>{children}</View> };
});
// The option's labelled bar: its label and the share node PollCard hands it.
jest.mock('@oxy.so/bloom/stat-bar', () => {
  const { Text: RNText, View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    StatBar: ({ label, icon }: { label: string; icon?: React.ReactNode }) => (
      <View>
        <RNText>{label}</RNText>
        {icon}
      </View>
    ),
  };
});
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ user: { id: 'viewer-1' } }) }));

function poll(overrides: Partial<PollDetail> = {}): PollDetail {
  return {
    _id: 'poll-1',
    question: 'Favourite colour?',
    options: [
      { _id: 'opt-red', text: 'Red', voteCount: 0 },
      { _id: 'opt-blue', text: 'Blue', voteCount: 0 },
    ],
    createdBy: 'author-1',
    endsAt: new Date(Date.now() + 60_000).toISOString(),
    isMultipleChoice: false,
    isAnonymous: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    viewerSelectedOptionIds: [],
    ...overrides,
  };
}

async function render(element: React.ReactElement, client = new QueryClient()): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  // The poll arrives through React Query; let its fetch resolve and commit.
  await TestRenderer.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return renderer;
}

function textOf(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map((node) => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children))
    .join(' | ');
}

function pressHandlers(renderer: ReactTestRenderer): Array<() => void> {
  return renderer.root
    .findAll((node: ReactTestInstance) => typeof node.props?.onPress === 'function', { deep: true })
    .map((node) => node.props.onPress as () => void);
}

beforeEach(() => {
  mockGetPoll.mockReset();
  mockVote.mockReset();
  mockToastError.mockReset();
});

describe('PollCard — an anonymous poll with votes renders without throwing', () => {
  it('zero votes', async () => {
    mockGetPoll.mockResolvedValue({ success: true, data: poll() });
    const renderer = await render(<PollCard pollId="poll-1" />);

    expect(textOf(renderer)).toContain('0 votes');
    expect(textOf(renderer)).toContain('0%');
  });

  it('one vote, cast by someone other than the viewer', async () => {
    mockGetPoll.mockResolvedValue({
      success: true,
      data: poll({
        options: [
          { _id: 'opt-red', text: 'Red', voteCount: 1 },
          { _id: 'opt-blue', text: 'Blue', voteCount: 0 },
        ],
        // Anonymous, so this viewer is told only the total — never who cast it.
        viewerSelectedOptionIds: [],
      }),
    });

    const renderer = await render(<PollCard pollId="poll-1" />);

    expect(textOf(renderer)).toContain('1 votes');
    expect(textOf(renderer)).toContain('100%');
  });

  it('many votes across both options, including the viewer\'s own', async () => {
    mockGetPoll.mockResolvedValue({
      success: true,
      data: poll({
        options: [
          { _id: 'opt-red', text: 'Red', voteCount: 7 },
          { _id: 'opt-blue', text: 'Blue', voteCount: 3 },
        ],
        viewerSelectedOptionIds: ['opt-red'],
      }),
    });

    const renderer = await render(<PollCard pollId="poll-1" />);

    expect(textOf(renderer)).toContain('10 votes');
    // The viewer already voted (single-choice), so every option is disabled.
    const options = renderer.root.findAll(
      (node) => typeof node.props?.disabled === 'boolean',
      { deep: true },
    );
    expect(options.every((node) => node.props.disabled === true)).toBe(true);
  });
});

describe('PollCard — casting a vote', () => {
  it('applies the vote response directly and does not re-fetch the poll', async () => {
    mockGetPoll.mockResolvedValue({ success: true, data: poll() });
    mockVote.mockResolvedValue({
      success: true,
      data: poll({
        options: [
          { _id: 'opt-red', text: 'Red', voteCount: 1 },
          { _id: 'opt-blue', text: 'Blue', voteCount: 0 },
        ],
        viewerSelectedOptionIds: ['opt-red'],
      }),
    });

    const renderer = await render(<PollCard pollId="poll-1" />);
    expect(mockGetPoll).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      await pressHandlers(renderer)[0]();
    });

    expect(mockVote).toHaveBeenCalledWith('poll-1', 'opt-red');
    // The card reflects the vote's own response — no second load.
    expect(mockGetPoll).toHaveBeenCalledTimes(1);
    expect(textOf(renderer)).toContain('1 votes');
  });

  it('shows a failed vote instead of swallowing it, and does not retry on its own', async () => {
    mockGetPoll.mockResolvedValue({ success: true, data: poll() });
    mockVote.mockRejectedValue(new Error('network down'));

    const renderer = await render(<PollCard pollId="poll-1" />);

    await TestRenderer.act(async () => {
      await pressHandlers(renderer)[0]();
    });

    expect(mockVote).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledTimes(1);
    // The card is still showing the poll, not stuck or blanked by the failure.
    expect(textOf(renderer)).toContain('0 votes');
  });
});

describe('PollCard — a recycled or remounted row', () => {
  it('reads the same poll from the cache instead of fetching it again', async () => {
    mockGetPoll.mockResolvedValue({ success: true, data: poll() });
    const client = new QueryClient();
    const first = await render(<PollCard pollId="poll-1" />, client);
    TestRenderer.act(() => first.unmount());
    const second = await render(<PollCard pollId="poll-1" />, client);

    expect(mockGetPoll).toHaveBeenCalledTimes(1);
    expect(textOf(second)).toContain('0 votes');
  });
});
