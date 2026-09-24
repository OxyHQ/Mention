import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  getLiveRoomId,
  resetLivePresence,
  setLivePresence,
  useHasLivePresenceDemand,
  useLiveUser,
  type LiveUserState,
} from '../livePresenceStore';

const renders = new Map<string, number>();
const states = new Map<string, LiveUserState>();

function Probe({ userId }: { userId: string }) {
  const state = useLiveUser(userId);
  renders.set(userId, (renders.get(userId) ?? 0) + 1);
  states.set(userId, state);
  return null;
}

let demand: boolean[] = [];
function DemandProbe() {
  demand.push(useHasLivePresenceDemand());
  return null;
}

beforeEach(() => {
  resetLivePresence();
  renders.clear();
  states.clear();
  demand = [];
});

describe('livePresenceStore', () => {
  it('notifies only the users whose room changed', () => {
    setLivePresence([{ userId: 'a', roomId: 'r1' }]);
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <>
          <Probe userId="a" />
          <Probe userId="b" />
          <Probe userId="c" />
        </>,
      );
    });
    renders.clear();

    // b goes live; a unchanged; c stays offline.
    act(() => setLivePresence([{ userId: 'a', roomId: 'r1' }, { userId: 'b', roomId: 'r2' }]));
    expect(Object.fromEntries(renders)).toEqual({ b: 1 });
    expect(states.get('b')).toEqual({ isLive: true, roomId: 'r2' });

    // a moves rooms, b goes offline.
    renders.clear();
    act(() => setLivePresence([{ userId: 'a', roomId: 'r9' }]));
    expect(Object.fromEntries(renders)).toEqual({ a: 1, b: 1 });
    expect(states.get('a')).toEqual({ isLive: true, roomId: 'r9' });
    expect(states.get('b')).toEqual({ isLive: false, roomId: undefined });

    // Identical list: nobody re-renders.
    renders.clear();
    act(() => setLivePresence([{ userId: 'a', roomId: 'r9' }]));
    expect(renders.size).toBe(0);

    act(() => renderer!.unmount());
  });

  it('ignores entries without a user or room, and reset clears everything', () => {
    setLivePresence([
      { userId: 'a', roomId: 'r1' },
      { userId: 'b', roomId: null },
      { userId: null, roomId: 'r3' },
    ]);
    expect(getLiveRoomId('a')).toBe('r1');
    expect(getLiveRoomId('b')).toBeUndefined();
    resetLivePresence();
    expect(getLiveRoomId('a')).toBeUndefined();
    expect(getLiveRoomId(undefined)).toBeUndefined();
  });

  it('reports demand only while a keyed reader is mounted', () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<DemandProbe />);
    });
    expect(demand[demand.length - 1]).toBe(false);

    act(() => renderer!.update(<><DemandProbe /><Probe userId="a" /><Probe userId="b" /></>));
    expect(demand[demand.length - 1]).toBe(true);

    act(() => renderer!.update(<><DemandProbe /><Probe userId="a" /></>));
    expect(demand[demand.length - 1]).toBe(true);

    act(() => renderer!.update(<DemandProbe />));
    expect(demand[demand.length - 1]).toBe(false);
    act(() => renderer!.unmount());
  });
});
