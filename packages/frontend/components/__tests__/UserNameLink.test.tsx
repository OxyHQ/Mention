import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';

import UserName from '../UserName';

/**
 * A name with an `href` is an expo-router `Link` wrapping the name's own
 * `Text` (`asChild`) — on web, the `<a href>` a crawler follows from a feed row
 * to the author's profile.
 *
 * `asChild` merges the link's props into that `Text`, and the merge cannot take
 * a style array: production rendered every post row through the error boundary
 * ("This post could not be displayed") until the style was flattened. The
 * header's own tests mock this component, so only a render of the real one
 * sees it.
 */

jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { text: '#000' } }) }));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('expo-clipboard', () => ({}));
jest.mock('@/components/AccountBadge', () => ({ AccountBadge: () => null }));

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function nameNode(renderer: TestRenderer.ReactTestRenderer, name: string): ReactTestInstance {
  return renderer.root.find((node) => String(node.type) === 'Text' && node.props.children === name);
}

describe('UserName as a link', () => {
  it('renders the name as a link to the profile', () => {
    const renderer = render(<UserName name="Nate" style={{ name: [{ fontSize: 20 }, { fontWeight: '800' }] }} href="/@nate" />);

    const name = nameNode(renderer, 'Nate');
    expect(name.props.href).toBe('/@nate');
    expect(name.props.role).toBe('link');
    expect(Array.isArray(name.props.style)).toBe(false);
  });

  it('is plain text without an href', () => {
    const renderer = render(<UserName name="Nate" />);

    expect(nameNode(renderer, 'Nate').props.href).toBeUndefined();
  });

  it('is the page heading when asked to be', () => {
    const renderer = render(<UserName name="Nate" asHeading />);

    expect(nameNode(renderer, 'Nate').props.role).toBe('heading');
  });
});
