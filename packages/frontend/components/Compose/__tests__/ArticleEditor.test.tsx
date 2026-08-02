import React from 'react';
import { Modal, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { ArticleEditor } from '../ArticleEditor';

/**
 * The article editor is a long-form writing surface, and the two things worth
 * pinning about it are structural rather than visual:
 *
 *  1. It renders through bloom's `Dialog` and contains NO RN `<Modal>`. A raw
 *     `Modal` opens its own native window, which sits outside the design
 *     system's surface ordering — so anything opened from inside the editor has
 *     no way to paint above it. That is the layering bug this migration exists
 *     to remove, and it is invisible in a screenshot.
 *  2. The composer owns the draft. Opening, typing, closing and reopening must
 *     show the same title and body; a migration that moved either into local
 *     state would silently lose someone's article.
 */

const mockDialogProps: Record<string, unknown>[] = [];

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en-US' },
  }),
}));

jest.mock('@oxyhq/bloom/dialog', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Dialog: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
      mockDialogProps.push(props);
      return <View testID="bloomDialog">{props.children}</View>;
    },
    useDialogControl: () => ({ open: jest.fn(), close: jest.fn() }),
  };
});

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({
    colors: {
      border: '#333',
      card: '#fff',
      primary: '#7c3aed',
      text: '#000',
      textSecondary: '#666',
      textTertiary: '#999',
    },
  }),
}));

const noop = () => {};

function renderEditor(
  overrides: Partial<React.ComponentProps<typeof ArticleEditor>> = {},
) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <ArticleEditor
        visible
        title="On scheduling"
        body="A long body that must survive a round trip."
        onTitleChange={noop}
        onBodyChange={noop}
        onSave={noop}
        onClose={noop}
        {...overrides}
      />,
    );
  });
  if (!tree) throw new Error('ArticleEditor failed to render');
  return tree;
}

describe('ArticleEditor surface', () => {
  beforeEach(() => {
    mockDialogProps.length = 0;
  });

  it("renders through bloom's Dialog, with no RN Modal anywhere", () => {
    const tree = renderEditor();

    expect(tree.root.findAllByProps({ testID: 'bloomDialog' }).length).toBeGreaterThan(0);
    // The direct guard: reintroducing a hand-rolled shell fails here rather than
    // merely looking different.
    expect(tree.root.findAllByType(Modal)).toHaveLength(0);

    act(() => tree.unmount());
  });

  it('is given a writing-surface placement, not the centered-card default', () => {
    const tree = renderEditor();

    const props = mockDialogProps.at(-1);
    // Near-full-height sheet on a phone (the native shape for writing), wide
    // centered card on a desktop (prose reads badly in a 460px drawer).
    expect(props?.placement).toEqual({ base: 'bottom', md: 'center' });
    expect(props?.maxHeightRatio).toBe(0.92);
    expect(props?.maxWidth).toBe(720);
    expect(props?.open).toBe(true);

    act(() => tree.unmount());
  });

  it("uses the Dialog's own header for the title and the save action", () => {
    const onSave = jest.fn();
    const tree = renderEditor({ onSave });

    const header = mockDialogProps.at(-1)?.header as
      | { title?: string; right?: React.ReactElement }
      | undefined;
    expect(header?.title).toBe('Write article');

    const saveSlot = header?.right;
    if (!saveSlot) throw new Error('The Dialog header was given no right slot');

    // The save affordance is a real control handed to the header, not decoration.
    // Rendered on its own because the Dialog mock only renders `children`; the
    // header slot is a node the real Dialog mounts into its nav bar.
    let rendered: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      rendered = TestRenderer.create(saveSlot);
    });
    if (!rendered) throw new Error('The header slot failed to render');

    const button = rendered.root.find((node) => node.props.accessibilityRole === 'button');
    act(() => {
      button.props.onPress();
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    const mounted = rendered;
    act(() => {
      mounted.unmount();
      tree.unmount();
    });
  });

  it('closes through the Dialog rather than a bespoke affordance', () => {
    const onClose = jest.fn();
    const tree = renderEditor({ onClose });

    act(() => {
      (mockDialogProps.at(-1)?.onClose as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  it('keeps the title and body across an open, close and reopen', () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    const render = (visible: boolean) => (
      <ArticleEditor
        visible={visible}
        title="On scheduling"
        body="A long body that must survive a round trip."
        onTitleChange={noop}
        onBodyChange={noop}
        onSave={noop}
        onClose={noop}
      />
    );

    act(() => { tree = TestRenderer.create(render(true)); });
    act(() => { tree?.update(render(false)); });
    act(() => { tree?.update(render(true)); });

    if (!tree) throw new Error('ArticleEditor failed to re-render');
    const values = tree.root.findAllByType(TextInput).map((node) => node.props.value);
    expect(values).toEqual([
      'On scheduling',
      'A long body that must survive a round trip.',
    ]);

    act(() => tree?.unmount());
  });
});
