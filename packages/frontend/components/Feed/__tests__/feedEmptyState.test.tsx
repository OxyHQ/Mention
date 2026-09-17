/**
 * What a reader actually sees when a feed has nothing to show.
 *
 * The production complaint this guards: a momentary backend failure put a
 * red-iconed error panel in front of readers opening the app. While a retry is
 * still in flight the surface must show the loading state, and once the retries
 * are spent the failure has to read as calm and retryable — with the connection
 * icon reserved for the one case the reader can act on.
 */

import TestRenderer, { act } from 'react-test-renderer';
import { FeedEmptyState } from '../FeedEmptyState';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, options?: { defaultValue?: string }) =>
            options?.defaultValue ?? key,
    }),
}));

jest.mock('expo-image', () => ({ Image: 'Image' }));

jest.mock('@oxy.so/bloom/theme', () => ({
    useTheme: () => ({ colors: {} }),
}));

jest.mock('@oxy.so/bloom/loading', () => ({ Loading: 'Loading' }));

jest.mock('@/components/ui/Spinner', () => ({ Spinner: 'Spinner' }));

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

jest.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));

jest.mock('@oxy.so/bloom/icons', () => ({ RiRefreshLine: 'RiRefreshLine' }));

function render(props: Partial<React.ComponentProps<typeof FeedEmptyState>>) {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
        tree = TestRenderer.create(
            <FeedEmptyState
                isLoading={false}
                error={null}
                hasItems={false}
                type="for_you"
                onRetry={async () => {}}
                {...props}
            />,
        );
    });
    return tree;
}

/** Host/mocked element names come back as `ElementType`; compare them as text. */
function isElement(node: TestRenderer.ReactTestInstance, name: string): boolean {
    return String(node.type) === name;
}

/** Every icon name the tree renders, whatever nests it. */
function iconNames(tree: TestRenderer.ReactTestRenderer): string[] {
    return tree.root
        .findAll((node) => isElement(node, 'Ionicons'), { deep: true })
        .map((node) => String(node.props.name));
}

/** The retry affordance: a Bloom button leading with the refresh glyph. */
function retryButtons(tree: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
    return tree.root.findAll(
        (node) => isElement(node, 'Button') && node.props.leadingIcon === 'RiRefreshLine',
        { deep: true },
    );
}

function textContent(tree: TestRenderer.ReactTestRenderer): string {
    return tree.root
        .findAll((node) => isElement(node, 'Text'), { deep: true })
        .flatMap((node) => (Array.isArray(node.props.children) ? node.props.children : [node.props.children]))
        .filter((child): child is string => typeof child === 'string')
        .join(' | ');
}

describe('FeedEmptyState', () => {
    it('shows the loading state while a read (and its retries) is in flight', () => {
        const tree = render({ isLoading: true, error: 'Failed to load', errorKind: 'transient' });
        expect(tree.root.findAll((node) => isElement(node, 'Spinner')).length).toBe(1);
        expect(iconNames(tree)).toEqual([]);
        expect(retryButtons(tree)).toHaveLength(0);
    });

    it('reads as a calm retry — no alarm disc — for a backend hiccup', () => {
        const tree = render({ error: 'Failed to load', errorKind: 'transient' });
        // The retry affordance stays; the tinted warning disc does not.
        expect(iconNames(tree)).toEqual([]);
        expect(retryButtons(tree)).toHaveLength(1);
        expect(textContent(tree)).toContain('feed.empty.title');
    });

    it('keeps the connection icon and copy for a device with no network', () => {
        const tree = render({ error: 'Failed to load', errorKind: 'offline' });
        expect(iconNames(tree)).toContain('cloud-offline-outline');
        expect(textContent(tree)).toContain('No connection. Check your network and try again.');
    });

    it('never shows a failure while there are rows to read', () => {
        const tree = render({ error: 'Failed to load more posts', errorKind: 'transient', hasItems: true });
        expect(retryButtons(tree)).toHaveLength(0);
        expect(textContent(tree)).not.toContain('feed.empty.title');
    });
});
