import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CommunityNoteSummary } from '@mention/shared-types';
import { CommunityNoteCard } from '../CommunityNoteCard';
import { RateNoteSheet } from '../RateNoteSheet';
import { WriteNoteSheet } from '../WriteNoteSheet';

/**
 * The community-note surfaces a reader touches: the note under a post, the
 * rating reasons, and the note form. CrowdSource owns the note itself; these
 * pin what the UI promises — a long note collapses, rating needs a reason, a
 * rating is only offered where one can be given, and the form refuses an empty
 * note or a malformed source.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; count?: number }) =>
      (options?.defaultValue ?? _key).replace('{{count}}', String(options?.count ?? '')),
  }),
}));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { text: '#000', textSecondary: '#666' } }) }));
jest.mock('@oxy.so/bloom/icons', () => new Proxy({}, { get: () => () => null }));
jest.mock('@oxy.so/bloom/button', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    Button: ({ children, onPress, disabled }: { children?: React.ReactNode; onPress?: () => void; disabled?: boolean }) =>
      R.createElement(RN.Pressable, { onPress, disabled, accessibilityRole: 'button', testID: 'bloom-button' }, R.createElement(RN.Text, null, children)),
  };
});
jest.mock('@oxy.so/bloom/checkbox', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    Checkbox: ({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (v: boolean) => void }) =>
      R.createElement(RN.Pressable, { testID: `reason-${label}`, onPress: () => onCheckedChange(!checked) }, R.createElement(RN.Text, null, label)),
  };
});
jest.mock('@oxy.so/bloom/textarea', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { Textarea: (props: { value: string; onChangeText: (v: string) => void }) => R.createElement(RN.TextInput, { testID: 'note-text', ...props }) };
});
jest.mock('@oxy.so/bloom/text-field', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    TextField: ({ children }: { children?: React.ReactNode }) => R.createElement(RN.View, null, children),
    TextFieldInput: (props: { value: string; onChangeText: (v: string) => void }) => R.createElement(RN.TextInput, { testID: 'note-source', ...props }),
    TextFieldHint: ({ children }: { children?: React.ReactNode }) => R.createElement(RN.Text, null, children),
  };
});
jest.mock('@/components/Feed/PostItem', () => ({ __esModule: true, default: () => null }));
jest.mock('@/utils/openExternalLink', () => ({ openExternalLink: jest.fn() }));


const note = (overrides: Partial<CommunityNoteSummary> = {}): CommunityNoteSummary => ({
  id: 'note-1',
  text: 'Short context.',
  sourceUrls: ['https://example.com/a'],
  status: 'shown',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

const texts = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((node) => [node.props.children].flat().join(''));

/** The mocked Bloom buttons, in render order (the sheet header's close button comes first). */
const bloomButtons = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(jest.requireMock<{ Button: React.ComponentType }>('@oxy.so/bloom/button').Button);

const lastButton = (tree: TestRenderer.ReactTestRenderer) => {
  const button = bloomButtons(tree).at(-1);
  if (!button) throw new Error('no button rendered');
  return button;
};

function render(element: React.ReactElement) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element);
  });
  return tree;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('CommunityNoteCard', () => {
  it('collapses a long note under a post and offers to show more', () => {
    const tree = render(<CommunityNoteCard note={note({ text: 'x'.repeat(300) })} onPressAbout={() => {}} />);
    expect(texts(tree)).toContain('Show more');
    expect(texts(tree)).toContain('About this note');
  });

  it('shows a short note whole, with no "show more"', () => {
    const tree = render(<CommunityNoteCard note={note()} />);
    expect(texts(tree)).not.toContain('Show more');
  });

  it('offers Helpful / Not helpful only where a rating can be given', () => {
    const onRate = jest.fn();
    const rateable = render(<CommunityNoteCard note={note()} variant="rate" onRate={onRate} />);
    expect(texts(rateable)).toEqual(expect.arrayContaining(['Helpful', 'Not helpful']));

    const readOnly = render(<CommunityNoteCard note={note()} variant="rate" />);
    expect(texts(readOnly)).not.toContain('Helpful');

    const alreadyRated = render(<CommunityNoteCard note={note({ viewerRating: 'helpful' })} variant="rate" onRate={onRate} />);
    expect(texts(alreadyRated)).toContain('You rated this note helpful');
    expect(texts(alreadyRated)).not.toContain('Helpful');
  });
});

describe('RateNoteSheet', () => {
  const rateButton = (tree: TestRenderer.ReactTestRenderer) => lastButton(tree);

  it('needs at least one reason, and submits the ones chosen', () => {
    const onSubmit = jest.fn();
    const tree = render(<RateNoteSheet rating="helpful" onSubmit={onSubmit} onClose={() => {}} />);
    expect(rateButton(tree).props.disabled).toBe(true);

    act(() => tree.root.findByProps({ testID: 'reason-Reliable source' }).props.onPress());
    expect(rateButton(tree).props.disabled).toBe(false);

    act(() => rateButton(tree).props.onPress());
    expect(onSubmit).toHaveBeenCalledWith(['reliable_source']);
  });

  it('asks why NOT helpful with the not-helpful reasons', () => {
    const tree = render(<RateNoteSheet rating="not_helpful" onSubmit={() => {}} onClose={() => {}} />);
    expect(texts(tree)).toEqual(expect.arrayContaining(['Why is the community note not helpful?', 'Incorrect information']));
  });
});

describe('WriteNoteSheet', () => {
  const post = { id: 'post-1' } as never;
  const submit = (tree: TestRenderer.ReactTestRenderer) => lastButton(tree);

  it('refuses an empty note and a malformed source, and sends the trimmed draft', () => {
    const onSubmit = jest.fn();
    const tree = render(<WriteNoteSheet post={post} onSubmit={onSubmit} onClose={() => {}} />);
    expect(submit(tree).props.disabled).toBe(true);

    act(() => tree.root.findByProps({ testID: 'note-text' }).props.onChangeText('  Real context.  '));
    expect(submit(tree).props.disabled).toBe(false);

    act(() => tree.root.findByProps({ testID: 'note-source' }).props.onChangeText('not a link'));
    expect(submit(tree).props.disabled).toBe(true);

    act(() => tree.root.findByProps({ testID: 'note-source' }).props.onChangeText('https://example.com/source'));
    act(() => submit(tree).props.onPress());
    expect(onSubmit).toHaveBeenCalledWith({ text: 'Real context.', sourceUrl: 'https://example.com/source' });
  });
});
