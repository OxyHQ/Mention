import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';

import UserName from '../UserName';

/**
 * A name with an `href` carries an expo-router `Link` around its text — on web,
 * the `<a href>` a crawler follows from a feed row to the author's profile.
 *
 * The link is INSIDE the name's Text, never the name's Text itself:
 * - `Link asChild` merges its props into its child, and that merge cannot take
 *   the name's style array — production rendered every post row through the
 *   error boundary ("This post could not be displayed") when it tried;
 * - a heading name that is also a link would be one element asked to be two
 *   tags, and react-native-web renders the role's (`<h1 href>`, not a link).
 *
 * The header's own tests mock this component, so only a render of the real
 * one sees either.
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

function textNode(renderer: TestRenderer.ReactTestRenderer, predicate: (props: Record<string, unknown>) => boolean): ReactTestInstance {
  return renderer.root.find((node) => String(node.type) === 'Text' && predicate(node.props));
}

describe('UserName as a link', () => {
  it('renders the name with a link to the profile inside it', () => {
    const renderer = render(<UserName name="Nate" style={{ name: [{ fontSize: 20 }, { fontWeight: '800' }] }} href="/@nate" />);

    const link = textNode(renderer, (props) => props.href === '/@nate');
    expect(link.props.role).toBe('link');
    expect(link.props.children).toBe('Nate');
  });

  it('is plain text without an href', () => {
    const renderer = render(<UserName name="Nate" />);

    expect(renderer.root.findAll((node) => node.props.href !== undefined)).toHaveLength(0);
  });

  it('is the page heading when asked to be', () => {
    const renderer = render(<UserName name="Nate" asHeading />);

    expect(textNode(renderer, (props) => props.role === 'heading').props.children).toBe('Nate');
  });

  it('is a heading that holds its link, when it is both', () => {
    const renderer = render(<UserName name="Nate" asHeading href="/@nate" />);

    const heading = textNode(renderer, (props) => props.role === 'heading');
    expect(heading.props.href).toBeUndefined();
    expect(heading.find((node) => String(node.type) === 'Text' && node.props.href === '/@nate').props.role).toBe('link');
  });
});
