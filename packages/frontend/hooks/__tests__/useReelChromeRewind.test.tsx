import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * WHEN the reel rewinds — which is a question about latency, not about
 * semantics.
 *
 * Every activation is meant to begin at the start, and it still does. What
 * changed is that the seek happens as a surface goes IDLE rather than as it
 * becomes active, because activation is the reader's critical path and idling is
 * not.
 *
 * The asymmetry it caused was reported from the device: scrolling back felt
 * slower and jerkier than scrolling on. A slide AHEAD has never played, so
 * `currentTime = 0` was a no-op and it started from the buffer it filled while
 * it waited. A slide BEHIND sat wherever it stopped, with its buffer filled
 * around THAT position, so arriving discarded the buffer and re-fetched from the
 * start — the one direction that pays a seek is the one the reader notices.
 *
 * These assert the ORDER of the writes against activation, so a refactor that
 * quietly moves the seek back onto the arrival path fails here.
 */

jest.mock('react-native-reanimated', () => ({
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: () => ({}),
    withSequence: (...args: unknown[]) => args[0],
    withTiming: (value: unknown) => value,
}));
jest.mock('expo', () => ({ useEventListener: () => {} }));
jest.mock('expo-video', () => ({ VideoView: () => null }));
jest.mock('expo-keep-awake', () => ({
    activateKeepAwakeAsync: jest.fn(async () => {}),
    deactivateKeepAwake: jest.fn(async () => {}),
}));
jest.mock('@oxyhq/core/logger', () => ({
    createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/context/VideoPlaybackContext', () => ({
    // The hook destructures `shouldPlay` (renamed `playbackAllowed`),
    // `claimActive` and `reportVisibility`; the last is called DURING render, so
    // it has to exist or the first commit throws.
    useVideoPlayback: () => ({
        shouldPlay: true,
        claimActive: () => {},
        reportVisibility: () => {},
    }),
}));
jest.mock('@/hooks/usePipAspectRatio', () => ({ usePipAspectRatio: () => undefined }));

// eslint-disable-next-line import/first
import { useReelChrome } from '../useReelChrome';

/** A player that records every `currentTime` write, in order. */
function fakePlayer() {
    const seeks: number[] = [];
    let time = 0;
    return {
        seeks,
        player: {
            get currentTime() {
                return time;
            },
            set currentTime(value: number) {
                time = value;
                seeks.push(value);
            },
            loop: true,
            muted: true,
            playing: false,
            status: 'readyToPlay' as const,
            timeUpdateEventInterval: 0,
            duration: 30,
            bufferedPosition: 0,
            play: jest.fn(),
            pause: jest.fn(),
            seekBy: jest.fn(),
            replaceAsync: jest.fn(async () => {}),
            addListener: jest.fn(() => ({ remove: jest.fn() })),
            removeListener: jest.fn(),
        },
        /** Pretend the reader watched a few seconds. */
        advance(seconds: number) {
            time = seconds;
        },
    };
}

function Harness({ player, isActive }: { player: object; isActive: boolean }) {
    useReelChrome({
        player,
        restartOnActivate: true,
        postId: 'post-1',
        videoUrl: 'https://example.test/clip.mp4',
        posterUrl: undefined,
        isActive,
        screenFocused: true,
        windowHeight: 800,
        muted: true,
        onMutedChange: () => {},
        onError: () => {},
        t: ((key: string) => key) as never,
        isLiked: false,
        onLikePost: () => {},
        ownsSession: false,
        sessionActive: false,
        sessionSource: undefined,
        onSessionStart: () => {},
        onSessionEnd: () => {},
        onRegisterTransportSeek: () => () => {},
    } as never);
    return null;
}

function render(player: object, isActive: boolean) {
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    act(() => {
        renderer = TestRenderer.create(<Harness player={player} isActive={isActive} />);
    });
    if (!renderer) throw new Error('the harness did not render');
    return renderer as TestRenderer.ReactTestRenderer;
}

describe('the reel rewinds on the way out', () => {
    it('rewinds when the surface goes idle, so the return pays no seek', () => {
        const fake = fakePlayer();
        const renderer = render(fake.player, true);
        // Arriving writes nothing: this surface built its own player and a fresh
        // one is at zero. A seek that changes no position is still a seek.
        expect(fake.seeks).toEqual([]);

        fake.advance(7);
        act(() => renderer.update(<Harness player={fake.player} isActive={false} />));

        // Leaving is where the seek happens — off the reader's critical path.
        expect(fake.seeks).toEqual([0]);
        expect(fake.player.currentTime).toBe(0);

        act(() => renderer.update(<Harness player={fake.player} isActive />));

        // Coming back writes nothing either: the player is already at the start,
        // having sat there while the reader was elsewhere.
        expect(fake.seeks).toEqual([0]);
        act(() => renderer.unmount());
    });

    // The guarantee is "every activation begins at the start", and it survives a
    // second lap: play, leave, come back, play, leave again.
    it('rewinds again on every later exit', () => {
        const fake = fakePlayer();
        const renderer = render(fake.player, true);

        fake.advance(7);
        act(() => renderer.update(<Harness player={fake.player} isActive={false} />));
        act(() => renderer.update(<Harness player={fake.player} isActive />));
        fake.advance(3);
        act(() => renderer.update(<Harness player={fake.player} isActive={false} />));

        expect(fake.seeks).toEqual([0, 0]);
        expect(fake.player.currentTime).toBe(0);
        act(() => renderer.unmount());
    });

    it('does not rewind a surface that was never active', () => {
        const fake = fakePlayer();
        const renderer = render(fake.player, false);

        expect(fake.seeks).toEqual([]);
        act(() => renderer.unmount());
    });
});
