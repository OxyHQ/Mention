import React, { memo, useEffect, useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState } from 'react-native';
import {
    VideoPlaybackProvider,
    VideoViewabilityProvider,
    VideoViewabilityScope,
    useVideoPlayback,
    type UseVideoPlaybackResult,
} from '../VideoPlaybackContext';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

jest.mock('expo-router', () => ({ useIsFocused: jest.fn(() => true) }));

/**
 * Render fan-out of the playback authority (#1103 §13), measured the way a
 * media-heavy native feed mounts it: the authority at the app root, one list
 * publishing its viewable keys, and many MEMOIZED rows below it — FlashList
 * render-ahead keeps far more players mounted than are on screen, and a row is
 * never re-rendered by its list re-rendering.
 *
 * So every render counted here is one the authority itself caused. The guard is
 * that a player re-renders only when something IT resolves changed: its own
 * visibility or rank for a viewability update, its own audible slot for an
 * election. Twenty mounted players waking because one of them scrolled into view
 * is the fan-out this file exists to keep out.
 */

const PLAYER_COUNT = 20;
const renders = new Map<string, number>();
const probes = new Map<string, UseVideoPlaybackResult>();

const Player = memo(function Player({ id, viewabilityKey }: { id: string; viewabilityKey?: string }) {
    renders.set(id, (renders.get(id) ?? 0) + 1);
    probes.set(id, useVideoPlayback({ id, viewabilityKey }));
    return null;
});

const SilentPlayer = memo(function SilentPlayer({ id, viewabilityKey }: { id: string; viewabilityKey: string }) {
    renders.set(id, (renders.get(id) ?? 0) + 1);
    probes.set(id, useVideoPlayback({ id, viewabilityKey, silent: true }));
    return null;
});

const ids = Array.from({ length: PLAYER_COUNT }, (_, i) => `p${i}`);
const keyOf = (id: string): string => `k${id.slice(1)}`;

// Built ONCE, so the list re-rendering hands React the same elements and only a
// context/store subscription can reach a player — exactly as memoized list rows.
const ROWS = (
    <>
        <VideoViewabilityScope viewabilityKey="feed-header">
            <Player id="header" viewabilityKey="post-in-header" />
        </VideoViewabilityScope>
        {ids.map((id) => <Player key={id} id={id} viewabilityKey={keyOf(id)} />)}
    </>
);

let publishKeys: (keys: ReadonlySet<string>) => void = () => {};

function List({ initial }: { initial: ReadonlySet<string> }): React.ReactElement {
    const [keys, setKeys] = useState(initial);
    useEffect(() => {
        publishKeys = setKeys;
    }, []);
    return <VideoViewabilityProvider viewableKeys={keys}>{ROWS}</VideoViewabilityProvider>;
}

function mount(initial: readonly string[]): void {
    act(() => {
        TestRenderer.create(
            <VideoPlaybackProvider>
                <List initial={new Set(initial)} />
            </VideoPlaybackProvider>,
        );
    });
}

function measure(step: () => void): Record<string, number> {
    renders.clear();
    act(step);
    return Object.fromEntries(renders);
}

const playing = (): string[] =>
    [...probes].filter(([, probe]) => probe.shouldPlay).map(([id]) => id).sort();

beforeEach(() => {
    AppState.currentState = 'active';
    renders.clear();
    probes.clear();
});

describe('video playback fan-out', () => {
    it('one more player scrolling into view re-renders only that player', () => {
        mount(['k0', 'k1', 'k2']);
        expect(playing()).toEqual(['p0']);

        const rerendered = measure(() => publishKeys(new Set(['k0', 'k1', 'k2', 'k3'])));

        expect(playing()).toEqual(['p0']);
        expect(rerendered).toEqual({ p3: 1 });
    });

    it('a scroll step re-renders only the players whose own rank or slot moved', () => {
        mount(['k0', 'k1', 'k2']);

        // k0 leaves the top, k3 enters the bottom: p0 loses visibility AND the
        // slot, p1 wins it, p1/p2 move up one rank, p3 appears.
        const rerendered = measure(() => publishKeys(new Set(['k1', 'k2', 'k3'])));

        expect(playing()).toEqual(['p1']);
        expect(Object.keys(rerendered).sort()).toEqual(['p0', 'p1', 'p2', 'p3']);
    });

    it('an election re-renders only the player losing the slot and the one taking it', () => {
        mount(['k0', 'k1', 'k2']);

        const rerendered = measure(() => probes.get('p2')?.claimActive());

        expect(playing()).toEqual(['p2']);
        expect(Object.keys(rerendered).sort()).toEqual(['p0', 'p2']);
    });

    it('a silent (GIF) player keeps animating through an election and is not woken by it', () => {
        act(() => {
            TestRenderer.create(
                <VideoPlaybackProvider>
                    <VideoViewabilityProvider viewableKeys={new Set(['k0', 'k1', 'kg'])}>
                        <Player id="p0" viewabilityKey="k0" />
                        <Player id="p1" viewabilityKey="k1" />
                        <SilentPlayer id="gif" viewabilityKey="kg" />
                    </VideoViewabilityProvider>
                </VideoPlaybackProvider>,
            );
        });
        expect(playing()).toEqual(['gif', 'p0']);

        const rerendered = measure(() => probes.get('p1')?.claimActive());

        expect(playing()).toEqual(['gif', 'p1']);
        expect(Object.keys(rerendered).sort()).toEqual(['p0', 'p1']);
    });

    it('the header scope wakes its players only when the header itself moves', () => {
        mount(['feed-header', 'k0', 'k1']);
        // Header-first ordering: the list publishes the header ahead of every row.
        expect(playing()).toEqual(['header']);

        // A row entering below the header changes nothing the header resolves.
        const rowOnly = measure(() => publishKeys(new Set(['feed-header', 'k0', 'k1', 'k2'])));
        expect(rowOnly).toEqual({ p2: 1 });

        // The header scrolling away silences it and hands the slot to the top row.
        const headerGone = measure(() => publishKeys(new Set(['k0', 'k1', 'k2'])));
        expect(playing()).toEqual(['p0']);
        expect(Object.keys(headerGone).sort()).toEqual(['header', 'p0', 'p1', 'p2']);
    });
});
