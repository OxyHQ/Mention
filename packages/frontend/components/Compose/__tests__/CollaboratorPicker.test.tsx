import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import CollaboratorPicker, { type CollaboratorUser } from '../CollaboratorPicker';

/**
 * Inviting collaborators is now reached from the people icon in the attachment
 * row, like every other attachment. So this component no longer owns an entry
 * point of its own: it renders the chosen collaborators and, when the composer
 * says so, the search field — and NOTHING at all before either exists.
 *
 * The "Invite collaborators" link it used to render is the specific thing that
 * must not come back. Leaving it in place would put the same action in two
 * places, which is what the move was for.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en-US' },
  }),
}));

jest.mock('@oxyhq/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@oxyhq/bloom/avatar', () => ({ Avatar: () => null }));
jest.mock('@oxyhq/core/logger', () => ({ logger: { error: jest.fn() } }));
jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: () => ({
    user: { id: 'viewer' },
    oxyServices: { searchProfiles: jest.fn().mockResolvedValue({ data: [] }) },
  }),
}));

const COLLABORATOR: CollaboratorUser = {
  id: 'u1',
  username: 'ada',
  displayName: 'Ada',
};

function render(props: Partial<React.ComponentProps<typeof CollaboratorPicker>> = {}) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <CollaboratorPicker
        selected={[]}
        onChange={() => {}}
        expanded={false}
        onExpandedChange={() => {}}
        {...props}
      />,
    );
  });
  if (!tree) throw new Error('CollaboratorPicker failed to render');
  return tree;
}

function textContent(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')
    .join(' | ');
}

describe('CollaboratorPicker', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('renders NOTHING before anything is chosen or opened', () => {
    const tree = render();

    // The entry point moved to the attachment row, so an empty, closed picker
    // has nothing to say — and must not reserve a strip of the composer to
    // say it.
    expect(tree.toJSON()).toBeNull();

    act(() => tree.unmount());
  });

  it('no longer offers its own "Invite collaborators" link', () => {
    // Every state the old link could appear in. `{expanded: false, selected:
    // [one]}` is the load-bearing one: the link used to render below the chips
    // whenever the post was under the collaborator limit, and that is the only
    // case the empty-and-closed early return does not already hide. Testing
    // just the other two passes even with the link put straight back.
    const states = [
      { expanded: false, selected: [] },
      { expanded: true, selected: [] },
      { expanded: false, selected: [COLLABORATOR] },
      { expanded: true, selected: [COLLABORATOR] },
    ];
    for (const state of states) {
      const tree = render(state);
      expect(textContent(tree)).not.toContain('Invite collaborators');
      act(() => tree.unmount());
    }
  });

  it('shows the search field only when the composer opens it', () => {
    const closed = render({ expanded: false, selected: [COLLABORATOR] });
    expect(closed.root.findAllByType(TextInput)).toHaveLength(0);
    act(() => closed.unmount());

    const open = render({ expanded: true });
    expect(open.root.findAllByType(TextInput)).toHaveLength(1);
    act(() => open.unmount());
  });

  it('keeps showing who is already on the post while closed', () => {
    const tree = render({ expanded: false, selected: [COLLABORATOR] });

    // Chosen collaborators are state, not a transient search result: closing the
    // search must not hide who the post will be published with.
    expect(textContent(tree)).toContain('Ada');

    act(() => tree.unmount());
  });

  it('hands closing back to the composer, which owns the open state', () => {
    const onExpandedChange = jest.fn();
    const tree = render({ expanded: true, onExpandedChange });

    const close = tree.root.find(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        node.props.accessibilityLabel === 'Close collaborator search',
    );
    act(() => close.props.onPress());

    // Closing through local state instead would desync the icon in the toolbar,
    // which would then need two presses to reopen the panel.
    expect(onExpandedChange).toHaveBeenCalledWith(false);

    act(() => tree.unmount());
  });
});
