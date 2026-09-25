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

// Bloom draws the block now; keep it as a host element so the assertions below
// read the DECISION (which glyph, which copy, whether a retry is offered)
// rather than Bloom's internal layout.
jest.mock('@oxy.so/bloom/empty-state', () => ({ EmptyState: 'BloomEmptyState' }));

jest.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));

// NOT mocked: `package.json` maps the barrel AND every `@oxy.so/bloom/icons/Ri*`
// subpath to the same `test-support/bloomIcons.js`, so a `jest.mock` of the
// barrel replaces the module the per-glyph imports resolve to as well — every
// glyph the factory does not list silently becomes `undefined`. The shared
// stand-in already names each one through `displayName`.

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

/** Every empty-state block the tree renders. */
function blocks(tree: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
    return tree.root.findAll((node) => isElement(node, 'BloomEmptyState'), { deep: true });
}

/**
 * Every glyph the tree draws, by name. `@oxy.so/bloom/icons/Ri*` is mapped to
 * `test-support/bloomIcons.js`, whose stand-ins carry the glyph's own name as
 * `displayName` — so this still names the DECISION, as the Ionicons `name` prop
 * it replaces did.
 */
function iconNames(tree: TestRenderer.ReactTestRenderer): string[] {
    return blocks(tree)
        .map((node) => node.props.icon)
        .filter(Boolean)
        .map((icon: { displayName?: string; name?: string }) => String(icon.displayName ?? icon.name));
}

/** The retry affordance: the block's action, leading with the refresh glyph. */
function retryButtons(tree: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
    return blocks(tree).filter((node) => {
        const action = node.props.action as { icon?: { displayName?: string } } | undefined;
        return action?.icon?.displayName === 'RiRefreshLine';
    });
}

function textContent(tree: TestRenderer.ReactTestRenderer): string {
    return blocks(tree)
        .flatMap((node) => [node.props.title, node.props.description])
        .filter((child): child is string => typeof child === 'string')
        .join(' | ');
}

describe('FeedEmptyState', () => {
    it('shows the loading state while a read (and its retries) is in flight', () => {
        const tree = render({ isLoading: true, error: 'Failed to load', errorKind: 'transient' });
        expect(tree.root.findAll((node) => isElement(node, 'Loading')).length).toBe(1);
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
        // `cloud-offline-outline` was the Ionicons name; Bloom ships no cloud-off
        // glyph, so the connection failure draws the alert triangle.
        expect(iconNames(tree)).toContain('RiAlertLine');
        expect(textContent(tree)).toContain('No connection. Check your network and try again.');
    });

    it('never shows a failure while there are rows to read', () => {
        const tree = render({ error: 'Failed to load more posts', errorKind: 'transient', hasItems: true });
        expect(retryButtons(tree)).toHaveLength(0);
        expect(textContent(tree)).not.toContain('feed.empty.title');
    });
});
