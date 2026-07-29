import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState } from 'react-native';
import { useIsFocused } from 'expo-router';
import {
    VideoPlaybackProvider,
    VideoViewabilityProvider,
    VideoViewabilityScope,
    useVideoPlayback,
    type UseVideoPlaybackOptions,
    type UseVideoPlaybackResult,
} from '../VideoPlaybackContext';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

// Screen focus is navigation state; the authority only folds it in. Mocked so a
// test can blur the screen its players are on.
jest.mock('expo-router', () => ({
    useIsFocused: jest.fn(() => true),
}));

/**
 * These tests cover the parts of the authority that are pure decision logic:
 * which player is elected audible, and how an unmatched/unreportable player
 * resolves. They deliberately do NOT claim anything about autoplay, real
 * viewability, backgrounding or focus transitions in a live app — none of that is
 * reproducible under jest, and it still needs a browser tab and a device build.
 *
 * Native branch only: `Platform.OS` is `ios` under jest-expo's default, so the
 * viewability-source path (not the web IntersectionObserver path) is exercised.
 */

const probes = new Map<string, UseVideoPlaybackResult>();

const Player: React.FC<UseVideoPlaybackOptions> = (options) => {
    probes.set(options.id, useVideoPlayback(options));
    return null;
};

function shouldPlay(id: string): boolean {
    const probe = probes.get(id);
    if (!probe) throw new Error(`no player mounted with id "${id}"`);
    return probe.shouldPlay;
}

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
        renderer = TestRenderer.create(element);
    });
    if (!renderer) throw new Error('renderer was not created');
    return renderer;
}

function update(renderer: TestRenderer.ReactTestRenderer, element: React.ReactElement): void {
    act(() => {
        renderer.update(element);
    });
}

beforeEach(() => {
    // jest-expo leaves `AppState.currentState` as a mock FUNCTION, which is
    // neither 'active' nor null, so the authority would read every player as
    // backgrounded. Pin it to the value a running app reports so these tests
    // exercise the real foreground path. Backgrounding TRANSITIONS are not
    // covered here — they need a device.
    AppState.currentState = 'active';
    jest.mocked(useIsFocused).mockReturnValue(true);
    probes.clear();
});

describe('video playback authority — election', () => {
    it('elects the player earliest in the published viewable order, and only that one', () => {
        render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-a', 'post-b'])}>
                    <Player id="a" viewabilityKey="post-a" />
                    <Player id="b" viewabilityKey="post-b" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('a')).toBe(true);
        expect(shouldPlay('b')).toBe(false);
    });

    it('releases the slot when the elected player leaves the viewable set', () => {
        const renderer = render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-a', 'post-b'])}>
                    <Player id="a" viewabilityKey="post-a" />
                    <Player id="b" viewabilityKey="post-b" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );

        update(
            renderer,
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-b'])}>
                    <Player id="a" viewabilityKey="post-a" />
                    <Player id="b" viewabilityKey="post-b" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('a')).toBe(false);
        expect(shouldPlay('b')).toBe(true);
    });

    it('plays NOTHING when the viewable set empties — scrolling past the last video', () => {
        const renderer = render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-a'])}>
                    <Player id="a" viewabilityKey="post-a" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );
        expect(shouldPlay('a')).toBe(true);

        update(
            renderer,
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set<string>()}>
                    <Player id="a" viewabilityKey="post-a" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('a')).toBe(false);
    });

    it('hands the slot on when the elected player unmounts', () => {
        const renderer = render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-a', 'post-b'])}>
                    <Player id="a" viewabilityKey="post-a" />
                    <Player id="b" viewabilityKey="post-b" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );
        expect(shouldPlay('a')).toBe(true);

        update(
            renderer,
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-a', 'post-b'])}>
                    <Player id="b" viewabilityKey="post-b" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('b')).toBe(true);
    });

    it('breaks an equal-rank tie deterministically, not by mount order', () => {
        // Two videos in ONE multi-media post share a viewability key, so they share
        // a rank. Mounted in both orders, the same player must win.
        render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-a'])}>
                    <Player id="second" viewabilityKey="post-a" />
                    <Player id="first" viewabilityKey="post-a" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );
        const winnerWhenSecondMountsFirst = shouldPlay('first') ? 'first' : 'second';

        probes.clear();
        render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-a'])}>
                    <Player id="first" viewabilityKey="post-a" />
                    <Player id="second" viewabilityKey="post-a" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );
        const winnerWhenFirstMountsFirst = shouldPlay('first') ? 'first' : 'second';

        expect(winnerWhenSecondMountsFirst).toBe(winnerWhenFirstMountsFirst);
        // Exactly one is audible either way.
        expect(shouldPlay('first') !== shouldPlay('second')).toBe(true);
    });

    it('lets a silent (GIF) player play alongside the audible one without taking the slot', () => {
        render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-a', 'post-b'])}>
                    <Player id="gif" viewabilityKey="post-a" silent />
                    <Player id="video" viewabilityKey="post-b" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('gif')).toBe(true);
        expect(shouldPlay('video')).toBe(true);
    });

    it('stops a silent (GIF) player once it is off screen', () => {
        const renderer = render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-a'])}>
                    <Player id="gif" viewabilityKey="post-a" silent />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );
        expect(shouldPlay('gif')).toBe(true);

        update(
            renderer,
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set<string>()}>
                    <Player id="gif" viewabilityKey="post-a" silent />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('gif')).toBe(false);
    });
});

describe('video playback authority — visibility resolution', () => {
    it('is visible with no viewability source at all (post detail, single-video screens)', () => {
        render(
            <VideoPlaybackProvider>
                <Player id="solo" />
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('solo')).toBe(true);
    });

    it('is NOT visible when a source exists but does not list this player', () => {
        render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-a'])}>
                    <Player id="unlisted" viewabilityKey="post-elsewhere" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('unlisted')).toBe(false);
    });

    it('is NOT visible when a source exists and the player carries no key at all', () => {
        render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-a'])}>
                    <Player id="keyless" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('keyless')).toBe(false);
    });
});

describe('video playback authority — VideoViewabilityScope', () => {
    it('plays a scoped subtree while its scope key is on screen, whatever key the player carries', () => {
        render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['feed-header'])}>
                    <VideoViewabilityScope viewabilityKey="feed-header">
                        <Player id="header-video" viewabilityKey="post-in-header" />
                    </VideoViewabilityScope>
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('header-video')).toBe(true);
    });

    it('SILENCES a scoped subtree once its scope key leaves the published set', () => {
        // The regression this scope exists for: a header video that scrolled off
        // screen must not keep the audible slot.
        const renderer = render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['feed-header', 'reply-a'])}>
                    <VideoViewabilityScope viewabilityKey="feed-header">
                        <Player id="header-video" viewabilityKey="post-in-header" />
                    </VideoViewabilityScope>
                    <Player id="reply-video" viewabilityKey="reply-a" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );
        expect(shouldPlay('header-video')).toBe(true);
        expect(shouldPlay('reply-video')).toBe(false);

        update(
            renderer,
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['reply-a'])}>
                    <VideoViewabilityScope viewabilityKey="feed-header">
                        <Player id="header-video" viewabilityKey="post-in-header" />
                    </VideoViewabilityScope>
                    <Player id="reply-video" viewabilityKey="reply-a" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('header-video')).toBe(false);
        expect(shouldPlay('reply-video')).toBe(true);
    });

    it('is silent when scoped without any key source above it', () => {
        render(
            <VideoPlaybackProvider>
                <VideoViewabilityScope viewabilityKey="feed-header">
                    <Player id="orphan" />
                </VideoViewabilityScope>
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('orphan')).toBe(false);
    });
});

describe('video playback authority — screen focus', () => {
    it('does not let a blurred screen hold the audible slot', () => {
        jest.mocked(useIsFocused).mockReturnValue(false);
        render(
            <VideoPlaybackProvider>
                <VideoViewabilityProvider viewableKeys={new Set(['post-a'])}>
                    <Player id="blurred" viewabilityKey="post-a" />
                </VideoViewabilityProvider>
            </VideoPlaybackProvider>,
        );

        expect(shouldPlay('blurred')).toBe(false);
    });
});
