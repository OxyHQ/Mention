import React from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

/**
 * The channel explainer, and the one property that fails catastrophically and
 * silently: the host is mounted at app BOOT, so it must render nothing — and in
 * particular must not reach `useTranslation` — until something asks for it.
 * Under react-i18next's default `useSuspense: true` that hook throws a promise
 * while i18n is initializing, which discards the root render, so the init effect
 * never commits and the app deadlocks on a blank screen with no console output.
 * This app has shipped that exact white screen before.
 *
 * A test cannot see a deadlock, so it is pinned from the observable side: the
 * translator is a spy, and mounting the host must not call it. Mutating the host
 * to render its content unconditionally turns that assertion red.
 */

const mockTranslate = jest.fn((key: string) => {
  const catalog: Record<string, unknown> = require('@/locales/en.json');
  const resolved = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      catalog,
    );
  return typeof resolved === 'string' ? resolved : `MISSING_I18N_KEY:${key}`;
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => mockTranslate(key) }),
}));

jest.mock('@/assets/icons/channel-icon', () => ({ ChannelIcon: 'ChannelIcon' }));

/**
 * Both aliases carry a `Mock` prefix because a `jest.mock` factory may not
 * reference an out-of-scope name — and babel's hoist guard applies that to a
 * TYPE annotation too, so a plainly-named `Control` fails the suite at load with
 * "Invalid variable access", not at a line anyone would suspect. The prefix is
 * the documented escape hatch and is case-insensitive.
 */
type MockDialogControl = { open: () => void; close: () => void };
type MockNode = React.ReactNode;

/**
 * Bloom's `Dialog` reduced to the contract this component actually uses: it
 * renders its children, and `control.close()` reaches the `onClose` the caller
 * passed. Registration happens in an effect, which is also what makes the
 * component's own "open on mount" assumption meaningful here.
 */
jest.mock('@oxyhq/bloom/dialog', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const closers = new Map<MockDialogControl, () => void>();

  return {
    __esModule: true,
    useDialogControl: (): MockDialogControl =>
      ReactActual.useMemo<MockDialogControl>(() => {
        const control: MockDialogControl = {
          open: () => {},
          close: () => closers.get(control)?.(),
        };
        return control;
      }, []),
    Dialog: ({
      control,
      onClose,
      children,
    }: {
      control: MockDialogControl;
      onClose: () => void;
      children: MockNode;
    }) => {
      ReactActual.useEffect(() => {
        closers.set(control, onClose);
        return () => {
          closers.delete(control);
        };
      }, [control, onClose]);
      return children;
    },
  };
});

jest.mock('@oxyhq/bloom/button', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Button: ({ children, onPress }: { children: MockNode; onPress: () => void }) =>
      ReactActual.createElement(
        Pressable,
        { onPress, accessibilityRole: 'button' },
        ReactActual.createElement(Text, null, children),
      ),
  };
});

// eslint-disable-next-line import/first
import { ChannelInfoDialogProvider, showChannelInfo } from '../ChannelInfoDialog';
// eslint-disable-next-line import/first
import enStrings from '@/locales/en.json';

const COPY = enStrings.channels.explainer;

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(<ChannelInfoDialogProvider />);
  });
  return renderer;
}

/** Every string the render put on screen. */
function textOf(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON() ?? null);
}

/**
 * The rendered text of a subtree. Reading `props.children` instead would work
 * for a button whose child is a bare string and throw "circular structure" for
 * one whose child is an element — which is the same button one render later.
 */
function textIn(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(textIn).join('');
}

/**
 * Presses the button showing `label`.
 *
 * `Pressable` drives its host through the responder props, so the host View
 * carries no `onPress` — the handler lives on the composite, which is why this
 * looks for a press handler anywhere rather than for the button host.
 */
function press(renderer: ReactTestRenderer, label: string): void {
  const button = renderer.root
    .findAll((node) => typeof node.props?.onPress === 'function', { deep: true })
    .find((node) => textIn(node).includes(label));
  if (!button) throw new Error(`no button labelled "${label}" on screen`);
  TestRenderer.act(() => {
    button.props.onPress();
  });
}

/** Unmounting commits the host's cleanup, so it belongs inside `act` like any update. */
function unmount(renderer: ReactTestRenderer): void {
  TestRenderer.act(() => {
    renderer.unmount();
  });
}

beforeEach(() => {
  mockTranslate.mockClear();
});

describe('the host is inert until something asks for the explainer', () => {
  it('renders nothing and translates nothing when mounted at boot', () => {
    const renderer = mount();

    expect(renderer.toJSON()).toBeNull();
    expect(mockTranslate).not.toHaveBeenCalled();

    unmount(renderer);
  });

  it('does nothing at all when nothing has mounted the host', () => {
    // The imperative entry point is a module-level slot. Calling it with no host
    // must be a no-op rather than a throw, because a deep link can land on a
    // screen before the providers tree has finished mounting.
    expect(() => showChannelInfo()).not.toThrow();
  });
});

describe('the explainer opens, steps and closes', () => {
  it('walks all three cards forward and back, then dismisses', () => {
    const renderer = mount();

    TestRenderer.act(() => {
      showChannelInfo();
    });

    expect(textOf(renderer)).toContain(COPY.step1.title);
    expect(textOf(renderer)).toContain(COPY.step1.body);

    press(renderer, COPY.next);
    expect(textOf(renderer)).toContain(COPY.step2.title);
    press(renderer, COPY.next);
    expect(textOf(renderer)).toContain(COPY.step3.title);

    // Last card swaps the primary label rather than offering a fourth step.
    expect(textOf(renderer)).toContain(COPY.done);
    expect(textOf(renderer)).not.toContain(COPY.next);

    press(renderer, COPY.back);
    expect(textOf(renderer)).toContain(COPY.step2.title);
    press(renderer, COPY.back);
    expect(textOf(renderer)).toContain(COPY.step1.title);

    // First card offers a dismissal, not a fourth direction.
    expect(textOf(renderer)).toContain(COPY.cancel);
    expect(textOf(renderer)).not.toContain(COPY.back);

    press(renderer, COPY.cancel);
    expect(renderer.toJSON()).toBeNull();

    unmount(renderer);
  });

  it('closes from the last card and can be opened again from the start', () => {
    const renderer = mount();

    TestRenderer.act(() => {
      showChannelInfo();
    });
    press(renderer, COPY.next);
    press(renderer, COPY.next);
    press(renderer, COPY.done);
    expect(renderer.toJSON()).toBeNull();

    TestRenderer.act(() => {
      showChannelInfo();
    });
    // Reopening on card three would be the state surviving the unmount.
    expect(textOf(renderer)).toContain(COPY.step1.title);

    unmount(renderer);
  });

  it('renders real copy rather than missing keys', () => {
    const renderer = mount();
    TestRenderer.act(() => {
      showChannelInfo();
    });

    expect(textOf(renderer)).not.toContain('MISSING_I18N_KEY');

    unmount(renderer);
  });
});
