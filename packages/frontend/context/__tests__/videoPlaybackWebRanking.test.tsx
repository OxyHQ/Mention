import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * The WEB ranking rule, which the sibling suite deliberately does not cover:
 * under jest-expo `Platform.OS` is `ios`, so that file exercises the viewability
 * path instead. Here the platform is forced to web, because the defect this pins
 * only exists there.
 *
 * What it pins: the audible slot goes to the player closest to the ideal line
 * AS IT IS WHEN THE ELECTION HAPPENS. Position arrives from an
 * `IntersectionObserver`, which only fires on a threshold crossing, so a player
 * that stays visible while the page scrolls keeps publishing where it was on the
 * way in. Measured on a profile with two video rows: the upper sat 159px from
 * the line and the lower 370px, and the LOWER one held the slot four runs out of
 * four — the upper one was being ranked by its entry position.
 */
jest.mock('expo-router', () => ({ useIsFocused: jest.fn(() => true) }));

import { Dimensions, Platform } from 'react-native';
import type {
    UseVideoPlaybackOptions,
    UseVideoPlaybackResult,
} from '../VideoPlaybackContext';

// `IS_WEB` is read once when the module loads, so the platform has to be web
// BEFORE the import — mocking the whole `react-native` module instead breaks
// expo's runtime on the way in.
Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VideoPlaybackProvider, useVideoPlayback } = require('../VideoPlaybackContext') as
    typeof import('../VideoPlaybackContext');

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

const IDEAL = Dimensions.get('window').height / 2.5;
const probes = new Map<string, UseVideoPlaybackResult>();

const Player: React.FC<UseVideoPlaybackOptions & { y: number }> = ({ y, ...options }) => {
    const probe = useVideoPlayback(options);
    probes.set(options.id, probe);
    React.useEffect(() => { probe.reportVisibility(y, true); }, [probe, y]);
    return null;
};

const playing = (id: string): boolean => {
    const probe = probes.get(id);
    if (!probe) throw new Error(`no player "${id}"`);
    return probe.shouldPlay;
};

afterEach(() => probes.clear());

describe('which web player holds the audible slot', () => {
    it('elects by where the players ARE, not where they were when they last reported', () => {
        // `near` publishes a stale position far from the line — the one it had
        // on the way in — and measures its real one, right on the line. `far`
        // publishes a good position and measures a bad one. Only reading the
        // measurement at election time gets this right.
        const measureNear = jest.fn(() => IDEAL);
        const measureFar = jest.fn(() => IDEAL + 4000);

        act(() => {
            TestRenderer.create(
                <VideoPlaybackProvider>
                    <Player id="near" y={IDEAL + 4000} measureOrder={measureNear} />
                    <Player id="far" y={IDEAL} measureOrder={measureFar} />
                </VideoPlaybackProvider>,
            );
        });

        expect(measureNear).toHaveBeenCalled();
        expect(playing('near')).toBe(true);
        expect(playing('far')).toBe(false);
    });

    it('falls back to the published position when a player cannot measure', () => {
        // Both directions in one test: without a measurement the published value
        // is all there is, and it must still decide — otherwise this fix would
        // silence every player that has no DOM node yet.
        act(() => {
            TestRenderer.create(
                <VideoPlaybackProvider>
                    <Player id="close" y={IDEAL} />
                    <Player id="distant" y={IDEAL + 4000} />
                </VideoPlaybackProvider>,
            );
        });

        expect(playing('close')).toBe(true);
        expect(playing('distant')).toBe(false);
    });
});
