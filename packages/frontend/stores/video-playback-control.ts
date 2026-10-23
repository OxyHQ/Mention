import { useEffect, useState, useSyncExternalStore } from 'react';
import type { VideoPlayer } from 'expo-video';

interface PlaybackDemand {
  shouldPlay: boolean;
  shouldLoad: boolean;
}

interface PlaybackSnapshot extends PlaybackDemand {
  hasRenderedFrame: boolean;
}

/** A player can have several presenters, but only one playback decision. */
class PlaybackControl {
  private demands = new Map<object, PlaybackDemand>();
  private listeners = new Set<() => void>();
  private snapshot: PlaybackSnapshot;
  private subscriptions: Array<{ remove: () => void }> = [];

  constructor(private player: VideoPlayer) {
    this.snapshot = {
      shouldPlay: false,
      shouldLoad: false,
      hasRenderedFrame: player.status === 'readyToPlay',
    };
  }

  getSnapshot = (): PlaybackSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publish(owner: object, demand: PlaybackDemand): void {
    const isFirstOwner = this.demands.size === 0;
    if (isFirstOwner) {
      this.subscriptions = [
        this.player.addListener('sourceChange', this.synchronize),
        this.player.addListener('statusChange', ({ status }) => {
          if (status !== 'readyToPlay') return;
          this.setRenderedFrame(true);
          this.synchronize();
        }),
      ];
    }
    this.demands.set(owner, demand);
    this.update(isFirstOwner);
  }

  remove(owner: object): void {
    this.demands.delete(owner);
    if (this.demands.size === 0) {
      for (const subscription of this.subscriptions) subscription.remove();
      this.subscriptions = [];
    }
    this.update();
  }

  setRenderedFrame(hasRenderedFrame: boolean): void {
    if (this.snapshot.hasRenderedFrame === hasRenderedFrame) return;
    this.snapshot = { ...this.snapshot, hasRenderedFrame };
    for (const listener of this.listeners) listener();
  }

  synchronize = (): void => {
    // During a route handoff the transition lease keeps the player alive until
    // its next presenter arrives. Releasing a presenter is not a pause command.
    if (this.demands.size === 0) return;
    if (this.snapshot.shouldPlay) this.player.play();
    else this.player.pause();
  };

  private update(force = false): void {
    let shouldPlay = false;
    let shouldLoad = false;
    for (const demand of this.demands.values()) {
      shouldPlay ||= demand.shouldPlay;
      shouldLoad ||= demand.shouldLoad;
    }
    const previous = this.snapshot;
    if (previous.shouldPlay === shouldPlay && previous.shouldLoad === shouldLoad) {
      if (force) this.synchronize();
      return;
    }
    this.snapshot = { ...previous, shouldPlay, shouldLoad };
    for (const listener of this.listeners) listener();
    if (force || previous.shouldPlay !== shouldPlay) this.synchronize();
  }
}

// Weak keys follow expo-video's player lifetime; they do not retain decoders.
const controls = new WeakMap<VideoPlayer, PlaybackControl>();

function controlFor(player: VideoPlayer): PlaybackControl {
  let control = controls.get(player);
  if (!control) {
    control = new PlaybackControl(player);
    controls.set(player, control);
  }
  return control;
}

function usePlaybackControl(player: VideoPlayer): PlaybackControl {
  const [current, setCurrent] = useState(() => ({ player, control: controlFor(player) }));
  if (current.player !== player) {
    setCurrent({ player, control: controlFor(player) });
  }
  return current.control;
}

/** Publish the playback authority's answer for one mounted presenter. */
export function useVideoPlaybackControl(
  player: VideoPlayer,
  shouldPlay: boolean,
  shouldLoad = shouldPlay,
): void {
  const [owner] = useState(() => ({}));
  const control = usePlaybackControl(player);
  useEffect(() => {
    control.publish(owner, { shouldPlay, shouldLoad });
  }, [control, owner, shouldPlay, shouldLoad]);
  useEffect(() => () => control.remove(owner), [control, owner]);
}

export function useVideoLoadingDemand(player: VideoPlayer): boolean {
  const control = usePlaybackControl(player);
  return useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot)
    .shouldLoad;
}

export function useVideoHasRenderedFrame(player: VideoPlayer): boolean {
  const control = usePlaybackControl(player);
  return useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot)
    .hasRenderedFrame;
}

export function setVideoHasRenderedFrame(player: VideoPlayer, hasRenderedFrame: boolean): void {
  controlFor(player).setRenderedFrame(hasRenderedFrame);
}
