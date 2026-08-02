import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useVideoPipSession, type VideoPipSession } from '../useVideoPipSession';

/**
 * The session's own decision logic: who owns it, where its cursor goes, and when
 * it pages. These tests say NOTHING about Picture-in-Picture itself — no OS
 * window, no player, no source swap is reachable from jest — only that the rules
 * the screen drives those things with are the intended ones.
 *
 * Impressions are NOT here: the screen reports them for both of its watched-video
 * sources through one shared tracker (see `useReelImpressions`).
 */

interface Item {
    id: string;
}

const ITEMS: Item[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];

let session: VideoPipSession<Item> | null = null;
const onEnded = jest.fn();
const loadMore = jest.fn();

function Probe({ items, hasMore }: { items: readonly Item[]; hasMore: boolean }) {
    session = useVideoPipSession({ items, onEnded, loadMore, hasMore });
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

describe('PiP session — what is playing', () => {
    it('has nothing playing until a session opens, and nothing again after it closes', () => {
        render();
        expect(live().playing).toBeNull();

        act(() => live().start('b'));
        expect(live().playing).toEqual({ id: 'b' });

        act(() => live().end('b'));
        expect(live().playing).toBeNull();
    });

    it('reports no item for a cursor that points outside the loaded list', () => {
        // The screen reads `playing` to decide what to report an impression for,
        // so a cursor left pointing past a rebuilt (shorter) list must yield null
        // rather than the nearest item.
        const renderer = render();
        act(() => live().start('e'));
        act(() => {
            renderer.update(<Probe items={[{ id: 'a' }, { id: 'b' }]} hasMore={false} />);
        });

        expect(live().ownerId).toBe('e');
        expect(live().playing).toBeNull();
    });
});
