import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useVideoPipSession, type VideoPipSession } from '../useVideoPipSession';

/**
 * The session's own decision logic: who owns it, where its cursor goes, when it
 * pages, and what it reports. These tests say NOTHING about Picture-in-Picture
 * itself — no OS window, no player, no source swap is reachable from jest — only
 * that the rules the screen drives those things with are the intended ones.
 */

// Prefixed `mock` so the hoisted `jest.mock` factory may reference it.
const mockImpressions: Array<[event: 'visible' | 'hidden', postUri: string]> = [];
const mockTracker = {
    current: {
        setVisible: (postUri: string) => { mockImpressions.push(['visible', postUri]); },
        setHidden: (postUri: string) => { mockImpressions.push(['hidden', postUri]); },
    },
};

jest.mock('@/utils/feedTelemetry', () => ({
    useFeedImpressionTracker: () => mockTracker,
}));

interface Item {
    id: string;
}

const ITEMS: Item[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];

let session: VideoPipSession<Item> | null = null;
const onEnded = jest.fn();
const loadMore = jest.fn();

function Probe({ items, hasMore }: { items: readonly Item[]; hasMore: boolean }) {
    session = useVideoPipSession({
        items,
        onEnded,
        loadMore,
        hasMore,
        feedDescriptor: 'videos',
        canReportImpressions: true,
    });
    return null;
}

function render(items: readonly Item[] = ITEMS, hasMore = false): TestRenderer.ReactTestRenderer {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
        renderer = TestRenderer.create(<Probe items={items} hasMore={hasMore} />);
    });
    if (!renderer) throw new Error('renderer was not created');
    return renderer;
}

/** The live session — re-read after every act, since each render replaces it. */
function live(): VideoPipSession<Item> {
    if (!session) throw new Error('no session probe mounted');
    return session;
}

beforeEach(() => {
    session = null;
    mockImpressions.length = 0;
    onEnded.mockClear();
    loadMore.mockClear();
});

describe('PiP session — ownership', () => {
    it('opens at the owner\'s own position in the list', () => {
        render();
        act(() => live().start('c'));

        expect(live().ownerId).toBe('c');
        expect(live().playing).toEqual({ id: 'c' });
    });

    it('does not open for an item that is not in the list', () => {
        render();
        act(() => live().start('gone'));

        expect(live().ownerId).toBeNull();
        expect(live().playing).toBeNull();
    });

    it('ignores an end from a surface that does not own the session', () => {
        render();
        act(() => live().start('b'));
        act(() => live().end('a'));

        expect(live().ownerId).toBe('b');
        expect(onEnded).not.toHaveBeenCalled();
    });

    it('closes on the owner\'s end and re-syncs the pager to the cursor', () => {
        render();
        act(() => live().start('b'));
        act(() => live().goToNext());
        act(() => live().goToNext());
        act(() => live().end('b'));

        expect(live().ownerId).toBeNull();
        expect(live().playing).toBeNull();
        // 'b' is index 1; two advances land on index 3 — where the pager must go.
        expect(onEnded).toHaveBeenCalledWith(3);
    });
});

describe('PiP session — cursor', () => {
    it('walks forward and back through the list', () => {
        render();
        act(() => live().start('a'));
        act(() => live().goToNext());
        expect(live().playing).toEqual({ id: 'b' });

        act(() => live().goToNext());
        expect(live().playing).toEqual({ id: 'c' });

        act(() => live().goToPrevious());
        expect(live().playing).toEqual({ id: 'b' });
    });

    it('stops at both ends of the loaded list', () => {
        render();
        act(() => live().start('a'));
        act(() => live().goToPrevious());
        expect(live().playing).toEqual({ id: 'a' });

        act(() => live().start('e'));
        act(() => live().goToNext());
        expect(live().playing).toEqual({ id: 'e' });
    });

    it('counts every press in a burst, not just the last one', () => {
        // Two OS transport presses can land before React re-renders — more easily
        // than on screen, since a backgrounded tab's renders are throttled. A
        // cursor computed from the rendered value would swallow the second.
        render();
        act(() => live().start('a'));
        const burst = live();
        act(() => {
            burst.goToNext();
            burst.goToNext();
        });

        expect(live().playing).toEqual({ id: 'c' });
    });

    it('keeps playing the item the cursor is on as the list grows', () => {
        const renderer = render([{ id: 'a' }, { id: 'b' }]);
        act(() => live().start('b'));
        act(() => {
            renderer.update(<Probe items={ITEMS} hasMore={false} />);
        });

        expect(live().playing).toEqual({ id: 'b' });
        act(() => live().goToNext());
        expect(live().playing).toEqual({ id: 'c' });
    });
});

describe('PiP session — top-up', () => {
    it('fetches another page as the cursor approaches the end of the loaded set', () => {
        render(ITEMS, true);
        act(() => live().start('a'));
        expect(loadMore).not.toHaveBeenCalled();

        // Index 2 of 5 is the first position within the top-up distance.
        act(() => live().goToNext());
        expect(loadMore).not.toHaveBeenCalled();
        act(() => live().goToNext());
        expect(loadMore).toHaveBeenCalled();
    });

    it('does not fetch when the feed has no more pages', () => {
        render(ITEMS, false);
        act(() => live().start('e'));

        expect(loadMore).not.toHaveBeenCalled();
    });

    it('does not fetch with no session open, however short the list is', () => {
        render([{ id: 'a' }], true);

        expect(loadMore).not.toHaveBeenCalled();
    });
});

describe('PiP session — impressions', () => {
    it('reports the real post id of whatever the session is playing', () => {
        render();
        act(() => live().start('b'));
        expect(mockImpressions).toEqual([['visible', 'b']]);

        act(() => live().goToNext());
        expect(mockImpressions).toEqual([
            ['visible', 'b'],
            ['hidden', 'b'],
            ['visible', 'c'],
        ]);

        act(() => live().end('b'));
        expect(mockImpressions).toEqual([
            ['visible', 'b'],
            ['hidden', 'b'],
            ['visible', 'c'],
            ['hidden', 'c'],
        ]);
    });

    it('reports nothing at all while no session is open', () => {
        const renderer = render();
        act(() => {
            renderer.unmount();
        });

        expect(mockImpressions).toEqual([]);
    });
});
