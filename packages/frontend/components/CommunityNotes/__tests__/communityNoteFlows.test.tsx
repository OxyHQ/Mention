import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CommunityNoteSummary, HydratedPostSummary } from '@mention/shared-types';
import { BottomSheetContext, type BottomSheetContextProps } from '@/context/BottomSheetContext';
import { AboutNoteSheet } from '../AboutNoteSheet';
import { CommunityNotesScreen } from '../CommunityNotesScreen';
import { NoteSubmittedSheet } from '../NoteSubmittedSheet';
import { WritingTipsSheet } from '../WritingTipsSheet';
import { useCommunityNoteSheets } from '../useCommunityNoteSheets';

/**
 * The community-note flows around the forms: the explainer sheets, the hub,
 * and the hook that swaps sheets. What is pinned is the promise the UI makes
 * before CrowdSource is wired: a flow that would collect something is offered
 * only once there is somewhere to send it.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key }),
}));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { text: '#000', textSecondary: '#666' } }) }));
jest.mock('@oxy.so/bloom/icons', () => new Proxy({}, { get: () => () => null }));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/bottom-sheet', () => ({ BottomSheet: () => null }));
jest.mock('@oxy.so/bloom/button', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    Button: ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) =>
      R.createElement(RN.Pressable, { onPress }, R.createElement(RN.Text, null, children)),
  };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));
jest.mock('@/components/Feed/PostItem', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/common/AnimatedTabBar', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: ({ tabs, onTabPress }: { tabs: { id: string; label: string }[]; onTabPress: (id: string) => void }) =>
      R.createElement(RN.View, null, tabs.map((tab) =>
        R.createElement(RN.Pressable, { key: tab.id, testID: `tab-${tab.id}`, onPress: () => onTabPress(tab.id) }, R.createElement(RN.Text, null, tab.label)),
      )),
  };
});
jest.mock('@/components/common/EmptyState', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { EmptyState: ({ title }: { title: string }) => R.createElement(RN.Text, null, title) };
});
jest.mock('@/utils/openExternalLink', () => ({ openExternalLink: jest.fn() }));

const mockPush = jest.fn();

const note = (overrides: Partial<CommunityNoteSummary> = {}): CommunityNoteSummary => ({
  id: 'note-1',
  text: 'Context.',
  sourceUrls: ['https://example.com/a'],
  status: 'needs_ratings',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});
const post = { id: 'post-1' } as HydratedPostSummary;

const texts = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((node) => [node.props.children].flat().join(''));

function render(element: React.ReactElement) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element);
  });
  return tree;
}

const pressText = (tree: TestRenderer.ReactTestRenderer, label: string) => {
  const node = tree.root.findAll((n) => typeof n.props.onPress === 'function' && texts({ root: n } as never).includes(label))[0];
  if (!node) throw new Error(`nothing pressable labelled ${label}`);
  act(() => node.props.onPress());
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => jest.clearAllMocks());

describe('explainer sheets', () => {
  it('writing tips: continue and learn more', () => {
    const onContinue = jest.fn();
    const onLearnMore = jest.fn();
    const tree = render(<WritingTipsSheet onContinue={onContinue} onLearnMore={onLearnMore} onClose={() => {}} />);
    expect(texts(tree)).toContain('Write a helpful community note');
    pressText(tree, 'Continue');
    pressText(tree, 'Learn more');
    expect(onContinue).toHaveBeenCalled();
    expect(onLearnMore).toHaveBeenCalled();
  });

  it('submitted: done and manage notes', () => {
    const onDone = jest.fn();
    const onManageNotes = jest.fn();
    const tree = render(<NoteSubmittedSheet onDone={onDone} onManageNotes={onManageNotes} />);
    pressText(tree, 'Done');
    pressText(tree, 'Manage notes');
    expect(onDone).toHaveBeenCalled();
    expect(onManageNotes).toHaveBeenCalled();
  });

  it('about: shows the note, and rating buttons only when rating is possible', () => {
    const readOnly = render(<AboutNoteSheet note={note()} onClose={() => {}} />);
    expect(texts(readOnly)).toEqual(expect.arrayContaining(['About this note', 'Context.', 'Anonymous']));
    expect(texts(readOnly)).not.toContain('Helpful');

    const onRate = jest.fn();
    const rateable = render(<AboutNoteSheet note={note()} onClose={() => {}} onRate={onRate} />);
    pressText(rateable, 'Helpful');
    expect(onRate).toHaveBeenCalledWith('helpful');
  });
});

describe('useCommunityNoteSheets', () => {
  function mountHook(handlers: Parameters<typeof useCommunityNoteSheets>[0]) {
    const sheet: BottomSheetContextProps = {
      openBottomSheet: jest.fn(),
      setBottomSheetContent: jest.fn(),
    } as unknown as BottomSheetContextProps;
    const result: { current: ReturnType<typeof useCommunityNoteSheets> | null } = { current: null };
    function Probe() {
      result.current = useCommunityNoteSheets(handlers);
      return null;
    }
    render(
      <BottomSheetContext.Provider value={sheet}>
        <Probe />
      </BottomSheetContext.Provider>,
    );
    if (!result.current) throw new Error('hook did not mount');
    return { sheets: result.current, sheet };
  }

  it('offers writing and rating only when a handler can receive them', () => {
    expect(mountHook({}).sheets).toMatchObject({ canWrite: false, canRate: false });
    expect(mountHook({ submitNote: jest.fn(), rateNote: jest.fn() }).sheets).toMatchObject({ canWrite: true, canRate: true });
  });

  /** The sheet element a flow put in the shared sheet (unwrapped from its Suspense). */
  const shown = (sheet: BottomSheetContextProps, call: number) =>
    (sheet.setBottomSheetContent as jest.Mock).mock.calls[call][0].props.children as React.ReactElement<Record<string, (...args: unknown[]) => unknown>>;

  it('write flow: tips -> form -> sends the draft -> submitted -> done', async () => {
    const submitNote = jest.fn().mockResolvedValue(undefined);
    const { sheets, sheet } = mountHook({ submitNote });
    act(() => sheets.openWriteFlow(post));

    const tips = shown(sheet, 0);
    act(() => void tips.props.onLearnMore());
    act(() => void tips.props.onContinue());

    const form = shown(sheet, 1);
    await act(async () => {
      await form.props.onSubmit({ text: 'Context', sourceUrl: '' });
    });
    expect(submitNote).toHaveBeenCalledWith('post-1', { text: 'Context', sourceUrl: '' });

    const submitted = shown(sheet, 2);
    act(() => void submitted.props.onDone());
    act(() => void submitted.props.onManageNotes());
    expect(mockPush).toHaveBeenCalledWith('/community-notes');
  });

  it('rate flow: about -> reasons -> sends the rating and reports it back', async () => {
    const rateNote = jest.fn().mockResolvedValue(undefined);
    const onRated = jest.fn();
    const { sheets, sheet } = mountHook({ rateNote });
    act(() => sheets.openAbout(note()));
    act(() => void shown(sheet, 0).props.onRate('helpful'));

    await act(async () => {
      await shown(sheet, 1).props.onSubmit(['relevant']);
    });
    expect(rateNote).toHaveBeenCalledWith('note-1', 'helpful', ['relevant']);

    act(() => sheets.openRateReasons(note(), 'not_helpful', onRated));
    await act(async () => {
      await shown(sheet, 2).props.onSubmit(['incorrect']);
    });
    expect(onRated).toHaveBeenCalledWith('not_helpful');
  });

  it('opens each flow in the shared sheet and routes to the hub', () => {
    const { sheets, sheet } = mountHook({ submitNote: jest.fn(), rateNote: jest.fn() });
    act(() => sheets.openWriteFlow(post));
    act(() => sheets.openAbout(note()));
    act(() => sheets.openRateReasons(note(), 'not_helpful'));
    expect(sheet.setBottomSheetContent).toHaveBeenCalledTimes(3);
    expect(sheet.openBottomSheet).toHaveBeenCalledWith(true);

    act(() => sheets.openManageNotes());
    expect(sheet.openBottomSheet).toHaveBeenCalledWith(false);
    expect(mockPush).toHaveBeenCalledWith('/community-notes');
  });
});

describe('CommunityNotesScreen', () => {
  const entry = (id: string, overrides: Partial<CommunityNoteSummary> = {}) => ({ post: { ...post, id: `p-${id}` }, note: note({ id, text: `Note ${id}`, ...overrides }) });

  it('shows each tab its own list, and an empty state when a list is empty', () => {
    const tree = render(
      <CommunityNotesScreen toRate={[entry('a')]} rated={[entry('b', { viewerRating: 'helpful', status: 'shown' })]} written={[]} />,
    );
    expect(texts(tree)).toContain('Note a');
    expect(texts(tree)).not.toContain('Note b');

    act(() => tree.root.findByProps({ testID: 'tab-ratings' }).props.onPress());
    expect(texts(tree)).toEqual(expect.arrayContaining(['Note b', 'You rated this note helpful']));

    act(() => tree.root.findByProps({ testID: 'tab-notes' }).props.onPress());
    expect(texts(tree)).toContain("You haven't written any notes yet");
  });

  it('offers rating in the queue only when ratings can be sent', () => {
    const readOnly = render(<CommunityNotesScreen toRate={[entry('a')]} rated={[]} written={[]} />);
    expect(texts(readOnly)).not.toContain('Helpful');

    const rateable = render(
      <CommunityNotesScreen toRate={[entry('a')]} rated={[]} written={[]} handlers={{ rateNote: jest.fn() }} />,
    );
    pressText(rateable, 'Helpful');
  });

  it('labels whether a written note is shown yet', () => {
    const tree = render(<CommunityNotesScreen toRate={[]} rated={[]} written={[entry('c'), entry('d', { status: 'shown' })]} />);
    act(() => tree.root.findByProps({ testID: 'tab-notes' }).props.onPress());
    expect(texts(tree)).toEqual(expect.arrayContaining(['Needs more ratings', 'Shown on the post']));
  });
});

describe('CommunityNoteCard actions', () => {
  const { openExternalLink } = jest.requireMock<{ openExternalLink: jest.Mock }>('@/utils/openExternalLink');
  const { CommunityNoteCard } = jest.requireActual<typeof import('../CommunityNoteCard')>('../CommunityNoteCard');

  it('under a post: expands a long note, opens its first source and the about sheet', () => {
    const onPressAbout = jest.fn();
    const tree = render(<CommunityNoteCard note={note({ text: 'y'.repeat(300), sourceUrls: ['https://a.example', 'https://b.example'] })} onPressAbout={onPressAbout} />);
    pressText(tree, 'y'.repeat(300));
    expect(texts(tree)).not.toContain('Show more');
    pressText(tree, 'Sources ({{count}})');
    expect(openExternalLink).toHaveBeenCalledWith('https://a.example');
    pressText(tree, 'About this note');
    expect(onPressAbout).toHaveBeenCalled();
  });

  it('for a rater: opens a cited source and sends either rating', () => {
    const onRate = jest.fn();
    const tree = render(<CommunityNoteCard note={note()} variant="rate" onRate={onRate} />);
    pressText(tree, 'example.com/a');
    expect(openExternalLink).toHaveBeenCalledWith('https://example.com/a');
    pressText(tree, 'Not helpful');
    pressText(tree, 'Helpful');
    expect(onRate.mock.calls).toEqual([['not_helpful'], ['helpful']]);
  });
});
