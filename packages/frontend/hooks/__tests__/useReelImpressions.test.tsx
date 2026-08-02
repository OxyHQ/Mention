import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useReelImpressions, type UseReelImpressionsOptions } from '../useReelImpressions';

/**
 * Which video the reel reports as watched, across the handoff between its two
 * sources: the pager's snapped slide and the OS Picture-in-Picture window's own
 * cursor. Nothing here touches the transport — `FeedImpressionTracker` has its
 * own tests — only the visible/hidden pairs this hook hands it.
 */

// Everything below is prefixed `mock` so the hoisted `jest.mock` factory may
// reference it.
type MockEvent = [event: 'visible' | 'hidden', postUri: string];

interface MockSession {
    /** The session identity this tracker instance was minted for. */
    key: string;
    /** What THIS instance was told, so a test can tell the instances apart. */
    events: MockEvent[];
    tracker: { setVisible: (postUri: string) => void; setHidden: (postUri: string) => void };
}

/** Every event, in order, whichever instance recorded it. */
const mockImpressions: MockEvent[] = [];
const mockSessions: MockSession[] = [];
const mockTrackerArgs: [string, string | number | undefined, boolean | undefined][] = [];

// The stable ref `useFeedImpressionTracker` hands back: ONE object for the whole
// mount, whose `.current` is swapped when the session identity changes. Modelled
// this way rather than as a single frozen stub because both halves matter — one
// instance across a re-render is what makes the two watched-video sources dedupe
// against each other, and a NEW instance on a session change is what the hook has
// to notice.
const mockTrackerRef: { current: MockSession['tracker'] } = {
    current: { setVisible: () => {}, setHidden: () => {} },
};

function mockOpenSession(key: string): void {
    const session: MockSession = {
        key,
        events: [],
        tracker: {
            setVisible: (postUri: string) => {
                session.events.push(['visible', postUri]);
                mockImpressions.push(['visible', postUri]);
            },
            setHidden: (postUri: string) => {
                session.events.push(['hidden', postUri]);
                mockImpressions.push(['hidden', postUri]);
            },
        },
    };
    mockSessions.push(session);
    mockTrackerRef.current = session.tracker;
}

jest.mock('@/utils/feedTelemetry', () => ({
    useFeedImpressionTracker: (
        descriptor: string,
        resetKey?: string | number,
        canReport?: boolean,
    ) => {
        mockTrackerArgs.push([descriptor, resetKey, canReport]);
        // The real hook's session identity, reproduced: a new tracker for a new
        // descriptor or reset key, and — deliberately — the SAME one across a
        // `canReport` flip, which must never reset a session mid-video.
        const key = `${descriptor}::${resetKey ?? ''}`;
        if (mockSessions.at(-1)?.key !== key) mockOpenSession(key);
        return mockTrackerRef;
    },
}));

function Probe(props: UseReelImpressionsOptions) {
    useReelImpressions(props);
    return null;
}

const BASE: UseReelImpressionsOptions = {
    pipOwnerId: null,
    screenFocused: true,
    feedDescriptor: 'videos',
    canReportImpressions: true,
};

/** Mount the hook and keep its props so a test can change one at a time. */
function mountReel(initial: Partial<UseReelImpressionsOptions> = {}) {
    let props: UseReelImpressionsOptions = { ...BASE, ...initial };
    let created: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
        created = TestRenderer.create(<Probe {...props} />);
    });
    const renderer = created;
    if (!renderer) throw new Error('renderer was not created');

    return {
        update(next: Partial<UseReelImpressionsOptions>) {
            props = { ...props, ...next };
            act(() => {
                renderer.update(<Probe {...props} />);
            });
        },
        unmount() {
            act(() => {
                renderer.unmount();
            });
        },
    };
}

beforeEach(() => {
    mockImpressions.length = 0;
    mockSessions.length = 0;
    mockTrackerArgs.length = 0;
});

describe('reel impressions — the pager', () => {
    it('reports the slide the pager is on', () => {
        mountReel({ activePostId: 'a' });

        expect(mockImpressions).toEqual([['visible', 'a']]);
    });

    it('closes the previous slide before opening the next one on a swipe', () => {
        const reel = mountReel({ activePostId: 'a' });
        reel.update({ activePostId: 'b' });

        expect(mockImpressions).toEqual([
            ['visible', 'a'],
            ['hidden', 'a'],
            ['visible', 'b'],
        ]);
    });

    it('reports nothing for an empty reel, from mount to unmount', () => {
        const reel = mountReel();
        reel.unmount();

        expect(mockImpressions).toEqual([]);
    });

    it('stops accruing on blur and resumes on re-focus', () => {
        // A pushed route leaves the reel mounted and stops its playback, so the
        // time spent on top of it is not dwell on the video underneath.
        const reel = mountReel({ activePostId: 'a' });
        reel.update({ screenFocused: false });
        expect(mockImpressions).toEqual([
            ['visible', 'a'],
            ['hidden', 'a'],
        ]);

        reel.update({ screenFocused: true });
        expect(mockImpressions).toEqual([
            ['visible', 'a'],
            ['hidden', 'a'],
            ['visible', 'a'],
        ]);
    });
});

describe('reel impressions — the Picture-in-Picture handoff', () => {
    it('emits nothing when the video already being watched enters PiP', () => {
        // The failure this test exists for: a session with its OWN tracker sees
        // the handoff as a first sighting and emits a second impression, whose
        // dwell — the time since the window opened — is short enough to book a
        // SKIP against a video the viewer just watched in full.
        const reel = mountReel({ activePostId: 'a' });
        expect(mockImpressions).toEqual([['visible', 'a']]);

        reel.update({ pipOwnerId: 'a', pipPlayingId: 'a' });

        expect(mockImpressions).toEqual([['visible', 'a']]);
    });

    it('emits nothing when the window closes on the video the pager lands back on', () => {
        const reel = mountReel({ activePostId: 'a', pipOwnerId: 'a', pipPlayingId: 'c' });
        expect(mockImpressions).toEqual([['visible', 'c']]);

        // Leaving PiP re-syncs the pager to the cursor, so the same video simply
        // changes which source is reporting it.
        reel.update({ pipOwnerId: null, pipPlayingId: undefined, activePostId: 'c' });

        expect(mockImpressions).toEqual([['visible', 'c']]);
    });

    it('ignores the pager entirely while a session is open', () => {
        const reel = mountReel({ activePostId: 'a', pipOwnerId: 'a', pipPlayingId: 'a' });
        reel.update({ activePostId: 'b' });
        expect(mockImpressions).toEqual([['visible', 'a']]);

        reel.update({ pipPlayingId: 'c' });
        expect(mockImpressions).toEqual([
            ['visible', 'a'],
            ['hidden', 'a'],
            ['visible', 'c'],
        ]);
    });

    it('does not fall back to the pager when a live session has nothing to play', () => {
        // A rebuilt list (a tab switch under a live session) can leave the cursor
        // pointing past the end. The pager is frozen while the OS window is up,
        // so attributing that time to its slide would be dwell on a video nobody
        // is watching.
        const reel = mountReel({ activePostId: 'a', pipOwnerId: 'a', pipPlayingId: 'a' });
        reel.update({ pipPlayingId: undefined, activePostId: 'b' });

        expect(mockImpressions).toEqual([
            ['visible', 'a'],
            ['hidden', 'a'],
        ]);
    });

    it('keeps reporting a blurred screen while it owns the OS window', () => {
        // PiP is exactly the case where a blurred/backgrounded reel is still the
        // thing being watched, so the focus gate must not reach it.
        mountReel({ pipOwnerId: 'a', pipPlayingId: 'a', screenFocused: false });

        expect(mockImpressions).toEqual([['visible', 'a']]);
    });
});

describe('reel impressions — the tracker session', () => {
    it('builds its tracker from the descriptor, the reset key and the auth gate', () => {
        mountReel({ activePostId: 'a', feedDescriptor: 'following', impressionResetKey: 'u1', canReportImpressions: false });

        expect(mockTrackerArgs[0]).toEqual(['following', 'u1', false]);
    });

    it('re-registers the video on screen with the new tracker when the session changes', () => {
        // The auth cold boot: the viewer lands several seconds into the first
        // video, which is a NEW impression session for the same feed. The
        // outgoing session is disposed during render, and it could not report
        // anything (the private-API gate was still shut), so a new session that
        // does not know about this video loses the impression outright — it would
        // only open one on the next swipe.
        const reel = mountReel({ activePostId: 'a', canReportImpressions: false });
        expect(mockSessions).toHaveLength(1);
        expect(mockSessions[0].events).toEqual([['visible', 'a']]);

        reel.update({ impressionResetKey: 'viewer-1', canReportImpressions: true });

        expect(mockSessions).toHaveLength(2);
        expect(mockSessions[1].events).toEqual([['visible', 'a']]);
        // …and the close went to the OUTGOING instance, never the new one. In
        // production that instance is already disposed, where `setHidden`
        // short-circuits, so the post is not reported twice.
        expect(mockSessions[0].events).toEqual([
            ['visible', 'a'],
            ['hidden', 'a'],
        ]);
    });

    it('does not disturb the session when only the auth gate flips', () => {
        // `useFeedImpressionTracker` keeps its instance across an anon → authed
        // flip precisely so a session is not reset mid-video; the hook must not
        // manufacture a re-registration where there was no new tracker.
        const reel = mountReel({ activePostId: 'a', impressionResetKey: 'viewer-1', canReportImpressions: false });
        reel.update({ canReportImpressions: true });

        expect(mockSessions).toHaveLength(1);
        expect(mockImpressions).toEqual([['visible', 'a']]);
    });
});
