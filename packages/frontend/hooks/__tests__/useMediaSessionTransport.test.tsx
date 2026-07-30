import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useMediaSessionTransport, type MediaSessionTrack } from '../useMediaSessionTransport';

// Prefixed `mock` so the hoisted `jest.mock` factory may reference it. Every
// swallowed failure lands here, which is what makes "did nothing at all"
// distinguishable from "tried and swallowed the error".
const mockDebug = jest.fn();

jest.mock('@oxyhq/core/logger', () => ({
    ...jest.requireActual('@oxyhq/core/logger'),
    // Read `mockDebug` at CALL time: the factory runs while the test module's own
    // bindings are still being initialised, so capturing it here would capture
    // `undefined` and every swallowed failure would become a crash.
    createLogger: () => ({ debug: (...args: unknown[]) => mockDebug(...args) }),
}));

/**
 * The Media Session binding is the only thing that can put next / previous
 * INSIDE a browser's Picture-in-Picture window, and it is also the API most
 * likely to be half-implemented under the app: an unknown action name throws out
 * of `setActionHandler`, and whole browsers (Safari) honour none of these.
 *
 * These tests pin the registration contract and the degradation. Whether Chromium
 * actually DRAWS the buttons is not reachable from jest — that needs a browser.
 */

type ActionDetails = { seekOffset?: number };
type ActionHandler = (details: ActionDetails) => void;

class FakeMediaSession {
    metadata: unknown = null;
    readonly handlers = new Map<string, ActionHandler>();
    /** Action names this fake browser does not know — `setActionHandler` throws. */
    readonly unsupported = new Set<string>();

    setActionHandler(action: string, handler: ActionHandler | null): void {
        if (this.unsupported.has(action)) {
            throw new Error(`Failed to execute 'setActionHandler': ${action} is not supported`);
        }
        if (handler === null) {
            this.handlers.delete(action);
        } else {
            this.handlers.set(action, handler);
        }
    }
}

class FakeMediaMetadata {
    title: string;
    artist: string;
    artwork: readonly { src: string }[];

    constructor(init: { title: string; artist: string; artwork: readonly { src: string }[] }) {
        this.title = init.title;
        this.artist = init.artist;
        this.artwork = init.artwork;
    }
}

const TRACK: MediaSessionTrack = {
    title: 'A caption',
    artist: '@someone',
    artwork: 'https://cdn.example/poster.jpg',
};

const onNext = jest.fn();
const onPrevious = jest.fn();
const onSeek = jest.fn();

let mediaSession: FakeMediaSession;

function Probe({ track }: { track: MediaSessionTrack | null }) {
    useMediaSessionTransport({ track, onNext, onPrevious, onSeek });
    return null;
}

function render(track: MediaSessionTrack | null = TRACK): TestRenderer.ReactTestRenderer {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
        renderer = TestRenderer.create(<Probe track={track} />);
    });
    if (!renderer) throw new Error('renderer was not created');
    return renderer;
}

function fire(action: string, details: ActionDetails = {}): void {
    const handler = mediaSession.handlers.get(action);
    if (!handler) throw new Error(`no handler registered for "${action}"`);
    act(() => handler(details));
}

/** Install a browser-shaped global with the given media session (or none). */
function installNavigator(session: FakeMediaSession | null): void {
    Object.defineProperty(globalThis, 'navigator', {
        value: session === null ? {} : { mediaSession: session },
        configurable: true,
        writable: true,
    });
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

beforeEach(() => {
    onNext.mockClear();
    onPrevious.mockClear();
    onSeek.mockClear();
    mockDebug.mockClear();
    mediaSession = new FakeMediaSession();
    installNavigator(mediaSession);
    (globalThis as { MediaMetadata?: unknown }).MediaMetadata = FakeMediaMetadata;
});

afterEach(() => {
    if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
        delete (globalThis as { navigator?: unknown }).navigator;
    }
    delete (globalThis as { MediaMetadata?: unknown }).MediaMetadata;
});

describe('media session transport — registration', () => {
    it('registers every action the reel offers', () => {
        render();

        expect([...mediaSession.handlers.keys()].sort()).toEqual([
            'nexttrack',
            'previoustrack',
            'seekbackward',
            'seekforward',
        ]);
    });

    it('releases them all on unmount', () => {
        const renderer = render();
        act(() => {
            renderer.unmount();
        });

        expect([...mediaSession.handlers.keys()]).toEqual([]);
    });

    it('keeps the supported actions when the browser rejects one', () => {
        // `setActionHandler` THROWS for an action name the browser does not know.
        // One missing button must cost that button and nothing else — least of all
        // the screen that mounted the hook.
        mediaSession.unsupported.add('seekbackward');

        expect(() => render()).not.toThrow();
        expect([...mediaSession.handlers.keys()].sort()).toEqual([
            'nexttrack',
            'previoustrack',
            'seekforward',
        ]);
    });

    it('does nothing where the API does not exist at all', () => {
        installNavigator(null);

        expect(() => render()).not.toThrow();
        // Not merely "did not crash": with no `mediaSession` the hook must not
        // reach the API at all. Anything it tried and swallowed would have been
        // logged, so an empty log is what separates detection from luck.
        expect(mockDebug).not.toHaveBeenCalled();
    });
});

describe('media session transport — actions', () => {
    it('routes next and previous straight through', () => {
        render();

        fire('nexttrack');
        expect(onNext).toHaveBeenCalledTimes(1);

        fire('previoustrack');
        expect(onPrevious).toHaveBeenCalledTimes(1);
    });

    it('seeks ±10s when the OS names no offset', () => {
        render();

        fire('seekforward');
        expect(onSeek).toHaveBeenLastCalledWith(10);

        fire('seekbackward');
        expect(onSeek).toHaveBeenLastCalledWith(-10);
    });

    it('honours the offset the OS asks for, in both directions', () => {
        render();

        fire('seekforward', { seekOffset: 30 });
        expect(onSeek).toHaveBeenLastCalledWith(30);

        fire('seekbackward', { seekOffset: 30 });
        expect(onSeek).toHaveBeenLastCalledWith(-30);
    });
});

describe('media session transport — metadata', () => {
    it('publishes what is playing', () => {
        render();

        expect(mediaSession.metadata).toEqual(new FakeMediaMetadata({
            title: 'A caption',
            artist: '@someone',
            artwork: [{ src: 'https://cdn.example/poster.jpg' }],
        }));
    });

    it('publishes nothing when there is nothing to play', () => {
        render(null);

        expect(mediaSession.metadata).toBeNull();
    });

    it('clears it on the way out', () => {
        const renderer = render();
        act(() => {
            renderer.unmount();
        });

        expect(mediaSession.metadata).toBeNull();
    });

    it('survives a browser that has no MediaMetadata to build', () => {
        delete (globalThis as { MediaMetadata?: unknown }).MediaMetadata;

        expect(() => render()).not.toThrow();
        // The transport still works; it just goes unlabelled.
        expect(mediaSession.handlers.has('nexttrack')).toBe(true);
    });
});
