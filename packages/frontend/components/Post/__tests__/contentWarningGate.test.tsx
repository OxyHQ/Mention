import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import ContentWarning from '../ContentWarning';

/**
 * A content warning is a gate: closed, it states the warning and offers to show
 * the post; open, it collapses to one line that can close it again. `PostItem`
 * hides the body and every block below while it is closed.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key }),
}));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { textSecondary: '#666' } }) }));
jest.mock('@oxy.so/bloom/icons', () => ({ RiAlertLine: () => null }));

const texts = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((node) => [node.props.children].flat().join(''));

function render(revealed: boolean, onToggle = jest.fn()) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ContentWarning text="Spoilers" revealed={revealed} onToggle={onToggle} />);
  });
  return tree;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

it('closed: names the warning and offers Show, and pressing it toggles', () => {
  const onToggle = jest.fn();
  const tree = render(false, onToggle);
  expect(texts(tree)).toEqual(expect.arrayContaining(['Content warning', 'Spoilers', 'Show']));

  act(() => tree.root.findByProps({ accessibilityRole: 'button' }).props.onPress());
  expect(onToggle).toHaveBeenCalledTimes(1);
});

it('open: one line with the warning and Hide', () => {
  const tree = render(true);
  expect(texts(tree)).toEqual(expect.arrayContaining(['Content warning · Spoilers', 'Hide']));
  expect(texts(tree)).not.toContain('Show');
});
