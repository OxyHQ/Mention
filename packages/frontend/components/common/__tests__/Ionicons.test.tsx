import React from 'react';
import { Pressable, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * An icon-font glyph is a Text node holding a private-use code point, and
 * TalkBack read it aloud: the Create Room options were announced as
 * "\U000f036c, Talk, Open conversation" (#1126, item 14). The app's one entry to
 * the font hides every glyph from assistive technology.
 *
 * The font is stood in for by a Text that spreads its props, which is what
 * `createIconSet` renders once the font has loaded (under jest it never loads,
 * so the real one draws an empty Text and the props could not be observed).
 * RN maps `aria-hidden` to `importantForAccessibility="no-hide-descendants"` on
 * Android and `accessibilityElementsHidden` on iOS.
 */
jest.mock('@expo/vector-icons/Ionicons', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => (
      <MockText {...props} testID="glyph">{''}</MockText>
    ),
  };
});

import Ionicons from '../Ionicons';

const hostByTestID = (tree: TestRenderer.ReactTestRenderer, testID: string) =>
  tree.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID);

describe('Ionicons', () => {
  it('hides the glyph from screen readers and leaves the words readable', () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <Pressable accessibilityRole="button">
          <Ionicons name="mic" size={20} />
          <Text testID="label">Talk</Text>
        </Pressable>,
      );
    });

    const [glyph] = hostByTestID(tree, 'glyph');
    expect(glyph.props['aria-hidden']).toBe(true);
    const [label] = hostByTestID(tree, 'label');
    expect(label.props['aria-hidden']).toBeUndefined();
  });

  it('cannot be switched back on by a call site', () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<Ionicons name="play" size={20} aria-hidden={false} />);
    });
    const [glyph] = hostByTestID(tree, 'glyph');
    expect(glyph.props['aria-hidden']).toBe(true);
  });
});
