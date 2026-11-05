import TestRenderer, { act } from 'react-test-renderer';

import { ProfileLinkChips } from '../ProfileLinkChips';

/**
 * The profile's links render as pills under the bio. A pill is labelled with
 * the owner's title when there is one, else the bare address; a tap opens the
 * link. The wrapping and the "+N" fold are Bloom's (`CappedChipRow`, tested in
 * Bloom), so this file pins only what Mention decides.
 */

// Bloom's chip row and chip are tested in Bloom. Here they are plain primitives,
// which also keeps the native worklets runtime out of this suite.
jest.mock('@oxy.so/bloom/chip', () => {
  const { View, Pressable, Text } = jest.requireActual('react-native');
  const MockChipComponent = ({
    children,
    accessibilityLabel,
    onPress,
    onLongPress,
  }: Record<string, unknown>) => (
    <Pressable
      accessibilityLabel={accessibilityLabel as string}
      onPress={onPress as () => void}
      onLongPress={onLongPress as () => void}
    >
      <Text>{children as string}</Text>
    </Pressable>
  );
  return {
    CappedChipRow: ({ children }: { children: unknown }) => <View>{children}</View>,
    Chip: MockChipComponent,
  };
});
// The mocked Chip, as the rendered tree names it.
import { Chip as MockChip } from '@oxy.so/bloom/chip';
jest.mock('@oxy.so/bloom/item', () => ({ Item: () => null }));
jest.mock('@oxy.so/bloom/icons/RiExternalLinkLine', () => ({ RiExternalLinkLine: () => null }));
jest.mock('@oxy.so/bloom/icons/RiLink', () => ({ RiLink: () => null }));
jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#000' } }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('@/utils/sheet', () => ({ presentSheet: jest.fn() }));
const mockOpen = jest.fn();
jest.mock('@/utils/openExternalLink', () => ({ openExternalLink: (url: string) => mockOpen(url) }));

/** The pill labels, read from the rendered tree (each pill is one Text). */
function pillLabels(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => node.type === MockChip)
    .map((node) => node.props.accessibilityLabel as string);
}

function pressPill(tree: TestRenderer.ReactTestRenderer, label: string) {
  const pill = tree.root.findAll(
    (node) => node.type === MockChip && node.props.accessibilityLabel === label,
  )[0];
  pill?.props.onPress({});
}

describe('ProfileLinkChips', () => {
  it('renders nothing without links', () => {
    const tree = TestRenderer.create(<ProfileLinkChips links={[]} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('labels each pill with the title, else the prettified address', () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <ProfileLinkChips
          links={[
            { id: 'a', url: 'https://example.com/me', title: 'My site' },
            { id: 'b', url: 'https://www.github.com/nate/' },
          ]}
        />,
      );
    });
    const labels = pillLabels(tree);
    expect(labels).toEqual(['My site', 'github.com/nate']);
  });

  it('opens the link when its pill is pressed', () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <ProfileLinkChips links={[{ id: 'a', url: 'https://example.com/me' }]} />,
      );
    });
    act(() => {
      pressPill(tree, 'example.com/me');
    });
    expect(mockOpen).toHaveBeenCalledWith('https://example.com/me');
  });
});
